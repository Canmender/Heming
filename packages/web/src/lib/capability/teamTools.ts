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
  updateTeamPlan,
  updateTeamTask,
  updateWorkspaceTeam,
} from "../api.js";
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
  "若本轮工具列表里看不到 team_*，先调用 tool_search 搜「团队」再继续。";

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
        team_id: str("团队 id（不知道就先 team_list）。"),
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
        team_id: str("团队 id（不知道就先 team_list）。"),
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
        team_id: str("团队 id（不知道就先 team_list）。"),
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
        team_id: str("团队 id。"),
        plan_id: str("方案 id（从 team_get 的 plans 里获取）。"),
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
        team_id: str("团队 id（不知道就先 team_list）。"),
        title: str("任务标题（必填，最多 120 字）。"),
        detail: str("任务说明（可选，最多 2000 字）。"),
        assigneeId: str("指给谁做：团队成员的 userId（必须是成员；不传 = 待认领）。"),
        planId: str("归属哪条方案（不传 = 独立任务）。"),
        dueAt: str("截止时间（ISO，例如 2026-11-10T18:00:00.000Z；不传 = 没定）。"),
        attachmentFileId: str("交付物文件 id（来自共享文件库，可选）。"),
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
        team_id: str("团队 id。"),
        task_id: str("任务 id（从 team_get 的 tasks 里获取）。"),
        title: str("新标题（可选）。"),
        detail: str("新说明（可选）。"),
        status: STATUS_ENUM,
        assigneeId: str("新的负责人 userId（必须是团队成员；空串 = 改为待认领）。"),
        planId: str("改挂到哪条方案（空串 = 独立任务）。"),
        dueAt: str("新的截止时间（ISO；空串 = 没定）。"),
        attachmentFileId: str("交付物文件 id（共享文件库；空串 = 清除交付物）。"),
      },
      required: ["team_id", "task_id"],
    },
  },
];

/* ------------------------------------------------------------------ 参数与格式化 */

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
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
export function formatTeamSnapshot(s: TeamWorkspaceSnapshot): string {
  const { team, members, plans, tasks } = s;
  const nameOf = (userId: string | null): string => {
    if (!userId) return "待认领";
    const m = members.find((x) => x.user.id === userId);
    return m ? `${m.user.displayName}（${m.user.username}）` : userId;
  };
  const lines: string[] = [];
  lines.push(`团队：${team.name}（team_id：${team.id}）`);
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
    lines.push(`- ${i + 1}. [plan_id：${p.id}] ${p.title} · ${STATUS_LABEL[p.status] ?? p.status}`);
    if (p.detail.trim()) lines.push(`  说明：${p.detail.trim()}`);
  });
  lines.push("");
  lines.push(`任务（${tasks.length}）：`);
  if (tasks.length === 0) lines.push("- （还没有任务）");
  tasks.forEach((t, i) => {
    const bits = [`[task_id：${t.id}] ${t.title} · ${STATUS_LABEL[t.status] ?? t.status}`];
    bits.push(`负责人：${nameOf(t.assigneeId)}`);
    if (t.planId) bits.push(`方案：${t.planId}`);
    if (t.dueAt) bits.push(`截止：${t.dueAt}`);
    if (t.attachmentFileId) bits.push(`交付物：${t.attachmentFileId}`);
    lines.push(`- ${i + 1}. ${bits.join(" · ")}`);
    if (t.detail.trim()) lines.push(`  说明：${t.detail.trim()}`);
  });
  return lines.join("\n");
}

function formatPlan(plan: TeamPlanItem): string {
  return `已新增方案项「${plan.title}」（plan_id：${plan.id}，状态：${
    STATUS_LABEL[plan.status] ?? plan.status
  }）。`;
}

function formatTask(task: TeamTask, members: TeamWorkspaceSnapshot["members"]): string {
  const assignee = task.assigneeId
    ? (members.find((m) => m.user.id === task.assigneeId)?.user.displayName ?? task.assigneeId)
    : "待认领";
  return (
    `已创建任务「${task.title}」（task_id：${task.id}，状态：${
      STATUS_LABEL[task.status] ?? task.status
    }，负责人：${assignee}）。`
  );
}

/** 失败统一文案：服务端中文错误原样透出，不吞成 "http 500"。 */
function failText(prefix: string, e: unknown): string {
  const msg = e instanceof Error && e.message ? e.message : String(e);
  return `${prefix}：${msg}`;
}

/** 写操作的统一收口：成功返回文本，失败把中文错误交给模型。 */
async function write(op: () => Promise<string>): Promise<{ text: string; ok: boolean }> {
  try {
    return { text: await op(), ok: true };
  } catch (e) {
    return { text: failText("团队操作失败", e), ok: false };
  }
}

/** 按 team_id 或 name 解析团队；两者都没给/找不到时给出下一步指引。 */
async function resolveTeamId(
  args: Record<string, unknown>,
): Promise<{ id: string } | { error: string }> {
  const id = argStr(args, "team_id");
  if (id) return { id };
  const name = argStr(args, "name");
  if (!name) {
    return { error: "请提供 team_id；不知道 id 就先调用 team_list（也可以用 name 精确匹配）。" };
  }
  try {
    const list = await fetchWorkspaceTeams();
    const exact = list.teams.filter((t) => t.name === name);
    const hit = exact.length ? exact : list.teams.filter((t) => t.name.toLowerCase() === name.toLowerCase());
    if (hit.length === 1) return { id: hit[0].id };
    if (hit.length > 1) {
      return {
        error: `有 ${hit.length} 个团队都叫「${name}」，请改用 team_id：${hit
          .map((t) => t.id)
          .join("、")}`,
      };
    }
    return { error: `没有找到名为「${name}」的团队；可先调用 team_list 查看全部团队。` };
  } catch (e) {
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
      const args = parseArgs(call.arguments);
      if (opts?.signal?.aborted) return { text: "用户已中断，团队操作未执行。", ok: false };
      try {
        switch (call.name) {
          case "team_list": {
            const list = await fetchWorkspaceTeams();
            if (list.teams.length === 0) {
              return {
                text: "你还没有任何团队工作台。需要的话先调用 team_create 建一个（写操作，会请用户确认）。",
                ok: true,
              };
            }
            // 列表接口只包含团队本体；成员数/任务数按快照补（失败则标「未知」，不阻断列表）。
            const snaps = await Promise.all(
              list.teams.map((t) => fetchWorkspaceTeam(t.id).catch(() => null)),
            );
            const lines = [`我的团队（${list.teams.length}）：`];
            list.teams.forEach((t, i) => {
              const snap = snaps[i];
              const counts = snap
                ? `成员 ${snap.members.length} 人 · 任务 ${snap.tasks.length} 个`
                : "成员/任务数未知";
              lines.push(
                `- ${i + 1}. ${t.name}（team_id：${t.id}）· ${counts} · 目标：${
                  t.goal.trim() || "（未填写）"
                }`,
              );
            });
            lines.push("要细节用 team_get（传 team_id），要派活先看 team_get 的 members/plans。");
            return { text: lines.join("\n"), ok: true };
          }
          case "team_get": {
            const resolved = await resolveTeamId(args);
            if ("error" in resolved) return { text: resolved.error, ok: false };
            const snap = await fetchWorkspaceTeam(resolved.id);
            const sources: ToolSource[] = [{ id: snap.team.id, title: `团队：${snap.team.name}` }];
            return { text: formatTeamSnapshot(snap), ok: true, sources };
          }
          case "team_create": {
            const name = argStr(args, "name");
            if (!name) return { text: "name 不能为空：请给团队起个名字（最多 40 字）。", ok: false };
            const goal = argOptStr(args, "goal");
            return write(async () => {
              const snap = await createWorkspaceTeam({ name, ...(goal ? { goal } : {}) });
              return `已创建团队「${snap.team.name}」（team_id：${snap.team.id}），目标：${
                snap.team.goal.trim() || "（还没写）"
              }。下一步：team_plan_add 写方案、team_task_add 派任务、team_member_add 拉人（都会请用户确认）。`;
            });
          }
          case "team_update": {
            const teamId = argStr(args, "team_id");
            if (!teamId) return { text: "team_id 不能为空；不知道就先调用 team_list。", ok: false };
            const name = argOptStr(args, "name");
            const goal = argOptStr(args, "goal");
            if (name === undefined && goal === undefined) {
              return { text: "没有要修改的字段：至少提供 name 或 goal 之一。", ok: false };
            }
            return write(async () => {
              const snap = await updateWorkspaceTeam(teamId, {
                ...(name !== undefined ? { name } : {}),
                ...(goal !== undefined ? { goal } : {}),
              });
              return `已更新团队「${snap.team.name}」：目标=${
                snap.team.goal.trim() || "（未填写）"
              }。`;
            });
          }
          case "team_member_add": {
            const teamId = argStr(args, "team_id");
            const username = argStr(args, "username");
            if (!teamId) return { text: "team_id 不能为空；不知道就先调用 team_list。", ok: false };
            if (!username) return { text: "username 不能为空（用用户名，不是显示名）。", ok: false };
            return write(async () => {
              const snap = await addWorkspaceMember(teamId, username);
              const names = snap.members.map((m) => `${m.user.displayName}（@${m.user.username}）`);
              return `已把 @${username} 加入团队「${snap.team.name}」。当前成员 ${snap.members.length} 人：${names.join("、")}。`;
            });
          }
          case "team_plan_add": {
            const teamId = argStr(args, "team_id");
            const title = argStr(args, "title");
            if (!teamId) return { text: "team_id 不能为空；不知道就先调用 team_list。", ok: false };
            if (!title) return { text: "title 不能为空：请给方案起个标题（最多 120 字）。", ok: false };
            const detail = argOptStr(args, "detail");
            const orderIndex = argOptNum(args, "orderIndex");
            return write(async () => {
              const plan = await createTeamPlan(teamId, {
                title,
                ...(detail ? { detail } : {}),
                ...(orderIndex !== undefined ? { orderIndex } : {}),
              });
              return formatPlan(plan);
            });
          }
          case "team_plan_update": {
            const teamId = argStr(args, "team_id");
            const planId = argStr(args, "plan_id");
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
              const plan = await updateTeamPlan(teamId, planId, {
                ...(title !== undefined ? { title } : {}),
                ...(detail !== undefined ? { detail } : {}),
                ...(status ? { status: status as "todo" | "doing" | "done" | "blocked" } : {}),
                ...(orderIndex !== undefined ? { orderIndex } : {}),
              });
              return `已更新方案项「${plan.title}」（plan_id：${plan.id}，状态：${
                STATUS_LABEL[plan.status] ?? plan.status
              }）。`;
            });
          }
          case "team_task_add": {
            const teamId = argStr(args, "team_id");
            const title = argStr(args, "title");
            if (!teamId) return { text: "team_id 不能为空；不知道就先调用 team_list。", ok: false };
            if (!title) return { text: "title 不能为空：请写清要做什么（最多 120 字）。", ok: false };
            const detail = argOptStr(args, "detail");
            const assigneeId = argOptStr(args, "assigneeId");
            const planId = argOptStr(args, "planId");
            const dueAt = argOptStr(args, "dueAt");
            const attachmentFileId = argOptStr(args, "attachmentFileId");
            return write(async () => {
              const task = await createTeamTask(teamId, {
                title,
                ...(detail ? { detail } : {}),
                ...(assigneeId ? { assigneeId } : {}),
                ...(planId ? { planId } : {}),
                ...(dueAt ? { dueAt } : {}),
                ...(attachmentFileId ? { attachmentFileId } : {}),
              });
              // 指派了人时顺带确认它确实是成员，便于模型下一步引用。
              if (!task.assigneeId) return formatTask(task, []);
              const snap = await fetchWorkspaceTeam(teamId).catch(() => null);
              return formatTask(task, snap?.members ?? []);
            });
          }
          case "team_task_update": {
            const teamId = argStr(args, "team_id");
            const taskId = argStr(args, "task_id");
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
              const task = await updateTeamTask(teamId, taskId, {
                ...(title !== undefined ? { title } : {}),
                ...(detail !== undefined ? { detail } : {}),
                ...(status ? { status: status as "todo" | "doing" | "done" | "blocked" } : {}),
                ...(assigneeId !== undefined ? { assigneeId: assigneeId || null } : {}),
                ...(planId !== undefined ? { planId: planId || null } : {}),
                ...(dueAt !== undefined ? { dueAt: dueAt || null } : {}),
                ...(attachmentFileId !== undefined
                  ? { attachmentFileId: attachmentFileId || null }
                  : {}),
              });
              return `已更新任务「${task.title}」（task_id：${task.id}，状态：${
                STATUS_LABEL[task.status] ?? task.status
              }）。`;
            });
          }
          default:
            return { text: `未知工具 ${call.name}`, ok: false };
        }
      } catch (e) {
        // 永不抛：读工具失败也让模型知道原因（可改用 team_list 等继续），不中断整轮。
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
