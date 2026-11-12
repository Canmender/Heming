/**
 * 信息中枢 · 沙箱 bundle 插件
 *
 * 运行在 widget:// 沙箱页面里，只能通过 window.__heming_widget 与宿主通信：
 *   - infohubCall(method, params, { timeoutMs })：调用本机归档桥（只读检索 + 采集）
 *   - dataGet / dataSet：插件私有数据（只用来记录自动采集时间）
 *   - homeCardSet：刷新首页卡片文案
 *   - notify：系统通知（仅在权限声明可用时）
 *   - openPage / log：打开宿主页面、写日志
 *
 * 不接触 Node、不使用 localStorage，所有归档数据都留在宿主进程。
 */
(() => {
  "use strict";

  const widget = window.__heming_widget || null;
  const hasWidget = Boolean(widget);
  const hasBridge = Boolean(widget && typeof widget.infohubCall === "function");

  const SEARCH_LIMIT = 100;
  const CONV_PAGE = 200;
  const MSG_PAGE = 80;
  const MERGE_GAP_SECONDS = 300;
  const KEYWORD_DEBOUNCE_MS = 220;
  const AUTO_SYNC_COOLDOWN_MS = 10 * 60 * 1000;
  const SOURCE_LABELS = { qq: "QQ", wechat: "微信" };
  const AVATAR_COLORS = ["#7b8794", "#8a7a6a", "#6f8b7d", "#8b7381", "#6f7f9a", "#9a8467", "#71838b"];

  const state = {
    phase: "connecting", // connecting | ready | error
    errorText: "",
    errorHint: "",
    status: null,
    agenda: null,
    tab: "search",
    busy: { search: false, agenda: false, rebuild: false, sync: false, status: false },
    syncOpen: false,
    syncNote: "",
    autoNote: "",
    searchQuery: "",
    searchedFor: "",
    searchResult: null,
    searchError: "",
    searchSeq: 0,
    sync: { qq: true, wechat: true, full: false, archive: false },
    chat: {
      source: "",
      keyword: "",
      convLimit: CONV_PAGE,
      items: [],
      total: 0,
      dbMissing: false,
      loading: false,
      seq: 0,
      selected: null,
      messages: [],
      hasMore: false,
      msgLoading: false,
      msgSeq: 0,
      messagesLoaded: false,
    },
    autoTried: false,
  };

  const el = (id) => document.getElementById(id);

  /* ────────────────────────── DOM 工具 ────────────────────────── */

  function append(node, children) {
    for (const child of children) {
      if (child == null || child === false) continue;
      if (Array.isArray(child)) append(node, child);
      else if (child instanceof Node) node.appendChild(child);
      else node.appendChild(document.createTextNode(String(child)));
    }
  }

  function h(tag, props, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value == null || value === false) continue;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key === "dataset") Object.assign(node.dataset, value);
      else if (key === "style") node.style.cssText = value;
      else if (key.startsWith("on") && typeof value === "function") {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else node.setAttribute(key, value === true ? "" : String(value));
    }
    append(node, children);
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  /** FTS 片段里的 <<命中>> 标记渲染成 <mark>；其余一律按纯文本处理。 */
  function snippetNodes(snippet) {
    const nodes = [];
    const re = /<<([\s\S]+?)>>/g;
    let last = 0;
    let match;
    while ((match = re.exec(snippet)) !== null) {
      if (match.index > last) nodes.push(document.createTextNode(snippet.slice(last, match.index)));
      nodes.push(h("mark", { text: match[1] }));
      last = re.lastIndex;
    }
    if (last < snippet.length) nodes.push(document.createTextNode(snippet.slice(last)));
    return nodes;
  }

  /* ────────────────────────── 格式化 ────────────────────────── */

  function toMs(ts) {
    if (ts == null || ts === "") return NaN;
    const n = typeof ts === "number" ? ts : Number(ts);
    if (!Number.isFinite(n) || n <= 0) return NaN;
    return n > 1e12 ? n : n * 1000;
  }

  function fmtBytes(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n <= 0) return "0 B";
    if (n < 1024) return `${n} B`;
    const kb = n / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KB`;
    const mb = kb / 1024;
    if (mb < 1024) return `${mb.toFixed(1)} MB`;
    return `${(mb / 1024).toFixed(2)} GB`;
  }

  function pad(n) {
    return String(n).padStart(2, "0");
  }

  function fmtClock(ts) {
    const ms = toMs(ts);
    if (Number.isNaN(ms)) return "";
    const d = new Date(ms);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function fmtTime(ts, withYear) {
    const ms = toMs(ts);
    if (Number.isNaN(ms)) return "—";
    const d = new Date(ms);
    const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return withYear ? `${d.getFullYear()}-${md} ${hm}` : `${md} ${hm}`;
  }

  function startOfDay(ms) {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function formatListTime(ts) {
    const ms = toMs(ts);
    if (Number.isNaN(ms)) return "";
    const now = Date.now();
    const day = startOfDay(ms);
    const today = startOfDay(now);
    if (day === today) return fmtClock(ms);
    if (day === today - 86400000) return "昨天";
    const d = new Date(ms);
    if (d.getFullYear() === new Date(now).getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function formatDayLabel(ts) {
    const ms = toMs(ts);
    if (Number.isNaN(ms)) return "";
    const day = startOfDay(ms);
    const today = startOfDay(Date.now());
    if (day === today) return "今天";
    if (day === today - 86400000) return "昨天";
    const d = new Date(ms);
    const week = "日一二三四五六"[d.getDay()];
    if (d.getFullYear() === new Date().getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 周${week}`;
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 周${week}`;
  }

  function fmtLastRun(lastRun) {
    if (lastRun == null || lastRun === "") return "—";
    if (typeof lastRun === "number" || /^\d+$/.test(String(lastRun))) return fmtTime(lastRun, false);
    const ms = Date.parse(String(lastRun));
    if (Number.isNaN(ms)) return String(lastRun);
    return fmtTime(ms, false);
  }

  function errText(err) {
    let msg = String((err && err.message) || err || "未知错误");
    msg = msg.replace(/^Error invoking remote method '[^']*':\s*/, "");
    msg = msg.replace(/^(Error|TypeError|RangeError):\s*/, "");
    return msg.trim() || "未知错误";
  }

  /* ────────────────────────── 桥调用 ────────────────────────── */

  function infohubCall(method, params, timeoutMs) {
    if (!hasBridge) return Promise.reject(new Error("信息中枢仅在桌面端可用"));
    const limit = timeoutMs || (method === "sync" ? 30 * 60 * 1000 : 180 * 1000);
    return widget.infohubCall(method, params || {}, { timeoutMs: limit });
  }

  function sourceDetected(status, source) {
    const config = (status && status.config) || {};
    if (source === "wechat") {
      const c = config.wechat || {};
      return Boolean(c.detected || c.db_dir || c.dbDir);
    }
    const c = config.qq || {};
    return Boolean(c.detected || c.nt_db || c.ntDb || c.export_dir || c.exportDir || c.export_detected || c.exportDetected);
  }

  function detectedSources() {
    const status = state.status;
    if (!status) return [];
    const sources = [];
    if (sourceDetected(status, "qq")) sources.push("qq");
    if (sourceDetected(status, "wechat")) sources.push("wechat");
    return sources;
  }

  /* ────────────────────────── 主题 / 页头 ────────────────────────── */

  async function readInfo() {
    if (!widget || typeof widget.info !== "function") return null;
    try {
      const info = await Promise.resolve(widget.info());
      return info && typeof info === "object" ? info : null;
    } catch {
      return null;
    }
  }

  async function applyTheme() {
    const info = await readInfo();
    const theme = info && info.theme;
    if (theme === "dark" || theme === "light") document.documentElement.dataset.theme = theme;
  }

  function setStatusLine(text, tone) {
    const dot = el("status-dot");
    const line = el("status-line");
    if (!dot || !line) return;
    dot.dataset.state = tone || "idle";
    line.textContent = text;
  }

  function setSubtitle(text) {
    const node = el("subtitle");
    if (node) node.textContent = text;
  }

  function showError(message) {
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

  function renderHeader() {
    const actions = el("actions");
    if (!actions) return;
    clear(actions);
    if (state.phase !== "ready") {
      setStatusLine(state.phase === "error" ? "未就绪" : "自动启动中…", state.phase === "error" ? "error" : "busy");
      return;
    }
    const status = state.status;
    if (state.busy.sync) setStatusLine("正在同步…", "busy");
    else setStatusLine("已连接 · 只读归档", "ready");

    if (status) {
      const stats = status.stats || {};
      setSubtitle(`${Number(stats.conversations) || 0} 个归档会话 · ${fmtBytes(status.dbBytes)}`);
    }

    append(actions, [
      h(
        "button",
        {
          class: "btn",
          type: "button",
          disabled: state.busy.sync,
          onclick: () => {
            state.syncOpen = !state.syncOpen;
            renderHeader();
            renderSyncPanel();
          },
        },
        state.syncOpen ? "收起同步" : "同步",
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

  function renderNoBridge() {
    renderHeader();
    setStatusLine("桌面端可用", "idle");
    setSubtitle("浏览器预览里没有本机归档桥。");
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

  function renderStateCard() {
    const panel = el("state-panel");
    if (!panel) return;
    panel.classList.remove("hidden");
    for (const id of ["stats", "sources", "sync-panel", "tabs", "tab-content", "config-details"]) {
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
          { class: "btn btn-primary", type: "button", onclick: () => refreshAll({} ) },
          "重试",
        ),
      ),
    ]);
  }

  function renderStats() {
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

  function sourceRows() {
    const status = state.status;
    const config = (status && status.config) || {};
    const rows = [];
    const wechat = config.wechat || {};
    rows.push({
      label: "微信目录",
      path: wechat.db_dir || wechat.dbDir || "",
      detected: Boolean(wechat.detected || wechat.db_dir || wechat.dbDir),
      account: "",
      detectedText: wechat.detected ? "已识别" : "未找到",
    });
    const qq = config.qq || {};
    const qqntPath = qq.nt_db || qq.ntDb || "";
    rows.push({
      label: "QQNT 消息库",
      path: qqntPath,
      detected: Boolean(qq.detected || qq.nt_db || qq.ntDb),
      account: qq.nt_account || qq.ntAccount || "",
      detectedText: qq.detected || qq.nt_db || qq.ntDb ? "已识别" : "未找到",
    });
    const exportPath = qq.export_dir || qq.exportDir || "";
    const exportDetected = Boolean(qq.export_detected || qq.exportDetected || exportPath);
    rows.push({
      label: "QQ 导出目录",
      path: exportPath,
      detected: exportDetected,
      account: "",
      detectedText: exportDetected ? "已识别" : "未找到",
    });
    return rows;
  }

  async function copyText(text, button) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      try {
        const area = document.createElement("textarea");
        area.value = text;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        document.execCommand("copy");
        document.body.removeChild(area);
      } catch {
        return;
      }
    }
    if (button) {
      const original = button.textContent;
      button.textContent = "已复制";
      setTimeout(() => {
        button.textContent = original;
      }, 1200);
    }
  }

  function renderSources() {
    const node = el("sources");
    if (!node) return;
    clear(node);
    const status = state.status;
    if (!status) return;
    const rows = sourceRows();
    let pathsVisible = node.dataset.paths !== "hidden";
    append(node, [
      h(
        "div",
        { class: "source-row" },
        h("span", { class: "source-label", text: "采集来源" }),
        rows.map((row) =>
          h(
            "span",
            { class: "source-item" },
            `${row.label}：`,
            h("span", {
              class: row.detected ? "badge badge-ok" : "badge badge-bad",
              text: row.detectedText,
            }),
            row.account ? h("span", { class: "micro", text: row.account }) : null,
          ),
        ),
        h("button", {
          class: "link",
          type: "button",
          onclick: () => {
            pathsVisible = !pathsVisible;
            node.dataset.paths = pathsVisible ? "visible" : "hidden";
            renderSources();
          },
        }, pathsVisible ? "收起路径" : "查看路径"),
      ),
      pathsVisible
        ? h(
            "ul",
            { class: "source-paths" },
            rows.map((row) =>
              h(
                "li",
                {},
                h("span", { class: "path-name", text: row.label }),
                h("code", { text: row.path || "未配置" }),
                row.path
                  ? h("button", {
                      class: "link",
                      type: "button",
                      "aria-label": `复制${row.label}`,
                      onclick: (event) => copyText(row.path, event.currentTarget),
                    }, "复制")
                  : null,
              ),
            ),
          )
        : null,
      state.autoNote ? h("p", { class: "source-note", text: state.autoNote }) : null,
      !status.hasDb
        ? h("p", {
            class: "source-note",
            text: "该目录还没有归档库。先在「同步」里选择来源并开始采集；采集完成后这里会自动刷新。",
          })
        : null,
    ]);
    node.classList.remove("hidden");
  }

  function renderSyncPanel() {
    const node = el("sync-panel");
    if (!node) return;
    clear(node);
    if (state.phase !== "ready" || !state.syncOpen) {
      node.classList.add("hidden");
      return;
    }
    const status = state.status || {};
    const rows = sourceRows();
    const detected = rows.map((row) => row.detected);
    const qqDisabled = !detected[1] && !detected[2];
    const wechatDisabled = !detected[0];
    append(node, [
      h(
        "div",
        { class: "sync-row" },
        h("span", { class: "muted", text: "同步来源" }),
        h(
          "label",
          {},
          h("input", {
            type: "checkbox",
            checked: state.sync.qq,
            disabled: qqDisabled || state.busy.sync,
            onchange: (event) => {
              state.sync.qq = event.currentTarget.checked;
            },
          }),
          "QQ",
        ),
        h(
          "label",
          {},
          h("input", {
            type: "checkbox",
            checked: state.sync.wechat,
            disabled: wechatDisabled || state.busy.sync,
            onchange: (event) => {
              state.sync.wechat = event.currentTarget.checked;
            },
          }),
          "微信",
        ),
        h(
          "label",
          {},
          h("input", {
            type: "checkbox",
            checked: state.sync.full,
            disabled: state.busy.sync,
            onchange: (event) => {
              state.sync.full = event.currentTarget.checked;
            },
          }),
          "全量重扫",
        ),
        h(
          "label",
          {},
          h("input", {
            type: "checkbox",
            checked: state.sync.archive,
            disabled: state.busy.sync,
            onchange: (event) => {
              state.sync.archive = event.currentTarget.checked;
            },
          }),
          "导出知识库",
        ),
        h("span", { class: "muted", text: "·" }),
        h(
          "button",
          {
            class: "btn btn-primary btn-sm",
            type: "button",
            disabled: state.busy.sync,
            onclick: () => runSync({ sources: undefined }),
          },
          state.busy.sync ? "同步中…" : "开始同步",
        ),
      ),
      state.busy.sync ? h("div", { class: "progress" }, h("i")) : null,
      state.syncNote ? h("p", { class: "sync-tip", text: state.syncNote }) : null,
      h("p", { class: "sync-tip", text: "同步会写入归档库；检索与日程始终只读。归档数据只留在本机。" }),
      h("p", {
        class: "sync-tip",
        text: `本机归档：${fmtBytes((status && status.dbBytes) || 0)}${status && status.hasDb ? "" : "（尚未建立）"}`,
      }),
    ]);
    node.classList.remove("hidden");
  }

  function renderTabs() {
    const node = el("tabs");
    if (!node) return;
    clear(node);
    if (state.phase !== "ready") {
      node.classList.add("hidden");
      return;
    }
    const overdue = state.agenda && state.agenda.summary ? Number(state.agenda.summary.overdue) || 0 : 0;
    const tabs = [
      ["search", "检索", 0],
      ["chats", "会话", 0],
      ["agenda", "日程", overdue],
    ];
    append(
      node,
      tabs.map(([id, label, count]) =>
        h(
          "button",
          {
            class: "tab",
            type: "button",
            role: "tab",
            "aria-selected": String(state.tab === id),
            onclick: () => selectTab(id),
          },
          label,
          count > 0 ? h("span", { class: "tab-count", text: String(count) }) : null,
        ),
      ),
    );
    const status = state.status;
    const sources = (status && status.sources) || {};
    const statusNodes = ["qq", "wechat"].map((source) => {
      const info = sources[source] || {};
      return h(
        "span",
        {},
        `${SOURCE_LABELS[source]} `,
        h("span", { class: info.status === "error" ? "badge badge-bad" : "badge badge-warn", text: info.status || "未同步" }),
        info.lastRun ? ` · ${fmtLastRun(info.lastRun)}` : null,
      );
    });
    append(node, [h("span", { class: "source-status" }, statusNodes)]);
    node.classList.remove("hidden");
  }

  function renderConfig() {
    const node = el("config-details");
    if (!node) return;
    clear(node);
    const status = state.status;
    if (!status) return;
    const config = status.config || {};
    const flag = (value) => (value ? "启用" : "停用");
    const entries = [
      ["QQ", flag(config.qq && config.qq.enabled)],
      ["微信", flag(config.wechat && config.wechat.enabled)],
      ["语音转写", config.transcribe ? flag(config.transcribe.enabled) : "—"],
      ["议程摘要", config.summary ? flag(config.summary.enabled) : "—"],
      ["推送", config.push ? `${config.push.channel || "—"} / ${config.push.configured ? "凭据就绪" : "未配置"}` : "—"],
      ["知识库导出", config.kb ? flag(config.kb.enabled) : "—"],
    ];
    append(node, [
      h("summary", { text: "本机配置（已脱敏）" }),
      h(
        "div",
        { class: "config-grid" },
        entries.map(([label, value]) =>
          h("span", {}, h("span", { class: "muted", text: `${label}：` }), value),
        ),
      ),
      status.configPath ? h("p", { class: "config-path", text: `配置：${status.configPath}` }) : null,
      status.dbPath ? h("p", { class: "config-path", text: `归档：${status.dbPath}` }) : null,
    ]);
    node.classList.remove("hidden");
  }

  /* ────────────────────────── 检索页 ────────────────────────── */

  function renderSearchPane() {
    const pane = el("tab-search");
    if (!pane) return;
    clear(pane);
    const input = h("input", {
      class: "input",
      id: "search-input",
      type: "search",
      value: state.searchQuery,
      placeholder: "全文检索（FTS5 trigram）：人物、地点、单号…",
      "aria-label": "在归档中检索",
      oninput: (event) => {
        state.searchQuery = event.currentTarget.value;
      },
      onkeydown: (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          runSearch();
        }
      },
    });
    const results = h("div", { id: "search-results" });
    append(pane, [
      h(
        "form",
        {
          class: "search-form",
          onsubmit: (event) => {
            event.preventDefault();
            runSearch();
          },
        },
        input,
        h(
          "button",
          { class: "btn btn-primary", type: "submit", disabled: state.busy.search },
          state.busy.search ? "检索中…" : "检索",
        ),
      ),
      results,
    ]);
    renderSearchResults();
  }

  function renderSearchResults() {
    const node = el("search-results");
    if (!node) return;
    clear(node);
    const dbMissing = state.status && state.status.hasDb === false;
    if (state.searchError) {
      append(node, h("div", { class: "search-body" }, h("p", { class: "empty-desc", text: state.searchError })));
      return;
    }
    if (state.busy.search) {
      append(
        node,
        h(
          "div",
          { class: "search-body" },
          h(
            "div",
            { class: "skeleton" },
            [0, 1, 2].map(() =>
              h("div", { class: "skeleton-row" }, h("div", { class: "skeleton-line", style: "width:100%" })),
            ),
          ),
        ),
      );
      return;
    }
    if (!state.searchedFor) {
      append(
        node,
        h(
          "div",
          { class: "search-body" },
          h("p", { class: "empty-desc muted", text: "输入关键词后回车。检索只在本机归档内进行。" }),
          dbMissing ? h("p", { class: "empty-desc muted", text: "归档库还没建好，先到「同步」里采集一次。" }) : null,
        ),
      );
      return;
    }
    const result = state.searchResult;
    const items = (result && result.items) || [];
    if (!items.length) {
      append(node, h("div", { class: "search-body" }, h("p", { class: "empty-desc", text: `没有找到「${state.searchedFor}」` })));
      return;
    }
    append(
      node,
      h(
        "div",
        { class: "search-body" },
        h("p", { class: "hit-summary", text: `「${state.searchedFor}」命中 ${items.length} 条` }),
        h(
          "ul",
          { class: "hit-list" },
          items.map((hit) =>
            h(
              "li",
              { class: "hit" },
              h(
                "div",
                { class: "hit-meta" },
                h("span", { class: "hit-conv", text: hit.convName || "未命名会话" }),
                h("span", { class: "badge badge-warn", text: SOURCE_LABELS[hit.source] || hit.source || "" }),
                h("span", { class: "hit-time", text: fmtTime(hit.ts, true) }),
              ),
              h(
                "div",
                { class: "hit-text" },
                snippetNodes(String(hit.snippet || hit.content || "")),
              ),
              hit.senderName ? h("div", { class: "hit-sender micro", text: hit.senderName }) : null,
            ),
          ),
        ),
      ),
    );
  }

  async function runSearch() {
    const query = state.searchQuery.trim();
    if (!query) return;
    const seq = ++state.searchSeq;
    state.searchedFor = query;
    state.busy.search = true;
    state.searchError = "";
    renderSearchResults();
    try {
      const result = await infohubCall("search", { query, limit: SEARCH_LIMIT });
      if (seq !== state.searchSeq) return;
      state.searchResult = result || { items: [] };
    } catch (err) {
      if (seq !== state.searchSeq) return;
      state.searchError = errText(err);
    } finally {
      if (seq === state.searchSeq) {
        state.busy.search = false;
        renderSearchResults();
      }
    }
  }

  /* ────────────────────────── 日程页 ────────────────────────── */

  function renderAgendaPane() {
    const pane = el("tab-agenda");
    if (!pane) return;
    clear(pane);
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

  async function rebuildAgenda() {
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

  function avatarColor(name) {
    let hash = 0;
    for (const char of String(name || "")) hash = (hash * 31 + char.charCodeAt(0)) % 997;
    return AVATAR_COLORS[hash % AVATAR_COLORS.length];
  }

  function renderChatsPane() {
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
    const segment = h(
      "div",
      { class: "segment", role: "group", "aria-label": "会话来源" },
      [["", "全部"], ["qq", "QQ"], ["wechat", "微信"]].map(([value, label]) =>
        h(
          "button",
          {
            type: "button",
            "aria-pressed": String(state.chat.source === value),
            onclick: () => {
              if (state.chat.source === value) return;
              state.chat.source = value;
              reloadConversations();
            },
          },
          label,
        ),
      ),
    );
    append(pane, [
      h(
        "div",
        { class: "conv-pane" },
        h(
          "div",
          { class: "conv-toolbar" },
          segment,
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

  function renderConvList() {
    const list = el("conv-list");
    if (!list) return;
    clear(list);
    const metaText = el("conv-meta-text");
    const metaLoading = el("conv-meta-loading");
    const chat = state.chat;
    if (metaText) {
      metaText.textContent = `${chat.total} 个会话${chat.keyword || chat.source ? " · 已筛选" : ""}`;
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
        append(list, emptyBlock("归档库还没建好", "先在「同步」里采集一次，完成后列表会自动刷新。"));
      } else if (chat.keyword || chat.source) {
        append(list, emptyBlock("没有匹配的会话", "换个关键词或来源再试；筛选只作用于会话名和来源，不检索消息正文。"));
      } else {
        append(
          list,
          emptyBlock("归档里还没有会话", "先在「同步」里选择来源并开始采集；采集完成后列表会自动刷新。"),
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
              h("span", { class: "badge badge-warn", text: SOURCE_LABELS[conv.source] || conv.source || "" }),
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

  function emptyBlock(title, desc) {
    return h(
      "div",
      { class: "empty" },
      h("div", { class: "empty-title", text: title }),
      h("div", { class: "empty-desc", text: desc }),
    );
  }

  function renderMsgPane() {
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
        emptyBlock("选择一个会话", "从左侧选择会话；如果列表为空，先到「同步」里采集一次归档。"),
      );
      return;
    }
    append(head, [
      h("span", { class: "msg-head-name", text: conv.name || "未命名会话" }),
      h("span", { class: "badge badge-warn", text: SOURCE_LABELS[conv.source] || conv.source || "" }),
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
        append(stream, emptyBlock("这个会话没有消息", "归档库还没建好；先在「同步」里采集一次。"));
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
          !msg.is_self && !merged
            ? h("span", {
                class: "avatar avatar-sm",
                style: `background:${avatarColor(msg.sender_name || "?")}`,
                text: String(msg.sender_name || "?").slice(0, 1),
              })
            : null,
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

  async function reloadConversations(appendMore) {
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
      if (chat.source) params.source = chat.source;
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

  async function selectConversation(conv) {
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

  async function loadMessages(conv) {
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

  function dedupeMessages(items) {
    const map = new Map();
    for (const item of items) {
      if (item && item.id != null && !map.has(item.id)) map.set(item.id, item);
    }
    return [...map.values()].sort((a, b) => toMs(a.ts) - toMs(b.ts));
  }

  async function loadOlderMessages() {
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

  async function loadStatus() {
    const status = await infohubCall("status", {});
    state.status = status || null;
    return state.status;
  }

  async function loadAgenda() {
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
  function agendaHighlights(agenda) {
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

  function updateHomeCard() {
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
    // items 让卡片直接露出「接下来三项」，不用点进插件才知道今天有什么
    const items = agendaHighlights(agenda);
    try {
      Promise.resolve(widget.homeCardSet("infohub", { text, detail, items })).catch(() => {});
    } catch {
      /* 旧宿主没有 homeCardSet 时静默跳过 */
    }
  }

  async function notifySync(body) {
    if (!widget || typeof widget.notify !== "function") return;
    try {
      await Promise.resolve(widget.notify({ title: "信息中枢同步完成", body, level: "info" }));
    } catch {
      /* 通知权限缺失时忽略 */
    }
  }

  async function runSync(options) {
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
      showError("没有已识别的采集来源，先确认 QQ / 微信目录是否已检测到。");
      return;
    }
    params.sources = sources;
    const silent = Boolean(options && options.silent);
    state.busy.sync = true;
    state.syncNote = silent ? "归档为空，正在自动采集一次…" : "正在采集归档…";
    showError("");
    renderHeader();
    renderSyncPanel();
    try {
      const result = await infohubCall("sync", params, 30 * 60 * 1000);
      const reports = (result && result.reports) || [];
      const added = reports.reduce((sum, item) => sum + (Number(item.added) || 0), 0);
      const updated = reports.reduce((sum, item) => sum + (Number(item.updated) || 0), 0);
      const errors = reports.flatMap((item) => item.errors || []);
      const conversations = reports.reduce((sum, item) => sum + (Number(item.conversations) || 0), 0);
      state.syncNote = `采集完成：扫描 ${conversations} 个会话，新增 ${added} 条，更新 ${updated} 条消息。`;
      if (errors.length) showError(`部分来源采集失败：${errors.join("；")}`);
      if (!silent) {
        await notifySync(errors.length ? `${added} 条新增，${errors.length} 个错误` : `新增 ${added} 条，更新 ${updated} 条消息`);
      }
      await Promise.all([loadStatus(), loadAgenda()]);
      renderReady();
    } catch (err) {
      state.syncNote = "";
      showError(`采集失败：${errText(err)}`);
    } finally {
      state.busy.sync = false;
      state.syncNote = state.syncNote || "";
      renderHeader();
      renderSyncPanel();
      updateHomeCard();
    }
  }

  async function maybeAutoCollect() {
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
    if (last && Date.now() - last < AUTO_SYNC_COOLDOWN_MS) {
      state.autoNote = "归档为空；最近 10 分钟内已自动采集过，先不重复采集。";
      return;
    }
    try {
      await widget.dataSet("autoSyncAt", Date.now());
    } catch {
      /* 数据目录不可写时仍然允许采集 */
    }
    state.autoNote = "归档为空，正在后台自动采集一次；之后可在「同步」里手动刷新。";
    renderSources();
    renderHeader();
    await runSync({ sources, silent: true });
    state.autoNote = "自动采集完成；之后可在「同步」里手动刷新。";
    renderSources();
  }

  /* ────────────────────────── 主流程 ────────────────────────── */

  function renderReady() {
    const panel = el("state-panel");
    if (panel) panel.classList.add("hidden");
    renderStats();
    renderSources();
    renderSyncPanel();
    renderTabs();
    renderConfig();
    renderChromeForReady();
  }

  function renderChromeForReady() {
    renderHeader();
    const content = el("tab-content");
    if (content) content.classList.remove("hidden");
    for (const id of ["tab-search", "tab-chats", "tab-agenda"]) {
      const node = el(id);
      if (node) node.classList.add("hidden");
    }
    const current = el(`tab-${state.tab}`);
    if (current) current.classList.remove("hidden");
    if (state.tab === "search") renderSearchPane();
    else if (state.tab === "chats") renderChatsPane();
    else renderAgendaPane();
  }

  function selectTab(tab) {
    state.tab = tab;
    renderTabs();
    renderChromeForReady();
  }

  async function refreshAll(options) {
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
   *   这里三个页签与 intent 同名映射；未知 intent 一律回落默认页签，
   *   免得以后改了页签名、旧卡片把页面点成空白。
   */
  const TAB_INTENTS = new Set(["search", "chats", "agenda"]);

  function intentFromHash() {
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

  function boot() {
    applyTheme();
    // 从首页卡「检索归档 / 全部日程」点进来时，直接落在对应页签
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
    refreshAll({});
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
