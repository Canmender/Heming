#!/usr/bin/env node
/**
 * 和鸣版本统一 bump：仓库根 + packages/desktop + 三个子包，四处版本字段一次写齐。
 *
 * 版本格式为 5 段：`<通道>.<特性>.<破坏性>.<修订>.<构建>`，可带 `-dev.<n>` 预发后缀；
 * 通道 d = desktop（桌面安装包，云端网页沿用同一版本号）、c = cloud、m = mobile。
 * 用法：
 *   node scripts/bump-version.mjs d.5.1.0.0          # 直接指定目标版本
 *   node scripts/bump-version.mjs auto fix           # 修订位 +1（修 bug / 小改）
 *   node scripts/bump-version.mjs auto feature       # 特性位 +1
 *   node scripts/bump-version.mjs auto breaking      # 破坏位 +1
 *   node scripts/bump-version.mjs auto build         # 构建位 +1（同版本重出包）
 *
 * 【数字只增不减】用户 2026-10-19 明确要求：任一数字只允许 +1，永不归零。
 *   d.5.3.2.1 下一个 feature 是 d.6.3.2.1（破坏/修订/构建原样保留）。
 * 过去低位归零会让版本号「越迭代越看不懂」：d.3.0.1.0 → d.4.0.0.0 把修订数抹掉了，
 * 无法从版本号看出历史累积。改为累积计数后，每一位都是「至今累计做了多少次这类改动」，
 * 版本号本身就是迭代记录；也天然不会出现「版本号变小看起来像降级」。
 *
 * 字段分工：
 * - `hemingVersion`：面向用户展示与更新比较的 5 段版本（四个包都写）；
 * - `version`：electron-builder 只接受 semver，由 5 段派生的 `5.1.0-build.1`（四个包都写）；
 * - `shortVersion` / `shortVersionWindows`：Windows 四段版本 `5.1.0.1`（仅桌面包）。
 *
 * 一次改多处是有意为之：过去手工改版本只动了其中一处，根包与应用漂移过；
 * web/server/shared 三个子包的 version 曾长期停在 0.0.1，主页版本徽标因此永远显示
 * 「版本 v0.0.1」——vite 注入的是 web 包自己的 version，不是应用版本。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktopPkgPath = join(root, "packages", "desktop", "package.json");

const PATTERN = /^([dmc])\.(\d+)\.(\d+)\.(\d+)\.(\d+)(?:-dev\.(\d+))?$/;

/**
 * 需要同步的包：根包 + 桌面包 + 三个子包。
 * 子包是 workspace 内部包（`workspace:*` 链接），版本号不参与依赖解析，
 * 但它们各自的 version 会被 vite define、构建产物元数据读到，必须一起走。
 */
const SYNCED_PACKAGES = [
  { path: join(root, "package.json"), label: "." },
  { path: join(root, "packages", "desktop", "package.json"), label: "packages/desktop", windows: true },
  { path: join(root, "packages", "web", "package.json"), label: "packages/web" },
  { path: join(root, "packages", "server", "package.json"), label: "packages/server" },
  { path: join(root, "packages", "shared", "package.json"), label: "packages/shared" },
  { path: join(root, "packages", "setup", "package.json"), label: "packages/setup" },
];

/** 读 5 段版本；读不到或格式不对时返回 null（首次发布场景）。 */
function parseVersion(raw) {
  const m = PATTERN.exec(raw ?? "");
  if (!m) return null;
  return {
    channel: m[1],
    feature: +m[2],
    breaking: +m[3],
    revision: +m[4],
    build: +m[5],
    dev: m[6] === undefined ? null : +m[6],
  };
}

/** 读当前 5 段版本；读不到或格式不对时回落到 d.0.0.0.0（首次发布场景）。 */
function currentVersion() {
  try {
    const pkg = JSON.parse(readFileSync(desktopPkgPath, "utf8"));
    return parseVersion(pkg.hemingVersion ?? pkg.version) ?? {
      channel: "d",
      feature: 0,
      breaking: 0,
      revision: 0,
      build: 0,
      dev: null,
    };
  } catch {
    return { channel: "d", feature: 0, breaking: 0, revision: 0, build: 0, dev: null };
  }
}

/**
 * auto 模式：**只把目标位 +1，其余位原样保留**（用户要求数字只增不减）。
 * 这是「每次修改都要改版本号」的执行方式——不用手算，也不会把低位抹掉。
 */
function autoBump(kind, cur) {
  const next = { ...cur };
  if (kind === "feature") next.feature += 1;
  else if (kind === "breaking") next.breaking += 1;
  else if (kind === "build") next.build += 1;
  else next.revision += 1; // 默认（也是 fix）
  next.dev = null;
  return next;
}

/**
 * 逐段比较两个版本；通道不同返回 0（不同发布通道之间不可比）。
 * 与 packages/desktop/app-version.js 的 compareVersions 保持同一套语义。
 */
function compareParts(a, b) {
  if (a.channel !== b.channel) return 0;
  for (const key of ["feature", "breaking", "revision", "build"]) {
    if (a[key] !== b[key]) return a[key] - b[key];
  }
  if (a.dev === b.dev) return 0;
  if (a.dev === null) return 1;
  if (b.dev === null) return -1;
  return a.dev - b.dev;
}

const KIND_LABEL = {
  feature: "新功能 → 特性位 +1",
  breaking: "不兼容变更 → 破坏位 +1",
  fix: "修复/小改 → 修订位 +1",
  build: "同版本重出包 → 构建位 +1",
};

const cur = currentVersion();
const arg = process.argv[2];
const next = arg === "auto" ? autoBump(process.argv[3] ?? "fix", cur) : parseVersion(arg);
if (!next) {
  console.error("用法: node scripts/bump-version.mjs <d|m|c>.<特性>.<破坏性>.<修订>.<构建>[-dev.<n>]");
  console.error("  或: node scripts/bump-version.mjs auto <fix|feature|breaking|build>");
  console.error("示例: node scripts/bump-version.mjs d.5.1.0.0 / node scripts/bump-version.mjs auto fix");
  process.exit(1);
}

/**
 * 降级守卫：版本号数字只增不减。写入前拦住任何不比当前大的目标，
 * 避免手滑写了 d.4.0.0.0 把版本号改小、后续安装包互相覆盖、用户分不清新旧。
 */
const currentRaw = `${cur.channel}.${cur.feature}.${cur.breaking}.${cur.revision}.${cur.build}` +
  (cur.dev === null ? "" : `-dev.${cur.dev}`);
if (currentRaw !== "d.0.0.0.0" && compareParts(next, cur) <= 0) {
  console.error(`拒绝：目标版本必须大于当前版本（数字只增不减）。`);
  console.error(`  当前 ${currentRaw} → 目标 ${arg}`);
  console.error(`  当前版本只能往大的方向走。要重出同一版请用 auto build，要新增功能用 auto feature。`);
  process.exit(1);
}

if (next.channel !== "d") {
  console.warn(`提示：当前只发布桌面安装包（通道 d），你写的是 ${next.channel}。云端网页沿用 d 通道版本号。`);
}

const version =
  `${next.channel}.${next.feature}.${next.breaking}.${next.revision}.${next.build}` +
  (next.dev === null ? "" : `-dev.${next.dev}`);

// 派生 semver：只取前三位，**不要带 `-build.N`**。
//
// 原因（实测踩出来的）：semver 里 `-` 之后是 **prerelease**，
// `15.1.3-build.0` 会被判成预发布版，而 electron-updater **拒绝发布预发布版**——
// 表现是不生成 latest.yml、客户端永远提示「已是最新」，界面上与正常无差别，
// 靠肉眼看日志根本发现不了。
//
// 构建号并没有丢：它仍然完整保留在 5 段 `hemingVersion` 与 Windows 四段里，
// 只是不再塞进 semver。electron-builder 的更新比较用 semver，
// 而 5 段版本才是用户看到与判断「同版本重出包」的依据，两者互不干扰。
const semverVersion =
  `${next.feature}.${next.breaking}.${next.revision}` +
  (next.dev === null ? "" : `-dev.${next.dev}`);
const shortVersion = `${next.feature}.${next.breaking}.${next.revision}.${next.build}`;

for (const target of SYNCED_PACKAGES) {
  const pkg = JSON.parse(readFileSync(target.path, "utf8"));
  const previous = pkg.hemingVersion ?? pkg.version ?? "(无)";
  pkg.hemingVersion = version;
  pkg.version = semverVersion;
  if (target.windows) {
    pkg.shortVersion = shortVersion;
    pkg.shortVersionWindows = shortVersion;
  }
  writeFileSync(target.path, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`${previous} -> ${version}  ${target.label}/package.json`);
}

// README 顶部的「当前版本」跟着走，避免文档里的版本号变成另一套事实
const readmePath = join(root, "README.md");
try {
  const readme = readFileSync(readmePath, "utf8");
  const updated = readme.replace(/(\*\*当前版本\*\*：`)[^`]+(`)/, `$1${version}$2`);
  if (updated !== readme) {
    writeFileSync(readmePath, updated);
    console.log(`README 当前版本已同步为 ${version}`);
  } else {
    console.warn("提示：README 里没找到「**当前版本**」标记行，请手工核对");
  }
} catch {
  console.warn("提示：README.md 不可读，跳过版本号同步");
}

console.log(
  `派生：semver=${semverVersion}  windows=${shortVersion}` +
    (next.dev === null ? "" : `  预发=dev.${next.dev}（低于同数值正式版）`),
);
if (arg === "auto") {
  const label = KIND_LABEL[process.argv[3] ?? "fix"];
  console.log(`改动类型：${label}（其余位保留，未归零）`);
}
console.log(
  "下一步：写 CHANGELOG.md 条目 → node scripts/build-changelog.mjs → 需要给用户装包时 `node scripts/build-desktop.mjs --win nsis` → 云端部署。",
);
console.log("查看当前版本：node scripts/version.mjs");