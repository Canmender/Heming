# d.46 · 信息中枢原生融入：从页面到能力

- 日期：2026-11-01
- 相关版本：d.45.1.11.0（基线）、本 spec = d.46.1.11.0（特性位 +1）
- 涉及包：`packages/web`（能力提供者、共享状态、首页卡、命令面板、信息中枢页意图）
- 前置：d.45 已把 InfoHub 作为本机 stdio 边车接进桌面端，但入口仍是一个独立页面

## 0. 问题

d.45 的信息中枢是「一个页面 + 一条 IPC」：用户要主动切过去、手动检索、手动看日程。对智能体来说它不存在——问「叶老师上周说的免检单是什么时候交」时，模型既不知道本机有这份归档，也没有工具去查。这不是原生融入，只是把外部应用嵌进了导航栏。

## 1. 决策

### A. 能力优先：新增 `infohub` 工具提供者

在 `lib/infohub/tools.ts` 构建 `ToolBridge`，注册到能力内核（`mcp → charts → tone → wiki → infohub → self`）：

| 工具 | 风险 | 用途 |
| --- | --- | --- |
| `infohub_search` | read | 在本机 QQ/微信归档中全文检索历史消息 |
| `infohub_read_conversation` | read | 按会话名或归档 id 读取最近消息 |
| `infohub_agenda` | read | 查看从归档抽取的日程与逾期统计 |
| `infohub_agenda_rebuild` | write | 重扫归档抽取日程（走 HITL 审批） |

- 工具名统一 `infohub_` 前缀；提供者 `id="infohub"`、`origin="builtin"`。
- 工具描述必须明确「这是和鸣之外的本机 QQ/微信归档」，避免模型拿它查当前和鸣会话。
- 结果附带 `ToolSource`（`kind="archive"`），由编排层生成来源脚注；`sourceFooter` 按来源类型切换标题，不把归档标成「本机知识库」。
- 只读工具免审批；`infohub_agenda_rebuild` 是唯一写操作，未声明风险时按 `write` 处理，由 HITL 闸门询问用户。

### B. 不自动拉起进程

d.45 的红线保持不变：Python 边车只由用户显式「连接」拉起。

- 提供者 `build()` 仅在「桌面端 + 进程已连接」时返回工具；未连接时本轮不注入工具。
- 工具执行前再次校验连接态，失败返回可读指引（「请先在信息中枢页连接本机归档」），不 spawn、不重试。
- 同步（`sync`）不暴露为工具：它写归档、耗时最长、且必须由用户勾选来源，继续只留在信息中枢页。

### C. 共享状态：一个 store 管连接、统计与日程

新增 `lib/infohub/store.ts`（zustand）：

- 状态：`available / running / info / status / agenda / busy / error / booted`。
- 动作：`boot()`（只读 `info()`，不启动）、`connect()`、`refresh()`、`loadAgenda()`、`rebuildAgenda()`、`disconnect()`、`syncInfo()`、`markStopped()`。
- `App` 挂载时调一次 `boot()`；信息中枢页在连接/断开后同步状态，保证页面内启动的进程对工具提供者可见。
- 所有错误收成字符串，UI 不因信息中枢失败而阻塞主流程。

### D. 体验：首页露出 + 全局检索

- 首页新增 `InfohubHomeCard`（全宽，位于用量热力图与两栏之间）：
  - 未连接：一行「本机归档未连接」+「连接」按钮；
  - 已连接：逾期/今天/本周统计、最近 3 条未完成日程、归档规模（会话/消息），以及「全部日程」「检索归档」入口。
  - 浏览器环境不渲染该卡。
- 命令面板（Ctrl/⌘+K）在已有会话/技能结果之后追加本机归档命中：
  - 仅在桌面端且已连接时启用；250ms 防抖，最多 5 条；
  - 结果标「本机」，显示来源、会话、时间与正文摘要；
  - 回车/点击跳到信息中枢页并自动执行同词检索。
- 跨页意图走 `store/ui.ts` 的 `infohubIntent`（`{tab:"search"|"agenda", query?}`）：`openInfohub(intent)` 切页并投递，信息中枢页消费后清空。

### E. 边界

- 归档仍以 `mode=ro` 打开；本轮不新增任何写归档的路径（重扫只写日程索引表，且由 HITL 确认）。
- 不做数据迁移：不把本机明文归档并入和鸣服务端数据库，避免与 E2E 信任边界冲突。
- 不上传、不开端口；浏览器端无桥时卡片与工具都消失，不做云端回退。
- 密钥仍只由 Python 侧脱敏汇总，工具参数与返回不包含任何凭据。

## 2. 失败形态

| 场景 | 行为 |
| --- | --- |
| 浏览器环境 | 不渲染首页卡；能力提供者返回 null |
| 桌面端未连接 | 首页卡显示连接入口；工具不注入；直接调用返回引导文案 |
| 归档库不存在 | 工具返回「尚未建立本机归档」，`ok=true`（不是异常） |
| 会话名有歧义 | 返回候选列表，要求模型用更精确的名称或 id |
| 重扫被拒 | HITL 拒绝，工具不执行，按既有拒绝文案回灌 |
| IPC/Python 报错 | 工具返回 `ok=false` 与清洗后的原因，不中断整轮 |

## 3. 测试

- `lib/infohub/store.test.ts`：boot 不启动、连接后刷新、重扫传 `rebuild:true`、断开复位。
- `lib/infohub/tools.test.ts`：浏览器/未连接不注入；四个工具的声明与风险；检索格式化与来源；会话名解析与歧义；重扫参数；归档缺失。
- `components/InfohubHomeCard.test.tsx`：未连接入口、已连接摘要、点击入口投递意图。
- `components/CommandPalette` 归档检索：防抖、结果、跳转意图。
- `components/InfohubPage.test.tsx`：消费检索/日程意图；连接/断开同步 store。
- `lib/capability/providers.test.ts`：注册顺序加入 `infohub`。
- `lib/agentStream.test.ts`：归档来源脚注标题。

## 4. 非目标

- 不改变信息中枢页的五个区块（去留待用户决定）。
- 不把归档会话导入和鸣的会话列表。
- 不做跨设备同步、云端索引或服务端检索。
- 不新增自动连接/自动同步开关。
