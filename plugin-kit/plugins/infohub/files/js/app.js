/**
 * 主流程：状态装载、同步、自动采集、启动
 */

import { loadAiPrefs } from './ai/prefs.js';
import { aiHighlights } from './ai/scan.js';
import { applyTheme, hasBridge, hasWidget, infohubCall, showError, widget } from './core/bridge.js';
import { AUTO_SYNC_COOLDOWN_MS } from './core/constants.js';
import { el } from './core/dom.js';
import { errText } from './core/format.js';
import { detectedSources, sourceDetected } from './core/sources.js';
import { state } from './core/state.js';
import { agendaHighlights } from './views/agenda.js';
import { renderHeader, renderNoBridge, renderReady, renderStateCard } from './views/shell.js';

export async function loadStatus() {
  const status = await infohubCall("status", {});
  state.status = status || null;
  return state.status;
}

export async function loadAgenda() {
  try {
    state.agenda = await infohubCall("agenda", { days: 14, overdue: 30 });
  } catch {
    state.agenda = null;
  }
  return state.agenda;
}

/**
 * 首页卡上的「接下来三项」。
 *
 * ★ 卡片速览项是纯展示文本（宿主不渲染点击），所以这里只挑最有信息量的三条：
 *   时间 + 事项标题。日程引擎给了 dueText 就用它（口径与日程页一致），
 *   否则自己按 dueTs 拼「今天 14:00」；超过 40 字由宿主硬截断，这里先缩短，
 *   免得截在半个字上看起来像 bug。
 */

export function updateHomeCard() {
  if (!widget || typeof widget.homeCardSet !== "function") return;
  const status = state.status;
  const agenda = state.agenda;
  const stats = (status && status.stats) || {};
  const hasData = status ? Number(stats.messages) > 0 : false;
  const text = hasData
    ? `已归档 ${Number(stats.conversations) || 0} 个会话 · ${Number(stats.messages) || 0} 条消息`
    : status
      ? "还没有归档数据，打开插件开始采集"
      : "还没有归档数据";
  const summary = agenda && agenda.summary;
  const detail = summary
    ? `逾期 ${summary.overdue || 0} · 今天 ${summary.today || 0} · 本周 ${summary.week || 0}`
    : "";
  // items 让卡片直接露出「接下来三项」：优先 AI 识别结果，没有 AI 结果时回落到规则抽取
  const aiItems = aiHighlights();
  const items = aiItems.length ? aiItems : agendaHighlights(agenda);
  try {
    Promise.resolve(widget.homeCardSet("infohub", { text, detail, items })).catch(() => {});
  } catch {
    /* 旧宿主没有 homeCardSet 时静默跳过 */
  }
}

export async function runSync(options) {
  if (state.busy.sync) return;
  const params = { full: Boolean(state.sync.full), archive: Boolean(state.sync.archive) };
  let sources;
  if (options && Array.isArray(options.sources)) sources = options.sources;
  else {
    sources = [];
    if (state.sync.qq && sourceDetected(state.status, "qq")) sources.push("qq");
    if (state.sync.wechat && sourceDetected(state.status, "wechat")) sources.push("wechat");
  }
  if (!sources.length) {
    showError("没有检测到 QQ / 微信数据目录，先把客户端装好并登录。");
    return;
  }
  params.sources = sources;
  const silent = Boolean(options && options.silent);
  state.busy.sync = true;
  state.syncNote = silent ? "归档为空，正在自动采集一次…" : "正在采集归档…";
  showError("");
  renderHeader();
  try {
    const result = await infohubCall("sync", params, 30 * 60 * 1000);
    const reports = (result && result.reports) || [];
    const added = reports.reduce((sum, item) => sum + (Number(item.added) || 0), 0);
    const updated = reports.reduce((sum, item) => sum + (Number(item.updated) || 0), 0);
    const errors = reports.flatMap((item) => item.errors || []);
    const conversations = reports.reduce((sum, item) => sum + (Number(item.conversations) || 0), 0);
    state.syncNote = `采集完成：扫描 ${conversations} 个会话，新增 ${added} 条，更新 ${updated} 条消息。`;
    if (errors.length) showError(`部分来源采集失败：${errors.join("；")}`);
    await Promise.all([loadStatus(), loadAgenda()]);
    renderReady();
  } catch (err) {
    state.syncNote = "";
    showError(`采集失败：${errText(err)}`);
  } finally {
    state.busy.sync = false;
    state.syncNote = state.syncNote || "";
    renderHeader();
    updateHomeCard();
  }
}

export async function maybeAutoCollect() {
  if (state.autoTried) return;
  state.autoTried = true;
  const status = state.status;
  if (!status) return;
  const stats = status.stats || {};
  if (Number(stats.messages) > 0) return;
  const sources = detectedSources();
  if (!sources.length) return;
  let last = 0;
  try {
    last = Number(await widget.dataGet("autoSyncAt")) || 0;
  } catch {
    last = 0;
  }
  // 归档为空时只自动采集一次，冷却期内不重复触发；全程静默，只在状态行留一句话。
  if (last && Date.now() - last < AUTO_SYNC_COOLDOWN_MS) return;
  try {
    await widget.dataSet("autoSyncAt", Date.now());
  } catch {
    /* 数据目录不可写时仍然允许采集 */
  }
  await runSync({ sources, silent: true });
}

/* ────────────────────────── 主流程 ────────────────────────── */

export async function refreshAll(options) {
  if (state.busy.status) return;
  state.busy.status = true;
  state.phase = state.status ? state.phase : "connecting";
  if (!state.status) {
    renderStateCard();
  }
  try {
    await loadStatus();
    await loadAgenda();
    state.phase = "ready";
    state.errorText = "";
    state.errorHint = "";
    renderReady();
    updateHomeCard();
    if (!state.autoTried) maybeAutoCollect();
  } catch (err) {
    const message = errText(err);
    if (state.status) {
      state.phase = "ready";
      showError(`刷新失败：${message}`);
      renderReady();
      return;
    }
    state.phase = "error";
    state.errorText = message;
    state.errorHint = message.includes("信息中枢不可用")
      ? "桌面端没有启用信息中枢桥，或本机归档服务未能启动；请检查桌面端设置。"
      : message.includes("缺少 permissions.infohub")
        ? "插件清单缺少 permissions.infohub，需要重新安装插件。"
        : "";
    showError("");
    renderHeader();
    renderStateCard();
  } finally {
    state.busy.status = false;
  }
}

/**
 * 首页卡快捷入口带来的页面意图：`widget://<id>/files/index.html#intent=agenda`。
 *
 * ★ 宿主只负责把 token 放进 hash，语义由插件自己解释（宿主不理解页签概念）。
 *   这里页签与 intent 同名映射；未知 intent 一律回落默认页签，
 *   免得以后改了页签名、旧卡片把页面点成空白。
 */

export const TAB_INTENTS = new Set(["chats", "agenda"]);

export function intentFromHash() {
  let raw = "";
  try {
    raw = String((typeof location !== "undefined" && location.hash) || "").replace(/^#/, "");
  } catch {
    return "";
  }
  if (!raw) return "";
  let intent = "";
  try {
    intent = String(new URLSearchParams(raw).get("intent") || "").trim().toLowerCase();
  } catch {
    return "";
  }
  return TAB_INTENTS.has(intent) ? intent : "";
}

export async function boot() {
  applyTheme();
  // 从首页卡「会话 / 全部日程」点进来时，直接落在对应页签
  const intent = intentFromHash();
  if (intent) state.tab = intent;
  const close = el("error-close");
  if (close) {
    close.addEventListener("click", () => showError(""));
  }
  if (widget && typeof widget.onEvent === "function") {
    try {
      widget.onEvent((event) => {
        if (event && event.kind === "theme") applyTheme();
      });
    } catch {
      /* 旧宿主可能没有事件通道 */
    }
  }
  if (widget && typeof widget.log === "function") {
    try {
      widget.log("infohub bundle: boot");
    } catch {
      /* ignore */
    }
  }
  if (!hasWidget) {
    renderNoBridge();
    return;
  }
  if (!hasBridge) {
    state.phase = "error";
    state.errorText = "当前桌面端版本还不支持信息中枢插件调用，请升级到最新版本后重试。";
    renderHeader();
    renderStateCard();
    return;
  }
  // 先恢复身份提示词、范围与上次结果，再拉状态与日程，避免日程页闪一下空表格
  await loadAiPrefs();
  refreshAll({});
}
