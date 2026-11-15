/**
 * AI 日程识别：偏好与结果的持久化
 */

import { widget } from '../core/bridge.js';
import { AI_DAYS, AI_MAX_ITEMS } from '../core/constants.js';
import { errText } from '../core/format.js';
import { state } from '../core/state.js';
import { renderAgendaPane } from '../views/agenda.js';
import { aiPlainItem, normalizeAiItem, sortAiItems } from './scan.js';

export function aiStoredItem(raw) {
  if (!raw || typeof raw !== "object") return null;
  const item = normalizeAiItem({ title: raw.title, due: raw.dueMs, allDay: raw.allDay, kind: raw.kind, detail: raw.detail, ref: raw.ref });
  if (!item) return null;
  item.source = String(raw.source || "");
  item.confidence = Number(raw.confidence) || 0;
  return item;
}

export async function aiSaveItems() {
  if (!widget || typeof widget.dataSet !== "function") return;
  const ai = state.ai;
  if (ai.itemsTimer) {
    clearTimeout(ai.itemsTimer);
    ai.itemsTimer = 0;
  }
  const payload = { at: Date.now(), days: ai.days, items: ai.items.map(aiPlainItem) };
  try {
    await widget.dataSet("aiItems", payload);
    ai.savedAt = payload.at;
  } catch (err) {
    ai.note = `结果没能保存到本地：${errText(err)}`;
  }
}

export function aiSaveItemsSoon() {
  const ai = state.ai;
  if (ai.itemsTimer) clearTimeout(ai.itemsTimer);
  ai.itemsTimer = setTimeout(() => {
    ai.itemsTimer = 0;
    aiSaveItems();
  }, 700);
}

export async function aiSavePrefs() {
  if (!widget || typeof widget.dataSet !== "function") return;
  const ai = state.ai;
  if (ai.prefTimer) {
    clearTimeout(ai.prefTimer);
    ai.prefTimer = 0;
  }
  try {
    await Promise.all([
      widget.dataSet("aiProfile", ai.profile),
      widget.dataSet("aiAllowSend", Boolean(ai.allowSend)),
      widget.dataSet("aiDays", Number(ai.days) || 14),
      widget.dataSet("aiModel", ai.model || ""),
    ]);
  } catch (err) {
    /* 数据目录不可写时不影响本次识别 */
  }
}

export function aiSavePrefsSoon() {
  const ai = state.ai;
  if (ai.prefTimer) clearTimeout(ai.prefTimer);
  ai.prefTimer = setTimeout(() => {
    ai.prefTimer = 0;
    aiSavePrefs();
  }, 600);
}

export async function loadAiPrefs() {
  const ai = state.ai;
  ai.loaded = true;
  if (!widget || typeof widget.dataGet !== "function") {
    await loadAiRuntime();
    return;
  }
  try {
    const values = await Promise.all([
      widget.dataGet("aiProfile"),
      widget.dataGet("aiAllowSend"),
      widget.dataGet("aiDays"),
      widget.dataGet("aiModel"),
      widget.dataGet("aiItems"),
    ]);
    if (typeof values[0] === "string") ai.profile = values[0];
    ai.allowSend = values[1] === true || values[1] === "true";
    const days = Number(values[2]);
    if (AI_DAYS.includes(days)) ai.days = days;
    if (typeof values[3] === "string" && values[3]) ai.model = values[3];
    const stored = values[4];
    if (stored && Array.isArray(stored.items)) {
      ai.items = sortAiItems(stored.items.map(aiStoredItem).filter(Boolean)).slice(0, AI_MAX_ITEMS);
      ai.savedAt = Number(stored.at) || 0;
      const storedDays = Number(stored.days);
      if (AI_DAYS.includes(storedDays)) ai.days = storedDays;
    }
  } catch (err) {
    /* 首次使用或数据目录不可读：保持默认值 */
  }
  await loadAiRuntime();
}

export async function loadAiRuntime() {
  const ai = state.ai;
  if (!widget || typeof widget.chatConfig !== "function") {
    ai.gateway = null;
    ai.error = "当前宿主没有提供模型通道（需要和鸣 d.139 及以上）";
    return;
  }
  try {
    const config = await widget.chatConfig();
    ai.gateway = config && config.gateway ? config.gateway : null;
    ai.models = config && Array.isArray(config.models) ? config.models.filter((item) => item && item.id) : [];
    const keep = ai.models.some((item) => item.id === ai.model);
    if (!keep) {
      const preferred = config && config.backgroundModel ? config.backgroundModel : "";
      const hit = ai.models.find((item) => item.id === preferred);
      ai.model = hit ? hit.id : ai.models.length ? ai.models[0].id : "";
    }
    ai.error = ai.gateway
      ? ""
      : "还没有可用模型：请先在主窗口「设置 → 模型」里配置供应商，再回到这里。";
  } catch (err) {
    ai.gateway = null;
    ai.error = `读取模型配置失败：${errText(err)}`;
  }
}

export async function refreshAiRuntime() {
  state.ai.error = "";
  await loadAiRuntime();
  renderAgendaPane();
}

/* ── 识别主流程 ── */

export function aiModelLabel() {
  const ai = state.ai;
  if (!ai.model) return "未选择模型";
  const hit = ai.models.find((item) => item.id === ai.model);
  return (hit && hit.name) || ai.model;
}
