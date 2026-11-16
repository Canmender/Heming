"use strict";
// 桌面桥冒烟的入口：起真实 Electron 跑 `smoke/main.js`，检查它输出的 SMOKE_RESULT。
//
// 为什么单独一个文件而不是并进 `packages/desktop` 的 `npm test`：
//   - 它要真的起一个 Electron 进程（约 5–10 秒），并依赖当前机器有可用的窗口系统；
//   - `npm test` 的 900+ 个 node:test 用例是纯逻辑、必须能在任何环境稳定跑。
// 桥本身改动时用 `pnpm smoke`（根）或 `pnpm --filter @heming/desktop smoke` 手动跑它。
const { spawn } = require("node:child_process");
const path = require("node:path");
const electronPath = require("electron");

const ROOT = path.join(__dirname);
const TIMEOUT_MS = 90_000;

// 逃生口：没有窗口系统的环境（少数容器/远程会话）里，冒烟本身跑不起来。
// 显式设 HEMING_SKIP_SMOKE=1 才跳过，并打印醒目的一行——**默认是跑**，
// 因为「跳过」比「漏检」更贵：d.162 的窗口打不开就是这么躺了四版。
if (process.env.HEMING_SKIP_SMOKE === "1") {
  console.log("[smoke] 已按 HEMING_SKIP_SMOKE=1 跳过桌面桥冒烟（只在没有窗口系统时用，别当成通过）");
  console.log("SMOKE_RESULT " + JSON.stringify({ total: 0, failed: 0, skipped: true, checks: [] }));
  process.exit(0);
}

const env = { ...process.env, ELECTRON_ENABLE_LOGGING: "0" };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, [path.join(ROOT, "smoke", "main.js"), "--no-sandbox"], {
  cwd: ROOT,
  env,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => {
  stdout += chunk.toString();
});
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

const timer = setTimeout(() => {
  console.error(`[smoke] 超时 ${TIMEOUT_MS}ms，杀掉 Electron`);
  child.kill();
}, TIMEOUT_MS);

child.on("close", (code) => {
  clearTimeout(timer);
  const line = stdout.split(/\r?\n/).find((l) => l.startsWith("SMOKE_RESULT "));
  if (!line) {
    console.error("---- Electron stdout ----");
    console.error(stdout.slice(-4000));
    console.error("---- Electron stderr ----");
    console.error(stderr.slice(-4000));
    console.error(`[smoke] 没有拿到 SMOKE_RESULT（退出码 ${code}）`);
    process.exit(1);
  }
  const result = JSON.parse(line.slice("SMOKE_RESULT ".length));
  const failed = (result.checks || []).filter((c) => !c.ok);
  const skipped = result.skipped || 0;
  // 跳过要说出来：skipped 的项不是「通过」，是「本机没条件验」——发版前应该看到 0。
  console.log(
    `[smoke] ${result.total - failed.length}/${result.total} 项通过（跳过 ${skipped} 项，退出码 ${code}）`,
  );
  if (skipped > 0) console.log(`[smoke] 有 ${skipped} 项被跳过（多为缺 web-dist 产物），发版前应为 0`);
  for (const c of failed) console.error(`[smoke] 失败项：${c.name} → ${JSON.stringify(c.detail)}`);
  if (failed.length > 0 || code !== 0) process.exit(1);
});
