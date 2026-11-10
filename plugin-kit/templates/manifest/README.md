# {{name}}

插件 id：`{{id}}`；类型：{{kindLabel}}。本目录由 `node scripts/new-plugin.mjs --kind {{kind}}` 生成。

## 怎么改

{{editGuide}}

## 可选：让插件在左侧导航多一个入口（插件页面，d.124）

**不写 `page` 就没有入口**——纯能力包照旧只在插件页/技能区/命令面板里生效。想加页面时，在 `plugin.json` 的
`contributions` 里加 `page`（其它部分不用动）：

```json
"page": {
  "title": "插件名",
  "icon": "activity",
  "summary": "一句话说明这个页面能看什么",
  "blocks": [
    { "type": "markdown", "title": "怎么用", "text": "写清入口与下一步。" }
  ]
}
```

- `blocks` 1–12 个，词表 `markdown` / `stats` / `table` / `list` / `actions` / `contributions`；
  字段与限制见 `plugin-kit/STANDARD.md` §3.7，可抄 `plugin-kit/examples/05-plugin-page/`。
- 写 `page` 时把 `engines.heming` 提到 `d.124`（旧版宿主不认识该字段）。
- 页面不新增权限、不联网、不执行代码；每插件最多一个页面。
- 界面插件（`--kind bundle`）要自带页时写 `page.entry = "files/page.html"`（`entry` 必须在 `files` 里，仅首方签名包可装）。

{{schemaNote}}

## 怎么校验

```bash
node scripts/plugin-lint.mjs {{dir}}              # 单个目录；中文报错 + 字段路径
node scripts/plugin-lint.mjs {{dir}} --strict     # warning 也算失败（CI 可选）
node scripts/plugin-lint.mjs {{dir}} --json       # 机器可读（CI）
pnpm plugin:lint                                  # 批量校验 plugin-kit/plugins 与 plugin-kit/examples
pnpm plugin:check                                 # shared 构建 + 批量 lint + schema 一致性
```

## 怎么装

{{installGuide}}

## 怎么发布

{{publishGuide}}

发布前先过 `pnpm plugin:check`；同一 `id` 的同一 `version` 内容不可变，内容变了先升 `version`。

参考文档：`plugin-kit/AUTHORING.md`（操作标准）、`plugin-kit/STANDARD.md`（契约）、`plugin-kit/COOKBOOK.md`（菜谱）、`docs/PLUGINS.md`（实现与红线）。

> 说明：`plugin-kit/templates/` 与 `plugin-kit/examples/_invalid/` 不参与 `pnpm plugin:lint` 的批量校验。
