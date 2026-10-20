"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const {
  createStdioBridge,
  encodeMessage,
  extractMessages,
  isValidCommand,
  isValidArgs,
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
