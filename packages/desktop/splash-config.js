"use strict";

// 启动动画时间轴（不可跳过，总长约 3s）：
//   0 ──1500ms──> 粒子聚拢段（splash.html 自播）
//   1500 ──200ms──> 静默间隔
//   1700 ──1300ms──> 声波扩散段（web 端 BootWave 揭示主界面）
//                      3000ms
const SPLASH_MS = 1500;
const GAP_MS = 200;
const WAVE_MS = 1300;
const BOOT_TOTAL_MS = SPLASH_MS + GAP_MS + WAVE_MS;

// 主窗口 did-finish-load 之后还需等多久才关闭 splash。
// 远端可能在 ~86ms 就加载完，若立刻关闭会截断粒子聚拢段（用户几乎看不到第一段动画），
// 故以「splash 已可见时长」倒推剩余等待：保证 splash 至少完整播满 SPLASH_MS + GAP_MS。
// 下限 200ms：远端加载本就慢（已等够）时也留一小段静默，避免 splash 与波纹硬切。
const SPLASH_CLOSE_MIN_MS = 200;
function splashCloseDelayMs(elapsedMs) {
  const elapsed = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
  return Math.max(SPLASH_CLOSE_MIN_MS, BOOT_TOTAL_MS - WAVE_MS - elapsed);
}

// 主窗口加载既未 did-finish-load 也未 did-fail-load 时的硬上限：
// 超时即关闭 splash 露出主窗口，杜绝 splash 永久遮挡。
const LOAD_WATCHDOG_MS = 8000;

// Chromium 的 net error code：ERR_ABORTED。用户/代码发起的新导航会取消在途请求，
// 此时也会抛 did-fail-load(-3)，但它不是「页面加载失败」。
const ERR_ABORTED = -3;

// did-fail-load 是否算「主页面加载失败」（决定要不要立刻收掉 splash 露出错误页）。
// 子 frame 失败不算（页面里的 iframe/子帧挂掉不代表主页面没加载出来）；ERR_ABORTED 不算。
function isFatalLoadFailure(errorCode, isMainFrame) {
  if (!isMainFrame) return false;
  return errorCode !== ERR_ABORTED;
}

// 是否显示启动动画 splash。
// HEMING_NO_SPLASH=1 时跳过（E2E/无头环境）；其余情况（含未设置）均显示。
function shouldShowSplash(env) {
  const e = env || process.env;
  return e.HEMING_NO_SPLASH !== "1";
}

// splash 窗口配置：铺满传入的显示器工作区（用 workArea 的 x/y/width/height，兼容多显示器
// 与主屏不在原点的情况；调用方传「主窗口所在显示器」的工作区，见 main.js），
// 无边框透明置顶，show:false + 白底 —— 先隐藏创建，待 splash.html 加载完成后再 show()，
// 避免白屏闪烁。
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

module.exports = {
  SPLASH_MS,
  GAP_MS,
  WAVE_MS,
  BOOT_TOTAL_MS,
  LOAD_WATCHDOG_MS,
  ERR_ABORTED,
  splashCloseDelayMs,
  isFatalLoadFailure,
  shouldShowSplash,
  splashWindowOptions,
};
