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

// ───────────────────────────── CSP 基线（P0-6，d.60） ─────────────────────────────
/**
 * `app://` 响应头里的 CSP（纯函数，便于单测）。
 *
 * ## 为什么在协议层加而不是 index.html 的 `<meta>`
 * web 交付有两条路径：云端 nginx 头 / 桌面 `app://` 响应头；dev（vite）**不设头**——
 * dev 下 `@vitejs/plugin-react` 会往 index.html 注入内联 preamble，任何 CSP meta
 * 都会当场把 HMR 弄挂，而 dev 不是交付形态。meta 还无法做 report-only 灰度。
 *
 * ## 豁免清单（每条都有据可查，不是「unsafe-inline 一把梭」）
 * - `style-src 'unsafe-inline'`：KaTeX 渲染输出自带 style 属性、26 处 React `style={{}}`
 *   （主题色/布局）、图表内联样式——这些都是既成事实，收掉需要给 KaTeX 加 nonce/hash（另立一轮）；
 * - `script-src` **绝不**加 `'unsafe-inline'` / `'unsafe-eval'`；但必须有 `'wasm-unsafe-eval'`：
 *   这是**硬证据**驱动的一条——① 代码高亮 shiki 用 oniguruma WASM 引擎
 *   （`createOnigurumaEngine(import("shiki/wasm"))`）；② PDF/Office 解析的 pdfjs 用 WASM 解图像；
 *   ③ 桌宠的 Live2D Cubism core（`public/pet/live2dcubismcore.min.js`）是 WASM。
 *   `'wasm-unsafe-eval'` 只放开 **WebAssembly 编译**，不放开 `eval` / `new Function`
 *   （全仓 `eval(` / `new Function` 源码 0 命中）——这正是它被设计出来的用途；
 * - `worker-src 'self' blob:`：pdfjs 的 module worker（同源 asset）与 blob 兜底；
 * - `img-src data: blob:` / `media-src blob:`：录音、图片预览、消息附件走 blob URL；
 * - `connect-src` 放 `https:` + `wss:` + 本机回环：模型供应商 `baseUrl`、MCP HTTP 服务、
 *   插件 Registry 都是**用户运行期配置**，静态头无法枚举。仍只挡「远程明文 http」，
 *   需要它的供应商请上 https 或用 `HEMING_WEB_URL`/`HEMING_CSP_CONNECT` 显式加来源。
 *
 * ## 灰度
 * `HEMING_CSP_MODE` = `off` | `report` | `enforce`，**桌面默认 `report`**（本轮先收集违例）。
 */
const CSP_HEADER = "Content-Security-Policy";
const CSP_REPORT_ONLY_HEADER = "Content-Security-Policy-Report-Only";
const CSP_MODES = ["off", "report", "enforce"];
/** 本轮默认 report-only：先观察一轮真实违例，再切 enforce。 */
const DEFAULT_CSP_MODE = "report";

/** 内置 API 源（与 `secure-origins.js` 的 APP_DEFAULT_URL、构建脚本的 DEFAULT_API 同源）。 */
const DEFAULT_API_ORIGIN = "http://47.92.39.184";

/** 本机回环来源：Ollama（11434）、magpie（3425）等本地模型/网关，端口不限。
 *
 * ★ 不用 `http://[::1]:*`：Chromium 的 CSP 语法**不接受 IPv6 字面量的端口通配**，
 *   实测会报 "contains an invalid source: 'http://[::1]:*'… ignored"（冒烟证据见
 *   docs/deploy.md §12.5）。只监听 IPv6 的本机服务，用 `HEMING_CSP_CONNECT` 显式加来源。
 */
const LOOPBACK_SOURCES = ["http://127.0.0.1:*", "http://localhost:*"];

/** TLS 通配来源：用户自建 https 代理 / MCP / Registry（见文件头「已知边界」）。 */
const TLS_SOURCES = ["https:", "wss:"];

/** 归一化灰度模式：未知值按默认（report）处理，不让一个拼错的 env 把 CSP 关掉。 */
function normalizeCspMode(value) {
  return CSP_MODES.includes(String(value || "").trim().toLowerCase())
    ? String(value).trim().toLowerCase()
    : DEFAULT_CSP_MODE;
}

/** 把 http(s) 源转换成同主机的 ws(s) 源；非法返回 null。 */
function wsOriginOf(origin) {
  try {
    const url = new URL(origin);
    if (url.protocol === "http:") return `ws://${url.host}`;
    if (url.protocol === "https:") return `wss://${url.host}`;
    return null;
  } catch {
    return null;
  }
}

/**
 * 生成一条 CSP 策略串（主窗口用）。
 *
 * @param {object} [opts]
 * @param {string} [opts.apiOrigin] 服务端源（缺省 `DEFAULT_API_ORIGIN`）
 * @param {string[]} [opts.extraConnect] 额外 connect-src 来源（运维用，来自 env）
 */
function buildCsp(opts = {}) {
  const apiOrigin = typeof opts.apiOrigin === "string" && opts.apiOrigin.trim()
    ? opts.apiOrigin.trim()
    : DEFAULT_API_ORIGIN;
  const connect = ["'self'", "app:", apiOrigin, wsOriginOf(apiOrigin), ...TLS_SOURCES, ...LOOPBACK_SOURCES]
    .filter(Boolean)
    .concat(Array.isArray(opts.extraConnect) ? opts.extraConnect.filter(Boolean) : []);
  const directives = [
    ["default-src", ["'self'", "app:"]],
    /*
     * ★ 主窗口：绝不放 'unsafe-inline' / 'unsafe-eval'；'wasm-unsafe-eval' 只放开 WASM 编译
     *   （shiki 代码高亮 oniguruma wasm / pdfjs 图像解码）。
     *
     * ★ 桌宠的 pixi 6 需要 'unsafe-eval'（`new Function` 生成着色器）；它已不在主窗，
     *   而是搬进 `widget://` 的界面插件，这条豁免跟着 widget CSP 走（见 buildWidgetCsp）。
     */
    ["script-src", ["'self'", "app:", "'wasm-unsafe-eval'"]],
    // ★ 唯一保留的 unsafe-inline：KaTeX / React style 属性 / 图表（理由见文件头）
    ["style-src", ["'self'", "app:", "'unsafe-inline'"]],
    ["img-src", ["'self'", "app:", "data:", "blob:"]],
    ["font-src", ["'self'", "app:", "data:"]],
    ["media-src", ["'self'", "app:", "blob:", "data:"]],
    ["worker-src", ["'self'", "blob:"]],
    ["connect-src", [...new Set(connect)]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'self'"]],
    ["frame-ancestors", ["'none'"]],
    ["form-action", ["'self'"]],
  ];
  return directives.map(([name, values]) => `${name} ${values.join(" ")}`).join("; ");
}

/**
 * 一次 `app://` 响应要带的 CSP 头（主窗口）。
 *
 * @param {string} urlPath 请求路径（保留参数：调用点多，主窗策略已不再按路径分叉）
 * @param {object} [opts]
 * @param {"off"|"report"|"enforce"} [opts.mode] 灰度模式
 * @returns {Record<string,string>} mode=off 时返回空对象（不加任何头）
 */
function cspHeadersFor(urlPath, opts = {}) {
  const mode = normalizeCspMode(opts.mode);
  if (mode === "off") return {};
  const policy = buildCsp({
    apiOrigin: opts.apiOrigin,
    extraConnect: opts.extraConnect,
  });
  const header = mode === "enforce" ? CSP_HEADER : CSP_REPORT_ONLY_HEADER;
  return { [header]: policy };
}

/* ─────────────────── 界面插件 `widget://` 的 CSP（d.98） ─────────────────── */
/*
 * 与主窗策略的三处**故意不同**（规格 §3.2）：
 * 1. `connect-src` **不继承** `https:` / `wss:` 通配：插件只能连本机回环 + 清单
 *    `permissions.network` 里逐个声明的主机。主窗需要的是"用户运行期配置的任意
 *    供应商"，插件需要的是"它自己声明过的那几个"。
 * 2. `'unsafe-eval'` 只在清单 `permissions.eval: true` 时放开（pixi 6 的着色器
 *    生成需要），并且只有第一方签名包才可能走到这里（安装端拒绝未签名 bundle）。
 * 3. `form-action 'none'` + `base-uri 'none'`：插件页没有表单提交与相对基址的正当用途。
 */

/** 把清单 `permissions.network` 的一项转成 CSP 来源；非法返回 null。 */
function widgetConnectSource(host) {
  if (typeof host !== "string") return null;
  const raw = host.trim().toLowerCase();
  if (!raw || raw.length > 253) return null;
  try {
    if (raw.includes("://")) {
      const url = new URL(raw);
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;
      return `${url.protocol}//${url.host}`;
    }
    return [`http://${raw}`, `https://${raw}`];
  } catch {
    return null;
  }
}

/**
 * 生成一个界面插件的 CSP 策略串。
 *
 * @param {{network?: string[], eval?: boolean}} [permissions] 清单里归一化后的 permissions
 */
function buildWidgetCsp(permissions = {}) {
  const permissionsObject = permissions && typeof permissions === "object" ? permissions : {};
  const script = ["'self'", "'wasm-unsafe-eval'"];
  if (permissionsObject.eval === true) script.push("'unsafe-eval'");

  const connect = ["'self'", ...LOOPBACK_SOURCES];
  for (const host of Array.isArray(permissionsObject.network) ? permissionsObject.network : []) {
    const source = widgetConnectSource(host);
    if (Array.isArray(source)) connect.push(...source);
    else if (source) connect.push(source);
  }

  const directives = [
    ["default-src", ["'self'"]],
    ["script-src", script],
    ["style-src", ["'self'", "'unsafe-inline'"]],
    ["img-src", ["'self'", "data:", "blob:"]],
    ["font-src", ["'self'", "data:"]],
    ["media-src", ["'self'", "blob:", "data:"]],
    ["worker-src", ["'self'", "blob:"]],
    ["connect-src", [...new Set(connect)]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'none'"]],
    ["frame-ancestors", ["'none'"]],
    ["form-action", ["'none'"]],
  ];
  return directives.map(([name, values]) => `${name} ${values.join(" ")}`).join("; ");
}

/**
 * 一次 `widget://` 响应要带的 CSP 头。
 *
 * @param {{network?: string[], eval?: boolean}} [permissions]
 * @param {{mode?: "off"|"report"|"enforce"}} [opts]
 */
function widgetCspHeaders(permissions = {}, opts = {}) {
  const mode = normalizeCspMode(opts.mode);
  if (mode === "off") return {};
  const header = mode === "enforce" ? CSP_HEADER : CSP_REPORT_ONLY_HEADER;
  return { [header]: buildWidgetCsp(permissions) };
}

/**
 * 解析一次 `widget://<id>/<path>` 的资源请求。
 *
 * 与 app:// 的区别：**不做 SPA 回落**（入口在清单里显式声明，回落只会把 404
 * 变成一块加载了错误内容的透明窗），并且永远不允许越出插件自己的版本目录。
 *
 * @param {string} urlPath URL 路径（如 `/files/index.html`）
 * @param {string} rootDir 插件版本目录（`<userData>/plugins/<id>/<version>`）
 * @param {(filePath: string) => boolean} exists
 * @returns {{ file: string, spaFallback: boolean } | null}
 */
function resolveWidgetRequest(urlPath, rootDir, exists) {
  const target = resolveAssetPath(urlPath, rootDir);
  if (target === null) return null;
  if (!exists(target)) return null;
  return { file: target, spaFallback: false };
}

/**
 * 解析一条 Chromium 的 CSP 违例 console 消息，**只提取元数据**。
 *
 * 为什么不整条落日志：console 消息可能夹带内联样式/脚本片段或页面路径，
 * 日志只需要「哪条指令拦了什么 URI、来自哪个文件」。字段一律截断到 200 字符。
 *
 * @returns {{directive:string, blockedUri:string, source:string, line:number}|null}
 *          非 CSP 消息返回 null
 */
function parseCspViolation(message, sourceId = "", line = 0) {
  const text = typeof message === "string" ? message : "";
  if (!/content security policy/i.test(text)) return null;
  const clip = (value) => String(value || "").slice(0, 200);
  /*
   * 指令名：Chromium 各版本/各 directive 的措辞不一，两种都要认——
   *   directive: "connect-src 'self' …"      （双引号 + 冒号）
   *   directive 'script-src 'self' …'        （单引号、无冒号）
   */
  const directiveMatch = /directive[:\s]+["']([^"']+)["']/i.exec(text);
  const directive = directiveMatch ? clip(directiveMatch[1].trim().split(/\s+/)[0]) : "unknown";
  const source = clip(sourceId || "");
  const lineNumber = Number.isFinite(Number(line)) ? Number(line) : 0;

  /*
   * 策略本身的告警（例如「某个来源写法非法，已忽略」）不是页面违例，
   * 但对排障很有用：单独记成 `blocked=invalid-source`（冒烟时正是靠它发现
   * `http://[::1]:*` 这种 Chromium 不认的写法）。
   */
  if (/contains an invalid source/i.test(text)) {
    return { directive, blockedUri: "invalid-source", source, line: lineNumber };
  }
  if (!/\bviolates\b/i.test(text)) return null; // 纯提示，不是违例

  /*
   * 被拦目标只在 `violates` **之前**那段里找：
   * 后半段是策略原文（如 `style-src 'self'`），全文匹配会把 `'self'` 当成被拦 URI。
   */
  const cutAt = text.search(/\bviolates\b/i);
  const head = cutAt > 0 ? text.slice(0, cutAt) : text;
  // 形如：Connecting to 'http://x' / Refused to load the script 'app://…' / Executing inline script /
  //      Fetch API cannot load http://x. Refused to connect because it violates …（渲染层重复报的一次）
  const blockedMatch = /'([^']+)'/.exec(head);
  const urlMatch = /(?:cannot load|load|connect to)\s+(https?:\/\/[^\s,，]+)/i.exec(head);
  // URL 后面紧跟句号/逗号时要去掉标点（不能把 `.` 排除在字符类外，否则域名里的点也没了）
  const rawUrl = urlMatch ? urlMatch[1].replace(/[.,;:]+$/, "") : "";
  const blockedUri = blockedMatch ? clip(blockedMatch[1]) : rawUrl ? clip(rawUrl) : "inline";
  return { directive, blockedUri, source, line: lineNumber };
}

module.exports = {
  contentTypeFor,
  isAssetRequest,
  resolveAssetPath,
  resolveRequest,
  INDEX_FILE,
  // CSP 基线（d.60）
  CSP_HEADER,
  CSP_REPORT_ONLY_HEADER,
  CSP_MODES,
  DEFAULT_CSP_MODE,
  DEFAULT_API_ORIGIN,
  LOOPBACK_SOURCES,
  TLS_SOURCES,
  normalizeCspMode,
  wsOriginOf,
  buildCsp,
  cspHeadersFor,
  // 界面插件 widget://（d.98）
  buildWidgetCsp,
  widgetCspHeaders,
  resolveWidgetRequest,
  parseCspViolation,
};
