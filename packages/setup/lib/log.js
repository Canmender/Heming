"use strict";
/**
 * 安装器日志。
 *
 * 为什么要自己写日志：这个程序在用户机器上出错时，界面只能给一句话，
 * 用户报问题必须能给出「到底哪一步失败」。日志放在工作目录（TEMP\heming-setup\setup.log），
 * 卸载后随临时目录清掉，不留隐私。
 *
 * 同步写：日志量极小（几十行），同步写换来的是崩溃前最后一行也能落盘。
 */

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_MAX_LINES = 80;

/**
 * @param {string} filePath
 * @param {{maxLines?: number}} [options]
 */
function createLog(filePath, options = {}) {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  /** @type {string[]} */
  const lines = [];

  const write = (level, message) => {
    const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
    const line = `${stamp} ${level.padEnd(5)} ${message}`;
    lines.push(line);
    while (lines.length > maxLines) lines.shift();
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.appendFileSync(filePath, `${line}\n`);
    } catch {
      // 日志写不进去不能影响安装本身
    }
  };

  return {
    path: filePath,
    info: (message) => write("INFO", message),
    warn: (message) => write("WARN", message),
    error: (message) => write("ERROR", message),
    /** 最近若干行，用于错误页的「详情」与用户反馈 */
    tail: () => lines.slice(),
  };
}

module.exports = { createLog, DEFAULT_MAX_LINES };
