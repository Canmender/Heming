import type { WidgetsBridge } from "./widgets.js";

/**
 * 桌面端 preload（packages/desktop/preload.js）通过 contextBridge 暴露在
 * `window.heming` 上的桥接 API。只有 Electron 里存在；浏览器直接打开时是 undefined，
 * 调用方必须按可选处理（BootWave 即靠此区分「有主进程信号」与「无信号兜底」）。
 */
declare global {
  /** 自动更新状态（主进程 → 渲染层）。 */
  interface UpdateState {
    /** idle / checking / up-to-date / available / downloading / downloaded / error */
    status: "idle" | "checking" | "up-to-date" | "available" | "downloading" | "downloaded" | "error";
    /** 本机当前 5 段版本。 */
    currentVersion: string;
    /** 待更新的版本；无更新时为 null。 */
    available: { version: string; path?: string; sha512?: string } | null;
    /** 上次检查时间戳（毫秒）；从未检查为 null。 */
    lastCheckedAt: number | null;
    /** 最近一次错误信息；无错误为 null。 */
    lastError: string | null;
    /** 是否允许下载（打包后为 true，开发态为 false）。 */
    canDownload: boolean;
    /**
     * 下载进度（仅 downloading 阶段有值，其余为 null）。
     * percent 已由主进程夹紧到 0–100；字节数用于展示「已下载/总量」。
     */
    progress: {
      percent: number;
      transferred: number;
      total: number;
      bytesPerSecond: number;
    } | null;
  }

  interface Window {
    /** 内部：桌面端 5 段版本号（preload 暴露；浏览器里 undefined）。 */
    __heming_version?: string;
    /**
     * 内部：自动更新桥（preload 暴露）。
     *
     * 只有**安装版**存在——开发态主进程不初始化更新器，
     * 所以调用方要按可选处理，且界面必须能在拿不到它时正常显示。
     */
    __heming_update?: {
      /** 主动检查一次，返回最新状态。 */
      check: () => Promise<UpdateState>;
      /** 下载已发现的更新，返回最新状态。 */
      download: () => Promise<UpdateState>;
      /** 退出并安装；仅在状态为 downloaded 时有效。 */
      install: () => Promise<boolean>;
      /** 读当前状态，不触发检查。 */
      state: () => Promise<UpdateState>;
      /** 订阅状态变化，返回取消订阅函数。 */
      subscribe: (callback: (state: UpdateState) => void) => () => void;
    };
    /** 内部：桌面端 MCP stdio 桥（preload 暴露；浏览器里 undefined）。 */
    __mcp_stdio?: {
      request: (
        serverId: string,
        config: { command: string; args?: string[] },
        method: string,
        params?: unknown,
      ) => Promise<unknown>;
      stop: (serverId: string) => Promise<boolean>;
    };
    /**
     * 内部：桌面端导出文件桥（preload 暴露；浏览器里 undefined）。
     *
     * 有它时 `saveExportFile` 写到 `~/Heming/exports`；没有则回退 Blob 下载。
     * 写失败也会以 `{ ok:false, error }` 返回（IPC 边界不抛）。
     */
    __heming_exports?: {
      write: (
        fileName: string,
        content: string,
      ) => Promise<{ ok: boolean; path?: string; name?: string; error?: string }>;
      info: () => Promise<{ dir: string; exists: boolean }>;
    };
    /**
     * 内部：桌面端本机密钥信封桥（preload 暴露；浏览器里 undefined）。
     *
     * d.58 起是「异步优先 + 启动预取缓存 + 旧同步 API 兜底」：
     * - `mode` / `asyncAvailable` / `ready` 描述当前 Electron 的能力与预取状态；
     * - `cachedRead` / `cacheSet` / `cacheDelete` 是同步缓存（三个白名单低频键），
     *   `bootstrap` 是启动预取的批量通道（主进程侧也是同一份白名单）；
     * - `availableAsync` / `encryptAsync` / `decryptAsync` 是首选路径；
     * - `available` / `encrypt` / `decrypt` 是**已弃用**的同步兜底（Electron 46 起失效）。
     *
     * 同步 API 只给三个低频键用（模型 Key / MCP 请求头 / E2E 身份），
     * 不要用在消息收发热路径上。
     */
    __heming_secrets?: {
      /** 加解密口径：`"async"`（首选）/ `"sync"`（旧版兜底）/ `null`（不可用）。 */
      mode?: "async" | "sync" | null;
      /** 异步三件套是否可用。 */
      asyncAvailable?: boolean;
      /** 系统安全存储是否可用（同步探测）。 */
      available: boolean;
      /** 启动预取完成信号（永不 reject）。 */
      ready?: Promise<{ available: boolean; mode?: string | null; hydrated: boolean }>;
      /** 同步读预取缓存：命中返回明文（解不开为 null），未命中 undefined。 */
      cachedRead?: (key: string) => string | null | undefined;
      /** 写盘后刷新缓存。 */
      cacheSet?: (key: string, plain: string) => void;
      /** 其它窗口改值后失效缓存。 */
      cacheDelete?: (key: string) => void;
      /** 批量解密（白名单三键）。 */
      bootstrap?: (payload: {
        entries: Array<{ key: string; data: string }>;
      }) => Promise<{
        available: boolean;
        mode?: string | null;
        plaintexts: Array<{ key: string; value: string | null }>;
      }>;
      availableAsync?: () => Promise<boolean>;
      encryptAsync?: (plain: string) => Promise<string | null>;
      decryptAsync?: (cipherB64: string) => Promise<string | null>;
      /** @deprecated Electron 45 弃用、46 移除；仅作兜底。 */
      encrypt: (plain: string) => string | null;
      /** @deprecated 同上。 */
      decrypt: (cipherB64: string) => string | null;
    };
    /** 内部：桌面端系统通知桥（preload 暴露；浏览器里 undefined）。 */
    __heming_notify?: {
      message: (payload: { title: string; body: string; conversationId?: string }) => void;
      onOpen: (cb: (conversationId: string | null) => void) => () => void;
    };
    /**
     * 内部：桌面端 InfoHub 本机桥（preload 暴露；浏览器里 undefined）。
     *
     * 归档数据只在本机：主进程用 stdio 拉起 Python 子进程，不开端口、不走网络。
     * 浏览器端没有它，信息中枢页必须显示「仅桌面端可用」而不是回退到云端。
     */
    __heming_infohub?: {
      info: () => Promise<{
        packageDir: string;
        defaultHome: string;
        bundledPython: string | null;
        running: boolean;
        pid: number | null;
        home: string | null;
        python: string | null;
        pythonSource: string | null;
        startedAt: number;
        methods: string[];
        hello?: { app: string; version: string; protocol: number } | null;
      }>;
      start: (config?: { home?: string; python?: string }) => Promise<unknown>;
      call: (
        method: string,
        params?: Record<string, unknown>,
        config?: { home?: string; python?: string },
      ) => Promise<unknown>;
      stop: () => Promise<boolean>;
      pickHome: () => Promise<string | null>;
      pickPython: () => Promise<string | null>;
      onEvent: (cb: (event: unknown) => void) => () => void;
    };
    /**
     * 界面插件桥（d.94）：preload 暴露，只有桌面端**主窗**存在。
     *
     * 桌宠已从本体拆成界面插件（`heming.pet`），宿主只提供这组通道：
     * 列出/安装/启停/卸载、窗口通用动作与设置表单读写、脱敏事件转发。
     * 契约（字段/通道/返回形状）见 `src/types/widgets.ts` 与规格 §4.2.1；
     * 浏览器里没有它，插件区「桌面小组件」必须显示「仅桌面端可用」。
     */
    __heming_widgets?: WidgetsBridge;
    heming?: {
      /** 运行平台（process.platform），如 "win32" / "darwin"。 */
      platform?: string;
      /**
       * 内部：web 端注册启动动画回调。preload 侧会缓冲信号——若主进程信号已发过，
       * 注册即立刻回调（避免 did-finish-load 早于 React 挂载时丢信号）。
       */
      __onBootReady?: (cb: () => void) => void;
      /** 内部：主进程 did-finish-load 后调用；web 端不主动调用。 */
      __startBootWave?: () => void;
    };
  }
}

export {};
