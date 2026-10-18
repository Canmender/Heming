"use strict";
const { app, BrowserWindow, Menu, dialog, shell, screen } = require("electron");
const path = require("node:path");
const { loadWindowState, saveWindowState } = require("./window-state");
const {
  shouldShowSplash,
  splashWindowOptions,
  splashCloseDelayMs,
  isFatalLoadFailure,
  LOAD_WATCHDOG_MS,
} = require("./splash-config");

const pkg = require("./package.json");
const { APP_DEFAULT_URL, originOf, secureOrigins } = require("./secure-origins");

// 加载地址优先级：HEMING_DEV_URL（本地开发）> HEMING_WEB_URL > 默认远程（云端中心化）
function resolveAppUrl(env) {
  const e = env || process.env;
  return e.HEMING_DEV_URL || e.HEMING_WEB_URL || APP_DEFAULT_URL;
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

function displayWorkAreas() {
  try {
    return screen.getAllDisplays().map((d) => d.workArea);
  } catch {
    return [];
  }
}

// 通知 web 端开始声波扩散段（BootWave）。preload 在隔离世界执行，故走 executeJavaScript
// 注入到主世界；web 端未就绪（无 window.heming）时静默无副作用。
const BOOT_WAVE_SNIPPET =
  "if (window.heming && window.heming.__startBootWave) window.heming.__startBootWave()";

// 启动动画 splash：无边框透明置顶窗口，覆盖**主窗口所在显示器**的工作区，
// 加载 splash.html（粒子聚拢 1.5s）。HEMING_NO_SPLASH=1 时跳过（E2E/无头环境）。
//
// 时序（与 splash-config.js 的时间轴常量一致）：
//   did-finish-load → 等满粒子聚拢段（splashCloseDelayMs）→ 关闭 splash + 触发声波扩散段。
// 四条收尾路径都保证 splash 一定会被关掉：
//   ① 正常：did-finish-load → 定时关闭 + 触发 BootWave
//   ② 失败：主 frame did-fail-load（非 ERR_ABORTED）→ 直接关闭，露出错误页
//   ③ 超时：LOAD_WATCHDOG_MS 内两者都没来 → 直接关闭
//   ④ 用户关窗：主窗口 closed（此时 window-all-closed 不会触发，splash 还活着）
function createSplashWindow(mainWin) {
  if (!shouldShowSplash()) return;

  // 多显示器：主窗口可能被 window-state 恢复到副屏，splash 跟随主窗口所在显示器，
  // 否则副屏用户只能看到主屏上一块无关的白板。
  const splash = new BrowserWindow(
    splashWindowOptions(screen.getDisplayMatching(mainWin.getBounds()).workArea)
  );
  // 第一段动画从 splash 创建即开始计时（splash.html 加载完成后立刻自播）。
  const splashStartedAt = Date.now();

  let closeTimer = null;
  let watchdog = null;
  let settled = false; // 已决定收尾（关掉 splash），不再接受第二个触发源

  const detach = () => {
    if (closeTimer !== null) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
    if (watchdog !== null) {
      clearTimeout(watchdog);
      watchdog = null;
    }
    try {
      // 主窗口可能已销毁：此时 webContents/窗口对象不可再访问，监听器随窗口一并回收
      mainWin.webContents.removeListener("did-finish-load", onFinishLoad);
      mainWin.webContents.removeListener("did-fail-load", onFailLoad);
      mainWin.removeListener("closed", onMainClosed);
    } catch {
      /* 已销毁，无需清理 */
    }
  };

  // 关闭 splash 并露出主窗口。主窗口以 show:false 创建（否则先于 splash 显示会闪白），
  // 故每条收尾路径都必须负责把它 show 出来。
  const closeSplash = () => {
    if (!splash.isDestroyed()) splash.close();
    if (!mainWin.isDestroyed() && !mainWin.isVisible()) mainWin.show();
  };

  // 正常路径：主窗口加载完成 → 补足粒子聚拢段时长 → 关闭 splash + 触发声波段
  function onFinishLoad() {
    if (settled) return;
    settled = true;
    detach();
    closeTimer = setTimeout(() => {
      closeTimer = null;
      closeSplash();
      if (mainWin.isDestroyed() || mainWin.webContents.isDestroyed()) return;
      mainWin.webContents.executeJavaScript(BOOT_WAVE_SNIPPET).catch(() => {});
    }, splashCloseDelayMs(Date.now() - splashStartedAt));
  }

  // 兜底路径（加载失败 / 看门狗超时 / 主窗口被关）：无动画可播，直接露出主窗口
  const abortSplash = () => {
    if (settled) return;
    settled = true;
    detach();
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
    if (!splash.isDestroyed()) splash.close();
  }

  watchdog = setTimeout(abortSplash, LOAD_WATCHDOG_MS);

  mainWin.webContents.on("did-finish-load", onFinishLoad);
  mainWin.webContents.on("did-fail-load", onFailLoad);
  mainWin.on("closed", onMainClosed);

  // splash 关闭后统一摘除监听与定时器（无论走哪条路径）
  splash.once("closed", detach);

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
      abortSplash();
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
      show: !withSplash,
      backgroundColor: "#ffffff",
      title: "和鸣",
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    // 窗口位置尺寸记忆：resize/move 后 debounce 500ms 落盘，关闭时立即落盘
    let saveTimer = null;
    const scheduleSave = () => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        saveTimer = null;
        saveWindowState(windowStateFile(), win.getBounds());
      }, 500);
    };
    win.on("resize", scheduleSave);
    win.on("move", scheduleSave);
    win.on("close", () => {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      saveWindowState(windowStateFile(), win.getBounds());
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
    win.loadURL(appUrl);
    return win;
  }

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
