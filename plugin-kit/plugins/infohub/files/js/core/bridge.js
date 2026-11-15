/**
 * 宿主桥封装：infohubCall / 私有数据 / 主题 / 状态行
 */

import { el } from './dom.js';
import { state } from './state.js';

export const widget = window.__heming_widget || null;

export const hasWidget = Boolean(widget);

export const hasBridge = Boolean(widget && typeof widget.infohubCall === "function");

export function infohubCall(method, params, timeoutMs) {
  if (!hasBridge) return Promise.reject(new Error("信息中枢仅在桌面端可用"));
  const limit = timeoutMs || (method === "sync" ? 30 * 60 * 1000 : 180 * 1000);
  return widget.infohubCall(method, params || {}, { timeoutMs: limit });
}

export async function readInfo() {
  if (!widget || typeof widget.info !== "function") return null;
  try {
    const info = await Promise.resolve(widget.info());
    return info && typeof info === "object" ? info : null;
  } catch {
    return null;
  }
}

export async function applyTheme() {
  const info = await readInfo();
  const theme = info && info.theme;
  if (theme === "dark" || theme === "light") document.documentElement.dataset.theme = theme;
}

export function setStatusLine(text, tone) {
  const dot = el("status-dot");
  const line = el("status-line");
  if (!dot || !line) return;
  dot.dataset.state = tone || "idle";
  line.textContent = text;
}

export function showError(message) {
  const bar = el("error-bar");
  const text = el("error-text");
  if (!bar || !text) return;
  if (!message) {
    bar.classList.add("hidden");
    text.textContent = "";
    return;
  }
  text.textContent = message;
  bar.classList.remove("hidden");
}
