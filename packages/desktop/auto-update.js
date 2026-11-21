"use strict";
/**
 * 自动更新（仅桌面端安装版）。
 *
 * ## 为什么自己写编排，而不是直接 `autoUpdater.checkForUpdates()`
 *
 * electron-updater 的默认行为有三个地方不适合本项目：
 * 1. **启动即检查**——冷启动时和网络抢带宽，且用户还没看到界面；
 * 2. **下载静默**——用户不知道后台在发生什么，出问题也不会知道；
 * 3. **5 段版本号对它没有意义**——它只认 semver，而本项目对外展示的是
 *    `d.14.1.3.0`。若把 5 段直接当 semver 比，`d.14.1.3.0` 会被解析成非法版本。
 *
 * 所以这里把「比较」交给自己已有的 `app-version.js`（已按5 段规则测过），
 * 把「下载/安装」交给 electron-updater。两者职责分开，也便于单测。
 *
 * ## 状态机
 *
 * ```
 * idle ──check──▶ checking ──▶ up-to-date
 *                    │
 *                    ├─▶ available（仅提示，不自动下载）
 *                    │        │
 *                    │     ──download──▶ downloading ──▶ downloaded
 *                    │                                                  │
 *                    └──────────────quitAndInstall ◀────────────────────┘
 * ```
 *
 * `available` 与 `downloaded` 之间**刻意不自动推进**：是否下载由用户决定，
 * 且下载完也不自动安装——正在编辑的会话不该被强行重启。
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { compareVersions, appVersion } = require("./app-version");

/** 更新检查的默认间隔：6 小时。 */
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * 发布源。打包时由 electron-builder 的 `publish` 字段注入到 app-update.yml，
 * 但开发态（未打包）不存在该文件，因此默认走环境变量，最后兜底到云服务器。
 *
 * 为什么兜底而不是「开发态不检查」：开发时也需要能验证更新链路是否通，
 * 只要显式给了地址就允许检查。
 */
const DEFAULT_FEED_URL = process.env.HEMING_UPDATE_FEED || "http://47.92.39.184/updates";

/**
 * 下载进度转发给界面订阅者的最小间隔。
 *
 * electron-updater 的 `download-progress` 每收一小段数据就发一次（250MB 的包
 * 会有上千次），原样转发等于让渲染进程每秒重绘上百次，进度条反而更抖。
 * 120ms 约 8fps：看起来是连续的，主进程到渲染进程的 IPC 数量降一个数量级。
 * 首帧和 100% 不受节流——前者要让界面立刻知道「开始了」，后者决定按钮状态。
 */
const PROGRESS_EMIT_INTERVAL_MS = 120;

/**
 * 装一个更新大概要占多少空间：安装包大小 × 该系数。
 *
 * 为什么要乘：NSIS 先把载荷解到临时目录，再删旧文件、写新文件，中间有
 * 「新旧共存」的一段时间。1.2 是保守值——多算不会拦下本来能装的更新
 * （差 20% 时安装本来也大概率失败），少算则会把用户带进「程序被删、装不回来」。
 */
const UPDATE_SPACE_FACTOR = 1.2;

/**
 * 除安装包本身外还要求留的余量：64MB。
 *
 * 为什么不是 0：装完还要写日志、写注册表、搬回用户数据；刚好卡在临界值上
 * 的安装最容易在最后一步失败。
 */
const UPDATE_SPACE_RESERVE_BYTES = 64 * 1024 * 1024;

/**
 * 当前是否运行在安装版。
 *
 * `app.isPackaged` 是唯一可靠判据：`electron .` 开发态为false，
 * 打包后为 true。开发态下**绝不能**触发自动下载——
 * 那会用发布源的包覆盖本地开发代码。
 */
function isInstalledOnly(autoUpdater, app) {
  return typeof autoUpdater?.isPackaged === "boolean" ? autoUpdater.isPackaged : Boolean(app?.isPackaged);
}

/**
 * 5 段版本号 → semver。
 *
 * 用于「拿本项目的 5 段版本去和远端 semver 比较」之前的归一，
 * 以及排查时对照 electron-updater 日志里显示的版本。
 * 无法解析时返回 null，调用方据此**跳过本次更新**而不是猜一个版本——
 * 猜错的后果是给用户推一个不该装的包。
 */
function toSemver(value) {
  if (typeof value !== "string") return null;
  const match = /^[dmc]\.(\d+\.\d+\.\d+\.\d+)(-dev\.(\d+))?$/.exec(value.trim());
  if (!match) return null;
  const [, core, prerelease] = match;
  return `${core}${prerelease ?? ""}`;
}

/**
 * 远端 semver → 5 段版本号（`selectUpdate` 的真正入口）。
 *
 * 方向别搞反：electron-updater 从 `update-info.json` 读到的是**semver**
 *（`14.1.4.0`），而本项目对外是 5 段（`d.14.1.4.0`）。
 * 两边不归一就交给 `compareVersions`，它会判「格式不同 / 不可比」返回 0，
 * 结果就是**永远推不出更新**——而且不报错，只是安静地什么都不做。
 * 这是接入自动更新最容易踩、也最难发现的一处。
 *
 * semver 段数不定（`14.1.4`、`14.1.4.0` 都可能出现），一律补齐到 4 段。
 *
 * @param {unknown} value 远端版本
 * @param {string} channel 通道字母，取自当前版本；默认 `d`
 * @returns {string | null}
 */
function fromSemver(value, channel = "d") {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  // 远端已带通道前缀时按 5 段直接解析，避免拼出 "d.d.14.1.4.0" 这种双前缀。
  // 这个分支必须放在下面的正则**之前**：正则是 `^(\d+)` 开头，
  // 带前缀的输入会在第一步就匹配失败，走不到分支里。
  //
  // 注意这里**不能**用 toSemver 再拼前缀——那会把通道字母洗掉
  // （`m.14.1.4.0` → `14.1.4.0` → 又拼成 `d.…`），
  // 结果就是「桌面包把别的通道的版本当自己的」而表面一切正常。
  if (/^[dmc]\./.test(trimmed)) {
    const prefixed = /^[dmc]\.\d+\.\d+\.\d+\.\d+(-dev\.\d+)?$/.exec(trimmed);
    return prefixed ? prefixed[0] : null;
  }

  const match = /^(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?(-dev\.(\d+))?$/.exec(trimmed);
  if (!match) return null;
  const [, major, minor, patch, build, prerelease] = match;
  const prefix = /^[dmc]$/.test(channel) ? channel : "d";
  return `${prefix}.${major}.${minor}.${patch}.${build ?? 0}${prerelease ?? ""}`;
}

/**
 * 从远端清单里挑出「应该更新到」的版本。
 *
 * electron-updater 的 `update-info.json` 形如
 * `{ version: "14.1.3.0", path: "...", sha512: "..." }`。
 * 注意它给的是 **semver**，不是 5 段——所以要换回5 段再交给 `compareVersions`，
 * 否则 `d.14.1.3.0` 与 `14.1.3.0` 会被判为不可比（返回 0），
 * 结果就是**永远推不出更新**。这是接入时最容易踩的一处。
 *
 * @returns {{version: string, path?: string, sha512?: string} | null} 不用更新时为 null
 */
function selectUpdate(currentVersion, info) {
  if (!info || typeof info.version !== "string") return null;

  // 远端给的是 semver，必须换回 5 段才能与本项目版本按同一规则比较
  const channel = /^[dmc]\./.test(currentVersion) ? currentVersion.split(".")[0] : "d";
  const candidate = fromSemver(info.version, channel);
  if (!candidate) return null;

  if (compareVersions(candidate, currentVersion) <= 0) return null;
  return { version: candidate, path: info.path, sha512: info.sha512 };
}

/**
 * 从 electron-updater 的下载结果里挑出安装包。
 *
 * `downloadUpdate()` 返回的是「这次落盘的所有文件路径」数组（安装包、blockmap
 * 之类混在一起），安装助手只认 .exe。挑不到时返回 null，调用方回退到
 * electron-updater 自己的安装流程，而不是猜一个文件去执行。
 */
function pickInstallerFile(files) {
  if (!Array.isArray(files)) return null;
  const exe = files.find((item) => typeof item === "string" && /\.exe$/i.test(item));
  // 只认 .exe：拿不到安装包时返回 null，让调用方回退到 electron-updater 自带流程。
  // 之前会退而返回第一个字符串，结果把 .blockmap / latest.yml 当安装包交给助手执行，
  // 恰好在本该安全回退的场景下让安装失败。
  return exe ?? null;
}

/**
 * 装这个安装包需要多少可用空间。
 *
 * 安装包大小未知（还没下载完、拿不到文件大小）时返回 0：**探测不到就不拦**。
 * 宁可放过一次可疑的安装，也不要因为读不到大小就让所有人装不了更新。
 */
function requiredUpdateSpace(installerBytes) {
  const size = Number(installerBytes);
  if (!Number.isFinite(size) || size <= 0) return 0;
  return Math.ceil(size * UPDATE_SPACE_FACTOR) + UPDATE_SPACE_RESERVE_BYTES;
}

/** 字节 → 人能读的大小（1 位小数，够用就好）。 */
function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return "0 MB";
  const mb = value / (1024 * 1024);
  if (mb < 1024) return `${Math.max(1, Math.round(mb))} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/**
 * 检查各块盘的剩余空间够不够装。
 *
 * 这是纯函数：不读盘、不抛异常，`freeBytes` 由调用方探测后传进来。
 * 为什么要两块盘：安装器把载荷解到**临时目录**（往往在 C:），把文件写进
 * **安装目录**（可能装在 D:/E:）。2026-11-16 那次「更新把程序删了却没装回来」
 * 就是 E: 有 45GB、C: 只剩 0.6GB —— 只看安装盘会漏掉真正的瓶颈。
 *
 * `freeBytes` 为 null/非数字表示探测失败，该目标跳过（不拦）。
 *
 * @param {{ installerBytes?: number|null, targets?: { label?: string, path?: string, freeBytes?: number|null }[] }} input
 * @returns {{ ok: boolean, requiredBytes: number, installerBytes: number|null, problems: { label: string, path: string, freeBytes: number, requiredBytes: number, shortBytes: number }[] }}
 */
function checkUpdateSpace({ installerBytes = null, targets = [] } = {}) {
  const size = Number(installerBytes);
  const normalizedInstaller = Number.isFinite(size) && size > 0 ? size : null;
  const requiredBytes = requiredUpdateSpace(normalizedInstaller);
  const problems = [];

  for (const target of Array.isArray(targets) ? targets : []) {
    if (!target || typeof target.path !== "string" || !target.path.trim()) continue;
    // 显式判 null/undefined：Number(null) 是 0，会被当成「一点空间都没有」而误拦。
    if (target.freeBytes === null || target.freeBytes === undefined) continue;
    const freeBytes = Number(target.freeBytes);
    // 探测失败（NaN/负数）不拦：不能因为读不到磁盘信息就不让更新。
    if (!Number.isFinite(freeBytes) || freeBytes < 0) continue;
    // 大小未知 → requiredBytes 为 0，永远不会命中这里。
    if (requiredBytes > 0 && freeBytes < requiredBytes) {
      problems.push({
        label: typeof target.label === "string" && target.label.trim() ? target.label : target.path,
        path: target.path,
        freeBytes,
        requiredBytes,
        shortBytes: requiredBytes - freeBytes,
      });
    }
  }

  return {
    ok: problems.length === 0,
    requiredBytes,
    installerBytes: normalizedInstaller,
    problems,
  };
}

/**
 * 把空间不足拼成一句人话（给界面与日志看）。
 *
 * 说清三件事：哪块盘、还剩多少、还差多少。只写「空间不足」用户没法行动。
 */
function formatSpaceShortfall(problems) {
  const list = Array.isArray(problems) ? problems : [];
  if (list.length === 0) return "";
  const parts = list.map(
    (item) =>
      `${item.label}（${item.path}）只剩 ${formatBytes(item.freeBytes)}，` +
      `装这个版本要 ${formatBytes(item.requiredBytes)}，还差 ${formatBytes(item.shortBytes)}`,
  );
  return `磁盘空间不够，已取消安装：${parts.join("；")}。清出空间后再点一次「重启并安装」。`;
}

/**
 * 探测某路径所在盘的可用字节数；读不到返回 null。
 *
 * 用 `fs.statfsSync`（Node 18.15+）：不需要外部命令、不解析 `dir` 输出、
 * 也不会因为中文路径/盘符编码出问题。
 */
function defaultDiskFree(target) {
  try {
    const stats = fs.statfsSync(target);
    const available = Number(stats.bavail) * Number(stats.bsize);
    return Number.isFinite(available) && available >= 0 ? available : null;
  } catch {
    return null;
  }
}

/**
 * 创建更新控制器。
 *
 * 依赖全部可注入，便于单测时传入假对象——自动更新牵涉网络与进程重启，
 * 真跑一次代价太大（会真的下载安装包）。
 *
 * @param {object} deps
 * @param {any} deps.autoUpdater electron-updater 的 autoUpdater 单例
 * @param {any} deps.app Electron app
 * @param {() => number} [deps.now]
 * @param {(...args: any[]) => void} [deps.log]
 * @param {(target: string) => number|null} [deps.diskFree] 探测某路径所在盘可用字节（单测注入）
 * @param {() => { label?: string, path: string }[]} [deps.spaceTargets] 要检查的盘（单测注入）
 * @param {() => number|null} [deps.installerBytes] 安装包大小（单测注入；默认读已下载文件）
 */
function createUpdater({
  autoUpdater,
  app,
  now = () => Date.now(),
  log = () => {},
  diskFree = defaultDiskFree,
  spaceTargets = null,
  installerBytes = null,
} = {}) {
  const currentVersion = appVersion();

  /** @type {"idle"|"checking"|"up-to-date"|"available"|"downloading"|"downloaded"|"error"} */
  let status = "idle";
  let available = null;
  let lastCheckedAt = null;
  let lastError = null;
  let timer = null;
  /**
   * 下载进度（electron-updater 的 `download-progress` 事件）。
   *
   * 为什么要有：安装包 250MB 量级，下载阶段界面只有「下载中…」三个字，
   * 用户不知道是在动还是卡死，也不知道还要多久。percent 是 0–100 的数字，
   * 由 electron-updater 按已接收/总大小算好；这里只负责转发 + 落进状态快照。
   * 进度只在 downloading 阶段有意义，其它阶段一律 null（避免界面显示陈旧百分比）。
   */
  let progress = null;

  /**
   * 上次把进度转发出去的毫秒时刻；0 表示这一轮还没发过（首帧不受节流）。
   */
  let progressEmitAt = 0;

  /**
   * 已下载安装包的落盘路径（由 `downloadUpdate()` 的返回值得到）。
   * 更新助手要拿它去静默安装；拿不到路径时主进程会回退到 electron-updater 自己的安装流程。
   */
  let downloadedInstaller = null;

  /**
   * 最近一次空间检查结果；没查过为 null。
   *
   * 为什么放进状态快照：界面要在「已下载、可以重启安装」这一刻就能提醒
   * 「这台机器空间不够，装了会失败」，而不是等用户点了按钮、程序被删之后。
   */
  let space = null;

  const listeners = new Set();

  const emit = () => {
    const snapshot = getState();
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch (err) {
        log(`[updater] 监听器异常：${err.message}`);
      }
    }
  };

  /**
   * 转发下载进度。只在 downloading 阶段采信：electron-updater 在某些路径上
   * 会先发一次 0% 再开始，也可能在下载完成后补发 100%；状态机以 download() 的
   * await 结果为准，进度只影响展示。
   */
  function onDownloadProgress(payload) {
    if (!payload || typeof payload !== "object") return;
    const percent = Number(payload.percent);
    progress = {
      percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0,
      transferred: Number(payload.transferred) || 0,
      total: Number(payload.total) || 0,
      bytesPerSecond: Number(payload.bytesPerSecond) || 0,
    };
    // 100% 与首帧必须立刻发：前者让「下载完成」按钮及时出现，后者让界面知道动起来了。
    const complete = progress.percent >= 100;
    const nowMs = Date.now();
    if (!complete && progressEmitAt !== 0 && nowMs - progressEmitAt < PROGRESS_EMIT_INTERVAL_MS) return;
    progressEmitAt = nowMs;
    emit();
  }

  if (typeof autoUpdater?.on === "function") {
    autoUpdater.on("download-progress", onDownloadProgress);
  }

  function getState() {
    return {
      status,
      currentVersion,
      available,
      lastCheckedAt,
      lastError,
      /** 打包后才允许自动下载；开发态永远为 false */
      canDownload: isInstalledOnly(autoUpdater, app),
      /** 下载进度；非 downloading 阶段为 null。 */
      progress,
      /**
       * 最近一次空间检查（d.203.4.107）；没查过为 null。
       * ok=false 时 message 是可以直接展示给用户的中文句子。
       */
      space,
    };
  }

  function setStatus(next) {
    status = next;
    emit();
  }

  /**
   * 检查更新。
   *
   * 开发态仍可检查（便于验证链路），但**绝不下载**：那里没有真实安装包，
   * 下载下来也无法安装，只会在日志里制造噪声。
   */
  async function check({ silent = false } = {}) {
    if (status === "checking") return getState();
    progress = null;
    progressEmitAt = 0;
    setStatus("checking");
    lastError = null;

    try {
      autoUpdater.autoDownload = false;
      autoUpdater.autoInstallOnAppQuit = false;
      if (!silent) log(`[updater] 检查更新（当前 ${currentVersion}）`);

      const result = await autoUpdater.checkForUpdates();
      lastCheckedAt = now();

      // 已安装最新版：result 里没有 updateInfo
      const info = result?.updateInfo ?? autoUpdater.updateInfo;
      const picked = selectUpdate(currentVersion, info);

      if (!picked) {
        available = null;
        setStatus("up-to-date");
        log("[updater] 已是最新");
        return getState();
      }

      available = picked;
      setStatus("available");
      log(`[updater] 发现新版本 ${picked.version}`);
      return getState();
    } catch (err) {
      lastError = err?.message ?? String(err);
      setStatus("error");
      log(`[updater] 检查失败：${lastError}`);
      return getState();
    }
  }

  /** 下载已发现的更新。开发态直接拒绝并说明原因。 */
  async function download() {
    if (!isInstalledOnly(autoUpdater, app)) {
      lastError = "开发模式不支持下载更新";
      setStatus("error");
      return getState();
    }
    if (!available) return getState();

    progress = null;
    progressEmitAt = 0;
    setStatus("downloading");
    try {
      const files = await autoUpdater.downloadUpdate();
      downloadedInstaller = pickInstallerFile(files);
      setStatus("downloaded");
      // 下完就知道包多大了：顺手查一次空间，让界面在用户点按钮之前就能提醒。
      checkSpace();
      return getState();
    } catch (err) {
      lastError = err?.message ?? String(err);
      setStatus("error");
      log(`[updater] 下载失败：${lastError}`);
      return getState();
    }
  }

  /**
   * 要检查的盘：安装目录所在盘 + 临时目录所在盘。
   *
   * 安装目录取 `app.getPath("exe")` 的父目录（打包后就是实际安装位置）；
   * 临时目录取 `os.tmpdir()`（= %TEMP%，NSIS 解压载荷的地方）。
   * 任何一边读不到路径就跳过那一边，不让探测本身把流程卡死。
   */
  function resolveSpaceTargets() {
    if (typeof spaceTargets === "function") return spaceTargets();
    const targets = [];
    try {
      const exePath = app?.getPath?.("exe");
      if (typeof exePath === "string" && exePath.trim()) {
        targets.push({ label: "安装盘", path: path.dirname(exePath) });
      }
    } catch (err) {
      log(`[updater] 读安装路径失败：${err?.message ?? err}`);
    }
    try {
      const tempPath = os.tmpdir();
      if (typeof tempPath === "string" && tempPath.trim()) {
        targets.push({ label: "临时目录盘", path: tempPath });
      }
    } catch (err) {
      log(`[updater] 读临时目录失败：${err?.message ?? err}`);
    }
    return targets;
  }

  /**
   * 安装包大小：优先读已下载文件的实际大小，其次用远端更新信息里的 size。
   * 都拿不到返回 null（→ 不拦）。
   */
  function resolveInstallerBytes() {
    if (typeof installerBytes === "function") {
      try {
        return installerBytes();
      } catch {
        return null;
      }
    }
    if (typeof downloadedInstaller === "string" && downloadedInstaller) {
      try {
        return fs.statSync(downloadedInstaller).size;
      } catch {
        // 文件不在/读不到就退到远端声明的大小
      }
    }
    const declared = Number(available?.size ?? available?.files?.[0]?.size);
    return Number.isFinite(declared) && declared > 0 ? declared : null;
  }

  /**
   * 查一次空间，把结果存进状态并通知订阅者。
   *
   * 单独暴露成方法，是为了让界面在「已下载」阶段就能先查一次，
   * 也方便单测直接验证判定逻辑（不真的装）。
   */
  function checkSpace() {
    const bytes = resolveInstallerBytes();
    const targets = resolveSpaceTargets().map((item) => ({
      label: item.label,
      path: item.path,
      freeBytes: typeof diskFree === "function" ? diskFree(item.path) : null,
    }));
    const result = checkUpdateSpace({ installerBytes: bytes, targets });
    const message = result.ok ? "" : formatSpaceShortfall(result.problems);
    space = {
      ok: result.ok,
      installerBytes: result.installerBytes,
      requiredBytes: result.requiredBytes,
      message,
      problems: result.problems,
      /** 每条检查目标当时剩多少（含探测失败的 null），供日志与界面排查 */
      targets: targets.map((item) => ({
        label: item.label,
        path: item.path,
        freeBytes: Number.isFinite(Number(item.freeBytes)) ? Number(item.freeBytes) : null,
      })),
      checkedAt: now(),
    };
    emit();
    return space;
  }

  /** 下载完成后退出并安装。 */
  function quitAndInstall() {
    if (status !== "downloaded") return false;

    // d.203.4.107：先查空间再交接。装不下就当场拒绝——一旦把控制权交给安装器，
    // 它会先删旧程序、再解压；解压失败时程序已经没了，用户连界面都打不开。
    const report = checkSpace();
    if (!report.ok) {
      lastError = report.message;
      log(`[updater] ${report.message}`);
      emit();
      return false;
    }

    lastError = null;
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return true;
  }

  /** 定时检查。到期才查，避免每次启动都打网络。 */
  function scheduleCheck(intervalMs = DEFAULT_INTERVAL_MS) {
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      void check({ silent: true });
    }, intervalMs);
    // 不因为这个定时器把应用吊住
    if (typeof timer.unref === "function") timer.unref();
    return timer;
  }

  function dispose() {
    if (timer) clearInterval(timer);
    timer = null;
    listeners.clear();
    if (typeof autoUpdater?.removeListener === "function") {
      autoUpdater.removeListener("download-progress", onDownloadProgress);
    }
  }

  return {
    currentVersion,
    feedUrl: DEFAULT_FEED_URL,
    check,
    download,
    quitAndInstall,
    /** 查一次安装空间（d.203.4.107）；返回结果同时写进状态快照。 */
    checkSpace,
    scheduleCheck,
    dispose,
    getState,
    /**
     * 已下载安装包的路径；没有则 null。
     * 主进程用它决定「交给自绘更新助手」还是「走 electron-updater 自带安装」。
     */
    getDownloadedInstaller: () => downloadedInstaller,
    /** 订阅状态变化；返回取消订阅函数。渲染进程用它刷新更新提示条。 */
    subscribe(listener) {
      listeners.add(listener);
      // 立即回调当前状态，好让界面不用等下一次变化才显示。
      // 这处同样要 try：新订阅者此刻就可能抛（渲染进程已销毁、状态结构不兼容），
      // 不能让它冒到调用方——那会让「订阅更新提示」变成崩溃点。
      try {
        listener(getState());
      } catch (err) {
        log(`[updater] 订阅时回调异常：${err.message}`);
      }
      return () => listeners.delete(listener);
    },
  };
}

module.exports = {
  DEFAULT_FEED_URL,
  DEFAULT_INTERVAL_MS,
  UPDATE_SPACE_FACTOR,
  UPDATE_SPACE_RESERVE_BYTES,
  checkUpdateSpace,
  createUpdater,
  defaultDiskFree,
  formatBytes,
  formatSpaceShortfall,
  fromSemver,
  isInstalledOnly,
  pickInstallerFile,
  requiredUpdateSpace,
  selectUpdate,
  toSemver,
};