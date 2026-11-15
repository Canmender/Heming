import { useSessionStringValue } from "../sessionState.js";

/**
 * 「当前团队」的会话级记忆（d.153）。
 *
 * 团队页在页头放了团队切换，工作台的左栏列表与它是同一个选择：一个人可以同时在多个
 * 团队里，页头切到哪个团队，名册 / 动向 / 看板 / 日程 / 用量 / 工作台就都只看那个团队。
 *
 * 为什么是 sessionStorage（`useSessionStringValue`）而不是 localStorage：与 Tab 记忆同一
 * 条口径——「这一次使用」的上下文，刷新保留、关窗回到第一个团队，比记住上个月的某个
 * 团队更符合预期；而且团队名单本身来自服务端，本地记住一个已退出/已解散的 id 只会
 * 让人看到空页面。
 */
export const TEAM_SELECTION_KEY = "heming.team.selected.v1";

/** 读/写当前团队 id；空串表示「还没选」（页面会回落到列表第一个）。 */
export function useSelectedTeamId(): [string, (teamId: string) => void] {
  return useSessionStringValue(TEAM_SELECTION_KEY);
}
