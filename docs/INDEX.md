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
| [PET.md](PET.md) | 桌宠（**d.98 起为界面插件 `heming.pet`**）：怎么装/用/卸、插件包结构、宿主运行时与三种边界、数据边界与老数据迁移、扩展指南（换形象/加姿态/加设置项）、已知限制与排查 |
| [PLUGINS.md](PLUGINS.md) | 插件（能力包）：清单 v3 字段表、权限声明（网络/工具风险上限/文件根）、命令 target、安装/更新/停用/卸载语义、v1/v2 兼容与红线；**§10 界面插件（v4 bundle）**；**§11 清单 v5（d.107）**：`engines` 版本兼容、上架元数据、`prepare→persist→rollback` 安装事务、权限扩张重确认、防降级、兼容矩阵 |
| [PLUGIN-AUTHORING.md](PLUGIN-AUTHORING.md) | 插件作者指南（v5）：五分钟写出第一个插件、五个字段决定能不能装、贡献点准入、权限声明、分层严格度、发布/市场/弃用、调试三招、兼容速查 |
| [SKILL-HUB.md](SKILL-HUB.md) | 技能社区（d.109）：接入国内技能平台「虾评」的契约与边界——为什么走服务端代理（CORS/归一化/解包上限）、5 条接口与上游字段映射、6 步安装流程与安全上限、Key 管理（安全存储/不持久化）、信任合规、失败降级、配置开关与接第二个源的做法 |

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
| [specs/2026-11-03-d67-signature-dark-responsive.md](superpowers/specs/2026-11-03-d67-signature-dark-responsive.md) | **d.65.2.24 签名信任 / 贡献级停用 / 暗色主题 / 窄窗响应式**：Ed25519 签名 + 发布者 TOFU 信任（验签失败不放行、换钥复核）；技能/服务/命令/工具束四类独立停用；暗色 token 双套 + 兼容层 + 主题模式设置；<1200 右栏抽屉化与页面内边距 |
| [specs/2026-11-03-d66-plugin-trust-toolpack-authz.md](superpowers/specs/2026-11-03-d66-plugin-trust-toolpack-authz.md) | **d.64.2.23 插件信任与工具束授权**：安装内容指纹（fnv1a64，明确非密码学签名）与覆盖保护（同版本内容变化/作者变化需显式勾选确认）；工具束按工具逐个授权（仅限本插件自己的 MCP 服务工具、逐个确认、无批量放行） |
| [specs/2026-11-03-d65-system-plugin.md](superpowers/specs/2026-11-03-d65-system-plugin.md) | **d.63.2.23 系统插件与声明式工具束**：内置技能/预置 MCP/内置工具建模为只读系统插件 `heming.core`（置顶不可停用/卸载）；清单 v3 向后兼容增补 `contributions.toolPacks`（声明式工具归属，不改开关与 HITL）；统一 `CapabilityDescriptor` 让插件页/技能区/接口区同源 |
| [specs/2026-11-03-d64-plugin-unification.md](superpowers/specs/2026-11-03-d64-plugin-unification.md) | **d.62.2.23 统一插件模型**：参考 DeepSeek Harness 插件模型（`apply(ctx)` 贡献面/依赖声明/生命周期/权限门禁）把技能、工具、MCP 服务合并为一份插件清单 v3（`contributions` + `permissions`），新增统一能力目录与插件页能力中枢（插件/技能/工具/MCP 四 Tab），命令面板接插件命令 |
| [specs/2026-11-03-d63-component-typography.md](superpowers/specs/2026-11-03-d63-component-typography.md) | **d.61.2.23 组件级排版与控件规范**：七组控件基元（input/btn/chip/table/list-row/empty/skeleton）、设置卡与弹窗收口、7 页表格与列表、空态骨架组件化、登录页归位 |
| [specs/2026-11-03-d62-layout-typography.md](superpowers/specs/2026-11-03-d62-layout-typography.md) | **d.61.2.22 布局与排版统一**：审计数据（11 档字号 / 3 种内边距 / 3 种内容宽度）、8 个语义排版档、`PageShell` 基元（固定页头 + 宽度档 + 滚动归属）、16 页逐页落地与刻意保留的不一致 |
| [specs/2026-11-02-d61-ux-round2.md](superpowers/specs/2026-11-02-d61-ux-round2.md) | **d.61.2.21 体验优化第二轮**：全局本机搜索（任务/记忆/插件进命令面板，只读本机）、设置页内搜索与 13 张卡片定位（registry + 双向源码守卫）、快捷键帮助面板、通知中心类型筛选 |
| [specs/2026-11-02-d60-ux-round.md](superpowers/specs/2026-11-02-d60-ux-round.md) | **d.60.2.21 用户体验优化轮**：审计到的 7 个问题（首跑无引导/未绑定模型不提示/命令面板单薄/空态空白/页面切换无骨架/登录页圆环压表单/文件栏缺上下文）与三轨方案（首跑引导+提示同源、命令面板 v2、空态骨架细节） |
| [research/2026-11-02-security-review.md](research/2026-11-02-security-review.md) | **d.59.2.21 安全复审**（28 条结论，每条带 `file:line`）：越权 IPC（已修，`secureIpc` fail-closed + 桌宠导航闸 + IPC 通道不变量守卫）、E2E 红线完整性、本机存储口径、保险模块零网络、注入面；待修 4 条（草稿/token 明文、可写根 rootId、files mime nosniff）与处置 |
| [research/2026-11-02-a11y-error-audit.md](research/2026-11-02-a11y-error-audit.md) | **d.59.2.20 无障碍与错误态巡检**：焦点环系统性回归（Tailwind 4 `outline-hidden` 后 59 处控件）、屏幕阅读语义、流式 live 区、对比度实测表与 token 修复（`muted #6f6f6f` AA、`line-strong` 表单边界）、逐入口 loading/error/retry 三态清单 |
| [specs/2026-11-03-d66-automation-execution-kernel.md](superpowers/specs/2026-11-03-d66-automation-execution-kernel.md) | d.66：自动化执行内核——动作注册表（`kinds.ts`/`actions.ts`，加动作只加元数据 + 执行函数）、运行记录独立键（40 条 / 192KB 双淘汰、触发来源与耗时、删任务级联）、失败通知（`kind:"automation"` + 跳转定位）、存储水位登记；借 n8n 概念但不复制代码，仍不自动重试/不补跑 |
| [plans/2026-11-03-d68-pet-nav-custom.md](superpowers/plans/2026-11-03-d68-pet-nav-custom.md) | **d.68.2.25 执行计划**：四条用户体验问题（桌宠拖动/菜单、导航自动隐藏、布局字体、自定义内容简化）的根因线索、三路写入边界、验收与收尾口径 |
| [specs/2026-11-03-d68-pet-interaction.md](superpowers/specs/2026-11-03-d68-pet-interaction.md) | **d.68 桌宠交互修复**：`fitModel` 用已缩放尺寸导致「局部放大/裁切」的代数推导与自然尺寸幂等拟合（`live2dFit.ts`）、拖拽中冻结重排与落点统一重拟合、跨屏 DPR 同步、右键菜单两个叠加缺陷（命中区漏菜单 / click-away 抢在 click 前卸载）、菜单键盘与重置位置/穿透开关、真机待验清单 |
| [specs/2026-11-03-d68-nav-layout.md](superpowers/specs/2026-11-03-d68-nav-layout.md) | **d.68 导航自动隐藏 + 布局字体**：`pinned/auto` 两模式与 `heming.nav.mode.v1`、左缘 8px 热区/300ms 收回/Esc/焦点还热区、`Ctrl/⌘+B` 三态、浮层 absolute 不挤压内容、设置卡与 pin 按钮同源；字体栈拉丁在前/CJK 在后、占位符对比度 AA、`.ui-card`/`.ui-overlay-shadow`、主页窄窗排布 |
| [specs/2026-11-03-d68-custom-content.md](superpowers/specs/2026-11-03-d68-custom-content.md) | **d.68 自定义内容简化**：自建智能体 4 模板 + 基础/进阶渐进披露、创建后直接进对话；自定义技能新建弹窗（必填名称+内容、3 模板、创建即分配、空态直达）；明确不做记忆区/Wiki、云同步与键位迁移 |
| [specs/2026-11-04-d68-selfcheck.md](superpowers/specs/2026-11-04-d68-selfcheck.md) | **d.68.2.26 自检与再优化**：headless Edge + CDP 真实浏览器逐页自检方法、8 个实测问题（暗色组件基元白底/热力图白方块/开关倒置/缺失 hover、导航 auto 鼠标焦点钉住、桌宠菜单贴边被裁与无桥死按钮、插件区统计滞后）的根因/修法/证据，以及未复验项 |
| [specs/2026-11-04-d69-ux-round.md](superpowers/specs/2026-11-04-d69-ux-round.md) | **d.69 体验自检六轮**：真实浏览器（含本机假 LLM 网关 / 假 MCP 服务）逐轮找问题与修复——登录说人话、内部术语出清、假状态换真数据、命令面板焦点环（含高对比回归）、失败原因分类翻译、HITL 记住规则/高对比实测、任务失败原因；附每轮未覆盖项 |
| [specs/2026-11-07-file-panel-and-automation-presets.md](superpowers/specs/2026-11-07-file-panel-and-automation-presets.md) | **文件管理收进智能体页 + 自动化预设**：共享文件面板不再全局常驻（只在智能体页显示），窄窗入口同步收口；自动化新增 4 条一键预设（每日/每2小时/日程/周导出），编辑器保留为自定义入口 |
| [specs/2026-11-07-installer-branding.md](superpowers/specs/2026-11-07-installer-branding.md) | **安装器品牌化**：NSIS 欢迎页/完成页文案、164×314 侧栏、150×57 页头、多尺寸应用图标；素材由 `scripts/make-installer-assets.py` 生成，附安装行为不变与未做项（签名/深色控件） |
| [specs/2026-11-07-ui-polish-rounds.md](superpowers/specs/2026-11-07-ui-polish-rounds.md) | **20 轮 UI/UX 自检与优化**（进行中）：按「使用习惯 / 排版 / UI 一致性 / AI 腔文案」逐轮找证据并修复；含轮次看板、每轮问题与修法、验证口径与遗留清单 |
| [specs/2026-11-08-d112-backup-and-layout.md](superpowers/specs/2026-11-08-d112-backup-and-layout.md) | **d.112 备份恢复页面化 + 布局**：备份列表/新建/恢复（二次确认、口令只在交互面板内存）/从文件恢复；新增 cli:begin 与 backup IPC；来源两列、运行两列、统一 SectionCard 卡片头 |
| [specs/2026-11-08-d111-model-advanced-forms.md](superpowers/specs/2026-11-08-d111-model-advanced-forms.md) | **d.111 模型页高级表单**：来源高级设置（Key/routing/models/请求头/耐心/错误处理/备用）、分组规则（tokens/文件夹/时段/意图）、模型属性（显示名/思考档/协议）；刷新模型目录 |
| [specs/2026-11-08-d110-usage-and-visual.md](superpowers/specs/2026-11-08-d110-usage-and-visual.md) | **d.110 视觉与用量**：模型页浅灰画布/渐变节点/呼吸枢纽/载波流动/候选链卡片对齐原版观感；新增用量面板（概览/每日柱状图/模型·Agent·账号拆分/最近请求/CSV）；附功能还原度差距清单 |
| [specs/2026-11-08-d106-model-bridge-fix.md](superpowers/specs/2026-11-08-d106-model-bridge-fix.md) | **d.106 修复模型页「用不了」**：真机定位为命令桥改动未进提交（preload/main 只有旧四方法）；重接六个方法+五通道并加源码级回归守卫；浏览器端降级收口（只读模型/运行，隐藏来源） |
| [specs/2026-11-08-d104-model-page-three-tabs.md](superpowers/specs/2026-11-08-d104-model-page-three-tabs.md) | **d.104 模型页三分区与动效**：融合成模型/来源/运行；分段控件、行卡片、骨架屏、空态示意；实时链路改为三列卡片 + 0.7s 虚线流动/1.8s 呼吸点/300ms 入场，尊重减少动效 |
| [specs/2026-11-08-d103-model-page-refactor.md](superpowers/specs/2026-11-08-d103-model-page-refactor.md) | **d.103 模型页重构**：设置区去掉模型页签；模型页改为「模型/添加来源/账号/路由/更多」五分区，卡片式加来源、只填 Key/点一下登录；去掉服务启停、地址端口与第三方品牌；其余能力收进折叠区 |
| [specs/2026-11-08-plugin-system-upgrade.md](superpowers/specs/2026-11-08-plugin-system-upgrade.md) | **插件体系升级（预计 d.104）**：对标 deepseek-harness 后定的契约——v5 清单（`engines` 版本兼容 + `meta` 上架元数据）、统一能力单元/贡献点注册表（撤销即停用/卸载）、安装事务与回滚、云端目录 v2 索引（分类/标签/版本/详情）、首方 bundle 签名；分 A/B/C/D 四阶段与测试计划 |
| [specs/2026-11-08-d102-trace-filters.md](superpowers/specs/2026-11-08-d102-trace-filters.md) | **d.102 实时链路优化**：顶部统计（总数/进行中/成功/失败/平均耗时/token）、状态筛选、点击客户端或账号节点即筛选、最后读取时间、尊重减弱动效、筛选后空状态 |
| [specs/2026-11-08-d101-live-trace-view.md](superpowers/specs/2026-11-08-d101-live-trace-view.md) | **d.101 模型页「实时链路」**：读内核 `/v1/magpie/trace`，画客户端→内核→账号的节点图；蓝流动=进行中、绿=成功、琥珀=换人，点击看尝试详情；纯函数建图 + SVG 视图 + 轮询暂停 |
| [specs/2026-11-08-d100-model-page.md](superpowers/specs/2026-11-08-d100-model-page.md) | **d.100 导航「模型」页**：把 magpie 管理面（供应商/订阅账号/分组路由/模型/用量/备份同步/库与搜索/终端）做成一等页面；页面经主进程白名单命令桥调用自家内核（无 shell、流式、真终端登录）；含页面/桥/导航测试 |
| [specs/2026-11-08-d97-magpie-core-vendored.md](superpowers/specs/2026-11-08-d97-magpie-core-vendored.md) | **d.97 复用 magpie 源码自建内核**：`vendor/magpie-core`（MIT，v0.1.3246 裁剪）+ `scripts/build-magpie-core.mjs` 编译 `magpie-core.exe` 随本体发布；删除下载官方二进制的 fetch 脚本；打包前置检查改为构建；版本串带 `-heming.` 可辨认 |
| [specs/2026-11-07-d95-adopt-existing-magpie.md](superpowers/specs/2026-11-07-d95-adopt-existing-magpie.md) | **d.95 采用本机已有 magpie**：启动前先 `/api/hello` 探活，已有实例则接入不 spawn（external 状态、stop 不杀外部进程）；设置页分「运行中/已接入」两套文案与按钮 |
| [specs/2026-11-07-d94-drop-anthropic-and-price.md](superpowers/specs/2026-11-07-d94-drop-anthropic-and-price.md) | **d.94 清掉 provider 死代码**：删 Anthropic 协议实现与前缀缓存（llmAnthropic/promptCache 及测试）、llmClient 重写为 OpenAI 单协议；删价格表与 `cheap` 档（smart 改 0.65/0.35）；插件目录 DTO 的 `llmPresets` 收尾 |
| [specs/2026-11-07-d98-pet-as-plugin.md](superpowers/specs/2026-11-07-d98-pet-as-plugin.md) | **d.98 桌宠拆成界面插件**：新增第二类包 `desktopWidget`（v4 `distribution: "bundle"`）——`package.tgz`（确定性 tar/gzip）+ 主进程安装落盘 + 独立 origin `widget://<id>` 渲染 + 最小 preload + `widget:*`/`widgets:*` 通道契约；桌宠迁到 `packages/pet-widget`，主程序删除 pet 入口/pixi/5MB 模型；老 `pet-state.json` / `heming.pet.v1` / `heming.pet.presence.v1` 一次性迁移；云端目录新增 `GET /api/plugins/:id/:version/package` |
| [plans/2026-11-07-d98-pet-as-plugin.md](superpowers/plans/2026-11-07-d98-pet-as-plugin.md) | d.98 实施计划：契约 → 宿主运行时 → 插件包迁移 → 主窗插件区/设置/删桌宠 → 分发与门禁，附明确不做（第三方界面插件/多 widget/签名/宿主代发） |
| [specs/2026-11-07-d92-bundled-magpie-component.md](superpowers/specs/2026-11-07-d92-bundled-magpie-component.md) | **d.92 内置 magpie 原生组件**：构建时下载并 SHA256 校验 CLI（约 73MB，不进仓库）、主进程托管启动/探活/整树回收、本机回环反代（来源白名单 + 清 Origin + SSE 直通）、渲染层桥与 `source=desktop/manual` 网关语义、设置页内置状态区块；含桌面/渲染层测试与打包前置检查 |
| [specs/2026-11-07-d90-magpie-native-model-layer.md](superpowers/specs/2026-11-07-d90-magpie-native-model-layer.md) | **d.90 magpie 内化为原生模型层**：删除服务商预设 / 协议选择 / 手填 BaseURL+Key / 逐连接 Key 与旧绑定候选链（一次性清除）；模型目录改由本机 magpie 网关 `/v1/models` 提供，绑定与候选链只绑模型；设置区换成网关卡；收回插件 v4 模型预设 |
| [specs/2026-11-07-d88-cloud-plugin-catalog.md](superpowers/specs/2026-11-07-d88-cloud-plugin-catalog.md) | **d.88 云端插件目录（插件独立分发）**：插件包不随安装包（desktop 打包守卫）；服务端目录 `GET /api/plugins` + 原样清单 + `X-Plugin-Sha256`；客户端「从云端浏览」下载并**校验指纹**后走既有安装预览；清单 v4 新增 `contributions.llmPresets`（只填地址/模型、strict 拒绝 apiKey、主机须被权限覆盖）；落地 `plugins/magpie-gateway` 与 `plugins/infohub-collector` 两个独立包 |
| [specs/2026-11-07-d85-magpie-module-and-infohub-plugin.md](superpowers/specs/2026-11-07-d85-magpie-module-and-infohub-plugin.md) | **d.85 magpie 移植收口 + InfoHub 采集插件**：magpie 选路语义全量移植为内置模块「模型路由」（八档策略、模块闸门、页面、设置区只留入口）；InfoHub 增加本机 HTTP MCP 采集桥（`infohub mcp`，回环 + CORS + Host 校验 + 端口冲突即失败）与 `plugins/infohub-collector` 声明式插件包；含测试、守卫用例与真实浏览器验证 |
| [specs/2026-11-07-d77-plugin-optimization.md](superpowers/specs/2026-11-07-d77-plugin-optimization.md) | **d.77 插件优化轮**：插件列表搜索 + 状态筛选 + 空态 + 安装后定位高亮；详情未声明贡献类别灰置；**权限 `tools` 上限落到注入点**（此前只在目录展示，模型实际仍拿到写工具）；清单/注册表两处地址校验不一致（大写协议半安装、默认端口 443/80 误判未声明）；附真实浏览器证据与 5 条「只记录未修」的后续候选 |
| [specs/2026-11-07-heming-core-audit-round1.md](superpowers/specs/2026-11-07-heming-core-audit-round1.md) | **本体第一轮（d.78）**：两名只读审计员用真实浏览器逐页点六页（36 条带证据问题），本轮修 14 条——首跑/未绑定 CTA 直达「模型」页签、会话头通道文案、首页团队用量接真数据、按日期只列到今天、团队日程出口、插件「接口区」旧名与预置恢复、软件更新空白卡、记忆区导出/置信度/ID、主题色命名与更新日志上限；附未做清单与维护约束 |
| [specs/2026-11-07-heming-core-round2.md](superpowers/specs/2026-11-07-heming-core-round2.md) | **本体第二轮（d.79）**：刷新恢复当前页与会话——当前页 + `activeConversationId` 落 `sessionStorage`（刷新保留、重启回主页），写盘收口在 store 订阅；附「为什么不是路由」决策、失效会话回落空态、插件区工具描述去 Markdown 与模块「全部恢复启用」反馈；含未做候选 |
| [specs/2026-11-07-heming-core-round3.md](superpowers/specs/2026-11-07-heming-core-round3.md) | **本体第三轮（d.80）**：宿主页 Tab 刷新恢复——`lib/sessionState.ts` + `useSessionTab`，团队/智能体/插件区/记忆区四处 Tab 刷新后留在原地（与页面同一口径：刷新保留、关窗清空、白名单校验脏值）；附测试隔离（每例清 sessionStorage）与模块 Tab 术语落地 |
| [specs/2026-11-07-heming-core-round4.md](superpowers/specs/2026-11-07-heming-core-round4.md) | **本体第四轮（d.81）**：用户版发布说明 + 记忆区入口摩擦——新增 `docs/RELEASE-NOTES.md` 与 `generated/releaseNotes.ts`（工程 CHANGELOG 与用户版说明两读者两文件，未收录版本只给指路不回退细节）；设置·关于与首页最近更新改用用户版标题；记忆区「数据库」提示条就地给选择器、个人知识库徽标不再写死 0 |
| [specs/2026-11-07-heming-core-round5.md](superpowers/specs/2026-11-07-heming-core-round5.md) | **本体第五轮（d.82）**：第一次配模型少绕两圈——`UnboundModelNotice` 支持「本机已有连接」时就地选择并写绑定（对话页接入，选中即提示消失、发送可用）；模型 Tab 点服务商预设后填好 4 项并聚焦 API Key、首跑说明保留；附任务区暂不改的边界与「不做隐式 fallback」的理由 |
| [specs/2026-11-07-heming-core-round6.md](superpowers/specs/2026-11-07-heming-core-round6.md) | **本体第六轮（d.83）**：会话阅读位置恢复——`lib/chatScroll.ts` 按会话把 scrollTop/是否贴底/窗口存进 sessionStorage（刷新保留、关窗清空），切回/刷新回到那一屏、贴底仍跟随最新；配合窗口化逐窗展开、首帧 rAF 重试；只存位置不存正文，脏值回落 null |
| [specs/2026-11-07-heming-core-round7-home-workbench.md](superpowers/specs/2026-11-07-heming-core-round7-home-workbench.md) | **主页改版（d.84）**：按用户功能优先级先做主页——新增「需要你处理」（HITL/运行中任务/未读通知，全部可点直达）与「最近对话」；统计卡改可点动作指标；删在线成员/最近更新/系统状态三块收敛为页脚；Token 空态折叠、团队数据失败显示「—」并给刷新；含主页专项审计摘要与明确不做项 |
| [specs/2026-11-07-heming-core-round8-agent-taskarea.md](superpowers/specs/2026-11-07-heming-core-round8-agent-taskarea.md) | **智能体应用第一轮（d.86）**：任务区稳定化——选中运行记录落 sessionStorage（切 Tab/刷新不丢）、1100 窄窗三栏收敛且「开始运行」吸底可见；新增 `lib/runAbort.ts` 登记表让汇总卡能「停止运行」（找不到执行者如实说明）；会话头三个图标补 tooltip；含审计 P1 对照与明确未做项 |
| [specs/2026-11-07-heming-core-round9-agent-roster.md](superpowers/specs/2026-11-07-heming-core-round9-agent-roster.md) | **智能体应用第二轮（d.87）**：名册 ≥5 个出现搜索（名称+简介，无结果可清空）、系统/自建分组标题、编辑按钮常显；任务详情未绑定提示去重（中栏有 ChatPage 时右栏不重复）；复制报告失败给可执行说明；含“不静默失败”的取舍 |
| [specs/2026-11-07-heming-core-round10-team-presence.md](superpowers/specs/2026-11-07-heming-core-round10-team-presence.md) | **团队第一轮（d.89）**：审计 P1 两条半——应用级在场轻连接（`useAppPresence`，登录后保活 WS，「人在应用里就算在线」）、共享开关「关掉≠撤回」统一说明与关闭提示、动向空态分流、成员详情补动向条数/用量、单用户账号来源说明、首页动向条落到成员；含「为什么在客户端补连接」的方案对比 |
| [specs/2026-11-07-heming-core-round11-team-deeplink.md](superpowers/specs/2026-11-07-heming-core-round11-team-deeplink.md) | **团队第二轮（d.91）**：首页动向条目从「定位到人」补到「定位到那一条」——`teamFocusActivityId` 一次性投递 + TeamPage 消费（切回动向、滚到该行、高亮 2.4s、读走即清）；看板空态压缩；团队隐私口径从 4 处收敛到共享条 + 各视图特有边界 |
| [specs/2026-11-07-heming-core-team-workspace.md](superpowers/specs/2026-11-07-heming-core-team-workspace.md) | **团队工作台（d.93）**：用户自建团队——名字/目标/方案/任务/成员仅成员可见；shared 契约 + 4 表 + 内存/SQLite 双 Store + 13 条 REST（非成员 404、owner 403、指派与归属校验、级联/解绑）；团队页新增「工作台」Tab（目标编辑、成员、方案、任务、上传交付物复用共享文件）；智能体 9 个 `team_*` 工具（读自动、写走 HITL，删除类不开放） |
| [specs/2026-11-08-team-optimization.md](superpowers/specs/2026-11-08-team-optimization.md) | **d.112 团队功能优化**：四路调研（前端静态 / 真机浏览器 / 服务端契约 / 历史待办）→ 16 项修复——派任务交付物静默丢失（契约+双 Store+工具）、截止时间按本地时区显示、工作台刷新与静默轮询、深链意图清理与高亮褪去、动向组合游标（同刻不丢条目）、双 Store 排序统一、日程自由文本收口（UI 派生 + 写侧白名单）、成员详情近 3 条与排行可点、看板复用宿主数据且筛选互通、动向/看板条目可点、应用内确认框、共享撤回口径、HITL 团队工具展示名、非 owner 隐藏编辑入口；附明确不做项 |
| [specs/2026-11-07-plugin-repository.md](superpowers/specs/2026-11-07-plugin-repository.md) | **云端插件仓库（d.96）**：一份仓库 + 公开读 / 发布密钥写接口（GET 目录/全版本/manifest、PUT 发布、DELETE 下线，未配置密钥时写接口 503）；插件区「仓库」Tab 与插件页「下载安装」弹窗（搜索、已装/可更新、权限与贡献，安装走 sha256 校验后进同一预览）；`publish-plugin.mjs --push` 直接推云端；`plugins-catalog/` 不入库 |
| [specs/2026-11-08-update-progress.md](superpowers/specs/2026-11-08-update-progress.md) | **关于页更新进度条（d.99）**：主进程订阅 electron-updater `download-progress` → 状态快照 `progress`（percent 夹紧、重查/重下清空、dispose 摘监听）→ 既有 `update:state` 推送；UpdateCard 渲染 `role=progressbar` 与「已下载 N%（x/y MB · 速度）」 |
| [specs/2026-11-05-nav-layout.md](superpowers/specs/2026-11-05-nav-layout.md) | **d.72 导航分组重排与页面布局收口**：9 个导航项按「工作台 → 智能模块 → 资料与能力 → 系统」重排并加组间细线；老默认顺序迁移、自定义顺序保留、Alt 键位不变；设置区正文/标签/搜索收进 760px 居中列；信息中枢浏览器空态真正垂直居中；d.73 收尾把幕僚/自动化空态改为剩余空间垂直居中、主页「近 30 日用量」并入 Token 用量卡。附真实浏览器多档宽度截图证据与不做清单 |
| [specs/2026-11-04-d70-pluggable-modules.md](superpowers/specs/2026-11-04-d70-pluggable-modules.md) | **d.70 内置能力模块可插拔**：幕僚 / 信息中枢 / 自动化改为插件区「模块」Tab 的开关；模块注册表 + `heming.modules.v1` + 依赖语义（自动化依赖信息中枢）+ 导航/路由/首页卡/命令面板/设置/后台循环/工具注入/边车的接线矩阵；第三方页面贡献明确不做；d.74 补命令面板「模块管理」直达入口（含实际生效数） |

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
| [research/2026-11-03-n8n-engine-notes.md](research/2026-11-03-n8n-engine-notes.md) | n8n 工作流引擎一手源码调研（2.46.0 / `bb832f1`，180 处 `file:line` 已校验）：执行栈、重试默认值与硬边界、节点注册表、执行记录两级清理、调度 misfire/去重、表达式与超时；含「可移植/需改造/不可移植」判断表与 8 条候选改进 |
| [research/2026-11-03-n8n-license-and-reuse.md](research/2026-11-03-n8n-license-and-reuse.md) | n8n 许可证事实与复用边界：Sustainable Use License 1.0（fair-code，非 OSI 开源）、核心包全为 SUL、npm 发布物许可被改写、2019 起从未 OSI 开源；结论「不复制代码、只借概念」，附可直接抄的「来源与许可」声明模板 |
| [research/2026-11-03-heming-automation-audit.md](research/2026-11-03-heming-automation-audit.md) | 和鸣自动化子系统审计（d.48 现状）：能力表、红线原文、存储键与内存态、动作注册表/重试/运行记录/失败通知四块的精确扩展点（`file:line`）、通知中心 API、测试约定与 14 条风险坑；推荐方案 B |
| [research/2026-11-03-d68-ux-solutions.md](research/2026-11-03-d68-ux-solutions.md) | d.68 体验方案调研（19 个来源，外部资料仅参考）：透明窗拖动残影/放大裁切的机理与修法、侧栏自动隐藏的竞品默认值表（热区/延迟/动效/键盘）、中文桌面字体栈与字号行高、低门槛创建流程（模板预填/渐进披露/空态三件事）；含 6 条未核实项 |
| [research/2026-11-08-plugin-system-benchmark.md](research/2026-11-08-plugin-system-benchmark.md) | DeepSeek Harness 官方插件体系对标调研（`fcc0ad46`）：三层实体/注册即 effect/贡献点/引导式安装/市场索引/信任立场 + 和鸣四套机制审计、差距矩阵与「可借鉴 7 / 需改造 6 / 不照搬 7」 |
| [research/2026-11-08-plugin-upgrade-feasibility.md](research/2026-11-08-plugin-upgrade-feasibility.md) | 插件升级**可实现性自检**（代码探针 + 可运行实验）：5 段版本比较、zod 4.6.7 的 JSON Schema 丢 refine、v5 strict 的破坏性、安装事务与内存态 reload、清单/索引体积实测、首方签名现状（bundle 实际不验签）、市场索引 225KB 实测；附 F1–F10 规格修正清单与「最小可验证切片」 |
| [research/2026-11-08-plugin-ecosystem-cross-reference.md](research/2026-11-08-plugin-ecosystem-cross-reference.md) |
| [research/2026-11-08-plugin-audit-round.md](research/2026-11-08-plugin-audit-round.md) | 插件/技能社区**对抗审计**（只读，2 P0 + 8 P1 + 10 P2，逐条 `file:line`）：签名不覆盖代码、卸载无事务、包可覆盖、启停写失败被吞、外链可点击 XSS、register 无限流、兼容口径不一致、坏 v5 记录降级、技能池预算口径；除正式公钥外已在 d.111.3.43.0 修复 | 插件生态**横向对标**（VS Code / Chrome / Claude Code / Dify / n8n / Figma / Obsidian / Raycast）：贡献点/懒激活、版本兼容三策略、索引-制品-工具链三分离、Dify 三段式安装事务、签名信封与 TUF-lite、开发沙箱三范式；产出 N1–N14 设计增量与证据缺口 |

## 5. 历史计划

`docs/superpowers/plans/` 下的实施计划按日期归档，反映当时的任务拆分与验收口径；现状以 [HANDOFF.md](HANDOFF.md) 和代码为准。
