import { beforeEach, describe, expect, it } from "vitest";
import { clearNodeRegistry, requireNodeType } from "../../registry.js";
import type { NodeExecuteResult, NodeOutputData } from "../../types.js";
import { toOutputData } from "../../types.js";
import { createFakeContext, makeItems, type FakeContextOptions } from "./fakeContext.js";
import { registerCoreNodes } from "./index.js";

/**
 * 数据类节点语义测试：直接调 `execute`，用假上下文给输入与参数。
 * 覆盖正常路径 + 参数错误路径；比较口径（数字/字符串/缺字段）是重点，
 * 因为这类规则一旦分叉，用户在画布上根本看不出是哪一步变了。
 *
 * 注意：当前引擎按「本次运行的第一个 item」解析参数，所以条件里的值对同一批
 * item 是同一个；逐 item 表达式求值属于下一轮能力（见完成汇报的遗留说明）。
 */

beforeEach(() => {
  clearNodeRegistry();
  registerCoreNodes();
});

async function run(
  type: string,
  parameters: Record<string, unknown>,
  input?: FakeContextOptions["input"],
): Promise<NodeOutputData> {
  const result: NodeExecuteResult = await requireNodeType(type).execute(
    createFakeContext({ parameters, input }),
  );
  return toOutputData(result);
}

function jsonOf(output: NodeOutputData, outputIndex = 0): Array<Record<string, unknown>> {
  return (output.main[outputIndex] ?? []).map((item) => item.json);
}

describe("设置字段（set）", () => {
  it("添加字段并保留原字段", async () => {
    const output = await run(
      "set",
      { mode: "manual", fields: [{ name: "status", value: "done" }], includeOtherFields: true },
      makeItems({ id: 1 }),
    );
    expect(jsonOf(output)).toEqual([{ id: 1, status: "done" }]);
  });

  it("关闭「保留其它字段」时只输出设置的字段", async () => {
    const output = await run(
      "set",
      { mode: "manual", fields: [{ name: "only", value: 1 }], includeOtherFields: false },
      makeItems({ id: 1, extra: true }),
    );
    expect(jsonOf(output)).toEqual([{ only: 1 }]);
  });

  it("没有输入时也产出一条数据（可用于构造初始数据）", async () => {
    const output = await run("set", {
      mode: "manual",
      fields: [{ name: "hello", value: "world" }],
      includeOtherFields: true,
    });
    expect(jsonOf(output)).toEqual([{ hello: "world" }]);
  });

  it("JSON 模式整体替换输出", async () => {
    const output = await run(
      "set",
      { mode: "raw", value: [{ a: 1 }, { a: 2 }] },
      makeItems({ ignored: true }),
    );
    expect(jsonOf(output)).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("字段列表为空时报可读错误", async () => {
    await expect(
      run("set", { mode: "manual", fields: [], includeOtherFields: true }),
    ).rejects.toThrow(/没有任何有效字段/);
  });
});

describe("过滤（filter）", () => {
  const matching = {
    combinator: "and",
    conditions: [{ left: "yes", operator: "equals", right: "yes" }],
  };
  const notMatching = {
    combinator: "and",
    conditions: [{ left: "no", operator: "equals", right: "yes" }],
  };

  it("保留匹配数据（条件成立时全保留）", async () => {
    const output = await run(
      "filter",
      { conditions: matching, keepOnlyMatching: true },
      makeItems({ n: 1 }, { n: 2 }, { n: 3 }),
    );
    expect(jsonOf(output).map((json) => json.n)).toEqual([1, 2, 3]);
  });

  it("条件不成立时全部丢弃", async () => {
    const output = await run(
      "filter",
      { conditions: notMatching, keepOnlyMatching: true },
      makeItems({ n: 1 }, { n: 2 }),
    );
    expect(jsonOf(output)).toEqual([]);
  });

  it("可以反转为只丢弃匹配数据", async () => {
    const output = await run(
      "filter",
      { conditions: matching, keepOnlyMatching: false },
      makeItems({ n: 1 }, { n: 2 }),
    );
    expect(jsonOf(output)).toEqual([]);
    const inverted = await run(
      "filter",
      { conditions: notMatching, keepOnlyMatching: false },
      makeItems({ n: 1 }, { n: 2 }),
    );
    expect(jsonOf(inverted).map((json) => json.n)).toEqual([1, 2]);
  });

  it("未知运算符报错（不静默当成不成立）", async () => {
    await expect(
      run(
        "filter",
        {
          conditions: { conditions: [{ left: 1, operator: "approximately", right: 1 }] },
        },
        makeItems({ n: 1 }),
      ),
    ).rejects.toThrow(/不支持的条件运算符/);
  });
});

describe("排序（sort）", () => {
  it("按数字升序，缺字段的排最后", async () => {
    const output = await run(
      "sort",
      { sortByField: "score", order: "asc", type: "number" },
      makeItems({ id: "a", score: 30 }, { id: "b" }, { id: "c", score: 10 }),
    );
    expect(jsonOf(output).map((json) => json.id)).toEqual(["c", "a", "b"]);
  });

  it("按字符串降序", async () => {
    const output = await run(
      "sort",
      { sortByField: "name", order: "desc", type: "string" },
      makeItems({ name: "banana" }, { name: "apple" }, { name: "cherry" }),
    );
    expect(jsonOf(output).map((json) => json.name)).toEqual(["cherry", "banana", "apple"]);
  });

  it("排序字段留空时保持原顺序", async () => {
    const input = makeItems({ n: 2 }, { n: 1 });
    const output = await run("sort", { sortByField: "", order: "asc", type: "number" }, input);
    expect(jsonOf(output).map((json) => json.n)).toEqual([2, 1]);
  });

  it("按日期时间排序", async () => {
    const output = await run(
      "sort",
      { sortByField: "at", order: "asc", type: "dateTime" },
      makeItems({ at: "2026-11-08T09:00:00" }, { at: "2026-11-07T09:00:00" }),
    );
    expect(jsonOf(output).map((json) => json.at)).toEqual([
      "2026-11-07T09:00:00",
      "2026-11-08T09:00:00",
    ]);
  });
});

describe("限制数量（limit）", () => {
  it("取前 N 条", async () => {
    const output = await run("limit", { maxItems: 2, keep: "firstItems" }, makeItems({ n: 1 }, { n: 2 }, { n: 3 }));
    expect(jsonOf(output).map((json) => json.n)).toEqual([1, 2]);
  });

  it("取后 N 条", async () => {
    const output = await run("limit", { maxItems: 2, keep: "lastItems" }, makeItems({ n: 1 }, { n: 2 }, { n: 3 }));
    expect(jsonOf(output).map((json) => json.n)).toEqual([2, 3]);
  });

  it("N 大于数据量时全量输出，N 为 0 时为空", async () => {
    expect(jsonOf(await run("limit", { maxItems: 10 }, makeItems({ n: 1 })))).toHaveLength(1);
    expect(jsonOf(await run("limit", { maxItems: 0 }, makeItems({ n: 1 })))).toHaveLength(0);
  });
});

describe("去重（removeDuplicates）", () => {
  it("整条 JSON 去重，键顺序不同也算重复", async () => {
    const output = await run(
      "removeDuplicates",
      { mode: "allFields" },
      makeItems({ a: 1, b: 2 }, { b: 2, a: 1 }, { a: 1 }),
    );
    // {a:1,b:2} 与 {b:2,a:1} 是同一份数据；最后一条 {a:1} 字段不同，保留。
    expect(jsonOf(output)).toEqual([{ a: 1, b: 2 }, { a: 1 }]);
  });

  it("按指定字段去重，保留首次出现", async () => {
    const output = await run(
      "removeDuplicates",
      { mode: "selectedFields", fields: ["id"] },
      makeItems({ id: 1, n: "first" }, { id: 2, n: "other" }, { id: 1, n: "second" }),
    );
    expect(jsonOf(output).map((json) => json.n)).toEqual(["first", "other"]);
  });

  it("指定字段模式但没选字段时退化为整条比较", async () => {
    const output = await run(
      "removeDuplicates",
      { mode: "selectedFields", fields: [] },
      makeItems({ a: 1 }, { a: 1 }),
    );
    expect(jsonOf(output)).toEqual([{ a: 1 }]);
  });
});

describe("拆分（splitOut）", () => {
  it("数组里的对象逐条输出", async () => {
    const output = await run(
      "splitOut",
      { fieldToSplitOut: "items", includeOtherFields: false, destinationFieldName: "value" },
      makeItems({ items: [{ name: "a" }, { name: "b" }] }),
    );
    expect(jsonOf(output)).toEqual([{ name: "a" }, { name: "b" }]);
  });

  it("保留外层字段时合并且去掉原数组字段", async () => {
    const output = await run(
      "splitOut",
      { fieldToSplitOut: "items", includeOtherFields: true, destinationFieldName: "value" },
      makeItems({ orderId: 7, items: [{ name: "a" }] }),
    );
    expect(jsonOf(output)).toEqual([{ orderId: 7, name: "a" }]);
  });

  it("标量放进目标字段", async () => {
    const output = await run(
      "splitOut",
      { fieldToSplitOut: "tags", includeOtherFields: false, destinationFieldName: "tag" },
      makeItems({ tags: ["red", "blue"] }),
    );
    expect(jsonOf(output)).toEqual([{ tag: "red" }, { tag: "blue" }]);
  });

  it("字段缺失时跳过该条；未配置字段时输出为空", async () => {
    expect(jsonOf(await run("splitOut", { fieldToSplitOut: "items" }, makeItems({ other: 1 })))).toHaveLength(0);
    expect(jsonOf(await run("splitOut", { fieldToSplitOut: "" }, makeItems({ items: [1] })))).toHaveLength(0);
  });
});

describe("汇总（aggregate）", () => {
  it("收集全部数据到一个数组字段", async () => {
    const output = await run(
      "aggregate",
      { aggregate: "allItemData", destinationFieldName: "rows" },
      makeItems({ n: 1 }, { n: 2 }),
    );
    expect(jsonOf(output)).toEqual([{ rows: [{ n: 1 }, { n: 2 }] }]);
  });

  it("按字段聚合：求和/平均/计数", async () => {
    const items = () => makeItems({ amount: 10 }, { amount: 20 }, { amount: 30 });
    const sum = await run(
      "aggregate",
      {
        aggregate: "individualFields",
        fieldsToAggregate: [{ fieldName: "amount", aggregation: "sum" }],
      },
      items(),
    );
    expect(jsonOf(sum)).toEqual([{ amount: 60 }]);

    const average = await run(
      "aggregate",
      {
        aggregate: "individualFields",
        fieldsToAggregate: [{ fieldName: "amount", aggregation: "average" }],
      },
      items(),
    );
    expect(jsonOf(average)).toEqual([{ amount: 20 }]);

    const count = await run(
      "aggregate",
      {
        aggregate: "individualFields",
        fieldsToAggregate: [{ fieldName: "amount", aggregation: "count" }],
      },
      items(),
    );
    expect(jsonOf(count)).toEqual([{ amount: 3 }]);
  });

  it("按字段聚合：去重与拼接", async () => {
    const items = () => makeItems({ tag: "a" }, { tag: "b" }, { tag: "a" });
    const unique = await run(
      "aggregate",
      {
        aggregate: "individualFields",
        fieldsToAggregate: [{ fieldName: "tag", aggregation: "unique" }],
      },
      items(),
    );
    expect(jsonOf(unique)).toEqual([{ tag: ["a", "b"] }]);

    const concatenate = await run(
      "aggregate",
      {
        aggregate: "individualFields",
        fieldsToAggregate: [{ fieldName: "tag", aggregation: "concatenate" }],
      },
      items(),
    );
    expect(jsonOf(concatenate)).toEqual([{ tag: "a,b,a" }]);
  });

  it("空输入也输出一条（计数 0、数组为空）", async () => {
    const all = await run("aggregate", { aggregate: "allItemData", destinationFieldName: "rows" });
    expect(jsonOf(all)).toEqual([{ rows: [] }]);
    const field = await run("aggregate", {
      aggregate: "individualFields",
      fieldsToAggregate: [{ fieldName: "amount", aggregation: "count" }],
    });
    expect(jsonOf(field)).toEqual([{ amount: 0 }]);
  });
});

describe("列表操作（itemLists）", () => {
  it("限制数量", async () => {
    const output = await run(
      "itemLists",
      { operation: "limit", maxItems: 1, keep: "lastItems" },
      makeItems({ n: 1 }, { n: 2 }),
    );
    expect(jsonOf(output)).toEqual([{ n: 2 }]);
  });

  it("排序", async () => {
    const output = await run(
      "itemLists",
      { operation: "sort", sortByField: "n", order: "desc", type: "number" },
      makeItems({ n: 1 }, { n: 3 }, { n: 2 }),
    );
    expect(jsonOf(output).map((json) => json.n)).toEqual([3, 2, 1]);
  });

  it("去重与拆分复用独立节点的同一套语义", async () => {
    const deduped = await run(
      "itemLists",
      { operation: "removeDuplicates", mode: "allFields" },
      makeItems({ a: 1 }, { a: 1 }),
    );
    expect(jsonOf(deduped)).toHaveLength(1);

    const split = await run(
      "itemLists",
      { operation: "splitOut", fieldToSplitOut: "items", destinationFieldName: "value" },
      makeItems({ items: [1, 2] }),
    );
    expect(jsonOf(split)).toEqual([{ value: 1 }, { value: 2 }]);
  });

  it("汇总", async () => {
    const output = await run(
      "itemLists",
      { operation: "aggregateItems", aggregate: "allItemData", destinationFieldName: "data" },
      makeItems({ a: 1 }),
    );
    expect(jsonOf(output)).toEqual([{ data: [{ a: 1 }] }]);
  });
});
