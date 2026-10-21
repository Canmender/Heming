"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { findNpmCli, pathEntriesOf, planStdioSpawn, probeLocalRuntime } = require("./local-runtime");

/** 用 path.join 造路径，保证断言与被测实现用同一套分隔符（Windows/Linux 都能跑）。 */
const P = (...parts) => path.join(...parts);
const PATHS = (...parts) => parts.join(path.delimiter);

function makeExists(files) {
  const set = new Set(files.map((p) => path.normalize(p)));
  return (p) => {
    try {
      return set.has(path.normalize(p));
    } catch {
      return false;
    }
  };
}

/* ================================================================== 纯工具 */

test("pathEntriesOf · 大小写不敏感地取 PATH，并丢掉空段", () => {
  assert.deepEqual(pathEntriesOf({ Path: PATHS(P("C:", "a"), "", P("C:", "b")) }), [P("C:", "a"), P("C:", "b")]);
});

test("pathEntriesOf · 没有 PATH 时返回空数组（不抛）", () => {
  assert.deepEqual(pathEntriesOf({}), []);
  assert.deepEqual(pathEntriesOf({ PATH: 123 }), []);
});

/* ================================================================== findNpmCli */

test("findNpmCli · 从 execPath 同目录找到官方安装的入口", () => {
  const file = P("C:", "Program Files", "nodejs", "node_modules", "npm", "bin", "npx-cli.js");
  const exists = makeExists([file]);
  assert.equal(findNpmCli([], P("C:", "Program Files", "nodejs", "node.exe"), exists), file);
});

test("findNpmCli · 全局前缀的 shim 目录（%APPDATA%\\npm）从上一级找", () => {
  const file = P("C:", "Users", "me", "AppData", "Roaming", "node_modules", "npm", "bin", "npx-cli.js");
  const exists = makeExists([file]);
  assert.equal(findNpmCli([P("C:", "Users", "me", "AppData", "Roaming", "npm")], "", exists), file);
});

test("findNpmCli · lib/node_modules 形态（Linux / nvm）", () => {
  const file = P("/opt", "node", "lib", "node_modules", "npm", "bin", "npx-cli.js");
  const exists = makeExists([file]);
  assert.equal(findNpmCli([P("/opt", "node", "bin")], P("/opt", "node", "bin", "node"), exists), file);
});

test("findNpmCli · 全都找不到时返回 null", () => {
  assert.equal(findNpmCli([P("C:", "nope")], P("C:", "nope", "node.exe"), () => false), null);
});

test("findNpmCli · 单个目录探测抛错不影响其它目录", () => {
  const file = P("C:", "good", "node_modules", "npm", "bin", "npx-cli.js");
  let calls = 0;
  const exists = (p) => {
    calls += 1;
    if (p.includes("bad")) throw new Error("EPERM");
    return p === file;
  };
  assert.equal(findNpmCli([P("C:", "bad"), P("C:", "good")], "", exists), file);
  assert.ok(calls > 0);
});

/* ================================================================== 探测 */

test("probeLocalRuntime · Windows 上必须同时有 node.exe 与 npx-cli.js 才算 npm 可用", () => {
  const dir = P("C:", "nodejs");
  const status = probeLocalRuntime({
    platform: "win32",
    execPath: P(dir, "electron.exe"),
    env: { PATH: PATHS(dir) },
    exists: makeExists([
      P(dir, "node.exe"),
      P(dir, "npx.cmd"), // ★ 只有 .cmd：不能直接 spawn，必须靠 npx-cli.js
      P("C:", "nodejs", "node_modules", "npm", "bin", "npx-cli.js"),
    ]),
  });
  assert.equal(status.npm, true);
  assert.equal(status.node, P(dir, "node.exe"));
  assert.equal(status.npx, P(dir, "npx.cmd"));
  assert.equal(status.pypi, false);
});

test("probeLocalRuntime · Windows 上只有 npx.cmd、没有 npx-cli.js → npm 不可用", () => {
  const dir = P("C:", "nodejs");
  const status = probeLocalRuntime({
    platform: "win32",
    execPath: "",
    env: { PATH: PATHS(dir) },
    exists: makeExists([P(dir, "npx.cmd")]),
  });
  assert.equal(status.npm, false);
  assert.match(status.note, /本机未安装：Node\.js（npx）/);
});

test("probeLocalRuntime · 类 Unix 上 PATH 里有 npx 即可", () => {
  const status = probeLocalRuntime({
    platform: "linux",
    execPath: P("/usr", "bin", "node"),
    env: { PATH: PATHS(P("/usr", "bin")) },
    exists: makeExists([P("/usr", "bin", "npx")]),
  });
  assert.equal(status.npm, true);
  assert.equal(status.npx, P("/usr", "bin", "npx"));
});

test("probeLocalRuntime · uv（而不是 uvx）也算 pypi 可用", () => {
  const dir = P("C:", "Users", "me", ".local", "bin");
  const status = probeLocalRuntime({
    platform: "win32",
    execPath: "",
    env: { PATH: PATHS(dir) },
    exists: makeExists([P(dir, "uv.exe")]),
  });
  assert.equal(status.pypi, true);
  assert.equal(status.uvx, P(dir, "uv.exe"));
});

test("probeLocalRuntime · 两样都缺时 note 一次说清", () => {
  const status = probeLocalRuntime({ platform: "win32", env: {}, exists: () => false });
  assert.equal(status.npm, false);
  assert.equal(status.pypi, false);
  assert.match(status.note, /Node\.js（npx）、uv（uvx）/);
});

test("probeLocalRuntime · 齐备时给正向文案", () => {
  const dir = P("C:", "nodejs");
  const status = probeLocalRuntime({
    platform: "win32",
    execPath: P(dir, "electron.exe"),
    env: { PATH: PATHS(dir) },
    exists: makeExists([
      P(dir, "node.exe"),
      P("C:", "nodejs", "node_modules", "npm", "bin", "npx-cli.js"),
      P(dir, "uvx.exe"),
    ]),
  });
  assert.equal(status.note, "本机运行时齐备，可安装本地包服务");
});

/* ================================================================== 启动方案 */

test("planStdioSpawn · Windows 的 npx 换成 node + npx-cli.js，参数原样后移", () => {
  const dir = P("C:", "nodejs");
  const cli = P(dir, "node_modules", "npm", "bin", "npx-cli.js");
  const plan = planStdioSpawn(
    { command: "npx", args: ["-y", "my-mcp@1.2.3"], env: { PATH: PATHS(dir) } },
    { platform: "win32", execPath: P(dir, "electron.exe"), exists: makeExists([P(dir, "node.exe"), cli]) },
  );
  assert.equal(plan.command, P(dir, "node.exe"));
  assert.deepEqual(plan.args, [cli, "-y", "my-mcp@1.2.3"]);
});

test("planStdioSpawn · ★ 翻译结果绝不是 .cmd/.bat（shell:false 下会 EINVAL）", () => {
  const dir = P("C:", "nodejs");
  const cli = P(dir, "node_modules", "npm", "bin", "npx-cli.js");
  const plan = planStdioSpawn(
    { command: "npx", args: [], env: { PATH: PATHS(dir) } },
    {
      platform: "win32",
      execPath: "",
      exists: makeExists([P(dir, "node.exe"), P(dir, "npx.cmd"), P(dir, "npx.bat"), cli]),
    },
  );
  assert.doesNotMatch(plan.command, /\.(cmd|bat)$/i);
});

test("planStdioSpawn · Windows 缺 node 或 npx-cli.js 时抛出可读文案", () => {
  const dir = P("C:", "nodejs");
  assert.throws(
    () =>
      planStdioSpawn(
        { command: "npx", args: ["-y", "pkg"], env: { PATH: PATHS(dir) } },
        { platform: "win32", execPath: "", exists: makeExists([P(dir, "npx.cmd")]) },
      ),
    /本机未找到可用的 Node\.js\/npm/,
  );
});

test("planStdioSpawn · uvx 解析到 uv 时补 `tool run`（uvx = uv tool run）", () => {
  const dir = P("C:", "Users", "me", ".local", "bin");
  const plan = planStdioSpawn(
    { command: "uvx", args: ["mcp-server-fetch"], env: { PATH: PATHS(dir) } },
    { platform: "win32", execPath: "", exists: makeExists([P(dir, "uv.exe")]) },
  );
  assert.equal(plan.command, P(dir, "uv.exe"));
  assert.deepEqual(plan.args, ["tool", "run", "mcp-server-fetch"]);
});

test("planStdioSpawn · uvx 存在时给绝对路径、参数不动", () => {
  const dir = P("C:", "Users", "me", ".local", "bin");
  const plan = planStdioSpawn(
    { command: "uvx", args: ["--from", "pkg", "srv"], env: { PATH: PATHS(dir) } },
    { platform: "win32", execPath: "", exists: makeExists([P(dir, "uvx.exe")]) },
  );
  assert.equal(plan.command, P(dir, "uvx.exe"));
  assert.deepEqual(plan.args, ["--from", "pkg", "srv"]);
});

test("planStdioSpawn · 本机没有 uv 时抛「需要 uv」", () => {
  assert.throws(
    () => planStdioSpawn({ command: "uvx", args: [], env: {} }, { platform: "win32", exists: () => false }),
    /本机未找到 uv\/uvx/,
  );
});

test("planStdioSpawn · 类 Unix 直接给 npx 的绝对路径", () => {
  const plan = planStdioSpawn(
    { command: "npx", args: ["-y", "pkg"], env: { PATH: PATHS(P("/usr", "bin")) } },
    { platform: "darwin", execPath: P("/usr", "bin", "node"), exists: makeExists([P("/usr", "bin", "npx")]) },
  );
  assert.equal(plan.command, P("/usr", "bin", "npx"));
  assert.deepEqual(plan.args, ["-y", "pkg"]);
});

test("planStdioSpawn · 其它命令原样返回（内置预置给的是包内绝对路径）", () => {
  const exe = P("D:", "Heming", "resources", "runtime", "mcp-env", "Scripts", "windows-mcp.exe");
  const plan = planStdioSpawn({ command: exe, args: ["serve"], env: {} }, { platform: "win32", exists: () => false });
  assert.deepEqual(plan, { command: exe, args: ["serve"] });
});

test("planStdioSpawn · 空命令 / 非数组参数不抛", () => {
  assert.deepEqual(planStdioSpawn({ command: "  ", env: {} }), { command: "", args: [] });
  assert.deepEqual(planStdioSpawn({}, { platform: "win32", exists: () => false }).command, "");
});
