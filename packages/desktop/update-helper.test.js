"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
  PLAN_FILE_NAME,
  PLAN_ENV,
  UPDATE_ENV,
  helperPath,
  planPath,
  buildUpdatePlan,
  helperEnv,
} = require("./update-helper");

test("助手位置：<resources>/updater/setup.exe", () => {
  assert.equal(helperPath("C:\\Programs\\Heming\\resources"), path.join("C:\\Programs\\Heming\\resources", "updater", "setup.exe"));
});

test("计划路径：临时目录下的 heming-setup/update-plan.json", () => {
  assert.equal(planPath("C:\\Users\\ADMIN\\AppData\\Local\\Temp"), path.join("C:\\Users\\ADMIN\\AppData\\Local\\Temp", "heming-setup", PLAN_FILE_NAME));
});

test("计划内容：缺安装包或安装位置就不生成计划", () => {
  assert.equal(buildUpdatePlan({}), null);
  assert.equal(buildUpdatePlan({ installerPath: "C:\\a.exe" }), null);
  assert.equal(buildUpdatePlan({ installDir: "C:\\Heming" }), null);
});

test("计划内容：路径归一、版本原样、默认装完拉起应用", () => {
  const plan = buildUpdatePlan({
    installerPath: "C:\\Temp\\和鸣 Setup d.1.2.3.4.exe",
    installDir: "C:\\Users\\ADMIN\\AppData\\Local\\Programs\\Heming",
    version: "d.1.3.0.0",
    currentVersion: "d.1.2.3.4",
  });
  assert.ok(plan);
  assert.equal(plan.installerPath, path.resolve("C:\\Temp\\和鸣 Setup d.1.2.3.4.exe"));
  assert.equal(plan.version, "d.1.3.0.0");
  assert.equal(plan.relaunch, true);
  assert.equal(buildUpdatePlan({ installerPath: "C:\\a.exe", installDir: "C:\\Heming", relaunch: false }).relaunch, false);
});

test("助手环境：带更新标记与计划路径，并抹掉会把它当 node 跑的变量", () => {
  const env = helperEnv("C:\\Temp\\plan.json", { ELECTRON_RUN_AS_NODE: "1", PATH: "C:\\Windows" });
  assert.equal(env[UPDATE_ENV], "1");
  assert.equal(env[PLAN_ENV], "C:\\Temp\\plan.json");
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(env.PATH, "C:\\Windows");
});

test("跨包常量：桌面端与安装器的计划文件名/变量名必须一致", () => {
  const setupPlan = require("../setup/lib/update-plan");
  assert.equal(setupPlan.PLAN_FILE_NAME, PLAN_FILE_NAME);
  assert.equal(setupPlan.PLAN_ENV, PLAN_ENV);
  assert.equal(setupPlan.UPDATE_ENV, UPDATE_ENV);
});
