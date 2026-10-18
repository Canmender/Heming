"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  shouldShowSplash,
  splashWindowOptions,
  splashCloseDelayMs,
  isFatalLoadFailure,
  WRITE_MS,
  SPLASH_MS,
  GAP_MS,
  WAVE_MS,
  BOOT_TOTAL_MS,
  LOAD_WATCHDOG_MS,
} = require("./splash-config");

// 直接引用生产代码（splash-config.js 由 main.js require），避免平行实现。
const mainSrc = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");

test("默认环境显示 splash", () => {
  assert.equal(shouldShowSplash({}), true);
  assert.equal(shouldShowSplash(undefined), true);
  assert.equal(shouldShowSplash({ HEMING_NO_SPLASH: "0" }), true);
});

test("HEMING_NO_SPLASH=1 时不显示 splash", () => {
  assert.equal(shouldShowSplash({ HEMING_NO_SPLASH: "1" }), false);
});

test("splash 窗口配置：无边框透明置顶 + 铺满主显示器", () => {
  const cfg = splashWindowOptions({ width: 1920, height: 1040 });
  // 无边框透明置顶
  assert.equal(cfg.frame, false);
  assert.equal(cfg.transparent, true);
  assert.equal(cfg.alwaysOnTop, true);
  assert.equal(cfg.skipTaskbar, true);
  // 铺满主显示器工作区
  assert.equal(cfg.width, 1920);
  assert.equal(cfg.height, 1040);
  // 先隐藏创建，避免白屏闪烁
  assert.equal(cfg.show, false);
  assert.equal(cfg.backgroundColor, "#ffffff");
  // 关掉后台节流：splash 是覆盖整个工作区的 alwaysOnTop 窗口，开启节流会让它的
  // rAF/定时器被暂停，粒子聚拢动画卡死
  assert.equal(cfg.webPreferences.backgroundThrottling, false);
});

test("多显示器：主屏不在原点时使用 workArea 的 x/y", () => {
  // 主屏位于右侧副屏（非 0,0 原点）
  const cfg = splashWindowOptions({ x: 1920, y: 0, width: 1920, height: 1040 });
  assert.equal(cfg.x, 1920);
  assert.equal(cfg.y, 0);
  assert.equal(cfg.width, 1920);
  assert.equal(cfg.height, 1040);
});

// ── 启动动画时间轴：总时长必须恰好 4500ms
//    （手写 1500 + 粒子 1500 + 静默 200 + 声波 1300） ──
test("启动动画总时长 4500ms（1.5s 手写 + 1.5s 粒子 + 0.2s 静默 + 1.3s 声波）", () => {
  assert.equal(WRITE_MS, 1500);
  assert.equal(SPLASH_MS, 1500);
  assert.equal(GAP_MS, 200);
  assert.equal(WAVE_MS, 1300);
  assert.equal(BOOT_TOTAL_MS, 4500);
  assert.equal(BOOT_TOTAL_MS, WRITE_MS + SPLASH_MS + GAP_MS + WAVE_MS);
});

test("加载看门狗硬上限 8s（既不 finish 也不 fail 时兜底收掉 splash）", () => {
  assert.equal(LOAD_WATCHDOG_MS, 8000);
});

// ── splashCloseDelayMs：远端 ~86ms 就加载完时不能立刻关 splash（会截断前两段动画） ──
test("云端极快加载（86ms）不截断手写段与粒子段：仍需等满 1.5 + 1.5 + 0.2s", () => {
  const delay = splashCloseDelayMs(86);
  assert.equal(delay, BOOT_TOTAL_MS - WAVE_MS - 86); // 3114ms，非常量兜底
  assert.equal(delay + 86, WRITE_MS + SPLASH_MS + GAP_MS); // splash 实际可见 3200ms
  assert.ok(delay > 200, "不能被 200ms 下限吃掉");
});

test("加载在 3.2s 内完成时，splash 恰好可见 3.2s（任意 elapsed）", () => {
  for (const elapsed of [0, 1, 50, 300, 1000, 1500, 3000]) {
    assert.equal(
      elapsed + splashCloseDelayMs(elapsed),
      WRITE_MS + SPLASH_MS + GAP_MS,
      `elapsed=${elapsed}`
    );
  }
});

test("任意加载耗时下 splash 可见时长都不会低于 3.2s（不可截断）", () => {
  for (const elapsed of [0, 86, 900, 1500, 3199, 3200, 5000, 7900]) {
    const visible = elapsed + splashCloseDelayMs(elapsed);
    assert.ok(visible >= WRITE_MS + SPLASH_MS + GAP_MS, `elapsed=${elapsed} 只可见 ${visible}ms`);
  }
});

test("加载耗时超过 3.2s 时保留下限 200ms（静默间隔不消失）", () => {
  assert.equal(splashCloseDelayMs(3200), 200);
  assert.equal(splashCloseDelayMs(5000), 200);
  // 负数/非法输入（时钟回拨等）按 0 处理，不会给出负等待
  assert.equal(splashCloseDelayMs(-100), BOOT_TOTAL_MS - WAVE_MS);
  assert.equal(splashCloseDelayMs(NaN), BOOT_TOTAL_MS - WAVE_MS);
});

// ── did-fail-load 判定：子 frame 与 ERR_ABORTED 都不算主页面失败 ──
test("isFatalLoadFailure：主 frame 的普通错误码才算加载失败", () => {
  assert.equal(isFatalLoadFailure(-105, true), true); // ERR_NAME_NOT_RESOLVED
  assert.equal(isFatalLoadFailure(-102, true), true); // ERR_CONNECTION_REFUSED
});

test("isFatalLoadFailure：子 frame 失败不算（不打断启动动画）", () => {
  assert.equal(isFatalLoadFailure(-105, false), false);
  assert.equal(isFatalLoadFailure(-102, false), false);
});

test("isFatalLoadFailure：ERR_ABORTED(-3) 不算失败（导航被主动取消）", () => {
  assert.equal(isFatalLoadFailure(-3, true), false);
});

// ── main.js 接线不变量（无法在 Node 里起 Electron，用源码断言钉住无行为接缝的两处）──
// 关闭时机 / 启动信号 / 失败兜底 / 看门狗 / 主窗口关闭等行为在 splash-lifecycle.test.js
// 用假窗口真实驱动，不在这里做字符串断言。
test("main.js：有启动动画时主窗口 show:false（避免先闪白底主窗口）", () => {
  assert.ok(mainSrc.includes("show: !withSplash"));
});

test("main.js：splash 覆盖主窗口所在显示器（多显示器）", () => {
  assert.ok(mainSrc.includes("screen.getDisplayMatching(mainWin.getBounds())"));
  assert.ok(!mainSrc.includes("screen.getPrimaryDisplay()"));
});

// 主窗口在启动动画期间被 splash 全覆盖，Chromium 会判定其被遮挡；开着节流则 web 端
// BootWave 的 rAF/定时器一起被暂停 → 揭示推不动、白遮罩永久盖住界面（真机复现过）。
test("main.js：主窗口关闭后台节流（遮挡时 rAF/定时器不被暂停）", () => {
  const m = mainSrc.match(/webPreferences:\s*\{[\s\S]*?\n {6}\}/);
  assert.ok(m, "未找到主窗口 webPreferences");
  assert.ok(
    m[0].includes("backgroundThrottling: false"),
    "主窗口 webPreferences 必须含 backgroundThrottling: false"
  );
});

// ── 启动默认最大化 ──
test("main.js：主窗口创建后 maximize()（铺满屏幕但保留标题栏与窗口控件）", () => {
  assert.ok(mainSrc.includes("win.maximize()"), "启动应最大化主窗口");
  // 不用 fullscreen：真全屏会把自定义标题栏与原生窗口控件一起隐藏
  assert.ok(!/fullscreen:\s*true/.test(mainSrc), "不应使用 fullscreen:true");
});

// 最大化时 getBounds() 返回屏幕尺寸，直接落盘会把用户偏好的窗口尺寸覆盖掉；
// 必须用 getNormalBounds() 取还原态尺寸，最大化/还原往返才正确。
test("main.js：窗口尺寸落盘用 getNormalBounds（最大化时不覆盖用户偏好尺寸）", () => {
  const saveCalls = [...mainSrc.matchAll(/saveWindowState\(windowStateFile\(\),\s*win\.(\w+)\(\)\)/g)].map(
    (m) => m[1]
  );
  assert.ok(saveCalls.length >= 2, `应有多处落盘（debounce + close），实际 ${saveCalls.length}`);
  assert.ok(
    saveCalls.every((fn) => fn === "getNormalBounds"),
    `所有落盘都必须用 getNormalBounds，实际：${saveCalls.join(", ")}`
  );
});

test("main.js：splash 定位仍需要 getBounds（取当前屏幕，不是还原态）", () => {
  // 上面的断言只约束落盘路径；getDisplayMatching 用 getBounds 是对的（要当前实际位置）
  assert.ok(mainSrc.includes("screen.getDisplayMatching(mainWin.getBounds())"));
});

// 减弱动态偏好只有渲染进程能查到（matchMedia）；查到后回填给生命周期收紧关闭时机，
// 否则这类用户要对着静止画面等满 3.2s 可见地板。
test("main.js：查询减弱动态偏好并回填给 splash 生命周期", () => {
  assert.ok(
    mainSrc.includes("prefers-reduced-motion"),
    "main.js 应向 splash 渲染进程查询 prefers-reduced-motion"
  );
  assert.ok(
    /lifecycle\.setReducedMotion\(/.test(mainSrc),
    "查到后必须回填 setReducedMotion，否则查询没有意义"
  );
});
