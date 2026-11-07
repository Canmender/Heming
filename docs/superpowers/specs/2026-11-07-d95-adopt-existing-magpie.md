# d.95 本机已有 magpie 时直接接入（不另起、不抢端口）

- 日期：2026-11-07
- 版本：`d.95.2.42.0`（特性 +1）
- 范围：只动 magpie 模型接入（不涉及信息采集插件等其它能力）。

## 1. 问题

d.92 的内置托管默认「spawn 一个 magpie serve」。但 magpie 的用户很可能本来就在跑它
（菜单栏应用 / `magpie serve` / 服务），此时 3425 已被占用：

- 再 spawn 一个只会撞端口，启动失败；
- 即使侥幸起来，用户也会以为自己那份被抢了；
- 明明已经有一个可用的 magpie，界面却显示「未连接」。

## 2. 做法：先探活，再决定要不要 spawn

`packages/desktop/magpie-host.js` 的 `start()`：

1. 先 `GET /api/hello`；若应答 `name=magpie` → **采用它**（`external=true`），不 spawn；
2. 否则才 spawn `magpie serve`，并轮询就绪；
3. `status()` 增加 `external` 字段；`stop()` 在 external 时只断开使用关系，
   **绝不会去杀用户自己开的进程**；
4. 反代、`/api/hello` 版本展示、模型目录刷新逻辑不变。

设置页 `MagpieGatewayCard` 按 external 分两种口径：

- 自动启动的：「运行中 · magpie 版本 · 反代端口」+「启动/重启」「停止」；
- 采用本机已有的：「已接入本机 magpie · 版本 · 反代端口」+「重新连接」「断开」，
  并说明「不会另起一个，也不会关掉它」。

## 3. 验证

- `magpie-host` 新增 1 例：端口上已有 magpie → 不 spawn、status.external=true、
  stop 后 running=false 且外部进程未被触碰；原 spawn/超时/并发用例按「先探活」适配；
- `MagpieGatewayCard` 新增 1 例：external 状态文案与「断开」按钮；
- 真实二进制：见交付报告（下载/校验/起服务/反代链路）。

## 4. 边界

- 采用外部实例时，和鸣无法得知它的配置位置与账号信息（那是 magpie 的），只借 `/v1` 接口；
- 端口以 magpie 的 settings.json 为准；若它不在 3425，仍需在设置页「高级」里手填地址；
- 桥只监听回环，反代来源白名单不变。
