import type { Conversation, Workspace } from "@heming/shared";

/**
 * 左栏「工作区」分组（d.147.4.91.11）。
 *
 * 一个工作区 = 本机一个文件夹的绝对路径。本模块只做**展示分组**：不读目录内容。
 * 注意：d.153.4.95.11 起同一个路径还会被 `lib/fileEdit/roots.ts` 派生成该会话智能体的
 * 可写根（见 `mergeWorkspaceRoot`）——分组与权限用的是同一个字段，改语义要两边一起看。
 */

/** 左栏一组会话。`path === null` 是「未分组」——隐式组，永远排在最后。 */
export interface WorkspaceGroup {
  path: string | null;
  /** 组头显示名：有路径时取文件夹名，未分组固定「未分组」。 */
  name: string;
  conversations: Conversation[];
  /** 组内最近活跃时间（ms）；空组为 0。 */
  lastActivityAt: number;
}

/** 未分组组的固定 id（折叠状态、aria 用；路径不可能等于它）。 */
export const UNGROUPED_ID = "__none__";

/** 从绝对路径取文件夹名：Windows 反斜杠与 POSIX 斜杠都认，末尾分隔符忽略。 */
export function workspaceLabel(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  // 只有分隔符（POSIX 根 "/"、或 "///"）：削完是空串，此时路径本身就是它的名字。
  if (!trimmed) return path;
  const at = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  // "D:\" 这种盘符根：削尾斜杠后剩 "D:"，没有分隔符可切，直接用它当名字。
  return at >= 0 ? trimmed.slice(at + 1) || trimmed : trimmed;
}

/** 会话最近活跃时间（与侧栏排序同一口径：有消息看消息，没消息看创建序的兜底 0）。 */
function lastActivityOf(conv: Conversation): number {
  const at = conv.lastMessageAt ? Date.parse(conv.lastMessageAt) : 0;
  return Number.isFinite(at) ? at : 0;
}

/**
 * 把会话按工作区分组。
 *
 * - 组来源 = 会话里出现过的路径 ∪ 工作区清单（清单里的空组也要显示，否则用户刚选的
 *   文件夹会「消失」）；清单里有、会话里没有 → 空组；
 * - 会话里有、清单里没有 → 也成组（目录被手工删掉/别的设备加的，不能把会话吞掉）；
 * - 组间排序：有会话的组在前（空工作区是用户刚选的目录，先别占前排）；
 *   同为有会话或同为空时，按组内最近活跃降序；再并列按名称；「未分组」永远最后；
 * - 组内按最近活跃降序。
 */
export function groupConversations(
  conversations: Conversation[],
  workspaces: Workspace[],
): WorkspaceGroup[] {
  const byPath = new Map<string, Conversation[]>();
  const ungrouped: Conversation[] = [];
  for (const conv of conversations) {
    const path = conv.workspace?.trim();
    if (!path) {
      ungrouped.push(conv);
      continue;
    }
    const list = byPath.get(path);
    if (list) list.push(conv);
    else byPath.set(path, [conv]);
  }
  for (const ws of workspaces) {
    const path = ws.path.trim();
    if (path && !byPath.has(path)) byPath.set(path, []);
  }

  const groups: WorkspaceGroup[] = [...byPath.entries()].map(([path, list]) => {
    const sorted = [...list].sort((a, b) => lastActivityOf(b) - lastActivityOf(a));
    return {
      path,
      name: workspaceLabel(path),
      conversations: sorted,
      lastActivityAt: sorted.length ? lastActivityOf(sorted[0]) : 0,
    };
  });
  // 有会话的组排在空工作区之前；同档比最近活跃，再并列按名称兜底。
  groups.sort(
    (a, b) =>
      Number(b.conversations.length > 0) - Number(a.conversations.length > 0) ||
      b.lastActivityAt - a.lastActivityAt ||
      a.name.localeCompare(b.name),
  );

  if (ungrouped.length) {
    const sorted = [...ungrouped].sort((a, b) => lastActivityOf(b) - lastActivityOf(a));
    groups.push({
      path: null,
      name: "未分组",
      conversations: sorted,
      lastActivityAt: sorted.length ? lastActivityOf(sorted[0]) : 0,
    });
  }
  return groups;
}
