#!/usr/bin/env node
/**
 * 构建桌面端要嵌入的 web 产物。
 *
 * 与云端部署的 web 构建差别只有一处：**注入 VITE_API_BASE**。
 * 嵌入后页面源是 app://heming，不再与 API 同源，故必须给出服务端绝对地址
 * （deploy.md §7 已预留：`VITE_API_BASE` 只服务桌面壳）。
 *
 * 产物落到 packages/desktop/web-dist/，由 electron-builder 的 extraResources
 * 打进 resources/web。该目录是构建产物，不入库。
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WEB_DIST = join(ROOT, "packages", "web", "dist");
const OUT = join(ROOT, "packages", "desktop", "web-dist");

/** 与 secure-origins.js 的 APP_DEFAULT_URL 同源，避免两处常量漂移。 */
const DEFAULT_API = "http://47.92.39.184";
const apiBase = process.env.HEMING_WEB_URL || DEFAULT_API;

/**
 * Windows 上 pnpm 是 .cmd，**必须**经 shell 启动（Node 不能用 execFile 直接跑 .cmd）。
 * 这里刻意传「单个命令字符串」而不是 (文件, 参数数组)：后者配 shell:true 会触发
 * DEP0190 参数拼接告警。入参都是本脚本写死的常量，无注入面。
 */
const run = (args, label) => {
  console.log(`\n[build-desktop-web] ${label}: pnpm ${args.join(" ")}`);
  execFileSync(`pnpm ${args.join(" ")}`, {
    cwd: ROOT,
    stdio: "inherit",
    shell: true,
    env: { ...process.env, VITE_API_BASE: apiBase },
  });
};

console.log(`[build-desktop-web] API base = ${apiBase}`);

// shared 是 web 的依赖，先构建（vite 会解析 workspace 包）
run(["--filter", "@heming/shared", "build"], "构建 shared");
run(["--filter", "@heming/web", "exec", "vite", "build"], "构建 web（注入 VITE_API_BASE）");

if (!existsSync(join(WEB_DIST, "index.html"))) {
  console.error(`[build-desktop-web] 失败：${WEB_DIST} 里没有 index.html`);
  process.exit(1);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
cpSync(WEB_DIST, OUT, { recursive: true });

console.log(`[build-desktop-web] 已拷贝到 ${OUT}`);
