import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearNodeRegistry, requireNodeType } from "../../registry.js";
import type { NodeExecuteResult, NodeOutputData, SubWorkflowParams, SubWorkflowResult } from "../../types.js";
import { toOutputData } from "../../types.js";
import { createFakeContext, makeItems } from "./fakeContext.js";
import { registerCoreNodes } from "./index.js";

/**
 * 执行子流程节点只做三件事：校验参数、调用宿主注入的 executeSubWorkflow、
 * 把子流程结果/失败翻译成本节点的输出/错误。测试用假执行器钉住这层翻译，
 * 尤其是「子执行 status=error 要按本节点失败处理」。
 */

beforeEach(() => {
  clearNodeRegistry();
  registerCoreNodes();
});

function subExecution(status: "success" | "error" | "canceled", errorMessage?: string): SubWorkflowResult {
  return {
    execution: {
      id: "exec-child",
      workflowId: "wf-child",
      workflowName: "子工作流",
      mode: "subworkflow",
      status,
      startedAt: 0,
      runData: {},
      error: errorMessage ? { message: errorMessage } : undefined,
    },
    output: makeItems({ fromChild: true }),
  };
}

async function run(
  parameters: Record<string, unknown>,
  executor: ((params: SubWorkflowParams) => Promise<SubWorkflowResult>) | null,
  input?: ReturnType<typeof makeItems>,
): Promise<NodeOutputData> {
  const context = createFakeContext({
    parameters,
    input,
    helpers: executor ? { executeSubWorkflow: executor } : {},
    executionId: "exec-parent",
  });
  const result: NodeExecuteResult = await requireNodeType("executeWorkflow").execute(context);
  return toOutputData(result);
}

describe("执行子流程", () => {
  it("把 workflowId、父执行 id、输入数据交给宿主", async () => {
    const executor = vi.fn(async (_params: SubWorkflowParams) => subExecution("success"));
    const input = makeItems({ orderId: 1 });
    const output = await run({ workflowId: "wf-child" }, executor, input);
    const params = executor.mock.calls[0]?.[0] as SubWorkflowParams;
    expect(params.workflowId).toBe("wf-child");
    expect(params.mode).toBe("subworkflow");
    expect(params.parentExecutionId).toBe("exec-parent");
    expect(params.inputData).toEqual(input);
    expect(output.main[0]?.map((item) => item.json)).toEqual([{ fromChild: true }]);
  });

  it("没有注入子流程执行器时报可读错误", async () => {
    await expect(run({ workflowId: "wf-child" }, null)).rejects.toThrow(/子流程执行器未注入/);
  });

  it("缺少目标工作流 id 时报错", async () => {
    await expect(run({ workflowId: "  " }, async () => subExecution("success"))).rejects.toThrow(
      /缺少目标工作流/,
    );
  });

  it("子执行失败按本节点失败处理，错误里带子工作流名与原因", async () => {
    const error = await run({ workflowId: "wf-child" }, async () =>
      subExecution("error", "下游节点失败"),
    ).catch((caught: unknown) => caught);
    expect((error as Error).message).toBe("子工作流「子工作流」执行失败");
    expect((error as { description?: string }).description).toBe("下游节点失败");
  });

  it("子执行被取消也按失败处理", async () => {
    await expect(
      run({ workflowId: "wf-child" }, async () => subExecution("canceled")),
    ).rejects.toThrow(/已取消/);
  });

  it("执行器抛错时包成可读错误", async () => {
    await expect(
      run({ workflowId: "wf-child" }, async () => {
        throw new Error("递归深度超限");
      }),
    ).rejects.toThrow(/子流程执行失败：递归深度超限/);
  });
});
