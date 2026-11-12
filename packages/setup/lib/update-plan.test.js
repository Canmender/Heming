"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  PLAN_FILE_NAME,
  PLAN_ENV,
  UPDATE_ENV,
  wantsUpdate,
  planPath,
  resolvePlanPath,
  normalizePlan,
  readPlan,
} = require("./update-plan");
const { CODES } = require("./errors");

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "heming-plan-"));
  return dir;
}

test("更新模式：环境变量或 --update 任一命中就算更新", () => {
  assert.equal(wantsUpdate([], {}), false);
  assert.equal(wantsUpdate([], { [UPDATE_ENV]: "1" }), true);
  assert.equal(wantsUpdate([], { [UPDATE_ENV]: "true" }), true);
  assert.equal(wantsUpdate(["setup.exe", "--update"], {}), true);
  assert.equal(wantsUpdate(["setup.exe"], { [UPDATE_ENV]: "0" }), false);
});

test("计划文件：默认落在工作目录，环境变量可以覆盖", () => {
  assert.equal(planPath("C:\\Temp\\heming-setup"), path.join("C:\\Temp\\heming-setup", PLAN_FILE_NAME));
  const custom = path.join("D:\\work", "plan.json");
  assert.equal(resolvePlanPath({ [PLAN_ENV]: custom }, "C:\\Temp"), path.resolve(custom));
  assert.equal(resolvePlanPath({}, "C:\\Temp"), path.join("C:\\Temp", PLAN_FILE_NAME));
});

test("计划内容：缺安装包或安装位置就整份作废", () => {
  assert.equal(normalizePlan(null), null);
  assert.equal(normalizePlan({}), null);
  assert.equal(normalizePlan({ installerPath: "C:\\a.exe" }), null);
  assert.equal(normalizePlan({ installDir: "C:\\Heming" }), null);
  // 相对路径不接受：安装器自己的 cwd 是临时目录，相对路径没有意义
  assert.equal(normalizePlan({ installerPath: "a.exe", installDir: "C:\\Heming" }), null);
  assert.equal(normalizePlan({ installerPath: "C:\\a.exe", installDir: "Heming" }), null);
});

test("计划内容：归一化路径并默认装完拉起应用", () => {
  const plan = normalizePlan({
    installerPath: "C:\\Temp\\和鸣 Setup d.1.2.3.4.exe",
    installDir: "C:\\Users\\ADMIN\\AppData\\Local\\Programs\\Heming\\",
    version: " d.1.3.0.0 ",
    currentVersion: "d.1.2.3.4",
  });
  assert.ok(plan);
  assert.equal(plan.installerPath, path.normalize("C:\\Temp\\和鸣 Setup d.1.2.3.4.exe"));
  assert.equal(plan.installDir, "C:\\Users\\ADMIN\\AppData\\Local\\Programs\\Heming");
  assert.equal(plan.version, "d.1.3.0.0");
  assert.equal(plan.relaunch, true);

  assert.equal(normalizePlan({ installerPath: "C:\\a.exe", installDir: "C:\\Heming", relaunch: false }).relaunch, false);
});

test("读计划：文件不存在或 JSON 坏了都归为 no-payload", () => {
  const dir = tempDir();
  assert.throws(() => readPlan(path.join(dir, "missing.json")), (error) => error.code === CODES.NO_PAYLOAD);

  const broken = path.join(dir, "broken.json");
  fs.writeFileSync(broken, "{ nope", "utf8");
  assert.throws(() => readPlan(broken), (error) => error.code === CODES.NO_PAYLOAD);

  const empty = path.join(dir, "empty.json");
  fs.writeFileSync(empty, JSON.stringify({ installerPath: "C:\\a.exe" }), "utf8");
  assert.throws(() => readPlan(empty), (error) => error.code === CODES.NO_PAYLOAD);
});

test("读计划：正常计划原样读回", () => {
  const dir = tempDir();
  const file = path.join(dir, "plan.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      installerPath: "C:\\Temp\\setup.exe",
      installDir: "C:\\Programs\\Heming",
      version: "d.1.3.0.0",
      currentVersion: "d.1.2.3.4",
      relaunch: true,
    }),
    "utf8",
  );
  const plan = readPlan(file);
  assert.equal(plan.installerPath, path.normalize("C:\\Temp\\setup.exe"));
  assert.equal(plan.installDir, "C:\\Programs\\Heming");
  assert.equal(plan.version, "d.1.3.0.0");
  assert.equal(plan.currentVersion, "d.1.2.3.4");
  assert.equal(plan.relaunch, true);
});
