# d.111 模型页高级表单：来源设置、分组规则、模型属性

- 日期：2026-11-08
- 版本：`d.111.2.42.0`（特性 +1）
- 承接 d.110。

## 1. 补上原版里「只能在命令行做」的三块

### 来源高级设置（来源页 · 每个来源的「高级」）

- 更新 API Key；
- 分发策略（routing：smart/order/rotate/usage/pace/weight/free/fast/cheap/drain/expiring）；
- 覆盖模型列表（models）；模型目录地址（models.url）；
- 请求头（header.X-Foo=value）；耐心（patience）；错误处理（errors=magpie|pass）；
- 备用模型（provider fallback：额度用完/故障时改用）；
- 保存后自动刷新模型目录与来源列表。

### 路由分组规则（运行页 · 路由分组折叠区）

- 规则表单：分组、先交给哪个模型，以及可选条件——
  够长（tokens≥N）、项目文件夹、时段、意图描述；
- 「保存规则」= `group rule add …`；「查看规则」= `group rule <组>`；
- 与已有分组增删查、策略选择放在同一处。

### 模型属性（模型页 · 折叠区）

- 显示名（model name）、思考档（model efforts）、请求协议（model api：auto/chat/responses/anthropic/gemini）；
- 留空项不动；改完刷新模型目录。

## 2. 与 magpie 原版的功能差距（更新）

本轮补掉：Provider 常用高级字段、分组规则（tokens/文件夹/时段/意图）、模型元数据编辑。

仍未做：
- Agent 模型改写（改本机 Claude Code/Codex 配置）——会动别的应用，需单独高风险面板；
- 上下文分析（依赖请求体留存与隐私边界）；
- 网关密钥/局域网共享/配额告警、Library 编辑、会话/启动器/托盘入口、备份恢复页面化。

## 3. 验证

- `ModelPage` 新增 3 例：来源 Key/设置命令、分组规则命令、模型属性命令；
- 全量 web 门禁与 typecheck 见发版记录。
