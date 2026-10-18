"use strict";
const path = require("node:path");

/**
 * 自定义协议 `app://` 的资源解析（纯函数，不依赖 electron，可直接单测）。
 *
 * 用途：桌面端把 web 构建产物打进安装包、本地加载，摆脱「UI 必须部署云端才可见」
 * 与「启动依赖网络」。**不能用 file://** —— file:// 不是安全上下文，crypto.subtle
 * 不可用会让 E2E 加密失效，而「无安全上下文拒绝发送」是项目红线。故走自定义协议
 * 并在 main.js 注册为 privileged + secure（实测 isSecureContext=true、ws:// 可连）。
 */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

const INDEX_FILE = "index.html";

/** 扩展名 → MIME；未知一律 application/octet-stream（不猜，避免把二进制当 HTML 执行）。 */
function contentTypeFor(filePath) {
  return MIME[path.extname(String(filePath)).toLowerCase()] || "application/octet-stream";
}

/**
 * 判定「资源请求」还是「前端路由」。
 * 有扩展名 = 资源（找不到就该 404，不能回落成 index.html——否则 JS 加载失败会被
 * 悄悄换成 HTML，报错变成 MIME 类型错误，极难排查）；无扩展名 = 前端路由，回落首页。
 */
function isAssetRequest(urlPath) {
  const p = String(urlPath || "");
  const last = p.split("/").pop() || "";
  return path.extname(last) !== "";
}

/**
 * URL 路径 → 磁盘绝对路径（含目录穿越防护）。
 * 越界（`..` 逃出 rootDir）返回 null，由调用方回 403。
 */
function resolveAssetPath(urlPath, rootDir) {
  let decoded;
  try {
    decoded = decodeURIComponent(String(urlPath || "/"));
  } catch {
    return null; // 非法百分号编码
  }
  // Windows 上反斜杠也是分隔符：先统一，再交给 path.resolve 判定
  const rel = decoded.replace(/\\/g, "/").replace(/^\/+/, "");
  const root = path.resolve(rootDir);
  const full = path.resolve(root, rel);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
}

/**
 * 解析一次请求最终要送哪个文件。
 *
 * @param {string} urlPath  请求的 URL 路径（如 "/"、"/assets/x.js"、"/chat"）
 * @param {string} rootDir  资源根目录
 * @param {(filePath: string) => boolean} exists  文件存在性判定（注入以便纯函数单测）
 * @returns {{ file: string, spaFallback: boolean } | null}
 *          null = 无法解析（越界或资源缺失），调用方回 403/404
 */
function resolveRequest(urlPath, rootDir, exists) {
  const target = resolveAssetPath(urlPath, rootDir);
  if (target === null) return null;

  const indexPath = path.join(path.resolve(rootDir), INDEX_FILE);

  // 根路径与无扩展名路径都是前端路由 → 直接首页
  if (target === path.resolve(rootDir) || !isAssetRequest(urlPath)) {
    return { file: indexPath, spaFallback: true };
  }
  if (exists(target)) return { file: target, spaFallback: false };
  // 资源缺失：**不回落**首页（回落会把 404 变成 MIME 错误）
  return null;
}

module.exports = { contentTypeFor, isAssetRequest, resolveAssetPath, resolveRequest, INDEX_FILE };
