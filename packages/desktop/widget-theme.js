"use strict";
const fs = require("node:fs");
const path = require("node:path");

/**
 * 界面插件的主题记忆（d.94）：主进程把主窗最后一次发布的主题存下来，
 * 下次启动建 widget 窗口时先按它初始化，避免「应用是暗色、桌宠先亮一下再变暗」。
 *
 * 为什么主题要落盘而不是问主窗：主窗的浅/深色存在**渲染层** localStorage（`data-theme`），
 * 主进程读不到；而 widget 窗口可能在主窗之前就建好。主窗挂载后会把当前主题
 * `widgets:publish` 过来，这里只负责「上一次的答案」。
 *
 * 边界：纯外观，读失败/写失败都静默回落 light（不能因为一个 JSON 打不开就影响启动）。
 */

const THEME_FILE = "widget-theme.json";

function normalizeTheme(value) {
  return value === "dark" ? "dark" : "light";
}

/** @param {string} file @returns {"light"|"dark"} */
function readWidgetTheme(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return normalizeTheme(raw && raw.theme);
  } catch {
    return "light";
  }
}

/** @param {string} file @param {unknown} theme @returns {"light"|"dark"} 实际写入的值 */
function writeWidgetTheme(file, theme) {
  const next = normalizeTheme(theme);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ theme: next }) + "\n", "utf8");
  } catch {
    /* 只是外观记忆：写不进去就算了，不该冒泡成错误 */
  }
  return next;
}

module.exports = { readWidgetTheme, writeWidgetTheme, normalizeTheme, THEME_FILE };
