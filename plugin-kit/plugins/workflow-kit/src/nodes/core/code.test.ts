import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearNodeRegistry, requireNodeType } from "../../registry.js";
import type { Item, NodeExecuteResult, NodeOutputData, RunUserCodeOptions } from "../../types.js";
import { toOutputData } from "../../types.js";
import { createFakeContext, makeItems } from "./fakeContext.js";
import { registerCoreNodes } from "./index.js";

/**
 * 代码节点本身不执行代码：它只负责把参数交给注入的沙箱 runner，并把 runner
 * 的返回值收敛成 items。测试用假 runner 覆盖两种运行方式与错误包装，
 * 不依赖真实 Worker（wf-expr 的沙箱有自己的测试）。
 */

beforeEach(() => {
  clearNodeRegistry();
  registerCoreNodes();
});

async function run(
  parameters: Record<string, unknown>,
  runner: ((options: RunUserCodeOptions) => Promise<unknown>) | null,
  input?: Item[],
): Promise<NodeOutputData> {
  const context = createFakeContext({
    parameters,
    input,
    helpers: runner ? { runUserCode: runner } : {},
  });
  const result: NodeExecuteResult = await requireNodeType("code").execute(context);
  return toOutputData(result);
}

describe("代码节点", () => {
  it("没有注入沙箱时给出可读错误（绝不偷偷 eval）", async () => {
    await expect(run({ code: "return 1" }, null)).rejects.toThrow(/代码运行器未注入/);
  });

  it("代码为空时报错", async () => {
    await expect(run({ code: "   " }, async () => [])).rejects.toThrow(/没有可执行的代码/);
  });

  it("全部数据模式：把返回值收敛成 items（普通对象包 json）", async () => {
    const runner = vi.fn(async (_options: RunUserCodeOptions) => [{ a: 1 }, { a: 2 }]);
    const output = await run({ mode: "runOnceForAllItems", code: "return items" }, runner, makeItems({ n: 1 }));
    const options = runner.mock.calls[0]?.[0] as RunUserCodeOptions;
    expect(options.mode).toBe("runOnceForAllItems");
    expect(options.items).toHaveLength(1);
    expect(options.itemIndex).toBeUndefined();
    expect(output.main[0]?.map((item) => item.json)).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("全部数据模式：{json} 形状原样保留，标量包成 value", async () => {
    const wrapped = await run({ code: "x" }, async () => [{ json: { ok: true } }]);
    expect(wrapped.main[0]?.[0]?.json).toEqual({ ok: true });

    const scalar = await run({ code: "x" }, async () => 42);
    expect(scalar.main[0]).toEqual([{ json: { value: 42 } }]);
  });

  it("全部数据模式：返回 undefined/null 时没有输出", async () => {
    expect((await run({ code: "x" }, async () => undefined)).main[0]).toEqual([]);
    expect((await run({ code: "x" }, async () => null)).main[0]).toEqual([]);
  });

  it("逐条模式：每条调用一次并带上 itemIndex", async () => {
    const seen: Array<number | undefined> = [];
    const runner = async (options: RunUserCodeOptions) => {
      seen.push(options.itemIndex);
      return { doubled: Number(options.items[options.itemIndex ?? 0]?.json.n ?? 0) * 2 };
    };
    const output = await run({ mode: "runOnceForEachItem", code: "x" }, runner, makeItems({ n: 1 }, { n: 2 }));
    expect(seen).toEqual([0, 1]);
    expect(output.main[0]?.map((item) => item.json)).toEqual([{ doubled: 2 }, { doubled: 4 }]);
  });

  it("逐条模式：某条返回空值时保留一条空 item，条数与输入对齐", async () => {
    const output = await run(
      { mode: "runOnceForEachItem", code: "x" },
      async (options) => (options.itemIndex === 0 ? { ok: true } : undefined),
      makeItems({ n: 1 }, { n: 2 }),
    );
    expect(output.main[0]).toHaveLength(2);
    expect(output.main[0]?.[1]).toEqual({ json: {} });
  });

  it("runner 抛错时包成 WorkflowNodeError，保留可读原因", async () => {
    const error = await run({ code: "throw new Error('boom')" }, async () => {
      throw new Error("沙箱拒绝了 fetch");
    }).catch((caught: unknown) => caught);
    expect((error as Error).name).toBe("WorkflowNodeError");
    expect((error as Error).message).toBe("代码执行失败：沙箱拒绝了 fetch");
  });

  it("超时参数夹紧到允许区间后传给 runner", async () => {
    const runner = vi.fn(async (_options: RunUserCodeOptions) => []);
    await run({ code: "x", timeoutMs: 1 }, runner);
    expect((runner.mock.calls[0]?.[0] as RunUserCodeOptions).timeoutMs).toBe(200);
  });
});
