/**
 * 会话列表与消息详情页
 */

import { infohubCall, showError } from '../core/bridge.js';
import {
  CONV_PAGE,
  KEYWORD_DEBOUNCE_MS,
  MERGE_GAP_SECONDS,
  MSG_PAGE,
} from '../core/constants.js';
import { append, clear, el, h } from '../core/dom.js';
import {
  avatarColor,
  errText,
  fmtClock,
  formatDayLabel,
  formatListTime,
  startOfDay,
  toMs,
} from '../core/format.js';
import { state } from '../core/state.js';

export function renderChatsPane() {
  const pane = el("tab-chats");
  if (!pane) return;
  clear(pane);
  const keywordInput = h("input", {
    class: "input",
    type: "search",
    value: state.chat.keyword,
    placeholder: "搜索会话名（Esc 清空）",
    "aria-label": "按会话名搜索",
    oninput: (event) => {
      state.chat.keyword = event.currentTarget.value;
      if (state.chat._timer) clearTimeout(state.chat._timer);
      state.chat._timer = setTimeout(() => reloadConversations(), KEYWORD_DEBOUNCE_MS);
    },
    onkeydown: (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.currentTarget.value = "";
        state.chat.keyword = "";
        if (state.chat._timer) clearTimeout(state.chat._timer);
        reloadConversations();
      }
    },
  });
  append(pane, [
    h(
      "div",
      { class: "conv-pane" },
      h(
        "div",
        { class: "conv-toolbar" },
        keywordInput,
        h(
          "div",
          { class: "conv-meta" },
          h("span", { id: "conv-meta-text" }),
          h("span", { id: "conv-meta-loading", class: "hidden", text: "加载中…" }),
        ),
      ),
      h("div", { class: "conv-list", id: "conv-list" }),
    ),
    h(
      "div",
      { class: "msg-pane" },
      h("div", { class: "msg-head", id: "msg-head" }),
      h("div", { class: "msg-stream", id: "msg-stream" }),
    ),
  ]);
  renderConvList();
  renderMsgPane();
  if (!state.chat.messagesLoaded && !state.chat.loading) reloadConversations();
}

export function renderConvList() {
  const list = el("conv-list");
  if (!list) return;
  clear(list);
  const metaText = el("conv-meta-text");
  const metaLoading = el("conv-meta-loading");
  const chat = state.chat;
  if (metaText) {
    metaText.textContent = `${chat.total} 个会话${chat.keyword ? " · 已筛选" : ""}`;
  }
  if (metaLoading) metaLoading.classList.toggle("hidden", !chat.loading);
  if (chat.loading && !chat.items.length) {
    append(
      list,
      h(
        "div",
        { class: "skeleton" },
        [0, 1, 2, 3].map(() =>
          h(
            "div",
            { class: "skeleton-row" },
            h("div", { class: "skeleton-line", style: "width:30px;height:30px;border-radius:50%" }),
            h(
              "div",
              { style: "flex:1;display:flex;flex-direction:column;gap:5px" },
              h("div", { class: "skeleton-line", style: "width:60%" }),
              h("div", { class: "skeleton-line", style: "width:85%" }),
            ),
          ),
        ),
      ),
    );
    return;
  }
  if (!chat.items.length) {
    if (chat.dbMissing) {
      append(list, emptyBlock("归档库还没建好", "首次打开会在后台自动采集一次，稍等片刻；也可以点上方「同步」手动刷新。"));
    } else if (chat.keyword) {
      append(list, emptyBlock("没有匹配的会话", "换个关键词再试；筛选只作用于会话名，不检索消息正文。"));
    } else {
      append(
        list,
        emptyBlock("归档里还没有会话", "首次打开会在后台自动采集一次；采集完成后列表会自动刷新。"),
      );
    }
    return;
  }
  append(
    list,
    chat.items.map((conv) =>
      h(
        "button",
        {
          class: "conv-item",
          type: "button",
          "aria-current": String(Boolean(chat.selected && chat.selected.id === conv.id)),
          onclick: () => selectConversation(conv),
        },
        h("span", {
          class: "avatar avatar-lg",
          style: `background:${avatarColor(conv.name)}`,
          text: String(conv.name || "?").slice(0, 1),
        }),
        h(
          "span",
          { class: "conv-main" },
          h(
            "span",
            { class: "conv-title-row" },
            h("span", { class: "conv-name", text: conv.name || "未命名会话" }),
            h("span", { class: "conv-time", text: formatListTime(conv.last_ts) }),
          ),
          h(
            "span",
            { class: "conv-sub" },
            conv.message_count != null ? h("span", { text: `${conv.message_count} 条` }) : null,
            conv.kind === "group" ? h("span", { class: "chip", text: "群聊" }) : null,
          ),
        ),
      ),
    ),
    chat.items.length < chat.total
      ? h(
          "div",
          { class: "conv-more" },
          h(
            "button",
            {
              class: "btn btn-ghost btn-sm",
              type: "button",
              disabled: chat.loading,
              onclick: () => {
                chat.convLimit += CONV_PAGE;
                reloadConversations(true);
              },
            },
            `加载更多（已显示 ${chat.items.length} / ${chat.total}）`,
          ),
        )
      : null,
  );
}

export function emptyBlock(title, desc) {
  return h(
    "div",
    { class: "empty" },
    h("div", { class: "empty-title", text: title }),
    h("div", { class: "empty-desc", text: desc }),
  );
}

export function renderMsgPane() {
  const head = el("msg-head");
  const stream = el("msg-stream");
  if (!head || !stream) return;
  clear(head);
  clear(stream);
  const chat = state.chat;
  const conv = chat.selected;
  if (!conv) {
    append(head, h("span", { class: "msg-head-name muted", text: "选择一个会话" }));
    append(
      stream,
      emptyBlock("选择一个会话", "从左侧选择会话；如果列表为空，稍等后台自动采集完成。"),
    );
    return;
  }
  append(head, [
    h("span", { class: "msg-head-name", text: conv.name || "未命名会话" }),
    h("span", {
      class: "micro",
      text: `${conv.message_count != null ? conv.message_count : chat.messages.length} 条消息`,
    }),
    chat.hasMore
      ? h(
          "button",
          {
            class: "link",
            type: "button",
            disabled: chat.msgLoading,
            style: "margin-left:auto",
            onclick: loadOlderMessages,
          },
          chat.msgLoading ? "加载中…" : "加载更早的消息",
        )
      : null,
  ]);
  if (chat.msgLoading && !chat.messages.length) {
    append(
      stream,
      h(
        "div",
        { class: "skeleton" },
        [0, 1, 2].map(() =>
          h(
            "div",
            { class: "skeleton-row" },
            h("div", { class: "skeleton-line", style: "width:26px;height:26px;border-radius:50%" }),
            h("div", { class: "skeleton-line", style: "width:55%" }),
          ),
        ),
      ),
    );
    return;
  }
  if (!chat.messages.length) {
    if (chat.dbMissing) {
      append(stream, emptyBlock("这个会话没有消息", "归档库还没建好；稍等后台自动采集完成。"));
    } else {
      append(
        stream,
        emptyBlock("这个会话没有消息", "归档里该会话的消息条数为 0，可能只采到了会话名。"),
      );
    }
    return;
  }
  let lastDay = "";
  let prevSender = "";
  let prevTs = 0;
  const nodes = [];
  for (const msg of chat.messages) {
    const day = startOfDay(toMs(msg.ts));
    if (day !== lastDay) {
      lastDay = day;
      nodes.push(h("div", { class: "day-sep", text: formatDayLabel(msg.ts) }));
      prevSender = "";
    }
    const merged = msg.sender_id === prevSender && Math.abs(toMs(msg.ts) - prevTs) <= MERGE_GAP_SECONDS * 1000;
    prevSender = msg.sender_id;
    prevTs = toMs(msg.ts);
    const isGroup = conv.kind === "group";
    const isText = msg.type_code === 1 || msg.type_label === "文本";
    const label = msg.type_label || "附件";
    const content = msg.content == null ? "" : String(msg.content);
    nodes.push(
      h(
        "div",
        { class: `msg${msg.is_self ? " self" : ""}${merged ? " merged" : ""}` },
        h(
          "div",
          { class: "msg-body" },
          !merged
            ? h(
                "div",
                { class: "msg-meta" },
                !msg.is_self && isGroup && msg.sender_name
                  ? h("span", { text: msg.sender_name })
                  : msg.is_self
                    ? h("span", { text: "我" })
                    : null,
                h("span", { text: fmtClock(msg.ts) }),
              )
            : null,
          h("div", { class: "bubble", text: isText ? content : content || `[${label}]` }),
          !isText && content ? h("span", { class: "chip msg-type", text: label }) : null,
        ),
      ),
    );
  }
  append(stream, nodes);
  if (!chat.msgLoading) stream.scrollTop = stream.scrollHeight;
}

/* ────────────────────────── 会话数据 ────────────────────────── */

export async function reloadConversations(appendMore) {
  const chat = state.chat;
  const seq = ++chat.seq;
  if (!appendMore) chat.convLimit = CONV_PAGE;
  chat.loading = true;
  if (!appendMore) {
    chat.items = [];
    chat.total = 0;
    chat.messages = [];
    chat.messagesLoaded = false;
    chat.hasMore = false;
    chat.selected = null;
  }
  renderConvList();
  try {
    const params = { limit: chat.convLimit };
    if (chat.keyword.trim()) params.keyword = chat.keyword.trim();
    const result = await infohubCall("conversations", params);
    if (seq !== chat.seq) return;
    const data = result || {};
    chat.items = Array.isArray(data.items) ? data.items : [];
    chat.total = Number(data.total) || chat.items.length;
    chat.dbMissing = Boolean(data.dbMissing);
    if (!chat.selected && chat.items.length) {
      chat.selected = chat.items[0];
      chat.messagesLoaded = false;
      loadMessages(chat.selected);
    } else if (chat.selected) {
      const fresh = chat.items.find((item) => item.id === chat.selected.id);
      if (fresh) chat.selected = fresh;
    }
    if (!chat.items.length) chat.selected = null;
  } catch (err) {
    if (seq !== chat.seq) return;
    chat.items = [];
    chat.total = 0;
    showError(`读取会话失败：${errText(err)}`);
  } finally {
    if (seq === chat.seq) {
      chat.loading = false;
      renderConvList();
      renderMsgPane();
    }
  }
}

export async function selectConversation(conv) {
  const chat = state.chat;
  if (chat.selected && chat.selected.id === conv.id) return;
  chat.selected = conv;
  chat.messages = [];
  chat.messagesLoaded = false;
  chat.hasMore = false;
  renderConvList();
  renderMsgPane();
  await loadMessages(conv);
}

export async function loadMessages(conv) {
  const chat = state.chat;
  const seq = ++chat.msgSeq;
  chat.msgLoading = true;
  chat.messages = [];
  chat.hasMore = false;
  renderMsgPane();
  try {
    const result = await infohubCall("messages", { conversationId: conv.id, limit: MSG_PAGE });
    if (seq !== chat.msgSeq) return;
    const data = result || {};
    chat.messages = dedupeMessages(data.items || []);
    chat.hasMore = Boolean(data.hasMore) && chat.messages.length > 0;
    chat.dbMissing = Boolean(data.dbMissing) || chat.dbMissing;
    if (data.conversation) chat.selected = data.conversation;
    chat.messagesLoaded = true;
  } catch (err) {
    if (seq !== chat.msgSeq) return;
    showError(`读取消息失败：${errText(err)}`);
  } finally {
    if (seq === chat.msgSeq) {
      chat.msgLoading = false;
      renderMsgPane();
      renderConvList();
    }
  }
}

export function dedupeMessages(items) {
  const map = new Map();
  for (const item of items) {
    if (item && item.id != null && !map.has(item.id)) map.set(item.id, item);
  }
  return [...map.values()].sort((a, b) => toMs(a.ts) - toMs(b.ts));
}

export async function loadOlderMessages() {
  const chat = state.chat;
  if (!chat.selected || !chat.messages.length || chat.msgLoading) return;
  const stream = el("msg-stream");
  const prevHeight = stream ? stream.scrollHeight : 0;
  const prevTop = stream ? stream.scrollTop : 0;
  const beforeTs = chat.messages[0].ts;
  const seq = ++chat.msgSeq;
  chat.msgLoading = true;
  renderMsgPane();
  try {
    const result = await infohubCall("messages", {
      conversationId: chat.selected.id,
      limit: MSG_PAGE,
      beforeTs,
    });
    if (seq !== chat.msgSeq) return;
    const data = result || {};
    const older = dedupeMessages(data.items || []);
    chat.hasMore = Boolean(data.hasMore) && older.length > 0;
    chat.messages = dedupeMessages([...older, ...chat.messages]);
  } catch (err) {
    if (seq !== chat.msgSeq) return;
    showError(`加载更早消息失败：${errText(err)}`);
  } finally {
    if (seq === chat.msgSeq) {
      chat.msgLoading = false;
      renderMsgPane();
      const next = el("msg-stream");
      if (next) next.scrollTop = next.scrollHeight - prevHeight + prevTop;
    }
  }
}

/* ────────────────────────── 状态 / 采集 ────────────────────────── */
