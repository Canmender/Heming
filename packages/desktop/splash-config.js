"use strict";

// 是否显示启动动画 splash。
// HEMING_NO_SPLASH=1 时跳过（E2E/无头环境）；其余情况（含未设置）均显示。
function shouldShowSplash(env) {
  const e = env || process.env;
  return e.HEMING_NO_SPLASH !== "1";
}

// splash 窗口配置：铺满主显示器工作区（用 workArea 的 x/y/width/height，兼容多显示器
// 主屏不在原点的情况），无边框透明置顶，show:false + 白底 —— 先隐藏创建，
// 待 splash.html 加载完成后再 show()，避免白屏闪烁。
function splashWindowOptions(workArea) {
  const area = workArea || { x: 0, y: 0, width: 800, height: 600 };
  return {
    x: area.x,
    y: area.y,
    width: area.width,
    height: area.height,
    show: false,
    backgroundColor: "#ffffff",
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    webPreferences: { offscreen: false },
  };
}

module.exports = { shouldShowSplash, splashWindowOptions };
