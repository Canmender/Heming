/**
 * 日程页（规则抽取结果）
 */

import { renderAiPane } from '../ai/view.js';
import { updateHomeCard } from '../app.js';
import { infohubCall, showError } from '../core/bridge.js';
import { append, clear, el, h } from '../core/dom.js';
import { errText, fmtClock, fmtTime, formatDayLabel, toMs } from '../core/format.js';
import { state } from '../core/state.js';

export function renderAgendaPane() {
  const pane = el("tab-agenda");
  if (!pane) return;
  clear(pane);
  renderAiPane(pane);
}

/* 规则抽取的日程：作为 AI 结果下方的「备用」折叠区保留；不需要模型、不联网 */
export function renderRuleAgenda(pane) {
  const agenda = state.agenda;
  const summary = (agenda && agenda.summary) || { overdue: 0, today: 0, week: 0, total: 0 };
  const items = (agenda && agenda.items) || [];
  append(pane, [
    h(
      "div",
      { class: "agenda-head" },
      h("span", { text: `未来 14 天 · 逾期 30 天 · 共 ${Number(summary.total) || 0} 条` }),
      h(
        "span",
        { class: "agenda-summary" },
        h("span", { class: summary.overdue ? "overdue" : "", text: `逾期 ${summary.overdue || 0}` }),
        h("span", { text: `今天 ${summary.today || 0}` }),
        h("span", { text: `本周 ${summary.week || 0}` }),
      ),
      h(
        "button",
        {
          class: "btn btn-ghost btn-sm",
          type: "button",
          disabled: state.busy.rebuild || state.busy.sync,
          onclick: rebuildAgenda,
        },
        state.busy.rebuild ? "重扫中…" : "重扫议程",
      ),
    ),
    h(
      "div",
      { class: "agenda-body" },
      items.length
        ? h(
            "ul",
            { class: "agenda-list" },
            items.map((item) => {
              const overdue = String(item.status || "") === "overdue" || toMs(item.dueTs) < Date.now();
              return h(
                "li",
                { class: "agenda-item" },
                h("span", { class: overdue ? "due overdue" : "due", text: item.dueText || fmtTime(item.dueTs, false) }),
                h(
                  "div",
                  { class: "agenda-main" },
                  h("div", { class: "agenda-title", text: item.title || "未命名事项" }),
                  item.detail ? h("div", { class: "agenda-detail", text: item.detail }) : null,
                  h("div", {
                    class: "agenda-source",
                    text: [item.convName, item.senderName, item.msgTs ? `消息 ${fmtTime(item.msgTs, false)}` : ""]
                      .filter(Boolean)
                      .join(" · "),
                  }),
                ),
              );
            }),
          )
        : h(
            "div",
            { class: "empty" },
            h("div", { class: "empty-title", text: "没有待办事项" }),
            h("div", { class: "empty-desc", text: "归档里的会议、日程与提醒会出现在这里。完成一次采集后再看看。" }),
          ),
    ),
  ]);
}

/* ────────────────────────── AI 日程识别 ────────────────────────── */

export async function rebuildAgenda() {
  if (state.busy.rebuild || state.busy.sync) return;
  state.busy.rebuild = true;
  renderAgendaPane();
  try {
    state.agenda = await infohubCall("agenda", { days: 14, overdue: 30, rebuild: true });
    updateHomeCard();
  } catch (err) {
    showError(`重扫议程失败：${errText(err)}`);
  } finally {
    state.busy.rebuild = false;
    renderAgendaPane();
  }
}

/* ────────────────────────── 会话页 ────────────────────────── */

export function agendaHighlights(agenda) {
  const items = (agenda && agenda.items) || [];
  const lines = [];
  for (const item of items) {
    if (!item || !item.title) continue;
    const when = item.dueText || (item.dueTs ? `${formatDayLabel(item.dueTs)} ${fmtClock(item.dueTs)}`.trim() : "");
    const line = when ? `${when} · ${item.title}` : String(item.title);
    lines.push(line.length > 40 ? `${line.slice(0, 39)}…` : line);
    if (lines.length >= 3) break;
  }
  return lines;
}
