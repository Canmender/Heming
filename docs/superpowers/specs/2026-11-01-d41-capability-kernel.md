# d.41 · 能力内核：统一工具提供者注册表

- 日期：2026-11-01
- 相关版本：d.40.1.11.0（基线）、本 spec = d.41.1.11.0（特性位 +1）
- 涉及包：`packages/web`（纯前端，不改服务端、不改协议）
- 上游判断：平台化第一层——先让「能力从哪来」成为可枚举、可归属的注册表，再谈插件包与第三方分发

## 0. 问题

- **扩展面与界面耦合**：五类工具在 `ChatPage.buildToolsFor` 手工拼装后交给 `mergeToolBridges`。新增一类能力必须改 `ChatPage.tsx`，而它是界面文件，不是能力层。
- **来源不可归属**：工具只有「谁声明了名字」这一层路由；来源靠 `self_` 前缀猜。轨迹、HITL、设置页都拿不到统一的「这个工具来自哪个能力面」。
- **技能分配不是真边界**：`heming.skillAssignments.v1` 只服务技能页展示；`routeSkills` 只看 `pinned/disabled`，**未分配的自定义技能照样会被注入系统提示词**。平台化要求「智能体拥有什么」必须就是「它能用什么」。

## 1. 决策

### A. 能力提供者契约

```ts
export type ToolOrigin = "mcp" | "builtin" | "self" | "plugin";

export interface CapabilityProvider {
  id: string;          // 稳定标识，注册表内唯一
  origin: ToolOrigin;  // 来源分类（展示与审计用）
  build(ctx: CapabilityContext): ToolBridge | null;
}
```

- `build` **每次调用重新构建**：MCP 服务/工具开关变化即时生效，不缓存桥。
- 返回 `null` 或 `tools` 为空都表示「本轮不提供」，与 `mergeToolBridges` 现有口径一致。
- `plugin` 本轮只作为合法枚举值占位，没有实例——为 d.42 留出口，不提前造运行时。

### B. 注册表

`CapabilityRegistry`：

| 方法 | 语义 |
|---|---|
| `register(provider)` | 重复 `id` 直接抛错（插件 id 冲突必须显性失败） |
| `providers()` | 只读快照，按注册顺序 |
| `build(ctx)` | 依次 build → 过滤空桥 → 走 `mergeToolBridges`；全空返回 `null` |

- **注册顺序即优先级**：工具名重复时前者胜出，与原 `mergeToolBridges(mcp, chart, tone, wiki, self)` 顺序一致。
- 合并后的 `meta(name)` 在提供者自述风险之外**统一补 `origin` 与 `providerId`**：
  - 风险仍然只认我们自己写的桥（MCP `annotations` 依旧不作为判定依据，缺省 `write`）；
  - `origin` 只用于展示/归属，**不参与 HITL 判定**。

### C. 内置提供者

| id | origin | 来源 | 注入条件 |
|---|---|---|---|
| `mcp` | `mcp` | `buildToolBridge()` | 有已启用的服务与工具 |
| `charts` | `builtin` | `buildChartToolBridge()` | 恒定 |
| `tone` | `builtin` | `buildToneToolBridge()` | 恒定 |
| `wiki` | `builtin` | `buildWikiToolBridge()` | 恒定 |
| `self` | `self` | `buildSelfToolBridge()` | **`policy.configured(agentId)`**（沿用现状：没开过自我优化就不注入） |

- `self` 提供者需要按 ChatPage 实例持有的单轮预算（`SelfEditBudget`）与策略对象，由 `CapabilityContext.selfEdit` 传入；内存/技能/MCP 三个依赖用现有模块单例，与改前同源。

### D. 技能分配成为真边界

- `RouteContext` 增加 `allowed?: ReadonlySet<string>`。
- 过滤顺序：`enabled` → 非 `disabled` → **在 `allowed` 内**。`pinned` 也不例外——置顶不能绕过分配。
- `SkillPool.route` 在传入 `agentId` 时传 `assigned(agentId)`。
- **默认语义不变**：没有分配记录时 `assigned()` 仍返回全部内置技能，开箱即用。

## 2. 明确不做

- **不做插件包格式与安装流**（d.42）：`plugin.json`、导入导出、安装确认卡另立规格。
- **不执行第三方 JS**：可执行插件需要进程隔离、权限模型与签名，活动部件翻倍，且直接顶到「本机执行」红线。
- **不把 `ToolBridge` / `SkillDefinition` 上提 `shared`**：`ToolBridge` 依赖 `RiskLevel`（人工确认语义），上提会把 HITL 概念带进服务端与桌面端共享协议。d.42 用「插件清单 schema」作为跨包契约，不搬执行期类型。
- 不做 MCP 的 per-agent 维度、不做能力总线事件、不改服务端。
- 不改技能页 UI（分配入口已存在，本轮只让它真正生效）。

## 3. 风险与处置

| 风险 | 处置 |
|---|---|
| 注册顺序改变导致重名工具归属变化 | 保持 `mcp → charts → tone → wiki → self` 原顺序；单测钉死重名前者胜出 |
| 技能分配收紧后，用户此前「能用」的自定义技能突然不再注入 | 这正是本轮修复目标（分配本应是边界）；技能页可显式分配；内置技能默认分配不变，回归用例覆盖 |
| `meta` 新增 `origin` 影响 HITL 判定 | `origin` 只读；`risk` 缺省仍是 `write`，MCP 仍不自述风险 |
| 注册表变成新单例后测试互相污染 | `register` 重复 id 抛错；单测用独立实例，不碰默认单例 |

## 4. 验收

1. 五类内置提供者注册后，最终工具名集合与改前一致（路径/顺序不变）。
2. 未分配的自定义技能**不**进入系统提示词；已分配与内置默认分配行为不变。
3. 注册表单测覆盖：顺序、空桥跳过、未知工具返回 `ok:false`、`meta` 归属与 `origin`、重复 id 抛错、全空返回 `null`。
4. 全量门禁 `pnpm -r build && pnpm -r --workspace-concurrency=1 test` 全绿。
