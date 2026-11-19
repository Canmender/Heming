import { describe, expect, it } from "vitest";

import {
  SEARCHER_OFF,
  SEARCH_FIRST_OPTIONS,
  describeSearchRoute,
  parseSearchRoute,
  searcherChoices,
} from "./magpieSearch.js";

function values(pairs: Record<string, unknown>): Map<string, unknown> {
  return new Map(Object.entries(pairs));
}

describe("网页搜索用谁", () => {
  it("settings 表里没有这三项：就是没设置过", () => {
    expect(parseSearchRoute(values({}))).toEqual({ searcher: "", effort: "", first: "" });
  });

  it("读到什么就是什么，多余空白去掉", () => {
    expect(
      parseSearchRoute(values({ searcher: " qwen/qwen3 ", searcherEffort: "low", searchFirst: "api" })),
    ).toEqual({ searcher: "qwen/qwen3", effort: "low", first: "api" });
  });

  it("searchFirst 只认 model 与 api：别的值当作和鸣自己决定", () => {
    expect(parseSearchRoute(values({ searchFirst: "whatever" })).first).toBe("");
  });

  it("三个取值各自都有中文说明：空值也在里面", () => {
    expect(SEARCH_FIRST_OPTIONS.map((option) => option.value)).toEqual(["", "model", "api"]);
    expect(SEARCH_FIRST_OPTIONS.every((option) => option.label && option.hint)).toBe(true);
  });

  it("现在怎么搜的：一句话说清谁在搜、先问谁、想多深", () => {
    expect(describeSearchRoute({ searcher: "", effort: "", first: "" })).toBe(
      "和鸣自己挑一个会搜网的模型；先问谁由和鸣决定；思考档按它自己的默认。",
    );
    expect(describeSearchRoute({ searcher: SEARCHER_OFF, effort: "", first: "api" })).toBe(
      "不叫模型去搜，只走搜索 API；先问搜索 API；思考档按它自己的默认。",
    );
    expect(describeSearchRoute({ searcher: "qwen/qwen3", effort: "high", first: "model" })).toBe(
      "用 qwen/qwen3 搜网；先问来源自己的搜索；搜索时按 high 档思考。",
    );
  });

  it("下拉里的模型：现在设的那个不在目录里也留一项，off 与空值不补", () => {
    const models = [{ id: "a" }, { id: "b" }];
    expect(searcherChoices(models, "")).toBe(models);
    expect(searcherChoices(models, SEARCHER_OFF)).toBe(models);
    expect(searcherChoices(models, "b")).toBe(models);
    expect(searcherChoices(models, "gone")).toEqual([{ id: "gone" }, { id: "a" }, { id: "b" }]);
  });
});
