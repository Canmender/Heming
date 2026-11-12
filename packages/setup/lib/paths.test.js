"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
  EXE_NAME,
  defaultInstallDir,
  workDir,
  isInstallerName,
  findLocalPayload,
  installedExe,
  sanitizeInstallDir,
  hasQuotedDArgument,
} = require("./paths");

test("defaultInstallDir 走 LOCALAPPDATA 的普通用户目录，且末级是 ASCII", () => {
  const dir = defaultInstallDir({ LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" });
  assert.equal(dir, path.join("C:\\Users\\x\\AppData\\Local", "Programs", "Heming"));
  assert.equal(dir.endsWith("Heming"), true);
  assert.equal(defaultInstallDir({}), null);
});

test("workDir 放在 TEMP 下", () => {
  assert.equal(workDir({ TEMP: "C:\\Temp" }), path.join("C:\\Temp", "heming-setup"));
  assert.equal(workDir({ TMP: "D:\\Tmp" }), path.join("D:\\Tmp", "heming-setup"));
});

test("isInstallerName 认「和鸣 Setup <版本>.exe」与 heming-setup", () => {
  assert.equal(isInstallerName("和鸣 Setup d.135.3.54.7.exe"), true);
  assert.equal(isInstallerName("和鸣Setup d.1.0.0.0.exe"), true);
  assert.equal(isInstallerName("heming-setup-d.1.0.0.0.exe"), true);
  assert.equal(isInstallerName("inner-setup.exe"), false);
  assert.equal(isInstallerName("和鸣 Setup d.1.0.0.0.msi"), false);
});

test("findLocalPayload 排除自身并按版本段取最大", () => {
  const entries = [
    "和鸣 Setup d.135.3.54.7.exe",
    "和鸣 Setup d.140.0.1.0.exe",
    "和鸣 Setup d.9.9.9.9.exe",
    "notes.txt",
  ];
  assert.equal(findLocalPayload(entries, "和鸣安装程序 d.135.3.54.7.exe"), "和鸣 Setup d.140.0.1.0.exe");
  assert.equal(findLocalPayload(entries, "和鸣 Setup d.140.0.1.0.exe"), "和鸣 Setup d.135.3.54.7.exe");
  assert.equal(findLocalPayload(["notes.txt"]), null);
});

test("installedExe 指向 Heming.exe", () => {
  assert.equal(installedExe("D:\\Programs\\Heming"), path.join("D:\\Programs\\Heming", EXE_NAME));
});

test("sanitizeInstallDir 去结尾分隔符并拒绝危险路径", () => {
  assert.equal(sanitizeInstallDir("  D:\\Programs\\Heming  "), "D:\\Programs\\Heming");
  assert.equal(sanitizeInstallDir("D:\\Programs\\Heming\\\\"), "D:\\Programs\\Heming");
  assert.equal(sanitizeInstallDir("D:/Programs/Heming/"), "D:/Programs/Heming");
  assert.equal(sanitizeInstallDir(""), null);
  assert.equal(sanitizeInstallDir("   "), null);
  assert.equal(sanitizeInstallDir("C:\\"), null);
  assert.equal(sanitizeInstallDir("relative\\Heming"), null);
  assert.equal(sanitizeInstallDir('D:\\a"b'), null);
  assert.equal(sanitizeInstallDir(null), null);
});

test("hasQuotedDArgument 识别 /D= 后面被加引号的情况", () => {
  assert.equal(hasQuotedDArgument('inner-setup.exe /S /D="C:\\Program Files\\Heming"'), true);
  assert.equal(hasQuotedDArgument("inner-setup.exe /S /D=C:\\Programs\\Heming"), false);
});
