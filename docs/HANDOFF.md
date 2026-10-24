# 和鸣 · 新会话交接文档

- 日期：2026-10-24
- 当前版本：`d.35.1.9.0`
- 当前 main：以 `git log -1` 为准（`a27ce40` 深度调研与分轮计划 → `b5a1348` d.30 四条红线口子 + 三处静默降级 → `793f608` d.30 两处发布收口 → 本轮 d.35.1.9.0 体验修补）
- 本文用途：给新开的协作会话快速接手——现状、约定、红线、下一步

---

## 1. 项目是什么

**和鸣**：原生桌面端（Electron）智能体应用平台 = 云端服务器（IM 即时通讯 + 智能体名册）+ 桌面/网页客户端。
定位：个人智能体工作台——与人类/智能体聊天协作，管理模型接口、工具接口与记忆知识库。

- **架构红线（不可违背）**：智能体**本地驱动**（本机系统提示词 + 本机 LLM Key 直连供应商 + 本机执行），云端**只是 IM 桥梁**；个人数据（Key/记忆/知识库/本地文件）**不出设备**。
- **E2E 红线**：消息与附件端到端加密，服务端只见信封；无安全上下文时**拒绝发送，绝不降级明文**。
- 参考项目：`D:\MultiAgent`（合鸣 Ensemble）——借鉴架构，不复用代码；调研见 `docs/superpowers/research/2026-10-17-multiagent-study.md`。
- 文档总入口：`docs/INDEX.md`；竞品与许可证调研：`docs/research/2026-10-20-competitive-analysis-v2.md`；同功能异同与优化建议：`docs/research/2026-10-21-feature-parity-and-optimization.md`；缺口清单：`docs/research/2026-10-21-gap-closure.md`、`docs/research/2026-10-21-all-feature-gap-audit.md`；**深度调研与分轮完善计划（含逐条 `file:line` 证据）：`docs/research/2026-10-22-deep-audit-followup-plan.md`**。

## 2. 当前状态

| 项 | 状态 |
|---|---|
| 版本 | `d.35.1.9.0`（5 段，五包同步；**修订位 +1**：全量门禁后的体感修补，不新增产品能力，按 `docs/VERSION-MANAGEMENT.md`「只有修复/小改 → 修订位 +1」走；**d.36 仍留给 P0-5 `safeStorage`**） |
| main | `4107935`/`d5dbdca`（本地构建产物 + 裸机部署）→ `94e6d77`（d.25.1.7.0 收口）→ `3956d23`（d.26.1.7.0 弹窗屏蔽背景 + 焦点归还）→ `915d19c`（d.27.1.7.0 召回可观测性）→ `9e27d5e`（d.28.1.7.0 个性化权重）→ `7d13525`/`08285f4`（d.29.1.7.0 冷清单覆盖面与计数一致性）→ `df85bbb`（d.29.1.8.0 模态门禁）→ `a27ce40`（深度调研与分轮计划）→ `b5a1348`（d.30.1.8.0 四条红线口子 + 三处静默降级）→ `793f608`（d.30 两处发布收口）→ `285beae`（d.31.1.8.0 本机存储水位 + 草稿持久）→ `348e283`（d.31 收口）→ `9369707`（d.32.1.8.0 token 用量埋点 + 能力矩阵）→ `51aa1fe`（d.32 收口）→ `6927d5f`（d.33.1.8.0 消息列表窗口化）→ `7b19179`（d.33 收口）→ `8c4e469`（d.34.1.8.0 HITL 待确认进通知）→ `c628bc6`（d.34 收口）→ `a834849`（d.35.1.8.0 wiki 中文检索 / 任务淘汰 / 导出落盘）→ `0e293f3`（d.35 发布收口）→ 本轮 d.35.1.9.0 体验修补 |
| 测试 | 2026-10-24 实跑（d.35.1.9.0 门禁，`pnpm -r build` + 分包串行 `test`，五个包全部 exit 0）：**shared 2 文件 / 79 例，server 9 文件 / 219 例，web 119 文件 / 1953 例，desktop 20 个 `node --test` 文件 / 260 例**。本轮 +55：聊天三态/滚动/时间/复制/图片/粘贴上传、设置页反馈、导航未读与命令面板，另有 `HitlPolicyStore.grantCount()` 与重试草稿边界用例 |
| 线上 | **线上仍是 `d.35.1.8.0`（2026-10-23 21:51 部署，裸机、云端零构建）；本轮 `d.35.1.9.0` 尚未部署**。发版前备份已拷回本机 `.tmp/backups/heming-data-2026-10-23-d35.tar.gz`；部署包 `/tmp/heming.tar.gz` 5709881 字节 → 远端 `/root/heming-d.35.1.8.0.tar.gz` 同大小、MD5 逐字一致（`6d937accff2874bcfdac4a85837a9681`）；`/root/install.log` 尾部 `INSTALL DONE: d.35.1.8.0`，`/api/health` `{"ok":true}`。**最硬的一条证据**：`curl` 下来的线上主 bundle `assets/index-H3ErDykH.js` 与本机 `pnpm --filter @heming/web build` 产物 **md5 相同**（`4f865db50d72196ae8bf9836b91e60bf`）。打完桌面包已重跑该命令把本机 `packages/web/dist` 恢复成云端口径，避免下一轮误传注入版 |
| 安装包 | **已发布的是 `和鸣 Setup d.35.1.8.0.exe`（178871235 字节，`release/r38/`）**：`openssl dgst -sha512 -binary` 转 base64 与 `latest.yml` 顶层 `sha512` 逐字一致（`hY7oCrMxdUGmXr1O…`），`size` 与实际字节相符；远端 Range 请求 206。内嵌产物是注入 `VITE_API_BASE` 的那份（`resources/web/assets/index-0Cz9nWnA.js`，与云端 `index-H3ErDykH.js` **文件名不同**——正是「两处产物来源不同」的预期形态）；内嵌 bundle 内 `d.35.1.8.0` 命中 1 次、`47.92.39.184` 命中 2 次（云端 1 次）。★ 本轮另在 `release/r39/` 重打过一份 d.35.1.8.0（sha512 `ISd4RWUx…`），并在 `release/r40/` 打出 **`和鸣 Setup d.35.1.9.0.exe`（178876007 字节，sha512 `U41dAUqL…`，与 `latest.yml` 逐字一致）**；r39/r40 **均只本地留档、未上传**。打完包已重跑 `pnpm --filter @heming/web build` 把本机 `web/dist` 恢复成云端口径（当前 `index-YhZskpbS.js`） |
| 自动更新源 | `http://47.92.39.184/updates/latest.yml` → 200 + `application/octet-stream` + 352 字节（不是 HTML 回落），当前指向 `35.1.8`（**本轮 d.35.1.9.0 尚未上传**）；`/opt/heming/updates/` 现有 d.25.1.6.0 至 d.35.1.8.0 共 13 版安装包 + 13 份 blockmap + `latest.yml`（回滚依赖旧包，别删） |
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
24. **记忆个性化权重（d.28.1.7.0）**：把 d.27 的归因从「看得见」变成「有用」——被引用过的记忆排前面，长期没被引用的列出来给人删。账本走**独立键** `heming.memory.usage.v1`（不挂召回日志：日志是环形 40 档，聊多了滚掉会让权重「无故变差」），按条目 id 累加 `注入/疑似引用`，**一档只计一次**、跳过工作层与 `focus`、`used` 夹在 `[0, injected]`、400 条容量按 `lastAt` 淘汰最旧、64KB 护栏、坏 JSON 回退空表、**不参与记忆导出**。因子 `1 + 25% × used/(used+3)`：**只提权不降权**（降权等于系统替用户判定这条没用，而判据只是词重合、偏保守），平滑项 + 封顶防「热门通吃」。接口 `UsageView { boostOf(id) }` 把公式与排序解耦，缺省 `NEUTRAL_USAGE` ⇒ 与 d.27 **逐字相同**（用例钉死 deep-equal）；`MemoryObservability.boosts` 只收 `>1`。接线：`RecallRecorder.settle` 只有日志真落盘才累加（同进同退，绝不留「有权重无档案」），ChatPage/记忆页预览共用同一份账本，删记忆 `forgetUsage`、清记录日志与账本同清。UI：语义/情景卡注脚 `累计注入 6 次 · 疑似引用 6 次 · 个性化加权 ×1.1667`（没计数整行不出现，不显示「×1」），预览逐行标乘子，新增「长期未被引用」清单（注入 ≥6 且引用 0，**只列不自动淘汰**）。文档见 `docs/superpowers/specs/2026-10-22-memory-personalization-weights.md`。
25. **冷清单覆盖面 + 计数一致性（d.29.1.7.0）**：d.28 的「长期未被引用」只看公用桶，而召回读的是「全局桶 + 该智能体私有」，情景条目一条都没列——最该被看见的两类条目恰好看不见。清单输入换成 `layers.semantic` + `layers.episodic`，**按注入次数降序**（给人逐条删，「挡了多少预算」是唯一有用的排序依据），每行标层名与归属，删除复用既有两条确认流、不新造口径；判据与「不自动降权不自动删」一字未动。同时修掉一处会咬人的不一致：**删情景条目原先不清用量账本**，孤儿 id 白占 400 条容量、把还在用的有效计数挤掉（表现为权重无故退回 ×1 且无法解释），现在与删语义条目同口径 `forgetUsage`。顺带清理发布后自检的三处技术债（无人调用的账本单例、恒真的二次 `score > 0` 过滤、两条早退共享同一个空结果对象）。新增 3 例，记忆链路 11 文件 207 例。文档见 `docs/superpowers/specs/2026-10-22-cold-memory-coverage.md`。
26. **模态门禁：弹窗开着时全局快捷键不再穿透（d.29.1.8.0）**：d.26 留下的那条「`inert` 不拦 JS 事件、另议」补上了——确认框开着按 `Alt+3` 照样换页面，弹窗留在已不是当前视图的子树里，`inert` 计数、Esc 归属、焦点归还全落在悬空 DOM 上；`Ctrl+K` 更糟，命令面板渲染在 App 根，一开就把弹窗整棵子树冻住而弹窗自己不知道。判据不加新状态：`useModalA11y` 的 `openDialogs` 条目补记 `modal`（取 `blockBackground`），导出 `hasOpenModal()`，存活判定与 `topToken` 逐字一致；非模态浮层（通知抽屉）与 `active:false` 的常驻弹窗都不算，语音通话浮层没走这个 hook、通话中照常切页。只拦 `Alt+1–8` 与 `Ctrl/⌘+K` 两处 window 级监听，吞键仍 `preventDefault`，输入框内的早退口径不变。新增 3 例（钩子 2 + App 真实链路 1）。文档见 `docs/superpowers/specs/2026-10-22-modal-shortcut-gate.md`。
27. **四条红线口子 + 三处静默降级（d.30.1.8.0）**：上一轮的四路勘察把红线的**实现完整度**摊在桌面上——四条红线里前三条在代码里都有**可绕开的口子**，红线的表述没骗人，但 UI 与传输细节让红线打了折扣。**① HITL「免问下限」的全放行口子**：下拉框能选到 `danger`，而判定式 `RISK_ORDER[risk] <= RISK_ORDER[floor]` 使 `floor=danger` 时**所有档位恒真** = 一个设置页里的「全部放行」；**读侧也夹**（只删 UI 不够，旧 localStorage 里的 `danger` 仍会放行），夹成 `write` 而非默认值 `read`——回落 `read` 会把用户「少被打扰」的偏好悄悄改严，`write` 是该字段能表达的最宽安全值（`danger` 严格高于 `write` ⇒ 恒要问），「危险恒问」不需要第四个下限值。**② `/api/ice-servers` 无鉴权**：加 `authOnly`；ICE 改由**渲染层自取**（渲染层本就有 token，`api()` 已带 Bearer 头），桌面主进程那段裸 fetch **整段删掉**——要让主进程继续工作就得把 token 搬进主进程，那是新增的暴露面。**③ WS 的 token 走 query**（会进 nginx access_log）：改**首帧鉴权** `{type:"auth",token}`，服务端认了才登记连接；「未鉴权收不到任何业务事件」是**结构性**保证（未鉴权 socket 从未进 `socketsByUser`，广播只遍历它）；服务端**仍兼容** `?token=`（旧桌面包已发布，不能因服务端升级断链），该路径待所有在网客户端升级后再删；nginx 给 `= /api/ws` 加 `access_log off`。**④ 桌面端零崩溃兜底**：新增 `crash-log.js`，`uncaughtException`/`unhandledRejection` 落 `~/Heming/logs/`，渲染进程崩溃**自动重载一次**（只一次，防崩溃循环刷爆机器）；**只写本机不上报**（崩溃日志常混着用户输入片段，上报等于把个人数据送出设备），处理器显式 `exit(1)` 还原 Node 默认语义。**⑤ 三处静默降级**：记忆 `updatedAt` 拆成内容时间与 `metaUpdatedAt`（改个错别字不该让这条记忆在系统眼里「刚刚更新过」，否则 recency 满血、冷门判定失效；旧数据以 `updatedAt` 顶替不迁移）；沉淀节奏计数落盘到独立键 `heming.memory.pending.v1`（以前只在内存，刷新即归零 ⇒ 长会话永远攒不满一次沉淀）；WS 离线队列加 100 帧/4MB 双上限（溢出丢最旧并**显式报错**，不静默丢），无 token 时 `send` 直接报错不入队（排队等于假装帧还在路上）且安排退避重试（不再是「只进不出」的死状态）。新增 34 例，全量门禁 web 1772 / server 219 / shared 79 / desktop 247 全绿；**三条护栏都做了变异验证**（把 `danger` 塞回 `FLOORS` / 改回无条件刷 `updatedAt` / 去掉服务端 `authed` 检查，各自立刻红）。文档见 `docs/superpowers/specs/2026-10-22-d30-security-redlines-and-silent-degradation.md`。
28. **本机存储水位 + 草稿持久（d.31.1.8.0）**：解决「用户看得见的东西消失了，但没人告诉他为什么」。**① 水位可见**：设置区新增「本机存储」卡，遍历 `localStorage` 逐键算 UTF-8 字节数、**按模块分组**（分组是为了让人知道**是哪儿占的**——总数只能说「快满了」，分组能说「是任务记录占的」）；≥80% 变黄、≥95% 变红；配额默认用 5MB 保守估计并标注「估算」，点「重新检测」才**实测**（实测要写满几 MB，绝不自动跑）；只给**可再生**的两类清理入口（明文缓存、任务记录，都要二次确认），**不可再生的（记忆条目、E2E 私钥与棘轮）不提供入口并在界面写明理由**。统计口径**单一真源在 `lib/storageUsage.ts`**（模块前缀表曾在组件里另抄一份并已分岔——通知该归哪组、`memory.usage` 算记忆还是账本；已合并，界面只负责排版）。**② `msgCache` 会话数 LRU**：每会话 500 条原本有上限但**会话数不设上限** ⇒ N 个会话就是 N×500 条，是全仓最大的无上限块；现保留最近 **20 个会话**，按「最后使用时间」淘汰最久未打开的整份缓存，淘汰只删缓存不删消息（服务端重新拉即可）。`list` 是热路径（每个信封都调），账本写盘走 60s 节流、`append` 立即写。**③ 草稿按会话持久**：`ChatPage` 常驻（切会话不卸载）导致草稿串会话 + 刷新全丢；改按 `heming.draft.<convId>` 存（值带 `at`，不另起索引键），LRU 20 个会话、单条截尾 2000 字（按码点切，不劈 emoji），写盘 300ms 节流但切会话/发送/卸载立即落盘，发送成功即清。新增 52 例，全量门禁 web 1824 / server 219 / shared 79 / desktop 247 全绿。文档见 `docs/superpowers/specs/2026-10-22-d31-storage-budget-and-drafts.md`。
29. **Token 用量埋点 + 能力矩阵补维（d.32.1.8.0）**：一个「假确定性」、一个「知道得太少」。**① 用量有数据源了**：首页 30 天热力图与本月配额一直在展示 token 用量，而 `useTokenUsageStore.record()` 在生产代码里**一次都没被调用**——界面把空数据当事实呈现。现在从供应商响应回填：OpenAI 兼容走流式尾包的 `usage`（请求带 `stream_options.include_usage`），Anthropic 走 `message_start`/`message_delta` 合并；**兼容阀门**是首次带上该参数、遇 **400 自动关掉重试一次**（部分第三方网关不认它），退化成「没有用量」而不是「聊天坏掉」。一次运行可能有多轮工具调用 ⇒ usage **累加后只记一次**；失败/中止不记录。★ **拿不到就标「未上报」，绝不落 0**：记录形状是 `tokens: number \| null`，`null` 表示供应商没给用量，界面因此能区分「真的用了 0」与「没数据」——首页写「今日用量未上报」、热力图那格写「未上报」、配额卡补「N 轮未上报」。**② 能力矩阵补两维**：`supportsParallelTools` / `supportsStructuredOutput`，长上下文用窗口**派生**（≥128K，不另存布尔——窗口已是唯一事实源）；`capabilityBadges` 去掉 emoji（原本违反本仓无 emoji 规范）改为纯中文标签。★ 如实标注：**只有工具与视觉两维驱动行为**（走 `capabilityNotice` 的「判定 → 丢弃」），其余四维是**选型参考**——`buildRequest` 从不发 `parallel_tool_calls`/`response_format`，不会假装丢弃了什么。新增 23 例，全量门禁 web 1847 / server 219 / shared 79 / desktop 247 全绿。文档见 `docs/superpowers/specs/2026-10-23-d32-token-usage-and-capability-matrix.md`。
30. **消息列表窗口化（d.33.1.8.0）**：消息区原来是全量 `map` 渲染——800 条消息就挂 800 个气泡（每条还带引用卡、chips、图表解析与 Markdown），首屏开销随会话长度线性增长。本轮做**轻量窗口化、不引第三方依赖**：默认渲染最近 **60 条**，滚到距顶部 80px 内自动追加 60 条；顶部另给「加载更早的消息」显式入口（触控板/滚轮在部分设备上不可靠）。三个关键细节：**① 滚动位置补偿**（追加的内容在上方长出来，`scrollTop` 同步加回新增高度，用 `useLayoutEffect` 在绘制前完成，正在读的那段不跳走）；**② 搜索能跳窗口外**（命中比当前窗口更早的消息时先扩窗到包含它，渲染出来再滚——否则 `getElementById` 拿不到节点）；**③ 窗口只增不减**（往上翻过的历史不因新消息到达被收回），切会话复位。**不改**消息行的 DOM 结构与 `msg-<id>` 锚点，搜索/多选/引用/已读回执全部照旧；**不做**真正的虚拟列表（高度不定，改每行容器风险不抵收益）。测试主判据是**渲染节点数**而非耗时（vitest 计时不稳定），另加粗粒度冒烟。新增 18 例，全量门禁 web 1865 / server 219 / shared 79 / desktop 247 全绿。文档见 `docs/superpowers/specs/2026-10-23-d33-message-windowing.md`。
31. **HITL 待确认进通知 + 不再「切会话 = 拒绝」（d.34.1.8.0）**：两件都发生在「用户没看见」时系统替他做了决定。**① 切会话不再自动拒绝**：以前切走会话，原会话的待确认工具调用被直接收口成「全部拒绝」——用户只是看了眼别的会话，回来发现工具没执行、模型收到「被拒绝」，而他本人从没点过按钮。现在待确认**跨会话保持**（弹窗继续显示并标注来源），切回来裁决还在等它；这不是放行——裁决到达前工具不执行（闸门兜底方向一直是「不执行」），只是不再替用户做拒绝的决定。`cancelForConversation` 与其单测一并删除（无调用方）。**② 待确认进通知中心**：新增 `kind:"approval"`，请求**不属于当前会话**时推一条「XX 请求调用工具」，点开跳回来源会话；当前会话的请求不推（弹窗就在眼前）。裁决/超时后按 key 摘掉，免得点开一个已经结束的请求。**③ 超时 60 分钟**（此前全仓没有这个常量，计划里提到的「60 分钟队列口径」本轮落定）：自动按拒绝收口，**审计写明「超时未确认」**（与手动拒绝可区分），并推一条超时通知。用户点击与超时走**同一个收口函数**（写审计 → 清通知 → 决议），避免超时路径漏留痕。新增 4 例，全量门禁 web 1869 / server 219 / shared 79 / desktop 247 全绿。文档见 `docs/superpowers/specs/2026-10-23-d34-hitl-approval-notifications.md`。
32. **wiki 中文检索 / 任务淘汰护进行中 / 导出附块与文件落盘（d.35.1.8.0）**：三件都在数据侧「悄悄丢东西或找东西」。**① wiki 检索不再对中文退化**：原实现按空白切词后逐词 `includes`——中文没空格，「预算风险」在文档写作「预算与风险」时就是 0 命中。现在按空白/中英文标点切段，CJK 长词展开相邻**二元组**、覆盖率 ≥60% 算命中（整词优先），ASCII 查询逐字不变（回归用例锁死）；不引词典依赖，确定性契约不变。**② 任务淘汰不再挤掉进行中**：`pruneTasks` 改为返回 `{tasks, droppedRunning}`，只从已结束里淘汰；running 自己超额或字节超限且只剩 running 时才动它，且先推通知（`task-evicted:<id>`）再摘。淘汰**只筛选不重排**（曾把 running 提到前面导致列表顺序在落盘后跳动，已修）。**③ 记忆导出可附账本并落成文件**：新增 `exportBundle`（不勾与 `exportAll()` **逐字节一致**；勾选加顶层 `aux`，**导入不消费 aux**——只有一套导入语义）；新增桌面文件桥 `export-fs.js` 写 `~/Heming/exports/`（白名单 `\p{L}\p{N}-_. `、只收 `.json`、拒穿越）与 preload `__heming_exports`；浏览器回退 Blob 下载，两条路径都不上云。新增 42 例，全量门禁 web 1898 / server 219 / shared 79 / desktop 260 全绿。文档见 `docs/superpowers/specs/2026-10-23-d35-wiki-tasks-export.md`。
33. **全量自检后的体验修补（d.35.1.9.0）**：门禁全绿后补「用户当天就会撞到」的体感缺口，**不动安全红线**。**聊天页**：历史拉取失败不再伪装成空会话（骨架 / 「加载失败 + 重试」/ 真空态三态，`store` 加 `messagesLoading`/`messagesError`）；发送失败红色 `role="alert"` + 纯文本重试（不吞用户新草稿），手动中断不再显示 `AbortError`；滚动改为「贴底才跟随 + 上滑不拽底 + ↓ 新消息 + 切会话复位」；新增时间戳/日期分隔、整条复制、图片原图查看、粘贴截图/拖拽上传、上传中禁用与提示；Esc 停止生成、空草稿禁用发送、hover 操作条键盘可见、@ 选择器键盘导航；`read_update`/`message_new` 实时维护未读。**设置页**：提交中弹窗不可 Esc/遮罩关闭；清空会话授权二次确认 + 报数（`HitlPolicyStore.grantCount()` 公开只读口，替代反射读私有 Map）；技能操作常显 + 分组搜索；异步按钮 busy 禁用；存储探测先渲染再阻塞；保存/生效说明；删除确认统一红色；文本字形换细线 SVG；保留天数错误色；主题色输入受控。**导航**：通知面板向上展开；标签未读角标；登出二次确认；通讯录/归档失败重试与搜索空结果；导航轨搜索按钮 + 命令面板 Esc/「还有 N 条」。新增 55 例，全量门禁 web 1953 / server 219 / shared 79 / desktop 260 全绿。明确未做：真实 presence、`@我` 角标、undo、好友拒绝/群成员管理（均需单独规格）。文档见 `docs/superpowers/specs/2026-10-24-ux-polish.md`。

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

**总入口**：`docs/research/2026-10-22-deep-audit-followup-plan.md` —— 四路代码勘察 + 逐条复核后的分级清单（P0 红线口子 / P1 数据一致性与「空账」/ P2 体感 / P3 功能 / P4 工程发布链），每条带 `file:line` 证据、修法与验收形态，并给出 **d.30…d.36 的分轮范围**。下面 6 条是那份文档之外的操作纪律与验证项，不重复列计划内容。**d.30 已完成并两处发布**（P0-1…P0-4 + P1-3/P1-4/P1-8，见里程碑 27）。**d.31 已完成**（P1-1 的 ①② + P2-1，见里程碑 28；P1-1 的第 ③ 步「把最大块搬走」**仍未做**，见 §6）。**d.35 已完成**（P1-5/P1-6/P1-7，见里程碑 32）。**d.35.1.9.0 已完成全量自检后的体验修补**（聊天三态/滚动/常用操作、设置反馈、导航未读，见里程碑 33）；**d.36 的 `safeStorage` 规格与分轮安排不变**。

**后续轮次的规格已经写好，可以直接开工**：
- **d.36 = P0-5 `safeStorage`**：`docs/superpowers/specs/2026-10-23-d36-safestorage.md`
  —— 三把钥匙（`llmConfigs` / `mcp.servers` / `e2e.identity`）改成**就地信封**（密文仍放原键位）+
  **读时懒迁移**（幂等、失败保留明文并可见提示），桥用同步 `sendSync`（只在三个低频键上用）。
  ★ 规格里**明确不覆盖** `msgCache` 与 `e2e.chains`（热路径 + 棘轮状态，需要单独设计，列为 P0-5b）。
- **d.37 起**：`docs/research/2026-10-23-rounds-after-d36.md` —— CSP 基线（含「`connect-src` 要含用户自填
  `baseUrl`」「手工全流程验证不可省」）、`release.sh` 的十步顺序与证据回写方式、docker 清理的前置动作，
  以及**需要用户拍板的两项**（更新源 HTTPS+签名、好友/群管理涉及 E2E 群密钥重协商）。

**当前直接待办**：

1. **备份纪律已经落成脚本，但要每次真跑**：`deploy-bare.py backup` 做「停服 → tar → 起服 → SFTP 拷回本机 `.tmp/backups/` → 本机文件非空 + `/api/health` 复核」，**d.30.1.8.0 发版前已实跑**（3718 字节，22:28，含 `heming.db` 与 `-wal`；拷回后改名留档为 `heming-data-2026-10-22-d30.tar.gz`，md5 `073bb273b62082e4b6c51c22986ca3c1`）。剩下的不是开发项，是操作纪律：**没把库拷回本机就不许 install**（`docs/deploy.md` §6）。两个已修的坑：① 备份名按日期生成，**同一天二次发版会覆盖上一份**（d.28 实测：14:27 那份盖掉了上午的；**d.30 又踩到一次**——22:28 那份盖掉了上午 09:50 的，已改名留档），一天内要多发几版就在覆盖前手动改名留档；② 脚本原先用未 resolve 的 `__file__` 且少算一层 parent，**实际把备份落在 `.superpowers/.tmp/backups/`**，与 §6 写的 `.tmp/backups/` 不符（文件确实在本机，只是不在文档指的地方）——已改 `pathlib.Path(__file__).resolve()` + `parent.parent`，实测常量解析为 `D:\Heming\.tmp\backups`；d.28/d.29/d.30 三份已按原 md5 复制到 `.tmp/backups/`（现有 5 份）。
2. **弹窗屏蔽背景的读屏软件实测**：`inert` 屏蔽、焦点归还、非模态退出、首帧骨架与失败重试条**都已在真实 Chromium 里实测通过**（证据见 `docs/superpowers/specs/2026-10-22-modal-inert-and-workspace-state.md` §5：弹窗开着时对背景按钮调 `.focus()` 焦点不动）。**只剩 NVDA / VoiceOver 那一层**——需要装读屏的机器，属验证项不属实现项。
3. **语音重连的真机验证**：状态机与信令有单测，缺弱网 / TURN 环境证据。新裸机上 `HEMING_TURN_*` 尚未配置，群通话只有 STUN 路径可验。
4. **记忆个性化权重已落地（d.28.1.7.0）**：`heming.memory.usage.v1` 账本按条目累加「注入 / 疑似引用」次数，
   召回时乘 `1 + 25% × used/(used+3)` 的因子（**只提权不降权**、不传账本时与 d.27 逐字一致），
   记忆页给加权注脚、预览标 `· 加权 ×1.1667`、另列「长期未被引用」清单**由人删、不自动淘汰**。判据仍是确定性字符串统计，没有加任何模型调用。
   下一步空间（都要保持这个前提）：权重只作用于语义/情景两层，工作层不参与；`used` 只看最终回答正文，
   工具调用里引用了但没复述的不算（冷清单会误列）；上限 25%／平滑 3／冷门槛 6 次都是导出常量，**没有真机反馈前不调**；
   串档边界仍在（`agentId::userText` 配对，严格化要等钩子带上 streamId）。
   设计见 `docs/superpowers/specs/2026-10-22-memory-personalization-weights.md`；覆盖面与计数一致性在 d.29.1.7.0 补齐，见 `docs/superpowers/specs/2026-10-22-cold-memory-coverage.md`。
5. **`release/win-unpacked/resources/app.asar` 打不开**：`dist:desktop` 连续两次 `EBUSY`（文件被某进程占住，`openfiles` 查不到持有者、树内无相关进程）。根因仍未查，**绕过方式已固化成惯例**：每版换一个新的输出目录（r25 → r26 → r27 → r28 → r29 → r30 打 d.29.1.7.0，均一次通过；**r31 是 d.29.1.8.0 的一次废尝试**——单跑 `build-desktop.mjs` 嵌了旧前端、没发布就作废，r32 打 d.29.1.8.0、**r33 打 d.30.1.8.0，均一次通过**），下次继续递增目录（**d.31 用 `release/r34`**）；打包与发布两处都要指同一目录（`HEMING_RELEASE_DIR`，`build-desktop.mjs` 与 `publish-update.sh` 都读它）。★ 真正的坑不是 EBUSY 而是**出包入口**：只有 `pnpm --filter @heming/desktop dist` 会先跑 `build-desktop-web.mjs` 刷新嵌入产物，单跑 `build-desktop.mjs` 打出的是**上一轮的旧前端**且一切指标看着都正常——出包后必须核对内嵌 bundle 名与版本串（`docs/deploy.md` §9 坑 #4）。★ **d.30 新踩的坑**：`tar --exclude='./node_modules'` 这种带 `./` 前缀的写法**一条都不生效**（tar 的 `--exclude` 匹配路径段名，不认前缀），包从 5.6MB 撑到 **2.19GB**；排除项要用裸段名并补 `@hemingdesktop`，详见 `docs/deploy.md` §2。
6. **`docker/` 与 `docker-compose.yml` 已停用但未清理**：机器已重置且没装 Docker，发版走 `deploy/`。两处 nginx 配置仍互为出处（`/updates/` 顺序、WS 的 `= /api/ws`），要清理就一起清，见 `docs/deploy.md` §11。
7. **WS 的 `?token=` 兼容路径待删（d.30 留下的）**：服务端为兼容**已发布**的旧桌面包仍接受 query 里的 token。新客户端（d.30+）一律走首帧 auth。等**所有在网客户端都升级到 d.30 之后**，删掉 `packages/server/src/ws.ts` 里读 query token 的那段（`queryUserId`），nginx 的 `access_log off` 可以保留（无害）。判断时机：旧版桌面客户端的更新是渐进的，删早了会让没升级的用户连不上——所以这条**不急，但要记着**。

**二期主线**：

1. **模型能力矩阵补全**：`supportsKind` 已驱动工具/图片的降级提示与实际丢弃；仍缺「思考/长上下文/函数并行」等维度与定价校准。
2. **本地包的安装体验**：探测与翻译链已落；剩下是运行时补全目录清单（装在非常规路径仍可能探不到）、可选的「一键检查/修复」引导，以及包更新（现在钉死版本、不自动跟进）。
3. **harness 桥接**：本机 CLI 探测 + `spawn(shell:false)` + Windows 进程树清理 + 危险命令三层围栏。
4. **Token 团队视图 / 按日期跨端汇总**：需服务端汇总。
5. **群管理**：成员删减/踢人 UI、群主权限。
6. **多模型同题对比**：竞品调研中价值较高、改动集中；对话导出与 LaTeX 已在 d.23 落地。

## 6. 技术债与已知风险

- **Registry**：发现页与安装流已接线（接口区二级面板）；本地包（npm/pypi）**已支持但需本机运行时**（不内置：探测缺 Node/uv 就标「缺运行时」，浏览器标「需桌面版」），oci/nuget/mcpb 仍显式不支持；包名走字符白名单、**必须有钉死版本**、`packageArguments`/`environmentVariables` 一律丢弃；安装确认**始终询问**且不提供「本次会话都允许」；列表缓存在 `heming.mcpRegistry.v1`（6h TTL），离线降级并标注 stale；台账字段 `registryType`/`registryVersion` 只作账本不作执行输入；删除 stdio 服务会调 `stopStdioServer` 回收子进程。
- **HITL**：没有“全部放行”档（刻意）；`annotations` 不参与判定（untrusted hint）；闸门异常按 deny；会话授权只在内存。规则记忆已落盘（deny 优先、danger 不记允许），新规则按智能体隔离、旧规则保持全局；规则不跨设备跟随，ChatPage 接线层已有拒绝/异常路径断言。确认前预览只读调用参数、不读目标文件；★ **d.34 起切换会话不再取消待确认**（此前是「切会话 = 替用户拒绝」）：请求跨会话保持、后台会话的确认会进通知中心（`kind:"approval"`），60 分钟无人裁决才按拒绝收口并在审计里写明「超时未确认」。★ **d.30 已把「免问下限」的全放行口子堵上（读侧 + 写侧都夹）**：`danger` 不再是合法的 floor 值（旧 localStorage 里的 `danger` 读回夹成 `write`），判定式 `<=` 语义未动 ⇒ `floor=write` 时**危险操作恒要问**。
- **会话导出**：只导出已加载且本机可解密的消息；换设备/清缓存后旧消息解不开会被跳过；附件只带元信息，不导出字节；不支持 PDF 或分享链接（避免明文上云）。
- **视觉附件**：历史图片与**本轮同发的图片**都进提示词（同发不再依赖 WS 回声时机）；一次最多 4 张历史图 + 本轮 1 张、单张 ≤4MB。图片解密依赖本地 E2E 密钥，换设备/清缓存后旧图读不到。空草稿单发附件仍不触发生成（刻意）。
- **Anthropic 不支持工具调用**：消息结构（content blocks）与 OpenAI 不同，绑 Anthropic 的智能体用不了 MCP/图表/self 工具。
- **语音通话**：**断线重连已做**（逐路 ICE restart，`RECONNECT_MAX_RESTARTS=2`、`disconnected` 先观察 3s、新信令 `voice_call_reconnect`、状态仍是 active 加路数提示）；★ **真机弱网与 TURN 环境仍未验证**，预算数字是工程判断不是测量结果；群通话任一路彻底断开即整通结束（刻意）；通话中邀请新成员、群成员在线状态等未做；★ `GET /api/ice-servers` **d.30 起已加鉴权**（未带 token → 401），ICE 改由渲染层登录后自取（`packages/web/src/lib/iceServers.ts`，`login()` 与 `restore()` 两条路径都拉），主进程那段裸 fetch 已删。★ **措辞纠正**：里程碑 11 与本节标题写的「Mesh」与实现不符——主叫给每个 `peerId` 建 PC（`voiceCall.ts:316`），但被叫只连主叫一路（`:390`/`:477`），**3 人以上实际是星型（中心=主叫）**；`voiceCall.ts:8` 的文件注释同样写错。处置方案（承认星型 vs 补真 Mesh）见同一份计划 P2-3。
- **弹窗无障碍**：`useModalA11y` 覆盖 Esc（嵌套栈顶独占）、焦点循环、打开即聚焦、**打开期间屏蔽背景**（无 portal ⇒ 遮罩根起的兄弟逐个 `inert` + 模块级引用计数支持嵌套 + `data-a11y-keep` 保留常驻通话浮层 + 非模态浮层 `blockBackground:false`）、**关闭后焦点归还触发元素**（只在焦点确实丢失时还）。真实 Chromium 已实测：弹窗开着时对背景按钮 `.focus()` 焦点不动、Esc 后 `inert` 归零且焦点回到触发按钮、通知中心背景仍可点。★ **未做 portal 改造**（要动 10 个挂载点与 z-index 继承，收益不抵风险）；★ **NVDA/VoiceOver 仍未验**（要装读屏的机器）。弹窗开着时的全局快捷键已在 d.29.1.8.0 收口：`Alt+1–8` 与 `Ctrl/⌘+K` 在有模态弹窗时吞键不做事（`inert` 只挡点击与焦点，挡不住挂在 window 上的 `keydown`），判据是 `useModalA11y` 导出的 `hasOpenModal()`，非模态浮层与语音通话常驻层不拦。
- **主页首帧**：`workspaceReady`/`workspaceError` 只管**首帧**，加载骨架与失败重试条已上屏并在真实浏览器里验过（拖住接口看到骨架、500 看到「加载失败：原因」+ 重试、重试后回正常空态）；后台刷新失败刻意不推翻已就绪（已验：切页触发失败也不塌）。智能体动态一栏的数据来自 `loadAgentsRoster`，不共用这套口径。
- **通知中心**：只做应用内（`heming.notifications.v1`，50 条 / 64KB 上限、无 TTL）；系统通知权限、免打扰、跨窗口聚合未做；HITL 待确认**不产生通知**，仍只在确认弹窗里等裁决。
- **召回可观测性**：注入旁路与召回日志都只在本机（`heming.memory.recallLog.v1`，40 档 / 256KB，**不参与记忆导出**）。「疑似引用」是提示层与回答层的**词重合指标，不是因果证明**：只看最终回答正文（工具调用里用了但没复述就不算），判据保守（宁漏报不误报），界面措辞固定为「疑似引用」。零注入的轮次不留档；`capture`/`settle` 任何异常都只是「这一档没记上」，绝不影响发送与流式。配对键是 `agentId::userText`（两个钩子都拿不到 streamId），同一智能体在两处同时在飞同一句话会串档——刻意接受的低概率代价。打分只展示数值，未拆「重合度／衰减／置信度」三项归因。
- **分发**：自动更新源是 HTTP（清单有 sha512，但首次安装包可被篡改）；无 CSP（web/server/desktop 三处 grep 均 0 命中）；未用 Electron `safeStorage` 加密落盘密钥（`packages/desktop/**` 0 命中 ⇒ apiKey、MCP 请求头、E2E 导出的 JWK 私钥**全明文 localStorage**）；网页端未 HTTPS 化。**规格已备**：d.36 = P0-5（`specs/2026-10-23-d36-safestorage.md`，尚未实施）；P0-6 CSP / P4-1 `release.sh` / P4-2 docker 清理见 `research/2026-10-23-rounds-after-d36.md`；P4-6（更新源签名与 HTTPS）**需用户拍板**。★ **P0-5b 仍未设计**：`msgCache`（解密后正文）与 `e2e.chains`（棘轮状态）仍是本地明文——两者都在热路径上，不能沿用就地信封的懒迁移。
- **本机存储只有一个 ~5MB 的同源配额，而键位设计的最坏情况超它一个量级**：记忆 4 键各 1.2MB（`memory/storage.ts:10-17`）+ 任务 1.1MB（`tasks/store.ts:39`）+ 召回日志 256KB + 用量账本 64KB + 通知 64KB + **每会话 500 条、会话数不设上限**的 `heming.msgCache.<convId>`。各处 `*BYTE_LIMIT` 各自为政、互不知情，溢出后的兜底是「回退空表 / 静默不落」，表现为**权重无故退回 ×1、任务记录消失**这类无法解释的降级。★ **d.31 已做 ①水位可见 + ②`msgCache` 会话数 LRU**（设置区「本机存储」卡按模块分组显示字节数、≥80% 变黄、可实测配额、只给可再生数据清理入口；明文缓存保留最近 20 个会话）。**仍未做：③把最大块搬走**（桌面端改走文件 / IndexedDB）——那是架构变更，需要单独规格与迁移方案；且「统一淘汰仲裁器」也要等 ③ 一起设计，本轮只在 `msgCache` 这一个真正无上限的块上做了局部 LRU。
- **用量账本已接数据源（d.32）**：`record()` 不再零调用——`agentStream` 在成功收口前经注入的 `recordUsage` 记一次（多轮工具调用累加）；拿不到供应商 `usage` 时记 `tokens: null`（未上报），界面区分「0」与「未知」。沉淀节奏计数**d.30 已落盘**（独立键 `heming.memory.pending.v1`）。★ 仍缺：跨端/团队汇总要服务端聚合（P3 二线），本轮未做。
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
