# 模型页对齐原版 magpie：功能对照与实现说明

> 状态：已实施（模型页 / 来源页 / 智能体页）。
> 对象：原版 magpie（`D:\testprogram\magpie-main (1)\magpie-main`）的 Providers / Models 管理体验。
> 原则：和鸣不复制 magpie 的 webview 界面，只让「模型管理」这件事的可做范围与结果一致；
> 每条能力都落到一条 `magpie-core` 子命令，UI 只负责把命令的结果摆出来、把参数拼对。

## 0. 为什么以 CLI 为准

原版 magpie 的界面是 `internal/gui/assets/app.js` 里手写的 webview 页面，模型相关的状态全部来自
`internal/gateway` 的模型对象与 `provider` 包：

- 网关 `GET /v1/models` 的每一条就带 `display_name`、`reasoning_levels`、`context_window`、
  `max_output_tokens`、`modalities`，本地请求还带 `pricing`（USD/**每 token** 的十进制字符串）。
- 改名、思考档、窗口/输出上限、图片输入、价格、禁用、可见范围都各有一条 `magpie model …` /
  `magpie visible …` / `magpie provider models …` 命令，改完立刻写进配置并被网关读到。

所以和鸣模型页的对齐方式是：**读网关目录 + 读 CLI 文本输出 → 渲染；用户操作 → 拼成同一条 CLI 命令**。
没有新增第二套状态存储，模型页看到的也就是智能体/网关正在用的。

## 1. 模型 tab（`packages/web/src/components/model/ModelCatalogPanel.tsx`）

| 原版 magpie 的行为 | 和鸣模型页现在的行为 | 背后的命令 |
| --- | --- | --- |
| 按来源分组列出模型，chip 上有显示名 | 按来源分组（`Avatar` + 来源名 + 个数），行上显示名（无则 id）+ id 副行 | `GET /v1/models` → `parseGatewayModels` → `buildModelRows` |
| 思考档、上下文窗口、输出上限、图片输入标签 | 「思考 low/high · 窗口 128K · 输出 8.2K · 图片输入」一行摘要 | 同上目录字段 |
| 每个模型的价格（每 1M in/out） | 「$0.15 入 / $0.6 出 · 每 1M token」 | 目录 `pricing`，`asPerMillion` 换算 |
| Model settings：改名、价格、思考档、窗口、API、图片 | 行内「编辑模型」展开：显示名 / 思考档 / 上下文窗口 / 最大输出 / 价格 / 请求协议 / 速度档 / 接受图片输入 | `model name`、`model spec --context/--output/--reasoning/--vision`、`model price`、`model api`、`model tier` |
| 右键 `Copy model ID` | 行上「复制模型 ID」（写系统剪贴板，1.5s 内显示「已复制」） | `navigator.clipboard` |
| 厂商的快速模式（provider 编辑器的 tier） | 编辑器里「速度档」下拉：快速 / 超快 / 常规速度 | `model tier <id> fast\|ultrafast\|usual` |
| 右键 `Test this model` | 「测试模型」 | `provider test <来源> <短名>` |
| Quick check 的「Test all · One real call each, at the provider's price」 | 面板右上「测试全部模型」→ 确认（每个模型都真的发一次请求，按厂商价格计费）→ 逐个串行测，进度「正在测试 3/7」，结束报「测试完 7 个模型：6 个通过，1 个失败」 | 逐个 `provider test <来源> <短名>` |
| 打开 Model settings 时显示「现在的值，以及哪些是你设的」 | 编辑器里「读取现在的设置」→ 填上窗口/输出/思考档/图片，并写一句「你自己设过：窗口、思考档」 | `model spec <p/m>`（`packages/web/src/lib/modelSpec.ts` 解析） |
| 右键 `Test as Codex` / `Test as Claude Code` | 编辑器里「按 Codex 测试」「按 Claude Code 测试」 | `provider test <来源> --as codex\|claude-code <短名>` |
| 关掉某个模型（Settings › Models 的 disabled 列表） | 行上「禁用模型」→ 确认 → 徽标变「已禁用」；折叠区「已禁用的模型（n）」可「启用」 | `model disable <id>`、`model enable <pattern>`、`model disabled` |
| 搜索 / 只看某个来源 | 「搜索模型」+「按来源筛选」 | 纯前端过滤（`filterModelRows`） |
| 模型没出现在网关目录时仍能管理 | 行上有「未在网关目录」徽标，编辑/禁用照旧可用 | `profiles` 为准，目录只补元信息 |

实现细节：

- `packages/web/src/lib/modelCatalog.ts` 是纯函数层（分组、搜索、能力摘要、价格行、禁用模式 glob 匹配），
  单测在 `modelCatalog.test.ts`。
- `parseDisabledModels` 认 `model disabled` 的两种输出：空态 `no model is disabled · …` 与
  `<pattern> · <命中模型>`；`matches no model magpie serves now` 记为「现在没有模型命中」。
- 编辑器保存按「名字 → spec → 价格 → 协议」逐条发命令，**一条失败就停**并把命令输出留在页脚的
  结果条里，不会出现「一半改了一半没改还显示成功」。

## 2. 智能体 tab（`ModelPage.tsx`）

| 原版 magpie 的行为 | 和鸣模型页现在的行为 | 背后的命令 |
| --- | --- | --- |
| 给智能体选模型（每个智能体一份） | 下拉按来源分组（`optgroup`），选项是「显示名（id）」；已禁用的模型置灰；末尾「自定义…」可手填 | `<agent> <provider/model>`、`<agent> default` |
| 每个智能体的可见模型范围 | 每行「可见模型 · 收窄到 deepseek、relay · 12 个可见，3 个被挡住」折叠区，勾选要暴露的来源后保存；勾满或不勾＝全部 | `visible`、`visible <agent> a,b`、`visible <agent> all` |
| 以后再出现的模型要不要自动露出 | 同一折叠区里的「只显示逐个挑过的模型」开关，勾上/取消立即生效 | `visible <agent> --only-picked` / `--show-new` |
| 下拉里只列这个智能体真正看得到的模型 | 下拉按该智能体的可见范围过滤（`rowsForAgent`），被挡住的不出现；行上会写「下拉只列它看得到的 N 个模型」；认不出来的收窄名字（家族/路由组已不存在）退回全部 | `visible` 的 names + `rowsForAgent` 本地过滤 |

- 写模型前有二次确认（会写进别的工具的配置，和鸣不替用户静默改）。
- `visible` 的解析在 `packages/web/src/lib/magpieVisible.ts`（`only models picked`、`N shown, M not` 都认）；过滤在 `packages/web/src/lib/modelCatalog.ts` 的 `rowsForAgent`。

## 3. 来源 tab（`ModelPage.tsx` 的「高级」）

| 原版 magpie 的行为 | 和鸣来源页现在的行为 | 背后的命令 |
| --- | --- | --- |
| Provider 编辑器里的模型 chip：加一个、减一个 | 「高级 → 模型」列出这个来源暴露的模型 chip，点 × 移除，输入框 +「添加模型」加一个 | `provider models <id> +id` / `-id` |
| `All models` / `Best in family` / `None` | 「全部」「每个系列只要最新」「暂时不下发模型」 | `provider models <id> all\|best\|none` |
| 重新拉一次厂商目录 | 「重新读取」 | `provider refresh <id>` |
| 模型目录地址、备用模型 | 「模型目录地址」「备用模型」+「保存备用」 | `provider set <id> models.url=…`、`provider fallback <id> …` |
| 分发策略、错误处理、请求头、耐心、换 Key、删来源、测试 | 同左（d.111 起已有） | `provider set`、`provider key`、`provider rm`、`provider test` |

- `packages/web/src/lib/providerModels.ts` 解析 `provider <id>` 输出里的 `models` 段
  （`2 exposed of 2 from … · fetched …` + 缩进的 `id  显示名`），并生成上面那些命令参数。
- 任何一条模型命令成功后都会重读一次 `provider <id>`，所以 chip、地址、套餐徽标同步更新。

## 4. 全局模型设置与看图/画图模型（`GlobalModelSettings.tsx`、`ImageModelSettings.tsx`）

原版 magpie 把这些放在 Settings › Models，和鸣放在模型 tab 底部的「全局模型设置」折叠区。

| 原版 magpie 的行为 | 和鸣模型页现在的行为 | 背后的命令 |
| --- | --- | --- |
| 智能体列表里的模型名带不带来源 | 「名字后缀」下拉：带来源 / 自己命名的原样 / 只写模型名 | `model suffix`、`model suffix on\|own\|off` |
| 上下文压缩：压到多少，或干脆跑满整个窗口 | 「压缩窗口」下拉 + 压缩点输入（如 500k） | `model compact`、`model compact on\|off\|<size>` |
| 给所有模型一个窗口上限 | 「窗口上限」输入（`off` / `200k` / `all`）+「关掉上限」 | `model context-cap`、`model context-cap <size>\|off\|all` |
| Images：选一个「能看图的模型」给看不了图的模型描述图片（也可以关掉，带图的请求直接拒绝）、给它指定思考档、选一个「画图模型」给 `generate_image` | 「看图与画图模型」折叠区：「看图模型」下拉（只列目录里声明了图片输入的模型，首项「不指定」，第二项「关掉」）；「看图模型的思考档」下拉（选项来自选中的看图模型自己的 `reasoningLevels`，首项「用它自己的默认」）；「画图模型」下拉（选项来自 `/v1/models?kind=image`，网关没列出能画图的来源时退回手填）；清空即 `settings reset` | `settings get vision\|visionEffort\|imageGen --json`、`settings set vision\|visionEffort\|imageGen <值>`、`settings reset vision\|visionEffort\|imageGen`；画图模型清单走 `GET /v1/models?kind=image` |

- 解析在 `packages/web/src/lib/modelGlobals.ts`：只认第一条有效行（跳过 ANSI、`✓/✗`、`magpie …` 提示），
  所以「读当前设置」和「写完之后重读」用同一套解析，界面上显示的永远是刚读回来的值。
- 写成功后重读三项，不靠本地猜状态。
- 画图模型不在默认目录里：`packages/web/src/lib/magpieClient.ts` 的 `fetchGatewayImageModels` 单独问 `?kind=image`（失败按「没有」处理，退回手填）。
- 看图/画图的读写与解析在 `packages/web/src/lib/modelSettings.ts`：`settings get` 的 JSON 字符串（空值是 `""`）与裸文本都认；`settings set` 不接受空值，所以清空走 `settings reset`。

## 5. 还没对齐的部分（明确留白）

- **Web search（Settings › Models 的 search 一段）**：`searcher`、`searcherThen`、`searcherEffort`、
  `searchFirst`、`replyModel` 这些键同样能走 `magpie settings`，但它们是搜索/回复的工具选择，
  不是模型本身的属性，本轮没做进模型 tab。原版 magpie 自己的 Settings › Models 里
  `searchList` / `searchMore` 两个容器在 `internal\gui\assets\index.html:444-447` 还在，
  但 `app.js` 里没有任何渲染它们的代码（`renderImages` 只填 `imagesList`），说明这一段
  在原版也已经收回到「工具与库」层面，没有对应的模型页控件可以照抄。
- **视频模型（`videoGen`）**：原版 GUI 的偏好里有 `videoGen`（`app.js:22911` 的 prefs 快照），
  但没有对应的 `settings` 键——`magpie settings list` 里只有 `vision`、`visionEffort`、
  `imageGen`、`imageTimeout`，所以画图/看图的 API 能对到视频也管不了。等内核把 `videoGen`
  暴露成设置键再加，代码位置与 `imageGen` 对称。
- **Test on account…**（指定订阅账号测试一个模型）：`provider test` 只有
  `--as codex|claude-code`，没有 `--account`；CLI 层拿不到「只让某个账号发这一次请求」。
  现在能按智能体协议测（上表），测不了按账号。
- **provider 模型排序 / 标签视图**（原版 chip 可拖排序、按 kind 打标签）：`provider models`
  只有 `+id` / `-id` / `all` / `best` / `none`，顺序跟着厂商目录；没有排序命令，也没有标签命令。
- `model alias`（把某个模型的用量算到另一个 id 上）是计费口径，不属于「模型设置」的视觉面；
  原版也藏在命令里，需要时用「运行 → 高级命令」直接敲。
- 用量页的按模型/按来源透视是 `ModelUsageView` 的另一套，不在此文档范围。
- 「速度档」依赖内核支持 `model tier`：参考源码（`internal\cli\model_cli.go:186` 的
  `case "tier", "speed", "fast"`）有，但本机随桌面端发布的 `magpie 0.1.3246-heming`
  报 `unknown command "tier"`。所以编辑器里的「速度档」是**按内核能力显示**的：页面加载时
  会跑一次裸 `magpie model` 取 usage，里面有 `magpie model tier` 才渲染这个下拉
  （`packages/web/src/lib/modelTier.ts` 的 `supportsModelTier`）。内核升级后按钮自动出现，
  不需要改模型页；不支持时不会摆一个保存即报错的控件。

## 6. 验证

- 订阅账号（来源 tab）的额度已经按内核 `accounts --json` 的真实契约渲染（d.279）：
  `packages/web/src/lib/magpieQuota.ts` 负责窗口名中文化、剩余百分比、色调、重置倒计时、
  读数时间与状态文案（全纯函数，`now` 由调用方传），`packages/web/src/components/model/SubscriptionRow.tsx`
  负责那一行的版式；「刷新额度」走 `quota refresh <provider>`（`accounts refresh` 只续登录令牌，不重读额度），
  「切到这个」走 `accounts switch <agent> <user>` 并带二次确认。
- 国内智能体（WorkBuddy / WorkBuddy AI / Qoder / Qoder CN / MiMo Code / ZCode）走「先装插件、再登录」（d.280）：
  内核的登录流只认 `claude`/`codex`/`copilot`/`gemini`/`antigravity`（`vendor/magpie-core/internal/provider/logins.go`
  的 `loginAgents`），国内端在 `internal/provider/migrate.go` 的 `retiredBuiltins` 里，账号由 `pluginOfAgent` 供给，
  所以 `packages/web/src/lib/magpieDomestic.ts` 只收录 `migrate_*.go` 的 `pkg` 包名（`@magpie-community/opencode-*-auth`），
  卡片先 `plugin add <包名>` 再 `accounts add <agent>`，装没装以 `plugin list --json` 的 `providers[].id` 为准；
  「今日签到」走 `accounts checkin --json`（WorkBuddy/Qoder/Trae CN/MiniMax Code 与插件的 `auth.checkin`）；
  点数窗口（`windows[].amount`/`limit`/`unit: credits`）按点数说「剩 7,000 点」，不再只说百分比。
- `pnpm --filter @heming/web test`（vitest）：`ModelPage.test.tsx`、`modelCatalog.test.ts`、
  `magpieVisible.test.ts`、`modelGlobals.test.ts`、`modelSettings.test.ts`、`modelSpec.test.ts`、
  `modelTier.test.ts`、`providerModels.test.ts`、`magpieClient.test.ts`、`magpieDomestic.test.ts`、
  `components/model/ImageModelSettings.test.tsx`
  覆盖上述每条命令的拼装与回读。
- `pnpm --filter @heming/web typecheck`：`tsc --noEmit` 通过。
- 浏览器预览（无 `window.__heming_magpie`）下模型页只读、不显示「来源」tab，属预期。



