/**
 * 「一眼能认出这次调用」的短文本：进度行、审批提示共用一份。
 *
 * 单独成模块的理由：审批（`approvals.ts`）与进度（`run.ts`）都要把一次工具调用
 * 压缩成一行人话。如果各写一份，终端里的提示与审批框里的摘要迟早对不上——
 * 用户会以为自己批准的和实际执行的不是同一件事。
 *
 * 刻意**不打印整段参数**：`file_write` 的参数里是整份文件内容，倒进终端日志
 * 既吵又可能把敏感内容留在滚动缓冲里。
 */

/** 一行化 + 截断（只给人看，不承载完整参数）。 */
export function oneLine(text: string, max = 80): string {
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * 从工具参数里挑「一眼能认出这次调用」的几个字段。
 *
 * 返回形如 ` command=git status`（带前导空格，方便直接拼进一行），挑不到就返回空串。
 */
export function describeCallArgs(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
    const record = parsed as Record<string, unknown>;
    for (const key of ["command", "path", "pattern", "query", "url", "glob", "file"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return ` ${key}=${oneLine(value)}`;
    }
  } catch {
    /* 参数不是 JSON：进度行不展示，工具层会给出正式失败原因 */
  }
  return "";
}