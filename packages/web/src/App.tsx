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
import { ensureDesktopGateway } from "./lib/magpieHost.js";
import { useModuleStore, isModuleEffective } from "./lib/modules/store.js";
// d.128：内置模块的页面/后台循环由运行时注册表统一装配，App 不再直连模块实现。
import {
  ModuleBackgroundSlots,
  ModulePage,
  modulePageOf,
  useModuleBackgroundLoops,
} from "./lib/modules/runtime.js";
import { useAppPresence } from "./lib/appPresence.js";
import { startWidgetEvents } from "./lib/widgetEvents.js";
import { refreshWidgets } from "./lib/widgets/store.js";
import { startWidgetThemeSync } from "./lib/widgetTheme.js";
import { useLlmStore } from "./store/llm.js";
import { isPageAvailable } from "./lib/modules/nav.js";
import { usePluginPageEntries } from "./lib/pages/usePluginPages.js";
import { isPluginPagePage, pluginPageEntry } from "./lib/pages/registry.js";
import { PluginPageHost } from "./components/plugins/PluginPageHost.js";
import { hasOpenModal, useModalA11y } from "./components/useModalA11y.js";
import { SkeletonBlock, SkeletonLine } from "./components/ui/Skeleton.js";
import { useViewport } from "./lib/viewport.js";
import { NAV_HOTZONE_PX } from "./lib/navPrefs.js";

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
const ModelPage = lazy(() => import("./components/ModelPage.js").then((m) => ({ default: m.ModelPage })));
const PluginsPage = lazy(() =>
  import("./components/PluginsPage.js").then((m) => ({ default: m.PluginsPage })),
);
const MemoryPage = lazy(() => import("./components/MemoryPage.js").then((m) => ({ default: m.MemoryPage })));
// 知识库（d.114）：整个 knowledge 目录（含 CodeMirror 编辑器）只在进这页时才下载。
const KnowledgePage = lazy(() =>
  import("./components/knowledge/KnowledgePage.js").then((m) => ({ default: m.KnowledgePage })),
);
const SettingsPage = lazy(() =>
  import("./components/SettingsPage.js").then((m) => ({ default: m.SettingsPage })),
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
 * Alt+数字键目标页。导航固定 8 项，其中 6 个带数字键：
 * 1 主页、2 团队（承接原团队看板）、5 记忆、6 设置、8 智能体（承接原通用智能体）、
 * 0 插件。原先的 3 技能区 / 4 接口区没有承接页——两个页面都并进了插件页的 Tab，
 * 不给已有页凭空换号，让 3/4 空着比让人重新记「3 现在是什么」更省心。
 *
 * 这里的键位必须与 NavRail 的 `digit` 严格对应（那边是快捷键提示的唯一来源）。
 */
const SHORTCUT_PAGES: Partial<Record<string, Page>> = {
  "1": "home",
  "2": "team",
  "5": "memory",
  "6": "settings",
  "8": "chat",
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
 * 右侧「共享文件」面板内容（d.67 T4 从 AppShell 内联 jsx 提取）。
 *
 * 为什么提取：宽窗的可拖拽 aside 与窄窗的覆盖层抽屉**必须是同一份内容**
 * （表头/用量/绑定/上传/FileTree/预览模态）。复制一份等于以后两端行为慢慢分叉。
 * 本组件只管渲染，数据与回调仍由 AppShell 持有（数据加载、上传、预览状态都不搬）。
 */
interface SharedFilesPanelProps {
  files: SharedFileMeta[];
  usage: { used: number; quota: number } | null;
  previewFile: SharedFileMeta | null;
  /** 绑定到当前会话（无会话时由 AppShell 给提示，不静默失败）。 */
  onBind: () => void;
  onUpload: () => void;
  onPreview: (file: SharedFileMeta) => void;
  onClosePreview: () => void;
  onSendToConversation: (item: SharedFileMeta) => void;
  /** 抽屉模式才传：显示面板内的关闭按钮（宽窗 aside 不传，布局与改前一致）。 */
  onClose?: () => void;
}

function SharedFilesPanel({
  files,
  usage,
  previewFile,
  onBind,
  onUpload,
  onPreview,
  onClosePreview,
  onSendToConversation,
  onClose,
}: SharedFilesPanelProps) {
  return (
    <>
      {/* d.68：表头左内边距与文件树行对齐（FileTree 行是 px-2），表头标题不再比内容缩进一档 */}
      <div className="flex items-center justify-between gap-1 border-b border-line-soft px-2 py-2">
        {/* d.62：表头用全站统一的 section 档（13/20/600） */}
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
          onClick={onBind}
          className="shrink-0 rounded-md border border-line px-2 py-0.5 text-[11px] shadow-card hover:bg-[#fafafa]"
        >
          绑定
        </button>
        <button
          type="button"
          title="上传文件到共享文件"
          onClick={onUpload}
          className="shrink-0 rounded-md border border-line px-2 py-0.5 text-[11px] shadow-card hover:bg-[#fafafa]"
        >
          上传
        </button>
        {onClose ? (
          <button
            type="button"
            aria-label="关闭共享文件面板"
            onClick={onClose}
            className="shrink-0 rounded-md border border-line px-2 py-0.5 text-[11px] shadow-card hover:bg-[#fafafa]"
          >
            关闭
          </button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1">
        <FileTree
          items={files}
          localPaths={[]}
          onPreview={onPreview}
          onSendToConversation={onSendToConversation}
        />
      </div>
      {previewFile && (
        <Suspense fallback={null}>
          <FilePreviewModal file={previewFile} onClose={onClosePreview} />
        </Suspense>
      )}
    </>
  );
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

  /** 绑定：把本地文件绑进当前会话。没有会话时提示先开一个——不静默失败（行为同提取前）。 */
  const onBindFile = () => {
    if (!useUiStore.getState().activeConversationId) {
      window.alert("先打开一个会话，再绑定文件");
      return;
    }
    void onUpload();
  };

  /** 目录文件名 → 发到当前会话（非会话页/无会话时提示，行为同提取前）。 */
  const onSendFileToConversation = (item: SharedFileMeta) => {
    const { page: currentPage, activeConversationId } = useUiStore.getState();
    if (currentPage !== "chat" || !activeConversationId) {
      window.alert("先打开一个会话，再从目录发送文件");
      return;
    }
    useUiStore.getState().sendFileToConversation(activeConversationId, {
      id: item.id,
      name: item.name,
      mime: item.mime,
      size: item.size,
    });
  };

  /*
   * d.67 T4 · 窄窗（<1200）响应式：
   * 宽窗完全保持原样（可拖拽 aside、宽度记忆、最小/最大、拖动手柄 aria 都不动）；
   * 窄窗默认不渲染 aside 列，改由顶部「共享文件」按钮打开覆盖层抽屉（同一份面板内容）。
   * 断点只在 viewport.ts 定义一次，这里不写死 1200。
   */
  const { narrow } = useViewport();
  const [filesDrawerOpen, setFilesDrawerOpen] = useState(false);
  const filesDrawerRef = useRef<HTMLElement | null>(null);
  const closeFilesDrawer = useCallback(() => setFilesDrawerOpen(false), []);
  // 抽屉是模态：Esc 关闭、Tab 在面板内循环、背景 inert、关闭后焦点回到触发按钮。
  useModalA11y(filesDrawerRef, closeFilesDrawer, { active: narrow && filesDrawerOpen });
  // 拖宽到 ≥1200 时自动收起：宽窗有常驻 aside，不能同时压一层遮罩。
  useEffect(() => {
    if (!narrow) setFilesDrawerOpen(false);
  }, [narrow]);

  const page = useUiStore((s) => s.page);
  const setPage = useUiStore((s) => s.setPage);
  // 内置能力模块的安装/启用状态。页面可用性、后台循环与跨页跳转都读这一份。
  const moduleEnabled = useModuleStore((s) => s.enabled);
  const moduleInstalled = useModuleStore((s) => s.installed);
  const moduleState = { installed: moduleInstalled, enabled: moduleEnabled };
  /** auto 模式下给左缘热区留一条 8px 空档，避免热区盖住内容最左侧的可点元素（列表整行按钮等）。 */
  const navMode = useUiStore((s) => s.navMode);

  // 本机自动化 / 工作流调度 / 常驻幕僚：实现收在 lib/modules/runtime，App 只按生效状态统一挂载。
  useModuleBackgroundLoops(Boolean(authUser), moduleState);

  // d.115：信息中枢模块生效 = 自动拉起本机边车（不依赖页面挂载），并自动识别、
  // 空库时采集一次；模块停用 = 运行时一起下线（不删任何归档数据）。
  const infohubModuleOn = isModuleEffective(moduleState, "infohub");
  useEffect(() => {
    if (!infohubModuleOn) {
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
  }, [infohubModuleOn]);

  // 系统通知点击 → 主进程回传会话 id → 打开会话（未登录时忽略，登录后再点即可）
  useEffect(() => {
    const bridge = typeof window !== "undefined" ? window.__heming_notify : undefined;
    if (!bridge?.onOpen) return;
    return bridge.onOpen((id) => {
      if (!id || !useAuthStore.getState().user) return;
      useUiStore.getState().openConversation(id);
    });
  }, []);

  // 模块页被停用/未安装（或被通知/桌宠/旧链接指到）时统一回主页，不渲染不该存在的页面。
  // 模型路由页已删除：旧存储/旧链接里的 `modelroute` 同样回落主页。
  // d.124：插件页面同一条纪律——入口不在注册表里、或已停用/卸载，一律回主页。
  const pluginPageEntries = usePluginPageEntries();
  const resolvedPage: Page = page === "modelroute" ? "home" : page;
  const pluginPageAvailable =
    !isPluginPagePage(resolvedPage) || pluginPageEntry(pluginPageEntries, resolvedPage)?.available === true;
  // 内置模块页（幕僚/信息中枢/自动化/工作流）统一走 ModulePage；迁移到插件后只换 runtime 条目。
  const modulePage = modulePageOf(resolvedPage);
  const currentPage: Page =
    isPageAvailable(resolvedPage, moduleState) && pluginPageAvailable ? resolvedPage : "home";
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
      const moduleOn = (id: "staff" | "infohub") =>
        isModuleEffective(useModuleStore.getState(), id);
      if (page === "settings") {
        // widget 的「打开设置」与托盘「设置」项都该落到外观页的小组件卡（不是个人资料）
        ui.openSettings(request.settingsTab ?? "appearance");
      } else if (page === "team") ui.setPage("team");
      else if (page === "tasks") ui.setPage("tasks");
      // 模块未安装/停用时落在插件页（能一键安装/启用），而不是静默跳到一个不存在的页面
      else if (page === "staff") {
        if (moduleOn("staff")) ui.openStaff();
        else ui.openModuleManager();
      } else if (page === "infohub") {
        if (moduleOn("infohub")) ui.openInfohub();
        else ui.openModuleManager();
      }
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
          // 智能体名册（chat store）按需加载：它牵 api/ws 一整条链，没必要为首屏付钱。
          // llm store 走静态导入——staff loop 等壳内模块已经静态引用它，动态导入不会分包。
          const { useChatStore } = await import("./store/chat.js");
          if (useChatStore.getState().agentsRoster.length === 0) {
            try {
              await useChatStore.getState().loadAgentsRoster();
            } catch {
              /* 名册拉不到就给空列表：widget 侧会回落到「没有可用智能体」 */
            }
          }
          const llm = useLlmStore.getState();
          const prompts = llm.prompts;
          const agents = useChatStore.getState().agentsRoster.map((agent) => {
            const prompt = prompts[agent.id]?.trim();
            return { id: agent.id, name: agent.name, ...(prompt ? { prompt } : {}) };
          });
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
      if (e.metaKey || e.ctrlKey) {
        // Ctrl/⌘+B：切换导航显隐（d.68）——
        // pinned 下切到 auto（导航收起、主内容变宽）；auto 下呼出/收回左缘浮层。
        // 输入框内不响应：浏览器里 Ctrl+B 是「加粗」，用户可能真在编辑文本。
        // 有模态弹窗时只吞键不动导航：与 Alt+N、Ctrl+K 同一套纪律。
        if (!e.altKey && !e.shiftKey && e.key.toLowerCase() === "b") {
          if (inText) return;
          e.preventDefault();
          if (hasOpenModal()) return;
          useUiStore.getState().toggleNav();
          return;
        }
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
        {/* 模块包后台循环槽位（d.131）：幕僚等模块迁出后由模块 entry 提供，未加载时回退内置。 */}
        <ModuleBackgroundSlots authUser={Boolean(authUser)} moduleState={moduleState} />
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
    currentPage === "home" ? (
      <HomePage />
    ) : currentPage === "team" ? (
      // 团队：真实成员名册 + 动向流（任务 / 日程摘要）；d.67 起承接「看板」视图
      <TeamPage />
    ) : currentPage === "chat" ? (
      // 智能体（本机运行）：左侧智能体名册 + 右侧对话；d.67 起承接「任务」视图
      <AssistantPage />
    ) : modulePage ? (
      // 内置模块页：幕僚 / 信息中枢 / 自动化 / 工作流（实现见 lib/modules/runtime.tsx）
      <ModulePage moduleId={modulePage} />
    ) : currentPage === "model" ? (
      // 模型页：内核管理面——供应商/订阅账号/分组/用量/备份/同步
      <ModelPage />
    ) : currentPage === "vault" ? (
      // 知识库（d.114）：本地 vault 三栏界面（文件树 / 编辑器 / 反链标签图谱），数据不出设备
      <KnowledgePage />
    ) : currentPage === "plugins" ? (
      // 插件区（能力中心）：插件包 + 技能池 + 工具 + MCP 服务，四个 Tab
      <PluginsPage />
    ) : currentPage === "memory" ? (
      // 记忆区：三层记忆 + 技能池（全部数据只在本机 localStorage）
      <MemoryPage />
    ) : isPluginPagePage(currentPage) ? (
      // 插件页面（d.124）：入口来自已装插件的页面贡献，渲染路径由来源决定
      // （声明式 = 宿主按 blocks 渲染；界面插件 = 主进程 widget:// 沙箱视图）
      <PluginPageHost page={currentPage} />
    ) : (
      <SettingsPage />
    );

  /**
   * 共享文件面板只在智能体页出现（用户要求：文件管理只留在智能体对话页）。
   * 其它页面不再常驻右栏，主内容获得完整宽度；窄窗入口也只在智能体页显示。
   */
  const showFilesPanel = currentPage === "chat";

  return (
    <div className="flex h-screen flex-col overflow-hidden border border-line bg-white">
      {/* 桌面壳自定义标题栏：浏览器端渲染 null，布局与原先一致（设计 §5） */}
      <TitleBar />
      {/* relative 是导航轨 auto 模式的定位基准：浮层用 absolute 贴在本行内，
          既不占布局宽度，也不会盖住上面的自定义标题栏。
          paddingLeft 只在 auto 下出现：热区是 8px，这一条空档保证热区不压到内容最左侧
          （助手页/团队页的列表行是整行按钮，左边缘就是可点区）。 */}
      <div
        className="relative flex min-h-0 flex-1 overflow-hidden"
        style={navMode === "auto" ? { paddingLeft: NAV_HOTZONE_PX } : undefined}
      >
        <NavRail onOpenSearch={onOpenSearch} onOpenShortcuts={onOpenShortcuts} />
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {/* 窄窗顶部工具区（d.67 T4）：右侧共享文件栏默认不渲染，入口收在这里。
              宽窗（≥1200）不渲染这条工具区，主内容高度与改前完全一致。 */}
          {narrow && showFilesPanel && (
            <div className="flex shrink-0 items-center justify-end border-b border-line-soft px-4 py-1.5">
              <button
                type="button"
                aria-label="打开共享文件"
                aria-haspopup="dialog"
                aria-expanded={filesDrawerOpen}
                onClick={() => setFilesDrawerOpen(true)}
                className="rounded-md border border-line px-2.5 py-1 text-[12px] shadow-card hover:bg-[#fafafa]"
              >
                共享文件
              </button>
            </div>
          )}
          {/* min-w-0 + overflow-hidden：窄窗下宽页面（settings/team/workspace/memory）不横向撑破主列 */}
          <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
            {/* 每个槽位各自 Suspense：只有当前页一块走占位，壳（标题栏/导航/目录栏）不动。
                启动动画挂着时页面 chunk 已在后台加载，揭开时通常已经就绪。 */}
            <Suspense fallback={<PageFallback />}>{view}</Suspense>
          </div>
        </main>
        {/* 宽窗：右侧工作目录可拖动左边缘改宽度（手柄整条 6px 宽，好抓）。
            绑定按钮把本地文件绑到当前会话，通话/协作里点目录就能带上文件。
            窄窗不渲染这一列（内容改由顶部按钮 + 覆盖层抽屉承载，见下方）。 */}
        {!narrow && showFilesPanel && (
          <aside
            aria-label="共享文件"
            className="relative flex shrink-0 flex-col border-l border-line-soft"
            style={{ width: asideWidth }}
          >
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="调整目录栏宽度"
              onPointerDown={onResizeStart}
              className="absolute -left-1 top-0 z-20 h-full w-2 cursor-col-resize hover:bg-[#1a1a1a]/10"
            />
            <SharedFilesPanel
              files={files}
              usage={usage}
              previewFile={previewFile}
              onBind={onBindFile}
              onUpload={() => void onUpload()}
              onPreview={setPreviewFile}
              onClosePreview={() => setPreviewFile(null)}
              onSendToConversation={onSendFileToConversation}
            />
          </aside>
        )}
      </div>
      {/* 窄窗共享文件抽屉：覆盖层 + aria-modal；Esc/焦点归还/背景 inert 由 useModalA11y 统一托管。 */}
      {narrow && showFilesPanel && filesDrawerOpen && (
        <div className="fixed inset-0 z-40 flex justify-end" data-testid="shared-files-drawer-overlay">
          <button
            type="button"
            aria-label="关闭共享文件遮罩"
            data-testid="shared-files-backdrop"
            onClick={closeFilesDrawer}
            className="absolute inset-0 cursor-default bg-black/30"
          />
          <aside
            id="shared-files-drawer"
            ref={filesDrawerRef}
            role="dialog"
            aria-modal="true"
            aria-label="共享文件"
            className="relative flex h-full w-[min(360px,90vw)] flex-col border-l border-line-soft bg-white shadow-xl"
          >
            <SharedFilesPanel
              files={files}
              usage={usage}
              previewFile={previewFile}
              onBind={onBindFile}
              onUpload={() => void onUpload()}
              onPreview={setPreviewFile}
              onClosePreview={() => setPreviewFile(null)}
              onSendToConversation={onSendFileToConversation}
              onClose={closeFilesDrawer}
            />
          </aside>
        </div>
      )}
      {/* 安装确认是全局的：从接口区发起，但用户可能立刻切页；
          挂在根节点上，pending 在第几页都能弹出来。 */}
      <Suspense fallback={null}>
        <RegistryInstallCard />
      </Suspense>
    </div>
  );
}
