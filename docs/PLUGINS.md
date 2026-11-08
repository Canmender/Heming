# 插件（能力包）编写与安装

插件是**纯声明式能力包**：一个 `plugin.json` 声明「这个包带来哪些能力」，和鸣负责把它物化到现有系统里。插件不执行第三方代码，也不从网络下载可执行物——技能变成技能池里的技能，MCP 服务登记进接口区，命令出现在命令面板。

> **唯一的例外是界面插件（§10，d.98）**：它带一个独立窗口的可执行渲染包，清单用 `schemaVersion: 4` + `distribution: "bundle"`，
> 只允许官方目录发布、用户在插件区二次确认后安装。第三方仍只能是纯声明式包。
>
> 版本口径：纯声明式清单现行 `schemaVersion: 5`（v1–v3 旧包归一化后可装；**v5 见 §11**：最低宿主版本 `engines` + 上架元数据 `meta`，v5 是新增不是替换）；d.88 短暂引入的 v4（模型预设）已在 d.90 收回——
> 模型统一由 magpie 网关提供，插件不再声明模型连接。**v4 现在的唯一用途是界面插件**（`distribution: "bundle"`，且必须首方签名）。
>
> 仓库自带的示例插件包（**不随安装包分发**，由云端插件目录发布、用户自行下载安装）：
> `plugins/infohub-collector/`：把本机 InfoHub 采集桥声明成本机 MCP 服务 + 技能 + 命令。
>
> 分发链路：`node scripts/publish-plugin.mjs` 把包摆成服务端目录布局 → 服务端 `GET /api/plugins`
> 列出目录 → 客户端「插件区 → 安装插件 → 从云端浏览」下载原文、**校验 sha256** 后走同一套安装预览。
> 界面插件多一步：服务端 `GET /api/plugins/:id/:version/package` 分发 `package.tgz`，客户端比 sha256 后交主进程解包安装。

## 1. 最小清单

```json
{
  "schemaVersion": 3,
  "id": "acme.report-kit",
  "name": "报告工具箱",
  "version": "1.0.0",
  "description": "周报与数据源",
  "author": "ACME",
  "contributions": {
    "skills": [
      {
        "name": "周报",
        "description": "按本周数据生成周报大纲",
        "instructions": "先汇总本周任务与日程，再输出：进展、风险、下周计划。",
        "triggers": ["周报"],
        "tags": ["汇报"]
      }
    ]
  }
}
```

只有技能时 `permissions` 可以省略。安装入口：插件区 → 安装 → 粘贴/导入 `plugin.json`。

## 2. 清单字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `schemaVersion` | 是 | 现行 `5`（v5 见 §11）；`3` 仍可装，`1`/`2` 为旧格式、解析时归一化 |
| `id` | 是 | 小写字母/数字开头，允许 `.`/`_`/`-`，≤64；安装后不可改（视为另一个插件） |
| `name` / `version` / `description` / `author` | `name`/`version` 必填 | 展示用；`version` 变化会走「更新」而不是新增 |
| `permissions` | 含 MCP 时必填 | 见 §3 |
| `contributions.skills` | 至少一类贡献非空 | 技能，≤50；字段与技能池一致（`name` ≤32、`instructions` ≤8000、`triggers` ≤20、`tags` ≤20） |
| `contributions.mcpServers` | 可选 | 远程 MCP（仅 https；http 只允许 localhost/127.0.0.1/[::1]），≤10；`key` 小写字母数字连字符 ≤32 |
| `contributions.commands` | 可选 | 插件命令，≤30；见 §4 |
| `contributions.toolPacks` | 可选 | 工具束，≤10（只声明归属，不改开关）；见 §8 |

## 3. 权限：声明即约束

```json
"permissions": {
  "network": ["api.acme.com", "localhost:3000"],
  "tools": "read",
  "files": ["notes"]
}
```

- **`network`**：`mcpServers` 实际会访问的主机白名单（host 或 host:port，≤20）。清单里每个服务的 host **必须**被覆盖，否则解析直接失败并报出缺失的 host——这是「安装即确认」的依据，不做「尽量放行」。比对前两侧都会规范化：小写，并去掉 http/https 的默认端口（`api.acme.com:443` 与 `api.acme.com` 等价；`:8443`/`:8787` 这类非默认端口照旧区分）。
- **`tools`**：`"none" | "read" | "write"`，缺省 `"read"`。它是本插件 MCP 工具的风险上限：超过上限的工具**不注入**给模型——**执行期**在工具桥注入点过滤（不只是插件页「未注入」的展示），插件页工具目录里会以「插件声明 read，未注入」标注。这是收紧，**不会放宽 HITL**——`write` 上限意味着写工具仍会按 HITL 逐次确认。
- **`files`**：预留字段（≤5 个相对路径）。当前版本只校验与展示，和鸣插件尚不能携带文件工具。

安装弹窗会完整展示以上权限与贡献计数；用户点「安装」等于确认这份清单。

## 4. 命令

```json
{
  "id": "weekly-report",
  "title": "生成周报",
  "description": "打开周报技能",
  "keywords": ["周报", "weekly"],
  "target": { "kind": "skill", "name": "周报" }
}
```

`target` 三种：

| kind | 字段 | 行为 |
|---|---|---|
| `page` | `page` | 跳到页面（页面 id 见命令面板页面目录） |
| `skill` | `name` | 跳到技能区并定位到该技能（必须是本插件 `skills` 里的名字） |
| `plugin` | — | 打开本插件详情 |

命令在命令面板的「插件命令」分组里出现；插件停用/卸载后命令立即消失。

## 5. 生命周期与数据

- **安装**：技能写入技能池（标记插件来源）、服务登记进接口区（标记插件来源）、命令进面板。数据只在本机（`heming.plugins.v1` + 技能池/MCP 注册表既有键），不上传。
- **查找**：插件区支持按名称 / id / 作者 / 描述 / 技能名 / 服务名搜索，并按「全部 / 已启用 / 已停用」筛选；装完自动回到插件列表并高亮新装的卡片。
- **云端安装**：安装弹窗「从云端浏览」列出服务端插件目录（版本/权限/贡献/指纹），点「载入清单」下载并**校验 sha256** 后填进同一个清单框——安装预览、信任确认、写入语义与手动粘贴完全一致；目录不可用时只影响该面板。
- **更新**：同 `id` 再次安装 = 更新；弹窗会展示技能/服务的增删改差异与服务 id 冲突。
- **停用**：技能与服务保留记录但不生效，命令消失；重新启用即恢复。
- **卸载**：级联收回本插件物化的技能与服务；用户手工改过的技能/服务不会被误删（按归属判断）。

## 6. 兼容与红线

- v1（仅技能）与 v2（技能 + MCP）旧包继续可安装：归一化后 `permissions.network` = 其服务 host 全集、`tools = "read"`，等于「安装时已确认的既有事实」，不回溯拦截。
- 插件**不执行代码**、不支持 stdio/命令类 MCP；插件包可由**云端插件目录**分发（只下载声明式清单并校验指纹），
  但不支持「URL 直接安装」或随包携带脚本；本地进程类集成仍走接口区手动配置或 Registry 安装。
- 插件包**不随安装包分发**：`plugins/` 目录只在仓库里维护，由 `scripts/publish-plugin.mjs` 发布到服务端目录
  （`HEMING_PLUGIN_DIR`，部署时同步到服务器）。
- 模型接入不由插件声明：d.90 起模型统一来自本机 magpie 网关（见 README「智能体对话」与
  `docs/superpowers/specs/2026-11-07-d90-magpie-native-model-layer.md`）。
- 报错一律中文并给出字段路径（如 `contributions.mcpServers[0].url`），坏包直接拒绝安装，不进入「半可用」状态。

## 7. 示例（仓库自带）

完整可粘贴示例（技能 + 本地 MCP + 两条命令 + 权限）：

```json
{
  "schemaVersion": 3,
  "id": "demo.report-kit",
  "name": "报告工具箱",
  "version": "1.0.0",
  "description": "示例插件：技能 + MCP + 命令",
  "author": "和鸣",
  "permissions": { "network": ["localhost:3999"], "tools": "read", "files": [] },
  "contributions": {
    "skills": [
      { "name": "周报", "description": "周报大纲", "instructions": "汇总本周任务与日程，输出进展/风险/下周计划。", "triggers": ["周报"], "tags": ["汇报"] }
    ],
    "mcpServers": [
      { "key": "report", "name": "报告服务", "url": "http://localhost:3999/mcp", "description": "本地自检服务" }
    ],
    "commands": [
      { "id": "weekly-report", "title": "生成周报", "description": "打开周报技能", "keywords": ["周报"], "target": { "kind": "skill", "name": "周报" } }
    ]
  }
}
```

## 8. 系统插件与工具束（d.63 起）

### 系统插件 `heming.core`

应用内置的技能、预置 MCP 服务与内置工具，在插件页里以一个**只读系统插件**「系统能力」出现（置顶、不可停用/卸载、不占插件数量上限）。它不是真实安装包，也不写本机插件存储：**只做归属展示**，不改变技能路由、服务连接与工具开关。

- 内置技能（`source: builtin`）、预置 MCP 服务（`isPreset`）、内置工具（目录里归属 `system`）都算它的贡献；
- 技能区/接口区里，这类能力的来源标为「内置：系统能力」（来源=内置、归属=系统插件）；插件带来的标「插件：<名>」。

### 工具束 `contributions.toolPacks`

插件可以声明「我用哪些已有工具」，用于归属与分组（**只声明，不改执行**）：

```json
"contributions": {
  "toolPacks": [
    { "id": "report-tools", "name": "报告工具", "description": "周报要用的查询/导出工具", "tools": ["report_query", "report_export"] }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `id` | 同命令 id 规则（小写字母/数字开头，允许 `.`/`_`/`-`，≤64） |
| `name` / `description` | 展示用（≤32 / ≤200） |
| `tools[]` | **已有工具的精确名字**（≤50，与工具目录里的 `name` 一致），跨工具束不得重复 |

语义边界：

- 工具束不会自动打开任何工具开关（MCP 工具默认关闭的规则不变），也不会让工具绕过人工确认；只是让插件页知道「这个工具属于哪个插件的哪一束」。
- 引用了当前还没连接/不存在的工具**不报错**，在插件页显示为「未连接/未提供」，等 MCP 连上后自动归位。
- 工具束里的工具仍受 `permissions.tools` 风险上限约束：超过上限的工具照旧不注入。
- 一个插件只声明工具束、不声明技能/MCP 也是合法的 v3 清单（清单 v3 对此**向后兼容**，旧应用会忽略该字段，不会坏）。

## 9. 云端插件仓库（d.95）

安装包**不内置**任何第三方插件；官网/服务端只维护**一份**插件仓库，客户端在「插件区 → 仓库」
里浏览、下载、安装。仓库是静态目录，服务端只做「列目录 + 原样分发清单」，不执行插件代码。

### 目录布局（服务端 `HEMING_PLUGIN_DIR`）

```
<dir>/<插件 id>/<版本>/plugin.json          # 原样字节，一个 id 可有多版
```

缺省 `<cwd>/plugins-catalog`；部署时把发布产物同步到这个目录，或用环境变量指定。

### 接口（公开读 / 密钥写）

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/plugins` | 公开 | 每个 id 的**最新版**：名称/版本/schemaVersion/描述/作者/sha256/权限/贡献计数 |
| GET | `/api/plugins/:id` | 公开 | 该 id 的**全部版本**（新→旧，含各自 sha256），用于更新记录/回滚参考 |
| GET | `/api/plugins/:id/:version/manifest` | 公开 | 原样 `plugin.json` 字节；响应头 `X-Plugin-Sha256` 供客户端校验 |
| PUT | `/api/plugins/:id/:version` | `x-publish-key` | 发布/覆盖一个版本：body 是 plugin.json 全文，路径 id/版本必须与清单一致；首次 201、覆盖 200 |
| DELETE | `/api/plugins/:id/:version` | `x-publish-key` | 下线某个版本（运维/CI） |

- 写接口只在配置了 `HEMING_PLUGIN_PUBLISH_KEY` 时开启，否则一律 503；密钥不对 401；
- 服务端不解析权限、不执行代码；权限/签名/安装校验仍由客户端在下载后做（sha256 不符就不装）；
- 目录接口是公开产物，不含用户数据；客户端「插件区 → 仓库」与安装弹窗里的「从云端浏览」
  走同一批接口，安装预览/信任确认/写入语义完全一致。

### 发布

```bash
# 1) 写本地发布目录（沿用「同步目录到服务器」的部署链）
node scripts/publish-plugin.mjs plugins/infohub-collector/plugin.json --dest /opt/heming/plugins

# 2) 或直接推到云端仓库（CI 用；需服务端已配置发布密钥）
HEMING_PLUGIN_PUBLISH_KEY=**** node scripts/publish-plugin.mjs plugins/ --push https://heming.example.com
```

两种方式都会先做「能不能解析 / id 与版本是否合规 / schemaVersion 是否是整数 / 有没有名字」的基础校验，
坏包不静默跳过（退出码非 0）。

## 10. 界面插件（v4 · `distribution: "bundle"`，d.98）

界面插件是**唯一带可执行内容**的插件：它提供一个独立窗口的渲染包（第一个也是当前唯一一个：桌宠 `heming.pet`，见 `docs/PET.md`）。
因为「装插件 = 在本机运行代码」，它与纯声明式包走两套清单字段、两套安装链路，**只有官方目录发布的包才允许安装**（第三方仍只能是 §1–§8 的声明式包）。

### 9.1 清单

```jsonc
{
  "schemaVersion": 4,                 // 必须是 4；v1/2/3 客户端会明确拒绝带 desktopWidgets 的包
  "id": "heming.pet",
  "name": "桌宠",
  "version": "1.0.0",
  "distribution": "bundle",           // 缺省 manifest = 旧语义（纯声明式）
  "permissions": {
    "network": [],                    // 逐 host，仍需 ≤20
    "tools": "none",
    "files": [],
    "events": ["notify"],             // 可接收主窗脱敏后转发的事件
    "graphics": ["webgl", "wasm"],    // 渲染能力声明
    "eval": false                     // true 只在渲染层确实需要 eval 时（pixi 6 的 shader 生成）
  },
  "contributions": {
    "desktopWidgets": [{
      "id": "pet",
      "name": "桌宠",
      "entry": "files/index.html",
      "width": 300, "height": 420,
      "scales": [0.6, 0.8, 1, 1.25, 1.5],
      "transparent": true, "alwaysOnTop": true, "skipTaskbar": true,
      "clickThrough": "auto",
      "position": { "anchor": "bottom-right", "margin": 24, "remember": true },
      "tray": { "icon": "files/tray.png", "items": ["toggle", "clickThrough", "resetPosition", "settings"] },
      "settings": { "title": "桌宠", "fields": [
        { "key": "agentId", "type": "agent", "label": "对话绑定智能体" },
        { "key": "modelPath", "type": "text", "label": "Live2D 模型路径" }
      ]}
    }],
    "commands": []
  }
}
```

约束：

- `distribution: "bundle"` 的包**只允许** `desktopWidgets`（可选 `commands`）；声明 `skills` / `mcpServers` / `toolPacks` 一律拒绝。
- `desktopWidgets` 本轮 **≤1 个**，字段校验见 `docs/superpowers/specs/2026-11-07-d98-pet-as-plugin.md` §2.3。
- 字段类型只支持 `boolean` / `select` / `text` / `number` / `agent`；值由**主进程**持有（`userData/plugins/<id>/settings.json`），
  渲染层经 IPC 读写、插件窗口经 preload 读，**不写 localStorage**。

### 9.2 包格式（`package.tgz`）

```
package.tgz
├── plugin.json
└── files/**
    ├── index.html        ← entry
    ├── assets/*.js|css
    └── …                 ← 模型等资源
```

- tar + gzip(9)，**确定性输出**（固定 mtime/uid/gid/路径排序）：同一份内容在任何机器上得到同一个 sha256。
- 安装校验（主进程）：sha256 → gzip/tar 解析 → 配额（解包 ≤20MB、≤2000 文件、单文件 ≤8MB）→ 禁绝对路径 / `..` /
  符号链接 / 硬链接 / NUL → `plugin.json` 在包根 → `entry` 存在且在包内 → 原子切换 `current.json`。
  任一步失败都不产生「半装可用」状态。

### 9.3 运行时边界

- origin：`widget://<pluginId>/<path>`（独立 origin，**读不到** `app://heming` 的 localStorage / 会话 / 记忆）。
- 窗口：宿主创建，`sandbox + contextIsolation`、无 nodeIntegration，挂**最小 preload** `__heming_widget`
  （窗口动作 / 宿主信息 / 设置 / 事件 / 页面跳转 / `chatConfig`；不含 secrets、MCP、文件、会话任何桥）。
- `widget:*` IPC 一律按 sender 自校验（只认该 widget 自己的窗口）；主窗 `widgets:*` 通道走 `secureIpc` 只认主窗。
- CSP：按清单生成（`script-src` 仅在 `permissions.eval:true` 时放开 `'unsafe-eval'`；`connect-src` 只给本机回环 + 清单 `network`，
  **不继承**主窗的 `https:`/`wss:` 通配）。
- 数据：插件不得写会话 / 消息列表 / msgCache；对话不落盘。

### 9.4 发布

```bash
node scripts/build-pet-widget.mjs          # 构建插件 → packages/pet-widget/dist/package/
node scripts/publish-plugin.mjs packages/pet-widget/dist/package --dest <plugin-dir>
# 把 <plugin-dir> 同步到服务器的 HEMING_PLUGIN_DIR，客户端「插件区 → 桌面小组件」即可看到
```

## 11. 清单 v5：版本兼容、上架元数据与安装事务（d.106）

v5 相对 v3/v4 只加两件事：**最低宿主版本**（`engines.heming`）与**上架元数据**（`meta`）。
但它同时把三件长期缺失的工程语义补齐了：安装前拦截不兼容、安装要么全成要么全不成、失败能回滚。

### 11.1 清单增量

```jsonc
{
  "schemaVersion": 5,
  "id": "acme.report-kit",
  "name": "报告工具箱",
  "version": "1.2.0",
  "description": "周报与数据源",
  "author": "ACME",
  "engines": { "heming": "d.106" },           // 必填：最低宿主版本（只支持最小版本语义）
  "meta": {                                    // 可选：市场页展示
    "icon": "https://cdn.acme.com/icon.png",   // https，或 ≤8KB 的 data:image/*;base64
    "homepage": "https://acme.com/report-kit",
    "repository": "https://github.com/acme/report-kit",
    "license": "MIT",
    "category": "efficiency",                  // 引用目录声明的分类 id
    "tags": ["official"],                      // ≤8
    "keywords": ["周报", "报告"],               // ≤20，搜索加权
    "screenshots": ["https://cdn.acme.com/s1.png"], // ≤4
    "detail": "report-kit.md"                  // 内联 markdown（≤16KB）或包内相对 .md 路径
  },
  "permissions": { "network": ["api.acme.com"], "tools": "read", "files": [] },
  "contributions": { "skills": [], "mcpServers": [], "commands": [] }
}
```

| 字段 | 规则 |
|---|---|
| `engines.heming` | 必填；`d.<特性>.<破坏性>.<修订>.<构建>`（缺段按 0 补，容忍 `-dev.N`）。**只支持最小版本**（`actual >= required`），不支持 semver range |
| `meta.icon` | https URL 或 `data:image/(png|jpeg|webp|svg+xml);base64`；**安装记录只留轻字段**，大图不进 localStorage |
| `meta.category` / `meta.tags` | 引用目录声明；未知值只告警不拒绝 |
| `meta.detail` | 内联 ≤16KB，或包内相对 `.md` 路径（禁绝对路径/`..`） |
| 未知字段 | **顶层剥掉 + 警告**；`engines`/`permissions`/`meta`/每个贡献条目**strict，未知键=不装**（防权限写错位置被静默忽略） |
| 命名 | `heming` / `heming.*` / `heming-*` 保留；声明式包使用即拒绝，bundle 必须首方签名 |

v5 的权威校验器在 `packages/shared/src/plugin/manifest.ts`（web 安装预览、服务端索引、CLI 三处共用）。
本地校验：

```bash
node scripts/plugin-lint.mjs plugins/acme-report/plugin.json   # 中文报错 + 字段路径
node scripts/plugin-lint.mjs --dir plugins                     # 批量
node scripts/plugin-schema.mjs --check                         # 校验 docs/plugin.schema.json 是否最新（CI）
```

### 11.2 安装事务：要么全成、要么全不成

安装/更新/回滚统一走 **`prepare → persist → rollback`**（学 Dify 的 `PreparePackage → PersistPackage → RollbackPackage`）：

1. **prepare**：解析校验、冲突检查、`engines` 判定、权限扩张检测、**写入体积预估**（超阈值直接拒绝并给「先清理什么」，不进入写阶段）；
2. **persist**：按计划写技能池 / MCP 注册表 / 插件记录（先依赖方后被依赖方）；
3. **rollback**：任一步失败 → 恢复受影响键的快照 + **重载三个内存单例**（技能池 / MCP 注册表 / 插件 store），并如实报告 `rollback.ok=false`（配额/隐私模式下恢复也可能失败，不谎报成功）。

结果语义：

| 字段 | 含义 |
|---|---|
| `changed` | 存储是否真的变了（幂等 apply 为 false） |
| `applied` | 是否生效（`applied` / `failed`） |
| `warnings` | 非阻断问题（未知顶层字段、未标注兼容性…） |
| `diagnostics` | 为什么没生效（停用/依赖缺失/超权限未注入/不兼容/半装风险） |

### 11.3 更新、权限扩张与回滚

- **权限扩张必须重新确认**：更新若新增 `permissions.network` 主机、把 `tools` 从 `read` 放宽到 `write`、或新增贡献类别 → 预览进入「重新确认」；拒绝则保留旧版（不允许静默提权）。
- **防降级**：记录每个插件 `highestVersion`；安装更旧版本需显式「降级安装」确认（防被诱导装回有漏洞的旧版）。
- **回滚到上一版**：更新时保留 `previous` 清单（单插件 ≤128KB、全量 ≤512KB，超限如实标注「未保留上一版」），详情页可一键回滚；回滚不联网、只用本机清单。
- **不兼容不静默失效**：应用升级后已装插件若不满足 `engines`，进入「不兼容」状态并禁用其贡献，详情页写明「需要和鸣 d.X / 当前 d.Y」。

### 11.4 兼容矩阵

| 清单 | 旧版和鸣 | 新版和鸣 |
|---|---|---|
| v1 / v2 / v3 | 可装 | 可装（归一化到 v5 视图，`engines` 视为 `d.0`） |
| v4（界面插件） | 可装（**不验签**，已知缺口） | 可装，**必须首方签名** |
| v5 | 拒绝（schemaVersion 不认识） | 可装，按 `engines.heming` 判定 |

