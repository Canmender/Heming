# 本体第二轮：刷新恢复当前页与会话（d.79.2.42.0）

- 日期：2026-11-07
- 分支：`feat/d77-heming-core`
- 来源：本体第一轮审计 P1-1（「任何页按 F5 都回到主页，智能体页已打开的会话、团队页所选视图全部重置；
  地址栏始终是 `/`，没有路由」）
- 范围：`store/ui.ts` 页面状态持久化；插件区两处小修（工具描述去 Markdown、模块「全部恢复启用」反馈）

## 1. 为什么不是路由

项目没有 URL 路由（Electron `app://` 内嵌产物、桌面端重启回主页是既有口径）。加一套路由要动
`App` 渲染、导航、命令面板、通知跳转、旧链接兼容与测试，收益却只是「刷新不丢页」。因此选择
**会话级视图快照**：

| 键 | 存储 | 生存期 | 内容 |
|---|---|---|---|
| `heming.session.view.v1` | `sessionStorage` | 本次渲染进程会话（刷新保留、重启清空） | `{ page, activeConversationId }` |

决策依据：

- **刷新要留住**：F5 是常见操作，聊到一半被弹回主页是明确的痛点；
- **重启要回主页**：关窗再开是新一次使用，上一个会话的页面是过期意图（与「桌面端重启回主页」口径一致）；
- **偏好才落 localStorage**：页面与会话属于这一次使用，不是需要记住的偏好（导航顺序/主题等仍走 localStorage）。

只恢复宿主页 `Page` 与 `activeConversationId`。宿主页内部 Tab（团队看板 / 智能体任务 / 插件区各 Tab）
是页面局部 state；恢复它需要每页自己声明持久化策略，超出本轮「刷新别丢上下文」的诉求，留作候选。

## 2. 实现要点

1. `readSessionView()`：只认 `DEFAULT_NAV_ORDER` 里的宿主页；旧合并页 id（workspace/tasks/skills/interfaces）
   不恢复（旧链接兼容由 `resolvePage` 负责，不在刷新路径）；非 JSON、缺字段、非字符串 id 一律回落 null。
2. `writeSessionView()`：存储被禁用/配额满时静默失败（内存态已生效，刷新回主页不是错误）。
3. store 初始化读一次快照；**写盘收口在 store 订阅**，只比较 `page` 与 `activeConversationId`：
   `setPage` / `openConversation` / `leaveConversation` / 各页「回主页」等十来个入口不会漏写。
4. 会话 id 失效时 `AssistantPage` 的 `activeConv` 找不到 → 回到「选择一个智能体开始」空态，不崩。
5. 模块页被停用时 `App` 已有 `isPageAvailable` 兜底落到主页，与恢复逻辑不冲突。

## 3. 插件区两处小修（同一轮）

- **工具描述去 Markdown**：`plainToolDescription()` 去掉 `**`/`__`/反引号并压空白，完整原文放 `title`。
  工具描述是写给模型看的，直接展示会出现字面量 `**不是**`。
- **模块「全部恢复启用」**：3/3 全启用时禁用 + `title` 说明；点击后在状态行追加「已全部恢复启用」。
  此前按钮永远可点、点完没有任何反馈。

## 4. 验证

- 单测：`store/ui.test.ts` +4；`ModulesView.test.tsx` +1 改 1；`PluginToolPanel.test.tsx` 新增 3。
- 真实浏览器：智能体页打开会话 → F5 仍在原会话（草稿保留）；团队页 → F5 仍在团队页；控制台 0 error。
- 门禁：见提交说明（全量 build + 四包 test + typecheck）。

## 5. 未做 / 候选

- 宿主页内部 Tab 的刷新恢复（团队看板、智能体任务、插件区 Tab）——需要各页声明式接管。
- 恢复「上一次所在会话的消息滚动位置」——属于滚动记忆，单独做。
- 更新日志拆「用户版发布说明」、记忆区默认智能体、模型 Tab 首跑引导仍在第一轮规格的候选清单里。
