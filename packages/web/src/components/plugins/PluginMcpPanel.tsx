import type { CapabilityMcpRow } from "./viewModel.js";
import { BTN_GHOST_SM, CHIP, HINT, Switch } from "./shared.js";

/**
 * MCP 服务 Tab（d.64 · T2）：统一服务列表。
 *
 * 来源四档（预置 / 手工 / Registry / 插件）在接口区各有交互，这里只读汇总：
 * 名称、地址、来源、工具数、启用、连接状态；行内两个入口——
 * 「在接口区管理」（连接/工具授权仍在那里）与插件服务的「查看插件」（跳详情）。
 */
export function PluginMcpPanel({
  rows,
  onToggle,
  onManage,
  onOpenPlugin,
}: {
  rows: CapabilityMcpRow[];
  onToggle: (serverId: string, enabled: boolean) => void;
  onManage: () => void;
  onOpenPlugin: (pluginId: string) => void;
}) {
  if (rows.length === 0) {
    return <p className={`mt-2 ${HINT}`}>还没有 MCP 服务：可在接口区添加，或安装带服务的插件。</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="ui-table min-w-[760px]">
        <thead>
          <tr>
            <th>名称</th>
            <th>地址</th>
            <th>来源</th>
            <th className="text-right">工具</th>
            <th>状态</th>
            <th className="text-center">启用</th>
            <th className="text-right">操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate font-medium text-ink">{row.name}</span>
                  {row.pluginName && <span className={CHIP}>插件 · {row.pluginName}</span>}
                </div>
              </td>
              <td className="max-w-[280px] truncate text-muted" title={row.url}>
                {row.url || "—"}
              </td>
              <td>
                <span className={CHIP}>{row.originLabel}</span>
              </td>
              <td className="ui-numeric text-right">{row.toolCount}</td>
              <td className="ui-caption">
                {!row.enabled ? "已停用" : row.connected ? "已连接" : "未发现工具"}
              </td>
              <td className="text-center">
                <div className="flex justify-center">
                  <Switch
                    label={`启用服务 ${row.name}`}
                    checked={row.enabled}
                    onChange={(next) => onToggle(row.id, next)}
                  />
                </div>
              </td>
              <td className="text-right">
                <div className="flex items-center justify-end gap-1.5">
                  {row.pluginId && row.pluginName && (
                    <button
                      type="button"
                      aria-label={`查看插件 ${row.pluginName}`}
                      onClick={() => onOpenPlugin(row.pluginId as string)}
                      className={BTN_GHOST_SM}
                    >
                      查看插件
                    </button>
                  )}
                  <button
                    type="button"
                    aria-label={`在接口区管理 ${row.name}`}
                    onClick={onManage}
                    className={BTN_GHOST_SM}
                  >
                    在接口区管理
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
