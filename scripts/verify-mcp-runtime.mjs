#!/usr/bin/env node
/**
 * 内置 MCP 运行时**搬家验证**（打包后必跑一次，可重复跑）。
 *
 * ## 验证什么
 *
 * 「内置运行时」只有在**换一个路径、换一台机器**之后仍能起来，才算真的内置。
 * 上一版（裸 venv + pyvenv.cfg 指向构建机的 uv 托管 Python）在本机能跑，
 * 但整棵树搬到别处就**连 `import os` 都失败**——而打包恰恰就是「搬到别处」。
 *
 * 所以这里做的不是「检查文件在不在」，而是一次真搬家：
 *
 * 1. 把 `packages/desktop/runtime` 整棵复制到 `.tmp/runtime-relocate/<随机>/mods/runtime`；
 * 2. 把 `bundled-runtime.js` / `mcp-stdio.js` / `child-kill.js` / `local-runtime.js`
 *    也复制到 `mods/`（`bundled-runtime.js` 靠 `__dirname` 找 runtime，
 *    于是它会去认复制出来那一份，而不是仓库里的原版）；
 * 3. 用**真实的主进程 stdio 桥**拉起两个系统能力，走完 MCP 握手：
 *    `initialize` → `notifications/initialized` → `tools/list`；
 * 4. 断言：解析出的命令落在复制目录内（证明用的是包内解释器而不是系统 uvx）、
 *    两个服务都握手成功、工具数 > 0、进程能干净回收。
 *
 * ## 用法
 *
 *   node scripts/verify-mcp-runtime.mjs              # 复制 + 验证（约 1 分钟）
 *   node scripts/verify-mcp-runtime.mjs --reuse      # 复用上次复制（更快）
 *   node scripts/verify-mcp-runtime.mjs --keep       # 保留复制目录便于排查
 */

import { spawn } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DESKTOP = join(ROOT, "packages", "desktop");
const SOURCE_RUNTIME = join(DESKTOP, "runtime");
const WORK = join(ROOT, ".tmp", "runtime-relocate");

const args = new Set(process.argv.slice(2));
const reuse = args.has("--reuse");
const keep = args.has("--keep");

/** 与主进程一致的模块集合：少一个 `require` 就会在搬走的目录里挂掉。 */
const MODULES = ["bundled-runtime.js", "mcp-stdio.js", "child-kill.js", "local-runtime.js"];

/** 两个系统能力在渲染层的真实 id（`mcp-` 前缀就是旧版解析漏掉的那个）。 */
const SERVERS = [
  { id: "mcp-windows-desktop", command: "uvx", args: ["windows-mcp", "serve"] },
  { id: "mcp-scrapling", command: "uvx", args: ["--from", "scrapling[ai]", "scrapling", "mcp"] },
];

function fail(reason, next) {
  console.error(`\n[verify-mcp-runtime] ✗ ${reason}`);
  if (next) console.error(`[verify-mcp-runtime] 下一步：${next}`);
  process.exit(1);
}

function log(message) {
  console.log(`[verify-mcp-runtime] ${message}`);
}

function directories(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

// —— 1. 复制一份到别的路径 ——
mkdirSync(WORK, { recursive: true });
let modsDir = reuse ? join(WORK, "reuse", "mods") : "";
if (!modsDir || !existsSync(join(modsDir, "bundled-runtime.js"))) {
  const stamp = `run-${Date.now().toString(36)}`;
  modsDir = join(WORK, reuse ? "reuse" : stamp, "mods");
  if (reuse) rmSync(join(WORK, "reuse"), { recursive: true, force: true });
  mkdirSync(modsDir, { recursive: true });
  for (const name of MODULES) copyFileSync(join(DESKTOP, name), join(modsDir, name));
  if (!existsSync(SOURCE_RUNTIME)) fail(`找不到内置运行时：${SOURCE_RUNTIME}`, "先跑 node scripts/build-mcp-runtime.mjs");
  const started = Date.now();
  cpSync(SOURCE_RUNTIME, join(modsDir, "runtime"), { recursive: true });
  log(`已搬家：${SOURCE_RUNTIME} → ${join(modsDir, "runtime")}（${Math.round((Date.now() - started) / 1000)}s）`);
}

// —— 2. 用搬走的那份代码解析启动命令 ——
const require_ = createRequire(join(modsDir, "noop.cjs"));
const bundled = require_(join(modsDir, "bundled-runtime.js"));
const { createStdioBridge } = require_(join(modsDir, "mcp-stdio.js"));
const { planStdioSpawn } = require_(join(modsDir, "local-runtime.js"));

const status = bundled.runtimeStatus();
log(`运行时状态：bundled=${status.bundled} depsReady=${status.depsReady} python=${status.python}`);
if (!status.bundled) fail(`搬家后运行时不可用：${status.note}`, "node scripts/build-mcp-runtime.mjs --force");

if (!status.python || !status.python.toLowerCase().startsWith(modsDir.toLowerCase())) {
  fail(`解释器没有指向搬家后的目录：${status.python}`, "检查 bundled-runtime.js 的 runtimeDir()");
}

// —— 3. 真拉起进程并握手 ——
const bridge = createStdioBridge({
  spawn,
  log: (line) => console.log(`  ${line}`),
  planSpawn: planStdioSpawn,
});

async function handshake(server) {
  const resolved = bundled.resolveMcpCommand(server);
  if (!resolved.bundled) fail(`${server.id} 没有解析到内置运行时（bundled=false）`, "检查 builtinKind() 的 id 归一规则");
  if (!resolved.command.toLowerCase().startsWith(modsDir.toLowerCase())) {
    fail(`${server.id} 的命令不在搬家目录内：${resolved.command}`, "检查 resolveMcpCommand()");
  }
  log(`${server.id} → ${resolved.command} ${resolved.args.join(" ")}`);

  const started = Date.now();
  const init = await bridge.request(server.id, server, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "heming-verify", version: "1.0.0" },
  });
  bridge.notify(server.id, server, "notifications/initialized");
  const info = init?.serverInfo ?? {};
  const tools = await bridge.request(server.id, server, "tools/list", {});
  const names = Array.isArray(tools?.tools) ? tools.tools.map((t) => t.name) : [];
  if (names.length === 0) fail(`${server.id} 握手成功但一个工具都没有`, "看上面的子进程 stderr");
  log(
    `  ✓ ${server.id} 握手 ${Date.now() - started}ms · ${info.name ?? "?"} ${info.version ?? ""} · ${names.length} 个工具：${names.slice(0, 8).join(", ")}${names.length > 8 ? " …" : ""}`,
  );
  return { id: server.id, tools: names.length, serverInfo: info, command: resolved.command };
}

const results = [];
try {
  for (const server of SERVERS) results.push(await handshake(server));
} finally {
  await bridge.disposeAll?.();
}

// —— 4. 收尾 ——
if (!keep) {
  // 复制出来的是 400MB+，留着没意义；失败时也删，避免下次 --reuse 用到坏副本。
  const parent = join(modsDir, "..");
  try {
    rmSync(parent, { recursive: true, force: true });
  } catch {
    /* Windows 上刚杀掉的子进程可能还占着 DLL，删不掉不影响结论 */
  }
}

log(`✓ 搬家验证通过：${results.map((r) => `${r.id}（${r.tools} 个工具）`).join("、")}`);
log(`  说明：这两个服务跑在包内解释器上，用户机器不需要 Python 或 uv。`);
process.exit(0);
