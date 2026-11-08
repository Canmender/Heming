#!/usr/bin/env node
/**
 * 插件清单校验器（v5 权威校验；v1–v4 只做兼容性提示）。
 *
 * 为什么单独做一个脚本：`parsePluginManifestV5` 是 web 安装预览与 market 生成器
 * 共用的唯一权威校验器，但作者在本地写完 `plugin.json` 时也应该能离线跑一遍，
 * 而不是装一次才知道哪一行错了。CI 也可以用它挡坏包。
 *
 * 用法：
 *   node scripts/plugin-lint.mjs plugins/infohub-collector/plugin.json
 *   node scripts/plugin-lint.mjs --dir plugins            # 递归校验目录下所有 plugin.json
 *   node scripts/plugin-lint.mjs --json a.json            # 机器可读输出（CI 用）
 *
 * 退出码：0 = 全部通过（可能有 warning）；1 = 有错误；2 = 用法/环境问题。
 * 输出一律中文，带字段路径（与安装预览同一套文案）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distEntry = join(root, "packages", "shared", "dist", "index.js");

if (!existsSync(distEntry)) {
  console.error("找不到 packages/shared/dist/index.js。先跑 `pnpm --filter @heming/shared build`。");
  process.exit(2);
}

const { parsePluginManifestV5, PluginManifestInvalidError, PLUGIN_SCHEMA_VERSION_V5 } = await import(
  `file://${distEntry.replace(/\\/g, "/")}`
);

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const dirIndex = args.indexOf("--dir");
const files = [];

if (dirIndex >= 0) {
  const dir = args[dirIndex + 1];
  if (!dir) usage();
  collect(join(root, dir));
} else {
  for (const arg of args) {
    if (arg.startsWith("-")) continue;
    files.push(arg);
  }
}

function usage() {
  console.error("用法：node scripts/plugin-lint.mjs <plugin.json...> | --dir <目录> [--json]");
  process.exit(2);
}

function collect(dir) {
  if (!existsSync(dir)) {
    console.error(`目录不存在：${dir}`);
    process.exit(2);
  }
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      collect(full);
    } else if (name === "plugin.json") {
      files.push(full);
    }
  }
}

if (files.length === 0) usage();

const results = files.map((file) => {
  const display = relative(root, file) || file;
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    return { file: display, errors: [`不是合法 JSON：${(err && err.message) || err}`], warnings: [] };
  }
  const version = raw && typeof raw === "object" ? raw.schemaVersion : undefined;
  if (version !== PLUGIN_SCHEMA_VERSION_V5) {
    return {
      file: display,
      errors: [],
      warnings: [
        `schemaVersion=${String(version)} 是旧版清单（v1–v4）：本脚本只做 v5 权威校验，旧包请用应用内安装预览验证。`,
      ],
    };
  }
  try {
    const parsed = parsePluginManifestV5(raw);
    return { file: display, errors: [], warnings: parsed.warnings, manifest: parsed.manifest };
  } catch (err) {
    if (err instanceof PluginManifestInvalidError) {
      return { file: display, errors: [err.message], warnings: [] };
    }
    return { file: display, errors: [`校验器异常：${(err && err.message) || err}`], warnings: [] };
  }
});

const failed = results.filter((result) => result.errors.length > 0);

if (asJson) {
  console.log(JSON.stringify({ ok: failed.length === 0, results }, null, 2));
} else {
  for (const result of results) {
    const status = result.errors.length > 0 ? "✗" : "✓";
    console.log(`${status} ${result.file}${result.manifest ? `（${result.manifest.id} ${result.manifest.version}）` : ""}`);
    for (const warning of result.warnings) console.log(`  · 提示：${warning}`);
    for (const error of result.errors) console.log(`  · 错误：${error}`);
  }
  console.log(
    `\n共 ${results.length} 个清单：通过 ${results.length - failed.length}，失败 ${failed.length}${failed.length ? "。" : "。"}`,
  );
}

process.exit(failed.length > 0 ? 1 : 0);
