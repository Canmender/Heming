"use strict";
/** 5 段版本解析与比较（node --test）。规则见 app-version.js 头注释。 */
const test = require("node:test");
const assert = require("node:assert/strict");

const { appVersionOf, compareVersions, parseVersion } = require("./app-version.js");

test("parseVersion：5 段通道版本", () => {
  assert.deepEqual(parseVersion("d.0.1.0.0"), {
    format: "modern",
    channel: "d",
    numbers: [0, 1, 0, 0],
    prerelease: null,
  });
  assert.deepEqual(parseVersion("m.0.0.0.2-dev.3"), {
    format: "modern",
    channel: "m",
    numbers: [0, 0, 0, 2],
    prerelease: 3,
  });
});

test("parseVersion：纯数字 5 段与旧 semver", () => {
  assert.equal(parseVersion("1.2.3.4.5").channel, null);
  assert.equal(parseVersion("1.2.3").format, "legacy");
  assert.equal(parseVersion("1.2.3-dev.4").prerelease, 4);
});

test("parseVersion：非法输入返回 null", () => {
  for (const bad of ["", "x.0.0.0.0", "1.2", "d.0.0.0", null, undefined, 42]) {
    assert.equal(parseVersion(bad), null, `期望 null：${String(bad)}`);
  }
});

test("compareVersions：5 段恒高于旧 semver（首次迁移不算降级）", () => {
  assert.ok(compareVersions("d.0.0.1.0", "0.0.1") > 0);
  assert.ok(compareVersions("0.0.1", "d.0.0.1.0") < 0);
});

test("compareVersions：同通道逐位比较数值", () => {
  assert.equal(compareVersions("d.0.1.0.0", "d.0.1.0.0"), 0);
  assert.ok(compareVersions("d.0.2.0.0", "d.0.1.0.0") > 0);
  assert.ok(compareVersions("d.0.1.0.0", "d.0.1.1.0") < 0); // 修订位也算
  assert.ok(compareVersions("d.0.1.0.1", "d.0.1.0.0") > 0); // 构建位
  assert.ok(compareVersions("d.1.0.0.0", "d.0.9.9.9") > 0); // 特性位权重高于后面所有位
});

test("compareVersions：预发版低于同数值正式版", () => {
  assert.ok(compareVersions("d.0.1.0.0-dev.1", "d.0.1.0.0") < 0);
  assert.ok(compareVersions("d.0.1.0.0-dev.2", "d.0.1.0.0-dev.1") > 0);
  assert.equal(compareVersions("d.0.1.0.0-dev.1", "d.0.1.0.0-dev.1"), 0);
});

test("compareVersions：通道不同或非法输入一律 0（视为无更新）", () => {
  assert.equal(compareVersions("d.0.1.0.0", "m.0.0.0.0"), 0);
  assert.equal(compareVersions("d.0.1.0.0", "乱码"), 0);
  assert.equal(compareVersions(undefined, "d.0.1.0.0"), 0);
});

test("appVersionOf：优先 5 段，其次 semver，最后兜底", () => {
  assert.equal(appVersionOf({ hemingVersion: "d.0.1.0.0", version: "0.1.0-build.0" }), "d.0.1.0.0");
  assert.equal(appVersionOf({ version: "0.0.1" }), "0.0.1");
  assert.equal(appVersionOf({}), "0.0.0");
  assert.equal(appVersionOf(null), "0.0.0");
});