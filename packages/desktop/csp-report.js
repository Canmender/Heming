"use strict";
// =============================================================================
// CSP 违例上报（d.168 从 main.js 抽出来，给冒烟与单测共用同一份实现）
// -----------------------------------------------------------------------------
// 为什么不是「在 main.js 里留着就行」：
//   这一段此前**只有实现、没有测试**——真实的 Chromium 违例消息长什么样、两代
//   `console-message` 签名怎么兼容、去重与滚动截断有没有生效，全靠读代码相信。
//   抽成模块之后：①main.js 只负责「文件路径 + 挂到窗口」；②`csp-report.test.js`
//   用假 webContents 打两种签名；③真机冒烟用真实 Chromium 违例打一次，
//   确认「浏览器 → 主进程 → 文件」这条链真的通。
//
// 隐私约定（不是可选项）：只落 `directive / blocked / source` 三个字段，
// 绝不写页面内容、绝不写整条 console 消息——内联脚本/样式的违例消息里可能夹带片段。
// =============================================================================
const fs = require("node:fs");
const path = require("node:path");

const { parseCspViolation } = require("./app-protocol.js");

/** 单文件上限：超过就从空文件重新写，避免长期运行把磁盘吃满。 */
const CSP_REPORT_LOG_MAX_BYTES = 256 * 1024;
/** 去重表上限：超过后不再记新种类，防止被刷爆。 */
const CSP_REPORT_MAX_DEDUPE = 500;

/** 一行日志的形状（导出给测试钉格式；不含任何页面内容）。 */
function formatCspReportLine(violation, iso = new Date().toISOString()) {
  return (
    `[${iso}] directive=${violation.directive} ` +
    `blocked=${violation.blockedUri} source=${violation.source || "inline"}:${violation.line}\n`
  );
}

/**
 * 创建上报器。
 *
 * @param {object} opts
 * @param {string} opts.file 日志文件绝对路径
 * @param {number} [opts.maxBytes]
 * @param {number} [opts.maxDedupe]
 * @param {() => string} [opts.iso] 时间戳来源（测试可注入）
 */
function createCspReporter(opts) {
  const file = opts && opts.file;
  if (!file) throw new Error("createCspReporter 需要 file");
  const maxBytes = Number.isFinite(opts.maxBytes) ? opts.maxBytes : CSP_REPORT_LOG_MAX_BYTES;
  const maxDedupe = Number.isFinite(opts.maxDedupe) ? opts.maxDedupe : CSP_REPORT_MAX_DEDUPE;
  const iso = typeof opts.iso === "function" ? opts.iso : () => new Date().toISOString();
  const seen = new Set();
  let written = 0;

  /** 记一条；重复或超上限返回 false（调用方不需要关心，返回值只为测试可断言）。 */
  function record(violation) {
    if (!violation || typeof violation !== "object") return false;
    const key = `${violation.directive}|${violation.blockedUri}|${violation.source}`;
    if (seen.has(key)) return false;
    if (seen.size >= maxDedupe) return false;
    seen.add(key);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      try {
        if (fs.statSync(file).size > maxBytes) fs.writeFileSync(file, "");
      } catch {
        /* 文件还不存在：第一次写入 */
      }
      fs.appendFileSync(file, formatCspReportLine(violation, iso()), "utf8");
      written += 1;
    } catch {
      /* 日志失败绝不影响界面：CSP 本身仍然生效 */
    }
    return true;
  }

  return {
    file,
    record,
    /** 收到过的不同违例种类数（去重后）。 */
    get seenCount() {
      return seen.size;
    },
    /** 真正写进文件的条数（去重、写失败都不算）。 */
    get writtenCount() {
      return written;
    },
  };
}

/**
 * 把上报器挂到 webContents 上。
 *
 * 兼容两代 `console-message` 签名：Electron 45 起是 `(event, details)`，
 * 旧的是 `(event, level, message, line, sourceId)`；两种都能取到要的字段。
 */
function attachCspReporter(webContents, reporter, opts = {}) {
  if (!webContents || !reporter) return null;
  const parse = typeof opts.parse === "function" ? opts.parse : parseCspViolation;
  const handler = (_event, detailsOrLevel, legacyMessage, legacyLine, legacySourceId) => {
    const isDetails = !!detailsOrLevel && typeof detailsOrLevel === "object";
    const message = isDetails ? detailsOrLevel.message : legacyMessage;
    const sourceId = isDetails ? detailsOrLevel.sourceId || "" : legacySourceId || "";
    const line = isDetails ? detailsOrLevel.lineNumber || 0 : legacyLine || 0;
    const violation = parse(message, sourceId, line);
    if (violation) reporter.record(violation);
  };
  webContents.on("console-message", handler);
  return handler;
}

module.exports = {
  CSP_REPORT_LOG_MAX_BYTES,
  CSP_REPORT_MAX_DEDUPE,
  createCspReporter,
  attachCspReporter,
  formatCspReportLine,
};
