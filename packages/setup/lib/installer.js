"use strict";
/**
 * 启动内层 NSIS 安装器并等它退出。
 *
 * 两个关键点（都和 lib/args.js 里写的坑对应）：
 * - windowsVerbatimArguments: true —— 否则 /D= 会被 Node 加引号，目录参数静默失效；
 * - stdio: "ignore" —— 静默安装没有输出，也不需要控制台窗口。
 *
 * 退出码并不可全信：per-machine 升级时 NSIS 会自己 UAC 提权重启，
 * 父进程可能以 0 退出而实际没装（用户点了「否」）。所以调用方必须再确认
 * 主程序文件是否存在，不能只看退出码。
 */

const { spawn } = require("node:child_process");
const { SetupError, CODES } = require("./errors");

/**
 * @typedef {{code: number|null, signal: string|null}} InstallExit
 */

/**
 * 启动安装器。
 * @param {{file: string, args: string[], options?: {cwd?: string, env?: NodeJS.ProcessEnv}}} command
 * @returns {{child: import("node:child_process").ChildProcess, done: Promise<InstallExit>}}
 */
function startInstaller(command) {
  const { file, args, options = {} } = command;
  let child;
  try {
    child = spawn(file, args, {
      stdio: "ignore",
      windowsVerbatimArguments: true,
      windowsHide: true,
      cwd: options.cwd,
      env: options.env,
    });
  } catch (error) {
    throw new SetupError(CODES.INSTALL_SPAWN_FAILED, "无法启动安装程序", error);
  }

  const done = new Promise((resolve, reject) => {
    child.once("error", (error) => {
      reject(new SetupError(CODES.INSTALL_SPAWN_FAILED, "无法启动安装程序", error));
    });
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return { child, done };
}

/**
 * 结束安装器进程树。
 * taskkill 是 Windows 上唯一可靠的「连同子进程一起结束」的办法；
 * 静默安装期间 NSIS 会派生子进程（7z 解包、UAC 提权副本），只杀父进程会留下野进程。
 * @param {number} [pid]
 * @returns {Promise<void>}
 */
async function killInstallerTree(pid) {
  if (!pid) return;
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    try {
      const child = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      child.once("exit", finish);
      child.once("error", finish);
      setTimeout(finish, 3000);
    } catch {
      finish();
    }
  });
}

module.exports = { startInstaller, killInstallerTree };
