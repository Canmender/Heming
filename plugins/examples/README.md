# 插件示例（不随安装包分发）

这三个包是给 `scripts/plugin-lint.mjs`、单元测试与文档用的**最小样例**，不是发布物：

| 目录 | 用途 |
|---|---|
| `demo-minimal/` | 只带一条技能的 v5 最小包（合法） |
| `demo-full/` | 技能 + 本机 MCP + 命令 + 工具束的 v5 完整包（合法） |
| `demo-bad/` | 故意写错：缺 `engines`、MCP 主机未被 `permissions.network` 覆盖（应当失败） |

```bash
# 校验全部示例（bad 会让退出码为 1，这是预期）
node scripts/plugin-lint.mjs --dir plugins/examples

# 单个文件
node scripts/plugin-lint.mjs plugins/examples/demo-minimal/plugin.json
```

v1–v4 旧包仍可安装，但本脚本只做 v5 权威校验；旧包请用应用内的安装预览验证。
`scripts/publish-plugin.mjs` 发布的是 `plugins/` 下真实插件包（如 `infohub-collector/`），
`examples/` 不参与发布。
