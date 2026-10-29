# d.39 全域消息感知 · 深度对抗与压测

- 日期：2026-10-28（执行 2026-10-29）
- 范围：`backgroundMessages` / `messageNotify` / `convPrefs` / `desktopNotify` /
  `chatSocketPresence` / `store/chat.bumpUnread` / `store/notifications` / `App` 后台生命周期 /
  `desktop/notify-bridge` / `preload` 通知桥
- 方式：先只新增测试复现（32 例，只测不改），再按确认缺陷修复生产代码；计时用
  `performance.now()`，只给宽松上界。
- 落地版本：`d.39.1.11.0`（修复轮）。原始 QA 记录：`.superpowers/qa/2026-10-28-d39-deep-stress.md`。

## 一、用例与观察

32 个用例分三处：`stress.d39.test.ts` 21 例、`d39.app-lifecycle.test.tsx` 6 例、
`notify-bridge.stress.test.js` 5 例。修复后全部按新行为断言并通过，作为回归资产保留。

### 1. 通过并固化为回归

| 组 | 覆盖 |
| --- | --- |
| A. 后台去重/风暴 | 同 id 1000 次只计 1 次；500 条 `seenIncoming` 上限最旧淘汰；未知会话 200 条同 tick 只刷新一次；免打扰只抑制提醒不抑制未读；`read_update` 自己清零/他人忽略；自己发的消息零副作用；agent 消息按普通来消息；E2E 空正文回退固定文案 |
| B. Presence / App 生命周期 | 200 轮注册/注销归零不为负；home↔chat 30 周期建连/关闭配平、无残留句柄；未登录不建连且通知点击忽略；已登录点击回跳会话 |
| C. 通知中心负载 | 2000 条不同通知压到 50 条 / 64KB；超长 conversationId 触发字节淘汰；同 key 2000 次只留 1 条；每次 push 同步写一次 storage |
| D. 桌面通知桥 | 1000 条不抛；null/数组/错类型回退默认文案；依赖抛错（窗口/构造/show/isSupported）不产生未捕获异常 |
| E. 性能计量 | 见下方压测数字表 |
| F. UX 排查 | 偏好坏 JSON / 深嵌套 / 超大不抛；跨账号 `seenIncoming` 共享（已接受）；通知合并；交接窗口误报 |

### 2. 修复前记录到的 8 个观察

1. **C3**：每次通知 push 同步序列化两次并同步写 localStorage（jsdom 下 0.059ms/次，Electron 同步落盘量级只能定性推断）。
2. **D2**：`\x00`/`\x07` 等 C0 控制符原样进入通知；孤立代理项原样保留；100k 字符 conversationId 原样透传。
3. **D4**：点击回调触发两次会回传两次 `notify:open`、聚焦两次。
4. **D5**：仅通话窗口在前台时仍会弹主窗口吐司（渲染层 `document.hasFocus()` 是主窗口口径）。
5. **后台失败无 UI**：非聊天页后台连接失败只有 `onEvent`/`onOpen`，无 `onClose`、无状态出口。
6. **幽灵会话**：点击已不存在的会话不崩，但会切到 chat 并渲染空壳。
7. **`seenIncoming` 跨账号**：模块级集合登出不清空；真实服务端 id 全局唯一时风险低。
8. **`bumpUnread` O(会话数)**：5000 条 1 会话 0.075ms/条 vs 200 会话 0.082ms/条，不是瓶颈。

## 二、压测数字（修复前实测，单次运行）

| 场景 | 总量 | 耗时 | 单次 | 备注 |
| --- | --- | --- | --- | --- |
| 消息热路径（1 会话） | 5000 条 | 375.7 ms | 0.075 ms | 未读 5000；修复前系统桥 5000 次 |
| 消息热路径（200 会话） | 5000 条 | 411.8 ms | 0.082 ms | 相对 1 会话仅 +10%，O(会话数) 不是瓶颈 |
| 通知 push（真实 jsdom localStorage） | 2000 次 | 118.3 ms | 0.059 ms | 同步 setItem 2000 次 |
| 页面切换 chat↔home | 100 次 | 615 ms | 6.15 ms | 建连 101、存活 1、泄漏 0 |
| 系统通知（纯 node 假 Notification） | 1000 条 | 2.0 ms | 0.002 ms | 仅桥层成本，不含 OS |
| 10MB 标题/正文清洗 | 20 MB | 118.5 ms | — | 按码点展开后截断 |

## 三、本轮修复（6 项）

1. **交接窗口伪未读**（`backgroundMessages.ts`）：`chatSocketCount() > 0` 且消息属于
   `activeConversationId` 时直接返回，当前可见会话由 ChatPage 自己 append / 标已读；
   其它会话照常计未读与提醒。新增单测（presence 1 + active c1 → c1 静默、c2 照常）。
2. **系统吐司合并**（`messageNotify.ts`）：按会话 5s 冷却（`DESKTOP_NOTIFY_COALESCE_MS`），
   窗口内只弹第一声；应用内通知仍逐条按 `message:<id>` 去重。新增 `resetMessageNotifyForTest`。
3. **conversationId 校验**（`notify-bridge.js`）：只接受 `/^[A-Za-z0-9._:-]{1,128}$/`，
   非法值回传 null（点击只聚焦，不开幽灵会话）。
4. **文本清洗**（`notify-bridge.js`）：`toWellFormed()` 处理孤立代理项（→ U+FFFD），
   C0 控制符替换为空格后再折叠；码点截断保留（emoji 不劈）。
5. **点击幂等**（`notify-bridge.js`）：点击回调只处理第一次，避免重复聚焦与重复 `notify:open`。
6. **通话窗口焦点**（`notify-bridge.js` + `main.js`）：新增 `getFocusedWindow` 依赖，
   任一应用窗口在前台即不弹；保留主窗口 `isFocused()` 二次复核。

## 四、仍然接受的限制

- **后台失败无 UI**：非聊天页断线/鉴权失败仍无可见反馈，本轮不新建 UI，列为下一轮 UX 项。
- **E2E 控制消息可能提醒**：后台不解密，表情回应 / 链分发等控制行也可能触发一条无正文提醒。
- **`seenIncoming` 跨账号**：进程内去重表不随登出清空；消息 id 为服务端 UUID，实际碰撞风险低。
- **通知中心同步持久化**：每次 push 同步序列化 + 写 localStorage，Electron 突发下可能卡主线程；
  本轮只做系统吐司合并，持久化去抖留待后续。
- **通话窗口焦点边界已修复**（原缺陷 6），但真实多窗口/OS 吐司时序仍只能真机验证。
