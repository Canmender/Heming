import { useEffect, useMemo, useState } from "react";
import {
  mcpRegistry,
  refreshServerTools,
  type McpConnState,
  type McpRegistry,
  type McpServerConfig,
} from "../../lib/mcp/index.js";
import {
  readBundledRuntimeStatus,
  type BundledRuntimeStatus,
} from "../../lib/registry/runtime.js";
import { Button } from "../ui/Button.js";

/**
 * 系统能力的连接状态条（d.149.4.95.11）。
 *
 * 为什么不再画整张卡片：MCP 页签原本在顶部用「系统能力」卡片区展示这两条内置服务，
 * 下面「工具授权」里又有一组「系统能力（N）」，同一个东西出现两次。现在卡片区删掉，
 * 只留一行紧凑状态——连接态、工具数、重新连接、内置运行时提示都在这里，
 * 工具开关本身仍在下面的「工具授权 → 系统能力」分组里。
 *
 * 状态来源与接口页一致：本组件刚发起的连接优先，其次看 registry 落过的最近一次连接结果，
 * 最后才退回「有工具快照＝已连接」——只看本组件 state 会把启动时的自动连接显示成未连接。
 */
export interface SystemCapabilityStatusProps {
  registry?: McpRegistry;
  className?: string;
}

const STATE_TEXT: Record<McpConnState, string> = {
  idle: "未连接",
  connecting: "连接中…",
  ready: "已连接",
  stale: "已断开（清单过期）",
  error: "连接失败",
};

const STATE_CLASS: Record<McpConnState, string> = {
  idle: "bg-subtle-2 text-muted",
  connecting: "bg-warn-soft text-warn",
  ready: "bg-success-soft text-success",
  stale: "bg-warn-soft text-warn",
  error: "bg-danger-soft text-danger",
};

export function SystemCapabilityStatus({
  registry = mcpRegistry,
  className = "",
}: SystemCapabilityStatusProps = {}) {
  const [tick, setTick] = useState(0);
  /** 本组件发起的连接过程态；真实状态仍以 registry 为准。 */
  const [conn, setConn] = useState<Record<string, McpConnState>>({});
  const [connError, setConnError] = useState<Record<string, string>>({});
  /** 内置运行时状态（桌面端才读得到；浏览器 / 旧版主进程为 null）。 */
  const [runtimeStatus, setRuntimeStatus] = useState<BundledRuntimeStatus | null>(null);

  const bump = () => setTick((n) => n + 1);
  const servers = useMemo(() => registry.systemServers(), [registry, tick]);
  const toolsCount = useMemo(
    () => Object.fromEntries(servers.map((s) => [s.id, registry.tools(s.id).length])),
    [registry, servers, tick],
  );

  // 内置运行时状态只在挂载时读一次：读不到（浏览器/旧主进程）就不渲染这一行。
  useEffect(() => {
    let alive = true;
    void readBundledRuntimeStatus().then((status) => {
      if (alive && status) setRuntimeStatus(status);
    });
    return () => {
      alive = false;
    };
  }, []);

  const stateOf = (server: McpServerConfig): McpConnState => {
    const live = registry.status(server.id);
    if (live) {
      // 本组件刚发起的连接优先于落盘记录（例如刚点完重新连接还在跑）。
      if (conn[server.id]) return conn[server.id];
      return live.state === "connected" ? "ready" : live.state;
    }
    if (conn[server.id]) return conn[server.id];
    return registry.hasDiscovered(server.id) ? "ready" : "idle";
  };

  const reconnect = async (server: McpServerConfig) => {
    setConn((c) => ({ ...c, [server.id]: "connecting" }));
    setConnError((e) => ({ ...e, [server.id]: "" }));
    try {
      await refreshServerTools(server.id, registry);
      setConn((c) => ({ ...c, [server.id]: "ready" }));
      bump();
    } catch (err) {
      setConn((c) => ({ ...c, [server.id]: "error" }));
      setConnError((e) => ({
        ...e,
        [server.id]: err instanceof Error ? err.message : String(err),
      }));
    }
  };

  if (servers.length === 0) {
    // 密文读不出时 ensureSystemServers 会跳过补齐（避免覆盖用户配置），这一轮就没有系统能力。
    return (
      <p
        data-testid="mcp-system-status"
        className={`mb-3 rounded-lg border border-dashed border-line bg-surface px-3 py-2 text-ui-sm text-muted ${className}`}
      >
        系统能力暂不可用（本机服务配置读取失败）；恢复系统账户的凭据后重启应用即可。
      </p>
    );
  }

  return (
    <div
      data-testid="mcp-system-status"
      className={`mb-3 rounded-lg border border-line-soft bg-subtle-2 px-3 py-2 ${className}`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="ui-chip" title="随应用内置，不可删除、不可修改配置">
          随应用内置
        </span>
        {servers.map((server) => {
          const state = stateOf(server);
          const count = toolsCount[server.id] ?? 0;
          return (
            <span key={server.id} className="flex flex-wrap items-center gap-1.5">
              <span className="text-ui-sm">{server.name}</span>
              <span
                className={`rounded-full px-2 py-0.5 text-ui-xs ${STATE_CLASS[state]}`}
                title={
                  state === "stale"
                    ? registry.status(server.id)?.error ?? "最近一次连接失败"
                    : undefined
                }
              >
                {STATE_TEXT[state]}
              </span>
              <span className="ui-caption">
                {count > 0 ? `${count} 个工具` : "未获取工具"}
              </span>
              <Button
                type="button"
                aria-label={`重新连接 ${server.name}`}
                onClick={() => void reconnect(server)}
                disabled={state === "connecting"}
                size="sm"
                variant="ghost"
              >
                {state === "connecting" ? "连接中…" : "重新连接"}
              </Button>
            </span>
          );
        })}
      </div>
      {servers.map((server) =>
        connError[server.id] ? (
          <p key={`${server.id}-error`} role="alert" className="mt-1 text-ui-sm text-danger">
            {server.name}：{connError[server.id]}
          </p>
        ) : null,
      )}
      {runtimeStatus && (
        <p
          data-testid="mcp-runtime-status"
          className={`mt-1 text-ui-sm ${runtimeStatus.bundled ? "text-muted" : "text-warn"}`}
        >
          {runtimeStatus.note}
          {!runtimeStatus.bundled && (runtimeStatus.python === null || !runtimeStatus.depsReady)
            ? " 重新安装和鸣即可恢复。"
            : ""}
        </p>
      )}
    </div>
  );
}
