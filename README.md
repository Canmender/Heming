# 和鸣

原生电脑端智能体应用平台（云端中心化）：IM + 多 Agent 混合框架。

> **当前版本**：`d.33.1.8.0`　查看最新：`node scripts/version.mjs`（或 `pnpm version:show`）
> **版本号规则**：5 段 `d.特性.破坏性.修订.构建`，**每次修改/修复都要 bump** —— 见 [docs/VERSION-MANAGEMENT.md](docs/VERSION-MANAGEMENT.md)
> 改动记录见 [CHANGELOG.md](CHANGELOG.md)。

> 接手开发先读 **[docs/HANDOFF.md](docs/HANDOFF.md)**（现状 / 架构红线 / 工作方式约定 / 下一步候选）。

## 能力

- **智能体对话** — 每用户本机配置 LLM（OpenAI 兼容 + Anthropic），Key 仅存本机；群内 @ 触发流式回复；支持 1:1 智能体会话、思考过程与工具轨迹可视化；支持视觉的模型可读图片（**历史里的图与本轮刚上传的图都能看**：输入框有正文时选图即为「图片 + 文字同发」一条消息，按智能体所绑模型判定，图片本地解密后直连供应商）；可将自建智能体加入自己创建的群（新建群时勾选，随后群内 @ 即可对话）；绑定的模型缺能力时**发送前就明说会丢什么**（不支持工具 / 不支持图片），判定与实际丢弃同源
- **工具与 MCP** — HTTP / stdio 两种传输、预置服务、自动连接、工具级开关；模型可在会话中调用外部工具，结果回灌后继续回答；stdio 仅桌面端，启动恒定 `shell:false`，删除服务会回收其本机子进程
- **MCP Registry 发现** — 接口区可搜索官方 Registry 并一键安装（搜索防抖、6h 本地缓存、离线降级）；安装前始终弹确认卡（来源/评级/请求头），装完工具默认全部关闭；本地 npm/pypi 包需本机已有 Node.js / uv（不内置运行时，装之前先探测并标出「缺运行时 / 需桌面版」），且必须钉死版本、包名走字符白名单、启动恒定 `shell:false`；删除服务会回收其本机子进程
- **人工确认（HITL）** — 工具执行前先问用户；风险分 `read/write/danger` 三级，档位 `strict/guarded/trusted`，没有“全部放行”档；可按工具与资源记住允许/拒绝（**规则按智能体隔离**，拒绝优先，危险操作不记忆，最多 200 条、可一键清空）；被拒调用不执行但仍回灌 tool 消息，且区分「用户拒绝 / 命中规则 / 闸门异常」；确认前可查看将写入的变更（编辑显示行级 diff、写文件显示行数、删除只显示路径，不读取文件内容）；弹窗标明请求来自哪个会话，离开会话时其待确认项按拒绝收口
- **任务区** — 面向长任务的三栏视图（Alt+8）：左侧任务列表（搜索/状态筛选/清除已结束），中间复用智能体会话继续对话，右侧确定性汇总（目标、结果、步骤、来源、拒绝原因）；新建任务自动把目标投递给该智能体，**任务模板**可把常用目标一键填回输入框（仍可编辑，最多 12 个、只存本机）；执行中实时耗时、三段进度与步骤时间线；报告由记录生成并可一键复制 Markdown 或 JSON（`version: 1`）；记录只存本机 `localStorage`，不上云
- **会话导出与公式** — 会话可导出 Markdown / JSON（仅本机已解密的明文，附件只带元信息，不联网），也可**多选若干条消息**只导出选中的那几条（与整会话导出同一 `version: 1` 契约）；消息支持 LaTeX 行内与块级公式（KaTeX 本地渲染，不请求外部 CDN）
- **记忆与技能池** — 三层记忆（工作/情景/语义）按需注入系统提示词；召回走**同主题时效覆盖 + MMR 去重名额**（同一主题只带最新一条，近似重复不会占满 1200 字注入预算；确定性打分、无学习式权重）；**召回全程可观测**——记忆区逐条显示打分与「注入／超预算截断／预算外未注入／被同键新值覆盖」，回答里的引用按**字符串级词重合**判定（不额外问模型），并在本机留最近 40 次生成的召回档案；技能池支持新建/导入导出（`SKILL.md`）/按查询路由/按智能体分配；记忆区（Alt+5）管理，数据只落本机 `localStorage`，不上云、不进消息，召回日志也不随记忆导出带走
- **自我优化与知识库** — `self_*` 工具可改自己的记忆/技能/MCP（带敏感内容护栏、单轮上限与留痕），每次改动都有反向快照、可在技能区逐条回滚；LLM Wiki 文件态知识库（桌面端写真实 Markdown，Obsidian 可直接打开），问答可通过只读工具检索并附确定性来源脚注；网页抓取 Scrapling 预置
- **上下文预算** — 设置区可对 @ 触发的历史做 token 预算：超出部分压缩为早期对话摘要（可选 LLM 摘要或零成本确定性摘要），供应商报上下文超限时自动收紧预算重试；只在本机执行
- **IM 与主页** — 消息撤回、回复引用、转发、语音消息、表情回应；输入栏表情/图片/文件/语音与附件消息；**应用内通知中心**（他人往非当前会话发消息、任务收尾都记一条，去重、直达对应任务，清空要确认；不碰系统通知权限）；归档页与全局搜索（Ctrl+K）；**会话内搜索**（命中跳转与高亮）；Markdown 渲染与代码高亮、PDF/Office 文档解析、图表围栏；主页近 30 日 token 用量热力图；**首帧三路请求未落地时显示加载骨架、失败时显示「加载失败 + 重试」**，不再伪装成「你还没有数据」（后台刷新失败不推翻已就绪）
- **键盘与可访问性** — 弹窗统一契约：Esc 只关栈顶那层、Tab 在面板内循环、打开即落焦、**打开期间屏蔽背景**（`inert`，无 portal 故按兄弟逐个屏蔽 + 引用计数支持嵌套；常驻通话浮层用 `data-a11y-keep` 保留可点，非模态浮层可退出）、关闭后焦点归还触发元素（仅在焦点确实无处可去时还，不抢关闭方主动安排的焦点）
- **端到端加密** — 消息与附件端到端加密（前向保密棘轮，服务端只见信封）；本地明文缓存；明文存量自迁移；桌面端安全上下文白名单
- **共享文件** — 云端共享库文件投递到会话、内嵌预览（文本/Markdown/图片）、每用户存储配额（`HEMING_FILE_QUOTA_MB`，默认 200MB）
- **桌面端** — 嵌入 web 产物经 `app://heming` 本地加载、自动更新、内置运行时、语音/视频通话独立窗口、启动动画与自定义标题栏


## 环境

- Node ≥ 24，pnpm ≥ 10

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
- `packages/desktop` — Electron 壳（嵌入产物、自动更新、stdio MCP 桥、通话窗口、文件桥）

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
| 记忆召回排序 / 通话重连 | [docs/superpowers/specs/2026-10-21-memory-recall-ranking.md](docs/superpowers/specs/2026-10-21-memory-recall-ranking.md)、[2026-10-21-voice-call-reconnect.md](docs/superpowers/specs/2026-10-21-voice-call-reconnect.md) |
| 同功能产品/许可证/差距调研 | [docs/research/2026-10-20-competitive-analysis-v2.md](docs/research/2026-10-20-competitive-analysis-v2.md) |
| 图表 / 去 AI 味 / 网页抓取 / 自我修改 | [docs/CHARTS.md](docs/CHARTS.md)、[docs/LESS-AI-TONE.md](docs/LESS-AI-TONE.md)、[docs/WEB-SCRAPING.md](docs/WEB-SCRAPING.md)、[docs/SELF-EDIT.md](docs/SELF-EDIT.md) |
| 全部文档导航 | [docs/INDEX.md](docs/INDEX.md) |

## 数据

服务端数据（账号、会话、消息、已读状态）持久化在 SQLite：

- 库文件路径由 `HEMING_DB_PATH` 指定，缺省 `./data/heming.db`（相对进程工作目录）。用的是 Node 24 内置 `node:sqlite`，没有原生依赖。
- 云端裸机部署（见 `docs/deploy.md`）注入 `HEMING_DB_PATH=/var/lib/heming/heming.db`，该目录是 api 进程唯一的写入点；systemd 重启、重发版、回滚都不动它，备份/恢复针对该目录（`docs/deploy.md` §6）。
- 本地开发默认落 `./data/heming.db`，已在 `.gitignore` 排除（`data/`），不进版本库、不进部署包。

> 智能体的**三层记忆、技能池、上下文预算、HITL 策略、自我修改留痕**不在此库中：它们只存触发设备本机的 `localStorage`；LLM Key 与 MCP 配置也只在本机。Wiki 知识库在桌面端写真实 Markdown 文件。上述数据不上云、不进消息、不进部署包；换设备或清浏览器数据会丢失（记忆/技能支持导出导入）。

