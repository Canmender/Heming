"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  formatBytes,
  formatSpeed,
  formatDuration,
  formatCount,
  percentOf,
} = require("./format");

test("formatBytes 用 1024 进制并在 100 以上收掉小数", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1023), "1023 B");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(1024 * 1024), "1.0 MB");
  assert.equal(formatBytes(100 * 1024 * 1024), "100 MB");
  assert.equal(formatBytes(1024 * 1024 * 1024), "1.0 GB");
  assert.equal(formatBytes(1024 ** 4), "1.0 TB");
  assert.equal(formatBytes(1024 ** 5), "1024 TB");
});

test("formatBytes 对非法值返回破折号", () => {
  assert.equal(formatBytes(-1), "—");
  assert.equal(formatBytes(NaN), "—");
  assert.equal(formatBytes("abc"), "—");
});

test("formatSpeed 只在正数时带 /s", () => {
  assert.equal(formatSpeed(0), "—");
  assert.equal(formatSpeed(-5), "—");
  assert.equal(formatSpeed(1024), "1.0 KB/s");
  assert.equal(formatSpeed(2.5 * 1024 * 1024), "2.5 MB/s");
});

test("formatDuration 的秒/分/时档位", () => {
  assert.equal(formatDuration(0), "");
  assert.equal(formatDuration(null), "");
  assert.equal(formatDuration(0.4), "");
  assert.equal(formatDuration(1), "剩 1 秒");
  assert.equal(formatDuration(59), "剩 59 秒");
  assert.equal(formatDuration(60), "剩 1 分");
  assert.equal(formatDuration(90), "剩 1 分 30 秒");
  assert.equal(formatDuration(3600), "剩 1 小时 0 分");
  assert.equal(formatDuration(3900), "剩 1 小时 5 分");
});

test("formatCount 加千分位", () => {
  assert.equal(formatCount(0), "0");
  assert.equal(formatCount(999), "999");
  assert.equal(formatCount(12304), "12,304");
  assert.equal(formatCount(1234567), "1,234,567");
  assert.equal(formatCount(-3), "0");
  assert.equal(formatCount("42"), "42");
});

test("percentOf 夹在 0–100，total 无效时返回 null", () => {
  assert.equal(percentOf(0, 100), 0);
  assert.equal(percentOf(50, 100), 50);
  assert.equal(percentOf(100, 100), 100);
  assert.equal(percentOf(150, 100), 100);
  assert.equal(percentOf(-5, 100), 0);
  assert.equal(percentOf(1, 0), null);
  assert.equal(percentOf(1, null), null);
  assert.equal(percentOf(1, "abc"), null);
});
