import type { TaskRecord } from "../tasks/store.js";
import { useTaskStore } from "../tasks/store.js";
import { memoryStore } from "../memory/index.js";
import { pluginStore } from "../plugins/index.js";
import type { InstalledPlugin } from "../plugins/store.js";

/**
 * 命令面板 · 本机数据源（任务 / 记忆 / 插件）。
 *
 * ## 隐私边界（硬约束）
 * - 只读**本机**：任务用 zustand 里的 `useTaskStore.tasks`、记忆用 `memoryStore.exportAll()`
 *   解析出的本机数据、插件用 `pluginStore.list()`；
 * - **不发任何网络请求、不写日志、不碰 localStorage 写入**（`exportAll()` 只是序列化内存态）；
 * - **不搜消息正文**：任务只搜标题/目标/最终报告，记忆只搜三层条目文本；
 *   会话消息（含 E2E 明文缓存）不在本模块的读取范围内。
 *
 * ## 为什么记忆要绕道 exportAll
 * `MemoryStore` 没有「列出全部智能体的语义/情景」的 API，工作记忆更是只有按会话读的口
 * （`MemoryPage.tsx` 里也有同样的注释）。`exportAll()` 返回的是**本机内存态序列化**，
 * 解析它枚举三层是当前唯一不新增 store API 的读法；解析失败一律当空，不抛。
 */

export type LocalLayerKind = "working" | "episodic" | "semantic";

/** 任务命中项（只含定位与摘要，不含整段报告正文）。 */
export interface LocalTaskItem {
  kind: "task";
  id: string;
  name: string;
  detail: string;
  conversationId: string;
}

/** 记忆命中项（只含条目文本与定位信息）。 */
export interface LocalMemoryItem {
  kind: "memory";
  id: string;
  name: string;
  detail: string;
  layer: LocalLayerKind;
}

/** 插件命中项。 */
export interface LocalPluginItem {
  kind: "plugin";
  id: string;
  name: string;
  detail: string;
}

export type LocalItem = LocalTaskItem | LocalMemoryItem | LocalPluginItem;

/** 本机快照：命令面板打开时读一次，之后的检索全在内存里做。 */
export interface LocalSnapshot {
  tasks: TaskRecord[];
  memories: LocalMemoryItem[];
  plugins: InstalledPlugin[];
}

export interface LocalSearchResult<T> {
  /** 截断到上限后的命中（排序已按相关度）。 */
  hits: T[];
  /** 未截断的命中总数（用于「还有 N 条」）。 */
  total: number;
  /** 未截断的全部命中（必要时可自行再处理）。 */
  all: T[];
}

const TASK_STATUS_LABEL: Record<TaskRecord["status"], string> = {
  running: "运行中",
  done: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

/** 任务一行：标题 + 「状态 · 时间 · 目标摘要」。 */
function taskItem(task: TaskRecord): LocalTaskItem {
  const goal = task.prompt.replace(/\s+/g, " ").trim();
  const goalPart = goal ? Array.from(goal).slice(0, 40).join("") : "（无目标文本）";
  return {
    kind: "task",
    id: task.id,
    name: task.title || "未命名任务",
    detail: `${TASK_STATUS_LABEL[task.status]} · ${goalPart}`,
    conversationId: task.conversationId,
  };
}

/** 记忆一行的标题：按层给不同前缀，便于一眼看出是哪一层。 */
function memoryName(layer: LocalLayerKind, title: string): string {
  const prefix = layer === "semantic" ? "语义" : layer === "episodic" ? "情景" : "短期";
  return `${prefix} · ${title}`;
}

interface RawMemory {
  working?: Record<string, unknown>;
  episodic?: Record<string, unknown>;
  semantic?: Record<string, unknown>;
}

/**
 * 从 `memoryStore.exportAll()` 的 JSON 里枚举三层条目。
 *
 * 只取检索必需字段（id / 文本 / 层级）；条目不认识的层或坏条目直接跳过。
 */
export function readMemoryItems(exportedJson: string): LocalMemoryItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(exportedJson);
  } catch {
    return [];
  }
  const data = (parsed as { data?: RawMemory } | null)?.data;
  if (!data || typeof data !== "object") return [];
  const out: LocalMemoryItem[] = [];
  const asArray = (v: unknown): Record<string, unknown>[] =>
    Array.isArray(v) ? v.filter((item): item is Record<string, unknown> => !!item && typeof item === "object") : [];

  // 工作记忆：按会话分桶
  for (const bucket of Object.values(data.working ?? {})) {
    for (const turn of asArray(bucket)) {
      const id = typeof turn.id === "string" ? turn.id : "";
      if (!id) continue;
      const user = typeof turn.userText === "string" ? turn.userText : "";
      const assistant = typeof turn.assistantText === "string" ? turn.assistantText : "";
      const text = [user, assistant].filter(Boolean).join(" / ");
      if (!text) continue;
      out.push({
        kind: "memory",
        id,
        name: memoryName("working", Array.from(user || assistant).slice(0, 24).join("")),
        detail: text.replace(/\s+/g, " ").slice(0, 60),
        layer: "working",
      });
    }
  }

  // 情景记忆：按智能体分桶
  for (const bucket of Object.values(data.episodic ?? {})) {
    for (const entry of asArray(bucket)) {
      const id = typeof entry.id === "string" ? entry.id : "";
      const summary = typeof entry.summary === "string" ? entry.summary : "";
      if (!id || !summary) continue;
      out.push({
        kind: "memory",
        id,
        name: memoryName("episodic", Array.from(summary).slice(0, 24).join("")),
        detail: summary.replace(/\s+/g, " ").slice(0, 60),
        layer: "episodic",
      });
    }
  }

  // 语义记忆：按智能体分桶（含全局桶）
  for (const bucket of Object.values(data.semantic ?? {})) {
    for (const entry of asArray(bucket)) {
      const id = typeof entry.id === "string" ? entry.id : "";
      const key = typeof entry.key === "string" ? entry.key : "";
      const value = typeof entry.value === "string" ? entry.value : "";
      if (!id || (!key && !value)) continue;
      out.push({
        kind: "memory",
        id,
        name: memoryName("semantic", key || Array.from(value).slice(0, 24).join("")),
        detail: value.replace(/\s+/g, " ").slice(0, 60),
        layer: "semantic",
      });
    }
  }
  return out;
}

/** 插件技能数：兼容 T1 归一化后的 contributions 与旧夹具的顶层 skills。 */
function skillCount(m: { contributions?: { skills?: unknown[] }; skills?: unknown[] }): number {
  return (m.contributions?.skills ?? m.skills ?? []).length;
}

/** 插件一行：名称 + 「id · 描述 · N 个技能」。 */
export function pluginItem(plugin: InstalledPlugin): LocalPluginItem {
  const m = plugin.manifest;
  const desc = (m.description ?? "").replace(/\s+/g, " ").trim();
  return {
    kind: "plugin",
    id: m.id,
    name: m.name,
    detail: `${m.id}${desc ? ` · ${Array.from(desc).slice(0, 30).join("")}` : ""} · ${skillCount(m)} 个技能`,
  };
}

/**
 * 读一次本机快照。
 *
 * 三个来源都是同步内存读：任务来自 zustand、记忆来自内存态序列化、插件来自 store 单例。
 * 任何一步异常都降级为空数组（搜索少一组，但面板必须能开）。
 */
export function readLocalSnapshot(): LocalSnapshot {
  let tasks: TaskRecord[] = [];
  try {
    tasks = useTaskStore.getState().tasks ?? [];
  } catch {
    tasks = [];
  }

  let memories: LocalMemoryItem[] = [];
  try {
    memories = readMemoryItems(memoryStore.exportAll());
  } catch {
    memories = [];
  }

  let plugins: InstalledPlugin[] = [];
  try {
    plugins = pluginStore.list();
  } catch {
    plugins = [];
  }

  return { tasks, memories, plugins };
}

/* ------------------------------ 检索与打分 ------------------------------ */

/**
 * 相关度打分（与命令面板其它组口径一致，不引入检索引擎）：
 * - 标题/名称命中权重高于正文；
 * - 前缀命中高于包含命中；
 * - 命中位置越靠前略高（简单线性衰减）。
 */
export function matchScore(
  query: string,
  primary: string,
  secondary: string[] = [],
): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const p = primary.toLowerCase();
  if (p.startsWith(q)) return 100;
  const pos = p.indexOf(q);
  if (pos >= 0) return 80 - Math.min(20, pos);
  for (const text of secondary) {
    const s = text.toLowerCase();
    if (s.startsWith(q)) return 60;
    if (s.includes(q)) return 40;
  }
  return 0;
}

function rankByScore<T>(scored: { item: T; score: number; name: string }[]): T[] {
  return [...scored]
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "zh"))
    .map((s) => s.item);
}

/** 任务检索：标题（主）+ 目标 + 最终报告（次）。 */
export function searchLocalTasks(
  query: string,
  tasks: TaskRecord[],
  limit = 5,
): LocalSearchResult<LocalTaskItem> {
  const scored = tasks
    .map((task) => {
      const item = taskItem(task);
      const score = matchScore(query, task.title || "", [task.prompt, task.result ?? ""]);
      return { item, score, name: item.name };
    })
    .filter((s) => s.score > 0);
  const all = rankByScore(scored);
  return { hits: all.slice(0, limit), total: all.length, all };
}

/** 记忆检索：条目文本（只看本机三层，不碰消息正文）。 */
export function searchLocalMemories(
  query: string,
  memories: LocalMemoryItem[],
  limit = 5,
): LocalSearchResult<LocalMemoryItem> {
  const scored = memories
    .map((item) => ({
      item,
      score: matchScore(query, item.name, [item.detail]),
      name: item.name,
    }))
    .filter((s) => s.score > 0);
  const all = rankByScore(scored);
  return { hits: all.slice(0, limit), total: all.length, all };
}

/** 插件检索：名称（主）+ 描述 + 技能名（次）。 */
export function searchLocalPlugins(
  query: string,
  plugins: InstalledPlugin[],
  limit = 5,
): LocalSearchResult<LocalPluginItem> {
  const scored = plugins
    .map((plugin) => {
      const item = pluginItem(plugin);
      const m = plugin.manifest;
      // T1 归一化后真实 manifest 一定有 contributions；单测夹具可能仍是 v2 形态，
      // 这里兼容两种形状（只影响检索关键词的来源，不改变匹配口径）。
      const rawSkills =
        (m.contributions?.skills as { name: string }[] | undefined) ??
        ((m as unknown as { skills?: { name: string }[] }).skills ?? []);
      const skillNames = rawSkills.map((s) => s.name);
      const score = matchScore(query, m.name, [m.description ?? "", m.id, ...skillNames]);
      return { item, score, name: item.name };
    })
    .filter((s) => s.score > 0);
  const all = rankByScore(scored);
  return { hits: all.slice(0, limit), total: all.length, all };
}
