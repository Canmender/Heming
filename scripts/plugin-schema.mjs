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
/**
 * 顶层 `$schema` 是「已知但忽略」的编辑器补全字段（`KNOWN_TOP_LEVEL` 里已白名单），
 * 解析器不会为它产生「未知字段」warning。这里把它补进 schema 的 properties，
 * 否则编辑器按 JSON Schema 校验时会把它当未知字段（`additionalProperties: false`）。
 */
const schemaProperties =
  schema.properties && typeof schema.properties === "object" ? schema.properties : {};
/**
 * `required` 修正：zod 用 `io: "output"` 生成的 `required` 会把**带缺省值**的字段
 * （`description` / `author`）也算成必填，但解析器接受省略（缺省 `""`）。
 * 编辑器据此标红一个合法清单，比没有补全更糟，所以这里按**解析器的真实口径**剔除。
 */
const outputRequired = Array.isArray(schema.required) ? schema.required : [];
const OPTIONAL_WITH_DEFAULT = new Set(["description", "author"]);
const required = outputRequired.filter((key) => !OPTIONAL_WITH_DEFAULT.has(key));
const payload = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://heming.app/schemas/plugin.schema.json",
  title: "和鸣插件清单 v5",
  description:
    "只用于编辑器补全。权威校验走 parsePluginManifestV5（node scripts/plugin-lint.mjs 会做完整校验，包括跨字段规则）。",
  ...schema,
  // 顶层未知字段的**权威口径是「剥掉并给 warning」，不阻断安装**（见 manifest.ts 分层严格度）；
  // schema 若写死 additionalProperties:false，编辑器会对「能装但被忽略」的字段标红，与真实行为冲突。
  additionalProperties: true,
  required,
  properties: {
    $schema: {
      type: "string",
      description:
        "编辑器补全用的 schema 路径：仓库内可写相对路径（如 ../../docs/plugin.schema.json），对外发布可写 https://heming.app/schemas/plugin.schema.json。只作提示，权威校验仍走 parsePluginManifestV5；解析器已知并忽略该字段，不会告警。",
    },
    ...schemaProperties,
  },
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
