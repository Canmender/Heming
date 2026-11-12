"use strict";
/**
 * 「更新助手」模式的任务计划。
 *
 * 应用内更新时，桌面端不再自己调 `quitAndInstall`，而是把「装哪个包、装到哪、
 * 装完要不要拉起应用」写成一个 JSON，然后用两个环境变量把这个安装器叫起来：
 *
 *   HEMING_SETUP_UPDATE=1
 *   HEMING_SETUP_UPDATE_PLAN=<计划文件路径>
 *
 * 为什么用文件而不是命令行参数：助手本身是 portable 单 exe，外壳（NSIS）会把
 * 收到的参数按自己的规则重新拼一次再转给内层应用；带空格、带中文的安装包路径
 * 在这种转发里很容易被拆坏（`/D=` 那条坑是同一个来源）。文件路径只有一个、
 * 且由我们自己写，跨进程更稳。
 */

const fs = require("node:fs");
const path = require("node:path");
const { CODES, SetupError } = require("./errors");

/** 计划文件名。桌面端 `packages/desktop/lib/update-helper.js` 里有同名常量，两边必须一致。 */
const PLAN_FILE_NAME = "update-plan.json";
/** 计划文件路径的环境变量名。 */
const PLAN_ENV = "HEMING_SETUP_UPDATE_PLAN";
/** 进入更新模式的环境变量名。 */
const UPDATE_ENV = "HEMING_SETUP_UPDATE";

/**
 * 这次启动是不是桌面端叫起来的「更新助手」。
 *
 * 环境变量优先：portable 外壳转发参数时可能把 `--update` 弄丢，
 * 而它一定会把环境变量原样传下去。
 */
function wantsUpdate(argv = process.argv, env = process.env) {
  const flag = env[UPDATE_ENV];
  if (flag === "1" || flag === "true") return true;
  return Array.isArray(argv) && argv.includes("--update");
}

/** 计划文件的默认位置：安装器的临时工作目录。 */
function planPath(workDir) {
  return path.join(workDir, PLAN_FILE_NAME);
}

/** 环境变量给了就用环境变量，否则用默认位置。 */
function resolvePlanPath(env = process.env, workDir) {
  const custom = env[PLAN_ENV];
  if (typeof custom === "string" && custom.trim()) return path.resolve(custom.trim());
  return planPath(workDir);
}

/**
 * 校验并归一化计划内容。
 *
 * 只接受绝对路径：安装器进程的 cwd 是它自己的临时目录，
 * 相对路径在这里没有意义，而且容易指到用户没预期的位置。
 */
function normalizePlan(raw) {
  if (!raw || typeof raw !== "object") return null;
  const installerPath = typeof raw.installerPath === "string" ? raw.installerPath.trim() : "";
  const installDir = typeof raw.installDir === "string" ? raw.installDir.trim() : "";
  if (!installerPath || !installDir) return null;
  if (!path.isAbsolute(installerPath) || !path.isAbsolute(installDir)) return null;

  const version = typeof raw.version === "string" ? raw.version.trim() : "";
  const currentVersion = typeof raw.currentVersion === "string" ? raw.currentVersion.trim() : "";
  return {
    installerPath: path.normalize(installerPath),
    // 这里只去尾部分隔符；盘符根之类的合法性交给 paths.sanitizeInstallDir 判断。
    installDir: installDir.replace(/[\\/]+$/, ""),
    version,
    currentVersion,
    // 默认「装完拉起应用」：用户点的是「重启并安装」，装完停在桌面不符合预期。
    relaunch: raw.relaunch !== false,
  };
}

/**
 * 读取计划文件。
 *
 * 失败一律抛 `no-payload`：这是「更新包/计划不见了」的同一类问题，
 * 界面上应给用户「重新下载」的出路，而不是把内部错误码甩出去。
 */
function readPlan(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    throw new SetupError(CODES.NO_PAYLOAD, "找不到更新计划，没法继续更新", {
      file: filePath,
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new SetupError(CODES.NO_PAYLOAD, "更新计划不是有效的 JSON", {
      file: filePath,
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  const plan = normalizePlan(raw);
  if (!plan) {
    throw new SetupError(CODES.NO_PAYLOAD, "更新计划缺少安装包或安装位置", { file: filePath });
  }
  return plan;
}

/** 用完就删：留着的旧计划会让下一次「手动双击安装器」看起来像更新。 */
function removePlan(filePath) {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // 删不掉不影响安装结果，留待用户下次覆盖
  }
}

module.exports = {
  PLAN_FILE_NAME,
  PLAN_ENV,
  UPDATE_ENV,
  wantsUpdate,
  planPath,
  resolvePlanPath,
  normalizePlan,
  readPlan,
  removePlan,
};
