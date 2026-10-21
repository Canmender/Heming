"use strict";
/**
 * 本机运行时探测与 stdio 启动方案（仅桌面端，d.25 本地包安装）。
 *
 * ## 为什么需要
 * MCP Registry 的 `npm` / `pypi` 类服务器要在**用户机器上**拉起 `npx` / `uvx`。
 * 我们刻意不内置 Node 与 uv：内置意味着安装包 +30MB，且上游一发新版就得重打包。
 * 于是「能不能装」变成一个**必须先探测**的问题——装一个本机跑不起来的包，
 * 用户只会看到一条看不懂的连接失败。
 *
 * ## 为什么 Windows 上不能直接 spawn("npx")（实测）
 * ```
 * spawn("npx")     → ENOENT  （PATH 里没有无扩展名的可执行文件）
 * spawn("npx.cmd") → EINVAL  （Node ≥18.20.2 拒绝直接执行 .cmd/.bat，CVE-2024-27980 加固）
 * spawn("uvx")     → OK      （uvx 是真 .exe）
 * ```
 * 我们的 stdio 桥**恒定 `shell:false`**（装的是任意第三方包，开 shell 等于开命令注入面），
 * 所以 Windows 上走 npm 包只有一条路：`node <npm>/bin/npx-cli.js -y <包名>`——
 * 全程不经过 shell，参数都是数组元素，注入面与远程装法同级。
 *
 * ## 为什么解析结果一律给绝对路径
 * Windows 上 libuv 查找可执行文件用的是**父进程**的 PATH，`options.env` 里补的目录
 * 不参与搜索。Electron 从快捷方式启动时继承的是安装那一刻的 PATH，用户后装的
 * node/uv 常常不在其中——只返回「文件名」等于白找。
 *
 * 本模块只做两件事：① 探测（`probeLocalRuntime`）；② 把逻辑命令翻译成本机真正
 * 能执行的形态（`planStdioSpawn`）。两者都只读文件系统，不写、不执行。
 */

const path = require("node:path");
const { resolveExecutablePath } = require("./mcp-stdio.js");

/** npm CLI 入口相对候选目录的常见位置（官方安装、nvm、scoop、全局前缀各不同）。 */
const NPM_CLI_RELATIVES = [
  ["node_modules", "npm", "bin", "npx-cli.js"],
  ["lib", "node_modules", "npm", "bin", "npx-cli.js"],
  ["node_modules", "npm", "bin", "npx-bin.js"],
];

function pathEntriesOf(env) {
  const key = Object.keys(env).find((k) => k.toLowerCase() === "path");
  const raw = key && typeof env[key] === "string" ? env[key] : "";
  return raw.split(path.delimiter).filter(Boolean);
}

/** 逐个候选目录 × 相对位置找 npx-cli.js；返回绝对路径或 null。 */
function findNpmCli(entries, execPath, exists) {
  const roots = [];
  if (typeof execPath === "string" && execPath) roots.push(path.dirname(execPath));
  roots.push(...entries);
  const seen = new Set();
  for (const root of roots) {
    if (!root || seen.has(root)) continue;
    seen.add(root);
    for (const relative of NPM_CLI_RELATIVES) {
      try {
        if (exists(path.join(root, ...relative))) return path.join(root, ...relative);
      } catch {
        /* 单个探测失败不影响其余候选 */
      }
    }
    // 全局前缀的 shim 目录（%APPDATA%\npm）里 npm 包在上一级
    for (const relative of NPM_CLI_RELATIVES) {
      try {
        if (exists(path.join(root, "..", ...relative))) return path.join(root, "..", ...relative);
      } catch {
        /* 同上 */
      }
    }
  }
  return null;
}

/** 探测环境的原始结果（内部用：既给界面，也给启动方案）。 */
function localRuntimeProbe(deps) {
  const platform = typeof deps.platform === "string" ? deps.platform : process.platform;
  const env = deps.env && typeof deps.env === "object" ? deps.env : process.env;
  const execPath = typeof deps.execPath === "string" ? deps.execPath : process.execPath;
  const exists = deps.exists ?? ((p) => require("node:fs").existsSync(p));
  const entries = pathEntriesOf(env);

  const node = resolveExecutablePath("node", entries, exists);
  const npx = resolveExecutablePath("npx", entries, exists);
  const npmBin = resolveExecutablePath("npm", entries, exists);
  const uvx =
    resolveExecutablePath("uvx", entries, exists) ?? resolveExecutablePath("uv", entries, exists);
  const npxCli = findNpmCli(entries, execPath, exists);

  // Windows：npx 的真身是 .cmd，只有拿到 node + npx-cli.js 才算「能跑」；
  // 其他平台：PATH 里有 npx（或 node + 全局 npm 入口）即可。
  const npm = platform === "win32" ? Boolean(node && npxCli) : Boolean(npx ?? npmBin ?? (node && npxCli));

  return { platform, node, npx, npmBin, npxCli, uvx, npm, pypi: Boolean(uvx), entries, exists };
}

/**
 * 探测本机能不能跑 npm / pypi 类 MCP 包。
 *
 * @param {object} [deps] 全部可注入，便于单测（不依赖真实文件系统）
 * @param {string} [deps.platform] `process.platform`
 * @param {Record<string,string>} [deps.env] 已补全的 PATH（用 `buildChildEnv` 的输出）
 * @param {string} [deps.execPath] `process.execPath`
 * @param {(p: string) => boolean} [deps.exists]
 * @returns {{platform:string,node:string|null,npx:string|null,npxCli:string|null,uvx:string|null,npm:boolean,pypi:boolean,note:string}}
 */
function probeLocalRuntime(deps = {}) {
  const { platform, node, npx, npxCli, uvx, npm, pypi } = localRuntimeProbe(deps);
  const missing = [];
  if (!npm) missing.push("Node.js（npx）");
  if (!pypi) missing.push("uv（uvx）");
  return {
    platform,
    node,
    npx,
    npxCli,
    uvx,
    npm,
    pypi,
    note: missing.length
      ? `本机未安装：${missing.join("、")}——本地包服务无法启动，可改用远程服务或先安装对应运行时`
      : "本机运行时齐备，可安装本地包服务",
  };
}

/**
 * 把逻辑启动命令翻译成本机真正可执行的形态。
 *
 * 认识的命令（npx / npm / uvx / uv）一律解析成绝对路径；其余原样返回——
 * 内置预置给的本来就是包内绝对路径。
 *
 * @param {object} spec `{command, args, env}`
 * @param {object} [deps] `{platform, execPath, exists}`
 * @returns {{command:string, args:string[], note?:string}}
 * @throws {Error} 本机缺少所需运行时（文案直接给用户看）
 */
function planStdioSpawn(spec, deps = {}) {
  const command = typeof spec?.command === "string" ? spec.command.trim() : "";
  const args = Array.isArray(spec?.args) ? [...spec.args] : [];
  if (!command) return { command, args };

  const r = localRuntimeProbe({
    platform: deps.platform,
    env: spec?.env && typeof spec.env === "object" ? spec.env : process.env,
    execPath: deps.execPath,
    exists: deps.exists,
  });

  if (command === "npx" || command === "npm") {
    if (r.platform === "win32") {
      if (!r.node || !r.npxCli) {
        throw new Error("本机未找到可用的 Node.js/npm（Windows 上需 node.exe 与 npx-cli.js），无法运行该服务");
      }
      // args 原样拼在后面：`npx -y pkg@1.2.3` → `node npx-cli.js -y pkg@1.2.3`
      return { command: r.node, args: [r.npxCli, ...args], note: "node + npx-cli.js（绕开 .cmd）" };
    }
    // 类 Unix：`npx`/`npm` 本身是带 shebang 的脚本，绝对路径直接可执行
    const runner = command === "npx" ? r.npx : r.npmBin;
    if (!runner) throw new Error("本机未找到 npx/npm（需先安装 Node.js），无法运行该服务");
    return { command: runner, args };
  }

  if (command === "uvx" || command === "uv") {
    if (!r.uvx) throw new Error("本机未找到 uv/uvx（pypi 包需要 uv），无法运行该服务");
    // uvx 是 `uv tool run` 的别名：解析到 uv 时必须补这两个子命令，
    // 否则 `uv <包名>` 会被当成未知子命令报错。
    if (path.basename(r.uvx).toLowerCase().startsWith("uvx")) return { command: r.uvx, args };
    return { command: r.uvx, args: ["tool", "run", ...args] };
  }

  return { command, args };
}

module.exports = { NPM_CLI_RELATIVES, findNpmCli, pathEntriesOf, planStdioSpawn, probeLocalRuntime };
