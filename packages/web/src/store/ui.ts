import { create } from "zustand";

export type Page =
  | "home"
  | "workspace"
  | "tasks"
  | "skills"
  | "interfaces"
  | "memory"
  | "archive"
  | "settings"
  | "chat";

/** 联系人详情三类：群聊 / 人类好友 / 智能体（雷达扇区同口径）。 */
export type ContactKind = "group" | "human" | "agent";

/** 导航项（可排序的六个主页；chat 是覆盖层，不参与排序）。 */
export type NavPage = Exclude<Page, "chat">;

/** 导航默认顺序；快捷键数字由 App/NavRail 按页面固定绑定（显示顺序改了不影响快捷键）。 */
export const DEFAULT_NAV_ORDER: NavPage[] = [
  "home",
  "workspace",
  "tasks",
  "skills",
  "interfaces",
  "memory",
  "archive",
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

interface UiState {
  page: Page;
  /** 左侧导航显示顺序（用户可自定义；持久化）。 */
  navOrder: NavPage[];
  activeConversationId: string | null;
  /**
   * 聊天页上方横向标签页：当前打开过的会话（按打开先后，重复打开则移到末尾前移）。
   * 用户要求「以横向标签页记录聊天对象，点击可快速切换」。
   * 只存 id——标题/头像从 conversations 实时取，避免会话改名后标签还写死旧名。
   * 上限 TABS_MAX：长期使用会把标签栏撑爆，超出后丢弃最久未用的（与浏览器标签同思路）。
   */
  openTabs: string[];
  /** 通讯录雷达面板显隐（page==="chat" 时覆盖层滑出/呼出；非 chat 页恒可见）。 */
  contactsHidden: boolean;
  /** 工作区联系人详情目标（null=雷达主视图；置位=分组竖列+详情卡）。切页时清空。 */
  detailContact: { kind: ContactKind; id: string } | null;
  /** 右栏「发送到会话」待投递单槽（null=无）。切页时清空；ChatPage 命中目标会话即消费。 */
  pendingAttachment: PendingAttachment | null;
  /** 任务区待执行的任务（null=无）。切页/开普通会话时清空；ChatPage 命中会话即消费并自动发送。 */
  taskDraft: TaskDraft | null;
  /**
   * 通知中心跳转任务区时要选中的任务（null=无）。
   * 只到「进入任务区」为止：TaskAreaPage 命中该 id 即选中并消费，避免残留导致来回跳。
   */
  taskFocusId: string | null;
  setPage: (page: Page) => void;
  openConversation: (id: string) => void;
  /**
   * 聚焦某会话但**不切到聊天页**（任务区嵌 ChatPage 用）：
   * 标签与 activeConversationId 与 openConversation 同口径，page 保持当前值。
   */
  focusConversation: (id: string) => void;
  setTaskDraft: (draft: TaskDraft) => void;
  consumeTaskDraft: () => void;
  /** 从通知中心跳到任务区的某条任务（连带聚焦它的会话）。 */
  focusTask: (taskId: string, conversationId?: string) => void;
  consumeTaskFocus: () => void;
  leaveConversation: () => void;
  /** 关闭某个标签页：当前会话则退回上一个标签（非空时）否则离开聊天页。 */
  closeConversationTab: (id: string) => void;
  hideContacts: () => void;
  showContacts: () => void;
  openContactDetail: (kind: ContactKind, id: string) => void;
  closeContactDetail: () => void;
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

/** 标签页上限：超出丢弃最久未用的，避免标签栏无限变长。 */
export const TABS_MAX = 8;

/** 导航顺序写盘；存不下（隐私模式）时只在本次会话生效。 */
function persistNavOrder(order: NavPage[]): void {
  try {
    window.localStorage.setItem(NAV_ORDER_KEY, JSON.stringify(order));
  } catch {
    /* 忽略 */
  }
}

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
  openTabs: [],
  contactsHidden: false,
  detailContact: null,
  pendingAttachment: null,
  taskDraft: null,
  taskFocusId: null,
  setPage: (page) =>
    set({
      page,
      activeConversationId: null,
      // 标签页跨页保留：切去设置页看一眼再回聊天，之前开的会话标签还在。
      // 但待投递槽/详情卡是页内瞬态，离开聊天页就没意义了。
      contactsHidden: false,
      detailContact: null,
      pendingAttachment: null,
      // 未消费的任务投递跟着离开：切页后再自动发送会让用户莫名其妙多一条消息。
      taskDraft: null,
      taskFocusId: null,
    }),
  openConversation: (id) =>
    // 导航轨常驻：进入会话不再收起左侧导航（用户要求「左侧导航栏应该常驻，不应该移动」）
    set((state) => ({
      page: "chat",
      activeConversationId: id,
      contactsHidden: true,
      taskDraft: null,
      // 已在标签里则移到最前（用户刚点过它，理应成为当前标签位），否则追加
      openTabs: [
        ...state.openTabs.filter((t) => t !== id),
        id,
      ].slice(-TABS_MAX),
    })),
  focusConversation: (id) =>
    set((state) => ({
      activeConversationId: id,
      contactsHidden: true,
      openTabs: [
        ...state.openTabs.filter((t) => t !== id),
        id,
      ].slice(-TABS_MAX),
    })),
  setTaskDraft: (draft) => set({ taskDraft: draft }),
  consumeTaskDraft: () => set({ taskDraft: null }),
  focusTask: (taskId, conversationId) =>
    set((state) => ({
      page: "tasks",
      taskFocusId: taskId,
      taskDraft: null,
      pendingAttachment: null,
      detailContact: null,
      ...(conversationId
        ? {
            activeConversationId: conversationId,
            openTabs: [
              ...state.openTabs.filter((t) => t !== conversationId),
              conversationId,
            ].slice(-TABS_MAX),
          }
        : {}),
    })),
  consumeTaskFocus: () => set({ taskFocusId: null }),
  leaveConversation: () => get().setPage("workspace"),
closeConversationTab: (id) => {
      const { openTabs, activeConversationId } = get();
      const index = openTabs.indexOf(id);
      if (index < 0) return;
      const next = openTabs.filter((t) => t !== id);
      if (activeConversationId !== id) {
        set({ openTabs: next });
        return;
      }
      // 关掉的是当前会话：退到左邻（视觉上就在旁边），没有左邻才退右邻；都不剩才离开聊天页。
      // 邻居必须在**原数组**里取——next 已过滤掉 id，按 next 的下标算会错位
      // （关掉数组最后一个标签时 index-1 越界到 next 的末项，会跳到右边的标签）。
      const fallback = next[index - 1] ?? next[index];
      if (fallback) {
        set({ openTabs: next, activeConversationId: fallback, contactsHidden: true });
      } else {
        get().setPage("workspace");
      }
    },
  hideContacts: () => set({ contactsHidden: true }),
  showContacts: () => set({ contactsHidden: false }),
  openContactDetail: (kind, id) => set({ detailContact: { kind, id } }),
  closeContactDetail: () => set({ detailContact: null }),
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
