# d.66 · 插件信任与工具束授权（内容指纹 + 逐个启用）

- 日期：2026-11-03
- 状态：**本轮实施**
- 上游：`2026-11-03-d65-system-plugin.md`（系统插件与工具束已上线 d.63.2.23.0）
- 触发：用户「继续」
- 本轮版本：`d.64.2.23.0`（特性 63→64，其余位保留）

## 1. 两个缺口

| # | 现状 | 用户会撞到的问题 |
|---|---|---|
| G1 | 更新插件时只按技能/服务算差异 | 同一 `id`+`version` 的内容被悄悄换掉（改指令、加服务）看不出来；作者换了也看不出来 |
| G2 | 工具束只展示 `matched/unresolved` | 用户想启用工具束里的工具，仍要去接口区逐台服务找；插件页的「工具束」是个只读清单 |

## 2. 内容指纹与覆盖保护（T1）

### 2.1 指纹算法（`lib/plugins/integrity.ts`，新建）

```ts
export function canonicalManifestText(manifest: PluginManifest): string; // 键排序 + 无空白 + 稳定序列化
export function contentFingerprint(manifest: PluginManifest): string;    // "fnv1a64:<16 hex>"
```

- 算法：对规范化文本做 **FNV-1a 64 位**（两轮不同偏移/质数拼接成 16 hex），再附原文长度。
- **诚实边界（写进代码注释、文档与 UI 提示）**：这是**内容指纹**，用来发现「内容被悄悄改过」，**不是密码学签名**，不证明来源与作者。仓库没有签名基础设施，本轮不建（需要密钥管理与分发链，另立规格）。
- 判定口径：指纹只覆盖**清单语义内容**（id/version/name/description/author/permissions/contributions），不含安装时间等运行时字段。

### 2.2 存储与预览（`lib/plugins/store.ts`）

- `InstalledPlugin` 增 `fingerprint: string`（安装时写入；旧记录缺省 → 首次读取时补算并落盘，不视为错误）。
- `PluginInstallPreview` 增 `trust`：

```ts
export interface PluginTrustPreview {
  fingerprint: string;
  previousFingerprint: string | null;
  /** 同 id 同 version 但内容变了（最需要人看一眼的情况）。 */
  sameVersionContentChanged: boolean;
  authorChanged: boolean;
  previousAuthor: string | null;
  versionChanged: boolean;
  /** 需要用户在安装弹窗显式勾选「我已确认这次覆盖更新」才能继续。 */
  needsConfirm: boolean;
}
```

- `needsConfirm = existing != null && (authorChanged || sameVersionContentChanged)`。首次安装与纯版本升级（作者不变、版本不同）**不需要**额外确认，沿用现有差异预览。
- 安装时把 `fingerprint` 写进记录；更新保持 `installedAt`、刷新 `updatedAt`。

### 2.3 安装弹窗（T2）

- 「信任」一行：`内容指纹 fnv1a64:xxxx…`（首装显示「首次安装」；更新显示「与上次相同 / 与上次不同」）。
- 作者变化：`作者：<旧> → <新>` 标红；同版本内容变化：`版本未变，但内容有变化` 标红。
- `needsConfirm` 时：出现勾选框「我已确认这次覆盖更新」（默认不勾），未勾时「确认安装」禁用并给出 `aria-describedby` 说明；勾选后可安装。
- 既有技能/服务差异、权限清单、v1/v2 旧包提示全部保留。

## 3. 工具束逐个授权（T1 数据 + T2 UI）

- 只允许操作**本插件自己登记的 MCP 服务**的工具：`serverId` 以 `plugin:<pluginId>:` 开头；其它工具（内置、系统、别的插件/手工服务）在插件详情里只显示「在接口区管理」，不给开关。
- 插件详情「工具束」段：每个 `matched` 工具一行——
  - 显示工具名、风险（read/write）、当前启用状态、所属服务；
  - 有开关（`role=switch`），点击弹**逐个确认**：「启用工具 `<name>`？风险：<读/写>。启用只代表模型可见，每次调用仍按 HITL 确认。」确认后调用 `mcpRegistry.setToolEnabled(serverId, name, next)`；
  - **不提供「全部启用/全部停用」按钮**（这是红线：逐个授权）；未匹配工具显示「未连接/未提供」且禁用；插件停用时开关禁用并注明。
- 数据层需要的能力：目录/工具束里能拿到每个工具的 `serverId` 与 `enabled`；若现有 `CatalogToolPack` 不带，T1 在 `catalog.ts` 给 `CatalogToolPack` 增 `entries: { tool: string; serverId?: string; enabled: boolean; risk: "read" | "write" }[]`（保留现有 `tools/matched/unresolved` 以兼容）。
- 行为不变：MCP 工具默认关闭、HITL 判定链、权限上限过滤。

## 4. 不改（红线）

- 不引入密码学签名/证书链（无基础设施，本轮只做内容指纹并明确其边界）。
- 不提供「全部授权/全部放行」入口；不自动启用任何工具。
- 系统插件、权限模型、HITL、`heming.plugins.v1` 之外不新增存储键。
- 中文文案、无 emoji、错误中文带字段路径。

## 5. 三轨（文件级不重叠）

- **T1 核心**（`lib/plugins/**`）：`integrity.ts` + 测试；`store.ts` 指纹字段/预览 trust/旧记录补算；`catalog.ts` 工具束 `entries`；`index.ts` 导出。
- **T2 UI**（`components/plugins/**`、`components/PluginsPage.tsx`）：安装弹窗信任行 + 覆盖确认勾选；详情工具束逐个开关与确认弹窗；测试。
- Lead：规格、文档（CHANGELOG/HANDOFF/INDEX/台账）、版本、门禁、安装包、部署、证据、提交。

## 6. 验收

- T1/T2 定向用例全绿；`tsc --noEmit` 0；`pnpm -r build` 通过。
- 发布前全量门禁（逐包，允许单包重试一次）。
- 真机自检：装 v3 → 改同一 id+version 的内容再装 → 弹窗提示「版本未变，但内容有变化」并要求勾选；勾选后更新、指纹变化；工具束里本插件工具可逐个开关（每次确认），开关后接口区状态同步；无批量入口。
- 文档与部署/安装包/更新源证据回填。
