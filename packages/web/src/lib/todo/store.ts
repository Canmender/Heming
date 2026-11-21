/**
 * 会话级任务清单（`todo_write` 工具的落点）。
 *
 * 为什么要有它：智能体「无法处理长任务」的表现之一，是**计划只活在模型的上下文里**——
 * 十几步做完一半、撞到工具轮次上限或上下文压缩，前面「我打算做哪几步」就没了，
 * 用户看到的是一次次重来的半成品。把清单放到会话级的持久状态里，模型每一步都能读回
 * 自己承诺过什么（工具返回整份清单），重新接话时也不会从零猜。
 *
 * 三条口径：
 * - **整份替换**（与 DSH `tool-todo` 同语义）：模型每次给完整列表，不做增量 diff——
 *   增量合并的中间态最难排查（到底是模型少给了一条，还是合并逻辑吞了）。
 * - **一个会话一份**：按 `conversationId` 隔离，A 会话的计划不会出现在 B 会话里。
 * - **落 localStorage 但有上限**：重开应用还能接着做（长任务的现实），
 *   但只留最近 `MAX_STORED_LISTS` 个会话，避免把网站数据当草稿纸用。
 *
 * 这里只管数据，不碰 UI；渲染留给消息流 / 侧栏（v1 由工具返回文本承担）。
 */

/** 单条任务的三种状态，与 DSH 的 todo 语义一致（三态而不是布尔）。 */
export type TodoStatus = "pending" | "in_progress" | "completed";

/** 一条任务。**内容不写工具名/文件名之外的隐私**：它会进 localStorage 与工具回显。 */
export interface TodoItem {
  content: string;
  status: TodoStatus;
}

/** 一个会话最多几条：长任务要的是「能看见骨架」，20 条以上说明该拆阶段了。 */
export const MAX_TODOS = 20;

/** 单条内容上限：一条 todo 只能是「一步」，写成长段落就失去清单的意义。 */
export const TODO_CONTENT_MAX = 200;

/** 最多保留几个会话的清单（按最近更新淘汰）。 */
export const MAX_STORED_LISTS = 50;

/** localStorage 键：与 HITL/文件根的键同前缀风格，便于用户与排障脚本一起找到。 */
export const TODOS_KEY = "heming.todos.v1";

/** 内存态：`conversationId → 清单`。作为 localStorage 的读缓存，避免每条消息都 JSON.parse。 */
const lists = new Map<string, TodoItem[]>();

/**
 * 每个会话清单的「最近更新」序号：内存与存储的裁剪都按它淘汰（同一份口径）。
 *
 * 用单调序号而不是 Date.now()：同一毫秒内连写多个会话是常态（测试与批量更新都会），
 * 时间戳相等时排序不稳定，淘汰谁就成了随机——「只留 50 个」必须可复现。
 */
const touchedAt = new Map<string, number>();

/** 单调递增的更新序号。 */
let clock = 0;

function tick(): number {
  clock += 1;
  return clock;
}

/**
 * 变更订阅者：UI（输入栏上方的清单）要在模型写入清单后**立刻**看见，而不是等下一轮渲染。
 *
 * 订阅回调带上变化的会话 id：一个会话的清单变了，渲染着别的会话的组件不必重算。
 * 回调抛错要被吞掉——UI 里某个小组件崩了，不能连带把「清单已写入」这个事实丢掉。
 */
type TodoListener = (conversationId?: string) => void;

const listeners = new Set<TodoListener>();

/** 订阅清单变更；返回退订函数（useEffect 的 cleanup 直接用）。 */
export function subscribeTodos(listener: TodoListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit(conversationId?: string): void {
  for (const listener of [...listeners]) {
    try {
      listener(conversationId);
    } catch {
      // 单个订阅者出错不影响其余订阅者（清单是事实，UI 是投影）。
    }
  }
}

/** 是否已从 localStorage 装载过（第一次访问才读，避免模块加载时依赖存储可用）。 */
let loaded = false;

/**
 * localStorage 里存的形状：会话 id → { items, updatedAt, seq }。
 * `seq` 是落盘时的 touchedAt 单调序号——它是跨重启还原「最近更新」次序的唯一凭据：
 * `updatedAt` 在每次 persist 里被整批写成同一个毫秒，无法区分谁更近用过。
 */
type StoredLists = Record<string, { items: TodoItem[]; updatedAt: number; seq?: number }>;

/** 存储不可用（隐私模式/配额满）时静默降级成纯内存——清单丢了也不该让对话失败。 */
function readStorage(): StoredLists {
  try {
    const raw = localStorage.getItem(TODOS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as StoredLists;
  } catch {
    return {};
  }
}

function writeStorage(next: StoredLists): void {
  try {
    localStorage.setItem(TODOS_KEY, JSON.stringify(next));
  } catch {
    // 配额满 / 禁用存储：内存态仍然有效，这一轮照样能接着做。
  }
}

/**
 * 把内存态写回存储，并按最近更新裁剪到 `MAX_STORED_LISTS` 个会话。
 *
 * `touched` 是本次变动的会话 id：清单被清空时它在内存里已经不存在了，
 * 光遍历 `lists` 删不掉存储里的旧条目（那会表现出「清空了，重开又回来了」）。
 */
function persist(touched?: string): void {
  const stored = readStorage();
  if (touched && !lists.has(touched)) delete stored[touched];
  for (const [conversationId, items] of lists) {
    if (items.length === 0) {
      delete stored[conversationId];
      continue;
    }
    stored[conversationId] = { items, updatedAt: Date.now(), seq: touchedAt.get(conversationId) ?? 0 };
  }
  const entries = Object.entries(stored)
    .filter(([, value]) => Array.isArray(value?.items) && value.items.length > 0)
    // 排序键用内存里的更新序号（跨会话可比、同毫秒也稳定）；没有序号的旧条目退回时间戳。
    .sort((a, b) => (touchedAt.get(b[0]) ?? 0) - (touchedAt.get(a[0]) ?? 0))
    .slice(0, MAX_STORED_LISTS);
  const kept = new Set(entries.map(([conversationId]) => conversationId));
  // 内存也跟着裁剪：否则「存储只留 50 个」只是纸面约束，进程里还会一直涨。
  for (const conversationId of [...lists.keys()]) {
    if (!kept.has(conversationId)) {
      lists.delete(conversationId);
      touchedAt.delete(conversationId);
    }
  }
  writeStorage(Object.fromEntries(entries));
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  const stored = Object.entries(readStorage())
    // 按落盘序号 seq 从旧到新：旧的先 tick（序号小）、新的后 tick（序号大），
    // 这样重开应用后「最近更新」的次序与关掉前一致，超限淘汰的才是最久没用的那份。
    //
    // 不能按 Object.entries 的遍历序直接 tick——persist() 写盘时是 MRU 在前的，
    // 照遍历序递增会让最常用那份拿到最小序号、下一次超限先被淘汰的恰恰是它
    // （静默丢数据）。也不能依赖对象键顺序：数字样式的会话 id 会被 JS 重排。
    // 旧版本条目没有 seq：退回 updatedAt；再没有就当最旧（0）。
    .sort((a, b) => (a[1]?.seq ?? a[1]?.updatedAt ?? 0) - (b[1]?.seq ?? b[1]?.updatedAt ?? 0));
  for (const [conversationId, value] of stored) {
    if (!Array.isArray(value?.items)) continue;
    // 存储里的条目可能是旧版本写的：逐条过一遍校验，坏的直接丢，不整份作废。
    const items = value.items.filter(
      (item): item is TodoItem =>
        !!item &&
        typeof item.content === "string" &&
        item.content.trim().length > 0 &&
        (item.status === "pending" || item.status === "in_progress" || item.status === "completed"),
    );
    if (items.length > 0) {
      lists.set(conversationId, items.slice(0, MAX_TODOS));
      touchedAt.set(conversationId, tick());
    }
  }
}

/** 读清单（返回副本：调用方不能绕过 setTodos 改内部状态）。 */
export function getTodos(conversationId: string): TodoItem[] {
  ensureLoaded();
  return (lists.get(conversationId) ?? []).map((item) => ({ ...item }));
}

/** 整份替换。`[]` 表示清空（存储里也会删掉这个会话）。 */
export function setTodos(conversationId: string, items: readonly TodoItem[]): void {
  ensureLoaded();
  if (items.length === 0) {
    lists.delete(conversationId);
    touchedAt.delete(conversationId);
  } else {
    lists.set(
      conversationId,
      items.map((item) => ({ content: item.content, status: item.status })),
    );
    touchedAt.set(conversationId, tick());
  }
  persist(conversationId);
  emit(conversationId);
}

/** 清空一个会话的清单（会话删除时调用；当前 UI 还没有「清空计划」按钮）。 */
export function clearTodos(conversationId: string): void {
  setTodos(conversationId, []);
}

/** 测试与「换账号」场景用：清内存缓存并允许下次重新从存储装载。 */
export function resetTodoStore(): void {
  lists.clear();
  touchedAt.clear();
  clock = 0;
  loaded = false;
  emit();
}

/** 计数：工具回显与（后续）进度条共用一份口径，避免两处算法不同。 */
export function countTodos(items: readonly TodoItem[]): {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
} {
  let pending = 0;
  let inProgress = 0;
  let completed = 0;
  for (const item of items) {
    if (item.status === "completed") completed += 1;
    else if (item.status === "in_progress") inProgress += 1;
    else pending += 1;
  }
  return { total: items.length, pending, inProgress, completed };
}

/** 状态标记：模型读回清单时要能一眼看出哪条在做、哪条没做。 */
function marker(status: TodoStatus): string {
  if (status === "completed") return "[x]";
  if (status === "in_progress") return "[>]";
  return "[ ]";
}

/** 把清单渲染成给模型/用户看的纯文本：编号 + 状态 + 内容，末尾一行进度。 */
export function formatTodos(items: readonly TodoItem[]): string {
  if (items.length === 0) return "（空清单）";
  const counts = countTodos(items);
  const head = `进度：${counts.completed}/${counts.total} 已完成，${counts.inProgress} 进行中，${counts.pending} 待开始`;
  const body = items
    .map((item, index) => `${index + 1}. ${marker(item.status)} ${item.content}`)
    .join("\n");
  return `${head}\n${body}`;
}
