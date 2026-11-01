# InfoHub · 信息中枢

本地优先的 QQ / 微信消息采集与查看器。所有数据只留在这台电脑上，不联网、不上传。

## 它解决什么

你现在的工作信息分散在 QQ 群、私聊和微信里：通知、文件、待办、@事项每周都在增加。
InfoHub 把两边的消息**增量**收进一个统一归档库，让你可以在一个窗口里：

- 按会话浏览完整上下文（QQ + 微信并排出现在同一个列表里）
- QQ 图片/表情包在气泡里直接预览缩略图（点开看原图或视频），文件消息点名字直接打开原文件，语音点开 `.amr`
- **语音全部转文字**：本机 SenseVoice 模型把语音转成中文文本写进正文，搜索能搜到语音内容；音频原件复制进 `data/media/voice`，QQ 清缓存也不丢
- 从消息里识别截止时间/报名/会议/活动，汇总成按日排布的「日程」，点一条直接跳到原消息；识别默认交给大模型，失败自动回退本地规则
- 日程可导出 `.ics` 导入手机/电脑日历
- 把日程、待发通知候选、聊天文件和图片写进 Obsidian 知识库（标记区块 + 候选池 + 带索引的自包含归档）；**图片归档统一压成 ≤1600px / JPEG 80**，1.9GB 的原图档案可缩到几百 MB
- 全局搜索所有历史消息
- 看到采集状态：什么时候同步的、新增了多少、哪里失败
- **每小时智能体流水线**：整点自动跑「采集 → AI 分析 → 入库 Obsidian → 日程/通知 → 企微推送」五步；QQ 消息归为工作、微信消息归为生活，分别写进 `学院事务/消息归档` 与 `个人生活/消息归档`，再生成分门别类的简报推到企业微信

## 采集方式（与风险边界）

| 来源 | 方式 | 账号风险 |
|---|---|---|
| 微信 | `wechatauto-replica` 只读解密本地 `db_storage`（需微信登录并在后台运行） | 无网络行为，等同于本地读文件 |
| QQ | 只读解密 QQNT 自己的 `nt_msg.db`（SQLCipher），直接读本地消息库 | 不注入、不 Hook、不自动发送，等同本地读文件 |

QQ 侧不再依赖 QCE / NapCat：InfoHub 在 QQ 登录状态下从进程内存里只读取出数据库密钥，
把 `nt_msg.db`（含 `-wal` 未落盘增量）解密到临时目录读取，读完即删；密钥只留在内存。
QQ 没有登录或数据库没打开时拿不到密钥，这一轮同步会记为失败并在下一轮自动重试。
旧的 QCE 导出仍可用：把 `qq.mode` 改成 `qce` 就会回到文件夹扫描模式。

QQ 的图片/文件不下载、不复制：元素里自带内容 md5（图片/表情/语音/视频）或原始落盘路径（文件），
InfoHub 按 md5 到 QQ 自己的 `nt_data` 下找对应的本地缓存（`Pic/<月>/Ori`、`Emoji/emoji-recv`、
`Emoji/personal_emoji`、`Ptt/<月>/Ori`、`Video/<月>/Ori`），只记录路径和尺寸，界面直接引用 QQ 的原文件。
QQ 清理过缓存的历史图片会退回 `[图片]` 占位，不会去服务器补拉。

语音是例外：凡是能找到本地音频的语音，都会复制一份到 `data/media/voice/<md5>.amr`
（本机 143 条约 1.6MB），再用本机 SenseVoice 模型转写，转写文本写进消息正文（`[语音] 文本`）并进入检索。
模型和转写全程在 CPU 上本地完成，音频不出本机。

## 快速开始

```bat
cd /d D:\wohaolei
.venv\Scripts\python.exe -m pip install -e .
.venv\Scripts\python.exe -m infohub
```

首次启动会自动生成 `config.json` 并探测微信数据目录。确认无误后点「同步全部」。

命令行：

```bat
:: 全量同步一次
.venv\Scripts\python.exe -m infohub sync

:: 只看微信 / 只看 QQ
.venv\Scripts\python.exe -m infohub sync --source wechat
.venv\Scripts\python.exe -m infohub sync --source qq

:: 全文检索
.venv\Scripts\python.exe -m infohub search 免检单
.venv\Scripts\python.exe -m infohub stats

:: 日程：默认看过去 30 天（逾期）+ 未来 14 天
.venv\Scripts\python.exe -m infohub agenda
.venv\Scripts\python.exe -m infohub agenda --days 30 --overdue 60

:: 先重扫全部消息再输出（改了提取规则时用）
.venv\Scripts\python.exe -m infohub agenda --rebuild

:: 导出日历文件 / 机器可读输出
.venv\Scripts\python.exe -m infohub agenda --ics data\agenda.ics
.venv\Scripts\python.exe -m infohub agenda --json

:: 写进 Obsidian 知识库（日程区块 + 通知候选池 + 聊天资源归档）
.venv\Scripts\python.exe -m infohub kb
.venv\Scripts\python.exe -m infohub kb --days 14 --no-media

:: 语音：首次先下模型（约 230MB），之后同步会自动增量转写
.venv\Scripts\python.exe -m infohub voice --download
.venv\Scripts\python.exe -m infohub voice
.venv\Scripts\python.exe -m infohub voice --rebuild --limit 20

:: 小时简报：看最近一小时（默认写 Obsidian），加 --push 直接发出去
.venv\Scripts\python.exe -m infohub digest
.venv\Scripts\python.exe -m infohub digest --hours 6 --markdown
.venv\Scripts\python.exe -m infohub digest --push

:: 智能体流水线：同步 → AI 分析 → Obsidian 入库 → 日程 → 推送
.venv\Scripts\python.exe -m infohub agent
.venv\Scripts\python.exe -m infohub agent --run --hours 14
.venv\Scripts\python.exe -m infohub agent --run --no-push --quiet
.venv\Scripts\python.exe -m infohub agent --run --plan sync,analyze,archive

:: 每日通知：汇总班级公共事务成可转发格式（界面开着时默认每天 17:00 自动推送）
.venv\Scripts\python.exe -m infohub notice
.venv\Scripts\python.exe -m infohub notice --push
.venv\Scripts\python.exe -m infohub notice --no-ai

:: 推送通道自检（先填好 config.json 的 push）
.venv\Scripts\python.exe -m infohub push --test

:: 大模型（可选）：看配置、试连接、跑一份真实分析报告
.venv\Scripts\python.exe -m infohub llm
.venv\Scripts\python.exe -m infohub llm --test
.venv\Scripts\python.exe -m infohub llm --report 24
.venv\Scripts\python.exe -m infohub llm --summary "今晚 21:00 前交报名表"
.venv\Scripts\python.exe -m infohub digest --no-ai

:: 企微智能机器人长连接后台（界面启动时会自动拉起）
.venv\Scripts\python.exe -m infohub bot
.venv\Scripts\python.exe -m infohub bot --send "**测试**"
.venv\Scripts\python.exe -m infohub bot --stop
```

`sync` 结束后会自动增量整理日程；界面右上角「日程」按钮等价于 `infohub agenda` 的 30 天/14 天视图，「简报」按钮是最近一小时的小时简报，「智能体」按钮看流水线进度并手动跑一遍，旁边「推送到手机」手动发一次。

## 智能体：5 分钟同步 + 整点分析

程序开着的时候，智能体分两档运行：

- **每 `agent.sync_interval_min` 分钟（默认 5）**：只跑 `sync` 拉一遍 QQ / 微信新消息并刷新会话列表；不跑 AI、不写入 Obsidian、不推送，也不写运行日志（避免日志被刷屏）
- **每 `digest.interval_min` 分钟（默认 60）**：跑完整流水线

完整流水线由一个极简运行时驱动：每步是一个工具，按 `agent.plan` 顺序执行，单步失败不中断后续步骤，结果写进 `data/agent/runs/` 的 JSON 日志，界面右上的「智能体」面板能看到每一步的状态与耗时。

| 步骤 | 工具 | 做什么 |
|---|---|---|
| 1 | `sync` | 增量同步 QQ / 微信 |
| 2 | `analyze` | 生成简报 + AI 分析报告（输入按 QQ=工作、微信=生活 分组） |
| 3 | `archive` | 把本条窗口的消息按来源写入 Obsidian 两份归档，附带对应域的分析段落 |
| 4 | `agenda` | 把已识别的日程与通知候选导出到 Obsidian（识别在 `sync` 步骤做） |
| 5 | `push` | 把带 AI 分节的企业微信 Markdown 推给你 |

归档落点（同一小时重跑会覆盖同一文件，不会重复堆叠）：

```
D:\Obsidian\学院事务\消息归档\2026-10-30\0900-1000 工作.md
D:\Obsidian\个人生活\消息归档\2026-10-30\0900-1000 生活.md
```

- QQ 只进「工作」，微信只进「生活」；每份文件只带自己那一侧的 AI 分节（`工作 ·` / `生活 ·`）
- 营销群、虚拟会话按 `kb.DEFAULT_AGENDA_EXCLUDE` + `kb.agenda_conv_exclude` 过滤；群昵称里的手机号打码成 `188****8231`
- 单会话最多 30 条、单文件最多 600 行，按时间从旧到新截断，避免刷屏
- 想临时跳过入库或推送：`agent.archive = false` / `agent.push = false`，或用 `--no-archive` / `--no-push`
- `agent.enabled = false` 时退回旧的小时简报（只有统计和报告，不写归档）

```bash
infohub agent                 # 看计划与最近一次运行
infohub agent --run           # 立即跑一遍（默认回看 digest.hours）
infohub agent --run --hours 14 --json
```

小时简报的内容：

- **要处理**：这一小时新识别出的日程、@我的消息、24 小时内到期的日程（已逾期的不重复刷）
- **会话动态**：按消息量排序的会话与最后一句有效内容（`[表情]` 之类的占位会被跳过）
- **通知候选**：够格的通知原文（和 Obsidian 候选池同一套判定）
- **资源与 24 小时**：新图片/文件/语音、语音转写条数

落点：Obsidian `学院事务/班级管理/InfoHub-小时简报.md`，只保留最近 24 条，新条目在上；手动内容写在标记块外面不会被碰。
关掉程序超过一小时再打开，下一份简报会把空档一次补齐（最多回看 24 小时）。

推送（`push`）三选一：

| 通道 | 需要填 | 说明 |
|---|---|---|
| 企业微信智能机器人 | `push.channel = "wecom_bot"` + `push.wecom_bot_id` + `push.wecom_bot_secret` | 官方 SDK 长连接（`wss://openws.work.weixin.qq.com`），主动推到和机器人的单聊；**要先在企微里给它发过消息**，markdown 单条 ≤4096 字节 |
| 企业微信机器人 | `push.channel = "wecom"` + `push.wecom_webhook` | 在企业微信群里加「群机器人」，复制 webhook 地址即可；markdown 单条 4096 字节，超出自动截断 |
| 邮箱 SMTP | `push.channel = "smtp"` + `smtp_host/smtp_port/smtp_user/smtp_pass/mail_to` | QQ 邮箱：`smtp.qq.com:465`，`smtp_pass` 填**授权码**（邮箱设置里开启 SMTP 后生成），不是登录密码 |

- 密码可以不放配置文件：设环境变量 `INFOHUB_SMTP_PASS`（另有 `INFOHUB_SMTP_USER`、`INFOHUB_MAIL_TO`、`INFOHUB_WECOM_WEBHOOK`、`INFOHUB_WECOM_BOT_ID`、`INFOHUB_WECOM_BOT_SECRET`）
- 群机器人怎么拿：企业微信里建一个内部群（只有自己也行：拉两个人建群再把人移出），群设置 → 群机器人 → 添加 → 复制 Webhook；群消息提醒记得对手机开着
- 机器人限制（按官方口径）：markdown 单条 ≤4096 字节、text ≤2048 字节（中文一个字 3 字节），每个机器人每分钟最多 20 条；markdown 只认标题、加粗、链接、行内代码、引用和 info/comment/warning 三种字体色，表格要 `markdown_v2`，超出会按字节截断
- 为什么不走「自建应用消息」：那条路要 corpId + secret + agentId，而且调用方出口 IP 必须先进「企业可信 IP」，配可信 IP 又要求先有可信域名或公网回调地址；家庭宽带 IP 还会变，对本地桌面程序不划算

### 智能机器人长连接（`wecom_bot`）

同一个 Bot 只能有一条长连接，新连接会把旧连接顶掉，所以 InfoHub 把它做成**单实例后台**：界面、CLI、定时任务都通过本机 `127.0.0.1:8765` 让它代为发送。

```bash
infohub bot                 # 看状态；没起来就顺手拉起后台
infohub bot --json          # 原始状态（pid / connected / chat_known / last_seen）
infohub bot --send "**测试** 一条 Markdown"
infohub bot --stop
infohub bot --serve         # 前台跑（内部拉起后台时用这个）
```

- **第一步必须你主动发消息**：在企微里找到这个机器人，发任意一句「你好」。后台收到后记住会话并回一条连接确认；在此之前没有 chatid，主动推送会失败并提示先发消息
- 后台状态：`data/wecom_bot.json`（chatid、chat_type、上次收发时间、本机调用令牌），日志 `data/wecom_bot.log`
- 界面启动时如果 `push.channel = "wecom_bot"` 会自动拉起后台，状态栏显示「企微：已连接 / 待你发消息 / 后台离线」
- 长连接断了会自己 5 秒后重连，心跳 30 秒；本机 HTTP 端口每 60 秒同步一次状态
- 频率限制：每个会话 30 条/分钟、1000 条/小时；单聊请求会串行发送
- 令牌只管本机：`/send`、`/shutdown` 需要 `data/wecom_bot.json` 里的 token，只监听回环地址
- Bot Secret 等同于机器人密码，别贴到公开地方；泄露了去企微后台重置
- 没配置时不会尝试发送：界面上点「推送到手机」会直接说还差哪一项（如「smtp_pass（QQ 邮箱授权码）」）并提示去「设置」填写；`infohub push --test` 同样会列出缺失项
- 凭据填好但 `push.enabled = false` 时，点「推送到手机」会问一次要不要打开，确认后写回 `config.json` 再发送
- 只有这一处会联网，而且发的是你自己邮箱/企业微信；聊天原文仍只在本机
- 关掉推送：`push.enabled = false`；关掉整点生成：`digest.enabled = false`；`digest.toast` 控制右下角通知

整点简报就是「消息总结」：只要 InfoHub 界面开着，每 60 分钟自动生成一版并推到这个企微会话；某个小时没有新消息时不发（想强制发就把 `push.send_empty` 设为 true）。界面关掉后不再自动推送，只保留后台代发能力。

企业微信消息按紧急度分档、日程跨档连续编号，每条独占一行，不再把整段对话塞进一条：

```text
**InfoHub 简报 · 10-31 09:00–10:00**
> 新消息 470（微信 398 / QQ 72） · 22 个会话 · @我 2

**已逾期（1）**
> <font color="warning">1. 10-30 20:00</font>｜策划案和 PPT（活动指导部工作群）

**今天（2）**
> <font color="warning">2. 17:00</font>｜报名截止（经济学院26级新生群）
> <font color="warning">3. 20:00</font>｜网考模拟测试（十七届市场调查分析大赛本科）

**明天（1）**
> 4. 09:00｜学院例会（金融2601班群）

**未来 7 天（1）**
> 5. 11-04 全天｜治保月报表（经院生活委员治保群）

**之后（1）**
> 6. 11-09 全天｜月报表交回（经院生活委员治保群）

**@我**
> 陈羽熙（市调赛）：看群里的表

**AI 分析报告**

**工作**
> **结论**：……
> **待办与截止**
> · 领表并私信潘原伊

**生活**
> **动态**：……

**会话**
> 市调赛 · 微信 · 165 条 · @我
> 周康 · 微信 · 84 条

**资源**：图片 5
```

- 分档：已逾期 / 今天 / 明天 / 未来 7 天 / 之后；每档标题带条数，超过 24 小时的旧截止不再重复推
- 日程跨档连续编号（`1.`、`2.`……），说「第 5 项」就能直接对上；逾期和当天用警示色
- 会话只报名称、来源和条数，不贴最后一句，避免消息变成一大段
- 单条仍控制在 4096 字节内，超出从末尾（资源、会话）开始截断

## 每日通知（17:00 班级公共事务）

界面开着时，每天到 `notice.time`（默认 17:00）自动把「未来 14 天未完成的日程 + 近 3 天工作类会话里的通知原文」整理成一份可以直接转发到班群的纯文本，走上面配置的推送通道；同一天只发一次，失败后隔 10 分钟再试。

```text
金融2601 每日通知（10 月 26 日）

1、团风采大赛
请各班于 11 月 5 日前把参赛作品和报名表交给学习委员，逾期不再受理。

2、市场调查分析大赛（重要）
报名截止 10 月 31 日 17:00，院校代码 202609271202325585，经济学院学生报名费由学院承担。
```

- 生成流程：先让大模型合并同主题、按截止时间排序、补上截止时间 / 材料 / 同学要做的动作；模型不可用或输出不合格式时退回规则拼接（标题会粗糙一些，正文仍来自原文）
- 过滤：只取 `kb.notice_conv_keywords` + `notice.conv_keywords` 命中的会话（金融2601班群、秘书处、经院体委等），叠加营销群排除名单；已经在日程里出现过的原文先剔掉，避免同一条写两遍
- 单条上限 4000 字节（企微 4096 字节），超了从最后一条开始丢；日程跨条目按截止时间从近到远排序
- 正文另存 `data/daily/YYYY-MM-DD.txt`；发送状态在 `data/daily/sent.json`（`sent` / `empty` / `failed` / `ready`）
- 推送通道没配置时只在状态栏提示，不生成半成品；配好后次日自动发送，当天也可以手动 `infohub notice --push`
- 设置页「企业微信 / 推送」里能改发送时间、落款班级、最多条数、是否用 AI；`notice.enabled = false` 关闭
- AI 走的是和简报同一个接口，仍然只上传整理后的文字材料，不上传聊天原库、图片和文件

```bash
infohub notice                 # 只生成并打印，不推送
infohub notice --push          # 生成并推送
infohub notice --no-ai         # 跳过模型，按规则拼接
infohub notice --json
```

## 应用内设置

右上角「设置」直接改推送和大模型，不用手写 JSON：

![设置 · 企业微信](data/shots/settings_push.png)

- **企业微信 / 推送**：启用推送、通道（智能机器人 / 群机器人 / SMTP）、Bot ID 与 Secret（密码框）、本地端口、Webhook、SMTP 账号；旁边实时显示后台状态（已连接 / 待你发消息 / 后台未运行 / 未填凭据），可一键「重启后台」
- **测试推送**用当前表单里的值发一条测试消息，不保存；机器人凭据有改动时会提示先保存再测
- **大模型**：启用 AI 分析报告、接口地址、模型名、API Key、超时、额外要求；「测试连接」会发一句「只回复：ok」验证链路
- 保存后写入 `config.json`；改了 Bot ID / Secret / 端口或通道会顺手重启本地长连接后台，状态栏会显示「正在重启后台…」
- 环境变量仍然优先于界面里的值（`INFOHUB_WECOM_BOT_ID`、`INFOHUB_LLM_*` 等），界面上会给出提示

![设置 · 大模型](data/shots/settings_llm.png)

## AI 分析报告（可选）

简报可以多一块「AI 分析报告」：模型读的是**按来源分组的原始消息**（QQ = 工作、微信 = 生活，每会话最多 20 条），按五段输出——**工作 · 结论 / 工作 · 待办与截止 / 工作 · 通知与风险 / 生活 · 动态 / 生活 · 待办与提醒**。文本、Markdown、HTML、Obsidian 和企微消息都会带上；空的段自动省略，不会出现「无」占位。旧的「结论 / 待办与截止 / 重要通知 / 风险提醒」四段输出也仍能解析。走 OpenAI 兼容的 `/chat/completions`，不新增依赖。

- 默认指向本机 Ollama：`http://127.0.0.1:11434/v1` + `qwen2.5:7b`。装好 Ollama 后运行 `ollama serve`、`ollama pull qwen2.5:7b`，在设置里勾「启用 AI 分析报告」即可
- 接口地址填 OpenAI 兼容的 **`/v1` 级地址**（如 `https://api.deepseek.com/v1`），程序会自己拼 `/chat/completions`；误把完整地址粘进来也能识别
- **OpenCode Go 订阅**：地址用 `https://opencode.ai/zen/go/v1`（不是 `/go`，也不是 Zen 的 `/zen/v1`）。网关要求 `x-opencode-session` 请求头，程序对 `opencode.ai` 会自动带上；DeepSeek 这类推理模型会先输出 `reasoning_content`，`max_tokens` 太小会被推理吃光，代码里已按 1800 预留
- **默认只允许本机/内网地址**：填外部地址（OpenAI、DeepSeek 等）必须显式勾选「允许把简报内容发到该地址」，否则保存会被拦下
- 只发当小时的简报文字，不发图片、文件和聊天原库；`llm.max_chars` 控制单次最多送多少字
- 失败不影响简报：未配置或请求失败时简报照常生成，只是没有 AI 段，界面里会用红字标出原因；`digest --no-ai` 可跳过
- 常见报错已翻成中文：余额不足（402）、Key 无效（401）、地址不对或被 Cloudflare 拦（403/404）、限流或免费额度用完（429）
- 环境变量：`INFOHUB_LLM_BASE_URL`、`INFOHUB_LLM_MODEL`、`INFOHUB_LLM_API_KEY`
- CLI：`infohub llm` 看当前配置（API Key 只显示是否已设置）、`--test` 试连接、`--report 24` 用最近 24 小时真实消息生成一份报告、`--profile` 打印系统提示词、`--summary "一段文字"` 把给定文本交给模型总结

### 系统提示词（身份 / 人物 / 群聊语境）

每次生成报告前，会先给模型一段系统级背景，再附上分来源的报告要求。内置档案是按本机归档实证整理的，可在设置页「系统提示词」里整段改写，或点「恢复内置」还原；留空 = 使用内置。

- 身份：付梓杨，武汉轻工大学经济学院金融学 2026 级，金融2601班长（兼体育委员、治保委员），院学生会秘书处干事
- 人物：叶老师（2026 级辅导员）、周康（导学员）、卓思晓（副班长）、宋佳琦（团支书）、张航（组织委员）、黄皓雨（学习委员）、伍霭玲（秘书处负责人）、陈思雨（活动指导部部长）、唐楷淇/鲁至文（主席团）、潘原伊/谭乔月（学建部）、陈羽熙/陈梓琦/黄梦怡（市调赛队友）、陶奕如（金融2603班长）等
- 群聊语境：金融2601班群、秘书处大家庭、26 级班团群、市调赛、活动指导部、生活委员治保群
- 依据来自归档里的班团任免公示、群名片、@我 记录和群内分工，姓名与职务可用 `--profile` 直接核对
- **隐私**：档案只存在本机 `config.json`；用外部接口时它会和简报一起发送，不勾选「允许发到该地址」则不会发出

## 写进 Obsidian 知识库

`kb` 把 InfoHub 已经整理出来的东西落到 `D:\Obsidian`（路径可配），三处产物：

| 产物 | 落点 | 规则 |
|---|---|---|
| 消息归档 | `学院事务/消息归档/<日期>/<时段> 工作.md`、`个人生活/消息归档/<日期>/<时段> 生活.md` | 智能体每小时写入；QQ → 工作、微信 → 生活；按会话列消息，带该域 AI 分析段落；同小时重跑覆盖 |
| 自动日程 | `学院事务/日程安排.md` | 只在 `<!-- infohub:agenda:start/end -->` 之间写入；逾期 3 天 + 未来 30 天；手写章节一字不动 |
| 通知候选池 | `学院事务/班级管理/InfoHub-通知候选.md` | 近 7 天工作类会话里别人发的通知，按天列出；勾选状态跨次保留；只当候选，不自动改通知清单 |
| 资源归档 | `知识库/学院事务/附件/InfoHub/<年-月>/` + `知识库/学院事务/InfoHub-资源索引.md` | 文件和图片按内容哈希去重复制进库；图片统一压成 ≤1600px / JPEG 80；索引页分文档/图片/语音三节，列出大小、来源会话、发送人、时间和语音转写 |

- 图片压缩：归档前用 Pillow 生成 ≤1600px、质量 80 的 JPEG 预览，缓存于 `data/media/preview/`（源文件没变不重复压）；如果压完反而更大就继续用原图。早期按原图归档的图片会在下一次导出时就地转成预览版，改档案前会先把清单备份成 `kb_manifest.backup.json`
- 重复导出是幂等的：内容没变就不写文件（`updated` 与「本次扫描」行不计入比对）；源文件没变时直接复用上次的哈希，不重复读盘
- 通知候选只做候选：消息需含「截止/报名/提交/会议/缴费/名单/材料…」等强信号，疑问句、闲聊、本人发言、营销群会被过滤；含「助学金/身份证/名单/成绩/银行卡」的建议私发
- 资源按 SHA-1 去重，同一文件多次转发只存一份，索引里标 `×N`；源文件不在本地时只计入「缺失」，不会中断导出
- 可选配置：`kb.vault`、`kb.auto_export`（同步后自动导出，默认开）、`kb.media_days`（资源归档只取近 N 天，0 = 全部）、`kb.notice_days`、`kb.notice_conv_keywords`、`kb.agenda_conv_exclude`

## 配置

`config.json`（首次运行生成）：

```json
{
  "data_dir": "data",
  "auto_sync_on_start": true,
  "wechat": {
    "enabled": true,
    "db_dir": "E:\\xwechat_files",
    "sync_interval_min": 30
  },
  "qq": {
    "enabled": true,
    "mode": "nt",
    "nt_account": "",
    "nt_db": "",
    "key_timeout": 20,
    "scan_interval_sec": 60
  },
  "voice": {
    "enabled": true,
    "model_dir": "",
    "ffmpeg": "",
    "threads": 2,
    "language": ""
  },
  "digest": {
    "enabled": true,
    "interval_min": 60,
    "hours": 1,
    "toast": true,
    "obsidian": true,
    "self_names": [],
    "exclude_convs": []
  },
  "notice": {
    "enabled": true,
    "time": "17:00",
    "class_name": "金融2601",
    "days_ahead": 14,
    "lookback_days": 3,
    "max_items": 10,
    "ai": true,
    "conv_keywords": [],
    "exclude_convs": []
  },
  "agent": {
    "enabled": true,
    "sync_interval_min": 5,
    "agenda_ai": true,
    "plan": ["sync", "analyze", "archive", "agenda", "push"],
    "archive": true,
    "push": true
  },
  "push": {
    "enabled": true,
    "channel": "wecom_bot",
    "send_empty": false,
    "wecom_bot_id": "",
    "wecom_bot_secret": "",
    "wecom_bot_port": 8765,
    "wecom_webhook": "",
    "smtp_host": "smtp.qq.com",
    "smtp_port": 465,
    "smtp_user": "",
    "smtp_pass": "",
    "mail_to": ""
  },
  "llm": {
    "enabled": false,
    "base_url": "http://127.0.0.1:11434/v1",
    "model": "qwen2.5:7b",
    "api_key": "",
    "timeout": 60,
    "max_chars": 6000,
    "allow_remote": false,
    "prompt": "",
    "agent_prompt": ""
  }
}
```

- `wechat.db_dir`：含 `xwechat_files`（或账号目录）的那一层
- `qq.mode`：`nt`（默认，直读本地库）/ `qce`（扫描旧的导出目录）
- `qq.nt_account`：QQ 号；留空自动取最近更新的账号
- `qq.nt_db`：直接指定 `nt_msg.db` 路径（一般不用填）
- `qq.key_timeout`：等待 QQ 打开消息库并抓到密钥的秒数
- `qq.scan_interval_sec`：QQ 实时轮询间隔（默认 60 秒）
- `voice.model_dir`：SenseVoice 模型目录；留空用 `data/models/sherpa-onnx-sense-voice-…/`
- `voice.ffmpeg`：ffmpeg 路径；留空自动找 PATH / `E:\ffmpeg\bin`
- `voice.enabled`：关掉后既不复制音频也不转写
- `digest.interval_min`：简报周期（分钟，默认 60）；`digest.hours` 是每次回看窗口
- `digest.self_names`：判断「@我」用的额外昵称；留空自动从自己发过的群名片里取
- `digest.exclude_convs`：简报里不统计的营销/闲聊会话（会话名包含即命中），会叠加 `kb.agenda_conv_exclude`
- `agent.enabled`：开启智能体定时任务；`agent.sync_interval_min` 是只拉新消息的间隔（分钟，默认 5，不写日志不推送），完整流水线仍按 `digest.interval_min` 跑；`agent.agenda_ai` 控制日程识别是否优先用大模型（关掉后全程规则）；`agent.plan` 是整轮步骤顺序（`sync` / `analyze` / `archive` / `agenda` / `push`），`agent.archive` / `agent.push` 是本次是否入库 / 推送的总开关
- `notice.enabled` / `notice.time`：每日通知的开关与发送时间（默认 17:00，界面开着才触发）；`notice.class_name` 是标题落款，`notice.days_ahead` / `notice.lookback_days` 控制日程视界与通知回看天数，`notice.max_items` 是最多几条，`notice.ai` 关掉后只用规则拼接
- `notice.conv_keywords`：额外视为班级公共事务的会话名关键词（叠加 `kb.notice_conv_keywords`）；`notice.exclude_convs`：额外排除的会话（叠加营销群名单）
- `push.enabled` / `push.channel`：`wecom_bot` / `wecom` / `smtp`；`push.send_empty` 为真时没新消息也发一条
- `push.wecom_bot_id` / `push.wecom_bot_secret`：企微智能机器人的 Bot ID 和 Secret；`push.wecom_bot_port` 是本地后台端口（默认 8765，只监听 127.0.0.1）
- `push.wecom_webhook`：可以填完整 Webhook 地址，也可以只填机器人 `key`，程序会自动补成 `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…`
- `llm.enabled` / `llm.base_url` / `llm.model`：AI 分析报告开关与 OpenAI 兼容接口；`llm.api_key` 可留空（本机 Ollama 不需要）
- `llm.allow_remote`：只在本机/内网地址之外才需要，必须为 true 才会把简报文字发出去；`llm.max_chars` 是单次送入的字数上限，`llm.prompt` 是附加要求
- `llm.agent_prompt`：系统级身份/人物提示词，留空用内置档案（付梓杨 + 班委 + 辅导员 + 秘书处）；`infohub llm --profile` 可打印当前生效内容
- 界面右上角「设置」可以直接改这些项，改完立即生效；只有采集目录（`wechat.db_dir` / `qq.*`）这类启动时读取的配置需要重启应用

首次直读 QQ 时会把该库的全部本地历史导入，并替换同一会话里旧的 QCE 导出数据（同一条消息只留一份，
旧会话名会保留）。之后每轮只扫最近 3 天窗口做增量，数据库文件没变化时直接跳过。

## 日程是怎么算出来的

同步结束后只处理**游标之后的新消息**（游标存在 `source_state.agenda`，记录最后处理的消息 id），不再重扫整段历史。首次升级会做一次全量规则重建，之后进入增量模式；没有新消息时直接跳过。

- **默认优先调用大模型**：把新消息的文本、会话名、发送人、时间打成 JSON 发过去，要求返回 `[{id,title,due,all_day,kind,detail}]`；模型关闭、外部地址未授权或调用失败时，自动退回本地规则，并在同步详情里标注「AI 日程识别失败，已用规则」
- 规则兜底保留原来的解析能力：日期 `11月5日`、`10/28`、`周四 / 下周四`、`今天 / 明天`，时间 `15:00`、`下午3点`、`晚上8点半`；没有钟点记为「全天」
- 每条消息只以**它自己的发送时间**为锚点，「明天」「下周四」都相对发通知那一刻算
- 只认带动作的通知：报名、提交、上交、缴费、会议、班会、讲座、考试、集合、签到、填报、领取、排练等；疑问句、引用消息、纯闲聊跳过
- 合并按「会话 + 日期 + 类型 + 标题」去重，跨消息重复通知只留一条，也不会重复插入库里已有的事件；重新同步不会冲掉已完成状态
- AI 只吃新消息文本和必要的会话/发送人名称，不传图片、文件或历史库；外部地址仍需 `llm.allow_remote=true`
- 逾期项默认保留 30 天（可在 CLI 用 `--overdue` 调），今天/未来 7 天/逾期三个数字显示在日程面板顶部

## 数据落在哪

```
data/
├─ archive.db       SQLite：会话、消息、日程(events)、媒体索引、语音转写(voice_cache)、导入文件指纹、同步状态（含 FTS5 索引）
├─ agenda.ics       可选：infohub agenda --ics 导出的日历文件
├─ kb_manifest.json 知识库资源归档清单（内容哈希 → 库内路径），用于跨次去重
├─ media/thumbs/    QQ 图片缩略图（最长边 480px，首次导入时生成）
├─ media/preview/   知识库归档用的压缩图（≤1600px JPEG 80，按源路径哈希缓存）
├─ media/voice/     语音原件副本（`<md5>.amr`，QQ 清缓存也不会丢）
├─ agent/runs/      智能体每次运行的 JSON 日志（每步状态、耗时、摘要）
├─ daily/           每日通知正文（YYYY-MM-DD.txt）与发送状态（sent.json）
├─ wecom_bot.json   企微机器人后台状态（chatid、上次收发、本机调用令牌）
└─ models/          SenseVoice ONNX 模型（约 230MB，`infohub voice --download` 拉取）
```

小时简报与消息归档写在 Obsidian：

```
D:\Obsidian\学院事务\班级管理\InfoHub-小时简报.md
D:\Obsidian\学院事务\消息归档\2026-10-30\0900-1000 工作.md
D:\Obsidian\个人生活\消息归档\2026-10-30\0900-1000 生活.md
```

- 消息按 `(会话, 外部ID)` 去重，重复导入时只更新内容有变化的行（FTS 同步刷新）；QQ 直读按消息 ID 更新，同一秒同一正文再做一次内容哈希去重；旧的 QCE HTML/TXT 重叠导出另有跨格式合并
- 中文检索用 FTS5 trigram 做子串匹配；1–2 字的关键词自动回退到 LIKE
- 日程按游标增量：只处理上次之后的新消息，AI 优先、规则兜底；同一天、同一类型、同一件事的重复通知只留一条，重新同步不会冲掉已完成状态
- 微信解密密钥只存在于一次性临时目录，同步结束即删除
- QQ 数据库密钥只存在进程内存里，不落盘；解密出的 `nt_msg_plain.db` 在临时目录，读完立即删除
- 除语音外，媒体本体不进归档库，只记录路径与尺寸：QQ 直读模式记录 `nt_data` 下的缓存路径（图片/表情/语音/视频按内容 md5，文件按元素自带的落盘路径），QCE 模式按 `resources/` 文件名回填；两种模式都不复制、不移动源文件
- 语音是唯一会复制的：原件进 `data/media/voice/`，转写结果按音频 md5 缓存在 `voice_cache`，重新同步解析消息时会先查缓存，正文不会退回 `[语音] Ns`
- `kb_manifest.json` 除了「内容哈希 → 库内路径」，还缓存「源路径 → mtime/size/哈希」，没变过的文件不会在每次同步时重算 SHA-1
- 简报游标存在 `source_state` 的 `digest` 行里（最后一次生成时间），用来补齐关机期间的空档；简报本身不落库，只写 Obsidian 和推送

## 架构

```
infohub/
├─ config.py            配置与目录探测
├─ store.py             统一 SQLite（会话/消息/日程/FTS5/同步状态）
├─ sync.py              同步编排
├─ agenda.py            日程增量识别（AI 优先、规则兜底）、合并去重、按日分组、ICS 导出
├─ kb.py                Obsidian 导出：日程区块、通知候选、资源归档与索引（含图片压缩）
├─ voice.py             语音原件留存 + SenseVoice 本地转写 + 正文回填
├─ agent.py             智能体运行时：工具注册表、计划执行、每步状态、运行日志；含 Obsidian 工作/生活归档
├─ digest.py            小时简报：窗口统计、@我识别、按来源分组 AI 输入、渲染（文本/Markdown/HTML/企业微信）+ Obsidian 滚动写入
├─ daily.py             每日通知：日程 + 通知原文 → AI 合并成编号通知（规则兜底），每日一次推送与正文留存
├─ llm.py               OpenAI 兼容 /chat/completions：AI 分析报告（分来源五段解析，兼容旧四段）；默认只连本机，外部地址需显式确认
├─ push.py              投递：企业微信机器人 webhook / SMTP 邮件（环境变量可覆盖凭据）
├─ wecom_bot.py         企微智能机器人长连接：单实例后台 + 本机 HTTP 代发
├─ sources/
│  ├─ wechat.py         本地只读采集（wechatauto-replica）
│  ├─ qqnt.py           QQNT nt_msg.db 只读解密 + WAL 增量 + 消息映射 + 媒体定位
│  ├─ media.py          QCE resources 索引与缩略图
│  └─ qq_qce.py         QCE 导出解析（HTML chunk + TXT，mode=qce 时使用）
├─ cli.py               命令行
└─ ui/
   ├─ main_window.py    PySide6 桌面界面（5 分钟同步、整点触发智能体、每日通知定时、状态栏、推送到手机）
   ├─ agent_dialog.py   智能体面板：计划、最近一次运行、逐步状态、快捷打开归档/日志
   └─ settings.py       应用内设置：企业微信/推送、大模型
```

## 已知限制（v0.1）

- 微信图片/语音仍是加密 `.dat`，只保留占位文本（需要微信进程内的密钥，后续再接入）
- QQ 图片/视频/语音只有在 QQ 本地缓存还没被清理时才能打开；被清理的历史图片退回 `[图片]` 占位（本机实测约 3/4 的图片仍有缓存）
- 语音转写只覆盖本机还留着音频的语音（当前 541 条语音中 143 条有本地 `.amr`）；其余在 QQ 服务器上，不下载、不补拉，只显示时长
- 语音转写是本地模型，安静环境/普通话效果最好；方言、多人抢话、背景嘈杂会出错字。转写结果按音频 md5 缓存，`infohub voice --rebuild` 可重跑
- 少数结构化卡片只能保留 `[卡片]` 占位（普通群公告、分享卡片、戳一戳已能取到摘要）
- 同一位发送者在同一秒发出的多条消息会各自保留，不做合并
- QQ 能读到的历史范围 = 本机 `nt_msg.db` 里保存的范围（当前实测 31,000+ 条）
- 微信消息解析基于本机 4.1.15.x 实测；微信升级后可能需要更新 `wechatauto-replica`
- 日程默认交给大模型识别；没开大模型或调用失败时退回规则。两种方式都不保证召回：没写日期或只写「周五见」的约定不会被收进来；商家群会从 AI 输入里排除（写进 Obsidian 时再按 `agenda_conv_exclude` 过滤一次）
- 日程目前只读：不能在界面里打勾完成，改动 `events.status` 留给后续版本；重新同步不会覆盖已完成状态
- 通知候选是关键词规则：只保证「像通知的都列出来」，不判断是否真的需要发；候选人名/会话名依赖本地库质量
- 资源归档只覆盖能拿到本地路径的媒体（QQ 直读模式指 QQ 缓存里还在的图片/表情/语音/视频，以及本机还留着的文件；微信图片/文件仍是加密 `.dat`）
- 资源归档按 `kb.media_days` 截取时间窗（0 = 全部）；图片压成 ≤1600px JPEG 后本机归档从约 1.9 GB 降到几百 MB，只想留近期资源再把 `kb.media_days` 设成 7 / 14
- 归档图片是压缩版，正文/表格里的细节字可能看不清；需要原图时在 InfoHub 里点缩略图打开 QQ 缓存里的原文件（缓存还在的话）
- QQ 侧新消息最多滞后一个轮询周期（默认 60 秒）；QQ 客户端需保持登录才能读到密钥
- 小时简报由 InfoHub 窗口自己触发：程序没开就不会生成；关机超过 24 小时的空档不会补（最多回看一天）
- 每日通知同样由窗口触发：17:00 前开的程序会在到点后发（启动时已过点会补发当天一次）；程序整天没开就不会发，也不补历史日期
- 「@我」靠昵称文本匹配（自动收集自己在本群的名片 + `digest.self_names`），改过群名片的历史消息可能漏判
- 推送只发简报文本，不发聊天原件；开启推送意味着这部分摘要会经过企业微信/邮件服务器
- AI 报告与 AI 日程可能编造：提示词都要求「只依据原文、拿不准就丢弃」，日期入池前还会做格式与范围校验，但仍建议按原消息核对；不配模型时简报和日程都退回本地规则，功能不受影响

## 隐私

聊天记录包含他人个人信息。InfoHub 默认全程本地运行：采集、归档、日程、语音转写都在本机完成，不发起网络请求、不上传任何内容、不做云端同步。

只有你主动开启的两项会联网：

- **推送**：只发简报摘要 / 每日通知，发给你自己的企业微信或邮箱
- **AI 分析报告 / AI 日程识别 / 每日通知**：默认只连本机 Ollama；换成外部地址需要在设置里显式勾选确认。送给模型的只有文字：简报文本、新增消息的正文与会话/发送人名称，或每日通知的日程与通知原文；不含图片、文件和历史原库。日程识别失败会回退本地规则，不影响归档

请仅将归档用于个人事务整理，并自行评估合规边界。
