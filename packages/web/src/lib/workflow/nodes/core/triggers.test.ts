import { beforeEach, describe, expect, it } from "vitest";
import { clearNodeRegistry, getNodeType } from "../../registry.js";
import { createFakeContext, makeItems } from "./fakeContext.js";
import { registerCoreNodes } from "./index.js";
import type { INodeType } from "../../types.js";

/**
 * 触发器的共同契约：没有输入口、只有 1 个输出口、都带 `isTrigger`，
 * 以及在「没有触发数据」时至少产出一条空 item（否则手动调试整条工作流不会动）。
 */

function nodeType(type: string): INodeType {
  const found = getNodeType(type);
  if (!found) throw new Error(`未注册：${type}`);
  return found;
}

beforeEach(() => {
  clearNodeRegistry();
  registerCoreNodes();
});

describe("手动触发", () => {
  it("没有输入数据时产出一条空 item", async () => {
    const output = await nodeType("manualTrigger").execute(createFakeContext());
    expect(output).toEqual({ main: [[{ json: {} }]] });
  });

  it("调用方给了触发数据时原样输出", async () => {
    const items = makeItems({ from: "caller" });
    const output = await nodeType("manualTrigger").execute(createFakeContext({ input: items }));
    expect(output).toEqual({ main: [items] });
  });
});

describe("错误触发", () => {
  it("把错误上下文原样透传给下游", async () => {
    const items = makeItems({ error: { message: "上游失败" }, workflow: { id: "wf-1" } });
    const output = await nodeType("errorTrigger").execute(createFakeContext({ input: items }));
    expect(output).toEqual({ main: [items] });
  });

  it("手动运行（没有错误上下文）时产出一条空 item", async () => {
    const output = await nodeType("errorTrigger").execute(createFakeContext());
    expect(output).toEqual({ main: [[{ json: {} }]] });
  });
});

describe("子流程触发", () => {
  it("透传父流程传入的 items", async () => {
    const items = makeItems({ orderId: 42 });
    const output = await nodeType("executeWorkflowTrigger").execute(
      createFakeContext({ input: items }),
    );
    expect(output).toEqual({ main: [items] });
  });

  it("手动运行子流程时产出一条空 item，便于调试", async () => {
    const output = await nodeType("executeWorkflowTrigger").execute(createFakeContext());
    expect(output).toEqual({ main: [[{ json: {} }]] });
  });
});

describe("触发器注册信息", () => {
  it("四种触发器都已注册，且带 isTrigger / trigger 标记", () => {
    const expected = [
      ["manualTrigger", "manual"],
      ["scheduleTrigger", "schedule"],
      ["errorTrigger", "error"],
      ["executeWorkflowTrigger", "subworkflow"],
    ] as const;
    for (const [type, trigger] of expected) {
      const description = nodeType(type).description;
      expect(description.isTrigger).toBe(true);
      expect(description.trigger).toBe(trigger);
      expect(description.inputs).toBe(0);
      expect(description.outputs).toBe(1);
      expect(description.displayName.trim()).not.toBe("");
      expect(description.description.trim()).not.toBe("");
    }
  });

  it("所有 trigger 分组节点都声明了中文名（无 emoji）", () => {
    for (const type of ["manualTrigger", "scheduleTrigger", "errorTrigger", "executeWorkflowTrigger"]) {
      const { description } = nodeType(type);
      expect(description.group).toBe("trigger");
      expect(/[\u4e00-\u9fff]/.test(description.displayName)).toBe(true);
    }
  });
});
