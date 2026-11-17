import { describe, expect, it } from "vitest";

import {
  addProviderModelArgs,
  parseProviderModels,
  providerModelLabel,
  providerModelsChoiceArgs,
  refreshProviderModelsArgs,
  removeProviderModelArgs,
} from "./providerModels.js";

const SHOW = [
  "  DeepSeek  deepseek",
  "  chat       https://api.deepseek.com/v1",
  "  key        sk-7…3d7e",
  "  balance    ¥2.60",
  "  models     2 exposed of 2 from api.deepseek.com · fetched Nov 13",
  "             deepseek/deepseek-flash  DeepSeek-V4.1-Flash",
  "             deepseek/deepseek-v4-pro  DeepSeek-V4-Pro",
  "  keys       https://platform.deepseek.com/api_keys",
].join("\n");

describe("parseProviderModels", () => {
  it("读出模型 id、显示名与那一行的说明", () => {
    const block = parseProviderModels(SHOW);
    expect(block.note).toContain("2 exposed of 2 from api.deepseek.com");
    expect(block.models).toEqual([
      { id: "deepseek/deepseek-flash", name: "DeepSeek-V4.1-Flash" },
      { id: "deepseek/deepseek-v4-pro", name: "DeepSeek-V4-Pro" },
    ]);
  });

  it("没有 models 段时是空清单", () => {
    expect(parseProviderModels("  DeepSeek  deepseek\n  key sk-x\n")).toEqual({
      models: [],
      note: "",
    });
  });

  it("只有 id 没有显示名也认", () => {
    const block = parseProviderModels("  models     1 exposed of 1\n             relay/fast\n");
    expect(block.models).toEqual([{ id: "relay/fast", name: "" }]);
    expect(providerModelLabel(block.models[0]!)).toBe("relay/fast");
  });

  it("带 ANSI 颜色也能读", () => {
    const block = parseProviderModels(
      "  models     \u001b[2m3 exposed of 3\u001b[0m\n             a/one  One\n",
    );
    expect(block.note).toContain("3 exposed of 3");
    expect(block.models).toEqual([{ id: "a/one", name: "One" }]);
  });
});

describe("来源模型命令", () => {
  it("增删都走 provider models，加号减号区分方向", () => {
    expect(addProviderModelArgs("deepseek", "deepseek/deepseek-chat")).toEqual([
      "provider",
      "models",
      "deepseek",
      "+deepseek/deepseek-chat",
    ]);
    expect(removeProviderModelArgs("deepseek", "deepseek/deepseek-flash")).toEqual([
      "provider",
      "models",
      "deepseek",
      "-deepseek/deepseek-flash",
    ]);
  });

  it("整套切换与重新拉取目录", () => {
    expect(providerModelsChoiceArgs("mock", "all")).toEqual(["provider", "models", "mock", "all"]);
    expect(providerModelsChoiceArgs("mock", "best")).toEqual([
      "provider",
      "models",
      "mock",
      "best",
    ]);
    expect(providerModelsChoiceArgs("mock", "none")).toEqual([
      "provider",
      "models",
      "mock",
      "none",
    ]);
    expect(refreshProviderModelsArgs("mock")).toEqual(["provider", "refresh", "mock"]);
  });
});
