#!/usr/bin/env node
/**
 * 源码不得含裸 NUL 字节（d.113 审计 P1-7）。
 *
 * 背景：几处注释里写了 `path\0len`，在编辑/生成过程中变成了**真实的 NUL 字节**。
 * 后果不是运行错误，而是更隐蔽的：
 * - git 把整个文件当 **binary**（`git log --numstat` 显示 `- -`），历史 diff 不可读；
 * - `grep`/`file`/部分安全扫描器直接跳过或误判，等于给这些文件开了「审阅盲区」；
 * - 带 NUL 的文件如果恰好是安全敏感路径（如 `shared/src/plugin/manifest.ts` 的清单解析器），
 *   review 工具看不到改动，恶意篡改更容易藏。
 *
 * 规则：`packages/**`、`docs/**`、`scripts/**`、`plugin-kit/**` 下 `.ts/.tsx/.js/.mjs/.md/.json/.css`
 * 不允许出现 0x00。注释里的转义应写成两个字符 `\0`（反斜杠 + 0），不是 NUL 字节。
 *
 * 用法：node scripts/check-source-encoding.mjs   （有 NUL → 退出码 1）
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOTS = ["packages", "docs", "scripts", "plugin-kit"];
const EXTS = new Set([".ts", ".tsx", ".js", ".mjs", ".md", ".json", ".css"]);
const SKIP_DIRS = new Set(["node_modules", "dist", "release", "web-dist", ".git", "catalog"]);

const hits = [];
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name));
      continue;
    }
    if (!EXTS.has((/\.[^.]+$/.exec(entry.name) ?? [""])[0])) continue;
    const file = join(dir, entry.name);
    if (!statSync(file).isFile()) continue;
    let data;
    try {
      data = readFileSync(file);
    } catch {
      continue;
    }
    const index = data.indexOf(0);
    if (index >= 0) {
      const line = data.subarray(0, index).toString("utf8").split("\n").length;
      let count = 0;
      for (const byte of data) if (byte === 0) count += 1;
      hits.push({ file: relative(root, file), line, count });
    }
  }
}

for (const name of ROOTS) {
  const dir = join(root, name);
  try {
    walk(dir);
  } catch {
    // 目录不存在（如未构建）就跳过
  }
}

if (hits.length === 0) {
  console.log(`[check-source-encoding] OK：${ROOTS.join(" / ")} 下没有裸 NUL 字节`);
  process.exit(0);
}
console.error("[check-source-encoding] 发现裸 NUL 字节（会让 git/grep 把文件当二进制，形成审阅盲区）：");
for (const hit of hits) console.error(`  ${hit.file}:${hit.line}（${hit.count} 个 NUL）`);
console.error("修法：把注释里的 NUL 改成两个字符 `\\0`（反斜杠 + 0），不要写真实 0x00。");
process.exit(1);
