import type { ToolBridge, ToolSource } from "../agentStream.js";
import type { RiskLevel } from "../hitl/types.js";
import type { TeamPlanItem, TeamTask, TeamWorkspaceSnapshot } from "@heming/shared";
import {
  addWorkspaceMember,
  createTeamPlan,
  createTeamTask,
  createWorkspaceTeam,
  fetchWorkspaceTeam,
  fetchWorkspaceTeams,
  isApiAbort,
  isApiTimeout,
  updateTeamPlan,
  updateTeamTask,
  updateWorkspaceTeam,
  type ApiRequestOptions,
} from "../api.js";
import { fmtLocalDateTime } from "../format/datetime.js";
import type { CapabilityProvider } from "./types.js";

/**
 * 团队工作台（d.92）的智能体工具。
 *
 * 两层「团队」不要混：
 * - 本文件操作的是**用户自建的团队**（名字 / 目标 / 方案 / 任务 / 成员）；
 * - 团队页那个「全站一个团队」的名册与动向摘要是另一套（TeamRoster/TeamActivity），
 *   不在这里。
 *
 * 权限只在服务端判定（是否成员 / 是否 owner）；这里不做客户端越权判断，
 * 只做参数形状的友好校验，并把服务端的中文错误原样回给模型。
 *
 * 风险分级：读工具 `read`（不打断用户），写工具 `write`（走 HITL 确认）。
 * 写工具没有 `danger`：团队数据都是本机服务端的结构化记录，最坏结果是改名/改状态，
 * 删除类工具本轮不提供给智能体（避免误删团队/方案/任务）。
 */

export interface TeamToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  riskHint: RiskLevel;
}

const str = (description: string) => ({ type: "string" as const, description });
const STATUS_ENUM = {
  type: "string" as const,
  enum: ["todo", "doing", "done", "blocked"],
  description: "状态：todo=待办 / doing=进行中 / done=已完成 / blocked=受阻",
};

const SHARED_HEAD =
  "这是「用户自建的团队工作台」（用户自己建的团队：名字、目标、方案、任务、成员），" +
  "不是团队页那个「全站团队动向」。只操作用户自己的团队，不涉及全站名册与动向摘要。" +
  "若本轮工具列表里看不到 team_*，先调用 tool_search 搜「团队」再继续。" +
  "参数名两种写法都接受（team_id 或 teamId、plan_id 或 planId、task_id 或 taskId；" +
  "snake_case 与 camelCase 等价），但**不认识/拼错的参数会直接报错**，不会静默忽略——" +
  "报错时按提示里的可用参数名重试。";

/** 团队工具的单次请求超时：服务端 15 秒还没回就按超时处理，别让整轮对话挂死。 */
const TEAM_REQUEST_TIMEOUT_MS = 15_000;

/** 一次工具调用要传给 API 的请求控制：中断信号透传 + 统一超时。 */
function requestOf(signal: AbortSignal | undefined): ApiRequestOptions {
  return signal ? { signal, timeoutMs: TEAM_REQUEST_TIMEOUT_MS } : { timeoutMs: TEAM_REQUEST_TIMEOUT_MS };
}

export const TEAM_TOOLS: TeamToolSpec[] = [
  {
    name: "team_list",
    riskHint: "read",
    description:
      `${SHARED_HEAD}列出「我的团队」：每个团队的 team_id、名字、目标、成员数、任务数。` +
      "要操作某个团队但不知道 team_id 时，先调用它。",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "team_get",
    riskHint: "read",
    description:
      `${SHARED_HEAD}读取一个团队的完整快照：目标、方案（plans）、任务（tasks）、成员（members，` +
      "含 username 与 role，可用来核对 assigneeId）。可用 team_id 精确取，或用 name 精确匹配；" +
      "都不知道时先调用 team_list。",
    parameters: {
      type: "object",
      properties: {
        team_id: str("团队 id（从 team_list 或 team_create 的返回里获取）。"),
        name: str("团队名称（精确匹配；与 team_id 二选一）。"),
      },
      required: [],
    },
  },
  {
    name: "team_create",
    riskHint: "write",
    description:
      `${SHARED_HEAD}创建一个新团队，可同时写团队目标。创建后当前用户是 owner；` +
      "接着可用 team_member_add 拉人、team_plan_add 写方案、team_task_add 派任务。" +
      "这是写操作，执行前会请用户确认。",
    parameters: {
      type: "object",
      properties: {
        name: str("团队名称（必填，最多 40 字）。"),
        goal: str("团队目标（可选，最多 500 字）。"),
      },
      required: ["name"],
    },
  },
  {
    name: "team_update",
    riskHint: "write",
    description:
      `${SHARED_HEAD}修改团队名称或目标（至少给一项）。只有 owner 能改；` +
      "写操作，执行前会请用户确认。",
    parameters: {
      type: "object",
      properties: {
        team_id: str("团队 id（team_id 或 teamId 均可；不知道就先 team_list）。"),
        name: str("新的团队名称（可选，最多 40 字）。"),
        goal: str("新的团队目标（可选，最多 500 字；空串 = 清空目标）。"),
      },
      required: ["team_id"],
    },
  },
  {
    name: "team_member_add",
    riskHint: "write",
    description:
      `${SHARED_HEAD}把已有用户按 username 加入团队（不发邀请、也不公开注册）。只有 owner 能加；` +
      "写操作，执行前会请用户确认。",
    parameters: {
      type: "object",
      properties: {
        team_id: str("团队 id（team_id 或 teamId 均可；不知道就先 team_list）。"),
        username: str("要加入的用户的用户名（不是显示名，例如 zhangsan）。"),
      },
      required: ["team_id", "username"],
    },
  },
  {
    name: "team_plan_add",
    riskHint: "write",
    description:
      `${SHARED_HEAD}给团队新增一条方案项（团队的「怎么做」）。写操作，执行前会请用户确认。`,
    parameters: {
      type: "object",
      properties: {
        team_id: str("团队 id（team_id 或 teamId 均可；不知道就先 team_list）。"),
        title: str("方案标题（必填，最多 120 字）。"),
        detail: str("方案说明（可选，最多 2000 字）。"),
        orderIndex: {
          type: "number",
          description: "排序值（可选，0–9999，小的在前）。",
        },
      },
      required: ["team_id", "title"],
    },
  },
  {
    name: "team_plan_update",
    riskHint: "write",
    description:
      `${SHARED_HEAD}更新一条方案项：标题 / 说明 / 状态 / 排序（至少给一项）。` +
      "写操作，执行前会请用户确认。",
    parameters: {
      type: "object",
      properties: {
        team_id: str("团队 id（team_id 或 teamId 均可）。"),
        plan_id: str("方案 id（plan_id 或 planId 均可；从 team_get 的 plans 里获取）。"),
        title: str("新标题（可选）。"),
        detail: str("新说明（可选）。"),
        status: STATUS_ENUM,
        orderIndex: {
          type: "number",
          description: "新的排序值（可选，0–9999）。",
        },
      },
      required: ["team_id", "plan_id"],
    },
  },
  {
    name: "team_task_add",
    riskHint: "write",
    description:
      `${SHARED_HEAD}给团队派一条任务：可挂到方案下（planId）、指派给成员` +
      "（assigneeId 必须是团队成员，可先用 team_get 查 members）、设置截止时间（dueAt，ISO 时间）。" +
      "写操作，执行前会请用户确认。",
    parameters: {
      type: "object",
      properties: {
        team_id: str("团队 id（team_id 或 teamId 均可；不知道就先 team_list）。"),
        title: str("任务标题（必填，最多 120 字）。"),
        detail: str("任务说明（可选，最多 2000 字）。"),
        assigneeId: str(
          "指给谁做：团队成员的 userId（assigneeId 或 assignee_id 均可；必须是成员；不传 = 待认领）。",
        ),
        planId: str("归属哪条方案（planId 或 plan_id 均可；不传 = 独立任务）。"),
        dueAt: str(
          "截止时间（dueAt 或 due_at 均可；ISO/UTC，例如 2026-11-10T18:00:00.000Z；不传 = 没定）。",
        ),
        attachmentFileId: str(
          "交付物文件 id（attachmentFileId 或 attachment_file_id 均可；来自共享文件库，可选）。",
        ),
      },
      required: ["team_id", "title"],
    },
  },
  {
    name: "team_task_update",
    riskHint: "write",
    description:
      `${SHARED_HEAD}更新一条任务：状态 / 负责人 / 标题 / 说明 / 截止时间 / 交付物文件 id` +
      "（attachmentFileId，来自共享文件库）。负责人必须是团队成员。" +
      "写操作，执行前会请用户确认。",
    parameters: {
      type: "object",
      properties: {
        team_id: str("团队 id（team_id 或 teamId 均可）。"),
        task_id: str("任务 id（task_id 或 taskId 均可；从 team_get 的 tasks 里获取）。"),
        title: str("新标题（可选）。"),
        detail: str("新说明（可选）。"),
        status: STATUS_ENUM,
        assigneeId: str(
          "新的负责人 userId（assigneeId 或 assignee_id 均可；必须是团队成员；空串 = 改为待认领）。",
        ),
        planId: str("改挂到哪条方案（planId 或 plan_id 均可；空串 = 独立任务）。"),
        dueAt: str("新的截止时间（dueAt 或 due_at 均可；ISO；空串 = 没定）。"),
        attachmentFileId: str(
          "交付物文件 id（attachmentFileId 或 attachment_file_id 均可；空串 = 清除交付物）。",
        ),
      },
      required: ["team_id", "task_id"],
    },
  },
];

/* ------------------------------------------------------------------ 参数与格式化 */

/** snake_case ↔ camelCase：schema 里 id 用 snake、业务字段用 camel，两种写法都要认。 */
function toSnake(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}
function toCamel(key: string): string {
  return key.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
}

/** 解析模型给的 JSON 参数：解析不了要报错，不能默默当成 {}（否则模型以为传了、其实没传）。 */
function parseArgs(raw: string): { args: Record<string, unknown> } | { error: string } {
  const text = (raw ?? "").trim();
  if (!text) return { args: {} };
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) {
      return { error: `参数必须是 JSON 对象（收到 ${typeof v}），例如 {"team_id":"t1"}。` };
    }
    return { args: v as Record<string, unknown> };
  } catch {
    return { error: `参数不是合法 JSON，无法执行：${text.slice(0, 120)}` };
  }
}

/** 工具可用参数的说明文案（报错时教模型怎么改）。 */
function allowedParamsText(spec: Pick<TeamToolSpec, "parameters">): string {
  const declared = Object.keys(
    (spec.parameters as { properties?: Record<string, unknown> }).properties ?? {},
  );
  return declared
    .map((key) => {
      const canonical = toCamel(key);
      return canonical === key ? key : `${key}（或 ${canonical}）`;
    })
    .join(" / ");
}

/**
 * 参数归一化（B3）：把 snake_case / camelCase 别名统一成内部 camelCase 规范键，
 * 并且**显式拒绝不认识的键**。
 *
 * 为什么必须拒绝：服务端 zod 对未知键是静默 strip 的，工具以前也跟着静默忽略——
 * 模型把 plan_id 传给 team_task_add 时，任务照建却不挂方案，还回「已创建」，
 * 用户看到的是「说做了其实没做」。宁可报错让模型改名重试。
 */
export function normalizeTeamArgs(
  spec: Pick<TeamToolSpec, "name" | "parameters">,
  raw: Record<string, unknown>,
): { args: Record<string, unknown> } | { error: string } {
  const declared = Object.keys(
    (spec.parameters as { properties?: Record<string, unknown> }).properties ?? {},
  );
  const canonicalOf = new Map<string, string>();
  for (const key of declared) {
    const canonical = toCamel(key);
    canonicalOf.set(key, canonical);
    canonicalOf.set(toSnake(key), canonical);
    canonicalOf.set(toCamel(key), canonical);
  }
  const keys = Object.keys(raw);
  if (declared.length === 0) {
    if (keys.length === 0) return { args: {} };
    return { error: `${spec.name} 不接受任何参数（收到：${keys.join("、")}）。` };
  }
  const allowed = allowedParamsText(spec);
  const out: Record<string, unknown> = {};
  const unknown: string[] = [];
  for (const [key, value] of Object.entries(raw)) {
    const canonical = canonicalOf.get(key);
    if (!canonical) {
      unknown.push(key);
      continue;
    }
    if (canonical in out) {
      return {
        error: `参数重复：「${key}」和另一种写法指向同一项（${canonical}），只给一个即可。`,
      };
    }
    out[canonical] = value;
  }
  if (unknown.length > 0) {
    return {
      error:
        `不认识的参数：${unknown.join("、")}。${spec.name} 可用参数：${allowed}` +
        "（snake_case / camelCase 等价）。",
    };
  }
  return { args: out };
}

/**
 * 把截止时间规范成 ISO 串；非法返回 `null`。空串表示「不设/清空」，原样返回 `""`。
 *
 * 接受：ISO 串、`YYYY-MM-DD`、10 位秒级时间戳、13 位毫秒时间戳（数字或数字串）。
 * 量级判断：`< 1e12` 视为秒，否则视为毫秒——覆盖 2001–2286 年，够用且不会把
 * 毫秒值再乘 1000 变成 5 万年后的日期。
 */
function normalizeDueAt(value: unknown): string | null {
  const toMs = (n: number): number => (n < 1e12 ? n * 1000 : n);
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return "";
    if (text.length > 64) return null;
    const numeric = /^\d{10,13}$/.test(text);
    const ms = numeric ? toMs(Number(text)) : Date.parse(text);
    if (!Number.isFinite(ms) || ms <= 0) return null;
    return new Date(ms).toISOString();
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    return new Date(toMs(value)).toISOString();
  }
  return null;
}

/**
 * 参数类型校验与宽转（T2-04）。
 *
 * 为什么需要：`normalizeTeamArgs` 只统一键名、不管值类型，而 `argOptStr` / `argOptNum`
 * 遇到类型不符的值会静默返回 `undefined`——模型传 `dueAt: 1762776000000` 或
 * `orderIndex: "3"` 时字段凭空消失，任务照建、还回「已创建」。
 *
 * 规则（宁可报错让模型重试，也不猜）：
 * - string 字段收到 number / boolean → 报错（不做 `String()` 强转，避免 `123` 混进标题）；
 * - number 字段收到纯数字串 → 转数字；其它 → 报错；
 * - `dueAt` 额外接受 epoch 数字（秒/毫秒）→ 规范成 ISO；空串保留（= 清空）。
 *
 * 校验失败时调用方**不得发起任何请求**。
 */
export function validateTeamArgTypes(
  spec: Pick<TeamToolSpec, "name" | "parameters">,
  args: Record<string, unknown>,
): { args: Record<string, unknown> } | { error: string } {
  const props =
    (spec.parameters as { properties?: Record<string, { type?: string }> }).properties ?? {};
  // spec 里声明的键是 snake_case（team_id / order_index），而 args 已被 normalizeTeamArgs
  // 归一成 camelCase——先把声明键也归一再比对，否则永远查不到 type，校验会被整体跳过。
  const typeOf = new Map<string, string | undefined>();
  for (const [key, prop] of Object.entries(props)) typeOf.set(toCamel(key), prop?.type);
  const out: Record<string, unknown> = { ...args };
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue;
    if (key === "dueAt") {
      const due = normalizeDueAt(value);
      if (due === null) {
        return {
          error:
            "截止时间格式不对：dueAt 要 ISO 时间（例如 2026-11-10T18:00:00.000Z）" +
            `或毫秒时间戳，收到 ${JSON.stringify(value)}。空串表示不设截止时间。`,
        };
      }
      out[key] = due;
      continue;
    }
    const type = typeOf.get(key);
    if (type === "string" && typeof value !== "string") {
      return {
        error:
          `参数类型不对：${key} 需要字符串（收到 ${typeof value}）。` +
          `${spec.name} 可用参数：${allowedParamsText(spec)}。`,
      };
    }
    if (type === "number") {
      if (typeof value === "number" && Number.isFinite(value)) continue;
      const text = typeof value === "string" ? value.trim() : "";
      if (/^-?\d+$/.test(text)) {
        out[key] = Number(text);
        continue;
      }
      return {
        error:
          `参数类型不对：${key} 需要数字（收到 ${typeof value}）。` +
          `${spec.name} 可用参数：${allowedParamsText(spec)}。`,
      };
    }
  }
  return { args: out };
}

/** 取字符串参数（trim 后）；非字符串/空串 → ""。 */
function argStr(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === "string" ? v.trim() : "";
}

/** 取可选字符串：undefined 与空串区分不开时按空串处理（调用方决定是否清空）。 */
function argOptStr(args: Record<string, unknown>, key: string): string | undefined {
  return typeof args[key] === "string" ? String(args[key]).trim() : undefined;
}

function argOptNum(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  return Math.trunc(v);
}

const STATUS_LABEL: Record<string, string> = {
  todo: "待办",
  doing: "进行中",
  done: "已完成",
  blocked: "受阻",
};
const STATUS_SET = new Set(Object.keys(STATUS_LABEL));

/** 成员角色：owner 叫「队长」，避免和任务的「负责人」撞词。 */
const ROLE_LABEL: Record<string, string> = { owner: "队长", member: "成员" };

/** 把快照压成模型可读的文本：带 id（后续工具要用）、按方案/任务/成员分组。 */
/**
 * 快照里单条「说明」最多显示多少字。
 *
 * schema 允许每条 detail 2000 字；几十条任务就足以撞上 `truncateToolResult` 的
 * 8000 字符上限（中间被整段省略），模型会以为「没有这条任务」。所以列表视图只给摘要，
 * 完整说明留给用户到团队页看。
 */
const SNAPSHOT_DETAIL_MAX = 200;
/** 快照最多列多少条任务：超出部分用明确提示代替（而不是让截断悄悄发生）。 */
const SNAPSHOT_TASK_MAX = 20;

/** 单行说明截断：压成一行、超长加省略号，模型仍知道「还有内容没显示」。 */
function clipDetail(text: string): string {
  const flat = text.trim().replace(/\s*\r?\n\s*/g, " ");
  return flat.length > SNAPSHOT_DETAIL_MAX ? `${flat.slice(0, SNAPSHOT_DETAIL_MAX)}…` : flat;
}

export function formatTeamSnapshot(s: TeamWorkspaceSnapshot): string {
  const { team, members, plans, tasks } = s;
  const nameOf = (userId: string | null): string => {
    if (!userId) return "待认领";
    const m = members.find((x) => x.user.id === userId);
    return m ? `${m.user.displayName}（${m.user.username}）` : userId;
  };
  const lines: string[] = [];
  lines.push(`团队：${team.name}（teamId：${team.id}）`);
  if (team.goal.trim()) lines.push(`目标：${team.goal.trim()}`);
  else lines.push("目标：（还没写）");
  lines.push("");
  lines.push(`成员（${members.length}）：`);
  if (members.length === 0) lines.push("- （空）");
  members.forEach((m, i) => {
    lines.push(
      `- ${i + 1}. ${m.user.displayName}（@${m.user.username}，userId：${m.user.id}）· ` +
        `${ROLE_LABEL[m.role] ?? m.role}`,
    );
  });
  lines.push("");
  lines.push(`方案（${plans.length}）：`);
  if (plans.length === 0) lines.push("- （还没有方案）");
  plans.forEach((p, i) => {
    lines.push(`- ${i + 1}. [planId：${p.id}] ${p.title} · ${STATUS_LABEL[p.status] ?? p.status}`);
    if (p.detail.trim()) lines.push(`  说明：${clipDetail(p.detail)}`);
  });
  lines.push("");
  lines.push(`任务（${tasks.length}）：`);
  if (tasks.length === 0) lines.push("- （还没有任务）");
  // T2-05：只列前 N 条，超出部分明确提示（整个快照还要受 bridge 的 8000 字符上限约束）。
  tasks.slice(0, SNAPSHOT_TASK_MAX).forEach((t, i) => {
    const bits = [`[taskId：${t.id}] ${t.title} · ${STATUS_LABEL[t.status] ?? t.status}`];
    bits.push(`负责人：${nameOf(t.assigneeId)}`);
    if (t.planId) bits.push(`方案：${t.planId}`);
    // 截止时间给本地可读格式（快照以前直接打 UTC ISO，用户和模型都要自己换算时区）。
    if (t.dueAt) bits.push(`截止：${fmtLocalDateTime(t.dueAt) || t.dueAt}`);
    if (t.attachmentFileId) bits.push(`交付物：${t.attachmentFileId}`);
    lines.push(`- ${i + 1}. ${bits.join(" · ")}`);
    if (t.detail.trim()) lines.push(`  说明：${clipDetail(t.detail)}`);
  });
  if (tasks.length > SNAPSHOT_TASK_MAX) {
    lines.push(
      `- （另有 ${tasks.length - SNAPSHOT_TASK_MAX} 条任务未显示：全列出来会被工具结果长度上限截断。` +
        "要看具体某条请到团队页的任务看板，或先按方案缩小范围再问。）",
    );
  }
  lines.push("");
  lines.push("（上面 teamId / planId / taskId 可直接当参数回传：写 teamId 或 team_id 都可以。）");
  return lines.join("\n");
}

function formatPlan(plan: TeamPlanItem): string {
  return `已新增方案项「${plan.title}」（planId：${plan.id}，状态：${
    STATUS_LABEL[plan.status] ?? plan.status
  }）。`;
}

function formatTask(task: TeamTask, members: TeamWorkspaceSnapshot["members"]): string {
  const assignee = task.assigneeId
    ? (members.find((m) => m.user.id === task.assigneeId)?.user.displayName ?? task.assigneeId)
    : "待认领";
  return (
    `已创建任务「${task.title}」（taskId：${task.id}，状态：${
      STATUS_LABEL[task.status] ?? task.status
    }，负责人：${assignee}）。`
  );
}

/** 失败统一文案：服务端中文错误原样透出，不吞成 "http 500"。 */
function failText(prefix: string, e: unknown): string {
  const msg = e instanceof Error && e.message ? e.message : String(e);
  return `${prefix}：${msg}`;
}

/**
 * 中断/超时不能按「团队操作失败」报：用户主动点中断是正常操作，
 * 超时则要让模型知道可以重试（而不是以为服务端拒绝了）。
 */
function interruptText(e: unknown): string | null {
  if (isApiAbort(e)) {
    return "用户已中断，团队操作已取消；若刚提交的内容可能已在服务端生效，可再用 team_get 核对。";
  }
  if (isApiTimeout(e)) return failText("团队操作超时", e);
  return null;
}

/** 写操作的统一收口：成功返回文本，失败把中文错误交给模型。 */
async function write(op: () => Promise<string>): Promise<{ text: string; ok: boolean }> {
  try {
    return { text: await op(), ok: true };
  } catch (e) {
    const interrupted = interruptText(e);
    if (interrupted) return { text: interrupted, ok: false };
    return { text: failText("团队操作失败", e), ok: false };
  }
}

/** 按 teamId 或 name 解析团队；两者都没给/找不到时给出下一步指引。 */
async function resolveTeamId(
  args: Record<string, unknown>,
  request: ApiRequestOptions,
): Promise<{ id: string } | { error: string }> {
  const id = argStr(args, "teamId");
  if (id) return { id };
  const name = argStr(args, "name");
  if (!name) {
    return {
      error:
        "请提供 team_id（或 teamId）；不知道 id 就先调用 team_list（也可以用 name 精确匹配）。",
    };
  }
  try {
    const list = await fetchWorkspaceTeams(request);
    const exact = list.teams.filter((t) => t.name === name);
    const hit = exact.length ? exact : list.teams.filter((t) => t.name.toLowerCase() === name.toLowerCase());
    if (hit.length === 1) return { id: hit[0].id };
    if (hit.length > 1) {
      return {
        error: `有 ${hit.length} 个团队都叫「${name}」，请改用 teamId：${hit
          .map((t) => t.id)
          .join("、")}`,
      };
    }
    return { error: `没有找到名为「${name}」的团队；可先调用 team_list 查看全部团队。` };
  } catch (e) {
    const interrupted = interruptText(e);
    if (interrupted) return { error: interrupted };
    return { error: failText("读取团队列表失败", e) };
  }
}

/* ------------------------------------------------------------------ 工具桥 */

/** 把团队工具桥起来：tools 声明 + meta 风险 + execute 分发。 */
export function buildTeamToolBridge(): ToolBridge {
  return {
    tools: TEAM_TOOLS.map((spec) => ({
      type: "function" as const,
      function: {
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters,
      },
    })),
    meta: (name) => {
      const spec = TEAM_TOOLS.find((s) => s.name === name);
      return spec ? { risk: spec.riskHint } : undefined;
    },
    execute: async (call, opts) => {
      if (opts?.signal?.aborted) return { text: "用户已中断，团队操作未执行。", ok: false };
      const spec = TEAM_TOOLS.find((s) => s.name === call.name);
      if (!spec) return { text: `未知工具 ${call.name}`, ok: false };
      const parsed = parseArgs(call.arguments);
      if ("error" in parsed) return { text: parsed.error, ok: false };
      const normalized = normalizeTeamArgs(spec, parsed.args);
      if ("error" in normalized) return { text: normalized.error, ok: false };
      // T2-04：类型不符要报错（并在此处拒绝，绝不带着「消失的字段」去建记录）。
      const typed = validateTeamArgTypes(spec, normalized.args);
      if ("error" in typed) return { text: typed.error, ok: false };
      const args = typed.args;
      // B4：中断信号一路透传到 fetch（用户点中断后，在途请求真的收手），并给每次请求兜 15s 超时。
      const request = requestOf(opts?.signal);
      try {
        switch (call.name) {
          case "team_list": {
            const list = await fetchWorkspaceTeams(request);
            if (list.teams.length === 0) {
              return {
                text: "你还没有任何团队工作台。需要的话先调用 team_create 建一个（写操作，会请用户确认）。",
                ok: true,
              };
            }
            // 列表接口只包含团队本体；成员数/任务数按快照补（失败则标「未知」，不阻断列表）。
            const snaps = await Promise.all(
              list.teams.map((t) => fetchWorkspaceTeam(t.id, request).catch(() => null)),
            );
            const lines = [`我的团队（${list.teams.length}）：`];
            list.teams.forEach((t, i) => {
              const snap = snaps[i];
              const counts = snap
                ? `成员 ${snap.members.length} 人 · 任务 ${snap.tasks.length} 个`
                : "成员/任务数未知";
              lines.push(
                `- ${i + 1}. ${t.name}（teamId：${t.id}）· ${counts} · 目标：${
                  t.goal.trim() || "（未填写）"
                }`,
              );
            });
            lines.push("要细节用 team_get（传 team_id），要派活先看 team_get 的 members/plans。");
            return { text: lines.join("\n"), ok: true };
          }
          case "team_get": {
            const resolved = await resolveTeamId(args, request);
            if ("error" in resolved) return { text: resolved.error, ok: false };
            const snap = await fetchWorkspaceTeam(resolved.id, request);
            const sources: ToolSource[] = [{ id: snap.team.id, title: `团队：${snap.team.name}` }];
            return { text: formatTeamSnapshot(snap), ok: true, sources };
          }
          case "team_create": {
            const name = argStr(args, "name");
            if (!name) return { text: "name 不能为空：请给团队起个名字（最多 40 字）。", ok: false };
            const goal = argOptStr(args, "goal");
            return write(async () => {
              const snap = await createWorkspaceTeam({ name, ...(goal ? { goal } : {}) }, request);
              return `已创建团队「${snap.team.name}」（teamId：${snap.team.id}），目标：${
                snap.team.goal.trim() || "（还没写）"
              }。下一步：team_plan_add 写方案、team_task_add 派任务、team_member_add 拉人（都会请用户确认）。`;
            });
          }
          case "team_update": {
            const teamId = argStr(args, "teamId");
            if (!teamId) return { text: "team_id 不能为空；不知道就先调用 team_list。", ok: false };
            const name = argOptStr(args, "name");
            const goal = argOptStr(args, "goal");
            if (name === undefined && goal === undefined) {
              return { text: "没有要修改的字段：至少提供 name 或 goal 之一。", ok: false };
            }
            return write(async () => {
              const snap = await updateWorkspaceTeam(
                teamId,
                {
                  ...(name !== undefined ? { name } : {}),
                  ...(goal !== undefined ? { goal } : {}),
                },
                request,
              );
              return `已更新团队「${snap.team.name}」：目标=${
                snap.team.goal.trim() || "（未填写）"
              }。`;
            });
          }
          case "team_member_add": {
            const teamId = argStr(args, "teamId");
            const username = argStr(args, "username");
            if (!teamId) return { text: "team_id 不能为空；不知道就先调用 team_list。", ok: false };
            if (!username) return { text: "username 不能为空（用用户名，不是显示名）。", ok: false };
            return write(async () => {
              const snap = await addWorkspaceMember(teamId, username, request);
              const names = snap.members.map((m) => `${m.user.displayName}（@${m.user.username}）`);
              return `已把 @${username} 加入团队「${snap.team.name}」。当前成员 ${snap.members.length} 人：${names.join("、")}。`;
            });
          }
          case "team_plan_add": {
            const teamId = argStr(args, "teamId");
            const title = argStr(args, "title");
            if (!teamId) return { text: "team_id 不能为空；不知道就先调用 team_list。", ok: false };
            if (!title) return { text: "title 不能为空：请给方案起个标题（最多 120 字）。", ok: false };
            const detail = argOptStr(args, "detail");
            const orderIndex = argOptNum(args, "orderIndex");
            return write(async () => {
              const plan = await createTeamPlan(
                teamId,
                {
                  title,
                  ...(detail ? { detail } : {}),
                  ...(orderIndex !== undefined ? { orderIndex } : {}),
                },
                request,
              );
              return formatPlan(plan);
            });
          }
          case "team_plan_update": {
            const teamId = argStr(args, "teamId");
            const planId = argStr(args, "planId");
            if (!teamId) return { text: "team_id 不能为空；不知道就先调用 team_list。", ok: false };
            if (!planId) return { text: "plan_id 不能为空：先从 team_get 的 plans 里拿。", ok: false };
            const title = argOptStr(args, "title");
            const detail = argOptStr(args, "detail");
            const status = argStr(args, "status");
            const orderIndex = argOptNum(args, "orderIndex");
            if (status && !STATUS_SET.has(status)) {
              return {
                text: `status 不合法：只能是 ${[...STATUS_SET].join(" / ")}（收到「${status}」）。`,
                ok: false,
              };
            }
            if (
              title === undefined &&
              detail === undefined &&
              !status &&
              orderIndex === undefined
            ) {
              return {
                text: "没有要修改的字段：至少提供 title / detail / status / orderIndex 之一。",
                ok: false,
              };
            }
            return write(async () => {
              const plan = await updateTeamPlan(
                teamId,
                planId,
                {
                  ...(title !== undefined ? { title } : {}),
                  ...(detail !== undefined ? { detail } : {}),
                  ...(status ? { status: status as "todo" | "doing" | "done" | "blocked" } : {}),
                  ...(orderIndex !== undefined ? { orderIndex } : {}),
                },
                request,
              );
              return `已更新方案项「${plan.title}」（planId：${plan.id}，状态：${
                STATUS_LABEL[plan.status] ?? plan.status
              }）。`;
            });
          }
          case "team_task_add": {
            const teamId = argStr(args, "teamId");
            const title = argStr(args, "title");
            if (!teamId) return { text: "team_id 不能为空；不知道就先调用 team_list。", ok: false };
            if (!title) return { text: "title 不能为空：请写清要做什么（最多 120 字）。", ok: false };
            const detail = argOptStr(args, "detail");
            const assigneeId = argOptStr(args, "assigneeId");
            const planId = argOptStr(args, "planId");
            const dueAt = argOptStr(args, "dueAt");
            const attachmentFileId = argOptStr(args, "attachmentFileId");
            return write(async () => {
              const task = await createTeamTask(
                teamId,
                {
                  title,
                  ...(detail ? { detail } : {}),
                  ...(assigneeId ? { assigneeId } : {}),
                  ...(planId ? { planId } : {}),
                  ...(dueAt ? { dueAt } : {}),
                  ...(attachmentFileId ? { attachmentFileId } : {}),
                },
                request,
              );
              // 指派了人时顺带确认它确实是成员，便于模型下一步引用。
              if (!task.assigneeId) return formatTask(task, []);
              const snap = await fetchWorkspaceTeam(teamId, request).catch(() => null);
              return formatTask(task, snap?.members ?? []);
            });
          }
          case "team_task_update": {
            const teamId = argStr(args, "teamId");
            const taskId = argStr(args, "taskId");
            if (!teamId) return { text: "team_id 不能为空；不知道就先调用 team_list。", ok: false };
            if (!taskId) return { text: "task_id 不能为空：先从 team_get 的 tasks 里拿。", ok: false };
            const title = argOptStr(args, "title");
            const detail = argOptStr(args, "detail");
            const status = argStr(args, "status");
            const assigneeId = argOptStr(args, "assigneeId");
            const planId = argOptStr(args, "planId");
            const dueAt = argOptStr(args, "dueAt");
            const attachmentFileId = argOptStr(args, "attachmentFileId");
            if (status && !STATUS_SET.has(status)) {
              return {
                text: `status 不合法：只能是 ${[...STATUS_SET].join(" / ")}（收到「${status}」）。`,
                ok: false,
              };
            }
            const changed =
              title !== undefined ||
              detail !== undefined ||
              !!status ||
              assigneeId !== undefined ||
              planId !== undefined ||
              dueAt !== undefined ||
              attachmentFileId !== undefined;
            if (!changed) {
              return {
                text: "没有要修改的字段：至少提供 status / assigneeId / title / detail / dueAt / planId / attachmentFileId 之一。",
                ok: false,
              };
            }
            return write(async () => {
              const task = await updateTeamTask(
                teamId,
                taskId,
                {
                  ...(title !== undefined ? { title } : {}),
                  ...(detail !== undefined ? { detail } : {}),
                  ...(status ? { status: status as "todo" | "doing" | "done" | "blocked" } : {}),
                  ...(assigneeId !== undefined ? { assigneeId: assigneeId || null } : {}),
                  ...(planId !== undefined ? { planId: planId || null } : {}),
                  ...(dueAt !== undefined ? { dueAt: dueAt || null } : {}),
                  ...(attachmentFileId !== undefined
                    ? { attachmentFileId: attachmentFileId || null }
                    : {}),
                },
                request,
              );
              return `已更新任务「${task.title}」（taskId：${task.id}，状态：${
                STATUS_LABEL[task.status] ?? task.status
              }）。`;
            });
          }
          default:
            return { text: `未知工具 ${call.name}`, ok: false };
        }
      } catch (e) {
        // 永不抛：读工具失败也让模型知道原因（可改用 team_list 等继续），不中断整轮。
        const interrupted = interruptText(e);
        if (interrupted) return { text: interrupted, ok: false };
        return { text: failText("团队工具执行失败", e), ok: false };
      }
    },
  };
}

/**
 * 能力提供者：团队工具始终可用（服务端按 token 判权限；不依赖桌面桥/模块开关）。
 * 与其它提供者一致：返回的桥由注册表统一补 origin/providerId。
 */
export const teamProvider: CapabilityProvider = {
  id: "team",
  origin: "builtin",
  build: () => buildTeamToolBridge(),
};
