import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { SubscriptionRow } from "./SubscriptionRow.js";
import { parseAccounts } from "../../lib/magpieCli.js";

/**
 * 订阅账号的一行（d.339）：
 * 天天要看的（名字、状态、窗口、余额）留在明面上，
 * 一次设好就不再动的规则收进「这个账号的设置」，改过的项写在摘要上。
 */

const now = Date.parse("2026-11-18T05:00:00Z");

function rowOf(raw: unknown) {
  const [row] = parseAccounts(JSON.stringify([raw]));
  if (!row) throw new Error("夹具没解析出账号");
  return row;
}

const BASE = {
  agent: "claude",
  user: "work@example.com",
  alias: "工作号",
  plan: "Max",
  active: true,
  on: true,
  windows: [{ name: "5 hours", used: 18, remaining: 82, display: "18% used" }],
  readAt: "2026-11-18T04:58:00Z",
};

function renderRow(extra: Record<string, unknown> = {}, props: Record<string, unknown> = {}) {
  return render(
    <ul aria-label="订阅账号列表">
      <SubscriptionRow
        row={rowOf({ ...BASE, ...extra })}
        now={now}
        busy={false}
        onSwitch={vi.fn()}
        onRelogin={vi.fn()}
        onRename={vi.fn()}
        onForget={vi.fn()}
        {...props}
      />
    </ul>,
  );
}

describe("订阅账号行", () => {
  it("设置区默认收着：明面上只有名字、状态与额度", () => {
    renderRow({}, { onAutoReset: vi.fn(), onCapChange: vi.fn() });
    const details = screen.getByText("这个账号的设置").closest("details");
    expect(details).not.toBeNull();
    expect(details!.open).toBe(false);
    // 收起时明面内容照旧
    expect(screen.getByText("工作号")).toBeInTheDocument();
    expect(screen.getByText("在用")).toBeInTheDocument();
    expect(screen.getByText("剩 82%")).toBeInTheDocument();
  });

  it("改过的那几项写在摘要上，收起也看得见", () => {
    renderRow(
      { resets: { count: 2, until: "2026-11-20T00:00:00Z" } },
      { onAutoReset: vi.fn(), onCapChange: vi.fn(), autoReset: "expiring", cap: 70 },
    );
    const summary = screen.getByText(/这个账号的设置/);
    expect(summary.textContent).toContain("重置快过期就花");
    expect(summary.textContent).toContain("用到 70% 换下一个");
  });

  it("默认值不占摘要：没改过就只写这一行的名字", () => {
    renderRow(
      { resets: { count: 2 } },
      { onAutoReset: vi.fn(), onCapChange: vi.fn(), autoReset: "off", cap: 0 },
    );
    expect(screen.getByText("这个账号的设置").textContent).toBe("这个账号的设置");
  });

  it("没有可设的项时，连这行摘要都不摆", () => {
    // 没有登录名（不用改名/移除），没有可重置次数，也不是同门多账号。
    renderRow({ user: undefined }, {});
    expect(screen.queryByText("这个账号的设置")).toBeNull();
  });

  it("展开后才看得到规则与逐账号动作", () => {
    renderRow(
      { resets: { count: 2, until: "2026-11-20T00:00:00Z" } },
      {
        onAutoReset: vi.fn(),
        onCapChange: vi.fn(),
        onSpendReset: vi.fn(),
        autoReset: "week",
        cap: 80,
      },
    );
    const details = screen.getByText(/这个账号的设置/).closest("details")!;
    const inside = within(details);
    expect(inside.getByLabelText("工作号 的重置怎么花")).toBeInTheDocument();
    expect(inside.getByLabelText("工作号 用到多少换下一个")).toBeInTheDocument();
    expect(inside.getByRole("button", { name: "改名" })).toBeInTheDocument();
    expect(inside.getByRole("button", { name: "移除" })).toBeInTheDocument();
    expect(inside.getByRole("button", { name: "用掉一次重置" })).toBeInTheDocument();
  });

  it("「切到这个」仍摆在明面上：它是最要紧的动作", () => {
    const { container } = renderRow(
      { active: false, on: true },
      { onAutoReset: vi.fn(), onCapChange: vi.fn() },
    );
    const row = container.querySelector("ul > li")!;
    expect(within(row as HTMLElement).getByRole("button", { name: "切到这个" })).toBeInTheDocument();
    // 它不在「这个账号的设置」里
    const details = row.querySelector("details")!;
    expect(within(details).queryByRole("button", { name: "切到这个" })).toBeNull();
  });
});