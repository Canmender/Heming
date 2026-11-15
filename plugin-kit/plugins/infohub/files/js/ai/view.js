/**
 * AI 日程识别：设置面板与结果表
 */

import { updateHomeCard } from '../app.js';
import { AI_DAYS, AI_KINDS, AI_PROFILE_PLACEHOLDER } from '../core/constants.js';
import { append, copyText, h } from '../core/dom.js';
import { fmtTime } from '../core/format.js';
import { state } from '../core/state.js';
import { renderAgendaPane, renderRuleAgenda } from '../views/agenda.js';
import { aiModelLabel, aiSaveItemsSoon, aiSavePrefsSoon, refreshAiRuntime } from './prefs.js';
import {
  aiInputValue,
  aiParseLocal,
  aiResultsMeta,
  aiTsv,
  clearAiItems,
  exportAiCsv,
  runAiScan,
  stopAiScan,
} from './scan.js';

export function aiSettingsNode() {
  const ai = state.ai;
  const profile = h("textarea", {
    class: "input ai-textarea",
    id: "ai-profile",
    rows: "3",
    placeholder: AI_PROFILE_PLACEHOLDER,
    "aria-label": "我的身份与语境",
    oninput: (event) => {
      ai.profile = event.currentTarget.value;
      aiSavePrefsSoon();
    },
  }, ai.profile);

  const daysSelect = h(
    "select",
    {
      class: "input ai-select",
      "aria-label": "识别范围",
      onchange: (event) => {
        ai.days = Number(event.currentTarget.value) || 14;
        aiSavePrefsSoon();
        renderAgendaPane();
      },
    },
    AI_DAYS.map((day) =>
      h("option", { value: String(day), selected: ai.days === day, text: `最近 ${day} 天` }),
    ),
  );

  const modelOptions = ai.models.length
    ? ai.models.map((item) => ({ id: item.id, name: item.name || item.id }))
    : [{ id: "", name: ai.model ? ai.model : "（没有可用模型）" }];
  const modelSelect = h(
    "select",
    {
      class: "input ai-select",
      "aria-label": "模型",
      onchange: (event) => {
        ai.model = event.currentTarget.value;
        aiSavePrefsSoon();
      },
    },
    modelOptions.map((item) => h("option", { value: item.id, selected: ai.model === item.id, text: item.name })),
  );

  return h(
    "div",
    { class: "ai-setup" },
    h("label", { class: "ai-label", for: "ai-profile", text: "我的身份与语境（提示词）" }),
    profile,
    h("div", { class: "ai-hint", text: "越具体越准：你是谁、常出现的群、关心哪些事；只在你点「开始识别」时随请求发给模型。" }),
    h(
      "div",
      { class: "ai-controls" },
      h("label", { class: "ai-control" }, h("span", { class: "micro", text: "范围" }), daysSelect),
      h("label", { class: "ai-control ai-control-model" }, h("span", { class: "micro", text: "模型" }), modelSelect),
    ),
    h(
      "label",
      { class: "ai-consent" },
      h("input", {
        type: "checkbox",
        checked: ai.allowSend,
        onchange: (event) => {
          ai.allowSend = event.currentTarget.checked;
          aiSavePrefsSoon();
          renderAgendaPane();
        },
      }),
      h("span", {
        class: "ai-consent-text",
        text: "允许把最近聊天的原文发送给模型供应商（只在点「开始识别」时发送；结果只留在本机表格，可编辑、可导出）",
      }),
    ),
    h(
      "div",
      { class: "ai-actions" },
      h(
        "button",
        {
          class: "btn btn-primary",
          type: "button",
          disabled: ai.running,
          onclick: runAiScan,
        },
        ai.running ? "识别中…" : `开始识别（最近 ${ai.days} 天）`,
      ),
      ai.running
        ? h("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: stopAiScan, text: "停止" })
        : null,
      ai.running ? h("span", { class: "micro", id: "ai-stage", text: ai.stage || "" }) : null,
    ),
  );
}

export function aiProgressNode() {
  const ai = state.ai;
  if (!ai.running && !ai.total) return null;
  const pct = ai.total ? Math.round((ai.done / ai.total) * 100) : 0;
  return h(
    "div",
    { class: "ai-progress" },
    h(
      "div",
      { class: "ai-progress-track" },
      h("div", { class: "ai-progress-fill", id: "ai-progress-fill", style: `width:${pct}%` }),
    ),
    h("div", {
      class: "micro",
      id: "ai-progress-text",
      text: `${ai.stage} · ${ai.done}/${ai.total || "?"} 批 · 已识别 ${ai.items.length} 条`,
    }),
  );
}

export function aiRow(item, index) {
  const timeInput = h("input", {
    class: "input ai-cell-input ai-time",
    type: "datetime-local",
    value: aiInputValue(item.dueMs),
    "aria-label": "时间",
    onchange: (event) => {
      item.dueMs = aiParseLocal(event.currentTarget.value);
      item.allDay = false;
      aiSaveItemsSoon();
      renderAgendaPane();
    },
  });
  const titleInput = h("input", {
    class: "input ai-cell-input",
    value: item.title,
    maxlength: "60",
    "aria-label": "事项",
    onchange: (event) => {
      const next = String(event.currentTarget.value || "").replace(/\s+/g, " ").trim();
      if (next) item.title = next.slice(0, 60);
      aiSaveItemsSoon();
      renderAgendaPane();
    },
  });
  const kindSelect = h(
    "select",
    {
      class: "input ai-cell-input ai-kind",
      "aria-label": "类型",
      onchange: (event) => {
        item.kind = event.currentTarget.value;
        aiSaveItemsSoon();
      },
    },
    AI_KINDS.map(([key, label]) => h("option", { value: key, selected: item.kind === key, text: label })),
  );
  return h(
    "tr",
    null,
    h("td", null, timeInput),
    h("td", null, titleInput),
    h("td", null, kindSelect),
    h(
      "td",
      { class: "ai-detail" },
      h("div", { text: item.detail || "—" }),
      item.ref ? h("div", { class: "micro", text: `消息 ${item.ref}` }) : null,
    ),
    h(
      "td",
      { class: "ai-ops" },
      h("button", {
        class: "btn btn-ghost btn-sm",
        type: "button",
        "aria-label": `删除 ${item.title}`,
        text: "删除",
        onclick: () => {
          state.ai.items.splice(index, 1);
          aiSaveItemsSoon();
          updateHomeCard();
          renderAgendaPane();
        },
      }),
    ),
  );
}

export function renderAiResults() {
  const ai = state.ai;
  const items = ai.items;
  if (!items.length) {
    if (ai.running) return null;
    return h(
      "div",
      { class: "ai-empty" },
      h("div", { class: "empty" }, h("div", { class: "empty-title", text: "还没有识别结果" }), h("div", {
        class: "empty-desc",
        text: "补上身份与语境、勾选允许发送，再点「开始识别」。结果会整理成可编辑表格，不会写回日程库。",
      })),
    );
  }
  const meta = aiResultsMeta(items);
  return h(
    "div",
    { class: "ai-results" },
    h(
      "div",
      { class: "ai-results-head" },
      h("span", { class: "ai-results-title", text: `识别结果 ${items.length} 条` }),
      h("span", {
        class: "micro",
        text: `逾期 ${meta.overdue} · 今天 ${meta.today}${ai.savedAt ? ` · 保存于 ${fmtTime(ai.savedAt, false)}` : ""}`,
      }),
      h(
        "div",
        { class: "ai-results-actions" },
        h("button", {
          class: "btn btn-ghost btn-sm",
          type: "button",
          onclick: (event) => copyText(aiTsv(items), event.currentTarget),
          text: "复制表格",
        }),
        h("button", {
          class: "btn btn-ghost btn-sm",
          type: "button",
          onclick: () => exportAiCsv(items),
          text: "导出 CSV",
        }),
        h("button", { class: "btn btn-danger btn-sm", type: "button", onclick: clearAiItems, text: "清空" }),
      ),
    ),
    h(
      "div",
      { class: "ai-table-wrap" },
      h(
        "table",
        { class: "ai-table" },
        h(
          "thead",
          null,
          h("tr", null, ["时间", "事项", "类型", "依据", ""].map((label) => h("th", { text: label }))),
        ),
        h("tbody", null, items.map((item, index) => aiRow(item, index))),
      ),
    ),
  );
}

export function renderAiRules() {
  const holder = h("div", { class: "ai-rules-body" });
  renderRuleAgenda(holder);
  return h(
    "details",
    { class: "ai-rules" },
    h("summary", { text: "规则抽取的日程（备用，不需要模型）" }),
    holder,
  );
}

export function renderAiPane(pane) {
  const ai = state.ai;
  append(pane, [
    h(
      "div",
      { class: "ai-head" },
      h("div", { class: "ai-head-title" }, h("span", { text: "AI 日程识别" }), h("span", { class: "chip", text: `最近 ${ai.days} 天` })),
      h(
        "div",
        { class: "ai-head-actions" },
        h("span", { class: "micro", text: ai.gateway ? `模型：${aiModelLabel()}` : "未连接模型网关" }),
        h("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: refreshAiRuntime, text: "重新读取模型" }),
      ),
    ),
    aiSettingsNode(),
    aiProgressNode(),
    ai.error ? h("div", { class: "ai-alert", role: "alert", text: ai.error }) : null,
    ai.note ? h("div", { class: "ai-note", text: ai.note }) : null,
    renderAiResults(),
    renderAiRules(),
  ]);
}
