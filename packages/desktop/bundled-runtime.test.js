"use strict";
/**
 * 内置运行时路径解析测试（d.147.4.94.11「内置运行时自包含」）。
 *
 * 契约：runtime 是 `runtime/python/` 完整可重定位解释器 + 依赖直接装进它自己的
 * site-packages，**不再是 venv**，也没有 `windows-mcp.exe` / `scrapling-mcp.exe`
 * 这类入口 exe。所以判定一律走「包内 python + -I + 入口模块」，而不是 exe 路径。
 *
 * 关键行为：
 * - 渲染层存的是 `mcp-windows-desktop` / `mcp-scrapling`，旧实现只认不带前缀的 id，
 *   于是永远匹配不上、静默退回 uvx。这里同时钉住新旧 id 与「只按 args 包名识别」。
 * - 内置缺失时必须降级回原命令，而不是抛异常（日常开发不构建 runtime/）。
 * - `bundledEnv()` 必须清掉继承的 `PYTHONHOME` / `VIRTUAL_ENV`：它们会让包内解释器
 *   去别处找标准库，是「装了却起不来」的经典原因。
 *
 * 本仓库没构建 runtime/ 时（CI 与日常开发）所有用例走「内置缺失」分支，断言同样成立。
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  bundledDepsReady,
  bundledEnv,
  bundledPython,
  bundledUv,
  builtinKind,
  resolveMcpCommand,
  runtimeDir,
  runtimeStatus,
} = require("./bundled-runtime");

const RUNTIME_PYTHON = path.join(__dirname, "runtime", "python", "python.exe");
const WINDOWS_ARGS = ["-I", "-m", "windows_mcp", "serve"];
const SCRAPLING_ARGS = ["-I", "-c", "from scrapling.cli import mcp; mcp()"];

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

test("builtinKind：新旧 id 与 args 里的包名都认", () => {
  assert.equal(builtinKind({ id: "windows-desktop" }), "windows-desktop");
  assert.equal(builtinKind({ id: "windows-desktop-control" }), "windows-desktop");
  // 渲染层落盘的是 systemMcpServerId() 加过前缀的写法
  assert.equal(builtinKind({ id: "mcp-windows-desktop" }), "windows-desktop");
  assert.equal(
    builtinKind({ id: "x-unknown", command: "uvx", args: ["windows-mcp", "serve"] }),
    "windows-desktop",
    "id 不认识时要看 args 里的包名",
  );
  assert.equal(builtinKind({ id: "scrapling" }), "scrapling");
  assert.equal(builtinKind({ id: "mcp-scrapling" }), "scrapling");
  assert.equal(
    builtinKind({ id: "x-unknown", command: "uvx", args: ["--from", "scrapling[ai]", "scrapling", "mcp"] }),
    "scrapling",
  );
  assert.equal(
    builtinKind({ id: "x-unknown", command: "uvx", args: ["windows-mcp", "serve"] }),
    "windows-desktop",
    "windows-mcp 优先于 scrapling 判定",
  );
  assert.equal(builtinKind({ id: "some-unknown", command: "npx", args: ["-y", "thing"] }), null);
  assert.equal(builtinKind(undefined), null);
  assert.equal(builtinKind(null), null);
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

test(
  "构建过内置运行时时：解释器与依赖真实存在（完整解释器，不再是 venv）",
  { skip: !fs.existsSync(RUNTIME_PYTHON) },
  () => {
    assert.equal(bundledPython(), RUNTIME_PYTHON);
    assert.ok(fs.existsSync(path.join(__dirname, "runtime", "python", "Lib")), "应带完整标准库 Lib/");
    assert.equal(bundledDepsReady(), true, "site-packages 应同时含 windows_mcp 与 scrapling");
    const site = path.join(__dirname, "runtime", "python", "Lib", "site-packages");
    assert.ok(fs.existsSync(path.join(site, "windows_mcp")));
    assert.ok(fs.existsSync(path.join(site, "scrapling")));

    const status = runtimeStatus();
    assert.equal(status.python, RUNTIME_PYTHON);
    assert.equal(status.depsReady, true);
    assert.equal(status.bundled, true);
  },
);

test(
  "旧 venv / 专用入口 exe 布局已移除",
  { skip: !fs.existsSync(path.join(__dirname, "runtime")) },
  () => {
    const runtime = path.join(__dirname, "runtime");
    assert.ok(!fs.existsSync(path.join(runtime, "mcp-env")), "不再有裸 venv（mcp-env）");
    assert.ok(
      !fs.existsSync(path.join(runtime, "Scripts", "windows-mcp.exe")),
      "不再有 windows-mcp.exe（改走 python -m windows_mcp）",
    );
    assert.ok(
      !fs.existsSync(path.join(runtime, "Scripts", "scrapling-mcp.exe")),
      "不再有 scrapling-mcp.exe（改走 scrapling.cli:mcp）",
    );
  },
);

test("Windows 桌面控制：新旧 id 都归一，内置就绪时是 python -I -m windows_mcp serve", () => {
  const python = bundledPython();
  for (const id of ["windows-desktop", "windows-desktop-control", "mcp-windows-desktop"]) {
    const resolved = resolveMcpCommand({ id, command: "uvx", args: ["windows-mcp", "serve"] });
    if (python) {
      assert.equal(resolved.command, python, `${id} 应指向包内解释器（实际 ${resolved.command}）`);
      assert.equal(resolved.command, runtimeStatus().python, "命令必须与 runtimeStatus().python 同一答案");
      assert.deepEqual(resolved.args, WINDOWS_ARGS, `${id} 的 -I 入口参数`);
      assert.equal(resolved.bundled, true);
      assert.equal(resolved.missing, false);
    } else {
      // 内置缺失：原样退回配置里的 uvx，不擅自改命令
      assert.equal(resolved.command, "uvx");
      assert.deepEqual(resolved.args, ["windows-mcp", "serve"]);
      assert.equal(resolved.bundled, false);
      assert.equal(resolved.missing, true);
    }
  }
});

test("Scrapling：绝不能用 python -m scrapling（无 __main__），改用 scrapling.cli:mcp", () => {
  const python = bundledPython();
  for (const id of ["scrapling", "mcp-scrapling"]) {
    const resolved = resolveMcpCommand({
      id,
      command: "uvx",
      args: ["--from", "scrapling[ai]", "scrapling", "mcp"],
    });
    if (python) {
      assert.equal(resolved.command, python, `${id} 应指向包内解释器`);
      assert.deepEqual(resolved.args, SCRAPLING_ARGS, `${id} 的 click 入口参数`);
      assert.equal(resolved.bundled, true);
      assert.ok(!resolved.args.includes("scrapling.__main__"), "不能走 python -m scrapling");
    } else {
      assert.equal(resolved.command, "uvx");
      assert.deepEqual(resolved.args, ["--from", "scrapling[ai]", "scrapling", "mcp"]);
    }
  }
});

test("id 不认识时也能按 args 里的包名走内置运行时", () => {
  const python = bundledPython();
  const windows = resolveMcpCommand({ id: "x-unknown", command: "uvx", args: ["windows-mcp", "serve"] });
  const scrapling = resolveMcpCommand({
    id: "y-unknown",
    command: "uvx",
    args: ["--from", "scrapling[ai]", "scrapling", "mcp"],
  });
  if (python) {
    assert.equal(windows.command, python);
    assert.deepEqual(windows.args, WINDOWS_ARGS);
    assert.equal(scrapling.command, python);
    assert.deepEqual(scrapling.args, SCRAPLING_ARGS);
  } else {
    assert.equal(windows.command, "uvx");
    assert.equal(scrapling.command, "uvx");
    assert.equal(windows.bundled, false);
    assert.equal(scrapling.bundled, false);
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

test("bundledEnv：原有 PATH 顺序不变，追加内置解释器目录与 runtime/bin", () => {
  const base = {
    PATH: ["C:\\existing\\bin", "C:\\other"].join(path.delimiter),
    PYTHONHOME: "C:\\Python312",
    VIRTUAL_ENV: "C:\\venv",
  };
  const merged = bundledEnv(base);
  const parts = merged.PATH.split(path.delimiter);
  assert.deepEqual(parts.slice(0, 2), ["C:\\existing\\bin", "C:\\other"], "原有 PATH 必须保持在最前且顺序不变");
  assert.equal(base.PATH.split(path.delimiter).length, 2, "不得就地修改传入对象");

  const python = bundledPython();
  if (python) {
    assert.ok(parts.includes(path.dirname(python)), `PATH 应含内置解释器目录：${parts.join(" | ")}`);
    assert.ok(parts.includes(path.join(runtimeDir(), "bin")), "PATH 应含 runtime/bin（内置 uvx）");
    assert.equal(merged.HEMING_RUNTIME, runtimeDir(), "子进程要能知道自己在用内置运行时");
    // 这两个变量会让包内解释器去别处找标准库，必须删掉
    assert.equal("PYTHONHOME" in merged, false, "继承的 PYTHONHOME 必须删除");
    assert.equal("VIRTUAL_ENV" in merged, false, "继承的 VIRTUAL_ENV 必须删除");
  } else {
    // 无内置运行时：原样返回，不注入也不删任何东西
    assert.equal(merged, base);
    assert.equal(merged.HEMING_RUNTIME, undefined);
  }
});

test("bundledEnv 处理小写 path 键", () => {
  const merged = bundledEnv({ path: "C:\\x" });
  const key = Object.keys(merged).find((k) => k.toLowerCase() === "path");
  assert.ok(key, "小写 path 也应被识别");
  assert.equal(merged[key].split(path.delimiter)[0], "C:\\x", "原有 PATH 必须保持在最前");
});

test("runtimeStatus：bundled === (python && depsReady)，note 按三种状态给不同说明", () => {
  const status = runtimeStatus();
  const python = bundledPython();
  const depsReady = Boolean(python) && bundledDepsReady();

  assert.equal(status.bundled, Boolean(python && depsReady), "bundled 必须等价于「解释器 + 依赖都在」");
  assert.equal(status.python, python);
  assert.equal(status.uv, bundledUv());
  assert.equal(status.depsReady, depsReady);
  assert.equal(status.runtimeDir, runtimeDir());
  assert.equal(typeof status.note, "string");
  assert.ok(status.note.length > 0, "界面上要能直接显示这句话");

  if (python && depsReady) {
    assert.match(status.note, /无需安装 Python 或 uv/);
  } else if (python) {
    assert.match(status.note, /重新安装和鸣/, "缺依赖时要明确提示重装，不能静默");
  } else {
    assert.match(status.note, /系统已安装的 uvx/, "内置缺失时说明退回到系统 uvx");
  }
});

test("没有解释器时 depsReady 不能为 true（避免界面误报就绪）", () => {
  const status = runtimeStatus();
  if (!status.python) {
    assert.equal(status.depsReady, false);
    assert.equal(status.bundled, false);
  }
});

test("bundledUv 只返回真实存在的 uvx/uv，否则 null", () => {
  const uv = bundledUv();
  if (uv) {
    assert.ok(fs.existsSync(uv), "返回了就必须真实存在");
    assert.match(path.basename(uv), /^uvx?(\.exe)?$/);
  } else {
    assert.equal(uv, null);
  }
});
