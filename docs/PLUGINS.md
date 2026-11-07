# 插件（能力包）编写与安装

插件是**纯声明式能力包**：一个 `plugin.json` 声明「这个包带来哪些能力」，和鸣负责把它物化到现有系统里。插件不执行第三方代码，也不从网络下载可执行物——技能变成技能池里的技能，MCP 服务登记进接口区，命令出现在命令面板。

> 版本口径：清单 `schemaVersion: 3`。v1/v2 旧包归一化后可装；d.88 短暂引入的 v4（模型预设）已在 d.90 收回——
> 模型统一由 magpie 网关提供，插件不再声明模型连接。
>
> 仓库自带的示例插件包（**不随安装包分发**，由云端插件目录发布、用户自行下载安装）：
> `plugins/infohub-collector/`：**「信息采集中枢」v1.0.0**——把本机 InfoHub 采集桥
> （`http://127.0.0.1:8776/mcp`，QQ/微信归档的采集与查询）声明成本机 MCP 服务 + 技能 + 命令 + 权限。
> 端点由和鸣桌面端在信息中枢页显式「启动采集桥」提供（只回环、不自动启动）；浏览器版只能探测。
>
> 分发链路：`node scripts/publish-plugin.mjs` 把包摆成服务端目录布局 → 服务端 `GET /api/plugins`
> 列出目录 → 客户端「插件区 → 安装插件 → 从云端浏览」下载原文、**校验 sha256** 后走同一套安装预览。

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
| `schemaVersion` | 是 | 固定 `3`；`1`/`2` 为旧格式，解析时归一化 |
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

## 云端插件仓库（d.95）

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
