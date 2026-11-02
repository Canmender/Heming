import { create } from "zustand";
import {
  createDefaultStorage,
  isPlainObject,
  readJson,
  utf8Length,
  writeJson,
} from "../lib/memory/storage.js";
import type { StorageLike } from "../lib/memory/types.js";

/**
 * 通知中心（本机）：把「不在当前视图里发生的事」收进一条时间线。
 *
 * 为什么只存本机：正文可能含会话摘要，与任务记录同口径——这类内容一律不上云。
 */

export const NOTIFICATIONS_KEY = "heming.notifications.v1";

/** 保留条数（超出淘汰最旧）。 */
export const MAX_NOTIFICATIONS = 50;
/** 标题/正文长度上限（通知是提示，不是存档）。 */
export const MAX_TITLE_CHARS = 60;
export const MAX_BODY_CHARS = 200;
/** 单键字节上限。 */
export const NOTIFICATIONS_BYTE_LIMIT = Math.floor(64 * 1024);

/**
 * 通知类型（d.54 去 IM 后不再有 `message`）：
 * - `task`：任务收尾；
 * - `approval`：**等待用户裁决**的工具调用确认（d.34）。
 *   它的语义是「还没发生」——点开是回到待确认的智能体会话，不是去读一条历史。
 * - `staff`：常驻幕僚的主动简报（d.48），点开去幕僚页。
 */
export type NotificationKind = "task" | "approval" | "staff";

export interface AppNotification {
  id: string;
  kind: NotificationKind;
  /**
   * 去重键：同一个任务终态（`task:<id>:<status>`）等只记一次。
   * WS 重连补投、重复事件都会撞同一个 key，不能变成刷屏。
   */
  key: string;
  title: string;
  body: string;
  createdAt: number;
  read: boolean;
  /** 跳转目标：审批 → 助手会话；任务 → 任务（附带会话用于选中后聚焦）。 */
  conversationId?: string;
  taskId?: string;
}

let seq = 0;

function newId(now: number): string {
  seq += 1;
  return `ntf-${now.toString(36)}-${seq.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function clip(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  return `${chars.slice(0, Math.max(0, max - 1)).join("")}…`;
}

/** 压成一行（列表里只显示一行）。 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** 校验并归一条通知；不合规返回 null（读盘时逐条丢弃）。 */
export function normalizeNotification(raw: unknown): AppNotification | null {
  if (!isPlainObject(raw)) return null;
  if (typeof raw.id !== "string" || !raw.id) return null;
  if (typeof raw.key !== "string" || !raw.key) return null;
  if (raw.kind !== "task" && raw.kind !== "approval" && raw.kind !== "staff") {
    return null;
  }
  const title = oneLine(typeof raw.title === "string" ? raw.title : "");
  if (!title) return null;
  return {
    id: raw.id,
    kind: raw.kind,
    key: raw.key,
    title: clip(title, MAX_TITLE_CHARS),
    body: clip(oneLine(typeof raw.body === "string" ? raw.body : ""), MAX_BODY_CHARS),
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : Date.now(),
    read: raw.read === true,
    ...(typeof raw.conversationId === "string" ? { conversationId: raw.conversationId } : {}),
    ...(typeof raw.taskId === "string" ? { taskId: raw.taskId } : {}),
  };
}

/** 条数 + 字节双重淘汰（列表最新在前）。 */
export function pruneNotifications(
  items: AppNotification[],
  limit = NOTIFICATIONS_BYTE_LIMIT,
): AppNotification[] {
  const next = [...items]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, MAX_NOTIFICATIONS);
  let bytes = utf8Length(JSON.stringify(next));
  while (bytes > limit && next.length > 1) {
    next.pop();
    bytes = utf8Length(JSON.stringify(next));
  }
  return bytes > limit ? [] : next;
}

/** 读通知列表：缺键/损坏回退空，结构不符的条目丢弃。 */
export function readNotifications(storage: StorageLike = createDefaultStorage()): AppNotification[] {
  return readJson(storage, NOTIFICATIONS_KEY, [] as AppNotification[], (raw) => {
    if (!Array.isArray(raw)) return [];
    return pruneNotifications(
      raw.map(normalizeNotification).filter((n): n is AppNotification => n !== null),
    );
  });
}

export function unreadCount(items: AppNotification[]): number {
  return items.reduce((n, item) => n + (item.read ? 0 : 1), 0);
}

export interface PushInput {
  kind: NotificationKind;
  key: string;
  title: string;
  body?: string;
  conversationId?: string;
  taskId?: string;
  now?: number;
}

interface NotificationState {
  items: AppNotification[];
  /**
   * 记一条通知。返回新条目 id；key 已存在时返回 null（不重复提醒）。
   *
   * 新条目直接置为未读：出现在通知中心里的都是「用户还没看过的」，
   * 已读与否只由打开面板/点击跳转决定。
   */
  push: (input: PushInput) => string | null;
  markRead: (id: string) => void;
  markAllRead: () => void;
  remove: (id: string) => void;
  /**
   * 按去重键删除（d.34）：确认请求裁决/超时后，把对应那条 approval 通知摘掉，
   * 免得用户点开一个已经处理完的「待确认」。
   */
  removeByKey: (key: string) => void;
  /** 清空全部（含未读）：破坏性操作，UI 侧必须先经确认弹窗。 */
  clearAll: () => void;
}

let storage: StorageLike | null = null;

function getStorage(): StorageLike {
  return (storage ??= createDefaultStorage());
}

/** 测试注入点：传 null 恢复默认（jsdom 的 localStorage）。 */
export function setNotificationStorage(next: StorageLike | null): void {
  storage = next;
}

function persist(items: AppNotification[]): AppNotification[] {
  const pruned = pruneNotifications(items);
  writeJson(getStorage(), NOTIFICATIONS_KEY, pruned, NOTIFICATIONS_BYTE_LIMIT);
  return pruned;
}

export const useNotificationStore = create<NotificationState>((set, get) => ({
  items: readNotifications(),

  push: ({ kind, key, title, body = "", conversationId, taskId, now = Date.now() }) => {
    const cleanTitle = oneLine(title);
    if (!key || !cleanTitle) return null;
    if (get().items.some((n) => n.key === key)) return null;
    const item: AppNotification = {
      id: newId(now),
      kind,
      key,
      title: clip(cleanTitle, MAX_TITLE_CHARS),
      body: clip(oneLine(body), MAX_BODY_CHARS),
      createdAt: now,
      read: false,
      ...(conversationId ? { conversationId } : {}),
      ...(taskId ? { taskId } : {}),
    };
    set({ items: persist([item, ...get().items]) });
    return item.id;
  },

  markRead: (id) => {
    let changed = false;
    const next = get().items.map((n) => {
      if (n.id !== id || n.read) return n;
      changed = true;
      return { ...n, read: true };
    });
    if (changed) set({ items: persist(next) });
  },

  markAllRead: () => {
    if (unreadCount(get().items) === 0) return;
    set({ items: persist(get().items.map((n) => (n.read ? n : { ...n, read: true }))) });
  },

  remove: (id) => {
    const next = get().items.filter((n) => n.id !== id);
    if (next.length === get().items.length) return;
    set({ items: persist(next) });
  },

  removeByKey: (key) => {
    const next = get().items.filter((n) => n.key !== key);
    if (next.length === get().items.length) return;
    set({ items: persist(next) });
  },

  clearAll: () => set({ items: persist([]) }),
}));
