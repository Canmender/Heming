import { describe, expect, it } from "vitest";

import {
  SOURCE_MODELS_FIELDS,
  parseAutoInclude,
  sourceModelsCommands,
  sourceModelsSummary,
} from "./magpieSourceModels";

describe("来源的模型清单规矩", () => {
  it("三项都在，且键不重复", () => {
    const keys = SOURCE_MODELS_FIELDS.map((field) => field.key);
    expect(keys).toEqual(["listed", "refreshEvery", "autoInclude"]);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("列给智能体：yes / no 都发，留空不发", () => {
    expect(sourceModelsCommands("p", { listed: "yes" })).toEqual([["provider", "listed", "p", "yes"]]);
    expect(sourceModelsCommands("p", { listed: "no" })).toEqual([["provider", "listed", "p", "no"]]);
    expect(sourceModelsCommands("p", { listed: "" })).toEqual([]);
  });

  it("多久刷一次：认得四种时长，别的当没填", () => {
    expect(sourceModelsCommands("p", { refreshEvery: "6h" })).toEqual([
      ["provider", "refresh-every", "p", "6h"],
    ]);
    expect(sourceModelsCommands("p", { refreshEvery: "off" })).toEqual([
      ["provider", "refresh-every", "p", "off"],
    ]);
    expect(sourceModelsCommands("p", { refreshEvery: "每周" })).toEqual([]);
  });

  it("新模型自动收：空格、逗号、中文逗号都算分隔，规则原样排开", () => {
    expect(parseAutoInclude(" claude-*  gpt-4o* ")).toEqual(["claude-*", "gpt-4o*"]);
    expect(sourceModelsCommands("p", { autoInclude: "claude-*, gpt-4o*" })).toEqual([
      ["provider", "auto-include", "p", "claude-*", "gpt-4o*"],
    ]);
  });

  it("填 none 或 off 就发 none 清空那一条", () => {
    expect(sourceModelsCommands("p", { autoInclude: "none" })).toEqual([
      ["provider", "auto-include", "p", "none"],
    ]);
    expect(sourceModelsCommands("p", { autoInclude: " off " })).toEqual([
      ["provider", "auto-include", "p", "none"],
    ]);
  });

  it("没有来源 ID 就一条都不发", () => {
    expect(
      sourceModelsCommands("   ", { listed: "yes", refreshEvery: "1d", autoInclude: "a*" }),
    ).toEqual([]);
  });

  it("三项都改了就按固定顺序各发一条，按钮上点数", () => {
    const commands = sourceModelsCommands("p", {
      autoInclude: "a*",
      refreshEvery: "30m",
      listed: "no",
    });
    expect(commands).toEqual([
      ["provider", "listed", "p", "no"],
      ["provider", "refresh-every", "p", "30m"],
      ["provider", "auto-include", "p", "a*"],
    ]);
    expect(sourceModelsSummary(commands)).toBe("保存清单规矩（3 项）");
    expect(sourceModelsSummary([])).toBe("保存清单规矩");
  });
});
