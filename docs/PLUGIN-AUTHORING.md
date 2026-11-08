# 插件作者指南（v5）

> 面向：写 `plugin.json` 的人（产品/集成方/官方）。目标是把「怎么写出一个能装上、能被市场展示、不会装完半可用」讲清楚。
> 契约：`docs/PLUGINS.md` 是完整字段表；本指南是最短路径 + 常见坑。v5 相对 v3/v4 的新增只有三件事：`engines`（最低宿主版本）、`meta`（上架元数据）、未知字段分层策略。

## 1. 五分钟写出第一个插件

```bash
mkdir -p plugins/acme-hello
cat > plugins/acme-hello/plugin.json <<'JSON'
{
  "schemaVersion": 5,
  "id": "acme.hello",
  "name": "问候工具",
  "version": "1.0.0",
  "description": "一条能按场合写问候语的技能",
  "author": "ACME",
  "engines": { "heming": "d.105" },
  "contributions": {
    "skills": [
      {
        "name": "写问候",
        "description": "按场合生成得体的问候语",
        "instructions": "先问清对象与场合（正式/熟人/节日），再给 1–3 条候选，不要堆形容词。",
        "triggers": ["问候", "寒暄"],
        "tags": ["写作"]
      }
    ]
  }
}
JSON

# 校验（权威校验器与安装预览同一份）
node scripts/plugin-lint.mjs plugins/acme-hello/plugin.json
```

合法最小清单只需要：`schemaVersion` / `id` / `name` / `version` / `engines` / 至少一类非空 `contributions`。
没有 MCP 服务时可以整段省略 `permissions`。

## 2. 五个字段决定「能不能装、装完像不像样」

| 字段 | 作用 | 常见错法 |
|---|---|---|
| `id` | 安装后的稳定身份（同 id 再装 = 更新，换 id = 另一个插件） | 大写字母、空格、中文、超过 64 字；发布后改名（用户会看到两个插件） |
| `version` | 更新判定 + 市场版本列表 | 同 id 同版本改了内容再发布（服务端会拒绝：同一版本必须内容不变，见 §6） |
| `engines.heming` | **最低宿主版本**，安装前就拦不兼容 | 写 semver range（`^1.2.3`）——不支持；写 `d.105.2.42.0` 这种过细版本也能装，但会把你钉在很新的宿主上 |
| `meta` | 市场页的图标/分类/标签/关键词/详情 | 用 `data:` 内联大图（占本机配额）；`homepage` 写成 http 或带账号密码 |
| `permissions` | 安装确认卡展示的权限，且是**执行期收紧**的依据 | MCP 服务的 host 没写进 `network`（直接拒绝安装）；把 `tools` 写成 `none` 却声明写工具（工具不会注入） |

## 3. 贡献点：你这代能声明什么

| 贡献点 | 第三方声明式包 | 官方界面插件（bundle） | 说明 |
|---|---|---|---|
| `skills` | ✅ | ❌ | 技能写进技能池，可分配给智能体 |
| `mcpServers` | ✅（只 https，本机可 http） | ❌ | 远程 MCP 工具；装完默认不自动连接、工具默认关闭 |
| `commands` | ✅ | ✅（target 只允许 `page`/`plugin`） | 命令面板入口 |
| `toolPacks` | ✅ | ❌ | 只标归属，不改工具开关 |
| `desktopWidgets` | ❌ | ✅（首方签名） | 独立窗口的界面插件 |
| `page` / `homeCard` / `settingsCard` / `backgroundJob` / `hook` | ❌ | ❌（hook 阶段 C） | 界面/后台能力需要可执行代码，第三方包不开放——这是红线，不是暂缺 |

**为什么第三方不能加页面**：那等于「安装即执行任意 UI 代码」。和鸣只给**首方签名**的界面插件开这个口子；将来若开放，会先有沙箱 + 签名 + 独立规格。

## 4. 权限：声明即约束

```jsonc
"permissions": {
  "network": ["api.acme.com", "127.0.0.1:3999"],  // 每个 MCP 服务的 host 都必须在这里
  "tools": "read",                                 // 本插件 MCP 工具的风险上限：none/read/write
  "files": [],                                     // 预留，本轮只展示
  "events": ["notify"],                            // 只有界面插件用
  "graphics": ["webgl"],                           // 只有界面插件用
  "eval": false
}
```

- `tools` 是**上限**：超过上限的工具不会注入给模型（不是页面上标一下）。写工具仍逐次走人工确认，插件不会放宽 HITL。
- `network` 只写 host 或 host:port，不要写 `https://`、路径、通配符。默认端口两侧统一（`:443` 等于不写）。
- 安装确认卡会完整展示权限；用户点「安装」= 确认这份清单。

## 5. 分层严格度：哪些写错会被忽略、哪些会直接失败

| 位置 | 未知/多余字段 | 结果 |
|---|---|---|
| 顶层 | 不认识 | **剥掉 + 警告**（安装预览与 lint 都会说「已忽略未知字段 x」） |
| `engines` / `permissions` / `meta` / 每个贡献条目 | 不认识 | **报错，不装**（防止把权限写到危险的位置还被静默忽略） |
| 顶层数组超额 / 重名 | — | 报错并点名（技能名、服务 key、命令 id、工具束 id 都要唯一；工具名不得跨束重复） |

## 6. 发布与市场

```bash
# 只写本机目录（部署时同步到服务器）
node scripts/publish-plugin.mjs plugins/acme-hello/plugin.json --dest /opt/heming/plugins

# 直接推云端（需要服务端配置 HEMING_PLUGIN_PUBLISH_KEY）
HEMING_PLUGIN_PUBLISH_KEY=*** node scripts/publish-plugin.mjs plugins/acme-hello --push https://heming.example.com

# 生成/更新市场索引（v5 包才会出现在「市场」页）
node scripts/publish-plugin.mjs --index /opt/heming/plugins
```

- **同一 id + 版本的内容不可变**：改了内容必须提升 `version`，否则服务端返回 409。
- 弃用：整插件下架写 `market.json` 的 `status: removed` + `deprecatedReason` + `alternativeId`；单版本有问题写该版本的 `status: deprecated` + `statusMessage`（≤500 字）。
- 详情页内容：`meta.detail` 内联（≤16KB）或包内 `.md` 相对路径；市场页按「概述 / 贡献 / 版本历史」展示。
- 预发布：版本可标 `channel: prerelease`，默认折叠不推送。

## 7. 调试三招

1. `node scripts/plugin-lint.mjs <plugin.json>`：与安装预览同一套权威校验 + 中文字段路径。
2. 插件区 → 安装 → 粘贴清单：先看**预览**（差异、冲突、权限、兼容性），不点安装不会写任何东西。
3. 装完不生效？插件详情「诊断」区会写原因：停用 / 贡献级关 / 依赖未启用 / 需要更新和鸣 / 签名 / 超权限未注入 / 孤儿记录。**不要靠猜。**

## 8. 兼容性速查

| 你的清单 | 旧版和鸣（≤d.104） | 新版和鸣（≥d.105） |
|---|---|---|
| v1/v2/v3 | 可装 | 可装（归一化到 v5 视图） |
| v4（界面插件） | 可装 | 可装；**必须首方签名**（旧版不验签 = 已知缺口） |
| v5 | 拒绝（schemaVersion 不认识） | 可装，按 `engines.heming` 判定 |

> v5 是**新增**不是替换：旧包继续能装，改动只是「新包能声明兼容性与上架元数据」。
