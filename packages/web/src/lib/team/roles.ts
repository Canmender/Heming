/**
 * 团队角色口径（d.249）。
 *
 * 产品上的约定只有一句：**团队创建者就是组长**。组长能创建任务、也能把任务派给别人；
 * 其他成员只能给自己派活，或者留空等认领（服务端 `createTeamTask` / `updateTeamTask`
 * 会以 `not_leader` 拒绝越权派活，见 `packages/server/src/store.ts`）。
 *
 * 这里只做「界面怎么说」的判定，不重复服务端的校验——两处口径必须一致，
 * 但界面这边宁可少放一个选项，也不要让用户点了才被 403 拒绝。
 */

/** 组长判定：ownerId 与当前用户相同。参数缺一个就返回 false（宁可从严）。 */
export function isTeamLeader(
  team: { ownerId?: string | null } | null | undefined,
  userId: string | null | undefined,
): boolean {
  if (!team || !team.ownerId || !userId) return false;
  return team.ownerId === userId;
}

/** 角色文案：给成员列表与任务行用。 */
export function teamRoleText(
  team: { ownerId?: string | null } | null | undefined,
  userId: string | null | undefined,
): "组长" | "成员" {
  return isTeamLeader(team, userId) ? "组长" : "成员";
}

/** 成员下拉里的后缀：组长要看得出来，否则「为什么他能派活我不能」没有解释。 */
export function memberLabel(
  member: { id: string; displayName: string },
  team: { ownerId?: string | null } | null | undefined,
): string {
  return isTeamLeader(team, member.id) ? `${member.displayName}（组长）` : member.displayName;
}

/** 非组长看到的说明：为什么不让他选别人。 */
export const LEADER_ASSIGN_HINT =
  "只有组长能把任务派给别人：你可以给自己派活，或者留空等认领。";

/** 指派之后的一句交代：让对方知道这不是一行死数据。 */
export function assigneeAgentHint(name: string): string {
  return `${name} 的智能体会在下一轮对话里看到这条任务。`;
}
