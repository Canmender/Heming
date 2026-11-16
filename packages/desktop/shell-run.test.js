"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const {
  registerShellIpc,
  runCommand,
  cancelRun,
  resolveWorkingDir,
  MAX_COMMAND_CHARS,
} = require("./shell-run.js");

/** 造一个临时可写根，测试结束由调用方清理。 */
function makeRoot(prefix = "heming-shell-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { name: "工作区", path: dir, mode: "write" };
}

/** 假子进程：把预设的输出/退出码在下一 tick 抛出来。 */
function fakeChild({ stdout = "", stderr = "", code = 0 } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.pid = 4242;
  child.kill = () => {
    child.killed = true;
  };
  setImmediate(() => {
    if (stdout) child.stdout.emit("data", Buffer.from(stdout));
    if (stderr) child.stderr.emit("data", Buffer.from(stderr));
    child.emit("close", code, null);
  });
  return child;
}

function fakeSpawn(options = {}, captured = {}) {
  // d.165 起改成 `spawn(command, { shell: true })`：命令里的引号交给 Node 处理
  //（自己拼 `cmd.exe /d /s /c` 会在命令带引号时静默丢输出，exit 0 但 stdout 为空）。
  return (command, opts) => {
    captured.command = command;
    captured.opts = opts;
    return fakeChild(options);
  };
}

test("shell-run：可信来源下执行命令，返回退出码/输出/工作目录", async () => {
  const root = makeRoot();
  try {
    const captured = {};
    const res = await runCommand(
      { roots: [root], cwd: root.path, command: "echo hi" },
      fakeSpawn({ stdout: "hi\n", code: 0 }, captured),
    );
    assert.equal(res.ok, true);
    assert.equal(res.exitCode, 0);
    assert.equal(res.stdout, "hi\n");
    assert.equal(res.truncated, false);
    assert.equal(captured.command, "echo hi");
    // 交给 Node 的 shell 选项（Windows = ComSpec，Unix = /bin/sh）：跨平台语义一致。
    assert.equal(captured.opts.shell, true);
    assert.equal(captured.opts.cwd, root.path);
    assert.equal(captured.opts.stdio[0], "ignore", "不给 stdin：交互式命令必须自己超时");
  } finally {
    fs.rmSync(root.path, { recursive: true, force: true });
  }
});

test("shell-run：非零退出码照样回 ok（错误信息在 stderr 里，由模型读）", async () => {
  const root = makeRoot();
  try {
    const res = await runCommand(
      { roots: [root], cwd: root.path, command: "exit 1" },
      fakeSpawn({ stderr: "boom\n", code: 1 }),
    );
    assert.equal(res.ok, true);
    assert.equal(res.exitCode, 1);
    assert.equal(res.stderr, "boom\n");
  } finally {
    fs.rmSync(root.path, { recursive: true, force: true });
  }
});

test("shell-run：工作目录必须在可写根内（越界/只读根/相对路径都拒）", async () => {
  const root = makeRoot();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "heming-outside-"));
  try {
    const outsideRes = await resolveWorkingDir([root], outside);
    assert.equal(outsideRes.ok, false);
    assert.equal(outsideRes.code, "outside-roots");

    const relative = await resolveWorkingDir([root], "src");
    assert.equal(relative.ok, false);
    assert.equal(relative.code, "outside-roots");

    const readOnly = await resolveWorkingDir([{ ...root, mode: "read" }], root.path);
    assert.equal(readOnly.ok, false);
    assert.equal(readOnly.code, "no-write-root");

    const none = await resolveWorkingDir([], root.path);
    assert.equal(none.ok, false);
    assert.equal(none.code, "no-roots");

    const ok = await resolveWorkingDir([root], root.path);
    assert.equal(ok.ok, true);
  } finally {
    fs.rmSync(root.path, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("shell-run：命令为空/含 NUL/过长一律拒绝，且不启动进程", async () => {
  const root = makeRoot();
  try {
    let spawned = 0;
    const spawnImpl = (...args) => {
      spawned += 1;
      return fakeSpawn()(...args);
    };
    assert.equal((await runCommand({ roots: [root], cwd: root.path, command: "  " }, spawnImpl)).code, "invalid-command");
    assert.equal(
      (await runCommand({ roots: [root], cwd: root.path, command: "echo\u0000rm" }, spawnImpl)).code,
      "invalid-command",
    );
    const tooLong = await runCommand(
      { roots: [root], cwd: root.path, command: "a".repeat(MAX_COMMAND_CHARS + 1) },
      spawnImpl,
    );
    assert.equal(tooLong.code, "invalid-command");
    assert.equal(spawned, 0, "参数不合法时不能启动进程");
  } finally {
    fs.rmSync(root.path, { recursive: true, force: true });
  }
});

test("shell-run：超时杀进程并回 timeout", async () => {
  const root = makeRoot();
  try {
    let killed = false;
    const spawnImpl = () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.pid = 999999; // 不存在的 pid：taskkill 失败退回 child.kill
      child.killed = false;
      child.kill = () => {
        killed = true;
        child.killed = true;
      };
      return child;
    };
    const res = await runCommand({ roots: [root], cwd: root.path, command: "ping", timeoutMs: 1000 }, spawnImpl);
    assert.equal(res.ok, false);
    assert.equal(res.code, "timeout");
    assert.equal(killed, true, "超时必须真的把进程停掉");
  } finally {
    fs.rmSync(root.path, { recursive: true, force: true });
  }
});

test("shell-run：渲染层中止时杀进程并回 aborted", async () => {
  const root = makeRoot();
  try {
    const controller = new AbortController();
    controller.abort();
    const res = await runCommand(
      { roots: [root], cwd: root.path, command: "ping", signal: controller.signal },
      fakeSpawn({ stdout: "never" }),
    );
    assert.equal(res.ok, false);
    assert.equal(res.code, "aborted");
  } finally {
    fs.rmSync(root.path, { recursive: true, force: true });
  }
});

test("shell-run：输出超过采集上限就杀进程回 too-large（不假装成功）", async () => {
  const root = makeRoot();
  try {
    let killed = false;
    const spawnImpl = () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.pid = 424242;
      child.killed = false;
      child.kill = () => {
        killed = true;
        child.killed = true;
      };
      setImmediate(() => {
        child.stdout.emit("data", Buffer.alloc(600 * 1024, 0x61));
      });
      return child;
    };
    const res = await runCommand({ roots: [root], cwd: root.path, command: "dir" }, spawnImpl);
    assert.equal(res.ok, false);
    assert.equal(res.code, "too-large");
    assert.equal(killed, true);
  } finally {
    fs.rmSync(root.path, { recursive: true, force: true });
  }
});

test("shell:run：非可信来源一律 untrusted-sender（fail-closed）", async () => {
  const handlers = new Map();
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) };
  registerShellIpc(ipcMain, { isTrustedSender: () => false });
  assert.equal(typeof handlers.get("shell:run"), "function", "通道必须注册");
  const res = await handlers.get("shell:run")({ sender: {} }, {});
  assert.equal(res.ok, false);
  assert.equal(res.code, "untrusted-sender");
});

test("shell:run：未注入 isTrustedSender 时默认拒绝（忘了接线不能被默认放行）", async () => {
  const handlers = new Map();
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) };
  registerShellIpc(ipcMain, {});
  const res = await handlers.get("shell:run")({ sender: {} }, {});
  assert.equal(res.code, "untrusted-sender");
});

test("shell:run：可信来源 + 参数合法时把结果交给渲染层", async () => {
  const root = makeRoot();
  try {
    const handlers = new Map();
    const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) };
    registerShellIpc(ipcMain, {
      isTrustedSender: () => true,
      spawnImpl: fakeSpawn({ stdout: "done\n", code: 0 }),
    });
    const res = await handlers.get("shell:run")({ sender: {} }, {
      roots: [root],
      cwd: root.path,
      command: "echo done",
    });
    assert.equal(res.ok, true);
    assert.equal(res.stdout, "done\n");
  } finally {
    fs.rmSync(root.path, { recursive: true, force: true });
  }
});

/** 假子进程：不主动结束，用来测「取消」；只有 kill 之后才会 close。 */
function stuckChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.pid = 4343;
  child.kill = () => {
    child.killed = true;
    setImmediate(() => child.emit("close", null, "SIGKILL"));
  };
  return child;
}

test("shell-run：取消在跑的命令会杀进程并回 aborted（d.165）", async () => {
  const root = makeRoot();
  try {
    const child = stuckChild();
    const pending = runCommand(
      { roots: [root], cwd: root.path, command: "npm test", runId: "run-1" },
      () => child,
    );
    // 等它真的 spawn 出来再取消
    await new Promise((r) => setImmediate(r));
    assert.equal(child.killed, false);
    const cancelled = cancelRun("run-1");
    assert.equal(cancelled.ok, true);
    const res = await pending;
    assert.equal(res.ok, false);
    assert.equal(res.code, "aborted");
    assert.equal(child.killed, true, "取消必须真的杀掉子进程，而不是只改返回文案");
  } finally {
    fs.rmSync(root.path, { recursive: true, force: true });
  }
});

test("shell-run：命令开始前就取消，则根本不会 spawn（排队中的取消）", async () => {
  const root = makeRoot();
  try {
    assert.equal(cancelRun("run-early").ok, true);
    let spawned = 0;
    const res = await runCommand(
      { roots: [root], cwd: root.path, command: "npm test", runId: "run-early" },
      () => {
        spawned += 1;
        return fakeChild({ code: 0 });
      },
    );
    assert.equal(res.ok, false);
    assert.equal(res.code, "aborted");
    assert.equal(spawned, 0, "取消了还 spawn，等于「停止」按钮没生效");
  } finally {
    fs.rmSync(root.path, { recursive: true, force: true });
  }
});

test("shell-run：取消不存在的 runId 不会误杀别的命令，也不抛", async () => {
  const root = makeRoot();
  try {
    const child = stuckChild();
    const pending = runCommand(
      { roots: [root], cwd: root.path, command: "sleep 1", runId: "run-a" },
      () => child,
    );
    await new Promise((r) => setImmediate(r));
    const res = cancelRun("run-unknown");
    assert.equal(res.ok, true);
    assert.equal(child.killed, false, "取消未知 id 不能波及在跑的命令");
    cancelRun("run-a");
    await pending;
  } finally {
    fs.rmSync(root.path, { recursive: true, force: true });
  }
});

test("shell-run：`shell:cancel` 通道注册且非可信来源被拒（d.165）", () => {
  const handlers = new Map();
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) };
  registerShellIpc(ipcMain, {
    isTrustedSender: (event) => event && event.trusted === true,
  });
  assert.ok(handlers.has("shell:cancel"), "必须注册 shell:cancel");
  const res = handlers.get("shell:cancel")({ trusted: false }, { runId: "x" });
  assert.equal(res.ok, false);
  assert.equal(res.code, "untrusted-sender");
});
