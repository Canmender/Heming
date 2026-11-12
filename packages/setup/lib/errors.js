"use strict";
/**
 * 安装器内部的错误类型。
 *
 * 为什么要一个专门的错误类：主进程要按错误码决定「界面给什么按钮」
 * （可重试的断网 vs 需要人工处理的权限问题），而这些判断不能靠匹配错误文案。
 * code 是稳定的接口，message 是给用户的中文说明，detail 是给日志的原始信息。
 */

class SetupError extends Error {
  /**
   * @param {string} code 稳定错误码，见下面 CODES
   * @param {string} message 给用户看的一句话
   * @param {string|Error} [detail] 原始信息（进日志、错误页折叠显示）
   */
  constructor(code, message, detail) {
    super(message);
    this.name = "SetupError";
    this.code = code;
    this.detail = detail instanceof Error ? `${detail.name}: ${detail.message}` : detail || "";
  }
}

const CODES = {
  /** 更新服务器连不上 / 超时 */
  NETWORK: "network",
  /** latest.yml 结构不认识或没有可用安装包 */
  FEED_INVALID: "feed-invalid",
  /** 下载中断或写盘失败 */
  DOWNLOAD_FAILED: "download-failed",
  /** 长时间收不到数据 */
  DOWNLOAD_STALLED: "download-stalled",
  /** sha512 对不上 */
  HASH_MISMATCH: "hash-mismatch",
  /** 内层安装器进程起不来 */
  INSTALL_SPAWN_FAILED: "install-spawn-failed",
  /** 内层安装器返回非 0，或装完找不到主程序 */
  INSTALL_FAILED: "install-failed",
  /** 安装目录非法（带引号、盘符根目录等） */
  INVALID_DIR: "invalid-dir",
  /** 磁盘空间不足 */
  NO_SPACE: "no-space",
  /** 用户取消 */
  CANCELLED: "cancelled",
  /** 找不到安装包（既没网络也没有本地包） */
  NO_PAYLOAD: "no-payload",
  /** 程序自身用不了（缺配置、路径含空格等） */
  UNSUPPORTED: "unsupported",
};

/**
 * 把任意异常收敛成 SetupError，保证上层拿到的错误码不会是 undefined。
 * @param {unknown} error
 * @param {string} fallbackCode
 * @param {string} fallbackMessage
 * @returns {SetupError}
 */
function asSetupError(error, fallbackCode, fallbackMessage) {
  if (error instanceof SetupError) return error;
  return new SetupError(fallbackCode, fallbackMessage, error instanceof Error ? error : String(error));
}

module.exports = { SetupError, CODES, asSetupError };
