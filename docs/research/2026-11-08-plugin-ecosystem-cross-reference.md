# 插件生态横向对标（VS Code / Chrome / Claude Code / Dify / n8n / Figma / Obsidian / Raycast）

> 目的：在「官方 DSH 对标」（`2026-11-08-plugin-system-benchmark.md`）之外，把**声明式插件市场**、**代码型扩展平台**、**界面插件沙箱**三类生态放在一起看，回答三个问题：① 哪些设计是跨生态共识；② 和鸣该借哪一条；③ 哪些只是某个生态的包袱不要抄。
> 证据：4 份调研笔记（约 1380 行，均带 URL 或 `repo/path:line`）＋本次对和鸣代码的可行性探针。笔记原文见文末「证据来源」。
> 结论落点：本文件 §4 的 N1–N14 已并入 `docs/superpowers/specs/2026-11-08-plugin-system-upgrade.md`。

## 0. 结论速览

1. **「声明式插件 + 市场」在 2025–2026 已成主流形态**：Claude Code 的 `plugin.json` 能声明 15 类贡献点（全部是文件路径或内联对象）；Dify 的 `manifest.yaml` 描述 tool/model/endpoint 等六类；n8n 用 `package.json` 的 `n8n` 字段。**共同点：清单描述贡献，包体承载实现，市场只索引清单 + 定位信息**。
2. **市场必须是「索引 / 制品 / 校验工具链」三件分离**：Claude Code 官方市场 317 条里只有 41 个包在仓库内（其余指向外部 git/url/npm）；Dify 的 `dify-plugins` 仓库只放 `.difypkg`，索引由独立 marketplace 服务提供；n8n 的包在 npm、索引在自建 Strapi。和鸣「云端静态目录」正好可以只做索引服务。
3. **版本兼容没有「装完降级运行」这条路**：VS Code 是「装得上、标无效、禁用并提示升 IDE」；Chrome 是「商店显示 Not compatible 挡安装，老装静默停止更新」；n8n 是「目录 API 按宿主能力过滤 + 启动校验」。**和鸣应采用「市场服务端过滤 + 客户端兜底 + 已装不兼容显式禁用并说明」三段式**。
4. **安装事务的工业答案是 Dify 的三段式**：`PreparePackage → PersistPackage → rollbackPreparedPackage`（含旧包恢复、幂等、unique_identifier 含内容 checksum）。Claude Code 用「版本目录 + `.orphaned_at` 延迟 14 天清理」让运行中的旧版本不被更新打断。
5. **签名、来源证明、审核、权限是四件事**：包签名只管「字节未被改 + 是谁签的」；npm provenance 只管「从哪个 commit/CI 产出」（官方明说不保证无恶意代码）；TUF 管「更新通道不被降级/冻结/换钥」；审核管「上架判断」。**和鸣当前连第一层都没实现**（bundle 实际不验签，自检 §2.10 实证）。
6. **签名最小可行方案已收敛**：Ed25519 签 **`JCS(清单) ‖ sha256(包)`** 的信封（一次绑定元数据与内容），公钥内置、`keyId` 多钥、换钥走**新旧双签**、吊销靠「随应用版本下发 keyId + 最低版本」，再用「最高已装版本」防降级。
7. **界面插件敢开放的两种范式**：Figma 是「能力拆分」——改文档的没有网络/DOM、有网络/DOM 的改不了文档，网络靠 `networkAccess` 声明 + CSP 强制；Obsidian/Raycast 是「不沙箱 + 窄桥 + 制度」——插件全权限，靠来源审核、自动扫描、评分卡、强制/克制更新来兜。**和鸣只有前一种可选**（官方可执行插件本就是沙箱路线）。
8. **Electron 侧和鸣已经踩对大半**：`widget://` 注册为 `standard+secure+supportFetchAPI`（`main.js:148-156`）、sandbox/contextIsolation/nodeIntegration 三件套、preload 白名单函数、IPC 用 `sender === win.webContents` 身份比对（比 origin 比对更强，`secure-origins.js:61-75`）。**缺的是「包签名验签」与「CSP 最小基线 + 回归守卫」**。
9. **新增权限要重新征得同意，而不是静默提权**：Chrome 的「新增警告型权限 → 扩展被禁用直到用户同意」是可直接照抄的产品语义。和鸣插件升级时若新增网络主机、放宽 `tools` 上限或新增贡献类别，应**强制重新确认；拒绝则保留旧版**。
10. **命名保留是低成本高收益的防冒充手段**：Claude Code 保留 `claude-`/`anthropic-` 前缀与市场名（冒充官方 → 停止加载该市场及其插件）；Dify 要求 `author` 必须等于发布者 GitHub handle。和鸣应保留 `heming.`/`heming-`，且 `heming.*` 只接受首方签名。
11. **未知字段处理应分层**，而不是一味 strict：Claude Code 顶层未知键「剥掉 + 警告」，敏感子对象（`userConfig`/`channels`/`lspServers`）strict 报错。和鸣 v5 应照此分层，把「不兼容」交给 `engines` 而不是 strict 本身（修订自检 F2）。
12. **贡献点冲突要显式定义，否则是设计空白**：VS Code 只有「命令重名硬失败」有统一规则，其余贡献点各自为政。和鸣的贡献点少，正好可以一次定全（命令/技能名/MCP key/工具束 → 硬错误；页面/卡片 → 注册表独占）。
13. **插件市场需要生命周期字段**：Dify 的 `status`/`deprecated_reason`/`alternative_plugin_id`、Claude Code 的 `renames`/`forceRemoveDeletedPlugins`、VS Code 的 `Install Another Version`/pre-release 渠道——这些字段越早进索引越便宜。
14. **DSH 的「注册即 effect」与这几家的「声明式贡献点」并不矛盾**：DSH 是代码型插件（能力经 ctx 服务贡献）；Claude Code/Dify 是声明型（能力经清单贡献）。和鸣走声明型路线，**真正该借的是 DSH 的「撤销语义」和 Claude Code 的「贡献点表 + 合并语义」**，而不是 DSH 的运行时。

## 1. 调研对象与方法

| 生态 | 形态 | 可执行代码 | 市场/索引 | 兼容字段 | 证据强度 |
|---|---|---|---|---|---|
| VS Code | 代码扩展（extension host 进程） | 是 | Marketplace（gallery API） | `engines.vscode` | 源码级（`microsoft/vscode`） |
| Chrome MV3 | 代码扩展（浏览器沙箱） | 是 | Chrome Web Store | `minimum_chrome_version` | 文档 + Chromium 源码 |
| Claude Code | 目录 + 清单（15 类贡献点） | 组件文件由宿主加载 | `marketplace.json`（git 仓库） | **无宿主版本字段** | 官方文档 + 官方市场仓库 |
| Dify | `.difypkg` + `manifest.yaml` | 是（daemon 子进程/容器） | 独立 marketplace 服务 | `meta.minimum_dify_version` | daemon 源码 + 实调 API |
| n8n | npm 包 | 是（宿主内 require） | npm + 自建 Strapi 目录 | `n8nNodesApiVersion` | 源码级（`n8n-io/n8n`） |
| Figma | 双世界：sandbox 主线程 + iframe UI | 是（能力受限） | Community（人工审核） | 无（靠审核） | 官方文档 |
| Obsidian | 直接跑在带 Node 的 renderer | 是（无沙箱） | 社区目录（自动扫描 + 评分卡） | `minAppVersion` | 官方文档 + CVE |
| Raycast | Node 子进程 + RPC 桥 | 是（无沙箱） | Store（人工审核） | 无 | 官方文档 |
| （参照）DSH | Cordis 代码插件 + npm bundle | 是（宿主内） | 用户自配索引 | `engines.dsh` | 源码级 + 决策记录 |

限制：本机 `web_search` 返回 401、`raw.githubusercontent.com` 被重置，调研靠官方文档站 / `api.github.com` / `gh-proxy` 镜像；「未获取到」的条目在文末列出，不做推测。

## 2. 逐家要点

### 2.1 VS Code：贡献点 38 种、懒激活、签名可策略下发

- **清单 = identity + contributes + capability 自述 + 依赖图**；`contributes` 官方 38 项，源码 `IExtensionContributions` 只覆盖子集，其余由各自 registry 消费 → **每个贡献点自带 schema**。
- 自 1.74 起**贡献点自动生成激活事件**（`implicitActivationEvents.ts:63-77`）：声明产生入口，代码按需填充实现。
- 兼容：`engines.vscode` 不满足 → 装得上但 `isValid=false` → `DisabledByInvalidExtension` 禁用，**无降级运行**；更新时改为提示升级 IDE。
- 签名真实存在（`.signature.p7s` + X.509，委托 `@vscode/vsce-sign`），但**是否强制由市场 capability 位决定**（`extensionManagement.ts:825-830`）——「策略下发」而非客户端写死。
- 冲突：只有命令重名硬失败；其他贡献点无统一规则（设计空白）。
- 坑：禁用/卸载**要重载窗口才真正生效**；无效扩展只禁用不清理；内置扩展不可降级。

### 2.2 Chrome MV3：权限四键 + 新增权限即停用

- `permissions` / `optional_permissions` / `host_permissions` / `optional_host_permissions` + `activeTab`（零警告、手势下临时授权）。
- `permissions.request()` **必须用户手势**；**新增「会触发警告」的权限 → 扩展被禁用，直到用户接受新权限**。
- CSP 有最低基线（`script-src 'self'`，加 `'unsafe-eval'` 安装期报错）→ 机制上封死远程代码/字符串求值；唯一例外是 `sandbox.pages`（无 API、只能 postMessage）。
- 签名：CRX3 头 RSA-PSS/ECDSA + publisher proof；解包在沙箱 utility 进程；只有商店托管的包可被普通用户直装。
- 兼容：商店拦新装，**老装静默停止更新**（不提示）。

### 2.3 Claude Code：最接近「和鸣想要的形态」

- `plugin.json` 只有 `name` 必填；15 类贡献点全是路径或内联对象；**明确区分「追加/合并」（skills/hooks/mcpServers/lspServers）与「替换默认扫描」（commands/agents/themes…）**——合并语义写进清单规范，这一点比和鸣现在「按名匹配」更可预期。
- `marketplace.json` 是索引：条目有 `source`（7 类：相对路径/github/url/git-subdir/npm/archive/command）、`category/tags`、`strict`、`dependencies`、`headers`（下载鉴权）；顶层有 `renames`、`forceRemoveDeletedPlugins`、`allowCrossMarketplaceDependenciesOn`。
- 安装态：`~/.claude/plugins/cache/<market>/<plugin>/<version>/` + `data/`；两本账 `installed_plugins.json` / `known_marketplaces.json`；三档 scope（user/project/local，优先级 local>project>user）。
- 更新：版本按 `plugin.json.version` → 市场条目 → 源派生（git sha / archive sha256）；**写死 version 等于钉住用户**；旧版本目录 `.orphaned_at` 保留 14 天再清。
- 信任：**命名保留防冒充**（`claude-`/`anthropic-` 前缀、官方市场名只能来自 `github.com/anthropics/`，冒充则停止加载该市场及其插件）；目录 CI 有 `validate` + AI 政策扫描（`passes` 需「安全 + 无大范围 hooks + 无未披露遥测 + 描述与行为一致」）+ 夜间 bump sha + 失败回滚。
- 未知字段**分层处理**：顶层剥掉只警告；`userConfig`/`channels`/`lspServers`/`monitors` strict。
- 详情页在 `/plugin` 会话内打开（展示「将安装什么」+ Context cost），**不在市场页直接装**——先看后确认。

### 2.4 Dify：安装事务与市场字段的教科书

- 包：`.difypkg`（zip，签名写 zip comment）+ `manifest.yaml` + `provider/*.yaml` + README（英文主文件）+ `readme/README_<locale>.md` + `_assets/`（图标/截图）。**README 即详情页正文**，本地化按 UI 语言精确匹配再回落英文。
- 权限：`tool` / `model`（细到 llm/embedding/rerank/tts/stt/moderation 逐项布尔）/ `node` / `endpoint` / `app` / `storage`（1KB–1GB）/ `resource.memory`；`meta.minimum_dify_version` 必填。
- 市场 API 实测字段：`plugin_id/org/name/type/category/tags/label/brief/introduction/icon/badges/readme_meta/repository/resource/plugins/install_count/status/deprecated_reason/alternative_plugin_id/verification/minimum_dify_version_{major,minor,patch}/version_updated_at` → **这就是和鸣索引 v2 的字段表**。
- 安装事务：`PreparePackage`（解码/验签/算 unique id/备资产）→ `PersistPackage`（remap 资产、存包、写声明；任一步失败即 rollback）→ 失败时 `rollbackPreparedPackage` **恢复被覆盖的旧包**；unique id = `<author>/<name>:<version>@<checksum>`（同版本号不同内容 ≠ 同一插件）。
- 签名：RSA-4096 对「逐文件 sha256 串接 + created_at」签名，daemon 内置公钥验；`FORCE_VERIFYING_SIGNATURE` 默认 true；`ENFORCE_LANGGENIUS_PLUGIN_SIGNATURES` 防冒充。
- 发布：`dify-marketplace-toolkit` 静态校验（安全解压、密钥模式、二进制、外联域名、OSV 依赖漏洞…）+ 风险等级 Low/Medium/High + 一个 PR 一个包。

### 2.5 n8n：目录按宿主能力服务端过滤

- 包 = npm 包（名字 `n8n-nodes-*`、keyword `n8n-community-node-package`）；GUI 安装 = `npm pack` → 解包 → 删 dev/peer 依赖 → `npm install --ignore-scripts`（**禁 install scripts 是三家共同选择**）。
- 「verified」= n8n 自建目录里的一条记录（`packageName + npmVersion + checksum + nodeVersions[] + isOfficialNode`），**不是 npm 标签**；目录 API 请求带 `maxN8nNodesApiVersion`，**服务端按宿主能力过滤**。
- 兼容：包内 `n8n.n8nNodesApiVersion` 与宿主比对，不兼容报错并拒绝重装；**降级 = 卸载 + 指定版本重装**；blocklist + 风险勾选 + 实例级开关。
- verified 门槛：脚手架、无运行时依赖、README、Creator Portal 审核（最长 4 周）、**2026-05-01 起必须 GitHub Actions + npm provenance 发布**。

### 2.6 Figma：能力拆分是「敢开放第三方 UI」的结构性原因

- 主线程：极简 JS 沙箱（无 `fetch`/`XMLHttpRequest`/`setTimeout`/DOM），**能改文档**；UI：`<iframe>`（默认 null origin），**有浏览器 API、改不了文档**；两者只能 postMessage。
- `networkAccess.allowedDomains` 声明 + CSP 强制拒绝；**白名单显示在 Community 页面**；`["*"]` 必须写 `reasoning`。
- **固有缺口（官方明说）**：网络限制只作用于「插件自己发的请求」；iframe 里渲染的第三方页面的子资源不受限。
- 审核：上架/实质更新都要审；描述与实际一致、不得隐藏功能、性能（禁长跑后台）、API 只用官方插件 API。
- postMessage 教训：UI 导航到自定义 URL 时消息必须带 `pluginId` 且 `targetOrigin` 不能是 `*`，否则可被同 URL 的其他插件/站点截获。

### 2.7 Obsidian / Raycast：不沙箱，就用制度与窄桥替代

- Obsidian 官方原话：**「Obsidian cannot reliably restrict plugins to specific permissions or access levels」**；manifest 里没有任何 `permissions`/`networkAccess`/`signature` 字段。替代：默认 Restricted Mode、安装后再 Enable、开发者政策（禁混淆/禁自更新/禁遥测）、**自动扫描每个版本**、目录评分卡（含 GitHub artifact attestations）、人工复审、**不自动更新**。代价有 CVE 记录（打开恶意笔记即可 RCE 等）。
- Raycast 同样不沙箱（Node 全权限），但**桥收窄**：单 Node 子进程 + 定义的 RPC API + v8 isolate + 全开源 + 商店审核 + 强制自动更新。
- 教训：**「全权限 + 事后扫描」是一个产品选择，不是安全架构**；和鸣的「只允许官方可执行插件」决定了不能走这条，只能走 Figma 式的能力声明 + 运行时强制。

## 3. 横向六问

### 3.1 贡献点模型

| | 贡献点数量 | 合并/覆盖语义 | 冲突规则 | 懒激活 |
|---|---|---|---|---|
| VS Code | 38 | 各注册表自定 | 仅命令硬失败 | 贡献点自动生成激活事件 |
| Claude Code | 15 | **显式区分追加 vs 替换默认扫描** | 命名空间前缀 | 组件按路径加载 |
| Dify | 6 类（tool/model/endpoint/…） | 每类一个 provider 文件 | unique id 含 checksum | 运行时调用才加载 |
| 和鸣（现状） | 4 数据类 + 1 界面类 | 按名/key 更新 | 服务 id/重名前置校验 | 无（数据即时物化） |

**结论**：和鸣应把「合并语义」和「冲突规则」写进 v5 规范（N10），而不是留给实现各自决定。

### 3.2 版本兼容

| 策略 | 做法 | 代价 |
|---|---|---|
| VS Code | 市场筛兼容版本 + 本地 `isEngineValid` 双保险；不满足则禁用并提示升 IDE | 磁盘留无效扩展 |
| Chrome | 商店挡安装；老装静默停更 | 用户不知道为什么没更新 |
| n8n | 目录 API 带 `maxN8nNodesApiVersion` **服务端过滤** | 目录要理解宿主版本 |
| Dify | `minimum_dify_version` + 市场 API 带 `X-Dify-Version` | 同上 |
| Claude Code | **无宿主版本字段**，靠清单版本 + 依赖范围 + 源 pin | 兼容矩阵交给依赖解析 |

**和鸣结论（N2/N3）**：`/api/plugin-market?hostVersion=…` 服务端过滤 → 客户端再用同一 `satisfiesEngines` 兜底 → 已装插件在应用升级后若变得不兼容，**显式进入「不兼容」状态并禁用**（写明「需要和鸣 d.X / 当前 d.Y」），绝不静默失效。

### 3.3 市场与索引

- 三家都是「索引 / 制品 / 工具链」三分离；索引里放**列表页要显示的全部字段**（Dify 的字段表可直接当和鸣字段表）。
- 生命周期字段必备：`status`、`deprecated_reason`、`alternative_plugin_id`（Dify）、`renames`/`forceRemoveDeletedPlugins`（Claude）、pre-release 渠道（VS Code）。
- 详情内容两种范式：Dify「README + `readme/README_<locale>.md` + `_assets/`」 vs Claude「README 只是 homepage 指向物」。和鸣已选 `meta.detail`（内联或包内路径），等价于 Dify，保留。
- 证据：Dify 市场 API 实调（2026-11-08）、Claude 官方市场仓库统计（317 条/41 个包内）、n8n 目录 API 参数。

### 3.4 安装事务

| 产品 | 事务语义 | 可回退性 |
|---|---|---|
| Dify | `Prepare → Persist → Rollback`（含资产回滚、旧包恢复） | 强（显式补偿） |
| Claude Code | 版本目录 + `.orphaned_at` 延迟 14 天清理 | 中（旧版本仍在，可回退） |
| n8n | 安装失败即卸载；降级 = 卸载 + 指定版本重装 | 弱（无事务） |
| VS Code | 更新前保留旧版本；可 `Install Another Version` | 中 |

**和鸣结论（N5）**：保留自检确定的 `plan → apply → rollback`，但把 apply 拆成 **persist（写存储）+ prepare（预检/快照）+ rollback（补偿）** 三段并显式列出补偿动作；`previous` 清单是「可回退到上一版」的最小实现（受体积上限约束，见自检 F5）。

### 3.5 信任

- **四件事分开**：包签名（完整性/来源）、provenance（构建溯源）、TUF（更新通道防降级/防换钥）、审核（上架判断）。和鸣现在**一层都没有**（bundle 不验签）。
- 签名信封（推荐）：`sig = Ed25519(sk, JCS(manifest) ‖ sha256(pkg))`；`keyId` 多钥；换钥新旧双签（TUF/Sparkle 共识）；吊销 = 随应用版本下发 `revokedKeyIds` + `minVersion`；防降级 = 记录最高已装版本。
- 分级建议：L0 现状（发布密钥 + 用户确认）→ L1（清单+包摘要签名，1–2 人周）→ **L2 推荐（L1 + keyId/轮换/吊销/防降级，1–2 人月）** → L3 过度（Sigstore keyless/Rekor/每文件签名，不做）。
- 命名保留（N8）：`heming.`/`heming-` 前缀与官方市场名保留；`heming.*` 只接受首方签名。

### 3.6 权限与沙箱

- 三种范式：Figma（能力拆分 + 声明式网络 + CSP）、Obsidian/Raycast（全权限 + 制度）、Chrome（四键权限 + 手势申请 + 新增权限停用）。
- **和鸣只能走 Figma 式**：声明（`permissions.network/tools/files/events/graphics/eval`）+ 运行时强制（CSP、工具上限过滤）+ 用户可见（安装预览列权限）。
- Electron 正确姿势（官方 20 条 checklist 中与和鸣相关）：`sandbox/contextIsolation/nodeIntegration` 三件套 ✅；`widget://` 必须注册为 `standard+secure`（否则 web storage 默认禁用）✅；CSP 最小基线（N11）；preload 只暴露白名单函数 ✅；IPC 校验用 `senderFrame.origin` 或**sender 身份**✅（和鸣用身份比对，更强）。
- 缺口：**widget CSP 无回归守卫**（改坏了没人发现）、**`widget://` 页面若嵌外部页面则网络白名单不生效**（Figma 同款缺口，应在规范里写明不允许嵌外部页面）。

### 3.7 生命周期与 UX

- 「禁用/卸载需重载才生效」是 VS Code 的坑（用户以为停了其实没停）。和鸣的声明式插件即时生效，**bundle 窗口需重建**——应明确写进文档与 UI 提示（N14 之一）。
- 更新失败的用户预期：VS Code 保留旧版本可回退；n8n 只能卸载重装；Dify 保留历史包。和鸣用 `previous` + 「回滚到上一版」。
- 弃用/下架：Dify 的 `alternative_plugin_id` 是最好的产品语义（告诉用户迁到哪个），必须进索引字段。
- 预发布渠道 + 版本选择器（VS Code）：和鸣市场 v2 可选加 `channel: release|prerelease` 与「安装指定版本」，成本低。

## 4. 对和鸣的 14 条增量设计（已并入规格）

| # | 来源 | 设计增量 | 落点 |
|---|---|---|---|
| N1 | Dify/Claude | 索引加生命周期字段：`status`、`deprecated`、`deprecatedReason`、`alternativeId`、`renames`、`channel` | 规格 §6.2 |
| N2 | n8n/VS Code | `GET /api/plugin-market?hostVersion=…` 服务端按 `engines` 过滤版本；客户端 `satisfiesEngines` 兜底 | 规格 §6.1/§6.2 |
| N3 | VS Code/Chrome | 已装插件在应用升级后不兼容 → **显式「不兼容」状态 + 禁用 + 说明当前/所需版本**，不静默失效 | 规格 §3.5/§5.5 |
| N4 | Chrome | 升级**新增网络主机 / 放宽 tools 上限 / 新增贡献类别** → 强制重新确认；拒绝则保留旧版（并给出回滚入口） | 规格 §5.3 |
| N5 | Dify | 安装事务拆 `prepare（预检/快照）→ persist（写存储）→ rollback（补偿动作显式清单）`；幂等 | 规格 §5.1/§5.2 |
| N6 | Figma/TUF/Sparkle | 签名信封 `Ed25519(JCS(manifest) ‖ sha256(pkg))`；`keyId` 多钥；换钥双签；吊销随版本下发 | 规格 §7.1 |
| N7 | TUF/VS Code | 防降级：记录每个 id 的**最高已装版本**，安装更旧版本需用户显式「降级」确认 | 规格 §5.3 |
| N8 | Claude/Dify | 命名保留：`heming.`/`heming-` 与官方市场名；`heming.*` 只接受首方签名；冒充即拒绝加载该市场 | 规格 §4.6 |
| N9 | Claude Code | 未知字段分层：顶层 strip + **警告**；`permissions`/`contributions[*]`/`meta` strict 报错 | 规格 §4.6（修订自检 F2） |
| N10 | VS Code 空白 | 贡献点冲突规则表：命令/技能名/MCP key/工具束 → 硬错误；页面/首页卡/设置卡 → 注册表独占 | 规格 §3.2 |
| N11 | Figma/Chrome/Electron | widget CSP 最小基线（`script-src 'self'`、`object-src 'none'`、禁远程脚本、`connect-src` 只白名单）+ 回归守卫用例；禁止 widget 嵌外部页面 | 规格 §7.3 |
| N12 | Claude Code | 声明合并语义写进 v5：技能/服务/工具束**按名追加或更新**，命令**按 id 替换**，删除即移除（现状按名匹配，需在规范里写明） | 规格 §4.5 |
| N13 | Chrome/VS Code | 预发布渠道 + 「安装指定版本」+ 版本选择器 | 规格 §6.3（阶段 C） |
| N14 | VS Code | 生效语义如实交代：声明式即时生效；bundle 启停/更新需重建窗口（UI 文案写明） | 规格 §5.5 |

## 5. 与 DSH 调研的合并判断

| DSH 结论 | 横向对标后的变化 |
|---|---|
| 统一贡献点 + 注册即撤销 | **加强**：Claude Code 证明「声明式贡献点表」足以承载 15 类能力，和鸣不必引入 cordis 运行时 |
| `engines` 下载前拦截 | **加强并改进**：改为「服务端过滤 + 客户端兜底」，并补「已装不兼容显式禁用」 |
| 引导式安装八步 | **加强**：Dify 的三段式事务更完整（含旧包恢复），补进和鸣事务 |
| 索引与生成器分离 | **加强**：Dify/Claude/n8n 三家一致；和鸣可直接用 Dify 字段表 |
| 「沙箱不是安全边界」 | **保留**：和鸣的 widget 是真隔离（独立 origin + sandbox），比 DSH 动态包强；但不能因此放松签名与权限 |
| 不照搬 cordis/npm/slot 代数 | **保持**：横向对标没有给出反例 |
| （新增）签名体系 | DSH 没有，但 Figma/Chrome/Dify/TUF 都有成熟最小方案 → 和鸣应做 L2，不必等 |

## 6. 证据缺口（明确未获取）

1. 本机 `web_search` 返回 401、`raw.githubusercontent.com` 被重置 → 部分结论来自官方文档镜像与 `api.github.com`，未做「线上页面」二次核对。
2. Claude Code 的 `marketplace.schema.json` 实测 404；「Claude Code 无宿主版本字段」是**逐字段核对后的文档结论**，不是绝对不存在。
3. VS Code Marketplace 是否已对公开市场强制签名、审核 SLA；Chrome Web Store 费用与 2FA 细节；n8n verified 的完整标准页未逐页拉取；Dify marketplace 后台生成器闭源（字段从 API 与实体模型反推）。
4. 专门的市场 UX 横向（7 家列表页/详情页截图级对照）本轮未完整完成；§3.3/§3.7 的字段结论来自官方文档与 API，不是 UI 像素级对照。
5. 未获取到任何生态的「恶意插件真实事故统计」，因此本文不引用未核实的安全事件（Obsidian CVE 有 NVD 编号，属可核实条目）。

## 证据来源

- `D:/_research/notes-x-declarative-marketplaces.md`（329 行）：Claude Code / Dify / n8n，含 Dify 市场 API 实调与 daemon 源码行号。
- `D:/_research/notes-x-vscode-chrome.md`（338 行）：VS Code 贡献点/激活/签名/兼容 + Chrome 权限/CRX3/商店审核。
- `D:/_research/notes-x-sandbox-trust.md`（410 行）：Figma/Obsidian/Raycast 沙箱与审核 + TUF/provenance/Ed25519 方案 + Electron 安全清单。
- `D:/_research/notes-dsh-plugin-system.md`、`notes-dsh-cordis-model.md`、`notes-heming-plugin-audit.md`：DSH 体系与和鸣审计（见另一篇 benchmark 文档）。
- 和鸣代码探针与实测数据：`docs/research/2026-11-08-plugin-upgrade-feasibility.md`。
