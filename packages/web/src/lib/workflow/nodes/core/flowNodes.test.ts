import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearNodeRegistry, requireNodeType } from "../../registry.js";
import type { NodeExecuteResult, NodeOutputData } from "../../types.js";
import { toOutputData } from "../../types.js";
import { createFakeContext, makeItems, type FakeContextOptions } from "./fakeContext.js";
import { registerCoreNodes } from "./index.js";
import { switchOutputCount } from "./switch.js";

/**
 * 流程/分支节点语义：输出口数量、分支归属、回环计数、等待与主动报错。
 * 这里重点覆盖「空数组 vs 缺输出口」——引擎按输出口索引连线，
 * 少给一个输出口会让某条分支时有时无。
 */

beforeEach(() => {
  clearNodeRegistry();
  registerCoreNodes();
});

async function run(
  type: string,
  parameters: Record<string, unknown>,
  options: FakeContextOptions = {},
): Promise<NodeOutputData> {
  const result: NodeExecuteResult = await requireNodeType(type).execute(
    createFakeContext({ parameters, ...options }),
  );
  return toOutputData(result);
}

function jsonOf(output: NodeOutputData, outputIndex = 0): Array<Record<string, unknown>> {
  return (output.main[outputIndex] ?? []).map((item) => item.json);
}

describe("条件判断（if）", () => {
  const parameters = {
    conditions: {
      combinator: "and",
      conditions: [{ left: "ok", operator: "equals", right: "ok" }],
    },
  };

  it("按条件分到 true / false 两个输出口", async () => {
    const output = await run("if", parameters, {
      input: makeItems({ v: "ok" }, { v: "no" }),
    });
    // 假上下文里的 left 是固定值，所以两条都进 true。
    expect(output.main).toHaveLength(2);
    expect(jsonOf(output, 0)).toHaveLength(2);
    expect(jsonOf(output, 1)).toHaveLength(0);
  });

  it("条件为空时全走 true（没写条件 = 不拦数据）", async () => {
    const output = await run("if", { conditions: {} }, { input: makeItems({ n: 1 }) });
    expect(jsonOf(output, 0)).toHaveLength(1);
    expect(jsonOf(output, 1)).toHaveLength(0);
  });

  it("两个输出口始终存在，即使一侧为空", async () => {
    const output = await run("if", { conditions: { combometry: "and", conditions: [] } });
    expect(output.main).toHaveLength(2);
  });
});

describe("分支（switch）", () => {
  it("getOutputCount = 规则数 + 1（未匹配口）", () => {
    // 没有规则时只剩一个未匹配口。
    expect(switchOutputCount({ rules: [] })).toBe(1);
    expect(switchOutputCount({ rules: [{ left: 1 }] })).toBe(2);
    expect(switchOutputCount({ rules: [{ left: 1 }, { left: 2 }, { left: 3 }] })).toBe(4);
  });

  it("坏 JSON 时 getOutputCount 保守返回 2，不抛错", () => {
    expect(switchOutputCount({ rules: "{oops" })).toBe(2);
    expect(switchOutputCount({ rules: "not-json" })).toBe(2);
  });

  it("按顺序匹配，未命中的进最后一个输出口", async () => {
    const output = await run(
      "switch",
      {
        rules: [
          { left: "a", operator: "equals", right: "a" },
          { left: "a", operator: "equals", right: "b" },
        ],
      },
      { input: makeItems({ n: 1 }) },
    );
    expect(output.main).toHaveLength(3);
    expect(output.main[0]).toHaveLength(1);
    expect(output.main[1]).toHaveLength(0);
    expect(output.main[2]).toHaveLength(0);
  });

  it("规则为空时所有数据进唯一的未匹配口", async () => {
    const output = await run("switch", { rules: [] }, { input: makeItems({ n: 1 }, { n: 2 }) });
    expect(output.main).toHaveLength(1);
    expect(jsonOf(output, 0)).toHaveLength(2);
  });
});

describe("合并（merge）", () => {
  const left = makeItems({ id: 1, side: "left" }, { id: 2, side: "left" });
  const right = makeItems({ id: 1, side: "right", extra: true }, { id: 3, side: "right" });
  const twoInputs = { input: [left, right] as ReturnType<typeof makeItems>[] };

  it("排队拼接：先左后右", async () => {
    const output = await run("merge", { mode: "append" }, twoInputs);
    expect(jsonOf(output).map((json) => json.id)).toEqual([1, 2, 1, 3]);
  });

  it("按下标配对：两边逐条合并（右侧同名字段覆盖左侧）", async () => {
    const output = await run("merge", { mode: "combineByPosition" }, twoInputs);
    expect(output.main[0]).toHaveLength(2);
    expect(jsonOf(output)[0]).toEqual({ id: 1, side: "right", extra: true });
  });

  it("按字段关联：合并匹配项并保留未匹配项", async () => {
    const output = await run(
      "merge",
      { mode: "combineByField", fieldsToMatch: [{ field1: "id", field2: "id" }], joinType: "keepEverything" },
      twoInputs,
    );
    expect(jsonOf(output).map((json) => [json.id, json.side, json.extra])).toEqual([
      [1, "right", true],
      [2, "left", undefined],
      [3, "right", undefined],
    ]);
  });

  it("按字段关联：只保留匹配项", async () => {
    const output = await run(
      "merge",
      { mode: "combineByField", fieldsToMatch: [{ field1: "id", field2: "id" }], joinType: "keepMatchesOnly" },
      twoInputs,
    );
    expect(jsonOf(output)).toHaveLength(1);
  });

  it("关联字段为空时报可读错误", async () => {
    await expect(
      run("merge", { mode: "combineByField", fieldsToMatch: [] }, twoInputs),
    ).rejects.toThrow(/至少要指定一组关联字段/);
  });

  it("只取一路", async () => {
    expect(jsonOf(await run("merge", { mode: "chooseBranch", branch: "input1" }, twoInputs))).toHaveLength(2);
    expect(jsonOf(await run("merge", { mode: "chooseBranch", branch: "input2" }, twoInputs))).toHaveLength(2);
    expect(jsonOf(await run("merge", { mode: "chooseBranch", branch: "input2" }, twoInputs))[0]?.side).toBe("right");
  });

  it("只有一个输入口有数据时也不报错", async () => {
    const output = await run("merge", { mode: "append" }, { input: left });
    expect(jsonOf(output)).toHaveLength(2);
  });
});

describe("分批循环（splitInBatches）", () => {
  const items = makeItems({ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }, { n: 5 });

  it("按 runIndex 逐批输出到循环口", async () => {
    const first = await run("splitInBatches", { batchSize: 2 }, { input: items, runIndex: 0 });
    expect(jsonOf(first, 0)).toHaveLength(2);
    expect(jsonOf(first, 1)).toHaveLength(0);

    const second = await run("splitInBatches", { batchSize: 2 }, { input: items, runIndex: 1 });
    expect(jsonOf(second, 0).map((json) => json.n)).toEqual([3, 4]);
  });

  it("批次发完后从完成口输出全部数据", async () => {
    const done = await run("splitInBatches", { batchSize: 2 }, { input: items, runIndex: 3 });
    expect(jsonOf(done, 0)).toHaveLength(0);
    expect(jsonOf(done, 1)).toHaveLength(5);
  });

  it("空输入直接走完成口", async () => {
    const output = await run("splitInBatches", { batchSize: 2 });
    expect(output.main).toHaveLength(2);
    expect(jsonOf(output, 1)).toHaveLength(0);
  });

  it("非法批次大小夹到 1", async () => {
    const output = await run("splitInBatches", { batchSize: 0 }, { input: items, runIndex: 0 });
    expect(jsonOf(output, 0)).toHaveLength(1);
  });
});

describe("等待（wait）", () => {
  it("按单位换算并调用 helpers.sleep（可取消信号一并传入）", async () => {
    const sleep = vi.fn(async () => {});
    const controller = new AbortController();
    const output = await run(
      "wait",
      { amount: 2, unit: "minutes" },
      { input: makeItems({ ok: true }), helpers: { sleep }, signal: controller.signal },
    );
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(120_000, controller.signal);
    expect(jsonOf(output)).toEqual([{ ok: true }]);
  });

  it("负数时长报错", async () => {
    await expect(run("wait", { amount: -1, unit: "seconds" })).rejects.toThrow(/不小于 0/);
  });

  it("超过单次执行上限时报错（而不是静默卡住）", async () => {
    await expect(run("wait", { amount: 100, unit: "hours" })).rejects.toThrow(/超过单次执行上限/);
  });

  it("sleep 被取消时包成可读错误", async () => {
    const sleep = vi.fn(async () => {
      throw new Error("已取消");
    });
    await expect(
      run("wait", { amount: 1, unit: "seconds" }, { helpers: { sleep } }),
    ).rejects.toThrow(/等待被中断/);
  });
});

describe("空操作 / 停止并报错", () => {
  it("空操作原样透传输入", async () => {
    const output = await run("noOperation", {}, { input: makeItems({ a: 1 }) });
    expect(jsonOf(output)).toEqual([{ a: 1 }]);
  });

  it("停止并报错抛出带说明的结构化错误", async () => {
    const error = await run("stopAndError", {
      errorMessage: "上游数据为空",
      errorDescription: "检查前置节点",
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("上游数据为空");
    expect((error as { description?: string }).description).toBe("检查前置节点");
    expect((error as { name: string }).name).toBe("WorkflowNodeError");
  });

  it("错误信息为空时使用默认文案", async () => {
    await expect(run("stopAndError", { errorMessage: "   " })).rejects.toThrow(/主动停止/);
  });
});
