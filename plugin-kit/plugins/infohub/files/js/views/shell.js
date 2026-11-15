/**
 * 外壳：页内工具条、状态卡、统计、页签切换
 */

import { refreshAll, runSync } from '../app.js';
import { setStatusLine } from '../core/bridge.js';
import { append, clear, el, h } from '../core/dom.js';
import { fmtBytes, fmtTime } from '../core/format.js';
import { state } from '../core/state.js';
import { renderAgendaPane } from './agenda.js';
import { renderChatsPane } from './chats.js';
import { renderTabs } from './tabs.js';

export function renderHeader() {
  const actions = el("actions");
  if (!actions) return;
  clear(actions);
  if (state.phase !== "ready") {
    setStatusLine(state.phase === "error" ? "未就绪" : "自动启动中…", state.phase === "error" ? "error" : "busy");
    return;
  }
  if (state.busy.sync) setStatusLine(state.syncNote || "正在同步…", "busy");
  else setStatusLine(state.syncNote || "已连接 · 只读归档", "ready");

  append(actions, [
    h(
      "button",
      {
        class: "btn",
        type: "button",
        disabled: state.busy.sync,
        // 静默同步：来源由本机自动识别，不弹面板、不展示路径。
        onclick: () => runSync({}),
        title: "增量采集一次",
      },
      state.busy.sync ? "同步中…" : "同步",
    ),
    h(
      "button",
      {
        class: "btn btn-ghost",
        type: "button",
        disabled: state.busy.sync,
        onclick: () => refreshAll({ keepTab: true }),
        title: "重新读取归档状态",
      },
      "刷新",
    ),
  ]);
}

/* ────────────────────────── 连接状态 ────────────────────────── */

export function renderNoBridge() {
  renderHeader();
  setStatusLine("浏览器预览里没有本机归档桥", "idle");
  const panel = el("state-panel");
  if (!panel) return;
  clear(panel);
  panel.classList.remove("hidden");
  append(panel, [
    h(
      "div",
      { class: "state-card" },
      h("h2", { text: "信息中枢仅桌面端可用" }),
      h("p", { text: "本页运行在沙箱页面里，需要桌面应用提供本机归档桥才能读取 QQ / 微信归档。" }),
      h("p", { text: "请在和鸣桌面应用中打开「信息中枢」；数据只在本机处理，不会上传。" }),
    ),
  ]);
}

export function renderStateCard() {
  const panel = el("state-panel");
  if (!panel) return;
  panel.classList.remove("hidden");
  for (const id of ["stats", "tabs", "tab-content"]) {
    const node = el(id);
    if (node) node.classList.add("hidden");
  }
  clear(panel);
  if (state.phase === "connecting") {
    append(panel, [
      h(
        "div",
        { class: "state-card" },
        h("h2", { text: "正在启动本机归档" }),
        h("p", {
          text: "信息中枢会在后台自动识别 QQ / 微信目录，并在归档为空时采集一次；全程只在本机运行，不需要任何设置。",
        }),
        h("div", { class: "progress" }, h("i")),
      ),
    ]);
    return;
  }
  append(panel, [
    h(
      "div",
      { class: "state-card" },
      h("h2", { text: "本机归档没能启动" }),
      h("p", { text: state.errorText || "未知错误" }),
      state.errorHint ? h("p", { text: state.errorHint }) : null,
      h(
        "p",
        { text: "数据目录与解释器由主进程自动解析，不需要手动设置；重试仍失败时请重启应用。" },
      ),
      h(
        "button",
        { class: "btn btn-primary", type: "button", onclick: () => refreshAll({}) },
        "重试",
      ),
    ),
  ]);
}

export function renderStats() {
  const node = el("stats");
  if (!node) return;
  clear(node);
  const status = state.status;
  if (!status) return;
  const stats = status.stats || {};
  const agendaSummary = state.agenda && state.agenda.summary;
  const items = [
    ["归档会话", Number(stats.conversations) || 0],
    ["消息", Number(stats.messages) || 0],
    ["日程", agendaSummary ? Number(agendaSummary.total) || 0 : "—"],
    ["最后消息", status.lastMessageTs ? fmtTime(status.lastMessageTs, true) : "—"],
    ["归档大小", fmtBytes(status.dbBytes)],
  ];
  append(
    node,
    items.map(([label, value]) =>
      h("div", { class: "stat" }, h("div", { class: "stat-label", text: label }), h("div", { class: "stat-value", text: String(value) })),
    ),
  );
  node.classList.remove("hidden");
}

export function renderReady() {
  const panel = el("state-panel");
  if (panel) panel.classList.add("hidden");
  renderStats();
  renderTabs();
  renderChromeForReady();
}

export function renderChromeForReady() {
  renderHeader();
  const content = el("tab-content");
  if (content) content.classList.remove("hidden");
  for (const id of ["tab-chats", "tab-agenda"]) {
    const node = el(id);
    if (node) node.classList.add("hidden");
  }
  const current = el(`tab-${state.tab}`);
  if (current) current.classList.remove("hidden");
  if (state.tab === "agenda") renderAgendaPane();
  else renderChatsPane();
}

export function selectTab(tab) {
  state.tab = tab;
  renderTabs();
  renderChromeForReady();
}
