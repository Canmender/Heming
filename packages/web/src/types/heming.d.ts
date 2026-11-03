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
     * 桌宠桥（d.46）：preload 暴露，只有桌面端存在。
     *
     * 桌宠窗口自己画 Live2D、自己直连本机 LLM，主进程只管「窗口在哪、
     * 要不要挡鼠标、显示还是隐藏」。这里刻意**没有**通用的 move/resize/setAlwaysOnTop，
     * 只给这一组语义明确的动作。
     */
    __heming_pet?: {
      /** 当前状态。 */
      state: () => Promise<{
        visible: boolean;
        scale: number;
        clickThrough: boolean;
        bounds: { x: number; y: number; width: number; height: number };
      }>;
      /** 缩放：`{dir:1}` 相对切档；数字为绝对档位。 */
      setScale: (payload: { dir: number } | number) => Promise<number>;
      /** 上报「光标此刻是否在可交互区」（仅在值变化时调用）。 */
      setInteractive: (value: boolean) => void;
      dragStart: () => void;
      dragMove: () => void;
      dragEnd: () => void;
      /** 回到默认落位（工作区右下角，按当前缩放档位重算）。 */
      resetPosition: () => void;
      show: () => void;
      hide: () => void;
      toggle: () => void;
      /** 鼠标穿透开关（设置区与托盘共用同一份状态）。 */
      setClickThrough: (value: boolean) => void;
      /** 重新加载桌宠页面（换模型后让新配置生效）。 */
      reload: () => void;
      /**
       * 请求主窗口上前台并切到指定页面（未配置模型连接时的出口）。
       * @param page 可选页面 id（settings/team/tasks/staff/infohub），不传 = 设置页。
       */
      openSettings: (page?: string) => void;
      /**
       * 订阅主进程推来的事件（桌宠窗口用）。
       * 契约见 `lib/petEvent.ts` 的 PetEventPayload。
       */
      onEvent: (cb: (payload: unknown) => void) => () => void;
      /** 主动发起一条推送（主窗口用；主进程校验来源后转发给桌宠）。 */
      emit: (payload: unknown) => void;
      /** 主窗口侧：订阅「桌宠要切换页面」。回调收到 page（可能为 undefined，表示设置页）。 */
      onOpenSettings: (cb: (page?: string) => void) => () => void;
    };
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
