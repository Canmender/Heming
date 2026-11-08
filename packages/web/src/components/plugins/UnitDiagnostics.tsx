import { useMemo } from "react";
import {
  UNIT_SOURCE_LABELS,
  blockReasonText,
  type UnitStatus,
} from "@heming/shared";
import { unitMountDiagnostics, useUnitStatuses } from "../../lib/units/registry.js";
import {
  PLUGIN_HEALTH_LABELS,
  type PluginHealth,
} from "../../lib/plugins/index.js";
import { BTN_GHOST_SM } from "./shared.js";

/**
 * 能力单元诊断（d.105 · 阶段 A；d.113 接入插件健康度）。
 *
 * 回答「它为什么没生效 / 哪里坏了」：把每个 `UnitStatus.diagnostics`（停用 / 贡献级停用 /
 * 依赖未生效 / engines 不兼容 / 签名 / 降级 / 孤儿）、运行时挂载失败，以及 d.113 的
 * 插件健康问题（悬空引用 / 指纹不一致 / 损坏记录…）逐条翻译成中文。
 *
 * 文案统一走 shared 的 `blockReasonText` 与 store 的 `PluginHealthIssue.message`，
 * 与列表行/详情页同源；同一单元的同一条原因只显示一次（避免重复刷屏）。
 * `broken` 单元在诊断行尾给「修复记录」入口（只修记录，不删技能/服务）。
 */

interface DiagnosticRow {
  key: string;
  unitId: string;
  name: string;
  source: string;
  text: string;
  /** 该行对应单元可修复时，带上插件 id（broken 单元才给按钮）。 */
  repairPluginId?: string;
}

export interface UnitDiagnosticsProps {
  /** 覆盖投影（测试/宿主注入）；缺省读 `useUnitStatuses()`。 */
  statuses?: UnitStatus[];
  /** d.113：按单元 id 注入健康度（只对声明式插件单元有值）。 */
  healthByUnitId?: Record<string, PluginHealth>;
  /** d.113：「修复记录」动作（broken 单元的诊断行显示按钮）。 */
  onRepair?: (pluginId: string) => void;
  /** 正在修复的插件 id（按钮禁用并显示「修复中…」）。 */
  repairingPluginId?: string | null;
}

export function UnitDiagnostics({
  statuses,
  healthByUnitId,
  onRepair,
  repairingPluginId,
}: UnitDiagnosticsProps) {
  const subscribed = useUnitStatuses();
  const all = statuses ?? subscribed;
  const rows = useMemo<DiagnosticRow[]>(() => {
    const seen = new Set<string>();
    /** broken 单元的「修复记录」按钮只挂在第一条健康问题上（避免同一单元多个重复按钮）。 */
    const repairGiven = new Set<string>();
    const out: DiagnosticRow[] = [];
    for (const status of all) {
      const unit = status.unit;
      const reasons = [
        ...status.diagnostics,
        ...unitMountDiagnostics(unit.id).map((reason) => reason),
      ];
      for (const reason of reasons) {
        const text = blockReasonText(reason);
        const dedupeKey = `${unit.id}:${text}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        out.push({
          key: dedupeKey,
          unitId: unit.id,
          name: unit.name,
          source: UNIT_SOURCE_LABELS[unit.source],
          text,
        });
      }
      // d.113：健康问题逐条列出；broken 单元带「修复记录」入口。
      const health = healthByUnitId?.[unit.id];
      if (!health) continue;
      for (const issue of health.issues) {
        const dedupeKey = `${unit.id}:health:${issue.code}:${issue.target ?? ""}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        const withRepair = health.level === "broken" && !repairGiven.has(unit.id);
        out.push({
          key: dedupeKey,
          unitId: unit.id,
          name: unit.name,
          source: UNIT_SOURCE_LABELS[unit.source],
          text: `健康度${PLUGIN_HEALTH_LABELS[health.level]}：${issue.message}`,
          ...(withRepair ? { repairPluginId: unit.id } : {}),
        });
        if (withRepair) repairGiven.add(unit.id);
      }
    }
    return out;
  }, [all, healthByUnitId]);

  return (
    <section aria-label="能力单元诊断" className="mt-4 rounded-xl border border-line bg-panel p-4">
      <p className="ui-section-title">诊断</p>
      {rows.length === 0 ? (
        <p className="mt-1 ui-caption">没有发现问题：全部能力单元都按当前开关与依赖正常工作。</p>
      ) : (
        <ul className="mt-2 grid gap-1 ui-body-sm">
          {rows.map((row) => (
            <li key={row.key} className="flex flex-wrap items-baseline gap-2">
              <span className="rounded-sm border border-line px-1.5 py-0.5 text-[10px] text-muted">
                {row.source}
              </span>
              <span className="font-medium">{row.name}</span>
              <span className="text-muted">{row.text}</span>
              {row.repairPluginId && onRepair && (
                <button
                  type="button"
                  aria-label={`修复记录 ${row.name}（诊断）`}
                  disabled={repairingPluginId === row.repairPluginId}
                  onClick={() => onRepair(row.repairPluginId as string)}
                  className={BTN_GHOST_SM}
                >
                  {repairingPluginId === row.repairPluginId ? "修复中…" : "修复记录"}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
