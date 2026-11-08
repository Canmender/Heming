# 关于页更新进度条：下载中看得见进度（d.98 批次）

- 日期：2026-11-08
- 分支：`feat/d77-heming-core`（与「桌宠拆插件」分支同一轮合并）
- 用户指令：「应用内部在关于页面更新的时候，弄一个进度条，让用户能看到已经更新了多少」

## 1. 问题

安装包 250MB 量级；下载阶段界面只有「正在下载，请保持网络连接…」一句，
用户既不知道是否在推进，也不知道还要多久。下载失败/卡住时同样没有任何可视化线索。

## 2. 数据链路

```
electron-updater.download-progress
  → auto-update.js onDownloadProgress（主进程，夹紧 percent 0–100，记 transferred/total/bytesPerSecond）
  → updater 状态快照 state.progress + emit()
  → main.js 既有 update:state 推送（无需新通道）
  → preload __heming_update.subscribe（既有）
  → UpdateCard 进度条
```

- `progress` 只在 `downloading` 阶段有意义；`check()` 开始与 `download()` 开始都会清空，
  避免界面显示上一轮的陈旧百分比；
- `dispose()` 摘掉 `download-progress` 监听（主进程生命周期收尾不留钩子）；
- percent 越界（<0 / >100）夹紧，界面宽度不会算出负数或超宽。

## 3. UI

`UpdateCard`（设置区「关于」页）：

```
软件更新                                  当前 d.98.2.42.0
正在下载 42%，请保持网络连接…
[████████░░░░░░░░░░░░░░░░]            ← role=progressbar，aria-valuenow=42
已下载 42%（105 MB / 250 MB · 2.0 MB/s）
```

- 进度条 `role="progressbar"` + `aria-label="更新下载进度"` + `aria-valuemin/max/now`；
- 文字用 `已下载 N%（x / y MB · 速度/s）`（总量未知时只显示百分比）；
- 下载完成后进度条消失、按钮变为「重启并安装」（沿用既有状态机，不自动安装）。

## 4. 测试

- `packages/desktop/auto-update.test.js` +3：进度事件转发与夹紧、重新检查清空、dispose 摘监听；
- `packages/web/src/components/UpdateCard.test.tsx` +2：下载中进度条随推送更新（12.5%→68%）、
  下载完成后进度条消失且按钮为「重启并安装」。

## 5. 未做

- 不做「暂停/继续下载」（electron-updater 不提供，需要自管分片）；
- 不做更新包校验进度（sha512 校验发生在下载完成后，秒级，不值得可视化）；
- 不在启动提示条重复进度（关于页是唯一入口，避免多处小进度条噪音）。
