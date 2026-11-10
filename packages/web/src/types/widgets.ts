/**
 * 界面插件（desktopWidget）在主窗侧的类型契约（d.98）。
 *
 * 真源是规格 `docs/superpowers/specs/2026-11-07-d94-pet-as-plugin.md`：
 * - §2.3 `desktopWidget` 清单规格 → `WidgetSpec`
 * - §4.2.1 主窗 IPC 契约 → `WidgetsBridge`
 *
 * 为什么类型只放这里：主进程（packages/desktop）只实现通道、不定义 web 类型；
 * 主窗（本包）是唯一调用方，界面、store、事件转发全部复用这一份声明。
 * 通道名（`widgets:*`）属于主进程实现细节，渲染层只认 `window.__heming_widgets`。
 *
 * ★ 边界：这里只有「界面插件」的数据形状，没有任何执行能力——
 * 窗口、托盘、文件、密钥、会话全在主进程；本包不允许出现 fs / child_process 之类导入。
 */

/** 窗口鼠标穿透策略：`none` 整窗接收鼠标；`auto` 由渲染层上报交互区。 */
export type WidgetClickThrough = "none" | "auto";

/** 落位锚点：由主进程按工作区解释（规格只给了 `bottom-right` 例子，不做前端枚举）。 */
export interface WidgetPositionSpec {
  /** 锚点标识（如 "bottom-right"）；主进程校验并回落默认值。 */
  anchor: string;
  /** 距锚点边缘的 DIP 间距。 */
  margin: number;
  /** 是否记住用户拖动后的位置（`state.json`）。 */
  remember: boolean;
}

/** 宿主通用表单支持的五种字段类型（规格 §2.3）。 */
export type WidgetSettingFieldType = "boolean" | "select" | "text" | "number" | "agent";

/** `select` 的一个选项。 */
export interface WidgetSettingOption {
  value: string;
  label: string;
}

/** 清单 `settings.fields[]` 的一项：宿主用通用表单渲染，值由主进程持有。 */
export interface WidgetSettingField {
  /** 字段键；设置值以它为键存在 `settings.json`。 */
  key: string;
  label: string;
  type: WidgetSettingFieldType;
  /** 缺省值（清单可选）；缺失时由表单按类型给空值。 */
  default?: unknown;
  /** 仅 `select` 使用。 */
  options?: WidgetSettingOption[];
}

/** 清单 `desktopWidget.settings`：标题 + 字段表。 */
export interface WidgetSettingsSpec {
  title?: string;
  fields: WidgetSettingField[];
}

/** 托盘声明：图标与菜单项 id（菜单项实现留在宿主）。 */
export interface WidgetTraySpec {
  /** 包内相对路径（png）。 */
  icon: string;
  /** `toggle` / `clickThrough` / `resetPosition` / `settings` 的子集。 */
  items: string[];
}

/** 清单 `contributions.desktopWidgets[]` 的一项（窗口规格由宿主解释）。 */
export interface WidgetSpec {
  /** 插件内唯一 id（`^[a-z0-9][a-z0-9-]{0,31}$`）。 */
  id: string;
  name: string;
  /** 包内入口（相对包根的 .html）。 */
  entry: string;
  width: number;
  height: number;
  /** 可选缩放档位（递增，0.5–2）。 */
  scales: number[];
  defaultScale: number;
  transparent: boolean;
  alwaysOnTop: boolean;
  skipTaskbar: boolean;
  resizable: boolean;
  clickThrough: WidgetClickThrough;
  position: WidgetPositionSpec;
  icon?: string;
  tray?: WidgetTraySpec;
  settings?: WidgetSettingsSpec;
}

/** 窗口运行态（主进程持有；设置卡与列表按钮按它显示）。 */
export interface WidgetState {
  visible: boolean;
  scale: number;
  clickThrough: boolean;
}

/** 界面插件命令的目标（d.109；与声明式 v5 同四类，bundle 不允许 `skill`）。 */
export type WidgetCommandTarget =
  | { kind: "page"; page: string }
  | { kind: "plugin" }
  | { kind: "settings"; card: string }
  | { kind: "unit"; unitId: string };

/**
 * 界面插件命令（`contributions.commands[]` 的物化视图，d.109）。
 *
 * 主进程在安装/启动自检时按 bundle 允许的 target 集合收紧后写进注册表；
 * web 侧命令面板据此生成「插件命令」条目（不执行插件代码，只做导航）。
 */
export interface WidgetCommand {
  id: string;
  title: string;
  description: string;
  keywords: string[];
  target: WidgetCommandTarget;
}

/**
 * 已安装的界面插件记录（`widgets:list` 的一项）。
 *
 * `error` 只在「记录还在、但本版本起不来」时出现（如包文件损坏 / 清单校验失败），
 * 界面要如实显示而不是把这条静默隐藏——用户得知道为什么桌面上没有东西。
 */
export interface WidgetRecord {
  /** 插件 id（= 安装目录名，如 `heming.pet`）。 */
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  /**
   * 桌面浮窗规格；**页面型界面插件为 `null`**（d.124：清单只声明 `page`、没有
   * `desktopWidgets` 时，主进程不建浮窗）。消费方必须先判空再取 `.name/.settings`。
   */
  widget: WidgetSpec | null;
  settings: Record<string, unknown>;
  /** ISO 时间。 */
  installedAt: string;
  /** 清单里的命令（d.109；旧安装记录缺省 `[]`，主进程启动时会回填）。 */
  commands?: WidgetCommand[];
  /** d.124：界面插件页面（清单 `contributions.page`）；旧记录没有该字段。 */
  page?: WidgetPageSpec;
  error?: string;
}

/**
 * 界面插件页面（d.124，清单 `contributions.page` 的归一化视图）。
 *
 * 与声明式页面不同：页面内容全部由插件自己的 HTML 渲染，宿主只给一个
 * `widget://` 独立 origin 的沙箱视图与既有能力桥。web 侧只用它做导航入口、
 * 标题/图标展示与「打开页面」入口；真正的视图在主进程。
 */
export interface WidgetPageSpec {
  /** 导航项与页面标题（≤40 字）。 */
  title: string;
  /** 宿主图标 id（已归一化；未知值回落 `package`）。 */
  icon: string;
  /** 页面副标题（≤200 字；可空）。 */
  summary: string;
  /** 包内相对 `.html` 入口。 */
  entry: string;
}

/** 页面视图的位置与尺寸（主窗内容区坐标，CSS px = DIP）。 */
export interface WidgetPageRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 页面视图挂载结果（失败时 error 已是可直接展示的中文）。 */
export type WidgetPageMountResult = { ok: true } | { ok: false; error: string };

/** 宿主动作（规格 §2.3「窗口通用动作」）：全部由主进程执行，渲染层不碰窗口 API。 */
export type WidgetHostAction =
  | "show"
  | "hide"
  | "toggle"
  | "scaleUp"
  | "scaleDown"
  | "toggleClickThrough"
  | "resetPosition"
  | "reload";

/** 主进程 → 主窗的页面跳转请求（`widgets:open-page`，白名单页面）。 */
export interface WidgetOpenPageRequest {
  /** 目标页面；只认白名单里的值，其余由主进程丢弃。 */
  page: "settings" | "team" | "tasks" | "staff" | "infohub";
  /** `page === "settings"` 时的分区（如 "appearance"）。 */
  settingsTab?: string;
  /** 请求来源插件（用于高亮/定位；可缺省）。 */
  pluginId?: string;
}

/** 智能体摘要（widget `chatConfig()` 的 `agents[]`；提示词来自宿主的智能体设定）。 */
export interface WidgetChatAgent {
  id: string;
  name: string;
  /** 人设提示词（宿主设置里的智能体提示词；可缺省）。 */
  prompt?: string;
}

/**
 * 主窗回答 `chatConfig` 请求时给的内容（网关地址/Key 由主进程补，不经过这里）。
 *
 * `binding.agentId` 语义：widget 当前绑定用哪个智能体的人设；主窗不知道插件设置，
 * 所以固定回 `null`，由主进程用该 widget 的 `settings.agentId` 覆盖后再转给 widget。
 */
export interface WidgetChatConfigReply {
  agents: WidgetChatAgent[];
  binding: { agentId: string | null };
}

/** 主窗转发给主进程的事件（脱敏后；主进程再转给声明了 `permissions.events: ["notify"]` 的 widget）。 */
export interface WidgetNotifyEvent {
  kind: "notify";
  title: string;
  /** ≤60 字的摘要；空串表示「只有标题」。 */
  summary: string;
  route?: string;
  /** ISO 时间。 */
  at: string;
}

/**
 * 宿主 → widget 的生命周期事件（d.108，规格 §5.4；`widget:lifecycle` 通道）。
 *
 * 只投递给清单 `permissions.events` 含 `"lifecycle"` 的界面插件；**是通知不是授权**
 * （不会因此多出任何宿主能力），且窗口重建/宿主重启后不重放历史事件。
 * widget 侧的获取方式是 `window.__heming_widget.onLifecycle(cb)`（packages/desktop/widget-preload.js）。
 */
export interface WidgetLifecycleEvent {
  event: "installed" | "enabled" | "disabled" | "updated" | "uninstalled";
  /** 事件发生时的插件版本；`updated` 为**新**版本。 */
  version: string;
  /** 仅 `updated`：被替换掉的旧版本。 */
  from?: string;
}

/** 安装结果（`widgets:install` / `widgets:installFromFile`）。 */
export type WidgetInstallResult =
  | { ok: true; record: WidgetRecord }
  | { ok: false; error: string };

/** 启停/卸载/迁移这类「成功与否 + 原因」的结果。 */
export interface WidgetOkResult {
  ok: boolean;
  error?: string;
}

/**
 * 主窗 preload 暴露的界面插件桥（`window.__heming_widgets`，仅桌面端主窗存在）。
 *
 * 所有方法都可能 reject（IPC 本身失败）——调用方统一 try/catch 并转成中文提示；
 * 业务失败（清单不合法、包校验不过、无签名）以 `{ ok: false, error }` 返回，error 已是中文。
 */
export interface WidgetsBridge {
  /** 已安装界面插件列表（含未启用/损坏的记录）。 */
  list(): Promise<WidgetRecord[]>;
  /** 主进程开文件框选本地 `.tgz`；渲染层不碰 fs，正常安装路径用 `installFromFile()`。 */
  pickPackage(): Promise<{ canceled: boolean; path?: string }>;
  /** 用内存里的包字节安装（云端下载后调用）；`expectedSha256` 由主进程二次校验。 */
  install(input: { bytes: ArrayBuffer; expectedSha256?: string }): Promise<WidgetInstallResult>;
  /** 主进程自己开文件框并安装本地 `.tgz`。 */
  installFromFile(): Promise<WidgetInstallResult>;
  uninstall(input: { id: string; removeData?: boolean }): Promise<WidgetOkResult>;
  setEnabled(input: { id: string; enabled: boolean }): Promise<WidgetOkResult & { record?: WidgetRecord }>;
  settingsGet(input: { id: string }): Promise<Record<string, unknown>>;
  /** 合并 patch 写回，返回合并后的全量设置。 */
  settingsSet(input: { id: string; patch: Record<string, unknown> }): Promise<Record<string, unknown>>;
  action(input: { id: string; action: WidgetHostAction }): Promise<{ ok: boolean; state?: WidgetState; error?: string }>;
  /** 读窗口状态；未安装/记录损坏时主进程返回 `null`（不是伪造的默认值）。 */
  state(input: { id: string }): Promise<WidgetState | null>;
  /**
   * d.124：把界面插件的页面视图挂到主窗内容区（进入 `plugin:<id>` 页面时调用）。
   *
   * 主进程会先销毁上一个页面视图再创建；无 `page` 贡献/已停用的插件会被拒绝。
   * 旧版桌面端没有该方法 —— 调用方必须降级而不是假定存在。
   */
  pageMount?(input: { id: string; rect: WidgetPageRect }): Promise<WidgetPageMountResult>;
  /** 更新页面视图边界（窗口/布局变化时；fire-and-forget，主进程自己钳制）。 */
  pageBounds?(input: { rect: WidgetPageRect }): void;
  /** 移除并销毁当前页面视图（离开页面/切页时；重复调用无害）。 */
  pageUnmount?(): void;
  /** 脱敏事件转发（fire-and-forget；主进程按权限决定是否转给 widget）。 */
  publish(event: WidgetNotifyEvent): void;
  /**
   * 一次性迁移：把老版本主窗 localStorage 的桌宠偏好交给主进程并进插件设置（幂等）。
   *
   * `prefs` 是 `heming.pet.v1` 的原始对象（可能含 enabled/agentId/modelPath/presence）；
   * 主进程负责逐字段校验，脏字段丢弃、不整份拒绝。
   */
  migrateLegacy(input: { prefs: Record<string, unknown> }): Promise<WidgetOkResult>;
  /**
   * 主进程 → 主窗：widget/托盘请求切换页面（反向推送，可选）。
   *
   * 旧 preload 没有该方法时调用方必须 no-op——页面跳转是便利功能，不是可用性前提。
   */
  onOpenPage?(cb: (request: WidgetOpenPageRequest) => void): () => void;
  /**
   * 主进程 → 主窗：widget 要对话上下文（`widget:chat-config`，可选）。
   *
   * 主窗收到后用 `replyChatConfig` 回一次智能体列表；超时/不回时主进程按失败处理。
   */
  onChatConfigRequest?(cb: (request: { requestId: string }) => void): () => void;
  /** 回答一次 `chatConfig` 请求（必须与 requestId 对应；重复回会被主进程忽略）。 */
  replyChatConfig?(requestId: string, config: WidgetChatConfigReply): void;
}

/** 当前窗口的界面插件桥；浏览器/旧版桌面端返回 undefined。 */
export function widgetsBridge(): WidgetsBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return window.__heming_widgets;
}
