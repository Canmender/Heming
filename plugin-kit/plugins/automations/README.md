# 自动化（沙箱 bundle 插件）

把「同步本机归档」「重扫日程」两个信息中枢动作设成每天定时或按间隔执行。任务与运行记录都只存本机。

这是从宿主内置 React 模块迁出来的沙箱 bundle 版：页面与后台都是普通 HTML + 脚本，
跑在宿主的 `widget://` 隔离视图里，只能通过 `window.__heming_widget` 桥访问宿主能力（数据、信息中枢调用、通知、首页卡片）。

## 包结构

```
plugin-kit/plugins/automations/
├── plugin.json              # 界面插件清单（schemaVersion 4 / distribution "bundle"）
├── README.md
└── files/
    ├── index.html           # 页面视图（内联样式，脚本外链 app.js）
    ├── app.js               # 页面逻辑：展示、编辑任务、手动运行、轮询插件 data
    ├── background.html      # 后台隐藏窗口（无 UI）
    └── background.js        # 后台调度：15s tick、到期执行、失败通知、刷新首页卡片
```

## 清单要点

- `id: "heming.automations"`、`version: "1.0.0"`、`distribution: "bundle"`。
- `permissions.infohub: true`：允许调用 `infohubCall`（同步归档 / 重扫日程 / 连接探测）。
- `permissions.notify: true`：允许发失败通知。
- `contributions.page`：`files/index.html`，出现在插件页面列表。
- `contributions.background`：`files/background.html`，插件启用且已安装时宿主建隐藏窗口常驻。
- `contributions.homeCards`：一张 `automations` 卡，由后台通过 `homeCardSet` 写「下一次执行 / 上次结果 / 启用数」。
- `packageSha256` / `publisher` / `signature` 由打包工具回写，源码树里不写（dev 校验允许缺）。

## 数据（插件 data 目录，不是页面 localStorage）

| key | 内容 | 上限 |
| --- | --- | --- |
| `automations.tasks.v1` | 任务数组（最多 20 条） | 256KB |
| `automations.runs.v1` | 运行记录（最多 40 条，按开始时间倒序） | 192KB |

页面与后台共享同一份插件 data，因此后台跑完任务后页面最多 10 秒内会刷新到最新结果（页面每 10s 轮询一次）。
存储写不下时降级为「只在本次会话里可见」，不会丢任务定义或互相覆盖。

## 动作

两个动作都通过 `infohubCall` 调本机信息中枢，不执行任意脚本：

- `infohub.sync` → `infohubCall("sync", { sources, full, archive })`；结果 `reports[].added` 汇总成
  「同步完成：QQ 新增 N，微信 新增 N」，`archive` 打开时再补知识库导出结果。
- `infohub.agenda` → `infohubCall("agenda", { days: 14, overdue: 30, rebuild: true })`，结果汇总成「重扫完成：N 项日程」。

未连接信息中枢时任务**照常被消费**并记为失败（失败会推送通知、排期顺延），**不会**自动拉起本机进程。

## 调度语义

- 后台每 15 秒 tick 一次，同一时刻只跑一个任务（进程内串行）。
- 插件加载/宿主启动时把「关闭期间错过」的任务重新排到下一个未来时刻，**不补跑**。
- 只有启用的任务会被消费；`maxRuns` 到达后任务自动停用（编辑器暂不暴露该字段，兼容旧数据）。
- 页面只负责手动运行：手动运行同样走串行锁、写运行记录、失败通知与排期顺延。

## 已知限制

- 页面与后台之间没有推送通道，页面靠 10s 轮询插件 data 刷新；后台跑完不会让页面立即重绘。
- 后台窗口由宿主按插件启用状态创建/销毁，宿主版本不支持 `contributions.background` 时任务不会定时执行（页面仍可手动运行）。
- 首页卡片文案由后台刷新；后台销毁后卡片停在最后一次写入的内容。
- 浏览器（无宿主桥）里只做 localStorage 降级展示，不会执行计划。

## 开发与打包

```bash
# 只校验包结构与清单（不需要密钥）
node scripts/check-plugin-packages.mjs   # 如仓库提供

# 打包成可安装的 .heming-plugin（会回写 packageSha256 并签名）
node scripts/pack-plugin.mjs plugin-kit/plugins/automations
```
