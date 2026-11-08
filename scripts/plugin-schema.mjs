#!/usr/bin/env node
/**
 * 生成 `docs/plugin.schema.json`（插件清单 v5 的编辑器补全 schema）。
 *
 * ★ 重要边界：这份 JSON Schema **只用于编辑器补全/提示**，不是权威校验。
 *   zod 的 `toJSONSchema` 不会输出 `.superRefine()` 里的跨字段规则（bundle 只许
 *   commands+desktopWidgets、MCP 主机必须被 permissions.network 覆盖、工具名不得
 *   跨束重复…）。权威校验永远是 `parsePluginManifestV5`（`scripts/plugin-lint.mjs`
 *   与安装预览都走它）。本脚本在 CI 里用 `--check` 比对生成物，防止有人手改漂移。
 *
 * 用法：
 *   node scripts/plugin-schema.mjs            # 写入 docs/plugin.schema.json
 *   node scripts/plugin-schema.mjs --check    # 只比对，不一致退出码 1（CI 用）
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outFile = join(root, "docs", "plugin.schema.json");
const distEntry = join(root, "packages", "shared", "dist", "index.js");

if (!existsSync(distEntry)) {
  console.error("找不到 packages/shared/dist/index.js。先跑 `pnpm --filter @heming/shared build`。");
  process.exit(1);
}

const { pluginManifestV5JsonSchema } = await import(`file://${distEntry.replace(/\\/g, "/")}`);
const schema = pluginManifestV5JsonSchema();
const payload = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://heming.app/schemas/plugin.schema.json",
  title: "和鸣插件清单 v5",
  description:
    "只用于编辑器补全。权威校验走 parsePluginManifestV5（node scripts/plugin-lint.mjs 会做完整校验，包括跨字段规则）。",
  ...schema,
};
const text = `${JSON.stringify(payload, null, 2)}\n`;

const check = process.argv.includes("--check");
if (check) {
  if (!existsSync(outFile)) {
    console.error("docs/plugin.schema.json 不存在，请跑 node scripts/plugin-schema.mjs");
    process.exit(1);
  }
  const current = readFileSync(outFile, "utf8");
  if (current !== text) {
    console.error("docs/plugin.schema.json 与 v5 schema 不一致，请重新生成并提交。");
    process.exit(1);
  }
  console.log("plugin.schema.json 已是最新。");
  process.exit(0);
}

writeFileSync(outFile, text, "utf8");
console.log(`已写入 ${outFile}（${Buffer.byteLength(text)} 字节）`);
