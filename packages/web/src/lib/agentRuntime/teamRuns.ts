/**
 * 团队任务记录（d.347）。
 *
 * 为什么单独记一份：
 * `agent_team` 一次可能跑好几分钟、好几批成员。界面需要回答三个问题——「这次要解决
 * 什么」「现在谁在跑」「上一支队伍结果如何」。`subagentRuns` 只答得了第二个，而且
 * 跑完就清空；团队还需要**结果留档**，否则用户切到协作页什么也看不到。
 *
 * 三条口径与并行子代理一致：
 * - **只报事实**：状态来自真实进度事件，不编百分比。
 * - **成员按派遣顺序**：完成先后不改变行序，用户读的是「第 1 位负责什么」。
 * - **内存里有活的，落盘只留收口的**：正在跑的那次不写盘（刷新就该结束）；收口的
 *   最近 `TEAM_RUN_HISTORY_CAP` 次写进 localStorage，供协作页回看。
 */
import { findSubagentDef, type SubagentDef } from "./subagentDefs.js";
import type { TeamPlan, TeamProgressEvent, TeamResult } from "./team.js";

/** 本地留档的键（与其它设置项同一套 `heming.*` 命名）。 */
export const TEAM_RUNS_KEY = "heming.teamRuns.v1";

/** 最多留几次收口的团队任务：再多就是历史负担，不是产品价值。 */
export const TEAM_RUN_HISTORY_CAP = 20;

export type TeamRunStatus = "running" | "done" | "failed";
export type TeamMemberStatus = "pending" | "running" | "done" | "failed";

/** 一位成员在界面上的状态。 */
export interface TeamRunMember {
  id: string;
  /** 角色名（自定义子代理标题，或「通用成员」）。 */
  role: string;
  task: string;
  status: TeamMemberStatus;
  /** 已走到第几轮（0 表示还没开始）。 */
  rounds: number;
  toolCalls: number;
  /** done/failed 时的简述。 */
  note: string | null;
}

/** 一次团队任务。 */
export interface TeamRunRecord {
  id: string;
  conversationId: string;
  goal: string;
  startedAt: number;
  endedAt: number | null;
  status: TeamRunStatus;
  members: TeamRunMember[];
}

let runs: TeamRunRecord[] = [];
let loaded = false;
let seq = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

export function subscribeTeamRuns(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 当前快照：引用稳定，只在真的变了的时候换新数组。 */
export function listTeamRuns(): TeamRunRecord[] {
  return runs;
}

/** 某会话最近一次团队任务（协作页 / 聊天页用它显示「上一支队伍」）。 */
export function latestTeamRun(conversationId?: string): TeamRunRecord | null {
  ensureLoaded();
  const pool =
    conversationId === undefined ? runs : runs.filter((run) => run.conversationId === conversationId);
  return pool.length ? (pool[pool.length - 1] ?? null) : null;
}

/** 正在跑的那次（最后一条）。
 *  注意：`agent_team` 是只读风险工具，同一条消息里可能被并行派遣两次，
 *  此时会同时存在多条 running 记录——进度/收口归位请用下面的 `runForMemberIds`，
 *  不要一律拿最后一条（会把两队的事件串到同一队头上）。 */
export function activeTeamRun(conversationId?: string): TeamRunRecord | null {
  const pool =
    conversationId === undefined ? runs : runs.filter((run) => run.conversationId === conversationId);
  for (let i = pool.length - 1; i >= 0; i -= 1) {
    const run = pool[i];
    if (run && run.status === "running") return run;
  }
  return null;
}

/**
 * 按成员 id 把一条进度/收口事件归位到正确的那次派遣。
 *
 * 并行派遣时有多条 running 记录，事件里没有 runId（接口就带 memberId），
 * 于是用「谁包含的成员 id 最多」来认领：命中最多的那次就是它。
 * 没有一条命中（成员 id 全不认识、或空结果）时回落到最后一条 running，
 * 保持单队派遣与既有行为不变。
 */
function runForMemberIds(memberIds: readonly string[]): TeamRunRecord | null {
  if (!memberIds.length) return activeTeamRun();
  const want = new Set(memberIds);
  let best: TeamRunRecord | null = null;
  let bestScore = 0;
  for (const run of runs) {
    if (run.status !== "running") continue;
    let score = 0;
    for (const member of run.members) if (want.has(member.id)) score += 1;
    if (score > bestScore) {
      best = run;
      bestScore = score;
    }
  }
  return best ?? activeTeamRun();
}

function storage(): Storage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  const store = storage();
  if (!store) return;
  try {
    const raw = store.getItem(TEAM_RUNS_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    const history: TeamRunRecord[] = [];
    for (const item of parsed) {
      const record = sanitizeRecord(item);
      if (record) history.push(record);
    }
    // 留档在前、内存里的活记录在后：`latestTeamRun` 取数组末尾，语义仍是「最近」。
    runs = [...history.slice(-TEAM_RUN_HISTORY_CAP), ...runs];
  } catch {
    // 坏档按没有处理：团队记录是锦上添花，不该让页面打不开。
  }
}

function sanitizeRecord(value: unknown): TeamRunRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || typeof raw.goal !== "string") return null;
  if (typeof raw.startedAt !== "number") return null;
  if (!Array.isArray(raw.members)) return null;
  const members: TeamRunMember[] = [];
  for (const member of raw.members) {
    if (!member || typeof member !== "object" || Array.isArray(member)) continue;
    const m = member as Record<string, unknown>;
    if (typeof m.id !== "string" || typeof m.role !== "string" || typeof m.task !== "string") continue;
    const status: TeamMemberStatus =
      m.status === "running" || m.status === "done" || m.status === "failed" ? m.status : "pending";
    members.push({
      id: m.id,
      role: m.role,
      task: m.task,
      status,
      rounds: typeof m.rounds === "number" ? m.rounds : 0,
      toolCalls: typeof m.toolCalls === "number" ? m.toolCalls : 0,
      note: typeof m.note === "string" ? m.note : null,
    });
  }
  const status: TeamRunStatus =
    raw.status === "done" || raw.status === "failed" || raw.status === "running" ? raw.status : "failed";
  return {
    id: raw.id,
    conversationId: typeof raw.conversationId === "string" ? raw.conversationId : "",
    goal: raw.goal,
    startedAt: raw.startedAt,
    endedAt: typeof raw.endedAt === "number" ? raw.endedAt : null,
    status,
    members,
  };
}

function persist(): void {
  const store = storage();
  if (!store) return;
  // 只写收口的：正在跑的那次刷新后就该结束，留着只会误导。
  const finished = runs.filter((run) => run.status !== "running").slice(-TEAM_RUN_HISTORY_CAP);
  try {
    store.setItem(TEAM_RUNS_KEY, JSON.stringify(finished));
  } catch {
    // 配额满 / 隐私模式：记录可以丢，页面不能崩。
  }
}

/** 开始一次团队任务：返回它的 id，后续进度按成员 id 落进来。 */
export function beginTeamRun(input: {
  conversationId: string;
  goal: string;
  members: readonly { id: string; role: string; task: string }[];
  now?: number;
}): string {
  ensureLoaded();
  seq += 1;
  const now = input.now ?? Date.now();
  const id = `team-${now}-${seq}`;
  const record: TeamRunRecord = {
    id,
    conversationId: input.conversationId,
    goal: input.goal,
    startedAt: now,
    endedAt: null,
    status: "running",
    members: input.members.map((member) => ({
      id: member.id,
      role: member.role,
      task: member.task,
      status: "pending",
      rounds: 0,
      toolCalls: 0,
      note: null,
    })),
  };
  runs = [...runs, record];
  emit();
  return id;
}

/** 把一条团队进度落到当前这次派遣上（按 memberId 认人，重复事件幂等）。 */
export function applyTeamProgress(event: TeamProgressEvent, now = Date.now()): void {
  const run = runForMemberIds([event.memberId]);
  if (!run) return;
  const index = run.members.findIndex((member) => member.id === event.memberId);
  if (index < 0) return;
  const member = run.members[index];
  if (!member) return;
  let status: TeamMemberStatus = member.status;
  let note = member.note;
  if (event.phase === "start") status = "running";
  if (event.phase === "done") status = "done";
  if (event.phase === "failed") status = "failed";
  if (event.phase === "done" || event.phase === "failed") note = event.note ?? note;
  const rounds = Math.max(member.rounds, event.round);
  const toolCalls = event.phase === "tool" ? member.toolCalls + 1 : member.toolCalls;
  const members = run.members.map((item, i) =>
    i === index ? { ...item, status, rounds, toolCalls, note } : item,
  );
  runs = runs.map((item) => (item.id === run.id ? { ...item, members } : item));
  emit();
}

/** 收口：整次成功与否 + 每位成员的最后状态。 */
export function finishTeamRun(
  result: Pick<TeamResult, "ok" | "members">,
  now = Date.now(),
): void {
  const run = runForMemberIds(result.members.map((member) => member.id));
  if (!run) return;
  const byId = new Map(result.members.map((member) => [member.id, member]));
  const members = run.members.map((member) => {
    const final = byId.get(member.id);
    if (!final) {
      return member.status === "pending"
        ? { ...member, status: "failed" as const, note: "没有执行（被中断）" }
        : member;
    }
    return {
      ...member,
      role: final.role,
      status: final.ok ? ("done" as const) : ("failed" as const),
      rounds: final.rounds,
      toolCalls: final.toolCalls,
      note: member.note,
    };
  });
  runs = runs.map((item) =>
    item.id === run.id
      ? { ...item, status: result.ok ? "done" : "failed", endedAt: now, members }
      : item,
  );
  persist();
  emit();
}

/** 清空内存里的记录（切会话时用）；留档保留。 */
export function resetTeamRuns(): void {
  const hasActive = runs.some((run) => run.status === "running");
  if (!hasActive) return;
  runs = runs.filter((run) => run.status !== "running");
  emit();
}

/** 清空内存与留档（设置页「清空记录」/ 测试用）。 */
export function clearTeamRuns(): void {
  runs = [];
  loaded = true;
  const store = storage();
  try {
    store?.removeItem(TEAM_RUNS_KEY);
  } catch {
    // 忽略：清不掉也不该抛。
  }
  emit();
}

/** 从留档重新读一遍（模拟「重新打开应用」；设置页回看也走它）。 */
export function reloadTeamRuns(): void {
  runs = [];
  loaded = false;
  ensureLoaded();
  emit();
}

/** 按工作区角色定义给成员起显示名：没点名就是「通用成员」。 */
export function teamMemberRole(agent: string | null | undefined, agents: readonly SubagentDef[]): string {
  return findSubagentDef(agents, agent)?.title ?? "通用成员";
}

/** 从一份计划生成 `beginTeamRun` 需要的成员清单（角色名按工作区定义解析）。 */
export function teamRunMembersOf(
  plan: TeamPlan,
  agents: readonly SubagentDef[],
): { id: string; role: string; task: string }[] {
  return plan.members.map((member) => ({
    id: member.id,
    role: teamMemberRole(member.agent, agents),
    task: member.task,
  }));
}
