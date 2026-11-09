# 插件示例（不发布，只用于学习与校验）

五份示例都放在 `plugin-kit/examples/` 下；真实要发布/安装的插件放仓库根的 `plugins/`。

| 示例 | 形态 | 教会你 |
|---|---|---|
| [`01-hello-skill`](01-hello-skill/) | v5 声明式 | 最小可用插件：一条技能；`instructions` 的四段结构 |
| [`02-mcp-and-commands`](02-mcp-and-commands/) | v5 声明式 | 接 MCP + 命令 + 工具束；`permissions.network` 与 `tools` 上限 |
| [`03-commands`](03-commands/) | v5 声明式 | 五种命令 target 的适用场景与限制 |
| [`04-widget-bundle`](04-widget-bundle/) | v4 bundle（仅首方） | 界面插件最小闭环：结构、外置脚本、设置/数据 API、发布顺序 |
| [`_invalid/demo-bad`](_invalid/demo-bad/) | 故意非法 | 校验器怎么点名错误（缺 `engines`、主机未声明）——**不要抄** |

```bash
# 校验全部合法示例（_invalid 默认跳过）
node scripts/plugin-lint.mjs --dir plugin-kit/examples --skip _invalid
pnpm plugin:lint          # 等价：批量校验 plugins/ + plugin-kit/examples

# 看故意报错长什么样（退出码 1）
node scripts/plugin-lint.mjs plugin-kit/examples/_invalid/demo-bad/plugin.json
```

## 抄示例的正确姿势

1. 选最接近需求的一份，整目录复制（不要只拷 `plugin.json`，README 里的步骤也是内容）。
2. 改 `id` / `name` / `version` / `engines.heming`，再改贡献点。
3. `node scripts/plugin-lint.mjs <你的目录>` → 修到零错误。
4. 应用里安装预览 → 装 → 看诊断 → 再发布。

字段语义见 [../STANDARD.md](../STANDARD.md)，场景配方见 [../COOKBOOK.md](../COOKBOOK.md)，卡住查 [../FAQ.md](../FAQ.md)。
