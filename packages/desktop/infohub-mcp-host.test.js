"use strict";
/**
 * 采集桥托管（infohub-mcp-host.js）单测。
 *
 * ★ 全部注入替身：假 spawn、假 fetch、假子进程 EventEmitter。
 *   这里**不许真的拉起 Python、不许真的监听 8776**——测试跑在开发机上，
 *   真 spawn 会去抢用户正在用的端口，真监听会留下占端口的进程。
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const {
  HEALTH_URL,
  MCP_URL,
  MAX_STDERR_TAIL,
  PORT,
  createInfohubMcpHost,
  fetchHealth,
  stderrTailOf,
} = require("./infohub-mcp-host");

const PACKAGE_DIR = path.join(process.cwd(), "infohub");
const DEFAULT_HOME = path.join(process.cwd(), "home", "Heming", "infohub");
const CONFIGURED_PYTHON = "C:\\Python312\\python.exe";
const BUNDLED_PYTHON = "C:\\app\\resources\\runtime\\mcp-env\\Scripts\\python.exe";

/** 假子进程：可手动 emit stdout/stderr/exit/error。 */
function fakeChild(pid = 4321) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
  child.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
  child.kill = () => {
    child.killedByUs = true;
  };
  return child;
}

/**
 * 假回收：记录调用参数并「杀掉」假子进程。
 * ★ 必须注入：缺省实现会真的 taskkill /T /F，测试里的 4321 是假 PID。
 */
function fakeTeardown(calls = []) {
  const fn = (child, deps) => {
    child?.kill?.();
    calls.push({ pid: child?.pid, ...deps });
    return Promise.resolve({ exited: true, via: "fake" });
  };
  fn.calls = calls;
  return fn;
}

/** 让 async 链推进一轮。 */
function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

/** 等到条件成立（最多 ~2s），用于等 spawn 真的发生。 */
async function until(predicate) {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("等待条件超时");
}

/** 前 N 次探测失败、之后成功的假 /health（模拟「外部没在跑 → 我们自己拉起来」）。 */
function healthyFetch({ failFirst = 1 } = {}) {
  let calls = 0;
  return async () => {
    calls += 1;
    if (calls <= failFirst) return { ok: false, status: 503 };
    return { ok: true, status: 200, json: async () => ({ status: "ok" }) };
  };
}

function makeHost(overrides = {}) {
  const spawned = [];
  const teardown = overrides.teardown ?? fakeTeardown();
  const probes = [];
  const baseFetch = overrides.fetchImpl ?? (async () => ({ ok: false, status: 503 }));
  const fetchImpl = async (url, opts) => {
    probes.push({ url, opts });
    return baseFetch(url, opts);
  };
  const events = [];
  const host = createInfohubMcpHost({
    spawn: (command, args, opts) => {
      if (overrides.spawnThrows) throw new Error(overrides.spawnThrows);
      const child = fakeChild(overrides.pid ?? 4321);
      spawned.push({ command, args, opts, child });
      return child;
    },
    log: overrides.log ?? (() => {}),
    packageDir: overrides.packageDir ?? PACKAGE_DIR,
    bundledPythonPath: overrides.bundledPythonPath ?? null,
    defaultHome: overrides.defaultHome ?? DEFAULT_HOME,
    fetchImpl,
    platform: overrides.platform ?? "win32",
    exists:
      overrides.exists ??
      ((target) => target === CONFIGURED_PYTHON || target === BUNDLED_PYTHON),
    teardown,
    healthTimeoutMs: overrides.healthTimeoutMs ?? 200,
    healthIntervalMs: overrides.healthIntervalMs ?? 1,
    probeTimeoutMs: overrides.probeTimeoutMs ?? 50,
    now: overrides.now,
    sleep: overrides.sleep,
  });
  if (overrides.onEvent !== false) host.onEvent((snapshot) => events.push(snapshot));
  return { host, spawned, teardown, probes, events };
}

// ── 状态形状（规格 §6.1 唯一事实来源）──

test("status：字段名与规格 §6.1 逐字一致，初始为「未运行」", () => {
  const { host, spawned, probes } = makeHost();
  assert.deepEqual(host.status(), {
    running: false,
    starting: false,
    url: null,
    port: 8776,
    home: null,
    python: null,
    pythonSource: "unknown",
    source: "none",
    since: null,
    error: null,
  });
  assert.equal(spawned.length, 0);
  assert.equal(probes.length, 0);
});

test("不自动启动：加载模块 / 创建实例不 spawn、不探健康，源码里没有 ready 钩子", () => {
  makeHost();
  // 源码层面再钉一次：模块里不许出现应用生命周期钩子或后台定时拉起。
  const code = fs
    .readFileSync(path.join(__dirname, "infohub-mcp-host.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
  assert.equal(/whenReady|setInterval|\.on\("ready"/.test(code), false, "托管模块不得有自动启动路径");
});

// ── 启动成功 ──

test("启动成功：先探外部端点，再 spawn，argv/env/cwd 与 stdio 边车同构", async () => {
  const { host, spawned, probes, events, teardown } = makeHost({ fetchImpl: healthyFetch() });
  const home = path.join(process.cwd(), "archive", "qq");

  const status = await host.start({ home, python: CONFIGURED_PYTHON });

  assert.equal(spawned.length, 1, "外部端点不通才应该拉起进程");
  const { command, args, opts } = spawned[0];
  assert.equal(command, path.normalize(CONFIGURED_PYTHON));
  assert.deepEqual(args, ["-m", "infohub.mcp_server", "--host", "127.0.0.1", "--port", "8776"]);
  assert.equal(opts.cwd, PACKAGE_DIR);
  assert.equal(opts.shell, false);
  assert.equal(opts.windowsHide, true);
  assert.deepEqual(opts.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(opts.detached, undefined, "Windows 没有进程组，不该 detached");
  assert.equal(opts.env.INFOHUB_HOME, path.normalize(home));
  assert.ok(
    opts.env.PYTHONPATH === PACKAGE_DIR || opts.env.PYTHONPATH.startsWith(PACKAGE_DIR + path.delimiter),
    "PYTHONPATH 必须包含随包 infohub 目录",
  );

  assert.deepEqual(status, {
    running: true,
    starting: false,
    url: MCP_URL,
    port: PORT,
    home: path.normalize(home),
    python: path.normalize(CONFIGURED_PYTHON),
    pythonSource: "configured",
    source: "app",
    since: status.since,
    error: null,
  });
  assert.ok(typeof status.since === "number" && status.since > 0);
  assert.equal(status.url, "http://127.0.0.1:8776/mcp");

  assert.equal(probes.length, 2, "一次外部端点探测 + 一次健康轮询");
  assert.equal(probes[0].url, HEALTH_URL);
  assert.equal(host.idle(), false);

  // 状态事件：先 starting，再 running；每个快照都完整。
  assert.ok(events.length >= 2);
  assert.equal(events[0].starting, true);
  assert.equal(events[0].running, false);
  const last = events.at(-1);
  assert.equal(last.running, true);
  assert.equal(last.source, "app");
  for (const snapshot of events) assert.equal(Object.keys(snapshot).length, 10);

  // 幂等：已经在跑再 start 不再 spawn。
  const again = await host.start({ home, python: CONFIGURED_PYTHON });
  assert.equal(spawned.length, 1);
  assert.deepEqual(again, host.status());

  assert.equal(host.stop(), true);
  assert.equal(teardown.calls.length, 1);
  await host.dispose();
  assert.equal(host.idle(), true);
});

test("并发 start 共用同一份启动：不会对同一端口 spawn 两次", async () => {
  const { host, spawned } = makeHost({ fetchImpl: healthyFetch() });
  const first = host.start({ home: path.join(process.cwd(), "a"), python: CONFIGURED_PYTHON });
  const second = host.start({ home: path.join(process.cwd(), "b"), python: CONFIGURED_PYTHON });
  assert.equal(first, second, "并发调用必须复用同一个 Promise");
  await first;
  assert.equal(spawned.length, 1);
  await host.dispose();
});

test("非 Windows：spawn 带 detached（POSIX 整组回收要求子进程是组长）", async () => {
  const { host, spawned } = makeHost({ platform: "linux", fetchImpl: healthyFetch() });
  await host.start({ home: path.join(process.cwd(), "a"), python: CONFIGURED_PYTHON });
  assert.equal(spawned[0].opts.detached, true);
  await host.dispose();
});

test("解释器选择：用户配置优先；配置不可用时回退内置运行时", async () => {
  const configured = makeHost({
    fetchImpl: healthyFetch(),
    bundledPythonPath: BUNDLED_PYTHON,
    exists: (target) => target === CONFIGURED_PYTHON || target === BUNDLED_PYTHON,
  });
  await configured.host.start({ home: path.join(process.cwd(), "a"), python: CONFIGURED_PYTHON });
  assert.equal(configured.spawned[0].command, path.normalize(CONFIGURED_PYTHON));
  assert.equal(configured.host.status().pythonSource, "configured");
  await configured.host.dispose();

  const fallback = makeHost({
    fetchImpl: healthyFetch(),
    bundledPythonPath: BUNDLED_PYTHON,
    exists: (target) => target === BUNDLED_PYTHON,
  });
  // 相对路径不是合法解释器配置（normalizePython 会拒绝），必须回退内置运行时。
  await fallback.host.start({ home: path.join(process.cwd(), "a"), python: "python.exe" });
  assert.equal(fallback.spawned[0].command, path.normalize(BUNDLED_PYTHON));
  assert.equal(fallback.host.status().pythonSource, "bundled");
  await fallback.host.dispose();
});

// ── 外部端点复用 ──

test("外部端点已在跑：标记 external 并直接复用，绝不重复拉进程", async () => {
  const { host, spawned, teardown } = makeHost({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ status: "ok" }) }),
  });
  const status = await host.start({ home: path.join(process.cwd(), "a"), python: CONFIGURED_PYTHON });

  assert.equal(spawned.length, 0, "外部端点通的时候不许 spawn");
  assert.equal(status.running, true);
  assert.equal(status.source, "external");
  assert.equal(status.pythonSource, "external");
  assert.equal(status.python, null, "external 时解释器不是我们选的，必须给 null");
  assert.equal(status.url, MCP_URL);
  assert.ok(status.since > 0);

  // 不是我们拉起的进程：stop 返回 false 且状态不变（界面据此提示去原窗口关闭）。
  assert.equal(host.stop(), false);
  assert.equal(host.status().running, true);
  assert.equal(host.status().source, "external");
  assert.equal(teardown.calls.length, 0);
  await host.dispose();
  assert.equal(host.status().source, "external", "dispose 不碰外部进程");
});

// ── 失败态：中文 + 可执行 + stderr 尾巴 ──

test("缺解释器：抛中文可执行错误、不 spawn、状态回到 none/missing", async () => {
  const { host, spawned, probes } = makeHost({ fetchImpl: async () => ({ ok: false, status: 503 }), exists: () => false });
  await assert.rejects(
    host.start({ home: path.join(process.cwd(), "a"), python: CONFIGURED_PYTHON }),
    /未找到可用的 Python 解释器/,
  );
  assert.equal(spawned.length, 0, "没有解释器就不该 spawn");
  assert.equal(probes.length, 1, "先探外部端点，再判定解释器");
  const status = host.status();
  assert.equal(status.running, false);
  assert.equal(status.starting, false);
  assert.equal(status.source, "none");
  assert.equal(status.pythonSource, "missing");
  assert.equal(status.python, null);
  assert.equal(status.url, null);
  assert.equal(status.since, null);
  assert.match(status.error, /Python 解释器/);
  assert.equal(host.idle(), true);
});

test("端口占用：stderr 里的 EADDRINUSE 变成中文错误（含 stderr 尾巴）", async () => {
  const { host, spawned, teardown } = makeHost({ fetchImpl: async () => ({ ok: false, status: 503 }) });
  const pending = host.start({ home: path.join(process.cwd(), "a"), python: CONFIGURED_PYTHON });
  await until(() => spawned.length === 1);

  spawned[0].child.stderr.emit("data", "OSError: [WinError 10048] Address already in use: ('127.0.0.1', 8776)\n");
  spawned[0].child.emit("exit", 1, null);

  await assert.rejects(pending, /端口 8776 已被占用/);
  const status = host.status();
  assert.equal(status.running, false);
  assert.equal(status.starting, false);
  assert.equal(status.source, "none");
  assert.equal(status.since, null);
  assert.match(status.error, /端口 8776 已被占用/);
  assert.match(status.error, /Address already in use/, "错误里要带 stderr 尾巴，用户才知道原始原因");
  assert.equal(teardown.calls.length, 1);
  assert.equal(teardown.calls[0].graceMs, 0, "起不来的进程当场整树回收");
  await host.dispose();
  assert.equal(host.idle(), true);
});

test("进程早退（非端口占用）：中文错误带 stderr 尾巴与可执行提示", async () => {
  const { host, spawned } = makeHost({ fetchImpl: async () => ({ ok: false, status: 503 }) });
  const pending = host.start({ home: path.join(process.cwd(), "a"), python: CONFIGURED_PYTHON });
  await until(() => spawned.length === 1);

  spawned[0].child.stderr.emit("data", "ModuleNotFoundError: No module named 'infohub.mcp_server'\n");
  spawned[0].child.emit("exit", 3, null);

  await assert.rejects(pending, /启动失败/);
  const status = host.status();
  assert.equal(status.running, false);
  assert.equal(status.source, "none");
  assert.match(status.error, /code=3/);
  assert.match(status.error, /ModuleNotFoundError/);
  assert.match(status.error, /内置运行时/);
  await host.dispose();
});

test("健康检查一直不通且进程不死：超时后回收并如实报错", async () => {
  let clock = 0;
  const { host, spawned, teardown } = makeHost({
    fetchImpl: async () => ({ ok: false, status: 503 }),
    healthTimeoutMs: 30,
    healthIntervalMs: 5,
    now: () => (clock += 10),
    sleep: async () => {},
  });
  await assert.rejects(host.start({ home: path.join(process.cwd(), "a"), python: CONFIGURED_PYTHON }), /启动超时/);
  assert.equal(spawned.length, 1);
  assert.equal(host.status().running, false);
  assert.equal(host.status().source, "none");
  assert.match(host.status().error, /启动超时/);
  assert.equal(teardown.calls.length, 1);
  await host.dispose();
  assert.equal(host.idle(), true);
});

test("spawn 同步抛错：收成中文错误并回到失败态", async () => {
  const { host } = makeHost({ fetchImpl: async () => ({ ok: false, status: 503 }), spawnThrows: "ENOENT: spawn python failed" });
  await assert.rejects(host.start({ home: path.join(process.cwd(), "a"), python: CONFIGURED_PYTHON }), /采集桥启动失败/);
  const status = host.status();
  assert.equal(status.running, false);
  assert.equal(status.source, "none");
  assert.match(status.error, /ENOENT/);
});

// ── 运行时退出 / stop / dispose ──

test("运行中意外退出：状态回到未运行并带中文原因", async () => {
  const { host, spawned, events } = makeHost({ fetchImpl: healthyFetch() });
  await host.start({ home: path.join(process.cwd(), "a"), python: CONFIGURED_PYTHON });
  spawned[0].child.stderr.emit("data", "Traceback (most recent call last):\n");
  spawned[0].child.emit("exit", 1, null);
  await tick();

  const status = host.status();
  assert.equal(status.running, false);
  assert.equal(status.starting, false);
  assert.equal(status.source, "none");
  assert.equal(status.since, null);
  assert.equal(status.url, null);
  assert.match(status.error, /意外退出/);
  assert.match(status.error, /Traceback/);
  assert.equal(events.at(-1).error, status.error);
  assert.equal(host.idle(), true);
});

test("stop：app 进程走整树回收，状态立刻置为停止", async () => {
  const { host, teardown } = makeHost({ fetchImpl: healthyFetch() });
  await host.start({ home: path.join(process.cwd(), "a"), python: CONFIGURED_PYTHON });
  assert.equal(host.stop(), true);
  assert.deepEqual(host.status(), {
    running: false,
    starting: false,
    url: null,
    port: 8776,
    home: path.normalize(path.join(process.cwd(), "a")),
    python: path.normalize(CONFIGURED_PYTHON),
    pythonSource: "configured",
    source: "none",
    since: null,
    error: null,
  });
  assert.equal(teardown.calls.length, 1);
  assert.equal(teardown.calls[0].graceMs, 1500, "默认先礼貌等 1.5s 再拔树");
  assert.equal(host.stop(), false, "没有可停的进程");
  await host.dispose();
});

test("dispose：等在途回收跑完才 idle（退出流程据此决定拦不拦）", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const calls = [];
  const teardown = (child, deps) => {
    calls.push({ pid: child?.pid, ...deps });
    return gate.then(() => ({ exited: true, via: "fake" }));
  };
  const { host } = makeHost({ fetchImpl: healthyFetch(), teardown });
  await host.start({ home: path.join(process.cwd(), "a"), python: CONFIGURED_PYTHON });

  assert.equal(host.stop(), true);
  assert.equal(host.idle(), false, "回收还在途：这时退出照样要等");
  const disposing = host.dispose();
  await tick();
  assert.equal(host.idle(), false);
  release();
  await disposing;
  assert.equal(host.idle(), true);
  assert.equal(calls.length, 1);
});

// ── 事件订阅 ──

test("onEvent：状态变化逐个推送，退订后不再收到，非函数不注册", async () => {
  const { host, events } = makeHost({ fetchImpl: healthyFetch(), onEvent: false });
  const received = [];
  const off = host.onEvent((snapshot) => received.push(snapshot));
  const noop = host.onEvent("not a function");
  assert.equal(typeof noop, "function");

  await host.start({ home: path.join(process.cwd(), "a"), python: CONFIGURED_PYTHON });
  assert.ok(received.length >= 2);
  assert.equal(received[0].starting, true);
  assert.equal(received.at(-1).running, true);
  assert.equal(events.length, 0, "未注册时不该有事件");
  assert.notEqual(received[0], host.status(), "推送的是快照，不是内部状态引用");

  off();
  const before = received.length;
  assert.equal(host.stop(), true);
  assert.equal(received.length, before, "退订后不该再收到");
  await host.dispose();
});

// ── 纯函数 ──

test("fetchHealth：只回 ok 布尔，异常收成 error（不抛）", async () => {
  const requested = [];
  const ok = await fetchHealth(async (url) => {
    requested.push(url);
    return { ok: true, status: 200, json: async () => ({ status: "ok" }) };
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.body, { status: "ok" });
  assert.deepEqual(requested, [HEALTH_URL]);

  const down = await fetchHealth(async () => ({ ok: false, status: 503 }));
  assert.equal(down.ok, false);
  assert.match(down.error, /503/);

  const refused = await fetchHealth(async () => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:8776");
  });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /ECONNREFUSED/);

  assert.equal((await fetchHealth(undefined)).ok, false);
});

test("stderrTailOf：尾部最多 4000 字符（错误里不塞整份日志）", () => {
  assert.equal(stderrTailOf("  \n "), "");
  assert.equal(stderrTailOf("x".repeat(10)).length, 10);
  assert.equal(stderrTailOf("x".repeat(10_000)).length, MAX_STDERR_TAIL);
  assert.equal(MAX_STDERR_TAIL, 4_000);
});
