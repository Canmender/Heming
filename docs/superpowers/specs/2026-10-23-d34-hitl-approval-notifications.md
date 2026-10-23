# d.34 · HITL 待确认进通知 + 不再「切会话 = 拒绝」（P2-4）

- 日期：2026-10-23
- 相关版本：d.33.1.8.0（基线）、本 spec = d.34.1.8.0
- 上游依据：`docs/research/2026-10-22-deep-audit-followup-plan.md` §4 P2-4、§7 分轮表
- 涉及包：`packages/web`

## 0. 这一轮要解决什么

两件都在「用户没看见」的时候替他做了决定：

1. **切会话 = 替用户拒绝**：`ChatPage` 在 `convId` 变化时调 `cancelForConversation(previous)`，
   把上一个会话的待确认请求**直接 resolve 成空裁决**（全部拒绝）。
   用户只是去看了眼别的会话，回来发现工具没执行、模型收到「被拒绝」——
   而他本人从没点过任何按钮。
2. **待确认不产生通知**：后台会话的确认请求只能靠弹窗（弹窗还在，但用户可能正在别的页面），
   通知中心里没有任何痕迹。等用户回来，弹窗可能已经因为切会话被拒掉了（见 1）。

## 1. 已核实的事实（本轮亲自读过源码）

| 编号 | 事实 | 位置 |
|---|---|---|
| P2-4 | 切会话时 `cancelForConversation(previous)` 触发 | `packages/web/src/components/ChatPage.tsx:1949` |
| P2-4 | `cancelForConversation` 把该会话的等待者 `resolve([])`（空裁决 = 全拒） | `packages/web/src/store/hitl.ts:193-215` |
| P2-4 | 待确认是**单槽 + 队列**，跨会话请求会排队并带上归属标签 | `packages/web/src/store/hitl.ts:60-75` |
| P2-4 | 弹窗已支持「来源会话」标签与跳转（`pendingElsewhere` / `onOpenConversation`） | `packages/web/src/components/ChatPage.tsx:1161-1178` |
| P2-4 | 通知只有 `message` / `task` 两种 kind | `packages/web/src/store/notifications.ts:31` |
| P2-4 | 审计在 `ChatPage` 的 `onDecide` 里写（批准与拒绝都记） | `packages/web/src/components/ChatPage.tsx:3436-3447` |
| P2-4 | 全仓**没有** 60 分钟超时常量（计划里提到的「60 分钟队列口径」此前未落地） | grep |

## 2. 决策

### 2.1 切会话不再自动拒绝

- **删掉** `ChatPage` 里 `convId` 变化时调 `cancelForConversation` 的那个 effect。
- **删掉** store 的 `cancelForConversation` 方法及其两条单测（不再有调用方，留着就是死代码）。
- 待确认请求**跨会话保持**：切走后它仍是单槽/队列里的待定项，弹窗继续显示并标注来源会话；
  回来后裁决仍在等它。

**为什么安全**：这不是放行，是**不替用户做拒绝的决定**。闸门仍在等裁决，
在裁决到达前**工具不会执行**（闸门的兜底方向是「不执行」）。用户切走再回来，
最坏情况是「这轮对话还在等」——比「用户没同意却被记成拒绝」好。

### 2.2 待确认进通知中心（`kind: "approval"`）

- `NotificationKind` 增加 `"approval"`；通知中心标签 `approval → 确认`。
- **推送时机**：某个工具确认请求进入待定、且它**不属于当前正在看的会话**时，
  推一条：
  - `key`: `approval:<requestId>`（去重键，重连/重渲染不会重复推）
  - `title`: `{agentName} 请求调用工具`
  - `body`: 工具可读名列表 + 「等待确认」
  - `conversationId`: 来源会话（点通知即跳回）
- **不推送的情况**：请求属于当前会话——弹窗就在眼前，再推一条只是噪音。
- **清除时机**：用户裁决（允许/拒绝）或超时后，按 `key` 移除这条通知，
  免得用户点开一个已经处理完的「待确认」。

### 2.3 超时：60 分钟，按拒绝收口，**要留痕**

- `HITL_APPROVAL_TIMEOUT_MS = 60 * 60 * 1000`（60 分钟）。
  计划里的「60 分钟队列口径」此前未落地，本轮把它定死在这里。
- 计时从请求**成为当前待定项**开始（队列里的请求等排到时再计时）。
- 超时后：
  - 逐项给出 `deny`，`reason: "超时未确认"`；
  - **写审计**（`rejected: "超时未确认"`）——与用户手动拒绝可区分；
  - 移除 approval 通知，另推一条
    `key: approval-timeout:<requestId>`、`title: 工具确认已超时（已按拒绝处理）`。
- 为什么是 60 分钟：短了会把「用户去开个会」变成误拒；长了会让一轮对话无限挂起。
  60 分钟足够覆盖正常离开，又不至于挂到用户忘记这件事。

### 2.4 裁决的收口只有一处

用户点击、超时两条路径**都走同一个内部函数**（写审计 → `decide` → 清通知），
避免「超时路径忘了审计」这类分叉。审计仍是「批准与拒绝都记一笔」的既有口径。

## 3. 兼容与迁移

| 项 | 兼容性 |
|---|---|
| 通知 kind | 新增 `"approval"`；老通知不受影响，`normalizeNotification` 放行新值 |
| 切会话行为 | 由「自动拒绝」改为「保持待定」——这是**行为变更**，但方向是「少替用户做决定」 |
| store 方法 | 删除 `cancelForConversation`（无调用方）；`cancelAll`（页面卸载/停止）保持原样 |
| 超时 | 60 分钟；老用户没有该配置，无迁移 |

## 4. 测试计划

| 文件 | 覆盖 |
|---|---|
| `store/hitl.test.ts` | 删除 `cancelForConversation` 两条；保留 `decide`/`cancelAll` 队列语义 |
| `store/notifications.test.ts` | `approval` 能落盘/读回；`removeByKey` 按 key 删除且不动其它条 |
| `components/NotificationCenter.test.tsx` | `approval` 标签为「确认」；点击跳到 `conversationId` |
| `components/ChatPage.test.tsx` | **确认框在飞时切会话 → 通知里有 1 条 approval、切回来后弹窗仍在**；当前会话的请求**不**推通知；**超时（fake timers 推进 60 分钟）→ 审计记 denied 且原因是「超时未确认」、弹窗消失、通知被替换为超时提示** |

## 5. 不做 / 边界

- **不做**多槽并发确认（单槽 + 队列是既有设计，一次只问一件事）。
- **不做**「免打扰 / 静音确认」——确认是安全边界，不能被静音。
- **不做**把确认通知推到系统通知（系统通知权限与跨窗口聚合是另一件事）。
- **不改**闸门的判定逻辑与兜底方向（异常/无裁决一律不执行）。
- **不改** `cancelAll`（页面卸载/用户停止时全部拒绝）——那是显式动作，语义正确。
