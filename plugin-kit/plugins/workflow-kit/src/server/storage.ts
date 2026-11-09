/**
 * 本机存储：工作流 / 执行记录 / 凭据 / 设置 / 静态数据 / 通知，全部落 `data/` 下的 JSON 文件。
 *
 * 为什么用文件而不是数据库：这是本机单用户、低并发的小服务，装一个 SQLite 依赖
 * 只会增加安装门槛；JSON 文件可读、可备份、可直接改，坏条目还能逐条丢弃。
 *
 * 写入策略：**同步写 + 临时文件 rename**（先写 `.tmp` 再改名），断电最多丢最后一次写入，
 * 不会留下写了一半的 JSON。所有读取路径都「永不抛」：坏文件回退空数据，坏条目丢弃。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  cloneWorkflow,
  createWorkflow,
  normalizeWorkflow,
  validateWorkflow,
  WORKFLOW_NAME_MAX,
  clipText,
} from "../model.js";
import { WORKFLOW_LIMITS, type Item, type NodeRunData, type Workflow, type WorkflowExecution } from "../types.js";
import { createVault, validateCredentialData, type Vault } from "./credentials.js";

export interface WorkflowVersionMeta {
  versionId: string;
  savedAt: number;
  name: string;
  nodeCount: number;
}

export interface CredentialMeta {
  id: string;
  name: string;
  type: string;
  updatedAt: number;
}

export interface CredentialInput {
  name: string;
  type: string;
  data: Record<string, unknown>;
}

export interface Settings {
  vars: Record<string, unknown>;
  llm?: { baseUrl: string; apiKey: string; model: string };
}

export type SettingsPatch = {
  vars?: Record<string, unknown>;
  llm?: { baseUrl?: string; apiKey?: string; model?: string } | null;
};

export interface NotificationEntry {
  id: string;
  title: string;
  body: string;
  at: number;
  workflowId?: string;
}

export interface Store {
  listWorkflows(): Workflow[];
  getWorkflow(id: string): Workflow | undefined;
  createWorkflow(input?: { name?: string; from?: Workflow }): Workflow;
  saveWorkflow(workflow: Workflow): Workflow;
  removeWorkflow(id: string): boolean;
  /** 历史版本摘要（保存时的上一版快照；最新在前）。 */
  listVersions(workflowId: string): WorkflowVersionMeta[];
  /** 按版本 id 取历史快照；不存在返回 undefined。 */
  getVersion(workflowId: string, versionId: string): Workflow | undefined;
  setActive(id: string, active: boolean): Workflow | null;
  markRun(id: string, at: number): void;
  listExecutions(filter?: { workflowId?: string; limit?: number }): WorkflowExecution[];
  getExecution(id: string): WorkflowExecution | undefined;
  saveExecution(execution: WorkflowExecution): void;
  removeExecution(id: string): boolean;
  clearExecutions(workflowId?: string): number;
  listCredentials(): CredentialMeta[];
  saveCredential(input: CredentialInput): CredentialMeta;
  removeCredential(id: string): boolean;
  getCredentialData(type: string, id: string): Promise<Record<string, unknown> | null>;
  getSettings(): Settings;
  saveSettings(patch: SettingsPatch): Settings;
  getStaticData(workflowId: string, nodeId?: string): Record<string, unknown>;
  saveStaticData(workflowId: string, nodeId: string | null, data: Record<string, unknown>): void;
  addNotification(entry: { title: string; body?: string; workflowId?: string }): void;
  listNotifications(limit?: number): NotificationEntry[];
  /** 直接读某个工作流的执行记录（调度器判断状态用）。 */
  lastExecutionOf(workflowId: string): WorkflowExecution | undefined;
}

const MAX_EXECUTION_BYTES = 1 * 1024 * 1024;
const MAX_NOTIFICATIONS = 50;

function readJsonArray<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function readJsonObject<T extends Record<string, unknown>>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

function atomicWrite(path: string, text: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}

/** 规范化一条执行记录（读到旧数据/坏数据时逐条丢弃）。 */
function normalizeExecution(raw: unknown): WorkflowExecution | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== "string" || !value.id) return null;
  if (typeof value.workflowId !== "string" || !value.workflowId) return null;
  const status = value.status;
  const validStatus =
    status === "success" || status === "error" || status === "canceled" || status === "running" || status === "new" || status === "waiting";
  if (!validStatus) return null;
  return {
    id: value.id,
    workflowId: value.workflowId,
    workflowName: typeof value.workflowName === "string" ? value.workflowName : "",
    mode: (value.mode as WorkflowExecution["mode"]) ?? "manual",
    status: status as WorkflowExecution["status"],
    startedAt: typeof value.startedAt === "number" ? value.startedAt : 0,
    ...(typeof value.finishedAt === "number" ? { finishedAt: value.finishedAt } : {}),
    ...(typeof value.durationMs === "number" ? { durationMs: value.durationMs } : {}),
    ...(typeof value.triggerNodeId === "string" ? { triggerNodeId: value.triggerNodeId } : {}),
    runData: value.runData && typeof value.runData === "object" ? (value.runData as WorkflowExecution["runData"]) : {},
    ...(value.error && typeof value.error === "object" ? { error: value.error as WorkflowExecution["error"] } : {}),
    ...(typeof value.parentExecutionId === "string" ? { parentExecutionId: value.parentExecutionId } : {}),
    ...(Array.isArray(value.triggerData) ? { triggerData: value.triggerData as Item[] } : {}),
    ...(value.dataTruncated === true ? { dataTruncated: true } : {}),
  };
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export function createStore(dataDir: string): Store {
  mkdirSync(dataDir, { recursive: true });
  const paths = {
    workflows: join(dataDir, "workflows.json"),
    executions: join(dataDir, "executions.json"),
    credentials: join(dataDir, "credentials.json"),
    settings: join(dataDir, "settings.json"),
    static: join(dataDir, "static.json"),
    notifications: join(dataDir, "notifications.jsonl"),
    versions: join(dataDir, "versions.json"),
    secret: join(dataDir, "secret.key"),
  };
  const vault: Vault = createVault(paths.secret);

  // ---- 内存态（首次读盘）----
  let workflows: Workflow[] = readJsonArray<unknown>(paths.workflows)
    .map((raw) => normalizeWorkflow(raw))
    .filter((item): item is Workflow => item !== null)
    .slice(0, WORKFLOW_LIMITS.maxWorkflows)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  let executions: WorkflowExecution[] = readJsonArray<unknown>(paths.executions)
    .map(normalizeExecution)
    .filter((item): item is WorkflowExecution => item !== null)
    .slice(0, WORKFLOW_LIMITS.maxExecutions);

  interface StoredCredential extends CredentialMeta {
    secret: string;
  }
  let credentials: StoredCredential[] = readJsonArray<unknown>(paths.credentials)
    .filter((raw): raw is StoredCredential => {
      if (!raw || typeof raw !== "object") return false;
      const value = raw as Record<string, unknown>;
      return typeof value.id === "string" && typeof value.name === "string" && typeof value.type === "string" && typeof value.secret === "string";
    })
    .slice(0, 30);

  let settings: Settings = (() => {
    const raw = readJsonObject(paths.settings, {} as Record<string, unknown>);
    const vars = raw.vars && typeof raw.vars === "object" && !Array.isArray(raw.vars) ? (raw.vars as Record<string, unknown>) : {};
    const llmRaw = raw.llm && typeof raw.llm === "object" ? (raw.llm as Record<string, unknown>) : null;
    let llm: Settings["llm"];
    if (llmRaw && typeof llmRaw.baseUrl === "string" && typeof llmRaw.model === "string") {
      let apiKey = typeof llmRaw.apiKey === "string" ? llmRaw.apiKey : "";
      // apiKey 若以密文信封形式存储（`{"v":1,...}`），读取时解密；解不开就留空。
      if (apiKey.startsWith("{")) {
        try {
          apiKey = vault.decrypt(apiKey);
        } catch {
          apiKey = "";
        }
      }
      llm = { baseUrl: llmRaw.baseUrl, apiKey, model: llmRaw.model };
    }
    return { vars, ...(llm ? { llm } : {}) };
  })();

  interface StaticEntry {
    global?: Record<string, unknown>;
    nodes?: Record<string, Record<string, unknown>>;
  }
  let staticData: Record<string, StaticEntry> = (() => {
    const raw = readJsonObject(paths.static, {} as Record<string, unknown>);
    const result: Record<string, StaticEntry> = {};
    for (const [workflowId, value] of Object.entries(raw)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const entry = value as StaticEntry;
      result[workflowId] = {
        ...(entry.global && typeof entry.global === "object" ? { global: entry.global } : {}),
        ...(entry.nodes && typeof entry.nodes === "object" ? { nodes: entry.nodes } : {}),
      };
    }
    return result;
  })();

  // ---- 版本快照（data/versions.json）----
  interface StoredVersion {
    versionId: string;
    savedAt: number;
    workflow: Workflow;
  }
  const MAX_VERSIONS_PER_WORKFLOW = 10;
  const MAX_VERSIONS_BYTES = 4 * 1024 * 1024;
  let versions: Record<string, StoredVersion[]> = (() => {
    const raw = readJsonObject(paths.versions, {} as Record<string, unknown>);
    const result: Record<string, StoredVersion[]> = {};
    for (const [workflowId, list] of Object.entries(raw)) {
      if (!Array.isArray(list)) continue;
      const entries: StoredVersion[] = [];
      for (const item of list) {
        if (!item || typeof item !== "object") continue;
        const value = item as Record<string, unknown>;
        if (typeof value.savedAt !== "number" || typeof value.versionId !== "string") continue;
        const workflow = normalizeWorkflow(value.workflow);
        if (!workflow) continue;
        entries.push({ versionId: value.versionId, savedAt: value.savedAt, workflow });
      }
      entries.sort((a, b) => b.savedAt - a.savedAt);
      if (entries.length > 0) result[workflowId] = entries.slice(0, MAX_VERSIONS_PER_WORKFLOW);
    }
    return result;
  })();

  function persistVersions(): void {
    // 先按「每工作流最多 10 版」剪枝，再按全局 4MB 从最旧开始丢。
    const pruned: Record<string, StoredVersion[]> = {};
    for (const [workflowId, list] of Object.entries(versions)) {
      const sorted = [...list].sort((a, b) => b.savedAt - a.savedAt).slice(0, MAX_VERSIONS_PER_WORKFLOW);
      if (sorted.length > 0) pruned[workflowId] = sorted;
    }
    let bytes = utf8Bytes(JSON.stringify(pruned));
    if (bytes > MAX_VERSIONS_BYTES) {
      const flat = Object.entries(pruned).flatMap(([workflowId, list]) =>
        list.map((entry) => ({ workflowId, versionId: entry.versionId, savedAt: entry.savedAt })),
      );
      flat.sort((a, b) => a.savedAt - b.savedAt);
      for (const entry of flat) {
        if (bytes <= MAX_VERSIONS_BYTES) break;
        const list = pruned[entry.workflowId];
        if (!list) continue;
        const index = list.findIndex((item) => item.versionId === entry.versionId);
        if (index >= 0) list.splice(index, 1);
        if (list.length === 0) delete pruned[entry.workflowId];
        bytes = utf8Bytes(JSON.stringify(pruned));
      }
    }
    versions = pruned;
    atomicWrite(paths.versions, JSON.stringify(pruned));
  }

  /** 保存前把「旧版本」存成快照；同一 versionId 不重复记。 */
  function snapshotVersion(previous: Workflow, now: number): void {
    const list = versions[previous.id] ?? [];
    if (list.some((entry) => entry.versionId === previous.versionId)) return;
    list.unshift({
      versionId: previous.versionId,
      savedAt: now,
      workflow: normalizeWorkflow(previous, now) ?? previous,
    });
    versions[previous.id] = list;
    persistVersions();
  }

  function persistWorkflows(): void {
    atomicWrite(paths.workflows, JSON.stringify(workflows, null, 2));
  }

  function persistExecutions(): void {
    // 条数 + 字节双淘汰：从最旧的开始丢，直到两条上限都满足
    let list = [...executions].sort((a, b) => b.startedAt - a.startedAt).slice(0, WORKFLOW_LIMITS.maxExecutions);
    let bytes = utf8Bytes(JSON.stringify(list));
    while (bytes > MAX_EXECUTION_BYTES && list.length > 1) {
      list = list.slice(0, -1);
      bytes = utf8Bytes(JSON.stringify(list));
    }
    // 只剩一条记录仍然超上限：裁掉最早节点运行的数据（保留状态/耗时/错误），
    // 否则一条超大执行会永远写不进 1MB 预算，并让 UI/接口传输卡死。
    if (bytes > MAX_EXECUTION_BYTES && list.length === 1) {
      const execution = list[0];
      const runs: NodeRunData[] = Object.values(execution.runData ?? {})
        .flat()
        .filter((run) => Boolean(run.data))
        .sort((a, b) => a.executionIndex - b.executionIndex);
      const target = bytes - MAX_EXECUTION_BYTES;
      let freed = 0;
      for (const run of runs) {
        if (!run.data) continue;
        const sizeBefore = utf8Bytes(JSON.stringify(run.data));
        delete run.data;
        execution.dataTruncated = true;
        freed += sizeBefore;
        if (freed >= target) break;
      }
      bytes = utf8Bytes(JSON.stringify(list));
    }
    executions = list;
    atomicWrite(paths.executions, JSON.stringify(executions));
  }

  function persistCredentials(): void {
    atomicWrite(paths.credentials, JSON.stringify(credentials, null, 2));
  }

  function persistSettings(): void {
    const forDisk = {
      vars: settings.vars,
      ...(settings.llm
        ? {
            llm: {
              baseUrl: settings.llm.baseUrl,
              model: settings.llm.model,
              // Key 与普通设置分开：落盘前加密，读回时解密
              apiKey: settings.llm.apiKey ? vault.encrypt(settings.llm.apiKey) : "",
            },
          }
        : {}),
    };
    atomicWrite(paths.settings, JSON.stringify(forDisk, null, 2));
  }

  function persistStatic(): void {
    atomicWrite(paths.static, JSON.stringify(staticData));
  }

  function metaOf(item: StoredCredential): CredentialMeta {
    return { id: item.id, name: item.name, type: item.type, updatedAt: item.updatedAt };
  }

  return {
    listWorkflows: () => [...workflows].sort((a, b) => b.updatedAt - a.updatedAt),

    getWorkflow: (id) => workflows.find((item) => item.id === id),

    listVersions: (workflowId) =>
      (versions[workflowId] ?? [])
        .slice()
        .sort((a, b) => b.savedAt - a.savedAt)
        .map((entry) => ({
          versionId: entry.versionId,
          savedAt: entry.savedAt,
          name: entry.workflow.name,
          nodeCount: entry.workflow.nodes.length,
        })),

    getVersion: (workflowId, versionId) =>
      versions[workflowId]?.find((entry) => entry.versionId === versionId)?.workflow,

    createWorkflow: (input = {}) => {
      if (workflows.length >= WORKFLOW_LIMITS.maxWorkflows) {
        throw new Error(`最多保存 ${WORKFLOW_LIMITS.maxWorkflows} 条工作流，请先删除不用的工作流`);
      }
      const workflow = input.from
        ? cloneWorkflow(input.from, { name: input.name ?? `${input.from.name} 副本` })
        : createWorkflow({ name: input.name ? clipText(input.name, WORKFLOW_NAME_MAX) : undefined });
      workflows = [workflow, ...workflows];
      persistWorkflows();
      return workflow;
    },

    saveWorkflow: (workflow) => {
      const index = workflows.findIndex((item) => item.id === workflow.id);
      const now = Date.now();
      const normalized = normalizeWorkflow({ ...workflow, updatedAt: now, versionId: randomUUID() });
      if (!normalized) throw new Error("工作流数据不完整，无法保存");
      if (workflows.length > 0 && index < 0 && workflows.length >= WORKFLOW_LIMITS.maxWorkflows) {
        throw new Error(`最多保存 ${WORKFLOW_LIMITS.maxWorkflows} 条工作流，请先删除不用的工作流`);
      }
      if (index >= 0) {
        // 覆盖前留一版快照：版本历史与「回滚」都靠它。
        snapshotVersion(structuredClone(workflows[index]), now);
        workflows[index] = normalized;
      }
      else workflows = [normalized, ...workflows];
      workflows = workflows.sort((a, b) => b.updatedAt - a.updatedAt);
      persistWorkflows();
      return normalized;
    },

    removeWorkflow: (id) => {
      const next = workflows.filter((item) => item.id !== id);
      if (next.length === workflows.length) return false;
      workflows = next;
      executions = executions.filter((item) => item.workflowId !== id);
      delete versions[id];
      persistWorkflows();
      persistExecutions();
      persistVersions();
      return true;
    },

    setActive: (id, active) => {
      const current = workflows.find((item) => item.id === id);
      if (!current) return null;
      current.active = active;
      // 重新启用时把 lastRunAt 推到现在：停用期间错过的不补跑（与自动化模块同口径）。
      if (active) current.lastRunAt = Date.now();
      current.updatedAt = Date.now();
      current.versionId = randomUUID();
      persistWorkflows();
      return current;
    },

    markRun: (id, at) => {
      const current = workflows.find((item) => item.id === id);
      if (!current) return;
      // 只写 lastRunAt：定时记账不算「用户改了工作流」，不能每 15 秒把列表重排一次。
      current.lastRunAt = at;
      persistWorkflows();
    },

    listExecutions: (filter = {}) => {
      let list = [...executions].sort((a, b) => b.startedAt - a.startedAt);
      if (filter.workflowId) list = list.filter((item) => item.workflowId === filter.workflowId);
      return filter.limit ? list.slice(0, filter.limit) : list;
    },

    getExecution: (id) => executions.find((item) => item.id === id),

    saveExecution: (execution) => {
      executions = [execution, ...executions.filter((item) => item.id !== execution.id)];
      persistExecutions();
    },

    removeExecution: (id) => {
      const next = executions.filter((item) => item.id !== id);
      if (next.length === executions.length) return false;
      executions = next;
      persistExecutions();
      return true;
    },

    clearExecutions: (workflowId) => {
      const before = executions.length;
      executions = workflowId ? executions.filter((item) => item.workflowId !== workflowId) : [];
      persistExecutions();
      return before - executions.length;
    },

    listCredentials: () => credentials.map(metaOf),

    saveCredential: (input) => {
      const name = String(input.name ?? "").trim().slice(0, 40);
      if (!name) throw new Error("凭据名称不能为空");
      const validated = validateCredentialData(input.type, input.data ?? {});
      if (!validated.ok) throw new Error(validated.error);
      const existing = credentials.find((item) => item.name === name);
      const now = Date.now();
      const record: StoredCredential = {
        id: existing?.id ?? randomUUID(),
        name,
        type: input.type,
        updatedAt: now,
        secret: vault.encrypt(JSON.stringify(validated.data)),
      };
      if (existing) credentials = credentials.map((item) => (item.id === record.id ? record : item));
      else credentials = [record, ...credentials].slice(0, 30);
      persistCredentials();
      return metaOf(record);
    },

    removeCredential: (id) => {
      const next = credentials.filter((item) => item.id !== id);
      if (next.length === credentials.length) return false;
      credentials = next;
      persistCredentials();
      return true;
    },

    getCredentialData: async (type, id) => {
      const record = credentials.find((item) => item.id === id);
      if (!record || record.type !== type) return null;
      try {
        const plain = vault.decrypt(record.secret);
        const parsed = JSON.parse(plain) as unknown;
        return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    },

    getSettings: () => ({
      vars: { ...settings.vars },
      ...(settings.llm ? { llm: { ...settings.llm } } : {}),
    }),

    saveSettings: (patch) => {
      if (patch.vars !== undefined) {
        const vars =
          patch.vars && typeof patch.vars === "object" && !Array.isArray(patch.vars)
            ? (patch.vars as Record<string, unknown>)
            : {};
        settings.vars = vars;
      }
      if (patch.llm !== undefined) {
        if (patch.llm === null) settings.llm = undefined;
        else {
          const base = settings.llm ?? { baseUrl: "", apiKey: "", model: "" };
          const next = {
            baseUrl: String(patch.llm.baseUrl ?? base.baseUrl).trim(),
            apiKey: String(patch.llm.apiKey ?? base.apiKey).trim(),
            model: String(patch.llm.model ?? base.model).trim(),
          };
          settings.llm = next.baseUrl && next.model ? next : undefined;
        }
      }
      persistSettings();
      return { vars: { ...settings.vars }, ...(settings.llm ? { llm: { ...settings.llm } } : {}) };
    },

    getStaticData: (workflowId, nodeId) => {
      const entry = (staticData[workflowId] ??= {});
      if (!nodeId) {
        entry.global ??= {};
        return entry.global;
      }
      entry.nodes ??= {};
      entry.nodes[nodeId] ??= {};
      return entry.nodes[nodeId];
    },

    saveStaticData: (workflowId, nodeId, data) => {
      const entry = (staticData[workflowId] ??= {});
      if (nodeId) {
        entry.nodes ??= {};
        entry.nodes[nodeId] = data;
      } else {
        entry.global = data;
      }
      // 防御：静态数据只允许小体积（它跨运行保留，不该变成第二个执行记录）
      const bytes = utf8Bytes(JSON.stringify(staticData));
      if (bytes > 512 * 1024) {
        delete staticData[workflowId];
        return;
      }
      persistStatic();
    },

    addNotification: (entry) => {
      const record: NotificationEntry = {
        id: randomUUID(),
        title: String(entry.title ?? "").slice(0, 120),
        body: String(entry.body ?? "").slice(0, 500),
        at: Date.now(),
        ...(entry.workflowId ? { workflowId: entry.workflowId } : {}),
      };
      try {
        appendFileSync(paths.notifications, `${JSON.stringify(record)}\n`, "utf8");
      } catch {
        /* 通知写不进去不影响主流程 */
      }
    },

    listNotifications: (limit = MAX_NOTIFICATIONS) => {
      if (!existsSync(paths.notifications)) return [];
      try {
        const lines = readFileSync(paths.notifications, "utf8").split("\n").filter(Boolean);
        const parsed: NotificationEntry[] = [];
        for (const line of lines.slice(-Math.max(1, limit))) {
          try {
            const value = JSON.parse(line) as NotificationEntry;
            if (value && typeof value.id === "string") parsed.push(value);
          } catch {
            /* 坏行跳过 */
          }
        }
        return parsed.reverse();
      } catch {
        return [];
      }
    },

    lastExecutionOf: (workflowId) =>
      [...executions].sort((a, b) => b.startedAt - a.startedAt).find((item) => item.workflowId === workflowId),
  };
}

/** 保存前的校验（HTTP 层用于返回 400 与问题列表）。 */
export function validateForSave(workflow: Workflow): { ok: boolean; issues: ReturnType<typeof validateWorkflow> } {
  const issues = validateWorkflow(workflow);
  return { ok: issues.every((issue) => issue.level !== "error"), issues };
}
