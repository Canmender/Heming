/*
 * 聊天记录页面：两栏浏览本机 InfoHub 归档。
 *
 * 数据来源只有 InfoHub 的 MCP 采集桥（POST /mcp，两个只读工具
 * infohub_conversations / infohub_archive_messages）。页面不直接读文件、不碰
 * 宿主 DOM；所有文案都用 textContent 写入，不拼 innerHTML。
 */
(() => {
  "use strict";

  const DEFAULT_MCP_URL = "http://127.0.0.1:8776/mcp";
  const MCP_URL_KEY = "infohub.mcpUrl";
  const CONV_PAGE = 200;
  const MSG_PAGE = 80;
  const RPC_TIMEOUT = 10_000;
  const SOURCE_NAMES = { qq: "QQ", wechat: "微信" };

  const bridge = window.__heming_widget || null;

  /** 默认端口可用 localStorage 覆盖（换端口调试 / 与别的实例并存时用）。 */
  const mcpUrl = (() => {
    try {
      const custom = localStorage.getItem(MCP_URL_KEY);
      if (custom && /^https?:\/\//i.test(custom)) return custom;
    } catch {
      /* 存储不可用：用默认地址 */
    }
    return DEFAULT_MCP_URL;
  })();

  const $ = (id) => document.getElementById(id);
  const dom = {
    convList: $("convList"),
    convFoot: $("convFoot"),
    convCount: $("convCount"),
    moreConvs: $("moreConvs"),
    search: $("convSearch"),
    refreshConvs: $("refreshConvs"),
    refreshMsgs: $("refreshMsgs"),
    detail: $("detail"),
    detailEmpty: $("detailEmpty"),
    detailAvatar: $("detailAvatar"),
    detailName: $("detailName"),
    detailMeta: $("detailMeta"),
    stream: $("stream"),
    offline: $("offline"),
    offlineUrl: $("offlineUrl"),
    offlineDetail: $("offlineDetail"),
    offlineRetry: $("offlineRetry"),
    banner: $("banner"),
    bannerText: $("bannerText"),
    bannerRetry: $("bannerRetry"),
    bannerClose: $("bannerClose"),
  };

  const state = {
    conversations: [],
    convTotal: 0,
    source: "",
    keyword: "",
    selected: null,
    messages: [],
    messageTotal: 0,
    hasMore: false,
    nextBeforeTs: null,
    nextBeforeId: null,
    loadingConvs: false,
    loadingMsgs: false,
    bootstrapped: false,
  };

  let convSeq = 0;
  let msgSeq = 0;
  let searchTimer = 0;
  let bannerTimer = 0;

  /* ─────────────────────────── MCP 客户端 ─────────────────────────── */

  class RpcError extends Error {
    constructor(message, offline) {
      super(message);
      this.offline = offline === true;
    }
  }

  let rpcId = 0;
  let ready = null;

  function log(line) {
    try {
      if (bridge && typeof bridge.log === "function") bridge.log(`[infohub-page] ${line}`);
    } catch {
      /* 日志失败不影响页面 */
    }
  }

  async function post(payload) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT);
    try {
      return await fetch(mcpUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (error) {
      const reason = error && error.name === "AbortError" ? "请求超时" : "网络不可达";
      throw new RpcError(`连不上 InfoHub 本机服务（${reason}）`, true);
    } finally {
      clearTimeout(timer);
    }
  }

  async function rpc(method, params) {
    const response = await post({ jsonrpc: "2.0", id: ++rpcId, method, params });
    if (!response.ok) {
      throw new RpcError(`InfoHub 返回 HTTP ${response.status}`, response.status >= 500);
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new RpcError("InfoHub 返回的内容不是 JSON", false);
    }
    if (payload && payload.error) {
      throw new RpcError(payload.error.message || "InfoHub 返回错误", false);
    }
    return payload ? payload.result : null;
  }

  function ensureReady() {
    if (!ready) {
      ready = (async () => {
        await rpc("initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "heming.infohub-page", version: "0.1.0" },
        });
        try {
          // 采集桥是无状态的最小实现；通知失败不影响 tools/call，故吞掉异常。
          await post({ jsonrpc: "2.0", method: "notifications/initialized" });
        } catch {
          /* 同上 */
        }
      })();
      ready.catch(() => {
        ready = null;
      });
    }
    return ready;
  }

  async function callTool(name, args) {
    await ensureReady();
    const result = await rpc("tools/call", { name, arguments: args });
    const text =
      result && Array.isArray(result.content) && result.content[0]
        ? String(result.content[0].text || "")
        : "";
    if (result && result.isError) throw new RpcError(text || "工具执行失败", false);
    try {
      return JSON.parse(text);
    } catch {
      throw new RpcError("工具返回的内容不是 JSON", false);
    }
  }

  /* ─────────────────────────── 小工具 ─────────────────────────── */

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function pad(n) {
    return String(n).padStart(2, "0");
  }

  function toDate(ts) {
    return new Date((Number(ts) || 0) * 1000);
  }

  function dayKey(ts) {
    const d = toDate(ts);
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  }

  function dayDiff(a, b) {
    const left = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime();
    const right = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime();
    return Math.round((right - left) / 86_400_000);
  }

  function fmtListTime(ts) {
    if (!ts) return "";
    const d = toDate(ts);
    const now = new Date();
    const diff = dayDiff(d, now);
    if (diff === 0) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    if (diff === 1) return "昨天";
    if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
  }

  function fmtDay(ts) {
    const d = toDate(ts);
    const now = new Date();
    const diff = dayDiff(d, now);
    if (diff === 0) return "今天";
    if (diff === 1) return "昨天";
    const weekday = "日一二三四五六"[d.getDay()];
    if (d.getFullYear() === now.getFullYear()) {
      return `${d.getMonth() + 1}月${d.getDate()}日 周${weekday}`;
    }
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 周${weekday}`;
  }

  function fmtTime(ts) {
    const d = toDate(ts);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function fmtFull(ts) {
    const d = toDate(ts);
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${fmtTime(ts)}`;
  }

  function initialOf(name) {
    const chars = Array.from(String(name || "").trim());
    return chars.length > 0 ? chars[0].toUpperCase() : "?";
  }

  function hueOf(name) {
    let sum = 0;
    for (const ch of String(name || "")) sum = (sum + ch.codePointAt(0)) % 360;
    return sum;
  }

  function sourceName(source) {
    return SOURCE_NAMES[source] || source || "";
  }

  function kindName(kind) {
    if (kind === "group") return "群聊";
    if (kind === "private") return "单聊";
    return "";
  }

  function applyAvatar(node, name) {
    node.textContent = initialOf(name);
    node.style.setProperty("--h", String(hueOf(name)));
  }

  function isConversation(value) {
    return value && typeof value === "object" && Number.isFinite(Number(value.id));
  }

  function isMessage(value) {
    return value && typeof value === "object" && Number.isFinite(Number(value.id));
  }

  /* ─────────────────────────── 提示 / 离线 ─────────────────────────── */

  function showBanner(message, retry) {
    clearTimeout(bannerTimer);
    dom.bannerText.textContent = message;
    dom.banner.hidden = false;
    if (typeof retry === "function") {
      dom.bannerRetry.hidden = false;
      dom.bannerRetry.onclick = () => {
        hideBanner();
        retry();
      };
    } else {
      dom.bannerRetry.hidden = true;
      dom.bannerRetry.onclick = null;
      bannerTimer = setTimeout(hideBanner, 6000);
    }
  }

  function hideBanner() {
    clearTimeout(bannerTimer);
    dom.banner.hidden = true;
  }

  function showOffline(message) {
    dom.offlineUrl.textContent = mcpUrl;
    dom.offlineDetail.textContent = message || "";
    dom.offline.hidden = false;
    log(`离线：${message || "未知原因"}`);
  }

  function hideOffline() {
    dom.offline.hidden = true;
    dom.offlineDetail.textContent = "";
  }

  function handleError(error, retry) {
    const message = error && error.message ? error.message : String(error);
    log(`失败：${message}`);
    if (error && error.offline) {
      showOffline(message);
      return;
    }
    showBanner(message, retry);
  }

  /* ─────────────────────────── 会话列表 ─────────────────────────── */

  function refreshSelectedFromList() {
    if (!state.selected) return;
    const fresh = state.conversations.find((item) => Number(item.id) === Number(state.selected.id));
    if (fresh) {
      state.selected = { ...state.selected, ...fresh };
      renderDetailHead();
    }
  }

  function renderConvSkeletons() {
    dom.convList.textContent = "";
    for (let i = 0; i < 7; i += 1) {
      const row = el("div", "skeleton-row");
      row.append(el("div", "skeleton avatar-dot"));
      const lines = el("div", "skeleton-lines");
      const wide = el("div", "skeleton skeleton-line");
      wide.style.width = `${58 + ((i * 13) % 30)}%`;
      const narrow = el("div", "skeleton skeleton-line");
      narrow.style.width = `${30 + ((i * 7) % 24)}%`;
      lines.append(wide, narrow);
      row.append(lines);
      dom.convList.append(row);
    }
    dom.convFoot.hidden = true;
  }

  function renderConversations() {
    const list = dom.convList;
    list.textContent = "";

    if (state.conversations.length === 0) {
      if (state.loadingConvs) return;
      const note = el("div", "stream-note");
      note.textContent =
        state.keyword || state.source
          ? "没有匹配的会话"
          : "还没有采集到会话。先在 InfoHub 里运行一次采集，再点右上角刷新。";
      list.append(note);
      dom.convFoot.hidden = true;
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const conv of state.conversations) {
      const active = state.selected && Number(state.selected.id) === Number(conv.id);
      const button = el("button", `conv${active ? " is-active" : ""}`);
      button.type = "button";
      button.dataset.id = String(conv.id);
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", active ? "true" : "false");

      const avatar = el("span", "avatar");
      applyAvatar(avatar, conv.name);

      const main = el("div", "conv-main");
      main.append(el("div", "conv-name", conv.name || "（未命名会话）"));
      const sub = el("div", "conv-sub");
      const badge = el("span", `badge ${conv.source === "wechat" ? "wechat" : "qq"}`, sourceName(conv.source));
      sub.append(badge);
      const count = Number(conv.messageCount) || 0;
      if (count > 0) sub.append(el("span", "", `${count} 条`));
      main.append(sub);

      const side = el("div", "conv-side");
      side.append(el("span", "", fmtListTime(conv.lastTs)));

      button.append(avatar, main, side);
      button.addEventListener("click", () => selectConversation(conv));
      fragment.append(button);
    }
    list.append(fragment);

    dom.convFoot.hidden = false;
    const shown = state.conversations.length;
    dom.convCount.textContent =
      state.convTotal > shown ? `已显示 ${shown} / 共 ${state.convTotal}` : `共 ${shown} 个会话`;
    dom.moreConvs.hidden = shown >= state.convTotal;
    dom.moreConvs.disabled = state.loadingConvs;
  }

  async function loadConversations({ reset = false } = {}) {
    if (reset) {
      state.conversations = [];
      state.convTotal = 0;
      renderConvSkeletons();
    }
    const seq = ++convSeq;
    state.loadingConvs = true;
    dom.refreshConvs.classList.add("is-loading");
    dom.refreshConvs.disabled = true;
    dom.moreConvs.disabled = true;

    const args = {
      limit: CONV_PAGE,
      offset: reset ? 0 : state.conversations.length,
    };
    if (state.source) args.source = state.source;
    if (state.keyword) args.keyword = state.keyword;

    try {
      const data = await callTool("infohub_conversations", args);
      if (seq !== convSeq) return;
      state.loadingConvs = false; // 空结果也要渲染空态，不能停在骨架
      const incoming = (Array.isArray(data.conversations) ? data.conversations : []).filter(isConversation);
      state.conversations = reset ? incoming : state.conversations.concat(incoming);
      state.convTotal = Number(data.total) || state.conversations.length;
      hideOffline();
      refreshSelectedFromList();
      renderConversations();

      if (!state.bootstrapped && state.conversations.length > 0) {
        state.bootstrapped = true;
        selectConversation(state.conversations[0]);
      }
    } catch (error) {
      if (seq !== convSeq) return;
      state.loadingConvs = false;
      renderConversations();
      handleError(error, () => loadConversations({ reset: true }));
    } finally {
      if (seq === convSeq) {
        state.loadingConvs = false;
        dom.refreshConvs.classList.remove("is-loading");
        dom.refreshConvs.disabled = false;
        if (state.conversations.length > 0) {
          dom.moreConvs.disabled = state.conversations.length >= state.convTotal;
        }
      }
    }
  }

  /* ─────────────────────────── 消息流 ─────────────────────────── */

  function renderDetailHead() {
    const conv = state.selected;
    if (!conv) return;
    applyAvatar(dom.detailAvatar, conv.name);
    dom.detailName.textContent = conv.name || "（未命名会话）";
    const parts = [sourceName(conv.source), kindName(conv.kind)].filter(Boolean);
    const count = Number(conv.messageCount) || state.messageTotal || 0;
    if (count > 0) parts.push(`共 ${count} 条消息`);
    if (conv.lastTs) parts.push(`最近 ${fmtListTime(conv.lastTs)}`);
    dom.detailMeta.textContent = parts.join(" · ");
  }

  function renderMsgSkeletons() {
    dom.stream.textContent = "";
    const inner = el("div", "stream-inner");
    for (let i = 0; i < 5; i += 1) {
      const row = el("div", "msg");
      if (i % 2 === 0) row.classList.add("self");
      const bubble = el("div", "skeleton");
      bubble.style.width = `${120 + ((i * 37) % 180)}px`;
      bubble.style.height = "34px";
      bubble.style.borderRadius = "10px";
      row.append(bubble);
      inner.append(row);
    }
    dom.stream.append(inner);
  }

  function messageNode(message, conv, showMeta) {
    const wrap = el("div", `msg${message.isSelf === true ? " self" : ""}`);
    if (showMeta) {
      const meta = el("div", "msg-meta");
      if (conv && conv.kind === "group" && message.isSelf !== true && message.from) {
        meta.append(el("span", "", message.from));
      }
      meta.append(el("span", "", fmtTime(message.ts)));
      wrap.append(meta);
    }

    const type = String(message.type || "");
    if (type && type !== "文本" && type.toLowerCase() !== "text") {
      wrap.append(el("span", "type-chip", type));
    }
    const bubble = el("div", "bubble", message.text || "（空消息）");
    bubble.title = fmtFull(message.ts);
    wrap.append(bubble);
    return wrap;
  }

  function renderMessages() {
    const stream = dom.stream;
    stream.textContent = "";
    if (!state.selected) return;

    const inner = el("div", "stream-inner");

    if (state.hasMore) {
      const holder = el("div", "load-older");
      const button = el("button", "", state.loadingMsgs ? "正在加载…" : "加载更早的消息");
      button.type = "button";
      button.disabled = state.loadingMsgs;
      button.addEventListener("click", () => loadMessages({ older: true }));
      holder.append(button);
      inner.append(holder);
    }

    if (state.messages.length === 0) {
      inner.append(el("div", "stream-note", "这个会话还没有消息"));
      stream.append(inner);
      return;
    }

    let lastDay = "";
    let lastFrom = null;
    let lastTs = 0;
    for (const message of state.messages) {
      const day = dayKey(message.ts);
      if (day !== lastDay) {
        inner.append(el("div", "day", fmtDay(message.ts)));
        lastDay = day;
        lastFrom = null;
      }
      const sameSender =
        lastFrom !== null && message.from === lastFrom && Math.abs(message.ts - lastTs) < 300;
      inner.append(messageNode(message, state.selected, !sameSender));
      lastFrom = message.from;
      lastTs = message.ts;
    }

    stream.append(inner);
  }

  async function loadMessages({ older = false } = {}) {
    if (!state.selected || state.loadingMsgs) return;
    const target = state.selected;
    const seq = ++msgSeq;
    state.loadingMsgs = true;

    if (older) {
      const button = dom.stream.querySelector(".load-older button");
      if (button) {
        button.disabled = true;
        button.textContent = "正在加载…";
      }
    } else {
      renderMsgSkeletons();
    }

    const args = { conversationId: target.id, limit: MSG_PAGE };
    if (older) {
      args.beforeTs = state.nextBeforeTs;
      args.beforeId = state.nextBeforeId;
    }

    try {
      const data = await callTool("infohub_archive_messages", args);
      if (seq !== msgSeq) return;
      if (!state.selected || Number(state.selected.id) !== Number(target.id)) return;

      const incoming = (Array.isArray(data.messages) ? data.messages : []).filter(isMessage);
      const beforeHeight = dom.stream.scrollHeight;
      const beforeTop = dom.stream.scrollTop;

      if (older) {
        const seen = new Set(state.messages.map((item) => item.id));
        state.messages = incoming.filter((item) => !seen.has(item.id)).concat(state.messages);
      } else {
        state.messages = incoming;
      }

      state.messageTotal = Number(data.total) || state.messages.length;
      state.hasMore =
        data.hasMore === true &&
        Number.isFinite(Number(data.nextBeforeTs)) &&
        Number.isFinite(Number(data.nextBeforeId));
      state.nextBeforeTs = data.nextBeforeTs;
      state.nextBeforeId = data.nextBeforeId;
      if (data.conversation) {
        state.selected = { ...state.selected, ...data.conversation };
        renderDetailHead();
      }
      hideOffline();
      state.loadingMsgs = false;
      renderMessages();

      if (older) {
        dom.stream.scrollTop = beforeTop + (dom.stream.scrollHeight - beforeHeight);
      } else {
        dom.stream.scrollTop = dom.stream.scrollHeight;
      }
    } catch (error) {
      if (seq !== msgSeq) return;
      if (!older) renderMessages();
      handleError(error, () => loadMessages({ older }));
    } finally {
      if (seq === msgSeq) {
        state.loadingMsgs = false;
        const button = dom.stream.querySelector(".load-older button");
        if (button) {
          button.disabled = false;
          button.textContent = "加载更早的消息";
        }
      }
    }
  }

  function selectConversation(conv) {
    if (!isConversation(conv)) return;
    if (state.selected && Number(state.selected.id) === Number(conv.id)) return;

    msgSeq += 1; // 取消上一次会话还在路上的消息请求
    state.selected = conv;
    state.messages = [];
    state.messageTotal = Number(conv.messageCount) || 0;
    state.hasMore = false;
    state.nextBeforeTs = null;
    state.nextBeforeId = null;
    state.loadingMsgs = false;

    dom.detailEmpty.hidden = true;
    dom.detail.hidden = false;
    renderDetailHead();
    renderConversations();
    renderMsgSkeletons();
    dom.stream.scrollTop = 0;
    loadMessages({ older: false });
  }

  /* ─────────────────────────── 事件接线 ─────────────────────────── */

  function bind() {
    dom.offlineRetry.addEventListener("click", () => {
      hideOffline();
      loadConversations({ reset: true });
    });

    dom.refreshConvs.addEventListener("click", () => loadConversations({ reset: true }));

    dom.refreshMsgs.addEventListener("click", () => {
      if (!state.selected) return;
      loadMessages({ older: false });
    });

    dom.moreConvs.addEventListener("click", () => {
      if (state.loadingConvs || state.conversations.length >= state.convTotal) return;
      loadConversations({ reset: false });
    });

    dom.bannerClose.addEventListener("click", hideBanner);

    for (const button of document.querySelectorAll(".seg")) {
      button.addEventListener("click", () => {
        const source = button.dataset.source || "";
        if (source === state.source) return;
        state.source = source;
        for (const item of document.querySelectorAll(".seg")) {
          const active = item === button;
          item.classList.toggle("is-active", active);
          item.setAttribute("aria-pressed", active ? "true" : "false");
        }
        dom.moreConvs.hidden = true;
        loadConversations({ reset: true });
      });
    }

    dom.search.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        const keyword = dom.search.value.trim();
        if (keyword === state.keyword) return;
        state.keyword = keyword;
        loadConversations({ reset: true });
      }, 220);
    });

    dom.search.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        dom.search.value = "";
        dom.search.dispatchEvent(new Event("input"));
        return;
      }
      if (event.key === "Enter" && state.conversations.length > 0) {
        event.preventDefault();
        selectConversation(state.conversations[0]);
      }
    });
  }

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme === "dark" ? "dark" : "light";
  }

  async function initTheme() {
    if (bridge && typeof bridge.info === "function") {
      try {
        const info = await bridge.info();
        if (info && info.theme) applyTheme(info.theme);
      } catch {
        /* 拿不到主题就用默认亮色 */
      }
      if (typeof bridge.onEvent === "function") {
        bridge.onEvent((event) => {
          if (event && event.kind === "theme") applyTheme(event.theme);
        });
      }
      return;
    }
    // 浏览器里预览页面时跟随系统主题。
    if (typeof window.matchMedia === "function") {
      const query = window.matchMedia("(prefers-color-scheme: dark)");
      applyTheme(query.matches ? "dark" : "light");
      query.addEventListener("change", (event) => applyTheme(event.matches ? "dark" : "light"));
    }
  }

  bind();
  initTheme();
  dom.search.focus();
  loadConversations({ reset: true });
})();
