#!/usr/bin/env node
/**
 * 获取内置 magpie CLI 二进制（d.91）。
 *
 * 为什么不在仓库里放二进制：magpie-cli Windows 单文件约 70MB，放仓库会让每次 clone / 每次
 * 打包前的 diff 都背着一个可执行物。构建机需要时用本脚本下载，并用发布方的 SHA256SUMS 校验。
 *
 * 用法：
 *   node scripts/fetch-magpie.mjs            # 有就跳过；没有就下载并校验
 *   node scripts/fetch-magpie.mjs --force    # 强制重下
 *   node scripts/fetch-magpie.mjs --check    # 只在已存在时校验，不下载（发布前自检）
 *
 * 环境变量：
 *   HEMING_MAGPIE_VERSION  发布标签（默认 v0.1.3246）
 *   HEMING_MAGPIE_ASSET    覆盖资源名（默认按平台/架构推导）
 *   HEMING_MAGPIE_DIR      目标目录（默认 packages/desktop/resources/magpie）
 *   HEMING_MAGPIE_MIRROR   下载镜像前缀（例如 https://ghproxy.net/；GitHub 直连慢时用）
 *
 * 落点：`packages/desktop/resources/magpie/magpie-cli.exe`（由 desktop 的 extraResources
 * 打包到 `resources/magpie/`，主进程 `magpie-host.js` 从那里启动）。
 *
 * 只支持 Windows 安装包构建（本项目只发 Windows 安装包）；其它平台会提醒但仍可下载对应资源。
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = (process.env.HEMING_MAGPIE_VERSION || "v0.1.3246").trim();
const RELEASE_BASE = "https://github.com/yetone/magpie-releases/releases/download";
/** 可选镜像前缀：直连 GitHub 在部分网络下极慢（实测 30 分钟 <3MB），镜像只影响下载、校验不变。 */
const MIRROR = (process.env.HEMING_MAGPIE_MIRROR || "").trim();
function withMirror(url) {
  if (!MIRROR) return url;
  return `${MIRROR.replace(/\/+$/, "")}/${url}`;
}

function assetName() {
  if (process.env.HEMING_MAGPIE_ASSET) return process.env.HEMING_MAGPIE_ASSET.trim();
  const platform = process.platform === "win32" ? "windows" : process.platform;
  const arch = process.arch === "x64" ? "amd64" : process.arch;
  if (process.platform === "win32") return `magpie-cli-windows-${arch}.exe`;
  return `magpie-cli-${platform}-${arch}`;
}

function targetName() {
  return process.platform === "win32" ? "magpie-cli.exe" : "magpie-cli";
}

function targetPath() {
  const dir = process.env.HEMING_MAGPIE_DIR
    ? resolve(process.env.HEMING_MAGPIE_DIR)
    : join(ROOT, "packages", "desktop", "resources", "magpie");
  return join(dir, targetName());
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** Node 的 CA 库在部分 Windows 机器上缺根证书；失败时回落系统 curl（均为只读下载）。 */
function curlText(url, what) {
  const result = spawnSync("curl", ["-fsSL", "--max-time", "120", url], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout) {
    throw new Error(`${what} 下载失败（Node fetch 与 curl 都不可用）`);
  }
  return result.stdout;
}

async function fetchOk(url, what) {
  try {
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response;
  } catch (err) {
    throw new Error(
      `${what} 下载失败：${err instanceof Error ? err.message : String(err)}（可尝试 node --use-system-ca）`,
    );
  }
}

async function readText(url, what) {
  try {
    return await (await fetchOk(url, what)).text();
  } catch {
    return curlText(url, what);
  }
}

async function readBinary(url, what, tempPath) {
  try {
    const response = await fetchOk(url, what);
    return Buffer.from(await response.arrayBuffer());
  } catch {
    const result = spawnSync(
      "curl",
      ["-fsSL", "--retry", "3", "--max-time", "1800", "-o", tempPath, url],
      { encoding: "utf8" },
    );
    if (result.status !== 0) {
      throw new Error(`${what} 下载失败：Node fetch 与 curl 都不可用（${result.stderr || "无输出"}）`);
    }
    return readFileSync(tempPath);
  }
}

/** 读发布目录的 SHA256SUMS，取目标资源的期望摘要。 */
async function expectedHash(asset) {
  const text = await readText(withMirror(`${RELEASE_BASE}/${VERSION}/SHA256SUMS`), "SHA256SUMS");
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(\S+)$/);
    if (match && match[2] === asset) return match[1].toLowerCase();
  }
  throw new Error(`SHA256SUMS 里没有 ${asset}（版本 ${VERSION}）`);
}

async function check() {
  const path = targetPath();
  if (!existsSync(path)) {
    console.error(`[magpie] 缺少二进制：${path}`);
    return 1;
  }
  const bytes = readFileSync(path);
  const expected = await expectedHash(assetName());
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    console.error(`[magpie] 校验失败：期望 ${expected}，实际 ${actual}`);
    return 1;
  }
  console.log(`[magpie] 已就绪：${path}（${(bytes.length / 1048576).toFixed(1)}MB，sha256 ${actual.slice(0, 16)}…）`);
  return 0;
}

async function main(argv) {
  const force = argv.includes("--force");
  const checkOnly = argv.includes("--check");
  if (checkOnly) return check();

  const path = targetPath();
  if (existsSync(path) && !force) {
    console.log(`[magpie] 已存在，跳过下载（--force 可重下）：${path}`);
    return 0;
  }
  const asset = assetName();
  const url = withMirror(`${RELEASE_BASE}/${VERSION}/${asset}`);
  console.log(`[magpie] 下载 ${asset}（${VERSION}）…`);
  const expected = await expectedHash(asset);
  const temp = `${path}.download`;
  const buffer = await readBinary(url, asset, temp);
  const actual = createHash("sha256").update(buffer).digest("hex");
  if (actual !== expected) {
    throw new Error(`下载内容与 SHA256SUMS 不一致：期望 ${expected}，实际 ${actual}`);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(temp, buffer);
  renameSync(temp, path);
  if (process.platform !== "win32") chmodSync(path, 0o755);
  console.log(
    `[magpie] 完成：${path}（${(statSync(path).size / 1048576).toFixed(1)}MB，sha256 ${actual.slice(0, 16)}…）`,
  );
  // 清理历史残留的下载临时文件
  if (existsSync(`${path}.download`)) rmSync(`${path}.download`, { force: true });
  return 0;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code ?? 0;
  })
  .catch((err) => {
    console.error(`[magpie] 失败：${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
