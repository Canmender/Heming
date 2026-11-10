# d.127 · 插件独立化（插件不占用本体程序代码）— 方案与迁移表

> 用户口径（2026-11-10）：「所有插件独立化，不和本体程序挂钩，不要占用本体程序代码」。
> 本文是**方案**，不是本轮实现；本轮先交付用户同时提出的知识库 / 技能卡 / 智能体页 / 对话流四项（见
> `2026-11-10-d126-knowledge-agents-chat.md`）。插件运行时正在由并行会话改造（`plugin-engine.js` 等），
> 本文刻意只做边界与迁移表，避免两边同时改同一批文件。

## 0. 现状：什么在「占用本体代码」

本体（`packages/web` 的构建产物 + `packages/desktop` 安装包）里目前混着四类**本应属于插件**的东西：

| 类别 | 现状 | 体量（源码） | 问题 |
|---|---|---|---|
| 内置能力模块 | 幕僚 / 信息中枢 / 自动化 / 工作流：`lib/modules/registry.ts` 硬编码 4 个模块，页面组件（`StaffPage` / `InfohubPage` / `AutomationPage` / `WorkflowPage`）与引擎直接编进 web 包 | `lib/{staff,infohub,automation,workflow}` ≈ 948KB + `components/workflow` 184KB + 4 个页面 | 未安装也在安装包里；模块逻辑与本体同版本发布；无法独立升级/卸载 |
| 模块引擎（桌面侧） | `infohub-engine.js` / `infohub-bridge.js` / `mcp-stdio.js` / `http-bridge.js` 编进主进程 | ~54KB | 引擎与宿主进程生命周期绑定，不能按插件启停 |
| 插件专属 UI 细节 | 技能页「去 AI 味」写作卡（本轮已删）、模块设置卡、模块后台循环/调度器（`useStaffLoop` / `useAutomationScheduler` / `useWorkflowScheduler` 在 App 顶层无条件挂载） | 分散 | 本体需要认识每个模块的细节 |
| 内置技能/工具目录 | `lib/capability/providers.ts`、`lib/skills/builtins.ts` 硬编码来源 | 中等 | 新能力要改本体代码 |

已有的独立化基础（不要重造）：

1. **插件包模型**：`plugin.json` v5（技能 / MCP / 命令 / 工具束 / 页面）+ bundle v4（自带 HTML/JS，`widget://` 沙箱，
   首方签名）——插件页面在 d.124 已能进导航并嵌主窗（`WebContentsView`）。
2. **分发链**：自家服务器插件目录 + 客户端安装/更新/卸载/验签/防降级（d.104–d.123）。
3. **模块目录**：模块已能「云端目录安装 / 不随安装包分发引擎」的一半（`module-catalog`、`module-download`、
   `module-store`），但模块 UI 与调度仍在本体。
4. **独立本机服务先例**：`plugin-kit/plugins/workflow-kit` 是「独立 Node 服务 + MCP + 声明式插件包」，
   `infohub-collector` 是「本机 HTTP MCP + 声明式插件包」。

## 1. 目标形态（四条硬约束）

1. **本体只保留插件运行时与宿主能力**：插件包发现/安装/验签、贡献点解析、页面宿主（当前 d.124 的页面注册表 +
   `WebContentsView`）、能力桥（`widget-preload` 白名单）、数据目录、权限与 HITL。本体不包含任何具体插件的
   页面、业务逻辑、调度器。
2. **每个插件是独立包**：自己的 UI（bundle 页面/窗口）、自己的引擎（本机服务或 MCP）、自己的 manifest/版本。
   安装后进导航/设置/命令，卸载即撤销入口、数据与进程。
3. **引擎与 UI 解耦**：引擎跑在**独立进程**（本机服务 / MCP stdio / HTTP），由宿主按插件生命周期启停并做健康检查；
   UI 只是它的客户端。这样页面关闭、切页、主窗最小化都不影响后台任务。
4. **升级不改本体**：插件版本、能力、权限随插件包走；本体升级只保证宿主契约（`engines`）兼容。
   安装包体积不再随模块数量增长。

## 2. 迁移表（四个内置模块 → 独立插件）

| 现模块 | 目标形态 | UI | 引擎 | 迁移难点 |
|---|---|---|---|---|
| 幕僚 staff | 首方 bundle 插件（页面 + 后台简报） | `StaffPage` 搬进插件的 HTML/JS，页面宿主按 d.124 嵌主窗 | 简报生成需要本机 LLM/记忆数据：通过宿主能力桥（受权限约束）或本机服务调用 | 页面需要「本机数据」访问面：现有 `__heming_widget` 只有 settings/data/chatConfig，需新增受控只读桥（记忆摘要、任务摘要） |
| 信息中枢 infohub | 本机服务 + 声明式/ bundle 插件 | 采集桥 UI（已有独立插件页方向：`plugin-kit/plugins/infohub-page`） | 已有 Python 边车 + 本机 HTTP MCP；把 `infohub-engine.js` 从主进程挪到插件服务 | 边车启动/端口/健康、数据目录迁移 |
| 自动化 automations | 首方 bundle 插件 + 本机调度服务 | 任务列表/表单 UI 进插件页 | 调度器从 App 顶层 `useAutomationScheduler` 挪到本机服务；动作（`infohub.sync` 等）经 MCP/本机 API 调用 | 任务/运行记录是「本机数据」：存储键迁移到插件 data 目录或宿主受控 KV |
| 工作流 workflows | 已有独立服务 `workflow-kit`，收编为插件 | `WorkflowPage`（画布/编辑器）搬进 bundle 或独立窗口 | 已有独立 Node 服务 + MCP（先例） | 画布 ~184KB、引擎 ~676KB，包体大；打包/签名/更新链；凭据/执行记录迁移 |

横切项：

- **设置卡**：现在模块设置卡是本体 `SETTINGS_CARDS` 静态注册。目标：插件声明设置页/卡（新增贡献点
  `contributions.settings`，宿主渲染表单或 bundle 设置页），本体只校验与渲染骨架。
- **导航与页面注册表**：d.124 的 `lib/pages/registry.ts` 已按「已装插件 → 页面入口」投影；把模块页一并改为
  插件页后，`lib/modules/registry.ts` 可退化为「已装模块 = 插件」的兼容壳，最终删除。
- **后台循环**：宿主提供 `plugin.background` 生命周期事件（d.108 已有 installed/enabled/disabled/updated/uninstalled）
  + 本机服务托管；**不能**把定时任务塞进 bundle 页面（页面不在时会被销毁）。
- **安装包守卫**：`packaging.plugins.test.js` 加「安装包不得包含模块源码/引擎」，与现有插件守卫同口径。

## 3. 分阶段

| 阶段 | 内容 | 验收 |
|---|---|---|
| P0（本轮/并行） | 盘点与契约冻结：以本表为准；插件运行时由并行会话继续（`plugin-engine.js`）；不再往本体加插件专属代码 | 本文件入 INDEX；新插件代码只进 `plugin-kit/` |
| P1 | 设置卡贡献点（声明式 settings）+ 页面宿主补齐「本机数据受控桥」 | 一个示例插件能自带设置项而不改本体 `SETTINGS_CARDS` |
| P2 | 幕僚 / 自动化先迁（UI 简单、后台用本机服务）：包 + 目录 + 首方签名 + 安装后入口/卸载撤销 | 卸载后本体无残留代码路径；安装包不含其页面源码 |
| P3 | 信息中枢迁（Python 边车生命周期由插件服务负责） | 未安装时本体不再 spawn Python；健康检查/端口冲突行为与现在一致 |
| P4 | 工作流迁（大包 + 凭据/执行数据），`lib/modules/registry.ts` 删除 | 安装包体积显著下降；模块目录只列已装插件 |

## 3.5 与并行会话实际进展的对齐（2026-11-10 晚）

并行会话（插件作者线）已在做「插件自带本机引擎」这一步，工作区里有未提交实现（`packages/desktop/plugin-engine.js`
与 `plugin-package.js`/`plugin-host.js`/`plugin-kit/plugins/infohub-page/` 的改动，截至本文件更新时未提交）。
其契约与本方案一致，值得直接吸收为 P1 基础：

- `contributions.engine`（仅首方签名 bundle）：`{ entry: 包内 .py, lib?: 包内目录 }`；解释器固定用应用内置
  Python 运行时，**不接受命令字符串**；通信走 stdin/stdout 换行 JSON（与 `infohub-bridge.js` 同协议）。
- 能力闸门：`permissions.chat: true` 才下发本机模型网关（后台任务模型）；`permissions.kb: true` 才下发知识库根
  与 `writeDirs`；用户自己的供应商 Key 永不下发。
- 完整性：启动前按盘上 `files/**` 重算摘要（与安装同算法）比对，改包拒启动；摘要按 `id@version` 缓存。
- 页面侧：`__heming_widget` 增加 `engine` 调用面与 `backgroundModel`；设置区新增「后台任务模型」卡。

对迁移表的直接影响：

1. **信息中枢**可以直接走 `contributions.engine`（Python 引擎随插件包分发），不再需要在主进程保留
   `infohub-engine.js` 的启动逻辑——这是 P3 的第一块，等并行工作合入后按本方案收口。
2. **自动化 / 工作流**的引擎同样可走 engine 贡献点（工作流已是独立 Node 服务，可先保留本机服务 + MCP，
   再统一成引擎贡献）；本体的调度器仍需改为「插件引擎托管 + 生命周期启停」。
3. **幕僚**是纯 UI + 本机数据只读消费，优先级最低；可先留在本体，或等 d.124 页面宿主 + 宿主数据桥补齐后再迁。
4. 本体删除清单：四个 `lib/*` 模块、四个页面组件、`App.tsx` 顶层 `useStaffLoop`/`useAutomationScheduler`/
   `useWorkflowScheduler`、`SETTINGS_CARDS` 里的模块专属卡，都要随迁移逐项删；每删一项加一条「安装包不含它」的守卫测试。

> 边界：本节只做对齐记录。并行会话的实现仍未提交，本轮**不改**这些文件；合入后再按 P1–P4 推进。

## 4. 风险与取舍
- **本机数据访问**：插件页面在独立 origin，不能直接读本体 localStorage（记忆/任务/模型密钥）。必须走宿主受控桥，
  按权限最小化；否则会为了「独立」把密钥/记忆暴露给插件页——这条红线不能破。
- **后台任务**：必须独立进程；bundle 页面不适合承载定时/长任务（页面销毁即停）。
- **签名与首方**：四个模块都属首方，bundle 签名链已有（d.98/d.105）；第三方仍只能声明式。
- **迁移期双轨**：旧模块（本体编译）与新插件包同时存在会造成双入口/双份数据。迁移必须带「一次性停用旧模块 +
  数据迁移」，并在插件页明确「已迁移」状态。
- **与并行会话协同**：插件运行时（`plugin-engine.js`、`widget` 桥、模型页相关）正在改，P1 之前先对齐宿主契约，
  避免各做一套。

## 5. 本轮只做的事

1. 本方案文档 + `docs/INDEX.md` 索引。
2. 技能页「去 AI 味」独立卡删除，规则并入内置「写作润色」技能默认流程（已做，见 d.126 计划阶段 A）。
3. 其余阶段按 P1–P4 排期，不并入 d.126 的 UI 轮。
