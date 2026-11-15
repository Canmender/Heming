/**
 * 时间、字节、昵称等展示格式化
 */

import { AVATAR_COLORS } from './constants.js';

export function toMs(ts) {
  if (ts == null || ts === "") return NaN;
  const n = typeof ts === "number" ? ts : Number(ts);
  if (!Number.isFinite(n) || n <= 0) return NaN;
  return n > 1e12 ? n : n * 1000;
}

export function fmtBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

export function pad(n) {
  return String(n).padStart(2, "0");
}

export function fmtClock(ts) {
  const ms = toMs(ts);
  if (Number.isNaN(ms)) return "";
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtTime(ts, withYear) {
  const ms = toMs(ts);
  if (Number.isNaN(ms)) return "—";
  const d = new Date(ms);
  const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return withYear ? `${d.getFullYear()}-${md} ${hm}` : `${md} ${hm}`;
}

export function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function formatListTime(ts) {
  const ms = toMs(ts);
  if (Number.isNaN(ms)) return "";
  const now = Date.now();
  const day = startOfDay(ms);
  const today = startOfDay(now);
  if (day === today) return fmtClock(ms);
  if (day === today - 86400000) return "昨天";
  const d = new Date(ms);
  if (d.getFullYear() === new Date(now).getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function formatDayLabel(ts) {
  const ms = toMs(ts);
  if (Number.isNaN(ms)) return "";
  const day = startOfDay(ms);
  const today = startOfDay(Date.now());
  if (day === today) return "今天";
  if (day === today - 86400000) return "昨天";
  const d = new Date(ms);
  const week = "日一二三四五六"[d.getDay()];
  if (d.getFullYear() === new Date().getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 周${week}`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 周${week}`;
}

export function errText(err) {
  let msg = String((err && err.message) || err || "未知错误");
  msg = msg.replace(/^Error invoking remote method '[^']*':\s*/, "");
  msg = msg.replace(/^(Error|TypeError|RangeError):\s*/, "");
  return msg.trim() || "未知错误";
}

/* ────────────────────────── 桥调用 ────────────────────────── */

export function avatarColor(name) {
  let hash = 0;
  for (const char of String(name || "")) hash = (hash * 31 + char.charCodeAt(0)) % 997;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}
