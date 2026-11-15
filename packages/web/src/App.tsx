import { Suspense, lazy, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useUiStore, type Page } from "./store/ui.js";
import { initTheme } from "./store/theme.js";
import { useAuthStore } from "./store/auth.js";
import { getToken } from "./lib/api.js";
import { SYSTEM_AGENT, SYSTEM_AGENT_ID } from "@heming/shared";
// 常驻壳与登录页保持同步导入：它们是首帧就要画出来的东西（顶栏/登录表单），
// 拆成异步反而会让首屏先闪一块占位。下面所有**页面**都改成路由级懒加载。
import { LoginPage } from "./components/LoginPage.js";
import { TopBar } from "./components/TopBar.js";
import { Sidebar } from "./components/Sidebar.js";
import { ShortcutsHelp } from "./components/ShortcutsHelp.js";
import { TitleBar } from "./components/TitleBar.js";
import { BootWave } from "./components/BootWave.js";
import { autoConnectAll } from "./lib/mcp/runtime.js";
import { useInfohubStore } from "./lib/infohub/store.js";
import { bindTeamShareUser } from "./lib/team/share.js";
import { ensureDesktopGateway } from "./lib/magpieHost.js";
import { useAppPresence } from "./lib/appPresence.js";
import { startWidgetEvents } from "./lib/widgetEvents.js";
import { refreshWidgets } from "./lib/widgets/store.js";
import { startWidgetThemeSync } from "./lib/widgetTheme.js";
import { useLlmStore } from "./store/llm.js";
import { usePluginPageEntries } from "./lib/pages/usePluginPages.js";
import { isPluginPagePage, pluginPageEntry } from "./lib/pages/registry.js";
import { PluginPageHost } from "./components/plugins/PluginPageHost.js";
import { hasOpenModal } from "./components/useModalA11y.js";
import { SkeletonBlock, SkeletonLine } from "./components/ui/Skeleton.js";
import { Button } from "./components/ui/Button.js";
import { PAGE_WIDTH_CLASS } from "./components/layout/PageShell.js";

/**
 * 路由级懒加载：每个页面单独成 chunk，首屏只下「壳」。
 *
 * 为什么用 `.then(m => ({ default: m.Xxx }))`：本仓组件都是**命名导出**，
 * 而 `lazy()` 只认 default。这层包一下既满足契约，又不改任何组件的导出形态
 * （改导出形态会波及全部引用与测试）。
 *
 * 为什么值得懒加载：设置区/任务区/信息中枢/记忆区这类重页面各自带着一坨只在
 * 本页用得到的依赖（设置区曾经牵着 242KB 的桌宠偏好块，d.98 拆插件后不再有这块）。
 * 拆开后这些块只在第一次切到该页时下载，启动帧只付壳的成本。
 */
const HomePage = lazy(() => import("./components/HomePage.js").then((m) => ({ default: m.HomePage })));
const TeamPage = lazy(() => import("./components/TeamPage.js").then((m) => ({ default: m.TeamPage })));
const AssistantPage = lazy(() =>
  import("./components/AssistantPage.js").then((m) => ({ default: m.AssistantPage })),
);
// 协作（d.146.5）：多智能体协作独立页，恢复的 collaboration 引擎只在进这页时下载。
const CollaborationPage = lazy(() =>
  import("./components/collaboration/CollaborationPage.js").then((m) => ({
    default: m.CollaborationPage,
  })),
);
const ModelPage = lazy(() => import("./components/ModelPage.js").then((m) => ({ default: m.ModelPage })));
const PluginsPage = lazy(() =>
  import("./components/PluginsPage.js").then((m) => ({ default: m.PluginsPage })),
);
// 知识库（d.114）：整个 knowledge 目录（含 CodeMirror 编辑器）只在进这页时才下载。
const KnowledgePage = lazy(() =>
  import("./components/knowledge/KnowledgePage.js").then((m) => ({ default: m.KnowledgePage })),
);
const SettingsPage = lazy(() =>
  import("./components/SettingsPage.js").then((m) => ({ default: m.SettingsPage })),
);
// 下面是「按需出现」的全局浮层/卡片，同样不该进首屏：
// 命令面板（Ctrl+K 才挂载）、安装确认卡（有 pending 才有内容）。
const CommandPalette = lazy(() =>
  import("./components/CommandPalette.js").then((m) => ({ default: m.CommandPalette })),
);
const RegistryInstallCard = lazy(() =>
  import("./components/RegistryInstallCard.js").then((m) => ({ default: m.RegistryInstallCard })),
);

/**
 * 懒加载占位：**页面骨架**（与常规页结构相近：左列 + 右侧内容区 + 顶部标题条）。
 *
 * 为什么不只放一行灰字：路由级懒加载后切页会先看到这个占位，一行居中的「加载中…」
 * 会让布局从「整页空」瞬间跳到「真实页」，观感上是闪一下；骨架与真实页同构，
 * 位置稳定、切换时内容块只是被替换。
 *
 * 约束（d39 用例依赖）：`data-testid="page-fallback"` 必须保留——`settleRoutedPage()`
 * 用它判断目标页 chunk 已挂上。纯静态、无定时器/动画；`pointer-events-none` 保证
 * 占位期间不会截走本该落到壳层（导航/标题栏）的点击。
 */
export function PageFallback() {
  return (
    <div
      data-testid="page-fallback"
      role="status"
      aria-busy="true"
      className="pointer-events-none flex h-full w-full min-w-0 select-none"
    >
      {/* 无障碍：骨架块对读屏无意义，只播报「正在加载页面」 */}
      <span className="sr-only">正在加载页面</span>

      {/* 左列：与设置区/团队页等「列表 + 内容」页的次级导航同宽 */}
      <div className="hidden w-[184px] shrink-0 flex-col gap-2 border-r border-line-soft p-3 min-[720px]:flex">
        <SkeletonLine className="mb-1 h-3 w-16" />
        <SkeletonLine className="h-2.5 w-[72%]" />
        <SkeletonLine className="h-2.5 w-[56%]" />
        <SkeletonLine className="h-2.5 w-[64%]" />
        <SkeletonLine className="h-2.5 w-[48%]" />
      </div>

      {/* 右侧内容：顶部标题条 + 内容块（骨架基元与各页 loading 态同一套观感） */}
      <div className="min-w-0 flex-1 p-4">
        <div className="mb-4 flex items-center justify-between border-b border-line-soft pb-3">
          <SkeletonLine className="h-4 w-32" />
          <SkeletonLine className="h-6 w-16" />
        </div>
        <div className="flex flex-col gap-3">
          <SkeletonLine className="h-3 w-[60%]" />
          <SkeletonLine className="h-3 w-[80%]" />
          <SkeletonBlock className="h-24 w-full rounded-lg" />
          <SkeletonLine className="h-3 w-[40%]" />
        </div>
      </div>
    </div>
  );
}

/**
 * Alt+数字键目标页。页面入口现在只有侧栏「主导航」与命令面板两处，
 * 数字键口径与 `lib/palette/pages.ts` 的 `PALETTE_PAGES.digit` 严格对应
 * （命令面板/快捷键帮助直接读那份正表，这里只是键盘监听用的映射）。
 * 1 主页、2 团队（承接原团队看板）、5 协作（和鸣 + 本机智能体）、6 设置、
 * 8 会话（单智能体的对话页）、0 插件。记忆页已删除（记忆默认全开、无界面），
 * 原先的 3 技能区 / 4 接口区没有承接页——两个页面都并进了插件页的 Tab，
 * 不给已有页凭空换号，让 3/4 空着比让人重新记「3 现在是什么」更省心。
 */
export const SHORTCUT_PAGES: Partial<Record<string, Page>> = {
  "1": "home",
  "2": "team",
  "5": "collab",
  "6": "settings",
  "8": "chat",
  "0": "plugins",
};

/**
 * 顶层：主界面常驻，启动动画作为全屏遮罩盖在其上。
 *
 * AppShell 从 T=0 就挂载，其 restore()（GET /api/me）在动画播放期间于后台完成——
 * 动画约 3s，足够覆盖一次常规恢复，动画结束时已经是恢复后的界面。
 * 若反过来把 AppShell 挡在动画之后（早期实现），restore 要到 T≈3s 才开始，
 * 已登录用户会紧接着启动动画看到一个「加载中…」空窗。
 *
 * BootWave 的遮罩以中心透明洞向外揭示主界面，因此「先挂载、后揭开」在视觉上
 * 等于「主界面从中心向外渐次显现」，不会提前暴露真实 UI。
 */
/**
 * 桌面端（preload 暴露了启动信号通道）的手写段由 splash 窗口负责，
 * web 层不能再写一遍；浏览器/预览环境没有 splash，才由 BootWave 自己播手写段。
 */
const HAS_NATIVE_SPLASH = typeof window.heming?.__onBootReady === "function";

/** 键盘事件是否发生在可输入元素里：`?` / `Ctrl+/` 这类字符键在输入框内必须让给输入。 */
function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el.isContentEditable) return true;
  return typeof el.closest === "function" && el.closest('[contenteditable="true"]') !== null;
}

export function App() {
  // 应用级在场连接：人在应用里就算在线（团队名册/在线数不再要求「正开着某个会话」）
  useAppPresence();

  // 首帧之前就把主题色写进 CSS 变量，避免刷新时闪回默认墨色
  initTheme();

  const [bootDone, setBootDone] = useState(false);
  const handleBootDone = useCallback(() => setBootDone(true), []);
  const shellRef = useRef<HTMLDivElement>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  // 启动动画的圆环落位：登录页用右半区（clipped），其它页保持中心扩散。
  // 登录页第一屏就是登录卡；圆环从窗口中心扩散会横穿卡片，看起来像装饰压字。
  // 判定与 AppShell 的登录分支同口径：无用户且无 token = 登录页。
  const bootUser = useAuthStore((s) => s.user);
  const bootRipplePlacement = !bootUser && !getToken() ? "right" : "center";

  // 本机归档：只探测桥与运行态，不自动拉起 Python（拉起必须由用户点「连接」）。
  useEffect(() => {
    void useInfohubStore.getState().boot();
  }, []);

  // 内置 magpie（d.91）：桌面端由主进程托管，这里只取它给的反代地址并刷新模型目录。
  // 浏览器没有这个桥，ensureDesktopGateway 直接返回 supported:false，不影响手动网关。
  useEffect(() => {
    void ensureDesktopGateway();
  }, []);

  // 原生知识库（d.114）：启动时懒加载启动粘合层（`bootVault()` 幂等、失败不抛）。
  // 动态 import 保证 vault 索引与 CodeMirror 编辑器不进首屏 chunk；浏览器无文件桥时
  // bootVault 内部切到内存临时模式，不在这里分叉。
  useEffect(() => {
    void import("./lib/vault/boot.js")
      .then((m) => m.bootVault())
      .catch(() => {
        /* 知识库起不来不影响聊天与其它页面（启动期失败只写进 boot 的返回值） */
      });
  }, []);

  // 全局搜索：Ctrl/⌘+K。启动动画期间不响应（与 Alt+N 同一套纪律：
  // 遮罩后面看不见的界面不该接受输入）。模态弹窗开着时同样不响应：面板与弹窗
  // 在 DOM 里不是嵌套关系，面板的屏蔽会把弹窗一起 inert 掉，Esc 归属随之错位。
  //
  // 快捷键帮助：`?`（Shift+/）或 Ctrl/⌘+/ 打开同一面板。输入框内不响应——
  // 用户是在打问号，不是在求帮助；Esc 由弹窗骨架（useModalA11y）负责只关自己。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!bootDone) return;
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (hasOpenModal()) return;
        setPaletteOpen((v) => !v);
        return;
      }
      const helpKey =
        (e.key === "?" && !e.metaKey && !e.ctrlKey && !e.altKey) ||
        ((e.metaKey || e.ctrlKey) && !e.altKey && e.key === "/");
      if (!helpKey) return;
      if (isEditableTarget(e.target)) return;
      e.preventDefault();
      if (hasOpenModal()) return;
      setShortcutsOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bootDone]);

  // 动画期间主界面不可交互（规格 §7：动画不可跳过，不响应点击/键盘）。
  // 遮罩挡住了画面，但 AppShell 早已挂载且活着——不加 inert 的话点击会落在看不见的
  // 按钮上，全局快捷键（Alt+1–9 / Ctrl+K）也会在启动动画期间生效。
  // React 18 无 inert 属性类型，用原生 toggleAttribute 等价设置/移除（同 RadarContacts）。
  useEffect(() => {
    shellRef.current?.toggleAttribute("inert", !bootDone);
  }, [bootDone]);

  return (
    <>
      {/* 包一层仅为挂 inert：不加样式，AppShell 根节点自身的 h-screen 决定布局 */}
      <div ref={shellRef}>
        <AppShell
          onOpenSearch={() => setPaletteOpen(true)}
          onOpenShortcuts={() => setShortcutsOpen(true)}
        />
      </div>
      {!bootDone && (
        <BootWave
          onDone={handleBootDone}
          writeFirst={!HAS_NATIVE_SPLASH}
          ripplePlacement={bootRipplePlacement}
        />
      )}
      {/* 全局加一层除了命令面板之外的空壳：面板自己带着遮罩，不需要外层容器 */}
      {paletteOpen && (
        <Suspense fallback={null}>
          <CommandPalette onClose={() => setPaletteOpen(false)} />
        </Suspense>
      )}
      {/* 快捷键帮助：`?` / Ctrl+/ 或导航轨「?」打开；Esc 由 useModalA11y 只关自己 */}
      {shortcutsOpen && <ShortcutsHelp onClose={() => setShortcutsOpen(false)} />}
    </>
  );
}

/**
 * 登录恢复期的居中状态外壳（d.141）。
 *
 * 改动前这里有两套写法：「正在恢复登录…」是一个裸 div（items-center justify-center），
 * 重连面板自己又写了 `flex h-full w-full items-center justify-center px-6` + 内层
 * `max-w-[380px]`。同一个位置、同一件事（凭证在、但还没连上服务端），垂直对齐和内边距
 * 却是两套，状态切换时内容会横跳一下；380 这个宽度也不来自任何档位。
 *
 * 现在收成一个壳：内容居中、宽度取 PageShell 的内容档位（prose = 680，说明型短文 + 出口按钮，
 * 与首页空态/说明块同档；不是表单，所以不用 form），窄窗靠 w-full + px-6 自适应，不写死像素宽。
 */
function AuthStatusPanel({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full w-full items-center justify-center overflow-y-auto px-6 py-8">
      <div className={`mx-auto w-full ${PAGE_WIDTH_CLASS.prose} text-center`}>{children}</div>
    </div>
  );
}

/**
 * 登录恢复失败面板：凭证还在，只是此刻连不上服务端。
 * 不把用户推回登录页，给出「立即重试 / 退出登录」两个明确出口。
 */
function ReconnectPanel({
  message,
  onRetry,
  onLogout,
}: {
  message: string | null;
  onRetry: () => void;
  onLogout: () => void;
}) {
  return (
    <AuthStatusPanel>
      <h1 className="ui-section-title">登录状态已保留</h1>
      <p className="ui-body-sm mt-2 text-body">
        {message ? `暂时连不上服务器：${message}` : "正在重新连接服务器…"}
      </p>
      {/* d.142：原来这里还有「网络恢复后会自动重试，不需要重新登录。」——
          和下面的「立即重试」说同一件事，删掉让状态行 + 原因 + 两个出口自己说话。 */}
      <div className="mt-4 flex items-center justify-center gap-2">
        <Button
          type="button"
          onClick={onRetry}
          size="md" variant="primary"
        >
          立即重试
        </Button>
        <Button
          type="button"
          onClick={onLogout}
          size="md" variant="ghost"
        >
          退出登录
        </Button>
      </div>
    </AuthStatusPanel>
  );
}

/** 登录页/主界面内容：与启动动画并行挂载（动画仅作遮罩），不做时序门禁。 */
function AppShell({
  onOpenSearch,
  onOpenShortcuts,
}: {
  onOpenSearch: () => void;
  onOpenShortcuts: () => void;
}) {
  const authStatus = useAuthStore((s) => s.status);
  const authUser = useAuthStore((s) => s.user);
  const restoreError = useAuthStore((s) => s.restoreError);
  const restore = useAuthStore((s) => s.restore);
  const logout = useAuthStore((s) => s.logout);

  useEffect(() => {
    void restore();
  }, [restore]);

  /**
   * 团队共享设置按账号隔离（隐私边界）：同一台电脑换账号登录时，
   * 上一个人的共享开关 / 清除水位不能继承给下一个人，否则新账号会在
   * 从未同意的情况下把本机任务、日程、用量上报给全站团队。
   * `bindTeamShareUser` 内部处理「首次绑定认领 / 同账号 no-op / 换账号清空」。
   */
  useEffect(() => {
    if (!authUser) return;
    bindTeamShareUser(authUser.id);
  }, [authUser]);

  // 网络恢复时立刻再试一次，不必等退避到点
  useEffect(() => {
    const onOnline = () => {
      if (getToken() && !useAuthStore.getState().user) void restore();
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [restore]);

  /**
   * 登录成功后自动连接 MCP 服务并发现工具（用户要求：不要每次手动点）。
   *
   * 只在已登录时做：登录前拉起 MCP 子进程纯属浪费（用户可能压根不用）。
   * 失败静默——MCP 不可用不该挡住进主界面，用户在接口区能看到具体原因。
   */
  const [mcpReady, setMcpReady] = useState(false);
  useEffect(() => {
    if (!authUser || mcpReady) return;
    setMcpReady(true); // 早于 await 设位：避免 restore 抖动导致重复连接
    void autoConnectAll().catch(() => {
      /* 失败由接口区呈现，不打扰主流程 */
    });
  }, [authUser, mcpReady]);

  const page = useUiStore((s) => s.page);
  const setPage = useUiStore((s) => s.setPage);

  // d.124：插件页面入口（导航轨、设置区导航说明、路由守卫读同一份注册表投影）。
  const pluginPageEntries = usePluginPageEntries();

  // d.115：信息中枢插件生效 = 自动拉起本机边车（不依赖页面挂载），并自动识别、
  // 空库时采集一次；插件停用 = 运行时一起下线（不删任何归档数据）。
  const infohubPluginOn =
    pluginPageEntry(pluginPageEntries, "plugin:heming.infohub")?.available === true;
  useEffect(() => {
    if (!infohubPluginOn) {
      if (!useInfohubStore.getState().running) return;
      void useInfohubStore
        .getState()
        .disconnect()
        .catch(() => {
          /* 停用时的进程回收失败不该影响界面：页面入口已下线，重新启用会再拉起 */
        });
      return;
    }
    void useInfohubStore.getState().ensureRunning();
  }, [infohubPluginOn]);

  // 系统通知点击 → 主进程回传会话 id → 打开会话（未登录时忽略，登录后再点即可）
  useEffect(() => {
    const bridge = typeof window !== "undefined" ? window.__heming_notify : undefined;
    if (!bridge?.onOpen) return;
    return bridge.onOpen((id) => {
      if (!id || !useAuthStore.getState().user) return;
      useUiStore.getState().openConversation(id);
    });
  }, []);

  // 模型路由页已删除：旧存储/旧链接里的 `modelroute` 同样回落主页。
  // d.124：插件页面同一条纪律——入口不在注册表里、或已停用/卸载，一律回主页。
  const resolvedPage: Page = page === "modelroute" ? "home" : page;
  const pluginPageAvailable =
    !isPluginPagePage(resolvedPage) || pluginPageEntry(pluginPageEntries, resolvedPage)?.available === true;
  const currentPage: Page = pluginPageAvailable ? resolvedPage : "home";
  useEffect(() => {
    if (page !== currentPage) setPage(currentPage);
  }, [page, currentPage, setPage]);

  // 界面插件（原桌宠，d.98）的「打开设置 / 气泡直达页面」出口：主进程只转发白名单页面。
  // 旧 preload 没有 onOpenPage 时自动跳过（页面跳转是便利功能，不是可用性前提）。
  useEffect(() => {
    const bridge = typeof window !== "undefined" ? window.__heming_widgets : undefined;
    if (!bridge?.onOpenPage) return;
    return bridge.onOpenPage((request) => {
      const page = request?.page;
      const ui = useUiStore.getState();
      if (page === "settings") {
        // widget 的「打开设置」与托盘「设置」项都该落到外观页的小组件卡（不是个人资料）
        ui.openSettings(request.settingsTab ?? "appearance");
      } else if (page === "team") ui.setPage("team");
      else if (page === "tasks") ui.setPage("tasks");
      // 幕僚页面已随模块运行时下线：旧桌宠/托盘入口统一落到插件区。
      else if (page === "staff") ui.openStaff();
      // 信息中枢由沙箱插件提供页面；openInfohub 会落到 `plugin:heming.infohub`。
      else if (page === "infohub") ui.openInfohub();
      // 白名单之外的 page（主进程已过滤过）一律忽略
    });
  }, []);

  // 界面插件的对话上下文（d.98 §3.4 `chatConfig`）：widget 要一句话短回复时向主进程要，
  // 主进程再向主窗要一次「可用智能体 + 绑定」。Key 不出主进程——这里只给智能体列表与提示词，
  // 网关地址/Key 由主进程补（用户供应商 Key 不经过这条通道）。
  // ★ `binding.agentId` 固定回 null：桌宠绑哪个智能体是**插件设置**（主进程持有），
  //   主进程转发给 widget 前会用 settings.agentId 覆盖；主窗不替它决定。
  useEffect(() => {
    const bridge = typeof window !== "undefined" ? window.__heming_widgets : undefined;
    if (!bridge?.onChatConfigRequest || !bridge?.replyChatConfig) return;
    return bridge.onChatConfigRequest((request) => {
      const requestId = request?.requestId;
      if (!requestId) return;
      void (async () => {
        try {
          // 单智能体固定：名册只为拿内置智能体（服务端保证存在一个），拉不到就回落到本地常量。
          const { useChatStore } = await import("./store/chat.js");
          if (useChatStore.getState().agentsRoster.length === 0) {
            try {
              await useChatStore.getState().loadAgentsRoster();
            } catch {
              /* 名册拉不到也不要让 widget 空着：下面回落到 SYSTEM_AGENT */
            }
          }
          const llm = useLlmStore.getState();
          const prompt = llm.prompts[SYSTEM_AGENT_ID]?.trim();
          const agent = useChatStore.getState().agentsRoster[0] ?? SYSTEM_AGENT;
          const agents = [{ id: agent.id, name: agent.name, ...(prompt ? { prompt } : {}) }];
          bridge.replyChatConfig?.(requestId, {
            agents,
            binding: { agentId: null },
            // d.125：后台任务模型（归档/摘要）与模型目录一起下发；主进程再按目录校验 id
            models: llm.models.map((model) => ({ id: model.id, name: model.name })),
            backgroundModel: llm.backgroundModel,
          });
        } catch {
          bridge.replyChatConfig?.(requestId, {
            agents: [],
            binding: { agentId: null },
            models: [],
            backgroundModel: null,
          });
        }
      })();
    });
  }, []);

  // 通知中心 → 界面插件的事件转发（脱敏后交给主进程；主进程再按 permissions.events 分发）。
  // 静态引入：这只是几十行的纯逻辑，不牵任何重模块（首屏零负担）。
  useEffect(() => {
    return startWidgetEvents();
  }, []);

  // d.124：界面插件的页面入口由主进程记录驱动，进入应用时先拉一次列表
  // （浏览器里没有 `__heming_widgets`，refreshWidgets 是 no-op，不会多发请求）。
  useEffect(() => {
    void refreshWidgets();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!authUser) return;
      const t = e.target as HTMLElement | null;
      const inText =
        !!t &&
        (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      // Alt+数字键直接切页（不用 ⌘/Ctrl，避开浏览器/输入法组合键冲突）；输入框内不响应。
      // 7/9 已随会话/归档页取消，映射表里没有的键位直接忽略。
      const shortcutPage = SHORTCUT_PAGES[e.key];
      if (e.altKey && !e.metaKey && !e.ctrlKey && shortcutPage) {
        if (inText) return;
        e.preventDefault();
        // 模态弹窗开着时只吞键不切页：切走的子树里还留着那个弹窗，
        // 焦点归还、Esc 归属与 inert 计数全落在已经不属于当前视图的 DOM 上。
        if (hasOpenModal()) return;
        setPage(shortcutPage);
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [authUser, setPage]);

  if (!authUser) {
    // token 仍在 = 只是暂时恢复不了（断网/服务重启）；显示重连面板而不是登录页，
    // 避免一次网络抖动就把已登录用户踢回登录。401 会清 token，这里自然回落登录页。
    const hasToken = Boolean(getToken());
    return (
      <div className="flex h-screen flex-col overflow-hidden">
        {/* 桌面壳自定义标题栏：浏览器端渲染 null，布局与原先一致（设计 §5） */}
        <TitleBar />
        <div className="flex min-h-0 flex-1">
          {hasToken ? (
            authStatus === "pending" && !restoreError ? (
              <AuthStatusPanel>
                <p role="status" className="ui-body-sm text-muted">
                  正在恢复登录…
                </p>
              </AuthStatusPanel>
            ) : (
              <ReconnectPanel
                message={restoreError}
                onRetry={() => void restore()}
                onLogout={logout}
              />
            )
          ) : (
            <LoginPage />
          )}
        </div>
      </div>
    );
  }

  const view =
    currentPage === "home" ? (
      <HomePage />
    ) : currentPage === "team" ? (
      // 团队：真实成员名册 + 动向流（任务 / 日程摘要）；d.67 起承接「看板」视图
      <TeamPage />
    ) : currentPage === "chat" ? (
      // 会话（本机运行）：单智能体的会话列表 + 对话；d.67 起承接「任务」视图
      <AssistantPage />
    ) : currentPage === "collab" ? (
      // 协作（d.146.5）：多智能体协作——和鸣 + 本机智能体，按顺序/主管/辩论一起干活
      <CollaborationPage />
    ) : currentPage === "model" ? (
      // 模型页：内核管理面——供应商/订阅账号/分组/用量/备份/同步
      <ModelPage />
    ) : currentPage === "vault" ? (
      // 知识库（d.114）：本地 vault 三栏界面（文件树 / 编辑器 / 反链标签图谱），数据不出设备
      <KnowledgePage />
    ) : currentPage === "plugins" ? (
      // 插件区（能力中心）：插件 / 技能 / MCP 三个 Tab（技能区自 d.67 并入，d.148.4.95 起为单一列表）
      <PluginsPage />
    ) : isPluginPagePage(currentPage) ? (
      // 插件页面（d.124）：入口来自已装插件的页面贡献，渲染路径由来源决定
      // （声明式 = 宿主按 blocks 渲染；界面插件 = 主进程 widget:// 沙箱视图）
      <PluginPageHost page={currentPage} />
    ) : (
      <SettingsPage />
    );

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-surface">
      {/* 顶栏是唯一常驻的全局控件条：手写标志兼作桌面拖拽区，右侧是命令面板/
          快捷键帮助/通知。页面导航与账户各有归属（会话侧栏顶部 / 侧栏左下角）。 */}
      <TopBar onOpenSearch={onOpenSearch} onOpenShortcuts={onOpenShortcuts} />
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {/* 会话侧栏常驻：所有页面左侧都保持会话入口（导航轨删除后的主要导航面）。 */}
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {/* min-w-0 + overflow-hidden：窄窗下宽页面（settings/team 等）不横向撑破主列 */}
          <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
            {/* 每个槽位各自 Suspense：只有当前页一块走占位，壳（顶栏/侧栏）不动。
                启动动画挂着时页面 chunk 已在后台加载，揭开时通常已经就绪。 */}
            <Suspense fallback={<PageFallback />}>{view}</Suspense>
          </div>
        </main>
      </div>
      {/* 安装确认是全局的：从接口区发起，但用户可能立刻切页；
          挂在根节点上，pending 在第几页都能弹出来。 */}
      <Suspense fallback={null}>
        <RegistryInstallCard />
      </Suspense>
    </div>
  );
}
