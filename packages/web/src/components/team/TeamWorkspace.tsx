import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  TeamWorkspaceSnapshot,
  WorkspaceTeam,
  WorkspaceTeamMember,
  TeamDirectoryEntry,
  TeamJoinRequest,
} from "@heming/shared";
import {
  addWorkspaceMember,
  createWorkspaceTeam,
  deleteWorkspaceTeam,
  discoverTeams,
  createJoinRequest,
  fetchMyJoinRequests,
  fetchJoinRequests,
  reviewJoinRequest,
  fetchWorkspaceTeam,
  fetchWorkspaceTeams,
  leaveWorkspaceTeam,
  removeWorkspaceMember,
  transferWorkspaceTeamOwner,
  updateWorkspaceTeam,
} from "../../lib/api.js";
import { useAuthStore } from "../../store/auth.js";
import { useSessionStringValue } from "../../lib/sessionState.js";
import { TEAM_SELECTION_KEY } from "../../lib/team/selection.js";
import { describeTeamSummary, summarizeTeamTasks } from "../../lib/team/teamSummary.js";
import { EmptyState } from "../ui/EmptyState.js";
import { TeamPlanPanel } from "./TeamPlanPanel.js";
import { TeamTaskPanel } from "./TeamTaskPanel.js";
import { TeamSchedulePanel } from "./TeamSchedulePanel.js";
import { TeamActivityPanel } from "./TeamActivityPanel.js";
import { FOCUS_RING } from "../../lib/a11y/focus.js";
import { ConfirmDialog } from "../ConfirmDialog.js";
import { Button } from "../../components/ui/Button.js";
import { Dialog } from "../ui/Dialog.js";
import {
  REPORT_DEFAULT_DAYS,
  weeklyReportFileName,
  weeklyReportMarkdown,
} from "../../lib/team/weeklyReport.js";
import { saveExportFile } from "../../lib/export/file.js";

/**
 * 团队工作台（d.92）：用户自建团队 —— 名字 / 目标 / 方案 / 任务 / 成员。
 *
 * 与隔壁「团队页」两层语义（d.152）：那边是「自己 + 同队成员」的名册与摘要（没有团队时只有自己）；
 * 这里是用户自己拉的工作组本身（方案 / 任务 / 成员），只有成员可见。所有写操作都有对应的 REST 接口与智能体工具（team_*），
 * 权限判定只在服务端一处（是否成员 / 是否 owner），前端只做展示与提示。
 */

/** 当前团队的会话级记忆：与团队页页头共用同一个 key（见 `lib/team/selection.ts`）。 */
const SELECTED_TEAM_KEY = TEAM_SELECTION_KEY;

/**
 * 工作台静默轮询间隔：队友改了任务/方案，不用切 Tab 也能在 45s 内看到。
 *
 * 为什么是 45s：工作台不是实时聊天（有 60s 的动向流与 30s 的看板先例），
 * 比看板松一点、比动向紧一点；再快只会在没人看的时候白烧请求。
 */
const WORKSPACE_POLL_MS = 45_000;

/** 一次性提示（notice）的展示时长。 */
const NOTICE_MS = 3000;

export interface TeamWorkspaceProps {
  /**
   * 受控的当前团队（d.153）：团队页在页头放了「团队切换」，工作台必须跟着同一个选择走，
   * 否则页头显示 A、工作台内容却是 B。不传时退回本组件自己的会话级记忆（旧用法）。
   */
  teamId?: string | null;
  /** 工作台内部切团队（左栏列表 / 新建 / 删除后落到下一个）时通知宿主。 */
  onTeamChange?: (teamId: string) => void;
  /** 团队列表变化时上报（宿主的切换器要用同一份数据，避免两处各拉一次且口径不同）。 */
  onTeamsLoaded?: (teams: WorkspaceTeam[]) => void;
}

export function TeamWorkspace({ teamId, onTeamChange, onTeamsLoaded }: TeamWorkspaceProps = {}) {
  const me = useAuthStore((s) => s.user);
  const [teams, setTeams] = useState<WorkspaceTeam[]>([]);
  const [localId, setLocalId] = useSessionStringValue(SELECTED_TEAM_KEY);
  /** 受控优先：页头切换后所有视图一起走，内部选择只在宿主没接管时生效。 */
  const selectedId = teamId || localId;
  /** 外部（页头）切换进来的 id：只认「真的变了」的那一次，避免内部点击后重复拉快照。 */
  const externalIdRef = useRef(teamId ?? "");
  const setSelectedId = useCallback(
    (id: string) => {
      externalIdRef.current = id;
      setLocalId(id);
      onTeamChange?.(id);
    },
    [setLocalId, onTeamChange],
  );
  const [snapshot, setSnapshot] = useState<TeamWorkspaceSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  /**
   * 首屏加载失败：必须和「真的一个团队都没有」区分开（W-06）。
   * 只有 load() 失败才置位，切团队/写操作失败仍走页顶横幅（此时通常已有快照）。
   */
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  /** 提示的消失计时器：统一由 flash 管，卸载时清掉。 */
  const noticeTimer = useRef<number | null>(null);
  /** 待删除团队 / 待移除成员：确认框开着时才有值，取消不发请求。 */
  const [confirmDeleteTeam, setConfirmDeleteTeam] = useState(false);
  const [pendingRemoveMember, setPendingRemoveMember] = useState<WorkspaceTeamMember | null>(null);
  /** 打开确认框时焦点落在「取消」：误按回车不会执行破坏性操作。 */
  const cancelDeleteTeamRef = useRef<HTMLButtonElement | null>(null);
  const cancelRemoveMemberRef = useRef<HTMLButtonElement | null>(null);
  /** 待转让队长 / 待退出团队：同样只在确认框开着时有值，取消不发请求。 */
  const [pendingTransferTo, setPendingTransferTo] = useState<WorkspaceTeamMember | null>(null);
  const [confirmLeaveTeam, setConfirmLeaveTeam] = useState(false);
  const cancelTransferRef = useRef<HTMLButtonElement | null>(null);
  const cancelLeaveRef = useRef<HTMLButtonElement | null>(null);

  /**
   * 周报弹窗（d.269）：成稿只在打开时算一次，之后复制/导出都用同一份文本，
   * 避免「看到的」和「复制出来的」因为时间漂移而不一致。
   */
  const [reportText, setReportText] = useState("");
  const [reportOpen, setReportOpen] = useState(false);
  const [reportBusy, setReportBusy] = useState(false);
  /** 周报回看天数（痛点 10：不再固定 7 天，可在 1–30 天内切换）。 */
  const [reportDays, setReportDays] = useState(REPORT_DEFAULT_DAYS);

  // 新建团队表单
  const [createOpen, setCreateOpen] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftGoal, setDraftGoal] = useState("");
  // 目标编辑
  const [goalEditing, setGoalEditing] = useState(false);
  const [goalDraft, setGoalDraft] = useState("");
  // 团队成员
  const [memberName, setMemberName] = useState("");

  /* ── 找团队 / 加入申请（社交化加入，去 IM） ── */
  /** 发现弹窗开关。 */
  const [discoverOpen, setDiscoverOpen] = useState(false);
  /** 搜索词与结果（只含元数据，不含成员名单/任务）。 */
  const [discoverQuery, setDiscoverQuery] = useState("");
  const [discoverResults, setDiscoverResults] = useState<TeamDirectoryEntry[]>([]);
  const [discoverLoading, setDiscoverLoading] = useState(false);
  /** 正在给哪个团队写申请（附言输入）。 */
  const [applyTeam, setApplyTeam] = useState<TeamDirectoryEntry | null>(null);
  const [applyMessage, setApplyMessage] = useState("");
  /** 我的申请进度（看待审/通过/拒绝）。 */
  const [myRequests, setMyRequests] = useState<TeamJoinRequest[]>([]);
  /** 队长看到的本团队待审申请。 */
  const [joinRequests, setJoinRequests] = useState<TeamJoinRequest[]>([]);
  /** 发现弹窗内的提示（成功/失败），与全局 error 分开，关窗即清。 */
  const [discoverNotice, setDiscoverNotice] = useState("");

  /**
   * 一次性提示统一走这里：3s 自动消失。
   *
   * 之前只有 `run()` 里的提示带计时器，「团队已创建」是一次常驻横幅（P2-10）——
   * 用户会以为有个没处理完的状态。统一入口后新增提示也不会再漏。
   */
  const flash = useCallback((text: string) => {
    setNotice(text);
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => {
      noticeTimer.current = null;
      setNotice("");
    }, NOTICE_MS);
  }, []);

  // 卸载清 timer：组件都不在了，回调不该再 setState。
  useEffect(
    () => () => {
      if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    },
    [],
  );

  const refreshTeams = useCallback(async () => {
    const data = await fetchWorkspaceTeams();
    setTeams(data.teams);
    onTeamsLoaded?.(data.teams);
    return data.teams;
  }, [onTeamsLoaded]);

  /**
   * 团队快照的请求序号：切团队时旧请求可能后到，晚到的响应不能盖掉新选中的团队
   * （W-05：否则界面停在 A 的成员/任务上，用户以为自己在看 B）。
   */
  const teamSeq = useRef(0);

  const loadTeam = useCallback(async (id: string) => {
    const seq = ++teamSeq.current;
    const data = await fetchWorkspaceTeam(id);
    // 已经切走了：这次响应作废（也不要把 loading 关掉，交给最新那次请求收尾）。
    if (seq !== teamSeq.current) return null;
    setSnapshot(data);
    return data;
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    setLoadFailed(false);
    try {
      const list = await refreshTeams();
      const target = list.find((t) => t.id === selectedId) ?? list[0];
      if (target) {
        setSelectedId(target.id);
        await loadTeam(target.id);
      } else {
        setSnapshot(null);
      }
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "加载团队失败");
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [refreshTeams, loadTeam, selectedId, setSelectedId]);

  // 页头切换团队：宿主的 id 变了才拉一次快照（内部点击已由 setSelectedId 同步 ref）。
  useEffect(() => {
    const next = teamId ?? "";
    if (!next || next === externalIdRef.current) return;
    externalIdRef.current = next;
    void selectTeam(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId]);

  useEffect(() => {
    void load();
    // 只在挂载时拉一次；切团队走 selectTeam
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectTeam = async (id: string) => {
    setSelectedId(id);
    setLoading(true);
    setError("");
    try {
      await loadTeam(id);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "加载团队失败");
    } finally {
      setLoading(false);
    }
  };

  /**
   * 手动刷新：只换快照，**不动**任何未保存的表单草稿（目标编辑框、新建团队表单）。
   * 只更新 snapshot 的依据：写操作成功后也是只 setSnapshot，表单草稿是本地 state。
   */
  const refreshNow = async () => {
    const id = snapshot?.team.id;
    if (!id || busy) return;
    setBusy(true);
    setError("");
    try {
      await loadTeam(id);
      flash("团队数据已刷新");
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "刷新团队数据失败");
    } finally {
      setBusy(false);
    }
  };

  // 轮询回调读的是「最新值」：放 ref 里，避免 busy/snapshot 变化把 interval 重建成
  // 「永远等不到 45s」——那会让轮询实际失效，而不只是丢一轮。
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const activeTeamId = snapshot?.team.id ?? "";
  const activeTeamIdRef = useRef(activeTeamId);
  activeTeamIdRef.current = activeTeamId;

  // 工作台挂载期间每 45s 静默刷新一次（有快照才轮询；busy 跳过这一轮）。
  // 切团队时 activeTeamId 变 → effect 重跑 → 旧 timer 被清掉，切走再切回也不会叠加。
  useEffect(() => {
    if (!activeTeamId) return;
    const timer = window.setInterval(() => {
      if (busyRef.current) return;
      void (async () => {
        try {
          const next = await fetchWorkspaceTeam(activeTeamId);
          // 切团队/卸载后回来的旧响应不能盖掉新团队的快照。
          if (busyRef.current || activeTeamIdRef.current !== activeTeamId) return;
          // 轮询是为了「别人改了能看见」，不是每 45 秒弹一次提示——静默更新快照即可。
          setSnapshot(next);
        } catch {
          // 静默轮询：失败不打断用户，下一轮再试（错误横幅留给手动操作）。
        }
      })();
    }, WORKSPACE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [activeTeamId, flash]);

  /** 统一包装写操作：busy 态 + 成功后刷新快照 + 一次性提示。 */
  const run = async (action: () => Promise<TeamWorkspaceSnapshot>, okText: string) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const next = await action();
      setSnapshot(next);
      await refreshTeams();
      setSelectedId(next.team.id);
      flash(okText);
      return true;
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "操作失败");
      return false;
    } finally {
      setBusy(false);
    }
  };

  /**
   * 破坏性操作的目标团队：必须**同时**满足「左栏选中的是它」和「快照是它」。
   *
   * 只读 `snapshot.team.id` 不够：切团队是异步的，点开确认框后左栏可能已经切走，
   * 而快照还停在旧团队上——那时确认删的就是用户眼前看不到的那个团队（W-05）。
   */
  const destructionTargetId = (): string => {
    const id = selectedId && snapshot?.team.id === selectedId ? selectedId : "";
    if (!id) {
      setConfirmDeleteTeam(false);
      setPendingRemoveMember(null);
      setError("团队已切换，请重新确认");
    }
    return id;
  };

  /** 删除团队（确认框已确认）：级联删方案与任务，落回列表里的下一个团队。 */
  const deleteTeamNow = async () => {
    const id = destructionTargetId();
    if (!id || busy) return;
    setBusy(true);
    setError("");
    try {
      await deleteWorkspaceTeam(id);
      setConfirmDeleteTeam(false);
      const list = await refreshTeams();
      setSnapshot(null);
      if (list[0]) await selectTeam(list[0].id);
      else flash("团队已删除");
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "删除团队失败");
    } finally {
      setBusy(false);
    }
  };

  /** 移除成员（确认框已确认）：服务端会把他的任务解绑为待认领。 */
  const removeMemberNow = async () => {
    const id = destructionTargetId();
    const member = pendingRemoveMember;
    if (!id || !member || busy) return;
    await run(() => removeWorkspaceMember(id, member.user.id), "已移除成员");
    setPendingRemoveMember(null);
  };

  /** 转让队长（确认框已确认）：转让后自己降为普通成员，只剩改任务/方案这些成员权限。 */
  const transferOwnerNow = async () => {
    const id = destructionTargetId();
    const member = pendingTransferTo;
    if (!id || !member || busy) return;
    const ok = await run(
      () => transferWorkspaceTeamOwner(id, member.user.id),
      "队长已转让给 " + member.user.displayName,
    );
    if (ok) setPendingTransferTo(null);
  };

  /** 退出团队（确认框已确认）：退出的团队不再对我可见，落回列表里的下一个团队。 */
  const leaveTeamNow = async () => {
    const id = destructionTargetId();
    if (!id || busy) return;
    setBusy(true);
    setError("");
    try {
      await leaveWorkspaceTeam(id);
      setConfirmLeaveTeam(false);
      const list = await refreshTeams();
      setSnapshot(null);
      if (list[0]) await selectTeam(list[0].id);
      else flash("已退出团队");
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "退出团队失败");
    } finally {
      setBusy(false);
    }
  };

  const isOwner = Boolean(snapshot && me && snapshot.team.ownerId === me.id);
  /** 团队概览（d.257）：与 d.256 服务端同一套口径，界面这侧不额外发请求。 */
  const summary = useMemo(() => summarizeTeamTasks(snapshot?.tasks ?? []), [snapshot?.tasks]);
  /** 我在这个团队里的成员身份：成员才有「退出团队」，owner 必须先转让。 */
  const mine = snapshot && me ? snapshot.members.find((m) => m.user.id === me.id) : undefined;
  /** 只有普通成员能自退：owner 走「转让队长」或「删除团队」。 */
  const canLeave = Boolean(mine) && !isOwner;

  /** 用当前快照和给定天数算一份成稿（不额外发请求）。 */
  const buildWeeklyReport = (days: number) => {
    if (!snapshot) return;
    setReportText(
      weeklyReportMarkdown(snapshot, {
        days,
        memberName: (userId) => {
          const member = snapshot.members.find((m) => m.user.id === userId);
          return member ? `${member.user.displayName}（@${member.user.username}）` : userId;
        },
      }),
    );
  };

  /** 打开周报弹窗：用当前快照算一份成稿（不额外发请求）。 */
  const openWeeklyReport = () => {
    if (!snapshot) return;
    setReportDays(REPORT_DEFAULT_DAYS);
    buildWeeklyReport(REPORT_DEFAULT_DAYS);
    setReportOpen(true);
  };

  /** 切换回看天数：重算成稿，复制/导出跟着变成同一份新文本。 */
  const changeReportDays = (days: number) => {
    setReportDays(days);
    buildWeeklyReport(days);
  };

  /** 复制成稿：剪贴板不可用（非安全上下文）时退回临时 textarea。 */
  const copyWeeklyReport = async () => {
    try {
      await navigator.clipboard.writeText(reportText);
    } catch {
      const area = document.createElement("textarea");
      area.value = reportText;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    flash("周报已复制，可以直接粘到群里或周会材料里");
  };

  /** 导出成 .md：桌面端落到 ~/Heming/exports 并报真实路径，浏览器端退回下载。 */
  const exportWeeklyReport = async () => {
    if (!snapshot || reportBusy) return;
    setReportBusy(true);
    try {
      const result = await saveExportFile(
        weeklyReportFileName(snapshot.team.name, Date.now()),
        reportText,
      );
      flash(
        result.via === "desktop" && result.path ? `周报已保存到 ${result.path}` : "周报已下载",
      );
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "导出周报失败");
    } finally {
      setReportBusy(false);
    }
  };

  const onCreateTeam = async () => {
    const name = draftName.trim();
    if (!name) {
      setError("请填写团队名称");
      return;
    }
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const next = await createWorkspaceTeam({ name, goal: draftGoal.trim() });
      setSnapshot(next);
      setSelectedId(next.team.id);
      setCreateOpen(false);
      setDraftName("");
      setDraftGoal("");
      await refreshTeams();
      flash("团队已创建");
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "创建团队失败");
    } finally {
      setBusy(false);
    }
  };

  /** 搜索团队目录（只暴露元数据）。空词也允许，列出全部。 */
  const searchDirectory = async () => {
    setDiscoverLoading(true);
    setDiscoverNotice("");
    try {
      const data = await discoverTeams(discoverQuery.trim());
      setDiscoverResults(data.teams);
    } catch (err) {
      setDiscoverNotice(err instanceof Error && err.message ? err.message : "搜索失败");
    } finally {
      setDiscoverLoading(false);
    }
  };

  /** 打开发现弹窗：拉一次目录与我的申请进度。 */
  const openDiscover = () => {
    setDiscoverOpen(true);
    setDiscoverNotice("");
    setApplyTeam(null);
    setApplyMessage("");
    void searchDirectory();
    void fetchMyJoinRequests()
      .then((data) => setMyRequests(data.requests))
      .catch(() => setMyRequests([]));
  };

  /** 提交加入申请。 */
  const submitJoinRequest = async () => {
    if (!applyTeam || busy) return;
    setBusy(true);
    setDiscoverNotice("");
    try {
      await createJoinRequest(applyTeam.id, applyMessage.trim());
      setApplyTeam(null);
      setApplyMessage("");
      setDiscoverNotice(`已申请加入「${applyTeam.name}」，等队长审核`);
      const data = await fetchMyJoinRequests();
      setMyRequests(data.requests);
    } catch (err) {
      setDiscoverNotice(err instanceof Error && err.message ? err.message : "申请失败");
    } finally {
      setBusy(false);
    }
  };

  /** 队长拉本团队待审申请列表。 */
  const loadJoinRequests = useCallback(async () => {
    const id = snapshot?.team.id;
    if (!id || !isOwner) return;
    try {
      const data = await fetchJoinRequests(id);
      setJoinRequests(data.requests);
    } catch {
      setJoinRequests([]);
    }
  }, [snapshot?.team.id, isOwner]);

  useEffect(() => {
    void loadJoinRequests();
  }, [loadJoinRequests]);

  /** 队长审批通过/拒绝。 */
  const review = async (requestId: string, action: "approve" | "reject") => {
    const id = snapshot?.team.id;
    if (!id || busy) return;
    setBusy(true);
    setError("");
    try {
      await reviewJoinRequest(id, requestId, action);
      flash(action === "approve" ? "已通过加入申请" : "已拒绝加入申请");
      await loadJoinRequests();
      await loadTeam(id);
      await refreshTeams();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "审批失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-[240px] shrink-0 flex-col border-r border-line-soft">
        <div className="flex items-center gap-2 border-b border-line-soft px-3 py-2.5">
          <span className="ui-section-title">我的团队</span>
          <span className="ui-micro">{teams.length}</span>
          <button
            type="button"
            className="ui-link"
            onClick={openDiscover}
          >
            找团队
          </button>
          <button
            type="button"
            className="ui-link ml-auto"
            onClick={() => {
              setCreateOpen((v) => !v);
              setError("");
            }}
          >
            新建
          </button>
        </div>

        {createOpen && (
          <div className="border-b border-line-soft p-2.5">
            <input
              aria-label="团队名称"
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              placeholder="团队名称（如：增长小组）"
              className="ui-input w-full"
            />
            <textarea
              aria-label="团队目标"
              value={draftGoal}
              onChange={(e) => setDraftGoal(e.target.value)}
              placeholder="团队目标（可稍后补）"
              rows={2}
              className="ui-input mt-1.5 w-full resize-y"
            />
            <div className="mt-1.5 flex gap-2">
              <Button
                type="button"
                size="sm" variant="primary"
                disabled={busy}
                onClick={() => void onCreateTeam()}
              >
                创建
              </Button>
              <Button
                type="button"
                size="sm" variant="ghost"
                onClick={() => setCreateOpen(false)}
              >
                取消
              </Button>
            </div>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {teams.length === 0 ? (
            <p className="px-2 py-3 ui-caption">还没有团队。点右上「新建」拉一个。</p>
          ) : (
            teams.map((team) => (
              <button
                key={team.id}
                type="button"
                aria-current={team.id === selectedId}
                onClick={() => void selectTeam(team.id)}
                className={`mb-1 flex w-full flex-col items-start rounded-lg px-2 py-1.5 text-left transition-colors ${
                  team.id === selectedId ? "bg-subtle-4" : "hover:bg-subtle-2"
                } ${FOCUS_RING}`}
              >
                <span className="w-full truncate ui-body-sm font-medium">{team.name}</span>
                <span className="w-full truncate ui-caption">
                  {team.goal || "还没有目标"}
                </span>
              </button>
            ))
          )}
        </div>
        <p className="border-t border-line-soft px-3 py-2 ui-micro leading-4">
          团队只有成员可见；任务与方案智能体也能帮你改（会先请你确认）。
        </p>
      </aside>

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-6 py-5">
        {error && !(!snapshot && loadFailed) && (
          <p role="alert" className="mb-3 rounded-lg border border-danger-line bg-danger-soft px-3 py-2 text-ui-sm text-danger">
            {error}
          </p>
        )}
        {notice && !error && (
          <p role="status" className="mb-3 rounded-lg border border-line-soft bg-subtle px-3 py-2 text-ui-sm">
            {notice}
          </p>
        )}

        {loading ? (
          <p role="status" className="ui-caption">
            正在加载团队…
          </p>
        ) : !snapshot ? (
          loadFailed ? (
            <EmptyState
              title="团队加载失败"
              desc={`${error || "网络请求没有成功"}。请检查网络后重试；已保存的团队数据不会丢失。`}
              actions={
                <Button type="button" size="md" variant="primary" onClick={() => void load()}>
                  重试
                </Button>
              }
            />
          ) : (
            <EmptyState
              title="还没有团队"
              desc="建一个团队，写下目标与方案，把任务派给成员；智能体也能通过工具帮你维护。"
              actions={
                <Button
                  type="button"
                  size="md" variant="primary"
                  onClick={() => setCreateOpen(true)}
                >
                  新建团队
                </Button>
              }
            />
          )
        ) : (
          <div className="mx-auto flex w-full max-w-[1000px] flex-col gap-4">
            <section className="ui-card p-4" aria-label="团队概况">
              <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-0 flex-1">
                  <h2 className="ui-page-title">{snapshot.team.name}</h2>
                  <p className="mt-1 ui-caption">
                    {snapshot.members.length} 名成员 · {snapshot.plans.length} 条方案 ·{" "}
                    {snapshot.tasks.length} 个任务
                    {isOwner ? " · 你是队长" : ""}
                  </p>
                  <p
                    data-testid="team-summary"
                    data-overdue={summary.overdue > 0 ? "true" : "false"}
                    className={
                      summary.overdue > 0
                        ? "mt-1 inline-flex rounded-full bg-danger-soft px-2 py-0.5 ui-caption text-danger"
                        : "mt-1 ui-caption"
                    }
                  >
                    进度：{describeTeamSummary(summary)}
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm" variant="ghost"
                  aria-label="生成团队周报"
                  disabled={busy}
                  onClick={openWeeklyReport}
                >
                  生成周报
                </Button>
                <Button
                  type="button"
                  size="sm" variant="ghost"
                  aria-label="刷新团队数据"
                  disabled={busy}
                  onClick={() => void refreshNow()}
                >
                  刷新
                </Button>
                {isOwner && (
                  <Button
                    type="button"
                    size="sm" variant="ghost" className="text-muted"
                    onClick={() => setConfirmDeleteTeam(true)}
                  >
                    删除团队
                  </Button>
                )}
              </div>

              {/* 目标 */}
              <div className="mt-3">
                <div className="mb-1 flex items-center gap-2">
                  <span className="text-ui-sm font-semibold text-muted">团队目标</span>
                  {isOwner && !goalEditing && (
                    <button
                      type="button"
                      className="ui-link ml-auto"
                      onClick={() => {
                        setGoalDraft(snapshot.team.goal);
                        setGoalEditing(true);
                      }}
                    >
                      编辑
                    </button>
                  )}
                </div>
                {goalEditing ? (
                  <div>
                    <textarea
                      aria-label="编辑团队目标"
                      value={goalDraft}
                      onChange={(e) => setGoalDraft(e.target.value)}
                      rows={3}
                      className="ui-input w-full resize-y"
                    />
                    <div className="mt-2 flex gap-2">
                      <Button
                        type="button"
                        size="sm" variant="primary"
                        disabled={busy}
                        onClick={() =>
                          void run(
                            () => updateWorkspaceTeam(snapshot.team.id, { goal: goalDraft.trim() }),
                            "目标已更新",
                          ).then((ok) => ok && setGoalEditing(false))
                        }
                      >
                        保存
                      </Button>
                      <Button
                        type="button"
                        size="sm" variant="ghost"
                        onClick={() => setGoalEditing(false)}
                      >
                        取消
                      </Button>
                    </div>
                  </div>
                ) : (
                  <p className="whitespace-pre-wrap text-ui-md leading-6">
                    {snapshot.team.goal || "还没有写目标。写清楚「这个团队要达成什么」，方案与任务才有对齐的依据。"}
                  </p>
                )}
              </div>

              {/* 成员 */}
              <div className="mt-4">
                <div className="mb-1.5 flex flex-wrap items-center gap-2">
                  <span className="text-ui-sm font-semibold text-muted">成员</span>
                  {snapshot.members.map((m) => (
                    <span key={m.user.id} className="ui-chip">
                      <span data-testid={`team-member-${m.role === "owner" ? "leader" : "member"}`}>
                        {m.user.displayName}
                        {m.role === "owner" ? " · 队长" : ""}
                      </span>
                      {isOwner && m.role !== "owner" && (
                        <>
                          <button
                            type="button"
                            aria-label={`转让队长给 ${m.user.displayName}`}
                            className="ml-1.5 text-muted hover:text-accent"
                            onClick={() => setPendingTransferTo(m)}
                          >
                            转让
                          </button>
                          <button
                            type="button"
                            aria-label={`移除成员 ${m.user.displayName}`}
                            className="ml-1 text-muted hover:text-danger"
                            onClick={() => setPendingRemoveMember(m)}
                          >
                            ×
                          </button>
                        </>
                      )}
                    </span>
                  ))}
                </div>
                {isOwner && (
                  <form
                    className="flex flex-wrap items-center gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const username = memberName.trim();
                      if (!username) return;
                      void run(
                        () => addWorkspaceMember(snapshot.team.id, username),
                        "成员已加入",
                      ).then((ok) => ok && setMemberName(""));
                    }}
                  >
                    <input
                      aria-label="成员用户名"
                      value={memberName}
                      onChange={(e) => setMemberName(e.target.value)}
                      placeholder="按用户名加成员（对方需已注册）"
                      className="ui-input w-[240px]"
                    />
                    <Button
                      type="submit"
                      size="sm" variant="ghost"
                      disabled={busy || !memberName.trim()}
                    >
                      添加
                    </Button>
                  </form>
                )}
                {isOwner && joinRequests.filter((r) => r.status === "pending").length > 0 && (
                  <div className="mt-3 border-t border-line-soft pt-2">
                    <p className="ui-caption mb-1.5">
                      待审加入申请（{joinRequests.filter((r) => r.status === "pending").length}）
                    </p>
                    <div className="flex flex-col gap-1.5">
                      {joinRequests
                        .filter((r) => r.status === "pending")
                        .map((r) => (
                          <div key={r.id} className="flex flex-wrap items-center gap-2 rounded-lg bg-subtle px-2 py-1.5">
                            <span className="min-w-0 flex-1 ui-body-sm">
                              用户 {r.userId}
                              {r.message && <span className="ui-caption"> · {r.message}</span>}
                            </span>
                            <Button
                              type="button"
                              size="sm" variant="primary"
                              disabled={busy}
                              onClick={() => void review(r.id, "approve")}
                            >
                              通过
                            </Button>
                            <Button
                              type="button"
                              size="sm" variant="ghost"
                              disabled={busy}
                              onClick={() => void review(r.id, "reject")}
                            >
                              拒绝
                            </Button>
                          </div>
                        ))}
                    </div>
                  </div>
                )}
                {canLeave && (
                  <div className="mt-2">
                    <Button
                      type="button"
                      size="sm" variant="ghost"
                      className="text-muted"
                      disabled={busy}
                      onClick={() => setConfirmLeaveTeam(true)}
                    >
                      退出团队
                    </Button>
                  </div>
                )}
              </div>
            </section>

            <TeamPlanPanel
              teamId={snapshot.team.id}
              plans={snapshot.plans}
              tasks={snapshot.tasks}
              busy={busy}
              onChanged={(next) => setSnapshot(next)}
            />

            {/* 按截止日看：和任务板是两条不同的轴（谁在做什么 vs 今天该交什么）。 */}
            <TeamSchedulePanel tasks={snapshot.tasks} members={snapshot.members} />

            <TeamTaskPanel
              teamId={snapshot.team.id}
              viewerId={me?.id ?? ""}
              ownerId={snapshot.team.ownerId}
              plans={snapshot.plans}
              members={snapshot.members}
              tasks={snapshot.tasks}
              busy={busy}
              onChanged={(next) => setSnapshot(next)}
            />

            <TeamActivityPanel teamId={snapshot.team.id} members={snapshot.members} />
          </div>
        )}
      </div>

      {/* 破坏性操作统一走应用内确认框：取消 = 不发请求，初始焦点在「取消」。 */}
      {confirmDeleteTeam && snapshot ? (
        <ConfirmDialog
          title="删除团队？"
          onCancel={() => setConfirmDeleteTeam(false)}
          initialFocusRef={cancelDeleteTeamRef}
          footer={
            <>
              <Button
                type="button"
                ref={cancelDeleteTeamRef}
                size="md" variant="ghost"
                onClick={() => setConfirmDeleteTeam(false)}
              >
                取消
              </Button>
              <Button
                type="button"
                size="md" variant="danger"
                disabled={busy}
                onClick={() => void deleteTeamNow()}
              >
                删除
              </Button>
            </>
          }
        >
          <p className="ui-body-sm">
            删除团队「{snapshot.team.name}」？团队下的方案与任务会一起删除，且不可恢复。
            任务交付物文件仍保留在共享文件库，需要时请到文件库单独清理。
          </p>
        </ConfirmDialog>
      ) : null}

      {pendingRemoveMember ? (
        <ConfirmDialog
          title="移除成员？"
          onCancel={() => setPendingRemoveMember(null)}
          initialFocusRef={cancelRemoveMemberRef}
          footer={
            <>
              <Button
                type="button"
                ref={cancelRemoveMemberRef}
                size="md" variant="ghost"
                onClick={() => setPendingRemoveMember(null)}
              >
                取消
              </Button>
              <Button
                type="button"
                size="md" variant="danger"
                disabled={busy}
                onClick={() => void removeMemberNow()}
              >
                移除
              </Button>
            </>
          }
        >
          <p className="ui-body-sm">
            移除成员「{pendingRemoveMember.user.displayName}」？移除后他的任务会解绑为待认领，需要重新指派。
          </p>
        </ConfirmDialog>
      ) : null}

      {pendingTransferTo && snapshot ? (
        <ConfirmDialog
          title="转让队长？"
          onCancel={() => setPendingTransferTo(null)}
          initialFocusRef={cancelTransferRef}
          footer={
            <>
              <Button
                type="button"
                ref={cancelTransferRef}
                size="md" variant="ghost"
                onClick={() => setPendingTransferTo(null)}
              >
                取消
              </Button>
              <Button
                type="button"
                size="md" variant="primary"
                disabled={busy}
                onClick={() => void transferOwnerNow()}
              >
                转让
              </Button>
            </>
          }
        >
          <p className="ui-body-sm">
            把队长转让给「{pendingTransferTo.user.displayName}」？转让后你会变成普通成员：
            只有新队长能改团队名称与目标、加人或移人、解散团队。
          </p>
        </ConfirmDialog>
      ) : null}

      {confirmLeaveTeam && snapshot ? (
        <ConfirmDialog
          title="退出团队？"
          onCancel={() => setConfirmLeaveTeam(false)}
          initialFocusRef={cancelLeaveRef}
          footer={
            <>
              <Button
                type="button"
                ref={cancelLeaveRef}
                size="md" variant="ghost"
                onClick={() => setConfirmLeaveTeam(false)}
              >
                取消
              </Button>
              <Button
                type="button"
                size="md" variant="danger"
                disabled={busy}
                onClick={() => void leaveTeamNow()}
              >
                退出
              </Button>
            </>
          }
        >
          <p className="ui-body-sm">
            退出「{snapshot.team.name}」？退出后这个团队对你不再可见，指给你的任务会解绑为待认领；
            要重新加入需要队长再把你拉回来。
          </p>
        </ConfirmDialog>
      ) : null}

      {reportOpen ? (
        <Dialog
          ariaLabel="团队周报"
          title="团队周报"
          description="按所选时间窗内的真实事实生成；可以直接复制，或导出成 .md 存下来。"
          size="lg"
          onClose={() => setReportOpen(false)}
          footer={
            <>
              <Button
                type="button"
                size="md" variant="primary"
                onClick={() => void copyWeeklyReport()}
              >
                复制
              </Button>
              <Button
                type="button"
                size="md" variant="ghost"
                disabled={reportBusy}
                onClick={() => void exportWeeklyReport()}
              >
                导出 .md
              </Button>
            </>
          }
        >
          <div className="mb-3 flex items-center gap-2 ui-caption">
            <label htmlFor="weekly-report-days">回看天数</label>
            <select
              id="weekly-report-days"
              aria-label="周报回看天数"
              value={reportDays}
              onChange={(e) => changeReportDays(Number(e.target.value))}
              className="rounded-md border border-line-strong bg-surface px-2 py-1 ui-caption"
            >
              {[7, 14, 30].map((d) => (
                <option key={d} value={d}>
                  最近 {d} 天
                </option>
              ))}
            </select>
            <span className="text-muted">按所选时间窗生成，切档后重算（复制/导出用同一份）</span>
          </div>
          <pre
            data-testid="weekly-report"
            className="max-h-[56vh] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-subtle px-3 py-2 text-ui-sm leading-6"
          >
            {reportText}
          </pre>
        </Dialog>
      ) : null}

      {/* 找团队 / 申请加入：目录只暴露元数据，加入走「申请 → 队长审核」。 */}
      {discoverOpen ? (
        <Dialog
          ariaLabel="找团队"
          title="找团队"
          description="搜索团队目录，提交加入申请；队长审核通过后你即为成员。团队对成员以外不可见。"
          size="lg"
          onClose={() => {
            setDiscoverOpen(false);
            setDiscoverNotice("");
          }}
        >
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void searchDirectory();
            }}
          >
            <input
              aria-label="搜索团队"
              value={discoverQuery}
              onChange={(e) => setDiscoverQuery(e.target.value)}
              placeholder="按团队名或目标搜索"
              className="ui-input flex-1"
            />
            <Button type="submit" size="md" variant="primary" disabled={discoverLoading}>
              搜索
            </Button>
          </form>

          {discoverNotice && (
            <p role="status" className="mt-2 rounded-lg bg-subtle px-2 py-1.5 ui-caption">
              {discoverNotice}
            </p>
          )}

          {applyTeam ? (
            <div className="mt-3 rounded-lg border border-line-soft p-3">
              <p className="ui-body-sm font-medium">申请加入「{applyTeam.name}」</p>
              <textarea
                aria-label="申请附言"
                value={applyMessage}
                onChange={(e) => setApplyMessage(e.target.value)}
                placeholder="附言（可选，最多 200 字）"
                rows={2}
                className="ui-input mt-2 w-full resize-y"
              />
              <div className="mt-2 flex gap-2">
                <Button type="button" size="sm" variant="primary" disabled={busy} onClick={() => void submitJoinRequest()}>
                  提交申请
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => { setApplyTeam(null); setApplyMessage(""); }}>
                  取消
                </Button>
              </div>
            </div>
          ) : (
            <div className="mt-3 flex max-h-[40vh] flex-col gap-1.5 overflow-y-auto">
              {discoverLoading ? (
                <p className="ui-caption">正在搜索…</p>
              ) : discoverResults.length === 0 ? (
                <p className="ui-caption">没有找到匹配的团队，换个词试试。</p>
              ) : (
                discoverResults.map((t) => {
                  const myApps = myRequests.filter((r) => r.teamId === t.id);
                  const pending = myApps.some((r) => r.status === "pending");
                  const approved = myApps.some((r) => r.status === "approved");
                  const joined = teams.some((x) => x.id === t.id);
                  return (
                    <div key={t.id} className="flex items-center gap-2 rounded-lg border border-line-soft px-3 py-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate ui-body-sm font-medium">{t.name}</p>
                        <p className="truncate ui-caption">
                          {t.memberCount} 名成员{t.goal ? ` · ${t.goal}` : ""}
                        </p>
                      </div>
                      {joined ? (
                        <span className="ui-caption text-muted">已加入</span>
                      ) : approved ? (
                        <span className="ui-caption text-muted">已通过</span>
                      ) : pending ? (
                        <span className="ui-caption text-muted">待审核</span>
                      ) : (
                        <Button
                          type="button"
                          size="sm" variant="ghost"
                          onClick={() => { setApplyTeam(t); setApplyMessage(""); setDiscoverNotice(""); }}
                        >
                          申请加入
                        </Button>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          )}

          {myRequests.length > 0 && (
            <div className="mt-3 border-t border-line-soft pt-2">
              <p className="ui-caption mb-1">我的申请</p>
              <div className="flex max-h-[20vh] flex-col gap-1 overflow-y-auto">
                {myRequests.map((r) => {
                  const teamName = discoverResults.find((t) => t.id === r.teamId)?.name ?? r.teamId;
                  return (
                    <p key={r.id} className="ui-caption">
                      「{teamName}」· {r.status === "pending" ? "待审核" : r.status === "approved" ? "已通过" : "已拒绝"}
                    </p>
                  );
                })}
              </div>
            </div>
          )}
        </Dialog>
      ) : null}
    </div>
  );
}
