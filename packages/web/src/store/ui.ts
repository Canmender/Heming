import { create } from "zustand";
import { isModuleOn } from "../lib/modules/store.js";
import type { AutomationKind, SyncOptions } from "../lib/automation/model.js";
import type { PluginPageId } from "../lib/pages/ids.js";
import {
  persistNavMode,
  readStoredNavMode,
  type NavMode,
} from "../lib/navPrefs.js";

/**
 * 导航页（固定 8 项：主页 / 团队 / 智能体 / 插件 / 记忆 / 知识库 / 模型 / 设置）。
 *
 * 前三类「模块页」不再进导航，但**不能从类型里删掉**：
 * 旧链接、命令面板与通知中心的跳转、桌宠气泡的 route 都还在产出这些字符串，
 * 插件页的模块卡也仍要用 `setPage("staff")` 之类打开已安装模块的页面。
 * 删掉它们只会把兼容处理逼进 `as never` 之类的强转里，所以保留在 `Page` 里，
 * 由 `App.tsx` 的路由守卫（`isPageAvailable`）保证未安装模块页不会被渲染。
 *
 * 智能体页沿用内部名 `chat`（会话链路的既有锚点），显示名由 NavRail 决定。
 */
export type Page =
  | "home"
  | "team"
  | "chat"
  | "staff"
  | "infohub"
  | "automations"
  | "model"
  | "modelroute"
  | "workflows"
  | "vault"
  | "plugins"
  | "memory"
  | "settings"
  // d.124：插件页面（插件包声明的页面入口）。具体有哪些由 `lib/pages/registry.ts`
  // 按「已装且启用」投影；这里只表达「页面 id 可以是插件页」这一形状事实。
  | PluginPageId;

/**
 * 已合并页面的旧 id（只保留在类型与解析里，不再出现在导航中）：
 * - `workspace`（团队看板）→ 团队页的「看板」视图
 * - `tasks`（通用智能体）→ 智能体页的「任务」视图
 * - `skills`（技能区）      → 插件区（能力中心）的「技能」视图
 * - `interfaces`（接口区）  → 插件区（能力中心）的「MCP」视图
 */
export type LegacyPage = "workspace" | "tasks" | "skills" | "interfaces";
export type PageId = Page | LegacyPage;

/**
 * 宿主页内部视图（一次性导航意图）。
 *
 * 为什么用「一次性意图」而不是把 Tab 状态放进 store：
 * 跳转方（命令面板、通知中心、桌宠气泡、旧链接）只知道要「去技能」，不知道宿主页
 * 的 Tab 是局部 state；把 Tab 长期放 store 又会让「切走再回来」被钉在上次的位置，
 * 那超出了跳转方的意图。消费一次即清，与 `automationIntent` / `paletteIntent` 同口径。
 */
export type PageView = "board" | "tasks" | "skills" | "interfaces" | "modules" | "plugins" | "chat";

/** 导航项：所有页面都可排进导航轨（只含合并后的宿主页）。 */
export type NavPage = Page;

/**
 * 导航默认顺序：固定 8 个**宿主页**（主页 / 团队 / 智能体 / 插件 / 记忆 / 知识库 / 模型 / 设置）。
 * 快捷键数字由 App/NavRail 按页面固定绑定（显示顺序改了不影响快捷键）。
 *
 * 幕僚 / 信息中枢 / 自动化 / 工作流这 4 个模块页**不在个性化顺序里**，而是由
 * `lib/modules/nav.ts` 的 `withModuleNav()` 按「已安装且启用」动态插到「插件」之后
 * （d.119 用户口径：装上就在导航里看得到）。所以本数组只表达宿主页；
 * 模型路由页已由 magpie 路由组取代、彻底删除，`Page` 类型仍保留这些字符串，
 * 供旧链接、通知跳转与模块卡路由使用。
 *
 * 视觉分组见 `lib/navGroups.ts`：工作台（主页/团队/智能体）→ 能力（插件 + 已装模块）→
 * 资料（记忆/知识库/模型）→ 系统（设置）。
 */
export const DEFAULT_NAV_ORDER: NavPage[] = [
  "home",
  "team",
  "chat",
  "plugins",
  "memory",
  "vault",
  "model",
  "settings",
];

/**
 * d.72 之前的默认顺序。
 *
 * 用户没动过顺序时，localStorage 里存的就是这一份；重排默认值后要把它迁移成新顺序，
 * 否则「重排列导航栏」对老用户完全不生效（看起来像功能没做）。用户自定义过的顺序
 * 一律原样保留——那是他亲手排的，不该被升级覆盖。
 */
const LEGACY_DEFAULT_NAV_ORDER: NavPage[] = [
  "home",
  "team",
  "chat",
  "staff",
  "infohub",
  "automations",
  "plugins",
  "memory",
  "settings",
];

/**
 * d.100–d.112 期间的默认顺序（10 个宿主页）。
 *
 * 这一段期间没动过顺序的用户，localStorage 里存的正是这一份；d.114 新增「知识库」后
 * 必须把它也认成「旧默认」，否则这些用户会在末尾多出一个知识库入口（normalize 的补项
 * 规则，视觉上落到设置区之后），看起来像导航顺序坏了。
 */
const LEGACY_DEFAULT_NAV_ORDER_MODEL: NavPage[] = [
  "home",
  "chat",
  "team",
  "staff",
  "infohub",
  "automations",
  "modelroute",
  "model",
  "plugins",
  "memory",
  "settings",
];

/**
 * d.114–d.115 期间的默认顺序（12 个宿主页，含幕僚/信息中枢/自动化/模型路由）。
 *
 * 导航收口成固定 8 项后，这一段期间没动过顺序的用户必须也迁到新默认；否则
 * 他们的存储里会留下 4 个已不进导航的页面，`normalizeNavOrder` 会把它们丢掉，
 * 而「已丢弃」与「用户自定义」无法区分——所以要在迁移判定里显式认成旧默认。
 */
const LEGACY_DEFAULT_NAV_ORDER_MODULES: NavPage[] = [
  "home",
  "chat",
  "team",
  "staff",
  "infohub",
  "automations",
  "modelroute",
  "model",
  "vault",
  "plugins",
  "memory",
  "settings",
];

/** 所有历史默认顺序：命中任意一份都跟随当前默认（用户亲手排过的不在此列）。 */
const LEGACY_DEFAULT_NAV_ORDERS: NavPage[][] = [
  LEGACY_DEFAULT_NAV_ORDER,
  LEGACY_DEFAULT_NAV_ORDER_MODEL,
  LEGACY_DEFAULT_NAV_ORDER_MODULES,
];

function sameOrder(a: readonly NavPage[], b: readonly NavPage[]): boolean {
  return a.length === b.length && a.every((page, i) => page === b[i]);
}

/** 旧页面 id → 宿主页 + 视图的折叠表。新增合并页时只改这里与 `Page`。 */
const LEGACY_ROUTES: Record<LegacyPage, { page: Page; view: PageView }> = {
  workspace: { page: "team", view: "board" },
  tasks: { page: "chat", view: "tasks" },
  skills: { page: "plugins", view: "skills" },
  interfaces: { page: "plugins", view: "interfaces" },
};

/** 是否是已合并的旧页面名。 */
export function isLegacyPage(value: unknown): value is LegacyPage {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(LEGACY_ROUTES, value);
}

/**
 * 把任意旧页面名/宿主页归一成「宿主页 + 视图」。
 *
 * 显式传入的 `view` 优先于旧页面的默认视图：`setPage("plugins", "interfaces")` 是
 * 「去插件区的 MCP 视图」，而 `setPage("interfaces")` 只是旧链接的等价写法。
 */
export function resolvePage(page: PageId, view?: PageView | null): { page: Page; view: PageView | null } {
  if (isLegacyPage(page)) {
    const route = LEGACY_ROUTES[page];
    return { page: route.page, view: view ?? route.view };
  }
  return { page, view: view ?? null };
}

/** 导航顺序本地存储键。 */
export const NAV_ORDER_KEY = "heming.navOrder.v1";

/**
 * 规整读回的顺序：只保留已知页、去重、缺项补在末尾——
 * 旧版本加过新页面时不会因为存储里缺它而整个顺序失效。
 *
 * 并入宿主页的旧项（workspace/tasks/skills/interfaces）按 `resolvePage` 折叠成宿主页；
 * 折叠后与已出现的宿主页重复就丢掉，所以老用户的导航顺序能平滑迁移。
 */
export function normalizeNavOrder(raw: unknown): NavPage[] {
  const seen: NavPage[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item !== "string") continue;
      if (!(DEFAULT_NAV_ORDER as string[]).includes(item) && !isLegacyPage(item)) continue;
      const { page } = resolvePage(item as PageId);
      if (!seen.includes(page)) seen.push(page);
    }
  }
  for (const page of DEFAULT_NAV_ORDER) if (!seen.includes(page)) seen.push(page);
  return seen;
}

/** 读存储里的导航顺序；缺失/损坏 → 默认顺序。 */
export function readStoredNavOrder(storage: Pick<Storage, "getItem"> | null): NavPage[] {
  if (!storage) return [...DEFAULT_NAV_ORDER];
  try {
    const raw = storage.getItem(NAV_ORDER_KEY);
    if (!raw) return [...DEFAULT_NAV_ORDER];
    const parsed = JSON.parse(raw) as unknown;
    const order = normalizeNavOrder(parsed);
    // 没动过顺序的老用户：跟随新版默认顺序（见 LEGACY_DEFAULT_NAV_ORDER 注释）。
    // 判据用**存储里的原始数组**而不是 normalize 之后的结果：normalize 会把新页补在末尾，
    // 拿补完的结果去比旧默认永远不相等——d.84 新增「模型路由」时正是这样漏掉的。
    const stored = Array.isArray(parsed) ? parsed : null;
    const followsLegacyDefault =
      stored !== null &&
      LEGACY_DEFAULT_NAV_ORDERS.some((legacy) => sameOrder(stored as NavPage[], legacy));
    return followsLegacyDefault ? [...DEFAULT_NAV_ORDER] : order;
  } catch {
    return [...DEFAULT_NAV_ORDER];
  }
}

/**
 * 任务区「新建任务」的一次性投递槽：任务记录已建档，等 ChatPage 挂载后自动执行。
 *
 * 为什么要经 UI store 转一手：任务区复用 ChatPage（消息/流式/E2E 全在那边），
 * 而创建任务发生在侧栏弹窗——把「发什么、@谁、算哪个任务」显式投递过去，
 * 比在页面间复制一套发送逻辑更不容易漏掉 E2E 与附件路径。
 */
export interface TaskDraft {
  taskId: string;
  conversationId: string;
  text: string;
  mentions: { agentId: string; name: string }[];
}

/** 右栏目录投递的单文件槽：文件已在共享库，直接经 WS 发 payload.file，不再走上传。 */
export interface PendingAttachment {
  conversationId: string;
  file: { id: string; name: string; mime: string; size: number };
}

/**
 * 进入信息中枢时的一次性意图（d.46）：首页卡/命令面板在别的页面发起，
 * 页面挂载或已就绪后消费——避免把检索词和 tab 状态复制到全局。
 */
export interface InfohubIntent {
  tab: "search" | "agenda";
  query?: string;
}

/**
 * 进入自动化页时的一次性意图（d.47）：信息中枢页把「当前同步选项」或
 * 「重扫日程」交给新建表单，不把任务状态复制到全局。
 */
export interface AutomationIntent {
  kind: AutomationKind;
  sync?: SyncOptions;
}

/**
 * 命令面板 → 知识库页的一次性意图（d.113 第二轮）。
 *
 * 照 `InfohubIntent` 的既有模式，但多带一个自增 `token`：日记/新建这类动作
 * 「连着点两次」都要各触发一次，只靠 kind 相同会被 React effect 合并掉。
 * 只放跳转/动作标识与目标 rel，**不放正文**；消费即清空，不落 localStorage。
 */
export type VaultIntentKind = "open" | "new" | "daily" | "canvas" | "settings";

export interface VaultIntent {
  kind: VaultIntentKind;
  /** open 时为目标文件 rel。 */
  rel?: string;
  /** 自增序号：同类意图连点两次也能分别消费。 */
  token: number;
}

/**
 * 命令面板向「常驻/懒加载页面」投递的一次性意图（d.60 起，d.61 扩三种）。
 *
 * 为什么需要它：弹窗/高亮这类开关是组件内局部 state，外部没有触发点。
 * 这里只加一个**内存**意图槽给命令面板投递：
 * - 不落 localStorage —— 面板关掉就该忘掉，重启后残留一个「打开通知中心」很怪；
 * - `token` 自增，保证「同一种意图连点两次」也能各自消费一次（不会因为 kind 相同被合并）；
 * - 消费即清空，消费端以 `token` 为 effect 依赖，天然幂等、不会重复打开；
 * - `data` 只放跳转所需的定位信息（任务/记忆/插件 id），**不放任何内容正文**。
 */
export type PaletteIntentKind =
  | "agent-create"
  | "notifications"
  /** d.64：命令面板插件命令（target=skill）→ 技能区定位并打开详情。 */
  | "focus-skill"
  /** d.61：命令面板本机搜索 → 记忆条目定位。 */
  | "focus-memory"
  /** d.61：命令面板本机搜索 → 插件卡片定位。 */
  | "open-plugin"
  /** d.108：命令面板插件命令（target=settings）→ 设置页定位到某张卡。 */
  | "focus-settings";

/** 意图携带的定位信息（只含 id/层级，不含正文）。 */
export interface PaletteIntentData {
  /** open-plugin：插件 id（target=unit 时是单元 id）。 */
  id?: string;
  /** focus-memory：记忆条目 id。 */
  memoryId?: string;
  /** focus-memory：条目所在层（三层记忆）。 */
  layer?: "working" | "episodic" | "semantic";
  /** focus-settings：设置卡 id（`SETTINGS_CARDS` 的 id）；设置页据此滚动+高亮。 */
  card?: string;
}

export interface PaletteIntent {
  kind: PaletteIntentKind;
  token: number;
  data?: PaletteIntentData;
}

interface UiState {
  page: Page;
  /**
   * 宿主页要激活的视图（一次性意图，消费即清）。
   * 只由 `setPage(page, view)` / 旧页面名折叠写入；页面用 `consumePageView` 取走。
   */
  pageView: PageView | null;
  /** 左侧导航显示顺序（用户可自定义；持久化）。 */
  navOrder: NavPage[];
  /**
   * 导航轨显示模式（d.68）：`pinned` 常显（默认）/ `auto` 自动隐藏。
   * 持久化到 `heming.nav.mode.v1`，解析与坏值回落见 `lib/navPrefs.ts`。
   */
  navMode: NavMode;
  /**
   * `auto` 模式下浮层导航是否展开（**临时态**，不落盘）。
   * 与 `navMode` 分开：收起浮层 ≠ 放弃自动隐藏模式，下次悬停/快捷键仍可呼出。
   */
  navOpen: boolean;
  /** 设为某档模式；切档时收起浮层（避免「pin 了却还挂着浮层」的半展开态）。 */
  setNavMode: (mode: NavMode) => void;
  /** 固定 ↔ 自动 切换（pin 按钮用）。 */
  toggleNavMode: () => void;
  /** 展开浮层导航（auto 模式；pinned 下无副作用）。 */
  openNav: () => void;
  /** 收起浮层导航。 */
  closeNav: () => void;
  /**
   * 快捷键 Ctrl/⌘+B 的「切换显隐」：
   * - pinned：切到 auto（导航隐藏，主内容变宽）；
   * - auto：展开/收起浮层（呼出/收回）。
   * 想重新常显用导航轨底部 pin 按钮或设置区「导航栏」卡。
   */
  toggleNav: () => void;
  /** 当前打开的助手会话（null=助手页显示选择列表）。 */
  activeConversationId: string | null;
  /** 右栏「发送到会话」待投递单槽（null=无）。切页时清空；ChatPage 命中目标会话即消费。 */
  pendingAttachment: PendingAttachment | null;
  /** 任务区待执行的任务（null=无）。切页/开普通会话时清空；ChatPage 命中会话即消费并自动发送。 */
  taskDraft: TaskDraft | null;
  /**
   * 通知中心跳转任务区时要选中的任务（null=无）。
   * 只到「进入任务区」为止：TaskAreaPage 命中该 id 即选中并消费，避免残留导致来回跳。
   */
  taskFocusId: string | null;
  /**
   * 命令面板「搜索成员 → 选中」的一次性投递槽。
   * TeamPage 命中该 id 即选中并消费，避免切走再回来还被同一目标钉住。
   */
  teamFocusUserId: string | null;
  /**
   * 「跳到团队页并定位到某条动向」的一次性投递槽（d.90）。
   *
   * 与 `teamFocusUserId` 的区别：那边只到「选中谁」，这边还要在动向流里高亮那一条
   * （首页点「谁完成了什么」应该落到那件事，而不是只落到那个人）。
   */
  teamFocusActivityId: string | null;
  /**
   * 通知中心跳转自动化页时要选中的自动化任务（null=无）。
   * 与 taskFocusId 同思路：只到「进入自动化页」为止，页面命中该 id 即选中并消费。
   */
  automationFocusId: string | null;
  /** 进入信息中枢的一次性意图（检索词/日程页）；命中即消费。 */
  infohubIntent: InfohubIntent | null;
  /** 进入自动化页并预填新建表单的一次性意图；命中即消费。 */
  automationIntent: AutomationIntent | null;
  /** 进入知识库页并执行动作（打开笔记 / 新建 / 日记 / 画布 / 设置）的一次性意图。 */
  vaultIntent: VaultIntent | null;
  /**
   * 切页。接受合并前的旧页面 id（`workspace` / `tasks` / `skills` / `interfaces`），
   * 会折叠成宿主页并投递对应视图意图；`view` 省略即「不指定视图」。
   */
  setPage: (page: PageId, view?: PageView | null) => void;
  /** 取走宿主的视图意图并清空（页面 effect 消费一次）。 */
  consumePageView: () => PageView | null;
  /** 跳到信息中枢并投递意图；不传意图即普通进入。 */
  /** 跳转到插件页（插件 Tab）：未安装/停用模块的通知与旧链接统一落到这里，而不是静默不动。 */
  openModuleManager: () => void;
  /** 打开幕僚页；模块未安装/未启用时落到插件页（可一键安装）。 */
  openStaff: () => void;
  openInfohub: (intent?: InfohubIntent) => void;
  consumeInfohubIntent: () => void;
  /** 跳到自动化页；带意图时打开预填的新建表单。 */
  openAutomations: (intent?: AutomationIntent) => void;
  consumeAutomationIntent: () => void;
  /** 进入知识库页并投递动作意图（笔记 / 新建 / 日记 / 画布 / 设置）。 */
  openVault: (intent?: Omit<VaultIntent, "token">) => void;
  consumeVaultIntent: () => void;
  /**
   * 设置页要打开的分组（null=保持默认「个人资料」）。
   * 桌宠未配置模型时的「去设置」用它直达「模型」分组，避免用户进来还要自己找。
   * 一次性投递槽：SettingsPage 消费后立即清空，不从外面长期把设置页钉在某个分组。
   */
  settingsTab: string | null;
  /** 打开设置页并可选直达某分组（复用 setPage 的清理语义）。 */
  openSettings: (tab?: string) => void;
  consumeSettingsTab: () => void;
  /** 命令面板投递的一次性意图（内存，消费即清）。 */
  paletteIntent: PaletteIntent | null;
  /** 投递意图（token 自增；data 只携带定位 id，不含内容正文）。 */
  setPaletteIntent: (kind: PaletteIntentKind, data?: PaletteIntentData) => void;
  /** 消费意图（消费端调用后立即清空）。 */
  consumePaletteIntent: () => void;
  /** 打开某个助手会话并进入助手页。 */
  openConversation: (id: string) => void;
  /**
   * 聚焦某会话但**不切到助手页**（任务区嵌 ChatPage 用）：
   * only 改 activeConversationId，page 保持当前值。
   */
  focusConversation: (id: string) => void;
  setTaskDraft: (draft: TaskDraft) => void;
  consumeTaskDraft: () => void;
  /** 从通知中心跳到任务区的某条任务（连带聚焦它的会话）。 */
  focusTask: (taskId: string, conversationId?: string) => void;
  consumeTaskFocus: () => void;
  /** 命令面板跳到团队页并选中某位成员。 */
  focusTeamMember: (userId: string) => void;
  consumeTeamFocus: () => void;
  /** 首页动向条目 → 团队页：选中成员并高亮那一条动向。 */
  focusTeamActivity: (activityId: string, actorId: string) => void;
  consumeTeamActivityFocus: () => void;
  /** 从通知中心跳到自动化页的某条自动化任务（看它的运行记录）。 */
  focusAutomation: (taskId: string) => void;
  consumeAutomationFocus: () => void;
  /** 回到助手选择列表（保持助手页，不选会话）。 */
  leaveConversation: () => void;
  /** 置入待投递槽（单槽：后写覆盖先写）。 */
  sendFileToConversation: (conversationId: string, file: PendingAttachment["file"]) => void;
  /** 消费待投递槽（发出即清空）。 */
  consumePendingAttachment: () => void;
  /** 设置完整导航顺序（自动去重补项并落盘）。 */
  setNavOrder: (order: NavPage[]) => void;
  /** 上移/下移一项（dir=-1 上移，+1 下移）；到顶/到底为 no-op。 */
  moveNav: (page: NavPage, dir: -1 | 1) => void;
  /** 恢复默认导航顺序。 */
  resetNavOrder: () => void;
}

/** 导航顺序写盘；存不下（隐私模式）时只在本次会话生效。 */
function persistNavOrder(order: NavPage[]): void {
  try {
    window.localStorage.setItem(NAV_ORDER_KEY, JSON.stringify(order));
  } catch {
    /* 忽略 */
  }
}

/**
 * 命令面板意图的自增序号（模块级即可：意图是进程内瞬态，不需要跨实例同步）。
 * 每次投递 +1，消费端用 token 判断「这是一次新的点击」。
 */
let paletteIntentToken = 0;

/** 知识库动作意图的自增序号：日记/新建连点两次也要各消费一次。 */
let vaultIntentToken = 0;

/** 取 localStorage；SSR / 隐私模式禁用时返回 null（调用方各自回落默认值）。 */
function uiStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * 启动时把「迁移后的导航顺序」落盘（d.72）。
 *
 * 读盘本身保持纯函数（测试里注入的假 storage 只有 getItem）；这里只在真机上
 * 发现存储值与归一结果不一致时写回——典型场景是把 d.72 之前的默认顺序升级成
 * 新默认，避免以后每次启动都重新迁移一遍。用户自定义顺序归一后内容不变，不会写。
 */
function persistMigratedNavOrder(next: NavPage[]): void {
  const storage = uiStorage();
  if (!storage) return;
  try {
    const raw = storage.getItem(NAV_ORDER_KEY);
    if (!raw || raw === JSON.stringify(next)) return;
    storage.setItem(NAV_ORDER_KEY, JSON.stringify(next));
  } catch {
    /* 隐私模式/配额满：内存态已生效，不因落盘失败影响启动 */
  }
}

const INITIAL_NAV_ORDER = (() => {
  const order = readStoredNavOrder(uiStorage());
  persistMigratedNavOrder(order);
  return order;
})();

/* ══════════════════════════════════════════════════════════════════════
 * 刷新恢复（d.79）：当前页与已选会话落 sessionStorage
 * ══════════════════════════════════════════════════════════════════════
 *
 * 为什么用 sessionStorage 而不是 localStorage：
 * - **刷新要留住**：用户在智能体页聊到一半按 F5，不该被弹回主页（审计 P1-1）；
 * - **重启要回主页**：关窗再开是新会话，上一个会话的页面是过期意图；
 * - 页面与会话属于「这一次使用」，不是需要长期记住的偏好（偏好才落 localStorage）。
 *
 * 只恢复宿主页 `Page` 与 `activeConversationId`：宿主页内部 Tab（团队看板/智能体任务）
 * 是页面局部 state，恢复它需要每个页面自己声明持久化策略，超出「刷新别丢上下文」的诉求。
 * 会话 id 恢复后若已不在工作区，`AssistantPage` 的 `activeConv` 找不到 → 回到空态，不崩。
 */
export const SESSION_VIEW_KEY = "heming.session.view.v1";

export interface SessionView {
  page: Page;
  activeConversationId: string | null;
}

function viewStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null; // 隐私模式/禁用存储：只在本次内存里导航，刷新回主页
  }
}

/** 读刷新前的页面与会话；缺失/脏值/未知页一律回落 null（不猜）。 */
export function readSessionView(
  storage: Pick<Storage, "getItem"> | null = viewStorage(),
): SessionView | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(SESSION_VIEW_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as { page?: unknown; activeConversationId?: unknown };
    if (typeof record.page !== "string") return null;
    if (!(DEFAULT_NAV_ORDER as string[]).includes(record.page)) return null;
    return {
      page: record.page as Page,
      activeConversationId:
        typeof record.activeConversationId === "string" && record.activeConversationId
          ? record.activeConversationId
          : null,
    };
  } catch {
    return null;
  }
}

export function writeSessionView(
  view: SessionView,
  storage: Pick<Storage, "setItem"> | null = viewStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(SESSION_VIEW_KEY, JSON.stringify(view));
  } catch {
    /* 配额满/隐私模式：内存态已生效，刷新回主页不是错误 */
  }
}

const INITIAL_SESSION_VIEW = readSessionView();

export const useUiStore = create<UiState>((set, get) => ({
  page: INITIAL_SESSION_VIEW?.page ?? "home",
  pageView: null,
  navOrder: INITIAL_NAV_ORDER,
  navMode: readStoredNavMode(uiStorage()),
  navOpen: false,
  activeConversationId: INITIAL_SESSION_VIEW?.activeConversationId ?? null,
  pendingAttachment: null,
  taskDraft: null,
  taskFocusId: null,
  teamFocusUserId: null,
  teamFocusActivityId: null,
  automationFocusId: null,
  infohubIntent: null,
  automationIntent: null,
  vaultIntent: null,
  settingsTab: null,
  paletteIntent: null,
  setPaletteIntent: (kind, data) => {
    paletteIntentToken += 1;
    set({ paletteIntent: { kind, token: paletteIntentToken, ...(data ? { data } : {}) } });
  },
  consumePaletteIntent: () => set({ paletteIntent: null }),
  setPage: (page, view) => {
    const route = resolvePage(page, view);
    set({
      page: route.page,
      pageView: route.view,
      // 助手页保留当前会话（从别页回来接着聊）；离开助手页则清掉选中，
      // 避免别的页面残留一个看不见的会话态。
      activeConversationId: route.page === "chat" ? get().activeConversationId : null,
      // 待投递槽/详情卡是页内瞬态，离开聊天页就没意义了。
      pendingAttachment: null,
      // 未消费的任务投递跟着离开：切页后再自动发送会让用户莫名其妙多一条消息。
      taskDraft: null,
      taskFocusId: null,
      // 团队的一次性定位意图也只在「这一次进入团队页」有效：首页点了动向却没命中的
      // 情况如果不在这里清，之后每次进团队页都会被强制切到「动向」Tab（d.109 修复）。
      teamFocusUserId: null,
      teamFocusActivityId: null,
      automationFocusId: null,
      infohubIntent: null,
      automationIntent: null,
      // 知识库动作意图同样一次性：切走就作废，回来不能莫名其妙弹一个新建框
      vaultIntent: null,
    });
  },
  consumePageView: () => {
    const view = get().pageView;
    if (view) set({ pageView: null });
    return view;
  },
  openModuleManager: () =>
    set({
      // 模块已并入插件页：统一落到「插件」Tab（pageView 让插件页把 Tab 钉到插件，
      // 而不是用户上次看的仓库/技能）。旧入口点进来能一键安装。
      page: "plugins",
      pageView: "plugins",
      activeConversationId: null,
      pendingAttachment: null,
      taskDraft: null,
      taskFocusId: null,
      infohubIntent: null,
      automationIntent: null,
      automationFocusId: null,
    }),
  openStaff: () => {
    if (!isModuleOn("staff")) {
      get().openModuleManager();
      return;
    }
    set({ page: "staff", pageView: null });
  },
  openInfohub: (intent) => {
    // 模块未安装/未启用时不再切到一个不该存在的页面；落到插件页让用户能安装/启用它
    if (!isModuleOn("infohub")) {
      get().openModuleManager();
      return;
    }
    set({
      page: "infohub",
      pageView: null,
      activeConversationId: null,
      pendingAttachment: null,
      taskDraft: null,
      taskFocusId: null,
      automationFocusId: null,
      infohubIntent: intent ?? null,
      automationIntent: null,
    });
  },
  consumeInfohubIntent: () => set({ infohubIntent: null }),
  openAutomations: (intent) => {
    if (!isModuleOn("automations")) {
      get().openModuleManager();
      return;
    }
    set({
      page: "automations",
      pageView: null,
      activeConversationId: null,
      pendingAttachment: null,
      taskDraft: null,
      taskFocusId: null,
      // 从这里进来是「去新建/看列表」，不该再落在一个旧的选中任务上。
      automationFocusId: null,
      infohubIntent: null,
      automationIntent: intent ?? null,
    });
  },
  consumeAutomationIntent: () => set({ automationIntent: null }),
  openVault: (intent) => {
    vaultIntentToken += 1;
    set({
      page: "vault",
      pageView: null,
      activeConversationId: null,
      pendingAttachment: null,
      taskDraft: null,
      taskFocusId: null,
      automationFocusId: null,
      infohubIntent: null,
      automationIntent: null,
      // 无 intent = 普通进入知识库页（清掉残留动作，不重复执行上次的「新建」）
      vaultIntent: intent ? { ...intent, token: vaultIntentToken } : null,
    });
  },
  consumeVaultIntent: () => set({ vaultIntent: null }),
  openSettings: (tab) => {
    get().setPage("settings");
    set({ settingsTab: tab ?? null });
  },
  consumeSettingsTab: () => set({ settingsTab: null }),
  openConversation: (id) =>
    set({
      page: "chat",
      /**
       * 通知/系统通知/HITL 点进来要的是**对话本身**：
       * 若用户当时正停在智能体页的「任务」Tab，只改 activeConversationId 会让会话
       * 在看不见的 Tab 下打开。所以这里显式投递「对话视图」意图，宿主页切回对话。
       */
      pageView: "chat",
      activeConversationId: id,
      taskDraft: null,
      automationFocusId: null,
      infohubIntent: null,
      automationIntent: null,
    }),
  focusConversation: (id) => set({ activeConversationId: id }),
  setTaskDraft: (draft) => set({ taskDraft: draft }),
  consumeTaskDraft: () => set({ taskDraft: null }),
  focusTask: (taskId, conversationId) =>
    set({
      // 任务区已并入智能体页：进宿主页 + 任务视图，再靠 taskFocusId 定位到具体任务。
      page: "chat",
      pageView: "tasks",
      taskFocusId: taskId,
      automationFocusId: null,
      taskDraft: null,
      pendingAttachment: null,
      infohubIntent: null,
      automationIntent: null,
      ...(conversationId ? { activeConversationId: conversationId } : {}),
    }),
  consumeTaskFocus: () => set({ taskFocusId: null }),
  focusTeamMember: (userId) =>
    set({
      page: "team",
      pageView: null,
      teamFocusUserId: userId,
      activeConversationId: null,
      pendingAttachment: null,
      taskDraft: null,
      taskFocusId: null,
      infohubIntent: null,
      automationIntent: null,
    }),
  consumeTeamFocus: () => set({ teamFocusUserId: null }),
  focusTeamActivity: (activityId, actorId) =>
    set({
      page: "team",
      pageView: null,
      teamFocusUserId: actorId,
      teamFocusActivityId: activityId,
      activeConversationId: null,
      pendingAttachment: null,
      taskDraft: null,
      taskFocusId: null,
    }),
  consumeTeamActivityFocus: () => set({ teamFocusActivityId: null }),
  focusAutomation: (taskId) => {
    if (!isModuleOn("automations")) {
      get().openModuleManager();
      return;
    }
    set({
      page: "automations",
      pageView: null,
      automationFocusId: taskId,
      // 与 setPage 同口径清掉跨页瞬态：自动化页不该继承任务区的投递/选中，
      // 也不该被残留的「新建表单预填」意图一进来就弹窗。
      taskFocusId: null,
      automationIntent: null,
      taskDraft: null,
      pendingAttachment: null,
      infohubIntent: null,
      activeConversationId: null,
    });
  },
  consumeAutomationFocus: () => set({ automationFocusId: null }),
  leaveConversation: () => set({ page: "chat", pageView: "chat", activeConversationId: null }),
  sendFileToConversation: (conversationId, file) =>
    set({ pendingAttachment: { conversationId, file } }),
  consumePendingAttachment: () => set({ pendingAttachment: null }),
  setNavOrder: (order) => {
    const next = normalizeNavOrder(order);
    set({ navOrder: next });
    persistNavOrder(next);
  },
  moveNav: (page, dir) => {
    const current = get().navOrder;
    const from = current.indexOf(page);
    if (from < 0) return;
    const to = from + dir;
    if (to < 0 || to >= current.length) return; // 边界：到顶/到底不动
    const next = [...current];
    next.splice(from, 1);
    next.splice(to, 0, page);
    set({ navOrder: next });
    persistNavOrder(next);
  },
  resetNavOrder: () => {
    set({ navOrder: [...DEFAULT_NAV_ORDER] });
    persistNavOrder([...DEFAULT_NAV_ORDER]);
  },
  setNavMode: (mode) => {
    const next = mode === "auto" ? "auto" : "pinned";
    // 切档一律收起浮层：pin 之后还挂着一层浮层，看起来像「没生效」。
    set({ navMode: next, navOpen: false });
    persistNavMode(next);
  },
  toggleNavMode: () => {
    get().setNavMode(get().navMode === "pinned" ? "auto" : "pinned");
  },
  openNav: () => {
    if (get().navMode !== "auto") return;
    set({ navOpen: true });
  },
  closeNav: () => {
    if (!get().navOpen) return;
    set({ navOpen: false });
  },
  toggleNav: () => {
    const { navMode, navOpen } = get();
    // pinned：Ctrl+B 的含义是「藏起来」——切到自动隐藏模式；再按一次呼出浮层。
    if (navMode === "pinned") {
      get().setNavMode("auto");
      return;
    }
    set({ navOpen: !navOpen });
  },
}));

/**
 * 页面/会话一变就写一次 sessionStorage（供刷新恢复）。
 *
 * 放在 store 外部订阅而不是每个 setter 里：`setPage` / `openConversation` / `leaveConversation` /
 * 各页的「回主页」有十来个入口，散着写必然漏一个；订阅只认「改完之后的状态」，天然收口。
 * 只比较这两个字段，避免 `navOpen` 之类的瞬时状态把写盘次数放大。
 */
let persistedSessionView: string | null = null;
useUiStore.subscribe((state) => {
  const next = JSON.stringify({
    page: state.page,
    activeConversationId: state.activeConversationId,
  } satisfies SessionView);
  if (next === persistedSessionView) return;
  const parsed = JSON.parse(next) as SessionView;
  persistedSessionView = next;
  writeSessionView(parsed);
});
