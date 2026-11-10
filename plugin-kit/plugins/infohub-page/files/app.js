/*
 * 聊天记录页面：两栏浏览本机 InfoHub 归档，顶部一键采集 / 存入知识库。
 *
 * 数据全部来自插件自带的本机引擎（window.__heming_widget.engineCall）：宿主用内置
 * Python 拉起包内 engine/bridge.py，不开端口、不收外部连接。页面不直接读文件、不碰
 * 宿主 DOM；所有文案都用 textContent 写入，不拼 innerHTML。
 *
 * 引擎返回 InfoHub 核心的 snake_case 行（conversations.items / messages.items），
 * 这里统一映射成渲染用的 camelCase，渲染层不关心来源格式。
 */
(() => {
  "use strict";

  const CONV_PAGE = 200;
  const MSG_PAGE = 80;
  const SYNC_TIMEOUT = 30 * 60 * 1000; // 采集可能跑几分钟，放宽到协议上限
  const ARCHIVE_TIMEOUT = 10 * 60 * 1000;
  const SOURCE_NAMES = { qq: "QQ", wechat: "微信" };
  const VAULT_KEY = "vaultId";

  const bridge = window.__heming_widget || null;

  const $ = (id) => document.getElementById(id);
  const dom = {
    engineDot: $("engineDot"),
    modelHint: $("modelHint"),
    vaultSelect: $("vaultSelect"),
    archiveBtn: $("archiveBtn"),
    syncBtn: $("syncBtn"),
    progress: $("progress"),
    progressText: $("progressText"),
    progressFill: $("progressFill"),
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
    engineError: $("engineError"),
    engineErrorTitle: $("engineErrorTitle"),
    engineErrorDesc: $("engineErrorDesc"),
    engineErrorDetail: $("engineErrorDetail"),
    engineRetry: $("engineRetry"),
    banner: $("banner"),
    bannerText: $("bannerText"),
    bannerRetry: $("bannerRetry"),
    bannerClose: $("bannerClose"),
  };

  const state = {
    conversations: [],
    convTotal: 0,
    convLimit: CONV_PAGE,
    source: "",
    keyword: "",
    selected: null,
    messages: [],
    messageTotal: 0,
    hasMore: false,
    nextBeforeTs: null,
    loadingConvs: false,
    loadingMsgs: false,
    bootstrapped: false,
    dbMissing: false,
    vaults: [],
    vaultId: "",
    chatModel: "",
    chatAvailable: false,
    busy: false,
  };

  let convSeq = 0;
  let msgSeq = 0;
  let searchTimer = 0;
  let bannerTimer = 0;

  /* ─────────────────────────── 引擎客户端 ─────────────────────────── */

  function log(line) {
    try {
      if (bridge && typeof bridge.log === "function") bridge.log(`[infohub-page] ${line}`);
    } catch {
      /* 日志失败不影响页面 */
    }
  }

  /**
   * 调插件引擎。首次调用宿主会懒启动进程；启动失败 / 超时 / 进程退出这类「引擎不可用」
   * 错误打上 engineDown 标记，页面据此弹整屏提示而不是普通提示条。
   */
  async function engineCall(method, params = {}, options = {}) {
    if (!bridge || typeof bridge.engineCall !== "function") {
      const error = new Error("请在和鸣桌面端里打开此页面：浏览器预览连不上插件本机引擎。");
      error.engineDown = true;
      throw error;
    }
    try {
      return await bridge.engineCall(method, params, options);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      if (/^(引擎|插件「)/.test(message)) error.engineDown = true;
      throw error;
    }
  }

  /* ─────────────────────────── 行映射 ─────────────────────────── */

  function mapConv(row) {
    return {
      id: row.id,
      name: row.name || "",
      source: row.source || "",
      kind: row.kind || "",
      avatar: row.avatar || "",
      messageCount: Number(row.message_count) || 0,
      lastTs: Number(row.last_ts) || 0,
      meta: row.meta || {},
    };
  }

  function mapMsg(row) {
    return {
      id: row.id,
      ts: Number(row.ts) || 0,
      from: row.sender_name || "",
      text: row.content || "",
      type: row.type_label || "",
      isSelf: row.is_self === true ? true : row.is_self === false ? false : null,
      media: row.media || null,
    };
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

  function writableVaults() {
    return state.vaults.filter((vault) => vault.writable);
  }

  /* ─────────────────────────── 提示 / 引擎错误 ─────────────────────────── */

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

  function showEngineError(title, detail) {
    dom.engineErrorTitle.textContent = title || "本机引擎没有运行";
    dom.engineErrorDetail.textContent = detail || "";
    dom.engineError.hidden = false;
    dom.engineDot.classList.add("is-down");
    log(`引擎不可用：${detail || title}`);
  }

  function hideEngineError() {
    dom.engineError.hidden = true;
    dom.engineErrorDetail.textContent = "";
    dom.engineDot.classList.remove("is-down");
  }

  function handleError(error, retry) {
    const message = error && error.message ? error.message : String(error);
    log(`失败：${message}`);
    if (error && error.engineDown) {
      showEngineError("本机引擎没有运行", message);
      return;
    }
    showBanner(message, retry);
  }

  /* ─────────────────────────── 顶部工具栏 ─────────────────────────── */

  function renderModelHint() {
    if (state.chatModel && state.chatAvailable) {
      dom.modelHint.textContent = `摘要模型：${state.chatModel}`;
      dom.modelHint.classList.remove("is-warn");
    } else if (state.chatModel) {
      dom.modelHint.textContent = `后台模型 ${state.chatModel} 暂不可用`;
      dom.modelHint.classList.add("is-warn");
    } else {
      dom.modelHint.textContent = "未配置后台模型 · 摘要用规则生成";
      dom.modelHint.classList.add("is-warn");
    }
  }

  function renderVaults() {
    const writable = writableVaults();
    const select = dom.vaultSelect;
    select.textContent = "";
    if (writable.length === 0) {
      select.append(el("option", "", "无可写知识库"));
      select.disabled = true;
      dom.archiveBtn.disabled = true;
      dom.archiveBtn.title = "请先在和鸣「知识库」里添加一个库（默认允许写入 inbox）";
      return;
    }
    for (const vault of writable) {
      const option = el("option", "", vault.name || vault.id);
      option.value = vault.id;
      option.title = vault.target || vault.root || "";
      select.append(option);
    }
    if (!writable.some((vault) => vault.id === state.vaultId)) {
      state.vaultId = writable[0].id;
    }
    select.value = state.vaultId;
    select.disabled = state.busy;
    dom.archiveBtn.disabled = state.busy;
    const current = writable.find((vault) => vault.id === state.vaultId);
    dom.archiveBtn.title = `存入 ${(current && current.target) || "知识库"}`;
  }

  function showProgress(text, ratio) {
    dom.progress.hidden = false;
    dom.progressText.textContent = text;
    if (ratio == null) {
      dom.progressFill.style.width = "100%";
      dom.progressFill.classList.add("is-indeterminate");
    } else {
      dom.progressFill.classList.remove("is-indeterminate");
      dom.progressFill.style.width = `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`;
    }
  }

  function clearProgress() {
    dom.progress.hidden = true;
    dom.progressFill.style.width = "0%";
    dom.progressFill.classList.remove("is-indeterminate");
  }

  function setBusy(busy, kind) {
    state.busy = busy;
    dom.syncBtn.disabled = busy;
    dom.syncBtn.classList.toggle("is-loading", busy && kind === "sync");
    dom.archiveBtn.classList.toggle("is-loading", busy && kind === "archive");
    renderVaults();
    if (!busy) clearProgress();
  }

  function summarizeArchive(kb) {
    if (!kb) return "";
    if (kb.empty) return "知识库已是最新（窗口内无新消息）";
    const bits = [];
    if (kb.vault && kb.vault.name) bits.push(`已存入「${kb.vault.name}」`);
    const work = Number(kb.work) || 0;
    const life = Number(kb.life) || 0;
    if (work || life) bits.push(`工作 ${work} 条 · 生活 ${life} 条`);
    if (kb.ai && kb.ai.enabled) bits.push(kb.ai.ok ? "AI 摘要已生成" : "AI 摘要失败，已用规则摘要");
    return bits.join("，");
  }

  /** 拉取引擎状态：后台模型可用性 + 可写知识库列表 + 上次入库游标。 */
  async function refreshMeta() {
    try {
      const status = await engineCall("status", {});
      state.dbMissing = status.hasDb === false;
      state.chatModel = (status.chat && status.chat.model) || "";
      state.chatAvailable = Boolean(status.chat && status.chat.available);
      state.vaults = Array.isArray(status.kb && status.kb.vaults) ? status.kb.vaults : [];
      let saved = "";
      try {
        if (bridge && typeof bridge.dataGet === "function") saved = (await bridge.dataGet(VAULT_KEY)) || "";
      } catch {
        /* 读不到就用第一个可写库 */
      }
      if (typeof saved === "string" && saved) state.vaultId = saved;
      renderModelHint();
      renderVaults();
    } catch (error) {
      handleError(error, refreshMeta);
    }
  }

  async function doSync() {
    if (state.busy) return;
    setBusy(true, "sync");
    showProgress("正在采集本机 QQ / 微信消息…", null);
    try {
      const result = await engineCall(
        "sync",
        { sources: ["qq", "wechat"], archive: true, vaultId: state.vaultId || undefined },
        { timeoutMs: SYNC_TIMEOUT },
      );
      hideEngineError();
      const added = (Array.isArray(result.reports) ? result.reports : []).reduce(
        (sum, report) => sum + (Number(report.added) || 0),
        0,
      );
      const parts = [`采集完成：新增 ${added} 条消息`];
      const archived = summarizeArchive(result.kb);
      if (archived) parts.push(archived);
      showBanner(parts.join(" · "));
      state.convLimit = CONV_PAGE;
      state.bootstrapped = false;
      await loadConversations({ reset: true });
      await refreshMeta();
    } catch (error) {
      handleError(error, doSync);
    } finally {
      setBusy(false);
    }
  }

  async function doArchive() {
    if (state.busy) return;
    if (writableVaults().length === 0) {
      showBanner("没有可写的知识库：请先在和鸣「知识库」里添加一个库（默认允许写入 inbox）。");
      return;
    }
    setBusy(true, "archive");
    showProgress("正在生成摘要并存入知识库…", null);
    try {
      const result = await engineCall(
        "kb.archive",
        { vaultId: state.vaultId || undefined },
        { timeoutMs: ARCHIVE_TIMEOUT },
      );
      hideEngineError();
      showBanner(summarizeArchive(result) || "已存入知识库");
      await refreshMeta();
    } catch (error) {
      handleError(error, doArchive);
    } finally {
      setBusy(false);
    }
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
      if (state.keyword || state.source) {
        note.textContent = "没有匹配的会话";
      } else if (state.dbMissing) {
        note.textContent = "还没有归档库。点右上角「采集」同步本机 QQ / 微信消息。";
      } else {
        note.textContent = "还没有采集到会话。点右上角「采集」同步本机 QQ / 微信消息。";
      }
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
      state.convLimit = CONV_PAGE;
      renderConvSkeletons();
    }
    const seq = ++convSeq;
    state.loadingConvs = true;
    dom.refreshConvs.classList.add("is-loading");
    dom.refreshConvs.disabled = true;
    dom.moreConvs.disabled = true;

    const params = { limit: state.convLimit };
    if (state.source) params.source = state.source;
    if (state.keyword) params.keyword = state.keyword;

    try {
      const data = await engineCall("conversations", params);
      if (seq !== convSeq) return;
      state.loadingConvs = false; // 空结果也要渲染空态，不能停在骨架
      state.dbMissing = data.dbMissing === true;
      const incoming = (Array.isArray(data.items) ? data.items : []).map(mapConv).filter(isConversation);
      state.conversations = incoming;
      state.convTotal = Number(data.total) || incoming.length;
      hideEngineError();
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

    const params = { conversationId: target.id, limit: MSG_PAGE };
    if (older) params.beforeTs = state.nextBeforeTs;

    try {
      const data = await engineCall("messages", params);
      if (seq !== msgSeq) return;
      if (!state.selected || Number(state.selected.id) !== Number(target.id)) return;

      const incoming = (Array.isArray(data.items) ? data.items : []).map(mapMsg).filter(isMessage);
      const beforeHeight = dom.stream.scrollHeight;
      const beforeTop = dom.stream.scrollTop;

      if (older) {
        const seen = new Set(state.messages.map((item) => item.id));
        state.messages = incoming.filter((item) => !seen.has(item.id)).concat(state.messages);
      } else {
        state.messages = incoming;
      }

      if (data.conversation) {
        state.selected = { ...state.selected, ...mapConv(data.conversation) };
        state.messageTotal = state.selected.messageCount || state.messages.length;
        renderDetailHead();
      } else {
        state.messageTotal = state.messages.length;
      }
      state.hasMore = data.hasMore === true && Number.isFinite(Number(data.beforeTs));
      state.nextBeforeTs = Number(data.beforeTs) || null;
      hideEngineError();
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
    state.messageTotal = conv.messageCount || 0;
    state.hasMore = false;
    state.nextBeforeTs = null;
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
    dom.engineRetry.addEventListener("click", () => {
      hideEngineError();
      bootstrap();
    });

    dom.syncBtn.addEventListener("click", doSync);
    dom.archiveBtn.addEventListener("click", doArchive);

    dom.vaultSelect.addEventListener("change", () => {
      state.vaultId = dom.vaultSelect.value;
      renderVaults();
      try {
        if (bridge && typeof bridge.dataSet === "function") bridge.dataSet(VAULT_KEY, state.vaultId);
      } catch {
        /* 存不住偏好不影响本次入库 */
      }
    });

    dom.refreshConvs.addEventListener("click", () => loadConversations({ reset: true }));

    dom.refreshMsgs.addEventListener("click", () => {
      if (!state.selected) return;
      loadMessages({ older: false });
    });

    dom.moreConvs.addEventListener("click", () => {
      if (state.loadingConvs || state.conversations.length >= state.convTotal) return;
      state.convLimit = Math.min(5000, state.convLimit + CONV_PAGE);
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

    if (bridge && typeof bridge.onEngineEvent === "function") {
      bridge.onEngineEvent((event) => {
        if (!event || event.event !== "progress") return;
        const total = Number(event.total) || 0;
        const current = Number(event.current) || 0;
        const ratio = total > 0 ? current / total : null;
        const label = event.phase === "kb" ? "入库" : "采集";
        showProgress(`${label}：${event.stage || "处理中…"}`, ratio);
      });
    }
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

  /** 首屏：懒启动引擎（ping）→ 成功后拉会话与元信息；失败弹整屏提示。 */
  async function bootstrap() {
    if (!bridge || typeof bridge.engineCall !== "function") {
      showEngineError(
        "请在和鸣里打开此页面",
        "浏览器预览连不上插件本机引擎。请在和鸣桌面端的插件页里打开「聊天记录」。",
      );
      return;
    }
    renderConvSkeletons();
    try {
      await engineCall("ping", {});
      hideEngineError();
    } catch (error) {
      handleError(error, bootstrap);
      return;
    }
    dom.search.focus();
    loadConversations({ reset: true });
    refreshMeta();
  }

  bind();
  initTheme();
  renderModelHint();
  renderVaults();
  bootstrap();
})();
