"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const {
  createInfohubBridge,
  encodeMessage,
  extractMessages,
  isValidMethod,
  normalizeHome,
  registerInfohubIpc,
  resolveDefaultHome,
  resolveInfohubPackageDir,
  resolvePython,
} = require("./infohub-bridge");

/** 假子进程：记录 stdin 写入，可手动 emit stdout/stderr/exit。 */
function fakeChild(pid = 4321) {
  const writes = [];
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
  child.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
  child.stdin = {
    ended: false,
    write(chunk) {
      writes.push(String(chunk));
      return true;
    },
    end() {
      this.ended = true;
    },
  };
  child.kill = () => {
    child.killedByUs = true;
  };
  return { child, writes };
}

function reply(child, payload) {
  child.stdout.emit("data", JSON.stringify(payload) + "\n");
}

/** 让 async 链推进一轮：start 等 hello 后才写请求。 */
function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * 假回收：**同步** kill（沿用旧断言里的 killedByUs），并记录每次调用。
 * ★ 单元测试必须注入它：缺省实现会真的调 taskkill /T /F，测试里的 4321 是假 PID，
 *   打在真机器上就是「跑个测试顺手杀了别人家的进程」。
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

function makeBridge(overrides = {}) {
  const spawned = [];
  const teardown = overrides.teardown ?? fakeTeardown();
  const bridge = createInfohubBridge({
    spawn: (command, args, opts) => {
      const { child, writes } = fakeChild();
      spawned.push({ command, args, opts, child, writes });
      return child;
    },
    packageDir: overrides.packageDir ?? path.join(process.cwd(), "infohub"),
    defaultHome: overrides.defaultHome ?? path.join(process.cwd(), "home"),
    bundledPythonPath: overrides.bundledPythonPath ?? "C:\\Python312\\python.exe",
    exists: overrides.exists ?? (() => true),
    log: overrides.log ?? (() => {}),
    helloTimeoutMs: overrides.helloTimeoutMs ?? 500,
    isWindows: overrides.isWindows ?? true,
    teardown,
  });
  return { bridge, spawned, teardown };
}

test("协议编码/切分：半包留到下一次，坏行忽略", () => {
  assert.equal(encodeMessage({ id: 1 }), '{"id":1}\n');
  const first = extractMessages('{"event":"progress"}\n{"id":2,');
  assert.equal(first.messages.length, 1);
  assert.equal(first.rest, '{"id":2,');
  const second = extractMessages(first.rest + '"ok":true}\nnot json\n');
  assert.deepEqual(second.messages, [{ id: 2, ok: true }]);
  assert.equal(second.rest, "");
});

test("路径解析：开发态/打包后指向不同的 InfoHub 包目录", () => {
  const dev = resolveInfohubPackageDir({
    isPackaged: false,
    resourcesPath: "C:\\app\\resources",
    dirname: path.join("C:\\app", "packages", "desktop"),
  });
  assert.equal(dev, path.join("C:\\app", "packages", "infohub"));

  const packaged = resolveInfohubPackageDir({
    isPackaged: true,
    resourcesPath: "C:\\app\\resources",
    dirname: "C:\\app\\resources\\app.asar",
  });
  assert.equal(packaged, path.join("C:\\app\\resources", "infohub"));

  assert.equal(resolveDefaultHome(path.join("C:\\app", "data")), path.join("C:\\app", "data", "infohub"));
});

test("数据目录校验：相对路径、换行、空值一律回退默认目录", () => {
  const fallback = path.join(process.cwd(), "home");
  assert.equal(normalizeHome("", fallback), fallback);
  assert.equal(normalizeHome("relative/dir", fallback), fallback);
  assert.equal(normalizeHome("D:\\ok\nD:\\evil", fallback), fallback);
  assert.equal(normalizeHome("  ", fallback), fallback);
  const absolute = path.join(process.cwd(), "archive");
  assert.equal(normalizeHome(absolute + path.sep, fallback), path.normalize(absolute + path.sep));
});

test("解释器选择：用户配置优先，其次内置，都没有则视为缺失", () => {
  const exists = (p) => p === "D:\\infohub\\.venv\\Scripts\\python.exe" || p === "C:\\bundled\\python.exe";
  assert.deepEqual(
    resolvePython({ configured: "D:\\infohub\\.venv\\Scripts\\python.exe", bundled: "C:\\bundled\\python.exe", exists }),
    { python: "D:\\infohub\\.venv\\Scripts\\python.exe", source: "configured" }
  );
  assert.deepEqual(
    resolvePython({ configured: "D:\\missing\\python.exe", bundled: "C:\\bundled\\python.exe", exists }),
    { python: "C:\\bundled\\python.exe", source: "bundled" }
  );
  assert.deepEqual(
    resolvePython({ configured: "D:\\missing\\python.exe", bundled: "C:\\also-missing.exe", exists }),
    { python: "", source: "missing" }
  );
  // 相对路径不接受：拼不出「第二条命令」
  assert.equal(resolvePython({ configured: "python.exe", exists }).source, "missing");
});

test("启动：用 -m infohub.bridge 拉起，带 INFOHUB_HOME/PYTHONPATH，等 hello 后返回", async () => {
  const { bridge, spawned } = makeBridge({ bundledPythonPath: "C:\\bundled\\python.exe" });
  const home = path.join(process.cwd(), "archive");
  const pending = bridge.start({ home });
  assert.equal(spawned.length, 1);
  const { command, args, opts, child } = spawned[0];
  assert.equal(command, "C:\\bundled\\python.exe");
  assert.deepEqual(args, ["-m", "infohub.bridge"]);
  assert.equal(opts.cwd, path.join(process.cwd(), "infohub"));
  assert.equal(opts.shell, false);
  assert.equal(opts.windowsHide, true);
  assert.equal(opts.env.INFOHUB_HOME, home);
  assert.ok(opts.env.PYTHONPATH.startsWith(path.join(process.cwd(), "infohub")));
  assert.equal(opts.env.PYTHONUNBUFFERED, "1");

  reply(child, { event: "hello", app: "infohub", version: "0.1.0", protocol: 1 });
  const info = await pending;
  assert.equal(info.running, true);
  assert.equal(info.pid, child.pid);
  assert.equal(info.hello.app, "infohub");
  assert.equal(info.home, home);
});

test("缺解释器：启动直接报可读错误，不 spawn", async () => {
  const spawned = [];
  const bridge = createInfohubBridge({
    spawn: (...args) => spawned.push(args),
    packageDir: process.cwd(),
    defaultHome: process.cwd(),
    bundledPythonPath: null,
    exists: () => false,
  });
  await assert.rejects(bridge.start({}), /未找到可用的 Python 解释器/);
  assert.equal(spawned.length, 0);
});

test("请求→响应按 id 配对；进度事件单独走订阅", async () => {
  const { bridge, spawned } = makeBridge();
  const events = [];
  const off = bridge.onEvent((event) => events.push(event));

  const pending = bridge.call("ping", {}, { home: path.join(process.cwd(), "h") });
  const { child, writes } = spawned[0];
  reply(child, { event: "hello", app: "infohub" });
  await tick();
  assert.equal(writes.length, 1);
  const request = JSON.parse(writes[0].trim());
  assert.equal(request.method, "ping");
  assert.equal(request.id, 1);

  reply(child, { event: "progress", phase: "sync", stage: "微信", current: 3, total: 10 });
  reply(child, { id: request.id, ok: true, result: { conversations: 255 } });
  assert.deepEqual(await pending, { conversations: 255 });
  assert.equal(events.length, 1);
  assert.equal(events[0].phase, "sync");
  off();
});

test("方法白名单：未知方法不 spawn，错误响应带 message/type", async () => {
  const { bridge, spawned } = makeBridge();
  await assert.rejects(bridge.call("shell.exec", {}, { home: path.join(process.cwd(), "h") }), /不支持的方法/);
  assert.equal(spawned.length, 0);

  const pending = bridge.call("status", {}, { home: path.join(process.cwd(), "h") });
  const { child, writes } = spawned[0];
  reply(child, { event: "hello" });
  await tick();
  const id = JSON.parse(writes[0].trim()).id;
  reply(child, { id, ok: false, error: { type: "ValueError", message: "会话不存在" } });
  await assert.rejects(pending, (err) => {
    assert.equal(err.message, "会话不存在");
    assert.equal(err.type, "ValueError");
    return true;
  });
});

test("进程退出：挂起请求立刻失败，并带上 stderr 尾巴", async () => {
  const { bridge, spawned } = makeBridge();
  const pending = bridge.call("search", { query: "免检单" }, { home: path.join(process.cwd(), "h") });
  const { child } = spawned[0];
  reply(child, { event: "hello" });
  await tick();
  child.stderr.emit("data", "Traceback: ModuleNotFoundError: zstandard\n");
  child.emit("exit", 1, null);
  await assert.rejects(pending, (err) => {
    assert.match(err.message, /进程已退出/);
    assert.match(err.message, /zstandard/);
    return true;
  });
  assert.equal(bridge.info().running, false);
});

test("配置变化会重启进程；stop 先发 shutdown 再回收", async () => {
  const { bridge, spawned } = makeBridge();
  const homeA = path.join(process.cwd(), "a");
  const homeB = path.join(process.cwd(), "b");

  const first = bridge.start({ home: homeA });
  reply(spawned[0].child, { event: "hello" });
  await first;

  const second = bridge.start({ home: homeB });
  assert.equal(spawned.length, 2);
  assert.equal(spawned[0].child.killedByUs, true);
  assert.equal(spawned[0].opts.env.INFOHUB_HOME, homeA);
  assert.equal(spawned[1].opts.env.INFOHUB_HOME, homeB);
  reply(spawned[1].child, { event: "hello" });
  await second;

  assert.equal(bridge.stop({ killDelayMs: 0 }), true);
  assert.equal(spawned[1].child.killedByUs, true);
  assert.equal(spawned[1].child.stdin.ended, true);
  const shutdown = JSON.parse(spawned[1].writes.at(-1).trim());
  assert.equal(shutdown.method, "shutdown");
  assert.equal(bridge.stop(), false);
});

// —————————————————————— 进程树回收（d.50）——————————————————————

test("spawn 参数按平台加 detached：POSIX 要自成进程组，kill(-pid) 才敢用负号", () => {
  const win = makeBridge({ isWindows: true });
  const winPending = win.bridge.start({ home: path.join(process.cwd(), "a") });
  reply(win.spawned[0].child, { event: "hello" });
  assert.equal(win.spawned[0].opts.detached, undefined, "Windows 上没有进程组，detached 只会让子进程更难收口");

  const posix = makeBridge({ isWindows: false });
  const posixPending = posix.bridge.start({ home: path.join(process.cwd(), "a") });
  reply(posix.spawned[0].child, { event: "hello" });
  assert.equal(posix.spawned[0].opts.detached, true);
  return Promise.all([winPending, posixPending]);
});

test("stop 交出的不是 kill 而是回收：宽限预算 = killDelayMs，平台一并传下去", () => {
  const { bridge, spawned, teardown } = makeBridge();
  const pending = bridge.start({ home: path.join(process.cwd(), "a") });
  reply(spawned[0].child, { event: "hello" });

  bridge.stop({ killDelayMs: 0 });
  return pending.then(() => {
    assert.deepEqual(teardown.calls, [{ pid: spawned[0].child.pid, graceMs: 0, isWindows: true }]);
  });
});

test("stop 缺省给 1.5s 宽限：先让 Python 自己关掉归档库，再拔树", async () => {
  const { bridge, spawned, teardown } = makeBridge();
  const first = bridge.start({ home: path.join(process.cwd(), "a") });
  reply(spawned[0].child, { event: "hello" });
  await first;
  bridge.stop();
  assert.equal(teardown.calls[0].graceMs, 1_500);
});

test("dispose 必等在途回收：点了停止就关应用，也不能抢在杀干净之前返回", async () => {
  let resolveTeardown;
  const gate = new Promise((r) => {
    resolveTeardown = r;
  });
  const calls = [];
  const { bridge, spawned } = makeBridge({
    teardown: (child, deps) => {
      child?.kill?.();
      calls.push(deps);
      return gate.then(() => ({ exited: true, via: "fake" }));
    },
  });
  const pending = bridge.start({ home: path.join(process.cwd(), "a") });
  reply(spawned[0].child, { event: "hello" });
  await pending;

  bridge.stop();
  assert.equal(calls.length, 1, "stop 已发起回收");
  let disposed = false;
  const disposing = bridge.dispose().then(() => {
    disposed = true;
  });
  await tick();
  assert.equal(disposed, false, "回收没跑完就返回 ⇒ Electron 会在杀进程之前退出，孤儿照旧");

  resolveTeardown();
  await disposing;
  assert.equal(disposed, true);
});

test("回收结论 exited:false 要如实写日志，不能当已经回收", async () => {
  const lines = [];
  const { bridge, spawned } = makeBridge({
    log: (line) => lines.push(line),
    teardown: () => Promise.resolve({ exited: false, via: "force-group" }),
  });
  const pending = bridge.start({ home: path.join(process.cwd(), "a") });
  reply(spawned[0].child, { event: "hello" });
  await pending;
  bridge.stop();
  await bridge.dispose();
  assert.match(lines.join("\n"), /回收未确认/);
  assert.match(lines.join("\n"), /force-group/);
});

test("hello 超时也回收进程：起不来的 Python 不能占着归档库等下次 start", async () => {
  const { bridge, spawned, teardown } = makeBridge({ helloTimeoutMs: 20 });
  await assert.rejects(bridge.start({ home: path.join(process.cwd(), "a") }), /启动超时/);
  assert.equal(teardown.calls.length, 1);
  assert.equal(teardown.calls[0].graceMs, 0);
  assert.equal(spawned[0].child.killedByUs, true);
});

test("idle：只有「没活进程且没在途回收」才允许退出流程不拦", async () => {
  let resolveTeardown;
  const gate = new Promise((r) => {
    resolveTeardown = r;
  });
  const { bridge, spawned } = makeBridge({
    teardown: () => gate.then(() => ({ exited: true, via: "fake" })),
  });
  assert.equal(bridge.idle(), true);
  const pending = bridge.start({ home: path.join(process.cwd(), "a") });
  reply(spawned[0].child, { event: "hello" });
  await pending;
  assert.equal(bridge.idle(), false, "进程在跑");

  bridge.stop();
  await tick();
  assert.equal(bridge.idle(), false, "进程没了但回收还在途——这时退出照样要等");
  resolveTeardown();
  await bridge.dispose();
  assert.equal(bridge.idle(), true);
});

test("护栏：这两个桥不许自己杀进程，回收一律交给 child-kill", () => {
  // 只断言代码：注释里写「旧实现是 child.kill()」是说明，不是接线。
  const codeOf = (file) =>
    fs
      .readFileSync(path.join(__dirname, file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split(/\r?\n/)
      .filter((line) => !/^\s*(\/\/|\*)/.test(line))
      .join("\n");
  for (const { file, dispose } of [
    { file: "infohub-bridge.js", dispose: "dispose" },
    { file: "mcp-stdio.js", dispose: "disposeAll" },
  ]) {
    const code = codeOf(file);
    assert.equal(/\.kill\(/.test(code), false, `${file} 不许出现裸 kill：单杀直接子进程就是孤儿来源，回收归 child-kill`);
    assert.ok(code.includes("require(\"./child-kill\")"), `${file} 必须复用 child-kill，别再写一套`);
    assert.ok(code.includes("beginTeardown("), `${file} 必须经 beginTeardown 走进程树回收`);
    // dispose 与 stop 的分工：stop 立刻返回（界面不能等），dispose 等回收跑完（退出不能抢跑）
    assert.ok(
      new RegExp(`async function ${dispose}\\(\\)`).test(code),
      `${file} 的 ${dispose} 必须是 async：同步返回就是让 Electron 抢在杀进程之前退出`,
    );
    assert.ok(code.includes("teardowns"), `${file} 要记住在途回收，dispose 才有的可等`);
    assert.ok(/function idle\(\)/.test(code), `${file} 必须报告「有没有在忙」，退出流程靠它判断要不要拦`);
  }
});

test("IPC：白名单、错误透传、目录选择", async () => {
  const handlers = new Map();
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) };
  const calls = [];
  const bridge = {
    info: () => ({ running: false }),
    start: async (config) => {
      calls.push(["start", config]);
      return { running: true, ...config };
    },
    call: async (method, params, config) => {
      calls.push(["call", method, params, config]);
      return { ok: true };
    },
    stop: () => true,
  };
  const dialog = { showOpenDialog: async () => ({ canceled: false, filePaths: ["D:\\wohaolei"] }) };
  registerInfohubIpc(ipcMain, { bridge, dialog });

  assert.deepEqual(await handlers.get("infohub:info")(), { running: false });
  await handlers.get("infohub:start")({}, { home: "D:\\wohaolei", python: " D:\\py\\python.exe " });
  assert.deepEqual(calls[0], ["start", { home: "D:\\wohaolei", python: "D:\\py\\python.exe" }]);

  await handlers.get("infohub:call")({}, { method: "conversations", params: { source: "qq" }, home: "D:\\w" });
  assert.deepEqual(calls[1], ["call", "conversations", { source: "qq" }, { home: "D:\\w", python: undefined }]);

  await assert.rejects(handlers.get("infohub:call")({}, { method: "shutdown" }), /不支持的方法/);
  await assert.rejects(handlers.get("infohub:call")({}, { method: "rm -rf" }), /不支持的方法/);

  assert.equal(await handlers.get("infohub:pick-home")({}), "D:\\wohaolei");
  assert.equal(await handlers.get("infohub:pick-python")({}), "D:\\wohaolei");
});

test("isValidMethod：渲染层不能调 shutdown", () => {
  assert.equal(isValidMethod("conversations"), true);
  assert.equal(isValidMethod("sync"), true);
  assert.equal(isValidMethod("shutdown"), false);
  assert.equal(isValidMethod("shutdown", true), true);
  assert.equal(isValidMethod("eval"), false);
});
