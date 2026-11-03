import type { CapabilitySkillRow } from "./viewModel.js";
import { BTN_GHOST_SM, CHIP, HINT, Switch } from "./shared.js";

/**
 * 技能 Tab（d.64 · T2）：统一技能列表。
 *
 * 一屏回答「有哪些技能、谁提供的、开没开、几个智能体在用」；
 * 深度管理仍在技能区——这里每行给一个「在技能区管理」入口，不复制技能编辑能力。
 */
export function PluginSkillPanel({
  rows,
  onToggle,
  onManage,
}: {
  rows: CapabilitySkillRow[];
  onToggle: (id: string, enabled: boolean) => void;
  /** 跳到技能区（复用页面既有跳转方式）。 */
  onManage: () => void;
}) {
  if (rows.length === 0) {
    return <p className={`mt-2 ${HINT}`}>技能池为空：可在技能区导入 SKILL.md 或新建技能。</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="ui-table min-w-[720px]">
        <thead>
          <tr>
            <th>名称</th>
            <th>来源</th>
            <th>所属插件</th>
            <th className="text-right">触发词</th>
            <th className="text-right">使用智能体</th>
            <th className="text-center">启用</th>
            <th className="text-right">操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>
                <div className="truncate font-medium text-ink">{row.name}</div>
                {row.description && (
                  <div className="mt-0.5 line-clamp-1 ui-caption">{row.description}</div>
                )}
              </td>
              <td>
                <span className={CHIP}>{row.sourceLabel}</span>
              </td>
              <td className="truncate text-muted">{row.pluginName ?? "—"}</td>
              <td className="ui-numeric text-right">{row.triggerCount}</td>
              <td className="ui-numeric text-right">{row.agentCount}</td>
              <td className="text-center">
                <div className="flex justify-center">
                  <Switch
                    label={`启用技能 ${row.name}`}
                    checked={row.enabled}
                    onChange={(next) => onToggle(row.id, next)}
                  />
                </div>
              </td>
              <td className="text-right">
                <button
                  type="button"
                  aria-label={`在技能区管理 ${row.name}`}
                  onClick={onManage}
                  className={BTN_GHOST_SM}
                >
                  在技能区管理
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
