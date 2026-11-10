# 故意非法的包：声明式页面写了 `entry`（不要抄）

`schemaVersion: 5` 的声明式插件**不能用** `contributions.page.entry`（那是界面插件 bundle 的字段）。
解析器应当拒绝，并提示改用 `blocks` 或改成 `distribution: "bundle"`：

```bash
node scripts/plugin-lint.mjs plugin-kit/examples/_invalid/page-entry-on-declarative/plugin.json
# 退出码 1，报错形如：
#   · 错误：声明式插件（distribution: manifest）的页面用 contributions.page.blocks 渲染，
#     不能写 contributions.page.entry；需要自带 HTML 请改用 distribution: "bundle"
```

两种正确写法：

| 需求 | 写法 |
|---|---|
| 第三方 / 无代码页面 | 删掉 `entry`，写 1–12 个 `blocks`（见示例 [`05-plugin-page`](../../05-plugin-page/)） |
| 首方界面插件自带 HTML | 改 `schemaVersion: 4` + `distribution: "bundle"` + `packageSha256`，`entry` 指向包内 `.html` |

`plugin:check` 默认跳过 `_invalid`，所以它不会把 CI 弄红。
