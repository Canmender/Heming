import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { useAuthStore } from "../store/auth.js";
import { useUiStore } from "../store/ui.js";
import { dayKeyOf, useTokenUsageStore } from "../store/tokenUsage.js";
import { FOCUS_RING, FOCUS_RING_TIGHT } from "../lib/a11y/focus.js";
import { PageShell } from "./layout/PageShell.js";
import { PAGE_TABLIST, pageTabClass } from "../lib/ui/tabStyles.js";
import { Avatar } from "./Avatar.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { TeamBoardView } from "./TeamBoardPage.js";

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

/** token 数的紧凑写法：超过 1 万换成「万」，避免排行榜每行都是长数字。 */
export function fmtTokens(n: number): string {
  const v = Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  if (v < 10_000) return String(v);
  return `${(v / 10_000).toFixed(1)} 万`;
}

export function TeamPage() {
  const me = useAuthStore((s) => s.user);
  const focusUserId = useUiStore((s) => s.teamFocusUserId);
  const consumeTeamFocus = useUiStore((s) => s.consumeTeamFocus);
  /** 一次性视图意图（d.67）：旧「团队看板」链接会被折叠成 team + pageView="board"。 */
  const pageView = useUiStore((s) => s.pageView);
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
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  /**
   * 团队页四个视图互斥：动向（默认）/ 看板 / 团队日程（只读）/ 用量。
   * 挤在一屏会把「摘要流」和「排行」互相压扁，切 Tab 反而是最省事的读法。
   * 看板是 d.67 从独立页（旧 workspace）并进来的——它保留自己的取数与筛选，
   * 只把「页面外壳」换成这里的 Tab。
   */
  const [tab, setTab] = useState<"feed" | "board" | "agenda" | "usage">("feed");
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
          ...(!reset && cursor.length ? { before: cursor[cursor.length - 1].occurredAt } : {}),
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

  const visibleActivities = useMemo(
    () => humanActivities.filter((a) => filter === "all" || a.kind === filter),
    [humanActivities, filter],
  );

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

  return (
    <PageShell
      scroll={false}
      title="团队"
      subtitle={
        <>
          全站一个团队 · {members.length} 名真实成员 · {onlineCount} 人在线 · 今日 {todayCount} 条动向
        </>
      }
      actions={
        <span className="ui-chip">共享 {shareCount}/3</span>
      }
      headerExtra={
        <div className="bg-[#fbfbfb] px-6 py-2">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <span className="ui-caption">
              对团队可见：任务 / 日程摘要与用量排行，不含对话和工具参数
            </span>
            <div className="flex items-center gap-3" role="group" aria-label="共享内容">
              <label className="flex items-center gap-1 ui-caption text-[#555]">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-[#1a1a1a]"
                  checked={share.tasks}
                  onChange={(e) => updateShare({ tasks: e.target.checked })}
                />
                任务
              </label>
              <label className="flex items-center gap-1 ui-caption text-[#555]">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-[#1a1a1a]"
                  checked={share.agenda}
                  onChange={(e) => updateShare({ agenda: e.target.checked })}
                />
                日程
              </label>
              <label className="flex items-center gap-1 ui-caption text-[#555]">
                <input
                  type="checkbox"
                  aria-label="共享用量"
                  className="h-3.5 w-3.5 accent-[#1a1a1a]"
                  checked={share.usage}
                  onChange={(e) => updateShare({ usage: e.target.checked })}
                />
                用量
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
              className="ui-btn ui-btn-sm ui-btn-ghost ml-auto text-muted"
              onClick={() => setConfirmClear(true)}
            >
              清除共享记录
            </button>
          </div>
          {syncError && (
            <p role="alert" className="mt-1 ui-micro text-[#b42318]">
              共享同步失败：{syncError}
            </p>
          )}
        </div>
      }
    >
      <div className="flex min-h-0 flex-1">
        {/* 看板自带成员筛选条与两列卡片，再叠一栏名册会把两列挤窄；
            其余视图（动向/日程/用量）仍用名册 + 右栏的结构。 */}
        {tab !== "board" && (
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
          {tab !== "board" && selectedMember && (
            <div className="flex items-center gap-3 border-b border-line-soft bg-white px-6 py-2.5">
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
                  {selectedMember.online ? "在线" : fmtLastSeen(selectedMember.lastSeenAt)} ·
                  该成员最近的动向
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
          )}

          {/* 四个视图互斥：动向（默认）/ 看板 / 团队日程（只读）/ 用量（本机 + 开启共享后的排行） */}
          <div
            className={`${PAGE_TABLIST} items-center border-b border-line-soft px-6`}
            role="tablist"
            aria-label="团队视图"
          >
            {[
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

          {/* 看板：d.67 从独立页并进来的视图，自己取数、自己筛选，只借用这里的 Tab 位。
              条件渲染意味着切走即卸载（轮询停止），不会在别的视图里偷偷占用带宽。 */}
          {tab === "board" && <TeamBoardView />}

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
                  成员在团队页勾选「任务 / 日程」后，摘要会出现在这里；智能体的工作不进入团队动向。
                </p>
              </div>
            ) : (
              <ul className="space-y-1">
                {visibleActivities.map((a) => (
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
                      </div>
                      {a.detail && (
                        <p className="mt-0.5 truncate ui-caption">{a.detail}</p>
                      )}
                    </div>
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
              <p className="rounded-lg border border-line-soft bg-[#fafafa] px-2.5 py-2 text-[11px] leading-5 text-muted">
                团队日程只收成员自己开启共享的「日程」摘要（标题 + 到期时间），不含日程详情、证据或发送人；
                不新增任何云端内容上传。
              </p>
              {!feedReady ? (
                <p role="status" className="mt-3 ui-caption">加载中…</p>
              ) : agendaActivities.length === 0 ? (
                <div className="py-10 text-center text-[12px] leading-6 text-muted">
                  {!infohubRunning ? (
                    <>
                      <p className="font-medium text-[#555]">仅本机可见</p>
                      <p className="mt-1">
                        信息中枢未连接：团队日程不显示，本机日程也没有被采集。连接信息中枢并开启「日程」共享后，
                        摘要才会同步给团队。
                      </p>
                      <p className="mt-1 ui-caption">信息中枢只在本机运行，不会自动拉起。</p>
                    </>
                  ) : !share.agenda ? (
                    <>
                      <p>你还没有开启「日程」共享。</p>
                      <p className="mt-1 ui-caption">
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
                        {a.detail && (
                          <p className="mt-0.5 truncate ui-caption">{a.detail}</p>
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
                  只统计 token 数、模型名与连接名；提示词、对话内容、工具参数与结果都不出本机。
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
                    白名单摘要（自然日 / 模型 / 连接名 / token 数 / 未上报轮数）。
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
                              className={`truncate ${
                                row.userId === me?.id ? "font-bold" : "font-medium"
                              }`}
                            >
                              {row.displayName}
                              {row.userId === me?.id ? "（我）" : ""}
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
