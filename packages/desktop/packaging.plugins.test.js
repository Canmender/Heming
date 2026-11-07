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

test("界面插件（desktopWidget bundle）同样不随安装包分发（d.97）", () => {
  // 桌宠已从本体拆成 heming.pet 界面插件：入口/资源在独立 package.tgz 里，
  // 本体产物里不该再有 pet 资源，安装包也不该携带插件包或插件产物目录。
  for (const source of packagedSources()) {
    assert.ok(!/pet-widget/.test(source), `packaging 不应包含界面插件产物：${source}`);
    assert.ok(!/package\.tgz$/.test(source), `packaging 不应包含插件包：${source}`);
    assert.ok(!/plugins-catalog/.test(source), `packaging 不应包含发布目录：${source}`);
  }
  // 桌宠的渲染入口已删除：desktop 的 files 里只剩宿主运行时，没有 pet.html / pet.tsx
  const files = Array.isArray(build.files) ? build.files : [];
  assert.ok(!files.some((file) => /pet\.(html|tsx)/.test(file)), "本体不应再打包桌宠页面");
  // 宿主运行时必须有 widget 相关模块（缺了就是装完插件起不了窗）
  for (const required of ["plugin-window.js", "plugin-package.js", "plugin-store.js", "plugin-host.js", "widget-preload.js"]) {
    assert.ok(files.includes(required), `安装包应包含 ${required}`);
  }
});
