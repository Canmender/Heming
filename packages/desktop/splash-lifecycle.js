"use strict";
const {
  splashCloseDelayMs,
  isFatalLoadFailure,
  LOAD_WATCHDOG_MS,
} = require("./splash-config");

// 通知 web 端开始声波扩散段（BootWave）。preload 在隔离世界执行，故走 executeJavaScript
// 注入到主世界；web 端未就绪（无 window.heming）时静默无副作用。
const BOOT_WAVE_SNIPPET =
  "if (window.heming && window.heming.__startBootWave) window.heming.__startBootWave()";

/**
 * splash 生命周期接线（关闭时机 + 启动信号）。与 Electron 解耦：窗口/计时器全部注入，
 * 便于在 node:test 里用假窗口驱动真实行为（而不是断言源码字符串）。
 *
 * 时序（与 splash-config.js 的时间轴常量一致）：
 *   did-finish-load → 等满粒子聚拢段（splashCloseDelayMs）→ 关闭 splash + 触发声波扩散段。
 * 四条收尾路径都保证 splash 一定会被关掉：
 *   ① 正常：did-finish-load → 定时关闭 + 触发 BootWave
 *   ② 失败：主 frame did-fail-load（非 ERR_ABORTED）→ 直接关闭，露出错误页
 *   ③ 超时：LOAD_WATCHDOG_MS 内两者都没来 → 直接关闭
 *   ④ 用户关窗：主窗口 closed（此时 window-all-closed 不会触发，splash 还活着）
 *
 * 启动信号则必须在**每一次**文档加载时发送（见 onFinishLoad），不能随 splash 关闭一起摘掉。
 *
 * @param {object} deps
 * @param {object} deps.splash          已创建的 splash 窗口（show/close/isDestroyed/once/getBounds）
 * @param {object} deps.mainWin         主窗口（on/removeListener/isDestroyed/isVisible/show）
 * @param {() => number} deps.now       当前时间（ms）
 * @param {(fn: Function, ms: number) => any} deps.setTimer
 * @param {(id: any) => void} deps.clearTimer
 * @returns {{ abort: () => void }}
 */
function attachSplashLifecycle({ splash, mainWin, now, setTimer, clearTimer }) {
  // 第一段动画从 splash 创建即开始计时（splash.html 加载完成后立刻自播）。
  const splashStartedAt = now();
  let closeTimer = null;
  let watchdog = null;
  // 只表示「splash 何时关」已定，与「是否发启动信号」无关（后者每次加载都要发）。
  let splashSettled = false;

  const clearTimers = () => {
    if (closeTimer !== null) {
      clearTimer(closeTimer);
      closeTimer = null;
    }
    if (watchdog !== null) {
      clearTimer(watchdog);
      watchdog = null;
    }
  };

  // 派发启动信号：主窗口/webContents 已销毁时 executeJavaScript 会同步抛错，先守卫。
  const signalBootWave = () => {
    if (mainWin.isDestroyed() || mainWin.webContents.isDestroyed()) return;
    const res = mainWin.webContents.executeJavaScript(BOOT_WAVE_SNIPPET);
    if (res && typeof res.catch === "function") res.catch(() => {});
  };

  // 关闭 splash 并露出主窗口。主窗口以 show:false 创建（否则先于 splash 显示会闪白），
  // 故每条收尾路径都必须负责把它 show 出来。
  const closeSplash = () => {
    if (!splash.isDestroyed()) splash.close();
    if (!mainWin.isDestroyed() && !mainWin.isVisible()) mainWin.show();
  };

  // 正常路径：主窗口加载完成 → 补足粒子聚拢段时长 → 关闭 splash + 触发声波段
  function onFinishLoad() {
    if (splashSettled) {
      // 后续文档加载（视图 → 重新加载 / Ctrl+R）：渲染进程是全新文档，preload 的
      // bootStarted 归零、BootWave 重新挂载等待信号。splash 早已关闭，此处必须立刻
      // 重发信号；否则 BootWave 只能等 5s 兜底，白遮罩会盖住界面 ~6.3s。
      signalBootWave();
      return;
    }
    splashSettled = true;
    if (watchdog !== null) {
      clearTimer(watchdog);
      watchdog = null;
    }
    closeTimer = setTimer(() => {
      closeTimer = null;
      closeSplash();
      signalBootWave();
    }, splashCloseDelayMs(now() - splashStartedAt));
  }

  // 兜底路径（加载失败 / 看门狗超时）：无动画可播，直接露出主窗口
  const abortSplash = () => {
    if (splashSettled) return;
    splashSettled = true;
    clearTimers();
    closeSplash();
  };

  // 失败路径：子 frame 的 did-fail-load 不代表主页面失败；ERR_ABORTED(-3) 是后续导航
  // 主动取消旧请求，同样不算失败（详见 isFatalLoadFailure）。两者都放行，让启动动画继续。
  function onFailLoad(event, errorCode, errorDescription, validatedURL, isMainFrame) {
    if (!isFatalLoadFailure(errorCode, isMainFrame)) return;
    abortSplash();
  }

  // 用户在主窗口加载完成前关掉主窗口：splash 仍是一个 BrowserWindow，window-all-closed
  // 不会触发，若不主动关掉就会残留一个无任务栏入口的全屏置顶遮罩（只能任务管理器救场）。
  function onMainClosed() {
    abortSplash();
  }

  watchdog = setTimer(abortSplash, LOAD_WATCHDOG_MS);

  mainWin.webContents.on("did-finish-load", onFinishLoad);
  mainWin.webContents.on("did-fail-load", onFailLoad);
  mainWin.on("closed", onMainClosed);

  // splash 关闭后只需停掉定时器：did-finish-load 监听必须留着（每次重载都要重发信号），
  // 它随主窗口销毁一并回收。
  splash.once("closed", clearTimers);

  return { abort: abortSplash };
}

module.exports = { attachSplashLifecycle, BOOT_WAVE_SNIPPET };
