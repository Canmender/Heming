import type { EntryUsage } from "./usage.js";
import type { RecallRun } from "./recallLog.js";

/**
 * 记忆导出附块（d.35）。
 *
 * 背景：`MemoryStore.exportAll()` 只含三层数据与设置（d.27/d.28 的刻意设计），
 * 换设备后记忆条目搬走了，但「哪几条常被引用」的权重账本与召回判定依据丢了。
 * 这个模块只负责**可选地把辅助账本附在同一份 JSON 上**，不改变导入语义。
 *
 * 三条边界：
 * 1. 不勾选附块时**逐字节等于 `exportAll()`**——老用户看不出任何差异，
 *    也不给导入端制造新的格式分支；
 * 2. 勾选时 `data` 原样保留，只在顶层加 `aux`：导入方 `importAll` 只认 `data`，
 *    未知字段被忽略，所以带 aux 的文件仍然能正常导入（aux 不进导入）；
 * 3. 数据来源由调用方注入（不在这里抓单例），保持纯函数、可测。
 */

export interface MemoryExportOptions {
  /** 是否附上辅助账本（用量权重 + 召回日志）。默认 false。 */
  includeAux?: boolean;
}

/** 辅助账本：只导出、不导入（导入端刻意不消费）。 */
export interface MemoryAux {
  /** 给用户看的说明，避免把 aux 误当成记忆内容。 */
  note: string;
  /** 条目 id → 注入/疑似引用计数（UsageLedger.snapshot()）。 */
  usage: Record<string, EntryUsage>;
  /** 本机召回档案（RecallLog.list()，按时间升序）。 */
  recallLog: RecallRun[];
}

/** `buildMemoryExport` 需要的最小读口；生产环境由 MemoryStore + RecallRecorder 提供。 */
export interface MemoryExportSource {
  exportAll(): string;
  usageSnapshot(): Record<string, EntryUsage>;
  recallRuns(): RecallRun[];
}

/** 附块说明文案：写死一处，测试与界面提示共用。 */
export const AUX_NOTE =
  "可再生数据：仅导出用于换设备后保留召回权重与判定依据；不参与导入";

/**
 * 生成记忆导出 JSON。
 *
 * 不勾附块：直接返回 `exportAll()` 的原始字符串（不 parse/stringify，保证逐字节一致）。
 * 勾选：解析后在同一对象末尾追加 `aux`，`data` 部分不动。
 */
export function buildMemoryExport(
  source: MemoryExportSource,
  options: MemoryExportOptions = {},
): string {
  const base = source.exportAll();
  if (!options.includeAux) return base;
  // exportAll 永远是合法 JSON；这里解析失败说明上游数据坏了，
  // 让它抛出去由调用方提示，而不是静默退回「不带附块」（用户会以为导出成功了）。
  const parsed = JSON.parse(base) as Record<string, unknown>;
  const aux: MemoryAux = {
    note: AUX_NOTE,
    usage: source.usageSnapshot(),
    recallLog: source.recallRuns(),
  };
  return JSON.stringify({ ...parsed, aux }, null, 2);
}
