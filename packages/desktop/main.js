"use strict";
const { app, BrowserWindow, Menu, Tray, nativeImage, dialog, shell, screen, ipcMain, Notification, protocol, net } = require("electron");
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
  contentTypeFor,
} = require("./app-protocol");
const { isPetWindowUrl, parsePetStateJson } = require("./pet-window");
const { createPetHost } = require("./pet-host");
const { appVersion } = require("./app-version");
const { buildChildEnv, createStdioBridge } = require("./mcp-stdio");
const { createChildReclaimer } = require("./child-kill");
const { bundledPython } = require("./bundled-runtime");
const { planStdioSpawn, probeLocalRuntime } = require("./local-runtime");

const pkg = require("./package.json");
const { APP_DEFAULT_URL, originOf, secureOrigins } = require("./secure-origins");
const { titleBarOptions, WINDOW_BACKGROUND } = require("./title-bar");
const { registerWikiIpc } = require("./wiki-fs");
const { registerChartIpc } = require("./chart-fs");
const { registerExportIpc } = require("./export-fs");
const { registerFileIpc } = require("./file-fs");
const { registerSecretIpc } = require("./secret-store");
const { registerNotifyIpc } = require("./notify-bridge");
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
protocol.registerSchemesAsPrivileged([
  {
    scheme: EMBEDDED_SCHEME,
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
      `blocked=${violation.blockedUri} source=${violation.source || "inline"}:${violation.line}\n`;
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
function installAppProtocol() {
  protocol.handle(EMBEDDED_SCHEME, async (request) => {
    let urlPath = "/";
    try {
      urlPath = new URL(request.url).pathname;
    } catch {
      return new Response("bad request", { status: 400 });
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
let petHost = null;

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

  /* ── 桌宠状态文件（d.46）─────────────────────────────────────────────
   * 与 window-state.json 分开放：桌宠有 scale / visible / clickThrough 三个
   * 主窗口没有的字段，混在一个文件里迟早被对方的写入覆盖掉。
   */
  function petStateFile() {
    return path.join(app.getPath("userData"), "pet-state.json");
  }

  function readPetState(file) {
    try {
      // 解析（含剥 BOM）在 pet-window.js 的纯函数里，有单测锁住：真机上踩过
      // 「状态文件带 BOM → JSON.parse 抛错 → 桌宠静默不出现」的坑
      return parsePetStateJson(fs.readFileSync(file, "utf8"));
    } catch {
      return null; // 缺文件：clampPetState 会回落默认落位
    }
  }

  function writePetState(file, state) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(state, null, 2) + "\n", "utf8");
    } catch (err) {
      console.log("[pet] 状态写入失败:", (err && err.message) || err);
    }
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

    // window.open / target=_blank 默认交给系统浏览器；**例外只有桌宠窗口**
    // （同源 + `?hemingWindow=pet`）。其余一律 deny，保持「主窗口不开新页」的既有约束。
    const appOriginForWindows = EMBEDDED_ORIGIN === originOf(appUrl) ? EMBEDDED_ORIGIN : appUrl;
    win.webContents.setWindowOpenHandler(({ url }) => {
      // 桌宠窗口由主进程自己建（需要透明穿透、位置记忆与单例），不走 window.open。
      // 这里 deny 掉并转去 host，避免它被当成外部链接丢给系统浏览器。
      if (isPetWindowUrl(url, appOriginForWindows) || isPetWindowUrl(url, EMBEDDED_ORIGIN)) {
        console.log("[heming] 桌宠窗口请求改由主进程托管");
        if (petHost) petHost.show();
        return { action: "deny" };
      }
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

  // —— InfoHub 本机进程桥（d.45 信息中枢）——
  // 归档数据只留在本机：主进程用 stdio 拉起 Python 桥，不开端口、不走网络。
  // 打包后 Python 包在 resources/infohub；开发态直接用 packages/infohub。
  // 解释器默认用内置运行时（浏览/检索只需标准库）；采集依赖缺失时界面会提示改路径。
  let infohubBridge = null;

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

  ipcMain.handle("mcp:stdio:request", async (_event, payload) => {
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

  ipcMain.handle("mcp:stdio:stop", (_event, serverId) => mcpStdio.stop(String(serverId)));

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
  ipcMain.handle("runtime:probe", () =>
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
      // 桌宠：同步销毁窗口与托盘（托盘不销毁会在托盘区留下一个幽灵图标）。
      // 它不是子进程，但同属「退出前必须收口」的资源；放在这里统一收口，
      // 而不是再挂一个无 event 的 will-quit——那种处理器拦不住退出（见 main.test 的守卫）。
      // 仅在桌宠真的被创建过时才入列：否则每次退出都白白多拦一次。
      if (petHost) list.push(() => petHost.destroy());
      return list;
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

  ipcMain.handle("update:check", () => updater.check());
  ipcMain.handle("update:download", () => updater.download());
  ipcMain.handle("update:install", () => updater.quitAndInstall());
  ipcMain.handle("update:state", () => updater.getState());

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
    installAppProtocol();
    setupMenu();
    // 个人知识库文件桥（卡帕西 LLM Wiki 标准）：必须在窗口创建前注册
    registerWikiIpc(ipcMain);
    // 图表导出桥：把生成的图表写到 ~/Heming/charts
    registerChartIpc(ipcMain);
    // 记忆导出文件桥（d.35）：把记忆 JSON 写到 ~/Heming/exports
    registerExportIpc(ipcMain);
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
    registerSecretIpc(ipcMain);
    // 系统通知桥（d.39）：消息提醒只在窗口不在前台时由渲染层请求；
    // 点击通知显式聚焦主窗口（桌宠窗口不能截走通知跳转）。
    registerNotifyIpc(ipcMain, {
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
      packageDir: resolveInfohubPackageDir({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        dirname: __dirname,
      }),
      defaultHome: resolveDefaultHome(path.join(os.homedir(), "Heming")),
      bundledPythonPath: bundledPython(),
    });
    infohubBridge.onEvent((event) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send("infohub:event", event);
      }
    });
    registerInfohubIpc(ipcMain, {
      bridge: infohubBridge,
      dialog,
      windowFromEvent: (event) => BrowserWindow.fromWebContents(event.sender),
    });
    createWindow();

    // ── 桌宠（d.46）──
    // 独立透明置顶窗 + 托盘。**默认不显示**：持久化状态里 visible 为 false 时
    // 就什么都不做，用户上次关掉的东西不该在重启后自己弹回来。
    // 打开入口：设置区「桌宠」卡、托盘菜单、渲染层 __heming_pet.show()。
    petHost = createPetHost({
      BrowserWindow,
      Tray,
      Menu,
      nativeImage,
      screen,
      ipcMain,
      app,
      stateFile: petStateFile(),
      preloadPath: path.join(__dirname, "preload.js"),
      // 图标在 asar 内也能被 nativeImage 读到（Electron 对 asar 路径做了透明处理）
      trayIconPath: path.join(__dirname, "assets", "pet-tray.png"),
      resolveAppUrl: () => resolveAppUrl(),
      getMainWindow: () => mainWindow,
      readState: readPetState,
      writeState: writePetState,
      log: (line) => console.log(line),
    });
    petHost.start();
    // 启动状态只打一行：桌宠不出现时，第一个要回答的问题就是「它到底启没启、上次是不是显示状态」
    console.log(
      "[heming] 桌宠:",
      JSON.stringify({ visible: petHost.state.visible, scale: petHost.state.scale }),
    );

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
