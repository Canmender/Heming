/**
 * 「智能体」分区顶部的一句汇总（d.343）：哪些还没落盘、哪些还没配模型。
 *
 * 逐个往下翻才知道「我改的那几个写进去了没有」太费事，而这两类都是**待办**：
 * 改了没写进配置的，下次启动不会生效；没配模型的，那个工具还在用它自己的默认。
 */
export interface AgentCounts {
  /** 本机认出来的工具数（只读、没有 id 的不计入）。 */
  total: number;
  /** 选了但还没写进配置的工具数。 */
  dirty: number;
  /** 还没配模型（或者配的还是它自己的默认）的工具数。 */
  unset: number;
}

/**
 * 一句话汇总；两类都是 0 时返回空串，调用方据此不渲染——
 * 没有待办就不要在顶上多一行字。
 */
export function agentSummary(counts: AgentCounts): string {
  const parts: string[] = [];
  if (counts.dirty > 0) parts.push(`${counts.dirty} 个工具改了还没写进去`);
  if (counts.unset > 0) parts.push(`${counts.unset} 个还没配模型`);
  if (parts.length === 0) return "";
  return `${parts.join("；")}。`;
}
