#!/usr/bin/env node
/**
 * 模块包契约检查（d.131 M6）。
 *
 * 不构建、不启动 Electron，只对磁盘上的模块清单做发布前守卫：
 * 1. 每个模块目录有 module.json，id 与目录一致，web.entry 合法且贡献非空；
 * 2. module.sdk.json 的每个宿主依赖都仍存在于 packages/web/src（迁走的目录不能残留引用；
 *    infohub client/store/tools 是宿主引擎桥，允许）；
 * 3. 如果已有 dist/entry.js，检查体积与「没打包 React」。
 *
 * 安装包守卫在 `packages/desktop/packaging.plugins.test.js`；本体实现守卫在
 * `packages/web/src/lib/modules/coupling.test.ts`。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MODULES = join(ROOT, "packages/modules");
const WEB_SRC = join(ROOT, "packages/web/src");
const SKIP = new Set(["sdk", "hello-page"]);
const MIGRATED = [/^lib\/staff\//, /^lib\/automation\//, /^lib\/workflow\//, /^components\/workflow\//];
const ALLOWED_CONTRIB = new Set(["page", "homeCard", "background", "settings", "tools"]);
const MAX_ENTRY_BYTES = 2.5 * 1024 * 1024;

const failures = [];
function fail(id, message) {
  failures.push(`[${id}] ${message}`);
}

function resolveWebModule(rel) {
  for (const ext of [".ts", ".tsx"]) {
    const file = join(WEB_SRC, `${rel}${ext}`);
    if (existsSync(file)) return file;
  }
  return null;
}

const ids = readdirSync(MODULES)
  .filter((name) => {
    const full = join(MODULES, name);
    return statSync(full).isDirectory() && !SKIP.has(name);
  })
  .sort();

if (ids.length === 0) {
  console.error("[module:check] packages/modules 下没有模块");
  process.exit(1);
}

for (const id of ids) {
  const dir = join(MODULES, id);
  const manifestPath = join(dir, "module.json");
  if (!existsSync(manifestPath)) {
    fail(id, "缺少 module.json");
    continue;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.id !== id) fail(id, `module.json id=${manifest.id} 与目录不一致`);
  if (manifest.distribution !== "module") fail(id, "distribution 必须是 module");
  if (manifest.meta?.kind !== "module") fail(id, "meta.kind 必须是 module");
  const web = manifest.web;
  if (!web || typeof web.entry !== "string") fail(id, "缺少 web.entry");
  else if (!/^files\/web\/[A-Za-z0-9._/-]+\.js$/.test(web.entry)) fail(id, `web.entry 非法：${web.entry}`);
  const contributions = Array.isArray(web?.contributions) ? web.contributions : [];
  if (contributions.length === 0) fail(id, "web.contributions 不能为空");
  for (const item of contributions) {
    if (!ALLOWED_CONTRIB.has(item)) fail(id, `未知贡献项：${item}`);
  }
  if (!contributions.includes("page")) fail(id, "必须声明 page 贡献");

  const sdkPath = join(dir, "module.sdk.json");
  if (existsSync(sdkPath)) {
    const sdk = JSON.parse(readFileSync(sdkPath, "utf8"));
    for (const [name, rel] of Object.entries(sdk.exports ?? {})) {
      if (typeof rel !== "string") {
        fail(id, `SDK 导出 ${name} 路径非法`);
        continue;
      }
      if (MIGRATED.some((re) => re.test(`${rel}.ts`))) {
        fail(id, `SDK 导出 ${name} 指向已迁出的模块文件：${rel}`);
        continue;
      }
      if (!resolveWebModule(rel)) fail(id, `SDK 导出 ${name} 指向不存在的宿主文件：${rel}`);
    }
  }

  const entry = join(dir, "dist/entry.js");
  if (existsSync(entry)) {
    const code = readFileSync(entry, "utf8");
    const size = statSync(entry).size;
    if (size > MAX_ENTRY_BYTES) fail(id, `dist/entry.js 超过 2.5MB（${(size / 1024).toFixed(0)}KB）`);
    if (/react\.development|react\.production|react-dom|__SECRET_INTERNALS/.test(code)) {
      fail(id, "dist/entry.js 打包了 React 本体（必须走宿主 SDK）");
    }
    console.log(`  ${id}: ${(size / 1024).toFixed(1)}KB entry · ${contributions.join("/")}`);
  } else {
    console.log(`  ${id}: 未构建（跳过 dist 检查）· ${contributions.join("/")}`);
  }
}

if (failures.length > 0) {
  console.error(`[module:check] ${failures.length} 项失败：`);
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}
console.log(`[module:check] OK：${ids.length} 个模块包契约通过`);
