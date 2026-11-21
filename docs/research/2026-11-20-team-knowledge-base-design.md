# 和鸣「个人知识库 + 团队知识库 + 知识库页开接口」设计方案

> 日期：2026-11-20　｜　状态：**Phase A（服务端底座）+ Phase B（"看"半边）+ Phase C（双向分享：收藏到个人库 / 发布到团队）均已实施并通过测试**；B 的团队文档编辑受控改造（三态编辑器）待实施
> 背景：用户诉求（m00272）——"用户自身有个知识库，还要团队内有个知识库，在知识库页开接口，看看该怎么做"。
> 同时确认的约束：**智能体不作为团队成员**（智能体存储在用户本地、使用用户自己的 API），故智能体不直接连服务端知识库。
> 事实来源：`kb-be-explorer` / `kb-fe-explorer` 只读调研（前后端现状见下），配套文档 `2026-11-20-team-collaboration-research.md`、`2026-11-20-team-collaboration-products-features.md`。

---

## 0. 一句话结论

**个人库保持本地（磁盘 Markdown，IPC，永不自动上传）；团队库存服务端（新表 `team_knowledge_docs`，按 `team_id` 隔离，成员可见）；扩展知识库页右上角现有的「切换知识库」下拉框，把团队作为可选项加进去（默认项显示「个人知识库」），并配显式"发布到团队 / 收藏到个人"双向动作（不自动同步）。** 智能体仍是用户本机的能力，读取团队资料须经"人以成员身份取回 → 落到个人库 → 本机检索"的路径，不给智能体独立的服务端身份。

---

## 1. 现状盘点（调研结论）

### 1.1 服务端：没有"知识库"这回事

- `packages/server/src/db.ts:25-118` 的全表清单**无 knowledge 表**；`app.ts` **无知识库 REST 路由**。服务端 SQLite（`resolveDbPath()`，`db.ts:12-14`）只管用户/会话/文件/团队。
- 项目里的"知识库"是两套**与服务端无关**的东西：
  1. **本地原生 vault**：`packages/desktop/vault-fs.js` + `~/Heming/vaults.json` 注册表，磁盘 Markdown 文件，走 Electron IPC（`vault:list/read/write/apply/watch` 等通道）。**纯本地、天然隐私**。
  2. **agent-pipeline RAG 服务**（Python，独立 SQLite）：`services/agent-pipeline/src/agent_pipeline/memory.py:77-100` 的 `documents / chunks / episodic` 表，`MemoryStore(path=":memory:")` 默认内存（`memory.py:112-129`）；`POST /v1/knowledge` 等（`service.py:534-547`，Bearer `AGENT_SERVICE_TOKEN`）。它是**用户机上智能体的检索后端**，不是团队共享存储。
- 文件分享机制：`shared_files`（`db.ts:71-74`，整文件 base64 存 SQLite，按 owner 计 200MB 配额），路由 `GET/POST/DELETE /api/files`（`app.ts:1809-1875`，全部 `authOnly`）。**但它是"全站登录可见"口径**（`app.ts:1270` 注释：`GET /api/files` 列全部文件、内容无属主校验，仅删除校验属主）——**不可直接拿来当团队知识库**，否则非成员也能读。
- 团队隔离的成熟模式可复用：`visibleTeam()` / `teamMemberRole()` / `isTeamOwner()`（`sqliteStore.ts:439-459`），非成员返回 null → 路由层 404 不泄露存在性；`team_*` 表带 `team_id`、刻意不建外键、级联在 Store 事务里做（`db.ts:147-151`）。

### 1.2 前端：知识库页完全围绕本地 vault

- 主组件 `packages/web/src/components/knowledge/KnowledgePage.tsx`（1264 行），三栏布局（注释 `:53-68`）：左=库下拉 + 文件树/搜索/标签三页签（`LeftTab`，`:92`，页签 `:793-809`）；中=打开文件标签页 + 编辑器 source/split/read 三态（`:966-983`）+ GraphPane；右=反链/出链/大纲/属性。页头动作 `:659-739`（切库、新建、日记、图谱、设置、打开其它库、移除）。
- 入口：侧栏"知识库"（`SidebarNav.tsx:25-31/55`，`page="vault"`）；命令面板 4 个动作（`lib/palette/actions.ts:67-89`）；无全局快捷键（仅页面级 Ctrl/⌘+O 快速切换，`:535-547`）。
- **API 现状**：知识库内容读写**全走 IPC 桥** `window.__heming_vault`（`bridge.ts:46-51`；方法清单 `types.ts:246-285`：list/pick/remove/rename/tree/read/readBinary/write/apply/create/createDir/move/delete/reveal/watch）。`api.ts` 里只有周边文件 API（`fetchFiles:302`、`uploadFile:665` 等）和团队 API（`fetchWorkspaceTeams:410` 等）。**没有任何团队/共享知识库字段**。
- 唯一"云端共享"痕迹：`lib/memory/kb.ts` 的 localStorage 个人 KB（`KB_KEY="heming.kb.v1"`，`addCloud()/hasCloud()` `:73-115`），**无 UI 消费者**——可作为"团队条目收藏进个人库"的去重辅助，但不是团队库本体。
- 状态：`zustand useVaultStore`（`store.ts:231-834`）；**无轮询**，靠 `bridge.watch` 订阅（`:742-757`）→ `reindexPaths` 增量（>200 路径全量重建，`REINDEX_INCREMENTAL_MAX=45/684`）；索引分片 32 批 + `requestIdleCallback`。
- 智能体检索入口：`vault_search/vault_read/vault_write`（`providers.ts:57-70` 默认注入，`vault_write` 需 HITL），提示词 `"先检索再回答"`（`runtimePrompt.ts:213-221`），上下文注入 `context.ts:173-187`；RAG 工具 `knowledge_search`（`tools.py:533-564`，结果带 citations）——**都是本机侧**。

### 1.3 结论：缺口在哪

| 需求 | 现状 | 缺口 |
|---|---|---|
| 个人知识库 | ✅ 本地 vault，功能完整（树/搜索/标签/双链/图谱/画布） | 无 |
| 团队知识库 | ❌ 服务端无表、无路由、前端无入口 | 全部 |
| 知识库页"开接口" | 只有 IPC 本地接口，无 REST/团队接口 | 扩展右上角「切换知识库」下拉（默认「个人知识库」+ 团队选项）+ REST 适配 + 显式分享动作 |
| 智能体用团队知识 | 智能体本机、用用户 API | 不建 Agent 身份；改为"人取回→个人库→本机检索" |

---

## 2. 设计原则

1. **个人库永远本地**：不自动上传、不镜像到服务端；隐私是和鸣卖点。
2. **团队库显式共享**：只有用户主动"发布"的内容进服务端；发布可撤销。
3. **按团队硬隔离**：一切团队库请求带 `teamId`，服务端用 `visibleTeam()` 校验，非成员 404。
4. **不复用 `shared_files` 的全站可见口径**：团队库用独立表（见 3.1）。
5. **智能体无服务端身份**：智能体=用户本机能力，团队资料经人流转，不给 Agent 成员记录/账号/直连服务端知识库的权限。
6. **复用现有 UI**：团队库尽量复用 KnowledgePage 的文件树/编辑器/搜索组件，避免造第二套。

---

## 3. 服务端方案

### 3.1 数据模型（新增表）

```sql
-- 团队知识文档：用户显式发布的摘要/文档，按团队隔离
CREATE TABLE team_knowledge_docs (
  id            TEXT PRIMARY KEY,
  team_id       TEXT NOT NULL,             -- 复用 teams.id，隔离边界
  author_id     TEXT NOT NULL,             -- 发布人（人类用户）
  title         TEXT NOT NULL,
  content       TEXT NOT NULL,             -- Markdown 正文（用户显式发布）
  source_vault  TEXT,                      -- 来源个人库 id（仅标签，不自动同步）
  tags          TEXT,                      -- JSON 数组
  pinned        INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_tkd_team ON team_knowledge_docs(team_id, updated_at DESC);

-- FTS5 检索（与既有 FTS5 trigram 方案一致，按 team_id 过滤）
CREATE VIRTUAL TABLE team_knowledge_fts USING fts5(
  title, content, tags,
  content='team_knowledge_docs', content_rowid='rowid',
  tokenize='trigram'
);
```

- 刻意**不建外键**（沿用 `db.ts:147-151` 约定），删除团队时在 Store 事务里级联删 docs + fts。
- 不存向量、不做服务端 RAG：智能体在用户本机，检索需求由"取回到个人库后本机 RAG"满足（见第 5 节）。

### 3.2 REST 路由（`app.ts`，全部 `authOnly` + `visibleTeam` 成员校验）

| 方法 | 路径 | 说明 | 权限 |
|---|---|---|---|
| GET | `/api/team/:teamId/knowledge` | 列表（id/title/author/tags/updated/pinned），支持 `?q=` 走 FTS、`?limit=&cursor=` 分页 | 成员 |
| GET | `/api/team/:teamId/knowledge/:docId` | 读单篇 Markdown 正文 | 成员 |
| POST | `/api/team/:teamId/knowledge` | 发布新文档（body: title/content/tags/sourceVault） | 成员 |
| PUT | `/api/team/:teamId/knowledge/:docId` | 更新（作者本人或 owner） | 作者/owner |
| DELETE | `/api/team/:teamId/knowledge/:docId` | 删除并撤销共享（作者或 owner） | 作者/owner |
| POST | `/api/team/:teamId/knowledge/:docId/pin` | 置顶（owner） | owner |

- 所有写入经 `packages/shared/src/schemas.ts` 的 Zod 白名单（title/content 长度上限、tags 数组校验），防越权字段注入。
- 非成员一律 404（复用 `visibleTeam()`），不泄露团队存在；未登录 401。
- 不提供"列出所有团队知识库"的全局端点（多团队但彼此独立）。

### 3.3 与现有模块的边界

- **不碰 `shared_files`**：它是全站可见的附件存储，继续只服务 `/api/files`；团队知识文档正文存新表。
- **不碰 agent-pipeline RAG**：Python 服务继续服务用户本机智能体，团队库不接入其 `documents/chunks` 表。
- **可复用**：`team_events` 记一条"XX 发布了团队知识《标题》"摘要（只记标题，不记正文——隐私白名单）；`kit` 里的 `FTS5 trigram` 索引方案复用。

---

## 4. 前端方案：知识库页"开接口"

### 4.1 界面：扩展右上角现有的「切换知识库」下拉框

**不新增分段控件**——直接扩展 KnowledgePage 页头右上角已有的 `<select aria-label="切换知识库">`（`KnowledgePage.tsx:659-670`，当前绑定 `store.activeVaultId`、切换走 `store.setActiveVault()`，`store.ts:356-380` 会清缓存/重建索引/重订阅 watch）。把它从"只列本地 vault"扩展为"个人库 + 各团队库"的统一选择器：

- **默认项 = 个人知识库**：下拉第一组是本地 vault（现状的 `store.vaults`），默认选中项展示名改为「个人知识库」（对应当前激活的本地 vault；若有多个本地库，用分组标题「个人知识库」下再列各库名，或把默认库直接命名/显示为「个人知识库」）。个人库行为完全不变（本地树/搜索/标签/图谱/编辑器）。
- **团队库作为新增选项**：下拉用 `<optgroup label="团队知识库">` 列出当前用户所在团队（数据来自 `fetchWorkspaceTeams` 一类已有 API；若团队很多，可只列已加入团队，或加"搜索团队"）。选中某团队即切到该团队知识库。
- **团队库视图**：选中团队后，左栏改为团队文档列表 + 全文搜索（不显示本地文件树/标签/图谱），中栏编辑器以 **read 模式**渲染团队 Markdown（复用现有编辑器组件，禁写本地），页头"新建笔记/日记/图谱/设置/打开其它库/移除"等个人库专属动作在团队库下隐藏或换成团队库动作（如"发布文档""收藏到个人库"）。
- **选择状态**：新增一个统一的选中值类型（如 `activeSource: {kind:"personal", vaultId} | {kind:"team", teamId}`），替代/包装现有 `activeVaultId`。团队选择复用 `lib/team/selection.ts` 的会话级选择（与看板/工作台共用一份切换状态），切队时列表/搜索/选中文档重置。
- **切换逻辑复用**：`store.setActiveVault()` 的"清缓存 + 重建索引 + 重订阅"模式保留给个人库；团队库走独立加载路径（`useTeamKnowledgeStore` 拉 REST 列表，见 4.3），但共用同一个下拉 onChange 入口，按选中值分派。

### 4.2 API 适配层（`packages/web/src/lib/api.ts` 新增）

```ts
fetchTeamKnowledge(teamId, {q, cursor, limit})   // GET 列表/搜索
fetchTeamKnowledgeDoc(teamId, docId)              // GET 正文
publishTeamKnowledge(teamId, {title, content, tags, sourceVault}) // POST
updateTeamKnowledge(teamId, docId, patch)         // PUT
deleteTeamKnowledge(teamId, docId)                // DELETE
```

### 4.3 关键取舍：复用 store 还是独立 store

- **推荐：独立 `useTeamKnowledgeStore` + 统一选择器入口**。本地 vault 的写语义（`write(vaultId,rel,text,{expectMtime})`、`apply()` 原子批量、`watch` 订阅）与团队 REST 的 CRUD 语义差异大，硬塞进 `VaultBridge` 会污染本地契约。独立 store 持有 `teamDocs/activeDoc/query`；但**右上角下拉是统一入口**，onChange 按选中值分派到 `setActiveVault()`（个人库）或 `teamStore.load(teamId)`（团队库）。KnowledgePage 的编辑器与列表展示组件改为受控 props 驱动，两种来源都喂给同一套组件。
- 备选：把团队库注册成一种 `VaultMeta`（`packages/web/src/lib/vault/types.ts:16-41` 加 `scope?:"personal"|"team"`、`teamId?`），让 `setActiveVault()` 直接也能切团队库——改动最小但会把 REST 语义混进 IPC 抽象，不推荐长期。

### 4.4 两个双向动作（显式、可撤销）

1. **发布到团队**（个人库 → 团队库）：在本地笔记编辑器加按钮 → 用户确认弹窗（显示将发布的标题、来源库，**明确不自动同步后续修改**）→ 前端用 `bridge.read()` 取当前笔记文本 → `publishTeamKnowledge()` → 成功后 `team_events` 记摘要。可选勾选"正文"或"仅摘要"两种发布形态。
2. **收藏到个人库**（团队库 → 个人库）：团队文档点"收藏到我的知识库" → 用 `bridge.write()` 落成本地 Markdown（建议写入 `_team/{teamName}/` 子目录）→ 复用 `lib/memory/kb.ts:addCloud()/hasCloud()` 做去重标记（记录来源 teamDocId，避免重复收藏）。收藏后本机智能体即可用 `vault_search` 检索这份内容。

### 4.5 命令面板与快捷键

- 新增动作须同步三处（现状惯例）：`lib/palette/actions.ts:67-89`、`ui.ts:169 VaultIntentKind`、`CommandPalette.tsx:434-446`，消费在 `KnowledgePage.tsx:552-575`。建议加："打开团队知识库""发布当前笔记到团队"。
- 可选：知识库页级快捷键 `Ctrl/⌘+Shift+T` 切团队库（与现有 `Ctrl/⌘+O` 快速切换同层，`:535-547`）。

---

## 5. 智能体边界（关键约束：不作为成员）

用户已明确：**智能体存储在用户本地、使用用户自己的 API**。因此：

- **不建 Agent 成员记录**：不进 `team_members`、不可被 @、无服务端席位/账号。
- **不给智能体直连团队库**：`vault_search/read/write` 与 `knowledge_search` 继续只查用户本机内容；服务端团队库没有让智能体调用的凭证。
- **数据流是"人取回"**：成员在知识库页读团队文档 → 点"收藏到个人库" → 本机智能体通过 `vault_search` 检索这份本地副本 → 产出由人审核后回填团队（与 `2026-11-20-team-collaboration-research.md` 的"本机执行 + HITL 回填"一致）。
- 若团队确需 AI 总结团队资料：由某个成员在本机对其**已取回的副本**执行，结果作为"人审核过的摘要"再发布回团队库，全程无 Agent 服务端身份。

---

## 6. 分阶段实施与验收

### Phase A：服务端底座（~3 人日）— ✅ 已实施
- 建 `team_knowledge_docs` + `team_knowledge_fts`（FTS5 trigram）；Store 双实现（内存 + SQLite）增删改查 + 级联删除 + 全文搜索；Zod schema（`TeamKnowledgeDocSchema` / `Create|UpdateTeamKnowledgeBodySchema`）；6 条 REST 路由 `GET/POST /api/teams/:id/knowledge`、`GET /api/teams/:id/knowledge/search`、`GET/PATCH/DELETE /api/teams/:id/knowledge/:docId` + 成员校验；新增 3 个 team event kind（knowledge_added/updated/removed）。
- 实施要点（与设计文档的差异）：FTS 采用现有 `messages_fts` 的"普通 FTS 表 + 应用层同步索引"风格（不建外部内容表/触发器）；行级权限=作者或 owner 可改删、普通队员只能读；权限判定全在 Store 的 `visibleTeam()`（非成员 → null → 404，不泄露存在性）；搜索 MATCH 只定位 doc_id 再回表并按 team_id 二次过滤，防跨团队串数据；`query <3` 字符回退 LIKE 线性扫描（与内存实现同口径）。
- 验收：非成员 404；成员可 CRUD；搜索按 team_id 隔离；删团队无孤儿。
- 验证证据：`pnpm --dir packages/shared run build` + `tsc --noEmit`（shared/server 均 EXIT=0）；`vitest run src/storeContract.test.ts -t 团队知识库` 8 通过（4 用例 × 双实现）、`vitest run src/teamWorkspace.test.ts -t 团队知识库 REST` 1 通过；全量 shared 122/122、server 476/476（20 文件）全绿（首轮一次 Windows node24 worker 0xC0000409 抖动，复跑消失）。
- 改动文件：`packages/shared/src/schemas.ts`、`packages/server/src/{db,store,sqliteStore,app}.ts`、`packages/server/src/{storeContract,teamWorkspace}.test.ts`。均为纯增量；与并行会话既存的 `priority`/`queryInt` 等改动共存未冲突。

### Phase B：知识库页接入（~4 人日）— ✅「看」半边已实施
已落地（本次）：
- 扩展右上角「切换知识库」下拉框：`<optgroup label="个人知识库">`（个人库 vault，默认）+ `<optgroup label="团队知识库">`（我加入的团队）。选中值 `personal:{vaultId}` / `team:{teamId}` 统一走 `selectSource()` 分派：个人库 → `store.setActiveVault()`（原语义不变），团队库 → `useTeamKnowledgeStore.load()`；切回个人库清团队内存。
- 新增 `useTeamKnowledgeStore`（`lib/team/teamKnowledgeStore.ts`）：团队列表、文档列表、全文搜索、打开单篇、请求竞态序号（切队/搜索并发只让最新落地）、reset。
- 新增 `TeamKnowledgeView`（`components/knowledge/TeamKnowledgeView.tsx`）：左栏文档列表 + 全文搜索框；中栏复用 `PreviewPane` 只读渲染 Markdown（不提供编辑器，防改正文）；空团队引导。选到团队时 `KnowledgePageShell` 整页换成该视图（个人库三栏零改动）。
- `api.ts` 新增 6 个 REST 封装（fetch/search/get/create/update/delete）。
- 配套修正：新增的 3 个 team event kind 在 `TeamActivityPanel.tsx`、`teamTools.ts` 的 `Record<TeamEvent["kind"],string>` 映射里补齐（否则 web tsc 报错），团队动态筛选新增「知识库」类。
- 验收：下拉默认「个人知识库」、个人库行为零回归（35 个 KnowledgePage 旧测试全过）；选团队后只显示该团队文档、搜索走 REST；只读无编辑框。
- 验证证据：web `tsc --noEmit` EXIT=0；新增 `TeamKnowledgeView.test.tsx` 3 用例全过；knowledge + api + TeamPage 定向 263 全过；**全量 web 468 文件 / 6770 测试全绿**。
- 尚未实施（Phase B 剩余）：编辑器受控组件改造（当前团队库用 `PreviewPane` 只读渲染，没复用编辑器的 source/split/read 三态）、团队库下页头个人专属动作的替换（已用团队专用 PageShell 简化处理）。

### Phase C：双向分享闭环（~3 人日）— ✅ 已实施（两个方向均为显式人工动作）

已落地（本次）：
- **收藏到个人库**（团队库 → 个人库）：`TeamKnowledgeView.tsx` 详情头新增「收藏到我的知识库」按钮，用 `useVaultStore.createFile()` 把团队文档写成 `_team/{团队名}/{标题}.md` 本地 Markdown（带 frontmatter：title/source:team/team/teamDocId/teamId/authorId/tags/syncedAt），成功后 `refreshTree()`、按钮置灰、路径提示；重复点击由 `favorited` 状态挡住。纯函数落在 `lib/team/teamKnowledgeShare.ts`：`safeFileName()` 去 Windows 非法字符补 `.md`、`favoriteRel()`、`favoriteMarkdown()`。本机智能体随后可用 `vault_search` 检索到这份人工取回的副本。
- **发布到团队**（个人库 → 团队库）：`KnowledgePage.tsx` 个人库页头新增「发布到团队」按钮（仅个人库 + 有活动笔记 + 已加入团队时出现）；`ConfirmDialog` 显示目标团队下拉并明确"只发布这一次快照、不会自动同步、智能体不能代发"；确认时校验无未保存修改 → `store.readText(activeRel)` 现读正文 → `createTeamKnowledge(teamId, {title, content, sourceVault})`，服务端记 `knowledge_added` 事件摘要。
- 验收：收藏写本地 `_team/` 路径（4 用例）、发布走 createTeamKnowledge 且脏数据拦截（2 用例）、纯函数 3 用例，均过；knowledge 全量 17 文件 / 203 测试全绿；web `tsc --noEmit` EXIT=0。
- 设计差异（相对原方案）：用 `vault_store.createFile()` 直接写本地文件，未走 `lib/memory/kb.ts:addCloud()` 去重（该文件是 localStorage KB、无 UI 消费者），去重改为前端 `favorited` 数组 + 同名路径提示；只做"正文全文"一种发布形态（原方案的可选"仅摘要"未做，可用标题/摘要另开）；命令面板动作未同步（两动作都有可见 UI 入口，非高频，暂不进命令面板）。
- 明确不做：自动同步、智能体代发、团队文档实时协同编辑。

### 做不做（明确排除）
- ❌ 智能体作为团队成员、Agent 直连服务端知识库、给 Agent 独立凭证。
- ❌ 个人库自动/镜像上传、团队库自动同步回个人库。
- ❌ 复用全站可见的 `shared_files` 当团队库、服务端 RAG 向量检索（智能体本机，用不上）。
- ❌ 团队库实时多人协同编辑（沿用"不做多人实时协同编辑"边界，文档级 CRUD + 版本号足够）。

---

## 7. 风险与对策

- **隐私误上传**：发布按钮必须有确认弹窗且默认"仅摘要"；服务端 schema 白名单截断超长正文；`team_events` 只记标题。
- **删除团队孤儿**：级联删 `team_knowledge_docs` + FTS（复用 `sqliteStore.ts:1401-1409` 一带的事务，并顺手修那里未清 `team_events`/`team_task_comments` 的老债）。
- **组件耦合回归**：编辑器改为受控 props 后，本地 vault 的 dirty/未保存拦截/`expectMtime` 逻辑必须保持（KnowledgePage 现有行为零回归是硬指标）。
- **多团队切换状态**：团队库列表的搜索词、当前文档在切队时重置（与看板切换一致）。
- **配额**：团队库正文按团队/按人计总量上限（复用 `HEMING_FILE_QUOTA_MB` 思路，建议新配 `HEMING_TEAM_KB_QUOTA_MB`），防止文本膨胀。

---

## 8. 关键文件索引

- 服务端：`packages/server/src/db.ts:25-118`（建表）、`app.ts:1809-1875`（文件路由参照）、`sqliteStore.ts:439-459`（`visibleTeam/teamMemberRole/isTeamOwner`）、`sqliteStore.ts:1401-1409`（级联删除债）、`packages/shared/src/schemas.ts`（白名单）。
- 前端：`packages/web/src/components/knowledge/KnowledgePage.tsx`（右上角「切换知识库」下拉 :659-670、页头其余动作 :671-739、页签 :793-809、意图消费 :552-575、快捷键 :535-547）、`packages/web/src/lib/vault/types.ts:16-41/246-285/324-380`（VaultMeta/VaultBridge/VaultStoreApi 契约）、`packages/web/src/lib/vault/store.ts:356-380`（`setActiveVault`）、`packages/web/src/lib/vault/bridge.ts:46-51`、`packages/web/src/lib/api.ts:302/410/665`、`packages/web/src/lib/palette/actions.ts:67-89`、`packages/web/src/lib/memory/kb.ts:73-115`、`packages/web/src/store/ui.ts:169`。
- 本机智能体：`providers.ts:57-70`、`runtimePrompt.ts:213-221`、`context.ts:173-187`、`services/agent-pipeline/.../tools.py:533-564`。
- 配套文档：`2026-11-20-team-collaboration-research.md`（Phase 2.2 会话→团队知识沉淀并入本方案）、`2026-11-20-team-collaboration-products-features.md`。
