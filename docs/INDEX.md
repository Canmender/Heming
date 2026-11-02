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
| [PET.md](PET.md) | 桌宠：怎么用、三层架构、数据边界、扩展指南（换形象/加姿态/接事件通道/接语音）、已知限制与排查 |

## 3. 设计规格与实施记录

### 平台与团队

| 文档 | 主题 |
|---|---|
| [specs/2026-10-13-heming-platform-design.md](superpowers/specs/2026-10-13-heming-platform-design.md) | 总设计、数据模型、里程碑、二期范围（IM 部分已被 d.54 取代） |
| [specs/2026-11-02-team-system-design.md](superpowers/specs/2026-11-02-team-system-design.md) | **d.54 团队系统（去 IM）**：删除人类私聊/群聊与语音视频通话、保留 AI 助手、通讯录升级为全站名册、团队动向摘要（来源/白名单/幂等/隐私边界）、迁移脚本与验收 |
| [specs/2026-10-22-bare-metal-deploy.md](superpowers/specs/2026-10-22-bare-metal-deploy.md) | 云端去 Docker：2C2G 上的裸机 nginx + systemd，云端零构建 |
| [specs/2026-10-16-m3-agents-design.md](superpowers/specs/2026-10-16-m3-agents-design.md) | 智能体名册与群内 @（群聊部分已被 d.54 删除） |
| [specs/2026-10-17-e2e-encryption-design.md](superpowers/specs/2026-10-17-e2e-encryption-design.md) | 端到端加密：棘轮、信封、迁移（现服务于 AI 助手消息） |
| [specs/2026-10-18-voice-call-design.md](superpowers/specs/2026-10-18-voice-call-design.md) | Mesh WebRTC 语音/视频通话（**d.54 已删除**，仅作历史） |
| [specs/2026-10-21-voice-call-reconnect.md](superpowers/specs/2026-10-21-voice-call-reconnect.md) | 通话断线重连（**d.54 已删除**，仅作历史） |
| [specs/2026-10-18-im-skills-memory-ui.md](superpowers/specs/2026-10-18-im-skills-memory-ui.md) | 导航常驻、技能区、记忆区、通话独立窗口（通话部分已删除） |
| [specs/2026-10-18-home-page-real-data-design.md](superpowers/specs/2026-10-18-home-page-real-data-design.md) | 主页真实数据化（d.54 改为团队统计与动向卡） |

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
| [specs/2026-11-02-d53-file-edit-primitive.md](superpowers/specs/2026-11-02-d53-file-edit-primitive.md) | **d.55 文件编辑原语**：`file_patch` / `file_read`、上下文锚点协议与三级匹配、可写根、三态安全判定、HITL 路径前缀授权、确认卡行级 diff（文件名中的 d.53 是写作时暂用号） |
| [specs/2026-11-02-d54-rollout-recovery-fork.md](superpowers/specs/2026-11-02-d54-rollout-recovery-fork.md) | 回合日志的回放/重跑/分叉（**d.56 已实施**）：`ROLLOUT_VERSION=2`（`seq` + `forkedFrom`）、v1 只读不可分叉、`pairToolCalls` 配对校验（回放标注与分叉前置同源）、重跑=新建任务且原任务不动、分叉=新任务 + 前缀由本机日志重建并如实标注截断、P3 分叉前预览；不做断点续跑、不做批量迁移、不提高 200 条上限 |

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

### d.30–d.54 安全、数据收口与能力平台化（2026-10-22 → ）

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
| [specs/2026-11-02-team-system-design.md](superpowers/specs/2026-11-02-team-system-design.md) | d.54：去 IM——删除人类私聊/群聊/消息/已读/typing/撤回/转发/表情回应/语音消息与语音视频通话；保留 AI 助手对话与 E2E；`GET /api/team` 全站名册 + presence + `last_seen_at`；`/api/team/activities` 仅摘要、`(actor_id, source_id)` 幂等；团队页三类共享默认全关、主页团队卡、Ctrl+K 搜成员；`scripts/purge-im-data.mjs` 默认 dry-run |
| [specs/2026-11-01-d46-desktop-pet.md](superpowers/specs/2026-11-01-d46-desktop-pet.md) | d.53（文件名为写作时编号）：桌宠——独立透明置顶窗（`pet.html` 独立入口，不背应用 bundle）、默认鼠标穿透 + 按可交互区动态关闭、Cubism Core 官方再分发文件 + Hiyori 示例模型、视线/点击/口型、点角色直接对话（复用 `streamChat` 直连本机 LLM）；不做语音/消息感知/模型市场 |
| [plans/2026-11-01-d46-desktop-pet.md](superpowers/plans/2026-11-01-d46-desktop-pet.md) | d.53 实施计划：资源与依赖 → 窗口层纯函数 → 主进程接线 → 渲染层 → 对话与设置 → 门禁与真机验收 |
| [specs/2026-11-02-pet-presence.md](superpowers/specs/2026-11-02-pet-presence.md) | 桌宠的在场感（**d.59.2.19 已实施**）：事件由通知中心派生（零生产者改动）、渠道互斥（主窗口前台走通知中心）、三档打扰强度、标题级文案脱敏、错过不补发；见 `docs/PET.md` §4.3 |
| [specs/2026-11-02-safe-storage-async-migration.md](superpowers/specs/2026-11-02-safe-storage-async-migration.md) | **d.59.2.19 safeStorage 同步→异步迁移**：async 三件套 + 批量 `secret:bootstrap` 白名单、preload 预取缓存、渲染层缓存优先/同步桥兜底、300ms 短帽 hydrate、P0-5b P3 备份清理安全序、Electron 46 前的 5 步切换清单 |
| [specs/2026-11-02-d53-file-edit-primitive.md](superpowers/specs/2026-11-02-d53-file-edit-primitive.md) | **d.55 文件编辑原语（已实施）**：`file_patch`/`file_read`、解析与三级匹配、原子应用、可写根与路径收敛（软链/硬链/大小/编码）、三态安全判定、HITL 路径前缀授权、确认卡行级 diff、桌面写盘桥 `file-fs.js` + `path-guard.js` |
| [specs/2026-11-02-d54-rollout-recovery-fork.md](superpowers/specs/2026-11-02-d54-rollout-recovery-fork.md) | **d.56 回合日志回放/重跑/分叉（已实施）**：`ROLLOUT_VERSION=2` + `seq`/`forkedFrom`、`pairToolCalls` 同源、重跑保留原任务、分叉新建任务 + 重建前缀并标注截断、P3 预览；不做断点续跑与批量迁移 |
| [specs/2026-11-02-p0-5b-hotpath-encryption.md](superpowers/specs/2026-11-02-p0-5b-hotpath-encryption.md) | **P0-5b 热路径加密（设计稿，P1 实施中）**：威胁模型与伪需求甄别、方案 A′（就地信封 + 逐条密文 + 内存视图）、chains 写前自校验、配额降级阶梯、非破坏性迁移；Q1/Q2/Q3 已拍板 |
| [plans/2026-11-02-full-upgrade-program.md](superpowers/plans/2026-11-02-full-upgrade-program.md) | **全面升级计划（2026-11-02 起）**：④ 发布与文档收尾 → ① 工程基线升级（依赖/构建链/桌面壳/样式链）→ ② 功能与技术债（`file_patch`、回合日志回放/分叉、团队能力、桌宠在场感、P0-5b、CSP、`release.sh`、docker 清理）→ ③ 体验与安全加固；每批独立版本号/门禁/发布，进度台账在文内 §5 |
| [research/2026-10-28-d38-adversarial-qa.md](research/2026-10-28-d38-adversarial-qa.md) | d.38.1.10.0：对抗性自检 16 例（typing + 连续性），C2 暴露「消息到达不清理输入态」，已修 |
| [research/2026-10-28-d39-deep-stress-testing.md](research/2026-10-28-d39-deep-stress-testing.md) | d.39.1.11.0：32 例深度对抗/压测（消息风暴、页面切换、通知桥模糊输入）+ 6 项修复（交接窗口、吐司合并、id 校验、文本清洗、点击幂等、通话窗焦点）；后台失败 UI 仍缺 |
| [research/2026-10-23-rounds-after-d36.md](research/2026-10-23-rounds-after-d36.md) | d.36 之后的开工备忘：CSP 基线、`release.sh` 顺序、docker 清理、需拍板项与建议轮次 |
| [research/2026-11-02-a11y-error-audit.md](research/2026-11-02-a11y-error-audit.md) | **d.59.2.20 无障碍与错误态巡检**：焦点环系统性回归（Tailwind 4 `outline-hidden` 后 59 处控件）、屏幕阅读语义、流式 live 区、对比度实测表与 token 修复（`muted #6f6f6f` AA、`line-strong` 表单边界）、逐入口 loading/error/retry 三态清单 |

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
| [research/2026-11-01-codex-vs-heming-agent.md](research/2026-11-01-codex-vs-heming-agent.md) | Codex 全量对比：15 维能力矩阵、六个缺口与逐条改法、可移植资产清单（Apache-2.0）、P0/P1/P2 路线；G1–G6 已于 d.50–d.52 落地 |

## 5. 历史计划

`docs/superpowers/plans/` 下的实施计划按日期归档，反映当时的任务拆分与验收口径；现状以 [HANDOFF.md](HANDOFF.md) 和代码为准。
