"use strict";
const { mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { readWidgetTheme, writeWidgetTheme, normalizeTheme } = require("./widget-theme");

test("normalizeTheme：只认 dark，其余一律 light", () => {
  assert.equal(normalizeTheme("dark"), "dark");
  assert.equal(normalizeTheme("light"), "light");
  assert.equal(normalizeTheme("DARK"), "light");
  assert.equal(normalizeTheme(undefined), "light");
  assert.equal(normalizeTheme({ theme: "dark" }), "light");
});

test("写后读回；目录不存在会自动建", () => {
  const root = mkdtempSync(join(tmpdir(), "widget-theme-"));
  try {
    const file = join(root, "nested", "widget-theme.json");
    assert.equal(writeWidgetTheme(file, "dark"), "dark");
    assert.equal(readWidgetTheme(file), "dark");
    assert.equal(writeWidgetTheme(file, "light"), "light");
    assert.equal(readWidgetTheme(file), "light");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("文件缺失 / 坏 JSON / 未知值：静默回落 light，不抛", () => {
  const root = mkdtempSync(join(tmpdir(), "widget-theme-"));
  try {
    assert.equal(readWidgetTheme(join(root, "missing.json")), "light");
    const broken = join(root, "broken.json");
    writeFileSync(broken, "{not json", "utf8");
    assert.equal(readWidgetTheme(broken), "light");
    const weird = join(root, "weird.json");
    writeFileSync(weird, JSON.stringify({ theme: "purple" }), "utf8");
    assert.equal(readWidgetTheme(weird), "light");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("写失败不抛（父路径是文件时）", () => {
  const root = mkdtempSync(join(tmpdir(), "widget-theme-"));
  try {
    const blocker = join(root, "blocker");
    writeFileSync(blocker, "x", "utf8");
    assert.doesNotThrow(() => writeWidgetTheme(join(blocker, "nested", "t.json"), "dark"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
