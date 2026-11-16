/**
 * 「这一轮跑到一半就没了」的存档（d.189；d.196 改成按会话存多份）。
 *
 * ## 为什么要有
 *
 * 长任务一跑十几分钟。用户中途关窗、切走、电脑睡眠、渲染进程崩掉，回来时只看到
 * 一个已经停住的对话——**没有任何地方记得刚才在做什么**，只能自己回忆着再打一遍。
 * 用户主动点「停止」也是同样的问题：停止之后就再也没有「接着做」的入口了。
 *
 * 这里只做一件事：**在一轮开始时写一个标记，收口时清掉**。下次打开应用（或切回
 * 那个会话）时，如果标记还在且没过期，就说明「那一轮没跑完」，界面给一次「继续」。
 *
 * ## 三条口径
 *
 * 1. **只记录、不 replay**：存的是「哪一轮、谁、什么时候开始」，不是聊天内容——
 *    历史本来就在会话里，重放会把工具再跑一遍。
 * 2. **不假装知道进度**：没有轮次数字可报（那要改 agentStream 的每条事件），
 *    所以文案只说「没跑完」，不说「完成了百分之多少」。
 * 3. **过期即忘**：超过 24 小时自动丢弃——放太久的标记十有八九是上次装完就没再打开，
 *    再弹「继续吗」只会烦人。
 *
 * ## 为什么 d.196 从「只存最近一条」改成「按会话存」
 *
 * 只存一条时，切到另一个会话再回来，上一个会话的标记就没了（写新标记会覆盖），
 * 用户在多会话之间来回看时「哪段活还没做完」这件事完全看不见。改成按会话存之后，
 * 侧栏也能显示「未跑完」徽标；同一时刻只有一轮在跑，所以条数天然很少，20 条封顶。
 */

export const RESUME_KEY = "heming.resumePoint.v1";
/** 超过这个时长就当作陈旧标记丢掉（24 小时）。 */
export const RESUME_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** 最多记多少条（每次开始一轮写一条、收口删一条，正常情况下远小于这个数）。 */
export const RESUME_MAX_POINTS = 20;

export interface ResumePoint {
  conversationId: string;
  streamId: string;
  agentId: string;
  agentName: string;
  startedAt: number;
}

type ResumeMap = Record<string, ResumePoint>;

const listeners = new Set<() => void>();

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // 隐私模式/被禁用的环境：退化成「没有这个功能」，不影响发送
  }
}

function isPoint(value: unknown): value is ResumePoint {
  if (!value || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.conversationId === "string" &&
    p.conversationId.length > 0 &&
    typeof p.streamId === "string" &&
    p.streamId.length > 0 &&
    typeof p.agentId === "string" &&
    typeof p.agentName === "string" &&
    typeof p.startedAt === "number" &&
    Number.isFinite(p.startedAt)
  );
}

/** 读原始存储；顺带兼容 d.189 的「单条」旧格式（升级后不丢已有标记）。 */
function readAll(): ResumeMap {
  const store = storage();
  if (!store) return {};
  let raw: string | null = null;
  try {
    raw = store.getItem(RESUME_KEY);
  } catch {
    return {};
  }
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    writeAll({});
    return {};
  }
  if (isPoint(parsed)) return { [parsed.conversationId]: parsed };
  if (!parsed || typeof parsed !== "object") {
    writeAll({});
    return {};
  }
  const out: ResumeMap = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (isPoint(value) && value.conversationId === key) out[key] = value;
  }
  // 全是坏条目等价于没有：顺手把脏数据清掉，别让它一直躺在存储里
  if (Object.keys(out).length === 0) writeAll({});
  return out;
}

function writeAll(map: ResumeMap): void {
  const store = storage();
  if (!store) return;
  const entries = Object.values(map);
  try {
    if (entries.length === 0) {
      store.removeItem(RESUME_KEY);
    } else {
      store.setItem(RESUME_KEY, JSON.stringify(map));
    }
  } catch {
    /* 配额满等：这是提示功能，失败就当没有 */
  }
}

/** 丢掉过期/超量的标记；返回存活下来的（按开始时间新→旧）。 */
function prune(map: ResumeMap, now: number): ResumeMap {
  const alive = Object.values(map)
    .filter((p) => now - p.startedAt <= RESUME_MAX_AGE_MS)
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, RESUME_MAX_POINTS);
  const out: ResumeMap = {};
  for (const p of alive) out[p.conversationId] = p;
  return out;
}

function emit(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* 单个订阅者出错不影响别人 */
    }
  }
}

/** 一轮开始：记下「这一轮没跑完之前别忘了我」。写失败不影响发送。 */
export function markTurnRunning(point: ResumePoint): void {
  const map = readAll();
  map[point.conversationId] = point;
  writeAll(prune(map, Date.now()));
  emit();
}

/**
 * 收口（成功/失败/用户停止都算）：清掉标记。
 * 传了会话 id 就只清那一条——别的会话里没跑完的活不该被顺手抹掉。
 */
export function clearTurnRunning(conversationId?: string): void {
  const map = readAll();
  if (conversationId) {
    if (!map[conversationId]) return; // 没这条就不写盘、也不通知
    delete map[conversationId];
  } else {
    for (const key of Object.keys(map)) delete map[key];
  }
  writeAll(map);
  emit();
}

/**
 * 读存档：只返回**可信**的标记——解析失败、结构不对、过期都返回 null。
 * 给了会话 id 就只认那一个；没给就返回最近的。
 */
export function loadResumePoint(
  conversationId?: string,
  now: number = Date.now(),
): ResumePoint | null {
  const map = readAll();
  const alive = prune(map, now);
  if (Object.keys(alive).length !== Object.keys(map).length) {
    writeAll(alive);
    emit();
  }
  if (conversationId) return alive[conversationId] ?? null;
  const newest = Object.values(alive).sort((a, b) => b.startedAt - a.startedAt)[0];
  return newest ?? null;
}

/** 所有还没跑完的会话（侧栏徽标用），新→旧。 */
export function listResumePoints(now: number = Date.now()): ResumePoint[] {
  const map = readAll();
  const alive = prune(map, now);
  if (Object.keys(alive).length !== Object.keys(map).length) {
    writeAll(alive);
    emit();
  }
  return Object.values(alive).sort((a, b) => b.startedAt - a.startedAt);
}

/**
 * 订阅标记变化（开始/收口/过期清理都会通知）。
 * 侧栏徽标靠它刷新——写标记发生在 ChatPage，侧栏不该为这件事轮询。
 */
export function subscribeResumePoints(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 测试与「清空所有本机数据」共用。 */
export function resetResumePoint(): void {
  clearTurnRunning();
  listeners.clear();
}
