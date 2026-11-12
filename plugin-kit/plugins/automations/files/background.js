/**
 * 自动化 · 后台脚本（沙箱 bundle 版）
 *
 * 由宿主在插件启用且已安装时以隐藏 BrowserWindow 常驻（`widget://<pluginId>/files/background.html`）。
 * 职责：
 *   1. 每 15 秒检查一次到期任务，串行执行（同一时刻只跑一个）；
 *   2. 启动时把「和鸣关闭期间错过的」任务重新排期，**不补跑**；
 *   3. 失败时通过宿主 `notify` 推送通知（与旧内置模块一致：只在失败时提醒）；
 *   4. 把「下一次执行 / 最近结果」写进首页卡片（homeCardSet）。
 *
 * 页面（files/app.js）只负责手动运行与展示，定时执行全部在这里，避免两处同时消费计划。
 * 信息中枢未连接时**不消费**计划：任务不会被偷偷执行，也不会自动拉起本机进程。
 */
(function () {
  "use strict";

  const TASKS_KEY = "automations.tasks.v1";
  const RUNS_KEY = "automations.runs.v1";
  const TASKS_BYTE_LIMIT = 256 * 1024;
  const RUNS_BYTE_LIMIT = 192 * 1024;
  const TICK_MS = 15000;
  const MAX_LOOP = 10;

  const AGENDA_DAYS = 14;
  const AGENDA_OVERDUE = 30;
  const INFOHUB_OFFLINE = "信息中枢未连接，本任务未执行；请先安装并连接信息中枢";

  const AUTOMATION_KINDS = ["infohub.sync", "infohub.agenda"];
  const AUTOMATION_KIND_META = [
    {
      kind: "infohub.sync",
      label: "同步本机归档",
      hasSyncParams: true,
      summary: "把 QQ / 微信的聊天记录同步到本机归档",
    },
    { kind: "infohub.agenda", label: "重扫日程", hasSyncParams: false, summary: "重扫本机归档的日程表" },
  ];

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

  function hasInfohubBridge() {
    const bridge = hostApi();
    return Boolean(bridge && typeof bridge.infohubCall === "function");
  }

  function logLine(line) {
    const bridge = hostApi();
    if (!bridge || typeof bridge.log !== "function") return;
    try {
      bridge.log(`[automations:background] ${clipText(line, 480)}`);
    } catch (err) {
      /* 日志失败不影响调度 */
    }
  }

  async function readKey(key) {
    const bridge = hostApi();
    if (!bridge || typeof bridge.dataGet !== "function") return null;
    try {
      return await bridge.dataGet(key);
    } catch (err) {
      logLine(`读取 ${key} 失败：${errText(err)}`);
      return null;
    }
  }

  async function writeKey(key, value) {
    const bridge = hostApi();
    if (!bridge || typeof bridge.dataSet !== "function") {
      throw new Error("宿主存储不可用");
    }
    await bridge.dataSet(key, value);
  }

  async function infohubCall(method, params, options) {
    const bridge = hostApi();
    if (!bridge || typeof bridge.infohubCall !== "function") throw new Error(INFOHUB_OFFLINE);
    return bridge.infohubCall(method, params, options);
  }

  async function pushNotify(payload) {
    const bridge = hostApi();
    if (!bridge || typeof bridge.notify !== "function") return;
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
    try {
      await bridge.homeCardSet("automations", {
        text: next ? `下一次 ${formatAutomationTime(next.nextRunAt)}` : "还没有自动化任务",
        detail: last
          ? `上次 ${runStatusLabel(last.status)} · ${formatAutomationTime(last.finishedAt)}`
          : "还没有运行记录",
        badge: `${enabled.length} 个启用`,
      });
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

  function clipText(text, max) {
    const chars = [...String(text === null || text === undefined ? "" : text).replace(/\s+/g, " ").trim()];
    if (chars.length <= max) return chars.join("");
    return `${chars.slice(0, Math.max(0, max - 1)).join("")}…`;
  }

  function isAutomationKind(value) {
    return AUTOMATION_KINDS.includes(value);
  }

  function kindMeta(kind) {
    return AUTOMATION_KIND_META.find((item) => item.kind === kind) || AUTOMATION_KIND_META[0];
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

  function clampInterval(minutes) {
    return Math.min(MAX_INTERVAL_MINUTES, Math.max(MIN_INTERVAL_MINUTES, Math.round(minutes)));
  }

  function nextDailyRun(time, weekdays, from) {
    const parsed = parseClock(time);
    if (!parsed) return from + 24 * 60 * 60 * 1000;
    const days = normalizeWeekdays(weekdays);
    for (let offset = 0; offset <= 7; offset += 1) {
      const candidate = new Date(from);
      candidate.setDate(candidate.getDate() + offset);
      candidate.setHours(parsed.hours, parsed.minutes, 0, 0);
      if (candidate.getTime() > from && days.includes(candidate.getDay())) return candidate.getTime();
    }
    return from + 24 * 60 * 60 * 1000;
  }

  function nextRunAt(schedule, from) {
    if (schedule && schedule.type === "interval") {
      const minutes = Number(schedule.minutes);
      return from + clampInterval(Number.isFinite(minutes) ? minutes : 60) * 60 * 1000;
    }
    const safe = schedule && schedule.type === "daily" ? schedule : { type: "daily", time: "09:00", weekdays: ALL_WEEKDAYS };
    return nextDailyRun(safe.time, safe.weekdays, from);
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
      schedule = {
        type: "daily",
        time: clockValue(parsed.hours, parsed.minutes),
        weekdays: normalizeWeekdays(scheduleRaw.weekdays),
      };
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
    const finishedAt =
      Number.isFinite(Number(raw.finishedAt)) && Number(raw.finishedAt) > 0 ? Number(raw.finishedAt) : startedAt;
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

  function pruneRuns(items) {
    const sorted = items.slice().sort((a, b) => b.startedAt - a.startedAt).slice(0, 40);
    while (sorted.length > 1 && utf8Length(JSON.stringify(sorted)) > RUNS_BYTE_LIMIT) sorted.pop();
    if (sorted.length > 0 && utf8Length(JSON.stringify(sorted)) > RUNS_BYTE_LIMIT) return [];
    return sorted;
  }

  function describeSchedule(schedule) {
    if (schedule && schedule.type === "interval") return `每 ${schedule.minutes} 分钟`;
    const days = normalizeWeekdays(schedule && schedule.weekdays);
    const time = schedule && parseClock(schedule.time) ? String(schedule.time).trim() : "09:00";
    if (days.length === 7) return `每天 ${time}`;
    const labels = ALL_WEEKDAYS.filter((day) => days.includes(day)).map((day) => WEEKDAY_LABEL[day]);
    return `每周${labels.join("、")} ${time}`;
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

  function newRunId(taskId, now) {
    return `auto-run-${taskId}-${now.toString(36)}`;
  }

  /* ══ 动作（与页面/app.js、旧 actions.ts 一致）═══════════════ */

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
      data = await infohubCall("agenda", { days: AGENDA_DAYS, overdue: AGENDA_OVERDUE, rebuild: true });
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

  /* ══ 存储与状态 ═══════════════════════════════════════════ */

  const state = {
    tasks: [],
    runs: [],
    running: null,
    ready: false,
    bootedAt: Date.now(),
  };

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

  async function persistTasks(next) {
    state.tasks = next;
    if (utf8Length(JSON.stringify(next)) > TASKS_BYTE_LIMIT) {
      logLine("任务数据超过本机存储上限，本次改动只在本次会话里可见");
      return false;
    }
    try {
      await writeKey(TASKS_KEY, next);
      return true;
    } catch (err) {
      logLine(`任务写入失败：${errText(err)}`);
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

  function beginRun(id, trigger) {
    if (state.running) return false;
    const task = state.tasks.find((item) => item.id === id);
    if (!task) return false;
    state.running = { id, since: Date.now(), trigger };
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
      await persistRuns([
        {
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
        },
        ...state.runs.filter((run) => run.id !== newRunId(task.id, now)),
      ]);
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
      await persistTasks(
        state.tasks.map((item) => {
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
        }),
      );
    }
    if (state.running && state.running.id === id) state.running = null;
    logLine(`「${task ? task.name : id}」执行${status === "ok" ? "成功" : "失败"}：${detail}`);
  }

  async function rescheduleMissed(since, now) {
    let changed = 0;
    const next = state.tasks.map((task) => {
      if (!task.enabled || task.nextRunAt >= since) return task;
      changed += 1;
      return { ...task, nextRunAt: nextRunAt(task.schedule, now), updatedAt: now };
    });
    if (changed > 0) {
      await persistTasks(next);
      logLine(`已把 ${changed} 条错过的任务重新排期（不补跑）`);
    }
    return changed;
  }

  async function probeInfohub() {
    if (!hasInfohubBridge()) {
      state.ready = false;
      return false;
    }
    try {
      await infohubCall("ping", {}, { timeoutMs: 5000 });
      state.ready = true;
    } catch (err) {
      state.ready = false;
    }
    return state.ready;
  }

  /* ══ 调度 ═════════════════════════════════════════════════ */

  let busy = false;
  let rescheduled = false;

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      state.tasks = await loadTasks();
      state.runs = await loadRuns();
      const ready = await probeInfohub();
      if (!ready) {
        /* 未连接信息中枢时不消费计划：不执行、不推进 nextRunAt，等连接后照常。 */
        await publishHomeCard();
        return;
      }
      if (!rescheduled) {
        await rescheduleMissed(state.bootedAt, Date.now());
        rescheduled = true;
      }
      for (let step = 0; step < MAX_LOOP; step += 1) {
        const now = Date.now();
        const due = state.tasks
          .filter((task) => task.enabled && task.nextRunAt <= now)
          .sort((a, b) => a.nextRunAt - b.nextRunAt)[0];
        if (!due) break;
        if (!beginRun(due.id, "schedule")) break;
        let outcome;
        try {
          outcome = await runAutomationTask(due);
        } catch (err) {
          outcome = actionResult("error", errText(err));
        }
        await finishRun(due.id, outcome, Date.now());
        /* 重新读一次，吸收页面在此期间的手动运行/编辑 */
        state.tasks = await loadTasks();
        state.runs = await loadRuns();
      }
      await publishHomeCard();
    } catch (err) {
      logLine(`调度出错：${errText(err)}`);
    } finally {
      busy = false;
    }
  }

  function start() {
    state.bootedAt = Date.now();
    logLine("后台调度启动");
    void tick();
    window.setInterval(() => {
      void tick();
    }, TICK_MS);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
