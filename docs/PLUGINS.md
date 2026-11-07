# 插件（能力包）编写与安装

插件是**纯声明式能力包**：一个 `plugin.json` 声明「这个包带来哪些能力」，和鸣负责把它物化到现有系统里。插件不执行第三方代码，也不从网络下载可执行物——技能变成技能池里的技能，MCP 服务登记进接口区，命令出现在命令面板。

> 版本口径：清单 `schemaVersion: 4`（d.88 起；在 v3 之上增加**模型接入预设**）。v3 仍可安装（但不接受预设），v1/v2 旧包归一化后可装。
>
> 仓库自带的两个示例插件包（**都不随安装包分发**，由云端插件目录发布、用户自行下载安装）：
> - `plugins/infohub-collector/`：把本机 InfoHub 采集桥声明成本机 MCP 服务 + 技能 + 命令（v3）；
> - `plugins/magpie-gateway/`：把本机 magpie 网关声明成一条「模型接入预设」+ 技能 + 命令（v4）。
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
| `schemaVersion` | 是 | `4`（推荐）；`3` 仍可装（不支持模型预设）；`1`/`2` 为旧格式，解析时归一化 |
| `id` | 是 | 小写字母/数字开头，允许 `.`/`_`/`-`，≤64；安装后不可改（视为另一个插件） |
| `name` / `version` / `description` / `author` | `name`/`version` 必填 | 展示用；`version` 变化会走「更新」而不是新增 |
| `permissions` | 含 MCP 时必填 | 见 §3 |
| `contributions.skills` | 至少一类贡献非空 | 技能，≤50；字段与技能池一致（`name` ≤32、`instructions` ≤8000、`triggers` ≤20、`tags` ≤20） |
| `contributions.mcpServers` | 可选 | 远程 MCP（仅 https；http 只允许 localhost/127.0.0.1/[::1]），≤10；`key` 小写字母数字连字符 ≤32 |
| `contributions.commands` | 可选 | 插件命令，≤30；见 §4 |
| `contributions.toolPacks` | 可选 | 工具束，≤10（只声明归属，不改开关）；见 §9 |
| `contributions.llmPresets` | 可选 | 模型接入预设，≤20（只填协议 / 地址 / 模型，**不含 Key**）；仅 v4；见 §5 |

## 3. 权限：声明即约束

```json
"permissions": {
  "network": ["api.acme.com", "localhost:3000"],
  "tools": "read",
  "files": ["notes"]
}
```

- **`network`**：`mcpServers` 与 `llmPresets` 实际会访问的主机白名单（host 或 host:port，≤20）。清单里每个服务的 host **必须**被覆盖，否则解析直接失败并报出缺失的 host——这是「安装即确认」的依据，不做「尽量放行」。比对前两侧都会规范化：小写，并去掉 http/https 的默认端口（`api.acme.com:443` 与 `api.acme.com` 等价；`:8443`/`:8787` 这类非默认端口照旧区分）。
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

## 5. 模型接入预设（v4）

```json
"contributions": {
  "llmPresets": [
    {
      "id": "magpie-gateway",
      "label": "magpie 本地网关",
      "provider": "openai",
      "baseUrl": "http://127.0.0.1:3425/v1",
      "model": "deepseek/deepseek-chat",
      "note": "模型名按 magpie models 填；Key 填 magpie-heming"
    }
  ]
}
```

- **它是什么**：插件告诉设置区「这条连接怎么填」——协议（`openai` 兼容 / `anthropic`）、Base URL、模型名、一句说明。
  设置区 → 模型里会出现「插件带来的模型预设」，点一下只**填表单**，之后仍走用户自己保存连接。
- **不含 Key**：清单里没有、也不接受 `apiKey` 字段（写了会被严格校验拒绝）；Key 由用户填、存本机安全存储。
- **地址约束**：远程必须 https，http 仅允许 localhost / 127.0.0.1 / [::1]；且该主机必须写进 `permissions.network`——
  「声明即约束」对预设同样生效。
- **停用即消失**：插件停用/卸载后预设不再出现；已经保存的连接不受影响（它属于用户，不属于插件）。
- **为什么走插件而不是内置**：这类第三方网关的接入配置不该随安装包分发；装不装、用不用由用户决定。

## 6. 生命周期与数据

- **安装**：技能写入技能池（标记插件来源）、服务登记进接口区（标记插件来源）、命令进面板。数据只在本机（`heming.plugins.v1` + 技能池/MCP 注册表既有键），不上传。
- **查找**：插件区支持按名称 / id / 作者 / 描述 / 技能名 / 服务名搜索，并按「全部 / 已启用 / 已停用」筛选；装完自动回到插件列表并高亮新装的卡片。
- **云端安装**：安装弹窗「从云端浏览」列出服务端插件目录（版本/权限/贡献/指纹），点「载入清单」下载并**校验 sha256** 后填进同一个清单框——安装预览、信任确认、写入语义与手动粘贴完全一致；目录不可用时只影响该面板。
- **更新**：同 `id` 再次安装 = 更新；弹窗会展示技能/服务的增删改差异与服务 id 冲突。
- **停用**：技能与服务保留记录但不生效，命令消失；重新启用即恢复。
- **卸载**：级联收回本插件物化的技能与服务；用户手工改过的技能/服务不会被误删（按归属判断）。

## 7. 兼容与红线

- v1（仅技能）与 v2（技能 + MCP）旧包继续可安装：归一化后 `permissions.network` = 其服务 host 全集、`tools = "read"`，等于「安装时已确认的既有事实」，不回溯拦截。
- 插件**不执行代码**、不支持 stdio/命令类 MCP；插件包可由**云端插件目录**分发（只下载声明式清单并校验指纹），
  但不支持「URL 直接安装」或随包携带脚本；本地进程类集成仍走接口区手动配置或 Registry 安装。
- 插件包**不随安装包分发**：`plugins/` 目录只在仓库里维护，由 `scripts/publish-plugin.mjs` 发布到服务端目录
  （`HEMING_PLUGIN_DIR`，部署时同步到服务器）。
- 报错一律中文并给出字段路径（如 `contributions.mcpServers[0].url`），坏包直接拒绝安装，不进入「半可用」状态。

## 8. 示例（仓库自带）

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

## 9. 系统插件与工具束（d.63 起）

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

