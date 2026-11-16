// =============================================================================
// 冒烟接进发版链路的「结构不变量」测试（d.166）
// -----------------------------------------------------------------------------
// 为什么需要这一层：d.165 加了真机冒烟（smoke.js），但**脚本存在 ≠ 会被跑**。
// 上一版就是把「窗口打不开」这种致命 bug 静默了四个版本，原因是没有任何一道
// 机器检查覆盖 preload + IPC 的真实加载过程。冒烟修好之后，如果再出现
// 「dist 不再前置冒烟」「CI 里悄悄删掉 smoke 步骤」「冒烟被 skip 状态冒充通过」，
// 就没有任何东西会红——所以这里把链路本身钉成测试。
//
// 只读文件、不启动 Electron：这几条断言在普通 `node --test` 里跑，几十毫秒。
// =============================================================================
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const DESKTOP = __dirname;
const REPO = path.resolve(DESKTOP, "../..");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readText(file) {
  return fs.readFileSync(file, "utf8");
}

test("冒烟必须覆盖「最近改动列表」（设置区回滚列表的数据源）", () => {
  const src = readText("smoke/main.js");
  assert.ok(src.includes("files.backups("), "冒烟要在真实渲染进程里调过 files.backups");
  assert.ok(src.includes("listBefore"), "先列出覆盖前的那条");
  assert.ok(src.includes("listAfter"), "撤销后确认那条消失");
});

test("冒烟必须覆盖 connect-src / img-src（页面看起来正常的失败形态）", () => {
  const src = readText("smoke/main.js");
  assert.ok(src.includes("probeSubresources("), "要在真机里跑子资源探针");
  assert.ok(src.includes("http://blocked.invalid/api"), "connect-src 违例要用 http 非回环地址（https: 是故意放行的）");
  assert.ok(src.includes("directive=connect-src"), "要断言 connect-src 违例进日志");
  assert.ok(src.includes("directive=img-src"), "要断言 img-src 违例进日志");
  assert.ok(src.includes("dataImgOk"), "还要有 data: 图片能加载的对照，证明不是把图全挡了");
});

test("dist:desktop 必须前置真机冒烟（不允许绕开桌面桥）", () => {
  const scripts = readJson(path.join(REPO, "package.json")).scripts;
  assert.equal(
    scripts["smoke:desktop"],
    "pnpm --filter @heming/desktop smoke",
    "根脚本 smoke:desktop 是 CI 与发版共用的唯一入口，不要改名或内联",
  );
  // d.166：冒烟现在会加载真实 web-dist 整页，所以产物必须先构建出来，
  // 否则冒烟只能 skip 掉最有价值的那几条断言。
  assert.match(
    scripts["dist:desktop"],
    /^pnpm --filter @heming\/desktop build:web && pnpm smoke:desktop && /,
    "dist:desktop 必须「先构建 web 产物 → 再冒烟 → 再打包」：跳过构建会让整页检查静默失效",
  );
  assert.match(scripts["dist:desktop"], /@heming\/desktop dist$/);
  const desktopScripts = readJson(path.join(DESKTOP, "package.json")).scripts;
  assert.equal(
    desktopScripts["build:web"],
    "node ../../scripts/build-desktop-web.mjs",
    "build:web 必须与 dist 用同一个构建脚本，否则产物口径会分叉",
  );
});

test("冒烟必须覆盖真实整页（app:// + web-dist），不能只测 data: 占位页", () => {
  const src = readText(path.join(DESKTOP, "smoke/main.js"));
  // 自定义协议必须在 app ready 之前注册成 privileged，否则 secure 语义丢失、页面行为与安装包不同。
  const privilegedAt = src.indexOf("registerSchemesAsPrivileged");
  const readyAt = src.indexOf("app.whenReady()");
  assert.ok(privilegedAt > 0, "缺 registerSchemesAsPrivileged：app:// 页面拿不到 secure 语义");
  assert.ok(readyAt > privilegedAt, "registerSchemesAsPrivileged 必须在 app ready 之前调用");
  assert.match(src, /protocol\.handle\(/, "缺 protocol.handle：app:// 请求没有响应者");
  assert.match(src, /webDistRoot\(\)/, "必须优先用 web-dist 产物（与安装包同源）");
  assert.match(src, /app:\/\/heming/, "整页检查必须加载 app://heming 真源，而不是 data: 占位页");
  assert.match(src, /#root|getElementById\("root"\)/, "必须断言 React 真的挂载了（白屏是用户第一眼看到的失败）");
  assert.match(src, /smoke\/main\.js|pageProbeScript/, "整页探针要留在主进程里，方便以后加断言");
});

test("冒烟必须验证「撤销上一次写入」（d.170：写两次再撤销能回到旧内容）", () => {
  const src = readText(path.join(DESKTOP, "smoke/main.js"));
  assert.match(src, /files\.undo\(/, "冒烟必须真的调用 __heming_files.undo（否则撤销链只有单测覆盖）");
  assert.match(src, /backupDir:/, "冒烟的 registerFileIpc 必须挂 backupDir，否则撤销永远回 no-backup");
  assert.match(src, /no-backup/, "必须断言同一份备份只能用一次（再撤销回 no-backup）");
});

test("冒烟必须用与生产同一条 CSP 验整页（头要对，页面也要真的起得来）", () => {
  const src = readText(path.join(DESKTOP, "smoke/main.js"));
  // 头必须从 app-protocol 生成，不能在冒烟里手抄一份——手抄会随生产策略漂移而失效。
  assert.match(src, /cspHeadersFor\(/, "必须用 app-protocol 的 cspHeadersFor 生成头");
  assert.match(src, /mode:\s*"enforce"/, "必须用 enforce 档：report-only 只记录不拦，页面白屏测不出来");
  assert.match(src, /content security policy|refused to /i, "必须收集页内 CSP 拒绝，否则「头对了但脚本被挡」测不出来");
  assert.match(src, /object-src|wasm-unsafe-eval|unsafe-inline/, "必须断言关键指令（script-src 不放 unsafe-*、object-src none）");
});

test("冒烟脚本默认必须真跑，只有显式 HEMING_SKIP_SMOKE=1 才允许跳过", () => {
  const src = readText(path.join(DESKTOP, "smoke.js"));
  assert.match(src, /require\("electron"\)/, "必须用真 Electron 当运行环境");
  // 跳过分支必须在 spawn 之前返回，否则会变成「跑了但没等结果」。
  const skipAt = src.indexOf('process.env.HEMING_SKIP_SMOKE === "1"');
  const spawnAt = src.indexOf("spawn(");
  assert.ok(skipAt > 0, "缺少 HEMING_SKIP_SMOKE=1 的逃生口（没有窗口系统的环境会卡死发版）");
  assert.ok(spawnAt > skipAt, "跳过分支必须早于 spawn");
  assert.match(src, /skipped: true/, "跳过要留下机器可读的标记，不能用「13/13 通过」冒充");
  assert.match(src, /SMOKE_RESULT/);
});

test("CI 必须在 Windows 上跑桌面桥冒烟（Electron 窗口只有它跑得起来）", () => {
  const workflow = readText(path.join(REPO, ".github/workflows/verify.yml"));
  const smokeSteps = workflow
    .split(/\r?\n/)
    .filter((line) => /smoke/i.test(line) && /run:/.test(line));
  assert.ok(smokeSteps.length > 0, "verify.yml 里没有任何 smoke 步骤");
  assert.match(
    workflow,
    /runs-on:\s*windows-latest[\s\S]{0,4000}smoke:desktop/,
    "smoke 必须放在 windows-latest 的 job 里：ubuntu runner 没有窗口系统，会变成永远 skip",
  );
});

test("CSP 违例上报只能有一份实现，且冒烟必须真验证「浏览器 → 主进程 → 文件」", () => {
  const main = readText(path.join(DESKTOP, "main.js"));
  const report = readText(path.join(DESKTOP, "csp-report.js"));
  const smoke = readText(path.join(DESKTOP, "smoke/main.js"));

  // 一份实现：main.js 只允许「给文件路径 + 挂到窗口」，去重/截断/格式都在 csp-report.js。
  assert.match(main, /require\("\.\/csp-report\.js"\)/, "main.js 必须复用 csp-report.js，不要再内联一份");
  assert.ok(
    !/function appendCspReport/.test(main),
    "main.js 里又出现 appendCspReport 了：两份实现迟早漂移（去重上限/格式/隐私字段各写各的）",
  );
  assert.match(report, /function createCspReporter/, "上报器本体要在 csp-report.js");
  assert.match(report, /CSP_REPORT_LOG_MAX_BYTES/, "截断上限必须在模块里，便于单测");
  assert.match(report, /CSP_REPORT_MAX_DEDUPE/, "去重上限必须在模块里，便于单测");
  // 隐私：只落三个字段，不回显 console 消息正文
  assert.match(report, /directive=\$\{violation\.directive\}/, "日志行必须只拼元数据");

  // 冒烟必须用真实违例打这条链，而不是只看代码里有没有这个函数。
  assert.match(smoke, /attachCspReporter\(/, "冒烟必须把上报器挂到真实页面上");
  assert.match(smoke, /directive=script-src/, "必须断言真实 Chromium 违例被解析成 script-src");
  assert.match(smoke, /blocked=inline/, "必须断言内联脚本被识别");
  assert.match(smoke, /await injectInline\(\)/, "必须真的造一次违例");
  assert.match(smoke, /去重/, "必须验证重复违例只记一次");
});

test("冒烟必须在生产默认档（report）下也验一次：不拦、但违例要记进日志", () => {
  const src = readText(path.join(DESKTOP, "smoke/main.js"));
  // 生产的默认档是 report（只记录不拦）。只测 enforce 会漏掉两类事故：
  // ①默认档被改成 enforce → 用户白屏；②report 档其实什么都没记 → 出事查不到。
  assert.match(src, /mode: "report"/, "必须在 report 档下再起一次整页");
  assert.match(src, /Content-Security-Policy-Report-Only/, "必须断言 report 档下发的是 Report-Only 头（不是强制拦截）");
  assert.match(src, /内联脚本照常执行/, "必须断言 report 档下脚本真的执行了（不白屏）");
  assert.match(src, /reportCspHeaderSeen/, "两档响应头要分开记录，不能互相覆盖");
  assert.match(src, /csp-report-report\.log/, "report 档的违例要单独落一个日志文件来断言");
});

test("pre-push（L1）必须包含桌面桥冒烟，且保留逃生口", () => {
  const hook = readText(path.join(REPO, ".githooks/pre-push"));
  assert.match(hook, /smoke:desktop/, "推送前不跑冒烟，等于把真机验证推给用户的电脑");
  assert.match(
    hook,
    /HEMING_SKIP_SMOKE/,
    "hook 里要写明跳过方式，否则没有窗口的机器会卡在这里反复失败",
  );
});
