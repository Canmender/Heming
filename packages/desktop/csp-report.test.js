"use strict";
// CSP 违例上报器（d.167）：把「只写元数据 + 去重 + 滚动截断 + 不炸界面」四条约定钉住。
//
// 为什么值得单独测：这段逻辑此前内联在 main.js 里，没有测试；它一旦写坏，
// 表现是「CSP 违例悄悄没了」或者「日志把页面内容写进磁盘」——两种都不会报错。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { EventEmitter } = require("node:events");

const {
  CSP_REPORT_LOG_MAX_BYTES,
  CSP_REPORT_MAX_DEDUPE,
  attachCspReporter,
  createCspReporter,
  formatCspReportLine,
} = require("./csp-report.js");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "heming-csp-"));
}

test("formatCspReportLine：只写 directive / blocked / source 三个字段，不带整条消息", () => {
  const line = formatCspReportLine(
    { directive: "script-src", blockedUri: "inline", source: "app://heming/index.html", line: 12 },
    "2026-11-16T00:00:00.000Z",
  );
  assert.equal(
    line,
    "[2026-11-16T00:00:00.000Z] directive=script-src blocked=inline source=app://heming/index.html:12\n",
  );
  // 内联脚本的违例消息里可能夹带片段：这里绝不能有 `=` 以外的正文回显
  assert.ok(!line.includes("<script"), "不能把页面内容写进日志");
});

test("createCspReporter：同一种违例只记一次（directive|blocked|source 去重）", () => {
  const dir = tempDir();
  const reporter = createCspReporter({ file: path.join(dir, "csp-report.log") });
  const violation = { directive: "script-src", blockedUri: "inline", source: "app://heming/", line: 3 };

  assert.equal(reporter.record(violation), true);
  assert.equal(reporter.record({ ...violation, line: 99 }), false, "行号不同也算同一种");
  assert.equal(reporter.record({ ...violation, blockedUri: "https://x.test/a.js" }), true);

  const lines = fs.readFileSync(reporter.file, "utf8").trimEnd().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(reporter.seenCount, 2);
  assert.equal(reporter.writtenCount, 2);
});

test("createCspReporter：去重表到上限后不再记新种类（防刷爆磁盘）", () => {
  const dir = tempDir();
  const reporter = createCspReporter({ file: path.join(dir, "csp-report.log"), maxDedupe: 2 });
  assert.equal(reporter.record({ directive: "a", blockedUri: "1", source: "s" }), true);
  assert.equal(reporter.record({ directive: "a", blockedUri: "2", source: "s" }), true);
  assert.equal(reporter.record({ directive: "a", blockedUri: "3", source: "s" }), false);
  assert.equal(reporter.seenCount, 2);
});

test("createCspReporter：文件超过上限时清空重写（不是无限追加）", () => {
  const dir = tempDir();
  const file = path.join(dir, "csp-report.log");
  fs.writeFileSync(file, "x".repeat(64), "utf8");
  const reporter = createCspReporter({ file, maxBytes: 16 });
  reporter.record({ directive: "script-src", blockedUri: "inline", source: "s", line: 1 });

  const text = fs.readFileSync(file, "utf8");
  // 截断的意义是「旧内容不无限累积」：新写的一行本身可能就比 maxBytes 长，所以判旧内容没了
  assert.ok(!text.includes("x".repeat(64)), "旧内容应被清空");
  assert.match(text, /directive=script-src/);
  assert.equal(text.trimEnd().split("\n").length, 1);
});

test("createCspReporter：目录不可写也不抛（日志失败不能影响界面）", () => {
  // 把一个文件当目录用：mkdir/append 必然失败
  const dir = tempDir();
  const blocker = path.join(dir, "blocker");
  fs.writeFileSync(blocker, "x", "utf8");
  const reporter = createCspReporter({ file: path.join(blocker, "nested", "csp-report.log") });

  assert.doesNotThrow(() => reporter.record({ directive: "a", blockedUri: "b", source: "c", line: 0 }));
  assert.equal(reporter.writtenCount, 0);
});

test("createCspReporter：非法入参不崩", () => {
  const reporter = createCspReporter({ file: path.join(tempDir(), "csp-report.log") });
  assert.equal(reporter.record(null), false);
  assert.equal(reporter.record("x"), false);
  assert.throws(() => createCspReporter(), /需要 file/);
});

test("attachCspReporter：兼容 Electron 45 的 (event, details) 签名", () => {
  const reporter = createCspReporter({ file: path.join(tempDir(), "csp-report.log") });
  const wc = new EventEmitter();
  attachCspReporter(wc, reporter);

  wc.emit("console-message", {}, {
    message:
      "Refused to execute inline script because it violates the following Content Security Policy directive: \"script-src 'self'\".",
    sourceId: "app://heming/index.html",
    lineNumber: 7,
  });

  const text = fs.readFileSync(reporter.file, "utf8");
  assert.match(text, /directive=script-src/);
  assert.match(text, /blocked=inline/);
  assert.match(text, /source=app:\/\/heming\/index.html:7/);
});

test("attachCspReporter：兼容旧 (event, level, message, line, sourceId) 签名", () => {
  const reporter = createCspReporter({ file: path.join(tempDir(), "csp-report.log") });
  const wc = new EventEmitter();
  attachCspReporter(wc, reporter);

  wc.emit(
    "console-message",
    {},
    2,
    "Refused to connect to 'https://evil.test/x' because it violates the following Content Security Policy directive: \"connect-src 'self'\".",
    5,
    "app://heming/app.js",
  );

  const text = fs.readFileSync(reporter.file, "utf8");
  assert.match(text, /directive=connect-src/);
  assert.match(text, /blocked=https:\/\/evil\.test\/x/);
  assert.match(text, /source=app:\/\/heming\/app\.js:5/);
});

test("attachCspReporter：非 CSP 消息不写（别把普通 console 日志当违例）", () => {
  const reporter = createCspReporter({ file: path.join(tempDir(), "csp-report.log") });
  const wc = new EventEmitter();
  attachCspReporter(wc, reporter);

  wc.emit("console-message", {}, { message: "[heming] ready", sourceId: "", lineNumber: 0 });
  assert.equal(reporter.writtenCount, 0);
  assert.equal(fs.existsSync(reporter.file), false);
});

test("attachCspReporter：缺 webContents 或 reporter 时返回 null，不挂监听", () => {
  assert.equal(attachCspReporter(null, {}), null);
  const wc = new EventEmitter();
  assert.equal(attachCspReporter(wc, null), null);
  assert.equal(wc.listenerCount("console-message"), 0);
});

test("常量与 main.js 的约定一致（256KB / 500 条）", () => {
  assert.equal(CSP_REPORT_LOG_MAX_BYTES, 256 * 1024);
  assert.equal(CSP_REPORT_MAX_DEDUPE, 500);
});
