"use strict";
/**
 * 「装到哪」的判断全部集中在这里，方便单测与复用。
 *
 * 默认安装目录是 %LOCALAPPDATA%\Programs\Heming，两个理由：
 * - 必须是普通用户目录：D:\Heming 这类低完整性级别目录装进去会双击秒退且没有日志
 *   （见 docs/superpowers/specs/2026-11-07-installer-branding.md 第 7 节，踩过一次）；
 * - 目录名用 ASCII 的 Heming 而不是中文「和鸣」：安装后这个路径出现在启动参数、
 *   内置 Python 运行时和插件配置里，中文路径容易被外部工具按 GBK 处理成乱码。
 *
 * 安装器永远显式把目录传给内层 NSIS（/D=<dir>），所以这里的默认值就是「实际值」，
 * 不依赖 electron-builder 自己那套 APP_FILENAME 推导。
 */
const path = require("node:path");
const os = require("node:os");

/** 内层安装器装出来的主程序名（packages/desktop 的 win.executableName）。 */
const EXE_NAME = "Heming.exe";

/** 默认安装目录的末级名字。 */
const DEFAULT_DIR_NAME = "Heming";

/** 下载与日志的工作目录名（放在 TEMP 下，卸载后不留东西）。 */
const WORK_DIR_NAME = "heming-setup";

/**
 * 默认安装目录。读不到 LOCALAPPDATA 时返回 null，由调用方给用户提示。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string|null}
 */
function defaultInstallDir(env = process.env) {
  const localAppData = env.LOCALAPPDATA;
  if (!localAppData) return null;
  return path.join(localAppData, "Programs", DEFAULT_DIR_NAME);
}

/**
 * 下载、校验、日志共用的工作目录。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
function workDir(env = process.env) {
  return path.join(env.TEMP || env.TMP || os.tmpdir(), WORK_DIR_NAME);
}

/**
 * 安装器自身 exe 的路径。
 *
 * portable 目标启动时，程序被解到临时目录里跑，process.execPath 指向那份临时副本；
 * 用户实际双击的那个文件在 PORTABLE_EXECUTABLE_FILE。找「安装包同目录的离线安装包」
 * 时必须用后者，否则会在临时目录里乱找。
 * @returns {string}
 */
function setupExePath() {
  return process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
}

/** @returns {string} 安装器自身所在目录（用户双击的那一层）。 */
function setupExeDir() {
  return path.dirname(setupExePath());
}

/**
 * 判断文件名是否像「和鸣 Setup <5 段版本>.exe」。
 * 旧安装包、离线安装包、从官网下载的安装包都是这个名字，用来做本地兜底。
 * @param {string} name
 */
function isInstallerName(name) {
  return /^和鸣\s*Setup\s+.+\.exe$/i.test(name) || /^heming[\s_-]*setup.*\.exe$/i.test(name);
}

/**
 * 在给定文件列表里找可用的本地安装包（离线兜底）。
 * 纯函数：目录列举交给调用方，方便单测。
 * @param {string[]} entries 同目录下的文件名
 * @param {string} [selfName] 安装器自己的文件名，排除掉（免得把自己当内层安装包）
 * @returns {string|null} 命中的文件名
 */
function findLocalPayload(entries, selfName = "") {
  const candidates = entries
    .filter((name) => name !== selfName)
    .filter((name) => isInstallerName(name));
  if (candidates.length === 0) return null;
  // 同名多份时取版本号最大的那个：版本号是数字段，按段比较避免字符串排序把 d.9 排在 d.10 后面。
  return candidates.sort((a, b) => compareVersionText(a, b))[candidates.length - 1];
}

/**
 * 从文本里抽出版本号并按段比较（给 findLocalPayload 用）。
 * 抽不到版本号的文件名排在前面（视为旧包）。
 */
function compareVersionText(a, b) {
  const va = extractVersionParts(a);
  const vb = extractVersionParts(b);
  const len = Math.max(va.length, vb.length);
  for (let i = 0; i < len; i++) {
    const da = va[i] ?? -1;
    const db = vb[i] ?? -1;
    if (da !== db) return da - db;
  }
  return 0;
}

function extractVersionParts(name) {
  const m = /(\d+)\.(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?/.exec(name);
  if (!m) return [];
  return m.slice(1).filter((x) => x !== undefined).map(Number);
}

/**
 * 内层安装器装完后主程序的路径。
 * @param {string} installDir
 */
function installedExe(installDir) {
  return path.join(installDir, EXE_NAME);
}

/**
 * 规整用户给出的安装目录：
 * - NSIS 的 /D= 后面不能带引号，也不能带结尾反斜杠（结尾反斜杠会把参数吞掉）；
 * - 空串、盘符根目录（C:\）、带引号的路径一律拒绝，交给上层报错。
 * @param {string} dir
 * @returns {string|null} 规整后的路径；不可用时返回 null
 */
function sanitizeInstallDir(dir) {
  if (typeof dir !== "string") return null;
  let value = dir.trim();
  if (!value) return null;
  if (/["\r\n\t]/.test(value)) return null;
  // 去掉结尾的分隔符，但保留盘符根（C:\ 由下面的长度判断拒绝）
  value = value.replace(/[\\/]+$/, "");
  if (/^[A-Za-z]:$/.test(value)) return null;
  if (!path.isAbsolute(value)) return null;
  return value;
}

/**
 * 内层 NSIS 用普通用户权限安装时不需要 /D= 里带空格以外的处理，
 * 但 Node 的 spawn 在 windowsVerbatimArguments 下会原样拼命令行，
 * 所以路径里只要有空格仍然能工作（NSIS 允许 /D= 后面跟含空格的路径，只是不允许引号）。
 * 这里只做安全检查，不修改路径。
 * @param {string} cmdline
 */
function hasQuotedDArgument(cmdline) {
  return /\/D=.*["']/.test(cmdline);
}

module.exports = {
  EXE_NAME,
  DEFAULT_DIR_NAME,
  WORK_DIR_NAME,
  defaultInstallDir,
  workDir,
  setupExePath,
  setupExeDir,
  isInstallerName,
  findLocalPayload,
  installedExe,
  sanitizeInstallDir,
  hasQuotedDArgument,
};
