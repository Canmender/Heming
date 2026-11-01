"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
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

function makeBridge(overrides = {}) {
  const spawned = [];
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
  });
  return { bridge, spawned };
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
