import { Fragment, useEffect, useMemo, useState } from "react";
import type { TeamActivity, TeamMember } from "@heming/shared";
import { useAuthStore } from "../store/auth.js";
import { useChatStore } from "../store/chat.js";
import { useUiStore } from "../store/ui.js";
import { useLlmStore } from "../store/llm.js";
import { useTaskStore } from "../lib/tasks/store.js";
import {
  useTokenUsageStore,
  monthKeyOf,
  summarizeMonth,
  dailyTotals,
  dayKeyOf,
} from "../store/tokenUsage.js";
import {
  deriveOnboardingSteps,
  shouldShowOnboarding,
  useOnboardingStore,
  type OnboardingTarget,
} from "../lib/onboarding.js";
import { fetchTeam, fetchTeamActivities, resolveUrl } from "../lib/api.js";
import { Avatar } from "./Avatar.js";
import { PageShell } from "./layout/PageShell.js";
import { EmptyState } from "./ui/EmptyState.js";
import { SkeletonLine } from "./ui/Skeleton.js";
import { InfohubHomeCard } from "./InfohubHomeCard.js";
import { StaffHomeCard } from "./StaffHomeCard.js";
import { TokenHeatmap } from "./TokenHeatmap.js";
import { OnboardingCard } from "./ux/OnboardingCard.js";
import { HomeTeamUsage } from "./HomeTeamUsage.js";
import { NeedsAttention } from "./home/NeedsAttention.js";
import { RecentConversations } from "./home/RecentConversations.js";
import { unreadCount, useNotificationStore } from "../store/notifications.js";
import { useHitlStore } from "../store/hitl.js";
import { TeamIcon } from "./icons.js";
import { fileRootsStore } from "../lib/fileEdit/roots.js";
import { FOCUS_RING } from "../lib/a11y/focus.js";
import { isModuleEffective, useModuleStore } from "../lib/modules/store.js";


/**
 * 统计卡：数字 + 一句说明。传了 `onOpen` 就是**可下钻的动作指标**
 * （不传则是纯看板数字——首页改造后只保留可点的那种）。
 */
function StatCard({
  title,
  value,
  sub,
  onOpen,
  actionLabel,
}: {
  title: string;
  value: string;
  sub?: string;
  onOpen?: () => void;
  actionLabel?: string;
}) {
  const body = (
    <>
      <div className="text-[11px] font-bold text-muted">{title}</div>
      <div className="mt-0.5 text-[20px] font-extrabold">{value}</div>
      {sub && <div className="mt-0.5 text-[10px] text-muted">{sub}</div>}
    </>
  );
  if (!onOpen) return <div className="ui-card p-3">{body}</div>;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={actionLabel ?? `${title}：${value}`}
      className={`ui-card p-3 text-left transition-colors hover:bg-[var(--subtle)] ${FOCUS_RING}`}
    >
      {body}
    </button>
  );
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return sameDay
    ? hm
    : `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${hm}`;
}

export function HomePage() {
  const user = useAuthStore((s) => s.user);
  const { loadWorkspace, agentsRoster, loadAgentsRoster } = useChatStore();
  const setPage = useUiStore((s) => s.setPage);
  const openSettings = useUiStore((s) => s.openSettings);
  const { quota, records } = useTokenUsageStore();
  /** UX-A 首跑引导：三步状态全部从真实 store 派生（连接/会话/任务），关闭状态只存本机。 */
  const llmProfiles = useLlmStore((s) => s.profiles);
  const conversations = useChatStore((s) => s.conversations);
  const taskRecords = useTaskStore((s) => s.tasks);
  const notifications = useNotificationStore((s) => s.items);
  const hitlPending = useHitlStore((s) => s.pending);
  const onboardingDismissedAt = useOnboardingStore((s) => s.dismissedAt);
  const dismissOnboarding = useOnboardingStore((s) => s.dismiss);
  const [tab, setTab] = useState<"me" | "team" | "date">("me");
  const [openDay, setOpenDay] = useState<string | null>(null);
  const [cloud, setCloud] = useState<"检测中" | "正常" | "失败">("检测中");
  /** 已绑定的可写根数量：首页「系统状态」不再写死「未绑定」（用户其实可能在设置区配过）。 */
  const [writeRootCount, setWriteRootCount] = useState(() => fileRootsStore.writeRoots().length);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [onlineCount, setOnlineCount] = useState(0);
  const [activities, setActivities] = useState<TeamActivity[]>([]);
  const [teamReady, setTeamReady] = useState(false);
  const [teamError, setTeamError] = useState("");
  /** 上次成功拉团队数据的时间：首页不轮询，至少让用户知道数据有多旧、并能手动刷新。 */
  const [lastTeamLoadAt, setLastTeamLoadAt] = useState<number | null>(null);

  // 真实数据优先：挂载时加载工作区数据、云端健康探测与智能体名册
  useEffect(() => {
    void loadWorkspace().catch((err) => console.warn("工作区数据加载失败", err));
    void loadAgentsRoster().catch(() => {});
  }, [loadWorkspace, loadAgentsRoster]);

  const loadTeam = () => {
    void Promise.all([fetchTeam(), fetchTeamActivities({ limit: 100 })])
      .then(([roster, feed]) => {
        setMembers(roster.members);
        setOnlineCount(roster.onlineCount);
        setActivities(feed.activities);
        setTeamError("");
        setTeamReady(true);
        setLastTeamLoadAt(Date.now());
      })
      .catch((err) => {
        setTeamError(err instanceof Error && err.message ? err.message : "网络异常");
        setTeamReady(true);
      });
  };

  useEffect(() => {
    loadTeam();
    // 首页停留期间不轮询：动向是「看一眼」的信息，切回首页/点重试时刷新即可。
    const onFocus = () => loadTeam();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let alive = true;
    fetch(resolveUrl("/api/health"))
      .then((r) => {
        if (alive) setCloud(r.ok ? "正常" : "失败");
      })
      .catch(() => {
        if (alive) setCloud("失败");
      });
    return () => {
      alive = false;
    };
  }, []);

  const moduleEnabled = useModuleStore((s) => s.enabled);
  const moduleState = {
    staff: isModuleEffective({ enabled: moduleEnabled }, "staff"),
    infoHub: isModuleEffective({ enabled: moduleEnabled }, "infohub"),
  };

  const monthKey = useMemo(() => monthKeyOf(new Date().toISOString()), []);
  const monthSummary = useMemo(() => summarizeMonth(records, monthKey), [records, monthKey]);

  const { today, todayKey } = useMemo(() => {
    const d = new Date();
    const week = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getDay()];
    return {
      today: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
        d.getDate(),
      ).padStart(2, "0")} ${week}`,
      todayKey: dayKeyOf(d.toISOString()),
    };
  }, []);

  /**
   * 按日明细只列到「今天」：本月还没到的日期不是「0 调用」，
   * 把它们铺成 0 会让账本看起来像出错（审计 P1-6）。
   */
  const dayRows = useMemo(
    () => dailyTotals(records, monthKey).filter((row) => row.day <= todayKey),
    [records, monthKey, todayKey],
  );
  const monthHasRecords = monthSummary.total > 0 || monthSummary.missing > 0;

  /* —— 首页第一屏的动作指标（d.84）：要处理 / 在跑 / 上次聊到哪 —— */
  const runningTasks = useMemo(
    () => taskRecords.filter((t) => t.status === "running"),
    [taskRecords],
  );
  /** 待处理 = 实时待确认（1 个）+ 未读的非审批通知；approval 通知不重复计数。 */
  const pendingCount =
    (hitlPending ? 1 : 0) +
    notifications.filter((n) => !n.read && n.kind !== "approval").length;
  const unreadNotifications = unreadCount(notifications);
  const todayDoneTasks = useMemo(() => {
    const d = new Date();
    return taskRecords.filter((t) => {
      if (t.status !== "done") return false;
      const at = new Date(t.endedAt ?? t.updatedAt);
      return (
        at.getFullYear() === d.getFullYear() &&
        at.getMonth() === d.getMonth() &&
        at.getDate() === d.getDate()
      );
    }).length;
  }, [taskRecords]);

  /** 点「待处理」时的落点：有实时审批去那个会话，否则去第一条未读通知的目标。 */
  const openPending = () => {
    if (hitlPending) {
      useUiStore.getState().openConversation(hitlPending.conversationId);
      return;
    }
    const first = notifications.find((n) => !n.read && n.kind !== "approval");
    if (!first) return;
    const ui = useUiStore.getState();
    if (first.kind === "task" && first.taskId) ui.focusTask(first.taskId, first.conversationId);
    else if (first.kind === "staff") ui.setPage("staff");
    else if (first.kind === "automation") ui.setPage("automations");
    else if (first.conversationId) ui.openConversation(first.conversationId);
  };

  const openRunningTasks = () => {
    const first = runningTasks[0];
    if (first) useUiStore.getState().focusTask(first.id, first.conversationId);
    else setPage("chat", "tasks");
  };

  const greeting = (() => {
    const h = new Date().getHours();
    if (h < 6) return "夜深了";
    if (h < 12) return "早上好";
    if (h < 18) return "下午好";
    return "晚上好";
  })();

  const pct = quota > 0 ? Math.min(100, Math.round((monthSummary.total / quota) * 100)) : 0;
  const modelRows = Object.entries(monthSummary.byModel).sort((a, b) => b[1] - a[1]);

  /** 团队动向只收真实成员的任务与日程；智能体侧旧数据不在首页露出。 */
  const humanActivities = useMemo(
    () => activities.filter((a) => a.kind === "task" || a.kind === "agenda"),
    [activities],
  );

  /** 今日动向条数（只统计最近 100 条；首页是概览，不为此转全量分组）。 */
  const todayActivities = useMemo(() => {
    const now = new Date();
    return humanActivities.filter((a) => {
      const d = new Date(a.occurredAt);
      return (
        d.getFullYear() === now.getFullYear() &&
        d.getMonth() === now.getMonth() &&
        d.getDate() === now.getDate()
      );
    }).length;
  }, [humanActivities]);
  const recentActivities = humanActivities.slice(0, 3);

  /** 首跑引导三步骤（真状态派生，不落盘）。 */
  const onboardingInputs = useMemo(
    () => ({
      connections: llmProfiles.length,
      conversations: conversations.length,
      tasks: taskRecords.length,
    }),
    [llmProfiles.length, conversations.length, taskRecords.length],
  );
  const onboardingSteps = useMemo(
    () => deriveOnboardingSteps(onboardingInputs),
    [onboardingInputs],
  );
  const showOnboarding = shouldShowOnboarding(
    onboardingInputs,
    onboardingDismissedAt,
    onboardingSteps,
  );
  /**
   * 首跑引导的去处：第 1 步是「配置模型连接」，必须直接落在设置区「模型」页签，
   * 不能只 setPage("settings")——那会停在「个人资料」，用户在昵称/头像里找模型。
   */
  const goOnboarding = (target: OnboardingTarget) => {
    if (target === "settings") openSettings("model");
    else setPage(target);
  };

  const KIND_LABEL: Record<TeamActivity["kind"], string> = {
    task: "任务",
    agent: "AI",
    staff: "幕僚",
    agenda: "日程",
    join: "加入",
  };

  return (
    <PageShell
      title={
        <>
          {greeting}，{user?.displayName ?? ""}
          <span className="ml-2 ui-caption font-normal">{today}</span>
        </>
      }
      subtitle="要处理什么、上次聊到哪、手上有什么在跑。"
      width="wide"
      bodyClassName="flex flex-col gap-4"
      actions={
        <>
          {/* 首页是「开始干活」的地方：先给动作，再给数字（审计：原来这里是版本号 + 今日用量） */}
          <button
            type="button"
            className="ui-btn ui-btn-sm ui-btn-ghost"
            onClick={() => setPage("chat")}
          >
            新对话
          </button>
          <button
            type="button"
            className="ui-btn ui-btn-sm ui-btn-primary"
            onClick={() => setPage("chat", "tasks")}
          >
            派任务
          </button>
        </>
      }
    >

      {/* 1.5 首跑引导（UX-A · U1）：只在「一个模型连接都没有」且用户没关过时出现 */}
      {showOnboarding && (
        <OnboardingCard steps={onboardingSteps} onGo={goOnboarding} onDismiss={dismissOnboarding} />
      )}

      {/* 1.8 需要你处理：审批 / 运行中的任务 / 未读通知，全都能点（d.84） */}
      <NeedsAttention />

      {/* 2. 四张动作指标卡（不是看板数字）：宽窗 4 列，窄窗折成 2 列 */}
      <div className="grid grid-cols-4 gap-2.5 max-[1199px]:grid-cols-2">
        <StatCard
          title="待处理"
          value={String(pendingCount)}
          sub={
            pendingCount === 0
              ? "没有需要你处理的事"
              : unreadNotifications > 0
                ? `含 ${unreadNotifications} 条未读通知`
                : "点开直接处理"
          }
          onOpen={pendingCount > 0 ? openPending : undefined}
          actionLabel="打开待处理事项"
        />
        <StatCard
          title="运行中任务"
          value={String(runningTasks.length)}
          sub={runningTasks.length === 0 ? "没有在跑的任务" : "点开查看进度"}
          onOpen={runningTasks.length > 0 ? openRunningTasks : undefined}
          actionLabel="查看运行中的任务"
        />
        <StatCard
          title="我的智能体"
          value={String(agentsRoster.length)}
          sub="本机运行"
          onOpen={() => setPage("chat")}
          actionLabel="打开智能体页"
        />
        <StatCard
          title="今日动向"
          value={teamError ? "—" : String(todayActivities)}
          sub={teamError ? "团队数据加载失败" : "成员共享的任务与日程"}
          onOpen={teamError ? undefined : () => setPage("team")}
          actionLabel="打开团队页"
        />
        <div className="col-span-4 ui-card p-3 max-[1199px]:col-span-2">
          {!monthHasRecords ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] font-bold text-muted">Token 用量 · {monthKey}</span>
              <span className="text-[11px] text-muted">
                本月还没有调用记录；接入模型并开始对话后自动统计。
              </span>
              <button
                type="button"
                className="ui-link ml-auto"
                onClick={() => openSettings("model")}
              >
                去配置模型
              </button>
            </div>
          ) : (
          <>
          <div className="flex items-center">
            <div className="text-[11px] font-bold text-muted">Token 用量 · {monthKey}</div>
            <div className="ml-auto inline-flex overflow-hidden rounded-lg border border-line bg-[var(--subtle)]">
              {(
                [
                  ["me", "个人"],
                  ["team", "团队"],
                  ["date", "按日期"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => {
                    setTab(key);
                    if (key !== "date") setOpenDay(null);
                  }}
                  className={`border-l border-line-soft px-2.5 py-1 text-[11px] font-semibold first:border-l-0 ${
                    tab === key ? "bg-ink text-white" : "text-muted"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {tab === "me" ? (
            <div className="mt-2 flex items-center gap-5">
              <div>
                <div className="text-[18px] font-extrabold">
                  {(monthSummary.total / 1000).toFixed(1)}
                  <small className="ml-1 text-[10px] text-muted">
                    / {(quota / 1_000_000).toFixed(1)}M
                  </small>
                </div>
                <div className="text-[10px] text-muted">本月已用 {pct}%</div>
                <div className="mt-1 h-1 w-[140px] overflow-hidden rounded-sm bg-[var(--subtle-4)]">
                  <div className="h-full bg-ink" style={{ width: `${pct}%` }} />
                </div>
                {/* 未上报单独提示（灰字，不抢主数字）：null 不是 0，不能被总量悄悄吞掉 */}
                {monthSummary.missing > 0 && (
                  <div className="mt-1 text-[10px] text-muted">{monthSummary.missing} 轮未上报</div>
                )}
              </div>
              <div className="flex-1 border-l border-line-soft pl-4">
                {modelRows.length === 0 ? (
                  <EmptyState
                    compact
                    className="px-0 py-2"
                    title="暂无调用记录"
                    desc="接入模型、开始对话后自动累计。"
                  />
                ) : (
                  modelRows.map(([model, n]) => (
                    <div key={model} className="flex justify-between py-0.5 text-[11px]">
                      <span>{model}</span>
                      <span>
                        <b>{n}</b>{" "}
                        <span className="text-muted">
                          · {Math.round((n / monthSummary.total) * 100)}%
                        </span>
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          ) : tab === "team" ? (
            <HomeTeamUsage />
          ) : !monthHasRecords ? (
            <div className="mt-2">
              <EmptyState
                compact
                className="px-0 py-2"
                title="本月还没有调用记录"
                desc="接入模型并开始对话后，这里按天列出用量（只列到今天）。"
              />
            </div>
          ) : (
            <div className="mt-2 max-h-[220px] overflow-y-auto">
              <table className="w-full text-left text-[11px]">
                <thead>
                  <tr className="border-b border-line-soft text-muted">
                    <th className="py-1 font-semibold">日期</th>
                    <th className="py-1 font-semibold">个人</th>
                    <th className="py-1 font-semibold">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {dayRows.map((row) => (
                    <Fragment key={row.day}>
                      <tr className="border-b border-line-soft">
                        <td className="py-1">{row.day}</td>
                        <td className="py-1">{row.total}</td>
                        <td className="py-1">
                          <button
                            type="button"
                            className="text-muted underline-offset-2 hover:underline"
                            onClick={() => setOpenDay(openDay === row.day ? null : row.day)}
                          >
                            {openDay === row.day ? "收起" : "查看"}
                          </button>
                        </td>
                      </tr>
                      {openDay === row.day ? (
                        <tr className="bg-[var(--subtle)]">
                          <td colSpan={3} className="py-1.5 pl-4">
                            {Object.keys(row.byModel).length === 0 ? (
                              <span className="text-muted">当天无调用记录</span>
                            ) : (
                              Object.entries(row.byModel).map(([model, n]) => (
                                <div key={model} className="flex justify-between py-0.5 pr-4">
                                  <span>{model}</span>
                                  <b>{n}</b>
                                </div>
                              ))
                            )}
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* 2.5 近 30 日用量热力图：并进「Token 用量」卡。
              单独一张卡时它只是一条细带（标题 + 30 个方块），在宽屏上占了一整行却几乎没有内容；
              并进来后「本月汇总 / 按日明细 / 近 30 日」在同一张卡里读，也少一个卡片框。 */}
          <div className="mt-3 border-t border-line-soft pt-2">
            <div className="mb-1.5 flex items-center">
              <div className="text-[11px] font-bold text-muted">近 30 日用量</div>
              <div className="ml-auto flex items-center gap-1 text-[10px] text-muted">
                少
                {["var(--heat-0)", "var(--heat-1)", "var(--heat-2)", "var(--heat-3)", "var(--heat-4)"].map((c) => (
                  <span key={c} style={{ backgroundColor: c }} className="h-2.5 w-2.5 rounded-[2px]" />
                ))}
                多
              </div>
            </div>
            <TokenHeatmap />
          </div>
          </>
          )}
        </div>
      </div>

      {/* 2.6 本机归档：日程摘要与归档规模（仅桌面端渲染）。
          d.70：信息中枢模块停用后整张卡下线，不在首页留假入口。 */}
      {moduleState.infoHub && <InfohubHomeCard />}

      {/* 2.7 幕僚：最近一份主动简报（d.48）；模块停用后同样下线 */}
      {moduleState.staff && <StaffHomeCard />}

      {/* 3/4/5/6. 两栏：左团队动向；右智能体动态 + 在线成员 + 系统状态。
          窄窗（<1200）折成单列：1.5fr/1fr 的比例在 1000px 出头的窗口里会把左栏压得读不完整。 */}
      <div className="grid grid-cols-[1.5fr_1fr] items-start gap-3 max-[1199px]:grid-cols-1">
        <section className="ui-card p-3">
          <div className="mb-1.5 flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-[12px] font-bold text-muted">
              <TeamIcon width={14} height={14} />
              团队动向
            </div>
            <div className="flex items-center gap-2">
              {lastTeamLoadAt ? (
                <span className="ui-micro">{fmtTime(new Date(lastTeamLoadAt).toISOString())} 更新</span>
              ) : null}
              <button
                type="button"
                className="ui-link"
                onClick={loadTeam}
              >
                刷新
              </button>
              <button
                type="button"
                className="ui-link"
                onClick={() => setPage("team")}
              >
                进入团队
              </button>
            </div>
          </div>
          {humanActivities.length === 0 ? (
            !teamReady ? (
              <div role="status" aria-label="正在加载" className="flex flex-col gap-2 py-1.5">
                {[0, 1, 2].map((i) => (
                  <SkeletonLine key={i} className="h-7 rounded-lg" />
                ))}
              </div>
            ) : teamError ? (
              <div className="flex items-center justify-between gap-2 py-1.5 text-[12px]">
                <span role="alert" className="min-w-0 truncate text-[var(--danger)]">加载失败：{teamError}</span>
                <button
                  type="button"
                  onClick={loadTeam}
                  className="ui-link border border-line"
                >
                  重试
                </button>
              </div>
            ) : (
              <EmptyState
                compact
                title="还没有团队动向"
                desc="成员在「团队」页开启共享后，这里显示任务和日程摘要；对话正文不上传。"
              />
            )
          ) : (
            recentActivities.map((a) => {
              const actor = members.find((m) => m.user.id === a.actorId);
              return (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => setPage("team")}
                  className="flex w-full items-start gap-2.5 rounded-lg px-1.5 py-2 text-left transition-colors duration-150 hover:bg-[var(--subtle-2)]"
                >
                  <Avatar
                    user={{
                      displayName: actor?.user.displayName ?? "成员",
                      avatar: actor?.user.avatar,
                    }}
                    size={28}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-1.5">
                      <span className="shrink-0 rounded-sm border border-line px-1 text-[10px] text-muted">
                        {KIND_LABEL[a.kind]}
                      </span>
                      <span className="truncate text-[13px] font-medium">{a.title}</span>
                    </span>
                    <span className="block truncate text-[11px] text-muted">
                      {actor?.user.displayName ?? "成员"}
                      {a.detail ? ` · ${a.detail}` : ""}
                    </span>
                  </span>
                  <span className="shrink-0 text-[10px] text-muted">{fmtTime(a.occurredAt)}</span>
                </button>
              );
            })
          )}
        </section>

        <div className="flex flex-col gap-3">
          {/* 4. 最近对话：日活用户打开主页的第一诉求是接着上次干（替代原来不可点的「智能体动态」） */}
          <RecentConversations />
        </div>
      </div>

      {/* 7. 底部：服务状态 + 更新日志入口（只留一行，异常时才变醒目） */}
      <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 ui-micro">
        <span>服务：{cloud}</span>
        <span>
          文件目录：{writeRootCount > 0 ? `已绑定 ${writeRootCount} 个` : "未绑定"}
        </span>
        <button type="button" className="ui-link" onClick={() => openSettings("about")}>
          更新日志
        </button>
      </footer>
    </PageShell>
  );
}
