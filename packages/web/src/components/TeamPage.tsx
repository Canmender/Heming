import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useSessionTab } from "../lib/sessionState.js";
import { EmptyState } from "./ui/EmptyState.js";
import { AsyncBoundary } from "./ui/AsyncBoundary.js";
import { SkeletonLine } from "./ui/Skeleton.js";
import type { TeamActivity, TeamActivityKind, TeamMember, WorkspaceTeam } from "@heming/shared";
import {
  clearMyTeamActivities,
  fetchTeam,
  fetchTeamActivities,
  fetchWorkspaceTeams,
  uploadTeamActivities,
} from "../lib/api.js";
import { collectCurrentTeamActivities, useTeamShareStore } from "../lib/team/share.js";
import { useSelectedTeamId } from "../lib/team/selection.js";
import { activitySummaryLine, activityTitle } from "../lib/team/labels.js";
import { useAuthStore } from "../store/auth.js";
import { useUiStore } from "../store/ui.js";
import { FOCUS_RING } from "../lib/a11y/focus.js";
import { PageShell } from "./layout/PageShell.js";
import { PageTabs } from "./layout/PageTabs.js";
import { HomeIcon, SessionsIcon, TaskIcon } from "./icons.js";
import { Avatar } from "./Avatar.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { TeamTaskBoard } from "./team/TeamTaskBoard.js";
import { TeamWorkspace } from "./team/TeamWorkspace.js";
import { Button } from "../components/ui/Button.js";

/**
 * 团队页：只有三个一级页签——团队列表 / 看板 / 动向。
 *
 * 「团队列表」是建队、改名册、拆方案与派任务的入口；「看板」读同一份 team_tasks，
 * 按状态流转；「动向」是服务端摘要事件流（只收成员自己的任务与日程摘要），
 * 不是聊天消息。本机只上报白名单字段，采集逻辑见 `lib/team/share.ts`。
 *
 * 智能体不是团队成员：对话、工具轨迹与幕僚简报都留在「智能体」/「幕僚」页。
 * 本页不连接、不跳转任何外部插件。
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
/** 内部保留 workspace 这个 key：刷新记忆与命令面板意图仍指向「团队列表」。 */
const TEAM_TABS = ["workspace", "feed", "board"] as const;
type TeamTab = (typeof TEAM_TABS)[number];
/** 页签文案（顺序与 TEAM_TABS 一致，tab 与 tabpanel 的 id 都由 key 生成）。 */
const TEAM_TAB_LABELS: Record<TeamTab, string> = {
  workspace: "团队列表",
  feed: "动向",
  board: "看板",
};
/** 页签图标：与模型页、插件页同一套 14px 描边，三页一级页签视觉语言一致。 */
const TEAM_TAB_ICONS: Record<TeamTab, ReactNode> = {
  workspace: <HomeIcon width={14} height={14} />,
  feed: <SessionsIcon width={14} height={14} />,
  board: <TaskIcon width={14} height={14} />,
};

export function TeamPage() {
  const me = useAuthStore((s) => s.user);
  const focusUserId = useUiStore((s) => s.teamFocusUserId);
  const consumeTeamFocus = useUiStore((s) => s.consumeTeamFocus);
  const focusActivityId = useUiStore((s) => s.teamFocusActivityId);
  const consumeTeamActivityFocus = useUiStore((s) => s.consumeTeamActivityFocus);
  /** 一次性视图意图（d.67）：旧「团队看板」链接会被折叠成 team + pageView="board"。 */
  const pageView = useUiStore((s) => s.pageView);
  const share = useTeamShareStore((s) => s.settings);
  /**
   * 当前团队（d.153）：一个人可以同时在多个团队里，页头切换后整页只看这一个团队。
   * 会话级记忆与团队列表左栏共用一个 key，两处不会各选一个。
   */
  const [teams, setTeams] = useState<WorkspaceTeam[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useSelectedTeamId();

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
   * 三个视图互斥：团队列表 / 看板 / 动向（默认）。
   * 看板保留自己的取数与筛选，只把「页面外壳」换成这里的 Tab。
   */
  const [tab, setTab] = useSessionTab<TeamTab>(TEAM_TAB_KEY, "feed", TEAM_TABS);
  // 页签 id 前缀用 useId：团队页若被同屏挂载两份（如嵌入视图），静态 id 会撞车。
  const teamTabPrefix = useId();
  const teamTabPanelId = (key: TeamTab) => `${teamTabPrefix}-team-${key}-panel`;
  /**
   * 生效的当前团队：记忆里的 id 可能已退出/已解散，回落到列表第一个。
   * 为空表示「一个团队都没有」——此时请求走服务端旧口径（我所在全部团队的并集），
   * 页头也不显示切换器（无处可切）。
   */
  const activeTeamId = useMemo(() => {
    if (selectedTeamId && teams.some((t) => t.id === selectedTeamId)) return selectedTeamId;
    return teams[0]?.id ?? "";
  }, [selectedTeamId, teams]);
  // 翻页游标要读「当下最新的列表」，但列表进 loadFeed 依赖会让定时刷新反复重建：
  // 用 ref 兜住当前值，回调只认 selectedId 这一个请求口径。
  const activitiesRef = useRef<TeamActivity[]>([]);
  activitiesRef.current = activities;
  /**
   * 动向请求序号（W-03）：切成员 / 切页签 / 定时刷新同时触发的请求会乱序返回，
   * 旧响应若直接 setActivities，会把新成员的列表盖回上一个成员，甚至把「加载更早」
   * 的条目混进去。每次请求自增，await 回来后只认最新那一次。
   */
  const feedSeq = useRef(0);

  /** 拉「我加入/拥有的团队」列表：页头切换器与团队列表共用这份数据。 */
  const loadTeams = useCallback(async () => {
    try {
      const data = await fetchWorkspaceTeams();
      setTeams(data.teams);
    } catch {
      // 切换器是增强：列表拿不到时不挡名册与动向（服务端仍按「我所在全部团队」并集返回）。
    }
  }, []);

  useEffect(() => {
    void loadTeams();
  }, [loadTeams]);

  // 记忆里的 teamId 失效（退出/解散/第一次进入）时，把它改成回落后的那个，
  // 否则团队列表左栏会高亮一个不存在的项。
  useEffect(() => {
    if (activeTeamId && activeTeamId !== selectedTeamId) setSelectedTeamId(activeTeamId);
  }, [activeTeamId, selectedTeamId, setSelectedTeamId]);

  // 切团队：选中成员、分页游标、筛选都属于上一个团队的口径，必须清掉。
  useEffect(() => {
    setSelectedId(null);
    setActivities([]);
    setHasMore(true);
    setFilter("all");
  }, [activeTeamId]);

  const loadRoster = useCallback(async () => {
    try {
      const data = await fetchTeam(activeTeamId ? { teamId: activeTeamId } : {});
      setMembers(data.members);
      setOnlineCount(data.onlineCount);
      setRosterError("");
      setRosterReady(true);
    } catch (err) {
      setRosterError(err instanceof Error && err.message ? err.message : "网络异常");
      setRosterReady(true);
    }
    // 当前团队变了就重拉：名册是「这个团队有谁」，不是「我所有团队有谁」的并集。
  }, [activeTeamId]);

  const loadFeed = useCallback(
    async (reset: boolean) => {
      const seq = ++feedSeq.current;
      const cursor = activitiesRef.current;
      try {
        const data = await fetchTeamActivities({
          limit: PAGE_SIZE,
          ...(activeTeamId ? { teamId: activeTeamId } : {}),
          // 游标必须带 id：只按 occurredAt 严格小于翻页，会漏掉与游标同一时刻的剩余条目
          // （d.109 A2）。beforeId 是可选的新参数，旧服务端会忽略它、行为退回旧口径。
          ...(!reset && cursor.length
            ? { before: cursor[cursor.length - 1].occurredAt, beforeId: cursor[cursor.length - 1].id }
            : {}),
          ...(selectedId ? { actorId: selectedId } : {}),
        });
        // 晚到的旧响应直接丢掉：它属于上一个筛选口径。
        if (seq !== feedSeq.current) return;
        setActivities((prev) => {
          if (reset) return data.activities;
          const known = new Set(prev.map((a) => a.id));
          return [...prev, ...data.activities.filter((a) => !known.has(a.id))];
        });
        setHasMore(data.activities.length >= PAGE_SIZE);
        setFeedError("");
        setFeedReady(true);
      } catch (err) {
        if (seq !== feedSeq.current) return;
        setFeedError(err instanceof Error && err.message ? err.message : "网络异常");
        setFeedReady(true);
      }
    },
    // 选中成员 + 当前团队决定请求口径；翻页游标走 activitiesRef，避免每次加载重建回调
    [selectedId, activeTeamId],
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

  // 视图意图消费：看板跳转落在本页时切到「看板」。
  // 读走即清，避免用户切走再回来还被上次跳转钉在看板（意图只对「这一次进入」有效）。
  useEffect(() => {
    if (!pageView) return;
    const view = useUiStore.getState().consumePageView();
    if (view === "board") setTab("board");
  }, [pageView]);

  // 命令面板的二级视图入口（d.142）：`{ kind: "focus-tab", data: { page: "team", tab } }`。
  // 与上面的 pageView 分开：pageView 表达「进入哪个视图」，这条表达「面板点名了哪个 Tab」，
  // 覆盖 workspace/feed 这两个没有 PageView 的页签（board 走上面的 pageView）。
  const paletteIntent = useUiStore((s) => s.paletteIntent);
  const consumePaletteIntent = useUiStore((s) => s.consumePaletteIntent);
  useEffect(() => {
    if (paletteIntent?.kind !== "focus-tab") return;
    const { page, tab } = paletteIntent.data ?? {};
    if (page !== "team" || !tab) return;
    if (!(TEAM_TABS as readonly string[]).includes(tab)) return;
    setTab(tab as TeamTab);
    consumePaletteIntent();
  }, [paletteIntent, consumePaletteIntent, setTab]);

  /** 采集并上报本机摘要（幂等：重复同步只在服务端跳过）。 */
  const sync = useCallback(async () => {
    // 共享没有开关了（d.153）：采集与上传就是默认行为，隐私边界靠字段白名单。
    const current = useTeamShareStore.getState().settings;
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
  }, [sync, loadRoster, loadFeed]);

  const selectedMember = useMemo(
    () => members.find((m) => m.user.id === selectedId) ?? null,
    [members, selectedId],
  );

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

  /** 成员详情：除了「他是谁」，也给「他最近干了多少、最近三条是什么」。 */
  const selectedMemberStats = useMemo(() => {
    if (!selectedMember) return null;
    const recent = humanActivities.filter((a) => a.actorId === selectedMember.user.id);
    return {
      recentCount: recent.length,
      recentThree: recent.slice(0, 3),
    };
  }, [selectedMember, humanActivities]);

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
      // 清除水位：只删服务端行不够——下一轮 sync 会把同一批任务/日程按同一 sourceId
      // 原样传回去（服务端 INSERT OR IGNORE），用户会看到刚清掉的摘要一分钟内复活。
      useTeamShareStore.getState().setActivitiesClearedAt(Date.now());
      setSyncError("");
      await loadFeed(true);
    } catch (err) {
      setSyncError(err instanceof Error && err.message ? err.message : "网络异常");
    } finally {
      setClearing(false);
      setConfirmClear(false);
    }
  };

  /** 团队列表把最新名单回传上来：宿主的切换器与左栏列表共用一份数据。 */
  const handleTeamsLoaded = useCallback((list: WorkspaceTeam[]) => {
    setTeams(list);
  }, []);

  return (
    <PageShell
      scroll={false}
      title="团队"
      subtitle="与你在同一团队的同事。这里是人类队伍；派子智能体干活在「会话」页里。"
      actions={
        // 一个人可以同时在多个团队里，切到哪个团队，
        // 团队列表 / 看板 / 动向都只看那一个。
        // 没有团队时不渲染选择器——无处可切，页面正文会给出建队引导。
        teams.length > 0 ? (
          <label className="flex items-center gap-2">
            <span className="ui-caption text-muted">团队</span>
            <select
              aria-label="切换团队"
              className="ui-input h-8 max-w-[220px] py-0"
              value={activeTeamId}
              onChange={(e) => setSelectedTeamId(e.target.value)}
            >
              {teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </select>
          </label>
        ) : null
      }
      // 一级页签走 PageShell.tabs + PageTabs：紧贴页头、通栏，与模型页/插件页同一位置。
      // 此前它挂在右栏 <main> 里，被 300px 名册挤到右边；现在常驻页头下方。
      tabs={
        <PageTabs
          label="团队视图"
          idPrefix={`${teamTabPrefix}-team`}
          items={TEAM_TABS.map((key) => ({
            key,
            label: TEAM_TAB_LABELS[key],
            icon: TEAM_TAB_ICONS[key],
          }))}
          active={tab}
          onChange={(key) => setTab(key as TeamTab)}
        />
      }
      headerExtra={
        tab === "feed" ? (
        <div className="bg-subtle px-6 py-2 max-[1199px]:px-4">
          {/* 第一行说清「共享了什么 / 上次同步 / 怎么撤回」，第二行说明撤回语义。 */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <span className="ui-caption font-medium text-ink">
              与同队成员共享任务 / 日程摘要
            </span>
            <span className="ui-caption">
              {share.lastSyncAt
                ? `上次同步 ${fmtTime(new Date(share.lastSyncAt).toISOString())}`
                : "正在首次同步…"}
            </span>
            <Button
              type="button"
              // 从未同步过时没有可清除的记录：不用一个点了没反应的按钮骗人
              disabled={!share.lastSyncAt}
              title={
                share.lastSyncAt
                  ? "删除你已上传到团队动向的全部摘要"
                  : "还没有可清除的共享记录"
              }
              size="sm" variant="ghost" className="ml-auto text-muted disabled:opacity-40"
              onClick={() => setConfirmClear(true)}
            >
              清除共享记录
            </Button>
          </div>
          {/* 一句说清「共享是默认的 / 撤回要手动 / 什么永远不出本机」。 */}
          <p className="mt-1 ui-body-sm text-muted">
            加入团队即共享这两类白名单摘要，没有逐类开关；已上传的内容不会随任何开关消失，需要手动清除。
            提示词与对话正文始终不出本机。
            {members.length <= 1
              ? " 你还没加入团队。到「团队列表」新建团队或让队长把你拉进来后，队友会出现在这里。"
              : null}
          </p>
          {syncError && (
            <p role="alert" className="mt-1 ui-body-sm text-danger">
              共享同步失败：{syncError}
            </p>
          )}
        </div>
        ) : null
      }    >
      <div className="flex min-h-0 flex-1">
        {/* 看板自带成员筛选条与两列卡片，再叠一栏名册会把两列挤窄；
            动向视图仍用名册 + 右栏的结构。 */}
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
              <div className="mt-2 flex items-center justify-between gap-2 ui-micro">
                <label className="flex items-center gap-1 text-muted">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-ink"
                    checked={onlineOnly}
                    onChange={(e) => setOnlineOnly(e.target.checked)}
                  />
                  仅看在线
                </label>
                <div className="flex items-center gap-2">
                  {selectedId && (
                    <button
                      type="button"
                      className={`-my-1 inline-flex h-8 items-center rounded-md px-1.5 text-muted hover:text-ink ${FOCUS_RING}`}
                      onClick={() => setSelectedId(null)}
                    >
                      查看全部动向
                    </button>
                  )}
                  {/* 名册是只读摘要，真正的加人/派活在团队列表。
                      这里给一步入口，避免用户对着名册找不到「怎么加人」。 */}
                  <button
                    type="button"
                    className={`ui-link ui-hit ${FOCUS_RING}`}
                    title="到团队列表管理成员、派任务"
                    onClick={() => setTab("workspace")}
                  >
                    管理成员
                  </button>
                </div>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
              <AsyncBoundary
                status={!rosterReady ? "loading" : rosterError ? "error" : "ready"}
                loadingLabel="正在加载团队成员"
                loadingClassName="space-y-1.5"
                loadingFallback={
                  <>
                    {[0, 1, 2, 3].map((i) => (
                      <SkeletonLine key={i} className="h-9 rounded-lg" />
                    ))}
                  </>
                }
                errorTitle={`名册加载失败：${rosterError}`}
                onRetry={() => void loadRoster()}
                errorCompact
              >
                {filteredMembers.length === 0 ? (
                  // 审计 F2：名册空态原来只有一句「还没有其他成员。」，既没有形状也没有下一步。
                  <EmptyState
                    compact
                    align="start"
                    className="mx-1.5"
                    title={members.length === 0 ? "还没有其他成员" : "没有符合条件的成员"}
                    desc={
                      members.length === 0
                        ? "你还没加入团队。到「团队列表」新建团队或让队长把你拉进来后，队友会出现在这里。"
                        : "换个关键词，或关掉「仅看在线」。"
                    }
                  />
                ) : (
                  filteredMembers.map((m) => {
                  const selected = m.user.id === selectedId;
                  return (
                    <button
                      key={m.user.id}
                      type="button"
                      onClick={() => setSelectedId(selected ? null : m.user.id)}
                      className={`ui-list-row w-full text-left ${selected ? "bg-subtle-2" : ""}`}
                    >
                      <span className="relative shrink-0">
                        <Avatar user={m.user} size={28} />
                        <span
                          aria-hidden="true"
                          className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-surface ${
                            m.online ? "bg-success" : "bg-line-strong"
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
              </AsyncBoundary>
            </div>
          </aside>
        )}

        <main className="flex min-w-0 flex-1 flex-col">
          {tab !== "board" && tab !== "workspace" && selectedMember && (
            <div className="border-b border-line-soft bg-surface px-6 py-2.5">
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
                      ? ` · 最近动向 ${selectedMemberStats.recentCount} 条`
                      : ""}
                  </div>
                </div>
                <Button
                  type="button"
                  size="sm" variant="ghost" className="ml-auto text-muted"
                  onClick={() => setSelectedId(null)}
                >
                  返回全部
                </Button>
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
                            className="flex w-full items-baseline gap-2 rounded-sm px-1 py-0.5 text-left hover:bg-subtle-2"
                          >
                            <span className="shrink-0 ui-chip">{KIND_LABEL[a.kind]}</span>
                            <span className="min-w-0 flex-1 truncate text-ui-sm">{activityTitle(a)}</span>
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

          {/* 三个视图互斥：团队列表 / 看板 / 动向（默认）。
              页签本身在页头下方（PageShell.tabs），这里只剩内容区。 */}
          <div
            role="tabpanel"
            id={teamTabPanelId(tab)}
            aria-labelledby={`${teamTabPrefix}-team-${tab}-tab`}
            className="flex min-h-0 flex-1 flex-col"
          >
          {/* 团队列表受控：页头切了团队，左栏列表与内容跟着走，两处不会各选一个。 */}
          {tab === "workspace" && (
            <TeamWorkspace
              teamId={activeTeamId}
              onTeamChange={setSelectedTeamId}
              onTeamsLoaded={handleTeamsLoaded}
            />
          )}

          {/* 看板：真正的任务板——读 team_tasks（与团队列表同源），
              按状态分列、可拖拽流转，复用收紧后的状态机（done_locked）。旧 TeamBoardView
              读 team_activities 摘要、只能看不能动，已不再使用。 */}
          {tab === "board" && (
            <TeamTaskBoard
              teamId={activeTeamId}
              members={members}
              currentUserId={me?.id ?? null}
              ownerId={teams.find((t) => t.id === activeTeamId)?.ownerId ?? null}
              onOpenTeamList={() => setTab("workspace")}
            />
          )}

          {tab === "feed" && (
            <>
              <div className="flex items-center gap-2 border-b border-line-soft px-6 py-2">
                {FILTERS.map((f) => (
                  <Button
                    key={f.key}
                    type="button"
                    aria-pressed={filter === f.key}
                    onClick={() => setFilter(f.key)}
                    size="sm" variant={filter === f.key ? "primary" : "ghost"} className={filter === f.key ? undefined : "text-muted"}
                  >
                    {f.label}
                  </Button>
                ))}
            <Button
              type="button"
              size="sm" variant="ghost" className="ml-auto text-muted"
              onClick={() => void loadFeed(true)}
            >
              刷新
            </Button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            {/* 动向列表要有一个真标题：页签只是导航，读屏与审计门禁认的是 h2。 */}
            <h2 className="mb-2 ui-section-title">
              {selectedMember ? `${selectedMember.user.displayName} 的动向` : "团队动向"}
            </h2>
            {linkNotice && (
              <p role="status" className="mb-2 rounded-lg border border-line-soft bg-subtle px-2.5 py-1.5 text-ui-xs leading-5 text-muted">
                {linkNotice}
              </p>
            )}
            <AsyncBoundary
              status={!feedReady ? "loading" : feedError ? "error" : "ready"}
              loadingLabel="正在加载团队动向"
              loadingClassName="space-y-2"
              loadingFallback={
                <>
                  {[0, 1, 2].map((i) => (
                    <SkeletonLine key={i} className="h-12 rounded-xl" />
                  ))}
                </>
              }
              errorTitle={`动向加载失败：${feedError}`}
              onRetry={() => void loadFeed(true)}
              errorCompact
            >
              {visibleActivities.length === 0 ? (
                <EmptyState
                  compact
                  title="还没有可见的动向。"
                  desc="成员产生任务或日程后，摘要会自动同步过来；你自己的摘要也在其中。"
                />
              ) : (
                <ul className="space-y-1">
                {visibleActivities.map((a) => (
                  <li
                    key={a.id}
                    data-activity-id={a.id}
                    className={`ui-list-row items-start transition-colors ${
                      highlightActivityId === a.id ? "bg-subtle-3 ring-1 ring-line-strong" : ""
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
                          <span className="truncate ui-body-sm">{activityTitle(a)}</span>
                          <time
                            dateTime={a.occurredAt}
                            className="ml-auto shrink-0 ui-caption"
                          >
                            {fmtTime(a.occurredAt)}
                          </time>
                        </span>
                        {activitySummaryLine(a) && (
                          <span className="mt-0.5 block truncate ui-caption">
                            {activitySummaryLine(a)}
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            </AsyncBoundary>
            {hasMore && visibleActivities.length > 0 && (
              <div className="mt-2 flex justify-center">
                <Button
                  type="button"
                  disabled={loadingMore}
                  onClick={() => {
                    setLoadingMore(true);
                    void loadFeed(false).finally(() => setLoadingMore(false));
                  }}
                  size="sm" variant="ghost" className="text-muted"
                >
                  {loadingMore ? "加载中…" : "加载更早"}
                </Button>
              </div>
            )}
          </div>
            </>
          )}

          </div>
        </main>
      </div>

      {confirmClear && (
        <ConfirmDialog
          title="清除共享记录？"
          onCancel={() => setConfirmClear(false)}
          footer={
            <>
              <Button
                type="button"
                size="md" variant="ghost"
                onClick={() => setConfirmClear(false)}
              >
                取消
              </Button>
              <Button
                type="button"
                disabled={clearing}
                size="md" variant="danger"
                onClick={() => void onClearMine()}
              >
                {clearing ? "清除中…" : "清除"}
              </Button>
            </>
          }
        >
          <p className="ui-body-sm">
            清除后，你已上传到团队动向的摘要会全部删除且不可恢复；之后的新动向仍会继续同步。
          </p>
        </ConfirmDialog>
      )}

    </PageShell>
  );
}
