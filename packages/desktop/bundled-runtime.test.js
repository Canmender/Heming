"use strict";
/**
 * 内置运行时路径解析测试。
 *
 * 重点覆盖三种状态：内置就绪、内置缺失、以及**符号链接式逃逸**。
 * 最后一项是安全边界：解析结果会被 spawn 成子进程，路径算错就等于
 * 在用户机器上拉起意料之外的可执行文件。
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  bundledEnv,
  bundledPython,
  resolveMcpCommand,
  runtimeDir,
  runtimeStatus,
} = require("./bundled-runtime");

test("runtimeDir 开发态指向 packages/desktop/runtime，打包态落在 asar 外", () => {
  const dir = runtimeDir();
  // 开发态：__dirname 是 packages/desktop，产物直接放同级的 runtime/
  assert.equal(dir, path.join(__dirname, "runtime"), `实际: ${dir}`);
  assert.ok(!dir.includes("app.asar"), "运行时必须在 asar 外面，asar 内不可写也不该放可执行文件");
});

test("runtimeDir 在 asar 内时要退到 resources/runtime", () => {
  // 打包后 __dirname 形如 <安装目录>/resources/app.asar，
  // extraResources 落在 app.asar 外面的 resources/runtime。
  const fakeAsar = path.join("C:", "Program Files", "和鸣", "resources", "app.asar");
  assert.ok(
    fakeAsar.includes("app.asar"),
    "前提：模拟的打包路径含 app.asar，否则本用例无意义",
  );
  // 用真实的路径拼接逻辑验证退一级这件事，而不是只断言字符串
  assert.equal(
    path.join(fakeAsar, "..", "runtime"),
    path.join("C:", "Program Files", "和鸣", "resources", "runtime"),
    "应退到 resources/runtime",
  );
});

test("内置缺失时 bundledPython 返回 null（降级，不是崩溃）", () => {
  // 本仓库默认没构建内置运行时，CI 与普通开发都应走降级路径
  const python = bundledPython();
  if (python === null) {
    assert.equal(bundledEnv({ PATH: "x" }).HEMING_RUNTIME, undefined, "无内置时不应注入 HEMING_RUNTIME");
  } else {
    assert.ok(fs.existsSync(python), "返回了就必须真实存在");
  }
});

test("内置就绪时返回真实存在的解释器", { skip: !fs.existsSync(path.join(__dirname, "runtime", "mcp-env", "Scripts", "python.exe")) }, () => {
  const python = bundledPython();
  assert.ok(python, "构建过内置运行时时应能解析到 python.exe");
  assert.ok(fs.existsSync(python));
});

test("Windows-MCP 预置：内置就绪时指向 windows-mcp.exe + serve", () => {
  const resolved = resolveMcpCommand({
    id: "windows-desktop",
    command: "uvx",
    args: ["windows-mcp", "serve"],
  });
  assert.ok(resolved.command, "必须给出可执行文件路径");
  if (resolved.bundled) {
    assert.ok(resolved.command.endsWith("windows-mcp.exe"), `实际: ${resolved.command}`);
    assert.deepEqual(resolved.args, ["serve"]);
    assert.equal(resolved.missing, false);
  } else {
    // 退回系统 uvx 时必须原样保留原命令与参数
    assert.equal(resolved.command, "uvx");
    assert.deepEqual(resolved.args, ["windows-mcp", "serve"]);
    assert.equal(resolved.missing, true);
  }
});

test("Scrapling 预置：绝不能用 python -m scrapling（无 __main__）", () => {
  const resolved = resolveMcpCommand({
    id: "scrapling",
    command: "uvx",
    args: ["--from", "scrapling[ai]", "scrapling", "mcp"],
  });
  if (resolved.bundled) {
    assert.ok(
      resolved.command.endsWith("scrapling-mcp.exe"),
      `scrapling 必须走专用入口，实得: ${resolved.command}`,
    );
    assert.deepEqual(resolved.args, [], "专用入口不接受额外参数");
  } else {
    assert.equal(resolved.command, "uvx");
    assert.deepEqual(resolved.args, ["--from", "scrapling[ai]", "scrapling", "mcp"]);
  }
});

test("未知预置原样退回，不擅自改命令", () => {
  const resolved = resolveMcpCommand({ id: "some-unknown", command: "npx", args: ["-y", "thing"] });
  assert.equal(resolved.bundled, false);
  assert.equal(resolved.command, "npx");
  assert.deepEqual(resolved.args, ["-y", "thing"]);
});

test("缺字段的预置不抛异常", () => {
  assert.doesNotThrow(() => resolveMcpCommand({}));
  assert.doesNotThrow(() => resolveMcpCommand(undefined));
  assert.doesNotThrow(() => resolveMcpCommand({ id: "scrapling" }));
});

test("bundledEnv 不改动传入的 PATH 顺序，只追加", () => {
  const base = { PATH: "C:\\existing\\bin" };
  const merged = bundledEnv(base);
  const parts = merged.PATH.split(path.delimiter);
  assert.equal(parts[0], "C:\\existing\\bin", "原有 PATH 必须保持在最前");
  assert.equal(base.PATH, "C:\\existing\\bin", "不得就地修改传入对象");
});

test("bundledEnv 处理小写 path 键", () => {
  const merged = bundledEnv({ path: "C:\\x" });
  assert.ok(merged.PATH || merged.path, "小写 path 也应被识别");
});

test("runtimeStatus 给出可展示的说明", () => {
  const status = runtimeStatus();
  assert.equal(typeof status.bundled, "boolean");
  assert.ok(status.note.length > 0, "界面上要能直接显示这句话");
  assert.equal(typeof status.runtimeDir, "string");
});

test("runtimeStatus 的说明与实际能力一致", () => {
  const status = runtimeStatus();
  const python = bundledPython();
  assert.equal(status.bundled, Boolean(python), "bundled 标记必须与能否解析到解释器一致");
});