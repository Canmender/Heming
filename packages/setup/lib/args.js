"use strict";
/**
 * 内层 NSIS 安装器的命令行参数。
 *
 * 这里是整个包装层最容易踩坑的一处，写清楚为什么：
 *
 * 1. `/D=` 必须是**最后一个**参数，而且**不能用引号包起来**（即使路径里有空格）。
 *    NSIS 的解析器只认这种形式：`setup.exe /S /D=C:\Program Files\Heming`。
 *    Node 的 spawn 默认会给含空格的参数加引号，结果是 `/D="C:\..."`，
 *    NSIS 会静默忽略它、装到默认目录——用户选了目录却没生效。
 *    所以调用方必须用 windowsVerbatimArguments: true，让参数原样拼进命令行。
 *
 * 2. 同理，**exe 自己的路径里不能有空格**：verbatim 模式下 Node 不会给可执行文件
 *    路径加引号。下载时文件名固定成 inner-setup.exe 放在无空格的临时目录，
 *    就是为了这一点（见 lib/download 与 pipeline）。
 *
 * 3. `/NCRC` 跳过安装包自校验：外层已经校验过 sha512，重复校验只会拖慢启动几秒。
 */

/**
 * @param {string} installDir 已规整的绝对路径（见 paths.sanitizeInstallDir）
 * @returns {string[]}
 */
function buildInstallArgs(installDir) {
  if (typeof installDir !== "string" || !installDir.trim()) {
    throw new TypeError("installDir 不能为空");
  }
  if (/["']/.test(installDir)) {
    throw new TypeError("安装目录不能包含引号（NSIS 的 /D= 不接受引号）");
  }
  return ["/S", "/NCRC", `/D=${installDir}`];
}

/**
 * 校验「这个 exe 路径能否在 verbatim 模式里安全使用」。
 * @param {string} exePath
 * @returns {boolean}
 */
function isSpawnSafePath(exePath) {
  return typeof exePath === "string" && exePath.length > 0 && !/\s/.test(exePath);
}

/**
 * 生成 spawn 用的参数对象，把 windowsVerbatimArguments 一起带出来，
 * 避免调用方忘了这个开关。
 * @param {string} exePath
 * @param {string} installDir
 * @returns {{file: string, args: string[], options: {windowsVerbatimArguments: boolean, windowsHide: boolean}}}
 */
function buildInstallCommand(exePath, installDir) {
  return {
    file: exePath,
    args: buildInstallArgs(installDir),
    options: { windowsVerbatimArguments: true, windowsHide: true },
  };
}

module.exports = { buildInstallArgs, buildInstallCommand, isSpawnSafePath };
