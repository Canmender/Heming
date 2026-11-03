# 和鸣

原生电脑端智能体应用平台（云端团队名册）：本机智能体 + 真实团队动向。

> **当前版本**：`d.61.2.23.0`　查看最新：`node scripts/version.mjs`（或 `pnpm version:show`）
> **版本号规则**：5 段 `d.特性.破坏性.修订.构建`，**每次修改/修复都要 bump** —— 见 [docs/VERSION-MANAGEMENT.md](docs/VERSION-MANAGEMENT.md)
> 改动记录见 [CHANGELOG.md](CHANGELOG.md)。

> 接手开发先读 **[docs/HANDOFF.md](docs/HANDOFF.md)**（现状 / 架构红线 / 工作方式约定 / 下一步候选）。

## 能力

- **智能体对话** — 每用户本机配置 LLM（OpenAI 兼容 + Anthropic），Key 仅存本机；与系统智能体「和小鸣」及自建智能体一对一对话，支持 1:1 智能体会话、流式回复、思考过程与工具轨迹可视化；支持视觉的模型可读图片（**历史里的图与本轮刚上传的图都能看**：输入框有正文时选图即为「图片 + 文字同发」一条消息，按智能体所绑模型判定，图片本地解密后直连供应商）；绑定的模型缺能力时**发送前就明说会丢什么**（不支持工具 / 不支持图片），判定与实际丢弃同源。**人类私聊/群聊与语音通话已从本版移除**，对话入口只剩本机智能体，智能体页专注智能体任务
- **工具与 MCP** — HTTP / stdio 两种传输、预置服务、自动连接、工具级开关；模型可在会话中调用外部工具，结果回灌后继续回答；stdio 仅桌面端，启动恒定 `shell:false`，删除服务会回收其本机子进程；工具目录超过 20 个时自动切**按需检索**——只暴露一部分 schema，其余由模型按关键词检索后加入可调用列表（检索是内部只读动作，不弹确认）
- **MCP Registry 发现** — 接口区可搜索官方 Registry 并一键安装（搜索防抖、6h 本地缓存、离线降级）；安装前始终弹确认卡（来源/评级/请求头），装完工具默认全部关闭；本地 npm/pypi 包需本机已有 Node.js / uv（不内置运行时，装之前先探测并标出「缺运行时 / 需桌面版」），且必须钉死版本、包名走字符白名单、启动恒定 `shell:false`；删除服务会回收其本机子进程
- **人工确认（HITL）** — 工具执行前先问用户；风险分 `read/write/danger` 三级，档位 `strict/guarded/trusted`，没有“全部放行”档；可按工具与资源记住允许/拒绝（**规则按智能体隔离**，拒绝优先，危险操作不记忆，最多 200 条、可一键清空）；被拒调用不执行但仍回灌 tool 消息，且区分「用户拒绝 / 命中规则 / 闸门异常」；确认前可查看将写入的变更（编辑显示行级 diff、写文件显示行数、删除只显示路径，不读取文件内容）；弹窗标明请求来自哪个会话，离开会话时其待确认项按拒绝收口
- **任务区** — 面向长任务的三栏视图（Alt+8）：左侧任务列表（搜索/状态筛选/清除已结束），中间复用智能体会话继续对话，右侧确定性汇总（目标、结果、步骤、来源、拒绝原因）与**只读过程日志**（开始→工具调用→结果→答案→终态，被拒单独标出，运行中每 2 秒刷新）；新建任务自动把目标投递给该智能体，**任务模板**可把常用目标一键填回输入框（仍可编辑，最多 12 个、只存本机）；执行中实时耗时、三段进度与步骤时间线；报告由记录生成并可一键复制 Markdown 或 JSON（`version: 1`）；记录只存本机 `localStorage`，不上云
- **会话导出与公式** — 会话可导出 Markdown / JSON（仅本机已解密的明文，附件只带元信息，不联网），也可**多选若干条消息**只导出选中的那几条（与整会话导出同一 `version: 1` 契约）；消息支持 LaTeX 行内与块级公式（KaTeX 本地渲染，不请求外部 CDN）
- **记忆与技能池** — 三层记忆（工作/情景/语义）按需注入系统提示词；召回走**同主题时效覆盖 + MMR 去重名额**（同一主题只带最新一条，近似重复不会占满 1200 字注入预算；确定性打分、无学习式权重）；**召回全程可观测**——记忆区逐条显示打分与「注入／超预算截断／预算外未注入／被同键新值覆盖」，回答里的引用按**字符串级词重合**判定（不额外问模型），并在本机留最近 40 次生成的召回档案；技能池支持新建/导入导出（`SKILL.md`）/按查询路由/按智能体分配（**分配即边界**：未分配的自定义技能不会进入提示词）；记忆区（Alt+5）管理，数据只落本机 `localStorage`，不上云、不进消息，召回日志也不随记忆导出带走
- **插件包** — 插件区（Alt+0）可安装、更新、启停与卸载系统能力包；`plugin.json`（v2）可声明技能与远程 MCP 服务（https，或本机 http），不执行随包代码、不携带密钥、安装时不联网、不自动连接/授权；同 id 再装即更新（技能按名称、服务按 key 增/改/删，保留请求头、工具启用状态与插件启停状态），更新前先看只读差异（新增/变更/不变/移除，冲突或数量超限时禁止确认），插件详情只读展示每个技能与服务的启用状态和地址；停用同步关闭服务，卸载连同技能、绑定、服务与工具清单一并删除，同名手工技能与转正服务不受影响；插件、技能与服务配置都只落本机 `localStorage`，不上云、不导出
- **信息中枢** — 把本机 QQ/微信归档接进和鸣：桌面端主进程用 stdio 拉起 InfoHub Python 边车（不开端口、不走网络），浏览会话、只读消息、全文检索（命中高亮并可回到会话）与议程都在本机完成；归档以 SQLite `mode=ro` 打开，同步/导出必须由用户显式勾选来源后触发；`config.json` 不进仓库，配置摘要只显示开关与「是否配置过」，不展示密钥；浏览器环境直接提示仅桌面端可用。**归档也是智能体能力**：桌面端已连接时注入 `infohub_search` / `infohub_read_conversation` / `infohub_agenda`（只读）与 `infohub_agenda_rebuild`（重扫日程，走人工确认），首页显示本机归档卡，Ctrl+K 可同时检索归档；未连接不注入工具、不自动拉起进程，`sync` 始终只由用户在信息中枢页显式触发
- **自动化** — 导航「自动化」可为本机归档建定时任务：每天定时（本地时区 + 星期）或按间隔（5–1440 分钟）执行 `infohub.sync`（QQ/微信来源、全量重扫、导出知识库）或 `infohub.agenda`（重扫日程）；任务只存本机 `localStorage`（最多 20 条），不上云、不导出、不执行任意脚本；只在和鸣运行且信息中枢已连接时触发，未连接记为跳过并顺延，**绝不自动拉起 Python 边车**；关闭期间错过的时刻不补跑。信息中枢页的「定时 / 保存为定时任务 / 定时重扫」会把当前选项直接带进新建表单
- **自我优化与知识库** — `self_*` 工具可改自己的记忆/技能/MCP（带敏感内容护栏、单轮上限与留痕），每次改动都有反向快照、可在技能区逐条回滚；LLM Wiki 文件态知识库（桌面端写真实 Markdown，Obsidian 可直接打开），问答可通过只读工具检索并附确定性来源脚注；网页抓取 Scrapling 预置
- **上下文预算** — 设置区可对智能体触发的历史做 token 预算：超出部分压缩为早期对话摘要（可选 LLM 摘要或零成本确定性摘要），供应商报上下文超限时自动收紧预算重试；只在本机执行
- **团队系统与主页** — 全站一个团队，所有注册用户即成员：团队页（导航第 2 项）显示名册、在线状态、最近活跃与动向流；在线来自服务端 WS 连接，最近活跃落库，名册 20 秒刷新。动向只含**摘要**——成员自己的任务标题/状态、日程标题/到期档位，**不包括对话正文、提示词、工具参数、智能体轨迹或附件**；任务 / 日程两类共享默认全关，逐类开启后才采集，设置只存本机，可一键清除已上传记录。智能体不是团队成员，名册与动向都不出现智能体条目。主页有团队动向卡（最近 3 条）与成员/在线/智能体/今日动向四张统计卡；Ctrl+K 改为「搜索成员与技能」，选成员直接跳团队并定位。应用内通知中心保留任务、审批与幕僚三类，不再有消息通知。
- **智能体页** — 原聊天页裁剪为「智能体」页：左栏只列本机智能体（系统预设在前，自建在后），右栏是与选中智能体的对话；保留消息列表、流式气泡、E2E 封发、附件、文档解析、图表、HITL、记忆/技能/工具、任务草稿、导出与会话内搜索。群成员、@ 选择、typing、已读、撤回、转发、表情回应、未读上报与通话入口全部删除
- **键盘与可访问性** — 弹窗统一契约：Esc 只关栈顶那层、Tab 在面板内循环、打开即落焦、**打开期间屏蔽背景**（`inert`，无 portal 故按兄弟逐个屏蔽 + 引用计数支持嵌套；非模态浮层可退出）、关闭后焦点归还触发元素（仅在焦点确实无处可去时还，不抢关闭方主动安排的焦点）
- **端到端加密** — 智能体消息与附件端到端加密（前向保密棘轮，服务端只见信封）；本地明文缓存；明文存量自迁移；桌面端安全上下文白名单
- **共享文件** — 云端共享库文件投递到智能体对话、内嵌预览（文本/Markdown/图片）、每用户存储配额（`HEMING_FILE_QUOTA_MB`，默认 200MB）
- **桌宠** — 桌面 Live2D 化身：独立透明置顶窗（`pet.html` 独立入口，不背主应用 bundle）、默认鼠标穿透并按模型包围盒动态关闭、视线跟随/点击动作/说话口型；点角色直接对话（复用 `streamChat` 直连本机 LLM，**不写会话、不进消息列表**）；位置与缩放缓存在本机，托盘常驻可显隐/切穿透；未配置模型连接时如实提示并直达设置
- **桌面端** — 嵌入 web 产物经 `app://heming` 本地加载、自动更新、内置运行时、启动动画与自定义标题栏；通话窗口与语音桥已随 IM 一并移除


## 环境

- Node ≥ 24，pnpm ≥ 10
- 信息中枢（可选）：浏览/检索用桌面端内置 Python 即可；采集/转写需要 InfoHub 自己的 Python ≥ 3.11 虚拟环境，并在页面里选它的解释器

## 启动

```bash
pnpm install
pnpm -r build

# 终端 A：云端服务端（http://127.0.0.1:8787）
pnpm --filter @heming/server dev

# 终端 B：前端（Vite，代理 /api 到 8787）
pnpm --filter @heming/web dev

# 终端 C（可选）：桌面壳（本地 dev：加载 Vite 开发服务器，由其代理 /api）
HEMING_DEV_URL=http://localhost:5173 pnpm --filter @heming/desktop dev
```

> 桌面壳（`packages/desktop`）默认加载**包内嵌入的 web 产物**（自定义协议 `app://heming`），API 与 WS 仍走云端；也可用 `HEMING_DEV_URL`（本地 Vite）或 `HEMING_WEB_URL`（自定义生产地址）覆盖。嵌入产物由 `pnpm -w run dist:desktop` 预构建，`pnpm --filter @heming/desktop start` 即以嵌入产物启动。
>
> **不能用 `file://` 加载**：它不是安全上下文，`crypto.subtle` 不可用会让 E2E 加密失效；`app://` 注册为 privileged + secure，实测 `isSecureContext=true`。
>
> 改了 web 代码要**两处分别发布**：云端（浏览器访问）与桌面端（重打安装包）。只发一处会出现“浏览器是新的、已装客户端是旧的”。


## 打包 Windows 安装包

```bash
# 国内网络需先设置 electron-builder 二进制镜像（NSIS / winCodeSign 下载）
export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
pnpm -w run dist:desktop   # 先构建嵌入 web 产物，再打包；不要直接跑 electron-builder
```

产物默认落在 D 盘 `packages/desktop/release/`（`HEMING_RELEASE_DIR` 可覆盖），生成 NSIS 安装包与 `latest.yml`（自动更新清单，缺了它客户端永远提示“已是最新”）。快捷方式名「和鸣」，`oneClick: false` 可选安装目录。暂未配置应用图标，使用 Electron 默认图标，待提供 `.ico` 后补 `build.win.icon`。


## 测试

```bash
pnpm test        # 等价于 pnpm -r build && pnpm -r test
pnpm typecheck   # 等价于 pnpm -r build && pnpm -r typecheck
```

说明：根目录 `pnpm test` / `pnpm typecheck` 会先自动 `pnpm -r build`（`shared` 的类型产物被其他包经 workspace 引用，fresh clone 直接跑测试会因缺 `dist` 失败），再执行各包的 test/typecheck。

## 结构

- `packages/shared` — 协议类型与 Zod schema（前后端唯一事实来源）
- `packages/server` — Express 5 + WebSocket + SQLite 持久化存储
- `packages/web` — React 18 + Tailwind 三栏 UI；智能体运行时（LLM/记忆/技能/MCP/HITL）全部在此
- `packages/desktop` — Electron 壳（嵌入产物、自动更新、stdio MCP 桥、文件桥；通话窗口已移除）

## 文档索引

| 想看什么 | 去哪 |
|---|---|
| 总设计、里程碑、架构红线 | [docs/superpowers/specs/2026-10-13-heming-platform-design.md](docs/superpowers/specs/2026-10-13-heming-platform-design.md) |
| 新会话接手（现状/约定/下一步） | [docs/HANDOFF.md](docs/HANDOFF.md) |
| 版本号规则与发布流程 | [docs/VERSION-MANAGEMENT.md](docs/VERSION-MANAGEMENT.md) |
| 部署、自动更新、回滚 | [docs/deploy.md](docs/deploy.md) |
| HITL 人工确认架构 | [docs/research/2026-10-21-hitl-architecture.md](docs/research/2026-10-21-hitl-architecture.md) |
| MCP Registry 接入架构 | [docs/research/2026-10-22-registry-architecture.md](docs/research/2026-10-22-registry-architecture.md) |
| 本地包运行时策略（npm/pypi、不内置运行时） | [docs/superpowers/specs/2026-10-21-local-package-runtime-policy.md](docs/superpowers/specs/2026-10-21-local-package-runtime-policy.md) |
| 记忆召回排序 | [docs/superpowers/specs/2026-10-21-memory-recall-ranking.md](docs/superpowers/specs/2026-10-21-memory-recall-ranking.md) |
| 团队系统（去 IM）设计 | [docs/superpowers/specs/2026-11-02-team-system-design.md](docs/superpowers/specs/2026-11-02-team-system-design.md) |
| 同功能产品/许可证/差距调研 | [docs/research/2026-10-20-competitive-analysis-v2.md](docs/research/2026-10-20-competitive-analysis-v2.md) |
| 图表 / 去 AI 味 / 网页抓取 / 自我修改 | [docs/CHARTS.md](docs/CHARTS.md)、[docs/LESS-AI-TONE.md](docs/LESS-AI-TONE.md)、[docs/WEB-SCRAPING.md](docs/WEB-SCRAPING.md)、[docs/SELF-EDIT.md](docs/SELF-EDIT.md) |
| 全部文档导航 | [docs/INDEX.md](docs/INDEX.md) |

## 数据

服务端数据（账号、好友关系、智能体会话与消息、团队动向摘要）持久化在 SQLite：

- 库文件路径由 `HEMING_DB_PATH` 指定，缺省 `./data/heming.db`（相对进程工作目录）。用的是 Node 24 内置 `node:sqlite`，没有原生依赖。
- 云端裸机部署（见 `docs/deploy.md`）注入 `HEMING_DB_PATH=/var/lib/heming/heming.db`，该目录是 api 进程唯一的写入点；systemd 重启、重发版、回滚都不动它，备份/恢复针对该目录（`docs/deploy.md` §6）。
- 本地开发默认落 `./data/heming.db`，已在 `.gitignore` 排除（`data/`），不进版本库、不进部署包。

> 智能体的**三层记忆、技能池、上下文预算、HITL 策略、自我修改留痕**不在此库中：它们只存触发设备本机的 `localStorage`；LLM Key 与 MCP 配置也只在本机。Wiki 知识库在桌面端写真实 Markdown 文件。上述数据不上云、不进消息、不进部署包；换设备或清浏览器数据会丢失（记忆/技能支持导出导入）。

