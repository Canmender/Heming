import { QuotaTrend } from "./QuotaTrend.js";
import { Button } from "../ui/Button.js";
import { trendHeadline, type QuotaHistoryRow } from "../../lib/quotaHistory.js";
import { useState } from "react";

export interface QuotaTrendCardProps {
  rows: readonly QuotaHistoryRow[];
  now: number;
  defaultOpen?: boolean;
  /** 看多少天的历史；不给就不显示天数选择器（只读用法）。 */
  days?: number;
  onDaysChange?: (days: number) => void;
}

/** 可看的天数档位：内核按天数现查，档位多一档就多一种读法，够用即可。 */
export const TREND_DAY_CHOICES = [7, 14, 30] as const;

const TONE_TEXT: Record<"danger" | "warn" | "muted", string> = {
  danger: "text-danger",
  warn: "text-warn",
  muted: "",
};

/**
 * 「额度走向」这张卡（模型页 → 来源）。
 *
 * 曲线只在一个时候有用：想知道「照这个速度会不会在重置前用完」。平时它占掉
 * 一屏高度，却只被扫一眼。所以收起来放一句结论在最急的那一份上，要细看再展开；
 * 没有历史时整张卡不渲染（由调用方决定要不要调用，这里再兜一次空）。
 *
 * 用 `aria-expanded` + `aria-controls` 而不是 `<details>`：按钮要显式说明
 * 「展开走向 / 收起走向」，两端的行为也更好对齐。
 */
export function QuotaTrendCard({
  rows,
  now,
  defaultOpen = false,
  days,
  onDaysChange,
}: QuotaTrendCardProps) {
  const [open, setOpen] = useState(defaultOpen);
  if (rows.length === 0) return null;
  const headline = trendHeadline(rows, now);
  const span = days ?? 7;
  return (
    <div className="ui-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="ui-section-title">额度走向</h2>
          <p className={`mt-0.5 ui-caption ${TONE_TEXT[headline.tone]}`}>
            {headline.text || `最近 ${span} 天的读数 · 展开看每一份的曲线`}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {days !== undefined && onDaysChange && (
            <label className="flex items-center gap-2 ui-caption">
              看几天
              <select
                className="ui-input w-auto"
                aria-label="额度走向看几天"
                value={days}
                onChange={(event) => onDaysChange(Number(event.target.value))}
              >
                {TREND_DAY_CHOICES.map((choice) => (
                  <option key={choice} value={choice}>
                    {choice} 天
                  </option>
                ))}
              </select>
            </label>
          )}
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={open}
            aria-controls="quota-trend-body"
            onClick={() => setOpen((value) => !value)}
          >
            {open ? "收起走向" : "展开走向"}
          </Button>
        </div>
      </div>
      {open && (
        <div id="quota-trend-body">
          <QuotaTrend rows={rows} now={now} />
        </div>
      )}
    </div>
  );
}