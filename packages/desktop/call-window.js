"use strict";

/**
 * 独立通话窗口的入口判定与窗口参数（纯函数，可在 node:test 里直接断言）。
 *
 * 为什么需要主进程配合：渲染层的 `window.open()` 会被 `setWindowOpenHandler` 统一拦下
 * （默认全部 deny 并转系统浏览器）。通话窗口必须走 allow 分支，并套上「小、置顶、
 * 独立任务栏项」的窗口参数，否则会变成一个大号普通窗口挡在主界面前面。
 */

/** 通话窗口的 query 标记（与 packages/web/src/lib/callWindow.ts 的 hemingWindow 对齐）。 */
const CALL_WINDOW_FLAG = "hemingWindow=call";

/**
 * 是否为主窗口内部弹出的通话窗口。
 *
 * 判定条件（同时满足）：
 * - 与主窗口同一个应用源（`app://heming`，或部署版同源页面）——避免把外部网页当通话窗；
 * - query 里带 `hemingWindow=call`。
 *
 * @param {string} url 待打开的地址
 * @param {string} appOrigin 主窗口的应用源（如 `app://heming` 或 `http://47.92.39.184`）
 */
function isCallWindowUrl(url, appOrigin) {
  if (typeof url !== "string" || !url.includes(CALL_WINDOW_FLAG)) return false;
  if (typeof appOrigin !== "string" || !appOrigin) return false;
  if (appOrigin.startsWith("app://")) {
    // 自定义 scheme 的 origin 走不了 URL 解析，按「去掉 query/hash 后比对前缀」处理：
    // app://heming、app://heming/、app://heming/index.html 都算同源。
    const bare = appOrigin.replace(/\/$/, "");
    const base = url.split("?")[0].split("#")[0].replace(/\/$/, "");
    return base === bare || base.startsWith(bare + "/");
  }
  try {
    return new URL(url).origin === new URL(appOrigin).origin;
  } catch {
    return false;
  }
}

/** 通话窗口参数：窄竖窗、置顶、可缩放；父窗口关闭时不连带销毁（用户可能仍在通话）。 */
function callWindowOptions() {
  return {
    width: 420,
    height: 640,
    minWidth: 360,
    minHeight: 480,
    alwaysOnTop: true,
    backgroundColor: "#fafafa",
    title: "通话",
    autoHideMenuBar: true,
  };
}

module.exports = { CALL_WINDOW_FLAG, isCallWindowUrl, callWindowOptions };
