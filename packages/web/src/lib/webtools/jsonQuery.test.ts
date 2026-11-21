import { describe, expect, it } from "vitest";
import { parseJsonPath, queryJson } from "./jsonQuery.js";

const DATA = {
  code: 0,
  data: {
    items: [
      { name: "第一项", tags: ["a", "b"] },
      { name: "第二项", tags: [] },
    ],
    "带空格 键": 1,
    total: 2,
  },
};

describe("parseJsonPath", () => {
  it("支持点号、下标与带引号的键名", () => {
    const path = parseJsonPath('data.items[0].name');
    expect(path.ok).toBe(true);
    if (path.ok) {
      expect(path.steps).toEqual([
        { kind: "key", key: "data" },
        { kind: "key", key: "items" },
        { kind: "index", index: 0 },
        { kind: "key", key: "name" },
      ]);
    }
    const quoted = parseJsonPath('$["带空格 键"]');
    expect(quoted.ok).toBe(true);
    if (quoted.ok) expect(quoted.steps).toEqual([{ kind: "key", key: "带空格 键" }]);
  });

  it("空路径与 $ 表示整个文档", () => {
    expect(parseJsonPath("")).toEqual({ ok: true, steps: [] });
    expect(parseJsonPath("$")).toEqual({ ok: true, steps: [] });
  });

  it("未闭合/非法方括号返回中文错误", () => {
    const unclosed = parseJsonPath("data[0");
    expect(unclosed.ok).toBe(false);
    const odd = parseJsonPath("data[abc]");
    expect(odd.ok).toBe(false);
  });
});

describe("queryJson", () => {
  it("按路径取嵌套值并带类型说明", () => {
    const outcome = queryJson(JSON.stringify(DATA), "data.items[0].name");
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.text).toContain("第一项");
      expect(outcome.text).toContain("字符串");
    }
  });

  it("取数组与对象时输出 JSON 片段", () => {
    const tags = queryJson(JSON.stringify(DATA), "data.items[0].tags");
    expect(tags.ok).toBe(true);
    if (tags.ok) expect(tags.text).toContain('"a"');
    const count = queryJson(JSON.stringify(DATA), "data.total");
    expect(count.ok).toBe(true);
    if (count.ok) expect(count.text).toContain("2");
  });

  it("路径不存在时列出可用字段", () => {
    const outcome = queryJson(JSON.stringify(DATA), "data.nope");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("可用字段");
  });

  it("下标越界、类型不符、坏 JSON 都返回中文错误", () => {
    const overflow = queryJson(JSON.stringify(DATA), "data.items[9]");
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) expect(overflow.error).toContain("越界");
    const wrongType = queryJson(JSON.stringify(DATA), "data.code.deeper");
    expect(wrongType.ok).toBe(false);
    const broken = queryJson("{oops", "$");
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.error).toContain("不是合法 JSON");
  });

  it("原型链上的键不算字段（d.412.4.183）：toString/constructor/__proto__/valueOf 一律报没有字段", () => {
    // JSON.parse 产出的对象继承 Object.prototype；旧实现用 `in` 会把这些原型成员
    // 当成「字段存在」，返回 `function toString(){[native code]}` 这种假答案。
    const source = JSON.stringify(DATA); // {"code":0,"data":{...}}
    for (const key of ["toString", "constructor", "__proto__", "valueOf", "hasOwnProperty"]) {
      const outcome = queryJson(source, `data.${key}`);
      expect(outcome.ok, key).toBe(false);
      if (!outcome.ok) expect(outcome.error, key).toContain("没有字段");
    }
    // 顶层也一样
    const top = queryJson(source, "toString");
    expect(top.ok).toBe(false);
    if (!top.ok) expect(top.error).toContain("没有字段");
  });

  it("自有字段照常取值，包括 JSON 里真写出来的 constructor/__proto__ 键（d.412.4.183）", () => {
    // JSON.parse 用 DefineOwnProperty，所以下面两个键是真正的自有字段，必须能取到。
    const source = '{"constructor":"自有值","__proto__":7,"a":1}';
    const ctor = queryJson(source, "constructor");
    expect(ctor.ok).toBe(true);
    if (ctor.ok) expect(ctor.text).toContain("自有值");
    const proto = queryJson(source, "__proto__");
    expect(proto.ok).toBe(true);
    if (proto.ok) expect(proto.text).toContain("7");
    // 普通字段与嵌套路径不受影响
    const a = queryJson(source, "a");
    expect(a.ok).toBe(true);
    if (a.ok) expect(a.text).toContain("1");
  });

  it("根路径返回顶层概览而不是整段文档", () => {
    const outcome = queryJson(JSON.stringify(DATA), "$");
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.text).toContain("顶层是对象");
      expect(outcome.text).toContain("code");
    }
  });
});
