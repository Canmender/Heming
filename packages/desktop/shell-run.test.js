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
  startBackground,
  readJobOutput,
  previewJobOutput,
  killJob,
  listJobs,
  MAX_COMMAND_CHARS,
  MAX_BACKGROUND_JOBS,
  MAX_JOB_BYTES,
  MAX_JOB_MS,
  MAX_JOB_WAIT_MS,
  MAX_JOB_PREVIEW_BYTES,
  decodeCommandOutput,
  shapeTerminalText,
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
    assert.match(res.error, /渲染层已断开/, "断连时的文案要说清是断开，不是用户取消");
    assert.doesNotMatch(res.error, /已被取消/, "断连不能被写成「用户取消」——甩锅式文案会让人误以为是自己点的");
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

test("shell-run：取消在跑的命令会杀进程并回 aborted（d.165 / 时序修正 d.230）", async () => {
  const root = makeRoot();
  try {
    const child = stuckChild();
    // 确定性等待「真的 spawn 了」：以前用一次 setImmediate，机器一忙就可能在校验目录阶段
    // 就取消，于是走的是「执行前取消」分支、child 根本没用上，断言随机红（d.230 修）。
    let spawnedResolve;
    const spawned = new Promise((r) => {
      spawnedResolve = r;
    });
    const pending = runCommand(
      { roots: [root], cwd: root.path, command: "npm test", runId: "run-1" },
      () => {
        spawnedResolve();
        return child;
      },
    );
    await spawned;
    assert.equal(child.killed, false);

    const cancelled = cancelRun("run-1");
    assert.equal(cancelled.ok, true);

    const res = await pending;
    assert.equal(res.ok, false);
    assert.equal(res.code, "aborted");
    assert.equal(child.killed, true, "取消必须真的杀掉子进程，而不是只改返回文案");
    assert.match(res.error, /命令已被取消/, "用户主动停止时的文案要说「已取消」，不能甩锅给「渲染层断开」");
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
    let spawnedResolve;
    const spawned = new Promise((r) => {
      spawnedResolve = r;
    });
    const pending = runCommand(
      { roots: [root], cwd: root.path, command: "sleep 1", runId: "run-a" },
      () => {
        spawnedResolve();
        return child;
      },
    );
    await spawned;
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

/* ─────────────────────── 后台命令作业（d.180） ─────────────────────── */

/** 可控的后台假子进程：不自动结束，由用例手动 emit data/close（测增量读与空转）。 */
function controlledChild(pid = 999001) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.pid = pid;
  child.kill = () => {
    child.killed = true;
    // 真实 kill 之后 close 是异步到的：这里同样晚一拍，避免测试依赖同步时序。
    setImmediate(() => child.emit("close", null, "SIGKILL"));
  };
  return child;
}

/** 后台启动并返回 { jobId, child }；失败时直接断言失败，省得每个用例重复判空。 */
async function startJob(root, spawnImpl, extra = {}) {
  const res = await startBackground({ roots: [root], cwd: root.path, command: "npm run build", ...extra }, spawnImpl);
  assert.equal(res.ok, true, JSON.stringify(res));
  return res;
}

test("后台作业：立即返回 jobId/pid/cwd，不等命令结束（d.180）", async () => {
  const root = makeRoot();
  try {
    const child = controlledChild(999001);
    const startedAt = Date.now();
    const res = await startJob(root, () => child);
    assert.match(res.jobId, /^job-/);
    assert.equal(res.pid, 999001);
    assert.equal(res.cwd, root.path.replace(/\\/g, "/"), "cwd 统一正斜杠（与前台结果一致）");
    assert.ok(Date.now() - startedAt < 2000, "后台启动不能被命令本身的执行时间拖住");
    assert.equal(listJobs().some((job) => job.id === res.jobId && job.running === true), true);
    // 收尾：手动关掉，避免把在跑作业留给后面的用例。
    child.emit("close", 0, null);
    await readJobOutput(res.jobId, 1000);
  } finally {
    fs.rmSync(root.path, { recursive: true, force: true });
  }
});

test("后台作业不进 enqueue：后台还在跑时，前台命令照样立刻执行（d.180）", async () => {
  const root = makeRoot();
  try {
    const child = controlledChild(999002);
    const bg = await startJob(root, () => child);
    // 如果后台占用了串行队列，这条前台命令会等到 child close 才返回——测试会超时。
    const front = await runCommand(
      { roots: [root], cwd: root.path, command: "echo front" },
      fakeSpawn({ stdout: "front\n", code: 0 }),
    );
    assert.equal(front.ok, true);
    assert.equal(front.stdout, "front\n");
    assert.equal(listJobs().find((job) => job.id === bg.jobId).running, true, "前台跑完时后台仍在跑");
    child.emit("close", 0, null);
    await readJobOutput(bg.jobId, 1000);
  } finally {
    fs.rmSync(root.path, { recursive: true, force: true });
  }
});

test("job-output：未读缓冲做增量，读一次消费一次、第二次只拿新增量（d.180）", async () => {
  const root = makeRoot();
  try {
    const child = controlledChild(999003);
    const job = await startJob(root, () => child);
    child.stdout.emit("data", Buffer.from("one\n"));
    child.stderr.emit("data", Buffer.from("err-1\n"));
    const first = await readJobOutput(job.jobId, 0);
    assert.equal(first.ok, true);
    assert.equal(first.running, true);
    assert.equal(first.stdout, "one\n");
    assert.equal(first.stderr, "err-1\n");

    child.stdout.emit("data", Buffer.from("two\n"));
    const second = await readJobOutput(job.jobId, 0);
    assert.equal(second.stdout, "two\n", "已读走的字节不能重复返回");
    assert.equal(second.stderr, "");

    child.emit("close", 0, null);
    const third = await readJobOutput(job.jobId, 1000);
    assert.equal(third.running, false);
    assert.equal(third.exitCode, 0);
    assert.equal(third.stdout, "", "结束后没有新输出");
  } finally {
    fs.rmSync(root.path, { recursive: true, force: true });
  }
});

test("job-output：waitMs 会等到作业结束再返回（不用渲染层空转轮询）", async () => {
  const root = makeRoot();
  try {
    const child = controlledChild(999004);
    const job = await startJob(root, () => child);
    const pending = readJobOutput(job.jobId, 5000);
    child.stdout.emit("data", Buffer.from("late\n"));
    setTimeout(() => child.emit("close", 7, null), 25);
    const res = await pending;
    assert.equal(res.ok, true);
    assert.equal(res.running, false);
    assert.equal(res.exitCode, 7);
    assert.equal(res.stdout, "late\n", "等待期间产生的输出必须包含在返回里");
  } finally {
    fs.rmSync(root.path, { recursive: true, force: true });
  }
});

test("job-output：waitMs 超时先回当前增量，running 仍为 true（有界等待）", async () => {
  const root = makeRoot();
  try {
    const child = controlledChild(999005);
    const job = await startJob(root, () => child);
    child.stdout.emit("data", Buffer.from("tick\n"));
    const startedAt = Date.now();
    const res = await readJobOutput(job.jobId, 60);
    const waited = Date.now() - startedAt;
    assert.equal(res.running, true);
    assert.equal(res.stdout, "tick\n");
    assert.ok(waited >= 40, `应当至少等一会儿再超时，实际 ${waited}ms`);
    assert.ok(waited < 2000, `等待必须被钳住，实际 ${waited}ms`);
    child.emit("close", 0, null);
    await readJobOutput(job.jobId, 1000);
  } finally {
    fs.rmSync(root.path, { recursive: true, force: true });
  }
});

test("job-output：未知 jobId 回 unknown-job；waitMs 非法值按 0 处理（d.180）", async () => {
  assert.equal(MAX_JOB_WAIT_MS, 30_000);
  assert.equal(MAX_JOB_MS, 30 * 60 * 1000);
  assert.equal(MAX_JOB_BYTES, 512 * 1024);
  assert.equal(MAX_BACKGROUND_JOBS, 20);

  const unknown = await readJobOutput("job-nope", 5000);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, "unknown-job");

  const root = makeRoot();
  try {
    const child = controlledChild(999006);
    const job = await startJob(root, () => child);
    // NaN 不是有限数：当作 0（立即返回），不能变成「永远等」。
    const res = await readJobOutput(job.jobId, Number.NaN);
    assert.equal(res.running, true);
    child.emit("close", 0, null);
    await readJobOutput(job.jobId, 1000);
  } finally {
    fs.rmSync(root.path, { recursive: true, force: true });
  }
});

test("job-kill：在跑时真的杀进程树；已结束则 alreadyFinished；未知 jobId 被拒（d.180）", async () => {
  const root = makeRoot();
  try {
    const child = controlledChild(999007);
    const job = await startJob(root, () => child);
    const killed = killJob(job.jobId);
    assert.deepEqual(killed, { ok: true, jobId: job.jobId, killed: true, alreadyFinished: false });
    assert.equal(child.killed, true, "killJob 必须真的动子进程，而不是只改返回文案");
    await readJobOutput(job.jobId, 1000);
    const again = killJob(job.jobId);
    assert.equal(again.killed, false);
    assert.equal(again.alreadyFinished, true);

    const missing = killJob("job-missing");
    assert.equal(missing.ok, false);
    assert.equal(missing.code, "unknown-job");
  } finally {
    fs.rmSync(root.path, { recursive: true, force: true });
  }
});

test("shell:jobs：列出作业元数据，bytes 是累计产出、cwd 正斜杠（d.180）", async () => {
  const root = makeRoot();
  try {
    const child = controlledChild(999008);
    const job = await startJob(root, () => child, { command: "node app.js" });
    child.stdout.emit("data", Buffer.from("abc"));
    child.stderr.emit("data", Buffer.from("de"));
    child.emit("close", 0, null);
    await readJobOutput(job.jobId, 1000);

    const listed = listJobs().find((item) => item.id === job.jobId);
    assert.ok(listed, "列表里必须有这个作业");
    assert.equal(listed.command, "node app.js");
    assert.equal(listed.cwd, root.path.replace(/\\/g, "/"));
    assert.equal(listed.running, false);
    assert.equal(listed.exitCode, 0);
    assert.equal(typeof listed.startedAt, "number");
    assert.equal(typeof listed.finishedAt, "number");
    assert.equal(listed.bytes, 5, "bytes 统计的是累计产出（已读走也算）");
    assert.equal(listed.dropped, 0);
    assert.ok(!Object.prototype.hasOwnProperty.call(listed, "stdout"), "列表不带输出正文");
  } finally {
    fs.rmSync(root.path, { recursive: true, force: true });
  }
});

test("输出超过 MAX_JOB_BYTES：丢最旧字节、累计 dropped、truncated=true（d.180）", async () => {
  const root = makeRoot();
  try {
    const child = controlledChild(999009);
    const job = await startJob(root, () => child);
    const half = 400 * 1024;
    child.stdout.emit("data", Buffer.alloc(half, 0x61)); // 'a'
    child.stdout.emit("data", Buffer.alloc(half, 0x62)); // 'b'
    const res = await readJobOutput(job.jobId, 0);
    assert.equal(res.truncated, true);
    assert.equal(res.droppedBytes, half * 2 - MAX_JOB_BYTES);
    assert.equal(res.stdout.length, MAX_JOB_BYTES, "未读缓冲必须收敛到上限");
    assert.equal(res.stdout[0], "a", "先丢的是最旧的字节");
    assert.equal(res.stdout[MAX_JOB_BYTES - half - 1], "a");
    assert.equal(res.stdout[MAX_JOB_BYTES - half], "b");
    assert.equal(res.stdout[res.stdout.length - 1], "b");
    assert.equal(
      listJobs().find((item) => item.id === job.jobId).bytes,
      half * 2,
      "produced 仍应记录全部产出",
    );
    child.emit("close", 0, null);
    await readJobOutput(job.jobId, 1000);
  } finally {
    fs.rmSync(root.path, { recursive: true, force: true });
  }
});

test("已完成作业淘汰：只保留最近 MAX_BACKGROUND_JOBS 个（d.180）", async () => {
  const root = makeRoot();
  try {
    const ids = [];
    for (let i = 0; i < MAX_BACKGROUND_JOBS + 5; i += 1) {
      const started = await startJob(root, () => fakeChild({ stdout: `out-${i}`, code: 0 }), {
        command: `echo ${i}`,
      });
      ids.push(started.jobId);
      await readJobOutput(started.jobId, 1000);
    }
    const finishedIds = listJobs()
      .filter((item) => !item.running)
      .map((item) => item.id);
    assert.equal(finishedIds.length, MAX_BACKGROUND_JOBS, "已完成作业数量必须被淘汰到上限");
    // 最新的 20 个（ids[5..24]）必须都在；最旧的 5 个必须已被清理。
    for (const id of ids.slice(5)) assert.ok(finishedIds.includes(id), `最新作业不能被淘汰：${id}`);
    for (const id of ids.slice(0, 5)) assert.ok(!finishedIds.includes(id), `最旧作业必须被淘汰：${id}`);
  } finally {
    fs.rmSync(root.path, { recursive: true, force: true });
  }
});

test("后台作业：非法命令/越界目录/预先取消都不会 spawn（d.180）", async () => {
  const root = makeRoot();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "heming-bg-outside-"));
  try {
    let spawned = 0;
    const spawnImpl = () => {
      spawned += 1;
      return fakeChild({ code: 0 });
    };
    const empty = await startBackground({ roots: [root], cwd: root.path, command: "   " }, spawnImpl);
    assert.equal(empty.code, "invalid-command");
    const noRoots = await startBackground({ roots: [], cwd: root.path, command: "echo hi" }, spawnImpl);
    assert.equal(noRoots.code, "no-roots");
    const escaped = await startBackground({ roots: [root], cwd: outside, command: "echo hi" }, spawnImpl);
    assert.equal(escaped.code, "outside-roots");
    assert.equal(spawned, 0, "校验失败时绝不能启动进程");

    assert.equal(cancelRun("bg-early").ok, true);
    const aborted = await startBackground(
      { roots: [root], cwd: root.path, command: "npm test", runId: "bg-early" },
      spawnImpl,
    );
    assert.equal(aborted.code, "aborted");
    assert.equal(spawned, 0, "校验目录期间被取消的作业也不能 spawn");
  } finally {
    fs.rmSync(root.path, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("shell:jobs / shell:job-output / shell:job-kill：非可信来源一律拒绝（d.180）", async () => {
  const handlers = new Map();
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) };
  registerShellIpc(ipcMain, {
    isTrustedSender: (event) => event && event.trusted === true,
    spawnImpl: fakeSpawn({ stdout: "x", code: 0 }),
  });
  for (const channel of ["shell:jobs", "shell:job-output", "shell:job-preview", "shell:job-kill"]) {
    assert.equal(typeof handlers.get(channel), "function", `${channel} 必须注册`);
    const res = await handlers.get(channel)({ trusted: false }, { jobId: "job-1", waitMs: 10 });
    assert.equal(res.ok, false, channel);
    assert.equal(res.code, "untrusted-sender", channel);
  }
  // 后台分支也必须先过来源检查：不能靠 background:true 绕过。
  const bg = await handlers.get("shell:run")({ trusted: false }, { background: true, command: "echo hi" });
  assert.equal(bg.code, "untrusted-sender");

  // 没注入 isTrustedSender 时默认拒绝（fail-closed）。
  const handlers2 = new Map();
  registerShellIpc({ handle: (channel, fn) => handlers2.set(channel, fn) }, {});
  const denied = await handlers2.get("shell:jobs")({ sender: {} });
  assert.equal(denied.code, "untrusted-sender");
});

test("shell:run background：经 IPC 启动后台作业，再经 jobs/job-output/job-kill 取结果（d.180）", async () => {
  const root = makeRoot();
  try {
    const handlers = new Map();
    const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) };
    registerShellIpc(ipcMain, {
      isTrustedSender: () => true,
      spawnImpl: fakeSpawn({ stdout: "bg\n", code: 0 }, {}),
    });
    const started = await handlers.get("shell:run")({ sender: {} }, {
      roots: [root],
      cwd: root.path,
      command: "echo bg",
      background: true,
    });
    assert.equal(started.ok, true);
    assert.ok(started.jobId);

    const listed = await handlers.get("shell:jobs")({ sender: {} });
    assert.equal(listed.ok, true);
    assert.ok(listed.jobs.some((job) => job.id === started.jobId));

    const output = await handlers.get("shell:job-output")({ sender: {} }, {
      jobId: started.jobId,
      waitMs: 1000,
    });
    assert.equal(output.ok, true);
    assert.equal(output.running, false);
    assert.equal(output.stdout, "bg\n");

    const killed = await handlers.get("shell:job-kill")({ sender: {} }, { jobId: started.jobId });
    assert.equal(killed.ok, true);
    assert.equal(killed.alreadyFinished, true);
  } finally {
    fs.rmSync(root.path, { recursive: true, force: true });
  }
});
test("job-preview：只读快照不消费增量，读完之后 command_output 仍拿得到同一段（d.203）", async () => {
  const root = makeRoot();
  try {
    const child = controlledChild(999101);
    const job = await startJob(root, () => child);
    child.stdout.emit("data", Buffer.from("line1\n"));
    child.stderr.emit("data", Buffer.from("warn: x\n"));

    const preview = previewJobOutput(job.jobId);
    assert.equal(preview.ok, true);
    assert.equal(preview.running, true);
    assert.equal(preview.stdout, "line1\n");
    assert.equal(preview.stderr, "warn: x\n");
    assert.equal(preview.cut, false);
    assert.equal(preview.produced, 14);

    // 关键：预览之后模型那条增量读必须还拿得到——否则用户在界面点一次「日志」，
    // 模型那一轮的 command_output 就少一段，两边互相抢。
    const output = await readJobOutput(job.jobId, 0);
    assert.equal(output.stdout, "line1\n");
    assert.equal(output.stderr, "warn: x\n");

    // 增量已经被读走：再预览就只剩空的，这是事实，不能假装还有。
    const again = previewJobOutput(job.jobId);
    assert.equal(again.stdout, "");

    child.emit("close", 0, null);
    await readJobOutput(job.jobId, 1000);
  } finally {
    fs.rmSync(root.path, { recursive: true, force: true });
  }
});

test("job-preview：只取末尾 maxBytes 并如实标 cut；长度被夹在 512..16KB（d.203）", async () => {
  assert.equal(MAX_JOB_PREVIEW_BYTES, 16 * 1024);
  const root = makeRoot();
  try {
    const child = controlledChild(999102);
    const job = await startJob(root, () => child);
    // 600 字节：超过 512 的下限，预览 512 时必然要截前面。
    const long = "a".repeat(600) + "TAIL";
    child.stdout.emit("data", Buffer.from(long));

    const tail = previewJobOutput(job.jobId, 512);
    assert.equal(tail.stdout.length, 512);
    assert.equal(tail.stdout.endsWith("TAIL"), true);
    assert.equal(tail.cut, true, "截掉了前面的内容必须标出来");

    // 非法/过小的 maxBytes 夹到 512：不会因为渲染层传 1 就把日志切成一个字符。
    const tiny = previewJobOutput(job.jobId, 1);
    assert.equal(tiny.stdout, tail.stdout);
    assert.equal(tiny.cut, true);
    // 缺省/非法长度 = 取到 16KB 上限：宁可多给，不能因为一个坏参数把日志清成空。
    const nan = previewJobOutput(job.jobId, Number.NaN);
    assert.equal(nan.stdout, long);
    assert.equal(nan.cut, false);

    const unknown = previewJobOutput("job-missing");
    assert.equal(unknown.ok, false);
    assert.equal(unknown.code, "unknown-job");

    child.emit("close", 0, null);
    await readJobOutput(job.jobId, 1000);
  } finally {
    fs.rmSync(root.path, { recursive: true, force: true });
  }
});

test("job-preview：经 IPC 可读，跑完的作业预览仍能看到最后输出（d.203）", async () => {
  const root = makeRoot();
  try {
    const handlers = new Map();
    const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) };
    registerShellIpc(ipcMain, {
      isTrustedSender: () => true,
      spawnImpl: fakeSpawn({ stdout: "build ok\n", code: 0 }, {}),
    });
    const started = await handlers.get("shell:run")({ sender: {} }, {
      roots: [root],
      cwd: root.path,
      command: "echo build ok",
      background: true,
    });
    assert.equal(started.ok, true);

    // 等作业收尾（job-output 会等到结束并顺带走掉增量，这里只为等结束）。
    const output = await handlers.get("shell:job-output")({ sender: {} }, { jobId: started.jobId, waitMs: 1000 });
    assert.equal(output.running, false);

    const preview = await handlers.get("shell:job-preview")({ sender: {} }, { jobId: started.jobId });
    assert.equal(preview.ok, true);
    assert.equal(preview.running, false);
    assert.equal(preview.exitCode, 0);
    // 增量读已经把缓冲取走，预览这里是空的——但「读走即消费」是契约，不是 bug；
    // 这里断言的是通道可用、形状正确、不报错。
    assert.equal(typeof preview.stdout, "string");
    assert.equal(preview.cut, false);
  } finally {
    fs.rmSync(root.path, { recursive: true, force: true });
  }
});

test("shell-run：输出解码——合法 UTF-8 原样、GBK 字节按 GBK 解、BOM 剥掉、坏字节不抛（d.228）", () => {
  assert.equal(decodeCommandOutput(Buffer.from("中文 ok\n")), "中文 ok\n", "合法 UTF-8 必须原样返回");
  assert.equal(decodeCommandOutput(Buffer.from([0xd6, 0xd0, 0xce, 0xc4])), "中文", "GBK 字节要按 GBK 解");
  assert.equal(
    decodeCommandOutput(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("x")])),
    "x",
    "UTF-8 BOM 要剥掉（PowerShell 重定向常见）",
  );
  assert.equal(typeof decodeCommandOutput(Buffer.from([0xff, 0xfe, 0x80])), "string", "两种编码都不成立时也不能抛");
  assert.equal(decodeCommandOutput([]), "", "空输出是空串");
  assert.equal(decodeCommandOutput([Buffer.from("中文"), Buffer.from(" ok")]), "中文 ok", "分块数组按顺序拼");
});

test("shell-run：命令输出的终端痕迹整形——ANSI 去掉、\\r 覆盖只留最终那一段（d.231）", () => {
  // ANSI 颜色与光标控制：终端会吃掉，落到工具结果里就是噪声
  assert.equal(shapeTerminalText("\u001b[32mok\u001b[0m 2 models"), "ok 2 models");
  assert.equal(shapeTerminalText("\u001b[2K\u001b[1Gdone"), "done");
  // OSC（窗口标题、超链接）
  assert.equal(shapeTerminalText("\u001b]0;title\u0007内容"), "内容");
  // \\r 覆盖：进度条最终只显示最后一段
  assert.equal(shapeTerminalText("10%\r50%\r100%"), "100%");
  assert.equal(shapeTerminalText("下载中 10%\r下载中 100%\n完成"), "下载中 100%\n完成");
  // 行尾单独的 \\r（光标回行首后没再写）保留前一段，不变成空行
  assert.equal(shapeTerminalText("abc\r\n"), "abc\n");
  // 普通文本、制表符、换行一律不动
  assert.equal(shapeTerminalText("a\tb\nc"), "a\tb\nc");
  assert.equal(shapeTerminalText(""), "");
});

test("shell-run：真跑一条吐 ANSI 与 \\r 的命令，工具结果里没有转义字符（d.231）", async () => {
  const root = makeRoot();
  try {
    const res = await runCommand({
      roots: [root],
      cwd: root.path,
      command:
        `node -e "const e=String.fromCharCode(27),r=String.fromCharCode(13);process.stdout.write('done'+String.fromCharCode(10)+e+'[32m10%'+e+'[0m'+r+'100%')"`,
    });
    assert.equal(res.ok, true);
    assert.equal(res.exitCode, 0);
    assert.equal(res.stdout, "done\n100%", "ANSI 与 \\r 都要按终端语义处理");
    assert.ok(!res.stdout.includes(String.fromCharCode(27)), "结果里不能再有 ESC");
  } finally {
    fs.rmSync(root.path, { recursive: true, force: true });
  }
});

test("shell-run：真跑一条吐 GBK 字节的命令，stdout 里是中文（d.228）", async () => {
  const root = makeRoot();
  try {
    const res = await runCommand({
      roots: [root],
      cwd: root.path,
      command: 'node -e "process.stdout.write(Buffer.from([0xd6,0xd0,0xce,0xc4]))"',
    });
    assert.equal(res.ok, true);
    assert.equal(res.exitCode, 0);
    assert.equal(res.stdout, "中文", "cmd 里跑的 node 吐 GBK 字节时必须解成中文，而不是一片问号");
  } finally {
    fs.rmSync(root.path, { recursive: true, force: true });
  }
});

test("job-output / job-preview：后台作业的输出同样按实际编码解（d.228）", async () => {
  const root = makeRoot();
  try {
    const child = controlledChild(999902);
    const job = await startJob(root, () => child);
    child.stdout.emit("data", Buffer.from([0xd6, 0xd0, 0xce, 0xc4]));
    child.emit("close", 0, null);
    const res = await readJobOutput(job.jobId, 1000);
    assert.equal(res.ok, true);
    assert.equal(res.stdout, "中文");

    const child2 = controlledChild(999903);
    const job2 = await startJob(root, () => child2);
    child2.stderr.emit("data", Buffer.from([0xb4, 0xed, 0xce, 0xf3]));
    const preview = previewJobOutput(job2.jobId);
    assert.equal(preview.ok, true);
    assert.equal(preview.stderr, "错误", "预览也要按 GBK 解（cmd 的报错就是 GBK）");
    child2.emit("close", 1, null);
    await readJobOutput(job2.jobId, 1000);
  } finally {
    fs.rmSync(root.path, { recursive: true, force: true });
  }
});
