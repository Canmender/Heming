#!/usr/bin/env node
/**
 * 一键查看当前版本 —— 用户要「随时知道装的是哪一版」时跑这个。
 *
 * 输出四块：版本号本身与各系统看到的形态、CHANGELOG 最近条目、
 * 磁盘上已有的安装包（文件名带版本号与时间）、git 最近提交。
 *
 * 用法：node scripts/version.mjs（= pnpm version:show）
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveReleaseDir } from "./release-dir.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktopPkg = JSON.parse(readFileSync(join(root, "packages", "desktop", "package.json"), "utf8"));
const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const version = desktopPkg.hemingVersion ?? desktopPkg.version ?? "(无)";
const rows = [
  ["应用版本（5 段，用户可见）", version],
  ["semver（electron-builder）", desktopPkg.version ?? "-"],
  ["Windows 四段", desktopPkg.shortVersionWindows ?? "-"],
  ["根包 hemingVersion", rootPkg.hemingVersion ?? "(未同步)"],
];
const width = Math.max(...rows.map(([k]) => [...k].length));
/** 中文按 2 列宽估算的左对齐（终端里更整齐，纯装饰）。 */
const pad = (text, n) => {
  const w = [...text].reduce((sum, ch) => sum + (/[^\x00-\xff]/.test(ch) ? 2 : 1), 0);
  return text + " ".repeat(Math.max(0, n - w));
};
console.log("和鸣版本");
for (const [k, v] of rows) console.log(`  ${pad(k, width * 2)}  ${v}`);
if (rootPkg.hemingVersion !== desktopPkg.hemingVersion) {
  console.log("  ⚠️ 根包与桌面包版本不一致，请跑 node scripts/bump-version.mjs 重新同步");
}
try {
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const shown = /\*\*当前版本\*\*：`([^`]+)`/.exec(readme)?.[1];
  if (shown && shown !== version) {
    console.log(`  ⚠️ README 写的是 ${shown}，与实际 ${version} 不一致（bump 脚本会自动同步，可能是手改了 README）`);
  }
} catch {
  /* README 缺失时跳过 */
}

// CHANGELOG 最近条目（第一个二级标题）
const changelogPath = join(root, "CHANGELOG.md");
if (existsSync(changelogPath)) {
  const lines = readFileSync(changelogPath, "utf8").split(/\r?\n/);
  const heading = lines.find((l) => l.startsWith("## "));
  if (heading) console.log(`\n最近条目  ${heading.replace(/^##\s*/, "")}`);
}

// 磁盘上的安装包（文件名带 5 段版本）
const releaseDir = resolveReleaseDir({ create: false });
if (existsSync(releaseDir)) {
  const exes = readdirSync(releaseDir).filter((f) => f.toLowerCase().endsWith(".exe"));
  console.log("\n已有安装包");
  if (exes.length === 0) console.log("  （无）");
  for (const f of exes) {
    const st = statSync(join(releaseDir, f));
    const stamp = `${st.mtime.getMonth() + 1}/${st.mtime.getDate()} ${String(st.mtime.getHours()).padStart(2, "0")}:${String(st.mtime.getMinutes()).padStart(2, "0")}`;
    console.log(`  ${f}  (${(st.size / 1024 / 1024).toFixed(0)}MB, ${stamp})`);
  }
}

try {
  const log = execFileSync("git", ["log", "-3", "--date=short", "--pretty=format:%h %ad %s"], {
    cwd: root,
    encoding: "utf8",
  });
  console.log(`\n最近提交\n${log
    .trim()
    .split(/\r?\n/)
    .map((l) => `  ${l}`)
    .join("\n")}`);
} catch {
  /* 不是 git 仓库就跳过 */
}

console.log(`\n规则：每次修改都要改版本号 → node scripts/bump-version.mjs auto <fix|feature|breaking|build>`);