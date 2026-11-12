"use strict";
/**
 * 下载速度与剩余时间估计。
 *
 * 直接用「最新两次采样」算速度会剧烈抖动（资源管理器同款毛病），
 * 这里用固定窗口内首尾差值：窗口内样本少于 2 个或时间跨度太短时返回 null，
 * 让界面先显示「计算中」而不是跳一个假数字。
 */

const DEFAULT_WINDOW = 8;

class EtaEstimator {
  /**
   * @param {{window?: number, minSpanMs?: number, now?: () => number}} [options]
   */
  constructor(options = {}) {
    this.window = options.window ?? DEFAULT_WINDOW;
    this.minSpanMs = options.minSpanMs ?? 500;
    this.now = options.now ?? (() => Date.now());
    /** @type {{t: number, bytes: number}[]} */
    this.samples = [];
  }

  reset() {
    this.samples = [];
  }

  /**
   * 记录一次已下载字节数。
   * @param {number} bytes
   * @returns {{rate: number|null, remaining: number|null}} 单位 B/s 与秒
   */
  sample(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value < 0) return { rate: null, remaining: null };
    const t = this.now();
    this.samples.push({ t, bytes: value });
    while (this.samples.length > this.window) this.samples.shift();
    return { rate: this.rate(), remaining: null };
  }

  /** @returns {number|null} 字节/秒 */
  rate() {
    const samples = this.samples;
    if (samples.length < 2) return null;
    const first = samples[0];
    const last = samples[samples.length - 1];
    const spanMs = last.t - first.t;
    if (spanMs < this.minSpanMs) return null;
    const delta = last.bytes - first.bytes;
    if (delta <= 0) return null;
    return (delta / spanMs) * 1000;
  }

  /**
   * @param {number|null} totalBytes
   * @returns {number|null} 剩余秒数
   */
  remaining(totalBytes) {
    const total = Number(totalBytes);
    const rate = this.rate();
    if (!Number.isFinite(total) || total <= 0 || !rate || rate <= 0) return null;
    const received = this.samples.length ? this.samples[this.samples.length - 1].bytes : 0;
    const left = total - received;
    if (left <= 0) return 0;
    return left / rate;
  }
}

module.exports = { EtaEstimator, DEFAULT_WINDOW };
