# 和鸣 vs OpenAI Codex CLI vs Anthropic Claude Code

> 一份尽量全面的能力对标与差距清单
> 写作时间：2026-11-17 ｜ 和鸣版本：d.235.4.116.12（工作树）｜ 线上版本：d.203.4.106.12（安装包 r109）

---

## 0. 文档说明（先读这一节）

**对比对象**

| 对象 | 形态 | 本文依据 |
| --- | --- | --- |
| **和鸣（Heming）** | Windows 桌面 AI 智能体应用（Electron + 自带服务端），兼有 Web 端 | 对 `D:\Heming` 工作树代码的逐子系统盘点（4 个只读调研并行完成），证据一律给 `相对路径:行号` |
| **OpenAI Codex CLI** | 开源终端智能体（Rust）+ 云端任务 | 公开文档与发行说明的**内部知识** |
| **Anthropic Claude Code** | 终端智能体 + Agent SDK + IDE/桌面/Web/移动端 | 公开文档与发行说明的**内部知识** |

**两点必须如实说明的限制**

1. **本轮无法联网核验。** 本机的 `web_search` / `web_fetch` 返回 HTTP 401（供应商 key 无效），Hindsight 记忆也未授权（401）。因此 Codex CLI 与 Claude Code 一侧的内容来自 2026-11 之前的公开文档与工程实践记忆，**不是实时抓取，版本细节可能有差异**（两款产品迭代很快）。凡我不确定的点，都在正文标了「未核实」。
2. **和鸣一侧只认代码，不认叙事。** 本文对和鸣的每个断言都对应到具体文件与行号；`changelog` 里写了但代码里没有的、或只有单测没有真机验证的，都单独标注。

**怎么读**

- 想快速知道结论 → 第 1 节（一页结论）与第 5 节（差距 Top 20）。
- 想逐维度核对 → 第 2 节矩阵 + 第 3 节逐维度展开。
- 想反驳或复核 → 第 8 节附录（和鸣能力清单与证据索引）。

---

## 1. 一页结论

**和鸣是什么**：它不是「Codex 的 GUI 皮肤」，而是一个**带云端账号与团队协作的桌面智能体工作台**——聊天、文件读写、本机命令、后台作业、子代理/工作流、任务清单、知识库、插件、桌宠都在一个应用里，消息端到端加密，安装包自带更新链。

**一句话判断**：**在「单机长任务」这条线上，和鸣已经能打；在「可编程性、沙箱安全、扩展生态、多端」这三条线上，还差一个量级。**

### 1.1 总览评级

（★＝明显领先；✓＝对齐；◐＝部分对齐；✗＝明显落后；—＝形态不同、不直接可比）

| 维度 | 和鸣 | Codex CLI | Claude Code | 判定 |
| --- | --- | --- | --- | --- |
| 运行形态（TUI/无头/CI/SDK） | GUI 桌面 + Web | TUI + `codex exec` + 云端 | TUI + `-p` + SDK + IDE + Web/移动 | **✗ 落后**（缺口最大之一） |
| 智能体核心循环 | ✓ 成熟 | ✓ | ✓ | ◐ 基本对齐（缺检查点回滚、写侧依赖调度） |
| 工具集（文件/命令/搜索/图片） | ✓ 26+ 工具 | ✓ | ✓ | ✓ 对齐（缺 PTY、笔记本、LSP） |
| 沙箱与审批 | 根目录授权 + HITL | **OS 级沙箱** + 4 档审批 | **OS 沙箱 + hooks + 规则** | **✗ 落后**（安全模型代差） |
| 上下文管理 | ✓ 预算/压缩/校准/折叠 | ✓ | ✓ + `/context` | ◐ 接近（缺检索式长期记忆） |
| 项目约定与记忆 | AGENTS.md/HEMING.md + `/init` | AGENTS.md | CLAUDE.md 层级 + `/init` | ✓ 对齐 |
| 扩展性（插件/技能/hooks/命令） | 插件强、技能有、**无 hooks** | 提示词模板 + MCP + notify | **skills + plugins + hooks + 自定义命令** | **✗ 落后**（生态机制） |
| 多智能体与编排 | 并行子代理 + DAG 工作流 | 云端并行任务 | 子代理 + 团队 | ✓ 对齐（局部领先） |
| 长任务可靠性 | **作业/通知/续跑/收口自检** | ✓ | ✓ | ★ 局部领先 |
| 界面与可用性 | 13 个面板、中文、diff | TUI | 终端 + IDE | ★ 形态优势（但缺移动端/内联 diff） |
| 团队与数据 | **E2E 加密 + 团队 + 文件** | 无（本地） | 企业设置/审计（无自建账号体系） | ★ 领先（但也带来运维负担） |
| 分发与运维 | Win-only、明文 http 更新、无签名校验 | 单二进制、多平台 | npm/多平台 | ✗ 落后 |
| 可观测性与评测 | **50 条确定性评测 + 56 项冒烟** | 结构化事件流 | OTel 遥测 | ◐ 评测领先、遥测落后 |

### 1.2 三句话总结

1. **能力广度已经够**：文件 8 件、命令 4 件、联网 7 件、子代理、工作流、清单、作业、知识库、插件、团队——Codex/Claude Code 有的工具面，和鸣基本都有对应物。
2. **真正的差距不在「有没有」，在「能不能被程序调用」与「安全边界怎么划」**：没有无头模式与 SDK，就进不了 CI 与其它人的工作流；没有 OS 级沙箱与 hooks，安全就靠「用户点确认」这一层人肉闸门。
3. **和鸣有两条别人没有的护城河**：端到端加密的团队协作（Codex/Claude Code 都是本地或企业托管，不给你一套自建账号体系），以及**确定性评测回归网**（50 条脚本化模型用例，改一行就能证明没退化）——这是工程能力，不是功能清单。

---

## 2. 对比矩阵（细项）

评级：✓ 对齐｜◐ 部分｜✗ 缺｜★ 领先｜— 不适用

### 2.1 运行形态与入口

| 能力 | 和鸣 | Codex CLI | Claude Code |
| --- | --- | --- | --- |
| 桌面 GUI | ★ 完整（Electron + React） | ✗ | ✓（桌面应用） |
| 终端 TUI | ✗ | ★ | ★ |
| 无头/脚本模式 | ✗ | ✓ `codex exec --json` | ✓ `claude -p --output-format stream-json` |
| SDK / 嵌入自有应用 | ✗ | ◐（MCP server 模式） | ★ Agent SDK（TS/Py） |
| IDE 集成 | ✗ | ◐（经云端/评审） | ★ VS Code / JetBrains |
| Web 端 | ◐（同构但受桌面桥限制） | ✓ 云端 | ✓ claude.ai/code |
| 移动端 | ✗ | ✗ | ✓ |
| 多平台 | ✗ 仅 Windows NSIS | ✓ macOS/Linux/Win | ✓ macOS/Linux/Win |

**差距本质**：和鸣把「交互」做成了产品，把「可编程」放在了后面。对个人用户没问题，对团队/CI 就是硬缺口。

### 2.2 智能体核心循环

| 能力 | 和鸣 | Codex | Claude Code | 备注 |
| --- | --- | --- | --- | --- |
| 多轮工具循环 | ✓ `agentStream.ts:1291` | ✓ | ✓ | 单段 12 轮硬顶，靠预算/续跑收口 |
| 流式解析（跨帧 tool_calls） | ✓ `llmClient.ts:267` | ✓ | ✓ | |
| 只读工具并行 | ✓ 并发 3 `agentStream.ts:195` | ✓ | ✓ | |
| 写工具串行保序 | ✓ `writeChain` `:1853` | ✓ | ✓ | 无依赖图调度 |
| 运行中插话（steering） | ✓ 仅 round>0 `:544` | ◐ | ✓ | 对齐 |
| 计划模式 | ✓ `planMode.ts:145` | ✓ | ✓ `ExitPlanMode` | 对齐 |
| 会话目标（跨轮保持） | ★ `/goal` `goal.ts` | ✗ | ◐ | **和鸣独有的一层** |
| 预算与收口 | ✓ `turnBudget.ts:35` | ✓ | ✓ | |
| 工具超时（真取消） | ✓ `:221` 180s | ✓ | ✓ | 取消走桥，老包如实降级 |
| 上游重试/退避 | ✓ `upstreamRetry.ts:19` | ✓ | ✓ | |
| 上下文溢出重试 | ✓ `:695` | ✓ | ✓ | 只收紧历史 |
| 重复调用提醒 | ✓ `:1282` | ◐ | ✓ | 只提示不阻断 |
| 检查点 / 回滚到某轮 | ◐ 单文件备份 + 本轮撤回 | ✓ `/undo` | ✓ `/rewind` | **差一个语义层** |
| 工具发现 | ✓ 阈值 20 + 关键词打分 | ◐ | ◐ | 无语义检索 |

### 2.3 工具集

| 能力 | 和鸣 | 证据 |
| --- | --- | --- |
| 读文件（分页） | ✓ `file_read` offset/limit | `fileEdit/tools.ts:95` |
| 写文件（原子写） | ✓ `file_write` | `desktop/file-fs.js:1259` |
| 改文件（锚点/全文替换） | ✓ `file_edit` | `toolOps.ts` |
| 补丁（多文件） | ✓ `file_patch` | `apply.ts:61` |
| 列文件 | ✓ `file_glob` | `file-fs.js:586` |
| 搜内容（带行号） | ✓ `file_grep` | `file-fs.js:640` |
| 读图（视觉管道） | ✓ `file_image` | `file-fs.js:366` |
| 撤销写盘 | ✓ `file_undo`（每份一次） | `file-fs.js:1028` |
| 本机命令 | ✓ `run_command` 30s/120s | `shell-run.js:356` |
| 后台作业 | ✓ 4 个工具、20 上限、30min | `shell-run.js:618` |
| 联网搜索/读网页 | ✓ `web_search`/`web_read` | `lib/webtools/tools.ts` |
| 时间/计算/JSON/编码 | ✓ 4 个只读工具 | 同上 |
| 任务清单 | ✓ `todo_write` + 面板 | `todo/tool.ts:29` |
| 子代理 | ✓ `agent_task`（并行≤3、只读/可写） | `subagent.ts:42` |
| 工作流（DAG） | ✓ `workflow_run` 6 步/并行 3 | `workflow.ts:32` |
| 长输出分段读 | ✓ `tool_output_read` | `spill/store.ts:41` |
| 工具检索 | ✓ `tool_search` | `agentStream.ts:73` |
| MCP 客户端 | ✓ stdio + Streamable HTTP | `mcp/httpClient.ts:33` |
| MCP 服务端模式 | ✗ | — |
| PTY 交互式终端 | ✗（未确认） | — |
| 笔记本（.ipynb）编辑 | ✗ | — |
| LSP / 语义跳转 | ✗ | — |
| 浏览器自动化 | ◐（MCP 里 windows-desktop / scrapling） | — |

### 2.4 沙箱与权限（**差距最大的一节**）

| 能力 | 和鸣 | Codex CLI | Claude Code |
| --- | --- | --- | --- |
| 沙箱层级 | **应用层**：根目录授权（`roots{name,mode}` 每请求传入） | **OS 级**：Seatbelt / Landlock+seccomp | **OS 级**：Seatbelt / bubblewrap |
| 写权限边界 | 根内可写，其余拒 | 工作区可写 + `writable_roots` | 工作区可写 + 规则 |
| 网络边界 | 无（渲染层可经主进程桥发任意 http/https） | 默认**禁网**，按需开 | 可配域名白名单 |
| 审批策略 | 三档：免问(read/write)、danger 必问、规则记忆 200 条 | 四档：`untrusted`/`on-failure`/`on-request`/`never` | 四档：default/acceptEdits/plan/bypass |
| 规则文件 | 无（规则存本地、可撤销，不可版本化） | `config.toml` profiles | `permissions.allow/deny/ask` glob |
| Hooks（确定性闸门） | ✗ | ◐ `notify` | ★ PreToolUse/PostToolUse/Stop/… |
| 命令白名单 / 危险命令解析 | ◐ 静态表 + 危险词（`classify.ts:66`） | ✓ | ✓ |
| 沙箱外「升级请求」 | ✗（模型不能申请提权） | ✓ | ✓ |
| CSP | **report-only 默认**（`main.js:357`） | — | — |
| 密钥存储 | safeStorage + 白名单 bootstrap | 本地凭据 | 系统钥匙串 |

**差距本质**：和鸣的信任模型是「**用户信任这个应用**，所以应用把根目录交给我自由读写」；Codex/Claude Code 的模型是「**不信任模型产生的任何动作**，先关进 OS 沙箱，再按策略放行」。后者是安全工程的正确方向，也是企业采购的硬门槛。

### 2.5 上下文与记忆

| 能力 | 和鸣 | Codex | Claude Code |
| --- | --- | --- | --- |
| 窗口预算自动分配 | ✓ `modelBudget.ts:21`（0.6 窗口、8–24 轮） | ✓ | ✓ |
| 工具结果折叠 | ✓ 3000 token/条、留最近 3 条 | ✓ | ✓ |
| 摘要压缩 | ✓ `history.ts:78` + `/compact` | ✓ | ✓ |
| 压缩可见 | ★ 折叠条数/时间提示 + `/status` 行 | ◐ | ✓ `/context` |
| 估算校准 | ✓ `calibration.ts:31`（真实 usage 反推） | ✓ | ✓ |
| 上下文水位提醒 | ✓ `contextMeter.ts:18`（30%/80%） | ✓ | ✓ |
| 项目约定文件 | ✓ AGENTS.md/HEMING.md/.heming/*（4000/6000 字上限） | ✓ AGENTS.md | ✓ CLAUDE.md 四层 |
| 长期记忆（检索式） | ✗（未发现实现） | ◐ | ✓ memory tool |
| 会话导出 | ✓ `/export`（本轮新增，未测试） | ◐ | ✓ `/export` |

### 2.6 扩展性

| 能力 | 和鸣 | Codex | Claude Code |
| --- | --- | --- | --- |
| 技能（SKILL.md 渐进披露） | ✓ 导入/社区/内置/自动匹配 | ✗ | ★ `.claude/skills` |
| 插件包 | ★ 声明式 v5 + ed25519 验签 + 8 类权限 + 9 贡献点 | ✗ | ★ 插件市场 |
| 自定义 slash 命令文件 | ✗（9 条内置，不可扩展） | ✓ `~/.codex/prompts/*.md` | ✓ `.claude/commands/*.md` |
| Hooks | ✗ | ◐ notify | ★ 8 类事件 |
| 子代理定义文件 | ✗（代码内固定） | ✗ | ✓ `.claude/agents/*.md` |
| MCP 双向 | ◐ 仅客户端 | ✓ 双向 | ✓ 双向 |
| 市场/目录 | ◐ 插件目录（8 版本、无分类消费）+ 技能池 | — | ✓ 市场 |
| 团队共享配置 | ✗ | — | ✓ managed settings |

### 2.7 多智能体与编排

| 能力 | 和鸣 | Codex | Claude Code |
| --- | --- | --- | --- |
| 并行子代理 | ✓ `agent_task` tasks 1–3 | ✓（云端并行任务） | ✓ Task 并行 |
| 子代理可写 | ✓ 需用户显式开 `/subagent write on` | ✓ | ✓ |
| DAG 工作流 | ★ `workflow_run`（needs 依赖 → 波次并行） | ✗ | ◐ |
| 进度可见 | ✓ SubagentRuns 状态条 | ◐ | ✓ |
| 云沙箱并行任务 | ✗ | ★ | ★ |
| Agent teams（多代理协作） | ✗ | ✗ | ✓（未核实细节） |
| 模型混用（子代理换模型） | ✗（未确认支持） | ✓ | ✓ |

### 2.8 长任务与可靠性（和鸣的相对强项）

| 能力 | 和鸣 | 证据 |
| --- | --- | --- |
| 自动续跑（轮次边界） | ✓ `longTask.ts:39`（12 轮/段×3） | |
| 收口自检（说做完但清单没打勾） | ★ `finishGate.ts`（只催一次、有插话先让） | |
| 后台作业完成通知 | ✓ `jobWatch` + JobReadyBar + 系统通知 | |
| 长输出落盘/分段读 | ✓ spill 40 条/4M、落盘 600K | |
| 断点续跑（未跑完的一轮） | ✓ ResumeBar（24h 过期、不 replay） | |
| 失败归因 | ★ `/status` 工具失败统计（按错误码/工具） | |
| 停止语义诚实 | ✓ 停的是这一轮、后台作业另说 | |
| 状态自检 | ★ `/status` 14 项（模型/目录/预算/清单/作业/压缩/失败/MCP/通知…） | |

**判断**：这一块和鸣做得比 Codex/Claude Code 更「产品化」——对方更依赖用户自己看终端输出与日志。

### 2.9 界面与交互

| 能力 | 和鸣 | 备注 |
| --- | --- | --- |
| 多行输入/历史/粘贴/拖拽 | ✓ 高度可拖、↑↓ 历史、文件 ≤5 | |
| 语音输入 | ✓ Web Speech + MediaRecorder（60s） | |
| 附件与文档解析 | ✓ ≤5、6MB、doc/pdf 解析 | |
| 引用工作区文件 | ✓ 最多 3 个、未读到有提示 | |
| 会话内搜索 | ✓ 命中列表 + 跳转高亮 + 上下步进 | 仅已加载明文 |
| 跨会话搜索 | ✓ 服务端检索 | 无 FTS、无分页 |
| 工具轨迹 | ✓ 参数摘要/结果预览/失败原因/定位 | |
| 改动对照 | ✓ 逐文件 diff 弹窗 + 会话台账 | 不内联进消息 |
| 面板 | 13 个（清单/目标/预算/作业/子代理/续跑/进度/改动/HITL…） | |
| 键盘 | Ctrl+K、?、Alt+数字、Esc | **无 Ctrl+F** |
| 移动端 | ✗ | |
| 内联 diff / 单条重生成 | ✗ | |
| 虚拟滚动 | ✗ | |

### 2.10 团队、数据与账号

| 能力 | 和鸣 | Codex | Claude Code |
| --- | --- | --- | --- |
| 自建账号体系 | ✓ 注册/登录/口令 scrypt | ✗（用 OpenAI 账号） | ✗（用 Anthropic 账号） |
| 端到端加密 | ★ 服务端只见信封（cipher/chain_kid/n） | — | — |
| 团队/成员/方案/任务 | ✓ | ✗ | ◐ 企业管理 |
| 群聊/多人会话 | ✗ | ✗ | ✗ |
| Token 生命周期 | ◐ 无过期/无刷新/无吊销 | ✓ | ✓ |
| 文件存储 | ◐ base64 入 SQLite、200MB/人 | — | — |
| 服务端审计 | ✗ | — | ✓ |

### 2.11 分发、更新与运维

| 能力 | 和鸣 | Codex | Claude Code |
| --- | --- | --- | --- |
| 安装包 | ✓ 自绘 setup + 静默 NSIS | ✓ 单二进制/npm | ✓ npm |
| 多平台 | ✗ 仅 Windows | ✓ | ✓ |
| 自动更新 | ✓ 自写编排 + 空间预检 | ✓ | ✓ |
| 更新包签名 | ✗（feed 明文 http，仅 sha512 校验） | ✓ | ✓ |
| 灰度/回滚 | ✗ | ◐ | ◐ |
| 数据迁移 | ✓ 首启补迁旧 userData | — | — |

### 2.12 可观测性与评测

| 能力 | 和鸣 | Codex | Claude Code |
| --- | --- | --- | --- |
| 客户端自检 | ★ `/status` 14 项 | ✓ `/status` | ✓ `/status` `/context` |
| 用量/成本 | ✓ 会话用量行（`/status`） | ✓ | ✓ `/cost` |
| 结构化事件流 | ✗ | ✓ `--json` | ✓ `stream-json` |
| 服务端日志/指标 | ✗（console.log，无 request id / metrics） | — | ✓ OTel |
| 崩溃上报 | ◐ 本地 crash-*.log，不联网 | — | ✓ |
| 确定性评测 | ★ 50 条 YAML + 17 类 grader + 脚本化模型 | ✗ | ✗ |
| 真实模型评测 | ◐ `--real` 模式（39/40 通过过） | ✗ | ✗ |
| 真机 E2E | ✗（56 项 Electron 冒烟，但无点击级 E2E） | — | — |
| CI 集成 | ◐ windows-latest 跑 build/test/smoke | ✓ | ✓ GitHub Actions |

---

## 3. 逐维度深挖：差距的本质与补法

### 3.1 运行形态：没有「可编程入口」，就进不了别人的工作流

**和鸣现状**：产品是一个 Electron 应用，所有能力都绑在 React 渲染层的 `ChatPage` 上。`packages/setup` 是安装器不是 CLI；仓库里没有 `bin/`、没有 headless 入口、没有对外 SDK。

**对方怎么做**：Codex CLI 的 `codex exec --json` 让「跑一个任务、拿到结构化结果」变成一条 shell 命令；Claude Code 的 `-p --output-format stream-json` 加官方 SDK，让同一个循环能被 TypeScript/Python 程序调用。

**为什么这是硬伤**：CI 里跑不了、定时任务里跑不了、别人的编辑器插件接不进来、也没法做「批量处理 200 个仓库」这类事。Codex/Claude Code 的生态一半建立在这上面。

**最小可行补法**（S–M）：把 `agentStream` + 工具桥抽成不依赖 React 的 `@heming/agent-core`（只依赖 `ToolBridge`、`LlmProfile`、`SessionStore` 三个接口——现在已经是这个形状，`runAgentMentions` 就是纯函数），再加一个 `packages/cli`（`heming run "..."` / `heming exec --json` / `heming resume`）。这一步没有想象中大，因为 d.209 起协议层测试已经把 `llmClient` 与 UI 解耦了。

### 3.2 沙箱：从「信任目录」到「限制进程」

**和鸣现状**：`roots` 由渲染层每次请求传入（`file-fs.js:233`），主进程只校验「路径在这个根内、逐级无软链、非保留名」；命令走 `cmd.exe /c`，**没有任何权限收敛**（`shell-run.js:13`）；网络经 `http-bridge` 默认放行任意 http/https。安全完全依赖渲染层的 HITL：危险操作弹窗、用户点「允许」。CSP 默认还是 report-only（`main.js:357`）。

**对方怎么做**：先在 OS 层关住（Seatbelt/Landlock/bubblewrap，默认禁网），再谈审批。模型想越界只能**申请升级**，用户逐条批准。Claude Code 还能把「团队规范」写成 hooks：`PreToolUse` 退出码 2 就直接拦死，不依赖模型自觉。

**真实风险**（不是理论）：提示注入可以让模型去读 `~/.ssh/id_rsa`（如果用户把家目录设成了根）、去 `curl` 一个恶意地址、或者在 `run_command` 里执行任意 PowerShell。HITL 只在用户认真看弹窗时有效，而长任务里用户会点「全部允许」。

**补法**（M–L，分三步）：
1. **命令白名单 + 网络策略**（S）：`run_command` 加 allowlist（默认 `node/pnpm/git/python` 等），网络请求加域名白名单（`web_read` 已有限制，`http-bridge` 没有）。
2. **写侧沙箱**（M）：对 `run_command` 加「工作目录锁定 + 环境变量裁剪 + 超时必杀」，Windows 上用 Job Object 限制子进程树（现在已有 killTree，但没有资源限制）。
3. **hooks 机制**（M）：`pre_tool_use` 脚本按工具名/参数匹配，返回非零即拒绝——把「不许改 dist、不许 curl」这类团队规范做成确定性闸门，而不是让模型记住。

### 3.3 可回滚：差的是「语义层」，不是「备份」

**和鸣现状**：有 `file_undo`（每路径 10 份备份，一份只用一次）、本轮改动可逐文件撤回、会话改动台账。**但没有「回到第 7 轮之前」**——模型跑了 20 轮把仓库改乱，用户只能逐个文件点撤回。

**对方怎么做**：Codex 的 `/undo` 按轮回滚；Claude Code 的 `/rewind` 基于检查点（代码与对话一起回到某个时间点）。

**补法**（M）：在 `turnWrites` 之上加「轮次快照」（每轮收口把本轮写入的文件备份 id 记成一串），`/rewind N` 就按串逆序 undo。数据已经有了（`backups/index.json`），缺的是索引结构与命令。

### 3.4 扩展性：和鸣缺的是「用户能写的东西」

**和鸣现状**：插件体系其实很强——ed25519 验签、8 类权限、9 个贡献点、事务化安装、防降级（`plugin-kit/STANDARD.md`）、技能（SKILL.md）已能导入与社区分发。**缺的是「轻量扩展」**：不能像 Codex 那样往 `~/.codex/prompts/` 丢一个 md 就多一条命令，也不能像 Claude Code 那样写个 hooks 脚本改变工具行为。九个 slash 命令全写死在 `slashCommands.ts`。

**补法**（S–M）：
1. **自定义命令**（S）：`%APPDATA%/Heming/commands/*.md`，frontmatter 带 `description`/`args`，加载进 `/` 面板——复用现有 `slashCommands` 的注册表结构即可。
2. **hooks**（M，见 3.2）。
3. **子代理定义文件**（S）：`.heming/agents/*.md`（工具白名单、模型、描述），复用 `subagentSpec`。
4. **MCP 服务端模式**（M）：把和鸣的工具集以 MCP server 暴露出去，别的编辑器/CLI 能调它——这是「被集成」的入口。

### 3.5 上下文与记忆：不缺压缩，缺「长期记忆」

**和鸣现状**：预算、折叠、摘要压缩、校准、水位提醒都在，甚至比多数产品更透明（折叠条数会说出来）。**但没有检索式长期记忆**：跨会话的「上次那个接口约定」只能靠用户自己说，或者靠知识库手动引用。

**对方怎么做**：Claude Code 有 memory tool 与 CLAUDE.md 分层；Codex 靠 AGENTS.md + 会话续跑。

**补法**（M）：知识库（`vault-fs`/`wiki-fs`）已经是现成的存储层，缺「收口时自动提炼事实 → 写入 `memory/` → 下轮按需检索注入」的闭环。风险是噪音，必须带「可撤销/可查看」的界面。

### 3.6 多智能体：和鸣的 DAG 工作流是独有优势，要敢用

`workflow_run` 的 `needs` 依赖 + Kahn 波次并行，在 Codex/Claude Code 里没有直接对应物（Claude Code 刚有 agent teams，未核实细节）。但当前限制很紧：6 步、每步只读（`workflow.ts:32`）。放开「可写步骤 + 失败重试 + 人在环」之后，这才是和鸣最能打的差异点。

### 3.7 界面：从「面板多」到「操作快」

缺的三个高频操作：**Ctrl+F 唤起搜索**（现在要点按钮）、**内联 diff**（现在要开对话框）、**单条消息重生成**（现在只能整轮重试）。这三个都不难（各 S），但对日常手感影响最大。

### 3.8 分发与安全运维：Windows-only + 明文更新是硬伤

更新 feed 是明文 http + sha512 校验，没有代码签名校验（`auto-update.js:38` 起）。对个人用户够用，对企业在内网部署就是风险点。多平台产物缺失（仅 NSIS），意味着 macOS/Linux 用户完全用不了。

### 3.9 评测：这是和鸣最被低估的资产

`evals/cases` 50 条 YAML、17 类 grader、脚本化模型可确定性回放、`--real` 可切真模型、baselines 对比（token/耗时/通过率）——这比 Codex/Claude Code 公开的能力更工程化。问题是：**没有夜间真实模型矩阵**，脚本化模型只能证明「编排没坏」，证明不了「模型还能用好这些工具」。

**补法**（M）：`--real` 接到每日定时（10 条抽样）+ 记录 flaky + 成本上限；再加一层「安装包启动冒烟」（现在冒烟跑的是未打包的 `electron .`，r105–r108 的 `Cannot find module` 就是这么漏的）。

---

## 4. 和鸣相对 Codex / Claude Code 的真实优势

不是自嗨，是对比下来站得住的三条：

1. **端到端加密的团队协作**。消息在客户端加密（服务端只见信封：`cipher`/`chain_kid`/`n`，`ws.ts:222`），团队/成员/任务/用量都在。Codex 和 Claude Code 都没有「自建账号 + E2E + 团队」这一层——它们是工具，和鸣是「一个能协作的工作台」。
2. **确定性评测回归网**。50 条用例可离线回放、17 类 grader、改一行就能证明没退化。这一条在本项目里已经抓到过多个真 bug（d.165 三个静默 bug、d.217 假绿用例）。
3. **长任务的产品化**：后台作业 + 完成通知 + spill 落盘 + 断点续跑 + 收口自检 + `/status` 失败归因。这些在终端产品里要靠用户自己看日志，和鸣把它们做成了界面。

---

## 5. 差距 Top 20（按「影响 ÷ 成本」排序）

| # | 差距 | 现状 | 对方 | 影响 | 最小可行补法 | 工作量 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 无头/脚本模式 | 只能 GUI 点 | `codex exec` / `claude -p` | 进不了 CI、无法批量 | 抽 `agent-core` + `packages/cli` | M |
| 2 | 无 OS 级沙箱 | 根目录授权 | Seatbelt/Landlock | 提示注入可读任意文件 | 命令白名单 + 网络策略先行 | M |
| 3 | 无 hooks | 全靠 HITL | 8 类事件 | 团队规范无法固化 | `pre_tool_use` 脚本闸门 | M |
| 4 | 无检查点回滚 | 单文件 undo | `/rewind` `/undo` | 跑乱 20 轮只能逐文件撤 | 轮次快照 + `/rewind N` | M |
| 5 | 无 IDE/编辑器集成 | 无 | VS Code/JetBrains | 用户切窗口成本 | 先做 MCP server 模式 | M |
| 6 | 无自定义命令 | 9 条写死 | 命令文件 | 重复提示词 | `commands/*.md` 加载 | S |
| 7 | 无移动端 | 只有 Win 桌面 | Web/移动 | 场景受限 | Web 端补齐（去掉桌面桥依赖） | L |
| 8 | 更新无签名/明文 | http feed | 签名 + https | 企业不信任 | https + 安装包签名校验 | M |
| 9 | 无长期记忆 | 仅会话内 | memory tool | 跨会话重复交代 | 知识库 + 收口提炼 | M |
| 10 | 无 PTY | 命令是一次性的 | 交互式终端 | 不能跑需要输入的命令 | 桌面 PTY 通道 | M |
| 11 | 无服务端可观测 | console.log | OTel | 排障靠用户 | request id + 结构化日志 + /metrics | M |
| 12 | 无真机 E2E | 只有冒烟 | — | 安装包级回归靠人 | Playwright/spectron 类 | M |
| 13 | 工具发现是关键词 | `discovery.ts:134` | 语义检索 | 装 30 个工具后选错 | embedding 检索（可后置） | M |
| 14 | 写侧无依赖调度 | 全串行 | 依赖图 | 多文件改动慢 | 按文件分桶并行 | M |
| 15 | 无群聊/多人会话 | 单人会话语义 | — | 团队协作只有任务板 | 会话 kind 扩展 | L |
| 16 | Token 无过期/吊销 | 永久 token | 标准 OAuth | 安全审计不过 | 过期 + 刷新 + 吊销端点 | S |
| 17 | 无 FTS 搜索 | 线性扫 4000 条 | 全文索引 | 大会话搜索慢 | SQLite FTS5 | S |
| 18 | 无内联 diff / 单条重生成 / Ctrl+F | 面板式 | 终端原生 | 日常手感 | 各 S | S |
| 19 | 无真实模型夜间回归 | `--real` 手动 | — | 模型升级后无声退化 | 定时 + flaky 记录 | S |
| 20 | 仅 Windows | NSIS | 三平台 | 覆盖面 | macOS/Linux 产物 | L |

---

## 6. 路线建议（三个阶段）

### 阶段一：补齐「可编程基线」（1–2 周）
1. `packages/cli` + `agent-core` 抽取（Top 1）；
2. 更新链 https + 安装包签名校验（Top 8）；
3. Token 过期/刷新/吊销 + 登录限流（Top 16）；
4. SQLite FTS5 搜索（Top 17）。

**验收**：`heming exec --json` 能在 CI 里跑完一条 eval 用例；安装包签名校验失败会拒绝安装。

### 阶段二：安全与生态（3–4 周）
5. 命令白名单 + 网络域名策略（Top 2 的第一步）；
6. `pre_tool_use` hooks（Top 3）；
7. 轮次快照 + `/rewind`（Top 4）；
8. 自定义命令 + 子代理定义文件（Top 6）；
9. MCP server 模式（Top 5）；
10. 服务端 request id + 结构化日志 + 关键指标（Top 11）。

**验收**：写一个 hooks 脚本能拦住「改 dist」；`/rewind 3` 能把仓库与对话一起退回三轮前。

### 阶段三：差异化放大（4–6 周）
11. 工作流放开可写步骤 + 重试 + 人在环；
12. 长期记忆闭环（知识库 + 收口提炼 + 可查看/撤销）；
13. 真实模型夜间矩阵 + 安装包启动冒烟（Top 19 + Top 12）；
14. Web 端去桌面桥依赖 + 移动端最小可用（Top 7/20）。

**验收**：一个 20 步的工作流能跑完并在中途请求确认；连续 7 天真实模型评测通过率不掉。

---

## 7. 结语：差距的性质

Codex CLI 和 Claude Code 是**「被程序员嵌进工作流的工具」**——它们的强项是沙箱、无头、hooks、IDE 集成，弱项是没有账号体系、没有团队、没有可视化。

和鸣是**「一个 AI 同事坐进你的工作台」**——强项是界面、长任务、团队与数据，弱项是可编程性与安全边界。

所以差距不是「和鸣差」，是**两类产品的最优解不同**。但如果和鸣的目标是「比肩 codex」，就必须把对方那套**可编程 + 安全**的底座补上；补上之后，它的界面、团队、E2E、确定性评测会变成别人拿不走的差异化。

---

## 8. 附录

### 8.1 和鸣能力清单与证据索引（摘要）

| 子系统 | 关键文件 |
| --- | --- |
| 核心循环 | `packages/web/src/lib/agentStream.ts`（`:1291` 回合循环、`:195` 并行、`:221` 超时、`:544` steering） |
| 协议层 | `packages/web/src/lib/llmClient.ts`（`:267` tool_calls 拼装、`:314` streamChat） |
| 文件工具 | `packages/web/src/lib/fileEdit/tools.ts`、`toolOps.ts`、`apply.ts`、`match.ts` |
| 命令工具 | `packages/web/src/lib/shell/*`、`packages/desktop/shell-run.js` |
| 子代理/工作流 | `lib/agentRuntime/subagent.ts`、`workflow.ts`、`finishGate.ts`、`longTask.ts` |
| 上下文 | `lib/agentContext/*`（`history.ts:78` 压缩、`calibration.ts:31`、`modelBudget.ts:21`） |
| 权限 | `lib/hitl/*`（`classify.ts:66`、`policy.ts:51`）、`lib/agentRuntime/planMode.ts:145` |
| 桌面桥 | `packages/desktop/file-fs.js`、`shell-run.js`、`path-guard.js`、`main.js:114`（IPC 校验） |
| 评测 | `evals/runner/*`、`evals/cases`（50 条） |
| 冒烟 | `packages/desktop/smoke/main.js`（13 类 56 项） |

### 8.2 Codex CLI / Claude Code 能力清单（内部知识，未联网核验）

（内部知识，未能联网核验）要点：
- **Codex**：TUI + `codex exec`、Seatbelt/Landlock 沙箱、四档审批、AGENTS.md、`~/.codex/prompts`、MCP 双向、`notify` 钩子、`/undo`、云端并行任务 + PR。
- **Claude Code**：TUI + `-p` + SDK、四档权限 + 规则 glob、8 类 hooks、CLAUDE.md 四层、skills、plugins、自定义命令、子代理定义、MCP 双向、`/rewind` 检查点、IDE/桌面/Web/移动端、OTel。

### 8.3 复核方法

- 和鸣的每条断言都能用 `Select-String -Path <路径> -Pattern <关键词>` 复核；
- 对方侧断言标注了「未核实」的，请在联网后对照官方文档修正；
- 本文档不含任何未经代码验证的「已修复」类断言。

---

*文档版本：v1（2026-11-17）。* 建议后续每补齐 Top 20 中的一项，就在第 5 节表格上划掉并把证据补进第 8 节。
