import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { last30DaysTotals, heatLevel, useTokenUsageStore } from "../store/tokenUsage.js";
import { FOCUS_RING_TIGHT } from "../lib/a11y/focus.js";

/** 5 档底色走 CSS 变量：暗色有独立一套（组件内写死亮色会在深底上出现白方块）。 */
const LEVEL_BG = ["var(--heat-0)", "var(--heat-1)", "var(--heat-2)", "var(--heat-3)", "var(--heat-4)"] as const;
const LEVEL_LABEL = ["无", "少", "较少", "较多", "多"] as const;

/**
 * 近 30 日用量热力图（Claude Code 式横排小方格，蓝色深浅=用量）。
 *
 * d.141 键盘/读屏可得：此前 30 个格子的唯一信息载体是 `title`（鼠标悬停才出现），
 * 键盘与触屏用户读不到任何一天的数据。现在改为「一个 Tab 停靠点 + 左右方向键逐日移动」
 * （roving tabindex，与 tablist 同一套约定），每格 `aria-label` 说清日期与用量，
 * 容器 label 先给合计与峰值，读屏用户不移动焦点也能拿到概要。
 */
export function TokenHeatmap() {
  const records = useTokenUsageStore((s) => s.records);
  const days = useMemo(() => last30DaysTotals(records), [records]);
  const max = Math.max(0, ...days.map((d) => d.total));

  // 默认停在「今天」（最后一格）：用户最常关心的是今天用了多少。
  const [active, setActive] = useState(days.length - 1);
  const cellRefs = useRef<(HTMLSpanElement | null)[]>([]);

  const total = days.reduce((sum, d) => sum + d.total, 0);
  const peak = days.reduce((best, d) => (d.total > best.total ? d : best), days[0]);
  const summary =
    total > 0
      ? `近 30 日 token 用量：合计 ${total} tokens，最高 ${peak.day} ${peak.total} tokens；按左右方向键逐日查看`
      : "近 30 日 token 用量：这 30 天还没有上报的用量";

  function moveTo(next: number) {
    const clamped = Math.max(0, Math.min(days.length - 1, next));
    setActive(clamped);
    cellRefs.current[clamped]?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      moveTo(active - 1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      moveTo(active + 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      moveTo(0);
    } else if (e.key === "End") {
      e.preventDefault();
      moveTo(days.length - 1);
    }
  }

  return (
    <div>
      <div
        className="flex items-center gap-[3px]"
        role="group"
        aria-label={summary}
        data-testid="token-heatmap"
        onKeyDown={onKeyDown}
      >
      {days.map((d, i) => {
        const level = heatLevel(d.total, max);
        // 当天只有未上报记录：标题说「未上报」，不拿「0 tokens」冒充真实用量。
        // 有数字时仍以数字为准（未上报只是附加事实，不抢主信息）。
        const label =
          d.total === 0 && d.missing > 0
            ? `${d.day} · 未上报`
            : `${d.day} · ${d.total} tokens（${LEVEL_LABEL[level]}）`;
        return (
          <span
            key={d.day}
            ref={(el) => {
              cellRefs.current[i] = el;
            }}
            role="img"
            aria-label={label}
            title={label}
            tabIndex={i === active ? 0 : -1}
            data-day={d.day}
            data-total={d.total}
            onFocus={() => setActive(i)}
            style={{ backgroundColor: LEVEL_BG[level] }}
            className={`h-3.5 w-3.5 rounded-[3px] ${FOCUS_RING_TIGHT}${
              i === 29 ? " ring-1 ring-[color:var(--line-strong)]" : ""
            }`}
          />
        );
      })}
      </div>
      {/* 审计 F9：30 个方块原来没有日期锚点，读者无法判断「最左边是哪天」；
          图例（少→多）在唯一使用处 UsageCard 里已有，这里只补时间轴与读法，不重复图例。 */}
      <div className="mt-1 flex flex-wrap items-center gap-x-2 ui-micro" aria-hidden="true">
        <span>{days[0]?.day}</span>
        <span aria-hidden="true">→</span>
        <span>{days[days.length - 1]?.day}</span>
        <span className="ml-auto">每格 1 天 · 颜色越深用量越多</span>
      </div>
    </div>
  );
}