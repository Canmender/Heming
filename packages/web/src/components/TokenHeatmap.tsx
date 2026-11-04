import { useMemo } from "react";
import { last30DaysTotals, heatLevel, useTokenUsageStore } from "../store/tokenUsage.js";

/** 5 档底色走 CSS 变量：暗色有独立一套（组件内写死亮色会在深底上出现白方块）。 */
const LEVEL_BG = ["var(--heat-0)", "var(--heat-1)", "var(--heat-2)", "var(--heat-3)", "var(--heat-4)"] as const;
const LEVEL_LABEL = ["无", "少", "较少", "较多", "多"] as const;

/** 近 30 日用量热力图（Claude Code 式横排小方格，蓝色深浅=用量）。 */
export function TokenHeatmap() {
  const records = useTokenUsageStore((s) => s.records);
  const days = useMemo(() => last30DaysTotals(records), [records]);
  const max = Math.max(0, ...days.map((d) => d.total));
  return (
    <div className="flex items-center gap-[3px]" role="img" aria-label="近 30 日 token 用量">
      {days.map((d, i) => {
        const level = heatLevel(d.total, max);
        // 当天只有未上报记录：标题说「未上报」，不拿「0 tokens」冒充真实用量。
        // 有数字时仍以数字为准（未上报只是附加事实，不抢主信息）。
        const title =
          d.total === 0 && d.missing > 0
            ? `${d.day} · 未上报`
            : `${d.day} · ${d.total} tokens（${LEVEL_LABEL[level]}）`;
        return (
          <span
            key={d.day}
            title={title}
            data-day={d.day}
            data-total={d.total}
            style={{ backgroundColor: LEVEL_BG[level] }}
            className={`h-3.5 w-3.5 rounded-[3px]${i === 29 ? " ring-1 ring-[color:var(--line-strong)]" : ""}`}
          />
        );
      })}
    </div>
  );
}
