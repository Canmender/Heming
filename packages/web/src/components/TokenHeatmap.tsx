import { useMemo } from "react";
import { last30DaysTotals, heatLevel, useTokenUsageStore } from "../store/tokenUsage.js";

const LEVEL_BG = ["#f1f4f7", "#dbeafe", "#93c5fd", "#3b82f6", "#1d4ed8"] as const;
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
        return (
          <span
            key={d.day}
            title={`${d.day} · ${d.total} tokens（${LEVEL_LABEL[level]}）`}
            data-day={d.day}
            data-total={d.total}
            style={{ backgroundColor: LEVEL_BG[level] }}
            className={`h-3.5 w-3.5 rounded-[3px]${i === 29 ? " ring-1 ring-ink/20" : ""}`}
          />
        );
      })}
    </div>
  );
}
