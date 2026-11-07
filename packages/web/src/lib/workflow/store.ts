/**
 * 工作流仓库（本机）：工作流的增删改查、选中态、启停与导入导出入口。
 *
 * 为什么单独成 store、而不是塞进组件里：
 * - 画布编辑器的「草稿」和列表页的「已保存」必须能分开（未保存的拖动不该立刻落盘）；
 * - 调度器/运行时/页面都要按同一个列表读盘，事实只能有一个来源；
 * - localStorage 写不进去（隐私模式、配额满）时**静默降级为内存态**——
 *   本次会话里用户仍能新建、编辑、运行，只是重启后丢失；把异常抛给 UI 只会
 *   让「点保存就报错」的体验比丢一次草稿更糟。
 *
 * 读盘原则与 `model.normalizeWorkflow` 一致：坏条目逐条丢弃，一条坏工作流
 * 不能让整个列表读不出来。写盘前先做归一与尺寸校验：单条工作流有 512KB 上限，
 * 超过就明确告诉用户（而不是写进去一个注定写不下的键）。
 */

import { create } from "zustand";
import { createDefaultStorage, readJson, utf8Length, writeJson } from "../memory/storage.js";
import type { StorageLike } from "../memory/types.js";
import { cloneWorkflow, normalizeWorkflow, createWorkflow } from "./model.js";
import { useWorkflowExecutionsStore } from "./executions.js";
import {
  WORKFLOW_LIMITS,
  type Workflow,
} from "./types.js";
import {
  exportWorkflow,
  importWorkflow,
  importWorkflowFromText,
  type N8nWorkflowExport,
  type WorkflowImportResult,
} from "./transfer.js";

/** 工作流列表键（契约 §8）。 */
export const WORKFLOWS_KEY = "heming.workflows.v1";

/**
 * 整个键的字节上限。
 *
 * 单条 512KB × 50 条理论上 25MB，但 localStorage 同源预算只有约 5MB，
 * 其它模块（记忆/消息缓存/任务）还要用。这里取 4MB 作为**逻辑上限**：
 * 超过就不写盘（内存态保留），避免一个超大键把其它模块挤出配额。
 */
export const WORKFLOWS_BYTE_LIMIT = 4 * 1024 * 1024;

/** 单条工作流的字节数（判定 512KB 上限用）。 */
export function workflowByteSize(workflow: Workflow): number {
  return utf8Length(JSON.stringify(workflow));
}

/** 应用启动/刷新时读盘：坏条目逐条丢弃、按更新时间倒序、最多 50 条。 */
export function readWorkflows(
  storage: StorageLike = createDefaultStorage(),
  now: number = Date.now(),
): Workflow[] {
  return readJson(storage, WORKFLOWS_KEY, [] as Workflow[], (raw) => {
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const workflows: Workflow[] = [];
    for (const item of raw) {
      const workflow = normalizeWorkflow(item, now);
      if (!workflow || seen.has(workflow.id)) continue;
      seen.add(workflow.id);
      workflows.push(workflow);
      if (workflows.length >= WORKFLOW_LIMITS.maxWorkflows) break;
    }
    // 列表页按「最近改过」排：更新频繁的工作流排前面，符合用户预期。
    return workflows.sort((a, b) => b.updatedAt - a.updatedAt);
  });
}

let storage: StorageLike | null = null;

function getStorage(): StorageLike {
  return (storage ??= createDefaultStorage());
}

/** 测试注入点：传 null 恢复默认（jsdom 的 localStorage）。 */
export function setWorkflowStorage(next: StorageLike | null): void {
  storage = next;
}

/**
 * 落盘（永不抛）。
 *
 * 写失败（超 4MB / 配额满 / 隐私模式）时**什么也不做**：内存里的 `workflows`
 * 已经是最新的，用户本次会话仍可正常使用。返回是否写成功，只给测试与
 * 未来可能的「存储水位」提示用，业务侧不依赖它。
 */
function persist(workflows: Workflow[]): boolean {
  return writeJson(getStorage(), WORKFLOWS_KEY, workflows, WORKFLOWS_BYTE_LIMIT);
}

function sortByUpdatedAt(workflows: Workflow[]): Workflow[] {
  return [...workflows].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 新建工作流时可以带名字，或直接从一条模板克隆（模板不消耗原 id）。 */
export interface WorkflowCreateInput {
  name?: string;
  /** 模板/副本来源；传入时克隆它的节点与连接（新 id）并保留名字（可被 name 覆盖）。 */
  from?: Workflow;
}

export type WorkflowMutation =
  | { ok: true; workflow: Workflow }
  | { ok: false; error: string };

/** 导入进仓库的结果：失败时字段与 transfer 的导入结果同构，便于 UI 直接展示。 */
export type WorkflowStoreImportResult =
  | { ok: true; workflow: Workflow; warnings: string[]; errors: string[] }
  | { ok: false; error: string; warnings: string[]; errors: string[] };

/** 更新工作流时允许的补丁形状（id / createdAt 不允许被改）。 */
export type WorkflowPatch =
  | Partial<Omit<Workflow, "id" | "createdAt">>
  | ((current: Workflow) => Workflow);

interface WorkflowStoreState {
  /** 全部已保存工作流（最新更新在前）。 */
  workflows: Workflow[];
  /** 当前在编辑器里打开的工作流（内存态，不落盘）。 */
  selectedId: string | null;
  create: (input?: WorkflowCreateInput, now?: number) => WorkflowMutation;
  /** 打补丁或传一个 updater；自动刷新 updatedAt/versionId 并落盘。 */
  update: (id: string, patch: WorkflowPatch, now?: number) => WorkflowMutation;
  /** 编辑器「保存」：用整条工作流覆盖（自动刷新版本与时间）。 */
  save: (id: string, next?: Workflow, now?: number) => WorkflowMutation;
  remove: (id: string) => boolean;
  duplicate: (id: string, now?: number) => WorkflowMutation;
  select: (id: string | null) => void;
  setActive: (id: string, active: boolean, now?: number) => WorkflowMutation;
  /**
   * 调度器专用：只写 `lastRunAt`，**不动** updatedAt/versionId。
   * 定时触发的记账如果也算「用户改了工作流」，列表会每 15 秒重新排序一次，
   * 编辑器里的「已保存/未保存」判断也会被噪音干扰。
   */
  markRun: (id: string, at: number) => void;
  /** 导入 JSON（n8n 或本仓导出形状）；成功后直接插入仓库并返回归一后的工作流。 */
  importWorkflow: (raw: unknown, now?: number) => WorkflowStoreImportResult;
  /** 导出成类 n8n JSON（连接按节点名）；找不到返回 null。 */
  exportWorkflow: (id: string) => N8nWorkflowExport | null;
  /** 定时调度只跑启用中的工作流。 */
  listActive: () => Workflow[];
}

function fail(error: string): WorkflowMutation {
  return { ok: false, error };
}

/**
 * 写盘前统一校验：尺寸、条数。
 * 尺寸超限要拒绝而不是截断——工作流是用户资产，截断等于静默丢节点。
 */
function validateForSave(workflow: Workflow, others: Workflow[]): string | null {
  if (others.length >= WORKFLOW_LIMITS.maxWorkflows) {
    return `最多保存 ${WORKFLOW_LIMITS.maxWorkflows} 条工作流，请先删除不用的工作流`;
  }
  const bytes = workflowByteSize(workflow);
  if (bytes > WORKFLOW_LIMITS.maxWorkflowBytes) {
    const kb = Math.ceil(bytes / 1024);
    return `工作流太大（${kb}KB），上限 ${Math.round(WORKFLOW_LIMITS.maxWorkflowBytes / 1024)}KB；请删减节点或固定的执行数据`;
  }
  return null;
}

export const useWorkflowStore = create<WorkflowStoreState>((set, get) => ({
  workflows: readWorkflows(),
  selectedId: null,

  create: (input = {}, now = Date.now()) => {
    const current = get().workflows;
    if (current.length >= WORKFLOW_LIMITS.maxWorkflows) {
      return fail(`最多保存 ${WORKFLOW_LIMITS.maxWorkflows} 条工作流，请先删除不用的工作流`);
    }
    const workflow = input.from
      ? cloneWorkflow(input.from, { name: input.name ?? input.from.name, now })
      : createWorkflow({ name: input.name, now });
    const workflows = sortByUpdatedAt([workflow, ...current]);
    persist(workflows);
    set({ workflows, selectedId: workflow.id });
    return { ok: true, workflow };
  },

  update: (id, patch, now = Date.now()) => {
    const current = get().workflows.find((workflow) => workflow.id === id);
    if (!current) return fail("工作流不存在（可能已被删除）");
    const candidate =
      typeof patch === "function" ? patch(current) : { ...current, ...patch };
    // 归一能挡住 updater 返回的坏形状（例如 nodes 被塞成字符串），
    // 也能把 import 时带进来的旧字段清洗掉；id/createdAt 始终以现有记录为准。
    const normalized = normalizeWorkflow(
      {
        ...candidate,
        id: current.id,
        createdAt: current.createdAt,
        updatedAt: now,
        versionId: candidate.versionId ?? current.versionId,
      },
      now,
    );
    if (!normalized) return fail("工作流数据不合法，无法保存");
    // 每次保存生成新版本 id：执行记录能标出「跑的是哪一版」。
    normalized.versionId = `ver-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const others = get().workflows.filter((workflow) => workflow.id !== id);
    const error = validateForSave(normalized, others);
    if (error) return fail(error);
    const workflows = sortByUpdatedAt([normalized, ...others]);
    persist(workflows);
    set({ workflows });
    return { ok: true, workflow: normalized };
  },

  save: (id, next, now = Date.now()) => get().update(id, next ?? {}, now),

  remove: (id) => {
    const current = get().workflows;
    const workflows = current.filter((workflow) => workflow.id !== id);
    if (workflows.length === current.length) return false;
    persist(workflows);
    set({
      workflows,
      selectedId: get().selectedId === id ? null : get().selectedId,
    });
    // 级联清掉这条工作流的执行记录：页面文案承诺「删除工作流时执行记录一并移除」。
    // 放在工作流删除之后，记录清理失败也不影响用户已经看到的删除结果。
    try {
      useWorkflowExecutionsStore.getState().removeForWorkflow(id);
    } catch {
      /* 记录清理失败不影响工作流删除 */
    }
    return true;
  },

  duplicate: (id, now = Date.now()) => {
    const source = get().workflows.find((workflow) => workflow.id === id);
    if (!source) return fail("工作流不存在（可能已被删除）");
    if (get().workflows.length >= WORKFLOW_LIMITS.maxWorkflows) {
      return fail(`最多保存 ${WORKFLOW_LIMITS.maxWorkflows} 条工作流，请先删除不用的工作流`);
    }
    const copy = cloneWorkflow(source, { name: `${source.name} 副本`, now });
    const workflows = sortByUpdatedAt([copy, ...get().workflows]);
    persist(workflows);
    set({ workflows, selectedId: copy.id });
    return { ok: true, workflow: copy };
  },

  select: (id) => {
    if (id === null) {
      set({ selectedId: null });
      return;
    }
    // 选一个不存在的 id 等于把编辑器留在空白页；直接忽略，保持当前选择。
    if (get().workflows.some((workflow) => workflow.id === id)) set({ selectedId: id });
  },

  setActive: (id, active, now = Date.now()) => {
    const current = get().workflows.find((workflow) => workflow.id === id);
    if (!current) return fail("工作流不存在（可能已被删除）");
    if (current.active === active) return { ok: true, workflow: current };
    // 重新启用时把 lastRunAt 推到「现在」：停用一周后再启用不该立刻补跑，
    // 下一次触发从启用时刻的下一个周期算起（与自动化模块同口径）。
    const patch: Partial<Workflow> = { active };
    if (active) patch.lastRunAt = now;
    return get().update(id, patch, now);
  },

  markRun: (id, at) => {
    let changed = false;
    const workflows = get().workflows.map((workflow) => {
      if (workflow.id !== id) return workflow;
      changed = true;
      return { ...workflow, lastRunAt: at };
    });
    if (!changed) return;
    persist(workflows);
    set({ workflows });
  },

  importWorkflow: (raw, now = Date.now()) => {
    // 页面可能直接把粘贴的文本交进来：文本先按 JSON 解析，错误信息才有中文可读。
    const result: WorkflowImportResult =
      typeof raw === "string"
        ? importWorkflowFromText(raw, { now })
        : importWorkflow(raw, { now });
    if (!result.ok) {
      return {
        ok: false,
        error: result.errors[0] ?? "导入失败：无法解析这份 JSON",
        warnings: result.warnings,
        errors: result.errors,
      };
    }
    if (get().workflows.length >= WORKFLOW_LIMITS.maxWorkflows) {
      return {
        ok: false,
        error: `最多保存 ${WORKFLOW_LIMITS.maxWorkflows} 条工作流，请先删除不用的工作流`,
        warnings: result.warnings,
        errors: ["工作流数量已达上限"],
      };
    }
    // 同名工作流不冲突（id 不同），但列表里同名会分不清；导入时补一个后缀。
    const usedNames = new Set(get().workflows.map((workflow) => workflow.name));
    let name = result.workflow.name;
    let suffix = 2;
    while (usedNames.has(name) && suffix < 1000) {
      name = `${result.workflow.name}（导入${suffix > 2 ? ` ${suffix}` : ""}）`;
      suffix += 1;
    }
    const workflow: Workflow = {
      ...result.workflow,
      name,
      active: false, // 导入默认不启用：避免刚导入的定时工作流立刻开始跑
      createdAt: now,
      updatedAt: now,
    };
    const bytes = workflowByteSize(workflow);
    if (bytes > WORKFLOW_LIMITS.maxWorkflowBytes) {
      return {
        ok: false,
        error: `导入的工作流太大（${Math.ceil(bytes / 1024)}KB），上限 ${Math.round(
          WORKFLOW_LIMITS.maxWorkflowBytes / 1024,
        )}KB`,
        warnings: result.warnings,
        errors: ["工作流超过单条尺寸上限"],
      };
    }
    const workflows = sortByUpdatedAt([workflow, ...get().workflows]);
    persist(workflows);
    set({ workflows });
    return {
      ok: true,
      workflow,
      warnings: result.warnings,
      errors: result.errors,
    };
  },

  exportWorkflow: (id) => {
    const workflow = get().workflows.find((item) => item.id === id);
    if (!workflow) return null;
    return exportWorkflow(workflow);
  },

  listActive: () => get().workflows.filter((workflow) => workflow.active),
}));

/** 按 id 取一条（组件里只想读单条时用；不订阅整个列表）。 */
export function getWorkflowById(workflows: readonly Workflow[], id: string | null): Workflow | undefined {
  if (!id) return undefined;
  return workflows.find((workflow) => workflow.id === id);
}
