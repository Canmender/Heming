# d.104 插件体系升级规格（v5 清单 · 统一贡献注册表 · 市场 v2）

> 分支：`feat/d103-plugin-system`（基线 `9c4bfd2` / `d.103.2.42.0`（本分支上另一并行会话已提交 d.103 模型页重构；本升级预计占 d.104，以实际 bump 为准））
> 对标调研：`docs/research/2026-11-08-plugin-system-benchmark.md`
> 本文是**契约**：实施时字段名、存储键、路由、撤销语义以本文为准；改契约先改本文。
> 状态：设计完成，待确认实施范围（阶段 A/B/C/D 见 §10）。

## 0. 决策（用户口径与本文边界）

1. 用户要求：**调研官方插件体系并对现有插件体系做升级**；先从官方仓库 `deepseek-ai/deepseek-harness` 取经。
2. 升级的**第一价值是「统一」而不是「加功能」**：和鸣现在有四套并行机制（声明式 v1–v3 / 界面插件 v4 / 内置模块 / 云端目录），只共享插件区 UI 壳；每加一种能力要改四处。本次把「能力单元 + 贡献点」做成一层契约。
3. **不改变既有红线**：声明式包永不执行代码；界面插件只在 `widget://` 沙箱 + 最小 preload 里跑且只允许官方；权限只收紧、HITL 不放宽；数据只落本机；E2E 不碰。
4. 本文**明确不做**：Cordis 式服务 DI/双面构建/进程内插件运行时；npm/pnpm 包管理与依赖安装；第三方界面插件；插件间任意通信；插件写会话/记忆。
5. 分阶段：阶段 A（统一地基）→ B（分发与市场）→ C（生态体验与开发者工具）→ D（可选：官方 bundle 界面贡献点、内置模块迁移）。**A 是 B/C/D 的前置**。

## 1. 名词

| 名词 | 含义 | 当前对应物 |
|---|---|---|
| 能力单元 Unit | 向产品贡献能力的一个单位，有 id/版本/来源/贡献/状态 | 插件、内置模块、系统能力 |
| 来源 Source | `system` / `builtin` / `package` / `bundle` | `heming.core`、四个模块、v3 包、v4 包 |
| 贡献点 Contribution point | 一种「能往产品里放什么」的类型（页面/命令/技能/…） | 现有四类 + 桌面小组件 + 写死的页面/首页卡/后台循环 |
| 贡献项 Item | 某个单元在某贡献点上的一个具体条目 | 一条技能、一个 MCP 服务、一条命令、一个小组件 |
| 撤销 Dispose | 注册贡献时返回的撤销句柄；停用/更新/卸载一律走撤销 | 目前没有，各 store 各写一套删除 |
| 市场索引 Index | 服务端分发的静态 JSON，描述可安装单元与版本 | 目前 `/api/plugins` 的扁平列表 |
| 生效 Applied | 贡献**真正在运行**（不只是开关为开） | 模块 `isModuleEffective` 的语义 |

## 2. 不变量（任何阶段都不许破）

1. 声明式插件（`distribution: "manifest"`）**永不执行代码**；界面插件只在独立 origin 沙箱内运行，且只有首方签名包可安装。
2. `permissions.tools` 只收紧、在注入点过滤；HITL 判定链不变、不放宽；插件不参与风险判定。
3. 停用/卸载只动**本单元归属**的实体；手工资产（无 `pluginId` 的技能、非 `plugin` origin 的服务）不误删。
4. 安装要么全成、要么全不成：坏包、校验失败、写入失败都不得留下「半可用」状态。
5. 数据只落本机（localStorage / userData）；不上传、不导出、不进团队动向。
6. 主窗 secrets/MCP/文件/会话桥**永不**暴露给 widget；`widgets:*` 只认主窗。
7. 服务端只存字节、不解析权限、不执行代码；客户端必须校验 sha256 才安装。
8. 插件包不随安装包分发。
9. 错误一律中文并给字段路径；解析失败直接拒绝，不做「尽量猜」。
10. 模块/单元停用只下线入口、循环、工具注入，**不删除**任何本机数据。

## 3. 目标架构：能力单元与贡献注册表

### 3.1 三层读模型（只读投影，不合并存储）

```
存储层（不动）                         投影层（新增）                      消费层（改造）
heming.plugins.v1  ─┐
heming.modules.v1  ─┼─→ unitRegistry.list(): CapabilityUnit[]  ─→ 插件区列表 / 诊断 / 搜索
userData/plugins/** ─┤    （system + builtin + package + bundle）     导航 / 路由 / 首页卡 / 设置卡
heming.core（内置）─┘    contributionRegistry.mount(kind,id,fn)     命令面板 / 技能路由 / 工具注入
```

**为什么投影而不是合并存储**：四套存储的写入方、失败语义、迁移路径都不同；合并一次要写迁移脚本、要处理旧版本回滚。投影层是纯函数，零迁移风险，先把「读口径」统一，写入仍由各自 store 负责。

### 3.2 贡献点清单与准入

| 贡献点 | 数据形状 | `system` | `builtin` | `package` | `bundle` |
|---|---|---|---|---|---|
| `skills` | 技能定义 | — | ✓ | ✓ | — |
| `mcpServers` | 远程 MCP 声明 | ✓（预置） | ✓ | ✓ | — |
| `commands` | 命令（target 见附录 A） | ✓ | ✓ | ✓ | ✓ |
| `toolPacks` | 工具归属束 | — | — | ✓ | — |
| `desktopWidgets` | 窗口规格 + 包 | — | — | — | ✓（首方） |
| `page` | 导航入口 + 页面 | ✓ | ✓ | ✗ | ✗（阶段 D 再议） |
| `homeCard` | 首页卡片 | ✓ | ✓ | ✗ | ✗（阶段 D 再议） |
| `settingsCard` | 设置卡片 | ✓ | ✓ | ✗ | ✗（阶段 D 再议） |
| `backgroundJob` | 常驻后台循环 | ✓ | ✓ | ✗ | ✗ |
| `hook` | 生命周期订阅 | — | — | — | ✓（阶段 C） |

「✗」不是永久禁令，而是**本阶段对第三方关闭**：第三方贡献 UI/后台等于在本机跑代码，必须先有首方签名 + 沙箱（详见 §7）。

### 3.3 撤销（dispose）契约

```ts
// packages/web/src/lib/units/registry.ts
export type Dispose = () => void;

/** 注册一个运行时贡献（页面挂载 / 首页卡 / 设置卡 / 后台循环）。返回撤销句柄。 */
export function mountContribution(kind: MountableKind, unitId: string, mount: () => Dispose): Dispose;

/** 单元停用/更新/卸载时：按注册逆序撤销，单个撤销抛错不阻断其余（收集为诊断）。 */
export function disposeUnit(unitId: string): { disposed: number; failures: string[] };
```

规则：

1. 所有运行时注册**必须**返回 `Dispose`；不提供「没有撤销」的注册 API。
2. 撤销顺序：**后注册先撤销**；异步撤销必须串行 `await`（避免「provider 已释放、消费者还在用」——这是官方记录过的 P0 坑）。
3. 撤销失败不阻断，进诊断；单元状态标记为 `degraded`，在插件页可见。
4. 声明式贡献（技能/MCP/命令）不经过 mount，其「生效」由 §3.4 的解析器给出，物化仍由原 store 负责。

### 3.4 依赖与生效判定

```ts
export type BlockReason =
  | { kind: "disabled" }                                   // 总开关关
  | { kind: "kindDisabled"; contribution: ContributionKind } // 贡献级关
  | { kind: "missingRequirement"; unitId: string }          // 依赖单元未生效
  | { kind: "incompatible"; required: string; actual: string }
  | { kind: "signature"; detail: string }
  | { kind: "overBudget"; detail: string };

export function resolveUnit(unit: CapabilityUnit, state: UnitState): UnitStatus;
// UnitStatus = { effective: boolean; contributions: Array<{ kind; effective; reason?: BlockReason }> }
```

- `requires`：单元可声明依赖其它单元 id（内置模块已有该语义，声明式插件 v5 新增）。依赖未生效 ⇒ 本单元 `effective=false`，但**开关保留**（启用依赖后自动恢复），与现有模块口径一致。
- 与准入的交集：即使依赖满足，`package` 单元声明 `page` 这类贡献也一律 `incompatible`（解析期已拒绝，运行时兜底）。

### 3.5 诊断（「为什么它没生效」）

每个单元输出 `diagnostics: Diagnostic[]`，插件页/详情页直接渲染：

| 诊断 | 触发 | 文案示例 |
|---|---|---|
| `disabled` | 总开关关 | 已停用，技能与服务保留但不生效 |
| `kindDisabled` | 某类贡献被关 | 技能已关闭（本插件 3 条技能不注入） |
| `missingRequirement` | 依赖未生效 | 需要「信息中枢」启用后才生效 |
| `incompatible` | engines 不满足 | 需要和鸣 d.105 或更高，当前 d.104 |
| `signature` | 验签失败/未签名 | 未通过首方签名，已拒绝安装 |
| `toolCeiling` | 插件声明 read，但工具是 write | 2 个写工具未注入（插件声明 read） |
| `orphan` | 归属记录丢失 | 发现 3 条无主技能（上次安装未完成） |

## 4. 清单 v5

### 4.1 完整示例

```jsonc
{
  "schemaVersion": 5,
  "id": "acme.report-kit",
  "name": "报告工具箱",
  "version": "1.2.0",
  "description": "周报、月报与数据源",
  "author": "ACME",
  "engines": { "heming": "d.104" },          // 最小应用版本（必填，见 4.3）
  "meta": {                                   // 上架元数据（可选；市场页用）
    "icon": "https://cdn.acme.com/report-kit/icon.png",   // https 或 data:image/*;base64，≤32KB
    "homepage": "https://acme.com/report-kit",
    "repository": "https://github.com/acme/report-kit",
    "license": "MIT",
    "category": "efficiency",                 // 目录声明的分类 id
    "tags": ["official", "report"],           // ≤8，引用目录声明的标签 id
    "keywords": ["周报", "月报", "报告"],       // ≤20，自由文本（搜索加权）
    "screenshots": ["https://cdn.acme.com/report-kit/s1.png"],  // ≤4
    "detail": "report-kit.md"                 // 可选，包内相对路径或内联 markdown（二选一，见 4.4）
  },
  "permissions": {
    "network": ["api.acme.com"],
    "tools": "read",
    "files": []
  },
  "contributions": {
    "skills": [ { "name": "周报", "description": "…", "instructions": "…", "triggers": ["周报"], "tags": ["汇报"] } ],
    "mcpServers": [ { "key": "report", "name": "报告服务", "url": "https://api.acme.com/mcp" } ],
    "commands": [ { "id": "weekly", "title": "生成周报", "keywords": ["周报"], "target": { "kind": "skill", "name": "周报" } } ],
    "toolPacks": [],
    "desktopWidgets": []
  }
}
```

### 4.2 字段表（v5 相对 v3/v4 的增量）

| 字段 | 必填 | 规则 |
|---|---|---|
| `schemaVersion` | 是 | 固定 `5`；v1/v2/v3/v4 仍可安装（归一化到 v5 视图，见 4.5） |
| `engines.heming` | **是（v5）** | 最小应用版本，格式 `d.<特性>[.<破坏性>[.<修订>[.<构建>]]]`，如 `d.104`；见 4.3 |
| `meta.icon` | 否 | `https:` URL 或 `data:image/(png\|jpeg\|webp\|svg+xml);base64,…`，解码后 ≤32KB |
| `meta.homepage` / `meta.repository` | 否 | 绝对 `https:`，≤2048，不含凭据/查询串/片段 |
| `meta.license` | 否 | ≤32 字符自由文本 |
| `meta.category` | 否 | 必须 ∈ 目录 `categories` 声明；未知分类只在市场页告警，不拒绝安装 |
| `meta.tags` | 否 | ≤8，去重；未知标签只告警 |
| `meta.keywords` | 否 | ≤20，各 ≤32 字符，去重 |
| `meta.screenshots` | 否 | ≤4，绝对 `https:`，≤2048 |
| `meta.detail` | 否 | 相对路径（`.md`，包内）或内联 markdown 字符串（≤16384 字符）；二选一 |
| 其余字段 | 同 v3/v4 | `permissions` / `contributions` / `publisher` / `signature` 语义不变 |

**为什么 `engines` 必填**：v5 之前的 `schemaVersion` 只是「解析器版本」，不是「应用兼容性」。zod 对未知字段静默 strip 已经导致过「装完不报错、新字段全丢」的半可用态（`manifest.ts:1250`）；v5 起用最小应用版本把不兼容挡在安装之前，和官方 `engines.dsh` 同一动机。

### 4.3 版本比较（不能用 semver）

和鸣版本是 5 段 `d.特性.破坏性.修订.构建`（`docs/VERSION-MANAGEMENT.md`）。新增 `packages/shared/src/plugin/version.ts`：

```ts
export interface ParsedHemingVersion { channel: string; feature: number; breaking: number; revision: number; build: number }
export function parseHemingVersion(raw: string): ParsedHemingVersion | null;   // 容忍 -dev.n 后缀
export function compareHemingVersion(a: string, b: string): -1 | 0 | 1;        // 缺段按 0 补
export function satisfiesEngines(required: string, actual: string): boolean;  // actual >= required
```

- 只支持「最小版本」语义（`>=`），不支持 semver range——**明确不做**，因为区间语法会带来解析歧义与测试面。
- 判定失败文案：`需要和鸣 d.105 或更高，当前 d.104.2.42.0（见 engines.heming）`。
- 工具链（`scripts/plugin-lint.mjs`）、服务端目录、客户端安装三处**共用同一实现**（`shared` 包），禁止各写一份。

### 4.4 上架元数据与详情文档

- 详情文档来源优先级：`meta.detail`（内联）> 包内 `meta.detail` 路径 > 无。**不读 README**（和鸣包没有 README 约定，读它等于让市场页依赖不存在的东西）。
- 市场页展示：图标、标题、描述、作者、分类、标签、版本列表、兼容性、详细介绍（markdown 渲染，禁原始 HTML，图片只允许 https 或包内 assets）。
- 图标与截图的 `https:` 来源由客户端直接加载（不代理、不落盘）；`data:` 内联只用于无法外链的场景。

### 4.5 兼容与归一化（v1–v4 → v5 视图）

| 旧版本 | 归一化 |
|---|---|
| v1（仅技能） | `engines.heming = "d.0"`、`meta = {}`、`permissions.network = 服务 host 全集`、`tools = "read"` |
| v2（技能 + MCP） | 同上 |
| v3 | 同上（保留 `contributions` 四类） |
| v4（bundle） | 保留 `distribution: "bundle"`、`desktopWidgets`、`permissions.events/graphics/eval`；`engines.heming = "d.0"` |

- 归一化只发生在**读模型**：`InstalledPlugin` 记录里的 `schemaVersion` 保留原值，不静默改写（沿用 `store.ts:349-362` 的既有口径）。
- 新增安装仍接受 v1–v4，但**新特性（meta/engines 兼容判定）只对 v5 生效**；v3/v4 包在市场页以「未标注兼容性」展示，可安装但提示一次。
- 存储：`heming.plugins.v1` 结构不变，新增可选字段 `previous?: { manifest; fingerprint; installedAt }`（更新回滚用，见 5.3）与 `history: Array<{ version: string; at: string }>`（≤3 条）。

### 4.6 拒绝规则（v5 新增，全部中文报错 + 字段路径）

1. `engines` 缺失或格式非法 → `engines.heming：需要最小应用版本（如 d.104）`。
2. `engines.heming` 高于当前应用 → 安装拒绝、市场页标「需要更新和鸣」。
3. `meta.icon` 超过 32KB 或协议非法 → 拒绝（不静默丢弃）。
4. `meta.detail` 同时给了内联与路径 → 拒绝（二选一）。
5. `meta.screenshots` 超过 4 或非 https → 拒绝。
6. `distribution: "bundle"` 仍只允许 `commands` + `desktopWidgets`；`page/homeCard/settingsCard/backgroundJob/hook` 对 `package` 与 `bundle` 一律拒绝。
7. `requires` 引用自身、或引用不存在的单元 id → 拒绝（内置模块注册表里没有对应 id 时也拒绝）。

## 5. 安装事务与生命周期

### 5.1 三阶段：plan → apply → report

```ts
// packages/web/src/lib/plugins/store.ts
export interface InstallPlan {
  manifest: PluginManifest;                 // v5 视图
  mode: "install" | "update";
  diff: PluginUpdatePreview;                // 复用现有 preview()
  conflicts: PluginConflict[];              // 服务 id 占用等，非空则禁止 apply
  writes: PlanWrite[];                      // 将要写的键 + 动作（create/update/remove）
  warnings: string[];                       // 非阻断（如未标注兼容性）
}

export function planInstall(manifest, options): InstallPlan;         // 纯函数，不写任何存储
export function applyPlan(plan): InstallResult;                     // 事务：失败回滚
export interface InstallResult {
  changed: boolean;                                                   // 存储是否真的变了
  applied: "applied" | "failed";                                      // 是否生效
  mode: "install" | "update";
  added/updated/removed: number;   serversAdded/…: number;            // 复用现有计数
  rollback?: { ok: boolean; keys: string[]; error?: string };         // 失败时的回滚报告
  diagnostics: Diagnostic[];
}
```

### 5.2 事务实现（关键改动）

1. **快照**：apply 前把受影响的键原值整体读出——`heming.plugins.v1`、`heming.skills.v1`、`heming.skillBindings.v1`、`heming.mcp.servers.v1`、`heming.mcp.enabledTools.v1`。（`heming.plugin.publishers.v1` 只在用户确认信任后写，放到 commit 之后。）
2. **顺序**：先算完整 plan（含冲突、配额预估），再按 plan 写；任何一步抛错 → 用快照**逐键恢复**（`removeItem` 对原值为空的情况）。
3. **写失败必须可见**：新增 `saveOrThrow()`；`save()` 保留给「非关键路径」但内部改为返回 `{ ok, error }`，安装/更新/卸载路径一律用 `saveOrThrow`。**禁止**再用「吞掉异常继续用内存态」的写法（`store.ts:857-863` 是当前半装态的根因之一）。
4. **原子性边界**：localStorage 没有真正事务，快照+恢复是能做到的最强保证；恢复失败（隐私模式/配额耗尽）要在结果里如实报告 `rollback.ok=false` 并进诊断，不允许谎报成功。
5. **幂等**：同 manifest 重复 apply 结果应为 `changed=false`。

### 5.3 更新与回滚到上一版

- 更新时把**旧 manifest 原样**写入 `previous`（含 fingerprint 与安装时间），`history` 追加 `{version, at}`（≤3，超限丢最旧）。
- 插件详情页新增「回滚到上一版」：仅当 `previous` 存在；用旧 manifest 走同一 `planInstall` + `applyPlan`（语义等同再装一次旧版），成功后交换 `previous`。
- 回滚不联网、不校验目录：**只用本机留存的旧清单**（内容指纹用于提示「与当前记录不同」，不阻断）。

### 5.4 生命周期事件（界面插件，阶段 C）

- 信任面：`permissions.events` 增加 `"lifecycle"`；未声明的插件收不到任何生命周期事件。
- 宿主 → widget（`postMessage`，经 preload 暴露 `onLifecycle(cb)`）：

| 事件 | 时机 | 载荷 |
|---|---|---|
| `installed` | 首装完成、窗口创建前 | `{ version }` |
| `enabled` / `disabled` | 启停生效后 | `{ version }` |
| `updated` | 版本切换完成（窗口已按新版本重建） | `{ from, to }` |
| `uninstalled` | 卸载前（最后一次） | `{ version }` |

- 语义边界：事件是**通知**，不是授权——插件不能靠它拿到新能力；事件在窗口重建后不会重放（`installed/updated` 在下次启动也不再发，插件应以 `getHost()` 返回值自检）。
- 声明式包没有生命周期钩子（永不执行代码），需要在文档里写明。

### 5.5 结果语义（页面与诊断一致）

`changed`（存储是否变）与 `applied`（是否生效）**分开报告**；`applied: "failed"` 时必须给出 `rollback` 与 `diagnostics`。UI 文案三态：

- 成功且生效：`已安装「报告工具箱」1.2.0：技能 +2，服务 +1`
- 成功但另有原因未生效：`已安装，但需要「信息中枢」启用后才生效`
- 失败并已回滚：`安装失败，已恢复到安装前状态：贡献服务 id 冲突（plugin:acme.report-kit:report）`

## 6. 云端目录 v2（市场索引）

### 6.1 布局与发布（服务端仍是字节仓库）

```
<HEMING_PLUGIN_DIR>/
├── market.json                       # 索引（v2），由发布工具生成、PÚT 上传
└── <插件 id>/<版本>/
    ├── plugin.json                   # 原样字节（既有）
    ├── market.json                   # 该版本的展示元数据（可选，发布工具生成）
    ├── detail.md                     # 详细介绍（可选，≤64KB）
    ├── icon.png / shot-1.png …       # 资源（可选，白名单：png/jpeg/webp/svg/ico，单文件 ≤2MB）
    └── package.tgz                   # 界面插件的包（既有）
```

- **索引与生成器分离**（照搬官方决策）：服务端不扫描、不解析、不生成索引，只存字节 + 原样分发；`scripts/publish-plugin.mjs --push` 在本地用插件目录生成 `market.json` 后上传。
- 新增服务端路由：

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/plugin-market` | 公开 | 原样返回 `market.json`；不存在时 404（客户端回落 v1） |
| GET | `/api/plugin-market/:id/:version/detail` | 公开 | 返回 `detail.md`（≤64KB，`text/markdown; charset=utf-8`） |
| GET | `/api/plugin-market/assets/:id/:version/:file` | 公开 | 白名单扩展名 + 路径穿越守卫；`Cache-Control: public, max-age=600` |
| PUT | `/api/plugin-market` | `x-publish-key` | 替换索引（body ≤4MB，必须是合法 JSON 对象）；未配置密钥 503 |

- 既有 `/api/plugins*` 五条路由**原样保留**（旧客户端、旧目录、离线降级都靠它）。

### 6.2 索引格式（`market.json`）

```jsonc
{
  "format": 1,
  "title": "和鸣插件目录",
  "description": "官方与社区能力包",
  "generatedAt": "2026-11-08T10:00:00.000Z",
  "categories": { "efficiency": { "title": "效率" }, "integration": { "title": "集成" }, "ui": { "title": "界面" } },
  "tags": { "official": { "title": "官方" }, "read-only": { "title": "只读" } },
  "sortKeys": { "downloads": { "title": "下载量", "order": "desc" } },
  "plugins": [
    {
      "id": "heming.pet",
      "title": "桌宠",
      "description": "桌面上的 Live2D 化身",
      "icon": "https://…/icon.png",
      "author": "和鸣",
      "homepage": "https://…",
      "repository": "https://…",
      "metadata": { "category": "ui", "tags": ["official"], "keywords": ["桌宠"], "sortKeys": { "downloads": 1200 } },
      "versions": [
        {
          "version": "1.0.1",
          "publishedAt": "2026-11-08T09:00:00.000Z",
          "schemaVersion": 5,
          "engines": { "heming": "d.98" },
          "distribution": "bundle",
          "sha256": "…", "size": 1234,
          "package": { "sha256": "…", "size": 5123456 },
          "detail": "detail.md"
        }
      ]
    }
  ]
}
```

- 客户端用 zod 校验索引（`packages/shared/src/plugin/index.ts`）；**任何一条不合法只丢弃该条并计数告警**，不让整份索引失效（市场不可用是产品事故）。
- `versions` 按 SemVer 序展示；`engines` 不满足的版本标「需要更新和鸣」并禁用安装；默认选最高兼容版本。
- 兼容性判定用 §4.3 的同一实现。

### 6.3 客户端市场 UI

插件区新增 Tab：**已安装 / 市场 / 模块**（模块 Tab 在阶段 C 并入「已安装」的统一列表，先保留）。

- 市场：分类 chips、标签多选、搜索（名称/描述/作者/关键词，250ms 防抖）、排序（默认/更新时间/下载量：来自索引 `sortKeys`）、卡片网格、空态、加载骨架、失败「重试」。
- 详情页：图标、标题、描述、作者、来源（主页/仓库）、分类/标签、版本列表（推荐/已安装/不兼容标记）、详细介绍（markdown，禁原始 HTML）、**安装**按钮。
- 安装流程复用现有 `InstallDialog`：预览（权限/贡献/engines/签名）→ 确认 → 进度 → 结果三态。**下载后仍校验 sha256**，不因来自索引而跳过。
- 离线/索引 404：回落现有「仓库」面板（v1 `/api/plugins`），并提示「目录暂时不可用，已切换到兼容列表」。

## 7. 信任升级

### 7.1 首方签名（把「只允许官方」变成结构保证）

现状：bundle 的「官方」只是「谁拿到 `HEMING_PLUGIN_PUBLISH_KEY`」+ 用户点一次确认（`plugin-package.js:130-139`、`app.ts:149-154`），代码里**没有发布者白名单**（审计 §7 G8）。

v2：

1. 应用内置**首方公钥表**（`packages/desktop/src/first-party-keys.json`，构建时可被环境变量覆盖用于换钥；公钥只用于验签，不是秘密）。
2. `plugin.json` 的 `signature` 对**规范化后的清单字节**做 Ed25519 签名（保留现有 `publisher` + `signature` 字段形状）。
3. bundle 安装：签名必须由首方公钥验签通过；失败 → 拒绝安装，文案「未通过首方签名（publisher: xxx），已拒绝安装」。
4. 声明式包：保留 TOFU（首次确认后记住公钥指纹）——**不变**，因为声明式包不执行代码，签名只用于来源提示。
5. 过渡：内置首方密钥上线前已发布的 bundle（如 `heming.pet 1.0.0`）在升级后**不再允许新装**；发布签名后的新版本（1.0.1）。已安装的不受回滚影响。

### 7.2 发布者身份（最小可用）

- TOFU 展示不变：插件详情显示「发布者：acme（首次确认，公钥指纹 xxxx）」。
- 新增诚实标注：未签名包在详情页显示「未验证来源」，不假装已验证。
- **明确不做**：账号体系绑定的发布者、目录条目签名、吊销列表（需要服务端身份系统，另立规格）。

### 7.3 顺手修掉的已知不一致（阶段 A 必做）

| 问题 | 现状 | 修法 |
|---|---|---|
| 响应头名不一致 | 服务端发 `X-Plugin-Package-Sha256`，客户端读 `x-plugin-sha256` | 客户端优先读新名，兼容旧名 |
| 上限不一致 | 客户端 20MB，目录允许 40MB | 统一 20MB（目录校验同步收紧） |
| bundle 版 `commands` 被接受但不物化 | 清单接受、安装后命令不出现 | 要么物化（命令 target 只允许 page/skill/plugin），要么解析期拒绝；选**物化**，与声明式语义一致 |
| 文档说「手工改过的技能不会被误删」 | 服务端只保护「改了 origin 的服务」 | 明知差异：文档改为「手工**新建**的技能不会误删；被插件带入后手工编辑的技能仍属插件」，并在详情页标注 |

## 8. 插件区 UI（阶段 C）

### 8.1 已安装：统一单元列表

- 一行一个 Unit：图标/来源徽标（系统 / 内置 / 插件 / 界面插件）、名称、版本、状态（生效 / 停用 / 待依赖 / 不兼容 / 降级）、贡献摘要（`技能 3 · 服务 1 · 命令 2`）。
- 筛选：来源、状态、关键词；排序：最近更新 / 名称。
- 操作：启用/停用、贡献级开关、详情、卸载（破坏性操作二次确认）。
- 「系统能力」`heming.core` 置顶只读，不占数量上限。

### 8.2 详情与诊断

- 概览、贡献矩阵（每类贡献的条目与生效状态）、权限、签名/发布者、版本历史、**诊断区**（§3.5）、数据键占用（模块已有）。
- 操作：贡献级开关、回滚到上一版、查看清单原文（只读）。

### 8.3 模块 Tab 的去向

- 阶段 C 起：模块不再是独立 Tab，而是「已安装」里 `source: builtin` 的单元；「模块」Tab 保留一个版本周期并标注「已合并到已安装」。

## 9. 开发者工具与文档

| 产物 | 内容 | 阶段 |
|---|---|---|
| `docs/plugin.schema.json` | 由 zod v5 schema 生成（`z.toJSONSchema`），供编辑器补全与 CI | A |
| `scripts/plugin-lint.mjs` | 校验任意 `plugin.json`（复用 shared 解析器）：字段路径错误、engines、meta、贡献限额、重名 | A |
| `docs/PLUGIN-AUTHORING.md` | 从零写一个插件、v5 字段速查、市场上架、常见拒绝原因、调试三招 | C |
| `plugins/demo-*` fixtures | 最小技能包 / 技能+MCP+命令包 / 坏包（供 lint 与测试用） | A |
| `scripts/publish-plugin.mjs` 扩展 | 生成 `market.json`、打包 detail/assets、上传索引 | B |
| Agent 工具（`plugin_market_search` / `plugin_install_preview` / `plugin_install_apply`） | 只读检索 + 预览 + 走 HITL 的应用 | C（可选） |
| `docs/PLUGINS.md` 更新 | v5 字段、市场、事务语义、信任 | A/B 完成后 |

## 10. 分阶段实施计划

### 阶段 A：统一地基（不改变用户可见能力面，≈1 轮）

| 工作 | 文件 | 验收 |
|---|---|---|
| A1 版本比较 | `packages/shared/src/plugin/version.ts` + 测试 | `d.104` vs `d.104.2.42.0` 等 12 例；`-dev.n` 容忍 |
| A2 v5 清单核心 | `packages/shared/src/plugin/manifest.ts`（v5 zod + 归一化 + engines 判定） | v5 合法/非法用例 30+；v1–v4 归一化视图逐字段断言 |
| A3 web 接线 | `packages/web/src/lib/plugins/manifest.ts`（v5 委托 shared，保留 v1–v4） | 既有 53 例全绿 + v5 新增 20 例；未知字段拒绝（不再静默 strip） |
| A4 单元投影 + 撤销 | `packages/web/src/lib/units/registry.ts`（新）、`modules/*` 适配 | 四类来源都能列出；停用单元撤销全部 mount；撤销失败进诊断 |
| A5 安装事务 | `store.ts`：`planInstall` / `applyPlan` / `saveOrThrow` / `previous` | 注入 `save` 失败 → 回滚到安装前（快照逐键比对）；幂等 apply |
| A6 修已知不一致 | `catalogClient.ts`、`pluginCatalog.ts`、`plugin-package.js` 等 | 头名/上限/命令物化三处回归用例 |
| A7 工具链 | schema 生成、lint 脚本、fixtures | `node scripts/plugin-lint.mjs plugins/demo-bad/plugin.json` 非 0 且中文报错 |

**A 的门槛**：`pnpm -r build && pnpm -r test && pnpm -r typecheck` 全绿；既有插件（infohub-collector / heming.pet）安装、更新、停用、卸载行为逐条不变（回归用例）。

### 阶段 B：分发与市场（≈1 轮）

| 工作 | 文件 |
|---|---|
| B1 索引 schema | `packages/shared/src/plugin/index.ts` |
| B2 服务端路由 | `packages/server/src/pluginMarket.ts` + `app.ts` 注册（索引/详情/资源/PUT） |
| B3 发布工具 | `scripts/publish-plugin.mjs`：生成 `market.json`、detail/assets、`--push` 上传 |
| B4 客户端 | `catalogClient.ts` 索引拉取 + `MarketView` / `MarketDetailDialog` / 分类标签排序 / 回落 v1 |
| B5 版本与兼容 | 版本列表、不兼容禁用、默认最高兼容版、指定版本安装 |

**B 的门槛**：索引不可用时自动回落且不报错；索引里一条坏数据只丢该条；不兼容版本无法安装；安装仍校验 sha256。

### 阶段 C：生态体验与开发者工具（≈1 轮）

统一单元列表与诊断 UI、模块 Tab 合并、命令 target 扩展（附录 A）、bundle 生命周期事件、Agent 工具（可选）、作者文档与 fixtures。

### 阶段 D：可选（另立规格）

官方 bundle 的 `settingsCard` / `page` / `homeCard` 贡献准入、内置模块迁移到统一注册表实现、插件健康检查与自动禁用。

## 11. 测试计划

| 层 | 新增用例（约） | 重点 |
|---|---|---|
| shared | 45 | 版本比较、v5 校验（含 meta/engines 边角）、归一化、索引 schema |
| web 单元 | 90 | plan/apply 回滚、saveOrThrow、撤销顺序、诊断、命令 target、索引匹配/排序 |
| web 组件 | 40 | 安装三态、市场分类/搜索/详情/不兼容、统一列表筛选、诊断文案 |
| server | 25 | 索引原样分发、detail/assets 路径守卫、PUT 鉴权、降级 404 |
| desktop | 15 | 首方验签（通过/失败/换钥）、生命周期事件投递、包上限统一 |

回归门槛：`pnpm -r test` 全绿；`plugin-*` 既有 450 例的语义一条不改。

## 12. 风险与回滚

| 风险 | 影响 | 缓解 |
|---|---|---|
| `manifest.ts`（1300 行）改动引入回归 | 所有插件安装坏掉 | v5 走新模块 + 委托，旧路径不动；A3 用既有 53 例做护栏 |
| 安装事务回滚本身失败（配额/隐私模式） | 「回滚了」但实际没回 | 结果如实报 `rollback.ok=false` + 诊断；UI 不谎报 |
| 首方签名上线导致旧 bundle 不能装 | 桌宠暂时装不了 | 先发布签名版 1.0.1，再切校验；正文写明 |
| 索引与真实包不一致（sha256 对不上） | 用户下载失败 | 客户端以**下载内容**为准校验，索引只作展示；不一致时提示「目录数据过期，请刷新」 |
| 并发开发（当前工作树有其它会话在改 SettingsPage/HomePage 等） | 合并冲突 | 阶段 A 只碰 `lib/plugins`、`lib/units`、`shared/plugin`、`server/pluginMarket`，与在改文件不相交；动手前再 `git status` 复核 |
| 版本号规则 | 忘记 bump | 每个阶段末 `node scripts/bump-version.mjs auto feature` + CHANGELOG 一行 |

**发布口径**：阶段 A 完成 → `d.104.<破坏>.<修订>.0` 一条 CHANGELOG；B/C 各自再 bump。每阶段独立可回滚（A 无用户可见变化，B 的市场可整体下线回 v1，C 的 UI 可开关）。

## 附录 A：命令 `target` 扩展（阶段 C）

```ts
export type CommandTarget =
  | { kind: "page"; page: Page }            // 既有
  | { kind: "skill"; name: string }          // 既有
  | { kind: "plugin" }                       // 既有（打开本插件详情）
  | { kind: "settings"; card: SettingsCardId } // 新增：打开设置区某张卡
  | { kind: "unit"; unitId: string };         // 新增：打开某个能力单元详情
```

- 注册表化：`COMMAND_TARGETS: Record<kind, { validate(target, ctx): string | null; run(target, ctx): void }>`；加一种 target = 加一个注册项，不再改三处。
- 阶段 C 不做「URL 打开」：外链会引入来源信任问题，另立规格。

## 附录 B：贡献点 → 代码落点（阶段 A 后）

| 贡献点 | 注册方 | 消费方（现状 → 改造） |
|---|---|---|
| `page` | 内置单元注册 `page` 贡献 | `App.tsx` 的页面渲染 + 导航（`nav` 顺序、`MODULE_PAGE_SET`） |
| `homeCard` | 内置单元 | `HomePage.tsx` 的 `homeCard` 分支 |
| `settingsCard` | 内置单元 | `lib/settings/registry.ts` + `SettingsPage.tsx` |
| `backgroundJob` | 内置单元 | `App.tsx` 两个 hook（`staff-loop` / `automation-scheduler`） |
| `commands` | 全部来源 | `CommandPalette` 的 `pluginStore.commands()` |
| `skills` / `mcpServers` / `toolPacks` | `package` | 既有 store / 工具目录 |
| `desktopWidgets` | `bundle` | `plugin-host.js` 窗口管理器 |

## 附录 C：本规格与调研的对应关系

| 调研结论 | 本规格落点 |
|---|---|
| 统一贡献点、注册即撤销 | §3.2 / §3.3 |
| `engines` 下载前拦截 | §4.2 / §4.3 |
| 引导式安装八步、changed vs applied | §5.1 / §5.5 |
| 索引与生成器分离、上架元数据 | §6.1 / §6.2 |
| 沙箱不是安全边界 → 动作级闸门 | 不引入沙箱承诺；用首方签名 + 权限上限 + 用户确认（§7） |
| 不照搬 cordis / npm / slot 代数 | §0.4 明确不做 |
| 官方踩坑（清理时序） | §3.3 撤销串行化 |
