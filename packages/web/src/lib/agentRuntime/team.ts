/**
 * 团队任务（d.347）：`agent_team` 工具。
 *
 * 为什么需要它：
 * `agent_task`（d.162/d.200）能一次派 2–3 个**互不相干**的子代理；`workflow_run`
 * （d.203）能把有先后的检索串起来。但复杂长任务要的往往是第三种东西——**一支有分工
 * 的小队**：有人先摸清结构，有人按结构深挖，有人做安全审查，最后把各自的结论合起来。
 *
 * 这一版把「团队」做成一次可核对的派遣：
 * - **成员有身份**：`agent` 点名 `.heming/agents/<名字>.md` 里的角色（d.287 同一套定义），
 *   没有点名就是通用成员；角色只追加系统提示，不会放宽工具与轮次。
 * - **成员有依赖**：`needs` 写清「我要等谁的结论」，没依赖的同批并行；上游结论自动
 *   接在下游任务前面，中间不回流主对话。
 * - **成员有边界**：2–6 人、同批最多 3 个并行、每人轮次有硬上限；写盘只在用户显式
 *   授权时开放，而且每个成员还得自己写 `write: true`——授权不会被一个成员顺走。
 * - **一个人失败不拖垮整队**：失败记成该成员的结论，下游照跑并看见「这一步没查到」。
 *
 * 与 `workflow_run` 的差别：工作流是「一个人按步骤做」的检索流水线，成员是匿名的；
 * 团队是「几个人各自负责一块」的协作，成员有名字、角色与可写权限，界面按成员显示。
 */
import type { ToolBridge } from "../agentStream.js";
import { resolveBoundProfile, streamChatRouted } from "../llmRoute.js";
import {
  SUBAGENT_MAX_ROUNDS_DEFAULT,
  runSubagentTask,
  type SubagentDeps,
  type SubagentProgressEvent,
} from "./subagent.js";
import {
  describeSubagentDefs,
  findSubagentDef,
  type SubagentDef,
} from "./subagentDefs.js";

/** 工具名：模型看到的就是这个名字。 */
export const TEAM_TOOL = "agent_team";

/** 最少几个成员才算「团队」：一个人就是 `agent_task`。 */
export const TEAM_MIN_MEMBERS = 2;

/** 最多几个成员：再多同批也排不下，工具参数还会长到没人看。 */
export const TEAM_MAX_MEMBERS = 6;

/** 同一批最多并行几个：与子代理一致，超过就是打满配额而不是省轮次。 */
export const TEAM_MAX_CONCURRENT = 3;

/** 成员轮次硬上限：团队一次要跑很多人，单人要更省；但长任务确实需要比 6 轮多一些。 */
export const TEAM_MAX_ROUNDS_LIMIT = 8;

/** 成员默认轮次。 */
export const TEAM_MAX_ROUNDS_DEFAULT = Math.min(4, SUBAGENT_MAX_ROUNDS_DEFAULT);

/** 团队目标（一句话）的长度上限。 */
export const TEAM_GOAL_MAX_CHARS = 400;

/** 单个成员任务的长度上限：写目标，不要把整段上下文倒过来。 */
export const TEAM_MEMBER_TASK_MAX_CHARS = 600;

/** 上游结论注入下游时的截断：不能靠它把原文一路搬下去。 */
export const TEAM_UPSTREAM_CONTEXT_MAX = 1200;

/** 成员 id 的形状：要进 `needs`，也要进界面，只允许短标识。 */
const MEMBER_ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,23}$/;

/** 模型给 `agent_team` 的一个成员（解析后）。 */
export interface TeamMember {
  /** 成员短标识（同一次派遣内唯一），下游用它在 `needs` 里引用。 */
  id: string;
  /** 工作区自定义子代理名；null 表示通用成员。 */
  agent: string | null;
  /** 这一块要做什么。 */
  task: string;
  /** 必须先跑完的成员 id。 */
  needs: string[];
  /** 这一位是否需要写盘：只有用户已授权时才允许为 true。 */
  write: boolean;
}

/** 一次团队派遣（解析后）。 */
export interface TeamPlan {
  goal: string;
  members: TeamMember[];
  maxRounds: number;
}

export type TeamParseResult =
  | { ok: true; plan: TeamPlan }
  | { ok: false; error: string };

export interface TeamParseOptions {
  /** 工作区里真正定义了的子代理名：传了就校验存在性，不传只校验形状。 */
  knownAgents?: readonly string[];
  /** 用户是否已授权写盘：false 时任何 `write: true` 都在执行前拒绝。 */
  allowWrite?: boolean;
}

/** 一个成员的结果。 */
export interface TeamMemberResult {
  id: string;
  /** 显示用的角色名（自定义子代理的标题，或「通用成员」）。 */
  role: string;
  /** 模型给的任务（不含上游上下文）。 */
  task: string;
  ok: boolean;
  rounds: number;
  toolCalls: number;
  text: string;
}

/** 一次团队派遣的结果。 */
export interface TeamResult {
  ok: boolean;
  text: string;
  waves: string[][];
  members: TeamMemberResult[];
}

export type TeamWaveResult =
  | { ok: true; waves: string[][] }
  | { ok: false; error: string };

/** 进度事件：在子代理事件上补成员身份，界面据 `memberId` 把行对上人。 */
export type TeamProgressEvent = SubagentProgressEvent & {
  memberId: string;
  role: string;
};

function memberLabel(def: SubagentDef | null): string {
  return def ? def.title : "通用成员";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 解析 `agent_team` 的参数。
 *
 * 错误文案要能让主模型自己改对并重试：说明是哪一位、错在哪、可选值是什么。
 */
export function parseTeamArgs(
  raw: string | undefined,
  opts: TeamParseOptions = {},
): TeamParseResult {
  const text = (raw ?? "").trim();
  if (!text) {
    return {
      ok: false,
      error:
        'agent_team 缺少参数：需要 {"goal":"这次团队要解决什么","members":[{"id":"a","task":"…"}]}（至少 2 位成员）。',
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      ok: false,
      error:
        'agent_team 的参数不是合法 JSON：应当形如 {"goal":"…","members":[{"id":"scan","task":"…"},{"id":"dig","task":"…","needs":["scan"]}]}。',
    };
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, error: "agent_team 的参数必须是 JSON 对象：{\"goal\":\"…\",\"members\":[…]}。" };
  }
  const goal = typeof parsed.goal === "string" ? parsed.goal.trim() : "";
  if (!goal) {
    return { ok: false, error: "agent_team 缺少 goal：用一句话写清这次团队要解决什么。" };
  }
  if (goal.length > TEAM_GOAL_MAX_CHARS) {
    return {
      ok: false,
      error: `agent_team 的 goal 太长了（${goal.length} 字，上限 ${TEAM_GOAL_MAX_CHARS}）：只写目标，细节放进各成员的任务里。`,
    };
  }
  const rawMembers = parsed.members;
  if (!Array.isArray(rawMembers)) {
    return {
      ok: false,
      error: `agent_team 的 members 必须是数组（至少 ${TEAM_MIN_MEMBERS} 位、最多 ${TEAM_MAX_MEMBERS} 位）。`,
    };
  }
  if (rawMembers.length < TEAM_MIN_MEMBERS) {
    return {
      ok: false,
      error: `agent_team 至少需要 ${TEAM_MIN_MEMBERS} 位成员（收到 ${rawMembers.length} 位）：只派一件事请用 agent_task。`,
    };
  }
  if (rawMembers.length > TEAM_MAX_MEMBERS) {
    return {
      ok: false,
      error: `agent_team 一次最多 ${TEAM_MAX_MEMBERS} 位成员（收到 ${rawMembers.length} 位）：请合并相近的分工，或拆成两次团队派遣。`,
    };
  }

  const members: TeamMember[] = [];
  const ids = new Set<string>();
  for (const [index, item] of rawMembers.entries()) {
    const label = `第 ${index + 1} 位成员`;
    if (!isPlainObject(item)) {
      return { ok: false, error: `agent_team 的${label}不是对象：每位成员都要有 id 与 task。` };
    }
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (!MEMBER_ID_RE.test(id)) {
      return {
        ok: false,
        error: `agent_team 的${label} id 不合法（${JSON.stringify(item.id)}）：必须以字母开头，只用字母 / 数字 / 短横线 / 下划线，最长 24 字符。`,
      };
    }
    if (ids.has(id)) {
      return { ok: false, error: `agent_team 的成员 id 重复了：${id}。每位成员要用不同的 id，下游才能用 needs 引用。` };
    }
    ids.add(id);
    const task = typeof item.task === "string" ? item.task.trim() : "";
    if (!task) {
      return { ok: false, error: `agent_team 的成员 ${id} 缺少 task：写清这一位要查什么、交付什么。` };
    }
    if (task.length > TEAM_MEMBER_TASK_MAX_CHARS) {
      return {
        ok: false,
        error: `agent_team 的成员 ${id} 的 task 太长了（${task.length} 字，上限 ${TEAM_MEMBER_TASK_MAX_CHARS}）：只写目标，不要把整段上下文倒过来。`,
      };
    }
    let agent: string | null = null;
    if (item.agent !== undefined && item.agent !== null) {
      const value = typeof item.agent === "string" ? item.agent.trim().toLowerCase() : "";
      if (!/^[a-z][a-z0-9-]{0,29}$/.test(value)) {
        return {
          ok: false,
          error: `agent_team 的成员 ${id} 的 agent 不合法（${JSON.stringify(item.agent)}）：必须是 .heming/agents/<名字>.md 里的小写名字，例如 review。`,
        };
      }
      if (opts.knownAgents !== undefined && !opts.knownAgents.includes(value)) {
        const list = opts.knownAgents.length ? opts.knownAgents.join(" / ") : "（工作区里还没有定义）";
        return {
          ok: false,
          error: `agent_team 的成员 ${id} 点名了不存在的子代理「${value}」：可用的有 ${list}。不点名就写通用成员。`,
        };
      }
      agent = value;
    }
    let needs: string[] = [];
    if (item.needs !== undefined && item.needs !== null) {
      if (!Array.isArray(item.needs)) {
        return { ok: false, error: `agent_team 的成员 ${id} 的 needs 必须是数组（写上游成员的 id）。` };
      }
      const seen = new Set<string>();
      for (const need of item.needs) {
        const value = typeof need === "string" ? need.trim() : "";
        if (!value) {
          return { ok: false, error: `agent_team 的成员 ${id} 的 needs 里有空值：只写成员 id。` };
        }
        if (value === id) {
          return { ok: false, error: `agent_team 的成员 ${id} 不能依赖自己：请删掉这条 needs。` };
        }
        if (!seen.has(value)) {
          seen.add(value);
          needs.push(value);
        }
      }
    }
    let write = false;
    if (item.write !== undefined && item.write !== null) {
      if (typeof item.write !== "boolean") {
        return { ok: false, error: `agent_team 的成员 ${id} 的 write 必须是 true / false。` };
      }
      write = item.write;
    }
    if (write && opts.allowWrite !== true) {
      return {
        ok: false,
        error: `agent_team 的成员 ${id} 要求写盘，但本轮没有授权子代理写盘：请把 write 去掉，或让用户先打开子代理写盘开关。`,
      };
    }
    members.push({ id, agent, task, needs, write });
  }

  const byId = new Map(members.map((member) => [member.id, member]));
  for (const member of members) {
    for (const need of member.needs) {
      if (!byId.has(need)) {
        return {
          ok: false,
          error: `agent_team 的成员 ${member.id} 依赖了不存在的成员「${need}」：可用的是 ${members.map((m) => m.id).join(" / ")}。`,
        };
      }
    }
  }

  let maxRounds = TEAM_MAX_ROUNDS_DEFAULT;
  if (parsed.max_rounds !== undefined && parsed.max_rounds !== null) {
    const value = parsed.max_rounds;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      return {
        ok: false,
        error: `agent_team 的 max_rounds 必须是 1–${TEAM_MAX_ROUNDS_LIMIT} 的整数（收到 ${JSON.stringify(value)}）。`,
      };
    }
    maxRounds = Math.min(value, TEAM_MAX_ROUNDS_LIMIT);
  }

  const planned = planTeamWaves(members);
  if (!planned.ok) return { ok: false, error: planned.error };

  return { ok: true, plan: { goal, members, maxRounds } };
}

function idList(ids: readonly string[]): string {
  return ids.map((id) => `「${id}」`).join("、");
}

/**
 * 把成员按依赖分层。
 *
 * 同一层的成员互不依赖，可以并行；层与层之间是同步点。成环时把「谁在互相等待」
 * 原样交给主模型，它才知道该删哪条 `needs`。
 */
export function planTeamWaves(members: readonly TeamMember[]): TeamWaveResult {
  const pending = new Map<string, Set<string>>();
  for (const member of members) pending.set(member.id, new Set(member.needs));
  const placed = new Set<string>();
  const waves: string[][] = [];
  while (placed.size < members.length) {
    const wave: string[] = [];
    for (const member of members) {
      if (placed.has(member.id)) continue;
      const needs = pending.get(member.id);
      if (!needs) continue;
      let ready = true;
      for (const need of needs) {
        if (!placed.has(need)) {
          ready = false;
          break;
        }
      }
      if (ready) wave.push(member.id);
    }
    if (wave.length === 0) {
      const stuck = members.filter((member) => !placed.has(member.id)).map((member) => member.id);
      return {
        ok: false,
        error: `agent_team 的成员依赖成环，无法排班：${idList(stuck)} 在互相等待。请删掉其中一条 needs，或改成单向依赖。`,
      };
    }
    waves.push(wave);
    for (const id of wave) placed.add(id);
  }
  return { ok: true, waves };
}

/** 下游成员看到的「上游结论」段落：带成员 id 与角色，便于它判断该不该引用。 */
function upstreamContext(
  member: TeamMember,
  roles: Map<string, string>,
  byId: Map<string, TeamMemberResult>,
): string {
  const parts: string[] = [];
  for (const need of member.needs) {
    const result = byId.get(need);
    if (!result) continue;
    const body = result.text.trim();
    const clipped =
      body.length > TEAM_UPSTREAM_CONTEXT_MAX
        ? `${body.slice(0, TEAM_UPSTREAM_CONTEXT_MAX)}…（已截断）`
        : body;
    parts.push(`- 成员 ${need}（${roles.get(need) ?? "成员"}）的结论：\n${clipped}`);
  }
  if (parts.length === 0) return "";
  return [
    "上游成员已经查到的结论（据此继续，不要重复查同一件事）：",
    ...parts,
    "",
    "你的任务：",
  ].join("\n");
}

/** 一次团队派遣需要的外部能力：子代理那一套 + 工作区角色定义。 */
export interface TeamDeps extends SubagentDeps {
  /** 工作区里定义好的子代理（点名的成员只追加系统提示，不改权限）。 */
  agents?: readonly SubagentDef[];
}

/** 执行选项。 */
export interface TeamRunOptions {
  /** 进度事件：界面按 memberId 认人；缺省透传给 `deps.onProgress`。 */
  onProgress?: (event: TeamProgressEvent) => void;
  /** 同批并发上限（夹在 1–`TEAM_MAX_CONCURRENT`）。 */
  concurrency?: number;
  /** task id 前缀：同一次派遣内的成员用 `前缀-成员id` 区分。 */
  taskIdPrefix?: string;
  /** 派遣开始时回调（界面据此开一条团队记录）。 */
  onStart?: (plan: TeamPlan) => void;
  /** 收口时回调（整次成功与否 + 每位成员的最后状态）。 */
  onFinish?: (result: TeamResult) => void;
}

/** 把整次团队任务的结果整理成回给主模型的文本。 */
export function formatTeam(
  plan: TeamPlan,
  waves: string[][],
  members: TeamMemberResult[],
  writable: boolean,
): TeamResult {
  const ok = members.every((member) => member.ok);
  const head = [
    `团队任务（${members.length} 位成员 / ${waves.length} 批；${writable ? "部分成员可写" : "只读子代理"}）`,
    `目标：${plan.goal}`,
    `成员：${members.map((m) => `${m.id}（${m.role}）`).join("、")}`,
  ];
  const body: string[] = [];
  for (const member of members) {
    const usage = member.ok
      ? `${member.rounds} 轮 / ${member.toolCalls} 次工具调用`
      : `未完成（${member.rounds} 轮 / ${member.toolCalls} 次工具调用）`;
    body.push(`### [${member.id}] ${member.role}｜${member.task}\n（${usage}）\n${member.text.trim()}`);
  }
  const tail = ok
    ? [
        "",
        "以上是团队各成员的结论。综合成一条回答：写清哪些结论一致、哪些只查到一部分；不要重复成员原文，也不要拿一个成员的结论替另一个成员背书。",
      ]
    : [
        "",
        "有成员没有跑完：请按失败原因决定是补派这一位、换一种做法，还是先向用户说明缺什么。",
      ];
  return { ok, text: [...head, "", ...body, ...tail].join("\n"), waves, members };
}

/**
 * 执行一次已校验的团队派遣：按批并行，上游结论注入下游任务。
 *
 * 与 `workflow_run` 同一套执行体（`runSubagentTask`），区别是每名成员带自己的角色、
 * 写盘授权与进度身份。一个成员抛错只记成它自己失败，后面的成员照跑。
 */
export async function runTeam(
  plan: TeamPlan,
  deps: TeamDeps,
  options: TeamRunOptions = {},
): Promise<TeamResult> {
  const planned = planTeamWaves(plan.members);
  if (!planned.ok) {
    return { ok: false, text: planned.error, waves: [], members: [] };
  }
  const prefix = options.taskIdPrefix ?? "team-";
  const budget = Math.max(
    1,
    Math.min(options.concurrency ?? TEAM_MAX_CONCURRENT, TEAM_MAX_CONCURRENT),
  );
  const roles = new Map<string, string>();
  const memberById = new Map(plan.members.map((member) => [member.id, member]));
  for (const member of plan.members) {
    roles.set(member.id, memberLabel(findSubagentDef(deps.agents ?? [], member.agent)));
  }
  const results = new Map<string, TeamMemberResult>();
  const writable = deps.writable === true;
  const forward = options.onProgress ?? deps.onProgress;
  options.onStart?.(plan);

  for (const wave of planned.waves) {
    const queue = [...wave];
    const workers = Math.max(1, Math.min(budget, queue.length));
    await Promise.all(
      Array.from({ length: workers }, async () => {
        for (;;) {
          const id = queue.shift();
          if (id === undefined) return;
          const member = memberById.get(id);
          if (!member) return;
          const role = roles.get(id) ?? "通用成员";
          const def = findSubagentDef(deps.agents ?? [], member.agent);
          const context = upstreamContext(member, roles, results);
          const task = context ? `${context}${member.task}` : member.task;
          const memberDeps: SubagentDeps = {
            tools: deps.tools,
            execute: deps.execute,
            chat: deps.chat,
            ...(deps.signal ? { signal: deps.signal } : {}),
            ...(def ? { instructions: def.instructions, agentName: def.name } : {}),
            // 写盘要同时满足两条：本轮用户授权过，且这一位点名要写。授权不会被顺走。
            ...(writable && member.write ? { writable: true } : {}),
            ...(deps.onWrite ? { onWrite: deps.onWrite } : {}),
            ...(forward
              ? {
                  onProgress: (event: SubagentProgressEvent) =>
                    forward({ ...event, memberId: member.id, role }),
                }
              : {}),
          };
          try {
            const result = await runSubagentTask(
              task,
              plan.maxRounds,
              memberDeps,
              `${prefix}${member.id}`,
              TEAM_MAX_ROUNDS_LIMIT,
            );
            results.set(member.id, {
              id: member.id,
              role,
              task: member.task,
              ok: result.ok,
              rounds: result.rounds,
              toolCalls: result.toolCalls,
              text: result.text,
            });
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            results.set(member.id, {
              id: member.id,
              role,
              task: member.task,
              ok: false,
              rounds: 0,
              toolCalls: 0,
              text: `这位成员执行时出错：${reason}`,
            });
          }
        }
      }),
    );
  }

  const ordered = plan.members.map(
    (member) =>
      results.get(member.id) ?? {
        id: member.id,
        role: roles.get(member.id) ?? "通用成员",
        task: member.task,
        ok: false,
        rounds: 0,
        toolCalls: 0,
        text: "（这位成员没有执行：被中断或内部出错）",
      },
  );
  const formatted = formatTeam(plan, planned.waves, ordered, writable);
  options.onFinish?.(formatted);
  return formatted;
}

/** OpenAI function spec：只在真的有写盘授权 / 有角色定义时才出现对应参数。 */
export function teamSpec(opts: { writable?: boolean; agents?: readonly SubagentDef[] } = {}): unknown {
  const writable = opts.writable === true;
  const agents = opts.agents ?? [];
  const agentNote = agents.length
    ? `工作区里定义了这些角色：${describeSubagentDefs(agents)}——要某一位按专门要求干活，就在它的 agent 里写那个名字。`
    : "";
  const writeNote = writable
    ? "本轮用户已授权子代理写盘：需要改文件的成员要显式写 write: true，并在 task 里写清改哪几个文件。"
    : "";
  const base =
    `组一支小队处理复杂长任务：把任务拆成 2–${TEAM_MAX_MEMBERS} 位成员，每人负责一块并写清交付什么；` +
    "有前后依赖就在 needs 里写上游成员的 id，没依赖的同批并行（最多 3 个）。" +
    "上游成员的结论会自动接在下游任务前面，中间不消耗主对话的轮次；某一位没跑完不影响其他人。" +
    "适合「要分头摸清、再合起来判断」的长任务；只查一件事用 agent_task，同一个人按步骤查用 workflow_run。";
  const properties: Record<string, unknown> = {
    goal: {
      type: "string",
      description: "这次团队要解决什么（一句话，成员都会看到）",
    },
    members: {
      type: "array",
      minItems: TEAM_MIN_MEMBERS,
      maxItems: TEAM_MAX_MEMBERS,
      description: "成员列表；没有 needs 的成员先并行跑",
      items: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "成员短标识（字母开头），供其他成员在 needs 里引用",
          },
          task: {
            type: "string",
            description: "这一位要查什么、交付什么（一两句话）",
          },
          needs: {
            type: "array",
            items: { type: "string", description: "依赖的上游成员 id" },
            description: "这一位必须在哪些成员之后跑（省略表示不依赖任何人）",
          },
          ...(agents.length
            ? {
                agent: {
                  type: "string",
                  enum: agents.map((def) => def.name),
                  description: `用哪个角色（${agents.map((def) => def.name).join(" / ")}）；不传就是通用成员`,
                },
              }
            : {}),
          ...(writable
            ? {
                write: {
                  type: "boolean",
                  description: "这一位是否需要改文件（只有本轮已授权写盘时才可用）",
                },
              }
            : {}),
        },
        required: ["id", "task"],
        additionalProperties: false,
      },
    },
    max_rounds: {
      type: "integer",
      minimum: 1,
      maximum: TEAM_MAX_ROUNDS_LIMIT,
      description: `每位成员最多跑几轮工具（默认 ${TEAM_MAX_ROUNDS_DEFAULT}，上限 ${TEAM_MAX_ROUNDS_LIMIT}）`,
    },
  };
  return {
    type: "function",
    function: {
      name: TEAM_TOOL,
      description: [base, agentNote, writeNote].filter(Boolean).join(""),
      parameters: {
        type: "object",
        properties,
        required: ["goal", "members"],
        additionalProperties: false,
      },
    },
  };
}

/** 包装 `agent_team` 时需要的依赖（与 `WithSubagentToolOptions` 同源）。 */
export interface WithTeamToolOptions {
  agentId: string;
  conversationId: string;
  /** 覆盖子会话的对话请求（测试 / 评测注入点）。 */
  chat?: SubagentDeps["chat"];
  /** 进度上报：界面据此显示「哪位成员在第几轮、正在读什么」。 */
  onProgress?: (event: TeamProgressEvent) => void;
  /** 界面「停止子代理」的信号：与主对话的停止信号取或。 */
  createSignal?: () => AbortSignal;
  /** 用户是否显式授权子代理写盘：只能来自界面开关，不能来自模型参数。 */
  writable?: boolean;
  /** 成员落盘回调：主对话据此把路径记进「本轮可撤回」。 */
  onWrite?: (path: string) => void;
  /** 工作区里定义好的角色。 */
  agents?: readonly SubagentDef[];
  /** 派遣开始时回调：界面据此开一条团队记录（d.347）。 */
  onStart?: (plan: TeamPlan) => void;
  /** 收口时回调：整次成功与否 + 每位成员的最后状态（d.347）。 */
  onFinish?: (result: TeamResult) => void;
}

/** 把两个中断信号合成一个：任一方 abort 都算中断。 */
function combineSignals(first?: AbortSignal, second?: AbortSignal): AbortSignal | undefined {
  if (!first) return second;
  if (!second) return first;
  const controller = new AbortController();
  const stop = () => controller.abort();
  if (first.aborted || second.aborted) {
    controller.abort();
    return controller.signal;
  }
  first.addEventListener("abort", stop, { once: true });
  second.addEventListener("abort", stop, { once: true });
  return controller.signal;
}

/** 把 `agent_team` 包到主桥上：工具清单多一件，其余工具原样透传。 */
export function withTeamTool(bridge: ToolBridge, opts: WithTeamToolOptions): ToolBridge {
  const writable = opts.writable === true;
  const agents = opts.agents ?? [];
  const agentNames = agents.map((def) => def.name);
  return {
    ...bridge,
    tools: [...bridge.tools, teamSpec({ writable, agents })],
    meta: (name: string) => {
      if (name === TEAM_TOOL) {
        // 长任务编排的主力入口，声明成核心工具（装了 MCP 也不会被挤掉）。
        return { risk: "read" as const, displayName: "派团队", core: true };
      }
      return bridge.meta?.(name);
    },
    execute: async (call, execOpts) => {
      if (call.name !== TEAM_TOOL) return bridge.execute(call, execOpts);
      const parsed = parseTeamArgs(call.arguments, {
        ...(agentNames.length ? { knownAgents: agentNames } : {}),
        allowWrite: writable,
      });
      if (!parsed.ok) return { text: parsed.error, ok: false };
      const profile = opts.chat ? undefined : resolveBoundProfile(opts.agentId);
      if (!opts.chat && !profile) {
        return {
          text: "没有可用的模型绑定，无法派团队：请先在「设置 → 模型」给这个智能体选一个模型。",
          ok: false,
        };
      }
      const signal = combineSignals(opts.createSignal?.(), execOpts?.signal);
      const result = await runTeam(
        parsed.plan,
        {
          tools: bridge.tools,
          agents,
          ...(signal ? { signal } : {}),
          ...(writable ? { writable: true } : {}),
          ...(opts.onWrite ? { onWrite: opts.onWrite } : {}),
          execute: (sub, subOpts) => bridge.execute(sub, subOpts),
          chat:
            opts.chat ??
            ((messages, subTools, subSignal, onToolCalls) => {
              if (!profile) throw new Error("团队缺少模型绑定");
              return streamChatRouted(profile, messages, {
                signal: subSignal ?? new AbortController().signal,
                onDelta: () => {},
                tools: subTools,
                onToolCalls: (calls) =>
                  onToolCalls(
                    calls.map((c) => ({
                      id: c.id,
                      name: c.function.name,
                      arguments: c.function.arguments,
                    })),
                  ),
              });
            }),
        },
        {
          ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
          ...(opts.onStart ? { onStart: opts.onStart } : {}),
          ...(opts.onFinish ? { onFinish: opts.onFinish } : {}),
        },
      );
      return { text: result.text, ok: result.ok };
    },
  };
}
