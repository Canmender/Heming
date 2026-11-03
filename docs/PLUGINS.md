# 插件（能力包）编写与安装

插件是**纯声明式能力包**：一个 `plugin.json` 声明「这个包带来哪些能力」，和鸣负责把它物化到现有系统里。插件不执行第三方代码，也不从网络下载可执行物——技能变成技能池里的技能，MCP 服务登记进接口区，命令出现在命令面板。

> 版本口径：清单 `schemaVersion: 3`（d.62.2.23.0 起）。v1/v2 旧包仍可安装，解析时归一化为 v3 结构。

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
| `schemaVersion` | 是 | 固定 `3` |
| `id` | 是 | 小写字母/数字开头，允许 `.`/`_`/`-`，≤64；安装后不可改（视为另一个插件） |
| `name` / `version` / `description` / `author` | `name`/`version` 必填 | 展示用；`version` 变化会走「更新」而不是新增 |
| `permissions` | 含 MCP 时必填 | 见 §3 |
| `contributions.skills` | 至少一类贡献非空 | 技能，≤50；字段与技能池一致（`name` ≤32、`instructions` ≤8000、`triggers` ≤20、`tags` ≤20） |
| `contributions.mcpServers` | 可选 | 远程 MCP（仅 https；http 只允许 localhost/127.0.0.1/[::1]），≤10；`key` 小写字母数字连字符 ≤32 |
| `contributions.commands` | 可选 | 插件命令，≤30；见 §4 |

## 3. 权限：声明即约束

```json
"permissions": {
  "network": ["api.acme.com", "localhost:3000"],
  "tools": "read",
  "files": ["notes"]
}
```

- **`network`**：`mcpServers` 实际会访问的主机白名单（host 或 host:port，≤20）。清单里每个服务的 host **必须**被覆盖，否则解析直接失败并报出缺失的 host——这是「安装即确认」的依据，不做「尽量放行」。
- **`tools`**：`"none" | "read" | "write"`，缺省 `"read"`。它是本插件 MCP 工具的风险上限：超过上限的工具**不注入**给模型（插件页工具目录里会以「插件声明 read，未注入」标注）。这是收紧，**不会放宽 HITL**——`write` 上限意味着写工具仍会按 HITL 逐次确认。
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
- **更新**：同 `id` 再次安装 = 更新；弹窗会展示技能/服务的增删改差异与服务 id 冲突。
- **停用**：技能与服务保留记录但不生效，命令消失；重新启用即恢复。
- **卸载**：级联收回本插件物化的技能与服务；用户手工改过的技能/服务不会被误删（按归属判断）。

## 6. 兼容与红线

- v1（仅技能）与 v2（技能 + MCP）旧包继续可安装：归一化后 `permissions.network` = 其服务 host 全集、`tools = "read"`，等于「安装时已确认的既有事实」，不回溯拦截。
- 插件**不执行代码**、不支持 stdio/命令类 MCP、不做远程插件市场下载；本地进程类集成仍走接口区手动配置或 Registry 安装。
- 报错一律中文并给出字段路径（如 `contributions.mcpServers[0].url`），坏包直接拒绝安装，不进入「半可用」状态。

## 7. 示例

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
