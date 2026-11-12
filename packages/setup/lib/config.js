"use strict";
/**
 * 构建期注入的配置。
 *
 * scripts/build-setup.mjs 会在打包前写一份 config/generated.json（版本号、内层安装包
 * 的 sha512、装完的体积、是否内嵌安装包）。开发态没有这份文件，这里给一套默认值，
 * 保证 `electron .` 直接能跑。
 *
 * 目录约定：
 * - 打包后内嵌的安装包在 resources/payload/inner-setup.exe（electron-builder extraResources）；
 * - 开发态在 packages/setup/payload/inner-setup.exe。
 */

const fs = require("node:fs");
const path = require("node:path");

/** 与 packages/desktop/auto-update.js 的 DEFAULT_FEED_URL 保持一致；换服务器时两处一起改。 */
const DEFAULT_FEED_URL = "http://47.92.39.184/updates";

/** 内层安装包在内嵌资源目录里的固定名（不含空格，spawn 的 verbatim 模式要求）。 */
const DEFAULT_PAYLOAD_FILE = "inner-setup.exe";

/**
 * @param {string} filePath
 * @returns {object|null}
 */
function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * @param {string} url
 */
function normalizeFeedUrl(url) {
  return String(url || DEFAULT_FEED_URL).replace(/\/+$/, "");
}

/**
 * @param {{
 *   appPath: string,
 *   resourcesPath: string,
 *   isPackaged: boolean,
 *   pkg: {version: string, hemingVersion?: string},
 *   env?: NodeJS.ProcessEnv,
 * }} input
 */
function createConfig(input) {
  const { appPath, resourcesPath, isPackaged, pkg, env = process.env } = input;
  const generated = readJsonFile(path.join(appPath, "config", "generated.json")) || {};
  const payloadFileName = generated.payloadFileName || DEFAULT_PAYLOAD_FILE;
  const payloadDir = isPackaged ? path.join(resourcesPath, "payload") : path.join(appPath, "payload");
  return {
    hemingVersion: generated.hemingVersion || pkg.hemingVersion || pkg.version,
    semverVersion: generated.semverVersion || pkg.version,
    feedUrl: normalizeFeedUrl(generated.feedUrl || env.HEMING_UPDATE_FEED || DEFAULT_FEED_URL),
    /** "network"：从更新服务器取安装包；"embedded"：安装包就在自己体内（离线版） */
    payloadMode: generated.payload === "embedded" ? "embedded" : "network",
    payloadPath: path.join(payloadDir, payloadFileName),
    payloadSha512: generated.payloadSha512 || null,
    /** 内层安装器装完之后的大致体积（用于安装阶段的进度条），构建脚本实测后写入 */
    installedBytes: Number(generated.installedBytes) > 0 ? Number(generated.installedBytes) : 0,
  };
}

module.exports = {
  DEFAULT_FEED_URL,
  DEFAULT_PAYLOAD_FILE,
  createConfig,
  normalizeFeedUrl,
  readJsonFile,
};
