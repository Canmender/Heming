/**
 * token 数的紧凑写法（团队页与首页排行共用）。
 *
 * 为什么单独成文件：团队页与首页「Token 用量 · 团队」都要展示同一批数字，
 * 两处各写一份 `toFixed` 迟早在「万」的边界上漂移（首页是概览，用户会对照着看）。
 */
export function fmtTokens(n: number): string {
  const v = Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  if (v < 10_000) return String(v);
  return `${(v / 10_000).toFixed(1)} 万`;
}
