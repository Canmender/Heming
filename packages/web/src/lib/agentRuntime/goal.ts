/**
 * 会话级「目标」（d.201）：一句话说明这次会话到底要达成什么。
 *
 * 为什么需要它：任务清单（`lib/todo/store.ts`）记的是**步骤**，长任务里真正会丢的是**终点**——
 * 跑了几十轮、压缩过几次之后，模型知道「清单第 3 项还没打勾」，却忘了「我们做这一切是为了什么」，
 * 于是把清单做完就当交付，或者半路拐去做顺手的另一件事。
 *
 * 三条口径：
 * - **一个会话一个目标**：按 `conversationId` 隔离；有目标就用新的覆盖（用户改主意是常态，
 *   保存历史目标只会让提示词里出现两个「目标」）。
 * - **只存活跃目标**：完成的/清除的直接删掉，不留在提示词里——已经达成的目标写进系统提示词
 *   只会让模型继续围着它转。
 * - **落 localStorage 但只留最近 50 个会话**：换会话/重开应用还能接着做，又不把网站数据当草稿纸。
 *
 * 这里只管数据；界面（GoalBar）与提示词（`runtimePrompt`）各自读它。
 */

/** 一个会话的目标。 */
export interface SessionGoal {
  /** 用户写的一句话目标（已 trim；不含隐私，会进 localStorage 与系统提示词）。 */
  text: string;
  /** 设定时间（毫秒）。 */
  createdAt: number;
}

/** 目标文本上限：一句话说清「要达成什么」；写成段落就没人读了。 */
export const GOAL_TEXT_MAX = 300;

/**
 * 按 Unicode 码点取前 max 个（d.412 回归）：String.slice 按 UTF-16 单元切，
 * 边界落在 emoji/扩展汉字中间会劈出落单代理；目标文本会进系统提示词，不能带乱码。
 */
function clipGoalText(text: string, max: number): string {
  const points = Array.from(text);
  return points.length > max ? points.slice(0, max).join("") : text;
}

/** 最多保留几个会话的目标（按最近写入淘汰）。 */
export const MAX_STORED_GOALS = 50;

/** localStorage 键：与清单/文件根同前缀风格，便于排障时一起找到。 */
export const GOALS_KEY = "heming.goal.v1";

/** 内存态：`conversationId → 目标`。 */
const goals = new Map<string, SessionGoal>();

/** 写入序号：裁剪按它淘汰，同毫秒连写也稳定（理由同 `lib/todo/store.ts` 的 `touchedAt`）。 */
const touchedAt = new Map<string, number>();
let clock = 0;

function tick(): number {
  clock += 1;
  return clock;
}

type GoalListener = (conversationId?: string) => void;
const listeners = new Set<GoalListener>();

/** 订阅目标变更；返回退订函数。 */
export function subscribeGoals(listener: GoalListener): () => void {
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
      // 单个订阅者崩了不影响其余：目标是事实，界面是投影。
    }
  }
}

let loaded = false;

type StoredGoal = {
  text: string;
  createdAt: number;
  /** 跨重启的最近使用序号：与 todo/store.ts 的 seq 同理，persist 改写所有条目的 createdAt，
   *  单靠它无法分辨谁最近用过；没有这个单调序号，重开后刚用过的那份反而被当成最旧淘汰。 */
  seq?: number;
};
type StoredGoals = Record<string, StoredGoal>;

function readStorage(): StoredGoals {
  try {
    const raw = localStorage.getItem(GOALS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as StoredGoals;
  } catch {
    return {};
  }
}

function writeStorage(next: StoredGoals): void {
  try {
    localStorage.setItem(GOALS_KEY, JSON.stringify(next));
  } catch {
    // 隐私模式/配额满：内存态仍然有效，这一轮照样能用目标。
  }
}

function persist(touched?: string): void {
  const stored = readStorage();
  if (touched && !goals.has(touched)) delete stored[touched];
  for (const [conversationId, goal] of goals) {
    // 把内存里的单调使用序号一并落盘，重开时才能按真实最近使用恢复淘汰顺序。
    stored[conversationId] = { ...goal, seq: touchedAt.get(conversationId) ?? 0 };
  }
  const entries = Object.entries(stored)
    .filter(([, value]) => typeof value?.text === "string" && value.text.trim().length > 0)
    .sort((a, b) => (touchedAt.get(b[0]) ?? 0) - (touchedAt.get(a[0]) ?? 0))
    .slice(0, MAX_STORED_GOALS);
  const kept = new Set(entries.map(([conversationId]) => conversationId));
  for (const conversationId of [...goals.keys()]) {
    if (!kept.has(conversationId)) {
      goals.delete(conversationId);
      touchedAt.delete(conversationId);
    }
  }
  writeStorage(Object.fromEntries(entries));
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  const stored = readStorage();
  // 按落盘的使用序号升序恢复：序号小的（最久没用）先 tick，序号大的（最近用过）后 tick，
  // 这样下次 persist 淘汰时才会先删最久没用的那份，而不是刚重开读到的第一条。
  const ordered = Object.entries(stored).sort(
    ([, a], [, b]) => (a?.seq ?? 0) - (b?.seq ?? 0),
  );
  for (const [conversationId, value] of ordered) {
    if (typeof value?.text !== "string") continue;
    const text = clipGoalText(value.text.trim(), GOAL_TEXT_MAX);
    if (!text) continue;
    goals.set(conversationId, {
      text,
      createdAt: typeof value.createdAt === "number" && Number.isFinite(value.createdAt) ? value.createdAt : Date.now(),
    });
    touchedAt.set(conversationId, tick());
  }
}

/** 读一个会话的目标；没有返回 null。 */
export function getGoal(conversationId: string): SessionGoal | null {
  ensureLoaded();
  const goal = goals.get(conversationId);
  return goal ? { ...goal } : null;
}

/**
 * 设定/替换目标。文本为空（或只有空白）时清除并返回 null——不要让空目标进提示词。
 */
export function setGoal(conversationId: string, text: string, now = Date.now()): SessionGoal | null {
  ensureLoaded();
  const trimmed = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!trimmed) {
    clearGoal(conversationId);
    return null;
  }
  const goal: SessionGoal = { text: clipGoalText(trimmed, GOAL_TEXT_MAX), createdAt: now };
  goals.set(conversationId, goal);
  touchedAt.set(conversationId, tick());
  persist(conversationId);
  emit(conversationId);
  return { ...goal };
}

/** 清除目标（用户说「不做了」/ 会话删除）。 */
export function clearGoal(conversationId: string): void {
  ensureLoaded();
  if (!goals.has(conversationId)) return;
  goals.delete(conversationId);
  touchedAt.delete(conversationId);
  persist(conversationId);
  emit(conversationId);
}

/** 测试与换账号用：清内存缓存并允许下次重新装载。 */
export function resetGoalStore(): void {
  goals.clear();
  touchedAt.clear();
  clock = 0;
  loaded = false;
  emit();
}

/** 目标是否「值得写进提示词」：有且非空（现在的模型只看到活跃目标）。 */
export function goalForPrompt(conversationId: string): string | null {
  const goal = getGoal(conversationId);
  const text = goal?.text.trim() ?? "";
  return text ? text : null;
}
