# 插件工具包（plugin-kit）

> **插件作者的唯一入口。** 标准、编写指南、可抄的示例、脚手架、编辑器 schema 都在这个文件夹里，不再散在仓库各处。
>
> 现行接口：声明式插件 `schemaVersion: 5`；界面插件 `schemaVersion: 4` + `distribution: "bundle"`（仅首方）。

---

## 30 秒上手

```bash
pnpm plugin:new acme.hello --name 问候工具   # 生成到 plugin-kit/plugins/ 并自动校验
pnpm plugin:lint                              # 批量校验（真实插件 + examples）
pnpm plugin:check                             # CI 口径：构建 + 校验 + schema 一致性
```

生成的 `plugin.json` 就是唯一必填产物：改技能/MCP/命令，存盘，然后在应用里「插件区 → 手动粘贴清单」粘贴或选文件看预览。

---

## 目录导航

| 你想…… | 看这里 |
|---|---|
| 看/改真实插件源码 | [`plugins/`](plugins/README.md)：InfoHub 采集桥、桌宠、工作流引擎 |
| 先跑起来、抄一份能用的 | [`examples/`](examples/README.md)，五份可 lint 通过的完整示例 |
| 知道字段与语义（契约） | [`STANDARD.md`](STANDARD.md) |
| 知道怎么做（操作标准 + 检查清单） | [`AUTHORING.md`](AUTHORING.md) |
| 查某个具体场景怎么写 | [`COOKBOOK.md`](COOKBOOK.md) |
| 遇到报错/疑问 | [`FAQ.md`](FAQ.md) |
| 编辑器补全 | [`plugin.schema.json`](plugin.schema.json)（只补全，不校验） |
| 脚手架模板 | [`templates/`](templates/)（`plugin:new` 从这里生成） |

仓库内另外两份文档分工明确：`docs/PLUGINS.md` 是**宿主实现说明**（内部怎么装、边界与红线），
`packages/shared/src/plugin/widget.ts` 是**界面插件运行时类型**（`HemingWidgetApi`）。

---

## 学习路径（建议顺序）

1. **跑一遍**：`plugin:new` 生成 → `plugin:lint` → 应用里安装预览（不点安装也能看差异）。
2. **抄一份**：按需求从 `examples/` 里选最接近的（技能 / MCP / 命令 / 界面插件 / 插件页面）。
3. **对齐契约**：只读 `STANDARD.md` 里与你相关的那一节（清单字段、权限、贡献点）。
4. **按检查清单收尾**：`AUTHORING.md` §9 逐条打勾 → 发布（`AUTHORING.md` §7）。

---

## 五份示例（都通过权威校验）+ 两份故意非法（不要抄）

| 示例 | 形态 | 教会你 |
|---|---|---|
| [`01-hello-skill`](examples/01-hello-skill/) | v5 声明式 | 最小可用插件：一条技能、`engines`、触发词怎么写 |
| [`02-mcp-and-commands`](examples/02-mcp-and-commands/) | v5 声明式 | 接入远程/本机 MCP + 命令 + 工具束，权限怎么写才不算多要 |
| [`03-commands`](examples/03-commands/) | v5 声明式 | 五种命令 target（页面/设置/单元/插件/技能）各自的适用场景 |
| [`04-widget-bundle`](examples/04-widget-bundle/) | v4 bundle（首方） | 界面插件最小可运行骨架：`files/` 结构、外置脚本、设置与数据 API 用法 |
| [`05-plugin-page`](examples/05-plugin-page/) | v5 声明式 | 插件页面：导航入口 + 受控块（markdown/指标/表格/列表/动作/贡献清单）怎么写 |
| [`_invalid/demo-bad`](examples/_invalid/demo-bad/) | 故意写错 | 校验器怎么点名错误（缺 `engines`、主机未声明），**不要抄** |
| [`_invalid/page-entry-on-declarative`](examples/_invalid/page-entry-on-declarative/) | 故意写错 | 声明式页写了 bundle 的 `entry` 会怎么被拒，**不要抄** |

```bash
# 校验全部示例（_invalid 默认跳过）
node scripts/plugin-lint.mjs --dir plugin-kit/examples --skip _invalid

# 故意看失败长什么样
node scripts/plugin-lint.mjs plugin-kit/examples/_invalid/demo-bad/plugin.json
```

---

## 命令速查

| 命令 | 作用 |
|---|---|
| `pnpm plugin:new <id> [--name …] [--kind manifest\|bundle]` | 生成骨架到 `plugin-kit/plugins/`（v5 声明式 / v4 界面插件），自动填 `$schema` 与 `engines.heming` |
| `pnpm plugin:lint` | 批量校验仓库里的插件与示例 |
| `pnpm plugin:check` | 构建 shared → 批量校验 → schema 一致性（CI 用，失败即非 0） |
| `pnpm plugin:schema` | 重新生成 `plugin-kit/plugin.schema.json`（改了清单字段才需要） |
| `pnpm plugin:pack` | 打确定性 `package.tgz`（界面插件） |
| `pnpm plugin:publish` | 发布到插件目录/云端仓库 |
| `node scripts/sign-plugin.mjs sign <清单> <私钥> --id <发布者> --write` | 首方签名（界面插件；私钥不落仓库，见 AUTHORING §7） |

---

## 三条红线（先记住再动手）

1. **不执行随包代码**：声明式插件只有技能/服务/命令/工具束和**声明式页面**（页面内容只是数据，宿主渲染），没有脚本、没有 `npm install`。
2. **权限声明即约束**：`network` / `tools` / `events` 在执行期生效，超限的工具不会交给模型。
3. **界面插件只对首方开放**：bundle 必须首方签名，第三方没有发布路径。
