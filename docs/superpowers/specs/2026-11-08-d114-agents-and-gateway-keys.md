# d.114 智能体改模型、网关密钥与会话入口

- 日期：2026-11-08
- 版本：`d.114.3.46.0`（特性 +1）
- 承接 d.112。

## 1. 智能体改模型（新增「智能体」分区）

原版 magpie 的核心玩法之一：给本机 Claude Code / Codex 等选模型，写进它们自己的配置。
本轮把它做成页面，但**限制范围并显式提示风险**：

- 检测：`magpie ls` 解析出本机智能体（名称、当前模型/档位、配置文件路径）；
- 改写：每行输入 `provider/model` → 「应用」→ **二次确认** → 写入该工具配置；
- 恢复：`<agent> default` 断开模型服务、恢复该工具原来的模型；
- 只读：没有映射到模型命令的智能体只展示，不改；
- 安全边界（主进程白名单）：
  - 只允许 `<agent>`、`<agent> <model>`、`<agent> default` 三种形态；
  - 智能体 id 限定内置集合；模型 id 限定安全字符；
  - `<agent> <field> <value>` 这类字段编辑一律拒绝；
- 提示：写入只在下一次启动生效；建议先关掉正在运行的会话。

## 2. 网关密钥

运行页新增「网关密钥」：

- 新建（名称 + 只读开关）→ `gateway-key add`；
- 列出 / 轮换 / 删除；
- 只读密钥只查用量与配额；用于其他设备、CI 或局域网工具。

## 3. 会话、启动器、库与自动分组

- 「会话与启动器」：查看最近会话 / 近 7 天（`sessions --limit/--days`）；启动器说明；
- 「资源库」新增「查看共享指令」（`library instructions`）；
- 路由分组新增「查看全部（含自动组）」（`groups`）。

## 4. 主进程白名单变化

- 新增 `sessions`、`gateway-key` 两个管理命令；
- 新增内置智能体 id 集合（claude/codex/gemini/cursor/copilot/antigravity/opencode/mimo/qoder/workbuddy/dsh/crush/goose/cline/droid/devin/pi/raft/atomcode/commandcode/codebuddy/kiro），
  只放行「查看 / 设模型 / 恢复默认」。

## 5. 验证

- `magpie-cli`：智能体参数形态、网关/会话命令白名单（9 例）；
- `magpieAgents`：ls 解析、路径/空行跳过、未映射只读、模型 id 校验；
- `ModelPage`：智能体改模型（应用/恢复默认均二次确认）、网关密钥与会话命令；
- 全量 web 与 desktop 门禁见发版记录。
