# 和鸣 · 新会话交接文档

- 日期：2026-10-18
- 当前 main：以 `git log -1` 为准（2026-10-18 校准时为 `d15abac`，之后仅文档提交）
- 本文用途：给新开的协作会话快速接手——现状、约定、红线、下一步

---

## 1. 项目是什么

**和鸣**：原生桌面端（Electron）智能体应用平台 = 云端服务器（IM 即时通讯 + 智能体名册）+ 桌面/网页客户端。
定位：个人智能体工作台——与人类/智能体聊天协作，管理模型接口、工具接口与记忆知识库。

- **架构红线（不可违背）**：智能体**本地驱动**（本机系统提示词 + 本机 LLM Key 直连供应商 + 本机执行），云端**只是 IM 桥梁**；个人数据（Key/记忆/知识库/本地文件）**不出设备**。
- **E2E 红线（2026-10-17 起）**：消息与附件端到端加密，**服务端只见信封**（密文 + 公开元数据）；无安全上下文时**拒绝发送，绝不降级明文**。
- 参考项目：`D:\MultiAgent`（合鸣 Ensemble）——借鉴架构，不复用代码；调研报告见 `docs/superpowers/research/2026-10-17-multiagent-study.md`（40 条可借鉴点 + 10 条 Agent 阶段任务草案）。
- 领域深化文档：智能体（记忆/技能/上下文预算）的代码地图、数据流与避坑见 `docs/superpowers/2026-10-18-agent-handoff.md`。

## 2. 当前状态（已完成并上线）

| 项 | 状态 |
|---|---|
| main | 见 `git log -1`（工作区干净） |
| 测试 | shared 63 / server 169 / web 617 / desktop 19 全绿（`pnpm -r test`） |
| 线上 | `http://47.92.39.184` 已部署最新版（`docker compose -p heming`） |
| 安装包 | `packages/desktop/release/和鸣 Setup 0.0.1.exe`（78.3 MB，含全部功能） |
| 账号 | `admin/admin`、`zhoukang/zhoukang`（服务端 `/root/heming/.env` 的 `HEMING_SEED_USERS` 播种；注册功能默认关闭） |

### 已完成里程碑

1. **M1 骨架**：monorepo（shared/server/web/desktop）、三栏壳与视觉规范、账号/好友/1:1/WS 实时、共享文件库。
2. **M2 IM 完善**：SQLite 固化、群聊、预设混合群、已读回执；**圆形雷达通讯录**（圆心我 + 三扇区，悬浮信息卡）。
3. **M3 智能体**：智能体名册 CRUD、本机 LLM 连接（Key 存 localStorage）、群内 @ 流式回复（本地驱动·云端桥梁）、入群接线。
4. **M3.5 UI 完善**：主页近 30 日 Token 热力图；聊天头部头像+三横线信息卡；输入栏表情/图片/文件/语音；雷达点击进详情页 + 分组竖列。
5. **M4 文件完善**：共享文件 Store 持久化、投递到会话、预览（文本/Markdown/图片）、每用户存储配额（`HEMING_FILE_QUOTA_MB`，默认 200MB）。
6. **二期 IM**：消息撤回（含四处内容旁路屏蔽）、回复引用、消息转发、语音消息、表情回应（事件化）；遗留收尾（他机流 watchdog、重连补已读、群消息头像）；导航图标列垂直居中。
7. **E2E 端到端加密**（前向保密棘轮）：P-256 ECDH + HKDF 链 + AES-256-GCM（零依赖 WebCrypto）；信封入库、服务端内容逻辑客户端化（回应=加密事件消息）、本地明文缓存、明文存量自迁移、附件加密、Electron 安全上下文白名单。
8. **智能体记忆/技能/上下文**（另一会话交付）：三层记忆（Working/Episodic/Semantic，本机 localStorage）、技能池（4 内置技能 + 导入导出 + 路由预览）、上下文预算与早期对话压缩（供应商上下文超限自动收紧重试 ≤2 次）。入口：**记忆区 Alt+4**、设置区「上下文预算」卡片。

## 3. 仓库结构与关键文件

```
packages/
├── shared/src/schemas.ts     # 协议单一真源：Message（enc/cipher/chainKid/n/recalledAt）、
│                             #   MessagePayload（text/mentions/file/forward/reactions）、WS 事件（双向）
├── server/src/               # Express5 + ws + node:sqlite
│   ├── app.ts                # REST：auth/profile/agents/conversations/files(+usage)/e2e keys/reencrypt
│   ├── ws.ts                 # send_message(明文|e2e)/mark_read/recall_message/agent_chunk|finish|error
│   ├── store.ts + sqliteStore.ts  # Store 双实现（契约测试双跑）；幂等 ALTER 迁移在 db.ts
│   └── db.ts                 # CREATE TABLE IF NOT EXISTS + PRAGMA 检查后 ALTER
├── web/src/
│   ├── lib/e2eCrypto.ts      # 密码核心：HKDF 棘轮/X3DH/GCM（纯函数，向量测试）
│   ├── lib/e2eSession.ts     # 会话层：链管理/封解密/乱序队列/本地明文缓存/去重
│   ├── lib/agentStream.ts    # @ 触发编排：TriggerDeps 6 可选钩子（seal×3 + buildSystemPrompt/onTurnComplete/prepareHistory）
│   ├── lib/agentContext/     # 上下文预算与压缩（另一会话交付）
│   ├── lib/{memory,skills,agentRuntime}/  # 三层记忆/技能池（另一会话交付）
│   ├── components/ChatPage.tsx   # 聊天主页面（收发/流式/撤回/回复/转发/语音/表情/加密）
│   ├── components/{RadarContacts,ContactColumn,ContactDetail}.tsx  # 通讯录
│   └── store/{chat,ui,llm,auth,tokenUsage}.ts
└── desktop/                  # Electron 壳：main.js + secure-origins.js（HTTP 源安全上下文白名单）
```

**本机存储键**（localStorage）：`heming.token` · `heming.llmConfigs` · `heming.agentLlm` · `heming.agentPrompts` · `heming.tokenUsage` · `heming.e2e.*`（身份/链/去重/新鲜度） · `heming.msgCache.*`（明文缓存） · `heming.memory.*` / `heming.skills` / `heming.skillBindings` / `heming.context*`（记忆/技能）。

## 4. 工作方式约定（沿用）

- **文档驱动**：先写设计规格（`docs/superpowers/specs/`）与实施计划（`docs/superpowers/plans/`），再动手。
- **子代理驱动执行**（superpowers:subagent-driven-development）：每任务一个实现者 → 任务评审（规格+质量）→ 修复轮（≤5）→ 整分支终审 → 合并。账本在 `.superpowers/sdd/<plan>/`（gitignored）。
- **测试门禁**：`pnpm -r build && pnpm -r test` 全绿才提交；shared 改契约后先 `pnpm --filter @heming/shared build`。
- **视觉规范**：无 emoji 图标（细线 SVG 1.5px，emoji 仅作消息内容）；分割线浅灰 `#e6e6e6`/`#ececec`；界面 chrome 不显示产品名「和鸣」；中文文案。
- **部署流程**：见 `docs/deploy.md`；本地 tar（排除 node_modules/.git/.superpowers/dist/.worktrees/data/release/.claude/@hemingdesktop）→ 上传 `/root/heming` → `docker compose -p heming build && up -d` → 冒烟验证。SSH 脚本在 `.superpowers/*.py`（gitignored，含凭据）。
- **`@hemingdesktop/`**：electron-builder 偶发落在仓库根的产物目录（已 gitignore；被系统句柄占用时删不掉，重启后可删）。

## 5. 下一步候选（未完成工作）

**二期主线**（总规格 `2026-10-13-heming-platform-design.md` §9）：
1. **MCP 接口区**：stdio/HTTP transport、命名空间前缀注册、渐进发现、白名单外危险操作 HITL 确认（参考调研报告 §3）。
2. **harness 桥接**：本机 CLI 探测（9 种注册表）+ `spawn(shell:false)` 进程管理 + Windows 进程树清理 + 危险命令三层围栏（调研 §4）。
3. **本地 RAG 知识库**：递归分块 + 中文 bigram BM25 + 可注入 EmbedFn（本地 Ollama/已配 Key 供应商）+ RRF 混合检索（调研 §2）。
4. **1:1 智能体会话**：单用户↔单智能体多轮流式对话（复用既有 ws 与 agentStream）。
5. **Token 团队视图 / 按日期跨端汇总**：需服务端汇总（当前仅本机聚合，参考调研 §6）。
6. **群管理**：成员删减/踢人 UI、群主权限。

**技术债/遗留**（各批次终审均裁定「可留后续」，详见对应计划文件与账本注释）：
- 撤回时限与「撤回占位原文」；表情回应种类数封顶（服务端未限 20 种）；语音消息转文字；转发嵌套深度限制；上传进度条；会话级文件 ACL；CSP；Electron safeStorage（密钥落盘加密）；网页端 HTTPS 化。
- 已知语义变化：**新入群成员只能解密加入之后的消息**（无密钥恢复模型的必然结果）；**旧客户端/纯浏览器（HTTP）无法发送**（安全上下文要求，桌面端经白名单解决）。

**跨会话协作**（另一会话正在做记忆/技能方向）：约定边界为「不改 shared/server/WS/消息契约」；其 worktree 在 `D:\Heming\.claude\worktrees\xenodochial-aryabhata-24defe`。若新工作要动 `TriggerDeps`/`ChatPage`/`agentStream`，先对齐接口（当前 TriggerDeps 共 6 个可选钩子）。

## 6. 快速上手命令

```bash
pnpm -r build && pnpm -r test      # 全量门禁
pnpm --filter @heming/web dev      # 本地前端（:5173，代理到本地 server）
pnpm --filter @heming/desktop dist # 重打安装包
```

线上验证：`curl -s http://47.92.39.184/api/health`；登录 `POST /api/auth/login {"username":"admin","password":"admin"}`。
