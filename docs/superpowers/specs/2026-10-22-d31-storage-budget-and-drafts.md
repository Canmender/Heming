# d.31 · 本机存储水位与草稿持久（P1-1 + P2-1）

- 日期：2026-10-22
- 相关版本：d.30.1.8.0（基线）、本 spec = d.31.1.8.0
- 上游依据：`docs/research/2026-10-22-deep-audit-followup-plan.md` §3 P1-1、§4 P2-1、§7 分轮表
- 涉及包：`packages/web`

## 0. 这一轮要解决什么

两个问题，一个共同的症状：**用户看得见的东西消失了，但没人告诉他为什么**。

1. **本机存储是一条 5MB 的单源预算，而键位设计的最坏情况已经超它一个量级**。
   浏览器/Chromium 的同源配额约 5MB。各处 `*BYTE_LIMIT` 各自为政、互不知情：
   记忆 4 键 × 1.2MB + 任务 1.1MB + 召回日志 256KB + 用量账本 64KB + 通知 64KB +
   **每会话 500 条明文缓存且会话数不设上限**（`heming.msgCache.<convId>`）。
   超配额时 `setItem` 抛 `QuotaExceededError`，各处的兜底是「回退空表 / 静默不落」——
   表现为**记忆权重无故退回 ×1、任务记录消失**这类无法解释的降级，界面上没有任何水位。
2. **草稿不持久 + 跨会话串字**。`ChatPage` 的 `draft` 是组件态（`useState("")`），
   而 `ChatPage` **常驻底层**（保持 WS/流式状态，切会话不卸载）⇒ 上一个会话写一半的字
   直接带进下一个会话；同时刷新即全丢。

本轮把这两件事一次做完。**不做新功能**——但「本机存储水位条」是用户可见的新界面元素，
按 `docs/VERSION-MANAGEMENT.md` 的口径走**特性位 +1**。

## 1. 已核实的事实（本轮亲自读过源码）

| 编号 | 事实 | 位置 |
|---|---|---|
| P1-1 | 记忆 4 键各 1.2MB 上限 | `packages/web/src/lib/memory/storage.ts:9-13,17` |
| P1-1 | 任务 1.1MB | `packages/web/src/lib/tasks/store.ts:39` |
| P1-1 | 模板 128KB / 通知 64KB / 召回日志 256KB / 用量账本 64KB | `tasks/templates.ts:26`、`store/notifications.ts:29`、`memory/recallLog.ts`、`memory/usage.ts` |
| P1-1 | `msgCache` 每会话 500 条，**会话数不设上限** | `packages/web/src/lib/e2eSession.ts:43,917-925` |
| P1-1 | `writeJson` 超配额**返回 false**（静默不落），不抛、不提示 | `packages/web/src/lib/memory/storage.ts:94-113` |
| P1-1 | `readJson` 读不到/损坏 → 回退 fallback（空表） | `packages/web/src/lib/memory/storage.ts:73-92` |
| P1-1 | 全仓共 41 个 `heming.*` 存储键（不含 `msgCache.*` 的动态后缀） | grep 全景 |
| P2-1 | `const [draft, setDraft] = useState("")` —— 组件态，不落盘 | `packages/web/src/components/ChatPage.tsx:479` |
| P2-1 | `onDraftChange` 只 `setDraft`，无持久化 | `packages/web/src/components/ChatPage.tsx:1887` |
| P2-1 | 发送成功后 `setDraft("")`（清空点已存在） | `packages/web/src/components/ChatPage.tsx:2029` |
| P2-1 | 任务区投递用 `setDraft(taskDraft.text)` 覆写输入框 | `packages/web/src/components/ChatPage.tsx:2042` |

## 2. 决策

### 2.1 P1-1 拆成三步，但本轮只做前两步

调研原文给的是三步：①水位可见 ②统一淘汰优先级 ③把最大块搬走（桌面端改走文件 / IndexedDB）。

**本轮做 ① 与 ②，不做 ③**：

- **③（搬走）**要动桌面端文件桥或引 IndexedDB，属于架构变更，需要单独的设计规格与迁移方案，
  硬塞进这一轮会让「可见 + 有序淘汰」这两件确定要做的事被拖住。
- **但 ② 的设计必须为 ③ 留门**：`msgCache` 是最大的无上限块，本轮的 LRU 淘汰是**止血**，
  不是根治。真要根治得把它搬出 localStorage——这是 d.32 之后的事。

### 2.2 ① 水位可见：设置页加「本机存储用量」条

**读什么**：遍历 `localStorage` 的全部键，逐键算 UTF-8 字节数，按**模块**分组汇总。

**为什么按模块分组而不是给一个总数**：总数只能说「快满了」，分组能说**「是任务记录占的」**。
用户看到「记忆 2.1MB / 任务 1.1MB / 明文缓存 3.4MB」才知道该去哪儿清理。

**分组规则**：键名前缀 → 模块名。用一张显式映射表，不做模糊匹配：

| 键前缀 | 模块名 |
|---|---|
| `heming.msgCache.` | 明文缓存 |
| `heming.memory.working.` / `heming.memory.episodic.` / `heming.memory.semantic.` | 记忆 |
| `heming.memory.`（其余） | 记忆 |
| `heming.tasks.` / `heming.taskTemplates.` | 任务 |
| `heming.e2e.` / `heming.x3dh.` | 加密会话 |
| `heming.mcp.` / `heming.mcpRegistry.` | 接口与 Registry |
| `heming.selfEdit.` / `heming.selfAudit.` | 自我修改 |
| `heming.skills.` / `heming.skillBindings.` / `heming.skillAssignments.` | 技能 |
| `heming.hitl.` | HITL |
| `heming.recallLog` / `heming.memory.recallLog` / `heming.memory.usage` / `heming.notifications` | 辅助账本 |
| 其余 | 其它 |

**关键约束**：**只统计字节数，不读内容**。这是本机存储，统计本身不该把明文拉进内存
（尤其 `msgCache.*` 里是解密后的消息正文）。

**阈值**：总量 ≥ 80% 配额 → 变黄并显示提示；≥ 95% → 变红。
**配额值怎么定**：不硬编码 5MB。Chromium 的实际配额随磁盘可用空间浮动（通常是磁盘的 10%，
下限 5MB / 上限 20% 磁盘）。所以**优先实测**：往一个临时键写数据探测到 `QuotaExceededError`
为止，能测出实际配额就测；测不到（隐私模式等）就回落到 5MB 保守值，并标注「估算」。

实测代价：为了测配额要写满几 MB。这在设置页打开时做一次太重。
**改为：只在用户点「重新检测」时实测**，默认用 5MB 保守估计值并明确标注。

### 2.3 ② 统一淘汰优先级

**现状**：每个模块各自 `prune*`，彼此不知情，也没有全局视角。

**本轮做两件事**：

**(a) `msgCache` 加全局会话数上限（LRU）**

现状：每会话 500 条（`CACHE_CAP`），但**会话数不设上限** ⇒ N 个会话就是 N × 500 条。

**做法**：加一个「哪些会话的缓存最久没被打开」的账本（独立小键
`heming.msgCache.lru.v1`，存会话 id → 最后打开时间戳），会话数超过上限（取 **20**）时
淘汰**最久未打开**的那个会话的整份缓存。

**为什么是 20**：明文缓存是「解密后的消息正文」，它的作用是「换设备/清缓存后仍能渲染已解密消息」。
保留 20 个会话覆盖了绝大多数人的活跃范围；再多是存储换不来体验。

**为什么单独一个键而不是扫 `localStorage`**：扫全部键找 `msgCache.` 前缀要读出每个键的**值**才能
判断，而 `localStorage` 没有「只列键名」的 API（只能 `key(i)` 拿键名）——
所以扫键名是可行的（不必读值），但每次都扫 41+ 个键在每次 append 时做一遍太浪费。
独立小键让 O(1) 取到「最久未打开的会话」。

**(b) 存储水位条上给「一键清理」的入口**

只给水位不给出口等于让用户看着一个数字发愁。所以水位条旁边要有：
- **「清理明文缓存」**（可再生：消息正文能从服务端重新拉，只是要重新解密）
- **「清理任务记录」**（可再生：任务记录是本机流水，重跑就有）

**不可再生的不清**：记忆条目（用户资产）、E2E 私钥与棘轮（丢了就是永久丢）。

### 2.4 P2-1 草稿按会话持久

**键**：`heming.draft.<convId>`，一个会话一键。

**为什么不放进现有的 store**：草稿是「当前输入框的瞬时状态」，不是全局状态；
放进 `store/ui.ts` 会让草稿跟着全局 store 走，反而变成跨会话共享的一锅粥。

**上限**：
- **LRU 20 个会话**（与 msgCache 一致的口径：一个数量级的东西用同一把尺子）
- **单条截尾 2000 字**（超长草稿截断，尾部加省略标记）
- 会话被清理时（`clearConversation`）草稿也要清

**读的时候**：`ChatPage` 挂载 / `convId` 变化时，按当前 `convId` 取草稿。
**不能靠卸载重置**——`ChatPage` 常驻是刻意的（保持 WS 与流式状态）。

**写的时候**：`onDraftChange` 时写盘。
**写盘的节流**：每敲一个字都写一次 localStorage 是不必要的开销。
用「**停止输入 300ms 后写**」的节流（`setTimeout`），并在 `convId` 变化 / 发送成功时立即落盘。

**发送成功即清**：发送成功后删掉该会话的草稿键（这一条 d.30 之前就有 `setDraft("")`，
现在补上「删盘上的那份」）。

**任务区投递**：`setDraft(taskDraft.text)` 覆写输入框时也要同步写盘
（否则投递来的任务文本刷新就没了）。

## 3. 兼容与迁移

| 项 | 兼容性 |
|---|---|
| 存储水位条 | 纯新增界面元素，不影响既有数据 |
| `msgCache` LRU | 新增独立键 `heming.msgCache.lru.v1`；**老用户没有这个键** ⇒ 首次打开会话时按访问顺序重建，不影响已有缓存 |
| 草稿键 | 新增 `heming.draft.<convId>`；老用户没有 ⇒ 首次进来是空草稿（与今天一致） |
| 配额探测 | 保守估计 5MB；点「重新检测」才实测（会写满几 MB，故不自动做） |

## 4. 测试计划

| 文件 | 覆盖 |
|---|---|
| `web/src/lib/storageUsage.ts`（新建） | 按模块分组统计字节数；`msgCache.*` 归到「明文缓存」；未知键归「其它」；**不读值**（用桩验证只调 `key(i)`/`length`） |
| `web/src/lib/storageUsage.test.ts`（新建） | 分组正确性；总字节数 = 各键之和；配额探测成功/失败两条路径 |
| `web/src/lib/drafts.ts`（新建） | 按会话存取；截尾 2000 字；LRU 20 个会话；发送后清除 |
| `web/src/lib/drafts.test.ts`（新建） | 存取、截尾、LRU 淘汰、清除 |
| `web/src/lib/e2eSession.test.ts` | msgCache 会话数超上限 ⇒ 最久未打开的会话缓存被清；LRU 账本坏 JSON ⇒ 回退空表不抛 |
| `web/src/components/ChatPage.test.tsx` | A 会话写草稿 → 切到 B → B 是空且 A 回来还在；发送成功后草稿清空 |
| `web/src/components/SettingsPage.test.tsx`（或新卡测试） | 水位条渲染；超 80% 变黄；「清理明文缓存」按钮点了之后字节数下降 |

## 5. 不做 / 边界

- **不做** ③「把最大块搬走」（桌面端文件 / IndexedDB）——架构变更，另立轮次。
- **不做** 统一淘汰的全局仲裁器（一个中心化的 LRU 管理所有模块）——那是 ③ 的前提，
  本轮只在 `msgCache` 这一个真正无上限的块上做局部 LRU。
- **不删** 不可再生数据（记忆条目、E2E 私钥/棘轮）——「一键清理」只给可再生的。
- **不做** 草稿的云端同步——草稿是本机数据，不出设备。
- **不做** 消息列表窗口化（P2-2）——排在 d.33，且要与 P1-1 的存储上限合流复测。
- **不引第三方依赖**——配额探测、LRU 都是几十行的事，不值得为它加依赖。
