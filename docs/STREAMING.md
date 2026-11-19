# 流式输出对照：DSH 怎么把回答送到屏幕上

> 对象：DSH（`D:\testprogram\deepseek-harness-master`）与和鸣（本仓库）。
> 目的：说清「模型正在回答」这段时间里，DSH 传了什么、屏幕上出现什么、按什么规则合并与折叠；
> 再逐项对照和鸣现状，给出可执行的优化清单。
> 文中 DSH 路径相对 DSH 仓库根，和鸣路径相对本仓库根。

## 0. 两个仓库的起点不同

| | DSH | 和鸣 |
|---|---|---|
| 前端与后端 | 同一个进程内两套包（`packages/core`、`packages/api`、`packages/client`） | 桌面壳 + 本机服务，前端 `packages/web` 走 WebSocket |
| 传输 | 一条 WebSocket 多路复用（`/api/remote.mux`），流就是 RPC 的 `AsyncIterable` | 自建 WS 事件（`agent_chunk` / `agent_finish` / `agent_error` …），E2E 信封加密 |
| 事件语义 | 传输层只有 `item / error / end`，语义在负载里 | 事件类型即语义（`agent_chunk`、`tool_trace` 等） |
| 落库 | 服务端持久事件 + 紧凑的流记录（`{time0, dt[], texts[]}`） | 服务端只存密文；明文靠本机缓存与发送链种子重解 |

结论：**能直接对齐的是「屏幕上出现什么」与「合并/折叠规则」，传输格式不必照搬**（我们是加密事件流，DSH 是单机 RPC）。

---

## 1. DSH 的链路：一帧一 chunk，前端按绘制帧合并

```
provider SSE ──► StreamChunk（text-delta / reasoning-delta / tool-call-delta / usage …）
                 │ 1 delta = 1 chunk
                 ▼
        AssistantStreamAttempt.push()   → 打 Date.now()、revision++、index++
                 ▼  进程内事件 agent/assistant-stream
        SessionAssistantStreamAccumulator   （供快照/断线补齐）
        AssistantStreamListener             （每连接 1:1 入队）
                 ▼ WebSocket /api/remote.mux，一帧 = 一条 JSON
        RemoteStreamMuxClient → RemoteJournalStream（快照优先 + 游标 + 补洞）
                 ▼
        ClientAssistantStream（瞬态行用分数 seq 插进已提交事件流）
                 ▼
        ui-chat / ui-tool 节点 → 三级发布（none / animation-frame / immediate）
                 ▼
        React 渲染（三次 rAF 才真正 flush）
```

要点（都带出处）：

1. **一帧一 chunk，后端不合并**。`packages/core/agent-loop/src/assistant-stream.ts:60-72` 每来一个 delta 就发一帧，`revision`、`index` 各 +1；`packages/api/gateway/src/stream-protocol.ts:254-257` 只有 `item / error / end` 三种帧。
2. **帧自带顺序**：`start {attemptId, revision, startedAfterSeq, turn, step}`、`chunk {revision, index, time, chunk}`、`end {outcome: committed|abandoned}`（`packages/api/session-controller/src/types.ts:520-550`）。宿主强校验 `revision === +1`、`index === nextIndex`，跳号就丢整次尝试；连接侧跳号直接判「载体丢失」，重开会话流并全量 rebaseline（`packages/api/session-controller/src/client/transport.ts:208-217`）。
3. **断线/刷新能补出半截回答**：会话流是「快照优先 + 游标续接 + 补洞」，`RemoteJournalStream` 负责（`packages/api/gateway/src/client/journal-stream.ts:83-89,305-336`）。和鸣目前刷新即丢正在生成的气泡。
4. **落库才打包**：`packages/llm/llm/src/assistant-stream.ts:19-52` 把相邻同类 delta 压成 `{time0, dt[], texts[]}`，还能无损还原每个时间戳（TTFT、解码速度都能重算）。在线传输保持 1:1，延迟最低。
5. **重绘由事件自己声明档位**：`none / animation-frame / immediate` 取最大值（`packages/client/ui-conversation/src/client/conversation/assembler.ts:90-107`）；文本增量 `animation-frame`，`usage`/`finish` 直接 `none`（不重绘），回合结束 `immediate`（`packages/client/ui-chat/src/client/conversation-nodes/assistant.ts:332-337`、`tool.ts:331`）。
6. **合并发生在绘制层**：`publication === 'animation-frame'` 时连跨三次 `requestAnimationFrame` 才 flush（`packages/client/ui-conversation/src/client/conversation/assembly.ts:141-158`）。

---

## 2. DSH 屏幕上出现什么（按时间顺序）

### 2.1 正在生成时

| 位置 | 内容 | 出处 |
|---|---|---|
| 正文 | Markdown 逐段长出，**没有打字光标** | `packages/client/ui-chat/src/client/chat/AssistantMarkdown.tsx:149` |
| 思考 | 一行「思考」折叠条，摘要 = 最近一个**已完成段落**的首行；展开才挂正文 | `.../ReasoningRow.tsx:17-33,64-82` |
| 工具调用 | 一行摘要（如「读取 · src/app.ts」），执行中整行 shimmer；参数还在流里就能先显示 `description` / `file_path` | `packages/client/ui-tool/src/client/tool/models/tool-call-model.ts:289-300,412` |
| 状态行 | 消息流末尾固定一行：「深度求索中，用时 12 秒 ···」+ 鲸鱼尾动画；**1 秒一跳**，断连冻结秒数，回合已结但状态未落时只占位不播报 | `.../RunningStatus.tsx:12-45`、`message-chrome.ts:13` |
| token / 速度 | **生成中不显示**；结束后才有用量药丸 | `.../TurnUsagePanel.tsx:42-51` |

### 2.2 生成结束后

1. **过程收成一行**：`已完成，用时 2 分 13 秒` 或 `已停止` / `处理失败`（停止与失败不显示耗时），点开才看思考与工具（`.../TurnProcessNodeView.tsx:24-30`）。
2. **正文保留**，尾部若有中断则追加「已停止」（`AssistantMarkdown.tsx:152-154`）。
3. **用量药丸**：`provider/model`、cache 命中、input/output、推理 token，点开是 dialog（`TurnUsagePanel.tsx:69-103`）。
4. **会话级统计在输入区**：轮/步、首 token 平均（TTFT）、`tok/s`（`StatsPills.tsx:251-294`）。

### 2.3 边界态

- **用户停止**：正文尾部「已停止」；未完成的工具行变 `stopped` 或隐藏；后端补一条 `assistant/message{interrupted:true}`（`packages/core/agent-loop/src/agent.ts:505-537`）。
- **错误**：行内一条 `role="status"` 的错误条（标题 + 原因 + 错误码），不是 toast（`.../MessageItem.tsx:132-146`）。
- **重试**：折叠 details，摘要行带倒计时 `重试中（2/5）· 4s`，展开看延迟与失败原因（`MessageItem.tsx:39-128`）。
- **压缩**：一行「上下文已压缩 · 已压缩 N 条历史记录（约 M tokens）」，可展开看摘要（`.../CompactionItem.tsx:49-73`）。
- **子代理/后台任务**：作为「本轮触发行」插在回合前，展开看通知正文（`TurnTriggerNodeView.tsx:44-55`）。

### 2.4 渲染性能的三个关键做法

1. **冻结前缀 + 只重解析尾部 2 块**：`packages/client/ui-primitives/src/markdown/incremental.ts:38,338-340`，缓存块用 source offset 做 key，追加时是 reconcile 不是 remount。
2. **未闭合代码块走「第二前沿」**：只重解析最后一条完成行 + 当前半行，并原地扩写 `Code` 节点；高亮用 TextMate 按行前进（`incremental.ts:195-301`、`highlight.ts:592-612`）。
3. **文本没变就零成本返回**：`MarkdownText.tsx:92` `if (text === this.lastText) return this.lastRendered`。

---

## 3. 和鸣现在是什么样

| 环节 | 现状 | 位置 |
|---|---|---|
| 收 chunk | 每个 delta 直接 `upsertStream`，**每次提交都重渲染整页** | `packages/web/src/components/ChatPage.tsx:2941-2951` |
| 累积 | 本机传累计全文；他机按 `text: 上一段 + e.text` 拼接 | `packages/web/src/store/chat.ts:1043-1066` |
| 渲染 | 整段 Markdown 每帧重解析；有打字光标 `▌` | `packages/web/src/components/AgentStreamBubble.tsx:97-109` |
| 思考 | 流式时默认展开、整段更新；结束后折叠成一行 | `AgentStreamBubble.tsx:173-181` |
| 工具 | 每次调用一行，参数/结果可展开；**结束后也不收起** | `AgentStreamBubble.tsx:222-391` |
| 进度 | 输入框下方一行「第 3 步 · 正在执行 file_grep · 已跑 42 秒」 | `TurnProgressLine.tsx`、`lib/agentRuntime/turnProgress.ts:156-166` |
| 中断/错误 | 气泡内错误行 + 「重试」按钮 | `AgentStreamBubble.tsx:110-120` |
| 工具轮中间话术 | **先缓存，轮末若有工具调用就整段丢弃** | `packages/web/src/lib/agentStream.ts:1535-1544,1618` |

---

## 4. 差距清单（按用户能感知的程度排序）

| # | 差距 | DSH | 和鸣 | 影响 |
|---|---|---|---|---|
| 1 | 工具轮里「我先看一下…」这类正文 | 边到边显示，留在记录里 | 被缓存后丢弃 | 干活时空屏，像卡住 |
| 2 | 每 token 一次 React 提交 | 三次 rAF 合并 + 整段没变就短路 | 每次 delta 一次 store 提交 | 长回答发烫、滚动发涩 |
| 3 | 整段 Markdown 每帧重解析 | 冻结前缀，只解析尾部 2 块 | 全量重解析 | 越到后面越慢 |
| 4 | 结束后的过程 | 收成「已完成，用时 X」一行 | 工具列表全部摊开 | 历史很长、翻不动 |
| 5 | 生成中的用时 | 消息流末尾一行实时走秒 | 输入框下方一行 | 视线要离开回答 |
| 6 | 首 token / 速度 | 输入区胶囊：TTFT、tok/s | 没有 | 不知道自己等得值不值 |
| 7 | 刷新/断线时的半截回答 | 快照 + 游标补齐 | 气泡直接消失 | 生成中断的错觉 |
| 8 | 停止的收尾 | 正文尾「已停止」+ 未完成调用标 stopped | 气泡消失、留一条错误 | 「刚才那些字呢」 |
| 9 | 压缩提示 | 行内一条可展开 | 输入区上方一句 notice | 位置不稳 |
| 10 | 无障碍 | 流式正文刻意不进 live region，只有状态行播报 | 已一致（`sr-only` 只报状态） | — |

---

## 5. 优化清单（d.352 起，按性价比）

进度标记：✅ 已落地（注明版本）／⬜ 未做。

### A. 立刻做（低风险，用户可感知）

1. **工具轮正文实时显示，不再丢弃**（对应差距 1）⬜
   - `agentStream.ts` 的 `onDelta` 在工具轮里同样走 `emitDelta`（首轮尝试才上行），保留 `roundText` 供上下文；删掉 `roundChunks` 的轮末补发。
   - 结束消息的正文因此包含这些「过渡话术」，与 DSH 的 text block 语义一致。
2. **绘制帧合并**（差距 2）✅ d.352
   - `ChatPage.onLocalDelta` 只记最新累计文本，用 `requestAnimationFrame` 合并一次 `upsertStream`；收口/工具/错误事件到来前强制 flush，保证状态不落后。
3. **结束后的过程收起**（差距 4）✅ d.352
   - 历史消息默认渲染一行「处理过程 · N 步 · 用时 X」，点开才是步骤表；进行中保持展开。

### B. 第二步（中等改动）

4. **Markdown 增量渲染** ✅ d.353（前缀冻结 + 尾部 2 块，见 `packages/web/src/lib/markdown/blocks.ts`；代码块未闭合时从围栏那块起都算尾部）
5. **消息流末尾的运行行** ⬜
   - `已用 12 秒` + 呼吸点，位置在最后一个气泡之后；输入框下方那行保留「第几步 · 正在做什么」。
6. **TTFT / tok/s** ⬜
   - 在回合结束的用量处补两项，数据来自供应商 usage 与首 chunk 时间（本地已有 `startedAt`/首个 delta 时刻可算）。

### C. 需要动传输/存储（先记着）

7. 断线补齐：本机流可以在 `localStorage` 里留一份「最后 N 条流式快照（加密）」，挂载时先渲染再接流。⬜
8. 停止的收尾：保留已生成的半截正文，并在尾部标注「已停止」，而不是整条气泡消失。⬜

### D. d.353 追加：后台作业的诚实收尾 ✅

9. 后台子代理不随刷新静默消失：`subagentJobs.ts` 落盘 queued/running 元数据，启动时 `restoreInterruptedJobs()` 标成「被重启中断」并按失败任务交付（见 HANDOFF d.353）。

---

## 6. 不建议照搬的部分

- **一条 WS 多路复用 + 流即 RPC**：我们是加密事件 + 桌面壳，改传输收益远小于风险。
- **`{time0, dt[], texts[]}` 紧凑落库**：我们的服务端只存密文，明文由本机保管，压缩收益不落在同一处。
- **虚拟滚动**：DSH 消息列也没有虚拟滚动（只给右侧导航条用），我们消息量更小，先解决重解析更划算。
- **`hidden="until-found"` / 折叠动画与滚动补偿同帧**：属于打磨项，等结构稳定后再抄。

---

## 7. 验收方式

- 单元：`agentStream` 的工具轮正文断言（流式期间 `onLocalDelta` 收到、结束时 `finish.text` 含它）；`ChatPage` 的绘制合并用例（同一帧内多次 delta 只触发一次 `upsertStream`）。
- 手测：长回答（> 3000 字）+ 多工具任务，观察是否还发烫、工具轮是否还有空白期、结束后过程是否收起。
