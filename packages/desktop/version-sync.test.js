"use strict";
/**
 * 版本字段一致性：四处 package.json 必须同步，README 也不能落后。
 * 「每次修改都要 bump」靠自觉会漏，这里用测试卡一道。
 *
 * 覆盖三组规则：
 * 1. 同步 —— 根包 / desktop / web / server / shared 五处的 hemingVersion 与 version 一致，
 *    派生值（semver、Windows 四段）由 5 段算得；
 * 2. 只增不减 —— CHANGELOG 里每一条历史版本都必须 ≥ 它上面那条（时间倒序），
 *    任何一位数字都不能变小；
 * 3. 读取侧 —— app-version.js 必须真的读得到版本号（曾因路径写错恒返回 0.0.0）。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..", "..");
const readJson = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));

const rootPkg = readJson("package.json");
const desktopPkg = readJson("packages/desktop/package.json");
const webPkg = readJson("packages/web/package.json");
const serverPkg = readJson("packages/server/package.json");
const sharedPkg = readJson("packages/shared/package.json");

/** 参与同步的五个包（desktop 额外带 Windows 四段）。 */
const ALL_PKGS = [
  ["package.json（根）", rootPkg],
  ["packages/desktop", desktopPkg],
  ["packages/web", webPkg],
  ["packages/server", serverPkg],
  ["packages/shared", sharedPkg],
];

const CURRENT = desktopPkg.hemingVersion;
const m = /^([dmc])\.(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(CURRENT);
assert.ok(m, `hemingVersion 不是 5 段：${CURRENT}`);
const [, , FEATURE, BREAKING, REVISION, BUILD] = m;

test("五个包的 hemingVersion 全部一致", () => {
  for (const [label, pkg] of ALL_PKGS) {
    assert.equal(pkg.hemingVersion, CURRENT, `${label} 的 hemingVersion 与桌面包不一致`);
  }
});

test("五个包的 version（semver）全部一致且由 5 段派生", () => {
  // 只取前三位，**不带 -build.N**：semver 的 `-` 之后是 prerelease，
  // 带 -build.0 会被 electron-updater 判为预发布版并拒绝发布（不生成 latest.yml）。
  // 构建号仍在 hemingVersion 与 Windows 四段里，测试下面两条会守住。
  const expected = `${FEATURE}.${BREAKING}.${REVISION}`;
  for (const [label, pkg] of ALL_PKGS) {
    assert.equal(pkg.version, expected, `${label} 的 version 不是 ${CURRENT} 派生的 ${expected}`);
  }
});

test("semver 不能带构建号后缀（会让 electron-updater 拒绝发布）", () => {
  for (const [label, pkg] of ALL_PKGS) {
    assert.ok(
      !/-build\./.test(pkg.version),
      `${label} 的 version 含 -build.N：会被判为 prerelease，导致不生成 latest.yml`,
    );
  }
});

test("桌面包的 Windows 四段版本由 5 段派生", () => {
  assert.equal(desktopPkg.shortVersion, `${FEATURE}.${BREAKING}.${REVISION}.${BUILD}`);
  assert.equal(desktopPkg.shortVersionWindows, `${FEATURE}.${BREAKING}.${REVISION}.${BUILD}`);
});

test("app-version.js 能真的读到版本号（不是兜底的 0.0.0）", () => {
  const { appVersion } = require("./app-version.js");
  assert.equal(appVersion(), CURRENT, "appVersion() 与 package.json 不符——检查 require 路径");
});

test("README 顶部的当前版本与实际一致", () => {
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const shown = /\*\*当前版本\*\*：`([^`]+)`/.exec(readme)?.[1];
  assert.equal(shown, CURRENT, "README 版本号落后，请跑 bump-version.mjs");
});

test("【只增不减】CHANGELOG 历史版本号逐条不小于上一条", () => {
  const lines = readFileSync(join(root, "CHANGELOG.md"), "utf8").split(/\r?\n/);
  // 文档里时间倒序排列（新 → 旧），所以相邻两条应满足 前者 > 后者
  const versions = lines
    .map((l) => /^##\s+([dmc]\.\d+\.\d+\.\d+\.\d+)(?:-dev\.\d+)?/.exec(l)?.[1])
    .filter(Boolean);
  assert.ok(versions.length >= 2, "CHANGELOG 条目太少，这条规则暂时验证不了");
  for (let i = 0; i < versions.length - 1; i++) {
    const newer = versions[i];
    const older = versions[i + 1];
    assert.ok(
      compareParts(newer, older) > 0,
      `${older} → ${newer} 违反了「数字只增不减」：版本号只能往大的方向走`,
    );
  }
});

test("【只增不减】自 d.5.1.0.0 起（规则切换点）每一位数字都单调不减", () => {
  // 规则切换点：2026-10-19 起改为累积计数、低位不再归零。
  // 更早的条目沿用旧规则（feature 时低位归零，如 d.0.1.0.0 → d.1.0.0.0 把破坏位抹成 0），
  // 那是既成事实、也是历史记录，不追溯改写——改了等于伪造迭代历史。
  const SINCE = "d.5.1.0.0";
  const lines = readFileSync(join(root, "CHANGELOG.md"), "utf8").split(/\r?\n/);
  // 时间正序（旧 → 新），逐段比较：新版本的每一位都不能小于旧版本同一位
  const versions = lines
    .map((l) => /^##\s+([dmc]\.(\d+)\.(\d+)\.(\d+)\.(\d+))/.exec(l))
    .filter(Boolean)
    .map((x) => ({ raw: x[1], parts: [+x[2], +x[3], +x[4], +x[5]] }))
    .reverse()
    .filter((v) => compareParts(v.raw, SINCE) >= 0);
  if (versions.length < 2) return; // 切换点之后还没有两条，暂时验证不了
  for (let i = 1; i < versions.length; i++) {
    const prev = versions[i - 1];
    const cur = versions[i];
    for (const [index, name] of ["特性", "破坏", "修订", "构建"].entries()) {
      assert.ok(
        cur.parts[index] >= prev.parts[index],
        `${prev.raw} → ${cur.raw}：${name}位从 ${prev.parts[index]} 降到 ${cur.parts[index]}，违反「只增不减」`,
      );
    }
  }
});

/** 逐段比较 5 段版本号，返回 a-b（只比数字段，不看通道字母）。 */
function compareParts(a, b) {
  const pa = a.split(".").slice(1).map(Number);
  const pb = b.split(".").slice(1).map(Number);
  for (let i = 0; i < 4; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}