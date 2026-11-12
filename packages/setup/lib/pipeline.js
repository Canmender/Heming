"use strict";
/**
 * 安装流程编排。
 *
 * 整个安装器只有这一条主线：
 *   找安装包（内嵌 / 同目录 / 更新服务器）→ 校验 → 静默调用内层 NSIS 安装器 → 等它退出
 *   → 确认主程序落地 → 需要的话拉起。
 *
 * 为什么不做成「自己解压 + 自己写注册表」：
 * 更新、卸载、快捷方式、per-machine 提权这些事 electron-builder 生成的 NSIS 已经做对了，
 * 我们只在它外面套一层自己的界面，出问题也还能退回原来的安装体验。
 *
 * 所有外部能力（网络 / 文件 / spawn / 计时）都从 services 注入，
 * 这样单元测试不需要真的下载 60MB 或真的装一遍。
 */

const path = require("node:path");
const fs = require("node:fs/promises");
const { spawn } = require("node:child_process");

const { SetupError, CODES, asSetupError } = require("./errors");
const {
  parseLatestYml,
  pickWindowsInstaller,
  resolveDownloadUrl,
  versionFromInstallerName,
  decodeFileName,
} = require("./feed");
const { EXE_NAME, sanitizeInstallDir, findLocalPayload } = require("./paths");
const { buildInstallArgs } = require("./args");
const { EtaEstimator } = require("./eta");
const { percentOf } = require("./format");
const download = require("./download");
const { statTree } = require("./dir-stats");
const { startInstaller, killInstallerTree } = require("./installer");

/** 安装期间轮询目标目录的间隔：太密会拖慢安装器自己的 IO，太稀看不出版面在动。 */
const POLL_INTERVAL_MS = 600;
/** 除了安装包本身，还要留出解压时的临时峰值（7z 先解到 TEMP 再复制过去）。 */
const SPACE_HEADROOM_BYTES = 200 * 1024 * 1024;
const MAX_EXISTS_WALK = 12;
const NOOP_LOG = Object.freeze({ info() {}, warn() {}, error() {} });

function createDefaultServices() {
  return {
    fetchText: (url, options) => download.fetchText(url, options),
    downloadFile: (url, dest, options) => download.downloadFile(url, dest, options),
    sha512File: (filePath) => download.sha512File(filePath),
    sha512Equals: download.sha512Equals,
    statTree: (dir, options) => statTree(dir, options),
    startInstaller: (command) => startInstaller(command),
    killInstallerTree: (pid) => killInstallerTree(pid),
    async listDir(dir) {
      try {
        return await fs.readdir(dir);
      } catch {
        return [];
      }
    },
    async exists(target) {
      try {
        await fs.access(target);
        return true;
      } catch {
        return false;
      }
    },
    async freeBytes(dir) {
      try {
        const stats = await fs.statfs(dir);
        return Number(stats.bavail) * Number(stats.bsize);
      } catch {
        return null;
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    async launch(exePath) {
      const child = spawn(exePath, [], { detached: true, stdio: "ignore", windowsHide: false });
      child.unref();
    },
  };
}

/**
 * @param {{
 *   config: ReturnType<typeof import("./config").createConfig>,
 *   paths: {workDir: string, setupDir: string, setupExeName: string},
 *   services?: object,
 *   emit: (event: object) => void,
 *   log?: {info: Function, warn: Function, error: Function},
 * }} input
 */
function createPipeline(input) {
  const { config, paths, emit, log = NOOP_LOG } = input;
  const services = { ...createDefaultServices(), ...(input.services || {}) };

  let controller = null;
  let busy = false;
  let installPid = null;
  let phase = "idle";

  const emitEvent = (event) => {
    if (event && event.type === "phase") phase = event.phase;
    try {
      emit(event);
    } catch (error) {
      log.error(`界面事件发送失败: ${error.message}`);
    }
  };

  /**
   * 找一个真实存在的祖先目录去问剩余空间（安装目录此时还没建出来）。
   * 到盘符根就停下：根目录即是这块盘本身，statfs 在根上问得最准；
   * 不再往上（dirname("C:\\") 还是 "C:\\"，会死循环），也不能返回 null，
   * 否则「装到还不存在的目录」这种情况会悄悄跳过空间检查。
   */
  async function nearestExisting(dir) {
    let current = path.resolve(dir);
    for (let i = 0; i < MAX_EXISTS_WALK; i += 1) {
      if (await services.exists(current)) return current;
      const parent = path.dirname(current);
      if (parent === current) return current;
      current = parent;
    }
    return current;
  }

  async function checkSpace(installDir) {
    if (!config.installedBytes) return;
    const anchor = await nearestExisting(installDir);
    if (!anchor) return;
    const free = await services.freeBytes(anchor);
    if (free === null) return;
    const need = config.installedBytes + SPACE_HEADROOM_BYTES;
    if (free < need) {
      throw new SetupError(
        CODES.NO_SPACE,
        "磁盘空间不够",
        `${anchor} 只剩 ${Math.floor(free / 1024 / 1024)} MB，安装需要约 ${Math.ceil(need / 1024 / 1024)} MB`,
      );
    }
  }

  /** 依次尝试：用户指定 → 内嵌安装包 → setup 同目录的离线安装包 → 更新服务器下载。 */
  async function resolvePayload(ctx, forcedPath) {
    if (forcedPath) {
      if (!(await services.exists(forcedPath))) {
        throw new SetupError(CODES.NO_PAYLOAD, "找不到你选择的安装包", forcedPath);
      }
      emitEvent({ type: "phase", phase: "prepare", label: "校验安装包" });
      return {
        filePath: forcedPath,
        version: versionFromInstallerName(path.basename(forcedPath)) || config.hemingVersion,
        source: "chosen",
      };
    }

    if (config.payloadMode === "embedded" && config.payloadPath) {
      if (await services.exists(config.payloadPath)) {
        emitEvent({ type: "phase", phase: "prepare", label: "校验内嵌安装包" });
        if (config.payloadSha512) {
          const actual = await services.sha512File(config.payloadPath);
          if (!services.sha512Equals(config.payloadSha512, actual)) {
            throw new SetupError(CODES.HASH_MISMATCH, "内嵌的安装包校验失败", "安装器文件可能被改动过，请重新下载");
          }
        }
        return { filePath: config.payloadPath, version: config.hemingVersion, source: "embedded" };
      }
      log.warn("内嵌安装包不存在，改用网络");
    }

    const entries = await services.listDir(paths.setupDir);
    const localName = findLocalPayload(entries, paths.setupExeName);
    if (localName) {
      emitEvent({ type: "phase", phase: "prepare", label: "使用同目录的安装包" });
      return {
        filePath: path.join(paths.setupDir, localName),
        version: versionFromInstallerName(localName) || config.hemingVersion,
        source: "local",
      };
    }

    emitEvent({ type: "phase", phase: "prepare", label: "连接更新服务器" });
    const feedUrl = `${config.feedUrl}/latest.yml`;
    let text;
    try {
      text = await services.fetchText(feedUrl, { signal: ctx.signal });
    } catch (error) {
      if (error && error.name === "AbortError") throw error;
      throw asSetupError(error, CODES.NETWORK, "连不上更新服务器，请检查网络后重试");
    }

    const feed = parseLatestYml(text);
    const file = pickWindowsInstaller(feed);
    if (!file) throw new SetupError(CODES.FEED_INVALID, "更新信息里没有 Windows 安装包", feedUrl);

    const url = resolveDownloadUrl(config.feedUrl, file.url);
    const version = versionFromInstallerName(decodeFileName(file.url)) || null;
    const destination = path.join(paths.workDir, "inner-setup.exe");
    emitEvent({ type: "phase", phase: "download", label: "下载安装包", totalBytes: file.size ?? null, version });

    const eta = new EtaEstimator();
    let result;
    try {
      result = await services.downloadFile(url, destination, {
        signal: ctx.signal,
        expectedSize: file.size ?? null,
        onProgress: ({ received, total }) => {
          eta.sample(received);
          emitEvent({
            type: "progress",
            received,
            total: total ?? file.size ?? null,
            rate: eta.rate(),
            remaining: eta.remaining(total ?? file.size ?? null),
          });
        },
      });
    } catch (error) {
      if (error && error.name === "AbortError") throw error;
      throw asSetupError(error, CODES.DOWNLOAD_FAILED, "安装包下载失败");
    }

    emitEvent({ type: "phase", phase: "verify", label: "校验安装包" });
    if (file.sha512 && !services.sha512Equals(file.sha512, result.sha512)) {
      throw new SetupError(CODES.HASH_MISMATCH, "下载的安装包不完整", "校验值对不上，请重试");
    }
    return { filePath: result.filePath, version, source: "network" };
  }

  /** 安装期间按目录增长刷新「已写入多少个文件」。装完的那一下不追求 100%，宁可停在 99%。 */
  async function pollInstall(installDir, ctx) {
    while (!ctx.stopped) {
      await services.sleep(POLL_INTERVAL_MS);
      if (ctx.stopped) break;
      try {
        const stats = await services.statTree(installDir, { signal: ctx.signal });
        emitEvent({
          type: "files",
          files: stats.files,
          bytes: stats.bytes,
          percent: percentOf(stats.bytes, config.installedBytes),
        });
      } catch {
        break;
      }
    }
  }

  /**
   * 找主程序。electron-builder 的静默安装理论上会把文件直接铺到 /D= 指定的目录，
   * 但 APP_FILENAME 在某些布局下会多套一层，所以找不到时再看一层子目录。
   */
  async function locateInstalledExe(installDir) {
    const direct = path.join(installDir, EXE_NAME);
    if (await services.exists(direct)) return { exePath: direct, installDir };
    const children = await services.listDir(installDir);
    for (const name of children) {
      const nestedDir = path.join(installDir, name);
      const nested = path.join(nestedDir, EXE_NAME);
      if (await services.exists(nested)) return { exePath: nested, installDir: nestedDir };
    }
    return null;
  }

  async function start(options = {}) {
    if (busy) return { ok: false, code: "busy" };
    const installDir = sanitizeInstallDir(options.installDir);
    if (!installDir) {
      emitEvent({
        type: "error",
        code: CODES.INVALID_DIR,
        message: "这个安装位置不能用",
        detail: "请选择一个普通的文件夹，比如 D:\\Programs\\Heming",
      });
      return { ok: false, code: CODES.INVALID_DIR };
    }

    busy = true;
    phase = "prepare";
    controller = new AbortController();
    const ctx = { signal: controller.signal, stopped: false };
    const launchAfter = options.launchAfter !== false;

    try {
      emitEvent({ type: "phase", phase: "prepare", label: "检查安装位置" });
      await checkSpace(installDir);

      const payload = await resolvePayload(ctx, options.payloadPath);
      emitEvent({
        type: "phase",
        phase: "install",
        label: "正在安装",
        version: payload.version,
        totalBytes: config.installedBytes || null,
      });
      log.info(`静默安装 ${payload.source} 安装包 -> ${installDir}`);

      const command = {
        file: payload.filePath,
        args: buildInstallArgs(installDir),
        // windowsVerbatimArguments 必须开着，否则 Node 会给 /D= 里的空格加引号，
        // NSIS 会静默忽略这个参数、装回默认目录（见 lib/args.js 的说明）。
        options: { cwd: paths.workDir, windowsVerbatimArguments: true, windowsHide: true },
      };
      const started = services.startInstaller(command);
      installPid = started && started.child ? started.child.pid : null;

      const polling = pollInstall(installDir, ctx);
      const exit = await started.done;
      ctx.stopped = true;
      await polling;
      installPid = null;

      const located = await locateInstalledExe(installDir);
      if (!located) {
        // 退出码 0 不代表装好了：用户可能在 UAC 里点了「否」，内层安装器照样安静退出。
        throw new SetupError(
          CODES.INSTALL_FAILED,
          "安装没有完成",
          `没有在 ${installDir} 找到 ${EXE_NAME}（退出码 ${exit.code}${exit.signal ? `，${exit.signal}` : ""}）`,
        );
      }

      let launched = false;
      if (launchAfter) {
        try {
          await services.launch(located.exePath);
          launched = true;
        } catch (error) {
          log.warn(`拉起 和鸣 失败: ${error.message}`);
        }
      }

      const result = {
        type: "done",
        installDir: located.installDir,
        exePath: located.exePath,
        version: payload.version,
        launched,
      };
      emitEvent(result);
      log.info(`安装完成 ${located.exePath}`);
      return { ok: true, ...result };
    } catch (error) {
      const cancelled =
        (error && error.code === CODES.CANCELLED) || (error && error.name === "AbortError");
      if (cancelled) {
        emitEvent({ type: "cancelled" });
        log.warn("用户在下载阶段取消了安装");
        return { ok: false, code: CODES.CANCELLED };
      }
      const failure = asSetupError(error, CODES.INSTALL_FAILED, "安装失败");
      log.error(`${failure.code}: ${failure.message} ${failure.detail || ""}`);
      emitEvent({ type: "error", code: failure.code, message: failure.message, detail: failure.detail || null });
      return { ok: false, code: failure.code };
    } finally {
      busy = false;
      phase = "idle";
      installPid = null;
      controller = null;
    }
  }

  /** 只有下载/准备阶段能取消；安装阶段打断内层安装器会留下半装状态，宁可让它跑完。 */
  function cancel() {
    if (!busy || !controller) return { ok: false, reason: "idle" };
    if (phase === "install") return { ok: false, reason: "installing" };
    controller.abort();
    return { ok: true };
  }

  function dispose() {
    if (controller) controller.abort();
    if (installPid) {
      killInstallerTree(installPid);
      installPid = null;
    }
    busy = false;
  }

  return {
    start,
    cancel,
    dispose,
    isBusy: () => busy,
    currentPhase: () => phase,
  };
}

module.exports = { createPipeline, createDefaultServices, POLL_INTERVAL_MS, SPACE_HEADROOM_BYTES };
