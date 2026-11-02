import { createRolloutLog, type RolloutLog } from "./log.js";
import type { RolloutInput } from "./types.js";

export * from "./types.js";
export { ROLLOUT_INDEX_KEY, ROLLOUT_KEY_PREFIX, MAX_ITEMS_PER_STREAM, MAX_STREAMS, MAX_TEXT_CHARS } from "./log.js";
export { createRolloutLog, normalizeItems, type RolloutLog, type RolloutLogOptions } from "./log.js";
export * from "./pair.js";
export * from "./fork.js";
export * from "./view.js";

/**
 * 本机默认日志（localStorage；不可用时降级为内存）。
 *
 * 只在本机：这里记的是明文回合过程，与「服务端只见信封」不冲突（本机明文缓存已有先例），
 * 但**不能**混进会话导出——导出带的是消息，日志带的是内部过程（含被拒调用的参数）。
 */
export const rolloutLog: RolloutLog = createRolloutLog();

/** 记录一条事件；失败静默（日志不该影响对话）。 */
export function recordRollout(item: RolloutInput): void {
  rolloutLog.append(item);
}
