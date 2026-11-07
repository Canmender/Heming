# d.85 两条能力线：magpie 全量移植为内置模块 + InfoHub 采集插件

- 日期：2026-11-07
- 版本：`d.85.2.42.0`（特性 +1）
- 分支：`feat/d77-heming-core`
- 两个交付物：①「模型路由」内置能力模块（magpie 语义移植收口）；②`plugins/infohub-collector` 插件包 + `D:\wohaolei` 的本机 HTTP MCP 采集桥。

## 0. 为什么是这两种形态

和鸣的第三方插件清单（`plugin.json` v3）**只声明技能 / 远程 MCP / 命令 / 工具束**，
不执行随包代码、不贡献 React 页面（红线，见 `lib/modules/registry.ts` 文件头）。
所以：

- **magpie**（5337 个 Go 文件、本地网关 + 菜单栏应用 + 30+ 家供应商）不可能原样装成第三方插件。
  它的可用语义（候选链 / failover / 冷却 / 脱敏 / 选路策略 / 记账）与和鸣自己的
  `lib/llmRoute.ts` 是同一类东西，正确落点是**内置能力模块**：插件区「模块」Tab 里可启停，
  停用只下线入口与高级选路，数据不删。上一轮（d.48）已做了第一批语义移植，本轮把它收口。
- **InfoHub** 的能力本体是一个 Python 采集器，插件红线不允许随包执行代码。正确落点是
  **声明式插件 + 本机 HTTP MCP 服务**：插件只声明 `http://127.0.0.1:8776/mcp` 与技能/命令；
  真正干活的 `infohub mcp` 由 InfoHub 项目提供，用户自己启动。插件安装不联网、不启进程。

## 1. magpie 全量移植：内置模块「模型路由」

### 1.1 模块与页面

- 模块 id / 页面 id：`modelroute`；导航名「模型路由」；归「智能模块」组；不占数字快捷键。
- 选路规则：`lib/llmRoute.ts` 排序入口先过 `effectiveRouteStrategy()`，
  内部 `isModuleOn("modelroute")`——**停用时八档全部退回 `order`**，候选链/failover 照常，
  路由组、冷却、用量一个不删。
- 页面 `components/ModelRoutePage.tsx`：概览数字（连接/候选链/候选/休息中/本月用量）+
  候选链编辑器（`RouteGroupsCard`，与设置区同一份实现，不复制）+ 每档策略人话 + 边界说明。
- 设置区不再渲染候选链编辑器，只留一张「打开模型路由」的入口卡（避免同一编辑器两处漂移）。

### 1.2 八档选路（全部确定性、可单测）

| 档位 | 规则 | 数据来源 |
| --- | --- | --- |
| `order` | 声明序（老数据缺省，行为逐字不变） | 路由组成员顺序 |
| `cheap` | 参考价升序，查不到排最后 | `lookupCapability(...).pricing` |
| `smart` | `0.5×本月用量 + 0.3×参考价 + 0.2×近期失败`，各自归一 0..1，同分回声明序 | tokenUsage 月合计 / 价目 / `llmHealth.failures` |
| `usage` | 本月用量按 1 小时半衰后升序（magpie `usageHalfLife`） | tokenUsage 记录时间戳 |
| `pace` | 本月已用 ÷ 本月已过时间比例（客户端近似；**不假装有 quota**） | tokenUsage |
| `weight` | 平滑加权轮询，`RouteMember.weight` 1–100（缺省 1），模块级 Map 按组隔离 | 路由组 |
| `fast` | 首 token + 200 token 用时，500ms 分档；没测速的排后，每第 5 个请求给未测速先手 | `lib/llmSpeed.ts`（纯内存，20 分钟半衰、4096 上限、重启清零） |
| `rotate` | 醒着按序轮换，休息的跳过 | 路由组 |

共同底线不变：**休息中的候选永远排最后且绝不删除**；全休息时仍问最快回来的一个（`probeOne`）；
已经吐出内容的流绝不换人（`surfaced`）。

### 1.3 刻意不做（写进 `llmRoute.ts` 文件头）

`drain` / `expiring`（没有供应商窗口续期 / 免费额度到期数据，不做近似）；
不读供应商配额、不做并发/限流/请求翻译（那是网关的活，本仓是客户端）；
不动 HITL / E2E / Key 存储。

## 2. InfoHub 采集插件

### 2.1 采集桥（`D:\wohaolei`）

- 新文件 `infohub/mcp_server.py`：标准库实现的 MCP Streamable HTTP 最小子集
  （`initialize` / `notifications/initialized` / `ping` / `tools/list` / `tools/call`），
  服务端回 `application/json`（和鸣客户端两种都认）。
- 新 CLI 子命令 `infohub mcp [--host 127.0.0.1] [--port 8776]`。
- 安全边界：只监听回环地址（非回环直接拒绝启动）；校验 `Host` 只认 `127.0.0.1` / `localhost`
  （防 DNS rebinding）；CORS 预检放行（浏览器版和鸣跨源访问需要）；请求体上限 256KB；
  `allow_reuse_address = False`——**Windows 上端口被占会启动失败而不是两个进程抢同一端口**
  （实测 InfoHub 桌面端自己占了 8765，所以默认端口定为 8776）。
- 工具：
  - `infohub_status`（只读）：会话/消息数、每来源最近采集时间与结果；
  - `infohub_sync`（**写**）：增量采集，`sources` 只收 `qq`/`wechat`，不重扫日程、不导出知识库、不推送；
  - `infohub_archive_search` / `infohub_archive_read` / `infohub_archive_agenda`（只读）。
- 错误收口：可预期错误（参数、未知工具、会话不存在）回 `isError` 的文本内容，不外泄 traceback（只进 stderr）。
- 测试 `tests/test_mcp_server.py`：13 例（协议层起真实 HTTP 服务；工具层用临时 sqlite 归档，
  不碰真实数据；`sync` 用 mock 证明只调采集、不触发其它副作用）。

### 2.2 插件包（`plugins/infohub-collector/`）

`plugin.json`（v3）：

- `mcpServers`：`infohub` → `http://127.0.0.1:8776/mcp`（本机回环 http 是清单允许的唯一明文形态）；
- `permissions`：`network: ["127.0.0.1:8776"]`、`tools: "write"`（采集是写操作，上限若写 read 会把它挡在注入点外）、`files: []`；
- 技能「本机归档采集与查询」：什么时候用哪个工具、写操作先确认、不可用时如实说、引用标注「来自本机归档」；
- 命令：「查看采集状态」「采集本机消息」→ 信息中枢页；
- 不含代码 / 命令 / 环境变量 / 请求头 / 密钥（有仓库内守卫用例钉住）。

仓库内守卫 `lib/plugins/bundledPlugins.test.ts`：清单必须能通过 v3 校验、只有一个回环服务、
风险上限是 write、技能/命令非空、**预览可安装且预览不写存储**。

## 3. 验证

- **magpie 策略**：`llmRoute` 20 + `llmRoute.strategies` 22 + `llmSpeed` 11 + `llmHealth` 16 +
  `RouteGroupsCard` 12 = 81 例；模块闸门覆盖六档退化 + rotate 不轮换 + 重新启用恢复。
- **InfoHub 桥**：13 例（`D:\wohaolei\.venv\Scripts\python.exe tests/test_mcp_server.py` OK）；
  curl 实测 `initialize` / `tools/list` / `infohub_status`（本机真实归档：271 会话 / 138488 条消息）。
- **和鸣侧**：模块/导航/命令面板/插件页/设置页相关用例全部更新并通过；
  `ModelRoutePage.test` 4 例；`bundledPlugins.test` 3 例；`pnpm --filter @heming/web typecheck` 零错。
- **真实浏览器**：装插件 → 接口区连接 `127.0.0.1:8776` → 工具出现在目录并默认关闭 →
  启用后调用 `infohub_status` 回显本机归档规模（见交接截图与门禁记录）。

## 4. 边界

- 采集桥数据不出本机；和鸣侧工具调用仍走 HITL（`infohub_sync` 按名字判为写，必问）。
- 插件不携带密钥、安装不联网、不自动连接；连接与逐工具启用仍由用户在接口区发起。
- 信息中枢内置模块（桌面端 stdio 边车）仍然可用，与插件这条路互不依赖。
- 测速样本只内存、重启清零；冷却同样只在本机内存，不上云、不进导出。
