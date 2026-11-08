"use strict";
/** 模型页 ↔ 内核命令桥（d.99）：白名单、终端命令、运行/流式/输入/取消。 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const {
  validateCliArgs,
  needsTerminal,
  quoteForCmd,
  terminalCommand,
  createMagpieCli,
} = require("./magpie-cli");

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { destroyed: false, write: (text) => (child.written = text) };
  child.kill = () => child.emit("exit", null);
  return child;
}

test("白名单：管理命令放行，危险/无关命令拒绝", () => {
  for (const cmd of ["providers", "provider", "accounts", "groups", "usage", "backup", "webdav", "settings"]) {
    assert.equal(validateCliArgs([cmd]).ok, true, cmd);
  }
  for (const cmd of ["uninstall", "serve", "tui", "web", "autostart", "rm-shell"]) {
    assert.equal(validateCliArgs([cmd]).ok, false, cmd);
  }
  assert.equal(validateCliArgs([]).ok, false);
  assert.equal(validateCliArgs(["provider", "a\0b"]).ok, false);
  assert.equal(validateCliArgs([123]).ok, false);
});

test("智能体命令：只允许查看/设模型/恢复默认，字段编辑与怪参数被拒", () => {
  assert.equal(validateCliArgs(["claude"]).ok, true);
  assert.equal(validateCliArgs(["claude", "deepseek/deepseek-chat"]).ok, true);
  assert.equal(validateCliArgs(["codex", "default"]).ok, true);
  assert.equal(validateCliArgs(["claude", "effort", "high"]).ok, false);
  assert.equal(validateCliArgs(["claude", "model; rm -rf"]).ok, false);
  assert.equal(validateCliArgs(["claude", "--help"]).ok, false);
});

test("网关密钥与会话命令放行", () => {
  assert.equal(validateCliArgs(["gateway-key", "list"]).ok, true);
  assert.equal(validateCliArgs(["sessions", "--limit", "5"]).ok, true);
});

test("交互式命令走真终端（账号登录/备份口令）", () => {
  assert.equal(needsTerminal(["accounts", "add", "claude"]), true);
  assert.equal(needsTerminal(["accounts"]), false);
  assert.equal(needsTerminal(["provider", "add", "deepseek", "sk-x"]), false);
  assert.equal(needsTerminal(["backup"]), true);
  assert.equal(needsTerminal(["restore", "a.backup"]), true);
});

test("终端命令：含空格加引号，含壳字符直接拒绝", () => {
  assert.equal(quoteForCmd(["a", "b c"]).join(" "), "a \"b c\"");
  assert.throws(() => quoteForCmd(["a&calc"]), /不安全字符/);
  assert.equal(terminalCommand("C:/x/magpie core.exe", ["accounts", "add", "claude"]), '"C:/x/magpie core.exe" accounts add claude');
});

test("run：收集 stdout/stderr 并逐块发事件，退出码 0 即成功", async () => {
  const child = fakeChild();
  const events = [];
  const cli = createMagpieCli({
    spawn: () => child,
    binaryPath: "magpie-core.exe",
    send: (event) => events.push(event),
  });
  const pending = cli.run(["providers"]);
  child.stdout.emit("data", "mock custom\n");
  child.stderr.emit("data", "warn\n");
  child.emit("exit", 0);
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.stdout, "mock custom\n");
  assert.equal(result.stderr, "warn\n");
  assert.deepEqual(
    events.filter((e) => e.type === "stdout").map((e) => e.text),
    ["mock custom\n"],
  );
  assert.equal(events[0].type, "start");
});

test("run：白名单外直接拒绝，不启动进程", async () => {
  let spawned = 0;
  const cli = createMagpieCli({ spawn: () => (spawned++, fakeChild()), binaryPath: "x", send: () => {} });
  const result = await cli.run(["uninstall"]);
  assert.equal(result.ok, false);
  assert.match(result.error, /不允许的命令/);
  assert.equal(spawned, 0);
});

test("run：超时会取消并给出原因", async () => {
  const child = fakeChild();
  child.kill = () => {};
  const cli = createMagpieCli({ spawn: () => child, binaryPath: "x", send: () => {}, timeoutMs: 20 });
  const result = await cli.run(["usage"]);
  assert.equal(result.ok, false);
  assert.match(result.error, /超时/);
});

test("start/input/kill：交互命令可写入 stdin 并可取消", async () => {
  const child = fakeChild();
  const cli = createMagpieCli({ spawn: () => child, binaryPath: "x", send: () => {} });
  const pending = cli.start(["accounts", "add", "claude"]);
  const [runId] = cli.activeRuns();
  assert.ok(runId);
  cli.input(runId, "123456\n");
  assert.equal(child.written, "123456\n");
  assert.equal(cli.kill(runId), true);
  const result = await pending;
  assert.equal(result.ok, false); // kill 后 exit code 为 null
  assert.equal(cli.activeRuns().length, 0);
});
