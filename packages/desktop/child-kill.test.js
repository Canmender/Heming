"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const {
  DEFAULT_GRACE_MS,
  ESCALATION_WAIT_MS,
  QUIT_CAP_MS,
  createChildReclaimer,
  forceKillProcessTree,
  hasExited,
  signalEscalate,
  signalTree,
  teardownChild,
  waitForExit,
} = require("./child-kill");

/**
 * 假子进程：形状对齐 Node 的 ChildProcess（活着的进程 exitCode/signalCode 是 **null**）。
 * 所有用例都注入假的 execFileSync/killGroup——本文件不允许碰真进程。
 */
function fakeChild(pid = 4321) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  const kills = [];
  child.kill = (signal) => {
    kills.push(signal ?? "default");
    return true;
  };
  return { child, kills };
}

/** 记账用：execFileSync（Windows taskkill）与 killGroup（POSIX 负 PID）。 */
function makeDeps(overrides = {}) {
  const taskkills = [];
  const groups = [];
  const deps = {
    isWindows: overrides.isWindows ?? false,
    taskkills,
    groups,
    execFileSync: (cmd, args, opts) => {
      taskkills.push({ cmd, args, opts });
      if (overrides.taskkillThrows) throw new Error("process not found");
      return Buffer.from("");
    },
    killGroup: (pid, signal) => {
      groups.push([pid, signal]);
      if (overrides.killThrows) {
        const err = new Error("no such process");
        err.code = "ESRCH";
        throw err;
      }
      return true;
    },
  };
  if (overrides.onSignal) {
    const innerKillGroup = deps.killGroup;
    deps.killGroup = (pid, signal) => {
      innerKillGroup(pid, signal);
      overrides.onSignal(signal);
    };
    const innerExec = deps.execFileSync;
    deps.execFileSync = (cmd, args, opts) => {
      innerExec(cmd, args, opts);
      overrides.onSignal("taskkill");
      return Buffer.from("");
    };
  }
  return deps;
}

// —————————————————————— 判据 ——————————————————————

test("hasExited：null（活着）与 undefined（没报告）不是一回事", () => {
  assert.equal(hasExited({ exitCode: null, signalCode: null }), false);
  assert.equal(hasExited({}), false, "字段缺失不能当成已退出——否则一个信号都不发就放它走");
  assert.equal(hasExited({ exitCode: 0 }), true);
  assert.equal(hasExited({ signalCode: "SIGTERM" }), true);
  assert.equal(hasExited(null), true, "没有进程可收 = 已经是干净状态");
});

// —————————————————————— Windows 拔树 ——————————————————————

test("forceKillProcessTree：/T /F 走参数数组，绝不经 shell", () => {
  const deps = makeDeps({ isWindows: true });
  assert.equal(forceKillProcessTree(4321, deps), true);
  assert.deepEqual(deps.taskkills[0].args, ["/T", "/F", "/PID", "4321"]);
  assert.equal(deps.taskkills[0].opts.stdio, "ignore");
  assert.equal(deps.taskkills[0].opts.shell, undefined, "spawn/exec 不许开 shell");
  assert.equal(deps.taskkills[0].opts.windowsHide, true);
});

test("forceKillProcessTree：PID 必须是正整数，坏值直接拒绝而不是丢给系统", () => {
  const deps = makeDeps({ isWindows: true });
  for (const bad of [0, -1, 1.5, "4321", "4321 & del x", null, undefined, NaN]) {
    assert.equal(forceKillProcessTree(bad, deps), false, `放过 ${String(bad)} 就是命令注入口`);
  }
  assert.equal(deps.taskkills.length, 0);
});

test("forceKillProcessTree：taskkill 失败（进程早没了）不算错误", () => {
  const deps = makeDeps({ isWindows: true, taskkillThrows: true });
  assert.equal(forceKillProcessTree(4321, deps), false);
});

// —————————————————————— 第一档信号 ——————————————————————

test("signalTree：Windows 拔整棵树，不再多做 child.kill()", () => {
  const { child, kills } = fakeChild();
  const deps = makeDeps({ isWindows: true });
  assert.equal(signalTree(child, deps), "tree");
  assert.equal(deps.taskkills.length, 1);
  assert.equal(kills.length, 0);
});

test("signalTree：POSIX 打的是负 PID（整个进程组），不是单个进程", () => {
  const { child, kills } = fakeChild(4321);
  const deps = makeDeps({ isWindows: false });
  assert.equal(signalTree(child, deps), "group");
  assert.deepEqual(deps.groups, [[-4321, "SIGTERM"]]);
  assert.equal(kills.length, 0);
});

test("signalTree：不是组长（ESRCH）时退化成单打，而不是把退出流程抛穿", () => {
  const { child, kills } = fakeChild();
  const deps = makeDeps({ isWindows: false, killThrows: true });
  assert.equal(signalTree(child, deps), "direct");
  assert.deepEqual(kills, ["SIGTERM"]);
});

test("signalTree：没有 pid 的进程只剩 child.kill() 这条路", () => {
  const { child, kills } = fakeChild();
  delete child.pid;
  const deps = makeDeps({ isWindows: false });
  assert.equal(signalTree(child, deps), "direct");
  assert.deepEqual(kills, ["SIGTERM"]);
});

test("signalEscalate：Windows 已经 /T /F 过，不许再 taskkill 第二遍", () => {
  const { child } = fakeChild();
  const deps = makeDeps({ isWindows: true });
  assert.equal(signalEscalate(child, deps), false);
  assert.equal(deps.taskkills.length, 0);
});

// —————————————————————— 完整回收序列 ——————————————————————

test("teardownChild：进程在宽限内自己退出 ⇒ 一个信号都不发", async () => {
  const { child, kills } = fakeChild();
  const deps = makeDeps();
  setTimeout(() => child.emit("exit", 0, null), 5);
  const result = await teardownChild(child, { ...deps, graceMs: 50, killWaitMs: 10 });
  assert.deepEqual(result, { exited: true, via: "graceful" });
  assert.equal(kills.length, 0);
  assert.equal(deps.groups.length, 0);
});

test("teardownChild：宽限到点 → SIGTERM 整组 → 仍不死 → SIGKILL 整组", async () => {
  const { child } = fakeChild(4321);
  const deps = makeDeps({ isWindows: false });
  const result = await teardownChild(child, { ...deps, graceMs: 0, killWaitMs: 10 });
  assert.deepEqual(deps.groups, [
    [-4321, "SIGTERM"],
    [-4321, "SIGKILL"],
  ]);
  assert.equal(result.exited, false, "假进程永远不会退：结论必须如实是无法确认");
  assert.equal(result.via, "force-group");
});

test("teardownChild：SIGTERM 后就退出 ⇒ 不再补 SIGKILL", async () => {
  const { child } = fakeChild();
  const deps = makeDeps({
    onSignal: (signal) => {
      if (signal === "SIGTERM") setImmediate(() => child.emit("exit", null, "SIGTERM"));
    },
  });
  const result = await teardownChild(child, { ...deps, graceMs: 0, killWaitMs: 20 });
  assert.equal(result.exited, true);
  assert.equal(result.via, "group");
  assert.deepEqual(deps.groups, [[-4321, "SIGTERM"]]);
});

test("teardownChild：Windows 全程只拔一次树", async () => {
  const { child } = fakeChild();
  const deps = makeDeps({ isWindows: true });
  const result = await teardownChild(child, { ...deps, graceMs: 0, killWaitMs: 10 });
  assert.equal(deps.taskkills.length, 1, "强杀本身就是 /T /F，重复执行只会拖慢退出");
  assert.equal(result.exited, false);
  assert.equal(result.via, "tree");
});

test("teardownChild：已经退出的进程直接认账，不做任何信号动作", async () => {
  const { child, kills } = fakeChild();
  child.exitCode = 0;
  const deps = makeDeps();
  const result = await teardownChild(child, deps);
  assert.deepEqual(result, { exited: true, via: "already" });
  assert.equal(kills.length, 0);
  assert.equal(deps.groups.length, 0);
});

test("teardownChild(null)：没有进程就是已回收，不是错误", async () => {
  const result = await teardownChild(null, makeDeps());
  assert.deepEqual(result, { exited: true, via: "none" });
});

test("teardownChild 的缺省预算：宽限 1.5s、每次确认 1s（够礼貌退出，又不至于拖住关闭）", () => {
  assert.equal(DEFAULT_GRACE_MS, 1_500);
  assert.equal(ESCALATION_WAIT_MS, 1_000);
  assert.equal(QUIT_CAP_MS, 4_000);
  // 缺省宽限走满的最坏路径必须仍在退出硬闸之内，否则回收会被闸腰斩、留下没杀死的树
  assert.ok(
    DEFAULT_GRACE_MS + ESCALATION_WAIT_MS * 2 <= QUIT_CAP_MS,
    "grace + 2×确认 超出 QUIT_CAP_MS：退出流程会先于回收结束",
  );
});

// —————————————————————— waitForExit ——————————————————————

test("waitForExit：等不到就返回 false，并且摘掉 exit 监听（不留重复监听警告）", async () => {
  const { child } = fakeChild();
  const exited = await waitForExit(child, 15);
  assert.equal(exited, false);
  assert.equal(child.listenerCount("exit"), 0);
});

test("waitForExit：已退出的进程立刻 resolve，不占一个定时器", async () => {
  const { child } = fakeChild();
  child.signalCode = "SIGKILL";
  await waitForExit(child, 10_000); // 若不立刻返回，这条用例会挂到测试超时
  assert.equal(child.listenerCount("exit"), 0);
});

test("护栏：本模块的兜底定时器一个都不许 unref", () => {
  // waitForExit 的超时与回收闸的超闸是「保证有结论」的唯一依托：
  // 一旦 unref，主进程事件循环空下来（窗口都关了）它们就永不响 ——
  // 前者等于没杀进程，后者等于应用关不掉。旧实现正是死在这上面。
  const code = readFileSync(path.join(__dirname, "child-kill.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
  assert.equal(/unref\(/.test(code), false, "child-kill 里的定时器必须留在事件循环上");
  assert.ok(code.includes("taskkill"), "Windows 分支必须走 taskkill /T /F");
});

// —————————————————————— will-quit 回收闸 ——————————————————————

function makeReclaimer(overrides = {}) {
  const quits = [];
  const prevented = [];
  const logs = [];
  const tasks = [];
  const reclaimer = createChildReclaimer({
    tasks: overrides.tasks ?? (() => tasks),
    onQuit: () => quits.push(Date.now()),
    capMs: overrides.capMs ?? 30,
    log: (line) => logs.push(line),
  });
  const event = () => {
    const holder = { prevented: false };
    prevented.push(holder);
    return { preventDefault: () => (holder.prevented = true) };
  };
  return { reclaimer, event, quits, prevented, logs, tasks };
}

test("回收闸：没有子进程就不拦退出（一次多余的 preventDefault 都会拖慢关闭）", () => {
  const h = makeReclaimer();
  h.reclaimer(h.event());
  assert.equal(h.prevented[0].prevented, false);
  assert.equal(h.quits.length, 0);
});

test("回收闸：有任务时拦一次 → 等回收跑完 → 再触发退出", async () => {
  const h = makeReclaimer();
  let done;
  const gate = new Promise((r) => {
    done = r;
  });
  let reclaimed = false;
  h.tasks.push(() =>
    gate.then(() => {
      reclaimed = true;
    }),
  );
  h.reclaimer(h.event());
  assert.equal(h.prevented[0].prevented, true);
  await new Promise((r) => setImmediate(r));
  assert.equal(h.quits.length, 0, "回收还没跑完就退出 ⇒ 又是孤儿");
  done();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(reclaimed, true);
  assert.equal(h.quits.length, 1);
});

test("回收闸：任务挂死也必须到点放行——应用关不掉比留孤儿更糟", async () => {
  const h = makeReclaimer({ capMs: 20 });
  h.tasks.push(() => new Promise(() => {})); // 永不 resolve
  h.reclaimer(h.event());
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(h.quits.length, 1);
});

test("回收闸：第二次 will-quit 绝不再拦，否则永远退不出去", async () => {
  const h = makeReclaimer({ capMs: 20 });
  h.tasks.push(() => new Promise(() => {}));
  h.reclaimer(h.event());
  h.reclaimer(h.event());
  assert.equal(h.prevented[1].prevented, false);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(h.quits.length, 1, "只能触发一次退出");
});

test("回收闸：任务抛错也算回收结束，不影响放行", async () => {
  const h = makeReclaimer();
  h.tasks.push(() => {
    throw new Error("dispose 炸了");
  });
  h.tasks.push(async () => {});
  h.reclaimer(h.event());
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.quits.length, 1);
});

test("回收闸：枚举任务本身就失败时不拦退出（没有已知子进程，别拖慢关闭）", () => {
  const h = makeReclaimer({
    tasks: () => {
      throw new Error("桥已经没了");
    },
  });
  h.reclaimer(h.event());
  assert.equal(h.prevented[0].prevented, false);
  assert.equal(h.quits.length, 0);
  assert.match(h.logs.join("\n"), /枚举失败/);
});

test("回收闸：onQuit 自己抛错只写日志，不变成未捕获异常", async () => {
  const logs = [];
  const reclaimer = createChildReclaimer({
    tasks: () => [async () => {}],
    onQuit: () => {
      throw new Error("app.quit 炸了");
    },
    capMs: 20,
    log: (line) => logs.push(line),
  });
  reclaimer({ preventDefault: () => {} });
  await new Promise((r) => setTimeout(r, 10));
  assert.match(logs.join("\n"), /退出触发失败/);
});

test("护栏：超闸定时器不许 unref —— 事件循环空了也要照样放行", () => {
  // 这条只能用真子进程验证：node --test 自己占着事件循环，被 unref 的定时器在这里照样会响，
  // 单元测试根本测不出「空转时不放行」。所以起一个干净的 node 进程，只留超闸这一个活动句柄。
  const script = [
    `const { createChildReclaimer } = require(${JSON.stringify(path.join(__dirname, "child-kill.js"))});`,
    "const reclaimer = createChildReclaimer({",
    "  tasks: () => [() => new Promise(() => {})],", // 回收永远挂住
    "  onQuit: () => { process.stdout.write('RELEASED'); process.exit(7); },",
    "  capMs: 60,",
    "});",
    "reclaimer({ preventDefault: () => {} });",
  ].join("\n");
  const { spawnSync } = require("node:child_process");
  const run = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 8_000 });
  assert.ok(run.stdout.includes("RELEASED"), "超闸没放行：进程要么 hangs（status=null）要么自己悄悄退了（无输出）");
  assert.equal(run.status, 7);
});
