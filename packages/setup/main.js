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

/**
 * 安装期要反复 stat 目标目录（lib/dir-stats.js），而 libuv 线程池默认只有 4 个
 * 线程；实测 8486 个文件的目录树在默认线程数下要 600~700ms，调到 16 之后
 * 是 300~400ms（哈希、下载写盘也共用这个池，算是顺手变快）。
 * 必须在任何 fs 异步调用之前设置，Node 只在启动时读一次。
 */
process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || "16";

const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");

const pathTools = require("./lib/paths");
const { createLog } = require("./lib/log");
const { createConfig } = require("./lib/config");
const { createPipeline } = require("./lib/pipeline");
const { captureShots, DEFAULT_SHOTS } = require("./lib/capture");
const { wantsUpdate, resolvePlanPath, readPlan, removePlan } = require("./lib/update-plan");
const { CODES } = require("./lib/errors");

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
/**
 * 更新模式：桌面端把「装哪个包、装到哪」写在计划文件里再叫起本程序。
 * 计划读失败时不让窗口停在「安装位置」屏——用户不知道自己要装什么，
 * 直接把原因摆到错误屏，让他回应用里重试。
 */
const updateRequest = wantsUpdate(process.argv, process.env);
const planFile = updateRequest ? resolvePlanPath(process.env, pathTools.workDir()) : null;
/** @type {null | {installerPath: string, installDir: string, version: string, currentVersion: string, relaunch: boolean}} */
let updatePlan = null;
/** 计划读不出来时的错误文案（初始化时交给界面）。 */
let planError = null;
/**
 * 更新服务器上当前发布的最新版本（通用外壳）。
 *
 * 外壳不再绑定某一版：界面上的「版本」读这里；探测还没回来时回落到
 * 打包时烘进 `config/generated.json` 的版本（离线/断网/内嵌形态都走回落）。
 * @type {string|null}
 */
let latestVersion = null;
/** 最新安装包的字节数（界面上「安装包大小」用；未知时为 null）。 */
let latestSize = null;

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

/** 更新计划不可用时留下排查线索：界面上只会给一句人话，细节必须进日志。 */
function recordPlanError(error, tag) {
  const detail = error && (error.detail || error.message) ? error.detail || error.message : String(error);
  traceStep(`update-plan-failed(${tag}) ${detail}`);
  if (log) log.error(`更新计划不可用（${tag}）：${detail}`);
}

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
  // 更新完成就把计划删掉：留着它，下次用户手动双击安装器（没带环境变量）不受影响，
  // 但若桌面端又用同一路径写新计划，旧内容也不会被误用。
  if (event && event.type === "done" && planFile) removePlan(planFile);
}

/**
 * 通用外壳的第一步：问一下更新服务器「现在最新是哪一版」。
 *
 * 只读 `latest.yml`，不下包、不校验签名——预取/安装主线会自己再读一次并给出
 * 真正的错误。这里失败就静默回落到烘进包的版本，不让「联网慢」挡住安装界面。
 * 更新模式不问：装哪一版由桌面端写好的计划文件指定，问了反而会显示错的版本。
 */
async function probeLatestVersion() {
  if (!pipeline || updateRequest) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const latest = await pipeline.probeLatest({ signal: controller.signal });
    if (!latest || !latest.version) return;
    latestVersion = latest.version;
    latestSize = latest.size;
    log.info(`更新服务器最新版 ${latest.version}${latest.size ? `（${latest.size} 字节）` : ""}`);
    emitToWindow({ type: "latest", version: latest.version, size: latest.size });
  } catch (error) {
    log.warn(`探测最新版失败，界面沿用 ${config.hemingVersion}：${error && error.message ? error.message : error}`);
  } finally {
    clearTimeout(timer);
  }
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
    title: updateRequest ? "更新 和鸣" : "安装 和鸣",
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
    if (!captureDir) {
      // 窗口能画了才开始后台预取：不抢启动时的 CPU/IO，截图模式也不跑下载。
      // 更新模式的安装包已经由桌面端下载好，没有可预取的东西。
      if (pipeline && !updateRequest) {
        pipeline.prefetch().catch((error) => traceStep(`prefetch-crashed ${error.message}`));
      }
      return;
    }
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
    const noun = updateRequest ? "更新" : "安装";
    const { response } = await dialog.showMessageBox(windowRef, {
      type: "question",
      title: `${noun}还没结束`,
      message: `${noun}还在进行。现在退出会留下不完整的状态，下次还得再来一次。`,
      buttons: [`继续${noun}`, "仍然退出"],
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
    // 通用外壳：界面上显示的版本优先用「服务器上现在最新的一版」；
    // 探测还没回来/失败时回落到打包时烘进去的版本（离线形态同理）。
    version: latestVersion || config.hemingVersion,
    /** 外壳自身的构建版本（排查用；正常安装流程不用它）。 */
    installerVersion: config.hemingVersion,
    latestKnown: Boolean(latestVersion),
    latestSize,
    semver: config.semverVersion,
    defaultDir: pathTools.defaultInstallDir(),
    existingDir: detectExistingInstall(),
    installedBytes: config.installedBytes,
    payloadMode: config.payloadMode,
    capture: Boolean(captureDir),
    logPath: log.path,
    mode: updateRequest ? "update" : "install",
    update: updatePlan
      ? {
          version: updatePlan.version || config.hemingVersion,
          currentVersion: updatePlan.currentVersion,
          installDir: updatePlan.installDir,
          relaunch: updatePlan.relaunch,
        }
      : null,
    planError: planError ? { code: planError.code, message: planError.message, detail: planError.detail } : null,
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
    // 更新模式下计划读不出来时，界面上的「重试」不该退化成一次全新安装：
    // 那会把程序装到默认目录，而用户以为自己只是在更新。
    if (updateRequest && !updatePlan) {
      return {
        ok: false,
        code: planError ? planError.code : CODES.NO_PAYLOAD,
        message: planError ? planError.message : "更新计划读不出来，请回应用里重新下载。",
        detail: planError ? planError.detail : "",
      };
    }
    // 更新模式不接受界面传来的路径：装哪个包、装到哪由计划决定，
    // 免得渲染层（或将来某个快捷键）改出计划外的安装位置。
    const installDir = updatePlan
      ? pathTools.sanitizeInstallDir(updatePlan.installDir)
      : pathTools.sanitizeInstallDir(options.installDir) || pathTools.defaultInstallDir();
    installing = true;
    try {
      return await pipeline.start({
        installDir,
        launchAfter: updatePlan ? updatePlan.relaunch : options.launchAfter !== false,
        payloadPath: updatePlan ? updatePlan.installerPath : options.payloadPath || process.env.HEMING_SETUP_PAYLOAD || undefined,
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
      log.info(`模式=${updateRequest ? "update" : "install"}${planFile ? ` 计划=${planFile}` : ""}`);

      if (updateRequest) {
        try {
          updatePlan = readPlan(planFile);
          // 计划里的安装包是桌面端刚下载的临时文件，可能已经被清理工具带走：
          // 早点确认存在，别等用户点了「继续」才失败。
          if (!fs.existsSync(updatePlan.installerPath)) {
            planError = {
              code: CODES.NO_PAYLOAD,
              message: "更新包已经不在原处了，请回应用里重新下载。",
              detail: updatePlan.installerPath,
            };
            recordPlanError(planError, "missing-payload");
          } else {
            traceStep(`update-mode version=${updatePlan.version} dir=${updatePlan.installDir}`);
          }
        } catch (error) {
          planError = {
            code: error.code || CODES.NO_PAYLOAD,
            message: error.message || "更新计划读不出来",
            detail: error.detail || "",
          };
          recordPlanError(error, "plan-invalid");
        }
      }

      pipeline = createPipeline({
        config,
        paths: resolveSetupLocation(),
        emit: sendEventFromPipeline,
        log,
      });

      registerIpc();
      createWindow();
      traceStep("window-created");
      void probeLatestVersion();

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
