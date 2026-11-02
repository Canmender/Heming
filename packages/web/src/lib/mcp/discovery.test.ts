import { describe, expect, it } from "vitest";
import { discoverTools, searchTools } from "./discovery.js";

/**
 * 工具检索：只做「名字/描述匹配 + 排序」，不认 MCP、不碰网络。
 * 重点验证三件事：结构不符的条目被跳过、名字命中优先于描述、空查询不返回全部。
 */

const spec = (name: string, description = "") => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties: {} } },
});

describe("discoverTools", () => {
  it("抽出名字/描述/schema，结构不符的条目跳过而不是抛错", () => {
    const tools = discoverTools([
      spec("srv__weather", "查天气"),
      { type: "function" }, // 没有 function
      { type: "function", function: {} }, // 没有 name
      null,
      "x",
      spec("srv__search"),
    ]);
    expect(tools.map((t) => t.name)).toEqual(["srv__weather", "srv__search"]);
    expect(tools[0]?.description).toBe("查天气");
    expect(tools[0]?.spec).toMatchObject({ function: { name: "srv__weather" } });
  });

  it("非数组输入返回空数组（调用方不必判空）", () => {
    expect(discoverTools(undefined as unknown as unknown[])).toEqual([]);
  });
});

describe("searchTools", () => {
  const tools = discoverTools([
    spec("srv__weather", "查询城市天气"),
    spec("srv__search", "网页搜索，也可搜天气"),
    spec("srv__write_file", "写入文件"),
  ]);

  it("名字命中排在描述命中之前（描述长不该靠字数取胜）", () => {
    const hits = searchTools(tools, "weather");
    expect(hits[0]?.name).toBe("srv__weather");
  });

  it("中文关键词也能命中（CJK 单字切分）", () => {
    const hits = searchTools(tools, "文件");
    expect(hits.map((t) => t.name)).toEqual(["srv__write_file"]);
  });

  it("完全等于查询的名字额外加权", () => {
    const hits = searchTools(tools, "srv__search");
    expect(hits[0]?.name).toBe("srv__search");
  });

  it("空查询返回空数组：没有查询词就没有「相关」", () => {
    expect(searchTools(tools, "")).toEqual([]);
    expect(searchTools(tools, "   ")).toEqual([]);
  });

  it("排除已可见的工具，并按 limit 截断", () => {
    const many = discoverTools(Array.from({ length: 20 }, (_, i) => spec(`srv__t${i}`, "批量")));
    const hits = searchTools(many, "批量", { limit: 5 });
    expect(hits).toHaveLength(5);
    const excluded = new Set([hits[0]?.name as string]);
    const again = searchTools(many, "批量", { exclude: excluded, limit: 5 });
    expect(again.map((t) => t.name)).not.toContain(hits[0]?.name);
  });

  it("无命中返回空数组（不是全量兜底）", () => {
    expect(searchTools(tools, "不存在的关键词")).toEqual([]);
  });
});
