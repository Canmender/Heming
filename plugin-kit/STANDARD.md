# 和鸣插件标准接口（PLUGIN-STANDARD）

> **这份文件是规范（normative）**：插件能声明什么、声明的含义、宿主如何校验与强制、升级时谁对谁负责。
> 写插件请配 [AUTHORING.md](AUTHORING.md)（操作标准 + 检查清单）、[COOKBOOK.md](COOKBOOK.md)（场景菜谱）、
> [FAQ.md](FAQ.md)（常见问题）；实现细节与内部边界见 [docs/PLUGINS.md](../docs/PLUGINS.md)；
> 机器可读的编辑器补全用 [`plugin.schema.json`](plugin.schema.json)。
>
> 现行标准：**声明式插件 `schemaVersion: 5`**；**界面插件 `schemaVersion: 4` + `distribution: "bundle"`**
> （仅首方签名）。本文中的「必须 / 不得 / 应」按 RFC 2119 语义理解。
>
> 唯一权威校验器：`packages/shared/src/plugin/manifest.ts` 的 `parsePluginManifestV5()`。
> 任何文档、schema、脚本与它冲突时，**以它为准**，并应提 PR 修文档。

## 目录

- [0. 文档分工](#0-文档分工四份文件不要互相抄)
- [1. 接口版本与兼容](#1-接口版本与兼容)
- [2. 清单接口（Manifest）](#2-清单接口manifest)
- [3. 贡献点接口](#3-贡献点接口)
- [4. 权限接口（Permissions）](#4-权限接口permissions)
- [5. 生命周期接口](#5-生命周期接口)
- [6. 运行时接口（仅界面插件 bundle）](#6-运行时接口仅界面插件-bundle)
- [7. 校验、诊断与错误口径](#7-校验诊断与错误口径)
- [8. 分发接口](#8-分发接口)
- [9. 附录](#9-附录)

---

## 0. 文档分工（四份文件不要互相抄）

| 文件 | 定位 | 读者 | 是否可执行 |
|---|---|---|---|
| `plugin-kit/STANDARD.md`（本文） | **契约**：字段语义、权限、生命周期、运行时 API、兼容规则 | 插件作者 / 宿主开发者 / 评审 | 规范，靠 `plugin-lint` 与测试落地 |
| `plugin-kit/AUTHORING.md` | **操作标准**：从零到发布的步骤、模板、检查清单、常见错误 | 插件作者 | 是（命令可直接跑） |
| `plugin-kit/COOKBOOK.md` / `FAQ.md` | **场景菜谱 / 常见问题**：按需求查怎么写、卡住时查为什么 | 插件作者 | 是（片段可直接粘） |
| `docs/PLUGINS.md` | **实现说明**：宿主内部怎么装、怎么物化、边界与红线、分发链路 | 维护者 | 否 |
| `plugin-kit/plugin.schema.json` | **编辑器补全**（JSON Schema） | 编辑器 / IDE | 仅补全，**不是权威校验** |

生成关系：`plugin.schema.json` 由 `node scripts/plugin-schema.mjs` 从 zod 定义生成，CI 用 `--check` 防漂移。

---

## 1. 接口版本与兼容

### 1.1 两个插件形态

| 形态 | `schemaVersion` | `distribution` | 可执行代码 | 谁能发布 |
|---|---|---|---|---|
| **声明式包**（manifest） | `5`（v1–v3 旧包可装） | 省略或 `"manifest"` | 无 | 任何人 |
| **界面插件**（bundle） | `4` | `"bundle"` | 有（独立窗口 / 主窗内嵌页面） | 仅首方（必须首方签名） |

两种形态是**两条安装链路**：声明式包由 web 侧解析物化；bundle 由主进程解包、验签、按 `packageSha256` 复核后安装。
第三方**不得**发布 bundle 包——这是安全红线，不是暂缺（见 §6.4）。

> 校验分工：声明式（v5）以 `parsePluginManifestV5` 为唯一权威；bundle（v4）的权威是主进程
> `packages/desktop/plugin-package.js` 的 `validateBundleManifest` / `readPackage`。
> `scripts/plugin-lint.mjs` 对 bundle 复用同一函数（`dev: true` 模式：打包前允许缺 `packageSha256`），
> shared 里的 v5 bundle 字段是契约占位，安装器不采纳。

### 1.2 三个版本号各管什么

| 字段 | 管什么 | 谁读 | 规则 |
|---|---|---|---|
| `schemaVersion` | **清单格式版本**（字段形状） | 解析器 | 声明式包必须 `5`；bundle 必须 `4`。写错直接拒绝 |
| `distribution` | 物化方式（声明 / 可执行 bundle） | 解析器 + 安装器 | bundle 必须显式声明；声明式包省略即为 `manifest` |
| `version` | **插件自身版本**（更新判定、市场版本列表） | 安装/更新/市场 | 自由字符串（≤32 字），建议 semver；**同 id + 同 version 的内容不可变**（§8.3） |
| `engines.heming` | **最低宿主版本**（5 段号，如 `d.117`） | 安装预览 / 市场过滤 | 只支持「最低版本」语义（`>=`）；**不支持 semver range**；缺段按 0 补 |

`engines.heming` 的判定是**失败关闭**：宿主读不到自己的版本、或插件写了非法版本号，一律视为不兼容。

### 1.3 兼容矩阵

| 你的清单 | 旧宿主（≤ d.104） | 现行宿主（≥ d.105） |
|---|---|---|
| v1 / v2 / v3 | 可装 | 可装（归一化成 v5 视图） |
| v4（bundle） | 可装（旧版不验签 = 已知缺口） | 可装；**必须首方签名 + `packageSha256`** |
| v5 | 拒绝（不认识 schemaVersion） | 可装，并按 `engines.heming` 判定 |

### 1.4 演进规则（改标准的人必须遵守）

1. **只加不删**：新增可选字段（顶层或 `meta`/`permissions` 的可选键）属于**向后兼容**，不升 `schemaVersion`。
2. **敏感子对象仍严格**：`engines` / `permissions` / `meta` / 每个贡献条目是 strict，未知键 = **报错**——防止权限写到危险位置被静默忽略。顶层未知键则**剥掉并给 warning**，不阻断安装。
3. **破坏性变更必须新开 `schemaVersion`**，并在一段时间内**双版本并行**（旧解析器继续可读），不得原地改语义。
4. **弃用流程**：单版本标 `status: deprecated`（`statusMessage` ≤500 字）；整插件下架标 `status: removed` + `deprecatedReason` + `alternativeId`（见 §8.4）。
5. **宿主能力可以收紧，不能放宽**：权限模型只允许「运行时收紧」（例如工具风险上限），任何放宽都必须先改本节与安全评审。

---

## 2. 清单接口（Manifest）

### 2.1 顶层字段（v5）

| 字段 | 必填 | 类型 / 限制 | 说明 |
|---|---|---|---|
| `$schema` | 否 | string | 编辑器补全用；**已知字段，不产生警告**，不参与校验 |
| `schemaVersion` | 是 | 字面量 `5` | 格式版本 |
| `id` | 是 | `^[a-z0-9][a-z0-9._-]{0,63}$` | 安装身份；**同 id 再装 = 更新**，换 id = 另一个插件。发布后不得改 |
| `name` | 是 | 1–64 字 | 展示名 |
| `version` | 是 | 1–32 字 | 自身版本；同版本内容不可变 |
| `description` | 否 | 0–200 字，缺省 `""` | 一句话说明 |
| `author` | 否 | 0–64 字，缺省 `""` | 作者/组织 |
| `engines` | 是 | `{ heming: string }`，strict | 最低宿主版本，见 §1.2 |
| `meta` | 否 | 见 2.2，strict | 上架展示元数据（图标/分类/标签/详情…） |
| `permissions` | 否 | 见 §4，strict | 权限声明；含 `mcpServers` 时实际必填（§4.1） |
| `distribution` | 否 | `"manifest" \| "bundle"` | 缺省 `manifest` |
| `contributions` | 是 | 至少一类非空 | 贡献点，见 §3（技能 / 服务 / 命令 / 工具束 / 桌面小组件 / 页面） |
| `publisher` | 否 | `{ id, publicKey }` | 发布者公钥（签名用） |
| `signature` | 否 | `{ alg: "ed25519", value }` | 首方/发布者签名；有签名必须有 publisher |
| `packageSha256` | bundle 必填 | 64 位小写 hex | `files/**` 的确定性内容摘要（§3.6） |

### 2.2 上架元数据 `meta`（全部可选，strict）

| 字段 | 限制 | 说明 |
|---|---|---|
| `icon` | https URL 或 `data:image/(png\|jpeg\|webp\|svg+xml);base64,`，≤48000 字 | 建议 https（`data:` 占本机配额） |
| `homepage` / `repository` | https URL（≤2048，禁账号密码） | 项目地址 |
| `license` | ≤32 字 | 许可证标识 |
| `category` | `^[a-z0-9][a-z0-9-]{0,31}$` | 市场分类 |
| `tags` | ≤8 个，每个 ≤32 字 | 标签 |
| `keywords` | ≤20 个，每个 ≤32 字 | 搜索关键词 |
| `screenshots` | ≤4 张 https URL | 市场截图 |
| `detail` | ≤16384 字 | 详情内联 Markdown；或用包内 `.md` 相对路径 |

### 2.3 限制与严格度分层

- 数量上限（唯一来源 `PLUGIN_LIMITS`）：技能 50、MCP 服务 10、命令 30、工具束 10（每束工具 50）、网络主机 20、
  文件根 5、桌面小组件 1、缩放档 6、设置字段 20、分类标签 8、关键词 20、截图 4。
- 页面（§3.7）：每插件 1 个；`title` ≤40 字、`summary` ≤200 字、`blocks` ≤12 个
  （markdown 正文 ≤4000 字；指标 ≤8 项；表格 ≤6 列 × ≤50 行、单元格 ≤120 字；列表 ≤20 项；动作 ≤6 项）。
- 同一清单内：技能名 / 服务 key / 命令 id / 工具束 id **必须唯一**；工具名**不得跨束重复**（重复会点名两处）。
- 名称类字段会 trim；`description` 这类允许空串的字段写成 `""` 合法。

### 2.4 归一化后的 v5 视图（消费方看到什么）

`parsePluginManifestV5()` 成功后总是返回完整对象（缺省值已补全，消费方不用判空）：

```ts
{
  schemaVersion: 5,
  id, name, version, description, author,
  engines: { heming },
  meta: {},
  distribution: "manifest" | "bundle",
  permissions: {
    network: string[],            // 已规范化（小写、去默认端口）
    tools: "none" | "read" | "write",   // 缺省 "read"
    files: string[],
    events: ("notify"|"lifecycle"|"theme"|"tray")[],
    graphics: ("webgl"|"webgl2"|"wasm")[],
    eval: boolean,                // 缺省 false
    chat: boolean,                // 缺省 false，仅 bundle
  },
  contributions: {
    skills, mcpServers, commands, toolPacks, desktopWidgets,
    page?,   // 只有声明了页面才有：{ kind: "blocks" | "entry", title, icon, summary, … }（§3.7）
  },
  publisher?, signature?, packageSha256?,
}
```

---

## 3. 贡献点接口

### 3.1 准入矩阵（来源 × 贡献点，唯一事实来源 `shared/src/plugin/unit.ts`）

| 贡献点 | 系统 | 内置模块 | 声明式插件 | 界面插件 |
|---|---|---|---|---|
| `skills` | ✅ | ✅ | ✅ | ❌ |
| `mcpServers` | ✅ | ✅ | ✅ | ❌ |
| `commands` | ✅ | ✅ | ✅ | ✅（target 受限） |
| `toolPacks` | ❌ | ❌ | ✅ | ❌ |
| `desktopWidgets` | ❌ | ❌ | ❌ | ✅（首方） |
| `page`（插件页面，每插件 1 个） | ❌ | ✅（模块页，非插件声明） | ✅（声明式 `blocks`） | ✅（`entry` 自带页，仅首方） |
| `hook`（生命周期订阅） | ❌ | ❌ | ❌ | ✅ |
| `homeCard` / `settingsCard` / `backgroundJob` | ❌ | ✅ | ❌ | ❌ |

声明超出准入的贡献点 → **解析期直接拒绝**并给中文原因（不是静默不生效）。

> 术语说明：`hook` 目前唯一的落地形态是界面插件的 `permissions.events: ["lifecycle"]`（§5.5），
> 清单里**没有**独立的 `hook` 字段——不要去找它。

### 3.2 `skills`（技能，≤50）

| 字段 | 必填 | 限制 |
|---|---|---|
| `name` | 是 | 1–32 字；作为物化后的技能名，**同插件内唯一** |
| `instructions` | 是 | 1–8000 字（给模型的正文） |
| `description` | 否 | 0–200 字 |
| `triggers` | 否 | ≤20 个，每个 ≤64 字 |
| `tags` | 否 | ≤20 个，每个 ≤32 字 |

物化：写进技能池（`source: "imported"`、`pluginId`），可分配给智能体；启停插件时同步技能启用位。

### 3.3 `mcpServers`（远程 MCP，≤10）

| 字段 | 必填 | 限制 |
|---|---|---|
| `key` | 是 | `^[a-z0-9][a-z0-9-]{0,31}$`；服务 id 变成 `plugin:<插件 id>:<key>` |
| `name` | 是 | 1–64 字 |
| `url` | 是 | ≤2048；**只 https**；http 仅限 `localhost` / `127.0.0.1` / `[::1]`；禁内嵌账号密码 |
| `description` | 否 | 0–200 字 |

约束：**每个服务的 host 必须被 `permissions.network` 覆盖**，否则解析失败并点名缺失主机。
物化：登记进 MCP 注册表（`origin: "plugin"`），**不自动连接**、工具**默认关闭**，写操作仍走 HITL。

### 3.4 `commands`（命令面板入口，≤30）

| 字段 | 必填 | 限制 |
|---|---|---|
| `id` | 是 | `^[a-z0-9][a-z0-9._-]{0,63}$`，插件内唯一 |
| `title` | 是 | 1–64 字 |
| `description` | 否 | 0–200 字 |
| `keywords` | 否 | ≤20 个，每个 ≤32 字 |
| `target` | 是 | 五种之一，见下 |

| `target.kind` | 字段 | 行为 | bundle 可用 |
|---|---|---|---|
| `page` | `page`（1–64 字） | 跳到页面 | ✅ |
| `skill` | `name`（必须是本插件 `skills` 之一） | 跳技能区并定位 | ❌ |
| `plugin` | — | 打开本插件详情 | ✅ |
| `settings` | `card`（1–64 字） | 跳设置区并定位卡片 | ✅ |
| `unit` | `unitId`（id 规则） | 跳插件区并打开能力单元详情 | ✅ |

### 3.5 `toolPacks`（工具束，≤10）

| 字段 | 必填 | 限制 |
|---|---|---|
| `id` | 是 | id 规则，插件内唯一 |
| `name` | 是 | 1–32 字 |
| `description` | 否 | 0–200 字 |
| `tools` | 是 | ≤50 个，每个 ≤128 字；**跨束不得重名** |

语义：**只声明归属**（这些工具属于哪个能力），不改变工具开关、不授予任何执行权；工具仍由 MCP 提供者产出并受 §4 上限约束。

### 3.6 `desktopWidgets`（桌面小组件，bundle 专用，每包 1 个）

| 字段 | 必填 | 限制 |
|---|---|---|
| `id` | 是 | `^[a-z0-9][a-z0-9-]{0,31}$` |
| `name` | 是 | 1–32 字 |
| `entry` | 是 | 包内相对 `.html` 路径（≤200；禁绝对路径 / `..` / 反斜杠） |
| `width` / `height` | 是 | 96–1024 整数 |
| `scales` | 否 | 1–6 档，每档 0.5–2；另有 `defaultScale` |
| `transparent` / `alwaysOnTop` / `skipTaskbar` / `resizable` | 否 | boolean |
| `clickThrough` | 否 | `"none" \| "auto"` |
| `position` | 否 | `{ anchor, margin(0–200), remember }`；**anchor 目前只支持 `"bottom-right"`**（宿主实现即此值，写别的会明确报错而不是静默当右下） |
| `icon` / `tray` | 否 | `icon` 为包内路径；`tray.items` ⊆ toggle/clickThrough/resetPosition/settings/**scaleUp**/**scaleDown**（≤8，全集以运行时为准） |
| `settings` | 否 | `{ title, fields[≤20] }`；字段类型 boolean/select/text/number/agent，`options` ≤20 |

bundle 额外约束：
- `distribution: "bundle"` 时**只允许** `commands` + `desktopWidgets` + `page`（声明 `skills`/`mcpServers`/`toolPacks` 一律拒绝）。
- 必须提供 `packageSha256`：`files/**` 的**确定性内容摘要**（不是 tgz 自身哈希，避免自引用）。
  算法：按路径排序后对每条 `pathNULlenNULsha256(content)` 再取 sha256。签名的清单因此**间接覆盖全部代码字节**。

### 3.7 `page`（插件页面，每插件 1 个）

装好插件 → 左侧导航**末位**（模块页之后）多一个入口 → 点进去是该插件自己的页面。
`page` 是**对象不是数组**：每插件最多 1 个，页内没有 Tab/子路由。两种形态由 `distribution` 决定且**互斥**。

**A · 声明式页（v5，`distribution: "manifest"`）**：内容写在清单里，宿主渲染受控块，**永不执行代码**。

```json
"contributions": {
  "page": {
    "title": "采集桥",
    "icon": "activity",
    "summary": "本机采集服务状态与用法",
    "blocks": [
      { "type": "markdown", "title": "怎么用", "text": "在设置里填来源，然后点「开始同步」。" },
      { "type": "stats", "items": [{ "label": "已采集", "value": "128 条" }] },
      { "type": "table", "columns": ["来源", "状态"], "rows": [["QQ", "就绪"]] },
      { "type": "list", "items": [{ "title": "开始同步", "description": "调用插件命令", "badge": "命令" }] },
      { "type": "actions", "items": [{ "label": "打开插件区", "target": { "kind": "page", "page": "plugins" } }] },
      { "type": "contributions", "kind": "skills" }
    ]
  }
}
```

| 字段 | 必填 | 限制 / 语义 |
|---|---|---|
| `title` | 是 | 1–40 字；导航项与页面标题共用 |
| `icon` | 否 | 宿主图标词表 id（`^[a-z][a-z0-9-]{0,31}$`）：`activity` / `book` / `calendar` / `chart` / `database` / `file` / `folder` / `globe` / `grid` / `hammer` / `key` / `layers` / `layout` / `link` / `list` / `message` / `package` / `play` / `settings` / `shield` / `terminal`；未知值回落 `package`，不报错 |
| `summary` | 否 | ≤200 字；页面副标题 |
| `blocks` | 是 | 1–12 个；未知 `type` 直接拒绝（严格，**不做静默丢弃**） |

块词表（v1，全部纯文本，宿主转义后渲染）：

| type | 字段 | 限制 | 渲染 |
|---|---|---|---|
| `markdown` | `title?`（≤40）、`text` | `text` ≤4000 字 | 复用聊天消息的 markdown 渲染器（禁原始 HTML） |
| `stats` | `title?`、`items[{label,value}]` | ≤8 项；label / value 各 ≤40 字 | 指标卡横排 |
| `table` | `title?`、`columns[]`、`rows[][]` | 列 ≤6、行 ≤50、单元格 ≤120 字；**每行格数必须等于列数** | 只读表格 |
| `list` | `title?`、`items[{title,description?,badge?}]` | ≤20 项；标题 ≤60 / 描述 ≤160 / badge ≤12 | 列表行 |
| `actions` | `title?`、`items[{label,target}]` | ≤6 项；label ≤24；target 与命令 target 同形（`page` / `plugin` / `settings` / `unit`） | 按钮；只做导航，不执行代码 |
| `contributions` | `title?`、`kind` | `skills` / `mcpServers` / `commands` / `toolPacks` 之一 | 自动列出本插件该类贡献（名称 + 数量），空则一句空态 |

声明式页**不新增权限、不发起网络请求**：宿主不代拉数据，页面只展示清单文本与本地投影（贡献计数、安装信息）。

**B · 自带页（v4，`distribution: "bundle"`）**：包内 HTML 在 `widget://<插件 id>/` 沙箱里渲染，仅首方签名包可装。

| 字段 | 限制 |
|---|---|
| `title` | 1–40 字 |
| `icon` | 同 A 的图标词表 |
| `summary` | ≤200 字 |
| `entry` | 包内相对路径，必须 `.html`、≤200 字符；禁绝对路径 / `..` / 反斜杠 / 协议前缀；**必须出现在 `files` 里** |

共同规则：

- 写 `page` 的包应把 `engines.heming` 提到 `d.124`：`contributions` 是 strict 对象，旧版宿主不认识 `page`，含该字段的清单在旧版会被拒绝安装；**不带 `page` 的旧包不受影响**。
- 仅声明式可写 `blocks`，仅 bundle 可写 `entry`；混写直接拒绝（声明式写 `entry` →「改用 blocks 或 `distribution: "bundle"`」；bundle 写 `blocks` → 拒绝）。
- bundle 允许的贡献 = `commands` + `desktopWidgets` + `page`；仍**不允许** `skills` / `mcpServers` / `toolPacks`。
  `page` 与 `desktopWidgets` 可并存（同一插件既能有浮窗又能有页面），每类最多 1 个。
- 包内页面的代码由 `packageSha256` + 首方签名间接覆盖（§8.3）；声明式页零代码。
- **签名覆盖页面元数据**：`page` 进入首方签名文本（canonical-v1/v2 的 `contributions.page`，含
  `title/icon/summary/entry` 与声明式 `blocks`）——签名后改页面标题/入口/摘要/块内容，验签必失败。
  只在声明 `page` 时才进文本，没有页面的旧包 canonical 字节与历史签名逐字不变。
- 页面**不新增权限**：`permissions` 不变；bundle 页面仍按清单生成 CSP（`connect-src` 跟随 `permissions.network`），
  能调到的宿主能力 = 既有 `__heming_widget` 白名单桥，没有新增 secrets / files / MCP / 会话桥。
- 页面**只能拥有自己**：不能改宿主现有页面/布局/导航顺序、不能注入宿主 DOM、不能给宿主页加卡片（首页卡/设置卡仍不做）。
- 导航口径：宿主 8 页 → 模块页 → 声明式插件页 → bundle 插件页（按首次安装时间升序，插件升级不改位置）；
  不分配快捷键，命令面板不新增「插件页面」跳转组。
- 浏览器版（无桌面桥）**只渲染声明式页**；bundle 页在浏览器里不可用（导航不出现入口；宿主缺少页面视图能力时给「只在安装版可用」的降级说明，不渲染空壳）。

### 3.8 生效判定（谁在什么时候算「生效」）

一个插件的某类贡献「生效」= 已安装 × 插件总开关 × 该贡献级开关；再叠加上兼容性 / 签名 / 依赖单元。
诊断用 `resolveUnit()` 的 `UnitBlockReason` 统一回答「为什么没生效」：
`notInstalled` / `disabled` / `kindDisabled` / `missingRequirement` / `incompatible` / `invalidEngines` /
`signature` / `orphan` / `degraded`。UI 展示文案与这套枚举一一对应，禁止各页面另写判断。

---

## 4. 权限接口（Permissions）

### 4.1 字段与默认值（strict）

| 字段 | 值 | 缺省 | 适用形态 |
|---|---|---|---|
| `network` | host / host:port 数组，≤20 | `[]` | 两者 |
| `tools` | `"none" \| "read" \| "write"` | `"read"` | 声明式（MCP 工具上限） |
| `files` | 包内相对路径数组，≤5（禁绝对路径/盘符/`..`） | `[]` | 两者（当前只校验与展示） |
| `events` | `notify` / `lifecycle` / `theme` / `tray`，≤8 | `[]` | 主要 bundle |
| `chat` | boolean | `false` | 仅 bundle；声明式包写 `true` 直接拒绝 |
| `graphics` | `webgl` / `webgl2` / `wasm`，≤8 | `[]` | bundle |
| `eval` | boolean | `false` | bundle（仅确需 eval 时） |

`network` 规范化：小写、去 http/https 默认端口（`:443`/`:80` 等于不写），非默认端口保留（不同端口是不同服务）；
禁协议、路径、账号密码、通配符。

### 4.2 执行期强制点（声明即约束，不只是展示）

| 声明 | 强制点 | 行为 |
|---|---|---|
| `network` | 解析期 + bundle CSP | MCP host 必须被覆盖否则**装不上**；widget CSP 的 `connect-src` 逐 host 放行（另有精确网关 origin） |
| `tools` | 工具注入点 `lib/plugins/toolCeiling.ts` → `buildToolBridge(toolAllowed)` | 超上限工具**不注入给模型**；写工具仍逐次 HITL。记录缺失按 `none`（失败关闭） |
| `events` | 主进程 `plugin-host.js` 投递前门禁 | 未声明的事件**一律不投递**（`theme`/`tray` 也不再无条件广播） |
| `chat` | `widget:chat-config` IPC + CSP | 未声明时返回空智能体名册与可读原因，CSP 不放行网关 origin；**人设提示词永不下发** |
| `graphics` / `eval` | widget CSP 生成 + 网关放行判定 | 未声明 `eval` 不放 `'unsafe-eval'`；`graphics` 决定「这个 widget 是否算渲染/执行类」从而是否给网关 origin（不是沙箱能力声明）；`frame-src` 恒为 `'none'`（界面插件不得嵌外部页面） |
| `files` | 预留 | 当前只校验与展示，不授予文件工具 |

**红线**：权限只能收紧执行面，**不得放宽 HITL**。任何「声明 write 就免确认」的写法都是错的。

### 4.3 最小权限原则（评审会问的三句）

1. 这个 host 真的每次都要连吗？能只写域名不写端口就不写。
2. `tools` 能不能是 `read`？只读够用就不要 `write`。
3. bundle 的 `eval`/`chat`/`graphics` 每一项都有对应代码路径吗？没有就去掉——**空声明也是声明**，用户会按它判断风险。

---

## 5. 生命周期接口

### 5.1 安装：要么全成，要么全不成

声明式包的安装是一个事务：快照存储 → 写技能/服务 → 读回校验 → 写插件记录 → 失败**逐键回滚**并如实报告
（`ok` / `error` / `rollback.ok`）。用户在安装前看到的是只读预览：差异（技能/服务的新增/变更/不变/移除）、
服务 id 冲突、体积预算、权限与兼容性（声明了页面时贡献行多一项「页面 1」）。**只读预览不写任何存储**。

### 5.2 更新

- 同 `id` 再装 = 更新：技能按**名称**匹配、服务按 **key** 匹配，原地更新并**保留**用户在接口区补的请求头、
  工具启用状态、贡献级停用选择与安装时间。
- **权限扩张必须重新确认**：新版本声明的权限比已装版本更宽时，安装器要求用户再确认一次；拒绝则不更新。
- **防降级**：默认拒绝安装比已装版本更旧的版本（除非显式确认）。
- 签名/摘要不符、包内容与清单不符 → 拒绝，不产生半装状态。
- **页面（§3.7）**：声明式页随清单替换**即时生效**（正停在该页则按新清单重渲染）；bundle 页在 `entry`/`page`
  变化或版本更新时由主进程**销毁旧视图**，下次进入按新包重建（设置与 `data/` 保留）。
  没有 `page` 贡献的纯能力包**不会**新增导航入口（d.122 的口径只对这类旧插件继续成立）。

### 5.3 启停与贡献级停用

- 插件总开关关闭 = 全部贡献不生效：技能退出路由、服务不再连接、命令消失、**页面入口消失**（bundle 页视图立即销毁）；**不删数据**。
- 贡献级停用只关某一类（`skills` / `mcpServers` / `commands` / `toolPacks`），重新打开时**仍尊重贡献级选择**
  （总开关不会偷偷把单独停用的项恢复）。
- 每次启停都是事务：写失败会回滚并明确提示「保存失败」，不会出现「界面停了、重启又回来」。

### 5.4 卸载

- 级联收回本插件物化的技能、MCP 服务、工具清单与工具启用状态，再删插件记录，整笔事务。
- 只删**仍归插件所有**的对象：用户把服务改成手填/转正后视为用户资产，不动。
- 卸载不清理插件贡献之外的业务数据（声明式包本就没有自有数据目录）。
- 有页面的插件：卸载即撤导航入口与路由；若用户正停在该页 → 回主页；bundle 页视图先销毁再删包目录，不留孤儿视图。

### 5.5 界面插件生命周期事件（bundle）

清单声明 `permissions.events` 含 `"lifecycle"` 才会收到；**未声明就收不到任何一条**。

| 事件 | 时机 | 载荷 |
|---|---|---|
| `installed` | 首装完成、首个窗口页面加载完成后 | `{ event, version }` |
| `enabled` / `disabled` | 启停生效后（`disabled` 是窗口销毁前最后一条） | `{ event, version }` |
| `updated` | 版本切换完成、窗口已按新版本重建 | `{ event, version, from }` |
| `uninstalled` | 卸载时（窗口销毁前最后一条） | `{ event, version }` |

边界：事件**不授权**任何能力；**不重放**（宿主重启不补发历史事件，状态请用 `info()`/`settings()` 自检）；
窗口未就绪时最多排队 20 条，超出丢最旧。

---

## 6. 运行时接口（仅界面插件 bundle）

### 6.1 运行环境

| 项 | 事实 |
|---|---|
| origin | `widget://<插件 id>/<path>`：独立 origin，**读不到** `app://heming` 的 localStorage / 会话 / 记忆 |
| 窗口 | 宿主创建：`sandbox + contextIsolation`、**无 nodeIntegration**、挂最小 preload `window.__heming_widget` |
| 持久化 | 独立 origin 下**没有可靠 localStorage**；偏好走 `settings()`，业务数据走 `data*` |
| IPC 鉴权 | `widget:*` 一律按 sender 反查 runtime（fail-closed：查不到就返回 `null`/`false`/`{}`/`[]`）；主窗 `widgets:*` 走独立守卫 |
| CSP | 按清单生成、**不继承主窗**：`script-src 'self' 'wasm-unsafe-eval'`，仅 `eval:true` 再放 `'unsafe-eval'`；`connect-src 'self'` + 本机网关精确 origin（仅 `chat:true`）+ `network` 逐 host；`object-src/base-uri/frame-ancestors/frame-src/form-action` 全 `'none'`；无 `127.0.0.1:*` 回环通配、无 `https:`/`wss:` 通配 |
| 导航闸 | `will-navigate` 只允许本插件 origin；`window.open` 一律 deny |
| 拿不到 | 密钥/`safeStorage`、MCP 桥、文件桥、会话与消息、主窗存储、任意 Node API/`fs`/`child_process`；用户供应商 Key 不出主进程 |
| 窗口几何 | 坐标不上报：拖拽只发「按下/移动/抬起」，位移由主进程按屏幕光标算；插件不能查绝对位置、不能自由缩放（只能按清单档位 ±1） |
| 页面视图 | bundle 的 `page.entry` 在主窗内容区嵌一个 `WebContentsView`：与 widget 同 origin（`widget://`）、同 preload、同 CSP；`rect` 由宿主算并钳制，插件只上报内容区坐标，**页面场景不适用于拖拽/托盘/穿透类通道** |

### 6.2 `window.__heming_widget` API

> 类型定义：`packages/shared/src/plugin/widget.ts` 的 `HemingWidgetApi`（27 个方法，方法名与 preload
> 由 `widget.test.ts` 严格比对：preload 多一个/少一个方法都会红）。
> 「可能不存在」的探测写法见 §6.2.2。

方法分组：

- **窗口动作**：`state()` / `show()` / `hide()` / `toggle()` / `setScale()` / `setClickThrough()` / `setInteractive()` /
  `dragStart()` / `dragMove()` / `dragEnd()` / `resetPosition()` / `reload()`
- **宿主信息**：`info()` / `log(line)`
- **设置**：`settings()` / `setSetting(key, value)` / `onSettings(cb)`
- **插件数据**：`dataGet` / `dataSet` / `dataDelete` / `dataKeys` / `dataDir`
- **事件**：`onEvent(cb)`（notify/theme/tray，按 `permissions.events` 门禁）/ `onLifecycle(cb)`（§5.5）
- **跳转与聊天**：`openSettings()` / `openPage(page)` / `chatConfig()`（仅 `chat: true`）

#### 6.2.1 方法表

| 方法 | 参数 | 返回 | 说明 / 边界 |
|---|---|---|---|
| `state()` | — | `Promise<WidgetState>` | 读运行态 `{ visible, scale, clickThrough }`；状态由主进程持有，插件只读，不含坐标尺寸 |
| `show()` | — | `Promise<WidgetState>` | 显示自己并返回显示后状态（`showInactive`，不抢焦点） |
| `hide()` | — | `void` | 隐藏自己（宿主暂停渲染并落盘） |
| `toggle()` | — | `void` | 可见就隐藏、否则显示 |
| `setScale(dir)` | `1 \| -1 \| { dir }` | `Promise<{ scale }>` | 按清单 `scales[]` 相对切一档；到顶/到底不循环 |
| `setClickThrough(on)` | `boolean` | `Promise<boolean>` | 仅清单 `clickThrough: "auto"` 生效（`none` 调用无效果，返回 `false`） |
| `setInteractive(on)` | `boolean` | `void` | 上报光标是否在可交互区（与 `clickThrough:"auto"` 配套）；拖拽期被忽略 |
| `dragStart()` / `dragMove()` / `dragEnd()` | — | `void` | 拖拽三段；**只发信号**，位移由主进程按屏幕光标算；高频，按 rAF 合并 |
| `resetPosition()` | — | `void` | 回到默认落位（主屏工作区右下 + `position.margin`） |
| `reload()` | — | `void` | 重载插件页（调试用；生命周期事件不重放） |
| `info()` | — | `Promise<WidgetHostInfo>` | **只有** `{ pluginId, pluginName, appVersion, theme }` 四个字段 |
| `log(line)` | `string` | `void` | 写宿主日志（加 `[widgets:<id>]` 前缀、截断 500 字）；别打印密钥 |
| `settings()` | — | `Promise<WidgetSettings>` | 本插件设置全量（只含清单声明字段，默认值已补全） |
| `setSetting(key, value)` | `string, unknown` | `Promise<WidgetSettings>` | 写一项并返回合并后全量；**未声明 key 静默忽略、坏值按类型强制**，只能比对返回值判断是否生效 |
| `onSettings(cb)` | `(settings) => void` | `() => void` | 订阅设置变更（载荷为全量），返回取消订阅 |
| `dataGet(key)` | `string` | `Promise<unknown \| null>` | 不存在/坏 JSON → `null`（不 reject）；非法 key reject |
| `dataSet(key, value)` | `string, unknown` | `Promise<{ key, bytes }>` | 原子写（tmp+rename）；JSON only、单文件 ≤1MB、失败 reject 不截断；`bytes` 按 `JSON.stringify(v,null,2)+"\n"` 的 UTF-8 字节算 |
| `dataDelete(key)` | `string` | `Promise<boolean>` | 是否真的删掉（不存在 = `false`，不算错误） |
| `dataKeys()` | — | `Promise<string[]>` | 已有 key（只含 `*.json`、已排序、忽略临时文件） |
| `dataDir()` | — | `Promise<{ dir }>` | 数据目录绝对路径（按需创建；别展示给终端用户） |
| `onEvent(cb)` | `(e: WidgetEvent) => void` | `() => void` | notify/theme/tray，按 `permissions.events` 门禁；notify 在主窗前台被抑制、窗口隐藏时丢弃、不补发 |
| `onLifecycle(cb)` | `(e: WidgetLifecycleEvent) => void` | `() => void` | 生命周期事件（§5.5）；不重放、不授权 |
| `openSettings()` | — | `void` | 打开设置区本插件卡片（主窗最小化会先恢复并聚焦） |
| `openPage(page)` | `WidgetPage` | `void` | 跳白名单页面（`settings / team / tasks / staff / infohub`）；白名单外静默丢弃并记日志 |
| `chatConfig()` | — | `Promise<WidgetChatConfig>` | 仅 `permissions.chat: true` 返回网关 origin 与智能体 `{id,name}`；否则 `gateway:null`、`agents:[]` + `reason`；**人设 prompt 与用户 Key 永不下发** |

#### 6.2.2 旧宿主兼容

`data*`、`onLifecycle`、`chatConfig` 是后加的方法。插件应探测能力而不是假定存在：

```js
const bridge = window.__heming_widget;
const data = typeof bridge?.dataGet === "function" ? bridge : null;
const value = data ? await data.dataGet("cache") : loadFromMemory();
```

缺方法时按「不可用」降级（`null` / `false` / `[]`），**不要白屏**。

### 6.3 插件数据目录 `data/`

```
<userData>/plugins/<pluginId>/data/<key>.json
```

- key 规则：`[A-Za-z0-9._-]{1,64}`，禁 `..` 与路径分隔符；非法 key 直接 reject，不做路径归一化。
- JSON only（`JSON.stringify` 能表示的值）；单文件 **1MB** 上限，超限 reject 并报字节数（不截断）。
- 升级保留（只替换 `<version>/`）；卸载即删；未安装的 id 不允许写入。
- **不要存密钥**（明文文件）；用户可见可回滚的偏好走 `settings()`。

### 6.4 界面插件红线（为什么第三方不能发布 bundle）

「装插件 = 在本机运行代码」，所以 bundle 只对**首方签名**开放：签名覆盖清单（含 `packageSha256`）→ 间接覆盖
全部代码字节；正式版**忽略所有 `dev-*` 公钥**。第三方若需要界面，正确路径是：先把能力做成声明式包
（技能/命令/MCP + **声明式页面 `blocks`**，零代码），确有可执行界面需求时另立「沙箱 + 权限 + 独立规格」，
不得绕过签名安装。

---

## 7. 校验、诊断与错误口径

### 7.1 三个校验入口，一套规则

| 入口 | 用途 | 是否权威 |
|---|---|---|
| `parsePluginManifestV5()`（shared） | 唯一权威解析 | ✅ |
| `node scripts/plugin-lint.mjs <file\|dir>` | 作者本地 / CI 离线校验，中文 + 字段路径 | ✅（同一函数） |
| 应用内「安装 → 预览」 | 用户装之前的差异/冲突/权限/兼容性预览 | ✅（同一函数） |

`plugin-kit/plugin.schema.json` **只做编辑器补全**：zod 的 JSON Schema 不表达跨字段规则（bundle 组合、host 覆盖、
工具名跨束唯一…），不要把「编辑器不报错」当成「能装」。

### 7.2 错误文案约定

- 一律中文、带字段路径（如 `contributions.mcpServers[0].url：只支持 https…`）。
- 解析错误直接给**可执行的修法**（缺什么、写成什么、去哪看文档），不输出 zod 原始英文。
- 非阻断问题走 `warnings`（如顶层未知字段），安装照常；阻断问题抛错，绝不静默忽略权限类笔误。

### 7.3 装完不生效怎么查

插件详情 →「诊断」会给出原因枚举（§3.8）与可执行建议（去技能区/去接口区/更新和鸣/修记录）。
插件页还有「健康检查 / 修复记录」（损坏记录、技能或服务对不上、权限不兼容、孤儿记录）。

---

## 8. 分发接口

### 8.1 目录布局（服务端 `HEMING_PLUGIN_DIR`）

```
<dir>/<插件 id>/<版本>/plugin.json     # 原样字节；一个 id 可有多版
```

bundle 包额外有 `package.tgz`（确定性 tar+gzip），由 `GET /api/plugins/:id/:version/package` 分发。

### 8.2 接口

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/plugins` | 公开 | 每个 id 的最新版摘要 |
| GET | `/api/plugins/:id` | 公开 | 该 id 的全部版本 |
| GET | `/api/plugins/:id/:version/manifest` | 公开 | 原样清单字节 + `X-Plugin-Sha256` |
| PUT | `/api/plugins/:id/:version` | `x-publish-key` | 发布/覆盖（同版本不可变，冲突 409） |
| DELETE | `/api/plugins/:id/:version` | `x-publish-key` | 下线某版本 |

市场索引 v2（`shared/src/plugin/market.ts`）另带 `hostVersion` 过滤与版本三态（active/deprecated/removed）。

### 8.3 不可变与签名

- **同一 id + 同一 version 的内容不可变**：服务端 409；要改就升 `version`。
- 签名（可选，首方必备）：`ed25519`，覆盖清单的规范化文本；`publisher.publicKey` 是 base64url 的 32 字节 raw key。
- bundle 必带 `packageSha256`，安装端解包后重算比对，只换包内 JS 的「借壳包」会被拒。

### 8.4 弃用与下架

- 单版本问题：该版本 `status: "deprecated"` + `statusMessage`（≤500 字），客户端默认不推送该版本更新。
- 整插件下架：索引里 `status: "removed"` + `deprecatedReason` + `alternativeId`（若有替代品）。
- 已安装用户不会被强制卸载；更新检查会给出替代建议。

---

## 9. 附录

### A. 最小合法清单（声明式）

```json
{
  "schemaVersion": 5,
  "id": "acme.hello",
  "name": "问候工具",
  "version": "1.0.0",
  "engines": { "heming": "d.117" },
  "contributions": {
    "skills": [
      {
        "name": "写问候",
        "instructions": "先问清对象与场合，再给 1–3 条候选。",
        "triggers": ["问候"]
      }
    ]
  }
}
```

### B. 完整声明式示例（技能 + MCP + 命令 + 工具束）

见 `plugin-kit/plugins/infohub-collector/plugin.json`（本机 MCP 服务）与 [`plugin-kit/examples/02-mcp-and-commands/`](examples/02-mcp-and-commands/)（技能 + MCP + 命令 + 工具束）。

页面：声明式见 [`plugin-kit/examples/05-plugin-page/`](examples/05-plugin-page/)；界面插件自带页的清单格式见
[`plugin-kit/examples/04-widget-bundle/`](examples/04-widget-bundle/)（把 `desktopWidgets` 换成 `page.entry`）。

### C. 字段速查

- 必填：`schemaVersion` / `id` / `name` / `version` / `engines` / `contributions`（至少一类非空）。
- 含 `mcpServers` 时：`permissions.network` 必须覆盖每个服务 host。
- bundle：`schemaVersion: 4` + `distribution: "bundle"` + `packageSha256` + 仅 `commands`/`desktopWidgets`/`page`。
- 页面（§3.7）：声明式写 `blocks`（1–12 个，零代码），bundle 写 `entry`（包内 `.html`，须在 `files` 里）；混写直接拒绝。
- 上限：见 §2.3。
- 严格度：顶层多余键 = warning；敏感子对象多余键 = 错误。

### D. 评审检查清单（改标准 / 收插件包时逐条过）

1. 清单能通过 `node scripts/plugin-lint.mjs <file>`，无 error；warning 都被解释过。
2. 权限最小化：`network` 无冗余、`tools` 不高于实际需要、bundle 的 `eval`/`chat`/`graphics` 都有代码路径。
3. 命令 target 指向的东西真实存在（技能名 / 页面 id / 设置卡 id / 单元 id）。
4. 版本策略：内容变了就升 `version`；破坏性变更新开 `schemaVersion` 并保留旧包可装。
5. `engines.heming` 只写「真正需要的最低版本」，不写近似当前版本。
6. 文档：README 说清「装了什么、要什么权限、数据放哪」；市场 `meta` 无 `data:` 大图。
7. bundle：首方签名 + `packageSha256` + 事件/数据/设置的权限声明与代码一致。
8. 页面：声明式页每块都在词表内且不超限；bundle 页的 `entry` 在 `files` 里、能在沙箱里加载；页面没有改宿主界面的企图（不允许）。
