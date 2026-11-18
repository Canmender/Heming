import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QuotaTrendCard } from "./QuotaTrendCard.js";
import type { QuotaHistoryRow } from "../../lib/quotaHistory.js";

const NOW = Date.parse("2026-11-18T12:00:00Z");

/** 一条从 100 匀速掉到 `left`、共 `hours` 小时的线（与 lib 测试同一套算法）。 */
function row(left: number, hours: number, provider = "claude"): QuotaHistoryRow {
  const points = [];
  for (let hour = hours; hour >= 0; hour -= 1) {
    points.push({
      at: new Date(NOW - hour * 60 * 60 * 1000).toISOString(),
      left: 100 - ((100 - left) * (hours - hour)) / hours,
    });
  }
  return { provider, lines: [{ name: "5 hours", points }] };
}

describe("QuotaTrendCard", () => {
  it("没有历史就整个不渲染，不留一个空卡", () => {
    const { container } = render(<QuotaTrendCard rows={[]} now={NOW} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("默认收起：只给一句结论和「展开走向」，点了才出曲线", () => {
    render(<QuotaTrendCard rows={[row(30, 8)]} now={NOW} />);
    expect(screen.getByText("额度走向")).toBeInTheDocument();
    expect(screen.getByText(/照这个速度，.*后用完/)).toBeInTheDocument();
    expect(screen.queryByLabelText("额度走向")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "展开走向" }));
    expect(screen.getByLabelText("额度走向")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "收起走向" }));
    expect(screen.queryByLabelText("额度走向")).toBeNull();
  });

  it("defaultOpen 时直接摊开：给需要一眼看到曲线的地方留口子", () => {
    render(<QuotaTrendCard rows={[row(70, 6)]} now={NOW} defaultOpen />);
    expect(screen.getByLabelText("额度走向")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "收起走向" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("说不出所以然时兜一句渠道说明，不留空白标题", () => {
    const thin: QuotaHistoryRow = {
      provider: "codex",
      lines: [{ name: "week", points: [{ at: new Date(NOW).toISOString(), left: 40 }] }],
    };
    render(<QuotaTrendCard rows={[thin]} now={NOW} />);
    expect(screen.getByText(/最近 7 天的读数/)).toBeInTheDocument();
  });
});