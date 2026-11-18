import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { QuotaCards } from "./QuotaCards.js";
import { parseQuotaCards } from "../../lib/magpieQuotaCards.js";

/** 其余来源的额度卡（d.286）：Key 的余额、套餐的窗口，与订阅账号同一套窗口条。 */

const now = Date.parse("2026-11-18T05:00:00Z");

function cards(...rows: unknown[]) {
  return parseQuotaCards(JSON.stringify(rows));
}

describe("其余来源的额度卡", () => {
  it("没有卡片时整块不出现", () => {
    const { container } = render(<QuotaCards cards={[]} now={now} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("余额卡把名字、种类与钱数写在同一行", () => {
    render(
      <QuotaCards
        cards={cards({ provider: "deepseek", name: "DeepSeek", kind: "balance", balance: "¥2.60" })}
        now={now}
      />,
    );
    expect(screen.getByText("DeepSeek")).toBeInTheDocument();
    expect(screen.getByText("余额")).toBeInTheDocument();
    expect(screen.getByText("¥2.60")).toBeInTheDocument();
  });

  it("套餐卡画窗口条，最紧那份说成「剩多少」", () => {
    render(
      <QuotaCards
        cards={cards({
          provider: "glm",
          name: "GLM Coding",
          kind: "plan",
          plan: "Lite",
          windows: [
            { name: "5 hours", used: 12, remaining: 88, display: "12% used" },
            { name: "week", used: 93, remaining: 7, display: "93% used" },
          ],
        })}
        now={now}
      />,
    );
    expect(screen.getByText("套餐")).toBeInTheDocument();
    expect(screen.getByText("5 小时")).toBeInTheDocument();
    expect(screen.getByText("每周")).toBeInTheDocument();
    expect(screen.getAllByText("剩 7%").length).toBeGreaterThan(0);
    expect(screen.getByRole("progressbar", { name: "每周 用量" })).toHaveAttribute(
      "aria-valuenow",
      "93",
    );
  });

  it("点数套餐按点数说话，不写百分比", () => {
    render(
      <QuotaCards
        cards={cards({
          provider: "workbuddy",
          name: "WorkBuddy",
          kind: "plan",
          windows: [{ name: "Month", used: 3000, remaining: 0, display: "", amount: 3000, limit: 10000, unit: "credits" }],
        })}
        now={now}
      />,
    );
    expect(screen.getByText("剩 7,000 点")).toBeInTheDocument();
  });

  it("读不到的卡说清原因，而不是显示 0", () => {
    render(
      <QuotaCards
        cards={cards({ provider: "grok", name: "Grok", kind: "plan", error: "HTTP 401" })}
        now={now}
      />,
    );
    expect(screen.getByText("这次没读到")).toBeInTheDocument();
    expect(screen.getByText("HTTP 401")).toBeInTheDocument();
  });

  it("共用余额与到期时间都照实说", () => {
    render(
      <QuotaCards
        cards={cards({
          provider: "kimi",
          name: "Kimi",
          kind: "plan",
          sharedBalance: "$12.00",
          until: "2026-12-01",
        })}
        now={now}
      />,
    );
    expect(screen.getByText("几个 Key 共用：$12.00")).toBeInTheDocument();
    expect(screen.getByText("到期：2026-12-01")).toBeInTheDocument();
  });
});
