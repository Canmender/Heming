import { describe, expect, it } from "vitest";
import {
  cardSummary,
  nonSubscriptionCards,
  parseQuotaCards,
  quotaKindLabel,
  type QuotaCard,
} from "./magpieQuotaCards.js";

/** 额度总览（d.286）：内核 `quota --json` 的 Key / 套餐 / 余额卡片。 */

const deepseek = {
  provider: "deepseek",
  name: "DeepSeek",
  kind: "balance",
  windows: [],
  balance: "¥2.60",
  readAt: "2026-11-18T04:00:00Z",
  lastServedAt: "2026-11-18T03:59:00Z",
  last: true,
};

const glm = {
  provider: "glm",
  name: "GLM Coding",
  kind: "plan",
  plan: "Lite",
  user: "me@example.com",
  windows: [
    { name: "5 hours", used: 12, remaining: 88, display: "12% used", unit: "credits", amount: 120, limit: 1000 },
    { name: "week", used: 64, remaining: 36, display: "64% used" },
  ],
  balanceSplit: [{ label: "wallet", text: "$3.20" }],
  resets: { count: 2, until: "2026-11-20T00:00:00Z" },
};

describe("parseQuotaCards", () => {
  it("空串、坏 JSON、对象形状都不当数据", () => {
    expect(parseQuotaCards("")).toEqual([]);
    expect(parseQuotaCards("not json")).toEqual([]);
    expect(parseQuotaCards('{"provider":"deepseek"}')).toEqual([]);
  });

  it("把内核的余额行原样读成一张卡", () => {
    const [card] = parseQuotaCards(JSON.stringify([deepseek]));
    expect(card).toMatchObject({
      provider: "deepseek",
      name: "DeepSeek",
      kind: "balance",
      balance: "¥2.60",
      last: true,
    });
    expect(card?.windows).toEqual([]);
  });

  it("套餐卡带上窗口、余额分项与可重置次数", () => {
    const [card] = parseQuotaCards(JSON.stringify([glm]));
    expect(card?.plan).toBe("Lite");
    expect(card?.windows.map((window) => window.name)).toEqual(["5 hours", "week"]);
    expect(card?.windows[0]?.limit).toBe(1000);
    expect(card?.balanceSplit).toEqual([{ label: "wallet", text: "$3.20" }]);
    expect(card?.resets).toEqual({ count: 2, until: "2026-11-20T00:00:00Z" });
  });

  it("缺 provider 与 name 的行不成卡；只有 provider 时用 id 当名字", () => {
    expect(parseQuotaCards(JSON.stringify([{ kind: "balance" }]))).toEqual([]);
    expect(parseQuotaCards(JSON.stringify([{ provider: "kimi" }]))[0]?.name).toBe("kimi");
  });
});

describe("订阅以外的来源", () => {
  it("订阅交给「订阅账号」卡，这里不再重复", () => {
    const cards = parseQuotaCards(
      JSON.stringify([deepseek, { provider: "claude", name: "Claude", kind: "subscription" }]),
    );
    expect(nonSubscriptionCards(cards).map((card) => card.provider)).toEqual(["deepseek"]);
  });

  it("种类说成人话", () => {
    expect(quotaKindLabel("plan")).toBe("套餐");
    expect(quotaKindLabel("balance")).toBe("余额");
    expect(quotaKindLabel("subscription")).toBe("订阅");
    expect(quotaKindLabel("wallet")).toBe("wallet");
  });
});

describe("cardSummary", () => {
  const now = Date.parse("2026-11-18T05:00:00Z");

  it("余额卡直接把钱数说出来", () => {
    const [card] = parseQuotaCards(JSON.stringify([deepseek]));
    expect(cardSummary(card as QuotaCard, now)).toBe("¥2.60");
  });

  it("有余额分项时全列出来", () => {
    const [card] = parseQuotaCards(JSON.stringify([glm]));
    expect(cardSummary(card as QuotaCard, now)).toBe("$3.20");
  });

  it("余额分项里有读不到的，就点出是哪一份", () => {
    const cards = parseQuotaCards(
      JSON.stringify([
        {
          provider: "kimi",
          name: "Kimi",
          kind: "plan",
          balanceSplit: [
            { label: "wallet", text: "$1.00" },
            { label: "points", text: "—", error: "HTTP 500" },
          ],
        },
      ]),
    );
    expect(cardSummary(cards[0] as QuotaCard, now)).toBe("points 这次没读到");
  });

  it("没有余额时看最紧的窗口", () => {
    const cards = parseQuotaCards(
      JSON.stringify([
        {
          provider: "zed",
          name: "Zed",
          kind: "plan",
          windows: [
            { name: "week", used: 10, remaining: 90, display: "10% used" },
            { name: "month", used: 93, remaining: 7, display: "93% used" },
          ],
        },
      ]),
    );
    expect(cardSummary(cards[0] as QuotaCard, now)).toBe("剩 7%");
  });

  it("读不到就直说，不装作没这回事", () => {
    const cards = parseQuotaCards(
      JSON.stringify([{ provider: "grok", name: "Grok", kind: "plan", error: "HTTP 401" }]),
    );
    expect(cardSummary(cards[0] as QuotaCard, now)).toBe("这次没读到");
  });

  it("什么都读不到时留空，不画一行假结论", () => {
    const cards = parseQuotaCards(JSON.stringify([{ provider: "mimo", name: "MiMo", kind: "plan" }]));
    expect(cardSummary(cards[0] as QuotaCard, now)).toBe("");
  });
});
