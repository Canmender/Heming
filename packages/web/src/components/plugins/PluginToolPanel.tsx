import type { CapabilityToolGroup, BlockedToolRow, ToolPackGroup } from "./viewModel.js";
import { toolRiskLabel } from "./viewModel.js";
import { CHIP, HINT, Switch } from "./shared.js";

/**
 * 工具描述是**写给模型看的**（含 `**加粗**`、行内代码、甚至「不要改写」这类指令），
 * 直接铺到界面上会出现字面量 `**不是**`。这里只做「去标记 + 压空白」，不改写语义；
 * 完整原文放 `title`，被两行截断时悬停可看全。
 */
export function plainToolDescription(input: string): string {
  return input
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

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
  toolPacks,
  onToggleTool,
}: {
  groups: CapabilityToolGroup[];
  blocked: BlockedToolRow[];
  /** 插件声明的工具束（按插件分组；d.65 只做归属展示，不改任何开关）。 */
  toolPacks: ToolPackGroup[];
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
                      <p
                        className="mt-0.5 line-clamp-2 ui-caption"
                        title={plainToolDescription(tool.description)}
                      >
                        {plainToolDescription(tool.description)}
                      </p>
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

      {toolPacks.length > 0 && (
        <section aria-label="工具束">
          <h3 className="ui-section-title">工具束</h3>
          <p className={HINT}>
            工具束只声明「插件用哪些工具」，不会自动打开任何开关；引用了尚未连接的工具时记为未提供。
          </p>
          <div className="mt-1 flex flex-col gap-2">
            {toolPacks.map((group) => (
              <div
                key={group.pluginId}
                className="rounded-lg border border-line-soft bg-[var(--surface)] p-3"
                aria-label={`工具束组 ${group.pluginName}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="ui-body-sm font-medium">{group.pluginName}</span>
                  {!group.enabled && <span className={CHIP}>插件已停用</span>}
                </div>
                <ul className="mt-1 flex flex-col gap-1.5">
                  {group.packs.map((pack) => (
                    <li key={`${group.pluginId}:${pack.id}`}>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="ui-body-sm font-medium">{pack.name}</span>
                        {pack.description && <span className="ui-caption">{pack.description}</span>}
                        <span className={`ml-auto ${CHIP}`}>
                          已匹配 {pack.matched.length}/{pack.tools.length}
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {pack.matched.map((name) => (
                          <span key={`matched:${name}`} className={CHIP} title="目录里存在该工具">
                            {name}
                          </span>
                        ))}
                        {pack.unresolved.map((name) => (
                          <span
                            key={`unresolved:${name}`}
                            className={`${CHIP} text-[var(--warn)]`}
                            title="服务未连接或未提供该工具"
                          >
                            {name} · 未连接/未提供
                          </span>
                        ))}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
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
