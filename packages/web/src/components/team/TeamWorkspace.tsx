import { useCallback, useEffect, useRef, useState } from "react";
import type { TeamWorkspaceSnapshot, WorkspaceTeam, WorkspaceTeamMember } from "@heming/shared";
import {
  addWorkspaceMember,
  createWorkspaceTeam,
  deleteWorkspaceTeam,
  fetchWorkspaceTeam,
  fetchWorkspaceTeams,
  leaveWorkspaceTeam,
  removeWorkspaceMember,
  transferWorkspaceTeamOwner,
  updateWorkspaceTeam,
} from "../../lib/api.js";
import { useAuthStore } from "../../store/auth.js";
import { useSessionStringValue } from "../../lib/sessionState.js";
import { EmptyState } from "../ui/EmptyState.js";
import { TeamPlanPanel } from "./TeamPlanPanel.js";
import { TeamTaskPanel } from "./TeamTaskPanel.js";
import { FOCUS_RING } from "../../lib/a11y/focus.js";
import { ConfirmDialog } from "../ConfirmDialog.js";
import { Button } from "../../components/ui/Button.js";

/**
 * 团队工作台（d.92）：用户自建团队 —— 名字 / 目标 / 方案 / 任务 / 成员。
 *
 * 与隔壁「团队页」两层语义（d.152）：那边是「自己 + 同队成员」的名册与摘要（没有团队时只有自己）；
 * 这里是用户自己拉的工作组本身（方案 / 任务 / 成员），只有成员可见。所有写操作都有对应的 REST 接口与智能体工具（team_*），
 * 权限判定只在服务端一处（是否成员 / 是否 owner），前端只做展示与提示。
 */

const SELECTED_TEAM_KEY = "heming.team.selected.v1";

/**
 * 工作台静默轮询间隔：队友改了任务/方案，不用切 Tab 也能在 45s 内看到。
 *
 * 为什么是 45s：工作台不是实时聊天（有 60s 的动向流与 30s 的看板先例），
 * 比看板松一点、比动向紧一点；再快只会在没人看的时候白烧请求。
 */
const WORKSPACE_POLL_MS = 45_000;

/** 一次性提示（notice）的展示时长。 */
const NOTICE_MS = 3000;

export function TeamWorkspace() {
  const me = useAuthStore((s) => s.user);
  const [teams, setTeams] = useState<WorkspaceTeam[]>([]);
  const [selectedId, setSelectedId] = useSessionStringValue(SELECTED_TEAM_KEY);
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

  // 新建团队表单
  const [createOpen, setCreateOpen] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftGoal, setDraftGoal] = useState("");
  // 目标编辑
  const [goalEditing, setGoalEditing] = useState(false);
  const [goalDraft, setGoalDraft] = useState("");
  // 团队成员
  const [memberName, setMemberName] = useState("");

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
    return data.teams;
  }, []);

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
  /** 我在这个团队里的成员身份：成员才有「退出团队」，owner 必须先转让。 */
  const mine = snapshot && me ? snapshot.members.find((m) => m.user.id === me.id) : undefined;
  /** 只有普通成员能自退：owner 走「转让队长」或「删除团队」。 */
  const canLeave = Boolean(mine) && !isOwner;

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

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-[240px] shrink-0 flex-col border-r border-line-soft">
        <div className="flex items-center gap-2 border-b border-line-soft px-3 py-2.5">
          <span className="ui-section-title">我的团队</span>
          <span className="ui-micro">{teams.length}</span>
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
                </div>
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
                      {m.user.displayName}
                      {m.role === "owner" ? " · 队长" : ""}
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
              busy={busy}
              onChanged={(next) => setSnapshot(next)}
            />

            <TeamTaskPanel
              teamId={snapshot.team.id}
              plans={snapshot.plans}
              members={snapshot.members}
              tasks={snapshot.tasks}
              busy={busy}
              onChanged={(next) => setSnapshot(next)}
            />
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
    </div>
  );
}
