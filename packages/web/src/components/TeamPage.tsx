import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSessionTab } from "../lib/sessionState.js";
import type {
  TeamActivity,
  TeamActivityKind,
  TeamMember,
  TeamUsageRange,
  TeamUsageResponse,
} from "@heming/shared";
import {
  clearMyTeamActivities,
  clearMyTeamUsage,
  fetchTeam,
  fetchTeamActivities,
  fetchTeamUsage,
  uploadTeamActivities,
  uploadTeamUsage,
} from "../lib/api.js";
import {
  collectCurrentTeamActivities,
  collectCurrentTeamUsage,
  summarizeLocalUsage,
  useTeamShareStore,
} from "../lib/team/share.js";
import { useInfohubStore } from "../lib/infohub/store.js";
import { activitySummaryLabel } from "../lib/team/labels.js";
import { useAuthStore } from "../store/auth.js";
import { useUiStore } from "../store/ui.js";
import { dayKeyOf, useTokenUsageStore } from "../store/tokenUsage.js";
import { FOCUS_RING, FOCUS_RING_TIGHT } from "../lib/a11y/focus.js";
import { PageShell } from "./layout/PageShell.js";
import { PAGE_TABLIST, pageTabClass } from "../lib/ui/tabStyles.js";
import { fmtTokens } from "../lib/format/tokens.js";
import { Avatar } from "./Avatar.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { TeamBoardView } from "./TeamBoardPage.js";
import { TeamWorkspace } from "./team/TeamWorkspace.js";

/**
 * 团队页（去 IM 后的主入口）：
 * 左栏名册只列真实成员（在线/最近活跃），右栏动向流只收成员自己的任务与日程摘要。
 *
 * 智能体不是团队成员：对话、工具轨迹与幕僚简报都留在「智能体」/「幕僚」页，
 * 不进名册、不进动向。动向是**服务端摘要事件**，不是聊天消息；本机只上报
 * 白名单字段，具体采集与隐私开关见 `lib/team/share.ts`。
 */

const ROSTER_POLL_MS = 20_000;
const FEED_POLL_MS = 60_000;
const PAGE_SIZE = 50;

const KIND_LABEL: Record<TeamActivityKind, string> = {
  task: "任务",
  agent: "AI",
  staff: "幕僚",
  agenda: "日程",
  join: "加入",
};

const FILTERS: { key: "all" | TeamActivityKind; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "task", label: "任务" },
  { key: "agenda", label: "日程" },
];

/** 团队动向只收真实成员的这两类；智能体侧的 staff/agent 即使有旧数据也不展示。 */
const HUMAN_KINDS: readonly TeamActivityKind[] = ["task", "agenda"];

function sameLocalDay(iso: string, now = new Date()): boolean {
  const d = new Date(iso);
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return sameLocalDay(iso, now)
    ? hm
    : `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${hm}`;
}

function fmtLastSeen(iso: string | null): string {
  if (!iso) return "从未登录";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "从未登录";
  const diff = Math.max(0, Date.now() - at);
  if (diff < 60_000) return "刚刚活跃";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前活跃`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前活跃`;
  return `${Math.floor(diff / 86_400_000)} 天前活跃`;
}

/** 团队视图 Tab 的会话级记忆：刷新回到上次看的视图（关窗重开回「动向」）。 */
const TEAM_TAB_KEY = "heming.tab.team.v1";
const TEAM_TABS = ["workspace", "feed", "board", "agenda", "usage"] as const;
type TeamTab = (typeof TEAM_TABS)[number];

export function TeamPage() {
  const me = useAuthStore((s) => s.user);
  const focusUserId = useUiStore((s) => s.teamFocusUserId);
  const consumeTeamFocus = useUiStore((s) => s.consumeTeamFocus);
  const focusActivityId = useUiStore((s) => s.teamFocusActivityId);
  const consumeTeamActivityFocus = useUiStore((s) => s.consumeTeamActivityFocus);
  /** 一次性视图意图（d.67）：旧「团队看板」链接会被折叠成 team + pageView="board"。 */
  const pageView = useUiStore((s) => s.pageView);
  const setPage = useUiStore((s) => s.setPage);
  const share = useTeamShareStore((s) => s.settings);
  const updateShare = useTeamShareStore((s) => s.update);

  const [members, setMembers] = useState<TeamMember[]>([]);
  const [onlineCount, setOnlineCount] = useState(0);
  const [rosterReady, setRosterReady] = useState(false);
  const [rosterError, setRosterError] = useState("");
  const [activities, setActivities] = useState<TeamActivity[]>([]);
  const [feedReady, setFeedReady] = useState(false);
  const [feedError, setFeedError] = useState("");
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [syncError, setSyncError] = useState("");
  const [filter, setFilter] = useState<"all" | TeamActivityKind>("all");
  const [memberQuery, setMemberQuery] = useState("");
  const [onlineOnly, setOnlineOnly] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** 从首页点进来的那一条动向：滚动到它并高亮 2.4 秒（一次性，不落盘）。 */
  const [highlightActivityId, setHighlightActivityId] = useState<string | null>(null);
  /** 深链未命中时的一次性说明（不落盘）。 */
  const [linkNotice, setLinkNotice] = useState("");
  /** 成员详情里点「最近动向」的滚动目标：等行渲染出来再滚（筛选可能刚被切回全部）。 */
  const [scrollToActivityId, setScrollToActivityId] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  /**
   * 团队页四个视图互斥：动向（默认）/ 看板 / 团队日程（只读）/ 用量。
   * 挤在一屏会把「摘要流」和「排行」互相压扁，切 Tab 反而是最省事的读法。
   * 看板是 d.67 从独立页（旧 workspace）并进来的——它保留自己的取数与筛选，
   * 只把「页面外壳」换成这里的 Tab。
   */
  const [tab, setTab] = useSessionTab<TeamTab>(TEAM_TAB_KEY, "feed", TEAM_TABS);
  const [usageRange, setUsageRange] = useState<TeamUsageRange>("7d");
  const [usage, setUsage] = useState<TeamUsageResponse | null>(null);
  const [usageReady, setUsageReady] = useState(false);
  const [usageError, setUsageError] = useState("");
  const [usageSyncing, setUsageSyncing] = useState(false);
  const [confirmClearUsage, setConfirmClearUsage] = useState(false);
  const [clearingUsage, setClearingUsage] = useState(false);
  const usageRecords = useTokenUsageStore((s) => s.records);
  /** 信息中枢是否在本机运行：团队日程空态要区分「未连接」与「没有摘要」。 */
  const infohubRunning = useInfohubStore((s) => s.running);
  // 翻页游标要读「当下最新的列表」，但列表进 loadFeed 依赖会让定时刷新反复重建：
  // 用 ref 兜住当前值，回调只认 selectedId 这一个请求口径。
  const activitiesRef = useRef<TeamActivity[]>([]);
  activitiesRef.current = activities;

  const loadRoster = useCallback(async () => {
    try {
      const data = await fetchTeam();
      setMembers(data.members);
      setOnlineCount(data.onlineCount);
      setRosterError("");
      setRosterReady(true);
    } catch (err) {
      setRosterError(err instanceof Error && err.message ? err.message : "网络异常");
      setRosterReady(true);
    }
  }, []);

  const loadFeed = useCallback(
    async (reset: boolean) => {
      const cursor = activitiesRef.current;
      try {
        const data = await fetchTeamActivities({
          limit: PAGE_SIZE,
          // 游标必须带 id：只按 occurredAt 严格小于翻页，会漏掉与游标同一时刻的剩余条目
          // （d.109 A2）。beforeId 是可选的新参数，旧服务端会忽略它、行为退回旧口径。
          ...(!reset && cursor.length
            ? { before: cursor[cursor.length - 1].occurredAt, beforeId: cursor[cursor.length - 1].id }
            : {}),
          ...(selectedId ? { actorId: selectedId } : {}),
        });
        setActivities((prev) => {
          if (reset) return data.activities;
          const known = new Set(prev.map((a) => a.id));
          return [...prev, ...data.activities.filter((a) => !known.has(a.id))];
        });
        setHasMore(data.activities.length >= PAGE_SIZE);
        setFeedError("");
        setFeedReady(true);
      } catch (err) {
        setFeedError(err instanceof Error && err.message ? err.message : "网络异常");
        setFeedReady(true);
      }
    },
    // 只有选中成员决定请求口径；翻页游标走 activitiesRef，避免每次加载重建回调
    [selectedId],
  );

  useEffect(() => {
    void loadRoster();
    const timer = window.setInterval(() => void loadRoster(), ROSTER_POLL_MS);
    return () => window.clearInterval(timer);
  }, [loadRoster]);

  useEffect(() => {
    void loadFeed(true);
    const timer = window.setInterval(() => void loadFeed(true), FEED_POLL_MS);
    return () => window.clearInterval(timer);
  }, [loadFeed]);

  // 命令面板「搜索成员 → 选中」的一次性投递
  useEffect(() => {
    if (!focusUserId) return;
    setSelectedId(focusUserId);
    consumeTeamFocus();
  }, [focusUserId, consumeTeamFocus]);

  // 视图意图消费（d.67）：旧链接 setPage("workspace") / 看板跳转落在本页时切到「看板」。
  // 读走即清，避免用户切走再回来还被上次跳转钉在看板（意图只对「这一次进入」有效）。
  useEffect(() => {
    if (!pageView) return;
    const view = useUiStore.getState().consumePageView();
    if (view === "board") setTab("board");
  }, [pageView]);

  const tasksOn = share.tasks;
  const agendaOn = share.agenda;

  /** 采集并上报本机摘要（幂等：重复同步只在服务端跳过）。 */
  const sync = useCallback(async () => {
    const current = useTeamShareStore.getState().settings;
    if (!current.tasks && !current.agenda) return;
    const items = collectCurrentTeamActivities(current);
    if (items.length === 0) return;
    try {
      const result = await uploadTeamActivities(items);
      useTeamShareStore.getState().setLastSync(Date.now());
      setSyncError("");
      if (result.inserted > 0) void loadFeed(true);
    } catch (err) {
      setSyncError(err instanceof Error && err.message ? err.message : "网络异常");
    }
  }, [loadFeed]);

  useEffect(() => {
    if (!tasksOn && !agendaOn) return;
    void sync();
    const timer = window.setInterval(() => void sync(), FEED_POLL_MS);
    const onFocus = () => {
      void loadRoster();
      void loadFeed(true);
      void sync();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [tasksOn, agendaOn, sync, loadRoster, loadFeed]);

  const selectedMember = useMemo(
    () => members.find((m) => m.user.id === selectedId) ?? null,
    [members, selectedId],
  );

  /* ------------------------------------------------------- ②-3 用量与团队日程 */

  const rangeDays = usageRange === "7d" ? 7 : 30;
  /** 本机用量（关闭共享时展示；纯本地计算，不产生任何请求）。 */
  const localUsage = useMemo(
    () => summarizeLocalUsage(usageRecords, rangeDays),
    [usageRecords, rangeDays],
  );

  /**
   * 用量同步：**只有开启 `usage` 共享才采集 + 上传 + 拉排行**。
   *
   * 关闭时直接返回：不上传、不采集——这是隐私红线，不是省流量的优化。
   */
  const syncUsage = useCallback(async () => {
    const current = useTeamShareStore.getState().settings;
    if (!current.usage) return;
    setUsageSyncing(true);
    try {
      const items = collectCurrentTeamUsage(current);
      if (items.length > 0) await uploadTeamUsage(items);
      const data = await fetchTeamUsage({
        range: usageRange,
        to: dayKeyOf(new Date().toISOString()),
      });
      setUsage(data);
      setUsageError("");
      setUsageReady(true);
      useTeamShareStore.getState().setLastSync(Date.now());
    } catch (err) {
      setUsageError(err instanceof Error && err.message ? err.message : "网络异常");
      setUsageReady(true);
    } finally {
      setUsageSyncing(false);
    }
  }, [usageRange]);

  useEffect(() => {
    if (!share.usage) {
      // 关闭共享：清空服务端返回的排行（不留在内存里），也不发任何用量请求。
      setUsage(null);
      setUsageReady(true);
      return;
    }
    void syncUsage();
  }, [share.usage, syncUsage]);

  useEffect(() => {
    if (!share.usage) return;
    const timer = window.setInterval(() => void syncUsage(), FEED_POLL_MS);
    return () => window.clearInterval(timer);
  }, [share.usage, syncUsage]);

  /**
   * 清除本人已上传的用量（显式动作，不随「关共享」自动发生）。
   *
   * 关闭共享只停未来上传——旧行还在服务端、人还在排行里，那不是隐私口径。
   * 删除后落一个本地水位：水位之前的用量不再重新上传，否则下一轮同步会把刚删的传回去。
   */
  const onClearUsage = async () => {
    setClearingUsage(true);
    try {
      await clearMyTeamUsage();
      useTeamShareStore.getState().setUsageClearedAt(Date.now());
      setUsage(null);
      setUsageReady(true);
      setUsageError("");
      // 仍开着共享时重拉一次：排行里应当已经没有自己
      if (useTeamShareStore.getState().settings.usage) await syncUsage();
    } catch (err) {
      setUsageError(err instanceof Error && err.message ? err.message : "网络异常");
    } finally {
      setClearingUsage(false);
      setConfirmClearUsage(false);
    }
  };

  const filteredMembers = useMemo(() => {
    const q = memberQuery.trim().toLowerCase();
    return members.filter((m) => {
      if (onlineOnly && !m.online) return false;
      if (!q) return true;
      return (
        m.user.displayName.toLowerCase().includes(q) ||
        m.user.username.toLowerCase().includes(q)
      );
    });
  }, [members, memberQuery, onlineOnly]);

  // 服务端契约仍接受更多 kind（旧数据可能来自 d.54 早期），团队页只渲染成员侧两类。
  const humanActivities = useMemo(
    () => activities.filter((a) => HUMAN_KINDS.includes(a.kind)),
    [activities],
  );

  /** 成员详情升级（d.88 / d.109）：除了「他是谁」，也给「他最近干了多少、最近三条是什么」——动向条数 + 最近 3 条 + 排行里的用量。 */
  const selectedMemberStats = useMemo(() => {
    if (!selectedMember) return null;
    const recent = humanActivities.filter((a) => a.actorId === selectedMember.user.id);
    const rank = usage?.ranking.find((r) => r.userId === selectedMember.user.id) ?? null;
    return {
      recentCount: recent.length,
      latest: recent[0] ?? null,
      recentThree: recent.slice(0, 3),
      rank,
    };
  }, [selectedMember, humanActivities, usage]);

  const visibleActivities = useMemo(
    () => humanActivities.filter((a) => filter === "all" || a.kind === filter),
    [humanActivities, filter],
  );

  // 首页动向条目 → 定位到那一条：切回「动向」视图、滚到它、临时高亮，读走即清。
  //
  // d.109 修复两个回归：
  // 1) 原来高亮计时器与 consume 在同一个 effect 里——consume 让 focusActivityId 变 null，
  //    effect 重跑 → cleanup clearTimeout → 高亮再也不褪（d.91 规格要求 2.4s）；
  // 2) 原来只有命中才消费，条目不在一页/被筛选掉时意图永久残留，之后每次进团队页都被
  //    强制切到「动向」。
  useEffect(() => {
    if (!focusActivityId) return;
    setTab("feed");
    const el = document.querySelector(`[data-activity-id="${focusActivityId}"]`);
    if (!el) return;
    setHighlightActivityId(focusActivityId);
    consumeTeamActivityFocus();
    el.scrollIntoView({ block: "center" });
  }, [focusActivityId, visibleActivities, consumeTeamActivityFocus]);

  // 数据已就绪但仍找不到该条：可能是已被清理、超过最近一页，或被当前筛选排除。
  // 这时消费意图并如实说明，而不是把它留到下一次进团队页再强制切 Tab。
  // 加载失败时不要走这条兜底：那会把「网络挂了」说成「这条没了」。
  useEffect(() => {
    if (!focusActivityId || !feedReady || feedError) return;
    if (document.querySelector(`[data-activity-id="${focusActivityId}"]`)) return;
    consumeTeamActivityFocus();
    setLinkNotice("该动向已不在最近的列表里，已为你打开团队动向。");
  }, [focusActivityId, feedReady, feedError, visibleActivities, consumeTeamActivityFocus]);

  // 高亮独立计时：跟 focus 消费解耦，2.4 秒后一定褪去。
  useEffect(() => {
    if (!highlightActivityId) return;
    const timer = window.setTimeout(() => setHighlightActivityId(null), 2400);
    return () => window.clearTimeout(timer);
  }, [highlightActivityId]);

  // 深链说明的消失计时（与 focus 解耦，避免被上面的 cleanup 顺手清掉）。
  useEffect(() => {
    if (!linkNotice) return;
    const timer = window.setTimeout(() => setLinkNotice(""), 6000);
    return () => window.clearTimeout(timer);
  }, [linkNotice]);

  // 成员详情「最近动向」点击：等筛选切回全部、目标行渲染后再滚动。
  useEffect(() => {
    if (!scrollToActivityId) return;
    const el = document.querySelector(`[data-activity-id="${scrollToActivityId}"]`);
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    setScrollToActivityId(null);
  }, [scrollToActivityId, visibleActivities]);

  /** 成员详情里点一条最近动向：切回「全部」筛选、高亮并滚过去。 */
  const focusActivityRow = (id: string) => {
    if (filter !== "all") setFilter("all");
    setHighlightActivityId(id);
    setScrollToActivityId(id);
  };



  /** 团队日程：只读，来源是既有 `agenda` 摘要通道（不新增任何上传）。升序 = 先到期的在前。 */
  const agendaActivities = useMemo(
    () =>
      humanActivities
        .filter((a) => a.kind === "agenda")
        .sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : 0)),
    [humanActivities],
  );

  /**
   * 排行渲染顺序：服务端已按 token 降序返回，这里再排一次——
   * 排序是展示口径，不该依赖「服务端一定排过」这种跨端约定。
   */
  const rankingRows = useMemo(
    () =>
      [...(usage?.ranking ?? [])].sort(
        (a, b) => b.tokens - a.tokens || a.displayName.localeCompare(b.displayName, "zh-Hans-CN"),
      ),
    [usage],
  );

  /** 本人是否还有已上传的用量行（决定要不要给「清除我的用量」）。 */
  const hasUploadedUsage = (usage?.self.byModel.length ?? 0) > 0;

  const todayCount = useMemo(
    () => humanActivities.filter((a) => sameLocalDay(a.occurredAt)).length,
    [humanActivities],
  );

  const nameOf = (actorId: string) =>
    members.find((m) => m.user.id === actorId)?.user.displayName ?? "成员";

  const avatarOf = (actorId: string) => {
    const user = members.find((m) => m.user.id === actorId)?.user;
    return { displayName: user?.displayName ?? "成员", avatar: user?.avatar };
  };

  const onClearMine = async () => {
    setClearing(true);
    try {
      await clearMyTeamActivities();
      useTeamShareStore.getState().setLastSync(null);
      setSyncError("");
      await loadFeed(true);
    } catch (err) {
      setSyncError(err instanceof Error && err.message ? err.message : "网络异常");
    } finally {
      setClearing(false);
      setConfirmClear(false);
    }
  };

  const shareCount = [share.tasks, share.agenda, share.usage].filter(Boolean).length;

  /**
   * 关闭某一类共享时的一次性说明（d.88）：关闭只停止未来上报，**不撤回已上传的摘要**——
   * 原来这条口径只有「用量」页签写了，任务/日程关掉后摘要还留在团队里、没有任何提示。
   */
  const [shareNotice, setShareNotice] = useState("");
  const turnOffShare = (kind: "tasks" | "agenda" | "usage") => {
    if (kind === "tasks") updateShare({ tasks: false });
    else if (kind === "agenda") updateShare({ agenda: false });
    else updateShare({ usage: false });
    const label = kind === "tasks" ? "任务摘要" : kind === "agenda" ? "日程摘要" : "用量排行";
    setShareNotice(
      // 撤回路径必须如实：清理按钮只清团队动向，用量有独立的「清除我的用量」。
      kind === "usage"
        ? "已停止上报用量排行；已上传的记录仍在团队排行里，可在「用量」页点「清除我的用量」撤回。"
        : `已停止上报${label}；之前上传的内容仍留在团队里，可用「清除共享记录」撤回。`,
    );
    window.setTimeout(() => setShareNotice(""), 6000);
  };

  return (
    <PageShell
      scroll={false}
      title="团队"
      subtitle={
        <>
          全站一个团队 · {members.length} 名成员 ·{" "}
          <span title="在线 = 当前打开着和鸣（有实时连接）；关掉即离线">
            {onlineCount} 人在线
          </span>{" "}
          · 今日 {todayCount} 条动向
        </>
      }
      actions={
        <span
          className="ui-chip"
          title={`已共享：${[
            share.tasks ? "任务摘要" : "",
            share.agenda ? "日程摘要" : "",
            share.usage ? "用量排行" : "",
          ]
            .filter(Boolean)
            .join("、") || "尚未共享任何内容"}`}
        >
          共享 {shareCount}/3
        </span>
      }
      headerExtra={
        tab === "workspace" ? null : (
        <div className="bg-[var(--subtle)] px-6 py-2">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <span className="ui-caption">
              向团队共享（只上报标题与状态摘要，不含对话、提示词与工具参数；关闭只停止上报，不撤回已上传的内容）：
            </span>
            <div className="flex items-center gap-3" role="group" aria-label="共享内容">
              <label className="flex items-center gap-1 ui-caption">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-[#1a1a1a]"
                  checked={share.tasks}
                  onChange={(e) => (e.target.checked ? updateShare({ tasks: true }) : turnOffShare("tasks"))}
                />
                任务摘要
              </label>
              <label className="flex items-center gap-1 ui-caption">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-[#1a1a1a]"
                  checked={share.agenda}
                  onChange={(e) => (e.target.checked ? updateShare({ agenda: true }) : turnOffShare("agenda"))}
                />
                日程摘要
              </label>
              <label className="flex items-center gap-1 ui-caption">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-[#1a1a1a]"
                  checked={share.usage}
                  onChange={(e) => (e.target.checked ? updateShare({ usage: true }) : turnOffShare("usage"))}
                />
                用量排行
              </label>
            </div>
            {/* 一项都没开时不会同步，显示「尚未同步」会让人以为出了故障 */}
            {shareCount > 0 && (
              <span className="ui-caption">
                {share.lastSyncAt
                  ? `上次同步 ${fmtTime(new Date(share.lastSyncAt).toISOString())}`
                  : "尚未同步"}
              </span>
            )}
            <button
              type="button"
              // 从未共享过（也没同步过）时没有可清除的记录：不用一个点了没反应的按钮骗人
              disabled={shareCount === 0 && !share.lastSyncAt}
              title={
                shareCount === 0 && !share.lastSyncAt
                  ? "还没有可清除的共享记录"
                  : "删除你已上传到团队动向的全部摘要（用量记录请在「用量」页单独清除）"
              }
              className="ui-btn ui-btn-sm ui-btn-ghost ml-auto text-muted disabled:opacity-40"
              onClick={() => setConfirmClear(true)}
            >
              清除共享记录
            </button>
          </div>
          {shareNotice && (
            <p role="status" className="mt-1 ui-micro text-[#92400e]">
              {shareNotice}
            </p>
          )}
          {shareCount === 0 && (
            <p className="mt-1 ui-micro">当前未共享任何内容：团队看不到你的任务、日程或用量。</p>
          )}
          {members.length <= 1 && (
            <p className="mt-1 ui-micro">
              团队目前只有你。团队是全站名册：新同事的账号由管理员在服务端创建，登录后会自动出现在这里。
            </p>
          )}
          {syncError && (
            <p role="alert" className="mt-1 ui-micro text-[var(--danger)]">
              共享同步失败：{syncError}
            </p>
          )}
        </div>
        )
      }
    >
      <div className="flex min-h-0 flex-1">
        {/* 看板自带成员筛选条与两列卡片，再叠一栏名册会把两列挤窄；
            其余视图（动向/日程/用量）仍用名册 + 右栏的结构。 */}
        {tab !== "board" && tab !== "workspace" && (
          <aside className="flex w-[300px] shrink-0 flex-col border-r border-line-soft">
            <div className="border-b border-line-soft p-2.5">
              <input
                value={memberQuery}
                onChange={(e) => setMemberQuery(e.target.value)}
                placeholder="搜索成员…"
                aria-label="搜索团队成员"
                className={`ui-input ${FOCUS_RING}`}
              />
              <div className="mt-1.5 flex items-center justify-between text-[11px]">
                <label className="flex items-center gap-1 text-muted">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-[#1a1a1a]"
                    checked={onlineOnly}
                    onChange={(e) => setOnlineOnly(e.target.checked)}
                  />
                  仅看在线
                </label>
                {selectedId && (
                  <button
                    type="button"
                    className="text-muted underline-offset-2 hover:underline"
                    onClick={() => setSelectedId(null)}
                  >
                    查看全部动向
                  </button>
                )}
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
              {!rosterReady ? (
                <div role="status" aria-busy="true" aria-label="正在加载团队成员" className="space-y-1.5 p-1.5">
                  {[0, 1, 2, 3].map((i) => (
                    <div key={i} className="ui-skeleton h-9 rounded-lg" />
                  ))}
                </div>
              ) : rosterError ? (
                <div className="p-2 text-[12px]">
                  <p role="alert" className="text-[#b42318]">名册加载失败：{rosterError}</p>
                  <button
                    type="button"
                    className="ui-btn ui-btn-sm ui-btn-ghost mt-1"
                    onClick={() => void loadRoster()}
                  >
                    重试
                  </button>
                </div>
              ) : filteredMembers.length === 0 ? (
                <p className="p-2 ui-caption">
                  {members.length === 0 ? "还没有其他成员。" : "没有符合条件的成员。"}
                </p>
              ) : (
                filteredMembers.map((m) => {
                  const selected = m.user.id === selectedId;
                  return (
                    <button
                      key={m.user.id}
                      type="button"
                      onClick={() => setSelectedId(selected ? null : m.user.id)}
                      className={`ui-list-row w-full text-left ${selected ? "bg-[#f2f2f2]" : ""}`}
                    >
                      <span className="relative shrink-0">
                        <Avatar user={m.user} size={28} />
                        <span
                          aria-hidden="true"
                          className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-white ${
                            m.online ? "bg-[#12b76a]" : "bg-[#c4c4c4]"
                          }`}
                        />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1">
                          <span className="truncate ui-body-sm font-medium">
                            {m.user.displayName}
                          </span>
                          {m.user.id === me?.id && (
                            <span className="ui-chip">我</span>
                          )}
                        </span>
                        <span className="block truncate ui-caption">
                          {m.online ? "在线" : fmtLastSeen(m.lastSeenAt)}
                        </span>
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </aside>
        )}

        <main className="flex min-w-0 flex-1 flex-col">
          {tab !== "board" && tab !== "workspace" && selectedMember && (
            <div className="border-b border-line-soft bg-white px-6 py-2.5">
              <div className="flex items-center gap-3">
                <Avatar user={selectedMember.user} size={32} />
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate ui-section-title">
                      {selectedMember.user.displayName}
                    </span>
                    <span className="truncate ui-caption">
                      @{selectedMember.user.username}
                    </span>
                  </div>
                  <div className="ui-caption">
                    {selectedMember.online ? "在线" : fmtLastSeen(selectedMember.lastSeenAt)}
                    {selectedMemberStats
                      ? ` · 近 ${rangeDays} 天动向 ${selectedMemberStats.recentCount} 条`
                      : ""}
                    {selectedMemberStats?.rank
                      ? ` · 用量 ${fmtTokens(selectedMemberStats.rank.tokens)}`
                      : share.usage
                        ? " · 用量暂无"
                        : " · 用量未共享"}
                  </div>
                </div>
                <button
                  type="button"
                  className="ui-btn ui-btn-sm ui-btn-ghost ml-auto text-muted"
                  onClick={() => setSelectedId(null)}
                >
                  返回全部
                </button>
              </div>
              {/* 成员详情升级（d.109）：从「只是个筛选器」变成「他最近在做什么」——
                  近 3 条可点（点了在动向里高亮那条），没有就不编。 */}
              {selectedMemberStats && (
                <div className="mt-2">
                  <span className="ui-caption">最近动向</span>
                  {selectedMemberStats.recentThree.length === 0 ? (
                    <p className="mt-0.5 ui-micro">该成员还没有可显示的动向。</p>
                  ) : (
                    <ul className="mt-0.5 space-y-0.5">
                      {selectedMemberStats.recentThree.map((a) => (
                        <li key={a.id}>
                          <button
                            type="button"
                            onClick={() => focusActivityRow(a.id)}
                            className="flex w-full items-baseline gap-2 rounded-sm px-1 py-0.5 text-left hover:bg-[var(--subtle-2)]"
                          >
                            <span className="shrink-0 ui-chip">{KIND_LABEL[a.kind]}</span>
                            <span className="min-w-0 flex-1 truncate text-[12px]">{a.title}</span>
                            <time dateTime={a.occurredAt} className="shrink-0 ui-caption">
                              {fmtTime(a.occurredAt)}
                            </time>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          )}

          {/* 四个视图互斥：动向（默认）/ 看板 / 团队日程（只读）/ 用量（本机 + 开启共享后的排行） */}
          <div
            className={`${PAGE_TABLIST} items-center border-b border-line-soft px-6`}
            role="tablist"
            aria-label="团队视图"
          >
            {[
              { key: "workspace" as const, label: "工作台" },
              { key: "feed" as const, label: "动向" },
              { key: "board" as const, label: "看板" },
              { key: "agenda" as const, label: "团队日程" },
              { key: "usage" as const, label: "用量" },
            ].map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={tab === t.key}
                onClick={() => setTab(t.key)}
                className={pageTabClass(tab === t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>

          {tab === "workspace" && <TeamWorkspace />}

          {/* 看板：d.67 从独立页并进来的视图；d.109 起改为受控视图——数据、名册、
              选中成员都由本页提供，不再自己取数/轮询，两套成员筛选天然互通。 */}
          {tab === "board" && (
            <TeamBoardView
              members={members}
              onlineCount={onlineCount}
              activities={humanActivities}
              selectedId={selectedId}
              onSelectMember={setSelectedId}
              ready={feedReady}
              error={feedError}
              onRetry={() => void loadFeed(true)}
            />
          )}

          {tab === "feed" && (
            <>
              <div className="flex items-center gap-2 border-b border-line-soft px-6 py-2">
                {FILTERS.map((f) => (
                  <button
                    key={f.key}
                    type="button"
                    aria-pressed={filter === f.key}
                    onClick={() => setFilter(f.key)}
                    className={`ui-btn ui-btn-sm ${filter === f.key ? "ui-btn-primary" : "ui-btn-ghost text-muted"}`}
                  >
                    {f.label}
                  </button>
                ))}
            <button
              type="button"
              className="ui-btn ui-btn-sm ui-btn-ghost ml-auto text-muted"
              onClick={() => void loadFeed(true)}
            >
              刷新
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            {linkNotice && (
              <p role="status" className="mb-2 rounded-lg border border-line-soft bg-[var(--subtle)] px-2.5 py-1.5 text-[11px] leading-5 text-muted">
                {linkNotice}
              </p>
            )}
            {!feedReady ? (
              <div role="status" aria-busy="true" aria-label="正在加载团队动向" className="space-y-2">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="ui-skeleton h-12 rounded-xl" />
                ))}
              </div>
            ) : feedError ? (
              <div className="py-6 text-center text-[12px]">
                <p role="alert" className="text-[#b42318]">动向加载失败：{feedError}</p>
                <button
                  type="button"
                  className="ui-btn ui-btn-sm ui-btn-ghost mt-2"
                  onClick={() => void loadFeed(true)}
                >
                  重试
                </button>
              </div>
            ) : visibleActivities.length === 0 ? (
              <div className="ui-empty">
                <p>还没有可见的动向。</p>
                <p className="mt-1 ui-caption">
                  {shareCount > 0
                    ? "你已经开启共享，但还没有可显示的摘要；产生任务或日程后会自动同步过来。"
                    : "成员开启「任务 / 日程摘要」共享后，摘要会出现在这里。"}
                </p>
              </div>
            ) : (
              <ul className="space-y-1">
                {visibleActivities.map((a) => (
                  <li
                    key={a.id}
                    data-activity-id={a.id}
                    className={`ui-list-row items-start transition-colors ${
                      highlightActivityId === a.id ? "bg-[var(--subtle-3)] ring-1 ring-[var(--line-strong)]" : ""
                    }`}
                  >
                    {/* 行可点 = 选中该成员（与首页/看板一致）；button 保证键盘可达。 */}
                    <button
                      type="button"
                      onClick={() => setSelectedId(a.actorId)}
                      className="flex w-full items-start gap-3 text-left"
                    >
                      <Avatar user={avatarOf(a.actorId)} size={26} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline gap-1.5">
                          <span className="shrink-0 ui-body-sm font-medium">
                            {nameOf(a.actorId)}
                          </span>
                          <span className="ui-chip">
                            {KIND_LABEL[a.kind]}
                          </span>
                          <span className="truncate ui-body-sm">{a.title}</span>
                          <time
                            dateTime={a.occurredAt}
                            className="ml-auto shrink-0 ui-caption"
                          >
                            {fmtTime(a.occurredAt)}
                          </time>
                        </span>
                        {activitySummaryLabel(a) && (
                          <span className="mt-0.5 block truncate ui-caption">
                            {activitySummaryLabel(a)}
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {hasMore && visibleActivities.length > 0 && (
              <div className="mt-2 flex justify-center">
                <button
                  type="button"
                  disabled={loadingMore}
                  onClick={() => {
                    setLoadingMore(true);
                    void loadFeed(false).finally(() => setLoadingMore(false));
                  }}
                  className="ui-btn ui-btn-sm ui-btn-ghost text-muted"
                >
                  {loadingMore ? "加载中…" : "加载更早"}
                </button>
              </div>
            )}
          </div>
            </>
          )}

          {tab === "agenda" && (
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
              <p className="rounded-lg border border-line-soft bg-[var(--subtle)] px-2.5 py-2 text-[11px] leading-5 text-muted">
                团队日程只显示成员共享的日程标题与到期档位；不含日程正文与来源信息。
              </p>
              {!feedReady ? (
                <p role="status" className="mt-3 ui-caption">加载中…</p>
              ) : feedError ? (
                <div className="py-10 text-center text-[12px]">
                  <p role="alert" className="text-[#b42318]">日程加载失败：{feedError}</p>
                  <button
                    type="button"
                    className="ui-btn ui-btn-sm ui-btn-ghost mt-2"
                    onClick={() => void loadFeed(true)}
                  >
                    重试
                  </button>
                </div>
              ) : agendaActivities.length === 0 ? (
                <div className="py-10 text-center text-[12px] leading-6 text-muted">
                  {!infohubRunning ? (
                    <>
                      <p className="font-medium text-ink">还没有共享的日程</p>
                      <p className="mt-1">
                        连接「信息中枢」后，团队成员共享的日程摘要会出现在这里（只含标题与到期时间）。
                      </p>
                      <button
                        type="button"
                        className="ui-btn ui-btn-sm ui-btn-primary mt-3"
                        onClick={() => setPage("infohub")}
                      >
                        去连接信息中枢
                      </button>
                      <p className="mt-2 ui-caption">信息中枢只在本机运行，不会自动拉起。</p>
                    </>
                  ) : !share.agenda ? (
                    <>
                      <p className="font-medium text-ink">你还没有开启「日程摘要」共享</p>
                      <p className="mt-1">
                        开启后，你的日程摘要（标题 + 到期时间）会出现在团队日程里。
                      </p>
                    </>
                  ) : (
                    <p>暂无日程摘要。信息中枢同步出临期日程后会自动出现。</p>
                  )}
                </div>
              ) : (
                <ul className="mt-2 space-y-1">
                  {agendaActivities.map((a) => (
                    <li
                      key={a.id}
                      className="ui-list-row items-start"
                    >
                      <Avatar user={avatarOf(a.actorId)} size={26} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-1.5">
                          <span className="shrink-0 ui-body-sm font-medium">
                            {nameOf(a.actorId)}
                          </span>
                          <span className="truncate ui-body-sm">{a.title}</span>
                          <time
                            dateTime={a.occurredAt}
                            className="ml-auto shrink-0 ui-caption"
                          >
                            {fmtTime(a.occurredAt)}
                          </time>
                        </div>
                        {activitySummaryLabel(a) && (
                          <p className="mt-0.5 truncate ui-caption">{activitySummaryLabel(a)}</p>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {tab === "usage" && (
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="ui-caption leading-5">
                  只统计日期、模型名、连接名与 token 数；不含提示词、对话内容与工具参数。
                </span>
                <div className="ml-auto flex items-center gap-1" role="group" aria-label="用量区间">
                  {(["7d", "30d"] as TeamUsageRange[]).map((r) => (
                    <button
                      key={r}
                      type="button"
                      aria-pressed={usageRange === r}
                      onClick={() => setUsageRange(r)}
                      className={`ui-btn ui-btn-sm ${usageRange === r ? "ui-btn-primary" : "ui-btn-ghost text-muted"}`}
                    >
                      {r === "7d" ? "近 7 天" : "近 30 天"}
                    </button>
                  ))}
                  {share.usage && (
                    <button
                      type="button"
                      disabled={usageSyncing}
                      onClick={() => void syncUsage()}
                      className="ui-btn ui-btn-sm ui-btn-ghost text-muted"
                    >
                      {usageSyncing ? "同步中…" : "刷新"}
                    </button>
                  )}
                  {share.usage && hasUploadedUsage && (
                    <button
                      type="button"
                      onClick={() => setConfirmClearUsage(true)}
                      className="rounded-sm border border-[#fecdca] px-2 py-1 text-[11px] text-[#b42318] hover:bg-[#fef3f2]"
                    >
                      清除我的用量
                    </button>
                  )}
                </div>
              </div>

              {!share.usage ? (
                <section className="mt-3" aria-label="本机用量">
                  <h2 className="ui-section-title">本机用量（仅自己可见）</h2>
                  <p className="mt-1 text-[11px] leading-5 text-muted">
                    「用量」共享未开启：不上传、不采集，全站排行也不会显示。开启后会同步近 30 天的
                    聚合摘要（自然日 / 模型 / 连接名 / token 数 / 未上报轮数）。
                  </p>
                  <div className="mt-2 flex flex-wrap items-baseline gap-4 text-[12px]">
                    <span>
                      近 {rangeDays} 天合计{" "}
                      <b className="tabular-nums">{fmtTokens(localUsage.total)}</b>
                    </span>
                    <span className="ui-caption">未上报 {localUsage.unreported} 轮</span>
                  </div>
                  <ul className="mt-2 space-y-1 text-[11px] leading-5">
                    {localUsage.byModel.map((m) => (
                      <li key={m.model} className="flex items-baseline gap-2">
                        <span className="truncate font-medium">{m.model}</span>
                        <span className="ml-auto shrink-0 tabular-nums">{fmtTokens(m.tokens)}</span>
                        {m.connections.length > 0 && (
                          <span className="shrink-0 text-muted">{m.connections.join("、")}</span>
                        )}
                      </li>
                    ))}
                    {localUsage.byModel.length === 0 && (
                      <li className="text-muted">近 {rangeDays} 天还没有用量记录。</li>
                    )}
                  </ul>
                  <p className="mt-2 ui-micro">
                    已停止上传；如需删除已上传记录，点
                    <button
                      type="button"
                      onClick={() => setConfirmClearUsage(true)}
                      className="mx-0.5 underline underline-offset-2 hover:text-[#b42318]"
                    >
                      清除我的用量
                    </button>
                    （不会自动删除，避免误伤）。
                  </p>
                </section>
              ) : !usageReady ? (
                <p role="status" className="mt-3 ui-caption">加载中…</p>
              ) : usageError ? (
                <div className="py-6 text-center text-[12px]">
                  <p role="alert" className="text-[#b42318]">用量加载失败：{usageError}</p>
                  <button
                    type="button"
                    className="ui-btn ui-btn-sm ui-btn-ghost mt-2"
                    onClick={() => void syncUsage()}
                  >
                    重试
                  </button>
                </div>
              ) : usage ? (
                <>
                  <section className="mt-3" aria-label="我的用量">
                    <h2 className="ui-section-title">我的用量（近 {rangeDays} 天）</h2>
                    <div className="mt-1 flex flex-wrap items-baseline gap-4 text-[12px]">
                      <span>
                        合计 <b className="tabular-nums">{fmtTokens(usage.self.total)}</b>
                      </span>
                      <span className="ui-caption">
                        未上报 {usage.self.unreported} 轮
                      </span>
                    </div>
                    <ul className="mt-2 space-y-1 text-[11px] leading-5">
                      {usage.self.byModel.map((m) => (
                        <li key={m.model} className="flex items-baseline gap-2">
                          <span className="truncate font-medium">{m.model}</span>
                          <span className="ml-auto shrink-0 tabular-nums">
                            {fmtTokens(m.tokens)}
                          </span>
                          {m.unreported > 0 && (
                            <span className="shrink-0 text-muted">未上报 {m.unreported} 轮</span>
                          )}
                          {m.connections.length > 0 && (
                            <span className="shrink-0 text-muted">{m.connections.join("、")}</span>
                          )}
                        </li>
                      ))}
                      {usage.self.byModel.length === 0 && (
                        <li className="text-muted">这个区间还没有已同步的用量。</li>
                      )}
                    </ul>
                  </section>

                  <section className="mt-4" aria-label="团队用量排行">
                    <h2 className="ui-section-title">团队排行（近 {rangeDays} 天）</h2>
                    {usage.ranking.length === 0 ? (
                      <p className="mt-1 ui-caption">还没有成员共享用量。</p>
                    ) : (
                      <ol className="mt-1 space-y-1 text-[11px] leading-5">
                        {rankingRows.map((row, i) => (
                          <li key={row.userId} className="flex items-baseline gap-2">
                            <span className="w-5 shrink-0 tabular-nums text-muted">{i + 1}.</span>
                            <span
                              className={`min-w-0 truncate ${
                                row.userId === me?.id ? "font-bold" : "font-medium"
                              }`}
                            >
                              {/* 排行行可点 = 选中该成员并切到动向（与名册同一行为）。 */}
                              <button
                                type="button"
                                onClick={() => {
                                  setSelectedId(row.userId);
                                  setTab("feed");
                                }}
                                className="max-w-full truncate text-left hover:underline"
                              >
                                {row.displayName}
                                {row.userId === me?.id ? "（我）" : ""}
                              </button>
                            </span>
                            <span className="ml-auto shrink-0 tabular-nums">
                              {fmtTokens(row.tokens)}
                            </span>
                            <span className="shrink-0 text-muted">
                              {row.unreported > 0 ? `未上报 ${row.unreported} 轮 · ` : ""}
                              {row.days} 天
                            </span>
                          </li>
                        ))}
                      </ol>
                    )}
                    <p className="mt-2 ui-micro">
                      排行只显示聚合数与显示名；模型名与连接名只在你自己的明细里。
                    </p>
                  </section>
                </>
              ) : null}
            </div>
          )}
        </main>
      </div>

      {confirmClear && (
        <ConfirmDialog
          title="清除我的共享记录"
          onCancel={() => setConfirmClear(false)}
          footer={
            <>
              <button
                type="button"
                className="ui-btn ui-btn-md ui-btn-ghost"
                onClick={() => setConfirmClear(false)}
              >
                取消
              </button>
              <button
                type="button"
                disabled={clearing}
                className="ui-btn ui-btn-md ui-btn-danger"
                onClick={() => void onClearMine()}
              >
                {clearing ? "清除中…" : "清除"}
              </button>
            </>
          }
        >
          <p className="text-[12px] leading-6">
            会删除你已上传到团队动向的全部摘要；共享开关保持不变，之后的新动向仍会继续同步。
            <br />
            用量记录不在这里清除——请到「用量」页点「清除我的用量」。
          </p>
        </ConfirmDialog>
      )}

      {confirmClearUsage && (
        <ConfirmDialog
          title="清除我的用量"
          onCancel={() => setConfirmClearUsage(false)}
          footer={
            <>
              <button
                type="button"
                className="ui-btn ui-btn-md ui-btn-ghost"
                onClick={() => setConfirmClearUsage(false)}
              >
                取消
              </button>
              <button
                type="button"
                disabled={clearingUsage}
                className="ui-btn ui-btn-md ui-btn-danger"
                onClick={() => void onClearUsage()}
              >
                {clearingUsage ? "清除中…" : "清除"}
              </button>
            </>
          }
        >
          <p className="text-[12px] leading-6">
            会删除你已上传到团队的用量记录（自然日 / 模型 / 连接名 / token 数），删除后你不再出现在
            用量排行里；共享开关保持不变，之后新产生的用量仍会继续同步。
            <br />
            清除不会删除本机的 token 用量记录（本机「我的用量」仍显示历史，只是不再上传）。
          </p>
        </ConfirmDialog>
      )}
    </PageShell>
  );
}
