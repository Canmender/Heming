#!/usr/bin/env node
/**
 * 构建首方「宿主加载式」模块包（`packages/modules/<id>` → `dist/entry.js`）。
 *
 * 与 `build-module.mjs`（Python 引擎包）不同：这个产物是 ESM UI bundle，由主窗口
 * `import()` 执行，React/宿主 stores 全部从 `globalThis.__hemingHost` 取，不打包 React。
 *
 * 用法：
 *   node scripts/build-web-module.mjs --id hello-page
 *   node scripts/build-web-module.mjs --id staff
 *
 * 门禁（任一失败即非 0）：
 * - 产物必须存在且包含 `export`；
 * - 产物不得包含 React 本体（`react-dom` / `react.development` 等标记）；
 * - 产物超过 2.5MB 视为误把宿主依赖打进来。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
function option(name) {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
}

const moduleId = option("id");
if (!moduleId || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(moduleId)) {
  console.error("[build-web-module] 用法：node scripts/build-web-module.mjs --id <module-id>");
  process.exit(1);
}

const moduleRoot = resolve(ROOT, "packages/modules", moduleId);
const entrySource = resolve(moduleRoot, "src/index.tsx");
if (!existsSync(entrySource)) {
  console.error(`[build-web-module] 找不到入口：${entrySource}`);
  process.exit(1);
}
if (!existsSync(resolve(moduleRoot, "module.json"))) {
  console.warn(`[build-web-module] 警告：${moduleId} 没有 module.json（只适合本地样例）`);
}

const run = spawnSync(
  "pnpm",
  ["-C", "packages/web", "exec", "vite", "build", "--config", "module-build.config.mjs"],
  {
    cwd: ROOT,
    env: { ...process.env, MODULE_ID: moduleId },
    stdio: "inherit",
    shell: process.platform === "win32",
  },
);
if (run.status !== 0) {
  console.error(`[build-web-module] vite build 失败（exit ${run.status}）`);
  process.exit(run.status ?? 1);
}

const outFile = resolve(moduleRoot, "dist/entry.js");
if (!existsSync(outFile)) {
  console.error(`[build-web-module] 构建没有产出 ${outFile}`);
  process.exit(1);
}
const code = readFileSync(outFile, "utf8");
const size = statSync(outFile).size;

const checks = [
  ["包含 ESM export", /\bexport\s*\{/.test(code) || /\bexport\s+(const|function|class)\b/.test(code)],
  ["未打包 React 本体", !/react\.development|react\.production|react-dom|__SECRET_INTERNALS/.test(code)],
  ["体积 ≤ 2.5MB", size <= 2.5 * 1024 * 1024],
];
let failed = false;
for (const [label, ok] of checks) {
  console.log(`[build-web-module] ${ok ? "✓" : "✗"} ${label}`);
  if (!ok) failed = true;
}
console.log(`[build-web-module] 产物：${outFile}（${(size / 1024).toFixed(1)}KB）`);
if (failed) process.exit(1);
