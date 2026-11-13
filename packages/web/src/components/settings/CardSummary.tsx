/**
 * 设置卡片标题旁的「当前值摘要」（d.打简化轮）。
 *
 * 设置页有 9 张卡，每张都把「现在是什么状态」藏在卡内第一行或折叠区里：
 * 用户为了确认「预算到底开没开」「后台任务用的哪个模型」得把整张卡读完。
 * 这里统一在标题旁给一行 12px 灰字，把**当前值**放在视线第一落点，
 * 卡片内部则只保留「改」的操作与解释。
 *
 * 约定：
 * - 只做拼接与省略，不做取数；状态仍由各卡片自己的 store 派生，避免两份真相；
 * - 值全空时整行不渲染（宁可没有，也不要「当前：—」这种废话）；
 * - 用 ` · ` 连接，顺序按重要性；调用方负责文案用词（用户语言，不出现 CLI 动词）。
 */

export interface CardSummaryProps {
  /** 摘要片段；false / null / undefined / 空串会被丢掉。 */
  items: readonly (string | false | null | undefined)[];
  className?: string;
}

export function CardSummary({ items, className }: CardSummaryProps) {
  const parts = items.filter((item): item is string => Boolean(item && item.trim()));
  if (parts.length === 0) return null;
  return <span className={className ? `ui-caption ${className}` : "ui-caption"}>{parts.join(" · ")}</span>;
}