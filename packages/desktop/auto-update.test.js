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
  createUpdater,
  fromSemver,
  isInstalledOnly,
  selectUpdate,
  toSemver,
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
  return {
    calls,
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