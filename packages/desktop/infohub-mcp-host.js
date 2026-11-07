"use strict";
/**
 * 信息采集中枢 · 本机采集桥（MCP HTTP 服务）托管（d.96）。
 *
 * ## 为什么由和鸣主进程托管
 *
 * 插件「信息采集中枢」只**声明**了一个 MCP 服务地址（`http://127.0.0.1:8776/mcp`），
 * 插件模型不允许它执行代码——所以端点必须由和鸣自己提供。Python 采集桥在
 * `packages/infohub/infohub/mcp_server.py`，用内置运行时就能跑，不需要用户另开窗口。
 *
 * ## 和 `infohub-bridge.js` 的关系
 *
 * 那个是 **stdio** 边车（不开端口、一问一答，适合归档检索）；这个是 **HTTP** 端点
 * （浏览器版与插件 MCP 客户端都只认 http(s)，所以必须监听回环端口）。
 * 两者的生命周期、解释器选择、整树回收是同一套语义：解释器选择直接复用
 * `resolvePython`，进程回收一律交给 `child-kill.js`，**模块里不写裸 kill**。
 *
 * ## 边界（逐条对应规格 §11）
 *
 * - 只监听 `127.0.0.1:8776`；端口固定，被占就如实报错，不静默换端口；
 * - **绝不自动启动**：本模块没有任何 ready/页面事件钩子，只有 IPC
 *   `infohub:bridge-start` 会调 `start()`；
 * - 外部已有端点（用户自己在终端跑着 `infohub mcp`）直接复用，不重复拉进程；
 * - 起不来时把 stderr 末尾（≤4000 字符）拼进中文错误，用户能自己判断缺什么。
 */

const path = require("node:path");
const fs = require("node:fs");
const { teardownChild } = require("./child-kill");
const { normalizeHome, resolvePython } = require("./infohub-bridge");

/** 采集桥固定端口（与插件清单里声明的 `127.0.0.1:8776` 一致，不做端口回退）。 */
const PORT = 8776;
const HOST = "127.0.0.1";
const HEALTH_URL = `http://${HOST}:${PORT}/health`;
/** 渲染层/插件消费的 MCP 地址：只有 running 时才对外给出。 */
const MCP_URL = `http://${HOST}:${PORT}/mcp`;

/** 健康轮询预算：内置运行时冷启动一般 1–3 秒；15 秒还没起来就是真的坏了。 */
const DEFAULT_HEALTH_TIMEOUT_MS = 15_000;
const DEFAULT_HEALTH_INTERVAL_MS = 200;
/** 单次 /health 探测超时：回环上不该更慢，慢了说明端口上不是我们的服务。 */
const DEFAULT_PROBE_TIMEOUT_MS = 1_500;
/** 停止时的礼貌退出预算（Windows 上 taskkill /T 之前的等待）。 */
const DEFAULT_STOP_GRACE_MS = 1_500;
/** 启动失败时留给用户看的 stderr 尾巴长度（与 infohub-bridge 一致）。 */
const MAX_STDERR_TAIL = 4_000;

function defaultExists(target) {
  try {
    return fs.existsSync(target);
  } catch {
    return false;
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => {
    // 故意不 unref：启动轮询期间主进程必须有活着的句柄，
    // 否则事件循环一空，这个 Promise 就再也不会 resolve（启动流程悬死）。
    setTimeout(resolve, ms);
  });
}

/**
 * 探一次 `/health`。任何异常都收成 `{ ok:false, error }`——探测失败不是崩溃，
 * 只是「这个地址上暂时没有我们的服务」。
 *
 * @returns {Promise<{ ok: boolean, body?: any, error?: string }>}
 */
async function fetchHealth(fetchImpl, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS) {
  if (typeof fetchImpl !== "function") return { ok: false, error: "缺少 fetch 实现" };
  let controller = null;
  let timer = null;
  if (typeof AbortController === "function") {
    controller = new AbortController();
    timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
  }
  try {
    const response = await fetchImpl(HEALTH_URL, {
      method: "GET",
      headers: { accept: "application/json" },
      // 健康结论必须是最新的：缓存住的「未运行」会让用户以为点了没反应。
      cache: "no-store",
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!response || !response.ok) {
      return { ok: false, error: `健康检查返回 HTTP ${response?.status ?? "未知"}` };
    }
    let body = null;
    try {
      if (typeof response.json === "function") body = await response.json();
    } catch {
      /* 有的实现只回 200 文本：只要状态码对就算通了 */
    }
    return { ok: true, body };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** stderr 末尾（≤4000 字符，去首尾空白）。 */
function stderrTailOf(text) {
  const trimmed = String(text ?? "").trim();
  return trimmed ? trimmed.slice(-MAX_STDERR_TAIL) : "";
}

/** 把 stderr 尾巴拼到中文错误后面：用户看到的是「为什么 + 原始证据」。 */
function withTail(message, tail) {
  const text = stderrTailOf(tail);
  return text ? `${message}\n--- 采集桥 stderr 末尾（最多 ${MAX_STDERR_TAIL} 字符）---\n${text}` : message;
}

/**
 * 进程退出/起不来时的中文可执行错误。
 * 端口占用是最常见的一种（用户自己开着一个 `infohub mcp`），要单独说清楚。
 *
 * @param {{code?: any, signal?: any, error?: string}} report 退出报告
 * @param {string} tail stderr 末尾
 * @param {{launching?: boolean}} [opts] `launching:false` 表示进程本来在跑、后来退了
 */
function exitErrorMessage(report, tail, { launching = true } = {}) {
  const evidence = `${report?.error ?? ""}\n${tail ?? ""}`;
  if (/EADDRINUSE|WSAEADDRINUSE|address already in use|端口.*占用/i.test(evidence)) {
    return withTail(
      "采集桥端口 8776 已被占用：请关闭占用该端口的程序（可能是另一个 InfoHub 采集桥，或你自己在终端里跑的「infohub mcp」），再重新启动。",
      tail,
    );
  }
  const code = report?.code ?? "null";
  const signal = report?.signal ?? "null";
  const cause = report?.error ? `：${report.error}` : "";
  const outcome = launching ? "启动失败" : "意外退出";
  return withTail(
    `采集桥进程${outcome}（code=${code} signal=${signal}）${cause}。请确认内置运行时里带有 infohub.mcp_server，或在信息中枢设置里改选已装好依赖的 Python 解释器。`,
    tail,
  );
}

/**
 * 创建采集桥托管实例。
 *
 * @param {object} deps
 * @param {(...args: any[]) => any} deps.spawn 子进程构造（测试注入假实现，缺省走 child_process）
 * @param {(line: string) => void} [deps.log]
 * @param {string} deps.packageDir 随包 infohub 目录（同时作为 cwd 与 PYTHONPATH 前缀）
 * @param {string|null} [deps.bundledPythonPath] 内置解释器
 * @param {string} deps.defaultHome 用户未指定时的归档目录（INFOHUB_HOME）
 * @param {typeof fetch} [deps.fetchImpl] /health 探测实现（测试注入假 fetch）
 * @param {string} [deps.platform] 注入平台：决定 spawn detached 与整树回收分支
 * @param {(target: string) => boolean} [deps.exists] 解释器存在性判断
 * @param {(child: any, deps: object) => Promise<{exited: boolean, via: string}>} [deps.teardown]
 *   子进程回收实现，缺省见 child-kill.teardownChild（测试里换成断言用假实现）
 * @param {number} [deps.healthTimeoutMs] 健康轮询总预算
 * @param {number} [deps.healthIntervalMs] 健康轮询间隔
 * @param {number} [deps.probeTimeoutMs] 单次 /health 超时
 * @param {number} [deps.stopGraceMs] stop 的礼貌退出预算
 * @param {() => number} [deps.now] 时间源（since 与超时判断）
 * @param {(ms: number) => Promise<void>} [deps.sleep] 轮询等待
 */
function createInfohubMcpHost({
  spawn,
  log = () => {},
  packageDir,
  bundledPythonPath = null,
  defaultHome,
  fetchImpl = globalThis.fetch,
  platform = process.platform,
  exists = defaultExists,
  teardown = teardownChild,
  healthTimeoutMs = DEFAULT_HEALTH_TIMEOUT_MS,
  healthIntervalMs = DEFAULT_HEALTH_INTERVAL_MS,
  probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  stopGraceMs = DEFAULT_STOP_GRACE_MS,
  now = () => Date.now(),
  sleep = defaultSleep,
} = {}) {
  const isWindows = platform === "win32";
  /** spawn 缺省走 child_process；require 放到首次使用时，保证「加载模块不启动任何东西」。 */
  const spawnImpl =
    typeof spawn === "function" ? spawn : (...args) => require("node:child_process").spawn(...args);

  /** 当前由本实例拉起的子进程（external 端点时恒为 null）。 */
  let child = null;
  /** 对外状态（唯一事实来源，只经 status() 拷贝出去）。 */
  let state = {
    running: false,
    starting: false,
    source: "none",
    home: null,
    python: null,
    pythonSource: "unknown",
    since: null,
    error: null,
  };
  /** 进行中的启动（并发调用共用同一份，避免同一个端口 spawn 两次）。 */
  let startingPromise = null;
  /** 正在被 stop() 取消的启动，用于把「启动失败」措辞改成「已取消」。 */
  let canceledChild = null;
  let stderrTail = "";
  /** 子进程退出报告：{ code, signal, error }。启动轮询靠它给出可执行错误。 */
  let exitReport = null;
  /**
   * 进行中的回收。stop() 不阻塞调用方（界面要立刻响应），
   * 但 dispose() 必须等完它们——否则「刚点停止就关应用」仍会留孤儿。
   * @type {Set<Promise<void>>}
   */
  const teardowns = new Set();
  const eventSinks = new Set();

  /**
   * 规格 §6.1 的形状，字段名/顺序逐字一致（渲染层直接消费，不许加料）。
   * `url` 只在 running 时给出；`port` 恒 8776（固定端口，不做回退）。
   */
  function status() {
    return {
      running: state.running,
      starting: state.starting,
      url: state.running ? MCP_URL : null,
      port: PORT,
      home: state.home,
      python: state.python,
      pythonSource: state.pythonSource,
      source: state.source,
      since: state.since,
      error: state.error,
    };
  }

  function setState(patch) {
    state = { ...state, ...patch };
  }

  /** 每次状态变化推一次（渲染层据此刷新「采集桥」区块，不必轮询）。 */
  function emit() {
    const snapshot = status();
    for (const sink of eventSinks) {
      try {
        sink(snapshot);
      } catch (err) {
        log(`[infohub-mcp] 状态事件处理失败：${err?.message ?? err}`);
      }
    }
  }

  function emitState(patch) {
    setState(patch);
    emit();
  }

  /** 解释器与归档目录：与 stdio 边车同一套纯函数（用户配置 > 内置运行时 > 缺失）。 */
  function resolveTarget(config = {}) {
    const home = normalizeHome(config.home, defaultHome);
    const picked = resolvePython({
      configured: config.python,
      bundled: bundledPythonPath,
      exists,
    });
    return { home, python: picked.python, pythonSource: picked.source };
  }

  /**
   * 发起一次整树回收（不阻塞调用方）。
   * 结论只写日志：`exited:false` 表示没证明它死了，如实留痕比假装成功有用。
   */
  function beginTeardown(targetChild, graceMs) {
    const run = (async () => {
      try {
        const result = await teardown(targetChild, { graceMs, isWindows });
        if (!result?.exited) {
          log(`[infohub-mcp] 进程（PID ${targetChild?.pid ?? "?"}）回收未确认（via=${result?.via}）`);
        }
      } catch (err) {
        log(`[infohub-mcp] 进程回收失败：${err?.message ?? err}`);
      } finally {
        teardowns.delete(run);
      }
    })();
    teardowns.add(run);
    return run;
  }

  /** 子进程退出/出错：运行时意外退出才算失败态；启动阶段交给轮询统一收口。 */
  function handleExit(targetChild, report) {
    if (child !== targetChild) return; // 主动 stop / 启动失败清理已经接管，别再改状态
    const wasRunning = state.running;
    exitReport = report;
    child = null;
    const message = exitErrorMessage(report, stderrTail, { launching: !wasRunning });
    if (state.starting) return; // 轮询会抛错并落状态，同一次失败不推两遍事件
    emitState({
      running: false,
      starting: false,
      source: "none",
      since: null,
      error: message,
    });
    log(`[infohub-mcp] 采集桥进程意外退出：code=${report?.code ?? "null"}（${message.split("\n")[0]}）`);
  }

  function attach(targetChild) {
    targetChild.stdout?.setEncoding?.("utf8");
    targetChild.stderr?.setEncoding?.("utf8");
    // 采集桥不往 stdout 写业务数据；不读走会让管道堆满、子进程卡在 write 上。
    targetChild.stdout?.on?.("data", () => {});
    targetChild.stderr?.on?.("data", (chunk) => {
      const text = String(chunk);
      stderrTail = (stderrTail + text).slice(-MAX_STDERR_TAIL);
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (trimmed) log(`[infohub-mcp] ${trimmed.slice(0, 500)}`);
      }
    });
    targetChild.on?.("error", (err) =>
      handleExit(targetChild, { code: null, signal: null, error: err?.message ?? String(err) }),
    );
    targetChild.on?.("exit", (code, signal) => handleExit(targetChild, { code, signal }));
  }

  /**
   * 拉起 Python 采集桥。
   * env 拼法与 `infohub-bridge.js` 的 launch 保持一致（同一份 INFOHUB_HOME/PYTHONPATH 语义，
   * 换一份写法迟早漂移）；`detached` 只给非 Windows：POSIX 的整组回收靠负 PID。
   */
  function launch(target) {
    stderrTail = "";
    exitReport = null;
    const pythonPath = process.env.PYTHONPATH
      ? packageDir + path.delimiter + process.env.PYTHONPATH
      : packageDir;
    const env = {
      ...process.env,
      INFOHUB_HOME: target.home,
      PYTHONPATH: pythonPath,
      PYTHONUNBUFFERED: "1",
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
    };
    const spawnOpts = {
      cwd: packageDir,
      env,
      // 采集桥不读 stdin：不开 pipe 少一个可能被写坏的句柄。
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    };
    if (!isWindows) spawnOpts.detached = true;
    return spawnImpl(
      target.python,
      ["-m", "infohub.mcp_server", "--host", HOST, "--port", String(PORT)],
      spawnOpts,
    );
  }

  /** 轮询 /health，直到通、子进程早退或超时。 */
  async function waitHealthy(targetChild) {
    const deadline = now() + healthTimeoutMs;
    const canceled = () => canceledChild === targetChild;
    const failure = () =>
      canceled()
        ? new Error("采集桥启动已取消")
        : new Error(exitErrorMessage(exitReport ?? {}, stderrTail));
    for (;;) {
      // 子进程先退（端口占用/缺依赖）就不必再等满 15 秒：早退才是常见失败态。
      if (child !== targetChild) throw failure();
      const probe = await fetchHealth(fetchImpl, probeTimeoutMs);
      if (child !== targetChild) throw failure();
      if (probe.ok) return;
      if (now() >= deadline) {
        throw new Error(
          withTail(
            `采集桥启动超时（${Math.round(healthTimeoutMs / 1000)} 秒内 /health 一直不通）：请确认内置运行时能执行「python -m infohub.mcp_server」；若端口 8776 被别的程序占用，请先关闭它。`,
            stderrTail,
          ),
        );
      }
      await sleep(healthIntervalMs);
    }
  }

  async function runStart(config) {
    const target = resolveTarget(config);

    // ① 先探测外部端点：用户可能自己在终端跑着采集桥，复用比再拉一个靠谱。
    emitState({ starting: true, error: null });
    const probe = await fetchHealth(fetchImpl, probeTimeoutMs);
    if (probe.ok) {
      emitState({
        running: true,
        starting: false,
        source: "external",
        home: target.home,
        python: null,
        pythonSource: "external",
        since: now(),
        error: null,
      });
      return status();
    }

    // ② 解释器缺失：不 spawn，直接给可执行的中文错误（界面据此提示去改路径）。
    if (!target.python) {
      const message =
        "未找到可用的 Python 解释器：请在信息中枢设置里选择 Python 解释器，或先构建内置运行时（resources/runtime）后再启动采集桥。";
      emitState({
        running: false,
        starting: false,
        source: "none",
        home: target.home,
        python: null,
        pythonSource: "missing",
        since: null,
        error: message,
      });
      throw new Error(message);
    }

    // ③ 拉起进程（同步抛错也要收成中文错误：spawn 对坏路径会直接 throw）。
    let targetChild;
    try {
      targetChild = launch(target);
    } catch (err) {
      const message = `采集桥启动失败：${err?.message ?? err}`;
      emitState({
        running: false,
        starting: false,
        source: "none",
        home: target.home,
        python: null,
        pythonSource: target.pythonSource,
        since: null,
        error: message,
      });
      throw new Error(message);
    }
    if (!targetChild) {
      const message = "采集桥启动失败：spawn 没有返回子进程句柄";
      emitState({ running: false, starting: false, source: "none", error: message });
      throw new Error(message);
    }

    child = targetChild;
    canceledChild = null;
    setState({
      home: target.home,
      python: target.python,
      pythonSource: target.pythonSource,
      source: "app",
    });
    attach(targetChild);

    // ④ 等 /health；起不来就当场回收（留着半死进程只会占端口与归档库）。
    try {
      await waitHealthy(targetChild);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (child === targetChild) child = null;
      beginTeardown(targetChild, 0);
      emitState({
        running: false,
        starting: false,
        source: "none",
        since: null,
        error: message,
      });
      throw new Error(message);
    }

    emitState({
      running: true,
      starting: false,
      source: "app",
      home: target.home,
      python: target.python,
      pythonSource: target.pythonSource,
      since: now(),
      error: null,
    });
    return status();
  }

  /**
   * 显式启动（或复用外部端点）。**这是本模块唯一的拉起路径**——没有 ready 钩子、
   * 没有定时器、没有页面事件；不调用它就不会有进程。
   */
  function start(config = {}) {
    const safe = config && typeof config === "object" ? config : {};
    // 已经在跑就不重复 spawn（external 也一样：那是用户的进程，不是我们的）。
    if (state.running) return Promise.resolve(status());
    if (startingPromise) return startingPromise;
    startingPromise = runStart(safe).finally(() => {
      startingPromise = null;
      canceledChild = null;
    });
    return startingPromise;
  }

  /**
   * 停止。只停自己拉起的进程：external 端点返回 false，界面据此提示
   * 「请在你启动它的窗口里关闭」。回收在后台跑完（dispose 会等）。
   *
   * @returns {boolean} 是否真的停了一个由本实例拉起的进程
   */
  function stop({ killDelayMs = stopGraceMs, silent = false } = {}) {
    const targetChild = child;
    if (!targetChild) return false; // external 或本来就没跑：都不是我们的进程
    child = null;
    canceledChild = targetChild;
    stderrTail = "";
    exitReport = null;
    setState({
      running: false,
      starting: false,
      source: "none",
      since: null,
      error: null,
    });
    emit();
    if (!silent) log(`[infohub-mcp] 已停止采集桥（PID ${targetChild.pid ?? "?"}）`);
    beginTeardown(targetChild, killDelayMs);
    return true;
  }

  /**
   * 应用退出时调用：发起回收并**等到它跑完**（或被 will-quit 的硬超闸放行）。
   * @returns {Promise<void>}
   */
  async function dispose() {
    stop({ killDelayMs: 0, silent: true });
    while (teardowns.size > 0) {
      await Promise.allSettled([...teardowns]);
    }
  }

  /** 订阅状态变化，返回退订函数。 */
  function onEvent(callback) {
    if (typeof callback !== "function") return () => {};
    eventSinks.add(callback);
    return () => eventSinks.delete(callback);
  }

  /** 既没有活进程也没有在途回收 ⇒ 退出时不用拦。 */
  function idle() {
    return !child && teardowns.size === 0;
  }

  return {
    status,
    start,
    stop,
    dispose,
    idle,
    onEvent,
  };
}

module.exports = {
  HEALTH_URL,
  HOST,
  MAX_STDERR_TAIL,
  MCP_URL,
  PORT,
  createInfohubMcpHost,
  fetchHealth,
  stderrTailOf,
};
