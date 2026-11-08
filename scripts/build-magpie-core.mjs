#!/usr/bin/env node
/**
 * 构建「和鸣内置模型网关内核」（d.97）。
 *
 * 背景：模型能力统一由 magpie 提供。早期做法是下载 magpie 官方编译好的 CLI 二进制
 * （`fetch-magpie.mjs`）——那等于随包分发别人的产物。现在改为 **在本仓库内复用 magpie 源码**
 * （MIT；裁剪后的源码见 `vendor/magpie-core/`，来源与裁剪口径见其 `PROVENANCE.md`），
 * 由本脚本用 Go 工具链编译成和鸣自己的内核：`packages/desktop/resources/magpie/magpie-core.exe`。
 *
 * 于是：
 * - 不是「添加 magpie 的安装包」：仓库里没有第三方二进制，只有可审计、可修改的源码与我们的构建；
 * - 不是插件：内核由主进程托管、随应用本体发布（`extraResources`），与插件系统无关；
 * - 版本号由本脚本注入（`main.version`），所以 `/api/hello` 能看出这是和鸣的内核。
 *
 * 用法：
 *   node scripts/build-magpie-core.mjs            # 按需构建（源码不比产物新时跳过）
 *   node scripts/build-magpie-core.mjs --force    # 强制重建
 *   node scripts/build-magpie-core.mjs --check    # 只检查产物是否存在且不比源码旧（打包前置用）
 *
 * 环境变量：
 *   HEMING_GO          Go 可执行文件（缺省 PATH 里的 go；需要 Go ≥ 1.26.8，见 vendor 的 go.mod）
 *   HEMING_GOPROXY     依赖代理（缺省沿用本机 GOPROXY；网络受限时可设 https://goproxy.cn,direct）
 *   HEMING_MAGPIE_CORE_VERSION  覆盖内核版本串（缺省 `0.1.3246-heming.<应用版本>`）
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR_DIR = join(ROOT, "vendor", "magpie-core");
const OUT_DIR = join(ROOT, "packages", "desktop", "resources", "magpie");
const OUT_NAME = process.platform === "win32" ? "magpie-core.exe" : "magpie-core";
const OUT = join(OUT_DIR, OUT_NAME);
const UPSTREAM_VERSION = "0.1.3246";

function appVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, "packages", "desktop", "package.json"), "utf8"));
    return pkg.hemingVersion ?? pkg.version ?? "dev";
  } catch {
    return "dev";
  }
}

function coreVersion() {
  return (
    process.env.HEMING_MAGPIE_CORE_VERSION?.trim() ||
    `${UPSTREAM_VERSION}-heming.${appVersion()}`
  );
}

function goBinary() {
  return process.env.HEMING_GO?.trim() || (process.platform === "win32" ? "go.exe" : "go");
}

/** 源码目录里最新的 .go / go.mod / go.sum 修改时间。 */
function newestSourceMtime(dir) {
  let newest = 0;
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(go|mod|sum)$/.test(entry.name)) {
        try {
          newest = Math.max(newest, statSync(full).mtimeMs);
        } catch {
          /* 读不到就忽略 */
        }
      }
    }
  };
  walk(dir);
  return newest;
}

function upToDate() {
  if (!existsSync(OUT)) return false;
  const built = statSync(OUT).mtimeMs;
  return built >= newestSourceMtime(VENDOR_DIR);
}

function build() {
  if (!existsSync(join(VENDOR_DIR, "go.mod"))) {
    console.error(`[magpie-core] 缺少 vendored 源码：${VENDOR_DIR}`);
    return 1;
  }
  const go = goBinary();
  const probe = spawnSync(go, ["version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    console.error(
      `[magpie-core] 找不到 Go 工具链（${go}）。需要 Go ≥ 1.26.8：设置 HEMING_GO 或把它放进 PATH。`,
    );
    return 1;
  }
  console.log(`[magpie-core] 使用 ${String(probe.stdout).trim()}`);
  const env = { ...process.env, CGO_ENABLED: "0" };
  if (process.env.HEMING_GOPROXY?.trim()) env.GOPROXY = process.env.HEMING_GOPROXY.trim();
  const version = coreVersion();
  const result = spawnSync(
    go,
    [
      "build",
      "-tags",
      "nogui",
      "-trimpath",
      "-ldflags",
      `-s -w -X main.version=${version}`,
      "-o",
      OUT,
      ".",
    ],
    { cwd: VENDOR_DIR, env, stdio: "inherit" },
  );
  if (result.error || result.status !== 0) {
    console.error(`[magpie-core] 构建失败：${result.error?.message ?? `exit ${result.status}`}`);
    return result.status ?? 1;
  }
  const size = statSync(OUT).size;
  console.log(
    `[magpie-core] 已构建：${OUT}（${(size / 1048576).toFixed(1)}MB，内核版本 ${version}）`,
  );
  return 0;
}

function check() {
  if (!existsSync(OUT)) {
    console.error(`[magpie-core] 缺少产物：${OUT}（运行 node scripts/build-magpie-core.mjs）`);
    return 1;
  }
  if (!upToDate()) {
    console.error("[magpie-core] 产物比源码旧，需要重建（node scripts/build-magpie-core.mjs）");
    return 1;
  }
  console.log(`[magpie-core] 已就绪：${OUT}`);
  return 0;
}

function main(argv) {
  if (!existsSync(VENDOR_DIR)) {
    console.error(`[magpie-core] 缺少 vendor 目录：${VENDOR_DIR}`);
    return 1;
  }
  if (argv.includes("--check")) return check();
  if (argv.includes("--force") || !upToDate()) return build();
  console.log(`[magpie-core] 已是最新：${OUT}`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
