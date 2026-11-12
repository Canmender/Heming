#!/usr/bin/env node
/**
 * 自绘安装器打包入口。
 *
 * 产物：`和鸣安装程序 <5 段版本>.exe`（electron-builder portable 单文件）。
 * 它启动后先由 portable 外壳自解压（显示 build/splash.bmp 静态图），
 * 再跑我们自己的 Electron 窗口（安装界面与安装动画），
 * 安装动作仍然交给原来那个 NSIS 安装器（静默 `/S /D=<dir>`）。
 *
 * 本脚本做四件事：
 * 1. 校验版本号与根 package.json 一致（版本由 scripts/bump-version.mjs 同步）；
 * 2. 写 `config/generated.json`：版本、装完体积（安装阶段进度条用）、
 *    以及「网络取安装包」还是「安装包嵌在体内」两种形态；
 * 3. 需要时把内层 NSIS 安装包复制到 `payload/inner-setup.exe` 并记下 sha512；
 * 4. 借主仓已解包的 electron 调 electron-builder（本机没有 electron 下载 zip，
 *    不传 --config.electronDist 会去联网重下并失败，与 scripts/build-desktop.mjs 同理）。
 *
 * 用法：
 *   node scripts/build-setup.mjs                      # 在线版：运行时从更新服务器下载安装包
 *   node scripts/build-setup.mjs --embed-inner        # 离线版：自动找最近的「和鸣 Setup」并嵌进去
 *   node scripts/build-setup.mjs --embed-inner=<path> # 离线版：指定内层安装包
 *
 * 环境变量：HEMING_ELECTRON_BUILDER 指定 electron-builder 可执行文件
 * （在 worktree 里本包没有 node_modules，借主仓 packages/desktop/node_modules/.bin 下的那个）。
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const setupDir = join(root, "packages", "setup");
const desktopDir = join(root, "packages", "desktop");
const payloadDir = join(setupDir, "payload");
const generatedPath = join(setupDir, "config", "generated.json");
const releaseDir = join(setupDir, "release");

const rootPkg = readJson(join(root, "package.json"));
const setupPkg = readJson(join(setupDir, "package.json"));
const version = rootPkg.hemingVersion;

if (!version) {
  fail("根 package.json 缺 hemingVersion，无法出安装器包");
}
if (setupPkg.hemingVersion !== version) {
  fail(
    `版本不一致：根 ${version} / packages/setup ${setupPkg.hemingVersion}。` +
      "先跑 scripts/bump-version.mjs（它会把两个包一起同步）",
  );
}

const args = process.argv.slice(2);
const embedArg = args.find((arg) => arg === "--embed-inner" || arg.startsWith("--embed-inner="));
const embedPath = embedArg && embedArg.includes("=") ? embedArg.slice("--embed-inner=".length) : null;

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function fail(message) {
  console.error(`[build-setup] ${message}`);
  process.exit(1);
}

/** 递归统计目录字节数；目录不存在时返回 0（构建机上缺哪块就少算哪块）。 */
function dirBytes(dir) {
  if (!existsSync(dir)) return 0;
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        try {
          total += statSync(full).size;
        } catch {
          // 统计只用于进度条，读不到就跳过
        }
      }
    }
  }
  return total;
}

/** 找 node_modules/.pnpm 下已解包的 electron（与 scripts/build-desktop.mjs 同一套探测）。 */
function detectElectronDist() {
  const override = process.env.HEMING_ELECTRON_DIST;
  if (override) {
    const dist = resolve(override);
    if (existsSync(join(dist, "electron.exe")) && existsSync(join(dist, "version"))) return dist;
    fail(`HEMING_ELECTRON_DIST 指向的目录不像已解包的 electron：${dist}`);
  }
  const pnpmDir = join(root, "node_modules", ".pnpm");
  if (!existsSync(pnpmDir)) return null;
  const candidates = readdirSync(pnpmDir)
    .filter((name) => name.startsWith("electron@"))
    .map((name) => join(pnpmDir, name, "node_modules", "electron", "dist"))
    .filter((dist) => existsSync(join(dist, "electron.exe")))
    .filter((dist) => existsSync(join(dist, "version")))
    .sort((a, b) => statSync(join(b, "version")).mtimeMs - statSync(join(a, "version")).mtimeMs);
  return candidates[0] ?? null;
}

/** 在产物目录里找最新的内层「和鸣 Setup」安装包。 */
function findInnerInstaller() {
  if (!existsSync(releaseDir)) return null;
  const candidates = readdirSync(releaseDir)
    .filter((name) => /^和鸣\s*Setup\s+.+\.exe$/i.test(name))
    .map((name) => join(releaseDir, name))
    .filter((full) => existsSync(full));
  candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return candidates[0] ?? null;
}

function sha512Base64(filePath) {
  const hash = createHash("sha512");
  hash.update(readFileSync(filePath));
  return hash.digest("base64");
}

// —— 1. 决定内嵌还是在线 ——
let payloadMode = "network";
let innerPath = null;

if (embedArg && embedPath) {
  innerPath = resolve(embedPath);
  if (!existsSync(innerPath)) fail(`指定的内层安装包不存在：${innerPath}`);
} else if (embedArg) {
  innerPath = findInnerInstaller();
  if (!innerPath) {
    fail(`在 ${releaseDir} 没找到「和鸣 Setup *.exe」。先跑 pnpm dist:desktop，或用 --embed-inner=<path> 指定`);
  }
}

mkdirSync(payloadDir, { recursive: true });
mkdirSync(join(setupDir, "config"), { recursive: true });

if (payloadMode === "network") {
  // 在线版绝不能带着上一次的离线安装包一起发出去：它会让“在线版”悄悄变成旧版离线包
  const stale = join(payloadDir, "inner-setup.exe");
  if (existsSync(stale)) {
    rmSync(stale, { force: true });
    console.log("[build-setup] 已移除上次遗留的内嵌安装包（这次是在线版）");
  }
}

// —— 2. 装完体积：安装阶段进度条的分母 ——
// 由三块内容组成：Electron 运行时 + 应用包（desktop 的 asar，含 web-dist）+ 内置资源。
// 内层 NSIS 安装包解开后落在用户机器上的就是这些；差值只有压缩率，不影响进度观感。
const electronDist = detectElectronDist();
const components = {
  "electron 运行时": electronDist ? dirBytes(electronDist) : 0,
  "应用包（web-dist）": dirBytes(join(desktopDir, "web-dist")),
  "内置运行时": dirBytes(join(desktopDir, "runtime")),
  "模型网关": dirBytes(join(desktopDir, "resources", "magpie")),
};
const installedBytes = Object.values(components).reduce((sum, bytes) => sum + bytes, 0);
for (const [name, bytes] of Object.entries(components)) {
  console.log(`[build-setup] ${name}: ${(bytes / 1024 / 1024).toFixed(0)} MB`);
}
if (installedBytes <= 0) {
  console.warn("[build-setup] 没统计到装完体积，安装阶段进度条会退化成不确定态（不影响安装）");
}

// —— 3. 复制内嵌安装包 + 写构建期配置 ——
const generated = {
  hemingVersion: version,
  semverVersion: setupPkg.version,
  payload: payloadMode,
  installedBytes,
  generatedAt: new Date().toISOString(),
};

if (innerPath) {
  const target = join(payloadDir, "inner-setup.exe");
  copyFileSync(innerPath, target);
  generated.payload = "embedded";
  generated.payloadFileName = "inner-setup.exe";
  generated.payloadSha512 = sha512Base64(target);
  generated.payloadSource = innerPath;
  console.log(
    `[build-setup] 已内嵌安装包：${innerPath}（${(statSync(target).size / 1024 / 1024).toFixed(0)} MB）`,
  );
}

writeFileSync(generatedPath, `${JSON.stringify(generated, null, 2)}\n`);
console.log(`[build-setup] 已写 ${generatedPath}`);

// —— 4. 交给 electron-builder（portable）——
// 支持用 HEMING_ELECTRON_BUILDER 指定可执行文件：在 worktree 里开发时本包没有自己的
// node_modules，直接借主仓 `packages/desktop/node_modules/.bin/electron-builder.CMD`。
const binName = process.platform === "win32" ? "electron-builder.CMD" : "electron-builder";
let binPath = null;
if (process.env.HEMING_ELECTRON_BUILDER) {
  binPath = resolve(process.env.HEMING_ELECTRON_BUILDER);
  if (!existsSync(binPath)) {
    fail(`HEMING_ELECTRON_BUILDER 指向的文件不存在：${binPath}`);
  }
} else {
  const electronBuilderDirCandidates = [
    join(setupDir, "node_modules", ".bin"),
    join(desktopDir, "node_modules", ".bin"),
  ];
  const binDir = electronBuilderDirCandidates.find((dir) => existsSync(join(dir, binName)));
  if (!binDir) {
    fail("找不到 electron-builder（packages/setup 与 packages/desktop 的 node_modules 里都没有）");
  }
  binPath = join(binDir, binName);
}

const builderArgs = ["--win", "portable", "--publish", "never", `--config.directories.output=${releaseDir}`];
if (electronDist) {
  builderArgs.push(`--config.electronDist=${electronDist}`);
  const electronVersion = readFileSync(join(electronDist, "version"), "utf8").trim();
  builderArgs.push(`--config.electronVersion=${electronVersion}`);
  console.log(`[build-setup] 使用本地 electron ${electronVersion}：${electronDist.replace(root, ".")}`);
} else {
  console.warn("[build-setup] 未找到本地 electron 解包目录，将尝试联网下载（可能很慢或失败）");
}

const child = spawn(binPath, builderArgs, {
  cwd: setupDir,
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, HEMING_APP_VERSION: version },
});

child.on("error", (error) => fail(`启动 electron-builder 失败：${error.message}`));
child.on("exit", (code) => {
  if (code !== 0) {
    fail(`electron-builder 退出码 ${code}`);
  }
  const artifact = readdirSync(releaseDir)
    .filter((name) => /^和鸣安装程序\s+.+\.exe$/i.test(name))
    .map((name) => join(releaseDir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  if (!artifact) {
    fail(`打包结束但没在 ${releaseDir} 找到「和鸣安装程序 *.exe」`);
  }
  console.log(`[build-setup] 完成：${artifact}（${(statSync(artifact).size / 1024 / 1024).toFixed(1)} MB）`);
  console.log(`[build-setup] sha512: ${sha512Base64(artifact)}`);
});
