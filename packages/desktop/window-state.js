"use strict";
// 桌面壳窗口状态记忆（最小实现，不引入 electron-window-state）：
// resize/move debounce 500ms 及关闭时把 bounds 写入 userData/window-state.json，
// 启动时读取并校验「结构合法 + 仍在某个可见显示区内」后才复用，
// 防止显示器拔掉后窗口不可见。
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_BOUNDS = Object.freeze({ width: 1280, height: 840 });
// 结构校验下限（防止损坏数据恢复出不可用窗口）
const MIN_WIDTH = 400;
const MIN_HEIGHT = 300;
// 至少要有这么多像素落在某个显示器工作区内才算「可见」
const MIN_VISIBLE_WIDTH = 100;
const MIN_VISIBLE_HEIGHT = 80;

function isValidBounds(bounds) {
  if (!bounds || typeof bounds !== "object") return false;
  const { x, y, width, height } = bounds;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return false;
  if (width < MIN_WIDTH || height < MIN_HEIGHT) return false;
  return true;
}

function visibleOverlap(bounds, workArea) {
  const left = Math.max(bounds.x, workArea.x);
  const top = Math.max(bounds.y, workArea.y);
  const right = Math.min(bounds.x + bounds.width, workArea.x + workArea.width);
  const bottom = Math.min(bounds.y + bounds.height, workArea.y + workArea.height);
  return { width: right - left, height: bottom - top };
}

// workAreas：[{x,y,width,height}]，通常来自 screen.getAllDisplays().map(d => d.workArea)。
// 传空数组视为「拿不到显示器信息」，不拦截（只做结构校验）。
function isOnVisibleDisplay(bounds, workAreas) {
  if (!Array.isArray(workAreas) || workAreas.length === 0) return true;
  return workAreas.some((area) => {
    if (!area || !Number.isFinite(area.x) || !Number.isFinite(area.y)) return false;
    if (!Number.isFinite(area.width) || !Number.isFinite(area.height)) return false;
    const overlap = visibleOverlap(bounds, area);
    return overlap.width >= MIN_VISIBLE_WIDTH && overlap.height >= MIN_VISIBLE_HEIGHT;
  });
}

function isUsableBounds(bounds, workAreas) {
  return isValidBounds(bounds) && isOnVisibleDisplay(bounds, workAreas);
}

// 读取失败（文件缺失/损坏/越界）一律回落默认尺寸；默认不含 x/y，由系统定位。
function loadWindowState(filePath, workAreas) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    const bounds = parsed && typeof parsed === "object" && parsed.bounds ? parsed.bounds : parsed;
    if (isUsableBounds(bounds, workAreas)) {
      return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
    }
  } catch {
    // 缺文件或 JSON 损坏：回落默认
  }
  return { ...DEFAULT_BOUNDS };
}

function saveWindowState(filePath, bounds) {
  try {
    if (!isValidBounds(bounds)) return false;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify(
        { bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } },
        null,
        2
      ) + "\n",
      "utf8"
    );
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  DEFAULT_BOUNDS,
  MIN_WIDTH,
  MIN_HEIGHT,
  MIN_VISIBLE_WIDTH,
  MIN_VISIBLE_HEIGHT,
  isValidBounds,
  isOnVisibleDisplay,
  isUsableBounds,
  loadWindowState,
  saveWindowState,
};
