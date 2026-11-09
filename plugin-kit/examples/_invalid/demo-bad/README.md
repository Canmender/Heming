# 故意非法的包（不要抄）

这个包**故意写错**，用来保证校验器的报错质量不退化。它应当**失败**：

```bash
node scripts/plugin-lint.mjs plugin-kit/examples/_invalid/demo-bad/plugin.json
# 退出码 1，报错形如：
#   · 错误：engines：必填
#   · 错误：permissions.network 未覆盖 MCP 服务主机 api.not-declared.example（见 contributions.mcpServers[0].url）
```

它同时是一份「常见错误对照」：

| 错误 | 正确写法 |
|---|---|
| 缺 `engines` | `"engines": { "heming": "d.117" }` |
| MCP 服务 host 不在 `permissions.network` | 把 `api.not-declared.example` 加进 `network` |
| 顶层多写无关字段 | 删掉（顶层多余字段只会被忽略+警告，但没必要） |

`plugin:check` 默认跳过 `_invalid`，所以它不会把 CI 弄红。
