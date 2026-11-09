# {{name}}

插件 id：`{{id}}`；类型：{{kindLabel}}。本目录由 `node scripts/new-plugin.mjs --kind {{kind}}` 生成。

## 怎么改

{{editGuide}}

{{schemaNote}}

## 怎么校验

```bash
node scripts/plugin-lint.mjs {{dir}}              # 单个目录；中文报错 + 字段路径
node scripts/plugin-lint.mjs {{dir}} --strict     # warning 也算失败（CI 可选）
node scripts/plugin-lint.mjs {{dir}} --json       # 机器可读（CI）
pnpm plugin:lint                                  # 批量校验 plugins/ 与 plugin-kit/examples
pnpm plugin:check                                 # shared 构建 + 批量 lint + schema 一致性
```

## 怎么装

{{installGuide}}

## 怎么发布

{{publishGuide}}

发布前先过 `pnpm plugin:check`；同一 `id` 的同一 `version` 内容不可变，内容变了先升 `version`。

参考文档：`plugin-kit/AUTHORING.md`（操作标准）、`plugin-kit/STANDARD.md`（契约）、`plugin-kit/COOKBOOK.md`（菜谱）、`docs/PLUGINS.md`（实现与红线）。

> 说明：`plugin-kit/templates/` 与 `plugin-kit/examples/_invalid/` 不参与 `pnpm plugin:lint` 的批量校验。
