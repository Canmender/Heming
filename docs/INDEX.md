# 文档索引

> 这个项目的文档分四层：**交接/规范**（先读）→ **功能说明**（怎么用）→ **设计规格**（怎么做）→ **调研**（为什么这么做）。历史计划与调研保留原文，不追改。

## 1. 先读

| 文档 | 用途 |
|---|---|
| [../README.md](../README.md) | 项目定位、启动、打包、结构、数据边界 |
| [HANDOFF.md](HANDOFF.md) | 新会话接手：现状、架构红线、工作约定、下一步 |
| [VERSION-MANAGEMENT.md](VERSION-MANAGEMENT.md) | 5 段版本号、bump 脚本、发布顺序、打包坑 |
| [deploy.md](deploy.md) | Docker 部署、两套产物、自动更新源、备份回滚 |

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
| [specs/2026-10-17-agent-context-budget-design.md](superpowers/specs/2026-10-17-agent-context-budget-design.md) | 上下文预算与早期对话压缩 |
| [specs/2026-10-19-mcp-tool-calling.md](superpowers/specs/2026-10-19-mcp-tool-calling.md) | MCP 工具调用、stdio、过程可视化 |
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

## 5. 历史计划

`docs/superpowers/plans/` 下的实施计划按日期归档，反映当时的任务拆分与验收口径；现状以 [HANDOFF.md](HANDOFF.md) 和代码为准。
