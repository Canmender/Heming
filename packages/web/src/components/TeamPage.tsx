import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TeamActivity, TeamActivityKind, TeamMember } from "@heming/shared";
import {
  clearMyTeamActivities,
  fetchTeam,
  fetchTeamActivities,
  uploadTeamActivities,
} from "../lib/api.js";
import { collectCurrentTeamActivities, useTeamShareStore } from "../lib/team/share.js";
import { useAuthStore } from "../store/auth.js";
import { useUiStore } from "../store/ui.js";
import { Avatar } from "./Avatar.js";
import { ConfirmDialog } from "./ConfirmDialog.js";

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

export function TeamPage() {
  const me = useAuthStore((s) => s.user);
  const focusUserId = useUiStore((s) => s.teamFocusUserId);
  const consumeTeamFocus = useUiStore((s) => s.consumeTeamFocus);
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

  const shareCount = [share.tasks, share.agenda].filter(Boolean).length;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <header className="flex items-center gap-3 border-b border-line-soft px-5 py-3">
        <div>
          <h1 className="text-[15px] font-extrabold">团队</h1>
          <p className="mt-0.5 text-[11px] text-muted">
            全站一个团队 · {members.length} 名真实成员 · {onlineCount} 人在线 ·
            今日 {todayCount} 条动向
          </p>
        </div>
        <span className="ml-auto rounded-md border border-line bg-[#fafafa] px-2 py-0.5 text-[11px] text-muted">
          共享 {shareCount}/2
        </span>
      </header>

      <div className="border-b border-line-soft bg-[#fbfbfb] px-5 py-2 text-[11px]">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <span className="text-muted">
            开启后团队成员可见你的任务与日程摘要（不含对话内容与智能体轨迹）
          </span>
          <label className="flex items-center gap-1 text-[#555]">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-[#1a1a1a]"
              checked={share.tasks}
              onChange={(e) => updateShare({ tasks: e.target.checked })}
            />
            任务
          </label>
          <label className="flex items-center gap-1 text-[#555]">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-[#1a1a1a]"
              checked={share.agenda}
              onChange={(e) => updateShare({ agenda: e.target.checked })}
            />
            日程
          </label>
          <span className="text-[#999]">
            {share.lastSyncAt ? `上次同步 ${fmtTime(new Date(share.lastSyncAt).toISOString())}` : "尚未同步"}
          </span>
          <button
            type="button"
            className="ml-auto rounded border border-line bg-white px-2 py-0.5 text-[11px] text-muted hover:bg-[#f5f5f5]"
            onClick={() => setConfirmClear(true)}
          >
            清除我的共享记录
          </button>
        </div>
        {syncError && (
          <p className="mt-1 text-[10px] text-[#b42318]">共享同步失败：{syncError}</p>
        )}
      </div>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[300px] shrink-0 flex-col border-r border-line-soft">
          <div className="border-b border-line-soft p-2.5">
            <input
              value={memberQuery}
              onChange={(e) => setMemberQuery(e.target.value)}
              placeholder="搜索成员…"
              aria-label="搜索团队成员"
              className="w-full rounded-lg border border-line px-2.5 py-1.5 text-[12px] outline-none focus:border-[#bbb]"
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
              <div className="space-y-1.5 p-1.5">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="h-9 animate-pulse rounded-lg bg-[#f2f2f2]" />
                ))}
              </div>
            ) : rosterError ? (
              <div className="p-2 text-[12px]">
                <p className="text-[#b42318]">名册加载失败：{rosterError}</p>
                <button
                  type="button"
                  className="mt-1 rounded border border-line px-2 py-0.5 text-[11px]"
                  onClick={() => void loadRoster()}
                >
                  重试
                </button>
              </div>
            ) : filteredMembers.length === 0 ? (
              <p className="p-2 text-[12px] text-muted">
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
                    className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left ${
                      selected ? "bg-[#f2f2f2]" : "hover:bg-[#f7f7f7]"
                    }`}
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
                        <span className="truncate text-[12px] font-medium">
                          {m.user.displayName}
                        </span>
                        {m.user.id === me?.id && (
                          <span className="shrink-0 rounded border border-line px-1 text-[9px] text-muted">
                            我
                          </span>
                        )}
                      </span>
                      <span className="block truncate text-[10px] text-muted">
                        {m.online ? "在线" : fmtLastSeen(m.lastSeenAt)}
                      </span>
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          {selectedMember && (
            <div className="flex items-center gap-3 border-b border-line-soft bg-white px-5 py-2.5">
              <Avatar user={selectedMember.user} size={32} />
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13px] font-bold">
                    {selectedMember.user.displayName}
                  </span>
                  <span className="truncate text-[11px] text-muted">
                    @{selectedMember.user.username}
                  </span>
                </div>
                <div className="text-[10px] text-muted">
                  {selectedMember.online ? "在线" : fmtLastSeen(selectedMember.lastSeenAt)} ·
                  该成员最近的动向
                </div>
              </div>
              <button
                type="button"
                className="ml-auto rounded-lg border border-line px-2 py-0.5 text-[11px] text-muted hover:bg-[#f7f7f7]"
                onClick={() => setSelectedId(null)}
              >
                返回全部
              </button>
            </div>
          )}

          <div className="flex items-center gap-1 border-b border-line-soft px-5 py-2">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                aria-pressed={filter === f.key}
                onClick={() => setFilter(f.key)}
                className={`rounded-lg px-2 py-1 text-[11px] ${
                  filter === f.key ? "bg-ink text-white" : "text-muted hover:bg-[#f3f3f3]"
                }`}
              >
                {f.label}
              </button>
            ))}
            <button
              type="button"
              className="ml-auto rounded px-2 py-1 text-[11px] text-muted hover:bg-[#f3f3f3]"
              onClick={() => void loadFeed(true)}
            >
              刷新
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
            {!feedReady ? (
              <div className="space-y-2">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="h-12 animate-pulse rounded-xl bg-[#f4f4f4]" />
                ))}
              </div>
            ) : feedError ? (
              <div className="py-6 text-center text-[12px]">
                <p className="text-[#b42318]">动向加载失败：{feedError}</p>
                <button
                  type="button"
                  className="mt-2 rounded border border-line px-2 py-0.5 text-[11px]"
                  onClick={() => void loadFeed(true)}
                >
                  重试
                </button>
              </div>
            ) : visibleActivities.length === 0 ? (
              <div className="py-10 text-center text-[12px] text-muted">
                <p>还没有可见的动向。</p>
                <p className="mt-1 text-[11px]">
                  成员在团队页勾选「任务 / 日程」后，摘要会出现在这里；智能体的工作不进入团队动向。
                </p>
              </div>
            ) : (
              <ul className="space-y-1">
                {visibleActivities.map((a) => (
                  <li
                    key={a.id}
                    className="flex items-start gap-2.5 rounded-xl px-2 py-2 hover:bg-[#fafafa]"
                  >
                    <Avatar user={avatarOf(a.actorId)} size={26} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-1.5">
                        <span className="shrink-0 text-[12px] font-medium">
                          {nameOf(a.actorId)}
                        </span>
                        <span className="shrink-0 rounded border border-[#ececec] px-1 text-[9px] text-muted">
                          {KIND_LABEL[a.kind]}
                        </span>
                        <span className="truncate text-[12px]">{a.title}</span>
                        <time
                          dateTime={a.occurredAt}
                          className="ml-auto shrink-0 text-[10px] text-muted"
                        >
                          {fmtTime(a.occurredAt)}
                        </time>
                      </div>
                      {a.detail && (
                        <p className="mt-0.5 truncate text-[11px] text-muted">{a.detail}</p>
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
                  className="rounded-lg border border-line px-3 py-1.5 text-[11px] text-muted hover:bg-[#fafafa] disabled:opacity-40"
                >
                  {loadingMore ? "加载中…" : "加载更早"}
                </button>
              </div>
            )}
          </div>
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
                className="rounded-lg border border-line px-3 py-1.5 text-[12px] hover:bg-[#fafafa]"
                onClick={() => setConfirmClear(false)}
              >
                取消
              </button>
              <button
                type="button"
                disabled={clearing}
                className="rounded-lg bg-[#b42318] px-3 py-1.5 text-[12px] font-medium text-white hover:bg-[#912018] disabled:opacity-50"
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
    </div>
  );
}
