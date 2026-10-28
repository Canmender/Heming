"use strict";
const { app, BrowserWindow, Menu, dialog, shell, screen, ipcMain, Notification, protocol, net } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { loadWindowState, saveWindowState } = require("./window-state");
const { shouldShowSplash, splashWindowOptions } = require("./splash-config");
const { attachSplashLifecycle } = require("./splash-lifecycle");
const { resolveRequest, contentTypeFor, INDEX_FILE } = require("./app-protocol");
const { isCallWindowUrl, callWindowOptions } = require("./call-window");
const { appVersion } = require("./app-version");
const { buildChildEnv, createStdioBridge } = require("./mcp-stdio");
const { planStdioSpawn, probeLocalRuntime } = require("./local-runtime");

const pkg = require("./package.json");
const { APP_DEFAULT_URL, originOf, secureOrigins } = require("./secure-origins");
const { titleBarOptions, WINDOW_BACKGROUND } = require("./title-bar");
const { registerWikiIpc } = require("./wiki-fs");
const { registerChartIpc } = require("./chart-fs");
const { registerExportIpc } = require("./export-fs");
const { registerSecretIpc } = require("./secret-store");
const { registerNotifyIpc } = require("./notify-bridge");
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
      return new Response("not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
    try {
      const body = await fs.promises.readFile(resolved.file);
      return new Response(body, {
        status: 200,
        headers: {
          "Content-Type": contentTypeFor(resolved.file),
          // 产物带内容哈希，可长缓存；index.html 不缓存以免版本切换时读到旧壳
          "Cache-Control": resolved.spaFallback ? "no-store" : "public, max-age=31536000, immutable",
        },
      });
    } catch {
      return new Response("read failed", { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } });
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
// （独立通话窗口由 window.open 创建，getAllWindows()[0] 不保证是主窗口）。
let mainWindow = null;

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

    // window.open / target=_blank 默认交给系统浏览器；**唯一例外**是通话窗口
    // （同源 + `?hemingWindow=call`）：它必须留在应用内，才能共享 localStorage 的登录态
    // 与 WS 信令。其余一律 deny，保持「主窗口不开新页」的既有约束。
    const appOriginForWindows = EMBEDDED_ORIGIN === originOf(appUrl) ? EMBEDDED_ORIGIN : appUrl;
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (isCallWindowUrl(url, appOriginForWindows) || isCallWindowUrl(url, EMBEDDED_ORIGIN)) {
        console.log("[heming] 打开通话窗口:", url);
        return { action: "allow", overrideBrowserWindowOptions: callWindowOptions() };
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
    win.on("focus", () => {
      win.flashFrame(false);
    });

    win.loadURL(appUrl);

    // 渲染进程崩溃兜底：写一条崩溃日志 + 自动重载**一次**。
    // 只重载一次：崩溃循环（每次加载都崩）会把机器刷爆，重载后还崩说明问题不在这一次
    // 渲染，剩下的事是让人看到日志，而不是让机器一直重启。
    // 详见 crash-log.js。
    attachRenderCrashRecovery(win.webContents, {
      appVersion: appVersion(),
      logDir: CRASH_LOG_DIR,
    });

    // ICE 服务器列表（STUN/TURN）**改由渲染层自己拉**（web/src/lib/iceServers.ts）。
    // 原来这里是主进程裸 fetch 服务端的 /api/ice-servers 再注入渲染层，但本轮服务端给
    // 该路由加了鉴权（未带 token → 401），而主进程拿不到 web 的 token。
    // 要让它继续工作就得把 token 从渲染层搬进主进程 → 主进程开始持有用户凭据，
    // 这是新增的暴露面（主进程内存会被 dump、崩溃日志可能带出）。
    // 渲染层本来就持有 token，且桌面页 app://heming 是 secure origin，跨域也通。
    // preload.js 的 __heming_ice_servers_get / setIceServers 保留不动，
    // web 侧仍按可选链读它作为兼容位（当前已无注入方）。

    // 窗口最小化时通知渲染层（渲染层据此弹系统通知，来电不丢）
    win.on("minimize", () => {
      win.webContents.send("voice-call:minimized");
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

  // —— 本机运行时探测（d.25 本地包安装）——
  // Registry 的 npm / pypi 服务要在用户机器上拉起 npx / uvx。装之前必须先知道
  // 「这台机器跑不跑得起来」，否则用户只会在连接阶段看到一条莫名其妙的失败。
  // 只回传能力布尔与解析到的路径，不执行任何命令、不写任何东西。
  // PATH 用 buildChildEnv 补全过的那份：与真正 spawn 时的查找范围一致，
  // 不然会出现「探测说没有、启动却成功了」这种自相矛盾的界面。
  ipcMain.handle("runtime:probe", () =>
    probeLocalRuntime({ env: buildChildEnv({ ...process.env }), execPath: process.execPath }),
  );

  app.on("will-quit", () => mcpStdio.disposeAll());

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

  // 语音通话系统通知 + 任务栏闪烁（渲染层经 preload 的 __heming_voice_call.notify 请求）
  ipcMain.on("voice-call:notify", (_event, title, body) => {
    if (Notification.isSupported()) {
      new Notification({ title, body }).show();
    }
    // 任务栏闪烁（Windows/Linux；窗口聚焦时自动停止，见 createWindow 的 focus 处理）
    const win = BrowserWindow.getAllWindows()[0];
    if (win && !win.isFocused()) win.flashFrame(true);
  });

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
    // 本机密钥信封桥（d.36）：preload 在页面加载时用 sendSync 问可用性，
    // 所以必须早于 createWindow()。
    registerSecretIpc(ipcMain);
    // 系统通知桥（d.39）：消息提醒只在窗口不在前台时由渲染层请求；
    // 点击通知显式聚焦主窗口（通话窗口不能截走通知跳转）。
    registerNotifyIpc(ipcMain, { Notification, getMainWindow: () => mainWindow });
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
