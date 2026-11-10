"use strict";
/**
 * 插件自带引擎（d.125）：启动守卫、权限环境、协议、对账与回收。
 *
 * 单元测试用假子进程 + 假回收：缺省 teardown 会 taskkill 真实 PID，
 * 测试里的 4321 是假的，绝不能打到真机器上。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { createPluginEngine, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS } = require("./plugin-engine");
const { computeFilesDigest } = require("./plugin-package");

const ENTRY = "files/engine/bridge.py";
const ENTRY_SOURCE = "print('engine')\n";

function tempDir(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

/** 造一个「已安装」的插件目录，返回 packageSha256（与安装端同算法）。 */
function makePluginDir(entry = ENTRY, files = {}) {
  const dir = tempDir("heming-engine-");
  const abs = path.join(dir, entry);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, ENTRY_SOURCE);
  const entries = [{ path: entry, data: Buffer.from(ENTRY_SOURCE) }];
  for (const [rel, data] of Object.entries(files)) {
    const file = path.join(dir, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, data);
    entries.push({ path: rel, data: Buffer.from(data) });
  }
  return { dir, sha: computeFilesDigest(entries) };
}

function fakeChild(pid = 4321) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
  child.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
  const writes = [];
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

/** 假回收：只记录，绝不真杀进程。 */
function fakeTeardown() {
  const fn = (child, deps) => {
    child?.kill?.();
    fn.calls.push({ pid: child?.pid, ...deps });
    return Promise.resolve({ exited: true, via: "fake" });
  };
  fn.calls = [];
  return fn;
}

/**
 * @param {(child: any, msg: any) => void} [respond] 非 ping 请求的应答器
 */
function makeSpawn(spawned, respond) {
  return (command, args, opts) => {
    const { child, writes } = fakeChild();
    const originalWrite = child.stdin.write.bind(child.stdin);
    child.stdin.write = (chunk) => {
      const ok = originalWrite(chunk);
      for (const line of String(chunk).split("\n")) {
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.method === "ping") {
          queueMicrotask(() => reply(child, { id: msg.id, ok: true, result: { pong: true } }));
        } else if (msg.method === "shutdown") {
          queueMicrotask(() => reply(child, { id: msg.id, ok: true, result: {} }));
        } else if (respond) {
          respond(child, msg);
        }
      }
      return ok;
    };
    spawned.push({ command, args, opts, child });
    return child;
  };
}

function recordOf(dir, sha, overrides = {}) {
  return {
    id: "heming.test-engine",
    name: "测试引擎",
    version: "1.0.0",
    enabled: true,
    packageSha256: sha,
    engine: { entry: ENTRY },
    permissions: {},
    ...overrides,
  };
}

function makeEngine(overrides = {}) {
  const spawned = [];
  const teardown = overrides.teardown ?? fakeTeardown();
  const events = [];
  const engine = createPluginEngine({
    spawn: overrides.spawn ?? makeSpawn(spawned),
    bundledPythonPath:
      overrides.bundledPythonPath === undefined
        ? "C:\\runtime\\python.exe"
        : overrides.bundledPythonPath,
    pluginDirFor: overrides.pluginDirFor,
    dataDirOf: () => path.join(tmpdir(), "engine-data"),
    readSettings: overrides.readSettings ?? (() => ({})),
    getChatConfig: overrides.getChatConfig,
    getKbRoots: overrides.getKbRoots,
    appVersion: () => "d.125.3.48.0",
    onEvent: (pluginId, payload) => events.push({ pluginId, payload }),
    log: () => {},
    isWindows: true,
    teardown,
  });
  return { engine, spawned, teardown, events };
}

test("启动：校验摘要、用内置解释器拉起、ping 握手后才算就绪", async () => {
  const { dir, sha } = makePluginDir();
  const { engine, spawned } = makeEngine({ pluginDirFor: () => dir });
  const record = recordOf(dir, sha);
  try {
    const running = await engine.start(record);
    assert.equal(running.pluginId, record.id);
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].command, "C:\\runtime\\python.exe");
    assert.deepEqual(spawned[0].args, ["-u", path.join(dir, ENTRY)]);
    assert.equal(spawned[0].opts.shell, false);
    assert.equal(spawned[0].opts.cwd, dir);
    // 第二次 start 复用同一个进程，不再 spawn
    await engine.start(record);
    assert.equal(spawned.length, 1);
    assert.equal(engine.status(record.id, record).running, true);
  } finally {
    await engine.stopAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("权限环境：chat/kb 只在声明后下发，未声明不出现", async () => {
  const { dir, sha } = makePluginDir();
  const plain = makeEngine({ pluginDirFor: () => dir });
  const record = recordOf(dir, sha);
  try {
    await plain.engine.start(record);
    const env = plain.spawned[0].opts.env;
    assert.equal(env.HEMING_PLUGIN_ID, record.id);
    assert.equal(env.HEMING_PLUGIN_VERSION, "1.0.0");
    assert.equal(env.HEMING_APP_VERSION, "d.125.3.48.0");
    assert.ok(env.PYTHONPATH.split(path.delimiter)[0].endsWith(path.join("files", "engine")));
    assert.equal(env.HEMING_CHAT, undefined);
    assert.equal(env.HEMING_KB_ROOTS, undefined);
  } finally {
    await plain.engine.stopAll();
  }

  const full = makeEngine({
    pluginDirFor: () => dir,
    getChatConfig: async () => ({
      gateway: { baseUrl: "http://127.0.0.1:3425/v1", key: "local" },
      backgroundModel: "cheap-model",
    }),
    getKbRoots: async () => [{ id: "v1", name: "库", root: "C:\\vault", writeDirs: ["inbox"] }],
  });
  try {
    await full.engine.start(recordOf(dir, sha, { permissions: { chat: true, kb: true } }));
    const env = full.spawned[0].opts.env;
    assert.deepEqual(JSON.parse(env.HEMING_CHAT), {
      baseUrl: "http://127.0.0.1:3425/v1",
      key: "local",
      model: "cheap-model",
    });
    assert.deepEqual(JSON.parse(env.HEMING_KB_ROOTS), [
      { id: "v1", name: "库", root: "C:\\vault", writeDirs: ["inbox"] },
    ]);
  } finally {
    await full.engine.stopAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("协议：请求带 id/method/params，成功回 result，失败带 code；事件单独投递", async () => {
  const { dir, sha } = makePluginDir();
  const record = recordOf(dir, sha);
  const spawned = [];
  const { engine, events } = makeEngine({
    pluginDirFor: () => dir,
    spawn: makeSpawn(spawned, (child, msg) => {
      if (msg.method === "conversations") {
        queueMicrotask(() => {
          reply(child, { event: "progress", stage: "scan", done: 1 });
          reply(child, { id: msg.id, ok: true, result: { items: [1, 2] } });
        });
      } else {
        queueMicrotask(() =>
          reply(child, { id: msg.id, ok: false, error: { type: "NOT_FOUND", message: "没有这条" } }),
        );
      }
    }),
  });
  try {
    const result = await engine.call(record, "conversations", { limit: 2 });
    assert.deepEqual(result, { items: [1, 2] });
    assert.deepEqual(events, [
      { pluginId: record.id, payload: { event: "progress", stage: "scan", done: 1 } },
    ]);
    await assert.rejects(
      () => engine.call(record, "messages", { id: "x" }),
      (err) => err.code === "NOT_FOUND" && /没有这条/.test(err.message),
    );
    assert.equal(spawned.length, 1);
  } finally {
    await engine.stopAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("超时：默认 60s，可按调用放宽并夹在 [1s, 30min]", async () => {
  const { dir, sha } = makePluginDir();
  const delays = [];
  const { engine } = makeEngine({
    pluginDirFor: () => dir,
    spawn: makeSpawn([], () => {
      /* 除 ping 外不回：调用会挂到超时 */
    }),
  });
  // 用假计时器只记录延迟，不真正触发（避免误杀测试进程）
  const realSet = global.setTimeout;
  const record = recordOf(dir, sha);
  try {
    const engineWithTimers = createPluginEngine({
      spawn: makeSpawn([], () => {}),
      bundledPythonPath: "C:\\runtime\\python.exe",
      pluginDirFor: () => dir,
      dataDirOf: () => path.join(tmpdir(), "engine-data"),
      readSettings: () => ({}),
      log: () => {},
      isWindows: true,
      teardown: fakeTeardown(),
      setTimeout: (_fn, ms) => {
        delays.push(ms);
        return { unref() {} };
      },
      clearTimeout: () => {},
    });
    engineWithTimers.call(record, "slow", {}, {}).catch(() => {});
    engineWithTimers.call(record, "slow", {}, { timeoutMs: 5 }).catch(() => {});
    engineWithTimers.call(record, "slow", {}, { timeoutMs: 99 * 60_000 }).catch(() => {});
    await new Promise((resolve) => realSet(resolve, 10));
    // 第一条：ping 握手 15s + 调用默认 60s
    assert.ok(delays.includes(15_000));
    assert.ok(delays.includes(DEFAULT_TIMEOUT_MS));
    assert.ok(delays.includes(1_000));
    assert.ok(delays.includes(MAX_TIMEOUT_MS));
    await engineWithTimers.stopAll();
  } finally {
    await engine.stopAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("启动守卫：未声明/停用/包内非法入口/摘要不符/缺运行时都拒绝", async () => {
  const { dir, sha } = makePluginDir();
  const { engine, spawned, teardown } = makeEngine({
    pluginDirFor: (id) => (id === "heming.test-engine" ? dir : null),
  });
  const base = recordOf(dir, sha);
  try {
    await assert.rejects(() => engine.start({ ...base, engine: undefined }), /没有声明本机引擎/);
    await assert.rejects(() => engine.start({ ...base, enabled: false }), /已停用/);
    await assert.rejects(
      () => engine.start(recordOf(dir, sha, { engine: { entry: "files/../outside.py" } })),
      /入口不在插件目录内或不存在/,
    );
    await assert.rejects(
      () => engine.start(recordOf(dir, sha, { engine: { entry: "files/engine/bridge.js" } })),
      /必须是插件包内的 \.py 文件/,
    );
    await assert.rejects(() => engine.start(recordOf(dir, "0".repeat(64))), /文件校验不通过/);
    await assert.rejects(
      () => engine.start(recordOf(dir, sha, { id: "heming.other" })),
      /插件文件目录不存在/,
    );
    assert.equal(spawned.length, 0);
    assert.equal(teardown.calls.length, 0);

    const noRuntime = makeEngine({ pluginDirFor: () => dir, bundledPythonPath: null });
    await assert.rejects(
      () => noRuntime.engine.start(base),
      /应用内置 Python 运行时不可用/,
    );
    assert.equal(noRuntime.spawned.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("停止与对账：shutdown → 回收；版本变化时停旧引擎", async () => {
  const { dir, sha } = makePluginDir();
  const { engine, spawned, teardown } = makeEngine({ pluginDirFor: () => dir });
  const record = recordOf(dir, sha);
  try {
    await engine.start(record);
    const child = spawned[0].child;
    assert.equal(await engine.stop(record.id), true);
    assert.equal(child.stdin.ended, true);
    assert.equal(teardown.calls.length, 1);
    assert.equal(engine.status(record.id, record).running, false);

    await engine.start(record);
    assert.equal(spawned.length, 2);
    // 同一版本不重启
    await engine.reconcile([record]);
    assert.equal(spawned.length, 2);
    // 版本变化 → 停掉旧引擎（记录里的 engine 也跟着换）
    const next = recordOf(dir, sha, { version: "1.0.1" });
    await engine.start(next);
    assert.equal(spawned.length, 3);
    await engine.reconcile([next]);
    assert.equal(spawned.length, 3);
    // 停用 → 对账会收掉
    await engine.reconcile([{ ...next, enabled: false }]);
    assert.equal(engine.status(record.id, next).running, false);
  } finally {
    await engine.stopAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("进程退出：挂起的调用全部拒绝，状态带退出码", async () => {
  const { dir, sha } = makePluginDir();
  const spawned = [];
  const { engine } = makeEngine({
    pluginDirFor: () => dir,
    spawn: makeSpawn(spawned, () => {
      /* 不回，等退出 */
    }),
  });
  const record = recordOf(dir, sha);
  try {
    await engine.start(record);
    const pending = engine.call(record, "hang", {});
    await new Promise((resolve) => setImmediate(resolve));
    spawned[0].child.emit("exit", 1, null);
    await assert.rejects(() => pending, /引擎已退出/);
    const status = engine.status(record.id, record);
    assert.equal(status.running, false);
    assert.match(status.error, /code=1/);
  } finally {
    await engine.stopAll();
    rmSync(dir, { recursive: true, force: true });
  }
});
