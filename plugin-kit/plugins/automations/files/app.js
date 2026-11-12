/**
 * 自动化 · 页面脚本（沙箱 bundle 版）
 *
 * 运行环境：宿主 widget 视图（`widget://<pluginId>/files/index.html`），
 * 通过 `window.__heming_widget` 使用宿主桥；在普通浏览器里打开时降级成
 * localStorage（仅能查看/编辑，不会执行计划——计划由 background 隐藏页执行）。
 *
 * 只做三件事：渲染页面、手动运行任务、把任务/运行记录存进插件 data。
 * 定时调度、失败通知与首页卡片刷新由 `files/background.js` 负责。
 */
(function () {
  "use strict";

  /* ── 存储键与上限 ─────────────────────────────────────────── */
  const TASKS_KEY = "automations.tasks.v1";
  const RUNS_KEY = "automations.runs.v1";
  const TASKS_BYTE_LIMIT = 256 * 1024;
  const RUNS_BYTE_LIMIT = 192 * 1024;
  const LOCAL_PREFIX = "automations:";

  /* ── 轮询节奏 ─────────────────────────────────────────────── */
  const POLL_MS = 10000; // 页面重新读插件 data（后台任务/手动运行都会改它）
  const PROBE_MS = 30000; // 探测信息中枢连接态

  /* ── 信息中枢动作参数（与 web 端 store 的 AGENDA_DAYS/AGENDA_OVERDUE 一致） */
  const AGENDA_DAYS = 14;
  const AGENDA_OVERDUE = 30;
  const INFOHUB_OFFLINE = "信息中枢未连接，本任务未执行；请先安装并连接信息中枢";

  /* ── 动作定义（与旧 built-in 模块的 kinds.ts 一致）──────────── */
  const AUTOMATION_KINDS = ["infohub.sync", "infohub.agenda"];
  const AUTOMATION_KIND_META = [
    {
      kind: "infohub.sync",
      label: "同步本机归档",
      defaultName: "同步本机归档",
      hasSyncParams: true,
      summary: "把 QQ / 微信的聊天记录同步到本机归档",
    },
    {
      kind: "infohub.agenda",
      label: "重扫日程",
      defaultName: "重扫日程",
      hasSyncParams: false,
      summary: "重扫本机归档的日程表",
    },
  ];

  /* ── 模型常量 ─────────────────────────────────────────────── */
  const MAX_AUTOMATIONS = 20;
  const MAX_NAME_CHARS = 40;
  const MAX_DETAIL_CHARS = 160;
  const MIN_INTERVAL_MINUTES = 5;
  const MAX_INTERVAL_MINUTES = 1440;
  const ALL_WEEKDAYS = [1, 2, 3, 4, 5, 6, 0];
  const WEEKDAY_LABEL = { 1: "一", 2: "二", 3: "三", 4: "四", 5: "五", 6: "六", 0: "日" };
  const DEFAULT_SYNC = { sources: ["qq", "wechat"], full: false, archive: false };

  /* ══ 宿主桥 ═══════════════════════════════════════════════ */

  function hostApi() {
    try {
      const bridge = window.__heming_widget;
      return bridge && typeof bridge === "object" ? bridge : null;
    } catch (err) {
      return null;
    }
  }

  function hasHost() {
    return hostApi() !== null;
  }

  function hasInfohubBridge() {
    const bridge = hostApi();
    return Boolean(bridge && typeof bridge.infohubCall === "function");
  }

  async function hostInfo() {
    const bridge = hostApi();
    if (!bridge || typeof bridge.info !== "function") {
      return { pluginId: "heming.automations", pluginName: "自动化", appVersion: "dev", theme: "dark" };
    }
    try {
      const info = await bridge.info();
      return info && typeof info === "object" ? info : {};
    } catch (err) {
      return {};
    }
  }

  function logLine(line) {
    const bridge = hostApi();
    if (!bridge || typeof bridge.log !== "function") return;
    try {
      bridge.log(`[automations] ${clipText(line, 480)}`);
    } catch (err) {
      /* 日志失败不影响功能 */
    }
  }

  function onHostEvent(handler) {
    const bridge = hostApi();
    if (!bridge || typeof bridge.onEvent !== "function") return;
    try {
      bridge.onEvent(handler);
    } catch (err) {
      logLine(`订阅宿主事件失败：${errText(err)}`);
    }
  }

  async function readKey(key) {
    const bridge = hostApi();
    if (bridge && typeof bridge.dataGet === "function") {
      try {
        return await bridge.dataGet(key);
      } catch (err) {
        logLine(`读取 ${key} 失败：${errText(err)}`);
        return null;
      }
    }
    try {
      const raw = window.localStorage.getItem(LOCAL_PREFIX + key);
      return raw === null ? null : JSON.parse(raw);
    } catch (err) {
      return null;
    }
  }

  async function writeKey(key, value) {
    const bridge = hostApi();
    if (bridge && typeof bridge.dataSet === "function") {
      await bridge.dataSet(key, value);
      return;
    }
    window.localStorage.setItem(LOCAL_PREFIX + key, JSON.stringify(value));
  }

  async function infohubCall(method, params, options) {
    const bridge = hostApi();
    if (!bridge || typeof bridge.infohubCall !== "function") {
      throw new Error(INFOHUB_OFFLINE);
    }
    return bridge.infohubCall(method, params, options);
  }

  async function pushNotify(payload) {
    const bridge = hostApi();
    if (!bridge || typeof bridge.notify !== "function") {
      logLine(`通知：${payload.title}${payload.body ? ` — ${payload.body}` : ""}`);
      return;
    }
    try {
      await bridge.notify(payload);
    } catch (err) {
      logLine(`发送通知失败：${errText(err)}`);
    }
  }

  async function publishHomeCard() {
    const bridge = hostApi();
    if (!bridge || typeof bridge.homeCardSet !== "function") return;
    const enabled = state.tasks.filter((task) => task.enabled);
    const next = enabled.slice().sort((a, b) => a.nextRunAt - b.nextRunAt)[0];
    const last = state.runs[0];
    const patch = {
      text: next ? `下一次 ${formatAutomationTime(next.nextRunAt)}` : "还没有自动化任务",
      detail: last
        ? `上次 ${runStatusLabel(last.status)} · ${formatAutomationTime(last.finishedAt)}`
        : "还没有运行记录",
      badge: `${enabled.length} 个启用`,
    };
    try {
      await bridge.homeCardSet("automations", patch);
    } catch (err) {
      logLine(`更新首页卡片失败：${errText(err)}`);
    }
  }

  /* ══ 小工具 ═══════════════════════════════════════════════ */

  function errText(err) {
    if (err === null || err === undefined) return "未知错误";
    if (typeof err === "string") return err;
    if (err.message) return String(err.message);
    return String(err);
  }

  function esc(value) {
    return String(value === null || value === undefined ? "" : value).replace(/[&<>"']/g, (ch) => {
      switch (ch) {
        case "&":
          return "&amp;";
        case "<":
          return "&lt;";
        case ">":
          return "&gt;";
        case '"':
          return "&quot;";
        default:
          return "&#39;";
      }
    });
  }

  const textEncoder = typeof TextEncoder === "function" ? new TextEncoder() : null;

  function utf8Length(text) {
    if (textEncoder) return textEncoder.encode(text).length;
    let bytes = 0;
    for (const ch of text) {
      const code = ch.codePointAt(0);
      bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    }
    return bytes;
  }

  function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function toast(message, level) {
    const root = document.getElementById("toast-root");
    if (!root || !message) return;
    const node = document.createElement("div");
    node.className = `toast${level ? ` ${level}` : ""}`;
    node.textContent = message;
    root.appendChild(node);
    window.setTimeout(() => {
      node.classList.add("out");
      window.setTimeout(() => node.remove(), 220);
    }, 3200);
  }

  /* ══ 模型：纯函数（照旧 built-in 模块 model.ts 的语义）════════ */

  function clipText(text, max) {
    const chars = [...String(text === null || text === undefined ? "" : text).replace(/\s+/g, " ").trim()];
    if (chars.length <= max) return chars.join("");
    return `${chars.slice(0, Math.max(0, max - 1)).join("")}…`;
  }

  function isAutomationKind(value) {
    return AUTOMATION_KINDS.includes(value);
  }

  function kindMeta(kind) {
    const meta = AUTOMATION_KIND_META.find((item) => item.kind === kind);
    if (!meta) throw new Error(`未知的自动化动作：${kind}`);
    return meta;
  }

  function parseClock(value) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(value === null || value === undefined ? "" : value).trim());
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (!Number.isInteger(hours) || hours < 0 || hours > 23) return null;
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 59) return null;
    return { hours, minutes };
  }

  function clockValue(hours, minutes) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  }

  function normalizeWeekdays(value) {
    const source = Array.isArray(value) ? value : [];
    const days = [];
    for (const item of source) {
      const day = Number(item);
      if (Number.isInteger(day) && day >= 0 && day <= 6 && !days.includes(day)) days.push(day);
    }
    days.sort((a, b) => a - b);
    return days.length > 0 ? days : [0, 1, 2, 3, 4, 5, 6];
  }

  function nextDailyRun(time, weekdays, from) {
    const parsed = parseClock(time);
    if (!parsed) return from + 24 * 60 * 60 * 1000;
    const days = normalizeWeekdays(weekdays);
    for (let offset = 0; offset <= 7; offset += 1) {
      const candidate = new Date(from);
      candidate.setDate(candidate.getDate() + offset);
      candidate.setHours(parsed.hours, parsed.minutes, 0, 0);
      if (candidate.getTime() > from && days.includes(candidate.getDay())) {
        return candidate.getTime();
      }
    }
    return from + 24 * 60 * 60 * 1000;
  }

  function clampInterval(minutes) {
    return Math.min(MAX_INTERVAL_MINUTES, Math.max(MIN_INTERVAL_MINUTES, Math.round(minutes)));
  }

  function nextRunAt(schedule, from) {
    if (schedule && schedule.type === "interval") {
      const minutes = Number(schedule.minutes);
      return from + clampInterval(Number.isFinite(minutes) ? minutes : 60) * 60 * 1000;
    }
    const safe = schedule && schedule.type === "daily" ? schedule : DEFAULT_DRAFT_SCHEDULE();
    return nextDailyRun(safe.time, safe.weekdays, from);
  }

  function DEFAULT_DRAFT_SCHEDULE() {
    return { type: "daily", time: "09:00", weekdays: ALL_WEEKDAYS.slice() };
  }

  function normalizeSync(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    let sources = DEFAULT_SYNC.sources.slice();
    if (Array.isArray(source.sources)) {
      const picked = [];
      for (const item of source.sources) {
        if ((item === "qq" || item === "wechat") && !picked.includes(item)) picked.push(item);
      }
      sources = picked;
    }
    return { sources, full: source.full === true, archive: source.archive === true };
  }

  function normalizeSchedule(raw) {
    if (raw && raw.type === "interval") {
      const minutes = Math.round(Number(raw.minutes) || 60);
      return { type: "interval", minutes: clampInterval(minutes) };
    }
    const time = parseClock(raw && raw.time) ? String(raw.time).trim() : "09:00";
    return { type: "daily", time, weekdays: normalizeWeekdays(raw && raw.weekdays) };
  }

  function validateDraft(draft) {
    if (!draft || typeof draft !== "object") return "请填写任务名称";
    const name = String(draft.name === null || draft.name === undefined ? "" : draft.name).trim();
    if (!name) return "请填写任务名称";
    if ([...name].length > MAX_NAME_CHARS) return `名称最多 ${MAX_NAME_CHARS} 字`;
    if (!isAutomationKind(draft.kind)) return "请选择要执行的动作";
    const meta = kindMeta(draft.kind);
    if (meta.hasSyncParams) {
      const sync = normalizeSync(draft.sync);
      if (sync.sources.length === 0) return "至少选择一个同步来源";
    }
    const schedule = draft.schedule && typeof draft.schedule === "object" ? draft.schedule : {};
    if (schedule.type === "daily") {
      if (!parseClock(schedule.time)) return "时间格式应为 HH:MM";
      if (!Array.isArray(schedule.weekdays) || schedule.weekdays.length === 0) return "至少选择一个星期";
      return "";
    }
    if (schedule.type === "interval") {
      const raw = schedule.minutes;
      const minutes = Number(raw);
      if (raw === "" || raw === null || raw === undefined || !Number.isInteger(minutes)) return "间隔分钟必须是整数";
      if (minutes < MIN_INTERVAL_MINUTES || minutes > MAX_INTERVAL_MINUTES) {
        return `间隔需在 ${MIN_INTERVAL_MINUTES}–${MAX_INTERVAL_MINUTES} 分钟之间`;
      }
      return "";
    }
    return "请选择触发方式";
  }

  function normalizeDraft(draft) {
    const source = draft && typeof draft === "object" ? draft : {};
    const kind = isAutomationKind(source.kind) ? source.kind : AUTOMATION_KINDS[0];
    const meta = kindMeta(kind);
    const name = clipText(source.name, MAX_NAME_CHARS) || meta.defaultName;
    const sync = normalizeSync(source.sync);
    const schedule = normalizeSchedule(source.schedule);
    const maxRunsRaw = Math.round(Number(source.maxRuns) || 0);
    const result = { name, kind, schedule, sync };
    if (maxRunsRaw > 0) result.maxRuns = Math.min(999, maxRunsRaw);
    return result;
  }

  function normalizeTask(raw, now) {
    if (!raw || typeof raw !== "object") return null;
    const id = String(raw.id === null || raw.id === undefined ? "" : raw.id).trim();
    const name = clipText(raw.name, MAX_NAME_CHARS);
    if (!id || !name) return null;
    if (!isAutomationKind(raw.kind)) return null;
    const meta = kindMeta(raw.kind);
    const scheduleRaw = raw.schedule && typeof raw.schedule === "object" ? raw.schedule : null;
    let schedule;
    if (scheduleRaw && scheduleRaw.type === "daily") {
      const parsed = parseClock(scheduleRaw.time);
      if (!parsed) return null;
      schedule = { type: "daily", time: clockValue(parsed.hours, parsed.minutes), weekdays: normalizeWeekdays(scheduleRaw.weekdays) };
    } else if (scheduleRaw && scheduleRaw.type === "interval") {
      const minutes = Number(scheduleRaw.minutes);
      if (!Number.isFinite(minutes) || minutes < MIN_INTERVAL_MINUTES || minutes > MAX_INTERVAL_MINUTES) return null;
      schedule = { type: "interval", minutes: Math.round(minutes) };
    } else {
      return null;
    }
    const sync = normalizeSync(raw.sync);
    if (meta.hasSyncParams && sync.sources.length === 0) return null;
    const createdAt = Number.isFinite(raw.createdAt) && raw.createdAt > 0 ? raw.createdAt : now;
    const updatedAt = Number.isFinite(raw.updatedAt) && raw.updatedAt > 0 ? raw.updatedAt : now;
    const nextAt = Number.isFinite(raw.nextRunAt) && raw.nextRunAt > 0 ? raw.nextRunAt : nextRunAt(schedule, now);
    const task = {
      id,
      name,
      kind: raw.kind,
      enabled: raw.enabled !== false,
      schedule,
      sync,
      createdAt,
      updatedAt,
      nextRunAt: nextAt,
      runCount: Number.isInteger(raw.runCount) && raw.runCount > 0 ? raw.runCount : 0,
    };
    if (raw.lastRunAt !== undefined && Number.isFinite(raw.lastRunAt) && raw.lastRunAt > 0) {
      task.lastRunAt = raw.lastRunAt;
    }
    if (raw.lastStatus === "ok" || raw.lastStatus === "error" || raw.lastStatus === "skipped") {
      task.lastStatus = raw.lastStatus;
    }
    if (typeof raw.lastDetail === "string") task.lastDetail = clipText(raw.lastDetail, MAX_DETAIL_CHARS);
    if (Number.isInteger(raw.maxRuns) && raw.maxRuns > 0) task.maxRuns = Math.min(999, raw.maxRuns);
    return task;
  }

  function describeSchedule(schedule) {
    if (schedule && schedule.type === "interval") return `每 ${schedule.minutes} 分钟`;
    const days = normalizeWeekdays(schedule && schedule.weekdays);
    const time = schedule && parseClock(schedule.time) ? String(schedule.time).trim() : "09:00";
    if (days.length === 7) return `每天 ${time}`;
    const labels = ALL_WEEKDAYS.filter((day) => days.includes(day)).map((day) => WEEKDAY_LABEL[day]);
    return `每周${labels.join("、")} ${time}`;
  }

  function describeSync(sync) {
    const safe = normalizeSync(sync);
    const parts = [];
    const sources = safe.sources.map((source) => (source === "qq" ? "QQ" : "微信"));
    if (sources.length > 0) parts.push(sources.join("、"));
    if (safe.full) parts.push("全量重扫");
    if (safe.archive) parts.push("导出知识库");
    return parts.join(" · ");
  }

  function describeAction(task) {
    const meta = kindMeta(task.kind);
    if (!meta.hasSyncParams) return meta.summary;
    return `同步归档（${describeSync(task.sync)}）`;
  }

  function actionLabel(kind) {
    return kindMeta(kind).label;
  }

  function runStatusLabel(status) {
    if (status === "ok") return "成功";
    if (status === "error") return "失败";
    return "已跳过";
  }

  function formatAutomationTime(ms) {
    const value = Number(ms);
    if (!Number.isFinite(value) || value <= 0) return "—";
    const date = new Date(value);
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function formatDuration(ms) {
    const value = Number(ms);
    if (!Number.isFinite(value) || value < 0) return "—";
    if (value < 1000) return "不到 1 秒";
    if (value < 60 * 1000) return `${Math.round(value / 1000)} 秒`;
    const minutes = Math.floor(value / 60000);
    const seconds = Math.round((value % 60000) / 1000);
    return `${minutes} 分 ${seconds} 秒`;
  }

  function triggerLabel(trigger) {
    return trigger === "manual" ? "手动" : "定时";
  }

  function draftForKind(kind, sync) {
    const safeKind = isAutomationKind(kind) ? kind : AUTOMATION_KINDS[0];
    const meta = kindMeta(safeKind);
    return {
      name: meta.defaultName,
      kind: safeKind,
      schedule: DEFAULT_DRAFT_SCHEDULE(),
      sync: sync ? normalizeSync(sync) : normalizeSync(DEFAULT_SYNC),
    };
  }

  let taskIdSeq = 0;

  function newTaskId(now) {
    taskIdSeq += 1;
    const rand = Math.random().toString(36).slice(2, 6);
    return `auto-${now.toString(36)}-${taskIdSeq.toString(36)}-${rand}`;
  }

  function newRunId(taskId, now) {
    return `auto-run-${taskId}-${now.toString(36)}`;
  }

  /* ══ 预设（照抄旧 presets.ts）═════════════════════════════ */

  const AUTOMATION_PRESETS = [
    {
      id: "daily-sync",
      label: "每日同步归档",
      description: "每天把 QQ / 微信的新消息同步进本机归档。",
      scheduleText: "每天 08:00",
      draft: {
        name: "每日同步归档",
        kind: "infohub.sync",
        schedule: { type: "daily", time: "08:00", weekdays: ALL_WEEKDAYS.slice() },
        sync: normalizeSync(DEFAULT_SYNC),
      },
    },
    {
      id: "interval-sync",
      label: "每 2 小时增量同步",
      description: "白天高频同步，聊天记录不会积压太久。",
      scheduleText: "每 2 小时",
      draft: {
        name: "每 2 小时增量同步",
        kind: "infohub.sync",
        schedule: { type: "interval", minutes: 120 },
        sync: normalizeSync(DEFAULT_SYNC),
      },
    },
    {
      id: "daily-agenda",
      label: "每天早上重扫日程",
      description: "把归档里的日程表重新扫一遍，临期事项早一点发现。",
      scheduleText: "每天 07:30",
      draft: {
        name: "每天早上重扫日程",
        kind: "infohub.agenda",
        schedule: { type: "daily", time: "07:30", weekdays: ALL_WEEKDAYS.slice() },
        sync: { sources: [], full: false, archive: false },
      },
    },
    {
      id: "weekly-export",
      label: "每周日导出知识库",
      description: "同步归档并导出到 InfoHub 配置的 Obsidian 目录。",
      scheduleText: "每周日 20:00",
      draft: {
        name: "每周日导出知识库",
        kind: "infohub.sync",
        schedule: { type: "daily", time: "20:00", weekdays: [0] },
        sync: { sources: ["qq", "wechat"], full: false, archive: true },
      },
    },
  ];

  /* ══ 动作执行（照抄旧 actions.ts / runner.ts）═══════════════ */

  function sourceLabel(source) {
    if (source === "qq") return "QQ";
    if (source === "wechat") return "微信";
    if (source === "voice") return "语音";
    return String(source || "未知");
  }

  function actionResult(status, detail) {
    return { status, detail: clipText(detail, MAX_DETAIL_CHARS) };
  }

  function describeInfohubError(err) {
    const message = errText(err)
      .replace(/^Error invoking remote method '[^']*':\s*/i, "")
      .replace(/^Error:\s*/i, "")
      .trim();
    if (/信息中枢不可用|信息中枢未连接|未连接信息中枢/i.test(message)) return INFOHUB_OFFLINE;
    if (/缺少 permissions\.infohub/i.test(message)) return "插件缺少信息中枢权限（permissions.infohub）";
    return message || INFOHUB_OFFLINE;
  }

  async function runSyncAction(task) {
    const sync = normalizeSync(task.sync);
    let data;
    try {
      data = await infohubCall("sync", { sources: sync.sources, full: sync.full, archive: sync.archive });
    } catch (err) {
      return actionResult("error", describeInfohubError(err));
    }
    const reports = data && Array.isArray(data.reports) ? data.reports : [];
    const added = reports
      .filter((report) => report && Number(report.added) > 0)
      .map((report) => `${sourceLabel(report.source)} 新增 ${Number(report.added)}`);
    const errors = reports.reduce(
      (sum, report) => sum + (report && Array.isArray(report.errors) ? report.errors.length : 0),
      0,
    );
    let detail = `同步完成：${added.join("，") || "无新增"}`;
    if (errors > 0) detail += `；${errors} 个采集错误`;
    if (sync.archive) {
      const kb = data ? data.kb : null;
      if (!kb) detail += "；配置未开启知识库导出";
      else if (kb.error) detail += `；知识库导出失败：${kb.error}`;
      else detail += "；知识库已导出";
    }
    return actionResult("ok", detail);
  }

  async function runAgendaAction() {
    let data;
    try {
      data = await infohubCall("agenda", {
        days: AGENDA_DAYS,
        overdue: AGENDA_OVERDUE,
        rebuild: true,
      });
    } catch (err) {
      return actionResult("error", describeInfohubError(err));
    }
    const count = data && Array.isArray(data.items) ? data.items.length : 0;
    return actionResult("ok", `重扫完成：${count} 项日程`);
  }

  const ACTIONS = {
    "infohub.sync": { run: runSyncAction },
    "infohub.agenda": { run: runAgendaAction },
  };

  async function runAutomationTask(task) {
    if (!hasInfohubBridge()) return actionResult("error", INFOHUB_OFFLINE);
    const action = ACTIONS[task.kind];
    if (!action) return actionResult("error", "未知的自动化动作");
    try {
      return await action.run(task);
    } catch (err) {
      return actionResult("error", describeInfohubError(err));
    }
  }

  /* ══ 存储：任务 / 运行记录 ═════════════════════════════════ */

  async function loadTasks() {
    const raw = await readKey(TASKS_KEY);
    const items = Array.isArray(raw) ? raw : [];
    const now = Date.now();
    const seen = new Set();
    const tasks = [];
    for (const item of items) {
      const task = normalizeTask(item, now);
      if (!task || seen.has(task.id)) continue;
      seen.add(task.id);
      tasks.push(task);
      if (tasks.length >= MAX_AUTOMATIONS) break;
    }
    return tasks;
  }

  async function loadRuns() {
    const raw = await readKey(RUNS_KEY);
    const items = Array.isArray(raw) ? raw : [];
    const runs = [];
    for (const item of items) {
      const run = normalizeRun(item);
      if (run) runs.push(run);
    }
    return pruneRuns(runs);
  }

  function normalizeRun(raw) {
    if (!raw || typeof raw !== "object") return null;
    const id = String(raw.id === null || raw.id === undefined ? "" : raw.id).trim();
    const taskId = String(raw.taskId === null || raw.taskId === undefined ? "" : raw.taskId).trim();
    const taskName = clipText(raw.taskName, MAX_NAME_CHARS);
    if (!id || !taskId || !taskName) return null;
    if (!isAutomationKind(raw.kind)) return null;
    if (raw.status !== "ok" && raw.status !== "error" && raw.status !== "skipped") return null;
    if (raw.trigger !== "manual" && raw.trigger !== "schedule") return null;
    const startedAt = Number(raw.startedAt);
    if (!Number.isFinite(startedAt) || startedAt <= 0) return null;
    const finishedAt = Number.isFinite(Number(raw.finishedAt)) && Number(raw.finishedAt) > 0 ? Number(raw.finishedAt) : startedAt;
    const durationMs = Number.isFinite(Number(raw.durationMs))
      ? Math.max(0, Number(raw.durationMs))
      : Math.max(0, finishedAt - startedAt);
    return {
      id,
      taskId,
      taskName,
      kind: raw.kind,
      trigger: raw.trigger,
      status: raw.status,
      detail: clipText(raw.detail, MAX_DETAIL_CHARS),
      startedAt,
      finishedAt,
      durationMs,
    };
  }

  function pruneRuns(items, limit) {
    const cap = Number.isFinite(limit) ? limit : RUNS_BYTE_LIMIT;
    const sorted = items.slice().sort((a, b) => b.startedAt - a.startedAt).slice(0, 40);
    while (sorted.length > 1 && utf8Length(JSON.stringify(sorted)) > cap) sorted.pop();
    if (sorted.length > 0 && utf8Length(JSON.stringify(sorted)) > cap) return [];
    return sorted;
  }

  async function persistTasks(next) {
    state.tasks = next;
    const text = JSON.stringify(next);
    if (utf8Length(text) > TASKS_BYTE_LIMIT) {
      state.storageWarn = "任务数据超过本机存储上限，本次改动只在本次会话里可见。";
      return false;
    }
    try {
      await writeKey(TASKS_KEY, next);
      state.storageWarn = "";
      return true;
    } catch (err) {
      state.storageWarn = `任务没能写入本机存储：${errText(err)}`;
      return false;
    }
  }

  async function persistRuns(next) {
    const pruned = pruneRuns(next);
    state.runs = pruned;
    try {
      await writeKey(RUNS_KEY, pruned);
      return true;
    } catch (err) {
      logLine(`运行记录写入失败：${errText(err)}`);
      return false;
    }
  }

  async function recordRun(run) {
    const next = [run, ...state.runs.filter((item) => item.id !== run.id)];
    await persistRuns(next);
  }

  async function removeRunsForTask(taskId) {
    await persistRuns(state.runs.filter((run) => run.taskId !== taskId));
  }

  async function clearRuns() {
    await persistRuns([]);
  }

  /* ══ 状态变更 ═════════════════════════════════════════════ */

  async function createTask(input) {
    const error = validateDraft(input);
    if (error) return { ok: false, error };
    if (state.tasks.length >= MAX_AUTOMATIONS) {
      return { ok: false, error: `自动化最多 ${MAX_AUTOMATIONS} 条，请先删除不用的任务` };
    }
    const now = Date.now();
    const draft = normalizeDraft(input);
    const task = {
      id: newTaskId(now),
      name: draft.name,
      kind: draft.kind,
      enabled: true,
      schedule: draft.schedule,
      sync: draft.sync,
      createdAt: now,
      updatedAt: now,
      nextRunAt: nextRunAt(draft.schedule, now),
      runCount: 0,
    };
    if (draft.maxRuns) task.maxRuns = draft.maxRuns;
    await persistTasks([task, ...state.tasks]);
    return { ok: true, task };
  }

  async function updateTask(id, input) {
    const existing = state.tasks.find((task) => task.id === id);
    if (!existing) return { ok: false, error: "任务不存在" };
    const error = validateDraft(input);
    if (error) return { ok: false, error };
    const now = Date.now();
    const draft = normalizeDraft(input);
    let updated = null;
    const next = state.tasks.map((task) => {
      if (task.id !== id) return task;
      updated = {
        ...task,
        name: draft.name,
        kind: draft.kind,
        schedule: draft.schedule,
        sync: draft.sync,
        updatedAt: now,
        nextRunAt: nextRunAt(draft.schedule, now),
      };
      if (draft.maxRuns) updated.maxRuns = draft.maxRuns;
      return updated;
    });
    await persistTasks(next);
    return { ok: true, task: updated };
  }

  async function removeTask(id) {
    await persistTasks(state.tasks.filter((task) => task.id !== id));
    try {
      await removeRunsForTask(id);
    } catch (err) {
      logLine(`清理运行记录失败：${errText(err)}`);
    }
  }

  async function setTaskEnabled(id, enabled) {
    const now = Date.now();
    const next = state.tasks.map((task) => {
      if (task.id !== id) return task;
      return {
        ...task,
        enabled,
        updatedAt: now,
        nextRunAt: enabled ? nextRunAt(task.schedule, now) : task.nextRunAt,
      };
    });
    await persistTasks(next);
  }

  function beginRun(id, trigger) {
    if (state.running) return false;
    const task = state.tasks.find((item) => item.id === id);
    if (!task) return false;
    state.running = { id, since: Date.now(), trigger: trigger || "schedule" };
    return true;
  }

  async function finishRun(id, result, now) {
    const detail = clipText(result.detail, MAX_DETAIL_CHARS);
    const status = result.status === "error" ? "error" : result.status === "skipped" ? "skipped" : "ok";
    const running = state.running && state.running.id === id ? state.running : null;
    const trigger = running ? running.trigger : "schedule";
    const startedAt = running && running.since > 0 ? running.since : now;
    const task = state.tasks.find((item) => item.id === id);
    if (task) {
      try {
        await recordRun({
          id: newRunId(task.id, now),
          taskId: task.id,
          taskName: task.name,
          kind: task.kind,
          trigger,
          status,
          detail,
          startedAt,
          finishedAt: now,
          durationMs: Math.max(0, now - startedAt),
        });
      } catch (err) {
        logLine(`记录运行结果失败：${errText(err)}`);
      }
    }
    if (status === "error") {
      await pushNotify({
        title: task ? `「${task.name}」执行失败` : "自动化任务执行失败",
        body: detail,
        level: "error",
      });
    }
    if (task) {
      const runCount = task.runCount + 1;
      const reached = Number.isFinite(task.maxRuns) && task.maxRuns > 0 && runCount >= task.maxRuns;
      const next = state.tasks.map((item) => {
        if (item.id !== task.id) return item;
        return {
          ...item,
          runCount,
          lastRunAt: now,
          lastStatus: status,
          lastDetail: detail,
          updatedAt: now,
          enabled: reached ? false : item.enabled,
          nextRunAt: reached ? item.nextRunAt : nextRunAt(item.schedule, now),
        };
      });
      await persistTasks(next);
    }
    if (state.running && state.running.id === id) state.running = null;
  }

  async function runTaskNow(id) {
    const task = state.tasks.find((item) => item.id === id);
    if (!task) return;
    if (!beginRun(id, "manual")) {
      toast("已有任务在运行，等它结束再试");
      return;
    }
    render();
    let outcome;
    try {
      outcome = await runAutomationTask(task);
    } catch (err) {
      outcome = actionResult("error", errText(err));
    }
    await finishRun(id, outcome, Date.now());
    render();
    void publishHomeCard();
    if (outcome.status === "ok") toast(`「${task.name}」${outcome.detail}`, "ok");
    else toast(outcome.detail, "error");
    void probeInfohub().then(render);
  }

  /* ══ 视图状态 ═════════════════════════════════════════════ */

  const state = {
    hosted: false,
    theme: "dark",
    tasks: [],
    runs: [],
    running: null,
    expanded: new Set(),
    editor: null,
    confirm: null,
    storageWarn: "",
    infohub: { status: "unknown", error: "" },
  };

  /* ══ 渲染 ═════════════════════════════════════════════════ */

  function render() {
    renderBanners();
    renderStats();
    renderTasks();
  }

  function renderPresets() {
    const root = document.getElementById("presets");
    if (!root) return;
    root.innerHTML = AUTOMATION_PRESETS.map((preset) => {
      return `
        <article class="preset">
          <div class="preset-top">
            <strong>${esc(preset.label)}</strong>
            <span class="chip">${esc(preset.scheduleText)}</span>
          </div>
          <p>${esc(preset.description)}</p>
          <button class="btn small" type="button" data-action="create-preset" data-preset="${esc(preset.id)}">一键创建</button>
        </article>
      `;
    }).join("");
  }

  function renderBanners() {
    const root = document.getElementById("banners");
    if (!root) return;
    const banners = [];
    if (!state.hosted) {
      banners.push(
        `<div class="banner info"><span class="grow">自动化只在桌面端执行。浏览器里可以创建和查看任务，但到点不会运行。</span></div>`,
      );
    }
    if (state.hosted && state.infohub.status === "offline") {
      banners.push(
        `<div class="banner"><span class="grow">信息中枢未连接：到点的任务会如实记为失败并顺延，不会自动拉起本机进程。</span><button class="btn small" type="button" data-action="open-infohub">去连接</button></div>`,
      );
    }
    if (state.storageWarn) {
      banners.push(`<div class="banner"><span class="grow">${esc(state.storageWarn)}</span></div>`);
    }
    root.innerHTML = banners.join("");
  }

  function nearestNextRun() {
    const enabled = state.tasks.filter((task) => task.enabled);
    if (enabled.length === 0) return null;
    return enabled.slice().sort((a, b) => a.nextRunAt - b.nextRunAt)[0].nextRunAt;
  }

  function infohubState() {
    if (!state.hosted) return { className: "", label: "仅桌面端" };
    if (state.infohub.status === "connected") return { className: "ok", label: "已连接" };
    if (state.infohub.status === "offline") return { className: "err", label: "未连接" };
    return { className: "warn", label: "探测中" };
  }

  function renderStats() {
    const root = document.getElementById("stats");
    if (!root) return;
    const enabledCount = state.tasks.filter((task) => task.enabled).length;
    const next = nearestNextRun();
    const infohub = infohubState();
    const clearDisabled = state.runs.length === 0 ? " disabled" : "";
    root.innerHTML = `
      <div class="stat"><div class="label">任务</div><div class="value">${state.tasks.length}</div></div>
      <div class="stat"><div class="label">启用</div><div class="value">${enabledCount}</div></div>
      <div class="stat"><div class="label">下次执行</div><div class="value">${next ? esc(formatAutomationTime(next)) : "—"}</div></div>
      <div class="stat">
        <div class="label">运行记录<button class="btn small ghost" type="button" data-action="clear-runs"${clearDisabled}>清空记录</button></div>
        <div class="value">${state.runs.length}</div>
      </div>
      <div class="stat"><div class="label">信息中枢</div><div class="value"><span class="dot ${infohub.className}"></span>${esc(infohub.label)}</div></div>
    `;
  }

  function renderTasks() {
    const root = document.getElementById("tasks");
    const count = document.getElementById("task-count");
    if (!root) return;
    const enabledCount = state.tasks.filter((task) => task.enabled).length;
    if (count) count.textContent = state.tasks.length > 0 ? `${state.tasks.length} 条任务，${enabledCount} 条启用` : "";
    if (state.tasks.length === 0) {
      root.innerHTML = `
        <div class="empty">
          <h3>还没有自动化任务</h3>
          <p>把信息中枢的「同步归档」「重扫日程」设为每天定时或按间隔执行。任务只存本机。</p>
          <button class="btn primary" type="button" data-action="new-task">新建自动化</button>
        </div>
      `;
      return;
    }
    root.innerHTML = state.tasks.map(taskCardHtml).join("");
  }

  function taskCardHtml(task) {
    const running = Boolean(state.running && state.running.id === task.id);
    const taskRuns = state.runs.filter((run) => run.taskId === task.id);
    const expanded = state.expanded.has(task.id);
    const statusPill = running
      ? `<span class="pill running">运行中</span>`
      : task.enabled
        ? `<span class="pill on">启用</span>`
        : `<span class="pill off">停用</span>`;
    const runPill = task.lastStatus
      ? `<span class="pill ${esc(task.lastStatus)}">${esc(runStatusLabel(task.lastStatus))}</span>`
      : `<span class="pill">未运行</span>`;
    const busy = state.running ? " disabled" : "";
    const runLabel = running ? "运行中…" : "立即运行";
    const runsHtml = expanded
      ? renderRunList(taskRuns, taskRuns.length)
      : "";
    return `
      <article class="task${task.enabled ? "" : " off"}">
        <div class="task-head">
          ${statusPill}
          <span class="name">${esc(task.name)}</span>
          <span class="badge">${esc(actionLabel(task.kind))}</span>
          <span class="spacer"></span>
          ${runPill}
        </div>
        <div class="task-desc">${esc(describeAction(task))}</div>
        <div class="task-meta">
          <span>计划 <b>${esc(describeSchedule(task.schedule))}</b></span>
          <span>下次 <b>${task.enabled ? esc(formatAutomationTime(task.nextRunAt)) : "已停用"}</b></span>
          <span>上次 <b>${task.lastRunAt ? esc(formatAutomationTime(task.lastRunAt)) : "从未"}</b></span>
        </div>
        ${task.lastDetail ? `<div class="task-detail">${esc(task.lastDetail)}</div>` : ""}
        <div class="task-actions">
          <button class="btn small" type="button" data-action="run-task" data-id="${esc(task.id)}"${busy}>${runLabel}</button>
          <button class="btn small" type="button" data-action="toggle-task" data-id="${esc(task.id)}">${task.enabled ? "停用" : "启用"}</button>
          <button class="btn small" type="button" data-action="edit-task" data-id="${esc(task.id)}">编辑</button>
          <button class="btn small danger" type="button" data-action="delete-task" data-id="${esc(task.id)}">删除</button>
          <span class="spacer"></span>
          <button class="btn small ghost" type="button" data-action="toggle-runs" data-id="${esc(task.id)}">
            ${expanded ? "收起运行记录" : `运行记录（${taskRuns.length}）`}
          </button>
        </div>
        ${runsHtml}
      </article>
    `;
  }

  function renderRunList(runs, total) {
    if (total === 0) return `<div class="runs"><p class="runs-empty">还没有运行记录。</p></div>`;
    const shown = runs.slice(0, 8);
    const rows = shown.map((run) => {
      return `
        <div class="run">
          <span class="pill ${esc(run.status)}">${esc(runStatusLabel(run.status))}</span>
          <span>${esc(formatAutomationTime(run.finishedAt))}</span>
          <span class="trigger">${esc(triggerLabel(run.trigger))}</span>
          <span class="duration">${esc(formatDuration(run.durationMs))}</span>
          <span class="detail">${esc(run.detail || "—")}</span>
        </div>
      `;
    }).join("");
    const more = total > shown.length ? `<p class="runs-empty">只显示最近 ${shown.length} 条，共 ${total} 条</p>` : "";
    return `<div class="runs">${rows}${more}</div>`;
  }

  /* ══ 编辑器 / 确认框 ══════════════════════════════════════ */

  function renderModal() {
    const root = document.getElementById("modal-root");
    if (!root) return;
    if (state.confirm) {
      const confirm = state.confirm;
      root.innerHTML = `
        <div class="modal-backdrop">
          <div class="modal" role="dialog" aria-modal="true">
            <h2>${esc(confirm.title)}</h2>
            <p class="body">${esc(confirm.text)}</p>
            <footer>
              <button class="btn" type="button" data-action="confirm-cancel">取消</button>
              <button class="btn ${confirm.danger ? "danger" : "primary"}" type="button" data-action="confirm-ok">${esc(confirm.okLabel)}</button>
            </footer>
          </div>
        </div>
      `;
      const ok = root.querySelector('[data-action="confirm-ok"]');
      if (ok) ok.focus();
      return;
    }
    if (!state.editor) {
      root.innerHTML = "";
      return;
    }
    root.innerHTML = editorHtml(state.editor);
    const nameInput = document.getElementById("f-name");
    if (nameInput) {
      nameInput.focus();
      if (state.editor.mode === "create") nameInput.select();
    }
  }

  function editorHtml(editor) {
    const draft = editor.draft;
    const meta = kindMeta(draft.kind);
    const isDaily = draft.schedule.type !== "interval";
    const schedule = isDaily ? draft.schedule : null;
    const weekdays = normalizeWeekdays(schedule ? schedule.weekdays : ALL_WEEKDAYS);
    const sync = normalizeSync(draft.sync);
    const title = editor.mode === "edit" ? "编辑自动化" : "新建自动化";
    const kindOptions = AUTOMATION_KIND_META.map((item) => {
      const selected = item.kind === draft.kind ? " selected" : "";
      return `<option value="${esc(item.kind)}"${selected}>${esc(item.label)}</option>`;
    }).join("");
    const weekdayButtons = ALL_WEEKDAYS.map((day) => {
      const active = weekdays.includes(day) ? " active" : "";
      return `<button class="weekday${active}" type="button" data-weekday="${day}" aria-label="周${WEEKDAY_LABEL[day]}" aria-pressed="${active ? "true" : "false"}">${WEEKDAY_LABEL[day]}</button>`;
    }).join("");
    const timeValue = schedule && parseClock(schedule.time) ? esc(schedule.time) : "09:00";
    const intervalValue = draft.schedule.type === "interval" ? esc(draft.schedule.minutes) : "60";
    return `
      <div class="modal-backdrop">
        <form class="modal" id="editor-form" role="dialog" aria-modal="true" aria-labelledby="editor-title">
          <h2 id="editor-title">${esc(title)}</h2>
          <label class="field">
            <span>名称</span>
            <input id="f-name" type="text" maxlength="${MAX_NAME_CHARS}" value="${esc(draft.name)}" autocomplete="off" />
          </label>
          <label class="field">
            <span>动作</span>
            <select id="f-kind">${kindOptions}</select>
          </label>
          <p class="hint" id="f-kind-summary">${esc(meta.summary)}</p>
          <div class="sync-panel" id="f-sync"${meta.hasSyncParams ? "" : " hidden"}>
            <div class="choice">
              <label><input type="checkbox" data-sync="qq"${sync.sources.includes("qq") ? " checked" : ""} /> QQ</label>
              <label><input type="checkbox" data-sync="wechat"${sync.sources.includes("wechat") ? " checked" : ""} /> 微信</label>
              <label><input type="checkbox" data-sync="full"${sync.full ? " checked" : ""} /> 全量重扫</label>
              <label><input type="checkbox" data-sync="archive"${sync.archive ? " checked" : ""} /> 导出知识库</label>
            </div>
            <p class="hint">同步会写入本机归档；导出知识库会写入 InfoHub 配置的 Obsidian 目录。</p>
          </div>
          <div class="field">
            <span>触发方式</span>
            <div class="choice">
              <label><input type="radio" name="f-trigger" value="daily"${isDaily ? " checked" : ""} /> 每天定时</label>
              <label><input type="radio" name="f-trigger" value="interval"${isDaily ? "" : " checked"} /> 按间隔</label>
            </div>
          </div>
          <div class="row" id="f-daily"${isDaily ? "" : " hidden"}>
            <label class="field">
              <span>执行时间</span>
              <input id="f-time" type="time" value="${timeValue}" />
            </label>
            <div class="field" style="flex: 2 1 260px">
              <span>星期</span>
              <div class="weekdays">${weekdayButtons}</div>
            </div>
          </div>
          <label class="field" id="f-interval"${isDaily ? " hidden" : ""}>
            <span>间隔分钟（${MIN_INTERVAL_MINUTES}–${MAX_INTERVAL_MINUTES}）</span>
            <input id="f-interval-input" type="number" min="${MIN_INTERVAL_MINUTES}" max="${MAX_INTERVAL_MINUTES}" step="1" value="${intervalValue}" />
          </label>
          <p class="preview" id="f-preview"></p>
          <p class="warn-box">
            执行前提：桌面端且信息中枢已连接。未连接时任务会如实记为失败并顺延，不会自动拉起本机进程；和鸣关闭期间错过的时刻不会补跑。
          </p>
          <p class="error-text" id="f-error"${editor.error ? "" : " hidden"}>${esc(editor.error || "")}</p>
          <footer>
            <button class="btn" type="button" data-action="close-modal">取消</button>
            <button class="btn primary" type="submit">保存</button>
          </footer>
        </form>
      </div>
    `;
  }

  function openEditor(mode, taskId) {
    if (mode === "edit") {
      const task = state.tasks.find((item) => item.id === taskId);
      if (!task) return;
      state.confirm = null;
      state.editor = {
        mode: "edit",
        id: task.id,
        nameTouched: true,
        error: "",
        draft: {
          name: task.name,
          kind: task.kind,
          schedule: normalizeSchedule(task.schedule),
          sync: normalizeSync(task.sync),
          maxRuns: task.maxRuns || 0,
        },
      };
    } else {
      const draft = draftForKind("infohub.sync");
      state.confirm = null;
      state.editor = {
        mode: "create",
        id: null,
        nameTouched: false,
        error: "",
        draft: {
          name: draft.name,
          kind: draft.kind,
          schedule: normalizeSchedule(draft.schedule),
          sync: normalizeSync(draft.sync),
          maxRuns: 0,
        },
      };
    }
    renderModal();
    updateEditorPreview();
  }

  function closeModal() {
    state.editor = null;
    state.confirm = null;
    renderModal();
  }

  function updateEditorPreview() {
    const editor = state.editor;
    if (!editor) return;
    const preview = document.getElementById("f-preview");
    if (!preview) return;
    const schedule = editor.draft.schedule;
    let text = "";
    if (schedule.type === "daily") {
      if (!parseClock(schedule.time)) {
        text = "时间格式应为 HH:MM";
      } else if (normalizeWeekdays(schedule.weekdays).length === 0) {
        text = "至少选择一个星期";
      } else {
        text = `下次执行：${formatAutomationTime(nextRunAt(schedule, Date.now()))}（保存后按此刻重新排期）`;
      }
    } else {
      const raw = schedule.minutes;
      const minutes = Number(raw);
      if (raw === "" || raw === null || raw === undefined || !Number.isInteger(minutes)) {
        text = "间隔分钟必须是整数";
      } else if (minutes < MIN_INTERVAL_MINUTES || minutes > MAX_INTERVAL_MINUTES) {
        text = `间隔需在 ${MIN_INTERVAL_MINUTES}–${MAX_INTERVAL_MINUTES} 分钟之间`;
      } else {
        text = `下次执行：${formatAutomationTime(nextRunAt(schedule, Date.now()))}（保存后按此刻重新排期）`;
      }
    }
    preview.textContent = text;
  }

  function setEditorError(message) {
    const node = document.getElementById("f-error");
    if (!node) return;
    node.textContent = message || "";
    node.hidden = !message;
  }

  /* ══ 表单交互 ═════════════════════════════════════════════ */

  function onEditorInput(ev) {
    const editor = state.editor;
    if (!editor) return;
    const target = ev.target;
    if (!target) return;
    const draft = editor.draft;
    if (target.id === "f-name") {
      editor.nameTouched = true;
      draft.name = target.value;
    } else if (target.id === "f-kind") {
      const nextKind = target.value;
      if (isAutomationKind(nextKind)) {
        const previous = kindMeta(draft.kind);
        const next = kindMeta(nextKind);
        draft.kind = nextKind;
        if (!editor.nameTouched || draft.name === previous.defaultName || !String(draft.name).trim()) {
          draft.name = next.defaultName;
          const nameInput = document.getElementById("f-name");
          if (nameInput) nameInput.value = next.defaultName;
          editor.nameTouched = false;
        }
        if (next.hasSyncParams) {
          draft.sync = normalizeSync(draft.sync);
          if (draft.sync.sources.length === 0) draft.sync.sources = ["qq", "wechat"];
        } else {
          draft.sync = { sources: [], full: false, archive: false };
        }
        const summary = document.getElementById("f-kind-summary");
        if (summary) summary.textContent = next.summary;
        const panel = document.getElementById("f-sync");
        if (panel) panel.hidden = !next.hasSyncParams;
        renderModal();
        updateEditorPreview();
        return;
      }
    } else if (target.id === "f-time") {
      draft.schedule = { type: "daily", time: target.value, weekdays: normalizeWeekdays(draft.schedule.weekdays) };
    } else if (target.id === "f-interval-input") {
      draft.schedule = { type: "interval", minutes: target.value === "" ? "" : Number(target.value) };
    } else if (target.name === "f-trigger") {
      if (target.value === "interval") {
        draft.schedule = { type: "interval", minutes: 60 };
      } else {
        draft.schedule = { type: "daily", time: "09:00", weekdays: ALL_WEEKDAYS.slice() };
      }
      renderModal();
      updateEditorPreview();
      return;
    } else if (target.dataset && target.dataset.sync) {
      const sync = normalizeSync(draft.sync);
      const flag = target.dataset.sync;
      if (flag === "qq" || flag === "wechat") {
        const set = new Set(sync.sources);
        if (target.checked) set.add(flag);
        else set.delete(flag);
        sync.sources = ["qq", "wechat"].filter((source) => set.has(source));
      } else if (flag === "full") {
        sync.full = target.checked;
      } else if (flag === "archive") {
        sync.archive = target.checked;
      }
      draft.sync = sync;
    }
    setEditorError("");
    updateEditorPreview();
  }

  function toggleWeekday(day, button) {
    const editor = state.editor;
    if (!editor || editor.draft.schedule.type !== "daily") return;
    const schedule = editor.draft.schedule;
    const days = normalizeWeekdays(schedule.weekdays);
    const next = days.includes(day) ? days.filter((item) => item !== day) : days.concat(day).sort((a, b) => a - b);
    editor.draft.schedule = { type: "daily", time: schedule.time, weekdays: next };
    if (button) {
      const active = next.includes(day);
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    }
    setEditorError("");
    updateEditorPreview();
  }

  function onSubmitEditor(ev) {
    ev.preventDefault();
    const editor = state.editor;
    if (!editor) return;
    const error = validateDraft(editor.draft);
    if (error) {
      setEditorError(error);
      return;
    }
    void (async () => {
      const name = normalizeDraft(editor.draft).name;
      const result = editor.mode === "edit" ? await updateTask(editor.id, editor.draft) : await createTask(editor.draft);
      if (!result.ok) {
        setEditorError(result.error);
        return;
      }
      closeModal();
      render();
      toast(editor.mode === "edit" ? `已保存「${name}」` : `已创建「${name}」`, "ok");
      void publishHomeCard();
    })();
  }

  function onModalClick(ev) {
    if (ev.target && ev.target.classList && ev.target.classList.contains("modal-backdrop")) {
      closeModal();
      return;
    }
    const weekday = ev.target.closest ? ev.target.closest("[data-weekday]") : null;
    if (weekday && state.editor) {
      toggleWeekday(Number(weekday.dataset.weekday), weekday);
      return;
    }
    const actionEl = ev.target.closest ? ev.target.closest("[data-action]") : null;
    if (!actionEl) return;
    const action = actionEl.dataset.action;
    if (action === "confirm-cancel" || action === "close-modal") {
      closeModal();
      return;
    }
    if (action === "confirm-ok") void confirmOk();
  }

  function askDelete(taskId) {
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task) return;
    state.editor = null;
    state.confirm = {
      title: "删除自动化",
      text: `确定删除「${task.name}」？删除后不会再按计划执行，已有的运行结果也会一并移除。`,
      okLabel: "删除",
      danger: true,
      run: async () => {
        await removeTask(task.id);
        render();
        void publishHomeCard();
        toast(`已删除「${task.name}」`);
      },
    };
    renderModal();
  }

  function askClearRuns() {
    const total = state.runs.length;
    if (total === 0) return;
    state.editor = null;
    state.confirm = {
      title: "清空运行记录",
      text: `确定清空全部运行记录？共 ${total} 条，清空后无法恢复；任务本身与排期不受影响。`,
      okLabel: "清空",
      danger: true,
      run: async () => {
        await clearRuns();
        render();
        void publishHomeCard();
        toast("已清空运行记录");
      },
    };
    renderModal();
  }

  async function confirmOk() {
    const confirm = state.confirm;
    state.confirm = null;
    renderModal();
    if (!confirm) return;
    try {
      await confirm.run();
    } catch (err) {
      toast(errText(err), "error");
    }
    render();
  }

  /* ══ 信息中枢连接态 ═══════════════════════════════════════ */

  async function probeInfohub() {
    if (!state.hosted) {
      state.infohub = { status: "unsupported", error: "" };
      return;
    }
    if (!hasInfohubBridge()) {
      state.infohub = { status: "offline", error: "当前宿主没有信息中枢桥" };
      return;
    }
    try {
      await infohubCall("ping", {}, { timeoutMs: 5000 });
      state.infohub = { status: "connected", error: "" };
    } catch (err) {
      state.infohub = { status: "offline", error: describeInfohubError(err) };
    }
  }

  function openInfohubPage() {
    const bridge = hostApi();
    if (bridge && typeof bridge.openPage === "function") {
      try {
        bridge.openPage("infohub");
        return;
      } catch (err) {
        logLine(`打开信息中枢失败：${errText(err)}`);
      }
    }
    toast("请在左侧打开信息中枢，安装并连接后回到这里");
  }

  /* ══ 事件委派与启动 ═══════════════════════════════════════ */

  function onPageClick(ev) {
    const el = ev.target.closest ? ev.target.closest("[data-action]") : null;
    if (!el) return;
    const action = el.dataset.action;
    switch (action) {
      case "new-task":
        openEditor("create");
        break;
      case "edit-task":
        openEditor("edit", el.dataset.id);
        break;
      case "delete-task":
        askDelete(el.dataset.id);
        break;
      case "toggle-task": {
        const task = state.tasks.find((item) => item.id === el.dataset.id);
        if (task) {
          void setTaskEnabled(task.id, !task.enabled).then(() => {
            render();
            void publishHomeCard();
            toast(task.enabled ? `已停用「${task.name}」` : `已启用「${task.name}」`);
          });
        }
        break;
      }
      case "run-task":
        void runTaskNow(el.dataset.id);
        break;
      case "toggle-runs": {
        const id = el.dataset.id;
        if (state.expanded.has(id)) state.expanded.delete(id);
        else state.expanded.add(id);
        renderTasks();
        break;
      }
      case "clear-runs":
        askClearRuns();
        break;
      case "create-preset": {
        const preset = AUTOMATION_PRESETS.find((item) => item.id === el.dataset.preset);
        if (!preset) break;
        void (async () => {
          const result = await createTask(cloneJson(preset.draft));
          if (!result.ok) {
            toast(result.error, "error");
            return;
          }
          render();
          void publishHomeCard();
          if (state.storageWarn) toast(state.storageWarn, "error");
          else toast(`已创建「${result.task.name}」`, "ok");
        })();
        break;
      }
      case "open-infohub":
        openInfohubPage();
        break;
      default:
        break;
    }
  }

  function applyTheme(theme) {
    const next = theme === "light" ? "light" : "dark";
    state.theme = next;
    document.documentElement.setAttribute("data-theme", next);
  }

  function fingerprint(value) {
    try {
      return JSON.stringify(value);
    } catch (err) {
      return "";
    }
  }

  async function poll() {
    const [tasks, runs] = await Promise.all([loadTasks(), loadRuns()]);
    let changed = false;
    if (fingerprint(tasks) !== fingerprint(state.tasks)) {
      state.tasks = tasks;
      changed = true;
    }
    if (fingerprint(runs) !== fingerprint(state.runs)) {
      state.runs = runs;
      changed = true;
    }
    if (changed) {
      render();
      void publishHomeCard();
    }
  }

  async function boot() {
    state.hosted = hasHost();
    const info = await hostInfo();
    applyTheme(info.theme);
    onHostEvent((evt) => {
      if (!evt || typeof evt !== "object") return;
      if (evt.kind === "theme") {
        applyTheme(evt.theme || (evt.payload && evt.payload.theme));
      }
    });
    state.tasks = await loadTasks();
    state.runs = await loadRuns();
    renderPresets();
    render();
    await probeInfohub();
    render();
    void publishHomeCard();
    document.addEventListener("click", onPageClick);
    const modalRoot = document.getElementById("modal-root");
    if (modalRoot) {
      modalRoot.addEventListener("click", onModalClick);
      modalRoot.addEventListener("input", onEditorInput);
      modalRoot.addEventListener("change", onEditorInput);
      modalRoot.addEventListener("submit", onSubmitEditor);
    }
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && (state.editor || state.confirm)) {
        ev.preventDefault();
        closeModal();
      }
    });
    window.setInterval(() => {
      void poll();
    }, POLL_MS);
    window.setInterval(() => {
      void probeInfohub().then(render);
    }, PROBE_MS);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => void boot());
  } else {
    void boot();
  }
})();
