"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  DEFAULT_BOUNDS,
  isValidBounds,
  isOnVisibleDisplay,
  loadWindowState,
  saveWindowState,
} = require("./window-state");

const PRIMARY = { x: 0, y: 0, width: 1920, height: 1080 };
// 拔掉的外接屏（右侧 2560 宽）
const GONE_DISPLAY_X = 1920;

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "heming-ws-"));
  return path.join(dir, "window-state.json");
}

test("文件不存在时返回默认 1280x840", () => {
  const state = loadWindowState(tmpFile(), [PRIMARY]);
  assert.equal(state.width, DEFAULT_BOUNDS.width);
  assert.equal(state.height, DEFAULT_BOUNDS.height);
  assert.equal(state.x, undefined);
  assert.equal(state.y, undefined);
});

test("JSON 损坏时返回默认值", () => {
  const file = tmpFile();
  fs.writeFileSync(file, "{ not json", "utf8");
  const state = loadWindowState(file, [PRIMARY]);
  assert.equal(state.width, DEFAULT_BOUNDS.width);
});

test("结构非法（尺寸过小/非数字）时返回默认值", () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ bounds: { x: 10, y: 10, width: 80, height: 60 } }));
  assert.equal(loadWindowState(file, [PRIMARY]).width, DEFAULT_BOUNDS.width);
  fs.writeFileSync(file, JSON.stringify({ bounds: { x: 10, y: 10, width: "wide", height: 600 } }));
  assert.equal(loadWindowState(file, [PRIMARY]).width, DEFAULT_BOUNDS.width);
});

test("合法且在屏内的 bounds 原样恢复", () => {
  const file = tmpFile();
  const saved = { x: 120, y: 80, width: 1000, height: 700 };
  assert.equal(saveWindowState(file, saved), true);
  assert.deepEqual(loadWindowState(file, [PRIMARY]), saved);
});

test("窗口整体移到已拔显示器后不复用", () => {
  const file = tmpFile();
  // 右侧外接屏（1920..4480），拔掉后 primary 只到 1920
  saveWindowState(file, { x: GONE_DISPLAY_X + 200, y: 100, width: 1280, height: 840 });
  const state = loadWindowState(file, [PRIMARY]);
  assert.equal(state.width, DEFAULT_BOUNDS.width);
  assert.equal(state.x, undefined);
});

test("部分可见（露出 ≥100x80）仍复用", () => {
  const file = tmpFile();
  // 右边缘只露出 150x840
  const saved = { x: 1800, y: 100, width: 1280, height: 840 };
  saveWindowState(file, saved);
  assert.deepEqual(loadWindowState(file, [PRIMARY]), saved);
});

test("多显示器时任一屏可见即复用", () => {
  const file = tmpFile();
  const second = { x: 1920, y: 0, width: 2560, height: 1440 };
  const saved = { x: 2200, y: 200, width: 1440, height: 900 };
  saveWindowState(file, saved);
  assert.deepEqual(loadWindowState(file, [PRIMARY, second]), saved);
});

test("拿不到显示器信息（空数组）时只做结构校验", () => {
  const file = tmpFile();
  const saved = { x: 99999, y: 99999, width: 800, height: 600 };
  saveWindowState(file, saved);
  assert.deepEqual(loadWindowState(file, []), saved);
});

test("saveWindowState 对非法 bounds 拒绝写入", () => {
  const file = tmpFile();
  assert.equal(saveWindowState(file, { x: 0, y: 0, width: 10, height: 10 }), false);
  assert.equal(fs.existsSync(file), false);
});

test("isValidBounds / isOnVisibleDisplay 基本判定", () => {
  assert.equal(isValidBounds({ x: 0, y: 0, width: 1280, height: 840 }), true);
  assert.equal(isValidBounds({ x: 0, y: 0, width: 1280 }), false);
  assert.equal(isValidBounds(null), false);
  assert.equal(isOnVisibleDisplay({ x: 500, y: 500, width: 800, height: 600 }, [PRIMARY]), true);
  // 露出 90px 宽（< 100 阈值）不算可见
  assert.equal(
    isOnVisibleDisplay({ x: 1920 - 90, y: 100, width: 800, height: 600 }, [PRIMARY]),
    false
  );
});

test("saveWindowState 自动创建父目录", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "heming-ws-"));
  const file = path.join(dir, "nested", "deep", "window-state.json");
  assert.equal(saveWindowState(file, { x: 1, y: 2, width: 900, height: 700 }), true);
  assert.equal(fs.existsSync(file), true);
});
