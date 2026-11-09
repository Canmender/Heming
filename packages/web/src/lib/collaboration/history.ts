/**
 * 协作历史（只保留最近一次，纯本地）。
 *
 * 需求是「本次会话内保留最近一次运行即可」；这里额外落一份 localStorage，
 * 方便刷新后还能看见上次纪要。写盘有硬限制：
 * - 只存 1 条（覆盖写），不累积；
 * - 序列化后超过 `MAX_SERIALIZED` 会先截断每个回合的正文，仍超限则丢弃正文；
 * - 不写服务端，不含模型 Key / 账号信息（run 本身就没有这些字段）。
 */

import type { CollaborationRun, CollaborationTurn } from "./types.js";

export const COLLAB_HISTORY_KEY = "heming.collab.last.v1";
/** 单条记录的字符上限（localStorage 常见配额 5MB，这里刻意只占很小一块）。 */
export const COLLAB_HISTORY_MAX_CHARS = 80_000;
const MAX_TURN_TEXT = 8_000;

type ReadStore = Pick<Storage, "getItem">;
type WriteStore = Pick<Storage, "setItem">;

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function slimTurns(turns: CollaborationTurn[], textLimit: number): CollaborationTurn[] {
  return turns.map((turn) => ({
    ...turn,
    text: turn.text.slice(0, textLimit),
    streaming: false,
  }));
}

/** 保存最近一次运行（覆盖）。写失败静默：历史只是便利功能。 */
export function saveLastRun(
  run: CollaborationRun,
  store: WriteStore | null = storage(),
): void {
  if (!store) return;
  try {
    const base: CollaborationRun = {
      ...run,
      participants: run.participants.map(({ agentId, name }) => ({ agentId, name })),
      turns: slimTurns(run.turns, MAX_TURN_TEXT),
    };
    let json = JSON.stringify(base);
    if (json.length > COLLAB_HISTORY_MAX_CHARS) {
      const budget = Math.max(
        200,
        Math.floor(COLLAB_HISTORY_MAX_CHARS / Math.max(1, base.turns.length)) - 400,
      );
      json = JSON.stringify({ ...base, turns: slimTurns(base.turns, budget) });
    }
    if (json.length > COLLAB_HISTORY_MAX_CHARS) {
      json = JSON.stringify({ ...base, turns: slimTurns(base.turns, 0) });
    }
    store.setItem(COLLAB_HISTORY_KEY, json);
  } catch {
    /* 配额满 / 隐私模式：忽略 */
  }
}

function readStatus(value: unknown): CollaborationRun["status"] {
  if (value === "done" || value === "aborted" || value === "error") return value;
  // 上次写入时还在运行（应用被关掉）：按中止展示已产生的回合。
  return "aborted";
}

function readTurn(value: unknown): CollaborationTurn | null {
  if (!value || typeof value !== "object") return null;
  const t = value as Partial<CollaborationTurn>;
  if (typeof t.id !== "string") return null;
  return {
    id: t.id,
    agentId: String(t.agentId ?? ""),
    agentName: String(t.agentName ?? ""),
    role: String(t.role ?? ""),
    round: Number.isFinite(t.round) ? Number(t.round) : 0,
    text: typeof t.text === "string" ? t.text.slice(0, MAX_TURN_TEXT) : "",
    startedAt: Number.isFinite(t.startedAt) ? Number(t.startedAt) : 0,
    endedAt: Number.isFinite(t.endedAt) ? Number(t.endedAt) : 0,
    ...(t.error ? { error: String(t.error).slice(0, 2_000) } : {}),
    ...(t.aborted ? { aborted: true } : {}),
  };
}

/** 读取最近一次运行；脏数据/超限/损坏一律返回 null（不猜）。 */
export function loadLastRun(store: ReadStore | null = storage()): CollaborationRun | null {
  if (!store) return null;
  try {
    const raw = store.getItem(COLLAB_HISTORY_KEY);
    if (!raw || raw.length > COLLAB_HISTORY_MAX_CHARS) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const run = parsed as Partial<CollaborationRun>;
    if (run.mode !== "sequential" && run.mode !== "supervisor" && run.mode !== "debate") {
      return null;
    }
    if (!Array.isArray(run.turns) || !Array.isArray(run.participants)) return null;
    if (typeof run.task !== "string") return null;
    const turns = run.turns.map(readTurn).filter((t): t is CollaborationTurn => t !== null);
    return {
      id: typeof run.id === "string" ? run.id : "history",
      mode: run.mode,
      task: run.task.slice(0, 20_000),
      participants: run.participants
        .filter(
          (p): p is { agentId: string; name: string } =>
            !!p && typeof p.agentId === "string" && typeof p.name === "string",
        )
        .map(({ agentId, name }) => ({ agentId, name })),
      rounds: Math.min(3, Math.max(1, Number(run.rounds) || 1)),
      turns,
      status: readStatus(run.status),
      startedAt: Number.isFinite(run.startedAt) ? Number(run.startedAt) : 0,
      ...(Number.isFinite(run.endedAt) ? { endedAt: Number(run.endedAt) } : {}),
      ...(run.error ? { error: String(run.error).slice(0, 2_000) } : {}),
    };
  } catch {
    return null;
  }
}

/** 清空历史（用户主动「清除」时用）。 */
export function clearLastRun(store: Pick<Storage, "removeItem"> | null = storage()): void {
  if (!store) return;
  try {
    store.removeItem(COLLAB_HISTORY_KEY);
  } catch {
    /* 忽略 */
  }
}
