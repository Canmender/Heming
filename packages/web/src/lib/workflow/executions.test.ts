import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryStorage, utf8Length } from "../memory/storage.js";
import type { StorageLike } from "../memory/types.js";
import {
  BINARY_DROPPED_MARK,
  EXECUTIONS_BYTE_LIMIT,
  EXECUTIONS_KEY,
  MAX_EXECUTIONS,
  TRUNCATED_MARK,
  prepareExecution,
  pruneExecutions,
  readExecutions,
  setWorkflowExecutionStorage,
  trimNodeRunData,
  useWorkflowExecutionsStore,
} from "./executions.js";
import { defaultWorkflowSettings } from "./model.js";
import {
  WORKFLOW_LIMITS,
  type Item,
  type NodeRunData,
  type WorkflowExecution,
} from "./types.js";

const NOW = 1_700_000_000_000;

function item(value: unknown): Item {
  return { json: { value } };
}

function makeRun(overrides: Partial<NodeRunData> = {}): NodeRunData {
  return {
    startTime: NOW,
    executionTime: 10,
    executionIndex: 0,
    source: [],
    status: "success",
    data: { main: [[item(1)]] },
    itemsTotal: 1,
    ...overrides,
  };
}

function makeExecution(overrides: Partial<WorkflowExecution> = {}): WorkflowExecution {
  return {
    id: "exec-1",
    workflowId: "wf-1",
    workflowName: "测试工作流",
    mode: "manual",
    status: "success",
    startedAt: NOW,
    runData: { "node-1": [makeRun()] },
    ...overrides,
  };
}

let mem: StorageLike;

beforeEach(() => {
  mem = createMemoryStorage();
  setWorkflowExecutionStorage(mem);
  useWorkflowExecutionsStore.setState({ executions: [] });
});

describe("trimNodeRunData", () => {
  it("所有输出口合计最多保留 200 条 items", () => {
    const many: Item[] = Array.from({ length: 600 }, (_, index) => item(index));
    const trimmed = trimNodeRunData({ main: [many, many] }, false);
    expect(trimmed?.main[0]).toHaveLength(WORKFLOW_LIMITS.maxItemsPerNodeRun);
    expect(trimmed?.main[1]).toHaveLength(0);
  });

  it("单条 item 超过 64KB 时替换成截断标记并保留预览", () => {
    const big = { blob: "x".repeat(WORKFLOW_LIMITS.maxItemPreviewBytes + 100) };
    const trimmed = trimNodeRunData({ main: [[{ json: big }]] }, false);
    const result = trimmed?.main[0]?.[0];
    expect(result?.json[TRUNCATED_MARK]).toBe(true);
    expect(typeof result?.json.preview).toBe("string");
    expect(result?.json.bytes).toBeGreaterThan(WORKFLOW_LIMITS.maxItemPreviewBytes);
  });

  it("二进制总量超过整条执行上限时整条丢弃并标注", () => {
    const base64 = "A".repeat(1_200_000);
    const items: Item[] = [
      { json: { a: 1 }, binary: { data: { data: base64, mimeType: "image/png" } } },
      { json: { a: 2 }, binary: { data: { data: base64, mimeType: "image/png" } } },
    ];
    const execution = prepareExecution(makeExecution({ runData: { "node-1": [makeRun({ data: { main: [items] } })] } }));
    const result = execution.runData["node-1"]?.[0]?.data?.main[0] ?? [];
    expect(result).toHaveLength(2);
    for (const entry of result) {
      expect(entry.binary).toBeUndefined();
      expect(entry.json[BINARY_DROPPED_MARK]).toBe(true);
    }
  });
});

describe("prepareExecution（saveData 设置）", () => {
  it("成功执行关闭 saveDataSuccessExecution 时不留 data，但保留 runData 条目与条数", () => {
    const settings = { ...defaultWorkflowSettings(), saveDataSuccessExecution: "none" as const };
    const execution = prepareExecution(makeExecution(), settings);
    const run = execution.runData["node-1"]?.[0];
    expect(run).toBeDefined();
    expect(run?.data).toBeUndefined();
    expect(run?.itemsTotal).toBe(1);
  });

  it("失败执行关闭 saveDataErrorExecution 时同样不留 data", () => {
    const settings = { ...defaultWorkflowSettings(), saveDataErrorExecution: "none" as const };
    const execution = prepareExecution(
      makeExecution({ status: "error", error: { message: "炸了" } }),
      settings,
    );
    expect(execution.runData["node-1"]?.[0]?.data).toBeUndefined();
    expect(execution.error?.message).toBe("炸了");
  });

  it("不传 settings 时保留 data（测试/内部调用不悄悄丢数据）", () => {
    const execution = prepareExecution(makeExecution());
    expect(execution.runData["node-1"]?.[0]?.data?.main[0]).toHaveLength(1);
  });
});

describe("pruneExecutions", () => {
  it("按开始时间倒序并限制 60 条", () => {
    const list = Array.from({ length: MAX_EXECUTIONS + 5 }, (_, index) =>
      makeExecution({ id: `e-${index}`, startedAt: NOW + index }),
    );
    const pruned = pruneExecutions(list);
    expect(pruned).toHaveLength(MAX_EXECUTIONS);
    expect(pruned[0]?.id).toBe(`e-${MAX_EXECUTIONS + 4}`);
  });

  it("超过 1MB 时继续淘汰，直到装得下或只剩一条", () => {
    const payload = "y".repeat(WORKFLOW_LIMITS.maxItemPreviewBytes - 100);
    const list = Array.from({ length: 30 }, (_, index) =>
      makeExecution({
        id: `e-${index}`,
        startedAt: NOW + index,
        runData: {
          "node-1": [makeRun({ data: { main: [[{ json: { payload } }]] } })],
        },
      }),
    );
    const pruned = pruneExecutions(list);
    expect(pruned.length).toBeLessThan(30);
    const bytes = utf8Length(JSON.stringify(pruned));
    expect(bytes).toBeLessThanOrEqual(EXECUTIONS_BYTE_LIMIT);
  });
});

describe("readExecutions", () => {
  it("坏条目逐条丢弃，合法条目保留并再裁剪", () => {
    const valid = makeExecution({ id: "e-valid" });
    mem.setItem(
      EXECUTIONS_KEY,
      JSON.stringify([
        valid,
        { id: "no-workflow" },
        "字符串",
        { ...makeExecution({ id: "e-2" }), startedAt: "not-a-number" },
      ]),
    );
    const executions = readExecutions(mem);
    expect(executions.map((execution) => execution.id)).toEqual(["e-valid"]);
  });

  it("键损坏时回退空列表", () => {
    mem.setItem(EXECUTIONS_KEY, "!!!");
    expect(readExecutions(mem)).toEqual([]);
  });
});

describe("executions store", () => {
  it("add 落盘、最新在前，并返回裁剪后的记录", () => {
    const older = makeExecution({ id: "e-1", startedAt: NOW - 1000 });
    const newer = makeExecution({ id: "e-2", startedAt: NOW });
    useWorkflowExecutionsStore.getState().add(older);
    const stored = useWorkflowExecutionsStore.getState().add(newer);
    expect(stored?.id).toBe("e-2");
    const list = useWorkflowExecutionsStore.getState().list();
    expect(list.map((execution) => execution.id)).toEqual(["e-2", "e-1"]);
    const onDisk = JSON.parse(mem.getItem(EXECUTIONS_KEY) ?? "[]") as WorkflowExecution[];
    expect(onDisk.map((execution) => execution.id)).toEqual(["e-2", "e-1"]);
  });

  it("手动执行但关闭 saveManualExecutions 时不记录", () => {
    const settings = { ...defaultWorkflowSettings(), saveManualExecutions: false };
    const result = useWorkflowExecutionsStore
      .getState()
      .add(makeExecution({ mode: "manual" }), settings);
    expect(result).toBeNull();
    expect(useWorkflowExecutionsStore.getState().list()).toEqual([]);
    // 定时触发不受这个开关影响
    const scheduled = useWorkflowExecutionsStore
      .getState()
      .add(makeExecution({ id: "e-trigger", mode: "trigger" }), settings);
    expect(scheduled?.id).toBe("e-trigger");
  });

  it("byWorkflow / remove / removeForWorkflow / clear", () => {
    useWorkflowExecutionsStore.getState().add(makeExecution({ id: "a", workflowId: "wf-1" }));
    useWorkflowExecutionsStore.getState().add(makeExecution({ id: "b", workflowId: "wf-2" }));
    expect(
      useWorkflowExecutionsStore
        .getState()
        .byWorkflow("wf-1")
        .map((execution) => execution.id),
    ).toEqual(["a"]);

    useWorkflowExecutionsStore.getState().remove("a");
    expect(useWorkflowExecutionsStore.getState().list().map((execution) => execution.id)).toEqual([
      "b",
    ]);

    useWorkflowExecutionsStore.getState().add(makeExecution({ id: "c", workflowId: "wf-2" }));
    useWorkflowExecutionsStore.getState().removeForWorkflow("wf-2");
    expect(useWorkflowExecutionsStore.getState().list()).toEqual([]);

    useWorkflowExecutionsStore.getState().add(makeExecution({ id: "d" }));
    useWorkflowExecutionsStore.getState().clear();
    expect(useWorkflowExecutionsStore.getState().list()).toEqual([]);
  });

  it("落盘失败时保留内存态（返回记录但不落盘）", () => {
    const broken: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => undefined,
    };
    setWorkflowExecutionStorage(broken);
    const stored = useWorkflowExecutionsStore.getState().add(makeExecution({ id: "e-x" }));
    expect(stored?.id).toBe("e-x");
    expect(useWorkflowExecutionsStore.getState().list()).toHaveLength(1);
  });
});
