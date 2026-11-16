import type { ToolBridge } from "../agentStream.js";

/**
 * 计划模式（d.173）：本轮只读、先出方案，不动文件。
 *
 * 为什么要有它：和鸣的智能体默认「能改就直接改」。对「把首页配色换成这个设计稿」
 * 这类需求，先读、先给改法计划、用户点头再动手，比一上来连改七个文件更省事——
 * 这正是 opencode / Claude Code 把「plan mode」做成常驻开关的理由。
 *
 * 口径三条：
 * 1. **按风险过滤，不按名字白名单**：写类工具会随版本增加（d.170 又多了 file_undo），
 *    硬编码名字必然漏。判据只认桥自己声明的 `meta(name).risk`。
 * 2. **风险不明的一律不给**：MCP 等第三方工具没有可信风险声明，计划模式下宁可少给，
 *    也不能让一个「以为是只读」的工具真的写盘。
 * 3. **执行层同样拦住**：只从 `tools` 里摘掉是不够的——模型可能在历史里记得某个工具名
 *    并继续调用，所以 `execute` 也要回一句明确的「本轮计划模式，没有执行」。
 */

/** 会话 → 是否开启计划模式（只存开着的会话，省得像布尔矩阵一样膨胀）。 */
export const PLAN_MODE_KEY = "heming.planMode.v1";
/** 最多记多少个会话：超了按最近优先丢最旧的，避免 localStorage 无限增长。 */
export const PLAN_MODE_MAX_ROOMS = 50;

/**
 * 「接受计划、开始执行」发给模型的口令（d.173）。
 *
 * 不重发原提问：同 `retryStream` 的理由——重发会让模型看到同一问题被问两次、
 * 已经执行过的工具再跑一遍。计划与被读过的文件都已在历史里，它知道从哪接。
 */
export const PLAN_EXECUTE_PROMPT =
  "照上面这份计划开始执行。每完成一步就更新任务清单；改完先自己验证，再汇报结果（改了哪些文件、怎么验证的、还有什么没做）。";
export const PLAN_MODE_BLOCK_TEXT =
  "本轮是计划模式：只读不改，这次调用没有执行。先把事实读完、把改法计划写清楚（改哪些文件、按什么顺序、怎么验证），等用户确认后再动手。";

interface PlanModeRecord {
  /** 会话 id → 最后更新时间（毫秒）。 */
  rooms: Record<string, number>;
}

/**
 * 单调递增的时间戳。
 *
 * 为什么不用裸 `Date.now()`：同一毫秒里连开 55 个会话是常态（测试里就是一次循环），
 * 时间戳全相等时 `sort` 的稳定性会把「插入顺序」当成结论，于是淘汰的是**最新**的那个、
 * 留下的是最旧的 —— 内存里看着正常，重启后「刚开的」反而没了。
 * 这条教训在 `lib/todo/store.ts` 的 `tick()` 上已经踩过一次。
 */
let lastStamp = 0;
function stamp(): number {
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  return lastStamp;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function read(): PlanModeRecord {
  const store = storage();
  if (!store) return { rooms: {} };
  try {
    const raw = store.getItem(PLAN_MODE_KEY);
    if (!raw) return { rooms: {} };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { rooms: {} };
    const rooms = (parsed as { rooms?: unknown }).rooms;
    if (!rooms || typeof rooms !== "object") return { rooms: {} };
    const out: Record<string, number> = {};
    for (const [id, at] of Object.entries(rooms as Record<string, unknown>)) {
      if (typeof id === "string" && id.length > 0 && typeof at === "number" && Number.isFinite(at)) {
        out[id] = at;
      }
    }
    return { rooms: out };
  } catch {
    // 坏 JSON 当作没开过：计划模式不是安全边界，读坏了大不了重开一次。
    return { rooms: {} };
  }
}

function write(record: PlanModeRecord): boolean {
  const store = storage();
  if (!store) return false;
  const ids = Object.keys(record.rooms);
  if (ids.length > PLAN_MODE_MAX_ROOMS) {
    const kept = ids
      .sort((a, b) => (record.rooms[b] ?? 0) - (record.rooms[a] ?? 0))
      .slice(0, PLAN_MODE_MAX_ROOMS);
    const next: Record<string, number> = {};
    for (const id of kept) next[id] = record.rooms[id] ?? 0;
    record = { rooms: next };
  }
  try {
    store.setItem(PLAN_MODE_KEY, JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

/** 该会话这一轮是不是计划模式。无 id（未落库的新对话）当作关闭。 */
export function loadPlanMode(conversationId: string | undefined): boolean {
  if (!conversationId) return false;
  const record = read();
  return Object.prototype.hasOwnProperty.call(record.rooms, conversationId);
}

/** 开/关某个会话的计划模式；返回是否真的写进了存储。 */
export function savePlanMode(conversationId: string | undefined, enabled: boolean): boolean {
  if (!conversationId) return false;
  const record = read();
  if (enabled) record.rooms[conversationId] = stamp();
  else delete record.rooms[conversationId];
  return write(record);
}

/** 清空（测试与「全部重置」用）。 */
export function resetPlanMode(): void {
  const store = storage();
  try {
    store?.removeItem(PLAN_MODE_KEY);
  } catch {
    /* 存储不可用就什么都不用做 */
  }
}

/** 这个风险等级算不算「会改东西」。 */
export function isWriteRisk(risk: unknown): boolean {
  return risk === "write" || risk === "danger";
}

/** 从 OpenAI 工具规格里取名字（拿不到名字就无法判断风险，计划模式下也不给）。 */
function specName(spec: unknown): string | null {
  if (!spec || typeof spec !== "object") return null;
  const fn = (spec as { function?: { name?: unknown } }).function;
  const name = fn && typeof fn === "object" ? fn.name : undefined;
  return typeof name === "string" && name.length > 0 ? name : null;
}

/** 这个工具在本轮是否允许出现/执行（只读才允许；风险不明一律不许）。 */
export function planModeAllows(bridge: ToolBridge, name: string): boolean {
  const risk = bridge.meta?.(name)?.risk;
  return risk === "read";
}

/**
 * 给桥套上计划模式：工具清单只留只读的，执行层再拦一次。
 *
 * 返回的桥保留原 `execute`/`meta` 的引用，只是过滤了 `tools`；这样 `toolMetaOf`
 * 查到的仍是同一份风险声明（提示词、闸门、执行三处不会各说一套）。
 */
export function withPlanMode(bridge: ToolBridge): ToolBridge {
  const tools = bridge.tools.filter((spec) => {
    const name = specName(spec);
    return name !== null && planModeAllows(bridge, name);
  });
  return {
    tools,
    meta: (name: string) => bridge.meta?.(name),
    execute: async (call, opts) => {
      if (!planModeAllows(bridge, call.name)) {
        return {
          text: PLAN_MODE_BLOCK_TEXT,
          ok: false,
          error: { error_code: "plan-mode", hint: "计划模式下只读：先给方案，用户确认后再改。" },
        };
      }
      return bridge.execute(call, opts);
    },
  };
}
