"use strict";
/**
 * 打包边界（d.86）：**插件包是独立产物，不随安装包分发**。
 *
 * 背景：信息采集 / magpie 网关这类插件由云端插件目录分发，用户自行下载安装。
 * 如果哪天有人把仓库根的 `plugins/` 加进 electron-builder 的 files / extraResources，
 * 安装包会悄悄变大、也违背「不携带他们」的产品约定。这条用例把边界钉在配置层：
 * 只看 `build.files` 与 `build.extraResources`，不解析打包产物。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const pkg = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf8"));
const build = pkg.build ?? {};

/** 收集所有会进安装包的来源路径（files + extraResources.from）。 */
function packagedSources() {
  const files = Array.isArray(build.files) ? build.files : [];
  const extras = Array.isArray(build.extraResources) ? build.extraResources : [];
  return [...files, ...extras.map((item) => (typeof item === "string" ? item : item.from))].filter(
    (item) => typeof item === "string",
  );
}

test("安装包不携带仓库根 plugins/ 目录（插件走云端分发）", () => {
  for (const source of packagedSources()) {
    assert.ok(
      !/(^|\/)plugins?(\/|$)/.test(source) && !source.startsWith("../plugins"),
      `packaging 不应包含插件目录：${source}`,
    );
  }
});

test("插件目录只存在于仓库根，且带发布说明（publish-plugin.mjs 是唯一入口）", () => {
  const publish = readFileSync(join(__dirname, "..", "..", "scripts", "publish-plugin.mjs"), "utf8");
  assert.match(publish, /HEMING_PLUGIN_DIR/);
  assert.match(publish, /plugins-catalog/);
});
