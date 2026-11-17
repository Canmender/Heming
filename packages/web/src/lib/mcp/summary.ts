/**
 * MCP 连接状况的只读快照（d.223）。
 *
 * ## 为什么
 *
 * 工具清单里出现 MCP 工具，不等于那台服务此刻连得上：服务进程第二天没起来、配置写错了、
 * 或者启动时连过一次之后掉线（`state: "stale"`），模型照样会在清单里看见这些工具，
 * 然后一次次调用失败。失败统计（d.221）只会说「这个会话失败了 3 次」，说不出
 * 「失败是因为那台服务没连上」——用户于是去改模型、改提示词，改不到点上。
 *
 * ## 口径
 *
 * - 只统计**已启用**的服务：用户主动关掉的服务不参与「没连上」的告警。
 * - `connected` 只认最近一次连接尝试的结果（`McpServerStatus` 的注释已经写明：缓存清单
 *   不能当连接状态用）。
 * - 没有连接记录的服务单独算 `pending`，不说成失败——刚配置完还没连，与连失败是两件事。
 * - 失败原因原样带出来（`error` 是运行时给的短句），这里不改写、不翻译。
 */

/** 只依赖这三个字段，测试不必造完整的 `McpServerConfig`。 */
export interface McpServerSnapshot {
  id: string;
  name: string;
  enabled: boolean;
}

export type McpConnectState = "connected" | "stale" | "error";

/** 与 `McpServerStatus` 的结构兼容（只读这三项）。 */
export interface McpConnectStatus {
  state: McpConnectState;
  error?: string;
  tools?: number;
}

export interface McpStatusSnapshot {
  /** 配置里的服务总数（含已停用）。 */
  total: number;
  /** 已启用的服务数。 */
  enabled: number;
  /** 已启用且最近一次连接成功。 */
  connected: number;
  /** 已启用、有连接记录但不是成功（stale / error）。 */
  failed: readonly { name: string; state: McpConnectState; error?: string }[];
  /** 已启用、但本进程还没尝试连接过。 */
  pending: number;
  /** 已启用工具的条数（模型能看到的 MCP 工具数）。 */
  tools: number;
}

/**
 * 把注册表里的一堆事实压成一个快照；不读存储、不发请求，纯函数。
 */
export function summarizeMcpStatus(
  servers: readonly McpServerSnapshot[],
  statusOf: (serverId: string) => McpConnectStatus | undefined,
  enabledTools: number,
): McpStatusSnapshot {
  const enabled = servers.filter((server) => server.enabled);
  const failed: { name: string; state: McpConnectState; error?: string }[] = [];
  let connected = 0;
  let pending = 0;
  for (const server of enabled) {
    const status = statusOf(server.id);
    if (!status) {
      pending += 1;
      continue;
    }
    if (status.state === "connected") {
      connected += 1;
      continue;
    }
    failed.push({
      name: server.name || server.id,
      state: status.state,
      ...(status.error ? { error: status.error } : {}),
    });
  }
  return {
    total: servers.length,
    enabled: enabled.length,
    connected,
    failed,
    pending,
    tools: Number.isFinite(enabledTools) && enabledTools > 0 ? Math.floor(enabledTools) : 0,
  };
}
