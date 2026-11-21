"use strict";
/**
 * 内置运行时路径解析（仅桌面端）。
 *
 * ## 为什么需要这个模块
 *
 * 和鸣只面向桌面安装版，且**内置全部运行环境**：用户装完就能用，不需要自己装
 * Python、uv 或任何 MCP 服务。实现方式是把这套东西打进安装包
 * （`resources/runtime/`），启动 MCP 时直接指向包内的解释器。
 *
 * ## 目录形态（d.147.4.94.11 起）
 *
 * ```
 * runtime/
 *   python/python.exe        python-build-standalone 的完整解释器（可重定位）
 *   python/Lib/site-packages windows-mcp / scrapling / mcp 等依赖直接装在这里
 *   bin/uv.exe  bin/uvx.exe  可选：给 Registry 的 pypi 包用，系统能力不需要
 * ```
 *
 * **不再有 venv**。旧版是「裸 venv + 指向构建机 uv 托管 Python 的 pyvenv.cfg」，
 * 只有 `Lib/site-packages`，没有标准库也没有 `python312.dll`——包搬上别的机器
 * 连 `import os` 都做不到。现在的形态整棵树可整体搬路径、换机器运行。
 *
 * ## 三种状态
 *
 * | 状态 | 指向 | 说明 |
 * |---|---|---|
 * | 内置就绪 | `runtime/python/python.exe -I …` | 用户装好即用，零外部依赖 |
 * | 内置缺依赖 | 同上（但导入会失败） | 界面要提示重装，不要静默 |
 * | 内置缺失 | 退回配置里的 `uvx` + PATH 补全 | 开发态没构建过运行时时不至于全挂 |
 *
 * 最后一行是刻意保留的退路：内置运行时构建要几分钟（拷解释器 + 装 100+ 个包），
 * 不可能塞进日常开发流程。没有它的话，改一行前端代码就会让 MCP 全挂。
 *
 * 路径解析集中在这里而不是散在各处：预置定义、stdio 子进程环境、界面提示
 * 都要用到同一个答案，写三份迟早漂移。
 */

const fs = require("node:fs");
const path = require("node:path");

/** 内置运行时在 `resources/` 下的目录名（与 electron-builder 的 extraResources 一致）。 */
const RUNTIME_DIR = "runtime";

/**
 * 解析 `resources/runtime` 的绝对路径。
 *
 * 开发态：`packages/desktop/runtime`（构建产物直接放这里，便于复用）
 * 打包后：`<安装目录>/resources/runtime`
 *
 * 两种形态都由本文件算出，调用方不必判断自己跑在哪。
 */
function runtimeDir() {
  // 打包后 __dirname 形如 `<安装目录>/resources/app.asar`，
  // 而 extraResources 落在 app.asar **外面**的 resources/runtime，
  // 所以要从 asar 目录再退一级到 resources。
  if (__dirname.includes("app.asar")) {
    return path.join(__dirname, "..", RUNTIME_DIR);
  }
  // 开发态：__dirname 就是 packages/desktop
  return path.join(__dirname, RUNTIME_DIR);
}

/** 是否存在（任何异常都按「不存在」处理：权限/路径异常不该让 MCP 区初始化失败）。 */
function exists(target) {
  try {
    return fs.existsSync(target);
  } catch {
    return false;
  }
}

/**
 * 内置解释器路径。
 *
 * 返回 null 表示内置运行时不可用——调用方据此退回 `uvx`，不要抛异常：
 * 「内置缺失」应该是降级，不是崩溃。
 */
function bundledPython() {
  const candidates = [
    path.join(runtimeDir(), "python", "python.exe"),
    path.join(runtimeDir(), "python", "python3.exe"),
    path.join(runtimeDir(), "python", "bin", "python3"),
  ];
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

/**
 * 内置 uv（可选）。
 *
 * 系统能力（Windows-MCP / Scrapling）用不到它——它们跑在包内解释器上。
 * 它是给 Registry 装来的 **pypi 本地包**用的：有它，用户机器上不用装 uv；
 * 没有它，那条路径会退回系统 `uvx`（探测不到就提示用户自己装）。
 */
function bundledUv() {
  const candidates = [path.join(runtimeDir(), "bin", "uvx.exe"), path.join(runtimeDir(), "bin", "uv")];
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

/** 内置依赖是否装好（site-packages 里两个入口包都在）。 */
function bundledDepsReady() {
  const site = path.join(runtimeDir(), "python", "Lib", "site-packages");
  return exists(path.join(site, "windows_mcp")) && exists(path.join(site, "scrapling"));
}

/**
 * 去重后共享的 Node 驱动路径（playwright 与 patchright 共用同一份 node.exe）。
 *
 * 这两个包各带一份 89.2MB 的 node.exe，SHA256 完全一致；构建期在**校验两者字节
 * 相同之后**删掉 patchright 那份，只留 playwright 的。两者的 `_impl/_driver.py`
 * 都读 `PLAYWRIGHT_NODEJS_PATH` 来决定用哪个 node.exe 启动 driver，所以把这个路径
 * 注入子进程环境后，patchright 会改用 playwright 那份字节相同的二进制——功能、
 * 行为、性能完全不变，只是磁盘上不再存两份相同的 89MB 文件。
 *
 * 只在「patchright 自己的 node.exe 已不存在、而 playwright 那份还在」时才返回
 * 路径——也就是去重**确实发生过**时才注入。这样：
 * - 已去重的运行时：patchright 被重定向到共享副本，正常工作；
 * - 未去重的老运行时：patchright 有自己的 node.exe，返回 null、不注入，行为
 *   与从前一字不差（即便将来两个包的 node.exe 版本不同也不会被错误替换）。
 */
function bundledNodeExecutable() {
  const site = path.join(runtimeDir(), "python", "Lib", "site-packages");
  const shared = path.join(site, "playwright", "driver", "node.exe");
  const patchrightNode = path.join(site, "patchright", "driver", "node.exe");
  // 去重确实发生过（patchright 副本已删）且共享副本存在，才需要重定向
  return !exists(patchrightNode) && exists(shared) ? shared : null;
}

/**
 * 把配置里的 id / 命令归一，判断它是不是我们的内置系统能力。
 *
 * 为什么不能只看 id：渲染层存下来的 id 是 `mcp-windows-desktop`、
 * `mcp-scrapling`（`systemMcpServerId()` 加的 `mcp-` 前缀），而最早那版实现
 * 只认 `windows-desktop` / `scrapling`，于是**一次都没匹配上**，永远退回 uvx。
 * 这里同时认两种写法，并且再看一眼原始命令里有没有对应包名，
 * 这样即使将来 id 规则又变，也不会静默退化成「要用户装 uv」。
 *
 * @returns {"windows-desktop"|"scrapling"|null}
 */
function builtinKind(spec) {
  const safe = spec && typeof spec === "object" ? spec : {};
  const id = String(safe.id ?? "").trim().toLowerCase().replace(/^mcp-/, "");
  const command = String(safe.command ?? "").toLowerCase();
  const args = Array.isArray(safe.args) ? safe.args.map((a) => String(a).toLowerCase()) : [];
  const haystack = [command, ...args].join(" ");

  if (id === "windows-desktop" || id === "windows-desktop-control" || haystack.includes("windows-mcp")) {
    return "windows-desktop";
  }
  if (id === "scrapling" || haystack.includes("scrapling")) return "scrapling";
  return null;
}

/**
 * 解析一个 MCP 服务的启动命令。
 *
 * @param {object} spec
 * @param {string} spec.id 服务 id（`mcp-windows-desktop` 或旧的 `windows-desktop`）
 * @param {string} spec.command 原本的启动命令（通常是 uvx）
 * @param {string[]} spec.args 原本的参数
 * @returns {{command: string, args: string[], bundled: boolean, missing: boolean}}
 *   `bundled` 表示走的是内置运行时；`missing` 表示内置缺失、已退回原命令。
 */
function resolveMcpCommand(spec) {
  // 预置可能因为数据损坏而缺失/不完整——这里必须容错：
  // 抛异常会让整个 MCP 区初始化失败，而不是只少一个服务。
  const safe = spec && typeof spec === "object" ? spec : {};
  const originalCommand = typeof safe.command === "string" ? safe.command : "";
  const originalArgs = Array.isArray(safe.args) ? safe.args : [];
  const fallback = { command: originalCommand, args: originalArgs, bundled: false, missing: true };

  const python = bundledPython();
  if (!python) return fallback;

  const kind = builtinKind(safe);
  if (!kind) return fallback;

  // `-I` 隔离模式（等价 -E -s -P）：不读 PYTHONPATH / PYTHONHOME / 用户 site-packages，
  // 也不把 cwd 放进 sys.path。用户机器上别处的 Python 配置就不会污染包内这份环境。
  const base = { command: python, bundled: true, missing: false };
  if (kind === "windows-desktop") {
    // 入口与 console_scripts 一致：windows_mcp.__main__:main，参数原样传 `serve`。
    return { ...base, args: ["-I", "-m", "windows_mcp", "serve"] };
  }
  // Scrapling 没有 `__main__`（`python -m scrapling` 会报 No module named scrapling.__main__），
  // 它提供的是 `scrapling.cli:mcp` 这个 click 命令——直接调它即可。
  return { ...base, args: ["-I", "-c", "from scrapling.cli import mcp; mcp()"] };
}

/**
 * 给子进程补上内置运行时的环境变量。
 *
 * 目的有两个：
 * 1. 把内置解释器与 bin 目录放进 PATH，这样 MCP 服务内部再调用 `python`/`uv` 时
 *    用的是包内那份，而不是用户机器上可能存在的旧版本——版本不一致是这类
 *    「能启动但行为诡异」问题的主因；
 * 2. 抹掉继承来的 `PYTHONHOME` / `VIRTUAL_ENV`：这两个变量会让包内解释器
 *    去别处找标准库，是「装了却起不来」的经典原因。
 *
 * 只影响子进程，不修改系统环境变量。
 */
function bundledEnv(base = process.env) {
  const python = bundledPython();
  if (!python) return base;

  const pathKey = Object.keys(base).find((k) => k.toLowerCase() === "path") ?? "PATH";
  const additions = [path.dirname(python), path.join(runtimeDir(), "bin")].filter(
    (p, i, arr) => p && arr.indexOf(p) === i,
  );

  const current = (base[pathKey] ?? "").split(path.delimiter).filter(Boolean);
  const seen = new Set(current.map((p) => p.toLowerCase()));
  const merged = [...current];
  for (const item of additions) {
    if (seen.has(item.toLowerCase())) continue;
    seen.add(item.toLowerCase());
    merged.push(item);
  }

  const env = { ...base, [pathKey]: merged.join(path.delimiter), HEMING_RUNTIME: runtimeDir() };
  delete env.PYTHONHOME;
  delete env.VIRTUAL_ENV;

  // 让 patchright 复用 playwright 那份 node.exe（两者字节相同，构建期已删掉
  // patchright 的副本）。两个包的 _driver.py 都认这个变量；只在共享文件存在时
  // 注入，老版本运行时没去重时保持原样，行为完全兼容。
  const node = bundledNodeExecutable();
  if (node && !env.PLAYWRIGHT_NODEJS_PATH) env.PLAYWRIGHT_NODEJS_PATH = node;
  return env;
}

/**
 * 运行时状态快照，供界面显示。
 *
 * 界面上要能区分「内置可用」「内置缺依赖」「退回系统环境」——三者行为不同，
 * 出问题时用户报的日志也不一样。
 */
function runtimeStatus() {
  const python = bundledPython();
  const uv = bundledUv();
  const depsReady = python ? bundledDepsReady() : false;
  let note;
  if (python && depsReady) {
    note = "系统能力使用包内运行时，无需安装 Python 或 uv";
  } else if (python) {
    note = "内置运行时缺少依赖包，系统能力可能启动失败，建议重新安装和鸣";
  } else {
    note = "未找到内置运行时，MCP 将尝试使用系统已安装的 uvx（需自行安装 uv）";
  }
  return { bundled: Boolean(python && depsReady), runtimeDir: runtimeDir(), python, uv, depsReady, note };
}

module.exports = {
  RUNTIME_DIR,
  bundledDepsReady,
  bundledEnv,
  bundledNodeExecutable,
  bundledPython,
  bundledUv,
  builtinKind,
  resolveMcpCommand,
  runtimeDir,
  runtimeStatus,
};
