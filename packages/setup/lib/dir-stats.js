"use strict";
/**
 * 目录体积统计——安装进度唯一的真实信号。
 *
 * 静默安装期间拿不到 NSIS 的进度（解包是同步阻塞的，见
 * docs/superpowers/specs/2026-11-12-setup-installer.md），所以退而求其次：
 * 定时数一数 $INSTDIR 已经写进去多少文件、多少字节，用「已写入 12,304 个文件」
 * 这种真实读数安抚用户，而不是画一个假的百分比。
 *
 * 这个函数会在安装过程中被反复调用，必须：
 * - 容错：目录/文件随时可能被创建或删除，ENOENT 直接跳过；
 * - 可中断：用户取消时靠 signal 立即退出；
 * - 有上限：异常目录结构下不至于卡死主进程。
 */

const fsp = require("node:fs/promises");
const path = require("node:path");
const { SetupError, CODES } = require("./errors");

/**
 * @typedef {{files: number, bytes: number, complete: boolean}} TreeStats
 */

/**
 * 统计一棵目录树里普通文件的数量与总字节数。
 * @param {string} root
 * @param {{signal?: AbortSignal, maxFiles?: number}} [options]
 * @returns {Promise<TreeStats>}
 */
async function statTree(root, options = {}) {
  const { signal, maxFiles = 200000 } = options;
  let files = 0;
  let bytes = 0;
  /** @type {string[]} */
  const stack = [root];

  while (stack.length > 0) {
    if (signal?.aborted) throw new SetupError(CODES.CANCELLED, "已取消", null);
    const dir = stack.pop();
    let handle;
    try {
      handle = await fsp.opendir(dir);
    } catch {
      continue; // 目录还没被创建，或正在被 NSIS 改名
    }
    try {
      for await (const entry of handle) {
        if (signal?.aborted) throw new SetupError(CODES.CANCELLED, "已取消", null);
        if (entry.isDirectory()) {
          stack.push(path.join(dir, entry.name));
        } else if (entry.isFile()) {
          try {
            const stat = await fsp.stat(path.join(dir, entry.name));
            bytes += stat.size;
            files += 1;
          } catch {
            // 文件在统计过程中被替换（NSIS 的安装过程就是不断写文件），忽略即可
          }
        }
        if (files >= maxFiles) return { files, bytes, complete: false };
      }
    } catch {
      // 枚举过程中目录被删掉，继续统计剩下的
    }
  }
  return { files, bytes, complete: true };
}

/**
 * 给界面用的一行摘要。
 * @param {TreeStats} stats
 * @returns {string}
 */
function describeTree(stats) {
  const mb = (stats.bytes / (1024 * 1024)).toFixed(0);
  return `${stats.files} 个文件 · ${mb} MB`;
}

module.exports = { statTree, describeTree };
