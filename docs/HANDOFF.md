# 和鸣 · 新会话交接文档

- 日期：2026-10-22
- 当前版本：`d.27.1.7.0`
- 当前 main：以 `git log -1` 为准（`3956d23` 弹窗屏蔽背景 + 焦点归还 + 工作区首帧状态 → `915d19c` 记忆召回的可观测性；本轮 d.27.1.7.0 **云端与安装包两处均已发布**）
- 本文用途：给新开的协作会话快速接手——现状、约定、红线、下一步

---

## 1. 项目是什么

**和鸣**：原生桌面端（Electron）智能体应用平台 = 云端服务器（IM 即时通讯 + 智能体名册）+ 桌面/网页客户端。
定位：个人智能体工作台——与人类/智能体聊天协作，管理模型接口、工具接口与记忆知识库。

- **架构红线（不可违背）**：智能体**本地驱动**（本机系统提示词 + 本机 LLM Key 直连供应商 + 本机执行），云端**只是 IM 桥梁**；个人数据（Key/记忆/知识库/本地文件）**不出设备**。
- **E2E 红线**：消息与附件端到端加密，服务端只见信封；无安全上下文时**拒绝发送，绝不降级明文**。
- 参考项目：`D:\MultiAgent`（合鸣 Ensemble）——借鉴架构，不复用代码；调研见 `docs/superpowers/research/2026-10-17-multiagent-study.md`。
- 文档总入口：`docs/INDEX.md`；竞品与许可证调研：`docs/research/2026-10-20-competitive-analysis-v2.md`；同功能异同与优化建议：`docs/research/2026-10-21-feature-parity-and-optimization.md`；缺口清单：`docs/research/2026-10-21-gap-closure.md`、`docs/research/2026-10-21-all-feature-gap-audit.md`。

## 2. 当前状态

| 项 | 状态 |
|---|---|
| 版本 | `d.27.1.7.0`（5 段，五包同步） |
| main | `204a592`（d.25.1.6.0 功能批次）→ `4107935`/`d5dbdca`（本地构建产物 + 裸机部署）→ `94e6d77`（d.25.1.7.0 发布收口）→ `3956d23`（d.26.1.7.0 弹窗屏蔽背景 + 焦点归还 + 首帧状态）→ 本轮「记忆召回的可观测性」（d.27.1.7.0） |
| 测试 | 2026-10-22 实跑：`pnpm -r build && pnpm -r --workspace-concurrency=1 test` 全绿（exit 0）；web 109 文件 / 1702 例，server 9 文件 / 212 例，shared 2 文件 / 75 例，desktop 2 例（node:test）全通过 |
| 线上 | **`d.27.1.7.0` 已发布（裸机，云端零构建）**：发版前备份落本机 `.superpowers/.tmp/backups/heming-data-2026-10-22.tar.gz`（3719 字节，含 `heming.db` 与 `-wal`）；部署包远端/本机 MD5 同为 `ee145532878442a1…`；`INSTALL DONE: d.27.1.7.0`，外部取回的 `assets/index-Bx6Ec6at.js` 与本机门禁产物同名（200，1425859 字节）、`/api/health` 返回 `{"ok":true}`、`/` 经 nginx 200，内存 444/1613MB、磁盘 5.8G/40G |
| 安装包 | **`和鸣 Setup d.27.1.7.0.exe`（178848062 字节，`release/r28/`）已发布到 `/updates`**——脚本复核远端字节数与本地一致，`latest.yml` 352 字节读到 `version: 27.1.7`，Range 请求返回 206。安装包内嵌注入 `VITE_API_BASE` 的产物（`index-Da_7nZwd.js`），与云端站点产物（`index-Bx6Ec6at.js`）**不同名即不同源**，这是预期；打完包已重跑 `pnpm --filter @heming/web build` 把本机 `packages/web/dist` 恢复成云端口径，避免下一轮误传注入版 |
| 自动更新源 | `http://47.92.39.184/updates/latest.yml` → 200 + `application/octet-stream` + 352 字节（不是 HTML 回落），当前指向 `27.1.7` |
| 账号 | 只有 `admin/admin`（`HEMING_SEED_USERS` 播种；注册默认关闭）。**重置把旧库连同 `zhoukang` 等账号一起清掉了**，历史会话/消息不可恢复 |

### 已完成里程碑

1. **M1 骨架**：monorepo（shared/server/web/desktop）、三栏壳与视觉规范、账号/好友/1:1/WS 实时、共享文件库。
2. **M2 IM**：SQLite 固化、群聊、预设混合群、已读回执、圆形雷达通讯录。
3. **M3 智能体**：名册 CRUD、本机 LLM 连接（Key 存 localStorage）、群内 @ 流式回复、入群接线。
4. **M3.5 UI**：主页 Token 热力图、聊天头像/信息卡、输入栏附件、雷达详情页。
5. **M4 文件**：共享文件持久化、投递、预览、每用户配额。
6. **二期 IM**：撤回、回复引用、转发、语音消息、表情回应、断线补偿。
7. **E2E 加密**：P-256 ECDH + HKDF 棘轮 + AES-256-GCM；信封入库、本地明文缓存、明文迁移、附件加密、Electron 安全上下文白名单。
8. **记忆/技能/上下文预算**：三层记忆（Working/Episodic/Semantic）、技能池与按智能体分配、上下文压缩与溢出重试、复盘分身（`lib/memory/review*.ts`）。
9. **主页真实数据化**：统计卡、最近会话、待处理、版本徽标均接真实数据。
10. **桌面视觉**：自定义标题栏、4.5s 启动动画、手写「Heming」字样、登录页分栏、默认最大化。
11. **语音/视频通话**：Mesh WebRTC（1:1 + 群聊），信令复用 WS，独立通话窗口，仅桌面端。
12. **web 嵌入客户端**：`app://heming` 本地加载嵌入产物；`file://` 不可用（非安全上下文会让 E2E 失效）。
13. **自动更新 + 内置运行时**：`electron-updater` + generic `/updates`；内置 Python/MCP 运行时，装完即用；stdio MCP 零外部 Node 依赖。
14. **能力扩展**：MCP HTTP/stdio 与工具调用、思考过程/工具轨迹、自我修改 `self_*`、图表、去 AI 味、网页抓取、LLM Wiki 知识库、归档页、全局搜索、文档解析、Markdown 高亮。
15. **HITL + MCP Registry**：工具执行前人工确认（三档、三级风险、队列化单槽、审计）；Registry 数据层（拉列表/去重/映射/评级）+ **发现页与安装流**（接口区二级面板、搜索防抖、TTL 缓存/离线降级、安装确认卡、请求头校验）。
16. **自主性安全与知识/视觉补全**：HITL 规则记忆（按 `{tool, resource, effect}`，deny 优先、danger 不记允许、200 条上限、可一键清空）；拒绝原因细分（user / rule / gate，闸门异常不冒充用户拒绝）；自我修改快照与回滚（按项反向操作、上限 50、`self_rollback` 走 HITL、技能区逐条回滚）；Wiki 只读工具 + 确定性来源脚注；视觉模型按智能体能力附历史图片（本地解密、4 张 / 4MB 封顶、非视觉模型当场提示）。
17. **任务区**：任务列表（搜索/状态筛选/清除已结束）+ 嵌入式 `ChatPage` + 确定性汇总三栏；新建任务自动投递目标到该智能体会话；`onRunSettled` 恰好一次收口（ok/aborted/error），工具步骤区分 ok/error/denied 并保留拒绝原因；Markdown 报告由记录纯函数生成、可复制；记录只存本机 `heming.tasks.v1`，不引入 auto-approve 或自动重试。
18. **缺口补全**：HITL 规则按智能体隔离（旧规则保持全局）；会话导出 Markdown / JSON（本机明文、跳过解不开的消息、附件仅元信息）；LaTeX 行内/块级公式（remark-math + rehype-katex，KaTeX 本地）；任务区实时耗时、三段进度、步骤时间线与应用内删除确认。
19. **全量缺口审计**：HITL 确认前变更预览（edit diff / write 行数 / delete 路径，不读文件）；待确认弹窗显示来源会话并可跳转，切会话按拒绝收口；会话内搜索（循环跳转、高亮）；聊天空态；任务 JSON 导出（`version: 1`）；智能体删除改应用内确认；导航 `aria-current`、会话标签按钮键盘可见、`line-soft` token 统一、Alt+1–8 提示校正。
20. **补齐上轮暂缓项（d.25）**：Registry **本地包（npm/pypi）**（不内置运行时→挂载即探测、缺什么直说、必须钉版本、Windows 上翻译为 `node npx-cli.js` 且恒定 `shell:false`、删除回收子进程）；**记忆召回**同主题时效覆盖 + MMR 去重名额（确定性、无学习权重、不加模型字段）；**通话逐路 ICE restart**（2 次预算、新信令 `voice_call_reconnect`、不重新响铃）；**应用内通知中心**（消息/任务收尾，去重、50 条上限、只存本机）；**弹窗骨架** `useModalA11y`（Esc 栈顶独占、焦点循环）+ 技能/接口/记忆/Wiki/HITL 规则等破坏性操作统一应用内确认；**模型能力降级提示**（判定与丢弃同源）；**任务模板**（名称+目标，填回输入框仍可编辑）；**消息多选导出**（与整会话导出同契约、纯本机 Blob）。文档见 `docs/superpowers/specs/2026-10-21-*.md` 三篇与审计文档 §2。
21. **图片 + 文字同发（d.25.1.7.0）**：输入框有正文时选文件 → 发**一条 `text + file` 消息**并当场触发；本轮附件不走历史，由 `TriggerDeps.buildUserTurn` 拼进当前 user 行（图片内容片 / 文档块），`fetchHistory` 按 `file.id` 去重；未绑定 LLM 的拦截提前到上传前；重试沿用本轮附件。能力闸、4 张 / 4MB 上限、E2E 不降级全部原样。文档见 `docs/superpowers/specs/2026-10-22-atomic-image-send.md`。
22. **弹窗屏蔽背景 + 焦点归还 + 工作区首帧状态（d.26.1.7.0）**：`useModalA11y` 补上「打开期间屏蔽背景、关闭后归还焦点」。因本仓弹窗**无 portal**，采用**遮罩根起的兄弟逐个 `inert`**（只挂 inert 不补 aria-hidden）、**模块级引用计数**支持嵌套、`data-a11y-keep` 保留常驻通话浮层可点、非模态浮层（通知中心）传 `blockBackground:false` 保住「点外面关」；焦点归还有条件（焦点确实丢失才还，不抢关闭方主动安排的焦点）。`loadWorkspace` 加 `workspaceReady`/`workspaceError`，HomePage 首帧未落地显示加载骨架、失败显示「加载失败 + 重试」，**后台刷新失败不推翻已就绪**。文档见 `docs/superpowers/specs/2026-10-22-modal-inert-and-workspace-state.md`。
23. **记忆召回的可观测性（d.27.1.7.0）**：把「召回 ≠ 注入」做成一等公民。新增注入旁路 `MemoryObservability`（`injected`／`dropped`+原因／`scores`／`superseded`／`counts`），**差集只在 `summarizeInjection` 算**（只有格式化层同时知道候选与注入清单，散到各 UI 写一遍偏一次）；`truncated`（注入了一半）与 `budget`（整条没进）分开，同键旧值单独标注「被覆盖，不是漏召回」。引用判定 `matchUsage` 是**字符串级词重合、零额外模型调用**（`USAGE_MIN_HITS=2`、单词需长到 3 字符、跳过工作层与 `focus`、比对**截断后**的文本；判据保守 ⇒ 界面只写「疑似引用」）。留档走**独立键** `heming.memory.recallLog.v1`（40 档／256KB／注入留 120 字／首档无条件保留，**不参与记忆导出**，也不污染 `selfAudit` 回滚时间线与任务区 `TaskRecord`）；`RecallRecorder` 用 `agentId::userText` 作键，把「两个钩子都拿不到 streamId」的两端接上，全程静默。记忆区：预览结论行 `召回 N 条 → 注入 M 条 · 预算占用 X/1200`、逐条带打分与状态、新增「召回记录」区（默认最近 3 档、明细可看引用与未注入原文、清除二次确认）、语义卡注脚「最近注入／疑似引用」。文档见 `docs/superpowers/specs/2026-10-22-memory-recall-observability.md`。

## 3. 仓库结构与关键文件

```
packages/
├── shared/src/schemas.ts       # 协议单一真源：Message（enc/cipher/chainKid/n/recalledAt）、
│                               #   MessagePayload（text/mentions/file/forward/reactions）、WS 事件
├── server/src/
│   ├── app.ts                  # REST：auth/profile/agents/conversations/files/archive/e2e/ice-servers
│   ├── ws.ts                   # send_message/recall/agent_chunk|finish|error/voice_call_*
│   ├── store.ts + sqliteStore.ts  # Store 双实现（契约测试双跑）
│   └── db.ts                   # CREATE TABLE IF NOT EXISTS + 幂等 ALTER 迁移
├── web/src/
│   ├── lib/e2eCrypto.ts / e2eSession.ts      # E2E 密码核心与会话层
│   ├── lib/agentStream.ts                     # @ 触发编排；工具轮 + HITL 唯一接线点
│   ├── lib/hitl/                              # 分类/策略/闸门/文案/审计（纯逻辑）
│   ├── lib/mcp/                               # HTTP/stdio 客户端、注册表、桥、预置、自动连接
│   ├── lib/registry/                          # Registry 数据层 + 安装预览/请求头校验
│   ├── lib/memory/                            # 三层记忆、召回、复盘、存储
│   ├── lib/skills/                            # 技能池、内置技能、路由、分配
│   ├── lib/agentContext/                      # token 预算、历史切分、摘要
│   ├── lib/selfEdit/                          # self_* 工具与护栏
│   ├── lib/tasks/ export/                     # 任务记录与报告、会话导出格式化
│   ├── lib/charts/ tone/ wiki/ docs/          # 图表、去 AI 味、Wiki、文档解析
│   ├── store/{chat,ui,llm,auth,tokenUsage,hitl,registry}.ts
│   └── components/                            # ChatPage、HomePage、SettingsPage、SkillsPage、
│                                              #   MemoryPage、InterfacesPage、RegistryPage、
│                                              #   RegistryInstallCard、ArchivePage、WikiPanel、
│                                              #   ToolApprovalModal、ConfirmDialog、AgentStreamBubble 等
└── desktop/                    # Electron 壳
    ├── main.js                 # 窗口、菜单、导航白名单、splash、协议注册
    ├── app-protocol.js         # app:// 资源解析（路径穿越防护/MIME/SPA 回落）
    ├── secure-origins.js       # HTTP 源安全上下文白名单
    ├── mcp-stdio.js            # stdio MCP 桥（spawn shell:false、JSON-RPC 配对、可执行文件解析）
    ├── local-runtime.js        # 本机 npm/pypi 运行时探测 + 逻辑命令翻译（node npx-cli.js / uvx）
    ├── auto-update.js          # electron-updater 接线
    ├── bundled-runtime.js      # 内置运行时探测
    ├── wiki-fs.js / chart-fs.js # Wiki 与图表文件桥
    ├── call-window.js          # 独立通话窗口
    ├── title-bar.js splash-*.js preload.js
    └── web-dist/               # 嵌入 web 产物（gitignored，由 scripts/build-desktop-web.mjs 生成）

deploy/                         # 裸机部署（云端已去 Docker，见 docs/deploy.md §1–§3）
    ├── provision.sh            # 一次性装机：apt/swap/Node24+pnpm/账号目录/api.env
    ├── install-app.sh          # 每次发版：存档→解包校验→装生产依赖→nginx+systemd→自检
    ├── nginx-heming.conf       # 宿主站点：静态页 + /api 反代 + = /api/ws + /updates/
    └── heming-api.service      # systemd 单元：User=heming，只写 /var/lib/heming
```

**本机存储键**（localStorage，除 Wiki 文件）：`heming.token` · `heming.llmConfigs` · `heming.agentLlm` · `heming.agentPrompts` · `heming.tokenUsage` · `heming.e2e.*` · `heming.msgCache.*` · `heming.memory.*` · `heming.skills` · `heming.skillAssignments.v1` · `heming.context*` · `heming.hitl.v1` · `heming.mcp.servers.v1` · `heming.mcpRegistry.v1` · `heming.selfEdit.v1` · `heming.kb.v1` · `heming.tasks.v1` · `heming.taskTemplates.v1` · `heming.notifications.v1`。
Wiki 在桌面端写 `~/Heming/wiki/`（`wiki-fs.js`），图表导出写 `~/Heming/charts/`。

## 4. 工作方式约定

- **文档驱动**：先写设计规格（`docs/superpowers/specs/`）与实施计划（`docs/superpowers/plans/`），再动手。
- **子代理驱动执行**（superpowers:subagent-driven-development）：每任务一个实现者 → 任务评审（规格+质量）→ 修复轮（≤5）→ 整分支终审 → 合并。账本在 `.superpowers/sdd/<plan>/`（gitignored）。
- **测试门禁**：`pnpm -r build && pnpm -r --workspace-concurrency=1 test` 全绿才提交；shared 改契约后先 `pnpm --filter @heming/shared build`。web 测试串行跑（`--no-file-parallelism`），默认并发会少跑文件；server 与 web 并发时 Windows 上偶发原生崩溃（`0xC0000409`），串行稳定。
- **版本门禁**：每次修改/修复/重构都要 bump；`node scripts/bump-version.mjs auto <fix|feature|breaking|build>` 一次同步五个 `package.json`；补 CHANGELOG 后跑 `node scripts/build-changelog.mjs`。版本号只增不减。
- **视觉规范**：无 emoji 图标（细线 SVG 1.5px，emoji 仅作消息内容）；分割线浅灰 `#e6e6e6`/`#ececec`；界面 chrome 不显示产品名「和鸣」；中文文案。
- **`skipLibCheck: true` 的坑**：`.d.ts` 内重复/冲突声明会被静默跳过。新增 `declare global` / `interface Window` 前先 `grep -rn "interface Window" packages/web/src`；怀疑类型问题时用 `tsc -p packages/web/tsconfig.json --noEmit --skipLibCheck false` 复验。
- **部署流程**：见 `docs/deploy.md`；**云端已去 Docker**（裸机 nginx + systemd + node，脚本在 `deploy/`）。**本地产物随包上传，云端零构建**：`pnpm -r build` 出 `packages/{web,shared,server}/dist` → tar（排除 node_modules/.git/.superpowers/.worktrees/data/release/.claude/.tmp/.workbuddy/packages/desktop/{runtime,web-dist}，**没有裸 `--exclude=dist`**，dist 这次是要传的）→ `.superpowers/deploy-bare.py` 的 `upload → provision → install`。`deploy/**` 必须 LF（`.gitattributes` 已钉）。SSH 脚本在 `.superpowers/*.py`（gitignored，含凭据）。
- **发布是两处**：云端（浏览器）与桌面端（嵌入产物随安装包）。只发一处会出现新旧界面并存；桌面端之后由自动更新分发。
- **并行会话**：本项目多个会话并行，共用 `D:\Heming` 主检出并直接提交 main。改共享文件前先 `git status` + 看目标文件是否有在途改动；小步提交，别把改动长时间留在工作区。

## 5. 下一步候选

**当前直接待办**：

1. **备份纪律已经落成脚本，但要每次真跑**：`deploy-bare.py backup` 做「停服 → tar → 起服 → SFTP 拷回本机 `.tmp/backups/` → 本机文件非空 + `/api/health` 复核」，d.25.1.7.0 发版前已实跑（3.7KB，含 `heming.db` 与 `-wal`）。剩下的不是开发项，是操作纪律：**没把库拷回本机就不许 install**（`docs/deploy.md` §6）。
2. **弹窗屏蔽背景的读屏软件实测**：`inert` 屏蔽、焦点归还、非模态退出、首帧骨架与失败重试条**都已在真实 Chromium 里实测通过**（证据见 `docs/superpowers/specs/2026-10-22-modal-inert-and-workspace-state.md` §5：弹窗开着时对背景按钮调 `.focus()` 焦点不动）。**只剩 NVDA / VoiceOver 那一层**——需要装读屏的机器，属验证项不属实现项。
3. **语音重连的真机验证**：状态机与信令有单测，缺弱网 / TURN 环境证据。新裸机上 `HEMING_TURN_*` 尚未配置，群通话只有 STUN 路径可验。
4. **记忆个性化权重（可观测性已在 d.27 落地）**：归因链路已有（注入清单 + 打分 + 疑似引用 + 本机留档），下一步是在此之上调权重/淘汰策略。**前提仍是确定性规则**——`USAGE_MIN_HITS` 这类判据可以调，但不要变成「问模型你用了哪条」。已知边界：疑似引用只看最终回答正文（工具调用里引用了但没复述的不算）；旁路按 `agentId::userText` 配对，同智能体同一句在两处同时在飞会串档（要严格化需等钩子带上 streamId）。
5. **`release/win-unpacked/resources/app.asar` 打不开**：`dist:desktop` 连续两次 `EBUSY`（文件被某进程占住，`openfiles` 查不到持有者、树内无相关进程）。根因仍未查，**绕过方式已固化成惯例**：每版换一个新的输出目录（r25 → r26 打 d.25.1.7.0 → r27 打 d.26.1.7.0 → **r28 打 d.27.1.7.0，均一次通过**），下次继续递增目录（**d.28 用 `release/r29`**）；打包与发布两处都要指同一目录（`HEMING_RELEASE_DIR`，`build-desktop.mjs` 与 `publish-update.sh` 都读它）。
6. **`docker/` 与 `docker-compose.yml` 已停用但未清理**：机器已重置且没装 Docker，发版走 `deploy/`。两处 nginx 配置仍互为出处（`/updates/` 顺序、WS 的 `= /api/ws`），要清理就一起清，见 `docs/deploy.md` §11。

**二期主线**：

1. **模型能力矩阵补全**：`supportsKind` 已驱动工具/图片的降级提示与实际丢弃；仍缺「思考/长上下文/函数并行」等维度与定价校准。
2. **本地包的安装体验**：探测与翻译链已落；剩下是运行时补全目录清单（装在非常规路径仍可能探不到）、可选的「一键检查/修复」引导，以及包更新（现在钉死版本、不自动跟进）。
3. **harness 桥接**：本机 CLI 探测 + `spawn(shell:false)` + Windows 进程树清理 + 危险命令三层围栏。
4. **Token 团队视图 / 按日期跨端汇总**：需服务端汇总。
5. **群管理**：成员删减/踢人 UI、群主权限。
6. **多模型同题对比**：竞品调研中价值较高、改动集中；对话导出与 LaTeX 已在 d.23 落地。

## 6. 技术债与已知风险

- **Registry**：发现页与安装流已接线（接口区二级面板）；本地包（npm/pypi）**已支持但需本机运行时**（不内置：探测缺 Node/uv 就标「缺运行时」，浏览器标「需桌面版」），oci/nuget/mcpb 仍显式不支持；包名走字符白名单、**必须有钉死版本**、`packageArguments`/`environmentVariables` 一律丢弃；安装确认**始终询问**且不提供「本次会话都允许」；列表缓存在 `heming.mcpRegistry.v1`（6h TTL），离线降级并标注 stale；台账字段 `registryType`/`registryVersion` 只作账本不作执行输入；删除 stdio 服务会调 `stopStdioServer` 回收子进程。
- **HITL**：没有“全部放行”档（刻意）；`annotations` 不参与判定（untrusted hint）；闸门异常按 deny；会话授权只在内存。规则记忆已落盘（deny 优先、danger 不记允许），新规则按智能体隔离、旧规则保持全局；规则不跨设备跟随，ChatPage 接线层已有拒绝/异常路径断言。确认前预览只读调用参数、不读目标文件；切换会话取消待确认按拒绝收口。
- **会话导出**：只导出已加载且本机可解密的消息；换设备/清缓存后旧消息解不开会被跳过；附件只带元信息，不导出字节；不支持 PDF 或分享链接（避免明文上云）。
- **视觉附件**：历史图片与**本轮同发的图片**都进提示词（同发不再依赖 WS 回声时机）；一次最多 4 张历史图 + 本轮 1 张、单张 ≤4MB。图片解密依赖本地 E2E 密钥，换设备/清缓存后旧图读不到。空草稿单发附件仍不触发生成（刻意）。
- **Anthropic 不支持工具调用**：消息结构（content blocks）与 OpenAI 不同，绑 Anthropic 的智能体用不了 MCP/图表/self 工具。
- **语音通话**：**断线重连已做**（逐路 ICE restart，`RECONNECT_MAX_RESTARTS=2`、`disconnected` 先观察 3s、新信令 `voice_call_reconnect`、状态仍是 active 加路数提示）；★ **真机弱网与 TURN 环境仍未验证**，预算数字是工程判断不是测量结果；群通话任一路彻底断开即整通结束（刻意）；通话中邀请新成员、群成员在线状态等未做；`GET /api/ice-servers` 无鉴权，配置 TURN 时凭据对未登录者可读。
- **弹窗无障碍**：`useModalA11y` 覆盖 Esc（嵌套栈顶独占）、焦点循环、打开即聚焦、**打开期间屏蔽背景**（无 portal ⇒ 遮罩根起的兄弟逐个 `inert` + 模块级引用计数支持嵌套 + `data-a11y-keep` 保留常驻通话浮层 + 非模态浮层 `blockBackground:false`）、**关闭后焦点归还触发元素**（只在焦点确实丢失时还）。真实 Chromium 已实测：弹窗开着时对背景按钮 `.focus()` 焦点不动、Esc 后 `inert` 归零且焦点回到触发按钮、通知中心背景仍可点。★ **未做 portal 改造**（要动 10 个挂载点与 z-index 继承，收益不抵风险）；★ **NVDA/VoiceOver 仍未验**（要装读屏的机器）。弹窗打开时全局快捷键（`Alt+1–8`、`Ctrl+\`）仍生效——`inert` 不拦 JS 事件，与本特性正交、另议。
- **主页首帧**：`workspaceReady`/`workspaceError` 只管**首帧**，加载骨架与失败重试条已上屏并在真实浏览器里验过（拖住接口看到骨架、500 看到「加载失败：原因」+ 重试、重试后回正常空态）；后台刷新失败刻意不推翻已就绪（已验：切页触发失败也不塌）。智能体动态一栏的数据来自 `loadAgentsRoster`，不共用这套口径。
- **通知中心**：只做应用内（`heming.notifications.v1`，50 条 / 64KB 上限、无 TTL）；系统通知权限、免打扰、跨窗口聚合未做；HITL 待确认**不产生通知**，仍只在确认弹窗里等裁决。
- **召回可观测性**：注入旁路与召回日志都只在本机（`heming.memory.recallLog.v1`，40 档 / 256KB，**不参与记忆导出**）。「疑似引用」是提示层与回答层的**词重合指标，不是因果证明**：只看最终回答正文（工具调用里用了但没复述就不算），判据保守（宁漏报不误报），界面措辞固定为「疑似引用」。零注入的轮次不留档；`capture`/`settle` 任何异常都只是「这一档没记上」，绝不影响发送与流式。配对键是 `agentId::userText`（两个钩子都拿不到 streamId），同一智能体在两处同时在飞同一句话会串档——刻意接受的低概率代价。打分只展示数值，未拆「重合度／衰减／置信度」三项归因。
- **分发**：自动更新源是 HTTP（清单有 sha512，但首次安装包可被篡改）；无 CSP；未用 Electron `safeStorage` 加密落盘密钥；网页端未 HTTPS 化。
- **数据边界**：记忆/技能/HITL 策略只在本机，换设备不跟随；新入群成员只能解密加入之后的消息。
- **启动动画/标题栏**：逻辑与 DOM 已验，观感仍需真机过目；`WAVE_MS` 在 web 与 desktop 各写一份，无跨包断言。
- **测试口径**：安全功能的测试要看断言方向，不只“全绿”；历史上有过把 `readOnlyHint:true` 的 `delete_file` 断言成 `read` 的漏洞。

## 7. 快速上手命令

```bash
node scripts/version.mjs                                   # 当前版本 / 最近条目 / 安装包
pnpm -r build && pnpm -r --workspace-concurrency=1 test    # 全量门禁（串行稳定）
pnpm --filter @heming/server dev                           # 云端服务端 :8787
pnpm --filter @heming/web dev                              # 前端 :5173
HEMING_DEV_URL=http://localhost:5173 pnpm --filter @heming/desktop dev
pnpm -w run dist:desktop                                   # 构建嵌入 web + 打安装包
node scripts/bump-version.mjs auto fix                     # 修 bug / 小改
node scripts/build-changelog.mjs                           # 同步设置区更新日志
```

线上验证：`curl -s http://47.92.39.184/api/health`；登录 `POST /api/auth/login {"username":"admin","password":"admin"}`。
