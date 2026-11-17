import { describe, expect, it } from "vitest";
import {
  buildModelRows,
  canTestModel,
  filterModelRows,
  formatTokenCount,
  groupModelRows,
  isModelDisabled,
  matchesDisabledPattern,
  modelCapabilityLine,
  modelPriceLine,
  modelShortId,
  parseDisabledModels,
  priceEditValue,
  providerOfModel,
  rowsForAgent,
} from "./modelCatalog.js";
import type { GatewayModel } from "./magpieClient.js";

const model = (patch: Partial<GatewayModel> & { id: string }): GatewayModel => ({
  name: patch.id,
  ownedBy: "magpie",
  reasoningLevels: [],
  vision: false,
  ...patch,
});

describe("模型目录展示", () => {
  it("来源名：provider / 路由组 / 自动路由 / 本机，各自说得清楚", () => {
    expect(providerOfModel("deepseek/deepseek-v4-pro")).toBe("deepseek");
    expect(providerOfModel("group/daily")).toBe("路由组");
    expect(providerOfModel("auto/deepseek-v4-pro")).toBe("自动路由");
    expect(providerOfModel("bare-model")).toBe("本机");
  });

  it("档案 + 目录拼成一行：显示名、思考档、窗口、图片能力都来自目录", () => {
    const rows = buildModelRows(
      [{ model: "deepseek/deepseek-flash", label: "deepseek/deepseek-flash" }],
      [
        model({
          id: "deepseek/deepseek-flash",
          name: "DeepSeek-V4.1-Flash",
          reasoningLevels: ["none", "low", "high", "max"],
          contextWindow: 128000,
          maxOutputTokens: 8192,
          vision: true,
        }),
      ],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "deepseek/deepseek-flash",
      provider: "deepseek",
      name: "DeepSeek-V4.1-Flash",
      efforts: ["none", "low", "high", "max"],
      contextWindow: 128000,
      vision: true,
      inCatalog: true,
    });
    expect(modelCapabilityLine(rows[0]!)).toBe("思考 none/low/high/max · 窗口 128K · 输出 8.2K · 图片输入");
  });

  it("目录里没有的旧档案照样列出，只是没有显示名与能力细节", () => {
    const rows = buildModelRows([{ model: "old/model", label: "old/model" }], []);
    expect(rows[0]).toMatchObject({ id: "old/model", name: "", efforts: [], inCatalog: false });
    expect(modelCapabilityLine(rows[0]!)).toBe("");
    expect(modelPriceLine(rows[0]!)).toBe("");
    expect(priceEditValue(rows[0]!)).toBe("");
  });

  it("价格写成每 100 万 token 的一行，编辑框里是 magpie 的四个数", () => {
    const rows = buildModelRows(
      [{ model: "deepseek/deepseek-flash" }],
      [
        model({
          id: "deepseek/deepseek-flash",
          priceIn: 0.15,
          priceOut: 0.6,
          priceCacheRead: 0.003,
          priceCacheWrite: 0,
        }),
      ],
    );
    expect(modelPriceLine(rows[0]!)).toBe("$0.15 入 / $0.6 出 · 每 1M token");
    expect(priceEditValue(rows[0]!)).toBe("0.15,0.6,0.003,0");
    const [other] = buildModelRows(
      [{ model: "x/y" }],
      [model({ id: "x/y", priceIn: 3, priceOut: 15 })],
    );
    expect(modelPriceLine(other!)).toBe(
      "$3 入 / $15 出 · 每 1M token",
    );
  });

  it("去重：同一个模型出现两次只留一行", () => {
    const rows = buildModelRows([{ model: "a/b" }, { model: "a/b" }], [model({ id: "a/b" })]);
    expect(rows).toHaveLength(1);
  });

  it("token 大小写得像人话，未知不占位", () => {
    expect(formatTokenCount(undefined)).toBe("");
    expect(formatTokenCount(0)).toBe("");
    expect(formatTokenCount(8192)).toBe("8.2K");
    expect(formatTokenCount(128000)).toBe("128K");
    expect(formatTokenCount(1000000)).toBe("1M");
    expect(formatTokenCount(1500000)).toBe("1.5M");
    expect(formatTokenCount(999)).toBe("999");
  });

  it("搜索同时匹配 id、显示名与来源", () => {
    const rows = buildModelRows(
      [{ model: "deepseek/deepseek-flash" }, { model: "openai/gpt-4o" }],
      [
        model({ id: "deepseek/deepseek-flash", name: "DeepSeek Flash" }),
        model({ id: "openai/gpt-4o", name: "GPT-4o" }),
      ],
    );
    expect(filterModelRows(rows, "flash").map((row) => row.id)).toEqual(["deepseek/deepseek-flash"]);
    expect(filterModelRows(rows, "OPENAI").map((row) => row.id)).toEqual(["openai/gpt-4o"]);
    expect(filterModelRows(rows, "4o").map((row) => row.id)).toEqual(["openai/gpt-4o"]);
    // 来源筛选与搜索词叠加
    expect(filterModelRows(rows, "gpt", "deepseek")).toEqual([]);
    expect(filterModelRows(rows, "", "deepseek").map((row) => row.id)).toEqual([
      "deepseek/deepseek-flash",
    ]);
  });

  it("按来源分组，路由组与自动路由排在供应商之后", () => {
    const rows = buildModelRows(
      [{ model: "group/daily" }, { model: "deepseek/a" }, { model: "auto/x" }, { model: "openai/b" }],
      [],
    );
    expect(groupModelRows(rows).map((group) => group.provider)).toEqual([
      "deepseek",
      "openai",
      "路由组",
      "自动路由",
    ]);
  });

  it("能测的只有供应商自己的模型；取 `provider test` 要的短 id", () => {
    expect(canTestModel("deepseek/deepseek-flash")).toBe(true);
    expect(canTestModel("group/daily")).toBe(false);
    expect(canTestModel("auto/x")).toBe(false);
    expect(canTestModel("bare")).toBe(false);
    expect(modelShortId("deepseek/deepseek-flash")).toBe("deepseek-flash");
    expect(modelShortId("group/daily")).toBe("daily");
    expect(modelShortId("bare")).toBe("");
  });

  it("已禁用列表：解析模式与命中，空态不产生垃圾行", () => {
    expect(parseDisabledModels("no model is disabled · magpie model disable <model> turns one off")).toEqual([]);
    const parsed = parseDisabledModels(
      ["\u001b[1m*opus*\u001b[0m · a/claude-opus-5-5, b/gpt-5.5", "b/gpt-5.5 · matches no model magpie serves now"].join("\n"),
    );
    expect(parsed).toEqual([
      { pattern: "*opus*", hits: ["a/claude-opus-5-5", "b/gpt-5.5"] },
      { pattern: "b/gpt-5.5", hits: [] },
    ]);
  });

  it("禁用规则是大小写不敏感的 glob，行据此标「已禁用」", () => {
    expect(matchesDisabledPattern("*OPUS*", "a/claude-opus-5-5")).toBe(true);
    expect(matchesDisabledPattern("b/gpt-5.5", "b/gpt-5.5")).toBe(true);
    expect(matchesDisabledPattern("b/gpt-5.5", "b/gpt-5.6")).toBe(false);
    expect(matchesDisabledPattern("deepseek/*", "deepseek/deepseek-flash")).toBe(true);
    const rows = buildModelRows([{ model: "a/claude-opus-5-5" }], []);
    expect(isModelDisabled(rows[0]!, [{ pattern: "*opus*", hits: [] }])).toBe(true);
    expect(isModelDisabled(rows[0]!, [{ pattern: "b/*", hits: [] }])).toBe(false);
  });

  it("智能体收窄后只列它看得到的模型，认不出来的名字不藏模型", () => {
    const rows = buildModelRows(
      [
        { model: "deepseek/deepseek-flash" },
        { model: "relay/relay-chat" },
        { model: "group/daily" },
      ],
      [],
    );
    expect(rowsForAgent(rows, []).map((row) => row.id)).toEqual([
      "deepseek/deepseek-flash",
      "relay/relay-chat",
      "group/daily",
    ]);
    expect(rowsForAgent(rows, ["relay"]).map((row) => row.id)).toEqual(["relay/relay-chat"]);
    expect(rowsForAgent(rows, ["daily"]).map((row) => row.id)).toEqual(["group/daily"]);
    expect(rowsForAgent(rows, ["deepseek-flash"]).map((row) => row.id)).toEqual([
      "deepseek/deepseek-flash",
    ]);
    // 一个都没命中（例如收窄到了已删掉的来源）时列出全部，不让下拉变空。
    expect(rowsForAgent(rows, ["gone"])).toHaveLength(3);
  });
});
