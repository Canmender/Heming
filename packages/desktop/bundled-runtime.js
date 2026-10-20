"use strict";
/**
 * 内置运行时路径解析（仅桌面端）。
 *
 * ## 为什么需要这个模块
 *
 * 和鸣只面向桌面安装版，且**内置全部运行环境**：用户装完就能用，不需要自己装
 * Python、uv 或任何 MCP 服务。实现方式是把这套东西打进安装包
 * （`resources/runtime/`），启动 MCP 时直接指向包内的可执行文件。
 *
 * 于是同一个预置（MCP 服务定义）在两种状态下要指向**完全不同的路径**：
 *
 * | 状态 | 指向 | 为什么 |
 * |---|---|---|
 * | 打包后 | `resources/runtime/mcp-env/Scripts/*.exe` | 用户装好的那份 |
 * | 开发态 | `resources/runtime/mcp-env/Scripts/*.exe`（同一份） | 本地开发直接复用构建产物 |
 * | 两者都没有 | 退回 `uvx` + PATH 补全 | 没构建过内置运行时时不至于完全不可用 |
 *
 * 最后一行是刻意保留的退路：内置运行时构建要十几分钟（拉 Python + 200+ 个包），
 * 不可能塞进日常开发流程。没有它的话，改一行前端代码就会让 MCP 全挂。
 *
 * 路径解析集中在这里而不是散在各处：预置定义、std子进程环境、界面提示
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

/**
 * 内置解释器路径（Windows 上是 Scripts/python.exe）。
 *
 * 返回 null 表示内置运行时不可用——调用方据此退回 `uvx`，不要抛异常：
 * 「内置缺失」应该是降级，不是崩溃。
 */
function bundledPython() {
  const candidates = [
    path.join(runtimeDir(), "mcp-env", "Scripts", "python.exe"),
    path.join(runtimeDir(), "mcp-env", "Scripts", "python3.exe"),
    path.join(runtimeDir(), "mcp-env", "bin", "python3"),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* 忽略：权限或路径异常都按「不可用」处理 */
    }
  }
  return null;
}

/**
 * 解析一个 MCP 服务的启动命令。
 *
 * @param {object} spec
 * @param {string} spec.id 预置 id，如 "windows-desktop" / "scrapling"
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

  const python = bundledPython();
  const envScripts = python ? path.dirname(python) : "";

  /** 内置解释器 + 模块入口的映射。 */
  const BUNDLED_ENTRY = {
    // Windows-MCP：入口是控制台脚本
    "windows-desktop": envScripts ? path.join(envScripts, "windows-mcp.exe") : "",
    // Scrapling：注意**不能**用 `python -m scrapling`——
    // scrapling 不是可执行包（没有 __main__.py），会报
    // "No module named scrapling.__main__"。环境提供的是独立的 scrapling-mcp.exe。
    scrapling: envScripts ? path.join(envScripts, "scrapling-mcp.exe") : "",
  };

  const entry = BUNDLED_ENTRY[safe.id];
  if (python && entry) {
    try {
      if (fs.existsSync(entry)) {
        return {
          command: entry,
          args: safe.id === "windows-desktop" ? ["serve"] : [],
          bundled: true,
          missing: false,
        };
      }
    } catch {
      /* 落到下面的退回分支 */
    }
  }

  // 内置缺失或不认识这个预置：退回原命令，交给 mcp-stdio 的 PATH 补全去找系统 uvx
  return { command: originalCommand, args: originalArgs, bundled: false, missing: true };
}

/**
 * 给子进程补上内置运行时的环境变量。
 *
 * 目的有两个：
 * 1. 让 Python 找到自己的标准库——直接跑 `mcp-env/Scripts/python.exe` 时，
 *    它靠 `pyvenv.cfg` 定位基础解释器，这通常已经够用；
 * 2. 把内置运行时目录放进 PATH，这样 MCP 服务内部再调用 `uv`/`python` 时
 *    用的是包内那份，而不是用户机器上可能存在的旧版本——
 *    版本不一致是这类「能启动但行为诡异」问题的主因。
 *
 * 只影响子进程，不修改系统环境变量。
 */
function bundledEnv(base = process.env) {
  const python = bundledPython();
  if (!python) return base;

  const scripts = path.dirname(python);
  const envRoot = path.join(runtimeDir(), "mcp-env");
  const pathKey = Object.keys(base).find((k) => k.toLowerCase() === "path") ?? "PATH";
  const additions = [scripts, path.join(envRoot, "Scripts")].filter(
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

  return {
    ...base,
    [pathKey]: merged.join(path.delimiter),
    // 明确指向包内环境，避免服务端再去读用户目录里的虚拟环境
    VIRTUAL_ENV: envRoot,
    HEMING_RUNTIME: runtimeDir(),
  };
}

/**
 * 运行时状态快照，供界面显示。
 *
 * 界面上要能区分「内置可用」与「退回系统环境」——两者行为不同，
 * 出问题时用户报的日志也不一样。
 */
function runtimeStatus() {
  const python = bundledPython();
  return {
    bundled: Boolean(python),
    runtimeDir: runtimeDir(),
    python,
    /** 简短说明，用于设置区提示。 */
    note: python
      ? "内置运行时已就绪，无需安装任何外部环境"
      : "未找到内置运行时，MCP 将尝试使用系统已安装的 uvx",
  };
}

module.exports = {
  RUNTIME_DIR,
  bundledEnv,
  bundledPython,
  resolveMcpCommand,
  runtimeDir,
  runtimeStatus,
};