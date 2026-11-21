import { useEffect, useMemo, useState } from "react";
import type { TeamActivity, TeamMember } from "@heming/shared";
import { useAuthStore } from "../store/auth.js";
import { useChatStore } from "../store/chat.js";
import { useUiStore } from "../store/ui.js";
import { useLlmStore } from "../store/llm.js";
import { useTaskStore } from "../lib/tasks/store.js";
import {
  deriveOnboardingSteps,
  shouldShowOnboarding,
  useOnboardingStore,
  type OnboardingTarget,
} from "../lib/onboarding.js";
import { fetchTeam, fetchTeamActivities, resolveUrl } from "../lib/api.js";
import { Button } from "./ui/Button.js";
import { PageShell } from "./layout/PageShell.js";
import { Stat } from "./ui/Stat.js";
import { PluginHomeCards } from "./plugins/PluginHomeCards.js";
import { OnboardingCard } from "./ux/OnboardingCard.js";
import { NeedsAttention } from "./home/NeedsAttention.js";
import { RecentConversations } from "./home/RecentConversations.js";
import { UsageCard } from "./home/UsageCard.js";
import { TeamActivityCard } from "./home/TeamActivityCard.js";
import { unreadCount, useNotificationStore } from "../store/notifications.js";
import { useHitlStore } from "../store/hitl.js";
import { fileRootsStore } from "../lib/fileEdit/roots.js";

/**
 * 首页的服务探活：只回答「本机服务此刻是否可达」。
 * 失败文案不在这里定——页脚要把「连接失败 + 原因 + 重试」放在一起说清楚（F-14）。
 */
function probeHealth(): Promise<"正常" | "失败"> {
  return fetch(resolveUrl("/api/health"))
    .then((r): "正常" | "失败" => (r.ok ? "正常" : "失败"))
    .catch((): "失败" => "失败");
}

/**
 * 统计卡已抽到 ui/Stat.tsx（d.138）：首页与模型页此前各写一份、尺寸不同
 * （首页 20px / p-3，模型页 26px / p-4），同一套「数字卡」两个页面不一样大。
 *
 * d.141 页面结构（首屏收敛）：
 *   第一屏 = 现在要做什么：开始使用（仅首跑）/ 需要你处理 / 最近对话；
 *   第二屏 = 状态与动向：四张统计卡 / Token 用量 / 插件卡 / 团队动向。
 *   改动前四张统计卡 + 一整张 Token 卡在首屏最上方，1440×900 下「最近对话」被挤到折线以下，
 *   用户在主页最先看到的是数字，而不是「接着干什么」。
 */
export function HomePage() {
  const user = useAuthStore((s) => s.user);
  const { loadWorkspace } = useChatStore();
  /** 首帧是否已拉到工作区 / 首载失败原因（store 只在首帧写，后台刷新失败不推翻已就绪）。 */
  const workspaceReady = useChatStore((s) => s.workspaceReady);
  const workspaceError = useChatStore((s) => s.workspaceError);
  const setPage = useUiStore((s) => s.setPage);
  const openSettings = useUiStore((s) => s.openSettings);
  /** UX-A 首跑引导：三步状态全部从真实 store 派生（连接/会话/任务），关闭状态只存本机。 */
  const llmProfiles = useLlmStore((s) => s.profiles);
  const conversations = useChatStore((s) => s.conversations);
  const taskRecords = useTaskStore((s) => s.tasks);
  const notifications = useNotificationStore((s) => s.items);
  const hitlPending = useHitlStore((s) => s.pending);
  const onboardingDismissedAt = useOnboardingStore((s) => s.dismissedAt);
  const dismissOnboarding = useOnboardingStore((s) => s.dismiss);
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

  // 真实数据优先：挂载时加载工作区数据与云端健康探测（单智能体固定，不再取名册）。
  // 首载失败不由本页吞掉：store 记 workspaceError（仅首帧写），首屏据此提示 + 给「重试」。
  useEffect(() => {
    void loadWorkspace().catch(() => {
      /* 错误已由 store 记录（workspaceError），首屏的失败条据此渲染 */
    });
  }, [loadWorkspace]);

  /**
   * 首载失败的重试：只重拉工作区，失败原因仍由 store 写回 workspaceError。
   * 不在这里再存一份错误，避免「store 说失败、本页说成功」两套口径。
   */
  const retryWorkspace = () => {
    void loadWorkspace().catch(() => {
      /* 错误已由 store 记录（workspaceError） */
    });
  };

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

  // 服务可用性只在挂载时探一次；失败不再是一次性的死状态——页脚给原因与「重试」（F-14）。
  useEffect(() => {
    let alive = true;
    void probeHealth().then((status) => {
      if (alive) setCloud(status);
    });
    return () => {
      alive = false;
    };
  }, []);

  /**
   * 页脚「重试」：重探服务 + 重读可写根（文件目录绑定可能在设置区刚改过）。
   * 探活走同一条 probeHealth，文案由页脚统一渲染，避免两处各说各话。
   */
  const retryService = () => {
    setCloud("检测中");
    setWriteRootCount(fileRootsStore.writeRoots().length);
    void probeHealth().then(setCloud);
  };

  const { today } = useMemo(() => {
    const d = new Date();
    const week = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getDay()];
    return {
      today: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
        d.getDate(),
      ).padStart(2, "0")} ${week}`,
    };
  }, []);

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
    else if (first.kind === "staff") ui.openStaff();
    else if (first.kind === "automation") ui.openAutomations();
    else if (first.conversationId) ui.openConversation(first.conversationId);
  };

  const openRunningTasks = () => {
    const first = runningTasks[0];
    if (first) useUiStore.getState().focusTask(first.id, first.conversationId);
    // d.138：没有在跑的任务时，「查看任务」指向团队页看板——任务列表在那里，
    // 而不是对话页一个早就不存在的 tasks 视图。
    else setPage("team", "board");
  };

  const greeting = (() => {
    const h = new Date().getHours();
    if (h < 6) return "夜深了";
    if (h < 12) return "早上好";
    if (h < 18) return "下午好";
    return "晚上好";
  })();

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
  /**
   * 「开始使用」卡的出现条件（d.141 复核，口径未改）：
   * 用户没关过 + 三步没全完成（onboardingAllDone）+ 一个模型连接都没有（shouldShowOnboarding 内部）。
   * 也就是说它只在「相关且未完成」时出现——首跑完成或用户点了「不再显示」就自然消失，
   * 不会变成常驻的装饰。
   */
  const showOnboarding = shouldShowOnboarding(
    onboardingInputs,
    onboardingDismissedAt,
    onboardingSteps,
  );
  /**
   * 首跑引导的去处：第 1 步是「添加模型来源并读取模型」，直接落在「模型」页，
   * 不能只 setPage("settings")——那会停在「个人资料」，用户在昵称/头像里找模型。
   */
  const goOnboarding = (target: OnboardingTarget) => {
    if (target === "settings") setPage("model");
    else setPage(target);
  };

  return (
    <PageShell
      title={
        <>
          {greeting}，{user?.displayName ?? ""}
          {/* d.138：日期此前是紧贴标题的 span，无障碍树把标题读成
              「下午好，设计评审2026-11-12 周四」；分隔点两侧留空格，视觉与朗读都断开。 */}
          <span className="ui-caption font-normal"> · {today}</span>
        </>
      }
      width="wide"
      bodyClassName="flex flex-col gap-4"
      actions={
        <>
          {/* 首页是「开始干活」的地方：先给动作，再给数字（审计：原来这里是版本号 + 今日用量）。
              d.138 主次对调：最高频的「新对话」用实心主按钮，「派任务」降为描边——
              此前低频的派任务反而是全页最重的黑色按钮，主次是反的。
              d.138 另外把「派任务」的目的地从 chat/tasks（对话页不认这个视图，等于静默掉到
              对话 Tab）改成团队页看板——任务本来就长在 TeamTaskPanel 里。 */}
          <Button size="sm" variant="primary" onClick={() => setPage("chat")}>
            新对话
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setPage("team", "board")}>
            派任务
          </Button>
        </>
      }
    >
      {/* ── 第一屏：现在要做什么（d.141） ──
          首页对日活用户只有一个问题「接着干什么」，对首跑用户是「下一步做什么」。
          所以第一屏只放可执行的三块：开始使用（仅首跑）/ 需要你处理 / 最近对话（继续上次）。
          统计与动向回答的是「我做了多少」，下沉到第二屏。

          两块劝进只留一块：引导卡在场时，最近对话空态（同样劝「去会话页」）不再出现。
          顺序也有意为之——先给「马上要处理的」，再给「上次干到哪」，最后才是引导（新用户没有前置项）。 */}
      <div data-testid="home-focus" className="flex flex-col gap-3">
        {/* 0. 首载失败：断网几秒回来时列表是空的，不说清楚会被读成「记录/智能体丢了」。
            只认 store 的首帧错误——已经成功拉到过一次之后，后台刷新失败不提示（旧数据仍可用）。 */}
        {!workspaceReady && workspaceError && (
          <div role="alert" className="ui-alert ui-alert-danger flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1">部分数据加载失败：{workspaceError}</span>
            {/* P2 可达性：`Button size="sm"` 高 28px，补 `.ui-hit` 撑到 32px（宽度已够） */}
            <Button type="button" size="sm" variant="ghost" className="ui-hit" onClick={retryWorkspace}>
              重试
            </Button>
          </div>
        )}

        {/* 1.5 首跑引导（UX-A · U1）：只在「一个模型连接都没有」且用户没关过时出现 */}
        {showOnboarding && (
          <OnboardingCard steps={onboardingSteps} onGo={goOnboarding} onDismiss={dismissOnboarding} />
        )}

        {/* 1.8 需要你处理：审批 / 运行中的任务 / 未读通知，全都能点（d.84）；空则整块不渲染 */}
        <NeedsAttention />

        {/* 1.9 继续上次：最近 3 个会话，点一下直接进那个会话（d.83 的阅读位置恢复接着上次的位置） */}
        <RecentConversations hideWhenEmpty={showOnboarding} />
      </div>

      {/* ── 第二屏：状态与动向（d.141） ── */}
      <section
        data-testid="home-secondary"
        aria-labelledby="home-status-heading"
        className="flex flex-col gap-3"
      >
        {/* 区块标题（2026-11-14 审计 A-03）：此前用 `ui-micro`（11px）当 h2，
            比正文 14px 还小，扫读时首页第二屏"没有标题"；改 `.ui-block-title`（16px/600），
            与 22px 页标题保持 1.375 倍差，中间不再断档。 */}
        <h2 id="home-status-heading" className="ui-block-title px-1">
          状态与动向
        </h2>

        {/* 2. 四张动作指标卡（不是看板数字）：宽窗 4 列，窄窗折成 2 列。
            data-testid 给测试一个稳定入口，不再靠 `.grid.grid-cols-4 > .ui-card` 猜结构。
            d.142：hint 只留「用户自己看不出来的东西」——待处理的未读构成、今日动向的失败原因；
            其余数字自解释（0 就是没有），「点开直接处理 / 本机运行 / 成员共享的任务与日程」
            这类复述句已删，让布局与数字自己说。 */}
        <div data-testid="home-stats" className="grid grid-cols-4 gap-3 max-[1199px]:grid-cols-2">
          <Stat
            label="待处理"
            value={pendingCount}
            hint={unreadNotifications > 0 ? `含 ${unreadNotifications} 条未读通知` : undefined}
            onOpen={pendingCount > 0 ? openPending : undefined}
            actionLabel="打开待处理事项"
          />
          <Stat
            label="运行中任务"
            value={runningTasks.length}
            onOpen={runningTasks.length > 0 ? openRunningTasks : undefined}
            actionLabel="查看运行中的任务"
          />
          <Stat
            label="会话"
            value={conversations.length}
            onOpen={() => setPage("chat")}
            actionLabel="打开会话页"
          />
          <Stat
            label="今日动向"
            value={teamError ? "—" : todayActivities}
            hint={teamError ? "团队数据加载失败" : undefined}
            onOpen={teamError ? undefined : () => setPage("team")}
            actionLabel="打开团队页"
          />
        </div>

        {/* 2.5 Token 用量：整宽一张卡（原来用 col-span-4 塞在统计网格里，窄窗折 2 列时
            还要再写 col-span-2，会额外生成隐式列）。 */}
        <UsageCard />

        {/* 2.6 插件首页卡（d.125）：沙箱 bundle 插件声明的卡片（信息中枢 / 自动化等）。
            数据只经 `window.__heming_plugins` 从宿主读，浏览器/旧版桌面端整块不渲染；
            模块运行时下线后这里是首页唯一的内置能力入口来源。 */}
        <PluginHomeCards />

        {/* 3. 团队动向：成员共享的任务与日程摘要（对话正文不上传） */}
        <TeamActivityCard
          activities={humanActivities}
          members={members}
          onlineCount={onlineCount}
          teamReady={teamReady}
          teamError={teamError}
          lastTeamLoadAt={lastTeamLoadAt}
          onRefresh={loadTeam}
          onOpenTeam={() => setPage("team")}
          onOpenBoard={() => setPage("team", "board")}
        />
      </section>

      {/* 7. 底部：服务状态 + 文件目录 + 更新日志入口（一行，异常时才变醒目）。
          d.138：三项之间补分隔点——此前只靠 gap 撑开，无障碍树把整行读成
          「服务：正常文件目录：未绑定」。
          F-14：探活原本是一次性的，「失败」既是无信息量的一个词、也没有重试入口，
          服务恢复后不刷新页面就一直停在失败。现在失败态 = 原因 + 就地重试。 */}
      <footer className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 ui-micro">
        <span>服务：{cloud === "失败" ? "连接失败" : cloud}</span>
        {cloud === "失败" && (
          <>
            <span className="ui-body-sm text-muted">连不上本机服务，可能刚重启或网络中断</span>
            <Button type="button" size="sm" variant="ghost" className="ui-hit" onClick={retryService}>
              重试
            </Button>
          </>
        )}
        <span> · </span>
        <span>
          文件目录：{writeRootCount > 0 ? `已绑定 ${writeRootCount} 个` : "未绑定"}
        </span>
        <span> · </span>
        {/* P2 可达性：`.ui-link` 高 24px，低于 32px 最小命中区；`.ui-hit` 用伪元素把可点区
            撑到 32×32，视觉不动（footer 是单行、左右间距 8px，不会吃掉相邻元素的点击）。 */}
        <button type="button" className="ui-link ui-hit" onClick={() => openSettings("about")}>
          更新日志
        </button>
      </footer>
    </PageShell>
  );
}