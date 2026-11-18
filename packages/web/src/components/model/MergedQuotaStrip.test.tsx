import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { MergedAgent } from "../../lib/mergedQuota.js";
import { MergedQuotaStrip } from "./MergedQuotaStrip.js";

const now = Date.parse("2026-11-18T05:00:00Z");

const group = (over: Partial<MergedAgent> = {}): MergedAgent => ({
  agent: "claude",
  label: "Claude",
  accounts: 2,
  windows: [
    {
      name: "5 hours",
      accounts: 2,
      unknown: 0,
      left: 50,
      tone: "ok",
      text: "平均剩 50%",
      detail: "同一计划下 2 个账号的平均",
      resetsAt: now + 2 * 3600_000,
    },
  ],
  ...over,
});

describe("MergedQuotaStrip", () => {
  it("没有两个账号就什么都不画", () => {
    const { container } = render(<MergedQuotaStrip groups={[]} now={now} />);
    expect(container.firstChild).toBeNull();
  });

  it("一家一行：名字、账号数，每个窗口一枚徽标", () => {
    render(<MergedQuotaStrip groups={[group()]} now={now} />);
    const list = screen.getByLabelText("账号合计");
    expect(list.textContent).toContain("Claude");
    expect(list.textContent).toContain("2 个账号");
    expect(list.textContent).toContain("5 小时 平均剩 50%");
  });

  it("悬停说明口径，并说最早一份什么时候重置", () => {
    render(<MergedQuotaStrip groups={[group()]} now={now} />);
    const chip = screen.getByTitle(/同一计划下 2 个账号的平均/);
    expect(chip.getAttribute("title")).toContain("最早 2 小时后重置");
  });

  it("余量见底用危险色", () => {
    const tight = group({
      windows: [{ ...group().windows[0], left: 6, tone: "danger", text: "平均剩 6%" }],
    });
    render(<MergedQuotaStrip groups={[tight]} now={now} />);
    expect(screen.getByText("5 小时 平均剩 6%").className).toContain("bg-danger-soft");
  });
});
