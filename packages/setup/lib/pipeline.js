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

/** 安装期间轮询目标目录的间隔：太密会跟解压抢 IO，太稀看不出版面在动。 */
const POLL_INTERVAL_MS = 900;
/** 除了安装包本身，还要留出解压时的临时峰值（7z 先解到 TEMP 再复制过去）。 */
const SPACE_HEADROOM_BYTES = 200 * 1024 * 1024;
const MAX_EXISTS_WALK = 12;
/** 下载失败自动重试次数：断网、代理抖动、服务器提前掐断都值得再试两次，.part 会接着续。 */
const MAX_DOWNLOAD_ATTEMPTS = 3;
/**
 * 进度事件的最小间隔。
 *
 * download.js 每收一个数据块就回调一次（64KB 级，300MB 的包意味着几千次），
 * 原样转发会变成每秒上百次 IPC + 上百次界面重绘，进度条反而更卡。
 * 120ms 约等于 8fps，肉眼看是连续的，渲染开销降一个数量级。
 */
const PROGRESS_EMIT_INTERVAL_MS = 120;
/** 安装包缓存元数据：版本 / 大小 / 摘要 / mtime，用来免掉每次启动的全量哈希。 */
const PAYLOAD_META_SUFFIX = ".meta.json";
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
    async removeFile(target) {
      await fs.rm(target, { force: true }).catch(() => {});
    },
    async statFile(target) {
      try {
        return await fs.stat(target);
      } catch {
        return null;
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
  /**
   * 后台预取任务。窗口一打开就去找安装包、开始下载：用户在「安装位置」这屏
   * 读路径、改目录的十几秒里，300MB 通常已经下完，点「开始安装」直接进安装。
   * 同一份任务被「开始安装」接管（visible 翻成 true，进度改走工作屏）。
   */
  let prefetchTask = null;
  /**
   * 预取成功后把结论留下：用户点「开始安装」时直接用，不再重新找包、不再重算哈希。
   */
  let prefetchedPayload = null;

  const isAbort = (error) => Boolean(error) && (error.name === "AbortError" || error.code === CODES.CANCELLED);

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

  /** 内层安装包在临时目录里的落脚点；续传的 .part 就在它旁边。 */
  function payloadDestination() {
    return path.join(paths.workDir, "inner-setup.exe");
  }

  /**
   * 上次已经下好并校验通过的安装包可以直接复用：
   * 大小与 latest.yml 对得上、sha512 也对得上才算命中，否则当垃圾清掉重下。
   *
   * 第一次启动必须对整包做一次 sha512（300MB 约几百毫秒）。下载成功时我们把
   * 版本/大小/mtime/摘要写在旁边的 .meta.json 里；文件没被动过就直接信这份
   * 元数据，省掉这次全量读盘。大小或 mtime 变了就退回真正的哈希校验。
   */
  async function readPayloadMeta(dest) {
    try {
      const text = await fs.readFile(`${dest}${PAYLOAD_META_SUFFIX}`, "utf8");
      const meta = JSON.parse(text);
      return meta && typeof meta === "object" ? meta : null;
    } catch {
      return null;
    }
  }

  async function writePayloadMeta(dest, version, result) {
    try {
      const stats = await services.statFile(dest);
      if (!stats || !stats.isFile()) return;
      const meta = {
        version,
        size: typeof result.bytes === "number" ? result.bytes : stats.size,
        sha512: result.sha512 ?? null,
        mtimeMs: stats.mtimeMs,
      };
      await fs.writeFile(`${dest}${PAYLOAD_META_SUFFIX}`, JSON.stringify(meta), "utf8");
    } catch (error) {
      // 元数据只是加速手段，写不进去不影响安装，最多下次多算一次哈希。
      log.warn(`写入安装包缓存元数据失败：${error.message}`);
    }
  }

  async function cachedPayload(file, version) {
    const dest = payloadDestination();
    if (!(await services.exists(dest))) return null;
    const stats = await services.statFile(dest);
    if (!stats || !stats.isFile()) return null;
    const expected = typeof file.size === "number" ? file.size : null;
    if (expected !== null && stats.size !== expected) return null;

    const meta = await readPayloadMeta(dest);
    const metaTrusted =
      meta &&
      meta.version === version &&
      meta.size === stats.size &&
      Number.isFinite(meta.mtimeMs) &&
      Math.abs(stats.mtimeMs - meta.mtimeMs) < 2000 &&
      (!file.sha512 || !meta.sha512 || services.sha512Equals(file.sha512, meta.sha512));
    if (metaTrusted) {
      log.info(`安装包缓存命中（元数据一致），跳过整包校验：${dest}`);
      return { filePath: dest, version, source: "cache" };
    }

    const actual = await services.sha512File(dest);
    if (file.sha512 && !services.sha512Equals(file.sha512, actual)) {
      await services.removeFile(dest);
      await services.removeFile(`${dest}${PAYLOAD_META_SUFFIX}`);
      return null;
    }
    return { filePath: dest, version, source: "cache" };
  }

  /**
   * 下载安装包：失败自动重试，续传走 .part（download.js 在续传模式下只补缺的字节，
   * 并把已有前缀一起喂给 sha512，所以校验的始终是整个文件）。
   */
  async function downloadPayload(file, url, ctx, sink, version) {
    const dest = payloadDestination();
    const expected = typeof file.size === "number" ? file.size : null;
    let lastError = null;
    for (let attempt = 1; attempt <= MAX_DOWNLOAD_ATTEMPTS; attempt += 1) {
      const eta = new EtaEstimator();
      // 每次重试都重新计时：续传的第一帧要立刻让界面知道「动了」。
      let lastEmitAt = 0;
      try {
        const result = await services.downloadFile(url, dest, {
          signal: ctx.signal,
          expectedSize: expected,
          resume: true,
          onProgress: ({ received, total }) => {
            eta.sample(received);
            const nowMs = Date.now();
            const complete = expected !== null && received >= expected;
            if (!complete && lastEmitAt !== 0 && nowMs - lastEmitAt < PROGRESS_EMIT_INTERVAL_MS) return;
            lastEmitAt = nowMs;
            sink({
              type: "progress",
              received,
              total: total ?? expected,
              rate: eta.rate(),
              remaining: eta.remaining(total ?? expected),
            });
          },
        });
        if (file.sha512 && !services.sha512Equals(file.sha512, result.sha512)) {
          throw new SetupError(CODES.HASH_MISMATCH, "下载的安装包不完整", "校验值对不上，请重试");
        }
        await writePayloadMeta(dest, version, result);
        return result;
      } catch (error) {
        if (isAbort(error)) throw error;
        lastError = error;
        if (error && error.code === CODES.HASH_MISMATCH) {
          // 半截 .part 本身可能是坏的：清掉重下，别让坏数据一直被续传。
          await services.removeFile(`${dest}.part`);
          await services.removeFile(dest);
        }
        if (attempt < MAX_DOWNLOAD_ATTEMPTS) {
          const waitMs = 1000 * attempt;
          log.warn(`下载安装包失败（第 ${attempt} 次）：${error.message}；${waitMs}ms 后重试`);
          await services.sleep(waitMs);
        }
      }
    }
    throw asSetupError(lastError, CODES.DOWNLOAD_FAILED, "安装包下载失败");
  }

  /**
   * 预取阶段的事件形状与安装阶段不同：界面在「安装位置」这屏只想显示一行
   * 「安装包 已准备 37%」，不该因为后台下载就把整屏切走。
   */
  function prefetchSinkFor(task) {
    return (event) => {
      if (task.settled) return;
      const base = { type: "prefetch" };
      if (event.type === "progress") {
        emit({
          ...base,
          stage: "downloading",
          received: event.received,
          total: event.total,
          rate: event.rate,
          remaining: event.remaining,
          percent: percentOf(event.received, event.total),
        });
        return;
      }
      if (event.type === "phase") {
        const stage = event.phase === "download" ? "downloading" : event.phase === "verify" ? "verifying" : "resolving";
        emit({ ...base, stage, label: event.label || null, version: event.version || null });
        return;
      }
      if (event.type === "prefetch") {
        emit(event);
      }
    };
  }

  /** 依次尝试：用户指定 → 内嵌安装包 → setup 同目录的离线安装包 → 更新服务器下载。 */
  async function resolvePayload(ctx, forcedPath, sink) {
    if (forcedPath) {
      if (!(await services.exists(forcedPath))) {
        throw new SetupError(CODES.NO_PAYLOAD, "找不到你选择的安装包", forcedPath);
      }
      sink({ type: "phase", phase: "prepare", label: "校验安装包" });
      return {
        filePath: forcedPath,
        version: versionFromInstallerName(path.basename(forcedPath)) || config.hemingVersion,
        source: "chosen",
      };
    }

    if (config.payloadMode === "embedded" && config.payloadPath) {
      if (await services.exists(config.payloadPath)) {
        sink({ type: "phase", phase: "prepare", label: "校验内嵌安装包" });
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
      sink({ type: "phase", phase: "prepare", label: "使用同目录的安装包" });
      return {
        filePath: path.join(paths.setupDir, localName),
        version: versionFromInstallerName(localName) || config.hemingVersion,
        source: "local",
      };
    }

    sink({ type: "phase", phase: "prepare", label: "连接更新服务器" });
    const feedUrl = `${config.feedUrl}/latest.yml`;
    let text;
    try {
      text = await services.fetchText(feedUrl, { signal: ctx.signal });
    } catch (error) {
      if (isAbort(error)) throw error;
      throw asSetupError(error, CODES.NETWORK, "连不上更新服务器，请检查网络后重试");
    }

    const feed = parseLatestYml(text);
    const file = pickWindowsInstaller(feed);
    if (!file) throw new SetupError(CODES.FEED_INVALID, "更新信息里没有 Windows 安装包", feedUrl);

    const url = resolveDownloadUrl(config.feedUrl, file.url);
    const version = versionFromInstallerName(decodeFileName(file.url)) || null;

    // 缓存命中：同一个包上次已经下好、大小和 sha512 都对得上，直接进安装。
    const cached = await cachedPayload(file, version);
    if (cached) {
      log.info("安装包已存在且校验通过，跳过下载");
      sink({ type: "phase", phase: "prepare", label: "使用已下载的安装包", version });
      return cached;
    }

    sink({ type: "phase", phase: "download", label: "下载安装包", totalBytes: file.size ?? null, version });
    const result = await downloadPayload(file, url, ctx, sink, version);

    sink({ type: "phase", phase: "verify", label: "校验安装包" });
    return { filePath: result.filePath, version, source: "network" };
  }

  /**
   * 单飞的「准备安装包」任务：预取和「开始安装」共用同一个 promise。
   * 用户还没点开始，进度走 prefetch 事件；点了开始就翻转 visible，
   * 同一个下载的后续进度改走工作屏，不会重复下载。
   */
  function ensurePayloadTask({ forcedPath = null, visible = false } = {}) {
    if (prefetchTask && !prefetchTask.settled && prefetchTask.forcedPath === forcedPath) {
      if (visible) prefetchTask.visible = true;
      return prefetchTask;
    }
    const taskController = new AbortController();
    const task = {
      controller: taskController,
      ctx: { signal: taskController.signal, stopped: false },
      forcedPath,
      visible,
      settled: false,
      promise: null,
    };
    const sinkToPrefetch = prefetchSinkFor(task);
    const sink = (event) => {
      if (task.settled) return;
      try {
        if (task.visible) {
          emitEvent(event);
        } else {
          sinkToPrefetch(event);
        }
      } catch (error) {
        log.error(`界面事件发送失败: ${error.message}`);
      }
    };
    task.promise = resolvePayload(task.ctx, forcedPath, sink).finally(() => {
      task.settled = true;
    });
    prefetchTask = task;
    return task;
  }

  /**
   * 后台预取安装包。窗口一打开就调用：用户在「安装位置」这屏的十几秒里，
   * 安装包通常已经下完，点「开始安装」就不必再等下载。
   * 失败不弹错——真正的失败等用户点开始时再报，免得打开窗口就吓人。
   */
  async function prefetch() {
    if (busy || (prefetchTask && !prefetchTask.settled)) return { ok: true, reused: true };
    const task = ensurePayloadTask({ visible: false });
    try {
      const payload = await task.promise;
      prefetchedPayload = payload;
      emitEvent({ type: "prefetch", stage: "ready", version: payload.version, source: payload.source });
      log.info(`安装包已就绪：${payload.source} ${payload.version || ""}`);
      return { ok: true, version: payload.version };
    } catch (error) {
      if (isAbort(error)) return { ok: false, code: CODES.CANCELLED };
      const failure = asSetupError(error, CODES.NETWORK, "准备安装包失败");
      emitEvent({ type: "prefetch", stage: "failed", code: failure.code, message: failure.message });
      log.warn(`预取安装包失败：${failure.code} ${failure.message}`);
      return { ok: false, code: failure.code };
    }
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
    // 分段计时：安装主体在内层 NSIS 里，外层只有「准备」和「安装」两段可控，
    // 记下来才谈得上后面按真实数据决定还要不要动打包格式。
    const startedAt = Date.now();
    const timings = { payloadMs: 0, installMs: 0 };

    try {
      emitEvent({ type: "phase", phase: "prepare", label: "检查安装位置" });
      await checkSpace(installDir);

      const payloadStartedAt = Date.now();
      let payload;
      if (options.payloadPath) {
        // 用户手动选了安装包：正在进行中的预取没用了，停掉，改走这个文件。
        if (prefetchTask && !prefetchTask.settled) prefetchTask.controller.abort();
        payload = await resolvePayload(ctx, options.payloadPath, emitEvent);
      } else if (prefetchTask && !prefetchTask.settled) {
        // 预取还没完：接手同一个任务，把后续进度切到工作屏，而不是再下一遍。
        prefetchTask.visible = true;
        payload = await prefetchTask.promise;
      } else if (prefetchedPayload) {
        payload = prefetchedPayload;
      } else {
        payload = await resolvePayload(ctx, null, emitEvent);
      }
      timings.payloadMs = Date.now() - payloadStartedAt;
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
      const installStartedAt = Date.now();

      const polling = pollInstall(installDir, ctx);
      const exit = await started.done;
      ctx.stopped = true;
      await polling;
      installPid = null;
      timings.installMs = Date.now() - installStartedAt;

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

      const elapsedMs = Date.now() - startedAt;
      const result = {
        type: "done",
        installDir: located.installDir,
        exePath: located.exePath,
        version: payload.version,
        launched,
        elapsedMs,
        timings: { ...timings, totalMs: elapsedMs },
      };
      emitEvent(result);
      log.info(
        `安装完成 ${located.exePath}（准备 ${timings.payloadMs}ms / 安装 ${timings.installMs}ms / 合计 ${elapsedMs}ms）`,
      );
      return { ok: true, ...result };
    } catch (error) {
      if (isAbort(error)) {
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
    // 窗口还停在「安装位置」、后台正在预取：取消就是把预取停了，不算报错。
    if (!busy && prefetchTask && !prefetchTask.settled) {
      prefetchTask.controller.abort();
      return { ok: true, scope: "prefetch" };
    }
    if (!busy || !controller) return { ok: false, reason: "idle" };
    if (phase === "install") return { ok: false, reason: "installing" };
    if (prefetchTask && !prefetchTask.settled) prefetchTask.controller.abort();
    controller.abort();
    return { ok: true };
  }

  function dispose() {
    if (prefetchTask && !prefetchTask.settled) prefetchTask.controller.abort();
    if (controller) controller.abort();
    if (installPid) {
      killInstallerTree(installPid);
      installPid = null;
    }
    busy = false;
  }

  return {
    start,
    prefetch,
    cancel,
    dispose,
    isBusy: () => busy,
    currentPhase: () => phase,
  };
}

module.exports = { createPipeline, createDefaultServices, POLL_INTERVAL_MS, SPACE_HEADROOM_BYTES };
