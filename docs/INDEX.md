# 文档索引

> 这个项目的文档分四层：**交接/规范**（先读）→ **功能说明**（怎么用）→ **设计规格**（怎么做）→ **调研**（为什么这么做）。历史计划与调研保留原文，不追改。

## 1. 先读

| 文档 | 用途 |
|---|---|
| [../README.md](../README.md) | 项目定位、启动、打包、结构、数据边界 |
| [HANDOFF.md](HANDOFF.md) | 新会话接手：现状、架构红线、工作约定、下一步 |
| [VERSION-MANAGEMENT.md](VERSION-MANAGEMENT.md) | 5 段版本号、bump 脚本、发布顺序、打包坑 |
| [deploy.md](deploy.md) | 裸机部署（已去 Docker）、两套产物、自动更新源、备份回滚 |

## 2. 功能说明（用户/维护者视角）

| 文档 | 主题 |
|---|---|
| [CHARTS.md](CHARTS.md) | 图表能力：图型、视觉语法、围栏块、导出 |
| [LESS-AI-TONE.md](LESS-AI-TONE.md) | 去 AI 味：11 条统计验证规则、白名单、信息守恒 |
| [WEB-SCRAPING.md](WEB-SCRAPING.md) | 网页抓取：Scrapling 16 个工具的三层启用策略 |
| [SELF-EDIT.md](SELF-EDIT.md) | 自我修改：`self_*` 工具、护栏、审计、快照回滚与开关 |

## 3. 设计规格与实施记录

### 平台与 IM

| 文档 | 主题 |
|---|---|
| [specs/2026-10-13-heming-platform-design.md](superpowers/specs/2026-10-13-heming-platform-design.md) | 总设计、数据模型、里程碑、二期范围 |
| [specs/2026-10-22-bare-metal-deploy.md](superpowers/specs/2026-10-22-bare-metal-deploy.md) | 云端去 Docker：2C2G 上的裸机 nginx + systemd，云端零构建 |
| [specs/2026-10-16-m3-agents-design.md](superpowers/specs/2026-10-16-m3-agents-design.md) | 智能体名册与群内 @ |
| [specs/2026-10-17-e2e-encryption-design.md](superpowers/specs/2026-10-17-e2e-encryption-design.md) | 端到端加密：棘轮、信封、迁移 |
| [specs/2026-10-18-voice-call-design.md](superpowers/specs/2026-10-18-voice-call-design.md) | Mesh WebRTC 语音/视频通话 |
| [specs/2026-10-21-voice-call-reconnect.md](superpowers/specs/2026-10-21-voice-call-reconnect.md) | 通话断线重连：逐路 ICE restart、预算、新信令、明文面复核 |
| [specs/2026-10-18-im-skills-memory-ui.md](superpowers/specs/2026-10-18-im-skills-memory-ui.md) | 导航常驻、技能区、记忆区、通话独立窗口 |
| [specs/2026-10-18-home-page-real-data-design.md](superpowers/specs/2026-10-18-home-page-real-data-design.md) | 主页真实数据化 |

### 智能体运行时

| 文档 | 主题 |
|---|---|
| [specs/2026-10-17-agent-memory-skills-design.md](superpowers/specs/2026-10-17-agent-memory-skills-design.md) | 三层记忆与技能池 |
| [specs/2026-10-21-memory-recall-ranking.md](superpowers/specs/2026-10-21-memory-recall-ranking.md) | 记忆召回：同主题时效覆盖、MMR 去重名额、半衰期分层 |
| [specs/2026-10-22-memory-recall-observability.md](superpowers/specs/2026-10-22-memory-recall-observability.md) | 召回可观测性：召回 ≠ 注入、确定性引用判定、本机召回日志 |
| [specs/2026-10-22-memory-personalization-weights.md](superpowers/specs/2026-10-22-memory-personalization-weights.md) | 个性化权重：引用计数反哺排序（封顶 +25%、只提权不降权）、用量账本、冷记忆清单 |
| [specs/2026-10-22-cold-memory-coverage.md](superpowers/specs/2026-10-22-cold-memory-coverage.md) | 冷清单覆盖面：含私有语义与情景条目、按注入次数排序、删除同步摘掉用量计数 |
| [specs/2026-10-22-modal-shortcut-gate.md](superpowers/specs/2026-10-22-modal-shortcut-gate.md) | 模态门禁：弹窗开着时 `Alt+1–8`/`Ctrl+K` 不穿透，判据复用 `openDialogs` |
| [specs/2026-10-17-agent-context-budget-design.md](superpowers/specs/2026-10-17-agent-context-budget-design.md) | 上下文预算与早期对话压缩 |
| [specs/2026-10-19-mcp-tool-calling.md](superpowers/specs/2026-10-19-mcp-tool-calling.md) | MCP 工具调用、stdio、过程可视化 |
| [specs/2026-10-22-atomic-image-send.md](superpowers/specs/2026-10-22-atomic-image-send.md) | 图片 + 文字同发：本轮附件走当前 user 轮，不依赖历史回声 |
| [specs/2026-10-22-modal-inert-and-workspace-state.md](superpowers/specs/2026-10-22-modal-inert-and-workspace-state.md) | 弹窗屏蔽背景（无 portal 下的兄弟屏蔽 + 引用计数）、焦点归还、工作区首帧加载/失败态 |
| [superpowers/2026-10-18-agent-handoff.md](superpowers/2026-10-18-agent-handoff.md) | 智能体批次交接（键名、常量、边界） |

### 桌面端

| 文档 | 主题 |
|---|---|
| [specs/2026-10-18-window-chrome-design.md](superpowers/specs/2026-10-18-window-chrome-design.md) | 自定义标题栏与窗口控件 |
| [specs/2026-10-18-boot-animation-design.md](superpowers/specs/2026-10-18-boot-animation-design.md) | 4.5s 四段式启动动画 |
| [specs/2026-10-18-wordmark-login-design.md](superpowers/specs/2026-10-18-wordmark-login-design.md) | 手写「Heming」字样与登录分栏 |
| [specs/2026-10-18-embed-web-in-client-design.md](superpowers/specs/2026-10-18-embed-web-in-client-design.md) | `app://heming` 嵌入产物与安全上下文 |

### 安全与新能力

| 文档 | 主题 |
|---|---|
| [research/2026-10-21-hitl-architecture.md](research/2026-10-21-hitl-architecture.md) | HITL 人工确认：分类、档位、闸门、文案、任务分解 |
| [research/2026-10-21-hitl-class-diagram.mermaid](research/2026-10-21-hitl-class-diagram.mermaid) | HITL 类图 |
| [research/2026-10-21-hitl-sequence-diagram.mermaid](research/2026-10-21-hitl-sequence-diagram.mermaid) | HITL 时序图 |
| [research/2026-10-22-registry-architecture.md](research/2026-10-22-registry-architecture.md) | MCP Registry：API 实测、映射、白名单、安装流、T08/T09 |
| [specs/2026-10-21-local-package-runtime-policy.md](superpowers/specs/2026-10-21-local-package-runtime-policy.md) | 本地包（npm/pypi）运行时策略：探测、`shell:false` 翻译链、台账与进程回收 |
| [research/2026-10-21-delivery-hitl-registry.md](research/2026-10-21-delivery-hitl-registry.md) | HITL + Registry 本轮交付与踩坑 |

### d.30–d.48 安全、数据收口与能力平台化（2026-10-22 → ）

按 `research/2026-10-22-deep-audit-followup-plan.md` 的分轮表推进；每轮一份规格、一次门禁、两处发布。

| 文档 | 主题 |
|---|---|
| [specs/2026-10-22-d30-security-redlines-and-silent-degradation.md](superpowers/specs/2026-10-22-d30-security-redlines-and-silent-degradation.md) | d.30：HITL 免问下限夹回 `write`、ICE/WS 鉴权、桌面崩溃兜底、记忆 `updatedAt` 拆分与沉淀计数落盘、WS 队列上限 |
| [specs/2026-10-22-d31-storage-budget-and-drafts.md](superpowers/specs/2026-10-22-d31-storage-budget-and-drafts.md) | d.31：本机存储水位（按模块分组 + 实测配额 + 可再生清理）、`msgCache` 会话数 LRU、草稿按会话持久 |
| [specs/2026-10-23-d32-token-usage-and-capability-matrix.md](superpowers/specs/2026-10-23-d32-token-usage-and-capability-matrix.md) | d.32：token 用量埋点（未上报 ≠ 0）、能力矩阵补并行/结构化两维、徽标去 emoji |
| [specs/2026-10-23-d33-message-windowing.md](superpowers/specs/2026-10-23-d33-message-windowing.md) | d.33：消息列表窗口化（默认 60 条、滚动补偿、搜索扩窗） |
| [specs/2026-10-23-d34-hitl-approval-notifications.md](superpowers/specs/2026-10-23-d34-hitl-approval-notifications.md) | d.34：待确认进通知中心、不再「切会话 = 拒绝」、60 分钟超时留痕 |
| [specs/2026-10-23-d35-wiki-tasks-export.md](superpowers/specs/2026-10-23-d35-wiki-tasks-export.md) | d.35：wiki 中文二元组检索、任务淘汰护进行中、导出附块与桌面落盘 |
| [specs/2026-10-24-ux-polish.md](superpowers/specs/2026-10-24-ux-polish.md) | d.35.1.9.0：全量自检后的体验修补（聊天三态/滚动/复制/图片/粘贴、设置反馈、导航未读） |
| [specs/2026-10-23-d36-safestorage.md](superpowers/specs/2026-10-23-d36-safestorage.md) | d.36（已实施）：三把钥匙改走 `safeStorage` 就地信封 + 懒迁移 + 失败保留明文；明确未覆盖 msgCache/chains |
| [specs/2026-10-27-d37-conversation-continuity.md](superpowers/specs/2026-10-27-d37-conversation-continuity.md) | d.37：会话连续性——`lastMessageAt` 排序、未读分隔线定位、连接三态与断线横幅、草稿可见 |
| [specs/2026-10-28-d38-typing-indicator.md](superpowers/specs/2026-10-28-d38-typing-indicator.md) | d.38：人类会话正在输入提示——`typing` 元数据事件、客户端 2s / 服务端 1s 节流、3s 过期；presence 未做 |
| [specs/2026-10-28-d39-global-message-awareness.md](superpowers/specs/2026-10-28-d39-global-message-awareness.md) | d.39：全域消息感知——非聊天页后台通道（只感知不解密）、桌面系统通知（正文固定）、按会话免打扰、消息 id 去重；会话列表/全局搜索/presence/托盘未做 |
| [specs/2026-10-29-d40-conversation-center.md](superpowers/specs/2026-10-29-d40-conversation-center.md) | d.40：会话中心——导航「会话」Alt+9、未归档全集、置顶 + 最近活跃排序、五级预览（只读本机缓存）、行内置顶/免打扰/归档、本机偏好；全局检索/分组/拖拽/服务端同步未做 |
| [specs/2026-11-01-d41-capability-kernel.md](superpowers/specs/2026-11-01-d41-capability-kernel.md) | d.41：能力内核——五类工具改为提供者注册（MCP/图表/去 AI 味/知识库/自我修改）、工具来源与提供者归属、技能分配成为真路由边界；插件包/可执行插件/共享契约上提未做 |
| [specs/2026-11-01-d42-plugin-packages.md](superpowers/specs/2026-11-01-d42-plugin-packages.md) | d.42：插件包——`plugin.json` 只声明技能、物化为带 `pluginId` 的普通技能、安装/更新/启停/卸载、插件页 Alt+0、`heming.plugins.v1`；不执行第三方代码、不声明 MCP、无市场/签名 |
| [specs/2026-11-01-d43-system-capability-plugins.md](superpowers/specs/2026-11-01-d43-system-capability-plugins.md) | d.43：系统能力包——清单 v2 声明技能 + 远程 MCP（https / 本机 http）、服务 id `plugin:<插件 id>:<key>`、安装/更新/停用/卸载同步服务并保留用户请求头与工具授权、接口区来源标记；不执行代码、不带密钥、不自动连接/授权 |
| [specs/2026-11-01-d44-plugin-update-preview.md](superpowers/specs/2026-11-01-d44-plugin-update-preview.md) | d.44：插件更新差异——`preview()` 按实际技能池/注册表算新增/变更/不变/移除、冲突与数量上限禁用确认、能力详情弹窗只读展示技能与服务状态；不回滚、不联网探测、不持久化预览 |
| [specs/2026-11-01-d45-infohub-local-sidecar.md](superpowers/specs/2026-11-01-d45-infohub-local-sidecar.md) | d.45：信息中枢——InfoHub Python 源码并入 `packages/infohub`，Electron stdio 拉起（不开端口/不走网络），只读 `mode=ro` 浏览/检索/议程、显式同步、配置脱敏、IPC 方法白名单；并修复 sandbox preload 不能 require 本地模块导致全部桌面桥失效 |
| [specs/2026-11-01-d46-infohub-native-capability.md](superpowers/specs/2026-11-01-d46-infohub-native-capability.md) | d.46：信息中枢原生融入——归档工具提供者（检索/读会话/日程，重扫走 HITL）、共享运行态 store、首页归档卡、Ctrl+K 归档检索、跨页意图、归档来源脚注；只在桌面端且已连接时注入，不自动启动边车、不暴露 sync、不迁移数据 |
| [specs/2026-11-01-d47-automation-center.md](superpowers/specs/2026-11-01-d47-automation-center.md) | d.47：自动化中心——本机任务（每天定时/按间隔，`heming.automations.v1`）、InfoHub 同步与日程重扫白名单、15s 串行调度、启动不补跑、未连接记 `skipped` 且绝不自动拉起边车；信息中枢「定时/保存为定时任务/定时重扫」预填；不执行脚本、不推送、不上云 |
| [specs/2026-11-01-d48-staff-proactive-agent.md](superpowers/specs/2026-11-01-d48-staff-proactive-agent.md) | d.48：常驻幕僚——晨报 + 日程临期 + 任务异常三路只读巡检，规则优先、可选模型总结并强制补回紧急项，`heming.staff.*` 本机存储、去重账本、静默时段与预算；只递简报与跳转，不自动执行、不拉起 InfoHub、不巡检归档全文 |
| [research/2026-10-28-d38-adversarial-qa.md](research/2026-10-28-d38-adversarial-qa.md) | d.38.1.10.0：对抗性自检 16 例（typing + 连续性），C2 暴露「消息到达不清理输入态」，已修 |
| [research/2026-10-28-d39-deep-stress-testing.md](research/2026-10-28-d39-deep-stress-testing.md) | d.39.1.11.0：32 例深度对抗/压测（消息风暴、页面切换、通知桥模糊输入）+ 6 项修复（交接窗口、吐司合并、id 校验、文本清洗、点击幂等、通话窗焦点）；后台失败 UI 仍缺 |
| [research/2026-10-23-rounds-after-d36.md](research/2026-10-23-rounds-after-d36.md) | d.36 之后的开工备忘：CSP 基线、`release.sh` 顺序、docker 清理、需拍板项与建议轮次 |

## 4. 调研

| 文档 | 主题 |
|---|---|
| [research/2026-10-20-competitive-analysis-v2.md](research/2026-10-20-competitive-analysis-v2.md) | 56 个同功能产品、许可证核实、差距与可复用资产 |
| [research/2026-10-20-competitive-analysis.md](research/2026-10-20-competitive-analysis.md) | 上一轮竞品调研（历史） |
| [research/2026-10-19-hermes-memory-skill-research.md](research/2026-10-19-hermes-memory-skill-research.md) | Hermes 记忆/技能机制 |
| [superpowers/research/2026-10-17-multiagent-study.md](superpowers/research/2026-10-17-multiagent-study.md) | 参考项目 MultiAgent 的 40 条可借鉴点 |
| [research/2026-10-21-feature-parity-and-optimization.md](research/2026-10-21-feature-parity-and-optimization.md) | 同功能产品功能异同与许可证安全的优化建议（本轮新增） |
| [research/2026-10-21-task-area.md](research/2026-10-21-task-area.md) | 任务区：Codex / Claude Code 等产品的任务模型对照与和鸣落地口径 |
| [research/2026-10-21-gap-closure.md](research/2026-10-21-gap-closure.md) | 缺口补全：功能 / 视觉 / 体感三张清单与规则作用域、导出、公式的落地口径 |
| [research/2026-10-21-all-feature-gap-audit.md](research/2026-10-21-all-feature-gap-audit.md) | 全功能缺口审计：d.24 已落地 10 项 + 暂缓项的 d.25 处置（8 项已补做，附未做部分与理由） |
| [research/2026-10-22-deep-audit-followup-plan.md](research/2026-10-22-deep-audit-followup-plan.md) | 深度调研与后续完善计划：P0 红线口子 / P1 数据一致性 / P2 体感 / P3 功能 / P4 工程，逐条带 `file:line` 证据与 d.30… 分轮排期 |
| [research/2026-10-28-ai-im-ux-pain-points.md](research/2026-10-28-ai-im-ux-pain-points.md) | AI 工作台 / IM 体验痛点：后台失联、系统通知、会话列表、免打扰、全局搜索、presence、托盘（P0–P3，附本仓证据；d.39 取 P0 两项 + 免打扰） |

## 5. 历史计划

`docs/superpowers/plans/` 下的实施计划按日期归档，反映当时的任务拆分与验收口径；现状以 [HANDOFF.md](HANDOFF.md) 和代码为准。
