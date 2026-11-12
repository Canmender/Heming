# 信息中枢（沙箱 bundle 插件）

信息中枢把本机 QQ / 微信聊天归档、全文检索与会话日程收在一个只读界面里。采集与归档全部在本机完成，插件本身不接触数据库文件，也不发起网络请求。

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
- `contributions.page`：插件页面，`entry: "files/index.html"`。
- `contributions.homeCards`：首页卡片 `infohub`，点击进入 `plugin:heming.infohub`；页面加载状态后通过 `homeCardSet` 覆盖为“已归档 N 个会话 · M 条消息”与逾期/今天/本周数量。
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
| `homeCardSet("infohub", { text, detail })` | 刷新首页卡片文案 |
| `notify({ title, body })` | 手动采集完成通知 |
| `info() / onEvent({ kind: "theme" })` | 跟随宿主深浅色 |
| `log(line)` | 启动日志 |

所有桥方法都做了存在性检测：旧宿主缺少 `infohubCall` 时页面显示“当前桌面端版本还不支持信息中枢插件调用”，缺少 `notify` / `homeCardSet` 时静默降级。

## 功能

- 三个页签：检索、会话、日程；页头显示连接状态、归档会话数与归档大小。
- 采集来源区：微信目录、QQNT 消息库、QQ 导出目录的识别状态、路径查看与复制。
- 同步面板：QQ / 微信来源勾选、全量重扫、导出知识库；采集期间显示不确定进度条（桥没有进度事件）。
- 归档为空且检测到来源时自动采集一次（10 分钟冷却），之后可手动刷新。
- 会话页：来源分段（全部 / QQ / 微信）、会话名搜索（220ms 防抖、Esc 清空）、每页 200 个会话；两栏阅读，消息按天分隔、群聊显示发送人、同人 300 秒内合并、向前翻页保持滚动位置。
- 空态与错误态：未安装归档库、没有匹配会话、没有待办、桥未就绪都给出可读说明。
- 本机配置折叠区（已脱敏）。

## 与旧 React 内置模块的差异

旧实现是宿主的 React 内置模块，能直接访问宿主 store 与事件。沙箱桥没有暴露以下能力，因此本插件相应简化：

1. **同步进度事件**：只显示不确定进度条与“正在同步…”，无法展示逐来源进度。
2. **定时同步 / 定时重扫议程 / 保存为定时任务**：需要写入宿主自动化（`infohub.sync` 等），沙箱桥未开放自动化接口，入口已移除。
3. **首页卡片的“检索归档 / 全部日程”快捷入口与前三项日程**：首页卡片现在只展示归档统计与日程计数，点击进入插件页。
4. **宿主 palette intent（`infohubIntent`）**：沙箱页面拿不到宿主页面意图，进入后默认落在检索页。
5. **主开关与部分停用**：启停、安装与删除由宿主插件管理界面的通用逻辑处理，插件页面不重复提供。

以上差异需要在宿主桥补齐进度事件 / 自动化接口后再回收。
