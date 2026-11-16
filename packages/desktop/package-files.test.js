// 打包白名单自检（d.204）：main.js / preload.js 里 require 的本地文件，必须都在
// electron-builder 的 files 白名单里，否则打出来的 asar 缺文件 —— 用户双击就弹
// 「A JavaScript error occurred in main process: Cannot find module './xxx.js'」。
//
// 为什么会出这个事故（d.165.4.101 / d.164 各新增了一个被 require 的模块，但都没加进
// files 清单）：冒烟用的是未打包的 `electron .`，读的是磁盘上的源码，测不到 asar 里
// 缺文件；打包产物又从来没有人启动过。于是 r105/r106/r107 一路带着这个 bug 发了出去。
// 这条测试把「加了一个 require 就忘了加白名单」变成红灯。

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = __dirname;
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

/** files 白名单允许通配（如 `assets/**\/*`），所以匹配时要按 glob 语义判。 */
function isListed(rel) {
  return pkg.build.files.some((pattern) => {
    if (!pattern.includes("*")) return pattern === rel;
    const prefix = pattern.split("*")[0];
    return rel.startsWith(prefix);
  });
}

/** 从入口文件出发，递归收集所有 `require("./x")` 指向的本地模块。 */
function localRequires(entry) {
  const seen = new Set();
  const stack = [entry];
  while (stack.length > 0) {
    const rel = stack.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) continue;
    const source = fs.readFileSync(abs, "utf8");
    for (const match of source.matchAll(/require\(\s*["'](\.[^"']+)["']\s*\)/g)) {
      let target = match[1].replace(/^\.\//, "");
      if (!path.extname(target)) target += ".js";
      // package.json 由 electron-builder 自动带上，不需要写进 files。
      if (target === "package.json") continue;
      stack.push(target);
    }
  }
  return seen;
}

test("main.js 与 preload.js require 的本地文件都在打包白名单里", () => {
  const requires = new Set([...localRequires("main.js"), ...localRequires("preload.js")]);
  const missing = [...requires].filter((rel) => !isListed(rel)).sort();
  assert.deepEqual(
    missing,
    [],
    `这些文件被 require 了但不在 build.files 里，打出来的 asar 会缺它们：\n${missing.join("\n")}`,
  );
});

test("打包白名单里的文件都真实存在（别写了不存在的名字）", () => {
  const missing = pkg.build.files
    .filter((rel) => !rel.includes("*"))
    .filter((rel) => !fs.existsSync(path.join(root, rel)));
  assert.deepEqual(missing, [], `build.files 里这些文件不存在：${missing.join(", ")}`);
});

test("白名单包含这两个曾经漏过、导致应用起不来的文件", () => {
  // 这条用例是那次事故的墓碑：csp-report.js（d.165.4.101）与 shell-run.js（d.164）。
  for (const rel of ["csp-report.js", "shell-run.js"]) {
    assert.ok(isListed(rel), `${rel} 必须在 build.files 里`);
    assert.ok(fs.existsSync(path.join(root, rel)), `${rel} 必须真实存在`);
  }
});
