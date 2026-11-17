import type { TeamBrief } from "@heming/shared";

/**
 * 团队简报 → 提示词段落（d.253）。
 *
 * 为什么需要：d.248 起组长的智能体就能用 `team_task_add` 的 `assigneeId` 把活派给具体的人，
 * 但它**不知道队友的 id** —— 要么让用户手输一串 uuid，要么先调 `team_list` 再翻一遍快照，
 * 最坏的情况是凭印象编一个（服务端会 400，用户只看到「派活失败」）。
 *
 * 每轮把「我在哪些团队、我在里面是什么身份、队里都有谁（名字 + id）」写进提示词，
 * 派活这一步就能一次到位；顺带也让「谁是组长」这件事在模型那边有事实依据。
 *
 * 只给事实、不替它挑人：谁最闲、该派给谁，是用户和模型的判断，不该由这里预判。
 */

/** 最多列几个团队（再多只提示去 `team_list` 看）。 */
export const TEAM_BRIEF_TEAMS_MAX = 4;
/** 每个团队最多列几个成员。 */
export const TEAM_BRIEF_MEMBERS_MAX = 10;
/** 团队目标截断长度（只用来帮她判断「这活该派到哪个团队」）。 */
export const TEAM_BRIEF_GOAL_MAX = 40;
/** 成员名截断长度。 */
export const TEAM_BRIEF_NAME_MAX = 24;

function clip(text: string, max: number): string {
  const chars = [...text.trim()];
  return chars.length <= max ? chars.join("") : `${chars.slice(0, max - 1).join("")}…`;
}

function memberText(name: string, id: string, isOwner: boolean, open: number): string {
  const load = open > 0 ? `，${open} 项未完成` : "";
  return `${clip(name, TEAM_BRIEF_NAME_MAX)}（${id}${isOwner ? "，组长" : ""}${load}）`;
}

/**
 * 团队任务概览（d.256）：组长被问「进度怎么样」时，答案就在这一行里，
 * 不用再逐个团队 team_get 去数。只给事实，不评优劣、不催办。
 */
function countsText(counts: TeamBrief["counts"]): string {
  if (counts.open === 0) {
    return `任务：没有未完成（已完成 ${counts.done} 项）`;
  }
  const parts: string[] = [];
  if (counts.overdue > 0) parts.push(`逾期 ${counts.overdue}`);
  if (counts.unassigned > 0) parts.push(`待认领 ${counts.unassigned}`);
  if (counts.blocked > 0) parts.push(`被前置卡住 ${counts.blocked}`);
  const detail = parts.length === 0 ? "" : `（${parts.join("、")}）`;
  return `任务：${counts.open} 项未完成${detail}`;
}

/**
 * 拼「团队（你在的）」段落；没有团队时返回空数组（调用方据此不写这一段）。
 *
 * 传进来的顺序就是展示顺序（服务端按最近有动静排），这里不再重排。
 */
export function describeTeamBriefLines(teams: readonly TeamBrief[]): string[] {
  if (teams.length === 0) return [];

  const lines: string[] = ["## 团队（你在的）"];
  for (const team of teams.slice(0, TEAM_BRIEF_TEAMS_MAX)) {
    const role = team.role === "owner" ? "你是组长" : "你是成员";
    const goal = team.goal.trim() === "" ? "" : `目标「${clip(team.goal, TEAM_BRIEF_GOAL_MAX)}」；`;
    const listed = team.members.slice(0, TEAM_BRIEF_MEMBERS_MAX);
    const members = listed
      .map((member) =>
        memberText(member.displayName, member.id, member.role === "owner", member.open ?? 0),
      )
      .join("、");
    const rest =
      team.members.length > listed.length ? ` 等 ${team.members.length} 人` : "";
    const counts = countsText(team.counts);
    lines.push(
      `- ${clip(team.name, TEAM_BRIEF_NAME_MAX)}（${role}）：${goal}${counts}；成员：${members}${rest}`,
    );
  }
  if (teams.length > TEAM_BRIEF_TEAMS_MAX) {
    lines.push(`- 还有 ${teams.length - TEAM_BRIEF_TEAMS_MAX} 个团队没列出来（用 team_list 看全部）。`);
  }
  lines.push(
    "- 派活用 team_task_add，并把 assigneeId 写成上面括号里的 id（只能是同队成员）；你是成员时不要往别人名下派——留空让对方认领，或派给自己。",
  );
  lines.push(
    "- 用户问「这周团队怎么样」「给我一份周报/复盘」时，先调 team_digest（d.267）：数字由它算（完成/新增/逾期/待认领/被前置挡住/催过没动），你只负责组织成话，不要自己对着任务清单手工统计（快照会截断，算不准）。",
  );
  lines.push(
    "- 派之前先看成员后面括号里的未完成数（d.264）：已经压着好几件的人别再继续派，能分散就分散；派完的结果里也会告诉你这个人手上还有多少。",
  );
  lines.push(
    // 批量派活（d.270）：一个方案 4–6 件活时，一件一件分开调既慢又容易前后不一致。
    "- 一个方案要拆成几步时，用一次 team_task_add 的 tasks 数组派 2–8 件（每件写清 title，能定就带上 assigneeId / dueAt / priority），别一件一件分开调；件数超过 8 就分两次。",
  );
  lines.push(
    // 任务讨论（d.271）：进展是覆盖式状态，讨论是追加的时间线；问口径、补约束都放讨论里。
    "- 任务下能留言（d.271）：开工前先用 team_task_comments 看有没有新留言；有疑问或要补约束就用 team_task_comment 写一句（它只追加，不会覆盖别人的话，对方的智能体下一轮也能看到）。说不清的需求不要靠猜。",
  );
  lines.push(
    // 团队动态（d.273）：快照说「现在」，动态说「怎么变成这样」。
    "- 团队动态（d.273）：被改回去的任务、被人拿走的活、被打回的版本，用 team_events 看时间线（只读，新的在前）；问「这周发生了什么」「怎么突然卡住」先看它，不要凭快照猜。",
  );
  lines.push(
    // 验收（d.272）：交上来不等于做完，组长看过才算。
    "- 验收（d.272）：任务交上来是「待验收」，只有组长能验收——用 team_task_review 选 approve 或 changes；打回必须写 note 说明要改什么，打回后任务会回到进行中、上一版结论还留着。别把「成员标了 done」直接当成交付完成。",
  );
  lines.push(
    "- 名单里没有合适的人、或者你不确定这个团队还在不在，就先 team_list / team_get 核对，不要凭印象编一个 id；派完要跟用户说清派给了谁、截止时间。",
  );
  lines.push(
    "- 被问进度时按上面每行的数字回答（未完成、逾期、待认领、被前置卡住），不要逐个团队 team_get 去数；数字和界面不一致时再重新拉一次。",
  );
  return lines;
}
