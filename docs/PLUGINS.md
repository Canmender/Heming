# 插件（能力包）编写与安装

> **规范在哪**：契约（字段语义 / 权限强制点 / 生命周期 / 运行时 API / 兼容规则）以
> [../plugin-kit/STANDARD.md](../plugin-kit/STANDARD.md) 为准；怎么写以 [../plugin-kit/AUTHORING.md](../plugin-kit/AUTHORING.md) 为准
> （菜谱与示例见 [../plugin-kit/COOKBOOK.md](../plugin-kit/COOKBOOK.md)、[../plugin-kit/examples/](../plugin-kit/examples/README.md)）。
> 本文是**实现说明**：宿主内部怎么装、怎么物化、边界与红线、分发链路。三者冲突时以
> `packages/shared/src/plugin/manifest.ts` 的 `parsePluginManifestV5()` 为准。

插件是**纯声明式能力包**：一个 `plugin.json` 声明「这个包带来哪些能力」，和鸣负责把它物化到现有系统里。插件不执行第三方代码，也不从网络下载可执行物——技能变成技能池里的技能，MCP 服务登记进接口区，命令出现在命令面板。

> **d.124 起多了一类贡献点：页面（`page`）**。插件可以给自己在左侧导航末位要一个入口，点进去是插件自己的页面。
> 两条渲染路径：**声明式页**（`contributions.page.blocks`，宿主按受控块渲染，零代码、浏览器版也能看）与
> **自带页**（界面插件 bundle 的 `contributions.page.entry`，包内 HTML 在 `widget://` 沙箱里跑，仅首方）。
> 页面只能拥有自己，不能改宿主界面；不新增任何权限。详见 §13。

> **唯一的例外是界面插件（§10，d.98）**：它带一个独立窗口的可执行渲染包，清单用 `schemaVersion: 4` + `distribution: "bundle"`，
> 只允许官方目录发布、用户在插件区二次确认后安装。第三方仍只能是纯声明式包。
>
> 版本口径：纯声明式清单现行 `schemaVersion: 5`（v1–v3 旧包归一化后可装；**v5 见 §11**：最低宿主版本 `engines` + 上架元数据 `meta`，v5 是新增不是替换）；d.88 短暂引入的 v4（模型预设）已在 d.90 收回——
> 模型统一由 magpie 网关提供，插件不再声明模型连接。**v4 现在的唯一用途是界面插件**（`distribution: "bundle"`，且必须首方签名）。
>
> 仓库自带的真实插件包（**不随安装包分发**，由云端插件目录发布、用户自行下载安装）：
> `plugin-kit/plugins/infohub-collector/`（本机 InfoHub 采集桥）、`plugin-kit/plugins/workflow-kit/`（工作流引擎）、
> `plugin-kit/plugins/pet-widget/`（桌宠，v4 bundle）。源码索引见 [`plugin-kit/plugins/README.md`](../plugin-kit/plugins/README.md)。
>
> 分发链路：`node scripts/publish-plugin.mjs` 把包摆成服务端目录布局 → 服务端 `GET /api/plugins`
> 列出目录 → 客户端「插件区 → 安装插件 → 从云端浏览」下载原文、**校验 sha256** 后走同一套安装预览。
> 界面插件多一步：服务端 `GET /api/plugins/:id/:version/package` 分发 `package.tgz`，客户端比 sha256 后交主进程解包安装。

## 1. 最小清单

```json
{
  "$schema": "../plugin-kit/plugin.schema.json",
  "schemaVersion": 5,
  "id": "acme.report-kit",
  "name": "报告工具箱",
  "version": "1.0.0",
  "description": "周报与数据源",
  "author": "ACME",
  "engines": { "heming": "d.117" },
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

需要导航入口时，在 `contributions` 里再加一个 `page`（声明式写 `blocks`，界面插件写 `entry`）——不写就没有入口，见 §13。

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
| `contributions.page` | 可选 | 插件页面，每插件最多 1 个；声明式写 `blocks`（零代码），界面插件写 `entry`（包内 `.html`，仅首方）；见 §13 |

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
- **`events`**：可订阅的宿主事件（`notify` / `lifecycle` / `theme` / `tray`）。**未声明的一律不投递**——
  `theme` / `tray` 此前是无条件广播，d.113（P1-5）起与 `notify` 同一门禁：声明是约束，不是表单。
- **`chat`**（**仅 bundle**，缺省 `false`）：是否允许 `chatConfig()` 拿到**本机网关 origin**与智能体 `{ id, name }`。
  审计 P0-1：`prompt`（人设提示词）**永不下发**；未声明时 `chatConfig()` 返回空 agents + 可读原因，
  widget CSP 也不放行网关 origin（不再有 `127.0.0.1:*` 通配）。

安装弹窗会完整展示以上权限与贡献计数；用户点「安装」等于确认这份清单。
插件页面（§13）**不引入新权限**：页面只是展示与导航，能调到的宿主能力仍以这份 `permissions` 为准。

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

`target` 五种（`settings` / `unit` 为 v5 新增，d.108）：

| kind | 字段 | 行为 |
|---|---|---|
| `page` | `page` | 跳到页面（页面 id 见命令面板页面目录） |
| `skill` | `name` | 跳到技能区并定位到该技能（必须是本插件 `skills` 里的名字） |
| `plugin` | — | 打开本插件详情 |
| `settings` | `card` | 跳到设置区并定位到某张卡（`card` 必须是 `lib/settings/registry.ts` 里登记的卡片 id） |
| `unit` | `unitId` | 跳到插件区并打开某个能力单元详情（不要求已安装；单元可能稍后才出现） |

命令在命令面板的「插件命令」分组里出现；插件停用/卸载后命令立即消失。
界面插件（bundle）的命令 target 允许 `page` / `plugin` / `settings` / `unit`（d.109 起与声明式对齐），
**仍不允许 `skill`**（bundle 不贡献技能，指向技能的命令没有可解析对象）；主进程安装器按同一集合二次收紧，
web 侧再从已装记录物化进命令面板（`__heming_widgets.list()` → `lib/widgets/commands.ts`）。

## 5. 生命周期与数据

- **安装**：技能写入技能池（标记插件来源）、服务登记进接口区（标记插件来源）、命令进面板。数据只在本机（`heming.plugins.v1` + 技能池/MCP 注册表既有键），不上传。
- **查找**：插件区支持按名称 / id / 作者 / 描述 / 技能名 / 服务名搜索，并按「全部 / 已启用 / 已停用」筛选；装完自动回到插件列表并高亮新装的卡片。
- **云端安装**：安装弹窗「从云端浏览」列出服务端插件目录（版本/权限/贡献/指纹），点「载入清单」下载并**校验 sha256** 后填进同一个清单框——安装预览、信任确认、写入语义与手动粘贴完全一致；目录不可用时只影响该面板。
- **更新**：同 `id` 再次安装 = 更新；弹窗会展示技能/服务的增删改差异与服务 id 冲突。
- **停用**：技能与服务保留记录但不生效，命令消失；重新启用即恢复。
- **卸载**：级联收回本插件物化的技能与服务；用户手工改过的技能/服务不会被误删（按归属判断）。
- **页面（d.124）**：声明式页随清单即时生效（停用撤入口、更新按新清单重渲染、卸载撤入口并清路由，正停在页上则回主页）；bundle 页由主进程创建/销毁视图，停用、卸载、更新与主窗关闭都不留孤儿视图。详见 §13.5。

## 6. 兼容与红线

- v1（仅技能）与 v2（技能 + MCP）旧包继续可安装：归一化后 `permissions.network` = 其服务 host 全集、`tools = "read"`，等于「安装时已确认的既有事实」，不回溯拦截。
- 插件**不执行代码**、不支持 stdio/命令类 MCP；插件包可由**云端插件目录**分发（只下载声明式清单并校验指纹），
  但不支持「URL 直接安装」或随包携带脚本；本地进程类集成仍走接口区手动配置或 Registry 安装。
- 插件包**不随安装包分发**：`plugin-kit/plugins/` 目录只在仓库里维护，由 `scripts/publish-plugin.mjs` 发布到服务端目录
  （`HEMING_PLUGIN_DIR`，部署时同步到服务器）。
- 模型接入不由插件声明：d.90 起模型统一来自本机 magpie 网关（见 README「智能体对话」与
  `docs/superpowers/specs/2026-11-07-d90-magpie-native-model-layer.md`）。
- 报错一律中文并给出字段路径（如 `contributions.mcpServers[0].url`），坏包直接拒绝安装，不进入「半可用」状态。
- **页面红线（d.124）**：插件只能拥有自己的页面。**没有 `page` 贡献的纯能力包不新增导航页**（d.122 的口径只对它们继续成立）；
  有 `page` 的插件才在导航末位多一个入口。插件页面不能改宿主现有页面/布局/导航顺序、不能注入宿主 DOM、不能给宿主页加卡片；
  声明式页永不执行代码、不联网；bundle 页只在 `widget://` 沙箱里跑，且仅首方签名包可装。

## 7. 示例（仓库自带）

完整可粘贴示例（技能 + 本地 MCP + 两条命令 + 权限）：

```json
{
  "schemaVersion": 5,
  "id": "demo.report-kit",
  "name": "报告工具箱",
  "version": "1.0.0",
  "description": "示例插件：技能 + MCP + 命令",
  "author": "和鸣",
  "engines": { "heming": "d.117" },
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
node scripts/publish-plugin.mjs plugin-kit/plugins/infohub-collector/plugin.json --dest /opt/heming/plugins

# 2) 或直接推到云端仓库（CI 用；需服务端已配置发布密钥）
HEMING_PLUGIN_PUBLISH_KEY=**** node scripts/publish-plugin.mjs plugin-kit/plugins/ --push https://heming.example.com
```

两种方式都会先做「能不能解析 / id 与版本是否合规 / schemaVersion 是否是整数 / 有没有名字」的基础校验，
坏包不静默跳过（退出码非 0）。

## 10. 界面插件（v4 · `distribution: "bundle"`，d.98；d.124 起可带页面）

界面插件是**唯一带可执行内容**的插件：它提供一个独立窗口的渲染包（第一个也是当前唯一一个：桌宠 `heming.pet`，见 `docs/PET.md`）；d.124 起还可以在**主窗内容区**嵌一个自己的页面（`contributions.page.entry`，见 §13.4）。
因为「装插件 = 在本机运行代码」，它与纯声明式包走两套清单字段、两套安装链路，**只有官方目录发布的包才允许安装**（第三方仍只能是 §1–§8 的声明式包）。

### 9.1 清单

```jsonc
{
  "schemaVersion": 4,                 // 必须是 4；v1/2/3 客户端会明确拒绝带 desktopWidgets 的包
  "id": "heming.pet",
  "name": "桌宠",
  "version": "1.0.0",
  "distribution": "bundle",           // 缺省 manifest = 旧语义（纯声明式）
  "packageSha256": "…64 位小写 hex…",  // bundle 必填：files/** 内容摘要（签名据此覆盖代码字节；构建/打包工具自动写）
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

- `distribution: "bundle"` 的包**只允许** `desktopWidgets` + `commands` + `page`；声明 `skills` / `mcpServers` / `toolPacks` 一律拒绝。
  `page` 与 `desktopWidgets` 可并存（同一插件既能有浮窗又能有页面），每类最多 1 个；`page.entry` 必须是包内 `.html` 且出现在 `files` 里。
- **`packageSha256` 必填（审计 P0-1）**：它是包内 `files/**` 的确定性内容摘要（不是 tgz 自身字节的 sha256——清单在 tgz 里，写自己的 tgz 摘要会构成自引用）。
  首方签名覆盖清单（含该字段）→ 签名**间接覆盖全部代码字节**；安装端解包后重算并比对，只换包内 JS、保留官方清单+签名的「借壳包」会被拒。
  旧的无该字段的 bundle 包**不再允许新装**（已安装记录不受影响）；打包/签名脚本会自动写入/校验该字段。
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
  （窗口动作 / 宿主信息 / 设置 / 插件数据 `data*` / 事件 / 页面跳转 / `chatConfig`；不含 secrets、MCP、文件、会话任何桥）。
- `widget:*` IPC 一律按 sender 自校验（只认该 widget 自己的窗口）；主窗 `widgets:*` 通道走 `secureIpc` 只认主窗。
- CSP：按清单生成（`script-src` 仅在 `permissions.eval:true` 时放开 `'unsafe-eval'`；`connect-src` = `'self'`
  + **本机网关精确 origin**（仅 `permissions.chat:true` 才放行，精确到端口）+ 清单 `network` 逐 host，
  **不再有 `127.0.0.1:*` 回环通配**、**不继承**主窗的 `https:`/`wss:` 通配；`frame-src 'none'` 禁外部页面）。
- 数据：插件自有业务数据走 `data*` API，默认落 `<userData>/plugins/<id>/data/`（见 §10.6）；
  插件不得写会话 / 消息列表 / msgCache；对话不落盘；**不得把密钥写进 data**（密钥属于宿主设置/密钥存储）。
  界面插件在独立 origin 下**没有可用的 localStorage 持久化**（清缓存/崩溃即丢），别再拿它当存储。

### 9.4 发布

```bash
node scripts/check-release-keys.mjs         # 发版前必跑：只有 dev-* 首方公钥 → 退出码 2 阻断（本地开发可加 --allow-dev）
node scripts/build-pet-widget.mjs           # 构建插件 → plugin-kit/plugins/pet-widget/dist/package/（自动写入 packageSha256）
node scripts/sign-plugin.mjs sign plugin-kit/plugins/pet-widget/dist/package/plugin.json <正式私钥> --id heming --write
                                            # 签名前自动按 files/** 重算 packageSha256；签名因此覆盖代码字节
node scripts/publish-plugin.mjs plugin-kit/plugins/pet-widget/dist/package --dest <plugin-dir>
# 把 <plugin-dir> 同步到服务器的 HEMING_PLUGIN_DIR，客户端「插件区 → 桌面小组件」即可看到
```

> 发版前跑 `node scripts/check-release-keys.mjs`：若 `resources/official-keys.json` 里只有 `dev-*` 公钥会以非 0 退出
> 并提示「正式发版前必须换正式首方公钥（见文件 `_rotate`）」；本地/CI 开发可加 `--allow-dev`。
**正式签名私钥在哪**：不在仓库里。发布机上放在 `D:/Heming-release-keys/official-plugin-signing.seed.txt`
（base64url 原始 32 字节种子，权限仅本用户可读）；**上线前必须移入发布 CI 的 secret / HSM**，并按
`resources/official-keys.json` 的 `_rotate` 做双钥过渡。丢失私钥 = 已安装用户永久无法接收新签名包。

**签名后自检**：`node scripts/pack-plugin.mjs plugin-kit/plugins/pet-widget/dist/package` 会以**安装口径**
（`readPackage`：解包配额 / 路径 / 清单 / 首方验签 / `packageSha256` 重算 / entry 存在）回读校验；
输出 `校验 readPackage ✓` 才算可发布。`d.111` 的 `heming.pet 1.0.1` 即按此流程用 `official-2026-11` 签出。

**dev 公钥不进正式版**：打包版会**跳过所有 `dev-*` 公钥**（即使表里同时有正式钥），
所以「仓库里公开的测试私钥」签出的包在正式版一律不认；本地 `electron .` 由主进程设
`HEMING_ALLOW_DEV_PLUGIN_KEYS=1` 放开。

### 10.5 生命周期事件（d.108，仅 bundle）

界面插件可以在清单里订阅宿主生命周期事件（**未声明就收不到任何一条**）：

```jsonc
"permissions": { "events": ["lifecycle"] }
```

| 事件 | 时机 | 载荷 |
|---|---|---|
| `installed` | 首装完成、首个窗口页面加载完成后 | `{ event, version }` |
| `enabled` / `disabled` | 启停生效后（`disabled` 是窗口销毁前最后一条） | `{ event, version }` |
| `updated` | 版本切换完成、窗口已按新版本重建 | `{ event, version, from }` |
| `uninstalled` | 卸载时（窗口销毁前最后一条） | `{ event, version }` |

widget 侧订阅（`widget-preload.js` 的 `__heming_widget`）：

```js
const off = window.__heming_widget.onLifecycle((e) => {
  // e.event / e.version；updated 时还有 e.from
});
```

边界：

- **通知不是授权**：事件不带来任何新能力，权限仍由清单与宿主判定；插件不能靠事件「申请」什么。
- **权限门禁**：`permissions.events` 不含 `"lifecycle"` 的插件即使安装/启停/更新/卸载也不会收到事件。
- **不重放**：事件只在状态变化时发一次；窗口重建、页面重载、宿主重启都不补发历史事件——
  插件状态请用 `info()` / `settings()` 自检（`installed` 在宿主重启后不会重发）。
- 窗口还没建好时事件先排队，页面 `did-finish-load` 后再投递；单个插件最多排队 **20 条**（d.110），
  超出丢最旧的并在宿主日志记一条——保证投递的是最新状态而不是无限堆积。
- **CSP 基线含 `frame-src 'none'`：界面插件不得嵌外部页面**（含 `widget://` 互嵌；
  `connect-src` 白名单只约束插件自己的请求，管不到 iframe 里的第三方子资源，所以直接禁 frame）。
- 传输通道：宿主 `webContents.send("widget:lifecycle", payload)` → preload `onLifecycle(cb)`（返回取消订阅函数）。
- 声明式包没有生命周期钩子（永不执行代码），本条只适用于 `distribution: "bundle"` 的界面插件。

### 10.6 插件数据目录（`data/`，通用 data API）

界面插件的**业务数据默认放在安装目录**，不写 localStorage、不进主窗存储：

```
<userData>/plugins/<pluginId>/data/<key>.json     # 例：C:/Users/<你>/AppData/Roaming/和鸣/plugins/heming.pet/data/cache.json
```

`dataDirOf(id)` 由主进程持有；widget 侧通过 `__heming_widget` 的五个方法读写（全部按 sender 的 `pluginId` 隔离，
插件 A 读不到插件 B 的同名 key）：

| 方法 | 返回 | 说明 |
|---|---|---|
| `dataGet(key)` | `Promise<unknown \| null>` | 不存在 / JSON 坏了 → `null`（读失败不抛） |
| `dataSet(key, value)` | `Promise<{ key, bytes }>` | 覆盖写（tmp + rename 原子落盘）；**失败会 reject** |
| `dataDelete(key)` | `Promise<boolean>` | 是否真的删掉了文件（不存在 = `false`，不算错误） |
| `dataKeys()` | `Promise<string[]>` | 已有 key（只含 `*.json`，已排序；忽略临时文件） |
| `dataDir()` | `Promise<{ dir: string }>` | 数据目录**绝对路径**（放不进 JSON 的大文件也放这里；别展示给终端用户） |

约束（由主进程执行，插件绕不过）：

- **key 规则**：`[A-Za-z0-9._-]{1,64}`，不含 `..`、不含路径分隔符；非法 key 直接 reject（可读错误），不做路径归一化。
- **JSON only**：值按 `JSON.stringify` 落盘（不接受 `undefined` / 函数 / Symbol / 循环引用）。
- **单文件 1MB 上限**：超过 reject 并提示字节数，**不静默截断**（截断的 JSON 比报错更难查）。
- **目录按需创建**：第一次 `dataSet` 时建 `data/`；`dataDirOf` 只给路径，不建目录。
- **升级保留**：换版本只替换 `<version>/`，`data/` 原样保留。
- **卸载即删**：`data/` 随插件删除（即使卸载时勾选「保留设置」，也只保留 `settings.json` / `state.json`）。
- 未安装的 id 不允许写入（避免孤儿目录）；读/列/删对不存在的目录分别降级为 `null` / `[]` / `false`。

widget 侧示例：

```js
const data = window.__heming_widget;

const cache = (await data.dataGet("cache")) ?? { hits: 0 };
cache.hits += 1;
await data.dataSet("cache", cache);        // 超 1MB / 坏 key 会 reject，别吞异常

console.log(await data.dataKeys());        // ["cache", ...]
console.log((await data.dataDir()).dir);   // .../plugins/<id>/data
await data.dataDelete("cache");
```

边界与隐私：

- **只在本机**：数据不随插件包分发、不上云、不进会话/消息列表；卸载即删。
- **别存密钥**：`data/` 是明文文件，密钥应走宿主设置/密钥存储（`settings()` 里也不应出现明文密钥）。
- **偏好仍用 settings**：用户能在设置区看到并回滚的偏好（模型、绑定、打扰强度）走 `settings()/setSetting()`；
  `data*` 只用于插件自己的业务数据（缓存、索引、草稿）。桌宠现有 `settings()/setSetting()` 用法不变。
- **旧宿主兼容**：`data*` 是后加的方法，插件作者按「可能不存在」探测（`typeof data.dataGet === "function"`），
  或在包装层按 `null` / `false` / `[]` 降级；不要因为缺方法白屏。

### 10.7 界面插件页面（d.124）

`contributions.page = { title, icon?, summary?, entry }`：`entry` 是包内 `.html`，宿主在**主窗内容区**用
`WebContentsView` 拉起一个 `widget://<插件 id>/` 沙箱视图（同 `preload`、同 CSP，`rect` 由宿主算并钳制）。
它与桌面小组件可并存；停用/卸载/更新/切页时视图销毁，不留孤儿。清单字段、导航入口与安全边界见 §13.3–§13.6。

## 11. 清单 v5：版本兼容、上架元数据与安装事务（d.106）

v5 相对 v3/v4 只加两件事：**最低宿主版本**（`engines.heming`）与**上架元数据**（`meta`）。
但它同时把三件长期缺失的工程语义补齐了：安装前拦截不兼容、安装要么全成要么全不成、失败能回滚。
d.124 又在 v5 里**增补**了可选贡献点 `contributions.page`（声明式页面，见 §13.2）；不写 `page` 的旧包行为完全不变。

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
  "meta": {                                    // 可选：仓库卡片展示
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
node scripts/plugin-lint.mjs plugin-kit/plugins/acme-report/plugin.json   # 中文报错 + 字段路径
node scripts/plugin-lint.mjs --dir plugin-kit/plugins --skip dist,release  # 批量（源码工程用 --source 单独校验）
node scripts/plugin-lint.mjs plugin-kit/plugins/pet-widget/plugin.json --source  # 界面插件源码工程：不比对 files/
node scripts/plugin-schema.mjs --check                         # 校验 plugin-kit/plugin.schema.json 是否最新（CI）
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

## 12. 选装模块（可执行能力：信息中枢引擎，d.116）

界面插件（bundle）是声明 + 沙箱页面；**模块**是另一类产物：带可执行代码与依赖，由宿主用
stdio 子进程拉起。当前唯一模块是 `heming.infohub-engine`（信息中枢的 QQ / 微信归档引擎）。

**安装包不携带模块**：`build.extraResources` 里没有 `../infohub`，打包边界由
`packaging.plugins.test.js` 钉住。用户启用「信息中枢」时，应用按需从更新源下载模块包 →
首方验签 → 解包到 `<userData>/modules`，随后自动启动，没有任何配置界面。

### 12.1 包格式（`module.tgz`）

```
module.json
files/app/infohub/**      # Python 包（meta.entry = "app"）
files/lib/**              # 可选第三方依赖（meta.lib = "lib"，加进 PYTHONPATH）
```

清单是 **schemaVersion 4**（走 canonical-v1，与 `sign-plugin.mjs` / `plugin-signature.js`
逐字节一致），并额外声明：

```jsonc
{
  "distribution": "module",
  "meta": { "kind": "module", "entry": "app", "lib": "lib" },
  "packageSha256": "<files/** 内容摘要>"
}
```

`packageSha256` 让首方签名间接覆盖全部代码字节；安装端（`module-package.js`）重新计算并比对，
不一致直接拒绝。打包版**拒绝 `dev-*` 公钥**，与界面插件同一把信任锚。

### 12.2 落盘与启动

`<userData>/modules/<id>/<version>/files/{app,lib}`，版本切换后旧版本会被清理；
目录被手工删除时按「未安装」处理。桥（`infohub-bridge.js`）用内置 Python 3.12 拉起
`python -m infohub.bridge`，`PYTHONPATH = app + lib`，**不开端口、不走网络**。

### 12.3 构建与发布

```bash
# 依赖目录（.tmp-engine-lib/）需先按内置 Python 版本下载 cp312 wheel 并解包：
#   pip download --no-deps --only-binary=:all: --python-version 312 \
#     --platform win_amd64 --implementation cp --abi cp312 -d <tmp> <包名>
node scripts/build-module.mjs                  # 默认：packages/infohub + .tmp-engine-lib
node scripts/build-module.mjs --install <modulesDir>   # 构建后装到本机模块目录自检
```

产物默认在 `module-catalog/<id>/<version>/module.tgz`，脚本会用**安装端口径**
（`readModulePackage`：配额 / 布局 / 验签 / 摘要）回读校验并打印 keyId。
发布时把 `module-catalog/<id>/<version>/module.tgz` 放到模块源
`http://47.92.39.184/updates/modules/<id>/<version>/module.tgz`；上传属于部署动作，需单独确认。

开发态若模块未装、但仓库里有 `packages/infohub`，主进程直接退回源码目录（`electron .`
不必每次构建模块包）；打包版没有这条退路。

## 13. 插件页面（d.124）

插件可以在左侧导航**末位**要一个入口，点进去是它自己的页面。每插件**最多一个页面**（`page` 是对象不是数组，
页内没有 Tab/子路由）。导航入口就是它，插件页里另有「页面」贡献行与「打开页面」。

### 13.1 两条渲染路径

| 路径 | 清单字段 | 渲染位置 | 执行代码 | 可用范围 |
|---|---|---|---|---|
| **A · 声明式页** | v5 `contributions.page.blocks` | web 组件 `PluginDeclarativePage`（宿主按受控块渲染） | 否（内容是数据，全部转义） | 安装版 + 浏览器版 |
| **B · 自带页** | v4 bundle `contributions.page.entry` | 主进程 `WebContentsView`，嵌在主窗内容区的 `widget://<插件 id>/` 沙箱 | 是（同 widget 沙箱与 CSP，仅首方签名包） | 仅安装版（浏览器版给降级说明） |

两条路径共用同一份**页面注册表**：已装且启用的模块页 + 声明式页 + 自带页被投影成导航/路由/命令面板的同一份数据，
各处只读这份投影、不各自判断。

### 13.2 声明式页（v5）

```jsonc
"contributions": {
  "page": {
    "title": "采集桥",                    // 必填，1–40 字；导航项与页面标题共用
    "icon": "activity",                  // 可选，宿主图标词表 id；未知值回落 package，不报错
    "summary": "本机采集服务状态与用法",   // 可选，≤200 字；页面副标题
    "blocks": [                          // 必填，1–12 个；未知 type 直接拒绝（不静默丢弃）
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

块词表（v1，全部纯文本，宿主转义后渲染；上限唯一来源 `PLUGIN_LIMITS`）：

| type | 字段 | 限制 | 渲染 |
|---|---|---|---|
| `markdown` | `title?`、`text` | text ≤4000 字 | 复用聊天消息的 markdown 渲染器（**禁原始 HTML**） |
| `stats` | `title?`、`items[{label,value}]` | ≤8 项，各 ≤40 字 | 指标卡横排 |
| `table` | `title?`、`columns[]`、`rows[][]` | 列 ≤6、行 ≤50、单元格 ≤120 字；每行格数 = 列数 | 只读表格 |
| `list` | `title?`、`items[{title,description?,badge?}]` | ≤20 项；标题 ≤60 / 描述 ≤160 / badge ≤12 | 列表行 |
| `actions` | `title?`、`items[{label,target}]` | ≤6 项；label ≤24；target 与命令 target 同形 | 按钮，只做导航 |
| `contributions` | `title?`、`kind` | `skills` / `mcpServers` / `commands` / `toolPacks` | 自动列本插件该类贡献（名称 + 数量），空则一句空态 |

实现口径：

- 数据来源是已装插件记录里的 `manifest.contributions.page`（安装时已由 zod 校验）；渲染层仍逐块容错，
  未知/非法块跳过并记开发日志，生产不白屏。
- 页头 = 图标 + `title` + `summary` + 来源徽标「声明式插件」+ 版本。
- `actions` 的跳转复用命令面板的同一套跳转函数（单一真源，不复制页面白名单）。
- 页面**只读**：不提供编辑清单的能力（清单靠更新插件）；**不代拉数据、不发起任何网络请求**。

完整可 lint 通过的示例：`plugin-kit/examples/05-plugin-page/`；故意写错的对照：`plugin-kit/examples/_invalid/page-entry-on-declarative/`。

### 13.3 页面注册表、导航与路由

| 项 | 口径 |
|---|---|
| 路由 id | `plugin:<插件 id>`；`Page` 联合类型加模板字面量，`normalizePage` 放行 `plugin:` 前缀 |
| 有效性 | 由路由守卫判：未装/停用/记录损坏 → 入口不出现，直开路由 `fallbackPage` 回主页；浏览器版里 bundle 页不可用（入口不出现；宿主缺页面视图能力时显示降级说明）；**不写进 `navOrder`** |
| 导航顺序 | 8 个宿主页 → 模块页（注册表顺序）→ 声明式插件页（首次安装时间升序）→ bundle 插件页（同序）；同刻按 pluginId 字典序 |
| 稳定性 | 插件升级不改位置（沿用首次 `installedAt`）；卸载后重装排到末尾 |
| 分组 / 快捷键 | 归「能力」组；**不分配快捷键**（数字键仍只绑 8 个宿主页） |
| 命令面板 | **不新增**「插件页面」跳转组（v1 明确不做，避免双入口漂移） |
| 其它入口 | 插件卡/详情显示「页面」贡献行 + 「打开页面」（仅已装且启用可用）；设置区「导航顺序」只读列表追加「已装插件页面」 |

### 13.4 自带页运行时（桌面端）

- IPC：`widgets:page-mount { id, rect }`、`widgets:page-bounds { rect }`、`widgets:page-unmount`。
  web 侧占位 div 用 `ResizeObserver` + `getBoundingClientRect()` 上报内容区坐标。
- 主进程建/复用 `WebContentsView`：`preload = widget-preload.js`、`sandbox: true`、`contextIsolation: true`、
  `nodeIntegration: false`，`loadURL("widget://<id>/<entry>")`，CSP 用 `widgetCspHeaders(record.permissions)`。
- 坐标口径：主窗 `contentView` 坐标系（CSS px = DIP）；主进程对 rect 做边界钳制（宽高 ≥1、超出内容区裁掉）。
- 身份校验：页面视图的 `webContents.id` 登记进 runtime map，任何 IPC 先按 sender 反查，查不到即拒绝；
  页面视图**不允许**拖拽/托盘/穿透类通道（返回「不适用于页面」）。
- 导航守卫：`will-navigate` 只允许同 origin；`setWindowOpenHandler` 一律 deny；`will-download` 取消。
- 生命周期对账：切页 / 主窗 resize / 最小化恢复 / 插件停用 / 卸载 / 更新 → 销毁视图；主窗关闭先销毁视图再关窗，
  **不留孤儿视图**。
- 失败态：视图创建失败（entry 缺失/包损坏）→ 返回 `{ ok:false, error }`，web 显示原因 +「重建视图 / 打开插件详情」，不白屏。
- 浏览器（无桌面桥）：bundle 页不可用（导航不出现入口；宿主缺 `pageMount` 时显示「插件页面只在安装版里可用」降级说明），不渲染空壳。
- 主题：复用 `widget:info` 的 `theme`，主窗切主题按现有 `widget:event` 推送（不新增通道）。

### 13.5 安装 / 更新 / 卸载

| 场景 | 声明式 | bundle |
|---|---|---|
| 安装预览 | 贡献行多一项「页面 1」 | 同左（`page` 计入预览） |
| 存储 | 不新增键（页面从 `heming.plugins.v1` 的清单派生） | 主进程 `installed.json` 记录增加 `page`，`widgets:list` 暴露 |
| 更新 | 清单替换即生效；正停在该页按新清单重渲染 | `entry`/`page` 变化或版本更新 → 主进程销毁旧视图，下次进入重建；设置与 `data/` 保留 |
| 停用 | 入口消失，页面不渲染 | 入口消失 + 视图立即销毁 |
| 卸载 | 记录删除 → 入口与路由消失；正停在该页 → 回主页 | 同左 + 删除包目录（现有事务），视图先销毁 |
| 降级 | 沿用现有口径 | 沿用现有口径；页面随包回旧版 |
| 新增权限 | 页面不新增权限，无需重新确认 | 页面**不**新增权限项（CSP 仍按 `permissions.network`），无需重新确认 |

### 13.6 安全边界与明确不做

**安全边界**：

1. 声明式页：禁止任何 HTML/脚本入口（markdown 渲染器沿用聊天侧「禁原始 HTML」配置）；链接只允许 `http(s)` 与宿主页面跳转，
   外链走系统浏览器确认。
2. 自带页：只能在 `widget://<id>/` 内导航；`frame-src 'none'` 不变（不自嵌外网、不互嵌）；`connect-src` 仍按
   `permissions.network` 白名单；`script-src 'self'`；无 `nodeIntegration`；**无新增桥方法**（页面场景不写窗口几何）。
3. 视图隔离：页面视图的 `webContents.id` 登记进 runtime map；任何 IPC 先按 sender 反查，查不到即拒绝。
4. 反冒充：`heming.*` 仍是首方保留命名；bundle 页面只有首方签名包能装（现有 `plugin-package.js` + `official-keys.json`）；
   第三方页面在 v1 只能走声明式（零代码）。
5. 隐私：页面不上传任何数据；声明式页展示的是本机清单数据；自带页的数据读写仍只到
   `<userData>/plugins/<id>/data/`（单文件 ≤1MB 配额）。

**本轮明确不做**：插件修改宿主现有界面（注入 DOM、改导航顺序/分组/快捷键、给宿主页加卡片）；每插件多页面或页内 Tab/子路由；
命令面板的「插件页面」跳转组；第三方 bundle 页面的信任链（另立规格）；页面内嵌外部网页/iframe/视频/下载；
声明式页的数据绑定或远程请求；浏览器版渲染自带页（只给不可用/降级说明）。

版本口径：插件页面是新功能 → 特性位 +1（`d.124.3.48.0`）。
