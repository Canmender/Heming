/**
 * 界面插件（`distribution: "bundle"`）窗口桥的类型契约。
 *
 * 唯一事实来源：
 * - `packages/desktop/widget-preload.js`：宿主注入到插件窗口的 `window.__heming_widget`
 *   （方法清单、同步/异步口径、参数与返回形状都照它）；
 * - `packages/desktop/plugin-host.js`：`widget:*` 通道的参数校验、拒绝兜底与推送载荷；
 * - `packages/desktop/plugin-window.js`：`openPage` 白名单、缩放档位等几何语义。
 *
 * 本文件只有类型与一份方法名清单，没有运行时代码：
 * - 不 import electron / node，web / server / 脚本都能安全引用；
 * - 不声明 secrets / MCP / 文件 / 会话 / 记忆等任何桥——界面插件在结构上就拿不到它们。
 *
 * 同步 / 异步口径（与 preload 一一对应）：
 * - `ipcRenderer.send` 的方法返回 `void`：单向发送，不保证主进程已处理，也没有失败回执；
 * - `ipcRenderer.invoke` 的方法返回 `Promise`：拿主进程返回值，失败时 reject；
 * - `onX(cb)` 返回取消订阅函数 `() => void`，重复调用安全。
 *
 * 关于「拒绝兜底」：每个 `widget:*` 通道都由主进程按
 * `BrowserWindow.fromWebContents(event.sender)` 反查「是不是这个 widget 自己的窗口」，
 * 查不到时按通道给 `null` / `false` / `{}` / `[]` 兜底（fail-closed）。合法插件窗口里
 * 反查一定成功，因此本文件的返回类型按**成功载荷**声明，不把兜底并进每个返回，
 * 避免调用方到处判空；只有 `data*` 里本来就属于业务语义的 `null` / `false` 才写进类型。
 */

/** 宿主注入到界面插件窗口的全局对象名。 */
export const WIDGET_API_GLOBAL = "__heming_widget" as const;

/** 宿主主题（`info().theme` 与 `onEvent({ kind: "theme" })` 共用）。 */
export type WidgetTheme = "light" | "dark";

/**
 * `openPage()` 可跳转的主窗页面白名单（**唯一真源**）。
 *
 * 主进程侧有两份副本：`packages/desktop/plugin-window.js` 的 `WIDGET_PAGE_ALLOWLIST`
 * 与 `main.js` 的 `widget:open-page` 校验数组；它们由
 * `packages/desktop/widget-pages.test.js` 与本常量逐项比对（多一个/少一个都红），
 * 所以加页面时**只改这里 + 两处副本**，别让三份名单各自漂移。
 * 白名单外的值被静默丢弃并记一条宿主日志，不会抛错。
 */
export const WIDGET_ALLOWED_PAGES = ["settings", "team", "tasks", "staff", "infohub"] as const;

/** 可跳转的页面 id（由白名单派生，避免类型与运行期名单分叉）。 */
export type WidgetPage = (typeof WIDGET_ALLOWED_PAGES)[number];

/**
 * 窗口运行态（`state()` / `show()` 的返回，对应 `plugin-host.js` 的 `statePayload()`）。
 *
 * 由主进程持有并持久化（`state.json`）：插件只能读，改状态要通过下面各窗口方法。
 */
export interface WidgetState {
  /** 窗口当前是否显示；宿主重启后被隐藏的窗口不会自动弹出。 */
  visible: boolean;
  /** 当前缩放档位：取值为清单 `scales[]` 里的某一档，不是自由缩放。 */
  scale: number;
  /** 用户当前是否开启鼠标穿透（只有清单 `clickThrough: "auto"` 的 widget 可能为 true）。 */
  clickThrough: boolean;
}

/** `info()` 载荷（`widget:info`）。 */
export interface WidgetHostInfo {
  /** 插件 id（清单 `id`，如 `heming.pet`）。 */
  pluginId: string;
  /** 插件显示名（清单 `name`；记录缺失时回落为 id）。 */
  pluginName: string;
  /** 宿主（和鸣）版本号，如 `d.119.3.47.0`；仅供展示/日志，不要拿它做能力判断。 */
  appVersion: string;
  /** 宿主当前主题（主窗与小组件共用一份选择）。 */
  theme: WidgetTheme;
}

/** `chatConfig().gateway`：本机 magpie 反代信息。 */
export interface WidgetChatGateway {
  /**
   * 反代地址（如 `http://127.0.0.1:54321/v1`）。
   * 宿主没起来或解析失败时为 `null`，此时按「未配置」处理，不要假装能聊。
   */
  baseUrl: string | null;
  /** 网关 Key：宿主当前恒给本机默认值（`"local"`），**不是**用户供应商 Key。 */
  key: string;
}

/**
 * `chatConfig().agents[]` 的一项。
 *
 * 审计 P0-1：宿主**不下发 `prompt`**（智能体人设提示词不出主进程），只有 id/name。
 */
export interface WidgetChatAgent {
  /** 智能体 id。 */
  id: string;
  /** 智能体显示名（缺失时回落为 id）。 */
  name: string;
}

/** `chatConfig().binding`：本插件当前绑定的智能体（来自本插件设置 `settings.agentId`）。 */
export interface WidgetChatBinding {
  /** 绑定到的智能体 id；未绑定为 `null`。 */
  agentId: string | null;
}

/**
 * 对话上下文（`chatConfig()`，`widget:chat-config`）。
 *
 * 权限门禁：只有清单声明 `permissions.chat: true` 的界面插件才拿得到网关与智能体；
 * 未声明时宿主返回 `gateway: null`、`agents: []`、`binding.agentId: null`，
 * 并带 `reason` 说明原因（中文，可直接展示或写日志）。
 *
 * 边界：
 * - 用户真实供应商 Key 不在这里（P0 口径）；
 * - 面向主窗的探测有 1 秒超时、结果缓存 30 秒，设置变更（`setSetting`）会立即失效缓存；
 * - 当前载荷**没有**模型 id 字段：插件要自己按网关 `/v1/models` 或自身设置选模型。
 */
export interface WidgetChatConfig {
  gateway: WidgetChatGateway | null;
  agents: WidgetChatAgent[];
  binding: WidgetChatBinding;
  /** 只在「未声明 `permissions.chat`」时出现：宿主拒绝下发的原因。 */
  reason?: string;
}

/** `notify` 事件：主窗脱敏转发，只带标题级文案，不落盘。 */
export interface WidgetNotifyEvent {
  kind: "notify";
  /** 标题（≤80 字，必填）。 */
  title: string;
  /** 摘要（≤60 字）；宿主**总会**带这个字段，没有摘要时是空串。 */
  summary: string;
  /** 目标主窗页面：白名单内才有；插件可用 `openPage()` 跳过去。 */
  route?: WidgetPage;
  /** 事件时间文本（≤40 字）；宿主有就带，不要假设它一定能被 `Date` 解析。 */
  at?: string;
}

/** `theme` 事件：宿主主题变更。 */
export interface WidgetThemeEvent {
  kind: "theme";
  theme: WidgetTheme;
}

/** `tray` 事件：托盘动作（宿主菜单当前不产生，载荷形状先固定下来）。 */
export interface WidgetTrayEvent {
  kind: "tray";
  /** 动作标识（≤32 字，非空）。 */
  action: string;
}

/**
 * `onEvent(cb)` 推来的事件（`widget:event`）。
 *
 * 投递门禁（缺一不发）：`notify` / `theme` / `tray` 都要求清单
 * `permissions.events` 显式声明对应项；`notify` 还在主窗前台时抑制、窗口隐藏时丢弃
 * （错过不补发）。载荷畸形的事件由宿主直接丢弃，不会推到渲染层。
 *
 * 未来可能新增 `kind`：插件按 `kind` 分支后要有默认忽略分支，不要假定只有这三种。
 */
export type WidgetEvent = WidgetNotifyEvent | WidgetThemeEvent | WidgetTrayEvent;

/**
 * 生命周期事件（`onLifecycle(cb)`，`widget:lifecycle`）。
 *
 * 只有清单 `permissions.events` 含 `"lifecycle"` 的界面插件才收得到；
 * 事件是**通知不是授权**（收到不会多出任何能力），且窗口重建 / 页面重载 / 宿主重启
 * 都不会重放历史事件——插件状态请用 `info()` / `settings()` 自检。
 */
export interface WidgetLifecycleEvent {
  /** 发生了什么。 */
  event: "installed" | "enabled" | "disabled" | "updated" | "uninstalled";
  /** 事件发生时的插件版本；`updated` 为**新**版本。 */
  version: string;
  /** 仅 `updated`：被替换掉的旧版本。 */
  from?: string;
}

/**
 * 插件设置（清单 `settings.fields` 的当前值，宿主按字段默认值补全后返回）。
 *
 * 值由主进程持有（`<userData>/plugins/<id>/settings.json`），键是清单里声明的字段 key；
 * 未声明的键不会出现在这里。值的具体形状取决于字段类型（boolean / select / text /
 * number / agent），所以这里放宽为 `unknown`，插件按自己的字段表收窄。
 */
export type WidgetSettings = Record<string, unknown>;

/**
 * 插件业务数据值（`dataGet` / `dataSet`）。
 *
 * 宿主只保证「`JSON.stringify` 能表示」，因此类型放宽为 `unknown`；调用方按 key 自行
 * 收窄。不允许 `undefined` / 函数 / Symbol / 循环引用，单文件 ≤1MB。
 */
export type WidgetDataValue = unknown;

/** `dataSet()` 的回执：存了哪个 key、落盘多少字节（含末尾换行）。 */
export interface WidgetDataSetResult {
  key: string;
  bytes: number;
}

/** `dataDir()` 的回执：数据目录绝对路径（不保证目录已存在）。 */
export interface WidgetDataDir {
  dir: string;
}

/** `setScale()` 的回执：切换后的档位（到顶/到底时保持原档）。 */
export interface WidgetScaleResult {
  scale: number;
}

/**
 * `setScale()` 兼容的旧形状：`{ dir: 1 }` 放大一档、`{ dir: -1 }` 缩小一档。
 *
 * `dir` 缺省的 `{}` 不是「无操作」：主进程会走 `normalizeScale(spec, {})` 回落默认档。
 */
export interface WidgetScaleDirection {
  dir: 1 | -1;
}

/**
 * 宿主注入的 `window.__heming_widget` 的完整方法集（唯一事实来源是 preload）。
 *
 * 约定：
 * - 名字与 preload 顶层方法一一对应（`WIDGET_API_METHODS` 与测试共同钉住）；
 * - 同步方法就是 `void`（`ipcRenderer.send`），异步方法就是 `Promise`（`invoke`）；
 * - `onX(cb)` 返回取消订阅函数。
 *
 * 旧宿主可能缺后加的方法（`data*` / `onLifecycle` / `chatConfig`），
 * 插件桥接层应按 `typeof bridge.dataGet === "function"` 探测后降级，不要假定全都在。
 */
export interface HemingWidgetApi {
  /* ── 窗口 ── */

  /** 读窗口状态（`widget:state`，invoke）。 */
  state(): Promise<WidgetState>;

  /**
   * 显示自己（`widget:show`，invoke）。
   *
   * 宿主用 `showInactive()` 显示，不抢用户当前焦点；返回显示后的状态。
   */
  show(): Promise<WidgetState>;

  /** 隐藏自己（`widget:hide`，send；单向，无回执）。 */
  hide(): void;

  /** 显示 / 隐藏切换（`widget:toggle`，send；单向）。 */
  toggle(): void;

  /**
   * 缩放一档（`widget:set-scale`，invoke）。
   *
   * 只接受**相对方向**：`1`（放大）或 `-1`（缩小），或旧形状 `{ dir: 1 | -1 }`。
   * 绝对档位由清单 `scales[]` 决定，插件不能自选；两端夹住、不循环。
   *
   * 注意 preload 的口径：不是 `-1` 的**裸值**都会被归一成 `1`（放大），别传 `0` 或别的数字。
   */
  setScale(dir: 1 | -1 | WidgetScaleDirection): Promise<WidgetScaleResult>;

  /**
   * 切换鼠标穿透（`widget:set-click-through`，invoke），返回实际生效值。
   *
   * 只有清单 `clickThrough: "auto"` 的 widget 生效；`"none"` 的窗口调用它不会改变任何东西
   * （返回当前值 false）。拖拽期间不要切换，宿主会忽略交互区上报。
   */
  setClickThrough(on: boolean): Promise<boolean>;

  /**
   * 上报「光标此刻是否在可交互区」（`widget:set-interactive`，send）。
   *
   * 与 `clickThrough: "auto"` 配套：只在值变化时调用（`mousemove` 是高频事件）。
   * 拖拽期间宿主会忽略该上报，避免鼠标事件在透传/拦截之间抖动。
   */
  setInteractive(on: boolean): void;

  /**
   * 开始拖拽（`widget:drag-start`，send）。
   *
   * 只发「按下了」这个信号：位移由主进程按**屏幕光标**计算，渲染层不要传坐标
   * （`clientX/clientY` 会随窗口移动而失真）。
   */
  dragStart(): void;

  /** 拖拽中（`widget:drag-move`，send）；高频调用请按 `requestAnimationFrame` 合并。 */
  dragMove(): void;

  /** 结束拖拽（`widget:drag-end`，send）；宿主会补齐终值、吸附工作区边缘并钳制位置。 */
  dragEnd(): void;

  /** 重置到默认落位（工作区右下角 + 清单 `position.margin`；`widget:reset-position`，send）。 */
  resetPosition(): void;

  /** 重新加载自己（`widget:reload`，send）；换模型/绑定后重读配置用，设置变更通常走 `onSettings` 热更新即可。 */
  reload(): void;

  /* ── 宿主环境 ── */

  /** 读宿主信息（`widget:info`，invoke）。 */
  info(): Promise<WidgetHostInfo>;

  /** 读本插件设置全量（`widget:settings-get`，invoke；宿主已按字段默认值补全）。 */
  settings(): Promise<WidgetSettings>;

  /**
   * 写一个设置项（`widget:settings-set`，invoke），返回合并后的全量设置。
   *
   * 只接受清单 `settings.fields` 里声明过的 key：未声明的 key 被**静默忽略**，不报错，
   * 返回值里也不会出现；值的类型按字段类型由宿主强制（如 `number` 字段会被转数字）。
   * 写成功会触发 `onSettings` 推送并让 `chatConfig` 缓存失效。
   */
  setSetting(key: string, value: unknown): Promise<WidgetSettings>;

  /**
   * 订阅设置变更（推送通道 `widget:settings`），返回取消订阅函数。
   *
   * 触发时机：`setSetting()` 成功，或用户在宿主设置区改了本插件的字段；载荷是合并后的全量。
   */
  onSettings(callback: (settings: WidgetSettings) => void): () => void;

  /* ── 插件自有数据（`<userData>/plugins/<id>/data/`） ── */

  /**
   * 读一个业务数据 key（`widget:data-get`，invoke）。
   *
   * 文件不存在或 JSON 损坏都返回 `null`（读失败不 reject）；key 非法会 reject。
   */
  dataGet<T = unknown>(key: string): Promise<T | null>;

  /**
   * 写一个业务数据 key（`widget:data-set`，invoke），覆盖写（tmp + rename 原子落盘）。
   *
   * key 须匹配 `[A-Za-z0-9._-]{1,64}` 且不含 `..`；值必须是可 JSON 序列化的值、
   * 单文件 ≤1MB。失败一律 reject（可读中文原因），不会静默截断——别吞掉写失败。
   * 不要在这里存密钥：数据目录是明文文件。
   */
  dataSet(key: string, value: WidgetDataValue): Promise<WidgetDataSetResult>;

  /** 删一个业务数据 key（`widget:data-delete`，invoke）；返回是否真的删掉了文件（不存在 = false，不算错误）。 */
  dataDelete(key: string): Promise<boolean>;

  /** 列出现有 key（`widget:data-keys`，invoke；只含 `*.json`，已排序，忽略临时文件）。 */
  dataKeys(): Promise<string[]>;

  /** 取数据目录绝对路径（`widget:data-dir`，invoke）；放不进 JSON 的大文件也放这里，但别展示给终端用户。 */
  dataDir(): Promise<WidgetDataDir>;

  /* ── 事件 ── */

  /**
   * 订阅宿主事件（推送通道 `widget:event`），返回取消订阅函数。
   *
   * 只投递清单 `permissions.events` 声明过的 kind，见 `WidgetEvent`。
   */
  onEvent(callback: (event: WidgetEvent) => void): () => void;

  /**
   * 订阅生命周期事件（推送通道 `widget:lifecycle`），返回取消订阅函数。
   *
   * 只给清单 `permissions.events` 含 `"lifecycle"` 的插件投递，不重放历史事件。
   */
  onLifecycle(callback: (event: WidgetLifecycleEvent) => void): () => void;

  /* ── 跳转与对话 ── */

  /** 打开宿主设置区的本插件卡片（`widget:open-settings`，send）。 */
  openSettings(): void;

  /**
   * 让主窗跳到白名单页面（`widget:open-page`，send）。
   *
   * 白名单外的值由主进程静默丢弃（记宿主日志）；主窗被最小化时会先恢复并聚焦。
   */
  openPage(page: WidgetPage): void;

  /** 读对话上下文（`widget:chat-config`，invoke）：本机网关 + 可用智能体 + 当前绑定。 */
  chatConfig(): Promise<WidgetChatConfig>;

  /* ── 日志 ── */

  /**
   * 写一条插件日志（`widget:log`，send）。
   *
   * 宿主统一加 `[widgets:<pluginId>]` 前缀并截断到 500 字；空串被丢弃。
   * 不要用它打印密钥或用户隐私数据（会进宿主日志）。
   */
  log(line: string): void;
}

/**
 * `window.__heming_widget` 的顶层方法名清单（顺序与 preload 一致）。
 *
 * 用途：
 * - 一致性测试：preload 加/删方法而这里没跟上会红（`widget.test.ts`）；
 * - 文档生成：标准文档的方法表按这份清单核对，避免漏项。
 *
 * 新增方法的同步点（三处缺一不可）：`widget-preload.js`、`HemingWidgetApi`、本数组。
 */
export const WIDGET_API_METHODS = [
  "state",
  "show",
  "hide",
  "toggle",
  "setScale",
  "setClickThrough",
  "setInteractive",
  "dragStart",
  "dragMove",
  "dragEnd",
  "resetPosition",
  "reload",
  "info",
  "settings",
  "setSetting",
  "onSettings",
  "dataGet",
  "dataSet",
  "dataDelete",
  "dataKeys",
  "dataDir",
  "onEvent",
  "onLifecycle",
  "openSettings",
  "openPage",
  "chatConfig",
  "log",
] as const satisfies readonly (keyof HemingWidgetApi)[];

/** 接口里存在、但清单漏掉的方法（正常应为 `never`）。 */
type MissingWidgetApiMethod = Exclude<keyof HemingWidgetApi, (typeof WIDGET_API_METHODS)[number]>;

/**
 * 编译期断言：`HemingWidgetApi` 的每个方法都必须出现在 `WIDGET_API_METHODS` 里。
 * 漏一个时 `MissingWidgetApiMethod` 就不是 `never`，本行赋值失败 → 构建红。
 */
const WIDGET_API_METHODS_COMPLETE: MissingWidgetApiMethod extends never ? true : never = true;

/** 宿主注入后的窗口全局形状（`window.__heming_widget`）。 */
export interface WidgetApiGlobal {
  /**
   * 按 `Partial` 声明：`data*` / `onLifecycle` / `chatConfig` 是后加的方法，
   * 旧宿主可能没有；插件应探测方法是否存在后再调用（缺方法时降级，不要白屏）。
   */
  __heming_widget?: Partial<HemingWidgetApi>;
}
