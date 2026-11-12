"use strict";
/**
 * 应用内更新的「自绘安装器助手」。
 *
 * ## 为什么要有这个东西
 *
 * Windows 在程序运行时锁着它自己的文件，所以「安装时显示一个窗口」不能由
 * 正在运行的和鸣来做——那个窗口必须在应用退出之后还活着，只能是另一个进程。
 * 于是把 `packages/setup` 打出来的 portable 安装器作为助手塞进安装目录的
 * `resources/updater/setup.exe`，更新时由它接管：外观和首次安装完全一样，
 * 静默安装新版本，装完再把应用拉起来。
 *
 * ## 交接方式
 *
 * 主进程写一份计划 JSON（装哪个包、装到哪、装完是否拉起应用），然后用两个
 * 环境变量叫起助手：
 *
 *   HEMING_SETUP_UPDATE=1
 *   HEMING_SETUP_UPDATE_PLAN=<计划路径>
 *
 * 不走命令行参数：助手是 portable 单 exe，外壳会把参数重拼一次，带空格/中文
 * 的路径容易坏（细节见 `packages/setup/lib/update-plan.js` 的注释）。
 */

const path = require("node:path");

/** 与 `packages/setup/lib/update-plan.js` 的常量一字不差；跨包一致性由单测守着。 */
const PLAN_FILE_NAME = "update-plan.json";
const PLAN_ENV = "HEMING_SETUP_UPDATE_PLAN";
const UPDATE_ENV = "HEMING_SETUP_UPDATE";

/** 助手在安装目录里的位置：`<安装目录>/resources/updater/setup.exe`。 */
function helperPath(resourcesPath) {
  return path.join(resourcesPath, "updater", "setup.exe");
}

/**
 * 计划文件的路径。放在临时目录而不是安装目录：安装目录此时正被旧版本占用，
 * 而计划只是「这一次更新」的交接单，用完就该丢。
 */
function planPath(tempDir) {
  return path.join(tempDir, "heming-setup", PLAN_FILE_NAME);
}

/**
 * 组装计划内容。
 *
 * 路径缺失时返回 null——调用方据此回退到 electron-updater 自带的静默安装，
 * 而不是把一个半残的计划交给助手。
 */
function buildUpdatePlan({ installerPath, installDir, version, currentVersion, relaunch = true } = {}) {
  if (typeof installerPath !== "string" || !installerPath.trim()) return null;
  if (typeof installDir !== "string" || !installDir.trim()) return null;
  return {
    installerPath: path.resolve(installerPath),
    installDir: path.resolve(installDir),
    version: typeof version === "string" ? version : "",
    currentVersion: typeof currentVersion === "string" ? currentVersion : "",
    relaunch: relaunch !== false,
  };
}

/**
 * 助手进程的环境变量。
 *
 * 必须抹掉 `ELECTRON_RUN_AS_NODE`：助手自己也是 Electron 应用，
 * 宿主环境若带着这个变量（开发机、CI 里很常见），它会以 node 模式启动、
 * 直接报「找不到模块」退出——表现就是「点了重启并安装，什么都没发生」。
 */
function helperEnv(planFilePath, baseEnv = process.env) {
  const env = { ...baseEnv };
  delete env.ELECTRON_RUN_AS_NODE;
  env[UPDATE_ENV] = "1";
  env[PLAN_ENV] = planFilePath;
  return env;
}

module.exports = {
  PLAN_FILE_NAME,
  PLAN_ENV,
  UPDATE_ENV,
  helperPath,
  planPath,
  buildUpdatePlan,
  helperEnv,
};
