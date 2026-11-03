# d.64 · 统一插件模型（技能/工具/MCP 合并插件页）

- 日期：2026-11-03
- 状态：**本轮实施**
- 触发：用户「参考 deepseek-harness 的插件化模式，把和鸣也做成插件化模式，把技能工具 MCP 都合并插件页统一口径」
- 上游：`2026-11-03-d63-component-typography.md`（组件基元已就绪，d.61.2.23.0 上线）
- 本轮版本：`d.62.2.23.0`（feature 位 +1，其余位保留，见 `scripts/bump-version.mjs`）

## 1. 参考模型（DeepSeek Harness）与本项目映射

DSH 的插件模型要点（来源：[开发·第一个插件](https://deepseek-harness.github.io/deepseek-harness/develop/basic/index.md)、[扩展形态手册](https://deepseek-harness.github.io/deepseek-harness/reference/cookbook/extension-cookbook.md)）：

| DSH 概念 | 含义 | 和鸣对应 |
|---|---|---|
| 插件 = `apply(ctx)` 声明的能力包 | 一个插件可注册多类扩展点 | `plugin.json`（纯声明式能力包，不执行第三方代码） |
| `inject` 声明依赖 | 依赖就绪才加载 | 清单里 `contributions` 声明贡献；装配顺序由宿主固定 |
| 扩展点 `ctx.tools` / skill / MCP | 工具、技能、MCP 是**同一套贡献面** | 统一 `contributions: { skills, mcpServers, commands }` |
| `ctx.effect()` 卸载自动清理 | 生命周期统一收口 | 停用/卸载插件按 `pluginId` 级联清理技能与服务（已实现，补命令与计数） |
| `tools/pre-execute` 权限门禁（allow/deny/ask） | 权限是显式声明 + 运行时决策 | `permissions` 显式声明（network / tools / files），安装需确认，运行时按风险上限过滤 |
| 工具目录对齐展示/查找/执行 | 展示与执行同源 | 新增**统一能力目录** `lib/plugins/catalog.ts`，工具页只读它 |

**不作的事**：不引入 cordis 运行时、不执行插件代码、不做插件热重载。和鸣插件仍是「用户可读的 JSON 能力包」，安全边界不变。

## 2. 现状与差距

现状（d.61.2.23.0）：

- `lib/plugins/manifest.ts`：schemaVersion 1/2，承载 `skills[]` + `mcpServers[]`（仅远程 http）。
- `lib/plugins/store.ts`：技能物化进 `skillPool`、服务登记进 `mcpRegistry`（`origin: "plugin"`），卸载级联。**插件只有「技能 + MCP」两类贡献，没有命令，没有权限声明**。
- 四个页面各自为政：插件区（插件包）、技能区（技能池 + 智能体分配）、接口区（MCP 服务 + 工具开关）、发现 MCP（Registry 安装）。
- 工具没有统一目录：内置工具（charts/tone/wiki/infohub/self）散在 `lib/capability/providers.ts`，MCP 工具在 `mcpRegistry.allTools()`，用户看不到「这台机器一共能用哪些工具、谁提供的」。

差距：

| # | 问题 |
|---|---|
| G1 | 插件清单缺权限声明：装插件=同意任意网络主机与任意风险工具，安装弹窗只列 host，不列工具风险 |
| G2 | 技能/工具/MCP 三处口径不一：同一台 MCP 在接口区叫「服务」、插件页叫「server」、工具区没有 |
| G3 | 插件不能贡献命令：`ctx.tools` 在 DSH 里是最常见贡献，和鸣插件装完只有技能与 MCP |
| G4 | 工具不可枚举：用户无法回答「我现在能调用哪些工具、哪个插件给的、会不会问人」 |

## 3. 清单 v3（唯一契约）

文件：`packages/web/src/lib/plugins/manifest.ts`

```jsonc
{
  "schemaVersion": 3,
  "id": "acme.report-kit",
  "name": "报告工具箱",
  "version": "1.0.0",
  "description": "周报与大屏数据源",
  "author": "ACME",
  "permissions": {
    "network": ["api.acme.com", "localhost:3000"],
    "tools": "read",
    "files": []
  },
  "contributions": {
    "skills": [{ "name": "周报", "description": "", "instructions": "…", "triggers": [], "tags": [] }],
    "mcpServers": [{ "key": "report", "name": "报告服务", "url": "https://api.acme.com/mcp", "description": "" }],
    "commands": [{ "id": "weekly-report", "title": "生成周报", "description": "打开周报技能", "keywords": ["周报"], "target": { "kind": "skill", "name": "周报" } }]
  }
}
```

规则：

- `PLUGIN_SCHEMA_VERSION = 3`，`PLUGIN_SCHEMA_VERSIONS = [1, 2, 3]`；v1/v2 旧包**继续按原规则解析并归一化为 v3 结构**（`contributions.skills/mcpServers` 有值，`commands` 空，`permissions` 缺省）。
- v3 必填 `contributions`（对象，至少一类非空）；不再接受顶层 `skills`/`mcpServers`（给出中文迁移提示）。
- `permissions.network`：主机白名单（host 或 host:port，≤20）。**声明即约束**：`mcpServers` 的每个 host 必须被覆盖，否则解析失败（报错指明缺哪个 host）。v3 无 MCP 服务时可省略整个 `permissions`。
- `permissions.tools`：`"none" | "read" | "write"`，缺省 `"read"`。是**本插件 MCP 工具的风险上限**；运行时超过上限的工具不注入（见 §5）。不允许借此放宽 HITL——`read` 上限只是「不提供写工具」，不会让写工具免问。
- `permissions.files`：预留字段（≤5 个相对路径），本轮**只校验与展示，不执行**（和鸣插件尚不能携带文件工具）。
- `contributions.commands`：≤30 个；`id` 正则同插件 id 段；`target.kind ∈ {page, skill, plugin}`：
  - `page` 需 `page` 为合法页面 id（复用 `lib/palette/pages.ts` 的页面清单）；
  - `skill` 需 `name` 与本插件 `skills[].name` 之一一致；
  - `plugin` 表示打开本插件详情。
- 上限：`MAX_PLUGIN_SKILLS=50`、`MAX_PLUGIN_MCP_SERVERS=10`、`MAX_PLUGIN_COMMANDS=30`、`MAX_PLUGIN_PERMISSION_HOSTS=20`。
- 归一化后 `PluginManifest` 恒定具备 `contributions.skills[] / mcpServers[] / commands[]` 与 `permissions { network, tools, files }`（缺省补全），UI 不需要再判空。

`parsePluginManifest(input: unknown): PluginManifest` 行为不变：任何不合法一律抛 `PluginManifestError`，报错含字段路径与中文说明；不做「尽量猜」容错。

## 4. 统一能力目录

文件：`packages/web/src/lib/plugins/catalog.ts`

```ts
export type CapabilityOwnerKind = "builtin" | "mcp" | "plugin" | "self";

export interface CapabilityToolEntry {
  name: string;              // 工具名（执行时用的键）
  description: string;
  ownerKind: CapabilityOwnerKind;
  ownerId: string;           // providerId 或 serverId
  ownerLabel: string;        // 人读：内置 / MCP 服务名 / 插件名 / 自我修改
  pluginId?: string;         // 插件提供时必填
  serverId?: string;         // MCP 工具填写
  risk: "read" | "write";    // meta.risk ?? riskOfName(name)
  enabled: boolean;          // MCP 工具 = 开关；内置工具 = true；self = 该智能体是否配置
  editable: boolean;         // 只有 MCP 工具可在目录里直接开关
}

export interface CapabilityCatalog {
  tools: CapabilityToolEntry[];
  counts: { builtin: number; mcp: number; plugin: number; self: number; enabled: number };
  /** 插件风险上限过滤掉的工具（展示用，说明「插件声明 read，写工具未注入」）。 */
  blocked: { name: string; ownerLabel: string; risk: "read" | "write"; pluginId: string }[];
}

export function describeCapabilityCatalog(options?: {
  mcp?: Pick<McpRegistry, "allTools" | "tools" | "servers" | "isToolEnabled">;
  plugins?: Pick<PluginStore, "list">;
  providers?: readonly CapabilityProvider[];
  selfAgents?: string[];
}): CapabilityCatalog;
```

- 内置工具来源：遍历 `providers`（默认 `capabilityRegistry.providers()`），排除 `id === "mcp"`（MCP 单独展开到 server 粒度）与 `id === "self"`（需智能体上下文，`selfAgents` 为空时不列）。用 `provider.build({ agentId: "__catalog__", conversationId: "__catalog__" })` 取桥，`bridge.tools` + `bridge.meta(name)` 取描述与风险；构建抛错则跳过该 provider（目录不能拖垮页面）。
- MCP 工具来源：`mcpRegistry.allTools()` + `mcpRegistry.tools(serverId)` 补描述；`serverId` 以 `plugin:` 开头时归到插件 owner（`pluginId` 由 `lib/plugins/store.ts` 的 `pluginIdFromServerId` 反解），否则 owner 为「MCP 服务」。
- 风险：`meta.risk ?? riskOfName(name)`（复用 `lib/hitl/classify.ts`），**与执行期判定同源**。
- 去重：同名工具只保留首个（与 `mergeToolBridges` 的「前者胜出」一致），并在 `blocked` 之外的重复项不重复计数。

## 5. 权限模型与执行口径

文件：`packages/web/src/lib/plugins/permissions.ts`

```ts
export type PluginToolRisk = "none" | "read" | "write";
export function hostOfUrl(url: string): string;
export interface PluginPermissionReport {
  network: string[]; files: string[]; tools: PluginToolRisk;
  hosts: string[];          // 由 mcpServers 推导、实际会访问的主机
  undeclared: string[];     // hosts - network（解析期已拒绝，运行时兜底）
  accepted: boolean;
}
export function evaluatePluginPermissions(manifest: PluginManifest): PluginPermissionReport;
export function pluginIdFromServerId(serverId: string): string | null;  // "plugin:<id>:<key>" → id
export function riskAllowed(risk: "read" | "write", ceiling: PluginToolRisk): boolean;
```

执行口径（**只能收紧，不能放宽**）：

1. 安装前：插件详情/安装弹窗必须展示 `permissions`（网络主机、工具风险上限、预留文件根）与贡献计数（技能/服务/命令）。
2. 装配期（`lib/capability`）：`mcp` 提供者的桥在注入前过滤——桥内每个工具若来自 `plugin:` 服务且 `riskAllowed(toolRisk, pluginCeiling) === false`，则不注入；被过滤项进入目录 `blocked` 供 UI 说明。**HITL 判定链不变**，过滤只减少可调用工具，不改变审批要求。
3. 停用/卸载：沿用现有级联（技能 `pluginId`、服务 `origin: "plugin"`）。
4. 旧插件（v1/v2）没有 `permissions`：归一化后 `tools: "read"`、`network` = 其服务 host 全集（等于「安装时已确认的既有事实」），不回溯拦截。

## 6. 插件页信息架构（合并口径）

`components/PluginsPage.tsx` 改为**统一能力中枢**，标题「插件区」，副标题说明「插件 = 能力包：技能 / 工具 / MCP 服务 / 命令，全部本机」。

- 头部统计：已装插件 / 技能 / 工具 / MCP 服务 四个数值卡（数值来自 `pluginStore.list()`、`skillPool.list()`、`describeCapabilityCatalog()`、`mcpRegistry.servers()`）。
- Tab（`role=tablist`，复用技能区现有 tab 样式与 aria 约定）：
  1. **插件**：现有插件卡（保留安装/更新/停用/卸载/详情），卡片补「贡献」行（技能 N · 服务 N · 命令 N）与「权限」摘要（主机数 / 风险上限）；
  2. **技能**：统一技能列表（名称、来源：内置/导入/插件、所属插件、触发词数、启用开关、被几个智能体使用），行内「在技能区管理」跳转；
  3. **工具**：`describeCapabilityCatalog()` 统一目录（名称、描述、归属、风险、开关），按归属分组；插件被风险上限拦下的工具以只读行标注「插件声明 read，未注入」；
  4. **MCP 服务**：统一服务列表（名称、地址、来源：预置/手工/插件/Registry、工具数、启用、连接状态），行内「在接口区管理」跳转；插件服务显示所属插件并可跳到插件详情。
- 安装弹窗（粘贴/导入 plugin.json）：解析成功后就地展示 v3 摘要——schemaVersion、贡献计数、权限清单（网络主机 ≤3 行 + 「共 N 项」、风险上限、文件根）、与已装项差异（沿用现有 DiffChips）；`undeclared` 非空不可能出现（解析已拒绝），但类型守卫保留。
- v1/v2 包可以安装，弹窗标注「旧版清单（v2）：未声明权限，按既有口径处理」。
- 页面改造**不改**：安装/更新/停用/卸载的 store 语义、`pluginStore` 注入方式、现有测试锚点（`data-testid` 若存在保持）。
- `SkillsPage` / `InterfacesPage` 保留深度管理，但每个由插件提供的技能/服务行补「插件：<名>」徽标 + 链接到插件页详情（`ui-store` 的 `paletteIntent` 新增 `open-plugin` 复用既有 `plugin` 类型；若已有 `open-plugin` 用其 `pluginId` 参数）。

## 7. 命令贡献（插件 → 命令面板）

- `lib/palette/actions.ts` 仍是**静态动作**；插件命令单独一组，来自 `pluginStore.list()`（`enabled` 插件 + `contributions.commands`），在 `CommandPalette` 内以「插件命令」分组渲染，`id` 形如 `plugin:<pluginId>:<commandId>`。
- 执行分发（只走既有能力）：`page` → `useUiStore` 切页；`skill` → `focusSkill` 意图（技能区定位）；`plugin` → `openPlugin` 意图（插件页详情）。
- 停用插件后其命令立即从面板消失（每次打开面板现读 store，不缓存）。

## 8. 三轨（文件级不重叠）

### T1 核心模型（`lib/plugins/**`）
- `manifest.ts` v3（含 v1/v2 归一化）、`permissions.ts`、`catalog.ts`、`store.ts`（贡献计数、命令随停用隐藏、`pluginIdFromServerId` 导出）、`index.ts` 导出面；对应 `*.test.ts`。
- 约束：不改 `lib/skills/**`、`lib/mcp/**`、`lib/capability/**` 的既有行为；`store.ts` 只增字段与导出，不改安装/卸载语义。

### T2 插件页中枢（`components/PluginsPage.tsx` + `components/plugins/**`）
- 新增 `components/plugins/PluginStats.tsx`、`PluginSkillPanel.tsx`、`PluginToolPanel.tsx`、`PluginMcpPanel.tsx`、`PluginPermissionList.tsx`（可合并/改名，但文件都在 `components/plugins/` 下）；`PluginsPage.tsx` 组装 Tab。
- 依赖 T1 的导出；在 T1 落地前可先用本地 view-model 适配（`components/plugins/viewModel.ts`），落地后改为直连，**禁止在 `components/` 里重复实现解析/权限逻辑**。

### T3 页面口径统一 + 命令面板（`components/SkillsPage.tsx`、`components/InterfacesPage.tsx`、`lib/palette/**`、`components/CommandPalette.tsx`）
- 技能区/接口区补插件来源徽标与跳转；命令面板加「插件命令」分组；`lib/palette/pages.ts` 若需暴露页面 id 列表则只增不改。
- 不碰 `lib/plugins/**`、`components/PluginsPage.tsx`。

Lead：规格、文档（CHANGELOG/HANDOFF/INDEX/程序台账）、版本号、全量门禁、安装包、部署、回填证据、提交。

## 9. 不改（红线）

- 插件仍是**纯声明式**：不执行第三方代码、不引入 stdio/命令类 MCP、不做远程插件市场下载（Registry 仍只管 MCP 服务）。
- HITL 判定链、`secureStorage`、IPC 白名单、`PageFallback` 测试锚点、聊天消息列 880、设置内容列 720 左对齐——全部不动。
- 个人数据不出本机；插件记录仍只在 `heming.plugins.v1`。
- 中文文案与注释，不用 emoji；错误一律中文并带字段路径。

## 10. 验收

- T1/T2/T3 定向用例全绿；`tsc --noEmit` 零错误；`pnpm -r build` 通过。
- 发布前全量门禁（逐包执行，允许单包重试一次）：shared / server / web / desktop。
- 真机自检：装一个 v3 示例插件（含技能 + MCP + 命令 + 权限）→ 插件页四个 Tab 数值一致 → 命令面板出现该命令 → 停用后命令消失、技能与服务收回；装一个 v2 旧包不报错。
- 文档：CHANGELOG、HANDOFF（版本/里程碑/下一步）、INDEX、程序台账更新；部署与安装包证据回填。
