import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { QuotaTrend } from "./QuotaTrend.js";
import type { QuotaHistoryRow } from "../../lib/quotaHistory.js";

const NOW = Date.parse("2026-11-18T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const at = (offsetHours: number): string => new Date(NOW + offsetHours * HOUR).toISOString();

/** 三条读数从 100 匀速掉到 40，重置在 4 小时后。 */
function row(withReset = true): QuotaHistoryRow[] {
  return [
    {
      provider: "claude",
      user: "work@example.com",
      lines: [
        {
          name: "5 hours",
          points: [
            { at: at(-2), left: 100, ...(withReset ? { resetsAt: at(4) } : {}) },
            { at: at(-1), left: 70, ...(withReset ? { resetsAt: at(4) } : {}) },
            { at: at(0), left: 40, ...(withReset ? { resetsAt: at(4) } : {}) },
          ],
        },
      ],
    },
  ];
}

describe("QuotaTrend", () => {
  it("知道这次什么时候重置时，曲线右端留一段虚线，并在结论里写明", () => {
    const { container } = render(<QuotaTrend rows={row()} now={NOW} />);
    // 虚线就是「从现在到重置」：只在重置还在将来时画。
    const dashed = container.querySelector("line[stroke-dasharray]");
    expect(dashed).not.toBeNull();
    // 图的朗读文案把重置时刻也带上，不只读「从 100% 到 40%」。
    const chart = screen.getByRole("img");
    expect(chart.getAttribute("aria-label")).toMatch(/额度走向：从 100% 到 40%，.*后重置/);
    // 结论那行末尾补一句重置，且没有丢原来的趋势判断。
    expect(screen.getByText(/^5 小时：照这个速度/).textContent).toMatch(/· .*后重置$/);
  });

  it("内核没给重置时刻时，不画虚线，也不编一句重置", () => {
    const { container } = render(<QuotaTrend rows={row(false)} now={NOW} />);
    expect(container.querySelector("line[stroke-dasharray]")).toBeNull();
    expect(screen.getByRole("img").getAttribute("aria-label")).not.toMatch(/重置/);
    expect(screen.getByText(/^5 小时：照这个速度/).textContent).not.toMatch(/重置/);
  });
});