"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const { buildInstallArgs, buildInstallCommand, isSpawnSafePath } = require("./args");

test("buildInstallArgs 把 /D= 放在最后且不带引号", () => {
  const args = buildInstallArgs("C:\\Program Files\\Heming");
  assert.deepEqual(args, ["/S", "/NCRC", "/D=C:\\Program Files\\Heming"]);
  assert.equal(args[args.length - 1].startsWith("/D="), true);
  assert.equal(args[args.length - 1].includes('"'), false);
});

test("buildInstallArgs 拒绝空目录与带引号的目录", () => {
  assert.throws(() => buildInstallArgs(""), TypeError);
  assert.throws(() => buildInstallArgs("   "), TypeError);
  assert.throws(() => buildInstallArgs('C:\\Program "Files"\\Heming'), /引号/);
  assert.throws(() => buildInstallArgs("C:\\O'Brien"), TypeError);
});

test("buildInstallCommand 带上 windowsVerbatimArguments，否则 /D= 会失效", () => {
  const command = buildInstallCommand("C:\\Temp\\heming-setup\\inner-setup.exe", "D:\\Programs\\Heming");
  assert.equal(command.file, "C:\\Temp\\heming-setup\\inner-setup.exe");
  assert.deepEqual(command.args, ["/S", "/NCRC", "/D=D:\\Programs\\Heming"]);
  assert.equal(command.options.windowsVerbatimArguments, true);
  assert.equal(command.options.windowsHide, true);
});

test("isSpawnSafePath 拒绝带空格的 exe 路径", () => {
  assert.equal(isSpawnSafePath("C:\\Temp\\inner-setup.exe"), true);
  assert.equal(isSpawnSafePath("C:\\Program Files\\inner-setup.exe"), false);
  assert.equal(isSpawnSafePath(""), false);
  assert.equal(isSpawnSafePath(undefined), false);
});
