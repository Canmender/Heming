"use strict";
/**
 * 模型页 ↔ 内核命令桥的「接线守卫」（d.105）。
 *
 * 背景：命令桥曾因改动没有落进提交而在发布版里整段缺失——页面在桌面端也显示
 * 「仅桌面端可用」，所有管理操作不可用。这个测试直接读主进程与 preload 的源码，
 * 钉住「桥的两端都在」以及「通道都登记在 TRUSTED_CHANNELS」——任何一端丢失都会红。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const HERE = __dirname;
const read = (name) => readFileSync(join(HERE, name), "utf8");

test("preload 暴露 __heming_magpie 的六个命令桥方法", () => {
  const source = read("preload.js");
  assert.match(source, /exposeInMainWorld\("__heming_magpie"/);
  for (const method of ["status", "start", "stop", "gateway", "cli", "cliStart", "cliBegin", "cliInput", "cliKill", "openTerminal", "backupInfo", "backupPick", "onCli"]) {
    assert.match(source, new RegExp(`\\b${method}:`), `preload 缺少 ${method}`);
  }
});

test("主进程注册命令桥通道，且全部登记在 TRUSTED_CHANNELS", () => {
  const source = read("main.js");
  assert.match(source, /require\("\.\/magpie-cli"\)/);
  const trusted = source.match(/const TRUSTED_CHANNELS = \[([\s\S]*?)\];/);
  assert.ok(trusted, "main.js 必须有 TRUSTED_CHANNELS");
  const channels = [
    "magpie:cli",
    "magpie:cli:begin",
    "magpie:cli:start",
    "magpie:cli:input",
    "magpie:cli:kill",
    "magpie:terminal",
    "magpie:backup:info",
    "magpie:backup:pick",
  ];
  for (const channel of channels) {
    assert.match(trusted[1], new RegExp(`"${channel}"`), `${channel} 不在 TRUSTED_CHANNELS`);
    assert.match(
      source,
      new RegExp(`secureIpc\\.handle\\("${channel}"`),
      `${channel} 没有注册处理函数`,
    );
  }
});

test("命令桥使用白名单校验，不把参数拼进 shell", () => {
  const source = read("main.js");
  assert.match(source, /validateCliArgs\(args\)/);
  assert.match(source, /createMagpieCli\(/);
  assert.doesNotMatch(source, /exec(?:Sync)?\([^)]*args\.join/);
});
