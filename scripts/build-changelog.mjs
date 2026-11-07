#!/usr/bin/env node
/**
 * 从 CHANGELOG.md 生成 `packages/web/src/generated/changelog.ts`（设置区的更新日志直接读它）。
 *
 * 为什么不直接读 md：浏览器/渲染层读不到仓库文件，而引入 markdown 渲染库又太重。
 * 所以构建期转成结构化 TS，产物可 review、可 diff、无运行时依赖。
 *
 * 用法：node scripts/build-changelog.mjs（发版流程：bump 之后、打包之前跑一次）
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseChangelog, renderChangelogModule, renderReleaseNotesModule } from "./changelog-parser.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "CHANGELOG.md");
const target = join(root, "packages", "web", "src", "generated", "changelog.ts");
const notesSource = join(root, "docs", "RELEASE-NOTES.md");
const notesTarget = join(root, "packages", "web", "src", "generated", "releaseNotes.ts");

if (!existsSync(source)) {
  console.error(`找不到 CHANGELOG.md（${source}）`);
  process.exit(1);
}

const entries = parseChangelog(readFileSync(source, "utf8"));
if (!entries.length) {
  console.error("CHANGELOG.md 里没解析出任何条目：检查标题格式是否为 `## d.x.y.z（YYYY-MM-DD）— 标题`");
  process.exit(1);
}

mkdirSync(dirname(target), { recursive: true });
const next = renderChangelogModule(entries);
const previous = existsSync(target) ? readFileSync(target, "utf8") : "";
if (previous === next) {
  console.log(`[build-changelog] 无变化（${entries.length} 条）`);
} else {
  writeFileSync(target, next);
  console.log(`[build-changelog] 已写入 ${target.replace(root, ".")}（${entries.length} 条，最新 ${entries[0].version}）`);
}

// 用户版发布说明（可选文件）：与 CHANGELOG 同一套解析器，内容只面向用户。
if (existsSync(notesSource)) {
  const notes = parseChangelog(readFileSync(notesSource, "utf8"));
  const nextNotes = renderReleaseNotesModule(notes);
  const prevNotes = existsSync(notesTarget) ? readFileSync(notesTarget, "utf8") : "";
  if (prevNotes === nextNotes) {
    console.log(`[build-changelog] 用户版发布说明无变化（${notes.length} 条）`);
  } else {
    writeFileSync(notesTarget, nextNotes);
    console.log(
      `[build-changelog] 已写入 ${notesTarget.replace(root, ".")}（${notes.length} 条，最新 ${notes[0]?.version ?? "—"}）`,
    );
  }
} else {
  console.log("[build-changelog] 没有 docs/RELEASE-NOTES.md，跳过用户版发布说明");
}
