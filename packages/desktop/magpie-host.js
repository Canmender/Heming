"use strict";
/**
 * 内置 magpie 网关托管（d.91）：把 magpie 当成和鸣的原生组件。
 *
 * 背景：和鸣的模型层已改为「只连本机 magpie 网关」（见 d.90）。桌面端随包携带
 * `resources/magpie/magpie-cli.exe`，由主进程负责：
 *   1. 启动 `magpie serve`（不弹窗、后台进程）；
 *   2. 轮询 `GET /api/hello` 等到网关就绪（拿到版本）；
 *   3. 退出时回收整棵子进程树（Windows 用 taskkill /T /F，POSIX 用进程组）。
 *
 * 为什么二进制不在仓库里：约 70MB，构建时由 `scripts/fetch-magpie.mjs` 下载并校验 SHA256SUMS
 * 放进 `packages/desktop/resources/magpie/`（打包后随 extraResources 进安装包）。
 *
 * 边界：
 * - 只在本机回环上跑，不对外开放端口；
 * - 不读、不改 magpie 的账号与配置（它自己管）；
 * - 所有外部依赖（spawn/fetch/sleep/exists）都可注入，单测不真的起进程。
 */

const path = require("node:path");

const DEFAULT_PORT = 3425;
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const HEALTH_TIMEOUT_MS = 3_000;
const STOP_TIMEOUT_MS = 8_000;
const STDERR_TAIL_LINES = 12;

/** 打包/开发两种布局下的二进制路径。 */
function resolveBinaryPath({ isPackaged, resourcesPath, appDir, platform = process.platform, env = process.env }) {
  if (env.HEMING_MAGPIE_BIN && String(env.HEMING_MAGPIE_BIN).trim()) {
    return String(env.HEMING_MAGPIE_BIN).trim();
  }
  const exe = platform === "win32" ? "magpie-cli.exe" : "magpie-cli";
  if (isPackaged) return path.join(resourcesPath, "magpie", exe);
  return path.join(appDir, "resources", "magpie", exe);
}

/** 默认的整树回收：Windows 必须 /T /F；POSIX 用进程组（spawn 时 detached）。 */
function defaultKillTree(
  child,
  { platform = process.platform, spawn = require("node:child_process").spawn } = {},
) {
  const pid = child && child.pid;
  if (!pid) return;
  if (platform === "win32") {
    try {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      return;
    } catch {
      /* 落到下面的 child.kill 兜底 */
    }
  } else {
    try {
      process.kill(-pid, "SIGTERM");
      return;
    } catch {
      /* 不是进程组组长/已退出：回落 child.kill */
    }
  }
  try {
    child.kill();
  } catch {
    /* 已退出 */
  }
}

/**
 * 创建托管器。start/stop/status 都幂等；并发 start 复用同一个进行中的 Promise。
 */
function createMagpieHost(opts) {
  const {
    binaryPath,
    port = DEFAULT_PORT,
    spawn,
    fetchImpl = (...args) => fetch(...args),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => Date.now(),
    exists = require("node:fs").existsSync,
    killTree = (child) => defaultKillTree(child),
    log = () => {},
    platform = process.platform,
    readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
    // 启动参数：正式用法是 ["serve"]；集成验证/自检可换成任意等价入口。
    args = ["serve"],
  } = opts || {};

  let child = null;
  let startedAt = 0;
  let version;
  let lastError = null;
  let starting = null;
  /** 主动停止中：此时的退出不是故障，不该记 lastError。 */
  let stopping = false;
  /**
   * 外部实例（用户自己开的 magpie，例如菜单栏应用）：此时不 spawn、不杀它，
   * 只把地址与版本借过来用。端口冲突是真实场景——用户可能本来就在跑 magpie。
   */
  let external = false;
  const stderrTail = [];

  const running = () => Boolean(child) && child.exitCode === null && child.signalCode === null;

  function rememberStderr(chunk) {
    const text = String(chunk || "");
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      stderrTail.push(line.trim().slice(0, 300));
      if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
    }
  }

  async function probeHealth() {
    try {
      const response = await fetchImpl(`http://127.0.0.1:${port}/api/hello`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      if (!response.ok) return null;
      const info = await response.json().catch(() => null);
      if (!info || info.name !== "magpie") return null;
      return { version: typeof info.version === "string" ? info.version : undefined };
    } catch {
      return null;
    }
  }

  async function start() {
    if (running()) return { port, version };
    if (starting) return starting;
    if (!exists(binaryPath)) {
      throw new Error(
        `没有找到内置 magpie（${binaryPath}）。开发态先运行 node scripts/fetch-magpie.mjs 下载；` +
          "或在设置里改用手动网关地址。",
      );
    }
    starting = (async () => {
      lastError = null;
      stderrTail.length = 0;
      // 先看端口上是不是已经有一个 magpie（用户自己开的菜单栏应用/服务）。
      // 有就采用它：再 spawn 一个只会撞端口，还会让用户以为自己开的那份被抢了。
      const existing = await probeHealth();
      if (existing) {
        external = true;
        version = existing.version;
        startedAt = now();
        log(`[magpie] 采用已在运行的本机 magpie${version ? `（${version}）` : ""}（端口 ${port}）`);
        return { port, version, external: true };
      }
      log(`[magpie] 启动：${binaryPath} ${args.join(" ")}（端口 ${port}）`);
      const spawned = spawn(binaryPath, args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        // POSIX 下放进自己的进程组，退出时才能整组回收。
        detached: platform !== "win32",
        env: { ...process.env, MAGPIE_GATEWAY: `http://127.0.0.1:${port}` },
      });
      child = spawned;
      startedAt = now();
      if (spawned.stdout) spawned.stdout.on("data", (chunk) => log(`[magpie] ${String(chunk).trim()}`));
      if (spawned.stderr) spawned.stderr.on("data", rememberStderr);
      spawned.on("error", (err) => {
        lastError = err instanceof Error ? err.message : String(err);
        log(`[magpie] 启动失败：${lastError}`);
      });
      spawned.on("exit", (code, signal) => {
        if (!stopping && code !== 0 && code !== null) lastError = `magpie 退出（code=${code}）`;
        log(`[magpie] 已退出（code=${code}, signal=${signal}）`);
        child = null;
      });

      const deadline = now() + readyTimeoutMs;
      while (now() < deadline) {
        const health = await probeHealth();
        if (health) {
          version = health.version;
          log(`[magpie] 就绪${version ? `（${version}）` : ""}`);
          return { port, version };
        }
        if (!running() && !starting) break;
        await sleep(500);
      }
      const tail = stderrTail.length ? `；输出：${stderrTail[stderrTail.length - 1]}` : "";
      await stop();
      throw new Error(`magpie 网关没有在规定时间内就绪（端口 ${port}）${tail}`);
    })().finally(() => {
      starting = null;
    });
    return starting;
  }

  async function stop() {
    if (external) {
      // 外部实例不是我们拉起的：只断开「使用关系」，不杀用户的进程。
      external = false;
      version = undefined;
      startedAt = 0;
      return;
    }
    const target = child;
    if (!target) return;
    stopping = true;
    child = null;
    try {
      killTree(target);
    } catch (err) {
      log(`[magpie] 停止失败：${err?.message ?? err}`);
    }
    // 等它真的退出；超时也继续（退出流程不能卡死应用）。
    const deadline = now() + STOP_TIMEOUT_MS;
    while (now() < deadline) {
      if (target.exitCode !== null || target.signalCode !== null) break;
      await sleep(100);
    }
    version = undefined;
    startedAt = 0;
    stopping = false;
  }

  function status() {
    return {
      available: Boolean(binaryPath) && exists(binaryPath),
      running: running() || external,
      external,
      port,
      version,
      binaryPath,
      startedAt: running() || external ? startedAt : 0,
      lastError,
      stderrTail: stderrTail.slice(),
    };
  }

  return { start, stop, status, probeHealth, port };
}

module.exports = {
  DEFAULT_PORT,
  DEFAULT_READY_TIMEOUT_MS,
  createMagpieHost,
  defaultKillTree,
  resolveBinaryPath,
};
