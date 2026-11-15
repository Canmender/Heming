# 信息中枢（沙箱 bundle 插件）

信息中枢把本机 QQ / 微信聊天归档与日程收在一个只读界面里。采集与归档全部在本机完成，插件本身不接触数据库文件；界面上不展示采集来源与路径，同步在后台静默进行。

日程页提供「AI 日程识别」：用户填写自己的身份与语境作为提示词，插件把最近若干天的聊天原文按批发送给**用户在宿主里配置的模型网关**，让模型挑出需要处理的事情，整理成可编辑表格（可改时间/标题/类型、复制、导出 CSV）。表格只存在插件自己的数据目录，不写回归档或宿主日程。除用户主动点击「开始识别」外，插件不发起任何网络请求。

插件以沙箱 bundle 形式运行：宿主把 `files/index.html` 挂到独立的 `widget://` 页面，插件只能通过 `window.__heming_widget` 暴露的桥调用读取数据。

## 目录

```
infohub/
├── plugin.json           插件清单（schemaVersion 4，distribution "bundle"）
├── files/
│   ├── index.html        页面骨架（只有结构，样式与脚本外链）
│   ├── styles/app.css    全部样式（亮/暗主题走 data-theme token，取值与原生界面同源）
│   └── js/               页面逻辑（原生 ES module，无框架、无构建步骤）
│       ├── main.js       入口：等 DOM 就绪后 boot
│       ├── app.js        主流程：状态装载、静默同步、自动采集、启动
│       ├── core/         constants 常量 / state 状态 / dom 构造 / format 格式化 / sources 来源识别 / bridge 宿主桥
│       ├── views/        shell 外壳 / tabs 页签 / agenda 日程 / chats 会话
│       └── ai/           scan 网关调用与批处理 / prefs 偏好与结果持久化 / view 设置面板与结果表
└── README.md
```

`files/**` 里的模块由宿主的 `widget://` 协议按路径直接提供（该 scheme 注册为 `standard`，`.js` 的 MIME 是 `text/javascript`），所以页面用 `<script type="module">` 加载、样式用 `<link>` 外链即可，CSP 的 `script-src 'self'` / `style-src 'self'` 都满足，不需要打包。

清单是**开发态**（不含 `packageSha256` 与 `signature`）：改完 `files/**` 直接重新装插件即可预览；发版前由打包/签名流程补回这两个字段。

## 数据存放

归档库与引擎配置都在宿主解析出的 InfoHub 根目录下（`config.json`、`data/archive.db`、`data/media/`）。该根目录默认跟着和鸣的数据根走：**打包版是安装目录下的 `<安装目录>/data/infohub`**，开发态回落到 `userData`；想换盘由宿主的数据目录设置决定，插件不自己拼路径。

AI 日程识别的结果与偏好存插件私有数据（宿主 `dataGet/dataSet`，键 `aiProfile` / `aiAllowSend` / `aiDays` / `aiModel` / `aiItems`），同样在数据根里的 `plugins/heming.infohub/data/`。

## 视觉与原生保持一致

插件页面嵌在宿主插件页的卡片里（宿主已经渲染页标题、版本、页摘要与「重新加载」），所以页面里只有内容区加一条页内工具条，不再重复画标题与副标题。

- `styles/app.css` 里的颜色、圆角、字号、动效都是照宿主 `packages/web/src/index.css` 的 token 抄下来的（`--line` / `--line-soft` / `--surface` / `--subtle-*` / `--ink` / `--muted` / `--avatar-*` 等，亮暗两套同名同值）。宿主改色时这里要跟着改。
- 底色分层沿用宿主约定：页面底 `--subtle`、卡片 `--surface` + 1px `--line-soft` 描边（12px 圆角、无投影）、控件 6px 圆角 / 32px 高、胶囊与分段控件全圆角。
- 强调色：宿主的 `--heming-accent` 由渲染层写在主文档根节点，插件的 `widget://` 是独立文档，读不到；因此这里用默认墨色（亮色 `#1a1a1a` / 暗色 `#e8eaed`），不跟随用户自定义主题色。要跟随需要宿主把主题色通过帧桥下发给页面。
- 会话页按宿主聊天的语言排版：流内不显示头像；自己的消息靠右、`--subtle-3` 气泡 24px 圆角；对方消息全宽无气泡；日期分隔居中 11px muted。
- 按钮、输入框、页签、折叠区、表格分别对应宿主的 `.ui-btn` / `.ui-input` / `.ui-segment` / `.ui-disclosure` / `.ui-table` 规格。

## 清单要点

- `permissions.infohub: true`：允许调用 `infohubCall`（宿主侧校验，缺少会返回“缺少 permissions.infohub”）。
- `permissions.chat: true`（d.140）：允许 `chatConfig()` 拿到本机模型网关地址与短期票据，并让 `widget://` 页面的 CSP `connect-src` 放行网关。宿主人设 prompt 与用户 API Key 永不下发；模型来源、模型列表由宿主「设置 → 模型」决定。
- `contributions.page`：插件页面，`entry: "files/index.html"`。
- `contributions.homeCards`：首页卡片 `infohub`，点击进入 `plugin:heming.infohub`；页面加载状态后通过 `homeCardSet` 覆盖为“已归档 N 个会话 · M 条消息”、逾期/今天/本周数量与接下来三项日程。
- `homeCards[0].actions`（d.139）：卡片上的「全部会话 / 全部日程」快捷入口。`intent` 是给插件页自己的页面意图，宿主原样拼进 `widget://…/files/index.html#intent=<intent>`，插件读 `location.hash` 决定落在哪个页签。
- `commands.open-infohub`：命令面板入口。

## 使用的宿主桥

| 桥方法 | 用途 |
| --- | --- |
| `infohubCall("status")` | 归档统计、来源是否检测到（内部用，不展示）、配置摘要、最后消息、归档大小 |
| `infohubCall("agenda", { days: 14, overdue: 30 })` | 日程列表与汇总；`rebuild: true` 重扫 |
| `infohubCall("conversations", { limit, keyword? })` | 会话列表（会话名筛选、分页） |
| `infohubCall("messages", { conversationId, limit, beforeTs? })` | 消息流（向前翻页） |
| `infohubCall("sync", { sources, full, archive })` | 手动 / 首次自动采集，30 分钟超时 |
| `dataGet / dataSet("autoSyncAt")` | 记录自动采集时间，10 分钟内不重复自动采集 |
| `dataGet / dataSet("aiProfile" / "aiAllowSend" / "aiDays" / "aiModel" / "aiItems")` | 身份提示词、发送许可、识别范围、所选模型与识别结果（只存插件私有目录） |
| `chatConfig()` | 取 `{ gateway, agents, models, backgroundModel }`：网关 OpenAI 兼容地址、短期票据与可选模型；未声明 `permissions.chat` 时 `gateway` 为 `null` |
| `homeCardSet("infohub", { text, detail, items })` | 刷新首页卡片文案与速览项；`items` 是接下来三项日程（纯展示，不可点） |
| `info() / onEvent({ kind: "theme" })` | 跟随宿主深浅色 |
| `log(line)` | 启动日志 |

所有桥方法都做了存在性检测：旧宿主缺少 `infohubCall` 时页面显示“当前桌面端版本还不支持信息中枢插件调用”，缺少 `homeCardSet` 时静默降级。

## 功能

- 两个页签：会话、日程；页内工具条只有连接状态与「同步 / 刷新」，指标卡显示归档会话数、消息数、日程数、最后消息与归档大小。
- 采集静默进行：不显示采集来源、路径、来源徽标与页签角标；归档为空时自动采集一次（10 分钟冷却），之后点「同步」增量采集，全程不弹系统通知。
- 首页卡：统计文案 + 逾期/今天/本周 + 接下来三项日程；「全部会话 / 全部日程」两个快捷入口直接落在对应页签（页面意图走 `#intent=`）。
- 日程页「AI 日程识别」（d.140）：填写身份与语境提示词 → 选范围（7 / 14 / 30 天）与模型 → 勾选允许发送后「开始识别」（QQ / 微信两边都在后台一起取，不需要选来源）。插件按会话取最近消息、切成约 2.6K 字的批，逐批让模型输出 JSON 数组，合并去重后落到表格（时间 / 事项 / 类型 / 依据）；时间、标题、类型都能直接改，支持复制表格、导出 CSV、清空，进度按批显示。识别结果优先作为首页卡 `items` 的三项速览。识别可随时停止，已完成的部分保留。
- 日程页底部折叠「规则抽取的日程（备用）」：保留引擎的规则抽取结果与「重扫议程」，不依赖模型、不联网。
- 会话页：会话名搜索（220ms 防抖、Esc 清空）、每页 200 个会话；两栏阅读，消息按天分隔、群聊显示发送人、同人 300 秒内合并、向前翻页保持滚动位置。
- 空态与错误态：未安装归档库、没有匹配会话、没有待办、桥未就绪都给出可读说明。

## 与旧 React 内置模块的差异

旧实现是宿主的 React 内置模块，能直接访问宿主 store 与事件。沙箱桥没有暴露以下能力，因此本插件相应简化：

1. **同步进度事件**：只显示不确定进度条与“正在同步…”，无法展示逐来源进度。
2. **定时同步 / 定时重扫议程 / 保存为定时任务**：需要写入宿主自动化（`infohub.sync` 等），沙箱桥未开放自动化接口，入口已移除。
3. ~~首页卡片的快捷入口与前三项日程~~：**d.139 已回收**。宿主把首页卡片升级成通用能力——清单可声明 `actions`（快捷入口），运行期 `homeCardSet` 可推 `items`（速览项），插件不需要任何专用硬编码。
4. **宿主 palette intent（`infohubIntent`）**：部分回收——首页卡快捷入口能带页面意图（`#intent=`）直接落在会话/日程页签；但从命令面板或宿主 palette 进入时仍固定落在默认页签（宿主还没有把页面意图交给沙箱页面）。
5. **主开关与部分停用**：启停、安装与删除由宿主插件管理界面的通用逻辑处理，插件页面不重复提供。

剩余差异（进度事件、自动化接口、palette 意图）需要在宿主桥继续补齐后再回收。

AI 日程识别有两点口径：① 结果只存在插件私有数据目录（`plugins/heming.infohub/data/`，键 `aiItems`），不写回归档库、也不写宿主日程；② 目前没有「一键写成宿主日程 / 定时任务」的入口，需要宿主继续开放自动化接口后再回收。聊天原文只在点击「开始识别」时发给用户自己配置的模型供应商，没配模型时插件只显示规则抽取结果。
