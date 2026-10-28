# d.37 · 会话连续性：最近会话可信、未读可定位、断线不伪装、草稿可见

- 日期：2026-10-27
- 相关版本：d.36.1.9.0（基线）、本 spec = d.37.1.9.0（特性位 +1）
- 上游依据：`docs/research/2026-10-22-deep-audit-followup-plan.md` §4（P2 体感缺口）+ 本轮源码勘察
- 涉及包：`packages/shared`（一处可选字段）、`packages/server`（两个 Store 实现）、`packages/web`
- 说明：纯体验轮，不改安全红线、不改 E2E 语义、不引入第三方依赖。

## 0. 问题（都有源码证据）

| 编号 | 用户撞到的现象 | 证据 |
|---|---|---|
| A | 首页「最近会话」不是最近的，而是**最早创建的**；重启后未打开过的会话明明有消息，却显示「暂无消息」 | `HomePage.tsx:182` `conversations.slice(0, 6)`（数组顺序=创建序）；`:359` 预览取 `messages[c.id]`，而消息只在打开会话后才加载 |
| B | 打开一个有未读的会话，**永远跳到底部**；长会话里要自己往上翻找「从哪条开始是新消息」 | `ChatPage.tsx:1421-1428` 切会话固定 `scrollIntoView` 到底 |
| C | 断线后标题旁永远显示「连接中…」，看起来像还在连；没有「已断开/正在重连/已恢复」的明确说法 | `ChatPage.tsx:2936` 只有 `connected ? "已连接" : "连接中…"` 二元；`onClose` 只置 false |
| D | 写了一半的草稿只在输入框里；切走/回首页后**看不出哪个会话说了一半**（草稿本身已持久化） | `lib/drafts.ts` 已有 `getDraft`，但 `ConversationTabs` / `ChatConvStrip` / `HomePage` 都不读 |

这四条都发生在「用户离开再回来」的路径上：数据其实都在，界面没说清楚。

## 1. 决策

### A. 最近会话按真实最近活动排序；未加载的预览不撒谎

- `ConversationSchema` 三个变体统一加可选字段 `lastMessageAt?: string | null`
  （ISO，最后一条消息时间；无消息为 `null`）。**可选**，旧服务端/旧数据不受影响。
- 两个 Store 实现都要填：
  - 内存：该会话 `messages` 数组最后一条的 `createdAt`；
  - SQLite：`SELECT created_at FROM messages WHERE conv_id=? ORDER BY created_at DESC LIMIT 1`。
  - 契约测试对两种实现同跑：发消息后 `lastMessageAt` = 该消息时间；空会话为 `null`。
- 首页：按 `lastMessageAt` 降序取前 6（`null` 排最后）；预览规则：
  - 本地有最后一条消息 → 原有逻辑（撤回/纯附件/正文）；
  - 本地没有但 `lastMessageAt` 有值 → **「点击查看消息」**（不再冒充「暂无消息」）；
  - 两者都没有 → 「暂无消息」。
- **不改**服务端返回顺序（客户端排序；服务端顺序不是契约）。

### B. 未读分隔线 + 打开会话定位到第一条未读

- 切进会话时**先快照**该会话的 `unreadCount`（服务端事实），再照旧发 `mark_read`；
  快照只用于本次停留的分隔线，不新增服务端状态。
- 在已加载消息中找到**第一条 `createdAt > lastReadAt` 的非自己消息**（`Conversation.lastReadAt`
  为当前用户在该会话的最后已读时间；从未已读为 `null`），在它前面插入分隔线
  **「以下是新消息」**（`role="separator"`）。不按条数往回数——服务端 `unreadCount` 把链分发 /
  表情事件这类**不渲染的控制行**也算进去，按条数会让分隔线提前甚至误报。
- 打开会话后滚到分隔线（`block:"start"`）；没有未读才保持原来的「跳到底部」。
- 未读只由不渲染的控制行构成（找不到可定位的气泡）时不画分隔线，直接回到底部。
- 旧服务端缺 `lastReadAt` 字段时不猜边界：**不画分隔线、直接回到底部**（宁可没有，也不说谎）。
- 分隔线在本次停留内保留；切走再回来时未读已被清掉，自然消失（不持久化）。
- 流式/自己发送的新消息不改变分隔线位置。

### C. 连接状态诚实化

- 三态：`连接中…`（首次）/ `已连接`（绿点）/ `连接已断开`（琥珀）。
- 断开时在标题栏下方显示一条细横幅：**「连接已断开，正在自动重连…消息会排队，恢复后自动补发」**，
  `role="status"`；恢复后横幅消失，并短暂（3 秒）显示「已恢复连接」。
- 复用现有 `connectWs` 的 `onOpen/onClose`，**不改 ws 协议**；不显示重试次数（内部退避策略不是用户需要理解的东西）。
- 断线期间的补拉与已读补齐逻辑保持现状。

### D. 草稿可见

- `lib/drafts.ts` 增加：
  - `hasDraft(convId): boolean`（只看键是否存在，不解析内容）；
  - `subscribeDrafts(listener)` + `draftsVersion()` 轻量订阅（模块级版本号），
    让「正在输入 → 300ms 落盘」后标签/首页能实时亮起，而不是等下一次别的状态变化。
  - `setDraft` / `clearDraft` 成功变更后通知订阅者。
- `ConversationTabs`、`ChatConvStrip`：有草稿时显示琥珀色小圆点，
  `aria-label` / `title` 追加「有草稿」。
- 首页最近会话：有草稿时预览行显示 **`草稿：<正文>`**（截尾 40 字），
  优先于「点击查看消息/暂无消息」；无草稿时维持 A 的规则。

## 2. 明确不做

- 不做完整会话列表/侧栏改版（导航模型保持雷达 + 标签）。
- 不做真实 presence、`@我` 角标、好友/群成员管理、undo——各自需要独立规格。
- 不做会话滚动位置记忆（窗口化与未读定位交互复杂，留待单独验证）。
- 不把消息预览写入服务端（E2E 红线：正文只在本机）。
- 不引第三方依赖。

## 3. 风险与处置

| 风险 | 处置 |
|---|---|
| `lastMessageAt` 字段可选，旧客户端忽略；旧库首次查询为 null | 客户端把 null 排最后；无迁移 |
| SQLite 每会话一条 MAX 查询（N+1） | 会话数是个位数到几十；ISO 字符串有索引再用，先不做过度优化 |
| 分隔线数错（未读中包含不可见的链分发 / 表情事件控制行） | 改为**按 `lastReadAt` 时间边界定位**（第一条 `createdAt > lastReadAt` 的非自己消息）；旧服务端没有该字段时不画分隔线、直接回到底部 |
| 快照时 `conversations` 尚未加载 | 用「未捕获过就继续等 conversations 变化」的 effect；只有拿到会话数据才写快照 |
| 断线横幅反复闪 | 三态切换 + 恢复提示 3 秒；重连退避由 ws 层负责，UI 不抖动 |
| 草稿订阅造成额外渲染 | 版本号只在草稿**实际变更**时 +1；订阅者仅 3 个轻组件 |

## 4. 测试计划

| 文件 | 覆盖 |
|---|---|
| `shared` schema 无需新文件 | 类型编译通过由 web/server typecheck 兜 |
| `server/src/storeContract.test.ts` | 两实现、三种会话（group / direct / agent）：空会话 `lastMessageAt=null`、`lastReadAt=null`；发消息后等于消息 `createdAt`；自己发也算（时间事实，不是未读）；`markRead` 后 `lastReadAt` 更新 |
| `web/src/components/HomePage.test.tsx` | 7 行乱序输入按 `lastMessageAt` 降序取前 6（数组末尾最新排第一、最旧被截掉）；有 lastMessageAt 但未加载 → 「点击查看消息」；真无消息 → 「暂无消息」；有草稿 → 预览「草稿：…」 |
| `web/src/components/ChatPage.test.tsx` | 按 `lastReadAt` 插分隔线且滚到分隔线（含夹自己消息）；未读 0 不插；未读只来自不渲染的控制行 → 不画也不提示；锚点窗口外自动扩窗；分隔线冻结不漂移；旧服务端缺字段不画分隔线；断线横幅出现/恢复提示出现 |
| `web/src/components/ConversationTabs.test.tsx` | 有草稿的标签显示圆点与 aria-label「有草稿」；无草稿不显示 |
| `web/src/components/ChatConvStrip.test.tsx` | 同上（若文件不存在则并入 ChatPage 的渲染断言或新建） |
| `web/src/lib/drafts.test.ts` | `hasDraft` 真/假；set/clear 触发订阅；空串不误报 |

## 5. 验收

- 门禁：`pnpm -r build && pnpm -r --workspace-concurrency=1 test` 全绿（先单独 build shared）。
- 人工复核：断网进会话看横幅与恢复提示；有未读的会话打开停在「以下是新消息」；
  首页最近会话顺序与最近消息时间一致；写草稿切走再回来，标签上有圆点、首页显示「草稿：…」。
- 版本：`d.37.1.9.0`；CHANGELOG、HANDOFF、INDEX 同步。
