"use strict";
/**
 * 应用数据根（d.133 用户要求）。
 *
 * 用户口径：「和鸣数据库默认指向安装目录，创建文件夹作为数据库，并在里面默认放入
 * 卡帕西的知识库规则」。
 *
 * 做法：
 * - 打包版默认 `<安装目录>/data`（安装目录随用户选择走，不占 C 盘用户目录）；
 * - `HEMING_DATA_ROOT` 可覆盖（便携/多实例/测试）；
 * - 开发态不改变默认 userData（避免把开发机的登录态写进仓库）；
 * - 首次启用新根时，把旧 userData 里的「登录态 / 插件 / 模块 / 窗口状态」拷过去，
 *   只补目标不存在的条目，绝不覆盖新根里已有数据；
 * - 知识库落在 `<data>/wiki`，并复制官方 LLM Wiki 规则（`resources/llm-wiki.md`）作为参考；
 *   标准的 raw/wiki/index/log/schema 结构由 `vault-fs.ensureStandardVault()` 幂等补齐。
 *
 * 本模块不 require electron，路径与文件操作都可注入，便于纯 node 单测。
 */

const fs = require("node:fs");
const path = require("node:path");

/** 首次迁移要从旧 userData 复制的条目（缓存/GPU 目录不搬）。 */
const MIGRATED_ENTRIES = [
  "Local Storage",
  "IndexedDB",
  "Session Storage",
  "Preferences",
  "Network",
  "Cookies",
  "Cookies-journal",
  "modules",
  "plugins",
  "model-backups",
  "window-state.json",
  "pet-state.json",
];

/**
 * 解析数据根。
 * @param {{isPackaged?: boolean, execDir?: string, env?: Record<string,string|undefined>}} [options]
 * @returns {string} 数据根绝对路径；空字符串 = 保持 Electron 默认 userData
 */
function resolveDataRoot(options = {}) {
  const env = options.env || process.env;
  const override = env.HEMING_DATA_ROOT;
  if (typeof override === "string" && override.trim()) return path.resolve(override.trim());
  if (!options.isPackaged) return "";
  const execDir = options.execDir || (process.execPath ? path.dirname(process.execPath) : "");
  if (!execDir) return "";
  return path.join(execDir, "data");
}

/**
 * 建数据根目录（data / wiki / logs）。
 * @param {string} root
 * @param {{fsImpl?: typeof fs}} [options]
 * @returns {{wikiRoot: string, logsDir: string}}
 */
function ensureDataLayout(root, options = {}) {
  const io = options.fsImpl || fs;
  const wikiRoot = path.join(root, "wiki");
  const logsDir = path.join(root, "logs");
  io.mkdirSync(wikiRoot, { recursive: true });
  io.mkdirSync(logsDir, { recursive: true });
  return { wikiRoot, logsDir };
}

/**
 * 首次迁移旧 userData → 新数据根。只补目标不存在的条目。
 * @param {string} oldDir
 * @param {string} newDir
 * @param {{fsImpl?: typeof fs, exists?: (p: string) => boolean}} [options]
 * @returns {string[]} 实际复制的条目名
 */
function migrateUserData(oldDir, newDir, options = {}) {
  const io = options.fsImpl || fs;
  const exists = options.exists || ((p) => fs.existsSync(p));
  const copied = [];
  if (!oldDir || !newDir || path.resolve(oldDir) === path.resolve(newDir)) return copied;
  if (!exists(oldDir)) return copied;
  io.mkdirSync(newDir, { recursive: true });
  for (const name of MIGRATED_ENTRIES) {
    const from = path.join(oldDir, name);
    const to = path.join(newDir, name);
    if (!exists(from) || exists(to)) continue;
    try {
      io.cpSync(from, to, { recursive: true, force: false, errorOnExist: false });
      copied.push(name);
    } catch {
      /* 单个条目迁移失败不应阻断启动：旧数据仍在原处 */
    }
  }
  return copied;
}

/**
 * 把官方 LLM Wiki 规则复制到 `<data>/wiki/llm-wiki.md`（只补缺，不覆盖用户编辑）。
 * @param {string} wikiRoot
 * @param {string} sourceFile 安装包内的参考文件
 * @param {{fsImpl?: typeof fs, exists?: (p: string) => boolean}} [options]
 * @returns {string} 目标文件路径（未复制也返回目标路径）
 */
function seedWikiRules(wikiRoot, sourceFile, options = {}) {
  const io = options.fsImpl || fs;
  const exists = options.exists || ((p) => fs.existsSync(p));
  const target = path.join(wikiRoot, "llm-wiki.md");
  if (!sourceFile || !exists(sourceFile) || exists(target)) return target;
  io.mkdirSync(wikiRoot, { recursive: true });
  io.copyFileSync(sourceFile, target);
  return target;
}

module.exports = {
  MIGRATED_ENTRIES,
  resolveDataRoot,
  ensureDataLayout,
  migrateUserData,
  seedWikiRules,
};
