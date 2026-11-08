# d.114 原生知识库（Obsidian 级 vault）与智能体记忆双向绑定 · 规格

- 日期：2026-11-08
- 状态：实现中（第一轮）
- 分支：`feat/d112-knowledge-native`（工作树 `.worktrees/knowledge-native`，基于 `d359d20` / d.112.3.45.0）
- 用户口径（2026-11-08）：
  1. **不是插件**，是扩展和鸣原生功能；
  2. 在和鸣内部做**知识库**，功能对齐 Obsidian（多库、任意目录、双链反链、标签、搜索、图谱、日记模板 Canvas、即时预览）；
  3. 不嵌入本机 Obsidian 应用、不复制其闭源代码——用开源等价件自己实现（CodeMirror 6 + 现有 markdown 链）；
  4. 与智能体记忆**双向绑定**；智能体**只能写指定目录**。

> 关于「模仿代码」的边界：Obsidian 本体闭源，复制其代码/资源不可行也不合法。本规格的
> 「对齐」指**能力模型与外显行为**对齐（同一套 vault 约定、同一份 md 文件、同样的双链/反链/标签语义），
> 底层用开源件（CodeMirror 6、react-markdown/remark/rehype、自研索引）实现。与真 Obsidian 共享
> 同一份文件是硬要求——这样用户两个客户端可以交替用，不会锁死。

## 0. 结论先行

| 项 | 决定 |
|---|---|
| 库模型 | **多库**：可打开任意目录为 vault（`vault:pick` 系统目录选择器）；和鸣自带的 `~/Heming/wiki` 自动注册为第一个库 |
| 库内结构 | **不限**：任意层级 md / 附件 / `.canvas`；`wiki/{entities,concepts,sources,synthesis,notes}` 不再强制，只作为和鸣自动维护区的建议布局 |
| 编辑器 | CodeMirror 6，三态：源码 / 分栏预览 / 阅读；即时预览内联（Live Preview）放第二轮 |
| 双链 | `[[页面]]`、`[[页面|别名]]`、`[[页面#标题]]`、`![[嵌入]]`；反链、出链、未解析链接、孤立页 |
| 标签 | `#tag`、`#a/b`、frontmatter `tags`；标签面板 + 按标签过滤 |
| 搜索 | Obsidian 风格子集：`tag:` `path:` `file:` `line:`、引号短语、`-` 排除、CJK 二元组（复用 `lib/wiki/query.ts`） |
| 图谱 | 复用 `lib/wiki/layout.ts` 力导向；新增局部图（当前页 N 跳）、过滤器（标签/文件夹/仅已解析） |
| 记忆绑定 | **双向**：vault→语义记忆（只存指针+摘要，不复制正文）；记忆沉淀/复盘→写回 vault 的允许目录 |
| 写入边界 | 双通道：`vault:write`（用户在界面里编辑，库内任意路径）+ `vault:apply`（**智能体**，仅允许目录 + HITL） |
| 云端 | **零上传**：vault 内容不出设备，不进服务端、不进 E2E 消息 |

## 1. 现状（为什么要新建一层，而不是改 `wiki-fs.js`）

- `packages/desktop/wiki-fs.js` 把允许路径写死为三档白名单（`index.md`/`log.md`/`schema.md`、
  `raw/*.md`、`wiki/<类别>/*.md`），根目录写死 `~/Heming/wiki`。**这是「一个固定库」的模型**，
  撑不起任意 vault（任意层级、`.canvas`、附件、本地图片）。
- `packages/web/src/lib/wiki/*` 的解析层只认三类信息：frontmatter、`[[双链]]`、按类别分文件；
  没有标签索引、没有反链、没有搜索语法、没有属性视图。
- `WikiPanel` 挂在**记忆页的 tab** 里，正文编辑是 `textarea`，没有文件树、没有编辑器、没有反链面板。
- `lib/memory/*` 与 `lib/wiki/*` **零耦合**（`grep wiki lib/memory` 为空）：「绑定记忆」是从零接的。

因此：**新增** `vault-*` 一条链路（桌面桥 + 索引层 + 界面 + 记忆适配），
`wiki-*` 原样保留（老用户与 `wiki_search` 工具不回归），第二轮再决定是否把 `wiki-*` 降为 vault 的一个自动维护区。

## 2. 数据模型（契约在 `packages/web/src/lib/vault/types.ts`）

```ts
type VaultId = string;            // 稳定 id：注册时生成（uuid），不随路径改名变化
interface VaultMeta { id: VaultId; name: string; root: string; writeDirs: string[]; addedAt: string }
interface VaultEntry { rel: string; name: string; kind: "dir" | "md" | "canvas" | "image" | "other"; size: number; mtime: string; children?: VaultEntry[] }
interface VaultDoc { vaultId: VaultId; rel: string; text: string; mtime: string; size: number }
interface WikiLink { target: string; alias?: string; heading?: string; embed: boolean; from: string; line: number }
interface TagRef { tag: string; from: string; line: number }
interface VaultIndex {
  pages: Map<string, PageInfo>;        // key = flat 名的解析结果（见 §3）
  links: WikiLink[]; backlinks: Map<string, WikiLink[]>; unresolved: WikiLink[];
  tags: Map<string, string[]>; orphans: string[];
}
interface SearchQuery { raw: string; terms: SearchTerm[]; negations: SearchTerm[] }
```

`PageInfo` 至少含 `rel` / `title` / `aliases` / `tags` / `headings` / `mtime` / `hash` / `frontmatter`。

## 3. 链接解析口径（对齐 Obsidian 的「最短唯一路径」）

1. `[[foo]]` 先按**文件名（不含 `.md`）** 精确匹配；多个同名文件时按「相对当前文件最近的路径」优先，
   歧义在界面标黄（不静默选一个）。
2. 带路径时 `[[dir/foo]]` 按相对库根解析；带前导 `/` 视为库根绝对。
3. `[[foo#标题]]` 解析到文件 + 该标题锚点（标题匹配失败仍算「文件已解析 + 锚点未命中」）。
4. `![[foo]]` 是嵌入：图片直接渲染、md 递归嵌入限深 1（防环）。
5. 解析在**代码块与行内代码之外**做（` ``` ` / `~~~` / 反引号），这是最容易写错的一处，必须有用例。
6. 未解析链接保留在 `unresolved`，界面可一键「创建该页」。

## 4. 安全模型（红线）

vault 根由**主进程**登记，渲染层只传 `vaultId` + 相对路径；主进程每次操作都重新夹一次：

- 根注册表 `~/Heming/vaults.json`（主进程独占读写；`vault:pick` 走系统目录对话框，**不接受渲染层给的绝对路径**）。
- 路径：`path-guard.resolveInsideRoot(root, rel)` + `fsp.realpath` 复核（防符号链接逃逸）+
  拒绝 Windows 保留名 / NUL / 300 字上限。
- 扩展名分级：
  - 可写文本：`.md` `.canvas` `.json` `.txt` `.csv`（单文件 ≤ 2MB，与 `wiki-fs` 同口径）
  - 只读图片：`.png` `.jpg` `.jpeg` `.gif` `.webp` `.svg`（经 `vault:readBinary` 转 data URL，≤ 8MB）
  - 其它一律不可读写（不执行、不解析）
- 默认忽略：`.obsidian/` `.git/` `node_modules/` 以及任何以 `.` 开头的目录（可在设置里显式放开 `.obsidian` 读取，
  但**永不写入** `.obsidian/`——那是 Obsidian 自己的配置）。
- 删除只删**单个文件**，不删目录、不递归；改名只改库内路径。
- 双通道写入（见 §0）：`vault:apply` 额外校验 `writeDirs`（库内相对目录，默认 `inbox`），
  越界直接拒绝并返回中文原因；`vault:apply` 每次都要经过工具层 HITL（`write` 风险）。
- 渲染层降级：浏览器无桥时走内存实现（与 `lib/wiki` 同策略），界面显式标「临时模式」。

## 5. 记忆双向绑定

### 5.1 vault → 记忆

- `lib/memory/vaultMemory.ts`：把 vault 里「被纳入索引」的 md 转成**指针型语义条目**：
  `source: "vault"`，`key` = `rel`，`value` = 摘要（首个标题 + 首段，≤ 500 字），
  新增可选字段 `vault?: { vaultId, rel, mtime, hash }`；**正文不复制进 localStorage**。
- 纳入范围：默认全库；超过 `VAULT_MEMORY_MAX`（建议 500 条）时按 `mtime` 降序截断，并在记忆页写明「已截断」。
- 增量：watch 事件 → 重算该文件 hash → 只增删改变化的条目；删除的笔记对应条目同步删除（与 `forgetUsage` 同口径）。
- 召回：复用既有语义召回打分（同主题时效覆盖 / MMR / 个性化权重）。
  注入点 `lib/agentRuntime/context.ts` 的 `buildAgentContext()` **是同步的**（`agentStream` 在流式前同步调用），
  所以注入用的是条目自带的同步摘要 `value`（≤500 字），**不在注入路径里异步读正文**；
  正文片段解析（`resolveExcerpt`，单条 ≤ 400 字、整轮 ≤ 1200 字）留给记忆页预览与将来的异步路径。
  格式化层标注「来自知识库《rel》」；无 vault 时 `buildAgentContext` 行为与现在逐字相同。
- 关掉：记忆设置新增「知识库参与记忆」开关；关闭只停注入，不删索引。

### 5.2 记忆 → vault（写回）

- 触发：`consolidate`（6 轮沉淀）/ `explicit`（用户说「记住…」）/ `review`（复盘自评）三类，
  各写入 `inbox/` 下独立文件：`inbox/memory-<key>-<yyyymmdd>.md`，frontmatter 带
  `source: heming-memory`、`key`、`agentId`、`createdAt`，正文是 `value`。
- 去重：同 `key` 已有文件则**追加到该文件**（`## 更新 YYYY-MM-DD` 小节），不产生重复文件。
- 失败不静默：写不进去（无库 / 无写权限 / 超限）在记忆页与通知中心如实报错，记忆条目本身照常保存。
- 用户手改优先：vault 里被用户改过的条目，下一次同步以文件为准（不覆盖用户修改）。

## 6. 界面（新页 `vault`，导航「资料与能力」组）

- 左栏：库切换器（当前库 + 打开其它库 + 移除）、文件树（可折叠、新建/改名/删除、右键菜单）、
  搜索框、标签列表。
- 中栏：标签页（多文件同时打开）+ 编辑器三态（源码 / 分栏 / 阅读）；面包屑；脏标记与 Ctrl+S。
- 右栏：反链 / 出链 / 未解析链接 / 大纲 / 属性（frontmatter）；可折叠。
- 图谱：全库与局部（当前页 1–2 跳）；节点点击跳转。
- 命令面板：`打开知识库页`、`新建笔记`、`在知识库中搜索`（第二轮补全部命令）。
- 记忆页的 wiki tab 改为「打开知识库」入口卡（`WikiPanel` 组件保留，避免老链接 404）。

## 7. 分轮

### 第一轮（本分支）
1. 桌面 `vault-fs.js` / `vault-watch.js` / 注册表 / preload 桥 / IPC 白名单；
2. web `lib/vault/*`：types、bridge、parse、buildIndex、search、graph、store、tools；
3. `components/knowledge/*` 界面 + 新导航页 + App 接线；
4. `lib/memory/vaultMemory.ts` + 召回/格式化/沉淀写回 + 记忆设置开关；
5. 桌面与 web 测试、文档、CHANGELOG、版本 bump（→ `d.114.3.45.0`）。

### 第二轮（本次一并实施，目标版本 `d.115.3.45.0`）

| 项 | 范围 |
|---|---|
| **Canvas** | `.canvas` 解析/序列化（保留未知字段，坏 JSON **绝不回写**）、SVG 画布：平移/缩放、选中/拖动（20px 吸附）、双击编辑文本节点、新建/删除节点、连线（拒绝自环与重复）、file 节点点击打开笔记。组件受控，写回统一走编辑器同一套「脏标记 + Ctrl+S」流程 |
| **日记** | 配置 `{folder, format, templatePath}`（默认 `daily/` + `YYYY-MM-DD`）；「今天」一键打开，不存在则按模板创建（frontmatter 带 `date`）；`parseDailyPath` 反解日期 |
| **模板** | `templates/*.md`，变量 `{{title}} {{date}} {{time}} {{vault}}` 与 `{{date:YYYY-MM-DD}}` 子集；未知占位符原样保留并回报；新建笔记时可选用 |
| **命令面板** | 新增 kind `vault`（笔记快速打开，含别名与路径匹配）+ 4 个动作（新建笔记 / 打开今天日记 / 新建画布 / 知识库设置）；跨页用 `vaultIntent`（照 `infohubIntent` 模式）；页面内 `Ctrl/⌘+O` 快速切换 |
| **修正项** | 跨行行内代码屏蔽（CommonMark 反引号 span 可跨行）；锚点未命中独立状态（`WikiLink.anchor`，界面黄色「锚点未命中」而非断链）；`vault:createDir` 新建文件夹；树按 `rel` 懒加载；嵌入笔记未打开时异步 `readText` |
| **仍不做（第三轮）** | 即时预览内联（Live Preview）、大纲滚动同步、附件面板、批量导入、`wiki-*` 与 `vault-*` 收敛、跨平台 watch（Linux 非 recursive） |

## 8. 测试计划

- **desktop（node:test）**：路径越界（`..`、绝对路径、盘符、NUL、保留名、符号链接逃逸）、扩展名与大小上限、
  只写 `writeDirs`、删除不递归、watch 事件去抖与 close 清理、注册表持久化与坏 JSON 回退。
- **web（vitest）**：链接解析（别名/锚点/嵌入/代码块内不算/同名歧义）、反链对称性、标签（含 `#a/b`、frontmatter）、
  搜索语法（每个 `key:`、引号、排除、CJK）、图谱确定性、store 增量重索引、记忆条目增删改与截断、
  写回去重与失败路径、降级到内存桥。
- **契约测试**：`WikiBridge` 与 `VaultBridge` 的同形接口用同一组用例跑两遍（浏览器内存实现 / 桌面桥 mock）。

## 9. 兼容与迁移

- 老 `wiki/` 目录继续可用：`wiki-fs.js` 与 `wiki_search` / `wiki_read` 工具不动；
  首次启动若 `~/Heming/wiki` 存在，自动注册为名为「和鸣知识库」的 vault（不移动文件）。
- `HEMING_WIKI_DIR` 继续只影响老 wiki 桥，不影响 vault 注册表。
- 记忆存储向后兼容：`SemanticEntry.source` 新增 `"vault"`、新增可选 `vault` 指针字段；
  老数据无该字段照常读写，导出/导入不改版本号（aux 口径不变）。

## 10. 风险

| 风险 | 处理 |
|---|---|
| CodeMirror 6 增加包体 | 懒加载：只在进知识库页时 `import()`；主页/聊天不受影响 |
| 大库（>5000 文件）首屏索引卡顿 | 索引在主线程分片（`requestIdleCallback` 队列），首屏只读目录树；进度条可见 |
| watch 风暴（git 操作、同步盘） | 去抖 300ms + 单次最多重算 200 文件，超出改全量重建并提示 |
| 与真 Obsidian 同时改同一文件 | 以文件 mtime 为准，不合并；编辑器保存前校验 mtime，变了就提示「文件已被外部修改」 |
| 记忆条目过多挤占召回预算 | `VAULT_MEMORY_MAX` 500 条 + 注入预算上限 + 设置开关 |
