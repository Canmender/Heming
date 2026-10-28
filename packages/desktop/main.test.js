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

// 剥掉注释后的源码：下面这些断言靠「字符串首次出现的位置」判断接线顺序，
// 而注释里只要提到 app.whenReady( 就会污染这个位置判断（main.js 里没有正则字面量，
// 所以按行剥注释是安全的）。断言的是**代码**，注释说什么不算。
const mainCode = mainSrc
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split(/\r?\n/)
  .filter((line) => !/^\s*\/\//.test(line))
  .join("\n");

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
  assert.ok(mainCode.includes("show: !withSplash"));
});

test("main.js：splash 覆盖主窗口所在显示器（多显示器）", () => {
  assert.ok(mainCode.includes("screen.getDisplayMatching(mainWin.getBounds())"));
  assert.ok(!mainCode.includes("screen.getPrimaryDisplay()"));
});

// 主窗口在启动动画期间被 splash 全覆盖，Chromium 会判定其被遮挡；开着节流则 web 端
// BootWave 的 rAF/定时器一起被暂停 → 揭示推不动、白遮罩永久盖住界面（真机复现过）。
test("main.js：主窗口关闭后台节流（遮挡时 rAF/定时器不被暂停）", () => {
  const m = mainCode.match(/webPreferences:\s*\{[\s\S]*?\n {6}\}/);
  assert.ok(m, "未找到主窗口 webPreferences");
  assert.ok(
    m[0].includes("backgroundThrottling: false"),
    "主窗口 webPreferences 必须含 backgroundThrottling: false"
  );
});

// ── 启动默认最大化 ──
test("main.js：主窗口创建后 maximize()（铺满屏幕但保留标题栏与窗口控件）", () => {
  assert.ok(mainCode.includes("win.maximize()"), "启动应最大化主窗口");
  // 不用 fullscreen：真全屏会把自定义标题栏与原生窗口控件一起隐藏
  assert.ok(!/fullscreen:\s*true/.test(mainCode), "不应使用 fullscreen:true");
});

// 最大化时 getBounds() 返回屏幕尺寸，直接落盘会把用户偏好的窗口尺寸覆盖掉；
// 必须用 getNormalBounds() 取还原态尺寸，最大化/还原往返才正确。
test("main.js：窗口尺寸落盘用 getNormalBounds（最大化时不覆盖用户偏好尺寸）", () => {
  const saveCalls = [...mainCode.matchAll(/saveWindowState\(windowStateFile\(\),\s*win\.(\w+)\(\)\)/g)].map(
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
  assert.ok(mainCode.includes("screen.getDisplayMatching(mainWin.getBounds())"));
});

// ── 本地包安装的运行时接线（d.25）──
test("main.js：stdio 桥接注入 planSpawn，并暴露 runtime:probe", () => {
  assert.ok(mainCode.includes("planSpawn: planStdioSpawn"), "spawn 前必须翻译逻辑命令（Windows 的 npx 是 .cmd）");
  assert.ok(mainCode.includes('ipcMain.handle("runtime:probe"'), "渲染层要能探测本机运行时");
  // 探测用的 PATH 必须与真正 spawn 时一致，否则界面说「没有」而启动成功（或反之）
  assert.ok(/probeLocalRuntime\(\{[\s\S]{0,120}buildChildEnv\(/.test(mainCode), "探测应使用补全后的 PATH");
  // shell:false 的约束在 mcp-stdio 里，main.js 不允许出现 shell:true
  assert.ok(!/shell:\s*true/.test(mainCode), "禁止任何 shell:true");
});

// 减弱动态偏好只有渲染进程能查到（matchMedia）；查到后回填给生命周期收紧关闭时机，
// 否则这类用户要对着静止画面等满 3.2s 可见地板。
test("main.js：查询减弱动态偏好并回填给 splash 生命周期", () => {
  assert.ok(
    mainCode.includes("prefers-reduced-motion"),
    "main.js 应向 splash 渲染进程查询 prefers-reduced-motion"
  );
  assert.ok(
    /lifecycle\.setReducedMotion\(/.test(mainCode),
    "查到后必须回填 setReducedMotion，否则查询没有意义"
  );
});

// ── web 界面嵌入（app:// 本地加载） ──

test("main.js：app:// 注册为 privileged + secure（E2E 依赖安全上下文）", () => {
  const m = mainCode.match(/registerSchemesAsPrivileged\(\[[\s\S]*?\]\)/);
  assert.ok(m, "未找到 registerSchemesAsPrivileged 调用");
  assert.ok(m[0].includes('scheme: EMBEDDED_SCHEME'), "注册的应是 EMBEDDED_SCHEME");
  assert.ok(m[0].includes("secure: true"), "必须 secure: true，否则 crypto.subtle 不可用、E2E 失效");
  assert.ok(!m[0].includes("allowRunningInsecureContent"), "不应放宽任何安全开关");
});

test("main.js：scheme 注册在 app ready 之前（否则拿不到 secure 语义）", () => {
  const reg = mainCode.indexOf("registerSchemesAsPrivileged(");
  const ready = mainCode.indexOf("app.whenReady(");
  assert.ok(reg > 0 && ready > 0);
  assert.ok(reg < ready, "registerSchemesAsPrivileged 必须出现在 app.whenReady 之前");
});

test("main.js：地址优先级为 dev > 显式远程 > 嵌入式 > 兜底远程", () => {
  const fn = mainCode.match(/function resolveAppUrl\(env\) \{[\s\S]*?\n\}/);
  assert.ok(fn, "未找到 resolveAppUrl");
  const body = fn[0];
  const iDev = body.indexOf("HEMING_DEV_URL");
  const iWeb = body.indexOf("HEMING_WEB_URL");
  const iEmbed = body.indexOf("hasEmbeddedWeb()");
  const iDefault = body.indexOf("APP_DEFAULT_URL");
  assert.ok(iDev > 0 && iWeb > iDev && iEmbed > iWeb && iDefault > iEmbed,
    "优先级顺序应为 HEMING_DEV_URL > HEMING_WEB_URL > hasEmbeddedWeb() > APP_DEFAULT_URL");
});

test("main.js：嵌入产物缺失时退回远程（老包/构建异常不至于打不开）", () => {
  assert.ok(mainCode.includes("hasEmbeddedWeb()"), "应存在嵌入产物可用性判定");
  assert.ok(/hasEmbeddedWeb\(\)\s*\)\s*return EMBEDDED_URL/.test(mainCode) ||
    /if \(hasEmbeddedWeb\(\)\) return EMBEDDED_URL/.test(mainCode),
    "只有产物存在时才用 app:// 地址");
});

test("main.js：导航白名单放行 app://（originOf 对自定义 scheme 会得到 null，必须按前缀判）", () => {
  assert.ok(mainCode.includes("EMBEDDED_ORIGIN + \"/\""), "应按前缀判定嵌入式源");
});

test("main.js：系统浏览器白名单不放行 app://（否则页面链接会把自己导航走）", () => {
  const fn = mainCode.match(/function isSafeExternalUrl\(url\) \{[\s\S]*?\n\}/);
  assert.ok(fn, "未找到 isSafeExternalUrl");
  assert.ok(!fn[0].includes("app:"), "isSafeExternalUrl 只应放行 http/https/mailto");
});

test("main.js：协议处理器在创建窗口之前装好", () => {
  const install = mainCode.indexOf("installAppProtocol();");
  const create = mainCode.indexOf("createWindow();", mainCode.indexOf("app.whenReady("));
  assert.ok(install > 0 && create > 0);
  assert.ok(install < create, "installAppProtocol 必须在 createWindow 之前调用");
});

// ── 崩溃兜底（d.30 · P0-4）──
// 此前主进程零兜底：抛未捕获异常直接静默退出，用户只看到「应用莫名其妙没了」，
// 而本机没有任何日志可查。这几条钉住「装上了、装在早处、且不再自己拉 ICE」。
test("main.js：装上崩溃兜底，且在 app.whenReady 之前（启动早期抛也要留日志）", () => {
  assert.ok(mainCode.includes('require("./crash-log")'), "主进程必须接上 crash-log 模块");
  assert.ok(mainCode.includes("installCrashHandlers("), "必须装 uncaughtException / unhandledRejection 兜底");
  const install = mainCode.indexOf("installCrashHandlers(");
  const ready = mainCode.indexOf("app.whenReady(");
  assert.ok(install > 0 && ready > 0);
  assert.ok(install < ready, "崩溃兜底必须在 app.whenReady 之前装上");
});

test("main.js：渲染进程崩溃接兜底（写日志 + 只重载一次）", () => {
  assert.ok(
    mainCode.includes('attachRenderCrashRecovery(win.webContents'),
    "主窗口 webContents 必须接渲染崩溃兜底"
  );
});

test("main.js：主进程不再自己拉 ICE（改由渲染层自取，主进程没有 token）", () => {
  // 服务端给 /api/ice-servers 加了鉴权，主进程裸 fetch 必然 401；
  // 而要让它继续工作就得把 token 搬进主进程（新增暴露面），所以整段删掉。
  assert.ok(!/iceBase/.test(mainCode), "主进程不应再有 iceBase 变量");
  assert.ok(!/\/api\/ice-servers/.test(mainCode), "主进程不应再请求 /api/ice-servers");
  assert.ok(!/HEMING_API_BASE/.test(mainCode), "主进程不应再有 HEMING_API_BASE 分支");
  // preload 的兼容位保留不动（web 侧仍按可选链读它）
  const preloadSrc = fs.readFileSync(path.join(__dirname, "preload.js"), "utf8");
  assert.ok(preloadSrc.includes("__heming_ice_servers_get"), "preload 的 ICE 兼容位应保留");
  assert.ok(preloadSrc.includes("setIceServers"), "preload 的 setIceServers 应保留");
});

// ── 本机密钥信封桥（d.36）──
test("密钥信封桥在 createWindow 之前注册（preload 用 sendSync 问可用性）", () => {
  const reg = mainCode.indexOf("registerSecretIpc(ipcMain)");
  const create = mainCode.indexOf("createWindow();"); // 带分号：避开函数定义的 `function createWindow() {`
  assert.ok(reg > 0, "main.js 应注册 secret IPC");
  assert.ok(create > 0, "main.js 应调用 createWindow()");
  assert.ok(reg < create, "注册必须早于窗口创建");
});

// ── 系统通知桥（d.39）──
test("main.js：接上系统通知桥，保持主窗口引用并用它聚焦", () => {
  assert.ok(mainCode.includes('require("./notify-bridge")'), "主进程必须接上 notify-bridge");
  assert.ok(mainCode.includes("registerNotifyIpc(ipcMain"), "必须注册 notify IPC");
  assert.ok(mainCode.includes("mainWindow = win"), "createWindow 后必须记住主窗口");
  assert.ok(
    /registerNotifyIpc\(ipcMain,\s*\{[\s\S]{0,80}getMainWindow:\s*\(\)\s*=>\s*mainWindow/.test(mainCode),
    "通知点击必须取主窗口，而不是 getAllWindows()[0]"
  );
  // Windows 系统通知要求进程 AUMID 与安装快捷方式一致，否则可能静默不弹。
  assert.ok(
    /process\.platform\s*===\s*["']win32["'][\s\S]{0,120}setAppUserModelId\(pkg\.build\?\.appId/.test(mainCode),
    "AUMID 应在 win32 下取自 package.json build.appId（与安装快捷方式一致）"
  );
});

