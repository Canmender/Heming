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

  /* ── AI 日程识别（d.140）：单批体积/条数上限，避免一次塞爆上下文 ── */
  const AI_DAYS = [7, 14, 30];
  const AI_BATCH_CHARS = 2600;
  const AI_BATCH_MESSAGES = 22;
  const AI_MAX_BATCHES = 12;
  const AI_MAX_CONVS = 60;
  const AI_MAX_MSGS_PER_CONV = 120;
  const AI_MAX_ITEMS = 80;
  const AI_KINDS = [
    ["task", "任务"],
    ["meeting", "会议"],
    ["activity", "活动"],
    ["exam", "考试"],
    ["signup", "报名"],
    ["payment", "缴费"],
    ["other", "其他"],
  ];
  const AI_KIND_LABELS = Object.fromEntries(AI_KINDS);
  const AI_PROFILE_PLACEHOLDER =
    "例：我是付梓杨，在 XX 大学读研，群里叫我「小付」。只关心课程/组会/实习/社团活动与缴费截止；广告、闲聊、抽奖一律忽略。";

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
    /* AI 日程识别：身份提示词、范围、来源、模型与可编辑结果（结果只存插件私有目录，不写回日程库） */
    ai: {
      loaded: false,
      profile: "",
      allowSend: false,
      days: 14,
      sources: { qq: true, wechat: true },
      gateway: null,
      models: [],
      model: "",
      error: "",
      note: "",
      running: false,
      stage: "",
      done: 0,
      total: 0,
      items: [],
      savedAt: 0,
      seq: 0,
      controller: null,
      prefTimer: 0,
      itemsTimer: 0,
    },
    autoTried: false,
  };

  const el = (id) => document.getElementById(id);

  /* ────────────────────────── DOM 工具 ────────────────────────── */

  function append(node, children) {
    if (children == null || children === false) return;
    // 兼容 append(node, 单个节点) 的写法：Node / 字符串都不能直接 for...of
    const list = Array.isArray(children) ? children : [children];
    for (const child of list) {
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
    renderAiPane(pane);
  }

  /* 规则抽取的日程：作为 AI 结果下方的「备用」折叠区保留；不需要模型、不联网 */
  function renderRuleAgenda(pane) {
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

  const AI_SOURCES = [
    ["qq", "QQ"],
    ["wechat", "微信"],
  ];

  /* ── 提示词与模型调用 ── */

  function aiSystemPrompt() {
    const now = new Date();
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const weekday = "日一二三四五六"[now.getDay()];
    const profile = String(state.ai.profile || "").trim();
    const lines = [
      "你是「信息中枢」的日程识别助手：从 QQ / 微信聊天记录里找出真正需要我处理或参加的事，整理成结构化列表。",
      `今天是 ${stamp}（星期${weekday}）。`,
      "判断标准：",
      "1. 只有出现明确日期、时间或期限，或者双方约定了要做的事，才算事项；闲聊、新闻、广告、表情、寒暄一律忽略。",
      "2. 相对时间（明天、周五、下周三、月底）必须换算成绝对日期；只有日期没有时刻时把 allDay 设为 true。",
      "3. 已经做完的旧事（例如「昨天已经交了」）不要提取，除非还能推出后续待办。",
      "4. 每条给出 detail（一句依据，不超过 60 字）与 ref（来源消息开头那串数字 id）。",
      "5. 同一件事在多条消息里出现只保留一条，合并信息；时间实在不确定就留空字符串。",
      "输出要求：只输出 JSON 数组，不要 markdown 代码块，也不要解释。没有事项就输出 []。",
      '每条字段：{"title":"事项（不超过 24 字，动宾短语）","due":"YYYY-MM-DD HH:mm 或 YYYY-MM-DD 或空字符串","allDay":false,"kind":"task|meeting|activity|exam|signup|payment|other","ref":"消息 id","detail":"依据","confidence":0.0}',
    ];
    if (profile) lines.push(`我的身份与语境（用户提供，用来判断哪些事与我有关）：${profile}`);
    return lines.join("\n");
  }

  function aiAbortError() {
    if (typeof DOMException === "function") return new DOMException("已停止", "AbortError");
    const err = new Error("已停止");
    err.name = "AbortError";
    return err;
  }

  /* 把网关的 SSE 响应拼成纯文本（少数网关忽略 stream:false） */
  function sseText(raw) {
    let out = "";
    for (const line of String(raw || "").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const chunk = JSON.parse(payload);
        const choice = chunk && Array.isArray(chunk.choices) ? chunk.choices[0] : null;
        const delta = choice && (choice.delta || choice.message);
        if (delta && typeof delta.content === "string") out += delta.content;
      } catch (err) {
        /* 单行坏数据不影响其它行 */
      }
    }
    return out;
  }

  async function gatewayChat(messages, signal, maxTokens) {
    const ai = state.ai;
    const gateway = ai.gateway;
    if (!gateway || !gateway.baseUrl) throw new Error("还没有可用的模型网关，请先在「设置 → 模型」里配置供应商");
    const url = `${String(gateway.baseUrl).replace(/\/+$/, "")}/chat/completions`;
    const resp = await fetch(url, {
      method: "POST",
      signal: signal || undefined,
      headers: { "content-type": "application/json", authorization: `Bearer ${gateway.key || "local"}` },
      body: JSON.stringify({
        model: ai.model,
        stream: false,
        max_tokens: maxTokens || 1200,
        messages,
      }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`模型接口 HTTP ${resp.status}${body ? `：${body.slice(0, 160)}` : ""}`);
    }
    const type = resp.headers && typeof resp.headers.get === "function" ? resp.headers.get("content-type") || "" : "";
    const text = await resp.text();
    if (type.includes("event-stream") || /^\s*data:/.test(text)) return sseText(text);
    let data = null;
    try {
      data = JSON.parse(text);
    } catch (err) {
      throw new Error("模型返回的不是 JSON，请确认网关提供 OpenAI 兼容接口");
    }
    if (data && data.error) {
      throw new Error(typeof data.error === "string" ? data.error : JSON.stringify(data.error).slice(0, 160));
    }
    const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
    const content = choice && choice.message ? choice.message.content : "";
    if (typeof content !== "string" || !content.trim()) throw new Error("模型没有返回内容");
    return content;
  }

  /* ── 候选消息收集 ── */

  function aiMessageText(message) {
    const raw = message && message.content != null ? message.content : "";
    return String(raw).replace(/\s+/g, " ").trim();
  }

  function aiSkipMessage(message) {
    const text = aiMessageText(message);
    if (!text) return true;
    if (/^\[(媒体|图片|视频|语音|文件|表情|动画表情)/.test(text)) return true;
    if (message.is_self && text.length < 6) return true;
    return false;
  }

  function aiConvLabel(conv) {
    const name = (conv && (conv.name || conv.id)) || "未知会话";
    const source = (conv && (SOURCE_LABELS[conv.source] || conv.source)) || "未知来源";
    return `${name}｜${source}`;
  }

  async function fetchConvMessages(conversationId, sinceMs, signal) {
    const out = [];
    let beforeTs = 0;
    for (let page = 0; page < 3; page += 1) {
      if (signal && signal.aborted) throw aiAbortError();
      const params = { conversationId, limit: 400 };
      if (beforeTs) params.beforeTs = beforeTs;
      const payload = await infohubCall("messages", params, 120000);
      const rows = (payload && payload.items) || [];
      for (const row of rows) {
        const ts = toMs(row.ts);
        if (ts && ts < sinceMs) continue;
        if (aiSkipMessage(row)) continue;
        out.push(row);
      }
      if (!payload || !payload.hasMore || !rows.length) break;
      beforeTs = Number(payload.beforeTs) || toMs(rows[0].ts);
      if (!beforeTs) break;
      if (out.length >= AI_MAX_MSGS_PER_CONV) break;
    }
    out.sort((a, b) => toMs(a.ts) - toMs(b.ts));
    return out.slice(-AI_MAX_MSGS_PER_CONV);
  }

  async function collectAiCandidates(sinceMs, sources, signal) {
    const picked = [];
    const seen = new Set();
    for (const [source] of AI_SOURCES) {
      if (!sources[source]) continue;
      if (signal && signal.aborted) throw aiAbortError();
      const page = await infohubCall("conversations", { source, limit: CONV_PAGE }, 120000);
      const rows = (page && page.items) || [];
      const fresh = rows
        .filter((row) => row && String(row.id || "").trim() && toMs(row.last_ts) >= sinceMs && !seen.has(row.id))
        .sort((a, b) => toMs(b.last_ts) - toMs(a.last_ts));
      for (const row of fresh) {
        if (picked.length >= AI_MAX_CONVS) break;
        seen.add(row.id);
        picked.push(row);
      }
    }
    picked.sort((a, b) => toMs(b.last_ts) - toMs(a.last_ts));
    const batch = [];
    const lookup = new Map();
    let messageCount = 0;
    for (const conv of picked) {
      if (signal && signal.aborted) throw aiAbortError();
      const messages = await fetchConvMessages(conv.id, sinceMs, signal);
      if (!messages.length) continue;
      for (const message of messages) lookup.set(String(message.id), aiConvLabel(conv));
      messageCount += messages.length;
      batch.push({ conv, messages });
    }
    return { batch, lookup, messageCount, convCount: batch.length };
  }

  function aiConversationText(batch) {
    const lines = [];
    for (const entry of batch) {
      lines.push(`【${aiConvLabel(entry.conv)}】`);
      for (const message of entry.messages) {
        const sender = message.sender_name || message.senderName || "?";
        lines.push(`${message.id}|${fmtTime(message.ts, true)}|${sender}|${aiMessageText(message)}`);
      }
    }
    return lines;
  }

  /* 把「群名 + 消息行」按体积与条数切成若干批，保证每批都带上下文标题 */
  function buildAiBatches(batch) {
    const flat = [];
    for (const line of aiConversationText(batch)) {
      flat.push({ header: line.startsWith("【"), text: line });
    }
    const batches = [];
    let lines = [];
    let chars = 0;
    let count = 0;
    let pendingHeader = "";
    const flush = () => {
      if (!count) return;
      batches.push({ text: lines.join("\n"), messages: count });
      lines = [];
      chars = 0;
      count = 0;
    };
    for (const row of flat) {
      if (row.header) {
        pendingHeader = row.text;
        continue;
      }
      if (count >= AI_BATCH_MESSAGES || (chars + row.text.length > AI_BATCH_CHARS && count > 0)) {
        flush();
        if (pendingHeader) {
          lines.push(pendingHeader);
          chars += pendingHeader.length;
        }
      }
      if (!lines.length && pendingHeader) {
        lines.push(pendingHeader);
        chars += pendingHeader.length;
      }
      lines.push(row.text);
      chars += row.text.length;
      count += 1;
    }
    flush();
    return batches.slice(0, AI_MAX_BATCHES);
  }

  /* ── 模型输出解析与归一 ── */

  function aiParseJsonArray(content) {
    let text = String(content || "").trim();
    if (!text) return [];
    if (text.startsWith("```")) text = text.replace(/^```[a-zA-Z]*\s*/, "").replace(/```\s*$/, "").trim();
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start >= 0 && end > start) {
      text = text.slice(start, end + 1);
    } else if (text.startsWith("{")) {
      const objStart = text.indexOf("{");
      const objEnd = text.lastIndexOf("}");
      if (objStart >= 0 && objEnd > objStart) text = text.slice(objStart, objEnd + 1);
    }
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      try {
        parsed = JSON.parse(text.replace(/,\s*([}\]])/g, "$1"));
      } catch (err2) {
        throw new Error("模型返回的内容不是合法 JSON 数组，可换一个模型再试");
      }
    }
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.items)) return parsed.items;
    if (parsed && Array.isArray(parsed.events)) return parsed.events;
    if (parsed && Array.isArray(parsed.data)) return parsed.data;
    return [];
  }

  function normalizeAiItem(raw) {
    if (!raw || typeof raw !== "object") return null;
    const title = String(raw.title || raw.name || raw.summary || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 24);
    if (!title) return null;
    let dueMs = NaN;
    let dateOnly = false;
    const due = raw.due != null ? raw.due : raw.time != null ? raw.time : raw.when;
    if (typeof due === "number") {
      dueMs = toMs(due);
    } else if (typeof due === "string" && due.trim()) {
      const text = due.trim();
      // 只有日期（没有时刻）时按本地零点解析，别落成 UTC 零点而整体偏 8 小时
      if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
        const parts = text.split("-").map(Number);
        const day = new Date(parts[0], parts[1] - 1, parts[2], 0, 0, 0, 0);
        if (!Number.isNaN(day.getTime())) {
          dueMs = day.getTime();
          dateOnly = true;
        }
      } else {
        const clock = text.match(/(\d{1,2}):(\d{2})/);
        if (clock && /^\d{4}[-/]\d{2}[-/]\d{2}/.test(text)) {
          const day = new Date(text.replace(/\//g, "-").slice(0, 10) + `T${pad(Number(clock[1]) || 0)}:${clock[2]}:00`);
          if (!Number.isNaN(day.getTime())) dueMs = day.getTime();
        }
      }
      if (!Number.isFinite(dueMs)) {
        const parsed = Date.parse(text.replace(/\//g, "-"));
        if (Number.isFinite(parsed)) dueMs = parsed;
      }
    }
    if (!(Number.isFinite(dueMs) && dueMs > 0)) dueMs = NaN;
    const allDay = raw.allDay === true || raw.all_day === true || (dateOnly && Number.isFinite(dueMs));
    const kindRaw = String(raw.kind || raw.type || "").toLowerCase();
    const kind = AI_KIND_LABELS[kindRaw] ? kindRaw : "other";
    const detail = String(raw.detail || raw.evidence || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
    const ref = String(raw.ref || raw.id || "").trim().slice(0, 24);
    const confidence = Number(raw.confidence);
    return {
      title,
      dueMs,
      allDay: allDay && Number.isFinite(dueMs),
      kind,
      detail,
      ref,
      source: "",
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    };
  }

  function aiItemKey(item) {
    const due = Number.isFinite(item.dueMs) ? String(Math.round(item.dueMs / 60000)) : "0";
    return `${String(item.title).replace(/\s+/g, "")}|${due}`;
  }

  function sortAiItems(items) {
    return items.slice().sort((a, b) => {
      const left = Number.isFinite(a.dueMs) ? a.dueMs : Infinity;
      const right = Number.isFinite(b.dueMs) ? b.dueMs : Infinity;
      if (left !== right) return left - right;
      return String(a.title).localeCompare(String(b.title), "zh-Hans-CN");
    });
  }

  function mergeAiItems(existing, incoming) {
    const map = new Map();
    for (const item of existing) map.set(aiItemKey(item), item);
    for (const item of incoming) {
      const key = aiItemKey(item);
      const prev = map.get(key);
      map.set(
        key,
        prev
          ? {
              ...prev,
              ...item,
              detail: item.detail || prev.detail,
              ref: item.ref || prev.ref,
              source: prev.source || item.source,
            }
          : item,
      );
    }
    return sortAiItems([...map.values()]).slice(0, AI_MAX_ITEMS);
  }

  /* ── 本地存取（插件私有目录，不写回日程库） ── */

  function aiPlainItem(item) {
    return {
      title: String(item.title || "").slice(0, 24),
      dueMs: Number.isFinite(item.dueMs) ? item.dueMs : 0,
      allDay: Boolean(item.allDay),
      kind: AI_KIND_LABELS[item.kind] ? item.kind : "other",
      detail: String(item.detail || "").slice(0, 120),
      ref: String(item.ref || "").slice(0, 24),
      source: String(item.source || "").slice(0, 60),
      confidence: Number(item.confidence) || 0,
    };
  }

  function aiStoredItem(raw) {
    if (!raw || typeof raw !== "object") return null;
    const item = normalizeAiItem({ title: raw.title, due: raw.dueMs, allDay: raw.allDay, kind: raw.kind, detail: raw.detail, ref: raw.ref });
    if (!item) return null;
    item.source = String(raw.source || "");
    item.confidence = Number(raw.confidence) || 0;
    return item;
  }

  async function aiSaveItems() {
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

  function aiSaveItemsSoon() {
    const ai = state.ai;
    if (ai.itemsTimer) clearTimeout(ai.itemsTimer);
    ai.itemsTimer = setTimeout(() => {
      ai.itemsTimer = 0;
      aiSaveItems();
    }, 700);
  }

  async function aiSavePrefs() {
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

  function aiSavePrefsSoon() {
    const ai = state.ai;
    if (ai.prefTimer) clearTimeout(ai.prefTimer);
    ai.prefTimer = setTimeout(() => {
      ai.prefTimer = 0;
      aiSavePrefs();
    }, 600);
  }

  async function loadAiPrefs() {
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

  async function loadAiRuntime() {
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

  async function refreshAiRuntime() {
    state.ai.error = "";
    await loadAiRuntime();
    renderAgendaPane();
  }

  /* ── 识别主流程 ── */

  async function runAiScan() {
    const ai = state.ai;
    if (ai.running) return;
    if (!state.status) {
      ai.error = "归档引擎还没就绪，先完成一次采集。";
      renderAgendaPane();
      return;
    }
    if (!ai.gateway) {
      ai.error = "没有可用的模型网关：请先在主窗口「设置 → 模型」里配置供应商。";
      renderAgendaPane();
      return;
    }
    if (!ai.model) {
      ai.error = "还没有选择模型。";
      renderAgendaPane();
      return;
    }
    if (!ai.allowSend) {
      ai.error = "先勾选「允许把最近聊天的原文发送给模型供应商」，再开始识别。";
      renderAgendaPane();
      return;
    }
    const seq = ai.seq + 1;
    ai.seq = seq;
    ai.controller = typeof AbortController === "function" ? new AbortController() : null;
    ai.running = true;
    ai.error = "";
    ai.note = "";
    ai.done = 0;
    ai.total = 0;
    ai.stage = "读取归档";
    renderAgendaPane();
    const signal = ai.controller ? ai.controller.signal : null;
    const sinceMs = Date.now() - ai.days * 24 * 60 * 60 * 1000;
    let scanned = 0;
    const beforeCount = ai.items.length;
    try {
      const collected = await collectAiCandidates(sinceMs, ai.sources, signal);
      if (ai.seq !== seq) return;
      scanned = collected.messageCount;
      if (!collected.batch.length) {
        ai.note = `最近 ${ai.days} 天没有可识别的消息。`;
        return;
      }
      const batches = buildAiBatches(collected.batch);
      if (!batches.length) {
        ai.note = "没有能塞进一次请求的消息。";
        return;
      }
      ai.total = batches.length;
      ai.stage = "请模型识别";
      renderAgendaPane();
      for (let index = 0; index < batches.length; index += 1) {
        if (ai.seq !== seq) return;
        ai.stage = `识别第 ${index + 1}/${batches.length} 批`;
        updateAiProgress();
        const content = await gatewayChat(
          [
            { role: "system", content: aiSystemPrompt() },
            {
              role: "user",
              content: `以下是 QQ / 微信聊天记录，每行格式为「消息 id|时间|发送者|内容」。请找出最近 ${ai.days} 天内需要我处理或参加的事，按约定输出 JSON 数组。\n\n${batches[index].text}`,
            },
          ],
          signal,
          1200,
        );
        if (ai.seq !== seq) return;
        const rows = aiParseJsonArray(content);
        const parsed = [];
        for (const row of rows) {
          const item = normalizeAiItem(row);
          if (!item) continue;
          if (item.ref && collected.lookup.has(item.ref)) item.source = collected.lookup.get(item.ref);
          parsed.push(item);
        }
        if (parsed.length) {
          ai.items = mergeAiItems(ai.items, parsed);
          ai.savedAt = Date.now();
          aiSaveItemsSoon();
        }
        ai.done = index + 1;
        updateAiProgress();
      }
      ai.items = sortAiItems(ai.items).slice(0, AI_MAX_ITEMS);
      ai.savedAt = Date.now();
      await aiSaveItems();
      ai.stage = "";
      ai.note = `扫了 ${collected.convCount} 个会话 / ${scanned} 条消息，本次新增 ${Math.max(0, ai.items.length - beforeCount)} 条，表格共 ${ai.items.length} 条。结果只在本机，可编辑后导出。`;
      updateHomeCard();
    } catch (err) {
      if (err && err.name === "AbortError") {
        ai.note = "已停止识别，已完成的部分保留。";
      } else {
        ai.error = `识别失败：${errText(err)}`;
      }
    } finally {
      if (ai.seq === seq) {
        ai.running = false;
        ai.controller = null;
        ai.stage = "";
        ai.done = 0;
        ai.total = 0;
        renderAgendaPane();
      }
    }
  }

  function stopAiScan() {
    const ai = state.ai;
    if (!ai.running) return;
    ai.seq += 1;
    if (ai.controller) {
      try {
        ai.controller.abort();
      } catch (err) {
        /* 忽略 */
      }
    }
    ai.controller = null;
    ai.running = false;
    ai.stage = "";
    ai.done = 0;
    ai.total = 0;
    ai.note = "已停止识别，已完成的部分保留。";
    renderAgendaPane();
  }

  function updateAiProgress() {
    const ai = state.ai;
    const fill = el("ai-progress-fill");
    const text = el("ai-progress-text");
    if (fill) fill.style.width = `${ai.total ? Math.round((ai.done / ai.total) * 100) : 0}%`;
    if (text) text.textContent = `${ai.stage} · ${ai.done}/${ai.total || "?"} 批 · 已识别 ${ai.items.length} 条`;
  }

  /* ── 渲染 ── */

  function aiKindLabel(kind) {
    return AI_KIND_LABELS[kind] || "其他";
  }

  function aiInputValue(ms) {
    if (!Number.isFinite(ms)) return "";
    const day = new Date(ms);
    return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}T${pad(day.getHours())}:${pad(day.getMinutes())}`;
  }

  function aiParseLocal(value) {
    const text = String(value || "").trim();
    if (!text) return NaN;
    const ms = Date.parse(text);
    return Number.isFinite(ms) ? ms : NaN;
  }

  function aiModelLabel() {
    const ai = state.ai;
    if (!ai.model) return "未选择模型";
    const hit = ai.models.find((item) => item.id === ai.model);
    return (hit && hit.name) || ai.model;
  }

  /* 首页卡只取前三条（按时间排序后的结果），比纯规则抽取更贴近用户关心的事 */
  function aiHighlights() {
    const lines = [];
    for (const item of state.ai.items) {
      if (!item || !item.title) continue;
      const when = Number.isFinite(item.dueMs)
        ? item.allDay
          ? formatDayLabel(item.dueMs)
          : `${formatDayLabel(item.dueMs)} ${fmtClock(item.dueMs)}`.trim()
        : "";
      const line = when ? `${when} · ${item.title}` : String(item.title);
      lines.push(line.length > 40 ? `${line.slice(0, 39)}…` : line);
      if (lines.length >= 3) break;
    }
    return lines;
  }

  function aiResultsMeta(items) {
    const todayStart = startOfDay(Date.now());
    const tomorrow = todayStart + 24 * 60 * 60 * 1000;
    let overdue = 0;
    let today = 0;
    for (const item of items) {
      if (!Number.isFinite(item.dueMs)) continue;
      if (item.dueMs < todayStart) overdue += 1;
      else if (item.dueMs < tomorrow) today += 1;
    }
    return { overdue, today };
  }

  function aiCsvCell(value) {
    const text = String(value == null ? "" : value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function aiTsv(items) {
    const rows = [["时间", "事项", "类型", "来源", "依据"]];
    for (const item of items) {
      rows.push([
        Number.isFinite(item.dueMs) ? (item.allDay ? formatDayLabel(item.dueMs) : `${formatDayLabel(item.dueMs)} ${fmtClock(item.dueMs)}`) : "未定",
        item.title,
        aiKindLabel(item.kind),
        item.source || "",
        item.detail || "",
      ]);
    }
    return rows.map((row) => row.map((cell) => String(cell).replace(/[\t\r\n]+/g, " ")).join("\t")).join("\n");
  }

  function aiCsv(items) {
    const rows = [["时间", "事项", "类型", "来源", "依据"]];
    for (const item of items) {
      rows.push([
        Number.isFinite(item.dueMs) ? fmtTime(item.dueMs, true) : "未定",
        item.title,
        aiKindLabel(item.kind),
        item.source || "",
        item.detail || "",
      ]);
    }
    return `\ufeff${rows.map((row) => row.map(aiCsvCell).join(",")).join("\r\n")}`;
  }

  function exportAiCsv(items) {
    if (!items.length) return;
    try {
      const blob = new Blob([aiCsv(items)], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `日程-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (err) {
      showError(`导出失败：${errText(err)}；可以改用「复制表格」。`);
    }
  }

  function clearAiItems() {
    const ai = state.ai;
    if (!ai.items.length) return;
    ai.items = [];
    ai.savedAt = 0;
    ai.note = "已清空识别结果。";
    aiSaveItems();
    updateHomeCard();
    renderAgendaPane();
  }

  function aiSettingsNode() {
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

    const sourceButtons = AI_SOURCES.map(([key, label]) =>
      h(
        "button",
        {
          type: "button",
          "aria-pressed": String(Boolean(ai.sources[key])),
          onclick: () => {
            ai.sources[key] = !ai.sources[key];
            renderAgendaPane();
          },
        },
        label,
      ),
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
        h(
          "div",
          { class: "ai-control" },
          h("span", { class: "micro", text: "来源" }),
          h("span", { class: "segment ai-segment" }, sourceButtons),
        ),
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

  function aiProgressNode() {
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

  function aiRow(item, index) {
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
        { class: "ai-meta" },
        h("div", { class: "ai-source", text: item.source || "—" }),
        item.ref ? h("div", { class: "micro", text: `消息 ${item.ref}` }) : null,
      ),
      h("td", { class: "ai-detail", text: item.detail || "—" }),
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

  function renderAiResults() {
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
            h("tr", null, ["时间", "事项", "类型", "来源", "依据", ""].map((label) => h("th", { text: label }))),
          ),
          h("tbody", null, items.map((item, index) => aiRow(item, index))),
        ),
      ),
    );
  }

  function renderAiRules() {
    const holder = h("div", { class: "ai-rules-body" });
    renderRuleAgenda(holder);
    return h(
      "details",
      { class: "ai-rules" },
      h("summary", { text: "规则抽取的日程（备用，不需要模型）" }),
      holder,
    );
  }

  function renderAiPane(pane) {
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
    // items 让卡片直接露出「接下来三项」：优先 AI 识别结果，没有 AI 结果时回落到规则抽取
    const aiItems = aiHighlights();
    const items = aiItems.length ? aiItems : agendaHighlights(agenda);
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

  async function boot() {
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
    // 先恢复身份提示词、范围与上次结果，再拉状态与日程，避免日程页闪一下空表格
    await loadAiPrefs();
    refreshAll({});
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
