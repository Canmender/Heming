"use strict";
const { app, BrowserWindow, Menu, dialog, shell, screen, ipcMain, Notification, protocol, net } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { loadWindowState, saveWindowState } = require("./window-state");
const { shouldShowSplash, splashWindowOptions } = require("./splash-config");
const { attachSplashLifecycle } = require("./splash-lifecycle");
const { resolveRequest, contentTypeFor, INDEX_FILE } = require("./app-protocol");

const pkg = require("./package.json");
const { APP_DEFAULT_URL, originOf, secureOrigins } = require("./secure-origins");
const { titleBarOptions, WINDOW_BACKGROUND } = require("./title-bar");

// ── web 界面嵌入（设计 §4）──────────────────────────────────────────────
// 产物打进安装包、用自定义协议本地加载，摆脱「UI 必须部署云端才可见」与「启动依赖网络」。
// 不能用 file://：它不是安全上下文，crypto.subtle 不可用会让 E2E 加密失效。
// 注册为 privileged + secure 后实测 isSecureContext=true 且明文 ws:// 仍可连
// （见设计文档 §3 的真实 Electron 实测表），且不需要放宽任何安全开关。
const EMBEDDED_SCHEME = "app";
const EMBEDDED_HOST = "heming";
const EMBEDDED_ORIGIN = `${EMBEDDED_SCHEME}://${EMBEDDED_HOST}`;
const EMBEDDED_URL = `${EMBEDDED_ORIGIN}/${INDEX_FILE}`;

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

    // window.open / target=_blank 一律交给系统浏览器，主窗口不开新页
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
    win.on("focus", () => {
      win.flashFrame(false);
    });

    win.loadURL(appUrl);

    // 语音通话：拉取服务端 ICE 配置（STUN/TURN）并注入渲染层。
    // 用 HEMING_API_BASE 指定 API 源；缺省与加载页同源（appUrl 去尾斜杠）。
    // 拉取失败静默——渲染层有公共 STUN 兜底，不阻塞窗口启动。
    const iceBase = process.env.HEMING_API_BASE || appUrl.replace(/\/$/, "");
    fetch(`${iceBase}/api/ice-servers`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data && data.iceServers) {
          // contextBridge.exposeInMainWorld 暴露的属性是只读的，
          // 直接赋值会静默失败，必须通过 setter 函数写入闭包变量。
          win.webContents.executeJavaScript(
            `window.__heming_voice_call.setIceServers(${JSON.stringify(data.iceServers)})`,
          );
        }
      })
      .catch(() => {});

    // 窗口最小化时通知渲染层（渲染层据此弹系统通知，来电不丢）
    win.on("minimize", () => {
      win.webContents.send("voice-call:minimized");
    });

    return win;
  }

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

  app.whenReady().then(() => {
    // 自定义协议处理器须在创建窗口之前装好，否则首次 loadURL 会拿到空响应
    installAppProtocol();
    setupMenu();
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
