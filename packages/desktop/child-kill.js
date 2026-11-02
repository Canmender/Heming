"use strict";
/**
 * 子进程树回收（d.50）。
 *
 * ★ 为什么不能继续用 `child.kill()`：Node 只给**直接子进程**发信号。
 *   - Windows：`kill()` = 对那个 PID 的 TerminateProcess，孙子进程全活着。
 *     MCP 服务经 `npx` 起的 node/Chromium、InfoHub 里 Python 起的转写与 bot 进程
 *     都会变成孤儿，占内存、锁文件（归档 SQLite、release 目录的 EBUSY 就是这么来的）。
 *   - POSIX：只杀父进程同样留下 MCP 的孙子；要杀整组得靠 `kill(-pgid)`。
 *
 * ★ 两个平台没有对称做法，别指望一条路走天下：
 *   - Windows 没有「礼貌地问整棵树退出」的原生手段（`taskkill /T` 不带 `/F` 只对
 *     GUI 程序发 WM_CLOSE，控制台服务收不到）。所以礼貌交给**协议层**
 *     （InfoHub 先写 `shutdown`、MCP 靠 stdin 关闭），超时后直接 `/T /F` 拔树。
 *   - POSIX 的 `kill(-pid)` 只有当子进程**是自己进程组组长**时才安全——否则负号打在
 *     别人组的头上。所以两个桥的 spawn 在非 Windows 上都带 `detached: true`。
 *
 * 判据与分支借 hermes-agent `electron/backend-child.ts`（MIT © 2025 Nous Research），
 * 按和鸣的两个消费者（infohub-bridge / mcp-stdio）改写过：和鸣没有 HTTP 后端，
 * 不需要它的 descriptor/claim 那一套。
 */

/** 等礼貌退出的缺省预算（毫秒）。 */
const DEFAULT_GRACE_MS = 1_500;
/** 每次发完信号后，确认「真的死了」最多再等多项。 */
const ESCALATION_WAIT_MS = 1_000;
/**
 * taskkill 自己的超时：它是个真进程，不能让它把退出流程拖住。
 * ★ execFileSync 会**同步阻塞主进程**，所以这里取小值：taskkill 只是发个终止请求，
 *   实测几百毫秒内返回；2s 已经是它不正常时的上限，再大就是界面卡死。
 */
const TASKKILL_TIMEOUT_MS = 2_000;
/** 应用退出时最多整体等这么久；到点照样放行退出，绝不卡死关闭。 */
const QUIT_CAP_MS = 4_000;

const hasPid = (child) => Number.isInteger(child?.pid) && child.pid > 0;

/**
 * 进程是否已经退出。
 * ★ `null` 与 `undefined` 不是一回事：Node 给活着的子进程的是 **null**（还没退出），
 *   而没有这两个字段的对象（假子进程、老版本、非 ChildProcess 的包装）只能算「没报告」，
 *   当成已退出就等于一个信号都不发直接放它走——孤儿正是这么留下的。
 */
function hasExited(child) {
  if (!child) return true;
  const reported = (v) => v !== null && v !== undefined;
  return reported(child.exitCode) || reported(child.signalCode);
}

/**
 * Windows：连根拔起（`/T` = 整棵树，`/F` = 强制）。
 * 参数走数组 + `shell:false`，PID 先过整数校验——拼字符串给 shell 就是注入口。
 * @returns {boolean} 是否成功执行（失败通常意味着进程已经没了，不是错误）
 */
function forceKillProcessTree(pid, deps = {}) {
  if (!(Number.isInteger(pid) && pid > 0)) return false;
  const execFileSync = deps.execFileSync ?? require("node:child_process").execFileSync;
  try {
    execFileSync("taskkill", ["/T", "/F", "/PID", String(pid)], {
      windowsHide: true,
      stdio: "ignore",
      timeout: deps.taskkillTimeoutMs ?? TASKKILL_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false; // 进程已不存在 / taskkill 缺失：调用方以 exit 事件为准
  }
}

/**
 * 第一档信号（礼貌档）。
 * @returns {"tree"|"group"|"direct"} 实际走了哪条路（留痕与测试用）
 */
function signalTree(child, deps = {}) {
  if (!child || hasExited(child)) return "direct";
  if (deps.isWindows ?? process.platform === "win32") {
    forceKillProcessTree(child.pid, deps);
    return "tree";
  }
  const kill = deps.killGroup ?? ((p, sig) => process.kill(p, sig));
  const signal = deps.signal ?? "SIGTERM";
  if (hasPid(child)) {
    try {
      kill(-child.pid, signal);
      return "group";
    } catch {
      // ESRCH/EPERM：这进程不是组长（旧包留下的子进程、或 detached 没生效），退化成单打
    }
  }
  try {
    child.kill(signal);
  } catch {
    /* 已经没了 */
  }
  return "direct";
}

/** 强杀档：POSIX 给整组补 SIGKILL。Windows 的 signalTree 已经是 `/T /F`，无需再来。 */
function signalEscalate(child, deps = {}) {
  if (!hasPid(child)) return false;
  if (deps.isWindows ?? process.platform === "win32") return false;
  const kill = deps.killGroup ?? ((p, sig) => process.kill(p, sig));
  try {
    kill(-child.pid, "SIGKILL");
    return true;
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* 已经没了 */
    }
    return false;
  }
}

/** 等一次退出事件；已经退出就立刻 resolve。 */
function waitForExit(child, timeoutMs) {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (exited) => {
      clearTimeout(timer);
      child?.removeListener?.("exit", onExit);
      resolve(exited);
    };
    const onExit = () => done(true);
    const timer = setTimeout(() => done(hasExited(child)), timeoutMs);
    // 故意不 unref：这个定时器是「别留孤儿」的最后一道保险，
    // 主进程事件循环空下来时它必须还能响（此前 stop 里 unref 的 kill 定时器正是孤儿成因）。
    child?.once?.("exit", onExit);
  });
}

/**
 * 收尾一个子进程：等礼貌退出 → 整组/整树信号 → 确认 → 还不死就强杀 → 再确认。
 * 返回 `exited:false` 表示**没能证明它死了**（调用方要如实留痕，不能当已经回收）。
 *
 * 最坏耗时 = graceMs + killWaitMs×2；`graceMs:0` 时 = killWaitMs×2。
 */
async function teardownChild(child, deps = {}) {
  if (!child) return { exited: true, via: "none" };
  if (hasExited(child)) return { exited: true, via: "already" };

  const isWindows = deps.isWindows ?? process.platform === "win32";
  const killWaitMs = deps.killWaitMs ?? ESCALATION_WAIT_MS;
  const graceMs = deps.graceMs ?? DEFAULT_GRACE_MS;
  if (graceMs > 0 && (await waitForExit(child, graceMs))) {
    return { exited: true, via: "graceful" };
  }

  const via = signalTree(child, { ...deps, isWindows });
  if (await waitForExit(child, killWaitMs)) return { exited: true, via };

  const escalated = signalEscalate(child, { ...deps, isWindows });
  const exited = await waitForExit(child, killWaitMs);
  return { exited, via: escalated ? "force-group" : via };
}

/**
 * 应用退出用的「一次性回收闸」。
 *
 * `will-quit` 是同步事件，回收却是异步的：第一道信号发完就放行，Electron 直接退，
 * 子进程变孤儿。所以这里拦一次（preventDefault）→ 等回收 → 再 `app.quit()`；
 * 第二次进来必须放行，并且**带硬超时**——进程杀不动也不能让用户关不掉应用。
 *
 * @param {object} deps
 * @param {() => Array<() => (Promise|void)>} deps.tasks 本次需要执行的回收（返回空数组就不拦）
 * @param {() => void} deps.onQuit 回收结束（或超闸）后真正触发退出
 * @param {number} [deps.capMs]
 * @param {(line: string) => void} [deps.log]
 * @returns {(event: {preventDefault?: () => void}) => void} 直接挂给 `app.on("will-quit", ...)`
 */
function createChildReclaimer({ tasks, onQuit, capMs = QUIT_CAP_MS, log = () => {} }) {
  let armed = false;
  return function onWillQuit(event) {
    if (armed) return; // 已经拦过一次：这次放行，保证退出通路不被自己堵死
    let pending;
    try {
      pending = tasks().filter((t) => typeof t === "function");
    } catch (err) {
      log(`子进程回收任务枚举失败：${err?.message ?? err}`);
      return; // 枚举都失败 ⇒ 没有已知子进程，别拖慢退出
    }
    if (pending.length === 0) return;

    armed = true;
    event?.preventDefault?.();
    const settled = Promise.allSettled(pending.map((run) => Promise.resolve().then(run)));
    // 超闸定时器**不能 unref**：任务永远挂着时，事件循环可能已经空了，
    // 一旦被 unref 它就再也不响 —— 用户换来的是「应用关不掉」，比留孤儿更糟。
    const cap = new Promise((resolve) => {
      setTimeout(resolve, capMs);
    });
    Promise.race([settled, cap]).then(() => {
      try {
        onQuit();
      } catch (err) {
        log(`退出触发失败：${err?.message ?? err}`);
      }
    });
  };
}

module.exports = {
  DEFAULT_GRACE_MS,
  ESCALATION_WAIT_MS,
  QUIT_CAP_MS,
  TASKKILL_TIMEOUT_MS,
  createChildReclaimer,
  forceKillProcessTree,
  hasExited,
  signalEscalate,
  signalTree,
  teardownChild,
  waitForExit,
};
