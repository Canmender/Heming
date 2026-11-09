# 智能体页：对话优先 + 流式页面抬高修复 + 纯净安装复核

- 日期：2026-11-09
- 版本：`d.116.3.46.0`（特性 +1）
- 分支：`claude/serene-torvalds-fc4f1e`
- 起因：用户三条反馈——① 智能体回答时页面异常抬高；② 智能体页应左边显示对话、在页面里选智能体，
  而不是左边选智能体再对话；③ 原生和鸣不携带其他插件，插件应从本体清出、由用户决定是否从云端安装。

## 1. 页面异常抬高（已复现，非猜测）

### 1.1 复现

本工作树起本地 API（`packages/server` + 临时 SQLite）+ 假 magpie 网关（`/api/hello`、`/v1/models`、
`/v1/chat/completions` SSE）+ Vite dev，headless 浏览器 1100×800，登录后进「智能体 → 与和小鸣的会话」，
贴底发送一条长回答，每 100–120ms 采样。

修复前（流式进行中）：

| 采样 | 聊天区 `getBoundingClientRect().y` | `main > div.scrollTop` | 消息列表 |
|---|---|---|---|
| 0 | 65 | 0 | 在底部 |
| 1 | -229 | 0 | 在底部 |
| 3–45 | **-309** | **510** | 在底部 |

即整个页面内容被向上顶了 510px（页头、页签、状态条全部移出视口），回答结束后弹回 201。

### 1.2 根因

`ChatPage` 的贴底跟随、切会话回底、「↓ 新消息」与搜索跳转都用 `scrollIntoView`。
`scrollIntoView` 按规范会滚动**所有可滚动祖先**；`overflow:hidden` 的元素仍然是滚动容器
（只是不响应滚轮/滚动条，程序仍可改 `scrollTop`）。App 壳里 `main` 与页面包裹层都是
`overflow-hidden`，于是每次流式文本增长都把包裹层滚下去，表现为整页抬高。

消息列表本身的内部滚动是正确的（`scrollHeight` 增长、`scrollTop` 跟到底），
问题只在它把祖先也一起滚了。

### 1.3 修法

- 新增 `scrollListToBottom(behavior)`：只对 `scrollRef.current` 设 `scrollTop` / `scrollTo`。
- 贴底跟随（`messages.length` / `streamTick`）、切会话回底、`scrollToLatest` 全部走它。
- 会话内搜索：按 `node` 与列表的 `getBoundingClientRect()` 相对位置计算居中 `scrollTop`，
  不再 `scrollIntoView`。
- 回归用例：贴底跟随后断言 `Element.prototype.scrollIntoView` 未被调用；
  浏览器复测流式全程 `main > div.scrollTop === 0`、聊天区 `y` 恒为 201。

## 2. 智能体页：对话优先

### 2.1 布局

```
┌ 对话 │ 协作 ─────────────────────────────────────────────┐
│ 左栏（264，可折叠 60）  │ 主区                                │
│ 对话 N                  │ 没有选中对话：智能体选择页            │
│ [搜索对话…]（≥5）       │   选择智能体 + 新建/模板              │
│ ┌────────────────┐     │   [搜索智能体…]（≥5）                │
│ │ 头像 名称  时间 │     │   系统智能体 / 自建智能体 分组卡片     │
│ │ 最近对话/草稿   │     │   每张：简介、模型绑定、编辑、开始对话 │
│ └────────────────┘     │ 选中对话：状态条 + ChatPage           │
│ …                       │   状态条：智能体 / 绑定 / 编辑 / 切换  │
└─────────────────────────┴─────────────────────────────────────┘
```

### 2.2 行为

- 左栏按 `lastMessageAt` 降序；预览优先草稿（`lib/drafts`，订阅变更），其次「最近有对话 · 时间」，
  最后智能体简介。只读本机，不拉消息正文。
- 点对话行 `openConversation(id)`；「新建」「切换智能体」清空 `activeConversationId`，主区回到选择页。
- 选择页卡片主按钮与「开始对话」都走既有 `openAgent(agentId)`（服务端幂等，已有会话复用）。
- 编辑智能体入口：选择页卡片常显按钮 + 对话状态条「编辑智能体」。
- Tab 文案「任务」→「对话」；存储值 `chat`/`tasks` 与 `pageView` 的 `tasks`/`chat` 继续归一为 `work`。
- 协作视图、命令面板新建智能体、通知 `openConversation` 的跳转语义不变。

### 2.3 明确不做

- 不做「一个智能体多会话」：服务端 `openAgent` 仍按智能体幂等复用会话。
- 不做左栏置顶/分组/拖拽；不做消息全文检索（会话内搜索仍由 ChatPage 负责）。

## 3. 纯净安装边界（复核 d.116）

- `d.115` 的 r81 安装包 `resources/` 里仍有 `infohub/`——用户看到的「还带插件」来自这里。
- `d.116` 起 `build.files` / `extraResources` 不含 `packages/infohub`、`plugins/`、`plugins-catalog/`、
  `pet-widget`、`package.tgz`；信息中枢引擎为官方 Ed25519 签名模块包，首次启用时从更新源下载到
  `<userData>/modules`，验签/摘要/meta 路径校验通过后落盘并自动启动。
- 本轮补守卫：`packaging.plugins.test.js` 同时禁止 `module-catalog/` 进安装包。
- 三个内置模块（幕僚 / 信息中枢 / 自动化）默认全部未安装：不占导航、不跑后台任务、
  不注入工具；用户在插件区自行安装/启停/删除，删除不碰本机数据。
- 明确边界：模块的**宿主界面代码**仍随应用发布（与其它页面一样是懒加载 chunk），
  但没有任何模块在未安装时生效；带可执行引擎的模块（信息中枢）引擎本体不随安装包。

## 4. 验证

- `pnpm --filter @heming/web exec tsc -p tsconfig.json --noEmit` 通过。
- web 全量 `vitest run`：302 文件 / 4298 例全绿。
- desktop `packaging.plugins.test.js` 4 例全绿。
- 真实浏览器：智能体页左对话/右选择页、切换智能体、编辑入口；长回答流式全程页面不位移。
