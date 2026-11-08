/**
 * 日期时间渲染（本地时区）。
 *
 * 为什么单独成文件：服务端存的是 ISO（UTC），展示时必须换成用户本机时区。
 * 之前任务截止时间直接 `dueAt.slice(0, 16)` 是**按 UTC 截断**——东八区用户
 * 填 18:00，列表显示 10:00，跨时区团队更乱（差 8 小时会直接改变「先做哪件事」
 * 与「是否已逾期」的判断）。
 *
 * 只做一件事：给一个时间点、按本机时区渲染。不做相对时间（那是 fmtTime 的活），
 * 也不做时区选择——团队功能没有「按某个时区统一显示」的产品需求。
 */

/** 两位数补零（月份/日期/时/分）。 */
function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * ISO 时间串 → 本地时区 `YYYY-MM-DD HH:mm`。
 *
 * 空值/非法值返回 `""`（调用方一律按「没有截止时间」处理，不猜一个假时间）。
 */
export function fmtLocalDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(
    d.getHours(),
  )}:${pad2(d.getMinutes())}`;
}

/**
 * 是否已过期：可解析且严格早于 `now`（默认当前时刻）。
 *
 * 空值/非法值一律判「未过期」：脏数据不该平白无故在地里长出一个红标记。
 * 边界用严格小于——「正好到点」算未过期，与用户直觉一致（到点还能做）。
 */
export function isOverdue(iso: string | null | undefined, now: number = Date.now()): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return false;
  return t < now;
}
