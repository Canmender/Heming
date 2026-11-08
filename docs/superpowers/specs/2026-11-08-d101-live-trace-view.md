# d.101 模型页「实时链路」：节点视图，看请求怎么走

- 日期：2026-11-08
- 版本：`d.101.2.42.0`（特性 +1）
- 承接：d.100 的导航「模型」页。

## 1. 为什么

magpie 原版最直观的一屏是 **Routing（路由实时图）**：左边是发请求的客户端，中间是 magpie，
右边是请求最终落到的账号/Key，连线随请求移动、失败换人会画出来。
d.100 的模型页只有表格与表单，没有这层「看得见的路径」。本轮补上。

## 2. 数据源：内核自己的 trace（不推断）

- 端点：`GET /v1/magpie/trace`（magpie Routing 页用的同一份，`internal/gateway/trace.go`）；
- 每条 Route 带：`agent`、`model`、`provider`、`group`、`order[]`（候选顺序）、`tries[]`（每次尝试）、
  `done`/`status`/`ms`/`tokens`；
- 渲染层经主进程反代读取（回环），不直连 3425；读不到就显示错误，**不造假节点**；
- 轮询：每 2.5s 读一次快照，页面可暂停。

## 3. 视图

- 三列节点：左「客户端」→ 中「和鸣内核 magpie-core」→ 右「账号 / Key · 模型」；
- 每条 Route 一条曲线：蓝色流动 = 进行中（带沿路径移动的圆点），绿色 = 成功，琥珀 = 失败/换人；
- 悬停高亮该请求的全部连线，点击打开详情（候选顺序数、尝试列表、耗时、token、错误）；
- 下方请求列表（最近 30 条）：时间、客户端、请求模型、落点、状态、耗时，与图联动；
- 空状态引导：发一次智能体对话即可看到路径。

## 4. 代码

- `lib/magpieTrace.ts`：快照读取 + `buildTraceGraph()` 纯函数（节点去重、落点取最后一次尝试、
  状态口径、行数据），单测覆盖；
- `components/ModelTraceView.tsx`：SVG 节点图 + 列表 + 详情 + 轮询/暂停；
- `ModelPage` 新增「实时链路」分区（概览之后）。

## 5. 验证

- 真实链路（隔离 APPDATA + mock 供应商 + 自家内核 + 反代）：
  发一次 `/v1/chat/completions` → 200 → `GET /v1/magpie/trace` 返回
  `{agent:"heming", model:"mock/mock-model", provider:"mock", status:200, done:true, order:["mock"], tries:[{id:"mock",status:200}]}`，
  即节点视图要画的三段信息齐全；
- 渲染层：`magpieTrace` 11 例（读取/拒绝坏形状/成功/live/失败/去重/落点/空图）；
  `ModelTraceView` 4 例（节点与统计/详情开关/空状态/错误）；web 全量门禁与 typecheck 见提交记录。

## 6. 边界

- 只能读本机内核的 trace（内核端点只服务本机）；远端共享网关需对方允许且 CORS 通过；
- 视图是「正在发生的事」的快照，不保存历史（历史与用量在「用量」分区看）；
- 账号列显示 `who`（账号名/Key 名），没有账号信息时退化为 provider/模型。
