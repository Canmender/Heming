import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { QuotaTrend } from "./QuotaTrend.js";
import type { QuotaHistoryRow } from "../../lib/quotaHistory.js";

const NOW = Date.parse("2026-11-18T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const iso = (hoursAgo: number): string => new Date(NOW - hoursAgo * HOUR).toISOString();

/** 5 小时窗口：4 小时从 100 掉到 50 —— 照这个速度还有 4 小时。 */
const falling: QuotaHistoryRow = {
  provider: "claude",
  user: "work@example.com",
  lines: [
    {
      name: "5 hours",
      points: [
        { at: iso(4), left: 100 },
        { at: iso(3), left: 88 },
        { at: iso(2), left: 75 },
        { at: iso(1), left: 62 },
        { at: iso(0), left: 50 },
      ],
    },
  ],
};

describe("QuotaTrend", () => {
  it("画出走向与结论：还剩多少、照这个速度多久用完", () => {
    render(<QuotaTrend rows={[falling]} now={NOW} />);
    expect(screen.getByText("Claude")).toBeInTheDocument();
    expect(screen.getByText("work@example.com")).toBeInTheDocument();
    // 窗口名中文化，剩余百分比按最后一点
    expect(screen.getByText("5 小时")).toBeInTheDocument();
    expect(screen.getByText("剩 50%")).toBeInTheDocument();
    // 线本身带无障碍名字（读屏能听到起止）
    expect(screen.getByRole("img", { name: /5 小时 的额度走向：从 100% 到 50%/ })).toBeInTheDocument();
    expect(screen.getByText(/照这个速度，3 小时 5[0-9] 分后用完/)).toBeInTheDocument();
  });

  it("窗口名写进结论里，多个窗口各说各的", () => {
    const both: QuotaHistoryRow = {
      ...falling,
      lines: [
        ...falling.lines,
        {
          name: "week",
          points: [
            { at: iso(6), left: 90 },
            { at: iso(4), left: 90 },
            { at: iso(2), left: 88 },
          ],
        },
      ],
    };
    render(<QuotaTrend rows={[both]} now={NOW} />);
    // 两份额度各说各的，结论前面带上窗口名，不混成一句
    expect(screen.getByText(/^5 小时：照这个速度，3 小时 5[0-9] 分后用完$/)).toBeInTheDocument();
    expect(screen.getByText(/^每周：照这个速度，\d+ 天/)).toBeInTheDocument();
  });

  it("只剩一个点的窗口不画线（画不成线就不装样子）", () => {
    const single: QuotaHistoryRow = {
      provider: "codex",
      lines: [{ name: "week", points: [{ at: iso(2), left: 40 }] }],
    };
    render(<QuotaTrend rows={[single]} now={NOW} />);
    expect(screen.getByText("ChatGPT")).toBeInTheDocument();
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByText(/剩 /)).toBeNull();
  });

  it("余量很紧时用告警色（读屏之外也能一眼看出）", () => {
    const low: QuotaHistoryRow = {
      provider: "claude",
      lines: [
        {
          name: "5 hours",
          points: [
            { at: iso(4), left: 30 },
            { at: iso(2), left: 15 },
            { at: iso(0), left: 6 },
          ],
        },
      ],
    };
    render(<QuotaTrend rows={[low]} now={NOW} />);
    expect(screen.getByText("剩 6%")).toHaveClass("text-danger");
  });
});
