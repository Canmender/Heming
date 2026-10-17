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

module.exports = { APP_DEFAULT_URL, originOf, secureOrigins };
