import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import { useUiStore, type Page } from "./store/ui.js";
import { initTheme } from "./store/theme.js";
import { useAuthStore } from "./store/auth.js";
import { getToken, fetchFiles, fetchFileUsage, uploadFile } from "./lib/api.js";
import type { SharedFileMeta } from "@heming/shared";
// 常驻壳与登录页保持同步导入：它们是首帧就要画出来的东西（标题栏/导航轨/登录表单），
// 拆成异步反而会让首屏先闪一块占位。下面所有**页面**都改成路由级懒加载。
import { LoginPage } from "./components/LoginPage.js";
import { NavRail } from "./components/NavRail.js";
import { FileTree } from "./components/FileTree.js";
import { ShortcutsHelp } from "./components/ShortcutsHelp.js";
import { TitleBar } from "./components/TitleBar.js";
import { BootWave } from "./components/BootWave.js";
import { autoConnectAll } from "./lib/mcp/runtime.js";
import { useInfohubStore } from "./lib/infohub/store.js";
import { useAutomationScheduler } from "./lib/automation/scheduler.js";
import { useStaffLoop } from "./lib/staff/loop.js";
import { hasOpenModal } from "./components/useModalA11y.js";

/**
 * 路由级懒加载：每个页面单独成 chunk，首屏只下「壳」。
 *
 * 为什么用 `.then(m => ({ default: m.Xxx }))`：本仓组件都是**命名导出**，
 * 而 `lazy()` 只认 default。这层包一下既满足契约，又不改任何组件的导出形态
 * （改导出形态会波及全部引用与测试）。
 *
 * 为什么值得懒加载：设置区/任务区/信息中枢/记忆区这类重页面各自带着一坨只在
 * 本页用得到的依赖（设置区还牵着桌宠偏好，实测把 242KB 的 petPrefs 块拖进了首屏）。
 * 拆开后这些块只在第一次切到该页时下载，启动帧只付壳的成本。
 */
const HomePage = lazy(() => import("./components/HomePage.js").then((m) => ({ default: m.HomePage })));
const TeamPage = lazy(() => import("./components/TeamPage.js").then((m) => ({ default: m.TeamPage })));
const AssistantPage = lazy(() =>
  import("./components/AssistantPage.js").then((m) => ({ default: m.AssistantPage })),
);
const TeamBoardPage = lazy(() =>
  import("./components/TeamBoardPage.js").then((m) => ({ default: m.TeamBoardPage })),
);
const StaffPage = lazy(() => import("./components/StaffPage.js").then((m) => ({ default: m.StaffPage })));
const InfohubPage = lazy(() =>
  import("./components/InfohubPage.js").then((m) => ({ default: m.InfohubPage })),
);
const AutomationPage = lazy(() =>
  import("./components/AutomationPage.js").then((m) => ({ default: m.AutomationPage })),
);
const TaskAreaPage = lazy(() =>
  import("./components/TaskAreaPage.js").then((m) => ({ default: m.TaskAreaPage })),
);
const SkillsPage = lazy(() => import("./components/SkillsPage.js").then((m) => ({ default: m.SkillsPage })));
const PluginsPage = lazy(() =>
  import("./components/PluginsPage.js").then((m) => ({ default: m.PluginsPage })),
);
const MemoryPage = lazy(() => import("./components/MemoryPage.js").then((m) => ({ default: m.MemoryPage })));
const SettingsPage = lazy(() =>
  import("./components/SettingsPage.js").then((m) => ({ default: m.SettingsPage })),
);
const InterfacesPage = lazy(() =>
  import("./components/InterfacesPage.js").then((m) => ({ default: m.InterfacesPage })),
);
// 下面三个是「按需出现」的全局浮层/卡片，同样不该进首屏：
// 命令面板（Ctrl+K 才挂载）、文件预览模态（点预览才挂载）、安装确认卡（有 pending 才有内容）。
const CommandPalette = lazy(() =>
  import("./components/CommandPalette.js").then((m) => ({ default: m.CommandPalette })),
);
const FilePreviewModal = lazy(() =>
  import("./components/FilePreviewModal.js").then((m) => ({ default: m.FilePreviewModal })),
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
      <div className="hidden w-[184px] shrink-0 border-r border-line-soft p-3 min-[720px]:block">
        <div className="mb-3 h-3 w-16 rounded-sm bg-line-soft" />
        <div className="space-y-2">
          <div className="h-2.5 w-[72%] rounded-sm bg-line-soft" />
          <div className="h-2.5 w-[56%] rounded-sm bg-line-soft" />
          <div className="h-2.5 w-[64%] rounded-sm bg-line-soft" />
          <div className="h-2.5 w-[48%] rounded-sm bg-line-soft" />
        </div>
      </div>

      {/* 右侧内容：顶部标题条 + 内容块 */}
      <div className="min-w-0 flex-1 p-4">
        <div className="mb-4 flex items-center justify-between border-b border-line-soft pb-3">
          <div className="h-4 w-32 rounded-sm bg-line-soft" />
          <div className="h-6 w-16 rounded-md bg-line-soft" />
        </div>
        <div className="space-y-3">
          <div className="h-3 w-[60%] rounded-sm bg-line-soft" />
          <div className="h-3 w-[80%] rounded-sm bg-line-soft" />
          <div className="h-24 w-full rounded-lg bg-panel" />
          <div className="h-3 w-[40%] rounded-sm bg-line-soft" />
        </div>
      </div>
    </div>
  );
}

/**
 * Alt+数字键目标页：1 主页、2 团队看板、3 技能区、4 接口区、5 记忆区、
 * 6 设置区、8 通用智能体、0 插件区。
 *
 * 去 IM 时原「会话」的 Alt+9 与「归档」的 Alt+7 一并取消，其余编号不动——
 * 改动老页的序号等于换掉用户肌肉记忆里的快捷键。智能体/团队/幕僚/信息中枢/
 * 自动化都是新页，不占数字键。
 *
 * 这里的键位必须与 NavRail 的 `digit` 严格对应（那边是快捷键提示的唯一来源）。
 */
const SHORTCUT_PAGES: Partial<Record<string, Page>> = {
  "1": "home",
  "2": "workspace",
  "3": "skills",
  "4": "interfaces",
  "5": "memory",
  "6": "settings",
  "8": "tasks",
  "0": "plugins",
};

/** 右侧目录栏宽度上下限（像素）：太窄放不下文件名，太宽会挤掉主内容。 */
export const ASIDE_MIN = 180;
export const ASIDE_MAX = 560;
const ASIDE_DEFAULT = 240;

/** 夹住目录栏宽度；非法值回落到默认宽。 */
export function clampAsideWidth(n: number): number {
  if (!Number.isFinite(n)) return ASIDE_DEFAULT;
  return Math.min(ASIDE_MAX, Math.max(ASIDE_MIN, Math.round(n)));
}

const ASIDE_WIDTH_KEY = "heming.asideWidth.v1";

/** 读上次调好的目录栏宽度；缺失/损坏 → 默认 240。 */
function readAsideWidth(): number {
  try {
    const raw = window.localStorage.getItem(ASIDE_WIDTH_KEY);
    return raw ? clampAsideWidth(Number(raw)) : ASIDE_DEFAULT;
  } catch {
    return ASIDE_DEFAULT;
  }
}

/** 宽度落盘；存不下（隐私模式）时只在本次会话生效。 */
function persistAsideWidth(n: number): void {
  try {
    window.localStorage.setItem(ASIDE_WIDTH_KEY, String(n));
  } catch {
    /* 忽略 */
  }
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
}

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
    <div className="flex h-full w-full items-center justify-center px-6">
      <div className="w-full max-w-[380px] text-center">
        <h1 className="text-[15px] font-extrabold">登录状态已保留</h1>
        <p className="mt-2 text-[12px] text-[#555]">
          {message ? `暂时连不上服务器：${message}` : "正在重新连接服务器…"}
        </p>
        <p className="mt-1 text-[11px] text-muted">
          网络恢复后会自动重试，不需要重新登录。
        </p>
        <div className="mt-4 flex items-center justify-center gap-2">
          <button
            type="button"
            onClick={onRetry}
            className="rounded-lg bg-ink px-3 py-1.5 text-[12px] font-medium text-white"
          >
            立即重试
          </button>
          <button
            type="button"
            onClick={onLogout}
            className="rounded-lg border border-line px-3 py-1.5 text-[12px] text-muted hover:bg-[#fafafa]"
          >
            退出登录
          </button>
        </div>
      </div>
    </div>
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

  const [files, setFiles] = useState<SharedFileMeta[]>([]);
  const [usage, setUsage] = useState<{ used: number; quota: number } | null>(null);

  /** 右栏文件行 hover「预览」的目标文件（null = 模态关闭）。 */
  const [previewFile, setPreviewFile] = useState<SharedFileMeta | null>(null);
  const refreshFiles = useCallback(() => {
    void fetchFiles().then(setFiles);
    void fetchFileUsage()
      .then(setUsage)
      .catch(() => setUsage(null)); // 用量接口失败静默（不影响文件列表）
  }, []);
  useEffect(() => {
    if (authUser) refreshFiles();
  }, [authUser, refreshFiles]);

  const onUpload = async () => {
    const input = document.createElement("input");
    input.type = "file";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        await uploadFile(file); // base64 编码与 POST 已下沉到 lib/api
        refreshFiles();
      } catch (e) {
        console.error("上传失败", e);
        window.alert(`上传失败：${e instanceof Error ? e.message : String(e)}`);
      }
    };
    input.click();
  };

  const page = useUiStore((s) => s.page);
  const setPage = useUiStore((s) => s.setPage);

  // 本机自动化：只在登录后的桌面端到点执行，不补跑、不自动拉起 InfoHub
  useAutomationScheduler(Boolean(authUser));
  // 常驻幕僚（d.48）：登录后巡检日程与任务，只读、只递简报
  useStaffLoop(Boolean(authUser));

  // 系统通知点击 → 主进程回传会话 id → 打开会话（未登录时忽略，登录后再点即可）
  useEffect(() => {
    const bridge = typeof window !== "undefined" ? window.__heming_notify : undefined;
    if (!bridge?.onOpen) return;
    return bridge.onOpen((id) => {
      if (!id || !useAuthStore.getState().user) return;
      useUiStore.getState().openConversation(id);
    });
  }, []);

  // 桌宠的「去设置 / 点气泡直达页面」出口（未登录时忽略）。
  // 复用同一条通道：收到 page 时直达对应页面，无 page（旧的无参调用）仍落到设置页。
  useEffect(() => {
    const bridge = typeof window !== "undefined" ? window.__heming_pet : undefined;
    if (!bridge?.onOpenSettings) return;
    return bridge.onOpenSettings((page) => {
      const ui = useUiStore.getState();
      if (page === "team") ui.setPage("team");
      else if (page === "tasks") ui.setPage("tasks");
      else if (page === "staff") ui.setPage("staff");
      else if (page === "infohub") ui.openInfohub();
      else ui.openSettings("model");
    });
  }, []);

  // 桌宠在场感（第二波）：订阅通知中心新增条目；主窗口不在前台时才让桌宠开口。
  // 动态导入而不是静态：petEvent 契约层当前静态依赖 staff/model（30KB 源码），
  // 静态引入会把整块 82.8KB(gzip) 拖进首屏并被两个入口预载。改成挂载后再加载，
  // 在场感订阅晚一个 tick 生效（用户无感），首屏直接省掉这块。
  useEffect(() => {
    void import("./lib/petEvent.js").then((m) => m.startPetPresence());
  }, []);

  // 右侧目录栏宽度：可拖动调节，落盘后下次启动保持（用户要求「支持拖动改变大小」）
  const [asideWidth, setAsideWidth] = useState(() => readAsideWidth());
  const onResizeStart = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    // 宽度变化只跟水平位移；竖向位移忽略，避免拖出边界后卡住
    const startX = e.clientX;
    const startW = asideWidthRef.current;
    const move = (ev: PointerEvent) => {
      // 往右拖 = 变宽，故用 startX 减当前 x
      setAsideWidth(clampAsideWidth(startW + (ev.clientX - startX)));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    // 拖动期禁用光标选择与默认选中，否则会顺带把文件文字全刷成选中态
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, []);
  // 回调里读不到最新 state，用 ref 兜住当前宽度（与 RadarContacts 的 zoom 兜法一致）
  const asideWidthRef = useRef(asideWidth);
  asideWidthRef.current = asideWidth;
  useEffect(() => {
    persistAsideWidth(asideWidth);
  }, [asideWidth]);

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
      if (!e.metaKey && !e.ctrlKey) return;
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
              <div className="flex h-full w-full items-center justify-center text-muted">
                正在恢复登录…
              </div>
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
    page === "home" ? (
      <HomePage />
    ) : page === "team" ? (
      // 团队：真实成员名册 + 动向流（任务 / 日程摘要）
      <TeamPage />
    ) : page === "chat" ? (
      // 智能体（本机运行）：左侧智能体名册 + 右侧对话（复用 ChatPage）
      <AssistantPage />
    ) : page === "workspace" ? (
      // 团队看板：真实成员的任务 / 日程摘要，按两列铺开
      <TeamBoardPage />
    ) : page === "staff" ? (
      // 幕僚：常驻主动简报（只读采集 + 一键跳转）
      <StaffPage />
    ) : page === "infohub" ? (
      // 信息中枢：本机 QQ/微信归档（桌面端 Python 子进程，数据不出本机）
      <InfohubPage />
    ) : page === "automations" ? (
      // 自动化：本机定时同步/重扫，只在和鸣运行且信息中枢已连接时执行
      <AutomationPage />
    ) : page === "tasks" ? (
      // 通用智能体：页内直接选智能体、写目标并运行；保留运行记录与结果汇总
      <TaskAreaPage />
    ) : page === "skills" ? (
      <SkillsPage />
    ) : page === "plugins" ? (
      // 插件区：声明式能力包（plugin.json）的安装、启停与卸载
      <PluginsPage />
    ) : page === "memory" ? (
      // 记忆区：三层记忆 + 技能池（全部数据只在本机 localStorage）
      <MemoryPage />
    ) : page === "settings" ? (
      <SettingsPage />
    ) : (
      <InterfacesPage />
    );

  return (
    <div className="flex h-screen flex-col overflow-hidden border border-line bg-white">
      {/* 桌面壳自定义标题栏：浏览器端渲染 null，布局与原先一致（设计 §5） */}
      <TitleBar />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <NavRail onOpenSearch={onOpenSearch} onOpenShortcuts={onOpenShortcuts} />
        <main className="flex min-w-0 flex-1 flex-col">
          {/* 每个槽位各自 Suspense：只有当前页一块走占位，壳（标题栏/导航/目录栏）不动。
              启动动画挂着时页面 chunk 已在后台加载，揭开时通常已经就绪。 */}
          <Suspense fallback={<PageFallback />}>{view}</Suspense>
        </main>
        {/* 右侧工作目录：可拖动左边缘改宽度（手柄整条 6px 宽，好抓）。
            绑定按钮把本地文件绑到当前会话，通话/协作里点目录就能带上文件。 */}
        <aside className="relative flex shrink-0 flex-col border-l border-line-soft" style={{ width: asideWidth }}>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="调整目录栏宽度"
            onPointerDown={onResizeStart}
            className="absolute -left-1 top-0 z-20 h-full w-2 cursor-col-resize hover:bg-[#1a1a1a]/10"
          />
          <div className="flex items-center justify-between gap-1 border-b border-line-soft px-3 py-2">
            {/* d.62：表头用全站统一的 section 档（13/20/600），与导航轨 12px 内边距同节奏 */}
            <span className="ui-section-title shrink-0 whitespace-nowrap">共享文件</span>
            {usage && (
              <span className="ui-micro min-w-0 flex-1 truncate">
                {fmtBytes(usage.used)} / {fmtBytes(usage.quota)}
              </span>
            )}
            {/* 绑定：把本地文件绑进当前会话。没有会话时提示先开一个——不静默失败 */}
            <button
              type="button"
              aria-label="绑定本地文件到会话"
              title="绑定工作区文件到当前会话（需先打开一个会话）"
              onClick={() => {
                if (!useUiStore.getState().activeConversationId) {
                  window.alert("先打开一个会话，再绑定文件");
                  return;
                }
                void onUpload();
              }}
              className="shrink-0 rounded-md border border-line px-2 py-0.5 text-[11px] shadow-card hover:bg-[#fafafa]"
            >
              绑定
            </button>
            <button
              type="button"
              title="上传文件到共享文件"
              onClick={() => void onUpload()}
              className="shrink-0 rounded-md border border-line px-2 py-0.5 text-[11px] shadow-card hover:bg-[#fafafa]"
            >
              上传
            </button>
          </div>
          <div className="min-h-0 flex-1">
            <FileTree
              items={files}
              localPaths={[]}
              onPreview={setPreviewFile}
              onSendToConversation={(item) => {
                const { page, activeConversationId } = useUiStore.getState();
                if (page !== "chat" || !activeConversationId) {
                  window.alert("先打开一个会话，再从目录发送文件");
                  return;
                }
                useUiStore.getState().sendFileToConversation(activeConversationId, {
                  id: item.id,
                  name: item.name,
                  mime: item.mime,
                  size: item.size,
                });
              }}
            />
          </div>
          {previewFile && (
            <Suspense fallback={null}>
              <FilePreviewModal file={previewFile} onClose={() => setPreviewFile(null)} />
            </Suspense>
          )}
        </aside>
      </div>
      {/* 安装确认是全局的：从接口区发起，但用户可能立刻切页；
          挂在根节点上，pending 在第几页都能弹出来。 */}
      <Suspense fallback={null}>
        <RegistryInstallCard />
      </Suspense>
    </div>
  );
}
