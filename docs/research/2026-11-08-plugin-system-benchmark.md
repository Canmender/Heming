# 插件体系对标调研：DeepSeek Harness vs 和鸣

> 调研日期：2026-11-08
> 对象：官方仓库 [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness)（commit `fcc0ad46`，release `dsh-0.2.2-rc.1`）与和鸣 `D:/Heming`（`feat/d103-plugin-system`，HEAD `9c4bfd2` / `d.103.2.42.0`；该分支同时有另一并行会话的模型页重构提交）。
> 方法：浅克隆官方仓库后只读源码 + 官方文档 + `.agents/notes` 决策记录；和鸣侧做代码级审计。所有关键论断带 `path:line` 证据，证据索引见附录 A。
> 本文只回答「官方怎么做的、和鸣差在哪、哪些能借」。**升级契约与实施计划见 `docs/superpowers/specs/2026-11-08-plugin-system-upgrade.md`。**
> 跨生态（VS Code / Chrome / Claude Code / Dify / n8n / Figma / Obsidian / Raycast）的横向对标见 `docs/research/2026-11-08-plugin-ecosystem-cross-reference.md`；可实现性自检见 `docs/research/2026-11-08-plugin-upgrade-feasibility.md`。

## 0. 结论速览

1. **DSH 的插件不是清单，是对象**：一个导出 `apply(ctx, config)` 的模块，加载即执行；`ctx` 是唯一能力入口，没有特权内核，产品每一部分都是插件。
2. **DSH 的整套能力建立在一个硬约束上：注册即副作用（effect）**。`ctx.on` / 服务注册 / 各 registry 的 `register()` 都返回 disposer，卸载时逆序回卷。于是「停用 / 热更 / 卸载 / 失败回滚」是同一套机制，而不是四种实现。
3. **DSH 分三层实体**：Cordis plugin（执行单元）→ bundle（npm 分发单元，带声明式 patch 层）→ profile（组装单元，有序层叠加）。插件不 import 主应用，只经服务与事件通信，因此插件升级面与主程序内部 API 解耦。
4. **DSH 对装了插件的风险是诚实的**：manifest 里**没有** per-plugin 权限清单，「装插件 = 在本机跑代码 = 与 bash 同级」；沙箱（vm/闭包）官方三处明写「是 API 纪律，不是安全边界」。防护做在**动作级闸门**（安装/启停要求全权限或本次批准、构建脚本单独批准），而不是伪造能力 ACL。
5. **和鸣不是「一套插件系统」，是四套并行机制**（声明式 v1–v3 / 界面插件 v4 bundle / 内置模块 / 云端静态目录），只共享「插件区」这一个 UI 壳；模型、存储、信任与生效点都不同。
6. **和鸣的扩展性缺口是同一个病根**：页面 / 导航 / 首页卡 / 设置卡 / 后台任务 / 生命周期在代码里都是联合类型或硬编码分支（G1–G7），没有第三方可注册的通用缝——因为**没有「贡献点」这个概念**，加一种能力要改四处。
7. **和鸣的清单没有版本兼容字段**：DSH 用 `engines.dsh` 在**下载前**挡住不兼容版本；和鸣靠 `schemaVersion` 人工判断，zod 对未知字段静默 strip，结果是「装完不报错、但新字段全丢」的半可用态。
8. **安装语义可以整套照抄**：DSH 是「先 inspect 再安装 → 失败/取消恢复文件 → 分类失败原因 → 装完再让用户启用 → 区分 changed 与 application」。和鸣现在是「解析即装」，技能先写、服务后写、`save()` 静默吞配额错误，存在半装态。
9. **市场格式要尽早标准化**：DSH 的索引包含本地化标题/描述/图标/分类/标签/排序键/每版本 `engines`/详细介绍文档，市场页因此能离线渲染；和鸣的目录只有 id/名称/版本/权限计数，没有图标、分类、详情与版本兼容，市场页只能退化成清单。
10. **不该照搬的也很清楚**：不要把 Cordis 的进程内服务图、双面构建、5 种 slot 基数、pnpm/profile/allowBuilds 那套包管理复杂度搬进来；和鸣的「声明式 + 官方沙箱界面插件」路线是对的，缺的是**统一贡献契约**与**安装/分发/兼容的工程化**。

---

## 1. 调研对象与方法

| | DeepSeek Harness | 和鸣 |
|---|---|---|
| 形态 | 通用 agent harness，Web/桌面/CLI/SDK 多入口 | 原生桌面智能体工作台（Electron + 云端服务端） |
| 插件可执行代码 | 是（cordis 插件 + npm bundle） | 否（声明式包），唯一例外是**官方**界面插件（`widget://` 沙箱） |
| 插件来源 | npm / Git / tarball / 本地路径 / 用户自配插件索引 | 手贴 `plugin.json` / 云端静态目录 |
| 信任模型 | 宿主内全权限，动作级审批 | 内容指纹 + TOFU 签名 + 用户确认 + 权限声明（只收紧） |
| 生态规模 | 23 个 `dsh.bundle`、90 个 `dsh.client` 包 | 仓库内 1 个声明式示例 + 1 个界面插件（桌宠） |

方法说明：官方仓库 20,665 个文件，采用「文档/决策记录定方向 + 源码定事实」读法；和鸣侧按「清单 → 存储 → 物化落点 → 界面 → 服务端」五段读代码，并对照 `docs/PLUGINS.md` 找文档-代码不一致。本文只保留能落到行动上的结论，纯实现细节（如 tar 解析、窗口状态机）不在此展开。

---

## 2. DSH 插件体系拆解

### 2.1 三层实体：执行单元 / 分发单元 / 组装单元

| 层 | 是什么 | 证据 |
|---|---|---|
| Cordis plugin（执行单元） | 导出 `apply(ctx, config)` 的对象（或 `Service` 子类），可选 `inject` 与 `Config` | `docs/cordis-tutorial/01-first-plugin.zh.md:16-21`、`docs/user/develop/basic/index.zh.md:105-138` |
| bundle（分发单元） | npm 包，`package.json` 的 `dsh.bundle.patch` 指向一个/一组 YAML patch，往配置树插入插件行 | `packages/util/package-manifest/README.zh.md:46-56`、`docs/user/develop/basic/publish.zh.md:16-64` |
| profile（组装单元） | `$DSH_HOME/profiles/<name>/` 下的 `package.json`（`dsh.profile.bundles` 有序列表）+ `cordis.patch.yml` + 锁文件 + 兼容豁免 | `packages/boot/app-boot/README.zh.md:52-60` |

一句话：**bundle 只贡献「配置 + 该配置引用的模块」，profile 按「bundle 层 < 用户层 < 启动 overlay」叠层组合**。同一份安装通过不同 profile 变成 web/headless/sdk 应用；patch 按行 id 整段替换 `config`（不做深合并），所以「用户层覆盖 bundle 层」是结构性保证。

### 2.2 运行时模型：effect、fiber、inject、事件、配置

- **注册即可逆副作用**：`ctx.effect(fn)` 的返回值是 disposer；`ctx.on`、`ctx.plugin(child)`、服务注册、registry `register()` 都已经自动绑定 effect，不需要手写清理（`docs/cordis-tutorial/02-lifecycle-and-effects.zh.md:86-92`）。
- **生命周期是状态机**：`PENDING → LOADING → ACTIVE`，LOADING 可落 `FAILED`；`ACTIVE → UNLOADING → DISPOSED`。**没有 onReady/onDispose**——「就绪」就是 `apply` 执行到该行，「释放」就是 disposer（`docs/user/develop/framework/index.zh.md:7-24`）。
- **依赖声明而非 import**：`inject: ['tools']`，缺 provider 时静默停在 PENDING；provider 卸载会连带卸载依赖方、恢复后重载（`docs/cordis-tutorial/03-services.zh.md:52-78`）。
- **事件有 5 种分发模式**（emit / parallel / serial / bail / waterfall），模式是公开契约；waterfall 不调 `next()` 即否决，是策略拦截的标准写法（`docs/cordis-primer.zh.md:19-39`）。
- **配置 schema 校验后注入**：普通字段变更=整插件重挂，`.volatile()` 字段可原地热改（`docs/cordis-tutorial/05-config.zh.md:5-95`）。
- **失败隔离靠分级名单**：required 行失败拒绝启动，可选行失败只 warning；`apply` 抛错 = fiber FAILED。官方不假装同进程插件之间能互相隔离（`.agents/notes/implemented/architecture/2026-09-09-consumer-owned-startup-strictness.zh.md:13-23`）。

### 2.3 贡献点：插件能往产品里加什么

官方给了一张「功能 → 机制」的权威映射（`docs/architecture.zh.md:150-173`、`docs/cookbook/extension-cookbook.zh.md:108-136`）。摘要：

| 想加的东西 | 机制 | 冲突/覆盖规则 |
|---|---|---|
| 模型可见工具 | `ctx.tools.register()` | 同 layer 重名抛错；per-agent 覆盖全局 |
| 工具策略拦截 | `tools/pre-execute` waterfall / `ctx.tools.guard()` | waterfall 重排、guard 单调拒绝 |
| 用户命令 | `ctx.commands` 注册表 | 重名抛错 |
| 后台任务/调度、provider | 各自服务（`ctx.schedule`、`ctx.llm` 等） | 同服务 key 一个提供方 |
| 提示词段/上下文 | `ctx.systemPrompt.section()`、`agent.inject()` | 有排序与作用域覆盖 |
| Web UI | `ctx.slots`（类型化 slot） | 未声明 slot 抛错；priority 遮蔽；卸载递归收回 |
| 设置卡 / 插件详情扩展 | `settings.section`、`plugins.detail.actions\|badge\|section` | 按 `subject` 渲染，无话可说返回 null |
| 侧栏/会话区域入口 | `sidebar.panellist`、`conversation.view` | 用户可 pin/hide，顺序不可调 |
| Chat 行 | `conversation.chat.node` 按 `kind` 注册视图 | 一个 kind 一个视图 |

**最重要的不是清单长，而是它是统一的**：新增一种贡献 = 新增一个注册 API（带 disposer），UI/生命周期/冲突规则自动继承。

### 2.4 安装 / 启用 / 更新 / 卸载与失败语义

官方把「引导式安装」写成了一条可照抄的时序（`packages/boot/plugin-manager/README.zh.md:50-77`、`.agents/notes/implemented/architecture/2026-09-15-guided-plugin-installation.zh.md:13-23`）：

1. `inspect(spec)`：先搞清楚 spec 指向什么（包名/版本/描述/是否声明 bundle），**不是 bundle 就在安装前拒绝**，不跑包管理器。
2. 快照 `package.json` + `pnpm-lock.yaml`。
3. 平台与版本检查（`dsh.bundle.platforms`、`engines.dsh`）——不满足则 `incompatible-version`，**一个字节都不下载**。
4. 安装（`requestId` 流式转发日志、每个注册表一次 `attempt`）。
5. 若包管理器拦下依赖构建脚本 → 返回 `pendingBuilds`，等用户「允许这些脚本并重试」（授权=以宿主用户权限执行命令）。
6. 成功 → 追加进 `dsh.profile.bundles`，但**默认 `enabled: false`**。
7. 交给 HMR 重组合：`application ∈ {applied, restart-required, overridden, failed}`。
8. 任一步失败 → 按步骤恢复快照，报告 `step` + 诊断。

三条容易忽略但很值钱的语义：

- **`changed`（磁盘改没改）与 `application`（生没生效）分开报告**，`restart-required` 必带原因（`no-hmr` / `package-moved` / 待处理模块）。
- **装完不自动启用**：完成画面给「立即启用」，让人先看到装了什么。
- **取消属于管理器**：`cancelInstall(requestId)` 只在子进程退出且文件已恢复后才应答；断掉的 RPC 不算确认。

### 2.5 市场与索引格式

官方明确「**索引**与**索引生成器**分离」：DSH 只定义并读取一种 JSON 索引格式，谁生成索引、基于哪份源列表，由生成器决定；**不内置任何索引源**，用户自己配 URL（`docs/user/guide/plugin-market.zh.md:5-34`）。

索引里放的是「列表页要显示的全部东西」：本地化标题/描述/图标、作者、主页/仓库、分类/标签/排序键声明、可用版本、每版本 `engines.dsh`、发布时间。理由写在决策记录里：如果索引只有包名，客户端每渲染一行就要发一次请求，慢且易部分失败（`.agents/notes/implemented/feature/2026-10-02-plugin-market-index-format.zh.md:9-17`）。

两个诚实的边界：

- **索引没有签名**：索引内容是索引的声明，实际安装什么由已安装的 manifest 决定（`packages/boot/plugin-market/README.zh.md:127`）。
- **没有插件签名/发布者身份体系**：安装信任来自 npm/lockfile integrity 与（可选）git commit 锁定；`未找到证据`表明 DSH 有插件级签名、SBOM 或 per-plugin 权限校验。

### 2.6 信任与安全：官方立场原文

- 「已安装的 Host 代码在宿主进程内运行，不受工作区沙箱限制」（`packages/boot/plugin-manager/README.zh.md:31`）。
- 「沙箱隔离全局变量，但不是安全边界……对待动态包要像对待 bash 访问一样」（`packages/extensions/cordis-host-runner/README.zh.md:62`）。
- 客户端 runner 的 guard 注释：「This is API discipline, not a security boundary」（`packages/extensions/cordis-client-runner/src/client/guard.ts:20-21`）。
- 会话沙箱（read-only / workspace-write / danger-full-access）**只约束文件系统效果、只作用于子进程**，对宿主进程内的插件无效（`docs/subsystems/sandbox.zh.md:11`）。

结论：DSH 把风险**前移到「是否批准这次动作」**，而不是给插件发权限令牌。三道闸门分别是：管理工具要求全权限或单次批准、依赖构建脚本单独批准、带浏览器半的动态包需人类审批。

### 2.7 开发者体验与官方踩坑

- 三条路径：源码内改插件（`--patch` overlay + HMR）、做成可分发 bundle（目录三件套 + `dsh plugin add`）、会话内创作（Creator 模式：inspect 工具读真 API + skill 模板 + install 工具 + 审批）。
- 没有脚手架 CLI；脚手架就是 skill 里的 `templates/decoration`、`templates/mcp`。
- 官方踩过的坑：清理时序（并发 disposer 导致 provider 已释放、消费者还在用，被列为 P0 并记录 5 条生产路径）、首代浏览器 loader 两层揉在一起（无卸载/重载路径、样式永不移除）、`this` 绑定导致 effect 落到错误 fiber、服务把 `Context` 泄漏给沙箱代码、slot 基数不够用反复加 kind。

这些坑的价值：**运行时化的收益（热更、无重启卸载、失败回滚）不是白来的，代价是所有权与时序纪律**。和鸣若引入，必须把「注册返回 disposer / 逆序释放 / 异步清理串行化」写成硬约束，否则会重复付学费。

---

## 3. 和鸣现状：四套并行机制

| | 声明式插件（v1–v3） | 界面插件（v4 bundle） | 内置模块（4 个） | 云端目录 |
|---|---|---|---|---|
| 声明物 | `plugin.json` | `plugin.json` + `package.tgz` | TS 常量数组 | 服务端目录里的字节 |
| 安装者 | web `pluginStore.install` | 主进程 `widgetStore.install` | 不需要安装 | 无（服务端只读） |
| 存储 | `heming.plugins.v1` + 技能池 + MCP 注册表 | `userData/plugins/**` | `heming.modules.v1` | `<HEMING_PLUGIN_DIR>/<id>/<version>/` |
| 生效点 | 技能路由 / 工具注入 / 命令面板 / 目录归属 | widget 窗口 + preload + CSP + 托盘 | 导航 / 页面 / 首页卡 / 后台循环 / 工具前缀 | 插件区「仓库」Tab 与安装弹窗 |
| 信任 | 内容指纹 + TOFU 签名 | sha256 + 结构守卫 + 二次确认 | 无（随应用发布） | 目录 sha256 + 一把共享发布密钥 |
| 第三方可否 | 可 | 名义上仅官方（**代码里无发布者白名单**） | 不可 | 可发布 |

关键结构事实（证据见附录 A）：

- 清单唯一入口 `parsePluginManifest`（`packages/web/src/lib/plugins/manifest.ts:1252`）：zod 校验 + 中文错误 + 字段路径；**未知字段被静默丢弃**（`manifest.ts:1250`）。v4 只服务界面插件，bundle 只允许 `commands` + `desktopWidgets`。
- 物化不是第二套系统：插件技能就是普通技能（带 `pluginId`），插件 MCP 就是普通服务（id `plugin:<id>:<key>`、`origin:"plugin"`）。权限上限 `permissions.tools` 是**执行期**过滤（`toolCeiling.ts:41-50`），这是和鸣做得比 DSH 更细的地方（DSH 没有 per-plugin 权限）。
- **事务性不足**：先查服务 id 冲突，但技能循环写完再写服务；`save()` 静默吞配额错误 → 可能「本次会话可用、重启后归属丢失」。
- 界面插件边界是真的：独立 origin `widget://<id>/<path>`、`sandbox+contextIsolation`、最小 preload、按清单生成 CSP、`widget:*` IPC 按 sender 自校验。
- 但「只允许官方目录」**没有代码级白名单**：签名可选，实际门是「谁拿到 `HEMING_PLUGIN_PUBLISH_KEY`」+ 用户点一次确认。
- 内置模块不可安装、不可第三方：编译期常量 + 联合类型；停用只下线入口/循环/工具，不删数据。
- 已知不一致：服务端响应头 `X-Plugin-Package-Sha256`，客户端读 `x-plugin-sha256`；下载上限 20MB 与目录允许 40MB 不一致；bundle 版 `commands` 被清单接受但不物化。

---

## 4. 差距矩阵

| 维度 | DSH | 和鸣 | 差距性质 |
|---|---|---|---|
| 扩展单元 | 统一：一切都是插件，能力=ctx 服务 | 四套并行机制，只共享 UI 壳 | **架构级**（本次升级主目标） |
| 贡献点 | 注册 API + disposer，20+ 类型 | 固定四类数据贡献 + 一个界面插件类型；页面/设置卡/首页卡/后台任务写死 | **架构级** |
| 生命周期 | fiber 状态机；注册即 effect；热更/卸载/回滚同一机制 | 四个布尔动作（安装/启用/停用/卸载）；无钩子 | 机制级 |
| 版本兼容 | `engines.dsh` + 平台声明，下载前拦截；精确豁免需 `acceptRisk` | 无 `engines`；靠 `schemaVersion` 人工判断；未知字段静默丢弃 | 契约级（**建议优先补**） |
| 安装事务 | inspect → 快照 → 装 → 组合；失败恢复、分类诊断、取消属于管理器 | 解析即装；技能先写服务后写；`save()` 静默失败；无回滚 | 工程级（**建议优先补**） |
| 市场 | 用户自配索引；本地化元数据/图标/分类/标签/排序/每版本兼容/详情文档 | 静态目录，仅有 id/名称/版本/权限计数；无图标/分类/详情/版本列表 | 产品级 |
| 信任 | 动作级闸门；不假装沙箱是安全边界 | 权限声明只收紧 + 沙箱界面插件；bundle 无发布者白名单；TOFU 可自造身份 | 需要**结构性**补强 |
| 开发者体验 | overlay+HMR / bundle 三件套 / Creator 模式 + inspect 工具 | 手写 JSON；无 schema 文件、无 lint、无脚手架、无本地调试路径 | 工程级 |
| Agent 参与 | 模型有 `plugin_manager` / `plugin_market` 工具（需全权限/批准） | 无（`self_*` 工具只改记忆/技能/MCP） | 产品级差异点 |

**病根判断**：和鸣的 G1–G7（第三方不能加页面/导航、无生命周期钩子、无设置卡、无首页卡、无后台任务、命令 target 封闭、bundle 形态单点）看似七个独立缺口，其实是同一个：**没有「贡献点」这一层抽象**。有贡献点，七个缺口变成「注册一种新贡献」；没有，就永远要改四处。

---

## 5. 可借鉴 / 需改造 / 不照搬

### 5.1 可直接借鉴（机制层，改造成本可控）

1. **统一贡献注册表 + 注册即可逆**：和鸣不需要 cordis，只需要「每种贡献的注册函数返回撤销句柄」。启停/更新/卸载 = 逆序撤销，不再各写一套。
2. **`engines` 版本兼容 + 下载前拦截**：manifest 加最小应用版本，安装/目录展示两侧都判定；不兼容不出现在「可安装」列表里。
3. **引导式安装的八步时序**：inspect → 快照 → 兼容检查 → 写 → 生效 → 报告；失败回滚、`changed` 与 `applied` 分开、装完再启用。
4. **索引格式（市场 v2）**：本地化标题描述、图标、分类/标签/排序键、每版本 `engines`/指纹/发布时间、详细文档。索引与生成器分离，服务端只出静态数据。
5. **显式依赖声明**（`requires` 的插件版）：内置模块已有 `requires`，声明式插件也应能声明「需要某贡献/某插件」；缺失时进「等待中」并给 UI 状态，而不是静默不生效。
6. **首方 bundle 的代码级门禁**：官方签名公钥内置到应用，验签失败拒绝安装——把「只允许官方」从事后纪律变成结构保证（否则一旦开放设置卡等界面贡献，风险立刻放大）。
7. **Agent 侧的市场/安装工具**：只读检索 + 安装预览（走 HITL），是「智能体工作台」定位的差异化能力；DSH 已经证明模型能参与插件管理，且必须走审批。

### 5.2 需要改造（不能原样搬）

1. **包管理抽象**：DSH 把 npm/pnpm/lockfile/注册表镜像/allowBuilds 全暴露给用户；和鸣应保持「单一插件源 + 一份索引」的窄抽象，不引入包管理器。
2. **版本比较**：和鸣是 5 段版本 `d.特性.破坏性.修订.构建`，不是 semver。`engines` 必须自定义最小版本比较（按 5 段数值比），不能用 semver range。
3. **slot 体系裁剪**：DSH 5 种基数 × 3 种 scope 是为大型多团队前端设计的。和鸣先做 `single`（设置卡/首页卡位）+ `list`（列表项/命令）+ 固定 scope 即可，保留「owner 声明子槽位」的所有权规则。
4. **沙箱语义重定义**：DSH 的沙箱只管子进程文件效果。和鸣若要求「插件不得读某些文件」，必须做能力级 ACL 或进程隔离，不能复用会话沙箱语义。
5. **上架元数据要一次性定标准**：否则市场页会退化成读 README。和鸣现在恰好缺这一层，补的时机最好是在插件数量还是个位数时。
6. **审批通道必须可缺席（fail-closed）**：DSH 无应答者时审批返回 `unavailable` 并失败关闭。和鸣的 headless/浏览器场景同样要默认拒绝。

### 5.3 不建议照搬

1. **不要把 Cordis 的进程内服务图搬进来**：那意味着插件作者要懂 TS 声明合并、effect 所有权、双面构建；和鸣的插件作者画像是「写 JSON 的产品/集成方」，不是框架工程师。
2. **不要把 `node:vm` 当安全边界**：官方自己都写「不是 containment」。
3. **不要照抄 `allowBuilds` 的构建批准体验**：那是 npm 生态特有复杂度（pnpm 拦截、workspace yaml、git 托管键、SSH 提示泄漏到 UI）。
4. **不要复制「90 个包即插件」的仓库组织**：那是大型 monorepo 的产物，和鸣照搬会得到永久的包数量约束。
5. **不要做「一套插件两种生命周期」**（动态包 + 已安装包）：官方已经因此收敛过一次，和鸣不要重踩。
6. **不要给插件开放新增会话事件类型/自由写会话**：会破坏回放、迁移与 E2E 红线。
7. **不要依赖「插件包签名」作为唯一安全承诺**：签名解决来源，不解决行为；必须配合能力声明、沙箱与审批。

---

## 6. 对升级的 7 条设计原则

1. **先统一，再加功能**：本次升级的第一价值不是「第三方能加页面」，而是「能力单元只有一种注册方式」。功能面扩展放在统一之后，否则会再造第五套机制。
2. **统一在契约层，不统一在存储层**：现有 `heming.plugins.v1` / `heming.modules.v1` / `userData/plugins` 不动，新增一个**只读投影**（Unit + Contribution）供列表、诊断、命令面板共用。零迁移风险，将来再谈存储合并。
3. **权限与信任只收紧**：所有新贡献点默认对第三方关闭；官方 bundle 才允许界面型贡献；权限上限继续在执行期过滤；HITL 判定链一字不改。
4. **每个贡献都有「撤销」**：新注册表从第一天就返回 disposer；停用/更新/卸载走同一撤销路径。这条不做，热更和回滚永远是补丁。
5. **不兼容要提前说**：`engines` 在目录、预览、安装三处判定；不确定时不装，而不是装完再猜。
6. **安装要么全成要么全不成**：先算计划再写，失败回滚；`save()` 的静默失败必须变成可见失败。
7. **诚实报告状态**：插件页要能回答「为什么它没生效」（停用/依赖缺失/超权限未注入/不兼容/半装风险），而不是只显示一个灰色开关。

---

## 附录 A：证据索引

### A.1 DSH（`D:/_research/deepseek-harness`）

| 论断 | 证据 |
|---|---|
| 插件最小形态与三种形态 | `docs/cordis-tutorial/01-first-plugin.zh.md:16-21`、`docs/user/develop/basic/index.zh.md:105-138` |
| 注册即 effect / 逆序回卷 | `docs/cordis-primer.zh.md:13`、`docs/cordis-tutorial/02-lifecycle-and-effects.zh.md:86-92` |
| fiber 状态机（无 onReady/onDispose） | `docs/user/develop/framework/index.zh.md:7-24` |
| 依赖 inject 与 PENDING | `docs/cordis-tutorial/03-services.zh.md:52-78` |
| 事件 5 模式 / waterfall 否决 | `docs/cordis-primer.zh.md:19-39` |
| 配置 schema 与 volatile | `docs/cordis-tutorial/05-config.zh.md:5-95` |
| 贡献点映射表 | `docs/architecture.zh.md:150-173`、`docs/cookbook/extension-cookbook.zh.md:108-136` |
| slot 所有权与基数 | `docs/subsystems/slots.zh.md:19-79` |
| 安装八步与失败语义 | `packages/boot/plugin-manager/README.zh.md:50-77`、`:179-197` |
| `changed` vs `application` | `docs/subsystems/boot.zh.md:21` |
| 版本兼容 `engines.dsh` 与豁免 | `packages/util/package-manifest/README.zh.md:54-56`、`packages/boot/plugin-manager/README.zh.md:79` |
| 市场索引格式 | `.agents/notes/implemented/feature/2026-10-02-plugin-market-index-format.zh.md:13-140` |
| 索引无签名 | `packages/boot/plugin-market/README.zh.md:127` |
| 沙箱不是安全边界 | `packages/extensions/cordis-host-runner/README.zh.md:62`、`packages/extensions/cordis-client-runner/src/client/guard.ts:20-21` |
| 装插件=宿主进程跑代码 | `packages/boot/plugin-manager/README.zh.md:31`、`SAFETY.zh.md:9-23` |
| 清理时序 P0 | `.agents/notes/proposed/architecture/2026-10-09-cordis-cleanup-dependency-lifetimes.zh.md:9-57` |

### A.2 和鸣（`D:/Heming`）

| 论断 | 证据 |
|---|---|
| 清单唯一入口 / 未知字段静默丢弃 | `packages/web/src/lib/plugins/manifest.ts:1250-1252` |
| v4 只服务界面插件 | `packages/web/src/lib/plugins/manifest.ts:963-985` |
| 权限上限执行期过滤 | `packages/web/src/lib/plugins/toolCeiling.ts:41-50`、`packages/web/src/lib/capability/providers.ts:24-30` |
| 安装顺序与半装风险 | `packages/web/src/lib/plugins/store.ts:615-758`、`:857-863` |
| widget 沙箱边界 | `packages/desktop/plugin-window.js:302-317`、`packages/desktop/widget-preload.js:30-83`、`packages/desktop/app-protocol.js:251-291` |
| 内置模块是编译期常量 | `packages/web/src/lib/modules/registry.ts:20,58-113`、`packages/web/src/lib/modules/store.ts:20` |
| 云端目录只存字节 | `packages/server/src/pluginCatalog.ts:23-34`、`packages/server/src/app.ts:116-154` |
| 响应头名不一致 | `packages/server/src/app.ts:270` vs `packages/web/src/lib/plugins/catalogClient.ts:186` |
| 缺口 G1–G7 逐条证据 | `D:/_research/notes-heming-plugin-audit.md` §7 |
| 不变量 10 条 | `D:/_research/notes-heming-plugin-audit.md` 附录 C |

### A.3 过程笔记（本次调研产物，暂存仓库外）

- `D:/_research/notes-dsh-plugin-system.md`（379 行）：DSH 插件体系全景（实体/安装/运行时/贡献点/UI/安全/开发体验/设计取舍）。
- `D:/_research/notes-dsh-cordis-model.md`（328 行）：Cordis 机制与开发模型（骨架/生命周期/DI/事件/配置/slot/组合隔离/成本）。
- `D:/_research/notes-heming-plugin-audit.md`（447 行）：和鸣代码级审计（四套机制、数据流、8 个缺口、测试盘点、红线）。
