import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useUiStore, type Page } from "./store/ui.js";
import { initTheme } from "./store/theme.js";
import { useAuthStore } from "./store/auth.js";
import { getToken, fetchFiles, fetchFileUsage, uploadFile } from "./lib/api.js";
import type { SharedFileMeta } from "@heming/shared";
import { LoginPage } from "./components/LoginPage.js";
import { NavRail } from "./components/NavRail.js";
import { FileTree } from "./components/FileTree.js";
import { FilePreviewModal } from "./components/FilePreviewModal.js";
import { WorkspacePage } from "./components/WorkspacePage.js";
import { TaskAreaPage } from "./components/TaskAreaPage.js";
import { ChatPage } from "./components/ChatPage.js";
import { ConversationTabs } from "./components/ConversationTabs.js";
import { ChatConvStrip } from "./components/ChatConvStrip.js";
import { RadarContacts } from "./components/RadarContacts.js";
import { HomePage } from "./components/HomePage.js";
import { ConversationsPage } from "./components/ConversationsPage.js";
import { InfohubPage } from "./components/InfohubPage.js";
import { AutomationPage } from "./components/AutomationPage.js";
import { StaffPage } from "./components/StaffPage.js";
import { SettingsPage } from "./components/SettingsPage.js";
import { MemoryPage } from "./components/MemoryPage.js";
import { ArchivePage } from "./components/ArchivePage.js";
import { CommandPalette } from "./components/CommandPalette.js";
import { InterfacesPage } from "./components/InterfacesPage.js";
import { RegistryInstallCard } from "./components/RegistryInstallCard.js";
import { SkillsPage } from "./components/SkillsPage.js";
import { PluginsPage } from "./components/PluginsPage.js";
import { TitleBar } from "./components/TitleBar.js";
import { BootWave } from "./components/BootWave.js";
import { autoConnectAll } from "./lib/mcp/runtime.js";
import { useInfohubStore } from "./lib/infohub/store.js";
import { useAutomationScheduler } from "./lib/automation/scheduler.js";
import { useStaffLoop } from "./lib/staff/loop.js";
import { hasOpenModal } from "./components/useModalA11y.js";
import { useBackgroundMessages } from "./lib/backgroundMessages.js";
import {
  chatSocketCount,
  chatSocketVersion,
  subscribeChatSocket,
} from "./lib/chatSocketPresence.js";

/**
 * Alt+1–Alt+9、Alt+0 目标页：1 主页、2 工作区、3 技能区、4 接口区、5 记忆区、6 设置区、7 归档、8 任务区、9 会话、0 插件区。
 *
 * 顺序必须与 NavRail 的 `digit` 严格对应——那边是快捷键提示的唯一来源，
 * 两边错位就会出现「界面写着 Alt+6、按下去却去了别的页」。
 * 新页追加到**末尾**：改动老页的序号等于换掉用户肌肉记忆里的快捷键。
 */
const SHORTCUT_PAGES: Page[] = [
  "home",
  "workspace",
  "skills",
  "interfaces",
  "memory",
  "settings",
  "archive",
  "tasks",
  "conversations",
  "plugins",
];

/** 快捷键数字 → SHORTCUT_PAGES 下标（`0` 对应第 10 项）。 */
const SHORTCUT_DIGITS = "1234567890";

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

export function App() {
  // 首帧之前就把主题色写进 CSS 变量，避免刷新时闪回默认墨色
  initTheme();

  const [bootDone, setBootDone] = useState(false);
  const handleBootDone = useCallback(() => setBootDone(true), []);
  const shellRef = useRef<HTMLDivElement>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);

  // 本机归档：只探测桥与运行态，不自动拉起 Python（拉起必须由用户点「连接」）。
  useEffect(() => {
    void useInfohubStore.getState().boot();
  }, []);

  // 全局搜索：Ctrl/⌘+K。启动动画期间不响应（与 Alt+N 同一套纪律：
  // 遮罩后面看不见的界面不该接受输入）。模态弹窗开着时同样不响应：面板与弹窗
  // 在 DOM 里不是嵌套关系，面板的屏蔽会把弹窗一起 inert 掉，Esc 归属随之错位。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!bootDone) return;
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (hasOpenModal()) return;
        setPaletteOpen((v) => !v);
      }
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
        <AppShell onOpenSearch={() => setPaletteOpen(true)} />
      </div>
      {!bootDone && <BootWave onDone={handleBootDone} writeFirst={!HAS_NATIVE_SPLASH} />}
      {/* 全局加一层除了命令面板之外的空壳：面板自己带着遮罩，不需要外层容器 */}
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
    </>
  );
}

/** 登录页/主界面内容：与启动动画并行挂载（动画仅作遮罩），不做时序门禁。 */
function AppShell({ onOpenSearch }: { onOpenSearch: () => void }) {
  const authStatus = useAuthStore((s) => s.status);
  const authUser = useAuthStore((s) => s.user);
  const restore = useAuthStore((s) => s.restore);

  useEffect(() => {
    void restore();
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

  // 没有 ChatPage 实例时由 App 壳保持一条后台连接：离开聊天页也能收到未读与提醒。
  // 是否「有 ChatPage」按实例注册判断（任务区会嵌入一个 ChatPage，页面名判断不了）；
  // useSyncExternalStore 让 ChatPage 挂载/卸载立刻触发本组件重算 active。
  useSyncExternalStore(subscribeChatSocket, chatSocketVersion, () => 0);
  useBackgroundMessages(Boolean(authUser) && chatSocketCount() === 0);
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
      // Alt+1–9 / Alt+0 直接切页（不用 ⌘/Ctrl，避开浏览器/输入法组合键冲突）；输入框内不响应
      if (e.altKey && !e.metaKey && !e.ctrlKey && SHORTCUT_DIGITS.includes(e.key)) {
        if (inText) return;
        e.preventDefault();
        // 模态弹窗开着时只吞键不切页：切走的子树里还留着那个弹窗，
        // 焦点归还、Esc 归属与 inert 计数全落在已经不属于当前视图的 DOM 上。
        if (hasOpenModal()) return;
        setPage(SHORTCUT_PAGES[SHORTCUT_DIGITS.indexOf(e.key)]);
        return;
      }
      if (!e.metaKey && !e.ctrlKey) return;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [authUser, setPage]);

  if (!authUser) {
    return (
      <div className="flex h-screen flex-col overflow-hidden">
        {/* 桌面壳自定义标题栏：浏览器端渲染 null，布局与原先一致（设计 §5） */}
        <TitleBar />
        <div className="flex min-h-0 flex-1">
          {authStatus === "pending" && getToken() ? (
            <div className="flex h-full w-full items-center justify-center text-muted">
              加载中…
            </div>
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
    ) : page === "chat" ? (
      // 会话态：ChatPage 常驻底层（保持 WS/草稿状态）；雷达覆盖层按 contactsHidden
      // 滑出/呼出（面板自身管理 transform，隐藏时平移出容器并由 overflow 裁切）。
      // 行布局：左侧头像缩略列（快速切会话） → 中间列（上方横向标签页 + ChatPage）
      <div className="relative flex h-full min-h-0 w-full overflow-hidden">
        <div className="flex min-w-0 flex-1">
          <ChatConvStrip />
          <div className="flex min-w-0 flex-1 flex-col">
            <ConversationTabs />
            <div className="relative min-h-0 flex-1">
              <div className="absolute inset-0 flex flex-col">
                <ChatPage />
              </div>
              <RadarContacts overlay />
            </div>
          </div>
        </div>
      </div>
    ) : page === "workspace" ? (
      <WorkspacePage />
    ) : page === "conversations" ? (
      // 会话中心：全部未归档会话的一站式列表（置顶/搜索/归档入口）
      <ConversationsPage />
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
      // 任务区：左侧任务列表 + 嵌入式 ChatPage + 右侧确定性汇总
      <TaskAreaPage />
    ) : page === "skills" ? (
      <SkillsPage />
    ) : page === "plugins" ? (
      // 插件区：声明式能力包（plugin.json）的安装、启停与卸载
      <PluginsPage />
    ) : page === "memory" ? (
      // 记忆区：三层记忆 + 技能池（全部数据只在本机 localStorage）
      <MemoryPage />
    ) : page === "archive" ? (
      // 归档处：收起来的历史会话，可按名字检索后恢复
      <ArchivePage />
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
        <NavRail onOpenSearch={onOpenSearch} />
        <main className="flex min-w-0 flex-1 flex-col">{view}</main>
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
            <span className="shrink-0 text-[11px] font-bold uppercase tracking-wider text-muted">目录</span>
            {usage && (
              <span className="min-w-0 flex-1 truncate text-[10px] text-muted">
                {fmtBytes(usage.used)} / {fmtBytes(usage.quota)}
              </span>
            )}
            {/* 绑定：把本地文件绑进当前会话。没有会话时提示先开一个——不静默失败 */}
            <button
              type="button"
              aria-label="绑定本地文件到会话"
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
            <FilePreviewModal file={previewFile} onClose={() => setPreviewFile(null)} />
          )}
        </aside>
      </div>
      {/* 安装确认是全局的：从接口区发起，但用户可能立刻切页；
          挂在根节点上，pending 在第几页都能弹出来。 */}
      <RegistryInstallCard />
    </div>
  );
}
