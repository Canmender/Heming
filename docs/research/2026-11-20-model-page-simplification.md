# 和鸣模型页简化设计方案

> 日期：2026-11-20　｜　状态：调研 + 方案草案（**未实施**，用户要求先出方案、先不写代码）
> 用户诉求（m00434，原文）：「然后关于模型页，我希望尽可能简化设计，减少功能，保留必要的，简化操作。主要是方便接入模型。方便调用智能体应用的免费额度，以及看消耗这三个部分」
> 事实来源：`modelpage-fe-explorer` / `model-backend-explorer` 两个只读调研代理，基于当前 `D:\Heming\packages\web\src\` 与 `vendor/magpie-core\` 代码，未修改任何文件。

---

## 0. 结论速览（TL;DR）

- 当前模型页 `packages/web/src/components/ModelPage.tsx` **4443 行**、60+ 个 import、2 大页签 11 个区块、`ModelPage.test.tsx` 139 个测试——"复杂"是结构性的，不是错觉。
- **简化方向**：围绕用户点名的三件事重建信息架构——**①接入模型（来源）②用免费额度（额度）③看消耗（用量）**，把这三件做成首页三张卡/三步引导；其余（轨迹、智能体改模型、路由分组、备份同步、高级设置）收进「更多/高级」二级页，默认不展示。
- **关键可行性**：模型配置全在**本地 magpie 内核**（`~/.config/magpie/`），仓库已有大量可复用能力——12 家厂商预设一键加 Key（`magpiePresets.ts`）、`/v1/models` 自动拉模型（`magpieClient.ts:156-201`）、额度/用量数据（`magpieQuota*.ts` / `magpieUsage.ts`）、CLI 备份恢复。**简化主要是前端信息架构与步骤精简，无需改服务端 SQLite**（服务端没有模型/供应商表，只有团队用量表 `team_usage`，与 magpie 记账无关）。
- 预计工作量：~6–9 人日（Phase 1 信息架构重排 ~3、Phase 2 三步流程精简 ~2–3、Phase 3 测试与回归 ~2–3）。风险点是 139 个现有测试与命令面板 `focus-tab` 契约。

---

## 1. 现状盘点

### 1.1 页面结构

`packages/web/src/components/ModelPage.tsx`（入口 `:349`，`return :2024-4440`）：
- 页头 `:2024-2060`：`PageShell title="模型" width="full"`，唯一操作是 ghost「重读全部」按钮（`:2030-2047`），`PageTabs idPrefix="model"`（`:2051-2060`）。
- 两大页签（`:225-236`，d.357 把原「模型/智能体」并进来）：
  - **来源**（`:2103-3482`）：①找服务商+锚点跳转（`:2108-2129`）→②API Key 服务商卡片：选厂商卡→选普通/Coding Plan→填 Key→保存（`:2134-2272`）→③cli 区：订阅账号（`:2277-2339`）、国产智能体（`:2419-2488`）、已添加来源（`:2490-3374`）、额度卡 QuotaReminder/QuotaCards/QuotaTrendCard（`:3364-3408`）→④可用模型（`:3414-3479`）：ModelCatalogPanel + GlobalModelSettings + ImageModelSettings。
  - **运行**（`:3485-4383`）：轨迹 ModelTraceView（`:3502`）、智能体改模型（`:3506-3825`）、路由分组（`:3826-4076`）、用量 ModelUsageView（`:4077-4081`）、备份同步（`:4083-4087`）、更多设置 details（`:4089-4381`：资源库/搜索/网关密钥/会话/高级命令/代理/SearchProviderSettings）。
- 锚点跳转：来源 5 个（`SOURCE_ANCHORS :249-255`）、运行 6 个（`RUN_ANCHORS :257-264`）——页面长到需要"跳到哪一块"。
- 命令面板：`CommandPalette.tsx:139-152`「模型›来源/运行」→ `focus-tab` intent，由 `ModelPage useEffect :362-369` 消费。
- 入口：`SidebarNav.tsx:26-31` 模型第 3 项，**无快捷键**（page=v model 项 `pages.ts:42-45` 无 digit）。

### 1.2 各子组件规模（`packages/web/src/components/model/`）

ModelCatalogPanel 679、CloudSyncCard 319、SubscriptionRow 252、BackupPanel 236、QuotaTrendCard 157、QuotaReminder 146、ConsolePanel 137、ImageModelSettings 199、GlobalModelSettings 180、SearchProviderSettings 145、DomesticCard 87、QuotaCards 76、WindowBar 63、AccountFilterRow 46、SectionCard 42、MergedQuotaStrip 37、Avatar 30。
另外：`ModelUsageView.tsx` 441 行（函数入口 `:81`，仅模型页用）、`ModelTraceView.tsx` 557 行（函数入口 `:86`，仅模型页用）。

### 1.3 用户操作繁琐点（现状痛点）

1. **加一个来源**：选厂商卡 → 选地址类型（普通/Coding Plan，选错"余额为 0" `:2261-2269`）→ 填 Key → 保存（`:2134-2271`）。
2. **自定义中转**：手填 4 字段——来源名称 / Base URL / 自定义 Key / 模型 ID 列表（逗号分隔）（`:2515-2584`）。
3. **已添加来源每行 4 操作**（高级/测试/停用/删除 `:2711-2755`）；"高级"下又分连接、调流、清单、画像、端点 5 组，`providerForm` 共 22 字段（`:599-622, 2757+`）。
4. **能力分散**：全局/看图/画图/搜索模型分别在多个折叠组件；画图模型网关没列出时还要手填 provider/model（`ImageModelSettings.tsx:160-194`）。
5. **订阅账号 5 类**（claude/codex/copilot/gemini/antigravity）+ 签到 + 自动收取 + 额度提醒/account-cap，国产端独立一块。
6. **"更多设置"堆了 4 类低频功能**（资源库/搜索/网关密钥/会话/高级命令/代理）。
7. **无桌面桥（cli=null）时来源页多数不可用**，只能看模型（`:2062-2070`）——浏览器端体验残缺。

### 1.4 后端/数据流现状（关键：简化不需要动服务端）

- **配置存储**：模型/供应商配置不在服务端 SQLite，也不在前端 store。真正配置在内置 magpie 内核的本地文件：`vendor/magpie-core/internal/provider/provider.go:5-7`「`~/.config/magpie/providers.json`（mode 0600）」；目录缓存 `~/.cache/magpie/models.json`（`catalog.go:604`）；用量日志 `~/.config/magpie/usage.jsonl`（`usage.go:293-294`）。
- **前端 store**：`packages/web/src/store/llm.ts:101-114` 只存网关地址+Key、目录镜像（`KEY_GATEWAY/KEY_MODELS/KEY_ROUTES`），profile 由目录派生，真 Key 不在和鸣；旧 `heming.llmConfigs` 已被 `migrateLegacy :223-250` 删除。五个 lib（`settings/providerForm.ts`、`providerModels.ts`、`modelCatalog.ts`、`modelSettings.ts`、`modelGlobals.ts`）全是**不落盘的纯函数**。
- **服务端路由**：`packages/server/src/app.ts` **没有模型/供应商 endpoint**；只有团队用量 `POST/GET/DELETE /api/team/usage`（`:835/865/907`，前端团队页用）与 `/api/files/usage`（`:1820`）。模型能力走桌面 IPC `magpie:*`（`packages/desktop/main.js:177-188, 885-1071`，CLI 白名单 `magpie-cli.js:17-50`）与 magpie 网关 HTTP（`/v1/models`、`/v1/magpie/usage`、`/usage/requests`）。

---

## 2. 你点名的三件事：现状与简化目标

### 2.1 ① 方便接入模型

**现状可复用的能力（已具备，只是埋得深）**：
- 12 家厂商预设（`lib/magpiePresets.ts:55-120`），`presetAddArgs :146-157` → `provider add <preset> <key> [region=coding]`——**本就是一键填 Key**。
- `/v1/models` 自动拉目录（`lib/magpieClient.ts:156-201`）；`providerModels.ts:46-79` 支持 `provider models ±id/all/best/none` 与 `provider refresh`。
- `providerForm.ts` 做 OpenAI 兼容地址校验与补全（`checkApiKey :20-36`、`normalizeProviderUrl :57-102`）。
- 备份/恢复一键（`BackupPanel.tsx:18-25`），CLI 白名单已含 `import/providers/presets/accounts/plugin/quota/backup/restore/webdav/s3/github`（`magpie-cli.js:17-50`）。

**简化目标**：
- 首页「接入模型」做成**三步向导**：选厂商预设（12 家卡片，含"自定义中转"入口）→ 粘贴 Key → 「添加并自动拉取模型」。Coding Plan 选项只在支持的厂商出现，选错余额为 0 的坑在文案上规避。
- 自定义中转保留但收敛：Base URL + Key 两项必填，模型 ID 让系统从 `/v1/models` 自动拉（拉不到才手动填），不再一上来就 4 个字段。
- 添加成功后直接展示拉到的模型清单与"设为默认"操作，形成闭环。
- 服务商卡、已添加来源、"高级"22 字段全部移到「更多 → 高级配置」，默认视图不出现。

### 2.2 ② 方便调用智能体应用的免费额度

**现状**：所谓"免费额度"= magpie 托管的智能体登录态里的订阅/免费额度，不是内置免配 provider。
- 订阅账号来自 `accounts --json`：`lib/magpieQuota.ts:62-85 AGENT_LABELS` 含 claude→Claude、codex→ChatGPT、copilot、gemini、antigravity 等 22 端。
- 按量/套餐/余额来自 `quota --json`（`lib/magpieQuotaCards.ts:1-10, 28-58`）；国产端每日免费额度需签到（`ModelPage.tsx:1521-1548`，`lib/magpieDomestic.ts`）。
- 现状用法：模型→来源→订阅账号点登录（`accounts add <agent>`，`ModelPage.tsx:1227`）或国产端先 `plugin add` 再登录（`:1620-1644`）——**需要配置/登录，不是即插即免**。
- 已有能力：`accounts import`（`main.go:106`）可导入 Codex `auth.json` 等；`discovery`（`ModelPage.tsx:836 accounts discovery`）自动发现本机已登录的智能体。

**简化目标**：
- 首页「免费额度」一张卡：**一键「检测本机已登录的智能体」**（走 `accounts discovery`），列出检测到的 claude/codex/… 及其额度状态，点"启用"即接入其免费/订阅额度——把"登录 → 启用"两步压到一次扫描。
- 国产端每日免费额度（签到）保留为卡内一个"签到"按钮 + 今日状态，不再单独占一个区块。
- 额度提醒、account-cap、自动收取等高级项收进「更多 → 额度设置」，默认不打断主流程。
- 明确文案："这些额度来自你自己已登录的智能体账号，和鸣不存储你的账号凭证"。

### 2.3 ③ 看消耗

**现状**（能力其实完整，只是埋在运行页底部）：
- `lib/magpieUsage.ts:138-232` 读内核 `/v1/magpie/usage` 与 `/usage/requests`；维度=时间（today/7d/30d/all）、按模型/Agent/账号拆分、请求/错误/输入+输出+缓存 token/费用/TTFT、逐请求明细。
- `ModelUsageView.tsx:81-441`（441 行）：4 张汇总卡 + SVG 柱状图 + 拆分 + 最近请求；CSV 导出走 `usage --csv <period>`（`ModelPage.tsx:4079`）；baseUrl 取 `store.gateway.baseUrl`（`:86`），period 默认 30d（`:87`）。

**简化目标**：
- 把用量从运行页底部提到**首页第三张卡**，默认展示：今日消耗（token/费用）、按模型 Top 3、7 天趋势迷你图；"查看明细/导出 CSV"点开 `ModelUsageView`（保留现有 441 行组件，不改内部）。
- 时间范围、按 Agent/账号拆分、逐请求明细等放进展开态，默认收敛。
- 与团队用量表 `team_usage`（服务端 `app.ts:835/865/907`）严格区分：这里看的是**本机 magpie 记账**，团队页看的才是团队上报；文案上别让用户混淆。

---

## 3. 推荐信息架构（目标形态）

```
模型页（PageShell）
├─ 概览（默认首页）
│   ├─ 卡 1：接入模型　　[三步向导：选预设 → 粘贴 Key → 自动拉模型] + [当前默认模型]
│   ├─ 卡 2：免费额度　　[一键检测已登录智能体 → 列表 + 启用] + [国产端签到]
│   └─ 卡 3：消耗　　　　[今日 token/费用 + 按模型 Top3 + 7天迷你图] → [明细/导出]
├─ 更多（二级页，默认不展示）
│   ├─ 来源管理（原「来源」页签内容：服务商卡片/已添加来源/高级表单）
│   ├─ 运行管理（原「运行」页签：轨迹/智能体改模型/路由分组/备份同步）
│   └─ 高级设置（全局/看图/画图/搜索模型、网关密钥、会话、代理、高级命令）
```

- **保留**三件主功能（接入/额度/消耗）为一级；**下沉**所有低频能力到"更多"，而不是删除——用户的 139 个测试和命令面板契约可平滑迁移。
- 命令面板 `focus-tab` 契约（`ModelPage.tsx:362-369`、`CommandPalette.tsx:139-152`）保留 `sources`/`run` 两个 key，内部映射到"更多"下的对应子页，避免破坏已有跳转。

---

## 4. 分阶段实施计划（未实施，供评审）

| 阶段 | 内容 | 工作量 |
|---|---|---|
| Phase 1 信息架构重排 | 首页三张卡（接入/额度/消耗）+「更多」二级页；原两页签内容搬入更多；页头 tabs 与命令面板契约适配 | ~3 人日 |
| Phase 2 三步流程精简 | 接入向导（预设一键加 Key + `/v1/models` 自动拉）、额度一键 discovery、消耗首页摘要卡（复用 ModelUsageView 展开态） | ~2–3 人日 |
| Phase 3 测试与回归 | 139 个现有测试迁移/更新；补"首页→更多"导航测试；无 CLI 场景、浏览器端降级验证 | ~2–3 人日 |

**明确不做**（保持简化）：
- 不动服务端 SQLite、不新增模型/供应商表（配置本就在本地 magpie）。
- 不重新实现用量统计（复用 `magpieUsage.ts` + `ModelUsageView`）。
- 不删除现有低频功能（收进"更多"，避免功能回退争议）。
- 不改 magpie 内核 CLI 协议。

---

## 5. 风险与约束

1. **测试规模**：`ModelPage.test.tsx` 3290 行 / 139 个 it，6 个 describe（结构与主路径/添加来源/账号与更多/高级表单/智能体改模型/网关密钥与会话）。结构重排会波及大量用例，需分阶段迁移，避免一次性大改。
2. **命令面板契约**：`focus-tab` 的 `sources`/`run` 两个 key 必须继续可用（`ModelPage.tsx:362-369`）。
3. **无桌面桥降级**：`cli=null` 时来源页多数不可用（`:2062-2070`），首页三卡需给出明确提示而非空白。
4. **凭证隐私**：真 Key 不落盘和鸣（store 只存网关地址/Key 镜像）；免费额度来自用户自己登录的智能体账号——文案与实现都要守住这一点，这也是产品隐私卖点（与"智能体不成为团队成员"同一原则）。

---

## 6. 关键文件索引

- 主组件：`packages/web/src/components/ModelPage.tsx`（页头 :2024-2060、TABS :225-236、来源页 :2103-3482、运行页 :3485-4383、命令面板消费 :362-369）。
- 测试：`packages/web/src/components/ModelPage.test.tsx`（3290 行 / 139 it）。
- model/ 组件：`packages/web/src/components/model/`（ModelCatalogPanel 679、CloudSyncCard 319、SubscriptionRow 252、BackupPanel 236、ImageModelSettings 199、GlobalModelSettings 180、QuotaTrendCard 157、QuotaReminder 146、SearchProviderSettings 145、DomesticCard 87、QuotaCards 76、AccountFilterRow 46、MergedQuotaStrip 37 等）。
- 用量/轨迹：`packages/web/src/components/ModelUsageView.tsx`（441，入口 :81）、`ModelTraceView.tsx`（557，入口 :86）。
- 本地库与 lib：`packages/web/src/store/llm.ts:101-114`、`:223-250`；`packages/web/src/lib/settings/providerForm.ts`；`packages/web/src/lib/providerModels.ts`；`packages/web/src/lib/modelCatalog.ts`；`packages/web/src/lib/magpiePresets.ts:55-120`；`magpieClient.ts:156-201`；`magpieQuota.ts:62-85`；`magpieQuotaCards.ts`；`magpieUsage.ts:138-232`；`magpieDomestic.ts`。
- 内核：`vendor/magpie-core/internal/provider/provider.go:5-7`（providers.json 0600）、`catalog.go:604`（models.json）、`usage.go:293-294`（usage.jsonl）。
- 服务端：`packages/server/src/app.ts`（无模型 endpoint；团队用量 :835/865/907）、`packages/desktop/main.js:177-188,885-1071`（magpie IPC）、`packages/web/src/lib/magpie-cli.js:17-50`（CLI 白名单）。
