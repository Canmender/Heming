/**
 * MCP / REST 共用的错误类型。
 *
 * 为什么单独一个文件：工具实现（`agentTools.ts`）与协议层（`mcp.ts`）都要用这两个类；
 * 放在 `mcp.ts` 里会形成 `mcp → agentTools → mcp` 的运行时循环依赖。
 * 类型定义集中在这里，两边都只依赖它，依赖方向是单向的。
 */

/** 业务失败：MCP 返回 isError 文本，REST 映射成 4xx。 */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

/** 参数不合法：JSON-RPC -32602。 */
export class RpcInvalidParams extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RpcInvalidParams";
  }
}
