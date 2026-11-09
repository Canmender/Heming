# 工作流引擎（独立插件）· 更新日志

本项目是独立产物，版本号不跟随和鸣应用版本。

## 1.4.0（2026-11-10）— 清单升级 v5，源码收进 plugin-kit

- 插件清单 `schemaVersion` 3 → 5：补 `engines.heming: "d.117"` 与 `$schema`；
  技能、MCP 服务、命令的业务语义不变。
- 源码迁入和鸣仓库 `plugin-kit/plugins/workflow-kit/` 统一维护；服务仍按独立产物构建/发布，
  不进入和鸣安装包。原独立仓库保留作备份。

## 1.3.0（2026-11-07）— 自然语言生成 + Webhook 触发

用户价值：不用先画节点，也能用一句话起一条工作流；外部事件可以直接触发本机流程。

### 一、AI 工作流生成（默认不保存）

- `POST /api/ai/workflow` 与 MCP `workflow_generate {request, name?, save?}`：
  用本机配置的 OpenAI 兼容模型把自然语言目标转成工作流 JSON，返回 `workflow`、`plan`、`notes` 与校验问题；
  **默认只生成不保存**，确认后再 `workflow_create`/`workflow_test`；
- 提示词只含当前节点目录与 JSON 规范，不含凭据/执行记录/消息内容；
- 模型失败、返回非 JSON、结构不完整都给可读中文错误，不落半成品。

### 二、Webhook 触发器

- 新节点 `webhookTrigger`（节点数 28 → 29）：path（留空=工作流 id）/ method / 可选 authToken；
- 服务端新增 `/webhook/<路径>` 路由：按「active=true + 路径 + 方法」匹配，请求体作为数据输入
  （数组按条、对象一条、空体 `{}`），返回 `202 {executionId}`；
- 拒绝口径：未启用/未知路径 404、路径冲突 409、方法不符 405、令牌不符 401；
- 只监听回环地址；令牌比较用 `timingSafeEqual`；停用工作流即关闭 webhook。

### 三、修复

- **设置区保存模型连接后 LLM 节点不生效**：节点读 `process.env`，此前只改存储不同步环境，
  要重启才生效。现在 `PUT /api/settings` 保存后立即同步 `WF_LLM_*`（清除时也同步删除）。
- 模型连接/AI 生成相关测试用桩模型，不触网；Webhook 走真实路由 + 真实执行（探针覆盖）。

### 四、验证

- 全量 vitest **24 文件 / 457 例** 全绿（AI 生成 3 例、Webhook 3 例、设置同步 1 例）；
- `audit-probe.mjs` **29/29**（新增 AI 生成无模型报错、Webhook 真实触发、停用 404 等）；
- smoke 14/14、发布包内 smoke 14/14；`plugin.json` 1.3.0 通过和鸣 v3 清单解析；
- 发布包 `heming-workflow-kit-1.3.0.zip`（版本号/插件清单/落地页同步）。

### 五、已发布

已上传到云端并完成公网 HTTP + sha256 校验（落地页 / 服务包 / 插件清单 / 目录清单）：
- 落地页 <http://47.92.39.184/updates/plugins/heming.workflow-kit/index.html>
- 服务包 <http://47.92.39.184/updates/plugins/heming.workflow-kit/heming-workflow-kit-1.3.0.zip>
- 目录清单 `/opt/heming/plugins/heming.workflow-kit/1.3.0/plugin.json`（服务器目录接口仍 404，属宿主升级范围，不影响下载安装）

## 1.2.0（2026-11-07）— 智能体自主设计闭环（P1）：搜索/执行详情/版本回滚/规范参考

P0 之后智能体已经能「发现 → 试跑 → 发布」，但还缺三样东西：工作流一多就找不到、
失败后看不到节点数据、改坏了回不去。本版补齐 P1 六项（MCP 工具 19 → 25）。

### 一、新增 6 个 MCP 工具

- `workflow_search {query?, tags?, active?, limit?}`：名称/描述/标签模糊匹配，标签 AND，启用状态过滤，
  返回摘要与全部可用标签（工作流多了以后先定位，不要靠 `workflow_list` 猜）；
- `workflow_execution_detail {executionId, nodeId?, includeData?, redactSecrets?, maxItems?}`：
  逐节点输入/输出，**默认脱敏**（password/secret/token/authorization/api key 等键值打码，Bearer/sk- 前缀也打码），
  默认每输出口最多 10 条、单条超 4KB 截断、总预算 240KB，并标 `truncated`；
- `workflow_versions {id}` / `workflow_version_get {id, versionId}` / `workflow_restore {id, versionId}`：
  每次保存自动留上一版（每工作流最多 10 版、全局 4MB，双上限），可读旧版、可回滚；
  回滚前会校验，回滚前的那一版也会先留快照（可再滚回来）；
- `workflow_sdk_reference {topic?}`：JSON 结构 / 表达式 / 节点设置 / 试跑 / 常见链路 / 排错的静态规范
  （7 个 topic，随版本发布，避免模型凭记忆写错字段）。

### 二、REST 同步

- `GET /api/workflows?query=&tag=&active=&limit=`（无参数保持旧行为，全量摘要）；
- `GET /api/workflows/:id/versions`、`GET /api/workflows/:id/versions/:versionId`、
  `POST /api/workflows/:id/restore {versionId}`。

### 三、存储

- 新增 `data/versions.json`：历史版本快照，原子写；每工作流 10 版 / 全局 4MB 双上限；
  删除工作流时级联清空版本；启动读盘逐条归一（坏快照丢弃）。

### 四、验证

- 新增/更新测试：storage 版本快照 4 例、agentTools 搜索/执行详情/版本/SDK 5 例、
  mcp 3 例、http 3 例；全量 **24 文件 / 450 例** 全绿；
- `scripts/audit-probe.mjs` 增加搜索/执行详情/版本恢复/SDK 参考 4 项（**26/26**）；
- smoke **14/14**；发布包内 smoke 14/14；`plugin.json` 1.2.0 通过和鸣 v3 清单解析；
- 发布包：`heming-workflow-kit-1.2.0.zip`（约 267 KB）。

### 五、顺手修复

- 版本号此前在 `main.ts` 写死 `0.1.0`，`/api/health`、MCP `serverInfo.version` 与外部 MCP 握手的
  clientInfo 都跟着报旧版本。现在统一从 `package.json` 读取（自检时发现，已回归）。
## 1.1.0（2026-11-07）— 智能体自主设计闭环（P0）

上一轮差距分析里，智能体只能「读 → 写 → 跑」，缺 n8n 那套「发现 → 试跑 → 发布 → 调试」的闭环。
本版补齐 P0 五项，并修掉两个会直接影响这些能力的运行时缺陷。

### 一、新增 5 个 MCP 工具（14 → 19）

- `credential_list`：列出本机凭据的 id/名称/类型（**不含任何密钥值**），智能体可自主绑定鉴权；
- `node_type_detail {type}`：返回单节点完整参数 schema（type/default/required/options/placeholder/displayOptions），写参数前先查；
- `workflow_test {id, pinData?, startNodeId?, timeoutMs?}`：**pinData 同步试跑**——被 pin 的节点不执行、
  直接输出给定数据（触发器/HTTP/通知等有副作用的节点先 pin 掉），返回逐节点状态与输出预览（每条 ≤2KB、最多 3 条）；
  默认 10 秒、最长 15 秒；**pinData 只在内存副本生效，不写回工作流**；
- `workflow_set_active {id, active}`：等价 n8n 的 publish/unpublish，启用前先校验，有错误拒绝；
- `mcp_list_tools {url}`：对本机 HTTP MCP 服务握手并列出工具（name/description/inputSchema），写 `mcpTool` 前可自主发现工具。

对应 REST 也补齐：`GET /api/node-types/:type`、`POST /api/workflows/:id/test`、`POST /api/mcp/discover`。

### 二、运行时缺陷修复（自检发现）

- **`runtime.stop()` 此前停不掉执行**：`/api/workflows/:id/stop` abort 的是顶层 `controller`，
  而顶层执行用的是 `execute()` 内部新建的 `runController`，两者没接线。现在把顶层 signal 作为父信号传入，
  stop 与超时都能真正中止执行（回归测试锁定）。
- **新增 `RunOptions.timeoutMs`**：到点 abort，执行置 `canceled` 并写明「执行超时（N 秒）」，
  保证 `workflow_test` 在 MCP 20 秒上限内返回。

### 三、验证

- 新增 `src/server/agentTools.test.ts` 12 例（真实 Store + 真实 Runtime）：凭据不泄密、节点 schema、
  pinData 试跑不写回、超时返回 canceled、启用前校验、外部 MCP 发现、stop 回归；
- `mcp.test` 24 例（工具数 19 + 五个新工具 happy path）、`http.test` 34 例（三个 REST 新接口）；
- `scripts/audit-probe.mjs` 增加 5 项（凭据/节点 schema/试跑/启停/外部 MCP 发现），共 22 项；
- 全量门禁：typecheck 0 错、vitest 全绿（数字见最终汇报）、smoke 14 项、audit-probe 22/22。

> 云端发布：1.0.0 已上线；1.1.0 由云端会话按同一流程重发（`build-release` + `publish-cloud`）。

## 1.0.1（2026-11-07）— 自检修复：CORS 来源白名单 / 执行数据体积上限 / 存储单测

自检方式：全量门禁 + 关键模块代码审查 + `scripts/audit-probe.mjs`（真实服务、17 项网络边界探测）。
共发现 3 个问题，全部修复并加了回归用例：

1. **高：CORS 对所有来源开放**。此前每个响应都带 `Access-Control-Allow-Origin: *`，
   任意网页都能跨域读写本机工作流、读取全局变量、触发带凭据的 HTTP 节点。现改为来源白名单：
   和鸣客户端（`app://heming`）、本机 `localhost`/`127.0.0.1` 页面、无 Origin 的命令行/MCP 调用；
   其它网页来源一律 403 且不回 CORS 头。云端网页版和鸣因此不能驱动本机插件（有意边界）。
2. **中：执行记录只限条数不限单条大小**。一个 300KB 的 item 会原样写盘并回传 UI。现在单条 item 的
   json 超过 64KB 会截断成「`__hemingTruncated` 标记 + 预览」，触发器数据同样处理；单条执行记录
   超过 1MB 时从最早节点开始丢弃数据、保留状态/耗时/错误并标记 `dataTruncated`；REST/MCP 摘要与
   编辑器执行详情都会显示该标记。
3. **低：storage/credentials 没有直接单测**（此前只经 HTTP 间接覆盖）。新增 15 例：坏数据逐条丢弃、
   删除级联、60 条上限、单条超限收缩、凭据 AES-256-GCM 密文、非法字段拒绝、设置/静态数据/通知持久化。

新增 `scripts/audit-probe.mjs`：起真实服务探测 CORS、路径穿越、5MB 体积上限、MCP 错误码、
沙箱宿主能力不可达、凭据落盘密文、执行数据上限、并发运行拒绝（17 项，全部通过）。
其中沙箱口径经实测确认：vm-realm 的 `constructor.constructor` 可以造 Function，但仍在沙箱 realm 内运行、
拿不到宿主 `process`/`require`（未改变沙箱实现，只把探针口径改准确）。

> 云端发布：1.0.0 已上传；本版是安全修复，建议由云端会话按同一流程重发（`build-release` + `publish-cloud`）。

## 1.0.0（2026-11-07）— 首个公开版本

- 节点式自动化引擎：items 数据流、执行栈、分支、多输入合并、回环兜底、节点级重试、
  三种错误策略、`executeOnce`、`pinData`、部分执行、子流程、错误工作流、取消；
- 28 个节点：手动/定时（含 5 段 Cron）/错误/子流程触发；If/Switch/Merge/分批循环/Wait/NoOp/StopAndError；
  Set/SplitOut/Filter/Sort/Limit/去重/汇总/列表；HTTP、代码（node:vm 沙箱）、执行子流程、日期、加密、XML；
  大模型（OpenAI 兼容）、MCP 工具、本机通知；
- 原生 JS Web 编辑器（无构建、无第三方库）：画布拖拽/连线/缩放/框选、参数表单、逐节点执行数据、
  执行记录、凭据、导入导出（兼容 n8n 导出形状）、4 个起手模板；
- 本机服务：HTTP REST + MCP（14 个工具，兼容和鸣 MCP 客户端）、JSON 存储、AES-256-GCM 凭据加密、
  定时调度（15s、串行、不补跑）；
- 和鸣插件包 `plugin/plugin.json`（schemaVersion 3）：1 个本机 MCP 服务 + 3 个技能 + 1 条命令；
- 发布物：服务压缩包、插件清单、落地页、`latest.json` 与 SHA256 校验；
- 已发布到云端：<http://47.92.39.184/updates/plugins/heming.workflow-kit/index.html>
  （服务 zip 约 236 KB；当前 sha256 以云端 `latest.json` / `SHA256SUMS` 为准；同时按云端插件目录布局预上传 `/opt/heming/plugins/heming.workflow-kit/1.0.0/`）。

### 已知限制

- 不支持 Webhook 触发器（需要常驻端口与鉴权设计，下一版）；
- 代码节点只支持同步代码（`await` 会报中文错误）；沙箱无网络/文件/进程入口；
- 等待节点不跨重启；没有断点续跑；
- 凭据是文件级加密（密钥在 `data/secret.key`，与数据同目录）；
- 没有多用户/团队共享；服务只监听 127.0.0.1。

### 来源与许可

设计语义参考 n8n 公开文档，未使用其源代码；n8n 采用 Sustainable Use License 1.0
（非 OSI 开源，禁止复制与商业分发），本实现为独立实现、不受该许可约束。
详见 `docs/DESIGN.md` §2。
