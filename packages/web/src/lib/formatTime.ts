/**
 * 聊天界面的时间格式工具（A4）。
 *
 * HomePage 里原有一份 `fmtTime`（首页会话列表用），口径是「当天 HH:mm、
 * 跨天 MM-DD HH:mm」。这里按同一口径独立实现一份给聊天页复用——
 * 不直接搬 HomePage 私有函数（它归导航路维护），也不追求两处共用代码：
 * 格式简单，重复实现比跨文件耦合更稳妥。
 */

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function valid(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 气泡时间：当天 HH:mm；跨天 MM-DD HH:mm（与首页列表同口径）。 */
export function formatClock(iso: string, now: Date = new Date()): string {
  const d = valid(iso);
  if (!d) return "";
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return sameDay(d, now) ? hm : `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hm}`;
}

/**
 * 分隔条时间：比气泡时间多给日期语境——
 * 今天 / 昨天 / 同年「M月D日」/ 跨年「YYYY年M月D日」，统一带 HH:mm。
 */
export function formatDayClock(iso: string, now: Date = new Date()): string {
  const d = valid(iso);
  if (!d) return "";
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (sameDay(d, now)) return `今天 ${hm}`;
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (sameDay(d, yesterday)) return `昨天 ${hm}`;
  if (d.getFullYear() === now.getFullYear()) {
    return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
  }
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

/**
 * 相邻两条消息之间是否插入时间分隔：
 * 首条（无前序）、跨天、或间隔达到 5 分钟 → 插。
 * 连续对话不插，避免每条消息头顶都挂一条时间。
 */
export const TIME_SEPARATOR_GAP_MS = 5 * 60 * 1000;

export function needsTimeSeparator(
  prevIso: string | null | undefined,
  iso: string,
  gapMs: number = TIME_SEPARATOR_GAP_MS,
): boolean {
  const prev = valid(prevIso);
  const cur = valid(iso);
  if (!cur) return false;
  if (!prev) return true;
  if (!sameDay(prev, cur)) return true;
  return cur.getTime() - prev.getTime() >= gapMs;
}
