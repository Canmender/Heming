"use strict";
const { app, BrowserWindow, Menu, Tray, nativeImage, dialog, shell, screen, ipcMain, Notification, protocol, net, WebContentsView } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadWindowState, saveWindowState } = require("./window-state");
const { shouldShowSplash, splashWindowOptions } = require("./splash-config");
const { attachSplashLifecycle } = require("./splash-lifecycle");
const {
  cspHeadersFor,
  normalizeCspMode,
  parseCspViolation,
  DEFAULT_API_ORIGIN,
  INDEX_FILE,
  resolveRequest,
  resolveWidgetRequest,
  contentTypeFor,
  widgetCspHeaders,
} = require("./app-protocol");
const { createPluginStore } = require("./plugin-store");
const { createModuleStore } = require("./module-store");
const { createWidgetHost } = require("./plugin-host");
const { readWidgetTheme, writeWidgetTheme } = require("./widget-theme");
const { WIDGET_SCHEME } = require("./plugin-window");
const { appVersion } = require("./app-version");
const { buildChildEnv, createStdioBridge } = require("./mcp-stdio");
const { createChildReclaimer } = require("./child-kill");
const { createMagpieHost, resolveBinaryPath } = require("./magpie-host");
const { startMagpieProxy } = require("./magpie-proxy");
const { createMagpieCli, validateCliArgs, terminalCommand } = require("./magpie-cli");
const { bundledPython } = require("./bundled-runtime");
const { planStdioSpawn, probeLocalRuntime } = require("./local-runtime");

/**
 * 本地开发（未打包）允许使用内置的 dev-* 首方公钥，否则界面插件在 `electron .` 下装不上。
 * 正式安装包不带这个环境变量 → `plugin-signature.js` 对「只有 dev-* 公钥」的表失败关闭，
 * 必须在 `resources/official-keys.json` 里换成正式公钥（见该文件 _rotate 说明）。
 */
if (!app.isPackaged && !process.env.HEMING_ALLOW_DEV_PLUGIN_KEYS) {
  process.env.HEMING_ALLOW_DEV_PLUGIN_KEYS = "1";
}

const pkg = require("./package.json");
const { APP_DEFAULT_URL, originOf, secureOrigins, guardIpc, makeSenderCheck } = require("./secure-origins");
const { titleBarOptions, WINDOW_BACKGROUND } = require("./title-bar");
const { registerWikiIpc } = require("./wiki-fs");
const { registerVaultIpc, readRegistry, defaultRegistryFile } = require("./vault-fs");
const { registerChartIpc } = require("./chart-fs");
const { registerExportIpc } = require("./export-fs");
const { registerFileIpc } = require("./file-fs");
const { registerSecretIpc } = require("./secret-store");
const { registerNotifyIpc } = require("./notify-bridge");
const { registerWorkflowHttpIpc } = require("./http-bridge");
const { createInfohubEngine } = require("./infohub-engine");
const { createInfohubBridge, registerInfohubIpc, resolveDefaultHome, resolveInfohubPackageDir } =
  require("./infohub-bridge");
const { crashLogDir, installCrashHandlers, attachRenderCrashRecovery } = require("./crash-log");

// Windows 系统通知要求进程 AUMID 与安装快捷方式一致（electron-builder 使用 build.appId）。
// 不设置时 Notification 可能静默不弹（本仓此前只有来电通知，未真机验证过）。
if (process.platform === "win32") {
  app.setAppUserModelId(pkg.build?.appId ?? "com.heming.app");
}

// ── web 界面嵌入（设计 §4）──────────────────────────────────────────────
// 产物打进安装包、用自定义协议本地加载，摆脱「UI 必须部署云端才可见」与「启动依赖网络」。
// 不能用 file://：它不是安全上下文，crypto.subtle 不可用会让 E2E 加密失效。
// 注册为 privileged + secure 后实测 isSecureContext=true 且明文 ws:// 仍可连
// （见设计文档 §3 的真实 Electron 实测表），且不需要放宽任何安全开关。
const EMBEDDED_SCHEME = "app";
const EMBEDDED_HOST = "heming";
const EMBEDDED_ORIGIN = `${EMBEDDED_SCHEME}://${EMBEDDED_HOST}`;
const EMBEDDED_URL = `${EMBEDDED_ORIGIN}/${INDEX_FILE}`;

// ── IPC 来源守卫（③-4 安全复审）─────────────────────────────────────────
// 只该由**主窗口**调用的通道清单：wiki/chart/export/file/secret/notify 这些
// 「能碰本机文件、进程与密钥」的能力，插件窗口一律不该能调。
// 界面插件（widget://）是**独立 origin + 独立最小 preload**，天然拿不到这些通道；
// 这里按通道再收一道：清单内通道只认 mainWindow，fail-closed。
// 不在清单里的通道（如 `app:version` 是 preload 顶层 sendSync）原样透传。
const TRUSTED_CHANNELS = [
  "wiki:info",
  "wiki:list",
  "wiki:read",
  "wiki:write",
  "wiki:remove",
  "wiki:log",
  // 原生知识库（多库 vault，d.114）：根只来自系统目录对话框，所有路径在主进程重新夹取。
  // 与 wiki:* 同级收口——同样能碰用户文件，只认主窗口。
  "vault:list",
  "vault:pick",
  "vault:remove",
  "vault:rename",
  "vault:tree",
  "vault:read",
  "vault:readBinary",
  "vault:write",
  "vault:apply",
  "vault:create",
  "vault:createDir",
  "vault:move",
  "vault:delete",
  "vault:reveal",
  "vault:watch",
  "vault:unwatch",
  "chart:export",
  "chart:list",
  "chart:open",
  "export:write",
  "export:info",
  "secret:available",
  "secret:encrypt",
  "secret:decrypt",
  "secret:capabilities",
  "secret:availableAsync",
  "secret:encryptAsync",
  "secret:decryptAsync",
  "secret:bootstrap",
  "secret:decryptMany",
  "secret:encryptMany",
  "notify:message",
  "workflow:http",
  "mcp:stdio:request",
  "mcp:stdio:stop",
  "runtime:probe",
  "modules:web-list",
  "update:check",
  "update:download",
  "update:install",
  "update:state",
  "infohub:info",
  "infohub:start",
  "infohub:call",
  "infohub:stop",
  "infohub:pick-home",
  "infohub:pick-python",
  "infohub:engine-info",
  "infohub:engine-ensure",
  "magpie:status",
  "magpie:start",
  "magpie:stop",
  "magpie:gateway",
  "magpie:cli",
  "magpie:cli:begin",
  "magpie:cli:start",
  "magpie:cli:input",
  "magpie:cli:kill",
  "magpie:terminal",
  "magpie:backup:info",
  "magpie:backup:pick",
  // ── 界面插件（desktopWidget · d.98）──
  // 这些是**主窗专用**的安装/启停/设置通道（widget 窗口永远碰不到：它不是 mainWindow，
  // 且 widget 自己的桥在 widget-preload.js 里，只有窗口动作与环境）。
  "widgets:list",
  "widgets:pickPackage",
  "widgets:install",
  "widgets:installFromFile",
  "widgets:uninstall",
  "widgets:setEnabled",
  "widgets:settingsGet",
  "widgets:settingsSet",
  "widgets:action",
  "widgets:state",
  "widgets:publish",
  "widgets:migrateLegacy",
  "widgets:chat-config-reply",
  // d.124 B 路径：插件自带页面的视图运行时（挂载/边界/卸载）。
  // 只认主窗口：页面 rect 与视图归属由主窗决定，插件窗口/页面视图自己都碰不到。
  "widgets:page-mount",
  "widgets:page-bounds",
  "widgets:page-unmount",
];

// ── 崩溃兜底（d.30 · P0-4）─────────────────────────────────────────────
// 此前主进程零兜底：抛一个未捕获异常就直接静默退出，用户只看到「应用莫名其妙没了」，
// 而本机没有任何日志可查。装上兜底后，未捕获异常/未处理的 promise 拒绝都会在
// ~/Heming/logs/ 留一份日志（版本号 + UTC 时间 + 异常信息），排查有据可依。
//
// ★ 必须在 app.whenReady() 之前装：启动早期（协议注册、单例锁、依赖加载）就可能抛，
//   装晚了会漏掉最需要排查的那一段。
//
// ★ 崩溃日志只写本机文件、绝不外发：日志里可能混着用户输入片段（异常 message 常带
//   用户数据），上报等于把个人数据送出设备。代价是拿不到崩溃遥测——个人工具不是
//   商业产品，可接受。详见 crash-log.js 文件头。
const CRASH_LOG_DIR = crashLogDir();
installCrashHandlers({
  appVersion: appVersion(),
  logDir: CRASH_LOG_DIR,
});
console.log("[heming] 崩溃日志目录:", CRASH_LOG_DIR);

// 必须在 app ready 之前注册，否则自定义协议拿不到 secure 语义。
// 两个 scheme：
// - `app://`：本体（主窗）的嵌入产物，与主窗同源；
// - `widget://`：界面插件，`widget://<pluginId>/…` **每个插件一个独立 origin**
//   （读不到 app://heming 的 localStorage：会话、记忆、偏好都在那边）。
protocol.registerSchemesAsPrivileged([
  {
    scheme: EMBEDDED_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
  {
    scheme: WIDGET_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
]);

/** 嵌入产物目录：打包后是 resources/web（electron-builder extraResources），开发时是 web-dist。 */
function webDistDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "web")
    : path.join(__dirname, "web-dist");
}

/** 嵌入产物是否可用。不可用则退回远程加载（老包/构建异常时不至于打不开）。 */
function hasEmbeddedWeb() {
  try {
    return fs.existsSync(path.join(webDistDir(), INDEX_FILE));
  } catch {
    return false;
  }
}

// 加载地址优先级：HEMING_DEV_URL（本地开发）> HEMING_WEB_URL > 嵌入式产物 > 默认远程
function resolveAppUrl(env) {
  const e = env || process.env;
  if (e.HEMING_DEV_URL) return e.HEMING_DEV_URL;
  if (e.HEMING_WEB_URL) return e.HEMING_WEB_URL;
  if (hasEmbeddedWeb()) return EMBEDDED_URL;
  return APP_DEFAULT_URL;
}

function isSafeExternalUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" || u.protocol === "mailto:";
  } catch {
    return false;
  }
}

// 协议白名单内才交给系统浏览器（http/https/mailto），失败仅记日志
function openInSystemBrowser(url) {
  if (!isSafeExternalUrl(url)) return;
  shell.openExternal(url).catch((err) => {
    console.log("[heming] 打开系统浏览器失败:", (err && err.message) || err);
  });
}

// 主 frame 导航白名单：本应用加载源 + 默认远程源 + localhost（dev 代理等）。
// 命中白名单 = 站内路由跳转放行；否则视为「离开应用」，转系统浏览器。
function isAllowedNavigation(url, appUrl) {
  // 嵌入式源按前缀判定：originOf 走 Node 的 URL 实现，自定义非特殊 scheme 的
  // origin 会得到 "null"，拿去比较必然不命中。
  if (typeof url === "string" && (url === EMBEDDED_ORIGIN || url.startsWith(EMBEDDED_ORIGIN + "/"))) {
    return true;
  }
  const target = originOf(url);
  if (!target) return false;
  if (target === originOf(appUrl)) return true;
  if (target === originOf(APP_DEFAULT_URL)) return true;
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  } catch {
    return false;
  }
}

// ── CSP 基线（P0-6，d.60）：协议响应头 + 违例日志 ────────────────────────
//
// 策略本体是 `app-protocol.js` 里的纯函数（可单测），这里只做三件事：
// 1. 从环境变量算灰度模式与 API 源；
// 2. 给 app:// 的响应挂 CSP 头；
// 3. 把渲染层的 CSP 违例 console 消息收进本机日志（限长 + 去重 + 只记元数据）。

/** 违例日志上限：超过就清空重来（CSP 违例通常只有少数几种，无需长期累积）。 */
const CSP_REPORT_LOG_MAX_BYTES = 256 * 1024;
/** 去重表上限：超过后不再记新种类，防止被刷爆磁盘。 */
const CSP_REPORT_MAX_DEDUPE = 500;
const cspSeenViolations = new Set();

/** 灰度模式：`HEMING_CSP_MODE=off|report|enforce`，**默认 report**（先收集违例）。 */
function cspMode() {
  return normalizeCspMode(process.env.HEMING_CSP_MODE);
}

/** 服务端源：HEMING_WEB_URL 的 origin（与嵌入产物构建时注入的 VITE_API_BASE 同源）。 */
function cspApiOrigin() {
  const raw = (process.env.HEMING_WEB_URL || "").trim();
  if (!raw) return DEFAULT_API_ORIGIN;
  try {
    return new URL(raw).origin;
  } catch {
    return DEFAULT_API_ORIGIN;
  }
}

/** 运维附加来源（HEMING_CSP_CONNECT，逗号/空白分隔）：给需要远程明文 http 的部署留的口子。 */
function cspExtraConnect() {
  return String(process.env.HEMING_CSP_CONNECT || "")
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function cspOptions() {
  return {
    mode: cspMode(),
    apiOrigin: cspApiOrigin(),
    extraConnect: cspExtraConnect(),
  };
}

/** 违例日志目录：`~/Heming/logs`（与崩溃日志同根，但**不是崩溃日志**）。 */
function cspReportFile() {
  return path.join(os.homedir(), "Heming", "logs", "csp-report.log");
}

/**
 * 追加一条违例（去重 + 限长）。
 *
 * ★ 只写 `directive / blocked / source` 三个字段：绝不写页面内容、绝不写整条 console 消息
 * （内联样式/脚本的违例消息可能夹带片段）。
 */
function appendCspReport(violation) {
  const key = `${violation.directive}|${violation.blockedUri}|${violation.source}`;
  if (cspSeenViolations.has(key)) return;
  if (cspSeenViolations.size >= CSP_REPORT_MAX_DEDUPE) return;
  cspSeenViolations.add(key);
  try {
    const file = cspReportFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size > CSP_REPORT_LOG_MAX_BYTES) fs.writeFileSync(file, "");
    } catch {
      /* 文件还不存在：第一次写入 */
    }
    const line =
      `[${new Date().toISOString()}] directive=${violation.directive} ` +
      `blocked=${violation.blockedUri} source=${violation.source || "inline"}:${violation.line}
`;
    fs.appendFileSync(file, line, "utf8");
  } catch {
    /* 日志失败绝不影响界面：CSP 本身仍生效 */
  }
}

/**
 * 给窗口挂 CSP 违例收集（仅 `console-message` 里的 CSP 消息）。
 *
 * Electron 45 起 console-message 是 `(event, details)`；为兼容旧签名，
 * 对第二个参数做对象判断，两种形状都能取到 message/sourceId/line。
 */
function attachCspReportLogger(win) {
  if (cspMode() === "off") return;
  win.webContents.on("console-message", (_event, detailsOrLevel, legacyMessage) => {
    const isDetails = !!detailsOrLevel && typeof detailsOrLevel === "object";
    const message = isDetails ? detailsOrLevel.message : legacyMessage;
    const sourceId = isDetails ? detailsOrLevel.sourceId || "" : "";
    const line = isDetails ? detailsOrLevel.lineNumber || 0 : 0;
    const violation = parseCspViolation(message, sourceId, line);
    if (violation) appendCspReport(violation);
  });
}

/**
 * 注册 app:// 的资源处理器（须在 app ready 之后）。逻辑下沉到 app-protocol.js 的
 * 纯函数，这里只做「解析 → 读文件 → 回响应」。
 */
function installAppProtocol(moduleStore, modulesDir) {
  protocol.handle(EMBEDDED_SCHEME, async (request) => {
    let urlPath = "/";
    try {
      urlPath = new URL(request.url).pathname;
    } catch {
      return new Response("bad request", { status: 400 });
    }
    // 宿主加载式模块包（d.131）：只读、只服务已安装且声明 web 的 id@version。
    if (urlPath.startsWith("/modules/")) {
      const exists = (f) => {
        try {
          return fs.existsSync(f);
        } catch {
          return false;
        }
      };
      const file = resolveModuleAssetPath(urlPath, {
        modulesDir,
        installed: moduleStore ? moduleStore.registry() : [],
      });
      if (!file || !exists(file)) {
        return new Response("module asset not found", {
          status: 404,
          headers: { "Content-Type": "text/plain; charset=utf-8", ...cspHeadersFor(urlPath, cspOptions()) },
        });
      }
      try {
        const body = await fs.promises.readFile(file);
        return new Response(body, {
          status: 200,
          headers: {
            "Content-Type": contentTypeFor(file),
            "Cache-Control": "public, max-age=31536000, immutable",
            ...cspHeadersFor(urlPath, cspOptions()),
          },
        });
      } catch {
        return new Response("read failed", { status: 500 });
      }
    }
    const root = webDistDir();
    const resolved = resolveRequest(urlPath, root, (f) => {
      try {
        return fs.existsSync(f);
      } catch {
        return false;
      }
    });
    if (!resolved) {
      // 资源缺失或路径越界：不回落首页（回落会把 404 变成难以排查的 MIME 错误）
      return new Response("not found", {
        status: 404,
        headers: { "Content-Type": "text/plain; charset=utf-8", ...cspHeadersFor(urlPath, cspOptions()) },
      });
    }
    try {
      const body = await fs.promises.readFile(resolved.file);
      return new Response(body, {
        status: 200,
        headers: {
          "Content-Type": contentTypeFor(resolved.file),
          // 产物带内容哈希，可长缓存；index.html 不缓存以免版本切换时读到旧壳
          "Cache-Control": resolved.spaFallback ? "no-store" : "public, max-age=31536000, immutable",
          // CSP 基线：off 时为空对象；report-only 时是 Content-Security-Policy-Report-Only
          ...cspHeadersFor(urlPath, cspOptions()),
        },
      });
    } catch {
      return new Response("read failed", {
        status: 500,
        headers: { "Content-Type": "text/plain; charset=utf-8", ...cspHeadersFor(urlPath, cspOptions()) },
      });
    }
  });
}

/* ────────────────────── 界面插件（desktopWidget · d.98） ────────────────────── */

/** 插件目录根：`<userData>/plugins`（主进程独有；渲染层不经 localStorage 决定窗口）。 */
function pluginsRoot() {
  return path.join(app.getPath("userData"), "plugins");
}

/** 老 `pet-state.json`（d.46 桌宠时代的位置/缩放/穿透）：一次性种入 heming.pet 的 state.json。 */
function readLegacyPetState() {
  try {
    const raw = fs.readFileSync(path.join(app.getPath("userData"), "pet-state.json"), "utf8");
    return JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

/**
 * 界面插件 CSP 里的「本机网关 origin」（审计 P0-1）。
 *
 * 不再放开 `127.0.0.1:*` / `localhost:*` 通配——只给网关自己的 `scheme//host:port`，
 * 且反代启动后才知道端口，所以是「按需解析 + 缓存」：首个 widget 请求会触发
 * ensureMagpieProxy（启动时已自动拉起），失败则该请求的 CSP 里没有网关来源。
 */
let widgetGatewayOrigin = null;
let widgetGatewayOriginProvider = null;

async function resolveWidgetGatewayOrigin() {
  if (widgetGatewayOrigin) return widgetGatewayOrigin;
  if (typeof widgetGatewayOriginProvider !== "function") return null;
  try {
    const baseUrl = await widgetGatewayOriginProvider();
    if (typeof baseUrl === "string" && baseUrl) {
      const url = new URL(baseUrl);
      widgetGatewayOrigin = `${url.protocol}//${url.host}`;
    }
  } catch {
    /* 网关没起来：CSP 不放行任何回环端点（fail-closed），chat 会失败但不越权 */
  }
  return widgetGatewayOrigin;
}

/**
 * 注册 `widget://` 资源处理器。
 *
 * `widget://<pluginId>/<path>` → `<userData>/plugins/<id>/<currentVersion>/<path>`：
 * - host 段只接受**已安装插件**的 id（查注册表，不拼任意目录名）；
 * - 路径解析复用 app-protocol 的防穿越逻辑，并且**不做 SPA 回落**
 *   （入口在清单里显式声明，回落只会把 404 变成一块内容可疑的透明窗）；
 * - 每个响应按该插件的清单 permissions 生成 CSP（不继承主窗的 https: 通配）。
 */
function installWidgetProtocol() {
  protocol.handle(WIDGET_SCHEME, async (request) => {
    let pluginId = "";
    let urlPath = "/";
    try {
      const parsed = new URL(request.url);
      pluginId = String(parsed.hostname || "").toLowerCase();
      urlPath = parsed.pathname;
    } catch {
      return new Response("bad request", { status: 400 });
    }
    const record = widgetStore ? widgetStore.get(pluginId) : null;
    const rootDir = widgetStore && record ? widgetStore.currentDir(pluginId) : null;
    if (!record || !rootDir || record.error) {
      return new Response("not found", { status: 404 });
    }
    const permissions = record.permissions || {};
    // 本机网关 origin 精确到端口（审计 P0-1：不再有回环通配）
    const widgetCspOpts = { ...cspOptions(), gatewayOrigin: await resolveWidgetGatewayOrigin() };
    const resolved = resolveWidgetRequest(urlPath, rootDir, (target) => {
      try {
        return fs.existsSync(target);
      } catch {
        return false;
      }
    });
    if (!resolved) {
      return new Response("not found", {
        status: 404,
        headers: { "Content-Type": "text/plain; charset=utf-8", ...widgetCspHeaders(permissions, widgetCspOpts) },
      });
    }
    try {
      const body = await fs.promises.readFile(resolved.file);
      return new Response(body, {
        status: 200,
        headers: {
          "Content-Type": contentTypeFor(resolved.file),
          // 插件版本目录里的产物每次安装都可能变；本地读盘、包体只有几 MB，
          // 直接 no-store 比引入一套 ETag/版本失效语义更不容易出错。
          "Cache-Control": "no-store",
          ...widgetCspHeaders(permissions, widgetCspOpts),
        },
      });
    } catch {
      return new Response("read failed", {
        status: 500,
        headers: widgetCspHeaders(permissions, widgetCspOpts),
      });
    }
  });
}

/** 主进程 → 主窗跳页（widget 气泡点击 / 托盘「设置」）。 */
function openPageInMainWindow(payload) {
  const main = mainWindow;
  if (!main || main.isDestroyed()) return;
  if (!payload || typeof payload !== "object") return;
  // 白名单真源在 shared（WIDGET_ALLOWED_PAGES）；这里是第二份运行期副本，
  // 由 widget-pages.test.js 与 plugin-window.js 一起钉住，三处必须同步。
  const page = ["settings", "team", "tasks", "staff", "infohub"].includes(payload.page) ? payload.page : null;
  if (!page) {
    console.log("[widgets] 丢弃未知页面跳转:", JSON.stringify(payload));
    return;
  }
  try {
    if (main.isMinimized()) main.restore();
    main.show();
    main.focus();
    main.webContents.send("widgets:open-page", {
      page,
      ...(typeof payload.settingsTab === "string" ? { settingsTab: payload.settingsTab } : {}),
      ...(typeof payload.pluginId === "string" ? { pluginId: payload.pluginId } : {}),
    });
  } catch (err) {
    console.log("[widgets] 页面跳转失败:", (err && err.message) || err);
  }
}

/**
 * chatConfig 的请求/应答（规格 §3.4）：主窗知道自己配了哪些智能体与绑定。
 *
 * 1s 超时与 30s 缓存由 plugin-host 负责；这里只做 requestId 关联与 pending 清理。
 * 超时/主窗没接 → resolve(null)，widget 那边降级为空 agents（对话仍可用网关）。
 */
const chatConfigPending = new Map();
let chatConfigRequestSeq = 0;

function requestChatConfigFromMainWindow(timeoutMs) {
  return new Promise((resolve) => {
    const main = mainWindow;
    if (!main || main.isDestroyed()) {
      resolve(null);
      return;
    }
    chatConfigRequestSeq += 1;
    const requestId = `cc-${chatConfigRequestSeq}`;
    const timer = setTimeout(() => {
      chatConfigPending.delete(requestId);
      resolve(null);
    }, Math.max(1, Number(timeoutMs) || 1000));
    chatConfigPending.set(requestId, (config) => {
      clearTimeout(timer);
      chatConfigPending.delete(requestId);
      resolve(config);
    });
    try {
      main.webContents.send("widgets:chat-config-request", { requestId });
    } catch {
      clearTimeout(timer);
      chatConfigPending.delete(requestId);
      resolve(null);
    }
  });
}

function displayWorkAreas() {
  try {
    return screen.getAllDisplays().map((d) => d.workArea);
  } catch {
    return [];
  }
}

// 启动动画 splash：无边框透明置顶窗口，覆盖**主窗口所在显示器**的工作区，
// 加载 splash.html（粒子聚拢 1.5s）。HEMING_NO_SPLASH=1 时跳过（E2E/无头环境）。
//
// 关闭时机 + 启动信号的事件接线在 splash-lifecycle.js（与 Electron 解耦、可单测）：
//   did-finish-load 首次 → 等满粒子段 → 关 splash + 发信号；之后每次加载 → 只重发信号；
//   did-fail-load（非 ERR_ABORTED 主 frame）/ 8s 看门狗 / 主窗口 closed → 兜底关闭。
function createSplashWindow(mainWin) {
  if (!shouldShowSplash()) return;

  // 多显示器：主窗口可能被 window-state 恢复到副屏，splash 跟随主窗口所在显示器，
  // 否则副屏用户只能看到主屏上一块无关的白板。
  const splash = new BrowserWindow(
    splashWindowOptions(screen.getDisplayMatching(mainWin.getBounds()).workArea)
  );

  const lifecycle = attachSplashLifecycle({
    splash,
    mainWin,
    now: Date.now,
    setTimer: setTimeout,
    clearTimer: clearTimeout,
  });

  // 减弱动态偏好只有渲染进程能查到（matchMedia）。这里异步回填给生命周期：
  // 开启时 splash 只是个静止画面，那 3.2s 可见地板没有意义 —— 查到就立刻收尾，
  // 别让这类用户对着静止画面干等（did-finish-load 先到时由 setReducedMotion 就地提前触发）。
  splash.webContents
    .executeJavaScript("matchMedia('(prefers-reduced-motion: reduce)').matches")
    .then((isReduced) => lifecycle.setReducedMotion(isReduced === true))
    .catch(() => {});

  // show:false 创建，加载完成后再 show()，避免白屏闪烁；加载失败（splash.html 缺失等）
  // 则直接收尾，避免留下一块没人管的全屏空白置顶层。
  splash
    .loadFile(path.join(__dirname, "splash.html"))
    .then(() => {
      if (splash.isDestroyed()) return;
      splash.show();
      // splash 已在最上层可见，此刻再 show 主窗口，用户看到的是 splash 而非白底主窗口
      if (!mainWin.isDestroyed() && !mainWin.isVisible()) mainWin.show();
    })
    .catch(() => {
      lifecycle.abort();
    });
}

// 主窗口引用：系统通知点击必须回到主窗口，而不是多窗口里随便一个
// （桌宠是独立窗口时，getAllWindows()[0] 不保证是主窗口）。
let mainWindow = null;

// 桌宠宿主（d.46）：独立透明置顶窗 + 托盘。浏览器端没有这个概念。
let widgetStore = null;
let widgetHost = null;

/** 界面插件的主题记忆：主窗挂载后会把浅/深色推过来，下次启动先按它初始化（见 widget-theme.js）。 */
function widgetThemeFile() {
  return path.join(app.getPath("userData"), "widget-theme.json");
}

// ③-4 安全复审：只该由主窗口调用的通道统一收口（fail-closed）。
// mainWindow 在 createWindow() 里赋值，闭包在调用时求值，此处只建门面。
const secureIpc = guardIpc(ipcMain, {
  isTrusted: makeSenderCheck(() => mainWindow),
  channels: TRUSTED_CHANNELS,
});

// 单例锁：拿不到锁直接退出；second-instance 时聚焦已存在窗口
const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  // 安全上下文白名单（E2E 设计 §2.1）：须在 whenReady 之前调用，恢复 crypto.subtle。
  const origins = secureOrigins();
  if (origins) app.commandLine.appendSwitch("unsafely-treat-insecure-origin-as-secure", origins);

  app.on("second-instance", () => {
    console.log("[heming] 检测到第二实例，聚焦已有窗口");
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  function windowStateFile() {
    return path.join(app.getPath("userData"), "window-state.json");
  }

  function createWindow() {
    const appUrl = resolveAppUrl();
    const bounds = loadWindowState(windowStateFile(), displayWorkAreas());
    // 有启动动画时不显示主窗口：默认 show:true 会在 splash 之前先把白底主窗口画出来
    // （白闪）。改由 createSplashWindow 在 splash 可见后再 show()。
    const withSplash = shouldShowSplash();

    const win = new BrowserWindow({
      ...bounds,
      // 自定义标题栏（设计 §3/§4）：隐藏系统栏 + 保留原生控件，内容延伸到窗口顶部
      ...titleBarOptions(process.platform),
      // 有启动动画时不显示主窗口（见上）：splash 可见后再 show()，避免 splash 之前白闪
      show: !withSplash,
      backgroundColor: WINDOW_BACKGROUND,
      title: "和鸣",
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // backgroundThrottling:false —— 启动动画期间 splash 覆盖整个工作区，主窗口会被
        // Chromium 判定为被遮挡；开启节流会让 web 端 BootWave 的 rAF/定时器一起被暂停，
        // 揭示永远推不动、白遮罩永久盖住界面。关掉节流保证声波段照常播放。
        backgroundThrottling: false,
      },
    });

    // 启动默认最大化：铺满屏幕但保留自定义标题栏与原生窗口控件（不用 fullscreen，
    // 真全屏会把标题栏一起隐藏）。
    win.maximize();

    mainWindow = win;
    // CSP 违例收集（report-only 期的主要证据来源；enforce 期也能看到被挡了什么）
    attachCspReportLogger(win);
    win.on("close", () => {
      // d.124 B 路径：主窗关闭前先销毁页面视图（视图生命周期不能长过宿主窗口）
      if (widgetHost) widgetHost.pageUnmount();
    });
    win.on("closed", () => {
      if (mainWindow === win) mainWindow = null;
    });

    // 窗口位置尺寸记忆：resize/move 后 debounce 500ms 落盘，关闭时立即落盘。
    // 用 getNormalBounds() 而非 getBounds()——最大化时 getBounds() 返回屏幕尺寸，
    // 直接存会把用户偏好的窗口尺寸覆盖掉；getNormalBounds() 取还原态尺寸，
    // 最大化/还原往返才正确。
    let saveTimer = null;
    const scheduleSave = () => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        saveTimer = null;
        saveWindowState(windowStateFile(), win.getNormalBounds());
      }, 500);
    };
    win.on("resize", scheduleSave);
    win.on("move", scheduleSave);
    win.on("close", () => {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      saveWindowState(windowStateFile(), win.getNormalBounds());
    });

    // window.open / target=_blank 一律 deny 并转系统浏览器：主窗口不开新页。
    // 界面插件窗口由主进程按清单建（独立 origin、透明置顶、单例），从不走 window.open。
    win.webContents.setWindowOpenHandler(({ url }) => {
      console.log("[heming] 新窗口请求转系统浏览器打开:", url);
      openInSystemBrowser(url);
      return { action: "deny" };
    });

    // 主 frame 导航拦截：离开白名单的跳转改走系统浏览器（站内路由不受影响）
    win.webContents.on("will-navigate", (event, url) => {
      if (isAllowedNavigation(url, appUrl)) return;
      event.preventDefault();
      console.log("[heming] 拦截离开应用的导航，转系统浏览器打开:", url);
      openInSystemBrowser(url);
    });

    // 开发模式 F12 快捷键打开开发者工具（Ctrl+Shift+I 由菜单 role 提供）
    if (!app.isPackaged) {
      win.webContents.on("before-input-event", (event, input) => {
        if (input.type === "keyDown" && input.key === "F12") {
          win.webContents.toggleDevTools();
          event.preventDefault();
        }
      });
    }

    // 先挂 splash 再 loadURL：确保 did-finish-load/did-fail-load 监听器不会漏掉极快的首次加载
    createSplashWindow(win);

    // 来电时停止任务栏闪烁（窗口获得焦点 = 用户已看到来电）
    win.loadURL(appUrl);

    // 渲染进程崩溃兜底：写一条崩溃日志 + 自动重载**一次**。
    // 只重载一次：崩溃循环（每次加载都崩）会把机器刷爆，重载后还崩说明问题不在这一次
    // 渲染，剩下的事是让人看到日志，而不是让机器一直重启。
    // 详见 crash-log.js。
    attachRenderCrashRecovery(win.webContents, {
      appVersion: appVersion(),
      logDir: CRASH_LOG_DIR,
    });

    return win;
  }

  // —— MCP stdio 传输（桌面端才有）——
  // 渲染进程没有 child_process 权限，故由主进程拉起 MCP 服务子进程并用换行分隔的
  // JSON-RPC 通信；渲染层经 preload 的 __mcp_stdio.request 逐条调用。
  const mcpStdio = createStdioBridge({
    spawn: require("node:child_process").spawn,
    log: (line) => console.log(line),
    planSpawn: planStdioSpawn,
  });

  // —— 内置 magpie 网关（d.91 原生模型组件）——
  // 模型统一由内置网关提供（d.90）；桌面端随包带本仓库编译的 `resources/magpie/magpie-core.exe`，
  // 主进程负责启动/探活/退出回收，并在本机回环上开一个带 CORS 的反代给渲染层用
  // （magpie 默认拒绝网页跨源请求，渲染层也不能自己起 HTTP 服务）。
  const magpieHost = createMagpieHost({
    binaryPath: resolveBinaryPath({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appDir: __dirname,
    }),
    spawn: require("node:child_process").spawn,
    log: (line) => console.log(line),
  });
  /** 反代按需创建：只有真的要用网关（且 magpie 已就绪）时才监听端口。 */
  let magpieProxy = null;

  /**
   * 界面插件 origin 能否用本机网关（d.98）。
   *
   * 只放行「已安装 + 已启用 + 文件完好 + 清单声明了渲染能力」的 widget：
   * 插件窗口要直连 magpie 反代（对话），但反代不能变成任意本机页面都能读的网关。
   * 不传这个判定 = 拒绝所有 widget（fail-closed），绝不放开 `widget://*` 通配。
   */
  const isWidgetOriginAllowed = (origin) => {
    const match = /^widget:\/\/([a-z0-9][a-z0-9._-]{0,63})$/.exec(String(origin || ""));
    if (!match) return false;
    const record = widgetStore ? widgetStore.get(match[1]) : null;
    if (!record || !record.enabled || record.error) return false;
    // d.124：只带页面的 bundle（没有浮窗）同样是一个可渲染的插件 origin，按同一口径放行；
    // 完全没有渲染面的记录（将来可能的纯数据包）仍然拒绝。
    if (!record.widget && !record.page) return false;
    const permissions = record.permissions || {};
    const graphics = Array.isArray(permissions.graphics) ? permissions.graphics : [];
    // 「需要渲染/执行能力」的界面插件才需要网关：全是静态展示的 widget 不用放行
    return permissions.eval === true || graphics.includes("webgl") || graphics.includes("webgl2") || graphics.includes("wasm");
  };

  const ensureMagpieProxy = async () => {
    if (!magpieProxy) {
      magpieProxy = await startMagpieProxy({
        upstreamPort: magpieHost.port,
        log: (line) => console.log(line),
        isWidgetOriginAllowed,
      });
    }
    const baseUrl = `http://127.0.0.1:${magpieProxy.port}/v1`;
    // widget CSP 只放行这个精确 origin（审计 P0-1：不再有 127.0.0.1:* 通配）
    try {
      const url = new URL(baseUrl);
      widgetGatewayOrigin = `${url.protocol}//${url.host}`;
    } catch {
      widgetGatewayOrigin = null;
    }
    return baseUrl;
  };
  // 首个 widget 请求若发生在反代之前，按需解析一次（启动时也会自动 startMagpieGateway）
  widgetGatewayOriginProvider = async () => ensureMagpieProxy();

  /** 启动（若未运行）并确保反代存在；失败把原因带回去给设置页展示。 */
  const startMagpieGateway = async () => {
    const started = await magpieHost.start();
    const baseUrl = await ensureMagpieProxy();
    return { baseUrl, status: { ...magpieHost.status(), version: started.version } };
  };

  secureIpc.handle("magpie:status", () => ({
    ...magpieHost.status(),
    proxyPort: magpieProxy ? magpieProxy.port : null,
  }));

  secureIpc.handle("magpie:start", async () => {
    try {
      return await startMagpieGateway();
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err), status: magpieHost.status() };
    }
  });

  secureIpc.handle("magpie:stop", async () => {
    await magpieHost.stop();
    if (magpieProxy) {
      await magpieProxy.close().catch(() => {});
      magpieProxy = null;
      widgetGatewayOrigin = null; // 端口已释放：CSP 里不能再放旧 origin
    }
    return magpieHost.status();
  });

  secureIpc.handle("magpie:gateway", async () => {
    if (!magpieHost.status().running) return { baseUrl: null, status: magpieHost.status() };
    try {
      return { baseUrl: await ensureMagpieProxy(), status: magpieHost.status() };
    } catch (err) {
      return {
        baseUrl: null,
        status: magpieHost.status(),
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  // —— 模型页的内核命令桥（d.105）——
  // 供应商/订阅账号/分组/用量/库/备份这些能力都在内核 CLI 里；模型页通过白名单
  // 命令调用**我们自己的内核**，不重写一遍，也不经过 shell。
  const magpieBinary = resolveBinaryPath({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appDir: __dirname,
  });
  const magpieCli = createMagpieCli({
    spawn: require("node:child_process").spawn,
    binaryPath: magpieBinary,
    send: (event) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send("magpie:cli:event", event);
      }
    },
    log: (line) => console.warn(line),
  });

  secureIpc.handle("magpie:cli", (_event, args) => magpieCli.run(args));

  secureIpc.handle("magpie:cli:start", (_event, args) => {
    const checked = validateCliArgs(args);
    if (!checked.ok) return { ok: false, error: checked.reason };
    void magpieCli.start(args);
    return { ok: true };
  });

  secureIpc.handle("magpie:cli:input", (_event, runId, text) =>
    magpieCli.input(String(runId), String(text ?? "")),
  );
  secureIpc.handle("magpie:cli:kill", (_event, runId) => magpieCli.kill(String(runId)));

  // 交互式命令（OAuth 登录、备份口令）：在真正的终端窗口里跑，用户能看到链接并输入。
  secureIpc.handle("magpie:terminal", (_event, args) => {
    const checked = validateCliArgs(args);
    if (!checked.ok) return { ok: false, error: checked.reason };
    try {
      const command = terminalCommand(magpieBinary, args);
      require("node:child_process").spawn("cmd.exe", ["/c", "start", "", "cmd", "/k", command], {
        windowsHide: false,
        detached: true,
        stdio: "ignore",
      }).unref();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  });

  // 交互式命令：立刻拿 runId，页面用事件流 + 输入框完成口令等交互。
  secureIpc.handle("magpie:cli:begin", (_event, args) => magpieCli.begin(args));

  // —— 模型备份（d.112）：备份文件放在应用自己的目录，页面列出来、点一下恢复 ——
  const fs = require("node:fs");
  const backupDir = require("node:path").join(app.getPath("userData"), "model-backups");
  const listBackups = () => {
    try {
      fs.mkdirSync(backupDir, { recursive: true });
      return fs
        .readdirSync(backupDir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => {
          const full = require("node:path").join(backupDir, entry.name);
          const stat = fs.statSync(full);
          return { name: entry.name, path: full, size: stat.size, mtime: stat.mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);
    } catch {
      return [];
    }
  };
  secureIpc.handle("magpie:backup:info", () => ({ dir: backupDir, files: listBackups() }));
  secureIpc.handle("magpie:backup:pick", async () => {
    const target = BrowserWindow.getFocusedWindow() ?? mainWindow;
    const result = await dialog.showOpenDialog(target, {
      title: "选择模型备份文件",
      properties: ["openFile"],
      filters: [{ name: "模型备份", extensions: ["backup", "enc", "*"] }],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  // 登录后自动拉起（不阻塞窗口）：失败只记日志，设置页会显示「未运行 + 原因」。
  void startMagpieGateway().catch((err) => {
    console.warn(`[magpie] 自动启动失败：${err instanceof Error ? err.message : String(err)}`);
  });

  // —— InfoHub 本机进程桥（d.45 信息中枢）——
  // 归档数据只留在本机：主进程用 stdio 拉起 Python 桥，不开端口、不走网络。
  // d.116 起引擎是**选装模块**：安装包里不再携带 Python 包，启用模块时从更新源
  // 下载官签名模块包，落到 `<userData>/modules` 后自动拉起。开发态若模块未装，
  // 退回仓库源码，避免每次改前端都得先构建模块包。
  let infohubBridge = null;

  // 宿主加载式模块包（d.131）：与 infohub 引擎共用 <userData>/modules 目录。
  // 只读 registry 供 app:// 路由与渲染层查询；安装/验签仍走 module-store。
  const webModulesRoot = path.join(app.getPath("userData"), "modules");
  const webModuleStore = createModuleStore({ dir: webModulesRoot, log: (line) => console.log(line) });
  secureIpc.handle("modules:web-list", () =>
    webModuleStore
      .registry()
      .filter((item) => item && item.web && typeof item.web.entry === "string")
      .map((item) => ({ id: item.id, version: item.version, name: item.name, entry: item.web.entry })),
  );

  const infohubEngine = createInfohubEngine({
    dir: path.join(app.getPath("userData"), "modules"),
    log: (line) => console.log(line),
    broadcast: (payload) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.send("infohub:engine", payload);
    },
  });

  /** 开发态仓库里的引擎源码；打包版恒为空（模块必须走下载）。 */
  const devEngineDir = () => {
    if (app.isPackaged) return "";
    const repo = resolveInfohubPackageDir({
      isPackaged: false,
      resourcesPath: process.resourcesPath,
      dirname: __dirname,
    });
    return fs.existsSync(repo) ? repo : "";
  };

  /** 引擎目录：已安装模块优先；未打包时退回仓库源码。 */
  const infohubEngineDirs = () => {
    const dirs = infohubEngine.dirs();
    if (dirs.packageDir) return dirs;
    const repo = devEngineDir();
    if (repo) return { packageDir: repo, libraryDir: "", version: "dev" };
    return { packageDir: "", libraryDir: "", version: "" };
  };

  /** 首次用到某服务时先握手（initialize → notifications/initialized）。 */
  const ensureStdioReady = async (serverId, config) => {
    if (mcpStdio.running().includes(serverId)) return true;
    await mcpStdio.request(serverId, config, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "heming", version: "1.0.0" },
    });
    mcpStdio.notify(serverId, config, "notifications/initialized");
    return true;
  };

  secureIpc.handle("mcp:stdio:request", async (_event, payload) => {
    const { serverId, config, method, params } = payload || {};
    if (typeof serverId !== "string" || !serverId) throw new Error("缺少 serverId");
    if (typeof method !== "string" || !method) throw new Error("缺少 method");
    const fresh = !mcpStdio.running().includes(serverId);
    if (fresh && method !== "initialize") await ensureStdioReady(serverId, config);
    const result = await mcpStdio.request(serverId, config, method, params);
    if (fresh && method === "initialize") {
      mcpStdio.notify(serverId, config, "notifications/initialized");
    }
    return result;
  });

  secureIpc.handle("mcp:stdio:stop", (_event, serverId) => mcpStdio.stop(String(serverId)));

  // sandbox 的 preload 读不到本地 app-version.js，版本号改由这里同步提供。
  // 必须在 createWindow() 之前注册：preload 顶层就会 sendSync 取一次。
  ipcMain.on("app:version", (event) => {
    event.returnValue = appVersion();
  });

  // —— 本机运行时探测（d.25 本地包安装）——
  // Registry 的 npm / pypi 服务要在用户机器上拉起 npx / uvx。装之前必须先知道
  // 「这台机器跑不跑得起来」，否则用户只会在连接阶段看到一条莫名其妙的失败。
  // 只回传能力布尔与解析到的路径，不执行任何命令、不写任何东西。
  // PATH 用 buildChildEnv 补全过的那份：与真正 spawn 时的查找范围一致，
  // 不然会出现「探测说没有、启动却成功了」这种自相矛盾的界面。
  secureIpc.handle("runtime:probe", () =>
    probeLocalRuntime({ env: buildChildEnv({ ...process.env }), execPath: process.execPath }),
  );

  // 子进程回收闸（d.50）：`will-quit` 是同步事件，回收却是异步的 —— 旧写法发完
  // dispose 就任由 Electron 退下去，两个桥里 `child.kill()` 只杀直接子进程，
  // Python 的转写/bot 与 MCP 的 npx→node→Chromium 全留在机器上。
  // 这里改成「拦一次 → 等回收 → 再退」，并由 reclaimer 自带硬超闸：
  // 进程杀不动也不能让用户关不掉应用。没有子进程时一律不拦，退出零延迟。
  const reclaimChildren = createChildReclaimer({
    tasks: () => {
      const list = [];
      // 判据是「有没有活着的或正在回收的子进程」，不是「界面有没有在跑」：
      // 用户几秒前点过停止，回收可能还在后台跑，这时退出照样要等它。
      if (!mcpStdio.idle()) list.push(() => mcpStdio.disposeAll());
      if (infohubBridge && !infohubBridge.idle()) list.push(() => infohubBridge.dispose());
      // magpie 网关与它的反代：关闭时先停进程再关服务，避免端口悬挂。
      if (magpieHost.status().running) list.push(() => magpieHost.stop());
      if (magpieProxy) list.push(() => magpieProxy.close());
      // 界面插件窗口与托盘：同步销毁（托盘不销毁会在托盘区留下一个幽灵图标）。
      // 它们不是子进程，但同属「退出前必须收口」的资源；放在这里统一收口，
      // 而不是再挂一个无 event 的 will-quit——那种处理器拦不住退出（见 main.test 的守卫）。
      if (widgetHost) list.push(() => widgetHost.destroyAll());
    },
    onQuit: () => app.quit(),
    log: (line) => console.warn(line),
  });
  app.on("will-quit", (event) => reclaimChildren(event));

  /* ------------------------------------------------------- 自动更新 */

  // 延后 require：electron-updater 依赖 electron 的 app 对象，
  // 在模块顶层 require 会在某些测试环境里触发「app未就绪」。
  const { createUpdater } = require("./auto-update");
  const { autoUpdater } = require("electron-updater");

  // 开发态（electron .）不检查更新：那里没有真实安装包，
  // 拉到的 latest.yml 只会指向线上包，调试时看到误导性的提示。
  if (!app.isPackaged) {
    console.log("[heming] 开发模式，跳过自动更新初始化");
  } else {
    // 把 electron-updater 的内部日志接到 console：更新失败时
    // 用户只会看到「没更新」，看不到原因，日志是唯一的排查线索。
    // 不用 electron-log —— 那是额外依赖，而这里只需要输出到已有日志通道。
    autoUpdater.logger = {
      info: (message) => console.log("[updater]", message),
      warn: (message) => console.warn("[updater]", message),
      error: (message) => console.error("[updater]", message),
      debug: (message) => console.debug("[updater]", message),
    };
  }

  const updater = createUpdater({ autoUpdater, app, log: (line) => console.log(line) });

  /** 把状态推给渲染进程（设置区的更新区、启动提示条）。 */
  const pushUpdateState = (state) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send("update:state", state);
    }
  };
  updater.subscribe(pushUpdateState);

  secureIpc.handle("update:check", () => updater.check());
  secureIpc.handle("update:download", () => updater.download());
  secureIpc.handle("update:install", () => updater.quitAndInstall());
  secureIpc.handle("update:state", () => updater.getState());

  // 启动后延迟一小会儿再检查：冷启动时不必和界面抢网络，
  // 也不至于让用户等更新检查才看到首屏。
  setTimeout(() => {
    void updater.check({ silent: true });
    updater.scheduleCheck();
  }, 8_000);

  function setupMenu() {
    const isDev = !app.isPackaged;
    const template = [];

    // macOS 归属菜单（简化：关于 + 退出）；Windows 不需要
    if (process.platform === "darwin") {
      template.push({
        label: "和鸣",
        submenu: [
          { role: "about", label: "关于和鸣" },
          { type: "separator" },
          { role: "quit", label: "退出和鸣" },
        ],
      });
    }

    template.push(
      {
        label: "文件",
        submenu: [{ role: "quit", label: "退出" }],
      },
      {
        label: "编辑",
        submenu: [
          { role: "undo", label: "撤销" },
          { role: "redo", label: "重做" },
          { type: "separator" },
          { role: "cut", label: "剪切" },
          { role: "copy", label: "复制" },
          { role: "paste", label: "粘贴" },
          { type: "separator" },
          { role: "selectAll", label: "全选" },
        ],
      },
      {
        label: "视图",
        submenu: [
          { role: "reload", label: "重新加载" },
          { type: "separator" },
          { role: "zoomIn", label: "放大" },
          { role: "zoomOut", label: "缩小" },
          { role: "resetZoom", label: "恢复缩放" },
          { type: "separator" },
          // 开发者工具仅 dev 模式可见（生产隐藏）
          ...(isDev
            ? [
                { role: "toggleDevTools", label: "开发者工具" },
                { type: "separator" },
              ]
            : []),
          { role: "togglefullscreen", label: "全屏" },
        ],
      },
      {
        label: "窗口",
        submenu: [
          { role: "minimize", label: "最小化" },
          {
            label: "缩放",
            click: (menuItem, browserWindow) => {
              if (!browserWindow) return;
              if (browserWindow.isMaximized()) browserWindow.unmaximize();
              else browserWindow.maximize();
            },
          },
          { role: "close", label: "关闭" },
        ],
      },
      {
        label: "帮助",
        submenu: [
          {
            label: "关于和鸣",
            click: async () => {
              await dialog.showMessageBox({
                type: "info",
                title: "关于和鸣",
                message: "和鸣",
                detail: `版本 ${pkg.version}`,
                buttons: ["确定"],
              });
            },
          },
        ],
      }
    );

    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  console.log("[heming] 版本", appVersion());
  // CSP 灰度模式：off / report（默认）/ enforce。report 期违例会写 ~/Heming/logs/csp-report.log
  console.log("[heming] CSP 模式", cspMode());

app.whenReady().then(() => {
    // 自定义协议处理器须在创建窗口之前装好，否则首次 loadURL 会拿到空响应
    // 插件注册表必须在协议与窗口之前就绪：widget:// 处理器要按它查插件目录
    widgetStore = createPluginStore({
      dir: pluginsRoot(),
      log: (line) => console.log(line),
    });
    widgetStore.init();
    // 自定义协议处理器须在创建窗口之前装好，否则首次 loadURL 会拿到空响应
    installAppProtocol(webModuleStore, webModulesRoot);
    installWidgetProtocol();
    setupMenu();
    // 个人知识库文件桥（卡帕西 LLM Wiki 标准）：必须在窗口创建前注册
    registerWikiIpc(secureIpc);
    // 原生知识库（多库 vault，d.114）：注册表在 ~/Heming/vaults.json，根只来自系统目录对话框。
    // 首次启动会把既有 ~/Heming/wiki 自动登记为「和鸣知识库」（不移动文件）。
    registerVaultIpc(secureIpc, {
      dialog,
      shell,
      getMainWindow: () => mainWindow,
    });
    // 图表导出桥：把生成的图表写到 ~/Heming/charts
    registerChartIpc(secureIpc);
    // 记忆导出文件桥（d.35）：把记忆 JSON 写到 ~/Heming/exports
    registerExportIpc(secureIpc);
    // 文件编辑桥（d.55 · file_patch）：只在用户显式添加的可写根内读写。
    // 只接受**主窗口**的调用——桌宠窗口等其它渲染进程不能经这里改用户文件；
    // 路径判定、软链/硬链拒绝、上限与 tmp+rename 原子写都在 file-fs.js 里兜底。
    registerFileIpc(ipcMain, {
      dialog,
      getMainWindow: () => mainWindow,
      isTrustedSender: (event) => {
        if (!mainWindow) return false;
        return BrowserWindow.fromWebContents(event.sender) === mainWindow;
      },
    });
    // 本机密钥信封桥（d.36）：preload 在页面加载时用 sendSync 问可用性，
    // 所以必须早于 createWindow()。
    registerSecretIpc(secureIpc);
    // 工作流 HTTP 桥（d.87）：渲染层 fetch 受 CORS 限制，由主进程代发给
    // 工作流「HTTP 请求」节点；只放行 http/https，响应体 20MB 上限。
    registerWorkflowHttpIpc(secureIpc);
    // 系统通知桥（d.39）：消息提醒只在窗口不在前台时由渲染层请求；
    // 点击通知显式聚焦主窗口（桌宠窗口不能截走通知跳转）。
    registerNotifyIpc(secureIpc, {
      Notification,
      getMainWindow: () => mainWindow,
      // 任一应用窗口在前台（含桌宠窗口）就不弹系统通知。
      getFocusedWindow: () => BrowserWindow.getFocusedWindow(),
    });
    // 信息中枢（d.45）：IPC 只在本机进程桥之上转发，不直接暴露文件系统。
    // 进度事件广播给所有窗口：采集可能在看别的页面时进行，回到页面即见最新阶段。
    infohubBridge = createInfohubBridge({
      spawn: require("node:child_process").spawn,
      log: (line) => console.log(line),
      packageDir: () => infohubEngineDirs().packageDir,
      libraryDir: () => infohubEngineDirs().libraryDir,
      defaultHome: resolveDefaultHome(path.join(os.homedir(), "Heming")),
      bundledPythonPath: bundledPython(),
    });
    infohubBridge.onEvent((event) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send("infohub:event", event);
      }
    });
    registerInfohubIpc(secureIpc, {
      bridge: infohubBridge,
      dialog,
      windowFromEvent: (event) => BrowserWindow.fromWebContents(event.sender),
    });
    // 选装引擎：状态 / 按需安装（下载 → 验签 → 解包）。安装完成后收掉旧进程，
    // 下一次调用会按新目录重新拉起，不需要用户点「重连」。
    secureIpc.handle("infohub:engine-info", () => infohubEngine.info());
    secureIpc.handle("infohub:engine-ensure", async (_event, payload) => {
      // 开发态有仓库源码就不必联网下载：直接按「已就绪」返回，改代码即时生效。
      if (!infohubEngine.info().installed && devEngineDir()) {
        return { ...infohubEngine.info(), installed: true, version: "dev", updated: false };
      }
      const requested = payload && typeof payload === "object" ? payload.version : undefined;
      const result = await infohubEngine.ensure(requested);
      if (result.updated) infohubBridge?.stop({ killDelayMs: 0, silent: true });
      return result;
    });
    createWindow();

    // ── 界面插件宿主（d.98：桌宠已拆成 heming.pet 插件）──
    // 只给「已安装 + enabled + 文件完好」的插件建窗。老 pet-state.json 一次性种入
    // heming.pet 的 state.json（幂等；老文件保留一版不删，方便回滚）。
    widgetStore.seedLegacyState("heming.pet", readLegacyPetState());
    widgetHost = createWidgetHost({
      BrowserWindow,
      Tray,
      Menu,
      nativeImage,
      screen,
      ipcMain,
      // d.124 B 路径：页面视图用（独立 origin 的 WebContentsView，嵌在主窗内容区）
      WebContentsView,
      app,
      store: widgetStore,
      preloadPath: path.join(__dirname, "widget-preload.js"),
      // 托盘兜底图标（插件没声明 tray.icon 时用）：沿用 d.46 的桌宠图标
      defaultTrayIconPath: path.join(__dirname, "assets", "widget-tray.png"),
      getMainWindow: () => mainWindow,
      appVersion: () => appVersion(),
      getTheme: () => readWidgetTheme(widgetThemeFile()),
      // 对话上下文只给本机网关（用户供应商 Key 不出主进程；P0 口径见规格 §3.4）
      getGateway: async () => {
        if (!magpieHost.status().running) return { baseUrl: null, key: "local" };
        try {
          return { baseUrl: await ensureMagpieProxy(), key: "local" };
        } catch {
          return { baseUrl: null, key: "local" };
        }
      },
      requestChatConfig: (timeoutMs) => requestChatConfigFromMainWindow(timeoutMs),
      // d.125：插件自带引擎（第一方签名 bundle）用内置 Python 运行时；
      // 知识库只读注册表、只把「根 + writeDirs」交给声明过 permissions.kb 的插件。
      spawn: require("node:child_process").spawn,
      bundledPythonPath: bundledPython(),
      getKbRoots: async () => {
        const registry = await readRegistry(defaultRegistryFile());
        return (registry.vaults || []).map((vault) => ({
          id: vault.id,
          name: vault.name,
          root: vault.root,
          writeDirs: [...(vault.writeDirs || [])],
        }));
      },
      openPage: (payload) => openPageInMainWindow(payload),
      log: (line) => console.log(line),
    });
    widgetHost.start();

    /* ── 主窗专用：界面插件安装/启停/设置/动作（secureIpc 只认 mainWindow） ── */
    const pluginDialogFilters = [{ name: "界面插件包", extensions: ["tgz"] }];

    const pickPluginFile = async () => {
      const picked = await dialog.showOpenDialog(mainWindow, {
        properties: ["openFile"],
        filters: pluginDialogFilters,
      });
      if (picked.canceled || picked.filePaths.length === 0) return null;
      return picked.filePaths[0];
    };

    /** 安装后统一收口：对账建窗 + 让 chatConfig 缓存失效（新插件的 agents 可能不同）。 */
    const afterInstallChange = () => {
      if (widgetHost) {
        widgetHost.reconcile();
        widgetHost.invalidateChatConfig();
      }
    };

    secureIpc.handle("widgets:list", () => widgetStore.list());
    secureIpc.handle("widgets:pickPackage", async () => {
      const filePath = await pickPluginFile();
      return filePath ? { canceled: false, path: filePath } : { canceled: true };
    });
    secureIpc.handle("widgets:install", (_event, payload) => {
      const bytes = payload && payload.bytes;
      if (!bytes) return { ok: false, error: "缺少插件包内容" };
      const result = widgetStore.install({ bytes, expectedSha256: payload.expectedSha256 });
      if (!result.ok) return { ok: false, error: result.error };
      afterInstallChange();
      return { ok: true, record: result.record };
    });
    secureIpc.handle("widgets:installFromFile", async () => {
      const filePath = await pickPluginFile();
      if (!filePath) return { ok: false, error: "已取消" };
      let bytes;
      try {
        bytes = fs.readFileSync(filePath);
      } catch (err) {
        return { ok: false, error: `读取插件包失败：${(err && err.message) || err}` };
      }
      const result = widgetStore.install({ bytes });
      if (!result.ok) return { ok: false, error: result.error };
      afterInstallChange();
      return { ok: true, record: result.record };
    });
    secureIpc.handle("widgets:uninstall", (_event, payload) => {
      const id = payload && payload.id;
      if (typeof id !== "string" || !id) return { ok: false, error: "缺少插件 id" };
      const result = widgetStore.uninstall(id, { removeData: payload.removeData !== false });
      afterInstallChange();
      return result;
    });
    secureIpc.handle("widgets:setEnabled", (_event, payload) => {
      const id = payload && payload.id;
      if (typeof id !== "string" || !id) return { ok: false, error: "缺少插件 id" };
      const result = widgetStore.setEnabled(id, payload.enabled === true);
      afterInstallChange();
      return result;
    });
    secureIpc.handle("widgets:settingsGet", (_event, payload) => widgetStore.readSettings(payload && payload.id));
    secureIpc.handle("widgets:settingsSet", (_event, payload) => {
      const id = payload && payload.id;
      const next = widgetStore.patchSettings(id, payload && payload.patch);
      // 设置变了 → chatConfig 缓存立刻失效（绑定/模型路径最多 30s 才生效是不可接受的）
      if (widgetHost) widgetHost.invalidateChatConfig();
      // 主窗改了设置也要让插件的**所有渲染面**立刻看到（widget 窗口 + d.124 页面视图）
      if (widgetHost) widgetHost.notifySettings(id, next);
      return next;
    });
    secureIpc.handle("widgets:action", (_event, payload) =>
      widgetHost.action(payload && payload.id, payload && payload.action),
    );
    secureIpc.handle("widgets:state", (_event, payload) => widgetHost.stateOf(payload && payload.id));
    /* ── d.124 B 路径：界面插件自带页面的视图（只认主窗口；rect 由 web 侧算，这里钳制） ── */
    secureIpc.handle("widgets:page-mount", (_event, payload) => widgetHost.pageMount(payload));
    secureIpc.on("widgets:page-bounds", (_event, payload) => {
      widgetHost.pageBounds(payload);
    });
    secureIpc.on("widgets:page-unmount", () => {
      widgetHost.pageUnmount();
    });
    secureIpc.handle("widgets:publish", (_event, payload) => {
      const result = widgetHost.publish(payload);
      // 主题是唯一需要主进程记住的跨窗口状态：widget 窗口可能比主窗先建好
      if (payload && payload.kind === "theme") writeWidgetTheme(widgetThemeFile(), payload.theme);
      return result;
    });
    secureIpc.handle("widgets:migrateLegacy", (_event, payload) =>
      widgetStore.migrateLegacy(payload && payload.prefs),
    );
    secureIpc.handle("widgets:chat-config-reply", (_event, payload) => {
      const requestId = payload && payload.requestId;
      const pending = typeof requestId === "string" ? chatConfigPending.get(requestId) : null;
      if (pending) pending(payload && payload.config);
      return { ok: true };
    });

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
