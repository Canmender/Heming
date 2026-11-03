# d.65 · 系统插件与声明式工具束（技能/工具全部纳入插件模型）

- 日期：2026-11-03
- 状态：**本轮实施**
- 上游：`2026-11-03-d64-plugin-unification.md`（清单 v3 已上线 d.62.2.23.0）
- 触发：用户「能不能把技能以及工具全部视作插件来制作」→ 选择 **A：内置能力作为系统插件置顶只读**
- 本轮版本：`d.63.2.23.0`（特性 62→63，其余位保留）

## 1. 结论先行（与 d.64 的关系）

d.64 建立了「插件 = 安装/分发单位，技能/MCP/命令 = 贡献类型」。本轮把最后两块补齐，使「所有能力都在插件模型里」：

| 层 | d.64 状态 | d.65 补齐 |
|---|---|---|
| 插件（可装卸包） | 技能/MCP/命令三类贡献 | 增补**声明式工具束 `toolPacks`**（第四类贡献） |
| 技能 | 已作为贡献 | 内置技能归入**系统插件 `heming.core`** |
| MCP 服务 | 已作为贡献 | 预置服务归入系统插件；手工/Registry 仍为「MCP 服务」 |
| 工具 | 只有统一目录 | 内置工具归入系统插件；插件/工具束可声明「我用哪些工具」（只做归属与分组，不改开关） |

**不做的**：插件定义可执行工具（需代码执行/沙箱/签名，触红线）、安装时自动打开工具开关（工具默认关闭是既有红线）、把技能区/接口区页面删掉（保留深度管理，只统一来源口径）。

## 2. 系统插件（`lib/plugins/system.ts`）

```ts
export const SYSTEM_PLUGIN_ID = "heming.core";
export const SYSTEM_PLUGIN_NAME = "系统能力";

export interface SystemPlugin {
  id: typeof SYSTEM_PLUGIN_ID;
  name: string;
  version: string;          // 内置版本，展示用（默认 "1.0.0"）
  description: string;
  pinned: true;             // 置顶
  uninstallable: false;     // 不可卸载/停用（界面不给开关）
  enabled: true;
  contributions: {
    skills: { id: string; name: string; description: string; enabled: boolean }[];
    servers: { id: string; name: string; url: string; enabled: boolean; preset: boolean }[];
    tools: { name: string; description: string; risk: "read" | "write" }[];
    commands: never[];      // 系统插件不贡献命令（保留字段给统一形状）
  };
  counts: { skills: number; servers: number; tools: number; commands: number };
}

export function describeSystemPlugin(options?: {
  skills?: Pick<SkillPool, "list">;
  mcp?: Pick<McpRegistry, "servers" | "isPreset">;
  providers?: readonly CapabilityProvider[];
  version?: string;
}): SystemPlugin;
```

- 技能来源：`skillPool.list()` 中 `source === "builtin"` 的条目（内置技能被用户删除后自然不出现）。
- 服务来源：`mcpRegistry.servers()` 中 `isPreset(id)` 为真的预置服务。
- 工具来源：能力目录里归属为 `system` 的内置工具（见 §4）。
- 只读：没有 `manifest` 解析、没有存储记录；不写 `heming.plugins.v1`。

## 3. 清单 v3 增补：`contributions.toolPacks`

schemaVersion 仍为 **3**（**向后兼容的增补**，不升版本号；旧清单没有该字段照样合法；旧版本应用读到未知键会剔除，不会坏）。

```jsonc
"contributions": {
  "toolPacks": [
    {
      "id": "report-tools",
      "name": "报告工具",
      "description": "周报要用到的查询工具",
      "tools": ["report_query", "report_export"]
    }
  ]
}
```

约束：

- `MAX_PLUGIN_TOOL_PACKS = 10`、`MAX_TOOL_PACK_TOOLS = 50`；`id` 同命令 id 正则；`name` ≤32；`description` ≤200。
- `tools[]` 是**工具名精确匹配**（不写通配符）：`/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/`，同一插件内跨工具束不得重复（重复即报错并指出两处路径）。
- 语义（**只声明归属，不改执行**）：
  1. 目录里被引用的工具标上「来自工具束 X」；
  2. 插件详情页展示工具束及其工具、当前是否已连接/已启用，并给「在接口区管理」入口；
  3. **不会自动打开任何工具开关**（MCP 工具默认关闭的口径不变），也不会让工具绕过 HITL；
  4. 引用了不存在的工具不报错（MCP 可能还没连接），在目录里记为 `unresolved` 展示「未连接/未提供」。
- v1/v2 归一化后 `toolPacks: []`。

## 4. 统一能力描述符（`lib/plugins/descriptors.ts`）

```ts
export type CapabilityKind = "skill" | "tool" | "mcp" | "command";
export type CapabilityOwnerKind = "system" | "plugin" | "mcp";

export interface CapabilityDescriptor {
  id: string;
  kind: CapabilityKind;
  name: string;
  description: string;
  ownerKind: CapabilityOwnerKind;
  ownerId: string;      // heming.core / 插件 id / serverId
  ownerName: string;    // 系统能力 / 插件名 / 服务名
  pluginId?: string;
  serverId?: string;
  enabled: boolean;
  risk?: "read" | "write";   // 仅 tool
}

export interface CapabilitySnapshot {
  descriptors: CapabilityDescriptor[];
  counts: {
    total: number;
    enabled: number;
    byKind: Record<CapabilityKind, number>;
    byOwner: Record<CapabilityOwnerKind, number>;
    systemPlugin: { installed: 1; skills: number; tools: number; servers: number };
  };
  system: SystemPlugin;
}

export function describeCapabilities(options?: { ...同 system/catalog 的注入 }): CapabilitySnapshot;
```

归属判定：

- 技能：有 `pluginId` → 插件；否则 → 系统。
- 服务：`origin: "preset"` → 系统；`origin: "plugin"`（`plugin:` 前缀 id）→ 插件；其余（manual / registry）→ mcp。
- 工具：来自能力目录的 `ownerKind`（`system` / `plugin` / `mcp` / `self`；self 归 mcp 之外的独立展示，descriptor 里 ownerKind 记 `mcp`、ownerName「自我修改」）。
- 命令：启用插件贡献的命令 → 插件；系统插件无命令。

能力目录（`catalog.ts`）同步改造：`CapabilityOwnerKind` 由 `"builtin" | "mcp" | "plugin" | "self"` 改为 `"system" | "mcp" | "plugin" | "self"`（内置工具 = system），`counts` 改 `{ system, mcp, plugin, self, enabled }`；新增 `toolPacks: CatalogToolPack[]` 与工具项上的 `toolPacks?: { id, name, pluginId }[]`：

```ts
export interface CatalogToolPack {
  id: string; pluginId: string; pluginName: string;
  name: string; description: string;
  tools: string[];
  matched: string[];      // 目录里存在的工具
  unresolved: string[];   // 声明了但目录里没有（服务未连接/未启用）
  enabled: boolean;       // 插件是否启用
}
```

## 5. 页面口径（T2/T3）

- **插件页**（T2）：统计四卡改为「插件 `系统 1 + 已装 N` ／ 技能 ／ 工具 ／ MCP 服务」；插件 Tab 顶部固定「系统能力」卡片（`data-testid="system-plugin-card"` 可选），显示技能/服务/工具计数与「随应用内置，不可停用或卸载」，无开关、无卸载；已装插件卡在下方。工具 Tab 增「工具束」段（按插件分组，显示 matched/unresolved），内置工具归属显示「系统能力」。安装弹窗贡献行加「工具束 N · 工具 M」。
- **技能区**（T3）：内置技能来源徽标改为「内置：系统能力」（前缀「内置」+ 系统插件名，非按钮、不可点；不用「系统：系统能力」——与插件名自我重复），插件技能保持「插件：<名>」可点。
- **接口区**（T3）：预置服务来源徽标改为「内置：系统能力」，手工/Registry 保持；插件服务保持可点徽标。
- 三处都从 `describeCapabilities()` / `describeSystemPlugin()` 取名字与归属，禁止各页再手写「内置/系统」字符串。

## 6. 不改（红线）

- MCP 工具开关仍逐个手动；安装/启用插件不自动打开工具；HITL 判定链、风险上限过滤、权限声明口径全部不变。
- 系统插件不写存储、不可停用/卸载、不参与 `MAX_PLUGINS` 计数。
- `PageFallback` 锚点、聊天列 880、设置列 720 左对齐、IPC 白名单不动。
- 中文文案、无 emoji、错误中文带字段路径。

## 7. 三轨（文件级不重叠）

- **T1 核心**（`lib/plugins/**`）：manifest 增补 toolPacks、store 计数、catalog 归属改造与 toolPacks、`system.ts`、`descriptors.ts`、index 导出、对应测试（含 v1/v2/v3 兼容、toolPacks 校验、系统插件计数、描述符归属矩阵）。
- **T2 插件页**（`components/PluginsPage.tsx` + `components/plugins/**`）：系统卡片、统计口径、工具束段、安装预览贡献行、详情工具束段；测试。
- **T3 来源口径**（`components/SkillsPage.tsx`、`components/InterfacesPage.tsx`）：系统/插件来源徽标统一走描述符；测试。
- Lead：规格、文档（CHANGELOG/HANDOFF/INDEX/台账/PLUGINS.md）、版本、门禁、安装包、部署、证据、提交。

## 8. 验收

- 三轨定向用例全绿；`tsc --noEmit` 0；`pnpm -r build` 通过。
- 发布前全量门禁（逐包，允许单包重试一次）：shared / server / web / desktop。
- 真机自检：插件页出现置顶「系统能力」卡片（技能/服务/工具计数与工具目录一致）、无停用/卸载入口；装一个带 toolPacks 的 v3 插件 → 目录里对应工具出现「工具束」归属、不自动打开任何开关；停用插件 → 工具束归属消失；技能区/接口区来源徽标显示「系统：系统能力」。
- 文档更新并回填部署/安装包/更新源证据。
