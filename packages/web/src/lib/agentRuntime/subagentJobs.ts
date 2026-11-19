/**
 * 后台子代理的排队与交付（d.349）。
 *
 * 为什么需要：`agent_task` 以前是同步的——主对话派出去就得停在那里等它跑完，
 * 一个「翻 30 个文件」的子代理会把主对话晾上几分钟。真正该做的是：派出去、
 * 立刻把工具调用还给模型，让它继续干别的（或先收口），结论跑完再送回来——
 * 这也是 DSH 的 `subagent` 的做法（发布 Activation 立即返回，结果另投递）。
 *
 * 这里只管三件事：
 * 1. `enqueueSubagentJob`：登记一个后台任务；同时最多 `SUBAGENT_MAX_ACTIVE` 个在跑，
 *    其余排队（上限是**全局**的，不是每个会话一份——打满配额的代价由整台机器承担）。
 * 2. 跑完把结果写进任务记录，交给 `deliverSubagentJob` 注册的交付器；
 *    没有交付器（页面不在）就先攒着，等界面回来 `takeUndeliveredJobs` 取走。
 * 3. `cancelSubagentJob`：只停这一条，不牵连主对话那一轮。
 *
 * 刻意不落盘的是**结论**与运行状态：后台子代理的生命周期就是这次运行，刷新后
 * 它的模型请求已经断了，留一份「还在跑」的记录只会变成永远不来的幽灵。
 *
 * 但「一声不响地消失」也不行（d.353，对齐 dsh-superagent 的 stored work 与
 * 「诚实报告」原则）：所以每登记/起跑/收口时把 queued|running 的**元数据**
 * 落一份盘；下次启动读到它，就把这些任务标成「被重启中断」并交给交付器，
 * 让模型和用户都能看到「这件事没跑完、原因是什么」，而不是当成做完了。
 */

/** 同时最多几个后台子代理在跑（d.349：用户定的上限 5）。 */
export const SUBAGENT_MAX_ACTIVE = 5;

/** 任务记录保留条数：跑完的只留最近这些，够界面回看即可。 */
export const SUBAGENT_JOB_HISTORY_CAP = 40;

export type SubagentJobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

/** 一条后台子代理任务（界面与交付器都读它）。 */
export interface SubagentJob {
  /** 任务 id（`bg-…`），只用于界面与日志。 */
  id: string;
  /** 属于哪个会话：交付要送回这里，不能串到别的会话。 */
  conversationId: string;
  /** 派它的智能体（交付时另起一轮要用同一个身份）。 */
  agentId: string;
  /** 智能体显示名（交付文案用）。 */
  agentName: string;
  /** 子代理是谁：工作区角色名或「通用子代理」。 */
  label: string;
  /** 派给它的自包含任务。 */
  task: string;
  /** 进度事件里的 id（`bg-…`）：界面按它认行。 */
  taskId: string;
  status: SubagentJobStatus;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  rounds: number;
  toolCalls: number;
  /** 结论正文（失败时是原因）。 */
  text: string;
  error: string | null;
  /** 是否已经交给对话（避免重复投递）。 */
  delivered: boolean;
}

/** 入队一条后台任务：`run` 由调用方包好（工具桥、模型绑定都在里面）。 */
export interface SubagentJobStart {
  conversationId: string;
  agentId: string;
  agentName: string;
  label: string;
  task: string;
  taskId: string;
  run: (signal: AbortSignal) => Promise<{
    ok: boolean;
    text: string;
    rounds: number;
    toolCalls: number;
  }>;
}

/**
 * 交付器：返回 false 表示「现在不方便送」——任务保持未交付，等界面切回那个会话
 * 再用 `takeUndeliveredJobs` 取走。别在交付器里抛异常：那会打断调度。
 */
type DeliveryHandler = (job: SubagentJob) => boolean | void;

let jobs: SubagentJob[] = [];
let pending: SubagentJobStart[] = [];
let controllers = new Map<string, AbortController>();
let deliveryHandler: DeliveryHandler | null = null;
let seq = 0;
const listeners = new Set<() => void>();

/** 落盘用的最小元数据：只够「下次启动时说清楚这件事没跑完」，不含结论。 */
interface StoredJob {
  id: string;
  conversationId: string;
  agentId: string;
  agentName: string;
  label: string;
  task: string;
  taskId: string;
  status: "queued" | "running";
  createdAt: number;
  startedAt: number | null;
}

const STORAGE_KEY = "heming.subagentJobs.v1";

/** 重启后给这些任务的原因：不假装它们失败了，也不假装它们还在跑。 */
const RESTART_ERROR =
  "应用重启时中断：这条子代理在运行时应用被关掉或刷新，没有跑完——不能把它当成已经做完。";

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** 把「还没收口」的任务元数据落盘；收口的任务不必存，结论已经进了会话。 */
function persist(): void {
  const store = storage();
  if (!store) return;
  try {
    const snapshot: StoredJob[] = jobs
      .filter((job): job is SubagentJob & { status: "queued" | "running" } => isRunning(job))
      .map((job) => ({
        id: job.id,
        conversationId: job.conversationId,
        agentId: job.agentId,
        agentName: job.agentName,
        label: job.label,
        task: job.task,
        taskId: job.taskId,
        status: job.status,
        createdAt: job.createdAt,
        startedAt: job.startedAt,
      }));
    store.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // 存不下就算了：丢的只是一次「说清楚」的机会，不影响正在跑的任务。
  }
}

function clearPersisted(): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(STORAGE_KEY);
  } catch {
    // 同 persist：拿不到存储不是致命问题。
  }
}

/** 校验一条从盘里读出来的记录（旧版本/坏档一律丢弃，不猜）。 */
function readStoredJob(value: unknown): StoredJob | null {
  if (typeof value !== "object" || value === null) return null;
  const item = value as Record<string, unknown>;
  const text = (key: string): string | null =>
    typeof item[key] === "string" && item[key] !== "" ? (item[key] as string) : null;
  const id = text("id");
  const conversationId = text("conversationId");
  const agentId = text("agentId");
  const agentName = text("agentName");
  const label = text("label");
  const task = text("task");
  const taskId = text("taskId");
  const status = item.status;
  if (!id || !conversationId || !agentId || !agentName || !label || !task || !taskId) return null;
  if (status !== "queued" && status !== "running") return null;
  const createdAt = typeof item.createdAt === "number" ? item.createdAt : 0;
  const startedAt = typeof item.startedAt === "number" ? item.startedAt : null;
  return { id, conversationId, agentId, agentName, label, task, taskId, status, createdAt, startedAt };
}

/**
 * 启动时读回上次没跑完的任务，标成「被重启中断」并等交付器补送（d.353）。
 *
 * 为什么是 failed 而不是继续跑：后台子代理的模型请求随页面一起断了，这里没有
 * 可以恢复的执行现场；硬说「还在跑」会让模型一直等一个永远不来的结论。诚实的
 * 做法是把它当成一次未完成的尝试交回会话——模型会重新派，或者自己接手。
 *
 * 返回读回来的任务（测试用；应用里由 ChatPage 在挂载时调用一次）。
 */
export function restoreInterruptedJobs(now = Date.now()): SubagentJob[] {
  const store = storage();
  if (!store) return [];
  let raw: string | null = null;
  try {
    raw = store.getItem(STORAGE_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const restored: SubagentJob[] = [];
  for (const value of Array.isArray(parsed) ? parsed : []) {
    const item = readStoredJob(value);
    if (!item) continue;
    restored.push({
      id: item.id,
      conversationId: item.conversationId,
      agentId: item.agentId,
      agentName: item.agentName,
      label: item.label,
      task: item.task,
      taskId: item.taskId,
      status: "failed",
      createdAt: item.createdAt,
      startedAt: item.startedAt,
      endedAt: now,
      rounds: 0,
      toolCalls: 0,
      text: "",
      error: RESTART_ERROR,
      delivered: false,
    });
  }
  clearPersisted();
  if (restored.length === 0) return [];
  jobs = [...jobs, ...restored].slice(-SUBAGENT_JOB_HISTORY_CAP);
  notify();
  return restored;
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** 跑着的数量（排队的不算）。 */
export function activeSubagentJobCount(): number {
  return jobs.reduce((count, job) => (job.status === "running" ? count + 1 : count), 0);
}

/** 排队中的数量。 */
export function queuedSubagentJobCount(): number {
  return jobs.reduce((count, job) => (job.status === "queued" ? count + 1 : count), 0);
}

/** 取一条任务的当前快照列表（界面用 `useSyncExternalStore` 订阅）。 */
export function listSubagentJobs(): readonly SubagentJob[] {
  return jobs;
}

/** 某个会话的任务（新到旧）。 */
export function subagentJobsOf(conversationId: string): readonly SubagentJob[] {
  return jobs.filter((job) => job.conversationId === conversationId);
}

/** 订阅任务表变化。 */
export function subscribeSubagentJobs(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 注册交付器：任务跑完时调用（页面卸载时传 null 收起来）。 */
export function setSubagentJobDelivery(handler: DeliveryHandler | null): void {
  deliveryHandler = handler;
}

/**
 * 登记一条后台任务并立刻返回记录。
 *
 * 到上限时它先以 `queued` 待着，前面有任务收口就自动起跑——调用方（工具桥）
 * 只关心「已经排上了」，不需要知道是第几条。
 */
export function enqueueSubagentJob(start: SubagentJobStart, now = Date.now()): SubagentJob {
  seq += 1;
  const job: SubagentJob = {
    id: `bg-${now.toString(36)}-${seq}`,
    conversationId: start.conversationId,
    agentId: start.agentId,
    agentName: start.agentName,
    label: start.label,
    task: start.task,
    taskId: start.taskId,
    status: "queued",
    createdAt: now,
    startedAt: null,
    endedAt: null,
    rounds: 0,
    toolCalls: 0,
    text: "",
    error: null,
    delivered: false,
  };
  jobs = [...jobs, job].slice(-SUBAGENT_JOB_HISTORY_CAP);
  persist();
  pending = [...pending, start];
  notify();
  pump();
  return job;
}

/** 有空位就起跑（同步：排队的是内存数组，不需要定时器）。 */
function pump(): void {
  while (activeSubagentJobCount() < SUBAGENT_MAX_ACTIVE && pending.length > 0) {
    const start = pending.shift();
    if (!start) return;
    const job = jobs.find((item) => item.taskId === start.taskId && item.status === "queued");
    if (!job) continue;
    const controller = new AbortController();
    controllers.set(job.id, controller);
    markRunning(job.id);
    void start
      .run(controller.signal)
      .then((result) => settle(job.id, result))
      .catch((error: unknown) => {
        settle(job.id, {
          ok: false,
          text: "",
          rounds: 0,
          toolCalls: 0,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }
}

function markRunning(id: string): void {
  jobs = jobs.map((job) =>
    job.id === id ? { ...job, status: "running" as const, startedAt: Date.now() } : job,
  );
  notify();
  persist();
}

function settle(
  id: string,
  result: {
    ok: boolean;
    text: string;
    rounds: number;
    toolCalls: number;
    error?: string;
  },
): void {
  controllers.delete(id);
  let settled: SubagentJob | null = null;
  jobs = jobs.map((job) => {
    if (job.id !== id || (job.status !== "running" && job.status !== "queued")) return job;
    const error = result.error ?? (result.ok ? null : result.text || "子代理没有给出结论");
    settled = {
      ...job,
      status: result.ok ? "done" : "failed",
      endedAt: Date.now(),
      rounds: result.rounds,
      toolCalls: result.toolCalls,
      text: result.text,
      error,
    };
    return settled;
  });
  notify();
  persist();
  if (settled) deliver(settled);
  pump();
}

function deliver(job: SubagentJob): void {
  if (job.delivered) return;
  const handler = deliveryHandler;
  if (!handler) return; // 页面不在：先攒着，回来 takeUndeliveredJobs
  let accepted = true;
  try {
    accepted = handler(job) !== false;
  } catch {
    // 交付失败不得反噬任务表：结论仍在记录里，用户可以手动「继续」。
    accepted = false;
  }
  if (!accepted) return; // 保持未交付：切回那个会话时会补送
  const updated = { ...job, delivered: true };
  jobs = jobs.map((item) => (item.id === job.id ? updated : item));
  notify();
}

/**
 * 取走某个会话里「还没交付」的任务（页面刚回来时用）。
 *
 * 取走即标记已交付：同一份结论不能让模型看两遍——重复注入会浪费上下文，
 * 还可能让它把同一件事重做一次。
 */
/**
 * 这个会话里有多少条后台子代理的结论还没送进去（d.383）。
 *
 * 与 `takeUndeliveredJobs` 的区别：只数、不取、不标记——侧栏要靠它显示一个
 * 「有结论等你回来」的提示，取走就等于交付了，用户还没看就没了。
 */
export function undeliveredJobsOf(conversationId: string): readonly SubagentJob[] {
  return jobs.filter(
    (job) => job.conversationId === conversationId && !job.delivered && !isRunning(job),
  );
}
export function takeUndeliveredJobs(conversationId: string): SubagentJob[] {
  const taken = jobs.filter(
    (job) => job.conversationId === conversationId && !job.delivered && !isRunning(job),
  );
  if (taken.length === 0) return [];
  const ids = new Set(taken.map((job) => job.id));
  jobs = jobs.map((job) => (ids.has(job.id) ? { ...job, delivered: true } : job));
  notify();
  return taken.map((job) => ({ ...job, delivered: true }));
}

function isRunning(job: SubagentJob): boolean {
  return job.status === "running" || job.status === "queued";
}

/** 用户主动停掉一条后台任务（只影响这一条）。 */
export function cancelSubagentJob(id: string): boolean {
  const job = jobs.find((item) => item.id === id);
  if (!job || !isRunning(job)) return false;
  if (job.status === "queued") {
    pending = pending.filter((start) => start.taskId !== job.taskId);
    jobs = jobs.map((item) =>
      item.id === id
        ? { ...item, status: "cancelled" as const, endedAt: Date.now(), error: "已取消" }
        : item,
    );
    notify();
    persist();
    return true;
  }
  controllers.get(id)?.abort();
  controllers.delete(id);
  jobs = jobs.map((item) =>
    item.id === id
      ? { ...item, status: "cancelled" as const, endedAt: Date.now(), error: "已取消" }
      : item,
  );
  notify();
  persist();
  pump();
  return true;
}

/** 停掉某个会话的全部后台任务（用户明确要停时用；切会话不调它）。 */
export function cancelSubagentJobsOf(conversationId: string): number {
  let count = 0;
  for (const job of jobs) {
    if (job.conversationId !== conversationId) continue;
    if (cancelSubagentJob(job.id)) count += 1;
  }
  return count;
}

/** 测试用：清空任务表、排队与交付器。 */
export function resetSubagentJobs(): void {
  for (const controller of controllers.values()) controller.abort();
  controllers = new Map();
  jobs = [];
  pending = [];
  deliveryHandler = null;
  seq = 0;
  clearPersisted();
  notify();
}

/**
 * 交付给主对话的正文（d.349）：必须是**自包含**的一段——它可能作为下一轮的第一条
 * 输入出现，模型不能靠「刚才那条工具结果」理解它（那已经不在这个上下文里了）。
 *
 * 失败也要交付：模型得知道「这件事没成」，否则会照着「派出去了」继续往下编。
 */
export function subagentDeliveryText(job: SubagentJob): string {
  const usage = `${job.rounds} 轮 / ${job.toolCalls} 次工具调用`;
  const task = job.task.length > 160 ? `${job.task.slice(0, 160)}…` : job.task;
  if (job.status === "cancelled") {
    return [
      `【后台子代理已取消】${job.label}（${task}）`,
      "它没有交回结论；这段任务如果还需要，请重新派一次，或者你自己做完并说明原因。",
    ].join("\n");
  }
  if (job.status === "failed") {
    return [
      `【后台子代理没能完成】${job.label}（${usage}）：${task}`,
      `原因：${job.error ?? "没有给出原因"}`,
      job.text ? `它最后写下的内容：\n${job.text}` : "",
      "不要把它没做完的事当成已完成；需要的话缩小范围再派一次，或者自己接手。",
    ]
      .filter(Boolean)
      .join("\n");
  }
  return [
    `【后台子代理交回结论】${job.label}（${usage}）：${task}`,
    job.text || "（它没有返回内容）",
    "这条是它跑完之后自动送回的：请把结论纳入当前这一轮的处理，再给用户一个完整的答复。",
  ].join("\n");
}


