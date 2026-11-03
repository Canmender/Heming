import { create } from "zustand";
import type { AutomationKind, SyncOptions } from "../lib/automation/model.js";

export type Page =
  | "home"
  | "team"
  | "chat"
  | "staff"
  | "infohub"
  | "automations"
  | "workspace"
  | "tasks"
  | "skills"
  | "plugins"
  | "interfaces"
  | "memory"
  | "settings";

/**
 * 导航项：所有页面都可排进导航轨。
 * 智能体页沿用内部名 `chat`（会话链路的既有锚点），显示名由 NavRail 决定。
 */
export type NavPage = Page;

/** 导航默认顺序；快捷键数字由 App/NavRail 按页面固定绑定（显示顺序改了不影响快捷键）。 */
export const DEFAULT_NAV_ORDER: NavPage[] = [
  "home",
  "team",
  "chat",
  "staff",
  "infohub",
  "automations",
  "workspace",
  "tasks",
  "skills",
  "plugins",
  "interfaces",
  "memory",
  "settings",
];

/** 导航顺序本地存储键。 */
export const NAV_ORDER_KEY = "heming.navOrder.v1";

/**
 * 规整读回的顺序：只保留已知页、去重、缺项补在末尾——
 * 旧版本加过新页面时不会因为存储里缺它而整个顺序失效。
 */
export function normalizeNavOrder(raw: unknown): NavPage[] {
  const seen: NavPage[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === "string" && (DEFAULT_NAV_ORDER as string[]).includes(item)) {
        if (!seen.includes(item as NavPage)) seen.push(item as NavPage);
      }
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
    return normalizeNavOrder(JSON.parse(raw));
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
  | "open-plugin";

/** 意图携带的定位信息（只含 id/层级，不含正文）。 */
export interface PaletteIntentData {
  /** open-plugin：插件 id。 */
  id?: string;
  /** focus-memory：记忆条目 id。 */
  memoryId?: string;
  /** focus-memory：条目所在层（三层记忆）。 */
  layer?: "working" | "episodic" | "semantic";
}

export interface PaletteIntent {
  kind: PaletteIntentKind;
  token: number;
  data?: PaletteIntentData;
}

interface UiState {
  page: Page;
  /** 左侧导航显示顺序（用户可自定义；持久化）。 */
  navOrder: NavPage[];
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
   * 通知中心跳转自动化页时要选中的自动化任务（null=无）。
   * 与 taskFocusId 同思路：只到「进入自动化页」为止，页面命中该 id 即选中并消费。
   */
  automationFocusId: string | null;
  /** 进入信息中枢的一次性意图（检索词/日程页）；命中即消费。 */
  infohubIntent: InfohubIntent | null;
  /** 进入自动化页并预填新建表单的一次性意图；命中即消费。 */
  automationIntent: AutomationIntent | null;
  setPage: (page: Page) => void;
  /** 跳到信息中枢并投递意图；不传意图即普通进入。 */
  openInfohub: (intent?: InfohubIntent) => void;
  consumeInfohubIntent: () => void;
  /** 跳到自动化页；带意图时打开预填的新建表单。 */
  openAutomations: (intent?: AutomationIntent) => void;
  consumeAutomationIntent: () => void;
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

export const useUiStore = create<UiState>((set, get) => ({
  page: "home",
  navOrder: readStoredNavOrder(
    typeof window === "undefined"
      ? null
      : (() => {
          try {
            return window.localStorage;
          } catch {
            return null;
          }
        })(),
  ),
  activeConversationId: null,
  pendingAttachment: null,
  taskDraft: null,
  taskFocusId: null,
  teamFocusUserId: null,
  automationFocusId: null,
  infohubIntent: null,
  automationIntent: null,
  settingsTab: null,
  paletteIntent: null,
  setPaletteIntent: (kind, data) => {
    paletteIntentToken += 1;
    set({ paletteIntent: { kind, token: paletteIntentToken, ...(data ? { data } : {}) } });
  },
  consumePaletteIntent: () => set({ paletteIntent: null }),
  setPage: (page) =>
    set({
      page,
      // 助手页保留当前会话（从别页回来接着聊）；离开助手页则清掉选中，
      // 避免别的页面残留一个看不见的会话态。
      activeConversationId: page === "chat" ? get().activeConversationId : null,
      // 待投递槽/详情卡是页内瞬态，离开聊天页就没意义了。
      pendingAttachment: null,
      // 未消费的任务投递跟着离开：切页后再自动发送会让用户莫名其妙多一条消息。
      taskDraft: null,
      taskFocusId: null,
      automationFocusId: null,
      infohubIntent: null,
      automationIntent: null,
    }),
  openInfohub: (intent) =>
    set({
      page: "infohub",
      activeConversationId: null,
      pendingAttachment: null,
      taskDraft: null,
      taskFocusId: null,
      automationFocusId: null,
      infohubIntent: intent ?? null,
      automationIntent: null,
    }),
  consumeInfohubIntent: () => set({ infohubIntent: null }),
  openAutomations: (intent) =>
    set({
      page: "automations",
      activeConversationId: null,
      pendingAttachment: null,
      taskDraft: null,
      taskFocusId: null,
      // 从这里进来是「去新建/看列表」，不该再落在一个旧的选中任务上。
      automationFocusId: null,
      infohubIntent: null,
      automationIntent: intent ?? null,
    }),
  consumeAutomationIntent: () => set({ automationIntent: null }),
  openSettings: (tab) => {
    get().setPage("settings");
    set({ settingsTab: tab ?? null });
  },
  consumeSettingsTab: () => set({ settingsTab: null }),
  openConversation: (id) =>
    set({
      page: "chat",
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
      page: "tasks",
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
      teamFocusUserId: userId,
      activeConversationId: null,
      pendingAttachment: null,
      taskDraft: null,
      taskFocusId: null,
      infohubIntent: null,
      automationIntent: null,
    }),
  consumeTeamFocus: () => set({ teamFocusUserId: null }),
  focusAutomation: (taskId) =>
    set({
      page: "automations",
      automationFocusId: taskId,
      // 与 setPage 同口径清掉跨页瞬态：自动化页不该继承任务区的投递/选中，
      // 也不该被残留的「新建表单预填」意图一进来就弹窗。
      taskFocusId: null,
      automationIntent: null,
      taskDraft: null,
      pendingAttachment: null,
      infohubIntent: null,
      activeConversationId: null,
    }),
  consumeAutomationFocus: () => set({ automationFocusId: null }),
  leaveConversation: () => set({ page: "chat", activeConversationId: null }),
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
}));
