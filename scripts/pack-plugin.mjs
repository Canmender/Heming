#!/usr/bin/env node
/**
 * 把「包根目录」（plugin.json + files/**）打成 `package.tgz`（确定性 tar + gzip 9）。
 *
 * 用法：
 *   node scripts/pack-plugin.mjs [包根目录] [--out <输出文件>]
 *   默认包根 = packages/pet-widget/dist/package
 *   默认输出 = <包根>/../package.tgz
 *
 * 为什么确定性：发布链路按 `sha256(package.tgz)` 做完整性校验，安装端要先比指纹再解包。
 * tar 头固定 mtime/uid/gid 并对条目排序，gzip 固定 level 9 ⇒ 同样内容在任意机器上同一串字节。
 *
 * ★ 实现**不复用两份**：优先用宿主侧 `packages/desktop/plugin-package.js`
 *   （`packPackage` 打包、`readPackage` 按**安装口径**回读校验：配额 / 路径穿越 /
 *   清单 v4 / entry·icon 存在性）。该模块缺位时退化到同目录的 `plugin-tar.js`，
 *   再缺位才用本脚本内的等价实现——发布脚本不该因为宿主运行时没就位就不可用。
 */
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requireFromRoot = createRequire(import.meta.url);

/** 与规格 §2.1 一致的安装配额（宿主模块可用时以它的为准）。 */
const LIMITS = Object.freeze({
  maxTotalBytes: 20 * 1024 * 1024,
  maxFiles: 2000,
  maxFileBytes: 8 * 1024 * 1024,
});

function fail(message) {
  console.error(`[pack-plugin] 失败：${message}`);
  process.exit(1);
}

/* ── 参数 ──────────────────────────────────────────────────────────────── */

const argv = process.argv.slice(2);
let rootArg = null;
let outArg = null;
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === "--out") {
    outArg = argv[i + 1] ?? null;
    i += 1;
  } else if (arg.startsWith("--out=")) {
    outArg = arg.slice("--out=".length);
  } else if (!rootArg) {
    rootArg = arg;
  } else {
    fail(`多余的参数：${arg}`);
  }
}

// 相对参数按**当前工作目录**解析（`pnpm --filter ... pack` 的 cwd 是包目录），
// 只有缺省值才按仓库根定位标准产物目录。
const PACKAGE_ROOT = rootArg
  ? resolve(process.cwd(), rootArg)
  : resolve(ROOT, "packages/pet-widget/dist/package");
const OUT_FILE = outArg
  ? resolve(process.cwd(), outArg)
  : resolve(PACKAGE_ROOT, "..", "package.tgz");

if (!existsSync(PACKAGE_ROOT)) fail(`包根目录不存在：${PACKAGE_ROOT}（先跑 build）`);
const manifestPath = join(PACKAGE_ROOT, "plugin.json");
if (!existsSync(manifestPath)) fail(`包根缺少 plugin.json：${manifestPath}`);

/* ── 收集条目（排序由 tar 实现负责，这里只保证不重不漏）─────────────────── */

function walk(dir, base = "") {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    const info = statSync(full);
    if (info.isSymbolicLink()) fail(`包内不允许符号链接：${rel}`);
    if (info.isDirectory()) out.push(...walk(full, rel));
    else if (info.isFile()) out.push({ path: rel, data: readFileSync(full), size: info.size });
  }
  return out;
}

const entries = walk(PACKAGE_ROOT);
let total = 0;
for (const entry of entries) {
  if (entry.size > LIMITS.maxFileBytes) fail(`单文件超过 8MB：${entry.path}（${entry.size} 字节）`);
  total += entry.size;
}
if (entries.length > LIMITS.maxFiles) fail(`文件数超过上限：${entries.length} > ${LIMITS.maxFiles}`);
if (total > LIMITS.maxTotalBytes) fail(`解包总量超过 20MB：${total} 字节`);

/* ── 确定性 tar：优先宿主实现 ───────────────────────────────────────────── */

function fallbackPackTarGz(items) {
  const BLOCK = 512;
  const oct = (value, width) => `${value.toString(8).padStart(width - 1, "0")}\0`;
  const header = (name, size) => {
    const buf = Buffer.alloc(BLOCK, 0);
    buf.write(name, 0, 100, "utf8");
    buf.write(oct(0o644, 8), 100, 8, "ascii");
    buf.write(oct(0, 8), 108, 8, "ascii");
    buf.write(oct(0, 8), 116, 8, "ascii");
    buf.write(oct(size, 12), 124, 12, "ascii");
    buf.write(oct(0, 12), 136, 12, "ascii"); // mtime=0：确定性
    buf.write("        ", 148, 8, "ascii");
    buf.write("0", 156, 1, "ascii");
    buf.write("ustar\0", 257, 6, "ascii");
    buf.write("00", 263, 2, "ascii");
    let sum = 0;
    for (const byte of buf) sum += byte;
    buf.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    return buf;
  };
  const chunks = [];
  for (const item of [...items].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    chunks.push(header(item.path, item.data.length), item.data);
    const pad = (BLOCK - (item.data.length % BLOCK)) % BLOCK;
    if (pad > 0) chunks.push(Buffer.alloc(pad, 0));
  }
  chunks.push(Buffer.alloc(BLOCK * 2, 0));
  return gzipSync(Buffer.concat(chunks), { level: 9 });
}

function resolveHostModule() {
  for (const relative of ["packages/desktop/plugin-package.js", "packages/desktop/plugin-tar.js"]) {
    const full = join(ROOT, relative);
    if (!existsSync(full)) continue;
    const mod = requireFromRoot(full);
    if (typeof mod?.packPackage === "function") return { mod, source: relative, full: true };
    if (typeof mod?.packTarGz === "function") return { mod, source: relative, full: false };
  }
  return null;
}

const host = resolveHostModule();
const packageBytes = host
  ? host.full
    ? host.mod.packPackage(entries)
    : host.mod.packTarGz(entries)
  : fallbackPackTarGz(entries);
if (!Buffer.isBuffer(packageBytes) || packageBytes.length === 0) fail("打包结果为空");

/* ── 回读校验：与安装端同一口径 ─────────────────────────────────────────── */

let verification = "仅完成 tar 往返（宿主校验模块缺位）";
if (host?.full && typeof host.mod.readPackage === "function") {
  const result = host.mod.readPackage(packageBytes);
  if (!result.ok) fail(`包校验未通过：\n  - ${result.errors.join("\n  - ")}`);
  verification = `readPackage ✓（${result.files.length} 个文件，entry=${result.widget.entry}，sha256=${result.sha256.slice(0, 16)}…）`;
}

writeFileSync(OUT_FILE, packageBytes);
const sha256 = createHash("sha256").update(packageBytes).digest("hex");
console.log(
  `[pack-plugin] ${OUT_FILE}\n` +
    `  sha256   ${sha256}\n` +
    `  size     ${(packageBytes.length / 1024 / 1024).toFixed(2)} MB（gzip；解包前 ${(total / 1024 / 1024).toFixed(2)} MB / ${entries.length} 个文件）\n` +
    `  tar      ${host ? host.source : "内置实现（未找到宿主模块）"}\n` +
    `  校验     ${verification}`,
);
