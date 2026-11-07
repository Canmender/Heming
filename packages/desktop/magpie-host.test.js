"use strict";
/** 内置 magpie 托管（d.91）：路径解析、启动就绪、超时回收、状态口径。 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createMagpieHost, resolveBinaryPath, DEFAULT_PORT } = require("./magpie-host");

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {
    child.exitCode = 0;
    child.emit("exit", 0, null);
  };
  return child;
}

function okHealth(version = "0.1.3246") {
  return async () => ({
    ok: true,
    json: async () => ({ name: "magpie", version }),
  });
}

function clock(start = 1_000) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  };
}

function hostWith(overrides = {}) {
  const child = overrides.child ?? fakeChild();
  const kills = [];
  // 同一个假时钟：now 与 sleep 必须共享时间轴，否则就绪轮询永远等不到 deadline。
  const fakeClock = clock();
  const host = createMagpieHost({
    binaryPath: "C:/fake/magpie-cli.exe",
    spawn: () => child,
    fetchImpl: async () => ({ ok: false, json: async () => ({}) }),
    sleep: fakeClock.sleep,
    now: fakeClock.now,
    exists: () => true,
    killTree: (target) => {
      kills.push(target);
      target.exitCode = 0;
      target.emit("exit", 0, null);
    },
    log: () => {},
    ...overrides,
  });
  return { host, child, kills };
}

test("resolveBinaryPath：打包/开发/环境变量覆盖", () => {
  assert.equal(
    resolveBinaryPath({ isPackaged: true, resourcesPath: "R", appDir: "A", platform: "win32", env: {} }),
    require("node:path").join("R", "magpie", "magpie-cli.exe"),
  );
  assert.equal(
    resolveBinaryPath({ isPackaged: false, resourcesPath: "R", appDir: "A", platform: "win32", env: {} }),
    require("node:path").join("A", "resources", "magpie", "magpie-cli.exe"),
  );
  assert.equal(
    resolveBinaryPath({ isPackaged: true, resourcesPath: "R", appDir: "A", platform: "linux", env: {} }),
    require("node:path").join("R", "magpie", "magpie-cli"),
  );
  assert.equal(
    resolveBinaryPath({
      isPackaged: true,
      resourcesPath: "R",
      appDir: "A",
      platform: "win32",
      env: { HEMING_MAGPIE_BIN: " D:/x/magpie.exe " },
    }),
    "D:/x/magpie.exe",
  );
});

test("没有二进制：启动给出可执行提示，不自称运行中", async () => {
  const { host } = hostWith({ exists: () => false });
  assert.equal(host.status().available, false);
  assert.equal(host.status().running, false);
  await assert.rejects(() => host.start(), /没有找到内置 magpie/);
});

test("启动成功：spawn serve、等到 /api/hello 就绪并记录版本；stop 回收整树", async () => {
  const spawned = [];
  const { host, child } = hostWith({
    spawn: (...args) => {
      spawned.push(args);
      return child;
    },
    fetchImpl: async (url) => {
      assert.match(String(url), /\/api\/hello$/);
      return { ok: true, json: async () => ({ name: "magpie", version: "0.1.3246" }) };
    },
  });

  const result = await host.start();
  assert.equal(result.port, DEFAULT_PORT);
  assert.equal(result.version, "0.1.3246");
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0][1].join(" "), "serve");
  assert.equal(spawned[0][2].windowsHide, true);
  assert.equal(host.status().running, true);
  assert.equal(host.status().version, "0.1.3246");

  await host.stop();
  assert.equal(host.status().running, false);
  assert.equal(host.status().version, undefined);
});

test("就绪超时：回收进程并带出 stderr 尾巴", async () => {
  const child = fakeChild();
  const { host } = hostWith({
    child,
    fetchImpl: async () => ({ ok: false, json: async () => ({}) }),
    readyTimeoutMs: 2_000,
  });
  // 启动过程中进程还没退出，sleep 只是推进假时钟
  const started = host.start();
  child.stderr.emit("data", "listen tcp 127.0.0.1:3425: bind: address already in use\n");
  await assert.rejects(started, /没有在规定时间内就绪/);
  assert.equal(child.exitCode, 0); // 被回收
  assert.match(host.status().stderrTail.join("\n"), /address already in use/);
});

test("/api/hello 不是 magpie：不认作就绪（防连到别的本机服务）", async () => {
  const { host } = hostWith({
    fetchImpl: async () => ({ ok: true, json: async () => ({ name: "other-service", version: "1" }) }),
    readyTimeoutMs: 1_000,
  });
  await assert.rejects(() => host.start(), /没有在规定时间内就绪/);
});

test("start 并发只拉起一个进程；running 时重复 start 不再 spawn", async () => {
  let spawns = 0;
  const child = fakeChild();
  const { host } = hostWith({
    child,
    spawn: () => {
      spawns += 1;
      return child;
    },
    fetchImpl: okHealth(),
  });
  await Promise.all([host.start(), host.start()]);
  assert.equal(spawns, 1);
  await host.start();
  assert.equal(spawns, 1);
});
