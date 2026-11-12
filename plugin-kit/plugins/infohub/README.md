# 信息中枢（沙箱 bundle 插件）

信息中枢把本机 QQ / 微信聊天归档、全文检索与会话日程收在一个只读界面里。采集与归档全部在本机完成，插件本身不接触数据库文件。

日程页提供「AI 日程识别」：用户填写自己的身份与语境作为提示词，插件把最近若干天的聊天原文按批发送给**用户在宿主里配置的模型网关**，让模型挑出需要处理的事情，整理成可编辑表格（可改时间/标题/类型、复制、导出 CSV）。表格只存在插件自己的数据目录，不写回归档或宿主日程。除用户主动点击「开始识别」外，插件不发起任何网络请求。

插件以沙箱 bundle 形式运行：宿主把 `files/index.html` 挂到独立的 `widget://` 页面，插件只能通过 `window.__heming_widget` 暴露的桥调用读取数据。

## 目录

```
infohub/
├── plugin.json           插件清单（schemaVersion 4，distribution "bundle"）
├── files/
│   ├── index.html        页面骨架与样式（无外部资源）
│   └── app.js            页面逻辑（原生 JS，无框架、无构建步骤）
└── README.md
```

## 清单要点

- `permissions.infohub: true`：允许调用 `infohubCall`（宿主侧校验，缺少会返回“缺少 permissions.infohub”）。
- `permissions.notify: true`：允许手动采集完成后发系统通知；旧宿主机没有 `notify` 时静默跳过。
- `permissions.chat: true`（d.140）：允许 `chatConfig()` 拿到本机模型网关地址与短期票据，并让 `widget://` 页面的 CSP `connect-src` 放行网关。宿主人设 prompt 与用户 API Key 永不下发；模型来源、模型列表由宿主「设置 → 模型」决定。
- `contributions.page`：插件页面，`entry: "files/index.html"`。
- `contributions.homeCards`：首页卡片 `infohub`，点击进入 `plugin:heming.infohub`；页面加载状态后通过 `homeCardSet` 覆盖为“已归档 N 个会话 · M 条消息”、逾期/今天/本周数量与接下来三项日程。
- `homeCards[0].actions`（d.139）：卡片上的「检索归档 / 全部日程」快捷入口。`intent` 是给插件页自己的页面意图，宿主原样拼进 `widget://…/files/index.html#intent=<intent>`，插件读 `location.hash` 决定落在哪个页签。
- `commands.open-infohub`：命令面板入口。

## 使用的宿主桥

| 桥方法 | 用途 |
| --- | --- |
| `infohubCall("status")` | 归档统计、采集来源、配置摘要、最后消息、归档大小 |
| `infohubCall("agenda", { days: 14, overdue: 30 })` | 日程列表与汇总；`rebuild: true` 重扫 |
| `infohubCall("search", { query, limit: 100 })` | 全文检索，片段里的 `<<命中>>` 渲染为高亮 |
| `infohubCall("conversations", { limit, source?, keyword? })` | 会话列表（来源 / 会话名筛选、分页） |
| `infohubCall("messages", { conversationId, limit, beforeTs? })` | 消息流（向前翻页） |
| `infohubCall("sync", { sources, full, archive })` | 手动 / 首次自动采集，30 分钟超时 |
| `dataGet / dataSet("autoSyncAt")` | 记录自动采集时间，10 分钟内不重复自动采集 |
| `dataGet / dataSet("aiProfile" / "aiAllowSend" / "aiDays" / "aiModel" / "aiItems")` | 身份提示词、发送许可、识别范围、所选模型与识别结果（只存插件私有目录） |
| `chatConfig()` | 取 `{ gateway, agents, models, backgroundModel }`：网关 OpenAI 兼容地址、短期票据与可选模型；未声明 `permissions.chat` 时 `gateway` 为 `null` |
| `homeCardSet("infohub", { text, detail, items })` | 刷新首页卡片文案与速览项；`items` 是接下来三项日程（纯展示，不可点） |
| `notify({ title, body })` | 手动采集完成通知 |
| `info() / onEvent({ kind: "theme" })` | 跟随宿主深浅色 |
| `log(line)` | 启动日志 |

所有桥方法都做了存在性检测：旧宿主缺少 `infohubCall` 时页面显示“当前桌面端版本还不支持信息中枢插件调用”，缺少 `notify` / `homeCardSet` 时静默降级。

## 功能

- 三个页签：检索、会话、日程；页头显示连接状态、归档会话数与归档大小。
- 首页卡：统计文案 + 逾期/今天/本周 + 接下来三项日程；「检索归档 / 全部日程」两个快捷入口直接落在对应页签（页面意图走 `#intent=`）。
- 采集来源区：微信目录、QQNT 消息库、QQ 导出目录的识别状态、路径查看与复制。
- 同步面板：QQ / 微信来源勾选、全量重扫、导出知识库；采集期间显示不确定进度条（桥没有进度事件）。
- 日程页「AI 日程识别」（d.140）：填写身份与语境提示词 → 选范围（7 / 14 / 30 天）、来源（QQ / 微信）与模型 → 勾选允许发送后「开始识别」。插件按会话取最近消息、切成约 2.6K 字的批，逐批让模型输出 JSON 数组，合并去重后落到表格（时间 / 事项 / 类型 / 来源 / 依据）；时间、标题、类型都能直接改，支持复制表格、导出 CSV、清空，进度按批显示。识别结果优先作为首页卡 `items` 的三项速览。识别可随时停止，已完成的部分保留。
- 日程页底部折叠「规则抽取的日程（备用）」：保留引擎的规则抽取结果与「重扫议程」，不依赖模型、不联网。
- 归档为空且检测到来源时自动采集一次（10 分钟冷却），之后可手动刷新。
- 会话页：来源分段（全部 / QQ / 微信）、会话名搜索（220ms 防抖、Esc 清空）、每页 200 个会话；两栏阅读，消息按天分隔、群聊显示发送人、同人 300 秒内合并、向前翻页保持滚动位置。
- 空态与错误态：未安装归档库、没有匹配会话、没有待办、桥未就绪都给出可读说明。
- 本机配置折叠区（已脱敏）。

## 与旧 React 内置模块的差异

旧实现是宿主的 React 内置模块，能直接访问宿主 store 与事件。沙箱桥没有暴露以下能力，因此本插件相应简化：

1. **同步进度事件**：只显示不确定进度条与“正在同步…”，无法展示逐来源进度。
2. **定时同步 / 定时重扫议程 / 保存为定时任务**：需要写入宿主自动化（`infohub.sync` 等），沙箱桥未开放自动化接口，入口已移除。
3. ~~首页卡片的“检索归档 / 全部日程”快捷入口与前三项日程~~：**d.139 已回收**。宿主把首页卡片升级成通用能力——清单可声明 `actions`（快捷入口），运行期 `homeCardSet` 可推 `items`（速览项），插件不需要任何专用硬编码。
4. **宿主 palette intent（`infohubIntent`）**：部分回收——首页卡快捷入口能带页面意图（`#intent=`）直接落在检索/会话/日程页签；但从命令面板或宿主 palette 进入时仍固定落在检索页（宿主还没有把页面意图交给沙箱页面）。
5. **主开关与部分停用**：启停、安装与删除由宿主插件管理界面的通用逻辑处理，插件页面不重复提供。

剩余差异（进度事件、自动化接口、palette 意图）需要在宿主桥继续补齐后再回收。

AI 日程识别有两点口径：① 结果只存在插件私有数据目录（`plugins/heming.infohub/data/`，键 `aiItems`），不写回归档库、也不写宿主日程；② 目前没有「一键写成宿主日程 / 定时任务」的入口，需要宿主继续开放自动化接口后再回收。聊天原文只在点击「开始识别」时发给用户自己配置的模型供应商，没配模型时插件只显示规则抽取结果。
