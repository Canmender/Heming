"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const {
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
    write: (chunk) => {
      writes.push(String(chunk));
      return true;
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
  const bridge = createStdioBridge({ spawn: () => child, timeoutMs: 200 });

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
  const bridge = createStdioBridge({ spawn: () => child, timeoutMs: 200 });
  const pending = bridge.request("s1", { command: "x" }, "tools/list", {});
  reply(child, { jsonrpc: "2.0", method: "notifications/message", params: { level: "info" } });
  reply(child, { jsonrpc: "2.0", id: 1, result: { ok: true } });
  assert.deepEqual(await pending, { ok: true });
});

test("错误响应 → 拒绝并带 code；进程退出 → 挂起请求全部失败", async () => {
  const { child } = fakeChild();
  const bridge = createStdioBridge({ spawn: () => child, timeoutMs: 200 });

  const failed = bridge.request("s1", { command: "x" }, "tools/list", {});
  reply(child, { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "没有这个方法" } });
  await assert.rejects(failed, /没有这个方法/);

  const hanging = bridge.request("s1", { command: "x" }, "tools/call", {});
  child.emit("exit", 1, null);
  await assert.rejects(hanging, /进程已退出/);
  assert.equal(bridge.running().includes("s1"), false);
});

test("超时 → 拒绝；stop → kill 并清理", async () => {
  const { child } = fakeChild();
  const bridge = createStdioBridge({ spawn: () => child, timeoutMs: 30 });
  await assert.rejects(bridge.request("s1", { command: "x" }, "tools/list", {}), /超时/);

  const { child: c2 } = fakeChild();
  const bridge2 = createStdioBridge({ spawn: () => c2, timeoutMs: 200 });
  const p = bridge2.request("s2", { command: "x" }, "tools/list", {});
  assert.equal(bridge2.stop("s2"), true);
  assert.equal(c2.killedByUs, true);
  await assert.rejects(p, /已被停止/);
  assert.deepEqual(bridge2.running(), []);
});

test("非法命令直接抛错，不 spawn", () => {
  let spawned = 0;
  const bridge = createStdioBridge({
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
  const bridge = createStdioBridge({ spawn: () => child });
  bridge.notify("s1", { command: "x" }, "notifications/initialized");
  const sent = JSON.parse(writes[0].trim());
  assert.equal(sent.method, "notifications/initialized");
  assert.equal(sent.id, undefined);
});

test("disposeAll 停掉全部服务", () => {
  const kids = [];
  const bridge = createStdioBridge({
    spawn: () => {
      const f = fakeChild();
      kids.push(f.child);
      return f.child;
    },
  });
  bridge.request("a", { command: "x" }, "tools/list", {}).catch(() => {});
  bridge.request("b", { command: "y" }, "tools/list", {}).catch(() => {});
  bridge.disposeAll();
  assert.equal(kids.length, 2);
  assert.ok(kids.every((k) => k.killedByUs));
  assert.deepEqual(bridge.running(), []);
});

/* ================================================================== planSpawn（本机运行时翻译） */

test("planSpawn · spawn 收到翻译后的命令与参数，且仍然 shell:false", () => {
  const calls = [];
  const { child } = fakeChild();
  const bridge = createStdioBridge({
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
  const bridge = createStdioBridge({
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
  const bridge = createStdioBridge({
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
  const bridge = createStdioBridge({
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
