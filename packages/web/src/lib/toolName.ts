/**
 * 工具名的展示形态。
 *
 * MCP 工具在模型接口里必须全局唯一，命名约定是 `服务名__工具名`（见 lib/mcp/bridge.ts）。
 * 这个内部名会出现在确认弹窗、工具轨迹、分叉预览与审计留痕里——直接展示双下划线像代码，
 * 统一换成「服务 · 工具」。**只影响展示**：裁决、执行、留痕的键仍是原始 `name`。
 *
 * 只在「恰好一个分隔符且两段都非空」时格式化：工具名本身可能含下划线，
 * 但 `a__b__c` 这种无法判断边界的情况保持原样，宁可不美化也不改写语义。
 */
export function toolNameLabel(name: string): string {
  const raw = (name ?? "").trim();
  const parts = raw.split("__");
  if (parts.length !== 2) return raw;
  const [server, tool] = parts;
  if (!server || !tool) return raw;
  return `${server} · ${tool}`;
}
