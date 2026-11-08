import { useMemo } from "react";
import {
  UNIT_SOURCE_LABELS,
  blockReasonText,
  type UnitStatus,
} from "@heming/shared";
import { unitMountDiagnostics, useUnitStatuses } from "../../lib/units/registry.js";

/**
 * 能力单元诊断（d.105 · 阶段 A）。
 *
 * 回答「它为什么没生效」：把每个 `UnitStatus.diagnostics`（停用 / 贡献级停用 /
 * 依赖未生效 / engines 不兼容 / 签名 / 降级 / 孤儿）与运行时挂载失败逐条翻译成中文。
 *
 * 文案统一走 shared 的 `blockReasonText`，与列表行/详情页同源；
 * 同一单元的同一条原因只显示一次（避免「技能已单独关闭」重复刷屏）。
 */

interface DiagnosticRow {
  key: string;
  unitId: string;
  name: string;
  source: string;
  text: string;
}

export interface UnitDiagnosticsProps {
  /** 覆盖投影（测试/宿主注入）；缺省读 `useUnitStatuses()`。 */
  statuses?: UnitStatus[];
}

export function UnitDiagnostics({ statuses }: UnitDiagnosticsProps) {
  const subscribed = useUnitStatuses();
  const all = statuses ?? subscribed;
  const rows = useMemo<DiagnosticRow[]>(() => {
    const seen = new Set<string>();
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
    }
    return out;
  }, [all]);

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
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
