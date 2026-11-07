import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryStorage } from "../memory/storage.js";
import type { StorageLike } from "../memory/types.js";
import { WORKFLOW_LIMITS, type Workflow, type WorkflowNode } from "./types.js";
import { createWorkflow } from "./model.js";
import {
  WORKFLOWS_KEY,
  readWorkflows,
  setWorkflowStorage,
  useWorkflowStore,
  workflowByteSize,
} from "./store.js";

const NOW = 1_700_000_000_000;

function makeWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return { ...createWorkflow({ name: "测试工作流", now: NOW }), ...overrides };
}

function makeNode(id: string, name: string, type = "set"): WorkflowNode {
  return { id, name, type, position: { x: 100, y: 100 }, parameters: {} };
}

let mem: StorageLike;

beforeEach(() => {
  mem = createMemoryStorage();
  setWorkflowStorage(mem);
  useWorkflowStore.setState({ workflows: [], selectedId: null });
});

describe("readWorkflows", () => {
  it("坏条目逐条丢弃、重复 id 去重、按更新时间倒序", () => {
    const older = makeWorkflow({ id: "wf-old", name: "旧", updatedAt: NOW - 1000 });
    const newer = makeWorkflow({ id: "wf-new", name: "新", updatedAt: NOW });
    // 非对象、重复 id 都要丢；note: normalizeWorkflow 对空对象会补一个 id，
    // 所以这里用一个不合法到无法归一的条目（字符串）与重复 id 来验证丢弃。
    mem.setItem(WORKFLOWS_KEY, JSON.stringify([older, "坏数据", newer, older]));
    const workflows = readWorkflows(mem, NOW);
    expect(workflows.map((workflow) => workflow.id)).toEqual(["wf-new", "wf-old"]);
  });

  it("读盘最多保留上限条数", () => {
    const list = Array.from({ length: WORKFLOW_LIMITS.maxWorkflows + 5 }, (_, index) =>
      makeWorkflow({ id: `wf-${index}`, name: `工作流 ${index}`, updatedAt: NOW - index }),
    );
    mem.setItem(WORKFLOWS_KEY, JSON.stringify(list));
    expect(readWorkflows(mem, NOW)).toHaveLength(WORKFLOW_LIMITS.maxWorkflows);
  });

  it("键损坏时回退空列表", () => {
    mem.setItem(WORKFLOWS_KEY, "{不是 JSON");
    expect(readWorkflows(mem, NOW)).toEqual([]);
  });
});

describe("create / update / save", () => {
  it("新建后落盘、自动选中，并记录在列表里", () => {
    const result = useWorkflowStore.getState().create({ name: "我的工作流" }, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const state = useWorkflowStore.getState();
    expect(state.workflows).toHaveLength(1);
    expect(state.selectedId).toBe(result.workflow.id);
    expect(state.workflows[0]?.name).toBe("我的工作流");
    const stored = JSON.parse(mem.getItem(WORKFLOWS_KEY) ?? "[]") as Workflow[];
    expect(stored).toHaveLength(1);
    expect(stored[0]?.id).toBe(result.workflow.id);
  });

  it("create 带模板时克隆出新 id 的节点，不共享原节点", () => {
    const template = makeWorkflow({ nodes: [makeNode("n1", "设置")] });
    const result = useWorkflowStore.getState().create({ from: template, name: "副本流程" }, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workflow.nodes).toHaveLength(1);
    expect(result.workflow.nodes[0]?.id).not.toBe("n1");
    expect(result.workflow.name).toBe("副本流程");
  });

  it("update 支持补丁与 updater，保存时刷新 updatedAt/versionId", () => {
    const created = useWorkflowStore.getState().create({ name: "原名" }, NOW);
    if (!created.ok) throw new Error(created.error);
    const id = created.workflow.id;
    const before = useWorkflowStore.getState().workflows[0] as Workflow;

    const updated = useWorkflowStore.getState().update(id, { name: "新名字" }, NOW + 1000);
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.workflow.name).toBe("新名字");
    expect(updated.workflow.updatedAt).toBe(NOW + 1000);
    expect(updated.workflow.versionId).not.toBe(before.versionId);
    expect(useWorkflowStore.getState().workflows[0]?.id).toBe(id);

    const viaUpdater = useWorkflowStore
      .getState()
      .update(
        id,
        (current) => ({ ...current, description: "由 updater 写入" }),
        NOW + 2000,
      );
    expect(viaUpdater.ok).toBe(true);
    if (!viaUpdater.ok) return;
    expect(viaUpdater.workflow.description).toBe("由 updater 写入");
    expect(viaUpdater.workflow.updatedAt).toBe(NOW + 2000);
  });

  it("update 不存在的 id 返回中文错误", () => {
    const result = useWorkflowStore.getState().update("wf-missing", { name: "x" }, NOW);
    expect(result).toEqual({ ok: false, error: "工作流不存在（可能已被删除）" });
  });

  it("单条超过 512KB 时拒绝保存且不改内存态", () => {
    const created = useWorkflowStore.getState().create({ name: "大流程" }, NOW);
    if (!created.ok) throw new Error(created.error);
    const huge = "x".repeat(WORKFLOW_LIMITS.maxWorkflowBytes + 1024);
    const result = useWorkflowStore.getState().update(
      created.workflow.id,
      { nodes: [{ ...makeNode("n1", "设置"), parameters: { blob: huge } }] },
      NOW + 1000,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("工作流太大");
    // 内存里还是原来的空工作流
    expect(useWorkflowStore.getState().workflows[0]?.nodes).toHaveLength(0);
  });

  it("save 可以整条覆盖内容", () => {
    const created = useWorkflowStore.getState().create({ name: "保存测试" }, NOW);
    if (!created.ok) throw new Error(created.error);
    const next: Workflow = {
      ...created.workflow,
      nodes: [makeNode("n1", "设置")],
      connections: {},
    };
    const saved = useWorkflowStore.getState().save(created.workflow.id, next, NOW + 500);
    expect(saved.ok).toBe(true);
    expect(useWorkflowStore.getState().workflows[0]?.nodes).toHaveLength(1);
  });
});

describe("remove / duplicate / select / setActive", () => {
  it("删除后清掉选中态并落盘", () => {
    const created = useWorkflowStore.getState().create({ name: "待删除" }, NOW);
    if (!created.ok) throw new Error(created.error);
    expect(useWorkflowStore.getState().remove(created.workflow.id)).toBe(true);
    expect(useWorkflowStore.getState().workflows).toHaveLength(0);
    expect(useWorkflowStore.getState().selectedId).toBeNull();
    expect(mem.getItem(WORKFLOWS_KEY)).toBe("[]");
    // 重复删除返回 false
    expect(useWorkflowStore.getState().remove(created.workflow.id)).toBe(false);
  });

  it("复制生成独立副本并选中", () => {
    const created = useWorkflowStore.getState().create(
      { name: "原始", from: makeWorkflow({ nodes: [makeNode("n1", "设置")] }) },
      NOW,
    );
    if (!created.ok) throw new Error(created.error);
    const duplicated = useWorkflowStore.getState().duplicate(created.workflow.id, NOW + 1000);
    expect(duplicated.ok).toBe(true);
    if (!duplicated.ok) return;
    expect(duplicated.workflow.id).not.toBe(created.workflow.id);
    expect(duplicated.workflow.name).toBe("原始 副本");
    expect(duplicated.workflow.nodes[0]?.id).not.toBe("n1");
    expect(useWorkflowStore.getState().selectedId).toBe(duplicated.workflow.id);
  });

  it("select 忽略不存在的 id", () => {
    useWorkflowStore.getState().select("wf-missing");
    expect(useWorkflowStore.getState().selectedId).toBeNull();
  });

  it("setActive 启用时把 lastRunAt 推到启用时刻（不补跑）", () => {
    const created = useWorkflowStore.getState().create({ name: "启停" }, NOW);
    if (!created.ok) throw new Error(created.error);
    const result = useWorkflowStore.getState().setActive(created.workflow.id, true, NOW + 5000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workflow.active).toBe(true);
    expect(result.workflow.lastRunAt).toBe(NOW + 5000);
    const off = useWorkflowStore.getState().setActive(created.workflow.id, false, NOW + 9000);
    expect(off.ok && off.workflow.active === false).toBe(true);
  });

  it("markRun 只写 lastRunAt，不动 updatedAt/version", () => {
    const created = useWorkflowStore.getState().create({ name: "调度记账" }, NOW);
    if (!created.ok) throw new Error(created.error);
    const before = useWorkflowStore.getState().workflows[0] as Workflow;
    useWorkflowStore.getState().markRun(created.workflow.id, NOW + 12_345);
    const after = useWorkflowStore.getState().workflows[0] as Workflow;
    expect(after.lastRunAt).toBe(NOW + 12_345);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.versionId).toBe(before.versionId);
  });
});

describe("导入 / 导出", () => {
  const n8nExport = {
    name: "来自 n8n",
    nodes: [
      {
        name: "手动触发",
        type: "n8n-nodes-base.manualTrigger",
        position: [100, 200],
        parameters: {},
      },
      {
        name: "设置",
        type: "n8n-nodes-base.set",
        position: [400, 200],
        parameters: { mode: "manual" },
      },
    ],
    connections: {
      手动触发: { main: [[{ node: "设置", type: "main", index: 0 }]] },
    },
    settings: { saveDataSuccessExecution: "none" },
    active: true,
    tags: ["测试"],
  };

  it("importWorkflow 插入仓库、连接按 name→id 重映射、默认不启用", () => {
    const result = useWorkflowStore.getState().importWorkflow(n8nExport, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workflow.nodes).toHaveLength(2);
    expect(result.workflow.active).toBe(false);
    const state = useWorkflowStore.getState();
    expect(state.workflows).toHaveLength(1);
    const source = result.workflow.nodes.find((node) => node.name === "手动触发");
    const target = result.workflow.nodes.find((node) => node.name === "设置");
    expect(result.workflow.connections[source?.id ?? ""]?.main[0]?.[0]?.node).toBe(target?.id);
  });

  it("导入同名工作流时自动加后缀", () => {
    useWorkflowStore.getState().importWorkflow(n8nExport, NOW);
    const second = useWorkflowStore.getState().importWorkflow(n8nExport, NOW + 1);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.workflow.name).toBe("来自 n8n（导入）");
  });

  it("导入坏 JSON 返回中文错误", () => {
    const result = useWorkflowStore
      .getState()
      .importWorkflow("{ not json", NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("不是合法的 JSON");
  });

  it("exportWorkflow 输出 n8n 形状（连接按节点名）", () => {
    const created = useWorkflowStore.getState().create({ name: "导出" }, NOW);
    if (!created.ok) throw new Error(created.error);
    const withNodes: Workflow = {
      ...created.workflow,
      nodes: [makeNode("n1", "设置"), makeNode("n2", "HTTP", "httpRequest")],
      connections: { n1: { main: [[{ node: "n2", type: "main", index: 0 }]] } },
      tags: ["标签"],
    };
    useWorkflowStore.getState().save(created.workflow.id, withNodes, NOW + 1000);
    const exported = useWorkflowStore.getState().exportWorkflow(created.workflow.id);
    expect(exported).not.toBeNull();
    if (!exported) return;
    expect(exported.name).toBe("导出");
    expect(exported.tags).toEqual(["标签"]);
    expect(exported.connections["设置"]?.main[0]?.[0]?.node).toBe("HTTP");
  });

  it("exportWorkflow 找不到时返回 null", () => {
    expect(useWorkflowStore.getState().exportWorkflow("wf-missing")).toBeNull();
  });
});

describe("落盘失败", () => {
  it("storage 抛错时不崩，内存态仍保留", () => {
    const broken: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => undefined,
    };
    setWorkflowStorage(broken);
    useWorkflowStore.setState({ workflows: [], selectedId: null });
    const result = useWorkflowStore.getState().create({ name: "写不进去" }, NOW);
    expect(result.ok).toBe(true);
    expect(useWorkflowStore.getState().workflows).toHaveLength(1);
  });
});

describe("workflowByteSize", () => {
  it("按 UTF-8 字节计算（中文三字节）", () => {
    const workflow = makeWorkflow({ name: "中文" });
    expect(workflowByteSize(workflow)).toBeGreaterThan(JSON.stringify(workflow).length);
  });
});
