"use strict";
/**
 * 人读的格式化：字节、速度、剩余时间、文件数。
 *
 * 单独成文件是为了能单测，也避免主进程里到处写 `(x / 1024 / 1024).toFixed(1)`。
 * 单位用 1024 进制（资源管理器同款），文案沿用「MB」而不是「MiB」——
 * 安装器是给普通用户看的，不是工程面板。
 */

const UNITS = ["B", "KB", "MB", "GB", "TB"];
const THOUSAND = 1000;

/**
 * @param {number} bytes
 * @param {number} [digits] 小数位；B 永远不带小数
 * @returns {string}
 */
function formatBytes(bytes, digits = 1) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value < 1024) return `${Math.round(value)} B`;
  let unit = 0;
  let scaled = value;
  while (scaled >= 1024 && unit < UNITS.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  // 100 以上再保留小数意义不大，读数反而变长
  const precision = scaled >= 100 ? 0 : digits;
  return `${scaled.toFixed(precision)} ${UNITS[unit]}`;
}

/**
 * @param {number} bytesPerSecond
 * @returns {string}
 */
function formatSpeed(bytesPerSecond) {
  const value = Number(bytesPerSecond);
  if (!Number.isFinite(value) || value <= 0) return "—";
  return `${formatBytes(value)}/s`;
}

/**
 * 剩余时间。不足 1 秒不出数字，避免进度尾巴上跳「剩 0 秒」。
 * @param {number|null|undefined} seconds
 * @returns {string}
 */
function formatDuration(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return "";
  // 四舍五入后不到 1 秒就是「马上」，不显示「剩 0 秒」也不显示「剩 1 秒」
  const total = Math.round(value);
  if (total < 1) return "";
  if (total < 60) return `剩 ${total} 秒`;
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (minutes < 60) return rest === 0 ? `剩 ${minutes} 分` : `剩 ${minutes} 分 ${rest} 秒`;
  const hours = Math.floor(minutes / 60);
  return `剩 ${hours} 小时 ${minutes % 60} 分`;
}

/**
 * 千分位整数，用于「已写入 12,304 个文件」。
 * @param {number} count
 * @returns {string}
 */
function formatCount(count) {
  const value = Math.max(0, Math.round(Number(count) || 0));
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * 百分比取整并夹在 0–100。
 * @param {number} part
 * @param {number} total
 * @returns {number|null} total 无效时返回 null（调用方转成不确定态）
 */
function percentOf(part, total) {
  const value = Number(total);
  if (!Number.isFinite(value) || value <= 0) return null;
  const ratio = (Number(part) / value) * 100;
  if (!Number.isFinite(ratio)) return null;
  return Math.min(100, Math.max(0, Math.round(ratio)));
}

/** 秒与字节的换算常量，避免各调用点各写一套。 */
const SECOND = 1000;
const KIB = 1024;

module.exports = {
  formatBytes,
  formatSpeed,
  formatDuration,
  formatCount,
  percentOf,
  SECOND,
  KIB,
  THOUSAND,
};
