import type { TeamTask } from "@heming/shared";

/**
 * 找活（d.266）：任务一多，界面和智能体都只能看到「前 20 条」，
 * 「上周说的那条」「接口那个 bug」就只能靠翻。
 *
 * 这里只做纯筛选 + 排序，界面搜索框和 `team_task_find` 工具共用同一套语义：
 * - 关键词按空格切开，**每个词都要出现**（不区分大小写），命中范围是标题 / 需求 / 结论 / 进展 / 任务 id；
 * - `status`：`open`（未完成，默认）/ `done` / `all`；
 * - `overdue`：只留「已过截止、还没完成」的；
 * - `assigneeId`：按负责人精确筛；传空串表示「只看没人认领的」（调用方负责把用户名解析成 id）。
 */

export const FIND_TASK_LIMIT_DEFAULT = 10;
export const FIND_TASK_LIMIT_MAX = 20;

export type TaskStatusScope = "open" | "done" | "all";

export interface FindTasksInput {
  tasks: TeamTask[];
  query?: string;
  assigneeId?: string | null;
  status?: TaskStatusScope;
  overdue?: boolean;
  now?: number;
  limit?: number;
}

export interface FindTasksResult {
  hits: TeamTask[];
  /** 满足条件的总条数（可能大于 hits.length，被 limit 截断）。 */
  total: number;
  /** 参与筛选的总条数（方便说「在 87 条里找到 3 条」）。 */
  scanned: number;
}

/** 任务是否已过截止（只算未完成的）。 */
export function isOverdue(task: TeamTask, now: number = Date.now()): boolean {
  if (task.status === "done") return false;
  if (!task.dueAt) return false;
  const at = Date.parse(task.dueAt);
  return Number.isFinite(at) && at < now;
}

/** 关键词匹配：空查询视为全中；多词 AND；不区分大小写。 */
export function matchesTaskQuery(task: TeamTask, query: string): boolean {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (terms.length === 0) return true;
  const haystack = [task.id, task.title, task.detail, task.result, task.progress, task.returnNote]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("\n")
    .toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/**
 * 排序（d.268）：高优先级先于其余——「重要但不紧急」的活不该被一堆普通任务淹掉；
 * 同一优先级内再按逾期 → 截止时间 → 更新时间。
 */
const PRIORITY_RANK: Record<string, number> = { high: 0, normal: 1, low: 2 };
const rankOf = (t: TeamTask): number => PRIORITY_RANK[t.priority ?? "normal"] ?? 1;
export function sortTaskHits(tasks: TeamTask[], now: number = Date.now()): TeamTask[] {
  const dueOf = (t: TeamTask): number => {
    if (!t.dueAt) return Number.POSITIVE_INFINITY;
    const at = Date.parse(t.dueAt);
    return Number.isFinite(at) ? at : Number.POSITIVE_INFINITY;
  };
  return [...tasks].sort((a, b) => {
    const pa = rankOf(a);
    const pb = rankOf(b);
    if (pa !== pb) return pa - pb;
    const oa = isOverdue(a, now) ? 0 : 1;
    const ob = isOverdue(b, now) ? 0 : 1;
    if (oa !== ob) return oa - ob;
    const da = dueOf(a);
    const db = dueOf(b);
    if (da !== db) return da - db;
    return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  });
}

export function findTeamTasks(input: FindTasksInput): FindTasksResult {
  const now = input.now ?? Date.now();
  const status: TaskStatusScope = input.status ?? "open";
  const query = (input.query ?? "").trim();
  const limit = Math.min(
    FIND_TASK_LIMIT_MAX,
    Math.max(1, Math.trunc(input.limit ?? FIND_TASK_LIMIT_DEFAULT) || FIND_TASK_LIMIT_DEFAULT),
  );
  const filtered = input.tasks.filter((task) => {
    if (status === "open" && task.status === "done") return false;
    if (status === "done" && task.status !== "done") return false;
    if (input.overdue === true && !isOverdue(task, now)) return false;
    if (input.assigneeId !== undefined) {
      const wanted = input.assigneeId ?? "";
      const owner = task.assigneeId ?? "";
      if (owner !== wanted) return false;
    }
    return matchesTaskQuery(task, query);
  });
  const sorted = sortTaskHits(filtered, now);
  return {
    hits: sorted.slice(0, limit),
    total: sorted.length,
    scanned: input.tasks.length,
  };
}

/** 一行一条给模型看的清单；`memberName` 把负责人 id 换成名字。 */
export function describeFindResult(
  result: FindTasksResult,
  options: {
    query?: string;
    memberName?: (userId: string) => string;
    now?: number;
    limit?: number;
  } = {},
): string {
  const now = options.now ?? Date.now();
  const limit = options.limit ?? FIND_TASK_LIMIT_DEFAULT;
  const nameOf = options.memberName ?? ((id: string) => id);
  const query = (options.query ?? "").trim();
  if (result.total === 0) {
    const scope = query === "" ? "" : `（关键词「${query}」）`;
    return `在 ${result.scanned} 条任务里没有找到符合条件的${scope}；可以换个关键词，或把 status 放宽到 all。`;
  }
  const head =
    query === ""
      ? `找到 ${result.total} 条（一共 ${result.scanned} 条任务），先列 ${result.hits.length} 条：`
      : `关键词「${query}」命中 ${result.total} 条（一共 ${result.scanned} 条任务），先列 ${result.hits.length} 条：`;
  const rows = result.hits.map((task) => {
    const owner = task.assigneeId ? nameOf(task.assigneeId) : "待认领";
    const due = task.dueAt ? `截止 ${task.dueAt.slice(0, 10)}` : "无截止";
    const late = isOverdue(task, now) ? "（已逾期）" : "";
    const mark = task.priority === "high" ? "【高】" : task.priority === "low" ? "【低】" : "";
    return `- [${task.status === "done" ? "已完成" : task.status === "doing" ? "在做" : "未开始"}] ${mark}${task.title} · ${owner} · ${due}${late} · taskId ${task.id}`;
  });
  const rest =
    result.total > result.hits.length
      ? `\n（还有 ${result.total - result.hits.length} 条没列出：把关键词或负责人收紧一点，或把 limit 调大（最多 ${limit}）。）`
      : "";
  return [head, ...rows].join("\n") + rest;
}
