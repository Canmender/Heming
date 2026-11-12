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
const { readFileSync, existsSync } = require("node:fs");
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

test("安装包不携带插件源码目录（插件走云端分发）", () => {
  for (const source of packagedSources()) {
    assert.ok(
      !/(^|\/)plugins?(\/|$)/.test(source) && !source.startsWith("../plugins"),
      `packaging 不应包含插件目录：${source}`,
    );
    assert.ok(
      !/(^|[\\/])plugin-kit([\\/]|$)/.test(source),
      `packaging 不应包含插件工具包/源码：${source}`,
    );
  }
});

test("插件源码只在 plugin-kit/plugins，且发布走 publish-plugin.mjs", () => {
  const publish = readFileSync(join(__dirname, "..", "..", "scripts", "publish-plugin.mjs"), "utf8");
  assert.match(publish, /HEMING_PLUGIN_DIR/);
  assert.match(publish, /plugins-catalog/);
  assert.ok(existsSync(join(__dirname, "..", "..", "plugin-kit", "plugins")));
});

test("界面插件（desktopWidget bundle）同样不随安装包分发（d.98）", () => {
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
  for (const required of ["plugin-window.js", "plugin-package.js", "plugin-signature.js", "resources/official-keys.json", "resources/llm-wiki.md", "data-root.js", "plugin-store.js", "plugin-host.js", "plugin-engine.js", "widget-preload.js"]) {
    assert.ok(files.includes(required), `安装包应包含 ${required}`);
  }
});

test("modules 体系已下线：安装包不携带 web 模块运行时、实现目录与发布产物", () => {
  // 自动化/信息中枢已是沙箱 bundle 插件（plugin-kit/plugins，页面走 widget:// + 插件安装链路），
  // web 模块运行时（app:// 的 /modules/... 路由、modules:* IPC、module-installer）已整条删除。
  // 这里把「不回头」钉在配置层：谁把模块实现目录或旧安装器塞回打包清单，测试立刻红。
  for (const source of packagedSources()) {
    assert.ok(
      !/(^|[\\/])packages[\\/]modules([\\/]|$)/.test(source),
      `安装包不应携带模块实现目录：${source}`,
    );
    assert.ok(
      !/(^|[\\/])module-catalog([\\/]|$)/.test(source),
      `安装包不应携带模块发布目录：${source}`,
    );
    assert.ok(
      !/(^|[\\/])module-installer\.js$/.test(source),
      `安装包不应携带已删除的 web 模块安装器：${source}`,
    );
  }
});

test("信息中枢引擎装机链必须随安装包分发（选装 Python 引擎，permissions.infohub 依赖）", () => {
  // 引擎包本身不随安装包分发（d.116：首次启用时从更新源补下载）；但下载/验签/解包/定位
  // 这条装机链必须在本体里 —— 缺了安装版就装不上引擎，沙箱插件的 permissions.infohub 直接失效。
  // 该链路与已下线的 web 模块体系无关，是「选装 Python 引擎」的装机机制，别误删。
  const files = Array.isArray(build.files) ? build.files : [];
  for (const required of [
    "infohub-bridge.js",
    "infohub-engine.js",
    "module-package.js",
    "module-store.js",
    "module-download.js",
  ]) {
    assert.ok(files.includes(required), `安装包应包含引擎装机链：${required}`);
  }
  for (const source of packagedSources()) {
    assert.ok(
      !/(^|[\\/])infohub([\\/]|$)/.test(source),
      `安装包不应携带引擎源码目录：${source}`,
    );
  }
});
