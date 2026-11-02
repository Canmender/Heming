"use strict";
// 安全上下文白名单（E2E 设计 §2.1）：crypto.subtle 仅安全上下文可用，生产是
// http://47.92.39.184 —— 需在加载页面前把这些 origin 声明为「视为安全」，否则
// 端到端加密无法初始化。
//
// 抽成独立模块（不依赖 electron）以便单测：main.js 是 Electron 入口，require 它会
// 触发 app.requestSingleInstanceLock() 等运行时副作用，无法在纯 node 测试里加载。
const APP_DEFAULT_URL = "http://47.92.39.184";

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

// 取「应用加载源 + 默认远程源 + 本地开发源」的 origin 去重，逗号拼接
// （appendSwitch 单参多 origin 用逗号分隔）。
function secureOrigins(env) {
  const e = env || process.env;
  const urls = [e.HEMING_WEB_URL, APP_DEFAULT_URL, e.HEMING_DEV_URL];
  const origins = [];
  for (const url of urls) {
    if (!url) continue;
    const o = originOf(url);
    if (o && !origins.includes(o)) origins.push(o);
  }
  return origins.join(",");
}

/* ─────────────────────────── IPC 调用来源守卫 ─────────────────────────── */

/**
 * 未授权调用的统一拒绝值。
 *
 * 注意 `sendSync` 通道（`secret:capabilities` 等）返回的不是这个对象而是 `null`：
 * 同步桥的调用方（preload）按「拿不到 = 不可用」处理，返回对象会让它把对象当
 * 能力表读，反而制造出奇怪的状态。见 `denyValueFor()`。
 */
const IPC_UNTRUSTED = Object.freeze({
  ok: false,
  code: "untrusted-sender",
  error: "未授权的调用来源",
});

/**
 * 判定一次 IPC 调用是否来自**主窗口**（唯一受信渲染进程）。
 *
 * 为什么要按通道再收一遍，而不是只靠 window 的导航拦截：
 * 桌宠窗口与主窗口**同源**（同一个 `app://heming`），共用同一份 preload 桥与
 * localStorage。只要桌宠 frame 被导航到远端页面（或主窗口被 XSS 注入脚本），
 * 它就能直接调 `__mcp_stdio`（拉起任意子进程）、`__heming_secrets`（解密预言机）、
 * `__heming_files`（写用户文件）。导航拦截是第一道，这里是第二道：**默认拒绝**，
 * 没接 `getMainWindow` 也拒绝（fail-closed，忘了接线不能变成放行）。
 *
 * @param {() => any} getMainWindow 返回当前主窗口（BrowserWindow|null）
 * @returns {(event: any) => boolean}
 */
function makeSenderCheck(getMainWindow) {
  return (event) => {
    try {
      const win = typeof getMainWindow === "function" ? getMainWindow() : null;
      if (!win) return false;
      if (typeof win.isDestroyed === "function" && win.isDestroyed()) return false;
      const sender = event && event.sender;
      if (!sender) return false;
      return sender === win.webContents;
    } catch {
      return false; // 取窗口/比较时抛错：当作不可信
    }
  };
}

/** 拒绝时的返回值：同步通道显式返回 null，其它通道返回结构化错误。 */
function denyValueFor(channel) {
  if (typeof channel !== "string") return IPC_UNTRUSTED;
  if (channel.startsWith("secret:") || channel.startsWith("update:")) return null;
  if (channel === "runtime:probe") return null;
  return IPC_UNTRUSTED;
}

/**
 * 给一批「只该由主窗口调」的 IPC 通道套上来源校验。
 *
 * 用法：把返回的门面当 `ipcMain` 传给各 register 函数——通道清单之外的通道
 * 原样透传（如 `app:version` 是 preload 顶层 sendSync，任何窗口都要能问版本）。
 *
 * @param {{handle: Function, on: Function}} ipcMain Electron ipcMain（或测试替身）
 * @param {{
 *   isTrusted: (event: any) => boolean,
 *   channels: Iterable<string>,
 *   denyValue?: (channel: string) => unknown,
 * }} options
 * @returns {{handle: Function, on: Function}}
 */
function guardIpc(ipcMain, options) {
  const isTrusted = (options && options.isTrusted) || (() => false);
  const channels = new Set((options && options.channels) || []);
  const denyValue = (options && options.denyValue) || denyValueFor;

  function isGuarded(channel) {
    return typeof channel === "string" && channels.has(channel);
  }

  return {
    handle(channel, listener) {
      if (!isGuarded(channel)) return ipcMain.handle(channel, listener);
      return ipcMain.handle(channel, (event, ...args) => {
        if (!isTrusted(event)) return denyValue(channel);
        return listener(event, ...args);
      });
    },
    on(channel, listener) {
      if (!isGuarded(channel)) return ipcMain.on(channel, listener);
      return ipcMain.on(channel, (event, ...args) => {
        if (!isTrusted(event)) {
          // sendSync 通道靠 event.returnValue 回值；异步通道上赋值可能抛，
          // 抛了也不影响「不执行 handler」这个安全结论。
          try {
            event.returnValue = denyValue(channel);
          } catch {
            /* 异步通道没有 returnValue，忽略 */
          }
          return undefined;
        }
        return listener(event, ...args);
      });
    },
  };
}

module.exports = {
  APP_DEFAULT_URL,
  originOf,
  secureOrigins,
  IPC_UNTRUSTED,
  makeSenderCheck,
  denyValueFor,
  guardIpc,
};
