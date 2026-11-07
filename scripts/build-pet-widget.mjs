#!/usr/bin/env node
/**
 * 桌宠界面插件包：构建（vite）→ 组装包根（plugin.json + files/**）。
 *
 * 产物：
 *   packages/pet-widget/dist/package/
 *   ├── plugin.json      # 清单 v4（源文件在包根，这里重写为规范化 JSON）
 *   └── files/**         # vite 产物 + public/pet 资源 + 托盘图标
 *
 * 之后由 `scripts/pack-plugin.mjs` 打成 `package.tgz`（确定性 tar + gzip9 + sha256）。
 *
 * 为什么构建与打包分开：`pnpm --filter @heming/pet-widget build` 只做「可检查的产物」，
 * 打包要复用宿主侧的确定性 tar（packages/desktop/plugin-tar.js，发布链路与安装校验共用）。
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PKG = join(ROOT, "packages", "pet-widget");
const DIST = join(PKG, "dist", "package");
const FILES = join(DIST, "files");

/** 与规格 §2.1 的安装配额同口径，构建期先自检一遍，别等安装时才失败。 */
const LIMITS = Object.freeze({
  maxTotalBytes: 20 * 1024 * 1024,
  maxFiles: 2000,
  maxFileBytes: 8 * 1024 * 1024,
});

/** 用包内依赖的 vite（不依赖根 node_modules）；找不到时给出可执行的提示。 */
function resolveViteBin() {
  const requireFromPkg = createRequire(join(PKG, "package.json"));
  try {
    return join(dirname(requireFromPkg.resolve("vite/package.json")), "bin", "vite.js");
  } catch {
    /* 继续尝试下面的入口推断 */
  }
  try {
    const entry = requireFromPkg.resolve("vite");
    return join(dirname(entry), "..", "..", "bin", "vite.js");
  } catch {
    return null;
  }
}

function walkFiles(dir, base = "") {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    const info = statSync(full);
    if (info.isDirectory()) out.push(...walkFiles(full, rel));
    else if (info.isFile()) out.push({ path: rel, size: info.size });
  }
  return out;
}

function fail(message) {
  console.error(`[build-pet-widget] 失败：${message}`);
  process.exit(1);
}

const viteBin = resolveViteBin();
if (!viteBin || !existsSync(viteBin)) {
  fail("找不到 vite —— 先在仓库根跑 `pnpm install`（worktree 也要装）。");
}

console.log(`[build-pet-widget] vite build → ${FILES}`);
execFileSync(process.execPath, [viteBin, "build"], { cwd: PKG, stdio: "inherit" });

// ── 组装包根 ────────────────────────────────────────────────────────────────
const manifestSource = join(PKG, "plugin.json");
if (!existsSync(manifestSource)) fail(`缺少清单源文件：${manifestSource}`);
let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestSource, "utf8"));
} catch (err) {
  fail(`plugin.json 不是合法 JSON：${(err && err.message) || err}`);
}
if (manifest.schemaVersion !== 4) fail(`schemaVersion 必须是 4（界面插件），实际 ${manifest.schemaVersion}`);
if (manifest.distribution !== "bundle") fail("界面插件必须声明 distribution: \"bundle\"");
const widget = manifest.contributions?.desktopWidgets?.[0];
if (!widget) fail("contributions.desktopWidgets 至少需要一个条目");
if (typeof widget.entry !== "string" || !widget.entry.startsWith("files/")) {
  fail(`desktopWidgets[0].entry 必须位于 files/ 下，实际 ${JSON.stringify(widget.entry)}`);
}

const entryFile = join(DIST, widget.entry);
if (!existsSync(entryFile)) fail(`entry 不存在于产物中：${widget.entry}（检查 vite build.outDir）`);

// 规范化写入：固定 2 空格 + 结尾换行，让同一份源码产出同一串字节（发布侧 sha256 依赖它）
writeFileSync(join(DIST, "plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

// ── 配额自检（与安装端同一口径）─────────────────────────────────────────────
const files = walkFiles(FILES);
let total = 0;
for (const file of files) {
  if (file.size > LIMITS.maxFileBytes) fail(`单文件超过 8MB：${file.path}（${file.size} 字节）`);
  total += file.size;
}
if (files.length > LIMITS.maxFiles) fail(`文件数超过上限：${files.length} > ${LIMITS.maxFiles}`);
if (total > LIMITS.maxTotalBytes) fail(`解包总量超过 20MB：${total} 字节`);

console.log(
  `[build-pet-widget] 已组装 ${DIST}\n` +
    `  plugin.json    ${manifest.id}@${manifest.version}\n` +
    `  files          ${files.length} 个文件 / ${(total / 1024 / 1024).toFixed(2)} MB（未压缩）\n` +
    `  入口           ${widget.entry}\n` +
    `  下一步         pnpm --filter @heming/pet-widget pack`,
);
