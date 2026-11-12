"use strict";
/**
 * 安装器界面的全部行为。
 *
 * 渲染进程没有任何 node 能力（sandbox + contextIsolation），所以格式化函数在这里
 * 各写一份小的；数量级只有字节/文件数/时间三种，重复三行换一个没有 require 的窗口，值。
 *
 * 状态只有四个屏幕：ready / work / done / error；work 内部再按 phase 换文案。
 * 界面不自己算「完成了百分之几」——下载百分比来自真实字节，安装期的文件数来自
 * 轮询目标目录，两者都不是动画编出来的。
 */

(() => {
  // 截图自检（lib/capture.js 的 diagnostics.json）要能读到渲染层的异常。
  // 安装器没有开发工具可开，页面里真报错时只有这行记录能说明白。
  window.__setupErrors = [];
  window.addEventListener("error", (event) => {
    window.__setupErrors.push(`error: ${event.message || "unknown"} @ ${event.filename || "?"}:${event.lineno || 0}`);
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    window.__setupErrors.push(`rejection: ${(reason && (reason.message || String(reason))) || "unknown"}`);
  });

  const api = window.setup;
  const $ = (id) => document.getElementById(id);
  const WORDMARK = window.HEMING_WORDMARK;
  const REDUCED_MOTION = Boolean(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  /** 手写段参数，与 packages/desktop/splash.html 的时序同源（那边是 1500/1250/55）。 */
  const DRAW_MS = 1250;
  const LETTER_GAP_MS = 55;
  const DOT_FADE_DELAY_MS = 120;
  const WAVE_DOT_COUNT = 24;

  const STEP_LABELS = {
    ready: "第 1 步 · 安装位置",
    work: "第 2 步 · 安装",
    done: "第 3 步 · 完成",
    error: "第 4 步 · 没能走完",
  };

  /**
   * 更新模式（桌面端叫起的「更新助手」）只有三步：
   * 没有「装在哪」这一屏，进度从第一秒就开始，所以步号和用词都要换。
   */
  const UPDATE_STEP_LABELS = {
    ready: "正在更新",
    work: "更新中",
    done: "更新完成",
    error: "更新没能完成",
  };

  function stepLabel(name) {
    const labels = state.mode === "update" ? UPDATE_STEP_LABELS : STEP_LABELS;
    return labels[name] || labels.ready;
  }

  const state = {
    screen: "ready",
    phase: "idle",
    init: null,
    /** "install" 首次安装；"update" 由桌面端叫起的更新助手。 */
    mode: "install",
    installDir: "",
    launchAfter: true,
    chosenPayload: null,
    download: { received: 0, total: 0 },
    counts: { files: 0, bytes: 0 },
    doneInfo: null,
    /** 更新模式下计划读不出来时的错误；非空表示「重试」只能关窗回应用。 */
    planError: null,
    busy: false,
    capture: false,
  };

  let wordmarkFrame = 0;
  let wordmarkDotTimer = null;
  let elapsedTimer = null;

  // ---------- 格式化 ----------

  function formatBytes(bytes, digits = 1) {
    if (!Number.isFinite(bytes) || bytes < 0) return "—";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = bytes;
    let index = 0;
    while (value >= 1024 && index < units.length - 1) {
      value /= 1024;
      index += 1;
    }
    const rounded = index === 0 ? Math.round(value) : value >= 100 ? Math.round(value) : Number(value.toFixed(digits));
    return `${rounded} ${units[index]}`;
  }

  function formatCount(count) {
    if (!Number.isFinite(count) || count <= 0) return "0";
    return String(Math.floor(count)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  /** 剩余时间只说「秒/分」，不装作精确倒计时。 */
  function formatRemaining(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return "";
    if (seconds < 60) return `剩 ${Math.ceil(seconds)} 秒`;
    const minutes = Math.floor(seconds / 60);
    const rest = Math.ceil(seconds % 60);
    return `剩 ${minutes} 分 ${String(rest).padStart(2, "0")} 秒`;
  }

  // ---------- 字形与波浪 ----------

  function buildWordmark() {
    const group = $("wordmark-strokes");
    group.textContent = "";
    for (const stroke of WORDMARK.strokes) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", stroke.d);
      path.dataset.letter = stroke.letter;
      group.appendChild(path);
    }
  }

  function buildWave() {
    const wave = $("wave");
    wave.textContent = "";
    for (let index = 0; index < WAVE_DOT_COUNT; index += 1) {
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.style.animationDelay = `${(index % 12) * 70}ms`;
      wave.appendChild(dot);
    }
  }

  /**
   * 逐笔写出「Heming」。用 rAF 手写插值而不是 Web Animations：
   * SVG 的 stroke-dashoffset 在 Chromium 里对关键帧的单位处理不统一，
   * 直接按每帧改样式最稳，也方便下面做「重播」。
   */
  function drawWordmark() {
    cancelAnimationFrame(wordmarkFrame);
    if (wordmarkDotTimer) {
      clearTimeout(wordmarkDotTimer);
      wordmarkDotTimer = null;
    }

    const paths = Array.from($("wordmark-strokes").querySelectorAll("path"));
    const dot = $("wordmark-dot");
    dot.style.opacity = "0";

    const items = paths.map((path) => {
      const length = path.getTotalLength();
      path.style.strokeDasharray = String(length);
      path.style.strokeDashoffset = String(length);
      return { path, length };
    });

    if (REDUCED_MOTION || typeof items[0]?.path.getTotalLength !== "function") {
      for (const item of items) item.path.style.strokeDashoffset = "0";
      dot.style.opacity = "1";
      return;
    }

    // 按字母分组：同一字母内笔画连着写，字母之间抬手一个短间隔。
    const groups = [];
    for (const item of items) {
      const letter = item.path.dataset.letter || "";
      const last = groups[groups.length - 1];
      if (!last || last.letter !== letter) groups.push({ letter, items: [item] });
      else last.items.push(item);
    }

    const totalGap = Math.max(0, groups.length - 1) * LETTER_GAP_MS;
    const drawBudget = Math.max(300, DRAW_MS - totalGap);
    const allLength = items.reduce((sum, item) => sum + item.length, 0);

    // 每一笔按自身长度分时间：笔尖推进速度均匀，不会出现长笔画飞、短笔画爬。
    //
    // 时间轴必须严丝合缝地铺满 DRAW_MS：抬手间隔放在字母之间（不是全部堆在最前面），
    // 每个字母的预算按笔画长度切分且不再对单笔设下限——之前「先偏移 totalGap，
    // 再给每笔至少 40ms」会让最后两笔（g）的 start 超过 DRAW_MS，rAF 停在 1250ms 时
    // 它们仍停在「未描画」状态，截图上就是词标缺了最后一个字母。
    const schedule = [];
    let clock = 0;
    groups.forEach((group, index) => {
      if (index > 0) clock += LETTER_GAP_MS;
      const groupLength = group.items.reduce((sum, item) => sum + item.length, 0);
      const groupBudget = allLength > 0 ? drawBudget * (groupLength / allLength) : drawBudget / groups.length;
      let letterClock = clock;
      for (const item of group.items) {
        const share = groupLength > 0 ? item.length / groupLength : 1 / group.items.length;
        const duration = groupBudget * share;
        schedule.push({ path: item.path, length: item.length, start: letterClock, duration });
        letterClock += duration;
      }
      clock += groupBudget;
    });

    const startedAt = performance.now();
    const tick = (now) => {
      const elapsed = now - startedAt;
      for (const step of schedule) {
        const progress = Math.min(Math.max((elapsed - step.start) / step.duration, 0), 1);
        step.path.style.strokeDashoffset = String(step.length * (1 - progress));
      }
      if (elapsed < DRAW_MS) {
        wordmarkFrame = requestAnimationFrame(tick);
      } else {
        // 最后一帧不再等插值：浮点误差下 dashoffset 可能差最后零点几，直接归零收笔。
        for (const step of schedule) step.path.style.strokeDashoffset = "0";
        // 写完停一下才落朱砂点：像句号，而不是装饰灯
        wordmarkDotTimer = setTimeout(() => {
          dot.style.opacity = "1";
          wordmarkDotTimer = null;
        }, DOT_FADE_DELAY_MS);
      }
    };
    wordmarkFrame = requestAnimationFrame(tick);
  }

  // ---------- 计时 ----------

  /**
   * 工作屏右侧一直显示「已用 X 秒」。
   *
   * 安装的大头是内层 NSIS 解压 + 复制，那一步没有可信的百分比；一个持续走的
   * 秒数能让用户确认程序没卡死，也让「这台机器装一次要多久」有据可查。
   */
  function formatElapsed(ms) {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    if (seconds < 60) return `已用 ${seconds} 秒`;
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    return `已用 ${minutes} 分 ${String(rest).padStart(2, "0")} 秒`;
  }

  function updateElapsedClock(running) {
    const label = $("status-elapsed");
    if (!label) return;
    if (elapsedTimer) {
      clearInterval(elapsedTimer);
      elapsedTimer = null;
    }
    if (!running) {
      label.textContent = "";
      label.hidden = true;
      return;
    }
    const startedAtMs = Date.now();
    label.hidden = false;
    label.textContent = formatElapsed(0);
    elapsedTimer = setInterval(() => {
      label.textContent = formatElapsed(Date.now() - startedAtMs);
    }, 1000);
  }

  // ---------- 屏幕与文案 ----------

  function showScreen(name) {
    state.screen = name;
    for (const screen of ["ready", "work", "done", "error"]) {
      const element = $(`screen-${screen}`);
      const active = screen === name;
      element.hidden = !active;
      if (active) {
        // 去掉再加回来，保证同一个屏幕重新进入时入场动画会重播
        element.classList.remove("is-current");
        void element.offsetWidth;
        element.classList.add("is-current");
      } else {
        element.classList.remove("is-current");
      }
    }
    $("step-label").textContent = stepLabel(name);
    // 预取那行小字只属于「安装位置」屏；进工作屏后进度改由进度条承担。
    const prefetchNote = $("prefetch-note");
    if (prefetchNote && name !== "ready") prefetchNote.hidden = true;
    updateElapsedClock(name === "work");
  }

  function setWorkHeadline(text) {
    $("work-headline").textContent = text;
  }

  function setMetric(value, unit, sub) {
    $("metric-value").textContent = value;
    $("metric-unit").textContent = unit;
    $("metric-sub").textContent = sub || " ";
  }

  function setStatus(text) {
    $("status").textContent = text;
  }

  /** percent 为 null 表示总量未知，走不确定进度动画。 */
  function setProgress(percent) {
    const bar = $("progress");
    const fill = $("progress-fill");
    if (percent === null || !Number.isFinite(percent)) {
      bar.classList.add("indeterminate");
      bar.removeAttribute("aria-valuenow");
      fill.style.width = "";
      return;
    }
    bar.classList.remove("indeterminate");
    const clamped = Math.min(100, Math.max(0, percent));
    fill.style.width = `${clamped}%`;
    bar.setAttribute("aria-valuenow", String(Math.round(clamped)));
  }

  function renderInstallPath() {
    $("install-path").textContent = state.installDir || "—";
    const hint = $("path-hint");
    hint.classList.remove("is-warning");
    if (state.chosenPayload) {
      hint.textContent = `使用你选择的安装包：${state.chosenPayload}`;
      return;
    }
    if (state.init && state.init.existingDir) {
      hint.textContent = "这里已经有一份 和鸣，安装会覆盖它，设置和数据都保留。";
      hint.classList.add("is-warning");
      return;
    }
    hint.textContent = "装在这里不需要管理员权限。";
  }

  function renderFacts() {
    const init = state.init;
    if (!init) return;
    $("fact-version").textContent = init.version || "—";
    $("fact-space").textContent = init.installedBytes ? `约 ${formatBytes(init.installedBytes, 0)}` : "约 1 GB";
    $("fact-existing").textContent = init.existingDir ? "已安装，将覆盖" : "未安装";
    $("fact-source").textContent = init.payloadMode === "embedded" ? "随安装器内置" : "从更新服务器获取";
  }

  // ---------- 事件 ----------

  function onPhase(event) {
    state.phase = event.phase;
    if (state.screen !== "work") showScreen("work");

    if (event.phase === "prepare") {
      setWorkHeadline("正在准备。");
      setMetric("—", "", " ");
      setProgress(null);
      setStatus(event.label || "准备中…");
      $("btn-cancel").hidden = false;
      return;
    }

    if (event.phase === "download") {
      setWorkHeadline("正在下载。");
      state.download.total = event.totalBytes || 0;
      setMetric("0", "%", `0 B / ${event.totalBytes ? formatBytes(event.totalBytes) : "未知大小"}`);
      setProgress(0);
      setStatus(event.label || "下载安装包…");
      $("btn-cancel").hidden = false;
      return;
    }

    if (event.phase === "verify") {
      setWorkHeadline("正在核对。");
      setMetric("—", "", "校验安装包的完整性与签名值");
      setProgress(null);
      setStatus(event.label || "校验安装包…");
      $("btn-cancel").hidden = false;
      return;
    }

    if (event.phase === "install") {
      setWorkHeadline("正在写入。");
      setMetric("—", "个文件", " ");
      setProgress(event.totalBytes ? 0 : null);
      setStatus("正在安装 · 请不要关闭这个窗口");
      $("btn-cancel").hidden = true;
    }
  }

  /**
   * 后台预取：窗口一打开主进程就开始找包/下载，这一屏只多一行小字。
   * 用户还没点「开始安装」，不该因为后台在下载就把整屏切走；
   * 预取失败也不弹错——点了开始会重新尝试并给出真正的错误。
   */
  function onPrefetch(event) {
    const note = $("prefetch-note");
    const text = $("prefetch-text");
    const fill = $("prefetch-fill");
    if (!note || !text || !fill || state.screen !== "ready") return;
    if (event.stage === "failed") {
      note.hidden = true;
      return;
    }
    if (event.stage === "ready") {
      note.hidden = false;
      note.classList.add("is-ready");
      text.textContent = event.version ? `安装包已就绪 · ${event.version}` : "安装包已就绪";
      fill.style.width = "100%";
      return;
    }
    note.hidden = false;
    note.classList.remove("is-ready");
    const percent = typeof event.percent === "number" ? Math.round(event.percent) : null;
    text.textContent = percent === null ? "正在准备安装包" : `正在准备安装包 · ${percent}%`;
    if (percent !== null) fill.style.width = `${Math.min(100, Math.max(0, percent))}%`;
  }

  function onProgress(event) {
    if (state.phase !== "download") return;
    state.download.received = event.received || 0;
    if (event.total) state.download.total = event.total;
    const total = state.download.total;
    const percent = total > 0 ? (state.download.received / total) * 100 : null;
    setMetric(percent === null ? "—" : String(Math.floor(percent)), percent === null ? "" : "%", `${formatBytes(state.download.received)} / ${total > 0 ? formatBytes(total) : "未知大小"}`);
    setProgress(percent);
    const parts = ["正在下载"];
    if (event.rate) parts.push(`${formatBytes(event.rate)}/s`);
    const remaining = formatRemaining(event.remaining);
    if (remaining) parts.push(remaining);
    setStatus(parts.join(" · "));
  }

  function onFiles(event) {
    state.counts.files = event.files || 0;
    state.counts.bytes = event.bytes || 0;
    if (state.phase !== "install") return;
    setMetric(formatCount(state.counts.files), "个文件", `已写入 ${formatBytes(state.counts.bytes)}`);
    if (event.percent !== null && event.percent !== undefined) {
      setProgress(event.percent);
    } else if (state.init && state.init.installedBytes > 0 && state.counts.bytes > 0) {
      setProgress((state.counts.bytes / state.init.installedBytes) * 100);
    }
    setStatus(`正在安装 · ${formatCount(state.counts.files)} 个文件`);
  }

  function onDone(event) {
    state.busy = false;
    state.phase = "done";
    state.doneInfo = { installDir: event.installDir, exePath: event.exePath, version: event.version };
    showScreen("done");
    const version = event.version ? ` ${event.version}` : "";
    $("done-line").textContent =
      state.mode === "update"
        ? `和鸣${version} 已更新到 ${event.installDir}`
        : `和鸣${version} 已装到 ${event.installDir}`;
    const seal = $("seal");
    seal.classList.remove("stamped");
    void seal.offsetWidth;
    seal.classList.add("stamped");
    const facts = $("fact-existing");
    if (facts) facts.textContent = "已安装";
  }

  function onError(event) {
    state.busy = false;
    state.phase = "error";
    showScreen("error");
    $("error-message").textContent = event.message || "安装程序提前停下了。";
    const lines = [];
    if (event.code) lines.push(`错误码：${event.code}`);
    if (event.detail) lines.push(String(event.detail));
    $("error-detail").textContent = lines.join("\n");
    $("error-detail").hidden = lines.length === 0;
  }

  function onCancelled() {
    state.busy = false;
    state.phase = "idle";
    if (state.mode === "update") {
      // 更新模式下没有「安装位置」可回；取消就等于这次不更新，直接关窗。
      api.close();
      return;
    }
    showScreen("ready");
    const hint = $("path-hint");
    hint.classList.remove("is-warning");
    hint.textContent = "已取消。已经下载的部分会保留，下次接着用。";
  }

  function handleEvent(event) {
    if (!event || typeof event.type !== "string") return;
    switch (event.type) {
      case "phase":
        onPhase(event);
        break;
      case "progress":
        onProgress(event);
        break;
      case "prefetch":
        onPrefetch(event);
        break;
      case "files":
        onFiles(event);
        break;
      case "done":
        onDone(event);
        break;
      case "error":
        onError(event);
        break;
      case "cancelled":
        onCancelled();
        break;
      default:
        break;
    }
  }

  // ---------- 动作 ----------

  async function beginInstall() {
    if (state.busy) return;
    state.busy = true;
    state.download = { received: 0, total: 0 };
    state.counts = { files: 0, bytes: 0 };
    showScreen("work");
    setWorkHeadline(state.mode === "update" ? "正在更新。" : "正在准备。");
    setMetric("—", "", " ");
    setProgress(null);
    setStatus(state.mode === "update" ? "退出应用后开始更新…" : "检查安装位置…");
    $("btn-cancel").hidden = false;
    try {
      await api.start({
        installDir: state.installDir,
        launchAfter: state.launchAfter,
        payloadPath: state.chosenPayload || undefined,
      });
    } catch (error) {
      onError({ code: "start-failed", message: "安装没能启动", detail: String((error && error.message) || error) });
    } finally {
      state.busy = false;
    }
  }

  async function cancelInstall() {
    const result = await api.cancel();
    if (result && result.ok === false && result.reason === "installing") {
      setStatus("正在写入文件，这一步不能取消。");
    }
  }

  async function chooseDirectory() {
    const chosen = await api.chooseDirectory(state.installDir);
    if (chosen) {
      state.installDir = chosen;
      renderInstallPath();
    }
  }

  async function pickPayload() {
    const chosen = await api.pickPayload();
    if (!chosen) return;
    state.chosenPayload = chosen;
    renderInstallPath();
    await beginInstall();
  }

  async function openInstalled() {
    const dir = state.doneInfo ? state.doneInfo.installDir : state.installDir;
    await api.openInstalled(dir);
  }

  async function openFolder() {
    const dir = state.doneInfo ? state.doneInfo.installDir : state.installDir;
    await api.openFolder(dir);
  }

  /**
   * 错误屏的「重试」：更新模式下若计划本身读不出来，重试没有意义——
   * 包和安装位置都在计划里，缺了只能回应用里重新下载，所以直接关窗。
   */
  function retryInstall() {
    if (state.mode === "update" && state.planError) {
      api.close();
      return;
    }
    beginInstall();
  }

  function onKeyDown(event) {
    if (event.key === "Enter") {
      if (state.screen === "ready") {
        event.preventDefault();
        beginInstall();
      } else if (state.screen === "done") {
        event.preventDefault();
        openInstalled();
      } else if (state.screen === "error") {
        event.preventDefault();
        retryInstall();
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      if (state.screen === "work") cancelInstall();
      else api.close();
    }
  }

  function bindEvents() {
    $("btn-minimize").addEventListener("click", () => api.minimize());
    $("btn-close").addEventListener("click", () => api.close());
    $("btn-quit").addEventListener("click", () => api.quit());
    $("btn-start").addEventListener("click", beginInstall);
    $("btn-retry").addEventListener("click", retryInstall);
    $("btn-cancel").addEventListener("click", cancelInstall);
    $("btn-choose").addEventListener("click", chooseDirectory);
    $("btn-open").addEventListener("click", openInstalled);
    $("btn-open-folder").addEventListener("click", openFolder);
    $("btn-pick-payload").addEventListener("click", pickPayload);
    $("btn-open-log").addEventListener("click", () => api.openLog());
    $("launch-after").addEventListener("change", (event) => {
      state.launchAfter = event.target.checked;
    });
    window.addEventListener("keydown", onKeyDown);
  }

  // ---------- 截图模式（electron . --capture=<dir>） ----------

  function applyCaptureState(name) {
    const version = state.init ? state.init.version : "";
    switch (name) {
      case "ready":
        state.busy = false;
        state.phase = "idle";
        state.chosenPayload = null;
        renderInstallPath();
        showScreen("ready");
        drawWordmark();
        break;
      case "work-download":
        showScreen("work");
        state.phase = "download";
        state.download.total = 142 * 1024 * 1024;
        onPhase({ type: "phase", phase: "download", label: "下载安装包", totalBytes: 142 * 1024 * 1024 });
        onProgress({ type: "progress", received: 101.6 * 1024 * 1024, total: 142 * 1024 * 1024, rate: 3.2 * 1024 * 1024, remaining: 13 });
        break;
      case "work-install":
        showScreen("work");
        state.phase = "install";
        onPhase({ type: "phase", phase: "install", label: "正在安装", totalBytes: state.init ? state.init.installedBytes : null });
        onFiles({ type: "files", files: 12304, bytes: 742 * 1024 * 1024, percent: 64 });
        break;
      case "done":
        onDone({ installDir: state.installDir || "D:\\Programs\\Heming", version, launched: false });
        break;
      case "error":
        onError({
          code: "network",
          message: "连不上更新服务器，请检查网络后重试。",
          detail: "GET http://47.92.39.184/updates/latest.yml\nECONNREFUSED 47.92.39.184:80",
        });
        break;
      default:
        break;
    }
  }

  // ---------- 启动 ----------

  async function boot() {
    buildWordmark();
    buildWave();
    bindEvents();
    // 先订阅再 init：更新模式在 init 返回后马上就开跑，晚一步订阅会丢掉第一批 phase 事件。
    api.onEvent(handleEvent);
    api.onCaptureState(applyCaptureState);
    try {
      state.init = await api.init();
    } catch (error) {
      state.init = null;
      onError({ code: "init-failed", message: "安装器没有正确启动", detail: String((error && error.message) || error) });
      return;
    }
    state.capture = Boolean(state.init.capture);
    state.mode = state.init.mode === "update" ? "update" : "install";

    if (state.mode === "update") {
      // 更新模式：没有「装在哪」这一步，界面语言也换成更新。
      $("brand-kind").textContent = "更新程序";
      document.title = "更新 和鸣";
      $("done-headline").textContent = "更新好了。";
      $("error-headline").textContent = "更新没能完成。";
      // 更新装哪个包由计划决定，不给「选择安装包」入口。
      $("btn-pick-payload").hidden = true;

      if (state.init.planError) {
        // 记住是「计划坏了」而不是「装到一半坏了」：重试按钮据此改成关窗。
        state.planError = state.init.planError;
        onError(state.init.planError);
        return;
      }
      const update = state.init.update || {};
      if (update.installDir) state.installDir = update.installDir;
      state.launchAfter = update.relaunch !== false;
      renderFacts();
      // 右栏的四条事实换成「更新」口径：装哪个版本、现在是什么版本、包从哪来。
      $("fact-version").textContent = update.version || state.init.version || "—";
      $("fact-existing").textContent = update.currentVersion ? `当前 ${update.currentVersion}` : "已安装";
      $("fact-source").textContent = "已在后台下载";
      showScreen("work");
      await beginInstall();
      return;
    }

    state.installDir = state.init.existingDir || state.init.defaultDir || "C:\\Programs\\Heming";
    state.launchAfter = true;
    renderInstallPath();
    renderFacts();
    showScreen("ready");
    drawWordmark();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
