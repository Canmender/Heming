import type { CapabilityToolGroup, BlockedToolRow } from "./viewModel.js";
import { toolRiskLabel } from "./viewModel.js";
import { CHIP, HINT, Switch } from "./shared.js";

/**
 * 工具 Tab（d.64 · T2）：统一能力目录。
 *
 * 只读 `describeCapabilityCatalog()` 的结果（展示与执行同源）。
 * 两类行：
 * - 目录内工具：名称 / 描述 / 归属 / 风险 / 开关（只有 MCP 工具可开关）；
 * - 被插件风险上限拦下的工具：只读行，注明「插件声明 read，未注入」——
 *   被过滤不等于审批放宽，用户需要知道这台机器上「有但没给模型」的工具。
 */
export function PluginToolPanel({
  groups,
  blocked,
  onToggleTool,
}: {
  groups: CapabilityToolGroup[];
  blocked: BlockedToolRow[];
  onToggleTool: (serverId: string, toolName: string, enabled: boolean) => void;
}) {
  const total = groups.reduce((sum, group) => sum + group.tools.length, 0);
  return (
    <div className="flex flex-col gap-4">
      <p className={HINT}>
        共 {total} 个可调用工具；插件声明的工具风险上限只能收紧，不会让写工具绕过确认。
      </p>

      {groups.length === 0 ? (
        <p className={HINT}>目录里还没有工具：连接 MCP 服务或安装带工具的插件后出现。</p>
      ) : (
        groups.map((group) => (
          <section key={group.kind} aria-label={`工具分组 ${group.label}`}>
            <h3 className="ui-section-title">
              {group.label}（{group.tools.length}）
            </h3>
            <ul className="mt-1">
              {group.tools.map((tool) => (
                <li key={tool.name} className="ui-list-row items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono ui-body-sm font-medium">{tool.name}</span>
                      <span className={CHIP}>{tool.ownerLabel}</span>
                      <span className={CHIP}>{toolRiskLabel(tool.risk)}</span>
                    </div>
                    {tool.description && (
                      <p className="mt-0.5 line-clamp-2 ui-caption">{tool.description}</p>
                    )}
                  </div>
                  <div className="shrink-0">
                    {tool.editable ? (
                      <Switch
                        label={`启用工具 ${tool.name}`}
                        checked={tool.enabled}
                        onChange={(next) => onToggleTool(tool.ownerId, tool.name, next)}
                      />
                    ) : (
                      <span className={CHIP}>{tool.enabled ? "常开" : "未启用"}</span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}

      {blocked.length > 0 && (
        <section aria-label="未注入的工具">
          <h3 className="ui-section-title">被插件权限拦下（{blocked.length}）</h3>
          <ul className="mt-1">
            {blocked.map((tool) => (
              <li key={tool.name} className="ui-list-row items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono ui-body-sm font-medium">{tool.name}</span>
                    <span className={CHIP}>{tool.ownerLabel}</span>
                    <span className={CHIP}>{toolRiskLabel(tool.risk)}</span>
                  </div>
                  <p className="mt-0.5 ui-caption">{tool.reason}</p>
                </div>
                <span className={`shrink-0 ${CHIP}`}>未注入</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
