"use strict";
/**
 * 和鸣应用版本：5 段格式 `<通道>.<特性>.<破坏性>.<修订>.<构建>`，可带 `-dev.<n>`。
 *
 * 通道：d = desktop（桌面安装包；云端网页沿用同一版本号）、c = cloud、m = mobile。
 *
 * 为什么并存三种字段：
 * - `hemingVersion`：面向用户展示与更新比较，始终是 5 段；
 * - `version`：electron-builder 只接受 semver，由 5 段派生（`d.0.1.0.0` → `0.1.0-build.0`）；
 * - `shortVersion` / `shortVersionWindows`：Windows 四段版本（`0.1.0.0`），仅作记录与工具用。
 *
 * 规则见 docs/VERSION-MANAGEMENT.md；bump 走 `node scripts/bump-version.mjs d.0.1.0.0`。
 */
const LEGACY_VERSION = /^(\d+\.\d+\.\d+)(-dev\.(\d+))?$/;
const CHANNEL_VERSION = /^([dmc])\.(\d+\.\d+\.\d+\.\d+)(-dev\.(\d+))?$/;
const NUMERIC_MODERN_VERSION = /^(\d+\.\d+\.\d+\.\d+\.\d+)(-dev\.(\d+))?$/;

/**
 * 解析受支持的版本号；非法输入返回 null，调用方据此判定「不可比较」。
 * @param {unknown} value
 */
function parseVersion(value) {
  if (typeof value !== "string") return null;

  const channelMatch = CHANNEL_VERSION.exec(value);
  if (channelMatch) {
    return {
      format: "modern",
      channel: channelMatch[1].toLowerCase(),
      numbers: channelMatch[2].split(".").map(Number),
      prerelease: channelMatch[4] === undefined ? null : Number(channelMatch[4]),
    };
  }

  const numericMatch = NUMERIC_MODERN_VERSION.exec(value);
  if (numericMatch) {
    return {
      format: "modern",
      channel: null,
      numbers: numericMatch[1].split(".").map(Number),
      prerelease: numericMatch[3] === undefined ? null : Number(numericMatch[3]),
    };
  }

  const legacyMatch = LEGACY_VERSION.exec(value);
  if (legacyMatch) {
    return {
      format: "legacy",
      channel: null,
      numbers: legacyMatch[1].split(".").map(Number),
      prerelease: legacyMatch[3] === undefined ? null : Number(legacyMatch[3]),
    };
  }

  return null;
}

/**
 * 比较两个版本号：a>b 返回正数，a<b 返回负数，相等或不可比返回 0。
 *
 * 规则（与 MultiAgent/合鸣一致）：
 * - 5 段通道版本恒高于旧 semver 基线，否则首次迁移（0.0.1 → d.0.1.0.0）会被误判为降级；
 * - 通道不同视为不可比（桌面版与移动端各走各的更新通道）；
 * - 数值段逐位比较，缺失位按 0 处理；
 * - `-dev.<n>` 低于同数值的正式版本，正式版高于任何预发版。
 */
function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;
  if (left.channel && right.channel && left.channel !== right.channel) return 0;
  if (left.format !== right.format) return left.format === "modern" ? 1 : -1;

  const length = Math.max(left.numbers.length, right.numbers.length);
  for (let index = 0; index < length; index++) {
    const difference = (left.numbers[index] ?? 0) - (right.numbers[index] ?? 0);
    if (difference !== 0) return difference;
  }

  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  return left.prerelease - right.prerelease;
}

/** 从 package.json 形状对象里取展示版本（5 段优先）。 */
function appVersionOf(pkg) {
  return pkg && typeof pkg.hemingVersion === "string" && pkg.hemingVersion
    ? pkg.hemingVersion
    : (pkg && typeof pkg.version === "string" ? pkg.version : "0.0.0");
}

// 预加载与主进程直接 require 本文件读取版本，避免各写一份读 package.json 的逻辑。
let cached = null;
/**
 * 应用展示版本（5 段）。首次读取后缓存。
 *
 * 路径必须是 `./package.json`（本文件与桌面包 package.json 同级）：
 * 早先写成 `../package.json`，指向的是并不存在的 `packages/package.json`，
 * 异常被 catch 吞成 "0.0.0" —— 桌面端设置区、主进程启动日志、preload 注入的
 * `__heming_version` 因此全都显示 0.0.0，而真实版本号一直是 d.x.y.z.w。
 */
function appVersion() {
  if (cached) return cached;
  try {
    cached = appVersionOf(require("./package.json"));
  } catch {
    cached = "0.0.0";
  }
  return cached;
}

module.exports = { APP_VERSION_CHANNEL: "d", appVersion, appVersionOf, compareVersions, parseVersion };