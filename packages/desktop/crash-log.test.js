"use strict";
/**
 * 崩溃兜底（d.30 · P0-4）的用例。
 *
 * 这个模块的价值全在两件事上：
 * 1. 崩了要**留下本机日志**（否则用户只看到「应用莫名其妙没了」）；
 * 2. **绝不上报云端**（崩溃日志里可能混着用户输入片段，上报等于把个人数据送出设备）。
 *
 * 所以第 2 条不是靠注释保证的，是靠「打桩全部网络 API 并断言未被调用」钉死的。
 * 将来谁想加个上报，这几条用例会直接红。
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  crashLogDir,
  writeCrashLog,
  installCrashHandlers,
  attachRenderCrashRecovery,
  resetRenderCrashGuard,
  redact,
  sanitizeExtra,
  describeError,
} = require("./crash-log.js");

// ── 测试脚手架 ──────────────────────────────────────────────────────────

/** 临时目录（用例结束自动删）。 */
function tmpDir(name) {
  const dir = path.join(os.tmpdir(), `heming-crash-${name}-${process.pid}-${Date.now()}`);
  return dir;
}

/** 假 process：只实现 on/off/removeListener/exit，绝不碰真实 process。 */
function fakeProcess() {
  const listeners = new Map();
  const exits = [];
  const proc = {
    exits,
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
      return proc;
    },
    off(event, fn) {
      const arr = listeners.get(event) || [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
      return proc;
    },
    removeListener(event, fn) {
      return proc.off(event, fn);
    },
    exit(code) {
      exits.push(code);
      return undefined;
    },
    /** 手动触发某个事件的全部处理器（模拟真的抛出来了）。 */
    emit(event, payload) {
      for (const fn of [...(listeners.get(event) || [])]) fn(payload);
    },
    listenerCount(event) {
      return (listeners.get(event) || []).length;
    },
  };
  return proc;
}

/** 假 webContents：记录 render-process-gone 处理器与 reload 调用。 */
function fakeWebContents() {
  const listeners = new Map();
  const reloads = [];
  const wc = {
    reloads,
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
      return wc;
    },
    off(event, fn) {
      const arr = listeners.get(event) || [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
      return wc;
    },
    removeListener(event, fn) {
      return wc.off(event, fn);
    },
    reload() {
      reloads.push(Date.now());
    },
    isDestroyed() {
      return false;
    },
    emit(event, payload) {
      for (const fn of [...(listeners.get(event) || [])]) fn({}, payload);
    },
  };
  return wc;
}

// ── 网络打桩：证明「崩溃日志绝不外发」 ──────────────────────────────────

/**
 * 把所有可能的出网 API 换成会记账的假实现。
 * 返回 { calls, restore }：calls 为空 ⇒ 崩溃处理过程没碰过网络。
 */
function stubNetwork() {
  const calls = [];
  const originals = [];
  const stub = (obj, key, label) => {
    if (!obj || !(key in obj)) return;
    originals.push([obj, key, obj[key]]);
    obj[key] = (...args) => {
      calls.push({ api: label, args });
      throw new Error(`测试桩：不允许调用 ${label}`);
    };
  };

  stub(globalThis, "fetch", "fetch");
  stub(require("node:https"), "request", "https.request");
  stub(require("node:https"), "get", "https.get");
  stub(require("node:http"), "request", "http.request");
  stub(require("node:http"), "get", "http.get");
  stub(require("node:net"), "connect", "net.connect");
  stub(require("node:net"), "createConnection", "net.createConnection");
  stub(require("node:dgram"), "createSocket", "dgram.createSocket");
  stub(require("node:tls"), "connect", "tls.connect");
  stub(require("node:child_process"), "exec", "child_process.exec");
  stub(require("node:child_process"), "spawn", "child_process.spawn");

  return {
    calls,
    restore() {
      for (const [obj, key, orig] of originals) obj[key] = orig;
    },
  };
}

// ── 目录与文件名 ────────────────────────────────────────────────────────

test("crashLogDir 默认在 ~/Heming/logs 下", () => {
  const dir = crashLogDir({});
  assert.equal(dir, path.join(os.homedir(), "Heming", "logs"));
});

test("crashLogDir 可用 HEMING_CRASH_DIR 覆盖（测试指向临时目录）", () => {
  const dir = crashLogDir({ HEMING_CRASH_DIR: "/tmp/heming-crash-test" });
  assert.equal(dir, path.resolve("/tmp/heming-crash-test"));
});

test("日志目录不存在时自动创建，且不抛", () => {
  const dir = tmpDir("mkdir");
  const nested = path.join(dir, "deep", "logs");
  assert.equal(fs.existsSync(nested), false, "前置条件：目录还不存在");
  const file = writeCrashLog("uncaughtException", new Error("boom"), undefined, { logDir: nested });
  assert.ok(file, "应写成功");
  assert.equal(fs.existsSync(nested), true, "目录应被自动创建");
  assert.ok(fs.readFileSync(file, "utf8").includes("boom"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("同一进程多次崩溃不互相覆盖（各自一份文件）", () => {
  const dir = tmpDir("multi");
  const a = writeCrashLog("uncaughtException", new Error("第一次"), undefined, { logDir: dir });
  const b = writeCrashLog("uncaughtException", new Error("第二次"), undefined, { logDir: dir });
  assert.notEqual(a, b, "两次崩溃不能写进同一个文件");
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 2);
  assert.ok(fs.readFileSync(a, "utf8").includes("第一次"));
  assert.ok(fs.readFileSync(b, "utf8").includes("第二次"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("日志文件名不含冒号（Windows 文件名不允许）", () => {
  const dir = tmpDir("colon");
  const file = writeCrashLog("uncaughtException", new Error("x"), undefined, { logDir: dir });
  const name = path.basename(file);
  assert.ok(!name.includes(":"), `文件名含冒号：${name}`);
  assert.match(name, /^crash-.+-\d+\.log$/, `文件名形状不对：${name}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── 内容：版本号 / 时间 / 异常信息 ──────────────────────────────────────

test("日志内容含版本号、UTC 时间、异常名/message/stack", () => {
  const dir = tmpDir("content");
  const file = writeCrashLog(
    "uncaughtException",
    new TypeError("读取配置失败"),
    undefined,
    { logDir: dir, appVersion: "d.30.1.8.0" }
  );
  const text = fs.readFileSync(file, "utf8");
  assert.ok(text.includes("d.30.1.8.0"), "日志必须含应用版本号");
  assert.ok(/time\(UTC\): \d{4}-\d{2}-\d{2}T/.test(text), "日志必须含 UTC 时间");
  assert.ok(text.includes("TypeError"), "日志必须含异常类型名");
  assert.ok(text.includes("读取配置失败"), "日志必须含 message");
  assert.ok(text.includes("at "), "日志必须含 stack");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("日志不含用户 ID / token / 消息正文（红线）", () => {
  const dir = tmpDir("redact");
  const file = writeCrashLog(
    "uncaughtException",
    new Error("请求失败 Authorization: Bearer abcdefghijklmnop"),
    { userId: "u-123", token: "secret-token", message: "用户的私密消息正文" },
    { logDir: dir, appVersion: "d.30.1.8.0" }
  );
  const text = fs.readFileSync(file, "utf8");
  assert.ok(!text.includes("u-123"), "不得出现 userId");
  assert.ok(!text.includes("secret-token"), "不得出现 token");
  assert.ok(!text.includes("用户的私密消息正文"), "不得出现消息正文");
  assert.ok(!/Bearer\s+abcdefghijklmnop/.test(text), "不得出现原始 Bearer 凭据");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("redact 盖住常见凭据形态，但不动普通内容", () => {
  assert.ok(!redact("Authorization: Bearer sk-1234567890abcd").includes("sk-1234567890abcd"));
  assert.ok(!redact("token=abcdef123456").includes("abcdef123456"));
  assert.ok(!redact("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOjF9.sig1234").includes("eyJhbGciOiJIUzI1NiJ9"));
  assert.equal(redact("普通的中文报错信息"), "普通的中文报错信息");
});

test("sanitizeExtra 拒收敏感字段名", () => {
  const lines = sanitizeExtra({
    reason: "crashed",
    exitCode: 9,
    token: "x",
    userId: "u-1",
    message: "正文",
    body: "正文",
  });
  const joined = lines.join("\n");
  assert.ok(joined.includes("reason=crashed"));
  assert.ok(joined.includes("exitCode=9"));
  for (const banned of ["token", "userId", "message", "body"]) {
    assert.ok(!joined.includes(banned), `不该出现 ${banned}`);
  }
});

test("describeError 能处理非 Error 的 rejection reason", () => {
  const a = describeError(new RangeError("越界"));
  assert.equal(a.name, "RangeError");
  assert.equal(a.message, "越界");
  const b = describeError("只是一个字符串");
  assert.ok(b.message.includes("只是一个字符串"));
  const c = describeError({ name: "Custom", message: "对象 reason" });
  assert.equal(c.name, "Custom");
  assert.equal(c.message, "对象 reason");
});

// ── installCrashHandlers：日志 + 不外发 ─────────────────────────────────

test("假 process 触发 uncaughtException：生成日志文件且内容含版本号", () => {
  const dir = tmpDir("uncaught");
  const proc = fakeProcess();
  const installed = installCrashHandlers({
    proc,
    fs,
    appVersion: "d.30.1.8.0",
    logDir: dir,
  });

  assert.equal(proc.listenerCount("uncaughtException"), 1);
  assert.equal(proc.listenerCount("unhandledRejection"), 1);

  proc.emit("uncaughtException", new Error("主进程炸了"));

  const files = fs.readdirSync(dir);
  assert.equal(files.length, 1, `应恰好写一份日志，实际：${files.join(", ")}`);
  const text = fs.readFileSync(path.join(dir, files[0]), "utf8");
  assert.ok(text.includes("d.30.1.8.0"), "日志必须含版本号");
  assert.ok(text.includes("主进程炸了"), "日志必须含异常信息");
  assert.ok(text.includes("uncaughtException"), "日志必须标明崩溃类型");

  installed.uninstall();
  assert.equal(proc.listenerCount("uncaughtException"), 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("假 process 触发 unhandledRejection：同样留下日志", () => {
  const dir = tmpDir("rejection");
  const proc = fakeProcess();
  const installed = installCrashHandlers({ proc, fs, appVersion: "d.30.1.8.0", logDir: dir });

  proc.emit("unhandledRejection", new Error("promise 炸了"));

  const files = fs.readdirSync(dir);
  assert.equal(files.length, 1);
  const text = fs.readFileSync(path.join(dir, files[0]), "utf8");
  assert.ok(text.includes("unhandledRejection"));
  assert.ok(text.includes("promise 炸了"));

  installed.uninstall();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("★ 崩溃处理全程没有任何网络发送（红线：个人数据不出设备）", () => {
  const dir = tmpDir("network");
  const net = stubNetwork();
  try {
    const proc = fakeProcess();
    const installed = installCrashHandlers({
      proc,
      fs,
      appVersion: "d.30.1.8.0",
      logDir: dir,
    });

    proc.emit("uncaughtException", new Error("带凭据的异常 Bearer abcdefghijklmnop"));
    proc.emit("unhandledRejection", new Error("rejection 也要守红线"));
    writeCrashLog("uncaughtException", new Error("直接写也守红线"), undefined, { logDir: dir });

    assert.deepEqual(
      net.calls.map((c) => c.api),
      [],
      `崩溃处理竟然发起了网络请求：${net.calls.map((c) => c.api).join(", ")}`
    );
    installed.uninstall();
  } finally {
    net.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("crash-log.js 源码里不出现任何网络模块（结构性保证）", () => {
  const raw = fs.readFileSync(path.join(__dirname, "crash-log.js"), "utf8");
  // 先剥掉注释再查：注释里可以解释「为什么不用 electron / 为什么不上报」，
  // 但真正执行的代码里不许出现这些依赖。
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const mod of ["node:http", "node:https", "node:net", "node:dgram", "node:tls", "electron"]) {
    assert.ok(
      !src.includes(`require("${mod}")`),
      `crash-log.js 不该依赖 ${mod}（崩溃日志只写本机文件）`
    );
  }
  // 也不能凭空出现 fetch 调用
  assert.ok(!/\bfetch\s*\(/.test(src), "crash-log.js 不该调用 fetch");
});

test("崩溃处理器自身不抛（处理器抛异常 = 死循环）", () => {
  const dir = tmpDir("no-throw");
  // 故意给一个会抛的 fs：写日志必然失败
  const brokenFs = {
    mkdirSync() {
      throw new Error("磁盘炸了");
    },
    appendFileSync() {
      throw new Error("磁盘炸了");
    },
    existsSync() {
      return false;
    },
  };
  const proc = fakeProcess();
  const installed = installCrashHandlers({ proc, fs: brokenFs, appVersion: "d.30.1.8.0", logDir: dir });

  assert.doesNotThrow(() => proc.emit("uncaughtException", new Error("x")));
  assert.doesNotThrow(() => proc.emit("unhandledRejection", "reason"));

  installed.uninstall();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("崩溃后仍按 Node 默认语义退出（不是「假装没事继续跑」）", () => {
  const dir = tmpDir("exit");
  const proc = fakeProcess();
  const installed = installCrashHandlers({ proc, fs, appVersion: "d.30.1.8.0", logDir: dir });
  proc.emit("uncaughtException", new Error("x"));
  assert.deepEqual(proc.exits, [1], "写完日志应退出，且退出码为 1");
  installed.uninstall();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("exitOnCrash:false 时不退出（给「想继续跑」的调用方留口子）", () => {
  const dir = tmpDir("no-exit");
  const proc = fakeProcess();
  const installed = installCrashHandlers({
    proc,
    fs,
    appVersion: "d.30.1.8.0",
    logDir: dir,
    exitOnCrash: false,
  });
  proc.emit("uncaughtException", new Error("x"));
  assert.deepEqual(proc.exits, []);
  assert.equal(fs.readdirSync(dir).length, 1, "日志照写");
  installed.uninstall();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── render-process-gone：只重载一次 ─────────────────────────────────────

test("render-process-gone：写日志 + 只自动重载一次（防崩溃循环刷爆机器）", () => {
  resetRenderCrashGuard();
  const dir = tmpDir("render");
  const wc = fakeWebContents();
  const attached = attachRenderCrashRecovery(wc, { fs, appVersion: "d.30.1.8.0", logDir: dir });

  wc.emit("render-process-gone", { reason: "crashed", exitCode: 133 });
  assert.equal(wc.reloads.length, 1, "第一次崩溃应重载一次");

  wc.emit("render-process-gone", { reason: "crashed", exitCode: 133 });
  assert.equal(wc.reloads.length, 1, "第二次崩溃不再重载（否则崩溃循环会把机器刷爆）");

  const files = fs.readdirSync(dir);
  assert.equal(files.length, 2, "两次崩溃各留一条日志");
  const text = fs.readFileSync(path.join(dir, files[0]), "utf8");
  assert.ok(text.includes("d.30.1.8.0"), "渲染崩溃日志也含版本号");
  assert.ok(text.includes("crashed"), "渲染崩溃日志含原因");

  attached.uninstall();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("render-process-gone：clean-exit 是页面自己退的，不重载", () => {
  resetRenderCrashGuard();
  const dir = tmpDir("clean-exit");
  const wc = fakeWebContents();
  const attached = attachRenderCrashRecovery(wc, { fs, appVersion: "d.30.1.8.0", logDir: dir });
  wc.emit("render-process-gone", { reason: "clean-exit", exitCode: 0 });
  assert.equal(wc.reloads.length, 0, "正常退出不该重载（会把用户的动作撤销）");
  attached.uninstall();
  fs.rmSync(dir, { recursive: true, force: true });
});
