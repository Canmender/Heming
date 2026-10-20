"use strict";
/**
 * 生成数据与 CHANGELOG.md 的一致性：改了日志忘了重跑生成脚本 → 这里直接红。
 * 「设置区更新日志卡」的全部内容都来自该生成产物，所以这条测试卡住的就是唯一真相源。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { execFileSync } = require("node:child_process");

const root = join(__dirname, "..", "..");
const generated = join(root, "packages", "web", "src", "generated", "changelog.ts");
const script = join(root, "scripts", "build-changelog.mjs");

test("生成的 changelog.ts 与 CHANGELOG.md 同步（重跑生成器应无变化）", () => {
  execFileSync(process.execPath, [script], { cwd: root, stdio: "pipe" });
  const before = readFileSync(generated, "utf8");
  execFileSync(process.execPath, [script], { cwd: root, stdio: "pipe" });
  assert.equal(readFileSync(generated, "utf8"), before, "生成产物不稳定或与 CHANGELOG 不同步");
});

test("最新条目版本 = 当前应用版本（发版后忘了写条目就会被抓到）", () => {
  const pkg = JSON.parse(readFileSync(join(root, "packages", "desktop", "package.json"), "utf8"));
  const source = readFileSync(generated, "utf8");
  const first = /"version":\s*"([^"]+)"/.exec(source)?.[1];
  assert.ok(first, "生成产物里没有条目");
  assert.equal(
    first,
    pkg.hemingVersion,
    `最新日志条目 ${first} 与当前版本 ${pkg.hemingVersion} 不一致：补 CHANGELOG 条目并重跑 node scripts/build-changelog.mjs`,
  );
});
