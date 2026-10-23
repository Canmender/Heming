# d.35 · wiki 中文检索 / 任务淘汰护进行中 / 导出附块与文件落盘（P1-5 + P1-6 + P1-7）

- 日期：2026-10-23
- 相关版本：d.34.1.8.0（基线）、本 spec = d.35.1.8.0
- 上游依据：`docs/research/2026-10-22-deep-audit-followup-plan.md` §3 P1-5/P1-6/P1-7、§7 分轮表
- 涉及包：`packages/web`、`packages/desktop`

## 0. 这一轮要解决什么

三件都在数据侧「悄悄丢东西或找东西」：

1. **wiki 检索对中文退化**：`searchPages` 把 query 按空白切开后逐词 `includes`，
   中文长词/多词组合几乎必然 0 命中，用户会以为知识库是空的。
2. **任务淘汰不看状态**：`pruneTasks` 按 `createdAt` 排序截 60 条，
   一个跑得久的 `running` 任务（创建最早）会被新任务挤掉，随后 `onRunSettled` 无处可写
   —— 任务悄悄消失且报告缺失。
3. **记忆导出的账本丢失**：`exportAll` 不含召回日志与用量账本（d.27/d.28 的刻意设计），
   换设备后记忆条目搬走了、**权重与判定依据丢了**；而且导出只能复制到剪贴板，
   没有文件落盘路径。

## 1. 已核实的事实（本轮亲自读过源码）

| 编号 | 事实 | 位置 |
|---|---|---|
| P1-5 | `terms = q.split(/\s+/).filter(Boolean)`，逐词 `hay.includes(t)`，**无 CJK 分词** | `packages/web/src/lib/wiki/tools.ts:86-100` |
| P1-5 | 标题 +6 / 标签 +3 / 正文 +1，整句命中再 +5 | 同上 |
| P1-6 | `[...tasks].sort((a,b)=>b.createdAt-a.createdAt).slice(0, MAX_TASKS)`，**不看 status** | `packages/web/src/lib/tasks/store.ts:346-349` |
| P1-6 | `MAX_TASKS = 60`；另有字节上限 1.1MB 的逐步裁剪 | `tasks/store.ts:25,39,353-380` |
| P1-7 | `exportAll()` 只含 `{version, exportedAt, data}`，不含 usage/recallLog | `packages/web/src/lib/memory/store.ts:708-714` |
| P1-7 | 记忆页导出只有「复制到剪贴板」一条路径 | `packages/web/src/components/MemoryPage.tsx:861-871` |
| P1-7 | 桌面端已有文件桥先例：`wiki-fs.js`（markdown）、`chart-fs.js`（HTML） | `packages/desktop/*.js` |

## 2. 决策

### 2.1 P1-5 · CJK 二元组 + 覆盖率匹配（只做读侧）

**分词**（新模块 `lib/wiki/query.ts`，纯函数可测）：
- 先按空白与中英文标点切段；
- ASCII 段 → 原样小写成一个词；
- 含 CJK 的段：长度 ≤ 2 时保留整段；长度 > 2 时展开成**相邻二元组**（bigram）。

**匹配**（保持「所有词都命中才入选」的 AND 语义，但单点匹配放宽）：
- 一个词匹配的条件：**整词出现**，或（CJK 且长度 > 2 时）**至少 60% 的 bigram 出现**。
- 这样 `预算风险`（不空格）能命中「预算与风险」；而 `项目 预算 风险` 这类空格查询行为不变。
- 非中文查询**逐字不变**（ASCII 词仍整词匹配）。

**打分**：标题 +6 / 标签 +3 / 正文 +1 的权重不变；整句命中额外 +5 改为「任一词整词命中标题」保持等价即可（实现上按下标累加，排序仍为 得分 → 标题 → 路径，确定性不变）。

**不做**：不改文档结构、不碰 `wiki/index.ts`（含字面 NUL 的禁改文件）、不引入分词依赖。

### 2.2 P1-6 · 淘汰只从「已结束」里摘，动到进行中要先通知

- `pruneTasks` 改为返回 `{ tasks, droppedRunning }`：
  - 先按 `createdAt` 降序，**running 全保留**；
  - 剩余名额给 ended 任务（同样按时间降序）；
  - 若 running 本身已超过 `MAX_TASKS`，仍要保住上限（不能无界），
    被迫摘掉最旧的 running，并把它们放进 `droppedRunning` 返回。
- 字节上限那一步同样**先摘 ended**；只有当只剩 running 且仍超限时才动 running，
  同样记入 `droppedRunning`。
- 调用方（`persist`）对 `droppedRunning` 里每一条推一条通知
  （`kind:"task"`，key `task-evicted:<id>`，标题「任务记录被清理」），
  **然后才**落盘——「先告知再消失」，符合 d.24 定的「不静默丢」。
- 一步 `sweepStale` 已经把长期无响应的 running 标成 failed（d.24），所以「全是 running」
  是短窗口内的极端情况，不是常态。

### 2.3 P1-7 · 导出附块（默认关）+ 桌面端落盘

**附块**：
- 新增 `lib/memory/exportBundle.ts`：`buildMemoryExport({ includeAux })`。
  - 不勾：**与今天逐字节一致**（直接返回 `memory.exportAll()`）。
  - 勾选：在同一份 JSON 上加 `aux: { usage, recallLog, note }`，
    并**显式标注 `note: "可再生数据：导出用于换设备后保留召回权重与判定依据；不参与导入"`**。
- 辅助数据来源：`UsageLedger.snapshot()` / `RecallLog.runs()`（两模块已有读取口径）。
- **导入不消费 aux**：`importAll` 只认 `data`，未知字段忽略（既有行为），
  规格里写明「aux 只导出、不导入」——否则会变成两套导入语义。

**落盘**：
- 新增桌面桥 `packages/desktop/export-fs.js`：目录固定 `~/Heming/exports/`，
  文件白名单后缀 `.json`、文件名走与 `chart-fs.js` 同款白名单清洗、不允许穿越。
- preload 暴露 `__heming_exports.write(fileName, content)` / `exists()`。
- web 侧 `lib/export/file.ts`：有桥 → 写文件并返回路径；无桥 → 回退 **Blob 下载**
  （浏览器端不新增任何上传路径）。
- 记忆页导出区：加「附上辅助账本（用量/召回记录，可再生）」勾选框（**默认关**），
  以及「导出到文件」按钮（无桥时文案为「下载 JSON」）。

**红线**：任何路径都**不上云**。

## 3. 兼容与迁移

| 项 | 兼容性 |
|---|---|
| wiki 检索 | 读侧变化；非中文查询逐字不变；中文查询命中数上升 |
| `pruneTasks` 返回值 | 由数组改为 `{tasks, droppedRunning}`（调用方同步改；导出函数签名变更，仓库内唯一实现对） |
| 任务淘汰 | running 不再被随意挤掉；被迫摘 running 时有通知 |
| 导出 | 不勾附块与今天**逐字节一致**；导出的 JSON 加了可选段 |
| 桌面桥 | 新 IPC，老包没有该桥时 web 侧回退 Blob 下载 |

## 4. 测试计划

| 文件 | 覆盖 |
|---|---|
| `lib/wiki/query.test.ts`（新建） | 分词：ASCII/中文/混合/标点；bigram 展开；长度 ≤2 不展开 |
| `lib/wiki/tools.test.ts` | 固定 wiki 集：`预算风险`（无空格）改动前 0 命中、改动后命中「预算与风险」；空格查询不变；**ASCII 查询结果逐条不变**（回归锁） |
| `lib/tasks/store.test.ts` | 61 条含 1 条最早的 running → running 仍在；全 running 且超额 → 最旧被摘且出现在 `droppedRunning`；字节裁剪优先摘 ended |
| `lib/tasks/store.test.ts` | 被迫摘 running 时推通知（key `task-evicted:<id>`） |
| `lib/memory/exportBundle.test.ts`（新建） | 不勾附块 → 与 `exportAll()` 逐字节一致；勾选 → JSON 含 `aux.usage/recallLog/note` 且 `data` 不变 |
| `desktop/export-fs.test.js`（新建） | 只写 `.json`、文件名清洗、拒目录穿越、写目录自动创建 |
| `lib/export/file.test.ts`（新建） | 有桥写文件；无桥回退 Blob 下载（断言不发起网络请求） |

## 5. 不做 / 边界

- **不做**真正的分词词典（bigram 足够，且确定性、无依赖）。
- **不做** aux 的导入（只导出，避免两套导入语义）。
- **不做**云同步/上传（红线）。
- **不改**任务区 UI 的其它部分，只加淘汰通知。
- **不改** `wiki/index.ts`（含字面 NUL 的禁改文件）。
