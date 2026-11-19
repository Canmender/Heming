# 模型页对齐原版 magpie：功能对照与实现说明

> 状态：已实施（模型页 / 来源页 / 智能体页）。
> 分区：d.357 起只留「来源 / 运行」两个页签——原来的「模型」页签内容落在**来源**末尾，
> 「智能体」页签内容落在**运行**里（`ModelTraceView` 之后）；下文 §1–§4 仍按能力分组描述。
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

## 1. 模型清单（来源分区末尾，`packages/web/src/components/model/ModelCatalogPanel.tsx`）

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

## 2. 本机智能体（运行分区里、调用轨迹之后，`ModelPage.tsx`）

| 原版 magpie 的行为 | 和鸣模型页现在的行为 | 背后的命令 |
| --- | --- | --- |
| 给智能体选模型（每个智能体一份） | 下拉按来源分组（`optgroup`），选项是「显示名（id）」；已禁用的模型置灰；末尾「自定义…」可手填 | `<agent> <provider/model>`、`<agent> default` |
| 每个智能体的可见模型范围 | 每行「可见模型 · 收窄到 deepseek、relay · 12 个可见，3 个被挡住」折叠区，勾选要暴露的来源后保存；勾满或不勾＝全部 | `visible`、`visible <agent> a,b`、`visible <agent> all` |
| 以后再出现的模型要不要自动露出 | 同一折叠区里的「只显示逐个挑过的模型」开关，勾上/取消立即生效 | `visible <agent> --only-picked` / `--show-new` |
| 下拉里只列这个智能体真正看得到的模型 | 下拉按该智能体的可见范围过滤（`rowsForAgent`），被挡住的不出现；行上会写「下拉只列它看得到的 N 个模型」；认不出来的收窄名字（家族/路由组已不存在）退回全部 | `visible` 的 names + `rowsForAgent` 本地过滤 |

- 写模型前有二次确认（会写进别的工具的配置，和鸣不替用户静默改）。
- `visible` 的解析在 `packages/web/src/lib/magpieVisible.ts`（`only models picked`、`N shown, M not` 都认）；过滤在 `packages/web/src/lib/modelCatalog.ts` 的 `rowsForAgent`。

### 2.1 备份与恢复：带上什么、覆盖什么

`packages/web/src/components/model/BackupPanel.tsx` 在运行分区末尾。内核的 flag **正反面不统一**，
命令行里很容易记反，所以页面按「这一块要不要」来勾，由 `packages/web/src/lib/magpieBackupParts.ts` 翻译成 flag。

| 内核默认（`vendor/magpie-core/internal/cli/backup_cmd.go`） | 页面行为 | 背后的命令 |
| --- | --- | --- |
| `backup` 默认**带** Key、**带**技能与 MCP 库、**不带**订阅/插件登录 | 三个勾默认「带 Key、带技能库、不带登录」，取消哪块加对应 flag，勾上登录才加 `--sign-ins` | `magpie backup [--no-keys] [--no-library] [--sign-ins] <file>` |
| `restore` 默认三样全恢复 | 确认框里三个勾默认全勾，取消哪块加对应 `--no-` | `magpie restore [--no-agents] [--no-library] [--no-sign-ins] <file>` |

- 面板里写一句人话再执行：「现在：带Key、带技能库、不带登录。」；恢复确认框里写「覆盖工具设置、覆盖技能库、覆盖登录；来源与账号总会恢复。」
  （`describeBackupParts` / `describeRestoreParts`）。
- flag 顺序固定（Key → 技能库 → 登录），路径永远在最后；测试 `magpieBackupParts.test.ts` 9 例断言了默认值、
  三种组合、顺序、以及「恢复这头没有 keys、备份这头没有 agents」。
- 勾选框的可访问名带前缀（`新建备份：来源的 Key` / `恢复：订阅与插件的登录`），因为两块可能同时出现在 DOM 里。
- 留白：口令仍在内核的交互面板里输入（`ConsolePanel`），页面不接管；内核没有 `backup --dry-run`，
  所以没有「先预览会写什么再决定」；定时自动备份也还没有——内核侧没有对应命令，页面不自己造。

## 3. 来源分区（`ModelPage.tsx` 的「高级」）

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
- 下面 §3.1–§3.4 这四组可选设置收在同一个「更多设置（可选）」折叠里（d.366 起）：来源行展开「高级」
  先只看见这一行，需要哪块展开哪块，四块各自带按钮、各发各的命令。之前它们各占一个折叠区，
  五个来源就是二十行折叠标题，把真正的模型 chip 挤下去了。
- 自定义请求头（d.368 起）是一块多行文本框：一行一个，写成「名称: 值」；**值留空就是删掉这个头**
  （内核 `header.X=` 的语义）。翻译在 `packages/web/src/lib/magpieSourceHeaders.ts` 的
  `parseHeaderLines`：分隔符认半角/全角冒号与等号，值里可以再有冒号；同一名字重复只留最后一个；
  看不懂的行在原地列出来，其余照发。控件是 d.368 新加的 `TextAreaField`
  （`packages/web/src/components/ui/Field.tsx`），和 `TextField` 共用 label / hint / error 语义。
- 读回现状（d.369 起）：展开「高级」时本来就会读一次 `provider show <id>`，现在顺带用
  `packages/web/src/lib/magpieSourceShow.ts` 的 `parseSourceShow` 把 `header` / `free` / `unmasked` /
  `refresh` / `include` 解析出来，写进 `showCache[id].flags`。页面因此在「更多设置」下多说一句
  「现在设着：…」（`describeShowFlags`，什么都没设时整句不出现），请求头那块多一个「拉下来改」
  把现有的头填回多行框。**`context=` 与 `family=` 内核 show 不打印**，这两项仍然只写不读。

### 3.1 路由分组：按模板建组、按需改设置

分组原本只有「名字 + 模型列表 + 策略」三格，等于要求用户先自己决定填哪些模型。内核早就有模板
（`vendor/magpie-core/internal/provider/grouptemplate.go:39 TemplateKinds` = smart / thrifty / steady，
id 由 `:243 TemplateIDs` 给成 `smart-split` / `cheap-first` / `never-stuck`），本轮把它接了出来：

| 内核能力 | 和鸣模型页现在的行为 | 背后的命令 |
| --- | --- | --- |
| 三套模板：难易分流 / 先用便宜的 / 不会卡住 | 「路由分组（可选）」里三个按钮，点一下直接建；名字沿用「分组名称」格子（留空则由内核起名，**被占用时内核自己编号，绝不替换现有组**） | `group template <smart\|thrifty\|steady> [name]` |
| `group set` 的十余个键（`groups_cli.go:420-590`） | 只收五个能一句话说清的：会话亲和 `stays`、是否列给智能体 `listed`、推理档谁说了算 `effort`、上下文 `context`、族标签 `family`；**只发用户改过的项**（空值等于把设置清回默认，那是另一件事） | `group set <id> stays=… listed=… effort=… context=… family=…` |
| — | 「应用设置」改的是「分组 ID」那一格填的组；没填 ID 或一项没选时按钮不可点 | 同上 |

- 参数生成在 `packages/web/src/lib/magpieGroups.ts`（`GROUP_TEMPLATES` / `groupTemplateArgs` /
  `GROUP_SETTING_FIELDS` / `groupSetArgs`），测试 `magpieGroups.test.ts` 覆盖「空值不发」「未知键忽略」
  「没 ID 不发」三种边界。
- **没收的键**：`weight` / `fast` / `pick` / `classifier` / `intent-sure` —— 它们要么要跟模型清单一起
  才对得上，要么要先选一个分类模型；塞进同一张表会变成「填了也不知道后果」，留给命令行。
- **做不到的**：参考实现有「组绑定点名账号」（`Group.Accounts`），但随桌面端发的这个内核
  `groups_cli.go` 里**没有 `accounts=` 这个键**（grep 零命中），所以本轮不做——等内核升上来再接。

### 3.2 来源调流：并发、排队、休息

参考实现的 Provider 编辑器里有一组「别把来源打爆」的开关。内核里它们不是 `provider set` 的键，
而是各自一条子命令（`vendor/magpie-core/internal/cli/providers_cli.go` 的 `atOnceCmd` / `rpmCmd` /
`queueCmd` / `quotaRestCmd` / `restCapCmd`），本轮接在来源「高级 → 调流（可选）」里：

| 内核能力 | 和鸣模型页现在的行为 | 背后的命令 |
| --- | --- | --- |
| 一次只上几个账号，其余排队（Discord #405 那条：三个 ZCode 账号一起上被拒） | 「同时用几个账号」下拉：不限 / 2 / 3 / 5 | `provider at-once <id> <n\|off>` |
| 每个账号每分钟最多几个请求（OpenRouter 免费模型常见 20） | 「每分钟请求」填数字 | `provider rpm <id> <n\|off>` |
| 每个账号排队几个、最多等几秒 | 「排队」填 `20` 或 `20:30`（长度:秒） | `provider queue <id> <len> [sec]` |
| 厂商说额度用完、又没说什么时候回来时歇多久 | 「额度用完后歇多久」下拉：15m / 30m / 6h / 1d / 回到默认 | `provider quota-rest <id> <dur\|default>` |
| 连续失败或被限流时最多歇多久 | 「连续失败最多歇多久」下拉：1m / 30m / 2h / 1d / 不歇 / 回到默认 | `provider rest-cap <id> <dur\|off\|default>` |

- 参数生成在 `packages/web/src/lib/magpieSourceTune.ts`（`SOURCE_TUNE_FIELDS` / `sourceTuneCommand` /
  `sourceTuneCommands` / `sourceTuneRejected`），测试 `magpieSourceTune.test.ts` 8 例覆盖
  「留空不发」「看不懂的点名」「一项一条命令」「没来源 ID 不发」。
- **一次只发改过的项，一项一条命令**：内核每个键各自校验，前一条失败不该挡住后面几条；
  留空是「这次不改」，和「改回默认」（下拉里的「回到默认/不改」之外的 `default` 项）不是一回事。
- **收的边界**：`quota-rest` 的「到每天某个时刻」（`until 08:00`）和按账号/按 Key 的
  `account-weight` / `account-concurrency` / `account-cap` 仍留命令行——它们要么要挑具体账号，
  要么要写时刻，塞进一个不分账号的表单会误导。

### 3.3 模型清单的规矩：列不列、什么时候刷、新模型怎么收

来源的模型清单不是加一次就定了：厂商会加新型号，有的来源只该经分组被选中、不该出现在
智能体的可选清单里。参考实现把这三件事放在 Provider 编辑器的 listing 区，本轮接在来源
「高级 → 模型清单（可选）」里，同样是三项各一条内核子命令：

| 想定的事 | 页面上的样子 | 背后的命令 |
| --- | --- | --- |
| 它的模型要不要出现在智能体的可选清单里 | 「列给智能体」下拉：列给智能体（默认）/ 只给分组用 | `provider listed <id> yes\|no` |
| 清单多久自己去拉一次 | 「多久自己刷一次清单」下拉：30m / 6h / 1d / 不自动刷 | `provider refresh-every <id> <30m\|6h\|1d\|off>` |
| 新模型 id 命中什么规则就自动收 | 「新模型自动收」输入框，空格或逗号分开，`*` 当通配 | `provider auto-include <id> <rule…\|none>` |

- 参数生成在 `packages/web/src/lib/magpieSourceModels.ts`（`SOURCE_MODELS_FIELDS` /
  `parseAutoInclude` / `sourceModelsCommands` / `sourceModelsSummary`），测试
  `magpieSourceModels.test.ts` 7 例覆盖「留空不发」「none 清空」「分隔符」「没来源 ID 不发」。
- 下拉首项是「不改」：页面不读当前值、也不猜默认值，免得一保存就把人家原来的设置覆盖掉。
- 收的边界：`refresh-every` 只在网关（`magpie serve` 或和鸣）跑着时生效，页面不另起定时器；
  「重新读取」按钮仍走 `provider refresh <id>`（另一处，不在这个折叠区里）。

### 3.4 它是什么：算不算免费、上下文多大、原文发不发

前两轮把「怎么发请求」和「清单怎么长」接上了，剩下的是一组描述来源本身属性的键——
它们都是 `provider set` 的键，所以四项合成**一条**命令，而不是像调流那样一项一条：

| 想定的事 | 页面上的样子 | 背后的命令 |
| --- | --- | --- |
| 这个来源怎么算钱 | 「这个来源怎么算钱」下拉：算免费（免费额度）/ 按价目收费 | `provider set <id> free=yes\|no` |
| 它实际能给多大上下文 | 「上下文带宽」输入框，`200000` / `200k` / `1.5m` 都行 | `provider set <id> context=<tokens>` |
| 给一组来源打个共同标签 | 「族标签」输入框（如 `fast`），规则里能按族挑 | `provider set <id> family=<tag>` |
| 发过去的话要不要脱敏 | 「原文照发」下拉：吃脱敏（默认）/ 原文照发（不脱敏） | `provider set <id> unmasked=yes\|no` |

- 参数生成在 `packages/web/src/lib/magpieSourceProfile.ts`（`SOURCE_PROFILE_FIELDS` /
  `parseTokensInput` / `sourceProfileRejected` / `sourceProfilePairs` / `sourceProfileCommand`）。
- `parseTokensInput` 与内核 `provider.ParseTokens`（`internal/provider/ruleparse.go`）同口径：
  只认 `200000`、`200k`、`1.5m` 这一类，下划线先去掉；页面先判一遍，看不懂的当场点出来、整条不发，
  不必等内核回 `tokens %q is not a length (200000, 200k, 1m)`。
- 「算免费」只是路由口径（Free first / Cheapest 会先挑它），价目与用量里的花费照旧按各家价格算；
  「原文照发」是这一家的账号收到的就是原文、不吃和鸣的脱敏，与别家共用的中转地址不建议开。
- 收的边界：`prompt=`（系统提示原样发）、`additional-tools=`、`user-agent=`、`search=`、
  `compaction=` 这几个更底层的键仍留在命令行——它们多半是某个端专用的排查开关，摆到页面上会误导。

### 3.5 停用与启用：先别用它，但什么都别删

删掉一个来源是「不留了」，用户真正想要的常常是「先别用它」——Key 还想留着、额度下周可能回来、
换一家对比两天。内核本来就有这个开关（`provider off <id>` / `provider on <id>`，Key 与模型记录都留着，
只是智能体拿不到它的模型、请求也不会走它），页面此前只有「删除」，没有中间那一档。

- 行上的按钮在「测试」旁边：「停用」→ `provider off <id>`，「启用」→ `provider on <id>`，都带 `refresh`；
  确认框只留给删除——停用是可逆的，不该再问一遍。
- 状态从 `magpie providers` 那行读出来：内核不给停用单独一列，只在那一行的说明里写一句
  `magpie provider on <id>`（`providers()` 的 `p.Off` 分支）。`parseProviders`
  （`packages/web/src/lib/magpieCli.ts` 的 `offHint`）认这句话里的 id **与本行 id 相同**，
  别家提到某个 id 不算——所以 `ProviderRow` 多了一个 `off`。
- 停用那行在名字后多一个「已停用」徽标，悬停说明「Key 与记录都留着，只是智能体拿不到它的模型」；
  停用时按钮只剩「启用」，不会同时出现两个相反动作。
- 收的边界：`listed no`（退出智能体清单、只经分组服务）是另一件事，仍在「模型清单」那组里；
  这里只管整家开/关。

### 3.6 端的小开关：搜索、压缩、User-Agent

同样是「来源自己知道怎么接」的三件事，内核都支持、`provider show` 又都读得回来，所以页面既写也读：

| 内核能力 | 页面行为 | 命令 |
| --- | --- | --- |
| 网页搜索由来源自己做（挂中转时） | 下拉「网页搜索由谁做」：by itself / 照客户端发的 | `provider set <id> search=yes\|no` |
| 上下文压缩交给来源（如 Codex 自己的） | 下拉「上下文压缩由谁做」：native / 由和鸣压 | `provider set <id> compaction=native\|magpie` |
| 请求带谁的 User-Agent | 下拉「请求带谁的 User-Agent」：智能体自己的 / 和鸣自己的 | `provider set <id> user-agent=agent\|magpie` |

- 参数生成在 `packages/web/src/lib/magpieSourceWire.ts`（`SOURCE_WIRE_FIELDS` / `sourceWirePairs` /
  `sourceWireCommand`），测试在 `magpieSourceWire.test.ts`：三项**合成一条** `provider set`，
  顺序 userAgent → search → compaction，值不在选项里的不发，没来源 id 就返回 `null`。
- 现状从 `provider show` 读：`magpieSourceShow.ts` 的 `LINE` 也认 `search` / `compaction` / `user-agent`
  三行，`describeShowFlags` 追加「搜索由来源做」「压缩交给来源」「带和鸣的 UA」；这三行**只在真设过时
  才出现**，没出现就是默认（照客户端发的 / 由和鸣压 / 智能体自己的 UA），所以「不改」确实是「这次不动」。
- 折叠里还写一句「现在：…UA · 搜索由来源做 · 压缩交给来源」，读的是同一份 show 缓存，不多发命令。
- 收的边界：`prompt=`（Antigravity 订阅原样发系统提示）、`additional-tools=` 是端专属且 show 读不回来，
  仍留命令行；订阅账号带 `user-agent=agent` 内核会报错（它本来就用自己的客户端），页面不做预判，让内核说。

### 3.7 轨迹里每一次尝试：落在谁身上、为什么没成

`/v1/magpie/trace` 的 `routes[].tries[]` 本来就带着每次尝试的结局（内核 `gateway.Try` 的 `id` / `status` /
`ms` / `ttft` / `firstText` / `fail` / `error`），页面此前只读 `id` / `status` / `ms`，把「换过账号」的理由丢了：

| 内核字段 | 页面怎么用 | 位置 |
| --- | --- | --- |
| `tries[].fail` / `error` | 「没成 —— 额度用完（insufficient_quota）」，有 fail 时 error 括起来 | `describeTry` |
| `tries[].ttft` / `ms` | 成功那条写「答上了（首字 320ms，共 1400ms）」 | `describeTry` |
| `tries[].done = false` | 「正在试」 | `describeTry` |
| `tries[].id` → `order[].who/name` | 试的是哪个账号/Key（`tryWho`，找不到就用 id） | 详情面板 |

- 类型与纯函数在 `packages/web/src/lib/magpieTrace.ts`（`TraceTry` 补 `ttft` / `firstText` / `fail` / `error`，
  新增 `tryWho` / `describeTry`），测试在 `magpieTrace.test.ts`。
- 渲染在 `packages/web/src/components/ModelTraceView.tsx` 的「请求详情」里：「试过谁、为什么没成」按顺序列出
  每一试，失败行标红；测试在 `ModelTraceView.test.tsx`。
- 收的边界：`Call.Fallback` 那句「哪些先失败了、为什么」仍在网关侧（`gateway.Call.Fallback`），现在用的
  是每次尝试自己的 `fail`，比那句更细；不另开接口。

### 3.8 收起时也看得出「这家改过」

请求头、算免费、原文照发这些只写在 `provider show` 里。以前要点开「高级」才读，于是收起的行上
永远看不出这家跟默认有什么不同，想知道只能逐条展开。

- 首屏 `providers` 一到位，就用 `flagsWarm`（`ref<Set<string>>`）逐家读一次
  `provider show`，写进同一份 `showCache`（一次一条，不跟首屏那几路抢）。
- 行上因此多一个「改过」徽标，悬停是 `describeShowFlags` 的整句（「这家跟默认不一样：请求头
  X-Trace；算免费；每 6h 刷清单」）；`describeShowFlags` 返回空串就不挂标。
- 代价与边界：一家一次 show（N 家 N 次，串行）；show 里没有的东西（`context=` / `family=` /
  `at-once` / `rpm` / `queue` / `quota-rest` / `rest-cap` / `listed`）标不出来——这些改没改，
  仍要靠展开时自己填的格子判断。

### 3.9 谁在用这一家：删之前先看一眼

内核 `providers` 的说明列里，`← Claude Code, Codex` 写的是「这几个智能体现在拿它的模型」。
页面此前把整列丢掉了，于是「这个来源还有人用吗」只能靠猜——删错一个正在用的来源，智能体那边
下一个请求就报错。

| 内核输出 | 页面 | 位置 |
| --- | --- | --- |
| `← Claude Code, Codex`（`providers()` 的 `r.uses`） | 行上加一句「← Claude Code、Codex」，悬停写「这些智能体现在用它」 | `parseProviders` 的 `usedByHint` → `ProviderRow.usedBy` |

- 同一列还挤着停用那句（`magpie provider on <id>`）与备用链（`⤷ a → b`），所以解析只取 `←` 到
  `⤷` 之间那段、按逗号拆；没写就是空数组（`packages/web/src/lib/magpieCli.ts`）。
- 测试：`magpieCli.test.ts`（谁在用 / 没有就是空数组 / 箭头之后的备用链不算 / 停用那句不算）、
  `ModelPage.test.tsx`（行上看得见）。

### 3.10 全部测一遍：换机器之后一家一家问「还通不通」

「已添加的来源」的标题旁有一个「全部测一遍」：按 `providers` 的顺序一家一家跑
`provider test <id>`，结论照旧写在各自那行（`通过 · 1.2 秒` / `连不上`，原因挂在悬停里），
最后在告警条里报一句「几家通、几家连不上」。

- 串行而不是并发：内核的 `provider test` 会真的发一个小请求，几路同时打出去既慢、又容易
  被对端限流，看不出真实结论。
- 复用行上的 `testProvider`（`packages/web/src/components/ModelPage.tsx`），单点「测试」与
  「全部测一遍」共用一套判定与文案；进行中按钮变「正在一家家测…」并禁用。
- 测试：`ModelPage.test.tsx`（失败时报「0 家通，1 家连不上」且行上是「连不上」；都通时只说
  「都通」，不说「0 家连不上」）。

## 4. 全局模型设置与看图/画图模型（`GlobalModelSettings.tsx`、`ImageModelSettings.tsx`）
原版 magpie 把这些放在 Settings › Models，和鸣放在**来源**分区末尾（可用模型清单之下）的「全局模型设置」「看图与画图模型」两个折叠区。

| 原版 magpie 的行为 | 和鸣模型页现在的行为 | 背后的命令 |
| --- | --- | --- |
| 智能体列表里的模型名带不带来源 | 「名字后缀」下拉：带来源 / 自己命名的原样 / 只写模型名 | `model suffix`、`model suffix on\|own\|off` |
| 上下文压缩：压到多少，或干脆跑满整个窗口 | 「压缩窗口」下拉 + 压缩点输入（如 500k） | `model compact`、`model compact on\|off\|<size>` |
| 给所有模型一个窗口上限 | 「窗口上限」输入（`off` / `200k` / `all`）+「关掉上限」——**只在 `magpie model` 的 usage 里出现 `model context-cap` 时才摆**（`supportsContextCap`）。随桌面端发的内核（magpie 0.1.3246-heming.d.107）不认识这条命令，所以真机上是隐藏的 | `model context-cap`、`model context-cap <size>\|off\|all` |
| Images：选一个「能看图的模型」给看不了图的模型描述图片（也可以关掉，带图的请求直接拒绝）、给它指定思考档、选一个「画图模型」给 `generate_image` | 「看图与画图模型」折叠区：「看图模型」下拉（只列目录里声明了图片输入的模型，首项「不指定」，第二项「关掉」）；「看图模型的思考档」下拉（选项来自选中的看图模型自己的 `reasoningLevels`，首项「用它自己的默认」）；「画图模型」下拉（选项来自 `/v1/models?kind=image`，网关没列出能画图的来源时退回手填）；清空即 `settings reset` | `settings get vision\|visionEffort\|imageGen --json`、`settings set vision\|visionEffort\|imageGen <值>`、`settings reset vision\|visionEffort\|imageGen`；画图模型清单走 `GET /v1/models?kind=image` |

- 解析在 `packages/web/src/lib/modelGlobals.ts`：只认第一条有效行（跳过 ANSI、`✓/✗`、`magpie …` 提示），
  所以「读当前设置」和「写完之后重读」用同一套解析，界面上显示的永远是刚读回来的值。
- 写成功后重读三项，不靠本地猜状态。
- 「能不能设窗口上限」以内核自己的 usage 为准（`supportsContextCap`，与「速度档」的 `supportsModelTier` 同一套做法）：
  内核不认识就整块不摆，也不再发一条注定回 `unknown command` 的命令——每次打开模型页都撞一次错误、界面上还有个保存必报错的控件，比少一个功能更糟。
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
- **候选链（`packages/web/src/components/RouteGroupsCard.tsx`）已删（d.384）**：那是本地
  「模型路由」页下线前的候选链编辑器，magpie 的路由组取代了它之后没有任何页面渲染它
  （只有它自己的测试），却和「路由分组」两套并存。留着会让人以为有两处能配候选链，
  所以连同测试一起删掉；`store/llm.ts`、`lib/llmRoute.ts`、`lib/llmHealth.ts` 是 ChatPage
  在用的，没动。
- 分组清单目前只能跑命令看：运行页「路由分组」里新增「看分组清单」（`magpie groups`），
  输出在页面底部。内核那份清单是给人看的表格（组名、ids、成员、谁在用），没有 JSON，
  这一轮不硬解析成卡片——解析错了比直接给人看原文更糟。
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
  负责那一行的版式；重读额度只走页头的「重读全部」（d.320 起卡片里那个「刷新额度」已删）：
  它先按账号与 provider 逐个发 `quota refresh <vendor>`（`accounts refresh` 只续登录令牌、不重读额度），
  再走整页重读，「切到这个」走 `accounts switch <agent> <user>` 并带二次确认。
- 国产智能体（国内站：WorkBuddy / Qoder CN / Trae CN / MiniMax Code / MiMo Code / ZCode；
  国际站：WorkBuddy AI / Qoder / MiniMax Code（国际））走「先装插件、再登录」（d.280、d.356）：
  内核的登录流只认 `claude`/`codex`/`copilot`/`gemini`/`antigravity`（`vendor/magpie-core/internal/provider/logins.go`
  的 `loginAgents`），国内端在 `internal/provider/migrate.go` 的 `retiredBuiltins` 里，账号由 `pluginOfAgent` 供给，
  所以 `packages/web/src/lib/magpieDomestic.ts` 只收录内核写明的包名（`@magpie-community/opencode-*-auth`）：
  `migrate_*.go` 里 movers 的 `pkg`，以及没有 mover、只在 `internal/provider/trae_checkin.go`、
  `internal/provider/minimax_checkin.go` 里写明插件包的 Trae CN（`trae-cn`）与 MiniMax Code（`minimax-code`、
  `minimax-code-global`）。不猜名字——猜错会被当成 npm 上的同名包装进来。
  卡片先 `plugin add <包名>` 再 `accounts add <agent>`，装没装以 `plugin list --json` 的 `providers[].id` 为准；
  「今日签到」走 `accounts checkin --json`（WorkBuddy/Qoder/Trae CN/MiniMax Code 与插件的 `auth.checkin`）；
  点数窗口（`windows[].amount`/`limit`/`unit: credits`）按点数说「剩 7,000 点」，不再只说百分比。
  9 张卡按 `DOMESTIC_GROUPS` 分「国内站 / 国际站」两组列，同一个包服务的两个站因此不会混在一排里；
  Trae 在 `internal/agent` 里没有 Agent 条目，所以它不做「本机已装」检测，MiniMax Code 有（`mcode`）。
- 首屏读两个分区都要的四路（`providers`/`ls`/`models disabled`/`visible`）加账号与设置；
  「来源」专用的那几路（`quota --json`、`quota history`、`quota auto-reset`（两条）、`plugin list --json`、
  `accounts discovery`）在落到「来源」时读一次（`sourcesWarm`）——d.357 起来源就是落地页，等于进页面就读，
  但只读一遍，重渲染与切换页签都不再打；页头「重读全部」是显式的重读入口。读之前先用 `lib/pageCache.ts` 的缓存画（d.321）。
- 额度走向的天数由用户在卡头选（7/14/30，`components/model/QuotaTrendCard.tsx` 的
  `TREND_DAY_CHOICES`）：`loadHistory(days)` 把它带进 `quota history --days n --json`，
  去重键是 `history:<天数>`，换档即重读（d.322）。
- `pnpm --filter @heming/web test`（vitest）：`ModelPage.test.tsx`、`modelCatalog.test.ts`、
  `magpieVisible.test.ts`、`modelGlobals.test.ts`、`modelSettings.test.ts`、`modelSpec.test.ts`、
  `modelTier.test.ts`、`providerModels.test.ts`、`magpieClient.test.ts`、`magpieDomestic.test.ts`、
  `components/model/ImageModelSettings.test.tsx`
  覆盖上述每条命令的拼装与回读。
- `pnpm --filter @heming/web typecheck`：`tsc --noEmit` 通过。
- 浏览器预览（无 `window.__heming_magpie`）下模型页只读、不显示「来源」tab，属预期。



