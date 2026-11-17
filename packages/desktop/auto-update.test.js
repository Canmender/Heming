"use strict";
/**
 * 自动更新编排的单元测试。
 *
 * 全部依赖注入假对象：真跑一次要下75MB 安装包并重启进程，代价太大，
 * 而且**测不出边界**——真正容易出错的是版本换算与状态流转，不是网络。
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { appVersion } = require("./app-version");

const {
  checkUpdateSpace,
  createUpdater,
  formatBytes,
  formatSpaceShortfall,
  fromSemver,
  isInstalledOnly,
  requiredUpdateSpace,
  selectUpdate,
  toSemver,
  UPDATE_SPACE_FACTOR,
  UPDATE_SPACE_RESERVE_BYTES,
} = require("./auto-update");

/**
 * 本机当前版本（读真实 package.json，不硬编码——硬编码会在每次 bump 后全红）。
 */
const CURRENT = appVersion();

/**
 * 构造一个比当前更高的**远端 semver**。
 *
 * 两个易错点：
 * - **不带通道前缀**。远端 `update-info.json` 里是纯 semver（`16.0.0.0`），
 *   带前缀会被当成 5 段走另一条分支。
 * - 只抬「特性位」，保证一定比当前新，且与当前号同族。
 */
function newerSemver() {
  const core = /^([dmc])\.(\d+)\./.exec(CURRENT);
  if (!core) return "999.0.0.0";
  return `${Number(core[2]) + 1}.0.0.0`;
}

/** 当前版本的 semver 形态（用于模拟"已是最新"）。 */
const CURRENT_SEMVER = toSemver(CURRENT);

/** 与当前同版本（不应重复推）。 */
const SAME_SEMVER = CURRENT_SEMVER;

/** 比当前低一档（不应推）。 */
const OLDER_SEMVER = (() => {
  const core = /^(\d+)\.(\d+)\.(\d+)/.exec(CURRENT_SEMVER || "");
  if (!core) return "0.0.1.0";
  const major = Number(core[1]);
  return `${major > 0 ? major - 1 : 0}.0.0.0`;
})();

/** 把远端 semver 换算回本项目的 5 段形态，用于断言文案。 */
function asLocal(semver) { return fromSemver(semver, "d"); }

/** 假 autoUpdater：记录调用，按脚本返回结果。 */
function fakeAutoUpdater({ packaged = true, updateInfo = null, failWith = null } = {}) {
  const calls = { check: 0, download: 0, quitAndInstall: 0 };
  /** 极简事件总线：electron-updater 是 EventEmitter，这里只需 on/emit/removeListener。 */
  const handlers = new Map();
  return {
    calls,
    handlers,
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(handler);
    },
    removeListener(event, handler) {
      handlers.get(event)?.delete(handler);
    },
    emit(event, payload) {
      for (const handler of handlers.get(event) ?? []) handler(payload);
    },
    isPackaged: packaged,
    updateInfo,
    // 这两个由被测代码直接赋值，测试要读它们的最终值
    autoDownload: undefined,
    autoInstallOnAppQuit: undefined,
    async checkForUpdates() {
      calls.check += 1;
      if (failWith) throw failWith;
      return this.updateInfo ? { updateInfo: this.updateInfo } : {};
    },
    async downloadUpdate() {
      calls.download += 1;
    },
    quitAndInstall() {
      calls.quitAndInstall += 1;
    },
  };
}

test("toSemver：5 段 → semver", () => {
  assert.equal(toSemver("d.14.1.3.0"), "14.1.3.0");
  assert.equal(toSemver("d.0.1.0.0"), "0.1.0.0");
  assert.equal(toSemver("d.14.1.3.0-dev.2"), "14.1.3.0-dev.2");
  // 非法输入必须返回 null 而不是猜一个——猜错会推错包
  assert.equal(toSemver("14.1.3"), null);
  assert.equal(toSemver("d.14.1.3"), null);
  assert.equal(toSemver(""), null);
  assert.equal(toSemver(null), null);
  assert.equal(toSemver(123), null);
});

test("fromSemver：远端 semver → 5 段（方向别搞反）", () => {
  assert.equal(fromSemver("14.1.4.0"), "d.14.1.4.0");
  assert.equal(fromSemver("14.1.4"), "d.14.1.4.0", "三段要补齐到四段");
  assert.equal(fromSemver("14.1.4.0-dev.2"), "d.14.1.4.0-dev.2");
  // 通道跟随当前版本，而不是写死d
  assert.equal(fromSemver("14.1.4.0", "c"), "c.14.1.4.0");
  // 已带通道前缀时不能拼成 "d.d.14.1.4.0"，也不能把通道字母洗掉
  assert.equal(fromSemver("d.14.1.4.0"), "d.14.1.4.0");
  assert.equal(fromSemver("m.14.1.4.0"), "m.14.1.4.0", "别的通道要原样保留，不能强转成 d");
  assert.equal(fromSemver("x.14.1.4.0"), null, "非法通道应拒绝而不是猜");
  // 非法输入返回 null，不猜
  assert.equal(fromSemver("不是版本"), null);
  assert.equal(fromSemver(""), null);
  assert.equal(fromSemver(null), null);
});

test("selectUpdate：远端更新才返回，同级/更旧都返回 null", () => {
  const current = CURRENT;
  assert.deepEqual(
    selectUpdate(CURRENT, { version: newerSemver() }),
    { version: asLocal(newerSemver()), path: undefined, sha512: undefined },
    "远端 semver 更大时应换回 5 段并判定为可更新",
  );
  assert.equal(selectUpdate(current, { version: SAME_SEMVER }), null, "同版本不该重复推");
  assert.equal(selectUpdate(current, { version: OLDER_SEMVER }), null, "更旧不该推");
  assert.equal(selectUpdate(current, null), null);
  assert.equal(selectUpdate(current, {}), null);
  assert.equal(selectUpdate(current, { version: "不是版本" }), null);
});

test("selectUpdate：这是最容易踩的坑——semver 必须换回 5 段再比", () => {
  // 若不换算，`d.14.1.3.0` 与 `14.1.3.0` 会被判「不可比」返回 0，
  // 结果就是永远推不出更新。
  const picked = selectUpdate(CURRENT, { version: newerSemver() });
  assert.ok(picked, "应当判定为可更新");
  assert.equal(picked.version, asLocal(newerSemver()));
  assert.notEqual(picked.version, newerSemver(), "对外版本必须保持 5 段形态");
});

test("selectUpdate：开发版低于正式版", () => {
  assert.equal(selectUpdate(CURRENT, { version: `${CURRENT_SEMVER}-dev.9` }), null);
  assert.ok(selectUpdate(`${CURRENT}-dev.2`, { version: CURRENT_SEMVER }), "正式版应高于预发版");
});

test("isInstalledOnly：开发态为 false，打包态为 true", () => {
  assert.equal(isInstalledOnly(fakeAutoUpdater({ packaged: false }), { isPackaged: false }), false);
  assert.equal(isInstalledOnly(fakeAutoUpdater({ packaged: true }), { isPackaged: true }), true);
  // 没有 isPackaged 时退回 app.isPackaged
  assert.equal(isInstalledOnly({}, { isPackaged: false }), false);
});

test("检查更新：已是最新", async () => {
  const au = fakeAutoUpdater({ updateInfo: { version: CURRENT_SEMVER } });
  const u = createUpdater({ autoUpdater: au, app: { isPackaged: true } });
  const state = await u.check();
  assert.equal(state.status, "up-to-date");
  assert.equal(state.available, null);
  assert.equal(au.calls.check, 1);
});

test("检查更新：发现新版本，只提示不自动下载", async () => {
  const au = fakeAutoUpdater({ updateInfo: { version: newerSemver() } });
  const u = createUpdater({ autoUpdater: au, app: { isPackaged: true } });
  const state = await u.check();
  assert.equal(state.status, "available");
  assert.equal(state.available.version, asLocal(newerSemver()));
  assert.equal(state.currentVersion, CURRENT, "对外版本必须是本机真实的 5 段版本");
  assert.equal(au.calls.download, 0, "绝不能自动下载");
  // autoUpdater.checkForUpdates 会在内部再次赋值，这里断言最终值
  assert.equal(au.autoDownload, false, "必须关掉自动下载");
  assert.equal(au.autoInstallOnAppQuit, false, "退出时也不能偷偷装");
});

test("检查更新失败不抛，转为 error 状态", async () => {
  const au = fakeAutoUpdater({ failWith: new Error("网络不可达") });
  const u = createUpdater({ autoUpdater: au, app: { isPackaged: true } });
  const state = await u.check();
  assert.equal(state.status, "error");
  assert.match(state.lastError, /网络不可达/);
});

test("开发态：拒绝下载，且不留下未捕获异常", async () => {
  const au = fakeAutoUpdater({ packaged: false, updateInfo: { version: newerSemver() } });
  const u = createUpdater({ autoUpdater: au, app: { isPackaged: false } });
  const state = await u.download();
  assert.equal(au.calls.download, 0, "开发态不得下载");
  assert.equal(state.status, "error");
  assert.match(state.lastError, /开发模式/);
  assert.equal(state.canDownload, false);
});

test("下载 → 已下载 → 退出安装，走完整链路", async () => {
  const au = fakeAutoUpdater({ updateInfo: { version: newerSemver() } });
  const u = createUpdater({ autoUpdater: au, app: { isPackaged: true } });
  await u.check();
  const downloading = await u.download();
  assert.equal(downloading.status, "downloaded");
  assert.equal(au.calls.download, 1);
  assert.equal(u.quitAndInstall(), true);
  await new Promise((r) => setImmediate(r));
  assert.equal(au.calls.quitAndInstall, 1);
});

test("未下载完成时不允许退出安装", async () => {
  const au = fakeAutoUpdater({ updateInfo: { version: newerSemver() } });
  const u = createUpdater({ autoUpdater: au, app: { isPackaged: true } });
  await u.check();
  assert.equal(u.quitAndInstall(), false, "只「发现」不算「已下载」");
});

test("未发现更新时 download 是空操作", async () => {
  const au = fakeAutoUpdater({ updateInfo: { version: CURRENT_SEMVER } });
  const u = createUpdater({ autoUpdater: au, app: { isPackaged: true } });
  await u.check();
  await u.download();
  assert.equal(au.calls.download, 0);
});

test("订阅者能收到状态变化，且立即收到当前状态", async () => {
  const au = fakeAutoUpdater({ updateInfo: { version: newerSemver() } });
  const u = createUpdater({ autoUpdater: au, app: { isPackaged: true } });
  const seen = [];
  const off = u.subscribe((s) => seen.push(s.status));
  assert.equal(seen[0], "idle", "订阅时应立即拿到当前状态");
  await u.check();
  assert.ok(seen.includes("checking"));
  assert.ok(seen.includes("available"));
  off();
  const before = seen.length;
  await u.check();
  assert.equal(seen.length, before, "取消订阅后不应再收到");
});

test("订阅者抛异常不影响检查流程", async () => {
  const au = fakeAutoUpdater({ updateInfo: { version: newerSemver() } });
  const u = createUpdater({ autoUpdater: au, app: { isPackaged: true }, log: () => {} });
  u.subscribe(() => {
    throw new Error("渲染进程崩了");
  });
  const state = await u.check();
  assert.equal(state.status, "available", "监听器异常不应中断更新检查");
});

test("定时检查可用且不吊住进程", () => {
  const au = fakeAutoUpdater();
  const u = createUpdater({ autoUpdater: au, app: { isPackaged: true } });
  const timer = u.scheduleCheck(1000);
  assert.ok(timer);
  u.dispose();
});

test("下载进度：转发 percent/字节数并落进状态；非下载阶段为 null", async () => {
  const au = fakeAutoUpdater({ updateInfo: { version: newerSemver() } });
  const u = createUpdater({ autoUpdater: au, app: { isPackaged: true } });
  assert.equal(u.getState().progress, null, "未开始下载时不应有进度");

  await u.check();
  const seen = [];
  u.subscribe((s) => seen.push({ status: s.status, progress: s.progress }));
  const pending = u.download();
  // 模拟 electron-updater 在下载过程中推事件
  au.emit("download-progress", {
    percent: 42.5,
    transferred: 10 * 1024 * 1024,
    total: 250 * 1024 * 1024,
    bytesPerSecond: 2 * 1024 * 1024,
  });
  const mid = u.getState();
  assert.equal(mid.status, "downloading");
  assert.equal(mid.progress.percent, 42.5);
  assert.equal(mid.progress.total, 250 * 1024 * 1024);
  assert.ok(
    seen.some((s) => s.status === "downloading" && s.progress && s.progress.percent === 42.5),
    "订阅者要收到带进度的状态",
  );
  await pending;
  // 越界值夹紧到 0–100，避免界面进度条宽度算出负数/超宽
  au.emit("download-progress", { percent: 250, transferred: 1, total: 1, bytesPerSecond: 0 });
  assert.equal(u.getState().progress.percent, 100);
});

test("重新检查会清掉上一轮的下载进度", async () => {
  const au = fakeAutoUpdater({ updateInfo: { version: newerSemver() } });
  const u = createUpdater({ autoUpdater: au, app: { isPackaged: true } });
  await u.check();
  const pending = u.download();
  au.emit("download-progress", { percent: 10, transferred: 1, total: 10, bytesPerSecond: 1 });
  assert.equal(u.getState().progress.percent, 10);
  await pending;
  await u.check();
  assert.equal(u.getState().progress, null, "新一轮检查不能带着陈旧的百分比");
});

test("dispose 会摘掉进度监听，之后事件不再更新状态", async () => {
  const au = fakeAutoUpdater({ updateInfo: { version: newerSemver() } });
  const u = createUpdater({ autoUpdater: au, app: { isPackaged: true } });
  await u.check();
  const pending = u.download();
  au.emit("download-progress", { percent: 5, transferred: 1, total: 20, bytesPerSecond: 1 });
  assert.equal(u.getState().progress.percent, 5);
  u.dispose();
  await pending;
  const handlers = au.handlers.get("download-progress");
  assert.equal(handlers.size, 0, "dispose 后不应还挂着监听");
});

// ───────────────────────── d.203.4.107：装更新前的空间预检 ─────────────────────────

test("requiredUpdateSpace：安装包大小 × 系数 + 余量；拿不到大小就不要求", () => {
  const installer = 400 * 1024 * 1024;
  assert.equal(
    requiredUpdateSpace(installer),
    Math.ceil(installer * UPDATE_SPACE_FACTOR) + UPDATE_SPACE_RESERVE_BYTES,
    "必须同时算上解压系数与固定余量",
  );
  // 未知大小 → 0：探测不到就不拦（宁可放过，也不要让所有人装不了更新）
  assert.equal(requiredUpdateSpace(null), 0);
  assert.equal(requiredUpdateSpace(Number.NaN), 0);
  assert.equal(requiredUpdateSpace(0), 0);
  assert.equal(requiredUpdateSpace(-1), 0);
});

test("formatBytes：人话大小，GB 一位小数", () => {
  assert.equal(formatBytes(544 * 1024 * 1024), "544 MB");
  assert.equal(formatBytes(Math.round(1.25 * 1024 * 1024 * 1024)), "1.3 GB");
  assert.equal(formatBytes(0), "0 MB");
  assert.equal(formatBytes(null), "0 MB");
});

test("checkUpdateSpace：够就过、不够逐条报差多少、探测失败不拦", () => {
  const installer = 400 * 1024 * 1024;
  const need = requiredUpdateSpace(installer);

  const enough = checkUpdateSpace({
    installerBytes: installer,
    targets: [
      { label: "安装盘", path: "E:\\Heming", freeBytes: need + 1 },
      { label: "临时目录盘", path: "C:\\Temp", freeBytes: need * 10 },
    ],
  });
  assert.equal(enough.ok, true);
  assert.deepEqual(enough.problems, []);
  assert.equal(enough.requiredBytes, need);
  assert.equal(enough.installerBytes, installer);

  const short = checkUpdateSpace({
    installerBytes: installer,
    targets: [
      { label: "安装盘", path: "E:\\Heming", freeBytes: need * 4 },
      // 2026-11-16 那次的真凶：安装盘够、临时盘不够
      { label: "临时目录盘", path: "C:\\Temp", freeBytes: 100 * 1024 * 1024 },
    ],
  });
  assert.equal(short.ok, false);
  assert.equal(short.problems.length, 1);
  assert.equal(short.problems[0].label, "临时目录盘");
  assert.equal(short.problems[0].shortBytes, need - 100 * 1024 * 1024);

  // 读不到剩余空间（null）→ 跳过，不因此拦下更新
  const unknown = checkUpdateSpace({
    installerBytes: installer,
    targets: [{ label: "临时目录盘", path: "C:\\Temp", freeBytes: null }],
  });
  assert.equal(unknown.ok, true);

  // 安装包大小未知 → 不要求任何空间
  const noSize = checkUpdateSpace({
    installerBytes: null,
    targets: [{ label: "临时目录盘", path: "C:\\Temp", freeBytes: 1024 }],
  });
  assert.equal(noSize.ok, true);
  assert.equal(noSize.requiredBytes, 0);
});

test("formatSpaceShortfall：说清哪块盘、还剩多少、还差多少", () => {
  const text = formatSpaceShortfall([
    { label: "临时目录盘", path: "C:\\Temp", freeBytes: 100 * 1024 * 1024, requiredBytes: 544 * 1024 * 1024, shortBytes: 444 * 1024 * 1024 },
  ]);
  assert.match(text, /磁盘空间不够/);
  assert.match(text, /临时目录盘/);
  assert.match(text, /C:\\Temp/);
  assert.match(text, /只剩 100 MB/);
  assert.match(text, /要 544 MB/);
  assert.match(text, /还差 444 MB/);
  assert.equal(formatSpaceShortfall([]), "");
});

test("空间不足：拒绝交接安装器，并把原因写进状态", async () => {
  const au = fakeAutoUpdater({ updateInfo: { version: newerSemver() } });
  const u = createUpdater({
    autoUpdater: au,
    app: { isPackaged: true },
    installerBytes: () => 400 * 1024 * 1024,
    spaceTargets: () => [{ label: "临时目录盘", path: "C:\\Temp\\heming" }],
    diskFree: () => 100 * 1024 * 1024,
  });
  await u.check();
  await u.download();

  const space = u.getState().space;
  assert.equal(space.ok, false, "下载完就该先查一次空间");
  assert.match(space.message, /磁盘空间不够/);

  assert.equal(u.quitAndInstall(), false, "空间不够时不能交接安装器");
  assert.equal(au.calls.quitAndInstall, 0, "绝不能让安装器启动（它会先删旧程序）");
  assert.match(u.getState().lastError, /还差/);
});

test("空间充足：允许交接安装器，且不再报错", async () => {
  const au = fakeAutoUpdater({ updateInfo: { version: newerSemver() } });
  const u = createUpdater({
    autoUpdater: au,
    app: { isPackaged: true },
    installerBytes: () => 400 * 1024 * 1024,
    spaceTargets: () => [{ label: "临时目录盘", path: "C:\\Temp\\heming" }],
    diskFree: () => 4 * 1024 * 1024 * 1024,
  });
  await u.check();
  await u.download();

  assert.equal(u.getState().space.ok, true);
  assert.equal(u.quitAndInstall(), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(au.calls.quitAndInstall, 1);
  assert.equal(u.getState().lastError, null);
});

test("探测不到剩余空间时不拦：交出去总比卡死强", async () => {
  const au = fakeAutoUpdater({ updateInfo: { version: newerSemver() } });
  const u = createUpdater({
    autoUpdater: au,
    app: { isPackaged: true },
    installerBytes: () => 400 * 1024 * 1024,
    spaceTargets: () => [{ label: "临时目录盘", path: "C:\\Temp\\heming" }],
    diskFree: () => null,
  });
  await u.check();
  await u.download();
  assert.equal(u.getState().space.ok, true);
  assert.equal(u.quitAndInstall(), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(au.calls.quitAndInstall, 1);
});
