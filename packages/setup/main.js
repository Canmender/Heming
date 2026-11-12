"use strict";
/**
 * 自绘安装器的主进程。
 *
 * 它只做四件事：
 * 1. 开一个无边框窗口装界面（900×620，固定尺寸，和品牌纸面比例对应）；
 * 2. 把「选目录 / 开始 / 取消 / 开文件夹 / 看日志」这些动作转给 pipeline；
 * 3. 把 pipeline 的状态推给渲染进程；
 * 4. 开发期用 --capture=<dir> 出各状态截图（见 lib/capture.js）。
 *
 * 真正的安装动作仍然由 electron-builder 生成的 NSIS 安装器完成（静默），
 * 这样卸载、快捷方式、自动更新都还是原来那一套。
 */

const path = require("node:path");
const fs = require("node:fs");
const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");

const pathTools = require("./lib/paths");
const { createLog } = require("./lib/log");
const { createConfig } = require("./lib/config");
const { createPipeline } = require("./lib/pipeline");
const { captureShots, DEFAULT_SHOTS } = require("./lib/capture");

const WINDOW_WIDTH = 900;
const WINDOW_HEIGHT = 620;
const CAPTURE_SETTLE_MS = 260;

/** @type {BrowserWindow|null} */
let windowRef = null;
let pipeline = null;
let log = null;
let config = null;
let installing = false;
let closing = false;

const captureDir = readCaptureTarget(process.argv);

/**
 * 打包产物（portable 单 exe）在某些机器上会把命令行里的 `--capture=…` 吞掉，
 * 所以截图目录也支持用环境变量给：脚本化验收时更稳，不依赖参数转发。
 */
function readCaptureTarget(argv) {
  const fromEnv = process.env.HEMING_SETUP_CAPTURE_DIR;
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv.trim());
  const prefix = "--capture=";
  const arg = argv.find((value) => typeof value === "string" && value.startsWith(prefix));
  if (!arg) return null;
  const dir = arg.slice(prefix.length).trim();
  return dir ? path.resolve(dir) : null;
}

/**
 * 启动期诊断日志：正常日志要等 whenReady 之后才有，但打包版曾在
 * whenReady 之前就静默退出，所以这里在关键步骤各记一行，便于定位卡在哪。
 */
function traceStep(message) {
  try {
    const dir = pathTools.workDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, "bootstrap.log"),
      `${new Date().toISOString()} ${message}\n`,
      "utf8",
    );
  } catch {
    // 诊断日志失败不能影响启动
  }
}

traceStep(
  `module-load packaged=${app.isPackaged} capture=${captureDir ? "on" : "off"} argv=${JSON.stringify(process.argv.slice(1))}`,
);

/** 用户双击的那个 setup.exe 所在目录；开发态指向包目录，方便放一个离线安装包测试。 */
function resolveSetupLocation() {
  const workDir = pathTools.workDir();
  if (app.isPackaged || process.env.PORTABLE_EXECUTABLE_FILE) {
    return { setupDir: pathTools.setupExeDir(), setupExeName: path.basename(pathTools.setupExePath()), workDir };
  }
  return { setupDir: path.join(__dirname, "payload"), setupExeName: "setup-dev.exe", workDir };
}

/** 已经装过的版本：只看默认目录，够用来在界面上提示「会覆盖现有版本」。 */
function detectExistingInstall() {
  const dir = pathTools.defaultInstallDir();
  if (!dir) return null;
  const exe = pathTools.installedExe(dir);
  try {
    const stats = require("node:fs").statSync(exe);
    return stats.isFile() ? dir : null;
  } catch {
    return null;
  }
}

function emitToWindow(event) {
  if (windowRef && !windowRef.isDestroyed()) {
    windowRef.webContents.send("setup:event", event);
  }
}

function sendEventFromPipeline(event) {
  emitToWindow(event);
}

function createWindow() {
  windowRef = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    useContentSize: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    frame: false,
    show: false,
    backgroundColor: "#f5f2ea",
    title: "安装 和鸣",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });

  windowRef.removeMenu();
  windowRef.loadFile(path.join(__dirname, "renderer", "index.html"));

  windowRef.once("ready-to-show", () => {
    windowRef.show();
  });

  windowRef.on("close", (event) => {
    if (closing) return;
    event.preventDefault();
    requestClose();
  });

  windowRef.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  windowRef.webContents.on("will-navigate", (event) => event.preventDefault());

  windowRef.webContents.once("did-finish-load", async () => {
    traceStep("did-finish-load");
    if (!captureDir) return;
    try {
      await new Promise((resolve) => setTimeout(resolve, CAPTURE_SETTLE_MS));
      windowRef.show();
      traceStep("capture-start");
      const files = await captureShots(windowRef.webContents, captureDir, DEFAULT_SHOTS);
      traceStep(`capture-done files=${files.length}`);
      process.stdout.write(`截图已保存：\n${files.join("\n")}\n`);
      closing = true;
      app.quit();
    } catch (error) {
      traceStep(`capture-failed ${error.stack || error.message}`);
      process.stderr.write(`截图失败：${error.stack || error.message}\n`);
      app.exit(1);
    }
  });
}

async function requestClose() {
  if (installing) {
    const { response } = await dialog.showMessageBox(windowRef, {
      type: "question",
      title: "安装还没结束",
      message: "安装还在进行。现在退出会留下装了一半的文件，下次还得重装。",
      buttons: ["继续安装", "仍然退出"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (response !== 1) return;
    if (pipeline) pipeline.dispose();
  }
  closing = true;
  if (windowRef && !windowRef.isDestroyed()) windowRef.close();
}

function registerIpc() {
  ipcMain.handle("setup:init", () => ({
    version: config.hemingVersion,
    semver: config.semverVersion,
    defaultDir: pathTools.defaultInstallDir(),
    existingDir: detectExistingInstall(),
    installedBytes: config.installedBytes,
    payloadMode: config.payloadMode,
    capture: Boolean(captureDir),
    logPath: log.path,
  }));

  ipcMain.handle("setup:choose-directory", async (_event, current) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(windowRef, {
      title: "选择安装位置",
      defaultPath: pathTools.sanitizeInstallDir(current) || pathTools.defaultInstallDir() || "C:\\",
      properties: ["openDirectory", "createDirectory"],
      buttonLabel: "装在这里",
    });
    if (canceled || filePaths.length === 0) return null;
    return pathTools.sanitizeInstallDir(filePaths[0]);
  });

  ipcMain.handle("setup:pick-payload", async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(windowRef, {
      title: "选择 和鸣 安装包",
      properties: ["openFile"],
      filters: [{ name: "安装包", extensions: ["exe"] }],
    });
    if (canceled || filePaths.length === 0) return null;
    return filePaths[0];
  });

  ipcMain.handle("setup:start", async (_event, options = {}) => {
    const installDir = pathTools.sanitizeInstallDir(options.installDir) || pathTools.defaultInstallDir();
    installing = true;
    try {
      return await pipeline.start({
        installDir,
        launchAfter: options.launchAfter !== false,
        payloadPath: options.payloadPath || process.env.HEMING_SETUP_PAYLOAD || undefined,
      });
    } finally {
      installing = false;
    }
  });

  ipcMain.handle("setup:cancel", () => pipeline.cancel());

  ipcMain.handle("setup:open-folder", async (_event, dir) => {
    const target = pathTools.sanitizeInstallDir(dir) || pathTools.defaultInstallDir();
    if (!target) return false;
    const failure = await shell.openPath(target);
    return failure === "";
  });

  ipcMain.handle("setup:open-installed", async (_event, dir) => {
    const target = pathTools.sanitizeInstallDir(dir) || pathTools.defaultInstallDir();
    if (!target) return false;
    const failure = await shell.openPath(pathTools.installedExe(target));
    return failure === "";
  });

  ipcMain.handle("setup:open-log", async () => {
    const failure = await shell.openPath(log.path);
    return failure === "";
  });

  ipcMain.handle("window:minimize", () => {
    if (windowRef && !windowRef.isDestroyed()) windowRef.minimize();
  });

  ipcMain.handle("window:close", () => requestClose());

  ipcMain.handle("app:quit", () => requestClose());
}

function bootstrap() {
  app.setAppUserModelId("com.heming.setup");

  app
    .whenReady()
    .then(() => {
      traceStep("when-ready");
      config = createConfig({
        appPath: __dirname,
        resourcesPath: process.resourcesPath,
        isPackaged: app.isPackaged,
        pkg: require("./package.json"),
      });
      traceStep(`config-ok version=${config.hemingVersion}`);
      // 下载目标、安装器 cwd、日志都指向这里，必须先把目录建出来：
      // spawn 的 cwd 指向不存在的目录会直接 ENOENT，下载也不会自己补父目录以外的层级。
      fs.mkdirSync(pathTools.workDir(), { recursive: true });
      log = createLog(path.join(pathTools.workDir(), "setup.log"));
      log.info(`安装器启动 heming=${config.hemingVersion} packaged=${app.isPackaged} capture=${captureDir ? "on" : "off"}`);

      pipeline = createPipeline({
        config,
        paths: resolveSetupLocation(),
        emit: sendEventFromPipeline,
        log,
      });

      registerIpc();
      createWindow();
      traceStep("window-created");

      app.on("window-all-closed", () => app.quit());
    })
    .catch((error) => {
      traceStep(`bootstrap-failed ${error.stack || error.message}`);
      process.stderr.write(`启动失败：${error.stack || error.message}\n`);
      app.exit(1);
    });
}

const gotLock = app.requestSingleInstanceLock();
traceStep(`single-instance-lock=${gotLock}`);
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!windowRef) return;
    if (windowRef.isMinimized()) windowRef.restore();
    windowRef.focus();
  });
  bootstrap();
}

process.on("uncaughtException", (error) => {
  traceStep(`uncaught ${error.stack || error.message}`);
  if (log) log.error(`未捕获异常: ${error.stack || error.message}`);
  process.stderr.write(`${error.stack || error.message}\n`);
});

process.on("unhandledRejection", (reason) => {
  const message = reason && (reason.stack || reason.message) ? reason.stack || reason.message : String(reason);
  traceStep(`unhandled-rejection ${message}`);
  if (log) log.error(`未处理的 Promise 拒绝: ${message}`);
});
