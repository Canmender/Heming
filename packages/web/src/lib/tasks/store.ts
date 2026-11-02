import { create } from "zustand";
import type { ToolSource } from "../agentStream.js";
import type { DenyCause } from "../hitl/types.js";
import { FORK_PREFIX_NOTICE, FORK_TRUNCATED_NOTICE } from "../rollout/fork.js";
import {
  createDefaultStorage,
  isPlainObject,
  readJson,
  utf8Length,
  writeJson,
} from "../memory/storage.js";
import type { StorageLike } from "../memory/types.js";
import { useNotificationStore } from "../../store/notifications.js";

/**
 * 任务区数据层（本机）：一次「发起任务 → 智能体执行 → 汇总结果」的完整记录。
 *
 * 与聊天消息的分工：
 * - 消息是**对话事实**（服务端存储、E2E 信封）；
 * - 任务是**执行视图**（标题、步骤轨迹、最终结果、汇总报告），只存本机，
 *   不上云、不进消息库——它包含工具参数摘要，不该被同步到任何服务端。
 */

export const TASKS_KEY = "heming.tasks.v1";

/** 保留的任务条数（超出淘汰最旧；已完成任务与进行中任务一视同仁，按创建时间）。 */
export const MAX_TASKS = 60;
/** 单个任务的工具步骤上限（超出保留最新的）。 */
export const MAX_STEPS = 40;
/** 标题长度（首行截断）。 */
export const MAX_TITLE_CHARS = 60;
/** 任务目标全文上限。 */
export const MAX_PROMPT_CHARS = 4000;
/** 结果全文上限。 */
export const MAX_RESULT_CHARS = 12_000;
/** 单条工具结果在任务记录里的上限（报告另有截断）。 */
export const MAX_STEP_RESULT_CHARS = 1600;
/** 报告末尾来源上限（与 agentStream 的 MAX_SOURCES 同口径）。 */
export const MAX_REPORT_SOURCES = 8;
/** 单键上限：localStorage 整个源约 5MB，给记忆/设置等键留余量。 */
export const TASKS_BYTE_LIMIT = Math.floor(1.1 * 1024 * 1024);

/**
 * 判定「长时间无响应」的阈值。
 *
 * 任务记录是本机的执行视图：应用关掉或刷新后，真正在跑的流已经没了
 * （本机流不跨进程恢复），记录若一直显示「进行中」，用户会误以为它还在跑。
 * 超过此阈值仍未收尾的 running 任务，加载/定时扫描时置为失败。
 */
export const TASK_STALE_MS = 10 * 60_000;

export type TaskStatus = "running" | "done" | "failed" | "cancelled";

export type TaskStepStatus = "running" | "ok" | "error" | "denied";

/** 一次工具调用在任务里的轨迹（与流气泡的 ToolTrace 同源，但只留汇总需要的字段）。 */
export interface TaskStep {
  id: string;
  name: string;
  /** 参数 JSON 原文（报告里会压缩成一行并截断）。 */
  args: string;
  status: TaskStepStatus;
  result?: string;
  startedAt: number;
  endedAt?: number;
  /** 工具成功返回的来源（知识库页面等）。 */
  sources?: ToolSource[];
  /** 拒绝原因：用户当场拒绝 / 命中记住的规则 / 闸门异常。 */
  denyCause?: DenyCause;
}

export interface TaskRecord {
  id: string;
  conversationId: string;
  agentId: string;
  agentName: string;
  title: string;
  prompt: string;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
  endedAt?: number;
  /** 首次触发该任务的流 id（任务与流气泡据此对照）。 */
  streamId?: string;
  /**
   * 分叉来源（d.56）：本任务是从哪个回合的第 `seq` 条 item 之后接着执行的。
   *
   * 原任务的日志/汇总/状态一律不动（§12.1）：分叉是**新任务**，
   * 这个字段只表达「从哪来」，不把两条任务的统计混在一起。
   */
  forkedFrom?: TaskForkedFrom;
  /** 最终回答（成功/中断时有值）。 */
  result?: string;
  /** 失败原因（失败时有值）。 */
  error?: string;
  steps: TaskStep[];
}

/** 分叉来源与「前缀重建代价」：任务卡要据此如实提示，不能暗示无损续跑。 */
export interface TaskForkedFrom {
  streamId: string;
  seq: number;
  /**
   * 重建前缀时被截断的工具结果条数（>0 时任务卡必须提示「结果不完整」）。
   * 日志单条文本上限 2000 字符，分叉复用的是**重建**出来的前缀，不是原始 transcript。
   */
  truncatedResults?: number;
}

/** 任务列表页头部的汇总数字（纯派生，不落盘）。 */
export interface TaskStats {
  total: number;
  running: number;
  done: number;
  failed: number;
  cancelled: number;
  tools: number;
  sources: number;
}

let idSeq = 0;

function newTaskId(now: number): string {
  idSeq += 1;
  return `task-${now.toString(36)}-${idSeq.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** 按码点截断（避免切坏代理对）。 */
function clip(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  return `${chars.slice(0, Math.max(0, max - 1)).join("")}…`;
}

/** 压成一行（报告/列表展示用）。 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** 任务标题：首个非空行，压平空白后截断。 */
export function taskTitle(prompt: string): string {
  const first = prompt.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  const flat = oneLine(first);
  return flat ? clip(flat, MAX_TITLE_CHARS) : "未命名任务";
}

export function taskStatusLabel(status: TaskStatus): string {
  switch (status) {
    case "running":
      return "进行中";
    case "done":
      return "已完成";
    case "failed":
      return "失败";
    case "cancelled":
      return "已中断";
  }
}

export function taskStepStatusLabel(status: TaskStepStatus): string {
  switch (status) {
    case "running":
      return "执行中";
    case "ok":
      return "完成";
    case "error":
      return "失败";
    case "denied":
      return "已拒绝";
  }
}

/** 本地时间 `YYYY-MM-DD HH:mm`（确定性格式，不依赖运行环境的 locale）。 */
export function formatTaskTime(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} 分 ${total % 60} 秒`;
  return `${Math.floor(minutes / 60)} 时 ${minutes % 60} 分`;
}

/** 任务里出现过的来源（去重、按首次出现、上限 MAX_REPORT_SOURCES）。 */
export function taskSources(task: TaskRecord): ToolSource[] {
  const seen = new Set<string>();
  const out: ToolSource[] = [];
  for (const step of task.steps) {
    for (const source of step.sources ?? []) {
      const id = String(source?.id ?? "").trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({ ...source, id });
      if (out.length >= MAX_REPORT_SOURCES) return out;
    }
  }
  return out;
}

/** 轻量统计（页头/汇总卡用）。 */export function taskStats(tasks: TaskRecord[]): TaskStats {
  const stats: TaskStats = {
    total: tasks.length,
    running: 0,
    done: 0,
    failed: 0,
    cancelled: 0,
    tools: 0,
    sources: 0,
  };
  const sourceIds = new Set<string>();
  for (const task of tasks) {
    stats[task.status] += 1;
    stats.tools += task.steps.length;
    for (const step of task.steps) {
      for (const source of step.sources ?? []) {
        const id = String(source?.id ?? "").trim();
        if (id) sourceIds.add(id);
      }
    }
  }
  stats.sources = sourceIds.size;
  return stats;
}

/**
 * 分叉任务在任务卡上的诚实提示（与分叉确认框**同一份口径**）。
 *
 * 返回 null 表示不是分叉任务。措辞刻意不说「从第 N 步继续」——
 * 前缀是本机日志重建出来的摘要，超过 2000 字符的结果已被截断。
 */
export function taskForkNotice(task: TaskRecord): string | null {
  const forked = task.forkedFrom;
  if (!forked) return null;
  const truncated = forked.truncatedResults ?? 0;
  return truncated > 0
    ? `${FORK_PREFIX_NOTICE}有 ${truncated} 条工具${FORK_TRUNCATED_NOTICE}`
    : FORK_PREFIX_NOTICE;
}

/**
 * 确定性汇总报告（Markdown）：同一份任务记录永远生成同一段文字，
 * 不调用模型、不含随机/时间性内容（时间取记录里的时间戳）。
 */
export function buildTaskReport(task: TaskRecord): string {
  const lines: string[] = [];
  lines.push(`# 任务：${task.title}`, "");
  lines.push(`- 状态：${taskStatusLabel(task.status)}`);
  lines.push(`- 智能体：${oneLine(task.agentName) || task.agentId}`);
  lines.push(`- 创建：${formatTaskTime(task.createdAt)}`);
  if (task.endedAt !== undefined) {
    lines.push(`- 结束：${formatTaskTime(task.endedAt)}`);
    lines.push(`- 用时：${formatDuration(task.endedAt - task.createdAt)}`);
  }
  lines.push(`- 会话：${task.conversationId}`, "");
  if (task.forkedFrom) {
    lines.push(
      `- 来源：从回合 ${task.forkedFrom.streamId} 第 ${task.forkedFrom.seq} 条之后分叉`,
      `- 提示：${taskForkNotice(task)}`,
      "",
    );
  }

  lines.push("## 目标", "");
  lines.push(task.prompt.trim() || "（空）", "");

  lines.push("## 结果", "");
  lines.push(task.result?.trim() || (task.status === "running" ? "（执行中，暂无结果）" : "（无）"));
  if (task.error) {
    lines.push("", "## 失败原因", "", task.error.trim());
  }
  lines.push("");

  lines.push("## 执行步骤", "");
  if (!task.steps.length) {
    lines.push("（无工具调用）");
  } else {
    task.steps.forEach((step, i) => {
      lines.push(
        `${i + 1}. [${taskStepStatusLabel(step.status)}] ${oneLine(step.name) || "未命名工具"}`,
      );
      const args = oneLine(step.args);
      if (args) lines.push(`   - 参数：${clip(args, 200)}`);
      if (step.denyCause) {
        const why =
          step.denyCause === "rule"
            ? "命中记住的拒绝规则"
            : step.denyCause === "gate"
              ? "确认流程异常"
              : "用户当场拒绝";
        lines.push(`   - 拒绝原因：${why}`);
      }
      const result = oneLine(step.result ?? "");
      if (result) lines.push(`   - 结果：${clip(result, 300)}`);
    });
  }

  const sources = taskSources(task);
  if (sources.length) {
    lines.push("", "## 来源", "");
    for (const source of sources) {
      const detail = source.detail ? ` — ${oneLine(source.detail)}` : "";
      lines.push(`- ${oneLine(source.title || source.id)}（${source.id}）${detail}`);
    }
  }

  lines.push("", "---", "由和鸣通用智能体本机生成，仅保存在当前设备。");
  return lines.join("\n");
}

/** 任务 JSON 导出格式版本：结构变更时递增，读取方据此判断兼容性。 */
export const TASK_EXPORT_VERSION = 1;

/**
 * 确定性 JSON 导出：字段逐个显式列出（不直接序列化内部记录），
 * 避免以后新增的内部字段被意外带出；时间保留毫秒时间戳，便于程序处理。
 */
export function buildTaskJson(task: TaskRecord): string {
  const payload = {
    format: "heming-task",
    version: TASK_EXPORT_VERSION,
    task: {
      id: task.id,
      conversationId: task.conversationId,
      agentId: task.agentId,
      agentName: task.agentName,
      title: task.title,
      prompt: task.prompt,
      status: task.status,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      ...(task.endedAt === undefined ? {} : { endedAt: task.endedAt }),
      ...(task.streamId === undefined ? {} : { streamId: task.streamId }),
      ...(task.forkedFrom === undefined ? {} : { forkedFrom: task.forkedFrom }),
      ...(task.result === undefined ? {} : { result: task.result }),
      ...(task.error === undefined ? {} : { error: task.error }),
      steps: task.steps.map((step) => ({
        id: step.id,
        name: step.name,
        args: step.args,
        status: step.status,
        startedAt: step.startedAt,
        ...(step.endedAt === undefined ? {} : { endedAt: step.endedAt }),
        ...(step.result === undefined ? {} : { result: step.result }),
        ...(step.sources?.length ? { sources: step.sources } : {}),
        ...(step.denyCause ? { denyCause: step.denyCause } : {}),
      })),
    },
    /** 与 Markdown 报告「来源」段同口径：去重、按首次出现、上限 MAX_REPORT_SOURCES。 */
    sources: taskSources(task),
  };
  return JSON.stringify(payload, null, 2);
}

/** 任务是否已超时未收尾。 */
export function isTaskStale(task: TaskRecord, now: number, staleMs = TASK_STALE_MS): boolean {
  return task.status === "running" && now - task.updatedAt > staleMs;
}

/** 把超时未收尾的任务置为失败（返回新数组；无变化时返回原数组，避免无谓重渲染）。 */
export function markStaleTasks(
  tasks: TaskRecord[],
  now: number,
  staleMs = TASK_STALE_MS,
): TaskRecord[] {
  let changed = false;
  const next = tasks.map((task) => {
    if (!isTaskStale(task, now, staleMs)) return task;
    changed = true;
    return {
      ...task,
      status: "failed" as const,
      endedAt: task.updatedAt,
      updatedAt: now,
      error: "长时间无响应，任务已中断（应用可能已关闭或刷新）",
    };
  });
  return changed ? next : tasks;
}

/**
 * 淘汰结果：保留下来的任务 + **被迫摘掉的进行中任务**（d.35 · P1-6）。
 *
 * 为什么要把 `droppedRunning` 单独交出去：进行中的任务被摘掉意味着
 * 「任务悄悄消失且报告缺失」，调用方必须先发通知再落盘——不静默丢是 d.24 定的口径。
 */
export interface PruneResult {
  tasks: TaskRecord[];
  /** 因条数/字节上限被迫摘掉的 running 任务（正常情况下应为空）。 */
  droppedRunning: TaskRecord[];
}

/**
 * 按条数上限（`MAX_TASKS`）与字节上限淘汰任务。
 *
 * ★ 淘汰**只从已结束的任务里摘**（d.35 · P1-6）：原实现按 `createdAt` 一刀切，
 * 会把创建最早、跑得最久的 `running` 任务挤掉，随后 `onRunSettled` 无处可写
 * ——任务悄悄消失且报告缺失。
 * 只有当 running 自己就超过上限（或字节超限且只剩 running）时才会动它，
 * 且被摘的会放进 `droppedRunning` 由调用方先通知。
 */
export function pruneTasks(tasks: TaskRecord[], limit = TASKS_BYTE_LIMIT): PruneResult {
  const droppedRunning: TaskRecord[] = [];
  const sorted = [...tasks].sort((a, b) => b.createdAt - a.createdAt);
  const running = sorted.filter((t) => t.status === "running");
  const ended = sorted.filter((t) => t.status !== "running");

  // ① 条数上限：ended 让位，running 全保；running 自己超额时才动它（保上限）。
  let keptRunning = running;
  if (running.length > MAX_TASKS) {
    const overflow = running.length - MAX_TASKS;
    // running 已按 createdAt 降序 ⇒ 尾部是最旧的
    droppedRunning.push(...running.slice(running.length - overflow));
    keptRunning = running.slice(0, MAX_TASKS);
  }
  const room = Math.max(0, MAX_TASKS - keptRunning.length);
  // ★ 只**筛选**不重排：保留原列表的相对顺序（按 createdAt 倒序，等时间戳时保持输入序）。
  // 早先的实现把 running 提到前面过——那会让列表顺序在每次落盘后跳动，是行为变更，
  // 与「淘汰谁」这件事无关。
  const keptIds = new Set([
    ...keptRunning.map((t) => t.id),
    ...ended.slice(0, room).map((t) => t.id),
  ]);
  let next = sorted
    .filter((task) => keptIds.has(task.id))
    .map((task) => ({
      ...task,
      steps: task.steps.slice(-MAX_STEPS),
      result: task.result === undefined ? undefined : clip(task.result, MAX_RESULT_CHARS),
      prompt: clip(task.prompt, MAX_PROMPT_CHARS),
    }));

  // ② 字节上限：优先摘**最旧的已结束**；只剩 running 时才动 running（并记录）。
  let bytes = utf8Length(JSON.stringify(next));
  while (bytes > limit && next.length > 1) {
    let victim = -1;
    // 从尾部扫（列表按时间降序）⇒ 先找到的就是最旧的 ended
    for (let i = next.length - 1; i >= 0; i -= 1) {
      if (next[i].status !== "running") {
        victim = i;
        break;
      }
    }
    // 全是 running：只能摘最旧的，记录后由调用方通知。
    if (victim === -1) victim = next.length - 1;
    const [removed] = next.splice(victim, 1);
    if (removed.status === "running") droppedRunning.push(removed);
    bytes = utf8Length(JSON.stringify(next));
  }
  if (bytes > limit && next.length === 1) {
    // 单条任务仍然超限：先砍结果，再砍步骤文本；最后仍不行就放弃这条记录。
    const only = next[0];
    const half = clip(only.result ?? "", Math.floor(MAX_RESULT_CHARS / 3));
    next = [
      {
        ...only,
        result: only.result === undefined ? undefined : half,
        steps: only.steps.map((step) => ({
          ...step,
          result: step.result === undefined ? undefined : clip(step.result, 200),
        })),
      },
    ];
    if (utf8Length(JSON.stringify(next)) > limit) {
      if (only.status === "running") droppedRunning.push(only);
      next = [];
    }
  }
  return { tasks: next, droppedRunning };
}

/* ------------------------------------------------------------------ 水合 */

function pickStep(raw: unknown): TaskStep | null {
  if (!isPlainObject(raw)) return null;
  if (typeof raw.id !== "string" || typeof raw.name !== "string") return null;
  const status = raw.status;
  if (status !== "running" && status !== "ok" && status !== "error" && status !== "denied") {
    return null;
  }
  const startedAt = typeof raw.startedAt === "number" ? raw.startedAt : Date.now();
  const sources = Array.isArray(raw.sources)
    ? raw.sources
        .filter((s): s is Record<string, unknown> => isPlainObject(s))
        .filter((s) => typeof s.id === "string")
        .map((s) => ({
          id: String(s.id),
          title: typeof s.title === "string" ? s.title : String(s.id),
          ...(typeof s.detail === "string" ? { detail: s.detail } : {}),
        }))
        .slice(0, MAX_REPORT_SOURCES)
    : undefined;
  return {
    id: raw.id,
    name: raw.name,
    args: typeof raw.args === "string" ? raw.args : "",
    status,
    ...(typeof raw.result === "string" ? { result: raw.result } : {}),
    startedAt,
    ...(typeof raw.endedAt === "number" ? { endedAt: raw.endedAt } : {}),
    ...(sources?.length ? { sources } : {}),
    ...(raw.denyCause === "user" || raw.denyCause === "rule" || raw.denyCause === "gate"
      ? { denyCause: raw.denyCause }
      : {}),
  };
}

function pickForkedFrom(raw: unknown): TaskForkedFrom | null {
  if (!isPlainObject(raw)) return null;
  if (typeof raw.streamId !== "string" || !raw.streamId) return null;
  if (typeof raw.seq !== "number" || !Number.isFinite(raw.seq) || raw.seq < 0) return null;
  const truncated =
    typeof raw.truncatedResults === "number" && Number.isFinite(raw.truncatedResults) && raw.truncatedResults > 0
      ? Math.floor(raw.truncatedResults)
      : undefined;
  return {
    streamId: raw.streamId,
    seq: Math.floor(raw.seq),
    ...(truncated ? { truncatedResults: truncated } : {}),
  };
}

function pickTask(raw: unknown): TaskRecord | null {
  if (!isPlainObject(raw)) return null;
  if (
    typeof raw.id !== "string" ||
    typeof raw.conversationId !== "string" ||
    typeof raw.agentId !== "string" ||
    typeof raw.prompt !== "string"
  ) {
    return null;
  }
  const status = raw.status;
  if (status !== "running" && status !== "done" && status !== "failed" && status !== "cancelled") {
    return null;
  }
  const createdAt = typeof raw.createdAt === "number" ? raw.createdAt : Date.now();
  return {
    id: raw.id,
    conversationId: raw.conversationId,
    agentId: raw.agentId,
    agentName: typeof raw.agentName === "string" ? raw.agentName : raw.agentId,
    title: typeof raw.title === "string" && raw.title ? raw.title : taskTitle(raw.prompt),
    prompt: raw.prompt,
    status,
    createdAt,
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : createdAt,
    ...(typeof raw.endedAt === "number" ? { endedAt: raw.endedAt } : {}),
    ...(typeof raw.streamId === "string" ? { streamId: raw.streamId } : {}),
    ...(pickForkedFrom(raw.forkedFrom) ? { forkedFrom: pickForkedFrom(raw.forkedFrom)! } : {}),
    ...(typeof raw.result === "string" ? { result: raw.result } : {}),
    ...(typeof raw.error === "string" ? { error: raw.error } : {}),
    steps: Array.isArray(raw.steps)
      ? raw.steps.map(pickStep).filter((s): s is TaskStep => s !== null)
      : [],
  };
}

/** 读取任务列表：缺键/损坏回退空，结构不符的条目丢弃。 */
export function readTasks(storage: StorageLike = createDefaultStorage()): TaskRecord[] {
  return readJson(storage, TASKS_KEY, [] as TaskRecord[], (raw) => {
    if (!Array.isArray(raw)) return [];
    const items = raw.map(pickTask).filter((t): t is TaskRecord => t !== null);
    return pruneTasks(items).tasks;
  });
}

/* ------------------------------------------------------------------ store */

interface TaskState {
  tasks: TaskRecord[];
  /** 建档（任务列表按创建时间倒序，最新在前）。返回任务 id。 */
  create: (input: {
    conversationId: string;
    agentId: string;
    agentName: string;
    prompt: string;
    /** 分叉新建任务时带上来源；普通新建不传。 */
    forkedFrom?: TaskForkedFrom;
    now?: number;
  }) => string;
  /** 绑定当前流（onStart 时调用；重试换新流后覆盖，任务详情据此找到最新一条）。 */
  bindStream: (taskId: string, streamId: string) => void;
  stepStart: (
    taskId: string,
    step: { id: string; name: string; args: string; now?: number },
  ) => void;
  stepEnd: (
    taskId: string,
    stepId: string,
    patch: {
      status: Exclude<TaskStepStatus, "running">;
      result?: string;
      sources?: ToolSource[];
      denyCause?: DenyCause;
      now?: number;
    },
  ) => void;
  /**
   * 重试：把已结束的任务拉回「进行中」。
   *
   * 保留既有步骤轨迹（上一轮的失败/拒绝是事实），只清终态字段；
   * 新一轮的工具步骤按新 id 追加在后面。
   */
  reopen: (taskId: string, now?: number) => void;
  /**
   * 重跑（d.56）：**保留原任务**，新建一个任务（新 `streamId` 在触发时绑定）。
   *
   * 与 `reopen` 的区别：`reopen` 把同一任务拉回进行中（步骤追加在原任务里），
   * 会让「这一轮跑成什么样」覆盖掉上一轮的留痕；重跑新建任务，两边互不影响。
   * 返回新任务 id；原任务不存在时返回 null（不静默造一个）。
   */
  rerun: (taskId: string, now?: number) => string | null;
  /**
   * 分叉（d.56）：**保留原任务**，新建一个任务并记下 `forkedFrom`。
   *
   * 继承原任务的目标与智能体（§12.1）；原任务的日志、汇总、状态一律不动。
   * 返回新任务 id；原任务不存在时返回 null。
   */
  forkFrom: (taskId: string, forkedFrom: TaskForkedFrom, now?: number) => string | null;
  /** 收尾（只对 running 生效：晚到的重复回调不得覆盖已结束状态）。 */
  settle: (
    taskId: string,
    outcome: {
      status: Exclude<TaskStatus, "running">;
      result?: string;
      error?: string;
      now?: number;
    },
  ) => void;
  remove: (taskId: string) => void;
  /** 清掉全部已结束任务（进行中保留）。返回清除条数。 */
  clearFinished: () => number;
  /** 扫描超时未收尾的任务并置失败。返回处理条数。 */
  markStale: (now?: number) => number;
}

let storage: StorageLike | null = null;

function getStorage(): StorageLike {
  return (storage ??= createDefaultStorage());
}

/** 测试注入点：传 null 恢复默认（jsdom 的 localStorage）。 */
export function setTaskStorage(next: StorageLike | null): void {
  storage = next;
}

function persist(tasks: TaskRecord[]): TaskRecord[] {
  const { tasks: pruned, droppedRunning } = pruneTasks(tasks);
  // 被迫摘掉进行中的任务 = 任务会悄悄消失且报告缺失（d.24「不静默丢」）。
  // 先通知、再落盘：用户至少知道「有一条跑着的任务被清理了」，而不是事后发现没了。
  for (const task of droppedRunning) {
    try {
      useNotificationStore.getState().push({
        kind: "task",
        key: `task-evicted:${task.id}`,
        title: "任务记录被清理",
        body: `${task.title}（进行中的任务因存储上限被移除，报告可能缺失）`,
        ...(task.conversationId ? { conversationId: task.conversationId } : {}),
      });
    } catch {
      /* 通知失败不影响落盘 */
    }
  }
  writeJson(getStorage(), TASKS_KEY, pruned, TASKS_BYTE_LIMIT);
  return pruned;
}

/** 更新一条任务并落盘；任务不存在时原样返回。 */
function patchTask(
  tasks: TaskRecord[],
  taskId: string,
  patch: (task: TaskRecord) => TaskRecord,
): TaskRecord[] {
  let found = false;
  const next = tasks.map((task) => {
    if (task.id !== taskId) return task;
    found = true;
    return patch(task);
  });
  return found ? next : tasks;
}

export const useTaskStore = create<TaskState>((set, get) => ({
  tasks: markStaleTasks(readTasks(), Date.now()),

  create: ({ conversationId, agentId, agentName, prompt, forkedFrom, now = Date.now() }) => {
    const id = newTaskId(now);
    const task: TaskRecord = {
      id,
      conversationId,
      agentId,
      agentName,
      title: taskTitle(prompt),
      prompt: clip(prompt, MAX_PROMPT_CHARS),
      status: "running",
      createdAt: now,
      updatedAt: now,
      ...(forkedFrom ? { forkedFrom } : {}),
      steps: [],
    };
    set({ tasks: persist([task, ...get().tasks]) });
    return id;
  },

  bindStream: (taskId, streamId) => {
    set({
      tasks: persist(patchTask(get().tasks, taskId, (task) => ({ ...task, streamId }))),
    });
  },

  stepStart: (taskId, { id, name, args, now = Date.now() }) => {
    set({
      tasks: persist(
        patchTask(get().tasks, taskId, (task) => {
          const steps = task.steps.filter((s) => s.id !== id);
          steps.push({ id, name, args, status: "running", startedAt: now });
          return { ...task, steps: steps.slice(-MAX_STEPS), updatedAt: now };
        }),
      ),
    });
  },

  stepEnd: (taskId, stepId, { status, result, sources, denyCause, now = Date.now() }) => {
    set({
      tasks: persist(
        patchTask(get().tasks, taskId, (task) => {
          const idx = task.steps.findIndex((s) => s.id === stepId);
          const steps = [...task.steps];
          const entry: TaskStep = {
            ...(idx >= 0
              ? steps[idx]
              : { id: stepId, name: "工具调用", args: "", startedAt: now }),
            status,
            endedAt: now,
            ...(result === undefined ? {} : { result: clip(result, MAX_STEP_RESULT_CHARS) }),
            ...(sources?.length ? { sources: sources.slice(0, MAX_REPORT_SOURCES) } : {}),
            ...(denyCause ? { denyCause } : {}),
          };
          if (idx >= 0) steps[idx] = entry;
          else steps.push(entry);
          return { ...task, steps: steps.slice(-MAX_STEPS), updatedAt: now };
        }),
      ),
    });
  },

  reopen: (taskId, now = Date.now()) => {
    set({
      tasks: persist(
        patchTask(get().tasks, taskId, (task) =>
          task.status === "running"
            ? task
            : { ...task, status: "running", updatedAt: now, endedAt: undefined, error: undefined },
        ),
      ),
    });
  },

  rerun: (taskId, now = Date.now()) => {
    const origin = get().tasks.find((task) => task.id === taskId);
    if (!origin) return null;
    // 目标/智能体/会话原样继承：重跑不重新解读用户意图，也不换会话（消息仍在那条对话里）。
    const id = get().create({
      conversationId: origin.conversationId,
      agentId: origin.agentId,
      agentName: origin.agentName,
      prompt: origin.prompt,
      now,
    });
    return id;
  },

  forkFrom: (taskId, forkedFrom, now = Date.now()) => {
    const origin = get().tasks.find((task) => task.id === taskId);
    if (!origin) return null;
    const id = get().create({
      conversationId: origin.conversationId,
      agentId: origin.agentId,
      agentName: origin.agentName,
      prompt: origin.prompt,
      forkedFrom,
      now,
    });
    return id;
  },

  settle: (taskId, { status, result, error, now = Date.now() }) => {
    set({
      tasks: persist(
        patchTask(get().tasks, taskId, (task) => {
          if (task.status !== "running") return task;
          // 收尾时把仍在「执行中」的步骤标成失败：流结束了却没收尾的工具，
          // 不可能再拿到结果——留着「执行中」会让汇总报告自相矛盾。
          const steps = task.steps.map((step) =>
            step.status === "running"
              ? { ...step, status: status === "cancelled" ? ("denied" as const) : ("error" as const), endedAt: now }
              : step,
          );
          return {
            ...task,
            status,
            steps,
            updatedAt: now,
            endedAt: now,
            ...(result === undefined ? {} : { result: clip(result, MAX_RESULT_CHARS) }),
            ...(error === undefined ? {} : { error: clip(error, 600) }),
          };
        }),
      ),
    });
  },

  remove: (taskId) => {
    set({ tasks: persist(get().tasks.filter((t) => t.id !== taskId)) });
  },

  clearFinished: () => {
    const before = get().tasks;
    const next = before.filter((t) => t.status === "running");
    if (next.length === before.length) return 0;
    set({ tasks: persist(next) });
    return before.length - next.length;
  },

  markStale: (now = Date.now()) => {
    const before = get().tasks;
    const next = markStaleTasks(before, now);
    if (next === before) return 0;
    set({ tasks: persist(next) });
    return next.filter((t, i) => t !== before[i]).length;
  },
}));
