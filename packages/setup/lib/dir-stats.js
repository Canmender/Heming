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
 * - 有上限：异常目录结构下不至于卡死主进程；
 * - 便宜：实测 8000 个文件的 win-unpacked 逐文件 await stat 要 ~800ms，
 *   按旧节奏每 900ms 扫一遍等于把线程池一直占满、跟解压抢 IO。
 *   所以改成两段式：先只读目录项收集路径（很快），再用有界并发批量 stat。
 */

const fsp = require("node:fs/promises");
const path = require("node:path");
const { SetupError, CODES } = require("./errors");

/**
 * 批量跑 worker 的并发上限。Node 的 fs.stat 走 libuv 线程池（默认 4 线程），
 * 8 个在飞足够把线程池喂满，再高只是排队。
 */
const STAT_CONCURRENCY = 8;

/**
 * @typedef {{files: number, bytes: number, complete: boolean}} TreeStats
 */

/**
 * 以不超过 limit 的并发跑 worker；worker 自己吞掉单个文件的错误。
 * @param {string[]} items
 * @param {number} limit
 * @param {(item: string) => Promise<void>} worker
 */
async function mapLimit(items, limit, worker) {
  let next = 0;
  const runners = [];
  const count = Math.min(limit, items.length);
  for (let i = 0; i < count; i += 1) {
    runners.push(
      (async () => {
        while (next < items.length) {
          const index = next;
          next += 1;
          await worker(items[index]);
        }
      })(),
    );
  }
  await Promise.all(runners);
}

/**
 * 统计一棵目录树里普通文件的数量与总字节数。
 * @param {string} root
 * @param {{signal?: AbortSignal, maxFiles?: number}} [options]
 * @returns {Promise<TreeStats>}
 */
async function statTree(root, options = {}) {
  const { signal, maxFiles = 200000 } = options;
  /** @type {string[]} */
  const filePaths = [];
  /** @type {string[]} */
  const stack = [root];
  let truncated = false;

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
          filePaths.push(path.join(dir, entry.name));
          if (filePaths.length >= maxFiles) {
            truncated = true;
            break;
          }
        }
      }
    } catch {
      // 枚举过程中目录被删掉，继续统计剩下的
    }
    if (truncated) break;
  }

  let files = 0;
  let bytes = 0;
  await mapLimit(filePaths, STAT_CONCURRENCY, async (filePath) => {
    if (signal?.aborted) throw new SetupError(CODES.CANCELLED, "已取消", null);
    try {
      const stat = await fsp.stat(filePath);
      bytes += stat.size;
      files += 1;
    } catch {
      // 文件在统计过程中被替换（NSIS 的安装过程就是不断写文件），忽略即可
    }
  });

  return { files, bytes, complete: !truncated };
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

module.exports = { statTree, describeTree, STAT_CONCURRENCY };
