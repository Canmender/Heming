"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const {
  clampTimeout,
  createStdioBridge,
  encodeMessage,
  extractMessages,
  isValidCommand,
  isValidArgs,
  resolveExecutable,
  resolveExecutablePath,
} = require("./mcp-stdio");

/** 假子进程：记录写入 stdin 的行，可手动 emit stdout/exit。 */
function fakeChild() {
  const writes = [];
  const child = new EventEmitter();
  child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
  child.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
  child.stdin = {
    ended: false,
    write: (chunk) => {
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

/**
 * 假回收：**同步** kill（保留 killedByUs 断言），并记录调用。
 * ★ 测试必须注入它——缺省实现会真的执行 `taskkill /T /F`，测试里的 PID 是假的，
 *   打在真机器上就是「跑个测试顺手杀了别人家的进程」。
 */
function fakeTeardown(calls = []) {
  return Object.assign(
    (child, deps) => {
      child?.kill?.();
      calls.push({ pid: child?.pid, ...deps });
      return Promise.resolve({ exited: true, via: "fake" });
    },
    { calls },
  );
}

/** 测试工厂：默认假平台 + 假回收，个别用例再覆盖。 */
function makeBridge(deps = {}) {
  const teardown = deps.teardown ?? fakeTeardown();
  return createStdioBridge({ isWindows: true, teardown, ...deps });
}

test("编码/切分：换行分隔，半包留到下一次", () => {
  assert.equal(encodeMessage({ a: 1 }), '{"a":1}\n');
  const first = extractMessages('{"id":1,"result":{}}\n{"id":2,');
  assert.equal(first.messages.length, 1);
  assert.equal(first.rest, '{"id":2,');
  const second = extractMessages(first.rest + '"result":{}}\n');
  assert.deepEqual(second.messages, [{ id: 2, result: {} }]);
  assert.equal(second.rest, "");
});

test("切分：非 JSON 行（误写日志）被忽略，不影响后续消息", () => {
  const { messages } = extractMessages('hello\n{"id":3,"result":{"ok":1}}\n');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, 3);
});

test("命令/参数校验：空白、换行、超长一律拒绝", () => {
  assert.equal(isValidCommand("npx"), true);
  assert.equal(isValidCommand("  "), false);
  assert.equal(isValidCommand("npx\nrm -rf /"), false);
  assert.equal(isValidCommand("x".repeat(600)), false);
  assert.equal(isValidArgs(undefined), true);
  assert.equal(isValidArgs(["-y", "pkg"]), true);
  assert.equal(isValidArgs([1]), false);
  assert.equal(isValidArgs("nope"), false);
});

test("请求→响应配对：写入一行 JSON-RPC，按 id 解析结果", async () => {
  const { child, writes } = fakeChild();
  const bridge = makeBridge({ spawn: () => child, timeoutMs: 200 });

  const pending = bridge.request("s1", { command: "npx" }, "tools/list", {});
  const sent = JSON.parse(writes[0].trim());
  assert.equal(sent.jsonrpc, "2.0");
  assert.equal(sent.method, "tools/list");
  assert.equal(sent.id, 1);

  reply(child, { jsonrpc: "2.0", id: 1, result: { tools: [{ name: "echo" }] } });
  assert.deepEqual(await pending, { tools: [{ name: "echo" }] });

  // 同一 serverId 复用进程，id 递增
  const second = bridge.request("s1", { command: "npx" }, "tools/call", { name: "echo" });
  assert.equal(JSON.parse(writes[1].trim()).id, 2);
  reply(child, { jsonrpc: "2.0", id: 2, result: { content: [] } });
  await second;
});

test("通知（无 id）不会错配给挂起的请求", async () => {
  const { child } = fakeChild();
  const bridge = makeBridge({ spawn: () => child, timeoutMs: 200 });
  const pending = bridge.request("s1", { command: "x" }, "tools/list", {});
  reply(child, { jsonrpc: "2.0", method: "notifications/message", params: { level: "info" } });
  reply(child, { jsonrpc: "2.0", id: 1, result: { ok: true } });
  assert.deepEqual(await pending, { ok: true });
});

test("错误响应 → 拒绝并带 code；进程退出 → 挂起请求全部失败", async () => {
  const { child } = fakeChild();
  const bridge = makeBridge({ spawn: () => child, timeoutMs: 200 });

  const failed = bridge.request("s1", { command: "x" }, "tools/list", {});
  reply(child, { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "没有这个方法" } });
  await assert.rejects(failed, /没有这个方法/);

  const hanging = bridge.request("s1", { command: "x" }, "tools/call", {});
  child.emit("exit", 1, null);
  await assert.rejects(hanging, /进程已退出/);
  assert.equal(bridge.running().includes("s1"), false);
});

test("超时可配：配置值夹到 [2s, 600s]，非法值回落缺省", () => {
  assert.equal(clampTimeout(undefined, 30_000), 30_000);
  assert.equal(clampTimeout(120_000, 30_000), 120_000);
  assert.equal(clampTimeout(1, 30_000), 2_000);
  assert.equal(clampTimeout(999_999_999, 30_000), 600_000);
  assert.equal(clampTimeout(Number.NaN, 30_000), 30_000);
  assert.equal(clampTimeout(-5, 30_000), 30_000);
});

test("超时会发 notifications/cancelled，并在文案里说明子进程可能仍在跑", async () => {
  const { child, writes } = fakeChild();
  const bridge = makeBridge({ spawn: () => child, timeoutMs: 40 });

  await assert.rejects(
    bridge.request("s1", { command: "x" }, "tools/call", { name: "slow" }),
    /超时.*已通知服务端取消.*可能仍在执行/,
  );
  const cancelled = writes
    .map((line) => JSON.parse(line.trim()))
    .find((msg) => msg.method === "notifications/cancelled");
  assert.ok(cancelled, "应当发出取消通知");
  assert.equal(cancelled.params.requestId, 1);
  assert.match(cancelled.params.reason, /超时/);
});

test("服务端发起的请求会被明确拒绝（-32601），ping 回空结果；通知不回应", async () => {
  const { child, writes } = fakeChild();
  const bridge = makeBridge({ spawn: () => child, timeoutMs: 200 });

  const pending = bridge.request("s1", { command: "x" }, "tools/list", {});
  // 服务端反过来请求我们（id 空间与客户端独立，容易错配）
  reply(child, { jsonrpc: "2.0", id: 7, method: "roots/list" });
  reply(child, { jsonrpc: "2.0", id: 8, method: "ping" });
  reply(child, { jsonrpc: "2.0", method: "notifications/message", params: { level: "info" } });
  reply(child, { jsonrpc: "2.0", id: 1, result: { tools: [] } });

  assert.deepEqual(await pending, { tools: [] });

  const sent = writes.map((line) => JSON.parse(line.trim()));
  const rejected = sent.find((msg) => msg.id === 7);
  assert.equal(rejected.error.code, -32601);
  assert.match(rejected.error.message, /roots\/list/);
  const pong = sent.find((msg) => msg.id === 8);
  assert.deepEqual(pong.result, {});
  // 服务端通知没有 id：不应产生任何回应（写出去的一共只有 1 条请求 + 2 条回应）
  assert.equal(sent.length, 3);
});

test("超时 → 拒绝；stop → 关 stdin 并回收整棵进程树", async () => {
  const { child } = fakeChild();
  const bridge = makeBridge({ spawn: () => child, timeoutMs: 30 });
  await assert.rejects(bridge.request("s1", { command: "x" }, "tools/list", {}), /超时/);

  const second = fakeChild();
  const bridge2 = makeBridge({ spawn: () => second.child, timeoutMs: 200 });
  const p = bridge2.request("s2", { command: "x" }, "tools/list", {});
  assert.equal(bridge2.stop("s2"), true);
  assert.equal(second.child.killedByUs, true);
  assert.equal(second.child.stdin.ended, true, "stdio 传输的礼貌关闭就是关 stdin：服务自己退时会带走孙子");
  await assert.rejects(p, /已被停止/);
  assert.deepEqual(bridge2.running(), []);
});

test("非法命令直接抛错，不 spawn", () => {
  let spawned = 0;
  const bridge = makeBridge({
    spawn: () => {
      spawned++;
      return fakeChild().child;
    },
  });
  assert.throws(() => bridge.request("s1", { command: "" }, "tools/list", {}), /命令不合法/);
  assert.equal(spawned, 0);
});

test("notify 只写一行、不建 pending", () => {
  const { child, writes } = fakeChild();
  const bridge = makeBridge({ spawn: () => child });
  bridge.notify("s1", { command: "x" }, "notifications/initialized");
  const sent = JSON.parse(writes[0].trim());
  assert.equal(sent.method, "notifications/initialized");
  assert.equal(sent.id, undefined);
});

test("disposeAll 停掉全部服务", async () => {
  const kids = [];
  const bridge = makeBridge({
    spawn: () => {
      const f = fakeChild();
      kids.push(f.child);
      return f.child;
    },
  });
  bridge.request("a", { command: "x" }, "tools/list", {}).catch(() => {});
  bridge.request("b", { command: "y" }, "tools/list", {}).catch(() => {});
  await bridge.disposeAll();
  assert.equal(kids.length, 2);
  assert.ok(kids.every((k) => k.killedByUs));
  assert.ok(kids.every((k) => k.stdin.ended));
  assert.deepEqual(bridge.running(), []);
});

// —————————————————————— 进程树回收（d.50）——————————————————————

test("spawn 参数按平台加 detached：MCP 的孙子进程（npx→node→Chromium）要靠整组信号收", () => {
  // timeoutMs 给小值：这里的请求永远不会 stop，缺省 30s 超时定时器会把测试进程拖住
  const spawnOn = (isWindows) => {
    const opts = [];
    const bridge = makeBridge({
      isWindows,
      timeoutMs: 20,
      spawn: (_command, _args, options) => {
        opts.push(options);
        return fakeChild().child;
      },
    });
    bridge.request("s", { command: "x" }, "tools/list", {}).catch(() => {});
    return opts[0];
  };
  const win = spawnOn(true);
  assert.equal(win.detached, undefined, "Windows 没有进程组，detached 只会让子进程更难收口");
  assert.equal(win.shell, false);
  assert.equal(win.windowsHide, true);

  const posix = spawnOn(false);
  assert.equal(posix.detached, true, "自成进程组是 kill(-pid) 的前提");
  assert.equal(posix.shell, false);
});

test("stop 交出的不是 kill 而是回收：整棵树一并交给 child-kill", () => {
  const handle = fakeChild();
  const teardown = fakeTeardown();
  const bridge = makeBridge({ spawn: () => handle.child, teardown, isWindows: false });
  bridge.request("s", { command: "x" }, "tools/list", {}).catch(() => {});
  bridge.stop("s");
  assert.deepEqual(teardown.calls, [
    { pid: handle.child.pid, graceMs: 1_500, isWindows: false },
  ]);
});

test("回收没确认成功要写日志，不能当已经回收", async () => {
  const lines = [];
  const handle = fakeChild();
  const bridge = makeBridge({
    log: (line) => lines.push(line),
    spawn: () => handle.child,
    teardown: () => Promise.resolve({ exited: false, via: "force-group" }),
  });
  bridge.request("s", { command: "x" }, "tools/list", {}).catch(() => {});
  bridge.stop("s");
  await bridge.disposeAll();
  assert.match(lines.join("\n"), /回收未确认/);
});

test("disposeAll 必等在途回收：刚点过停止就关应用，也不能抢在杀干净之前返回", async () => {
  let resolveTeardown;
  const gate = new Promise((r) => {
    resolveTeardown = r;
  });
  const handle = fakeChild();
  const bridge = makeBridge({
    spawn: () => handle.child,
    teardown: () => gate.then(() => ({ exited: true, via: "fake" })),
  });
  bridge.request("s", { command: "x" }, "tools/list", {}).catch(() => {});
  bridge.stop("s");
  let done = false;
  const disposing = bridge.disposeAll().then(() => {
    done = true;
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(done, false, "回收没跑完就返回 ⇒ Electron 会在杀进程之前退出，孤儿照旧");
  resolveTeardown();
  await disposing;
  assert.equal(done, true);
});

test("idle：只有「没活进程且没在途回收」才允许退出流程不拦", async () => {
  let resolveTeardown;
  const gate = new Promise((r) => {
    resolveTeardown = r;
  });
  const bridge = makeBridge({
    spawn: () => fakeChild().child,
    teardown: () => gate.then(() => ({ exited: true, via: "fake" })),
  });
  assert.equal(bridge.idle(), true);
  bridge.request("s", { command: "x" }, "tools/list", {}).catch(() => {});
  assert.equal(bridge.idle(), false, "服务在跑");
  bridge.stop("s");
  await new Promise((r) => setImmediate(r));
  assert.equal(bridge.idle(), false, "进程没了但回收还在途——这时退出照样要等");
  resolveTeardown();
  await bridge.disposeAll();
  assert.equal(bridge.idle(), true);
});

/* ================================================================== planSpawn（本机运行时翻译） */

test("planSpawn · spawn 收到翻译后的命令与参数，且仍然 shell:false", () => {
  const calls = [];
  const { child } = fakeChild();
  const bridge = makeBridge({
    spawn: (command, args, opts) => {
      calls.push({ command, args, opts });
      return child;
    },
    planSpawn: ({ command, args }) =>
      command === "npx"
        ? { command: path.join("C:", "nodejs", "node.exe"), args: [path.join("C:", "nodejs", "npx-cli.js"), ...args] }
        : { command, args },
  });
  bridge.request("s1", { command: "npx", args: ["-y", "pkg"] }, "tools/list", {}).catch(() => {});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, path.join("C:", "nodejs", "node.exe"));
  assert.deepEqual(calls[0].args, [path.join("C:", "nodejs", "npx-cli.js"), "-y", "pkg"]);
  assert.equal(calls[0].opts.shell, false);
});

test("planSpawn · 拿到的是补全过的 PATH（否则探测结果与启动环境会自相矛盾）", () => {
  const calls = [];
  const { child } = fakeChild();
  const bridge = makeBridge({
    spawn: () => child,
    planSpawn: (plan) => {
      calls.push(plan);
      return { command: plan.command, args: plan.args };
    },
  });
  bridge.request("s1", { command: "x" }, "tools/list", {}).catch(() => {});
  assert.equal(calls.length, 1);
  const pathKey = Object.keys(calls[0].env).find((k) => k.toLowerCase() === "path");
  assert.equal(typeof calls[0].env[pathKey], "string");
  assert.ok(calls[0].env[pathKey].length > 0);
  assert.deepEqual(calls[0].args, []);
});

test("planSpawn 抛错（本机缺运行时）→ 不 spawn，文案原样冒泡", () => {
  let spawned = 0;
  const bridge = makeBridge({
    spawn: () => {
      spawned++;
      return fakeChild().child;
    },
    planSpawn: () => {
      throw new Error("本机未找到 uv/uvx（pypi 包需要 uv），无法运行该服务");
    },
  });
  assert.throws(() => bridge.request("s1", { command: "uvx" }, "tools/list", {}), /本机未找到 uv\/uvx/);
  assert.equal(spawned, 0);
  assert.deepEqual(bridge.running(), []);
});

test("planSpawn 返回非法命令时仍然被拦住（不因翻译绕过校验）", () => {
  let spawned = 0;
  const bridge = makeBridge({
    spawn: () => {
      spawned++;
      return fakeChild().child;
    },
    planSpawn: () => ({ command: "bad\ncmd", args: [] }),
  });
  assert.throws(() => bridge.request("s1", { command: "npx" }, "tools/list", {}), /命令不合法/);
  assert.equal(spawned, 0);
});

/* ================================================================== resolveExecutable */

/**
 * 命令名解析的四个分支。
 *
 * 存在这个函数的理由（实测，Node v22.22.2，`shell:false`）：
 *   spawn("npx")     → ENOENT
 *   spawn("npx.cmd") → EINVAL（Node >=18.20.2 对 .cmd/.bat 直接拒绝，CVE-2024-27980）
 *   spawn("uvx")     → OK（uvx 是 .exe，Node 自己补 PATHEXT）
 * 所以命令得先解析出**真实文件名**，否则根本谈不上执行。
 *
 * `existsFn` 可注入，所以这些用例不碰真实文件系统。
 */
test("resolveExecutable · 只有原名存在时用它（Linux 场景兜底）", () => {
  const exists = (p) => p === path.join("C:////bin", "uvx");
  assert.equal(resolveExecutable("uvx", ["C:////bin"], exists), "uvx");
});

test("resolveExecutable · 只有 .exe 时返回 .exe", () => {
  const exists = (p) => p === path.join("C:////bin", "uvx.exe");
  assert.equal(resolveExecutable("uvx", ["C:////bin"], exists), "uvx.exe");
});

test("resolveExecutable · ★ .exe 与原名都在时优先 .exe（原名放最后）", () => {
  // 实测：npx（无扩展名）是 2073 字节的 shell 脚本，Windows 跑不了；
  // 原名优先会选中那个跑不了的脚本。所以 .exe/.cmd 必须排在原名之前。
  const both = (p) => p === path.join("C:////bin", "npx") || p === path.join("C:////bin", "npx.cmd");
  assert.equal(resolveExecutable("npx", ["C:////bin"], both), "npx.cmd");
});

test("resolveExecutable · 只有 .cmd 时返回 .cmd（npx 的真实情况）", () => {
  const exists = (p) => p === path.join("C:////npm", "npx.cmd");
  assert.equal(resolveExecutable("npx", ["C:////npm"], exists), "npx.cmd");
});

test("resolveExecutable · .exe 优先于 .cmd", () => {
  const both = (p) => p === path.join("C:////bin", "x.exe") || p === path.join("C:////bin", "x.cmd");
  assert.equal(resolveExecutable("x", ["C:////bin"], both), "x.exe");
});

test("resolveExecutable · ★ 候选顺序是 .exe -> .cmd -> .bat -> 原名（原名最后）", () => {
  const seen = [];
  resolveExecutable("npx", ["C:////bin"], (p) => {
    seen.push(path.basename(p));
    return false;
  });
  assert.deepEqual(seen, ["npx.exe", "npx.cmd", "npx.bat", "npx"]);
});

test("resolveExecutable · 找不到时返回 null（调用方据此提示「需要安装 Node.js」）", () => {
  assert.equal(resolveExecutable("npx", ["C:////bin"], () => false), null);
  assert.equal(resolveExecutable("npx", [], () => false), null);
});

test("resolveExecutable · 按目录顺序找（先命中的目录胜出）", () => {
  const exists = (p) => p === path.join("C:////second", "npx.cmd");
  assert.equal(resolveExecutable("npx", ["C:////first", "C:////second"], exists), "npx.cmd");
});

test("resolveExecutable · 跳过空目录项（不因 undefined 崩）", () => {
  const exists = (p) => p === path.join("C:////bin", "npx.cmd");
  assert.equal(resolveExecutable("npx", [null, undefined, "", "C:////bin"], exists), "npx.cmd");
});

test("resolveExecutable · 单个探测抛错不影响其它目录", () => {
  let calls = 0;
  const flaky = (p) => {
    calls += 1;
    if (calls <= 4) throw new Error("EPERM");       // 第一目录的四个候选都失败
    return p === path.join("C:////bin", "npx.cmd");
  };
  assert.equal(resolveExecutable("npx", ["C:////a", "C:////bin"], flaky), "npx.cmd");
});

test("resolveExecutable · 命令为空或非字符串时返回 null", () => {
  assert.equal(resolveExecutable("", ["C:////bin"], () => true), null);
  assert.equal(resolveExecutable(null, ["C:////bin"], () => true), null);
  assert.equal(resolveExecutable(123, ["C:////bin"], () => true), null);
});

test("resolveExecutable · 不带 existsFn 时走真实文件系统（不抛）", () => {
  const r = resolveExecutable("definitely-not-a-real-cmd-xyz", ["C:////nope"]);
  assert.ok(r === null || typeof r === "string");
});

/* ================================================================== resolveExecutablePath */

test("resolveExecutablePath · 返回命中目录下的绝对路径（spawn 只认绝对路径）", () => {
  const exists = (p) => p === path.join("C:////bin", "uvx.exe");
  assert.equal(resolveExecutablePath("uvx", ["C:////bin"], exists), path.join("C:////bin", "uvx.exe"));
});

test("resolveExecutablePath · 候选顺序与 resolveExecutable 一致（.exe -> .cmd -> .bat -> 原名）", () => {
  const seen = [];
  resolveExecutablePath("npx", ["C:////bin"], (p) => {
    seen.push(path.basename(p));
    return false;
  });
  assert.deepEqual(seen, ["npx.exe", "npx.cmd", "npx.bat", "npx"]);
});

test("resolveExecutablePath · 找不到 / 命令非法时返回 null", () => {
  assert.equal(resolveExecutablePath("npx", ["C:////bin"], () => false), null);
  assert.equal(resolveExecutablePath("", ["C:////bin"], () => true), null);
  assert.equal(resolveExecutablePath(undefined, ["C:////bin"], () => true), null);
});

test("resolveExecutable · 与 resolveExecutablePath 只差一层 basename（不会漂移）", () => {
  const exists = (p) => p === path.join("C:////bin", "npx.cmd");
  assert.equal(
    resolveExecutable("npx", ["C:////bin"], exists),
    path.basename(resolveExecutablePath("npx", ["C:////bin"], exists)),
  );
});
