# d.53 · 文件编辑原语：`file_patch`（规格，未开工）

- 日期：2026-11-02
- 状态：**已实施（②-1 轮，实施记录见 §15）**
- 编号说明：本文件按 d.53 编号；若与并行会话撞号则顺延，内容不受影响。开工前先看 `git log -1`。
- 借鉴来源：[openai/codex](https://github.com/openai/codex)（**Apache-2.0**）的 `codex-rs/apply-patch` 与 `core/src/safety.rs`。**只移植算法与协议形状，不搬 Rust 源码**；若最终逐行翻译，需在文件头注明来源与 commit，并在 `NOTICE` 里保留版权声明。
- 依赖面：新增 `packages/web/src/lib/fileEdit/*`、`packages/desktop/file-fs.js`、`lib/hitl/policy.ts`（规则匹配扩展）、`lib/hitl/classify.ts`（新增内置工具风险表项）、`components/TaskAreaPage.tsx`（可选：补丁预览）。**不改**服务端、不改 E2E、不改消息协议。

---

## 0. 这一轮要解决什么

和鸣目前**没有任何文件编辑能力**。核实过的事实：

- `lib/wiki/tools.ts:46,63` 只有 `wiki_search` / `wiki_read`，都是只读；
- `lib/selfEdit/tools.ts:92-265` 的 `self_*` 只改记忆、技能、MCP 配置，不碰文件系统；
- 真正能写盘的只有桌面端 `packages/desktop/wiki-fs.js`（写 Obsidian 知识库），**且只对 wiki 根开放，渲染层没有通用写入口**。

结果是：智能体能查、能说、能改自己的配置，但**不能改用户的文件**。这让"帮我把这份笔记整理一下""把这个目录的标题统一改掉"这类需求只能靠人手工做。

**目标**：给智能体一个**受控的、可审计的多文件编辑原语**，作用域由用户圈定，越界必问。

**非目标**（本轮明确不做）：shell 执行、目录遍历、文件删除的批量语义、自动回滚/undo 栈、跨设备同步。

---

## 1. 已核实的事实（带 `file:line`）

### 1.1 为什么不是「写一个 `write_file` 就够了」

整文件重写有两个硬伤：
1. **token 成本**：改一个 2000 行的文件里的一行，也要模型输出 2000 行；输出越长，截断与幻觉的概率越高。
2. **破坏性**：模型记不住原文时会把没让它改的部分"顺手重写"，用户看到的是一个被悄悄改过的文件。

Codex 的做法是用**上下文锚点补丁**（不依赖行号）。模型只需要给出"要改的几行 + 周围的锚点"，改错的可能性从"整篇重写"收敛到"局部匹配"。

### 1.2 路径收敛已有现成口径

`packages/desktop/wiki-fs.js:42-51` 的 `resolveInside(rel)` 已经处理过这类问题：

```js
const abs = path.resolve(root, norm);
const relCheck = path.relative(root, abs);
if (relCheck === "" || relCheck.startsWith("..") || path.isAbsolute(relCheck)) return null;
```

还有 NUL 字节拒绝（`:46`）。**新工具的路径判定沿用同一口径**，不另写一套——两套判定迟早会分叉。

### 1.3 HITL 的规则匹配目前是「精确相等」

`lib/hitl/policy.ts:355-370`：

```ts
r.tool === call.name && (r.resource === resource || r.resource === RULE_WILDCARD)
```

`resource` 来自 `classify.ts:325` 的 `ruleResource`，取 `SUMMARY_FIELDS = ["path","file","url","query","name","server"]`（`:104`）里第一个非空字符串，路径还会把 `\` 换成 `/` 并截到 200 字符。

**这意味着**：今天记住一条「允许 `D:/Obsidian/a.md`」只能覆盖这一个文件；用户想让"整个目录以后都别问"，现有规则表达不了。§7 要补的正是这块。

另外 `policy.ts:355-370` 里 `danger` 直接 `return null`（永不记忆放行），这条红线在文件编辑里必须保留。

### 1.4 工具执行层已经就绪

d.50/d.52 之后，新工具接进去就自动获得这些行为，**不需要改主循环**：

| 能力 | 位置 |
|---|---|
| 写操作串行、只读并行 | `agentStream.ts` 按 `bridge.meta.risk` 分组 |
| 结果封顶 8000 字符 | `mcp/bridge.ts` `truncateToolResult` |
| 中断透传 | `ToolBridge.execute(call, { signal })` |
| 工具结果回灌预算 | `agentContext/toolResults.ts` |
| 回合日志 | `onRollout`（`lib/rollout`） |
| 工具超 20 个按需检索 | `lib/mcp/discovery.ts` |

---

## 2. 工具形态

**一个工具**：`file_patch`，参数：

```json
{ "patch": "*** Begin Patch\n...", "root": "可选，指定根名（缺省 primary）" }
```

为什么一个工具而不是 `read_file` / `write_file` / `delete_file` 三个：
- 一次调用可以原子地改多个文件（改名 = 删除 + 新增，分两次调用会出现"删成功、增失败"的中间态）；
- 模型只需要学一种格式；
- 审批只需要一次（用户看到的是"这次会改这 3 个文件"，而不是三次弹窗）。

**另需一个只读工具** `file_read`（读指定文件的相关片段），理由见 §9：补丁失败时模型必须能重新读原文，否则它会猜。

---

## 3. 补丁协议（对模型的契约）

沿用 Codex 的标记，逐条固定下来：

| 标记 | 含义 |
|---|---|
| `*** Begin Patch` | 开始（可带说明文字，解析时忽略） |
| `*** End Patch` | 结束（必须存在） |
| `*** Add File: <path>` | 新增文件；其下每行必须以 `+` 开头 |
| `*** Delete File: <path>` | 删除文件 |
| `*** Update File: <path>` | 修改文件 |
| `*** Move to: <path>` | 紧跟在 Update 之后，表示改名 |
| `@@ <上下文>` | 变更块起始；后面可跟一段原文，用于定位 |
| `*** End of File` | 该块在文件末尾 |
| ` ` / `-` / `+` 前缀 | 上下文行 / 删除行 / 新增行 |

示例（改名 + 改内容）：

```
*** Begin Patch
*** Update File: notes/a.md
*** Move to: notes/b.md
@@ # 标题
-旧的一行
+新的一行
*** End Patch
```

**解析约束**（都是为了让错误尽早暴露）：
1. 首行必须是 `*** Begin Patch`，末行必须是 `*** End Patch`，否则 `invalid patch`；
2. 一个 `Update File` 下可以有多个 `@@` 块，按出现顺序应用；
3. `Add File` 里的行必须全部以 `+` 开头，出现其他前缀直接判错（模型常在这里混入上下文行）；
4. `Move to` 只能出现在 `Update File` 之后、第一个 `@@` 之前；
5. 空补丁（没有任何 hunk）→ 拒绝，文案「No files were modified」。

---

## 4. 匹配算法（不数行号）

按顺序尝试三级，命中即用：

1. **精确匹配**：锚点行与文件逐字相等（含行尾空白）。
2. **空白归一**：忽略行首尾空白与连续空白的差异。
3. **标点归一**：把 Unicode 连字符类（`‐` U+2010、`‑` U+2011、`–` U+2013、`—` U+2014）与 ASCII `-` 互认，弯引号与直引号互认。

第 3 级是**必要的**：模型输出的 `-` 与文件里的 `–` 不一致，是最常见的"补丁匹配失败"来源；不做归一化，用户会看到一堆莫名其妙的失败。

**原子性**：一个补丁里的**任何一个** hunk 匹配失败，整个补丁**不写盘**，返回失败原因（哪个文件、哪个块、期望的锚点是什么）。理由：半套补丁比不写更糟——文件处于一个用户没预期、模型也不知道的状态。

**行尾**：保持文件原有行尾（CRLF/LF），不强制转换。

---

## 5. 路径与作用域

### 5.1 可写根（roots）

配置形状（本机、进 `localStorage`，不进仓库）：

```json
{ "roots": [{ "name": "obsidian", "path": "D:/Obsidian/学院事务", "mode": "write" }] }
```

- 缺省**没有**可写根：装好之后必须用户显式加一条，工具才对模型可见（与 MCP"装完默认全关"同一口径）；
- `mode` 只有 `read` / `write` 两档，没有 `full-disk`；
- 同一路径重复添加按最长前缀归一（避免 `D:/a` 与 `D:/a/` 两条规则打架）。

### 5.2 路径判定

沿用 `wiki-fs.js:42-51` 的口径，额外三条：

- **不跟随符号链接**：`lstat` 判定，命中软链直接拒绝（否则用户圈定的根会被一个链接绕出去）；
- **硬链接提示**：Node 的 `nlink > 1` 且目标在根外时拒绝——这条 Codex 在 `safety.rs` 里也留了注释（"hard links to files outside the writable roots"）；
- **大小上限**：单文件 1 MB、单次补丁总计 4 MB；超限拒绝并说明（不是静默截断）。

### 5.3 编码与换行

只处理 UTF-8 文本；检测到二进制（前 8KB 含 NUL 或非法 UTF-8 序列）直接拒绝，文案说明"这不是文本文件"。

---

## 6. 安全判定（三态，与 HITL 同源）

新增 `assessPatchSafety(action, policy, roots)`，返回 `AutoApprove | AskUser | Reject`，判据只有一条：

> **补丁里所有目标路径（含 `Move to` 的目标）都在某个 `mode=write` 的根内 → AutoApprove；否则按策略问人或拒绝。**

与 Codex `core/src/safety.rs` 的 `assess_patch_safety` 一致。三条补充：

1. `AskForApproval::Never`（我们的 `strict` 之外没有"全放行"档）→ 越界直接 `Reject`，文案说明"写作被拒绝：目标不在可写根内"；
2. 危险操作（删除整个目录、覆盖不可读文件）不因为"在根内"就免问——`danger` 仍走闸门，与 `policy.ts` 现有红线一致；
3. 判定结果要**能被用户看见**：确认卡上显示"将修改 3 个文件（A/M/D）"，而不是一句"调用 file_patch"。

---

## 7. HITL 规则升级：从「精确路径」到「路径前缀」

现状（§1.3）：`ruleFor` 只做 `resource === resource` 的精确比较，用户没法说"这个目录以后都允许"。

**改动**（只动 `policy.ts` 的匹配与 `classify.ts` 的资源生成，不动闸门结构）：

- 规则资源支持两种形状：`*`（该工具全部）与**以 `/` 结尾的路径前缀**（如 `D:/Obsidian/学院事务/`）；
- 匹配顺序：`deny` 优先 → `danger` 不放行 → `allow`；
- 路径归一化统一走一个函数（大小写、分隔符、尾斜杠、`..` 折叠），**规则写入与匹配用同一个函数**，否则会出现"写进去匹配不上"的幽灵规则；
- 规则条数上限与"一键清空"沿用现有（200 条）；
- **不允许**把 `file_patch` 整体记成 `allow`——它天然是"多文件写"，只能按路径前缀授权。

> 这一条是文件编辑能否好用的关键：没有前缀授权，用户每改一个文件就要点一次确认，两天之后他就会去关掉 HITL。

---

## 8. 执行与并发

- 新工具的 `meta.risk = "write"`（`file_patch`）与 `"read"`（`file_read`），主循环据此自动串行/并行，**不需要改调度**；
- 同一轮里对同一文件的两次 `file_patch`：串行执行（已有），第二次基于第一次的结果计算，不会互相覆盖；
- 单次调用最多改 20 个文件、单个 hunk 最多 200 行（超出请拆成多次调用，文案说明）；
- 写盘采用**临时文件 + rename**：先写 `.<name>.tmp`，`fsync` 后 `rename` 覆盖，避免写到一半断电留下半个文件。

---

## 9. 失败语义（给模型的可行动文案）

失败时**不要**只回 "patch failed"。按原因分流：

| 原因 | 回给模型的文本要点 |
|---|---|
| 锚点匹配失败 | 哪个文件、第几个 `@@` 块、该块期望的前两行原文；建议「先 `file_read` 这段再重试」 |
| 路径越界 | 目标路径 + 可写根清单；不要暗示"可以绕过" |
| 文件不存在（Update/Delete） | 路径 + 建议先用 `file_read` 或改用 `Add File` |
| 目标已存在（Add） | 路径 + 建议改用 `Update File` |
| 二进制/超限 | 明确原因，不做截断式"部分成功" |

`file_read` 的支持是这条链路的必要条件：补丁失败 → 读原文 → 重新生成补丁，是模型自我修正的唯一现实路径。

---

## 10. 审计

- `onRollout` 记 `tool_call`（含 patch 全文的前 2000 字符，沿用日志上限）与 `tool_result`（成功/失败 + 文件清单）；
- 任务区过程日志面板（`components/RolloutTimeline.tsx`）已能显示这两条，**本轮不改 UI**；可选增强：把 `A/M/D` 清单渲染成文件列表；
- **不记录文件全文**：日志是排查用的，不是备份。真需要回滚，靠 git 或用户自己的备份。

---

## 11. 测试矩阵

| 类别 | 用例 |
|---|---|
| 解析 | 缺 Begin/End、空补丁、Add 行前缀错、Move 位置错、多 `@@` 块 |
| 匹配 | 精确命中、空白差异、Unicode 连字符、锚点歧义（同文出现两次→取第一个并提示）、锚点不存在 |
| 原子性 | 两文件补丁，第二个失败 → 第一个也不写盘 |
| 路径 | `..` 越界、绝对路径、NUL、软链、硬链接、根内正常、根外只读根 |
| 编码 | CRLF 保留、二进制拒绝、超 1MB 拒绝 |
| 安全 | 全在根内→AutoApprove；越界→AskUser；policy=strict→AskUser；越界+never→Reject |
| 规则 | 前缀授权命中、deny 优先、danger 永不 allow、归一化后能命中 |
| 并发 | 同轮两次改同一文件、两次改不同文件（并行） |
| 回归 | 现有 2551 个 web 用例不受影响；未配置可写根时 `file_patch` 对模型不可见 |

---

## 12. 分阶段

| 阶段 | 内容 | 验收 |
|---|---|---|
| P0 | 解析 + 匹配 + 干跑（不写盘），只读回放结果给模型 | 解析/匹配用例全绿；干跑能报出每个文件的 A/M/D |
| P1 | 桌面端写盘桥（沿用 `resolveInside`）+ 三态安全判定 + HITL 确认卡 | 根内免问、越界必问、拒绝有原因 |
| P2 | 规则前缀授权 + 任务区文件清单 | 一个目录授权后连续多次编辑不再重复弹窗 |
| P3（待定） | 补丁预览（行级 diff 进确认卡） | 用户能在确认前看到将写入的内容 |

---

## 13. 明确不做

- **shell / 命令执行**：与"文件编辑"是两件风险等级不同的事，不捆绑；
- **全盘可写根**：`mode` 只有 read/write，且 write 必须由用户显式添加；
- **自动回滚/undo 栈**：不做"内存里的影子文件"——它会制造"以为改回去了其实没改"的错觉；
- **跨设备同步**：写根是本机路径，云端没有意义。

---

## 14. 需要你先定的三件事

1. **默认写根**：装好之后要不要预置一个（例如 `D:/Obsidian`）？我倾向**不预置**，让用户显式加，与 MCP"装完默认全关"一致。
2. **单文件大小上限**：1 MB 是否够？知识库笔记够，代码文件可能要放宽到 2 MB。
3. **确认卡是否要行级 diff**：要的话 P3 提前，代价是确认卡复杂度上升（现有 `hitl/preview.ts` 已有行级 diff 的雏形，可复用）。

---

## 15. 实施记录（②-1 轮，d.55）

> 本节由实施负责人（filepatch）回写，记录**实际做了什么、与原稿的差异、已知边界**。
> 规格正文（§0–§14）保持原稿不改，便于对照。

### 15.1 实际交付

**web（`packages/web/src/lib/fileEdit/**`，新增 16 个文件）**

| 文件 | 内容 |
|---|---|
| `types.ts` | 协议结构、失败分类、变更集类型 |
| `limits.ts` | 单文件 2 MB / 单次补丁 4 MB / 20 文件 / 单 hunk 200 行 |
| `paths.ts` | 路径归一化、规则前缀匹配、`resolveInsideRoot`（沿用 `wiki-fs.js:42-51` 口径并加严）、公共目录前缀 |
| `parse.ts` | `*** Begin Patch` 协议解析（严格：缺前缀即判错） |
| `match.ts` | 三级匹配（精确 → 空白归一 → 标点归一）、hunk 应用、CRLF/BOM/末尾换行保留 |
| `resolve.ts` | 目标解析（所选根 + 相对路径，绝对路径与 `..` 一律拒绝），干跑/HITL/预览三处共用 |
| `apply.ts` | 干跑：读 → 匹配 → 产 A/M/D 变更集；任一 hunk 失败整单不产出 |
| `safety.ts` | `assessPatchSafety` 三态（auto / ask / reject） |
| `roots.ts` | 可写根存储（localStorage）+ 归一化 + 上限 |
| `bridge.ts` | `window.__heming_files` 探测与类型 |
| `tools.ts` | `file_patch` / `file_read` 工具定义与执行、按原因分流的失败文案 |
| `ruleTargets.ts` | 「这次调用碰哪些路径」解析（规则匹配与授权前缀共用） |
| `remember.ts` | 「记住本次选择」：文件工具按目录前缀写多条规则 |
| `patchPreview.ts` | 确认卡行级 diff（复用 `hitl/preview.ts` 的 `diffLines`，脱敏 + 200 行截断） |
| `index.ts` | 出口 |

**改动（小）**

- `lib/capability/providers.ts` + `index.ts`：新增 `files` 提供者，注册顺序 `mcp → charts → tone → wiki → files → infohub → self`。
- `lib/hitl/policy.ts`：规则匹配改为「精确 / `*` / 路径前缀」三形状（写入与匹配共用 `normalizeRuleResource`）；`deny` 优先；`danger` 不按规则放行（红线不变）；`file_patch` 多目标须**每个目标都被路径规则覆盖**、通配允许对它不生效；`allowed()` 里接「全在可写根内 → 免问」；新增 `rememberRules`（一次写多条、去重、绝不写 `*`）。
- `lib/hitl/classify.ts`：`file_patch` / `file_read` 风险与中文名；补丁参数摘要只数操作、不回显补丁内容；`file_` 前缀兜底名。
- `lib/hitl/gate.ts`（**经 Lead 批准新增的约 5 行**）：「记住」改走 `rememberDecision`，文件工具按目录前缀落规则。
- `lib/hitl/preview.ts`：导出既有 `diffLines` 供补丁预览复用（未另造 diff）。
- `components/ToolApprovalModal.tsx`：`file_patch` 显示「将修改 N 个文件（A/M/D）」+ 异步行级 diff；「记住本次选择」仅在能归纳出目录前缀时显示，并写出将记住的目录；不能记时说明本次不会落规则。
- `components/FileEditCard.tsx`（新增）+ `SettingsPage.tsx`：设置区「文件编辑」卡（可写根增删 / 读写模式切换 / 目录选择器 / 越界处理 / 已记住目录授权 / 上限说明 / 浏览器端不可用说明）。

**桌面端**

- `packages/desktop/path-guard.js`（新增）：从 `wiki-fs.js` 抽出的共享 `resolveInsideRoot`（行为逐字等价），另加 `isInsideRoot` / `checkAbsoluteInside` / `isReservedName` / `assertNoSymlinkAncestor`。
- `packages/desktop/wiki-fs.js`（小改）：`resolveInside` 改为复用 `path-guard.js`，不留两份判定。
- `packages/desktop/file-fs.js`（新增）：IPC `file:read` / `file:write` / `file:pick-root`；根内校验、软链（含祖先目录）、硬链（`nlink>1`）、NUL、保留名、非普通文件、上限、二进制拒绝；两阶段写（全部 tmp+fsync → 统一 rename）；删除放在写入之后；写操作串行排队；**不接受渲染层直接给绝对路径写盘**（每步先按根校验）；每个通道先校验调用来源（只接受主窗口）。
- `packages/desktop/preload.js`：暴露 `__heming_files`（read / write / pickRoot）。
- `packages/desktop/main.js`：注册 `registerFileIpc(ipcMain, { dialog, getMainWindow, isTrustedSender })`，来源校验为「主窗口 webContents」。

### 15.2 与原稿的差异（都是实施中必须定的口径）

1. **补丁路径只接受相对路径**：绝对路径一律拒绝（文案给根清单与「改成相对写法」的指引）。Codex 支持绝对路径，但我们的根是用户圈的目录，相对路径更不容易让模型「猜」到根外位置。
2. **`..` 一律拒绝而不是折叠后放过**：`resolveInsideRoot` 比 `wiki-fs.js` 更严——补丁里出现 `..` 从来不是笔误，折叠会掩盖一次越界尝试。
3. **AutoApprove 的边界**（规格 §6 只写了「全在写根内」）：
   - 全在写根内且**不含删除语义** → 免问；
   - 含 `Delete File` 或改名（改名 = 删旧 + 增新）→ 仍要问（删除不可逆）；即使用户记住了该目录的允许规则，**删除/改名也不吃这条允许**（规则只覆盖「改内容」）；
   - 目标落在只读根 → 拒绝（`mode=read` 就是不许写）；
   - 目标在根外 → 默认问用户；设置区可改为「直接拒绝」；
   - 补丁**解析不出来**（格式错 / 路径越界）→ 免问（反正一定写不进磁盘，工具层立刻报错，没必要先弹窗）。

   ★ **对 §6 的有意偏差（Lead 拍板）**：§6 原文说「越界 → AskUser」，实现里**越界补丁在 HITL 层免问**，
   由工具层直接拒绝并给出精确原因。理由：让用户批准一个**注定写不进去**的动作是更糟的体验
   （批了仍然失败），而正确出路是去设置区加可写根。配套三条：
   ① 拒绝文案固定包含「目标不在可写根内；如需写入，请先在「设置 → 文件编辑」添加该目录为写根。」
   （常量 `OUT_OF_ROOT_HINT`，工具结果与安全判定共用同一句）；
   ② 拒绝走既有 `ok:false` 工具结果，回合日志（`tool_result` 的 ok 与文本）与过程日志照常留痕；
   ③ 写盘层（桌面 `file-fs.js`）不依赖 HITL 结论，越界一律拒绝——两层防线互不替代。
4. **「记住本次选择」对文件工具按目录前缀记**：`file_patch` 永远不记 `*`；一次补丁跨多个目录就写多条前缀；目标不在可写根内时确认卡**不显示**「记住」并说明原因。这需要 `gate.ts` 一处约 5 行的接线（已获 Lead 批准）。
5. **`file_patch` 的 `meta.risk = "write"`、`file_read = "read"`**；调度仍由 `agentStream` 按 meta 分组，未改主循环。
6. **确认卡行级 diff 需要读盘**：确认卡出现在执行之前，diff 必须读文件当前内容。预览是**只读**（只调 `read`，测试断言绝不调 `write`），并做两件事：疑似密钥行替换成「已隐藏」；总行数超过 200 行截断并注明。
7. **写盘层不创建目录**：父目录不存在直接拒绝（Lead 定稿）。理由：一次拼错路径的补丁不该在磁盘上留下意料之外的目录树。
8. **工具可见性分工具判断**（Lead 定稿，是对 §5.1 末尾「桥存在且至少一条可写根」的细化）：
   - `file_read`：桌面桥存在 + **任意一条根**（read 或 write）即可见——只读根也有意义（读用户圈定的资料）；
   - `file_patch`：桌面桥存在 + **至少一条 write 根**才可见——没有写根注入了也只会反复失败；
   - 两者都不可见时提供者返回 null（注册表跳过），浏览器端永远不可见。
   判据唯一实现在 `tools.ts` 的 `visibleFileTools`，provider 与测试共用。
9. **规则资源**：文件工具的匹配资源是**解析后的绝对路径**，所以规则可以写成 `D:/Obsidian/学院事务/`；非文件工具仍是原来的参数摘要口径（`ruleResource`），既有精确匹配语义原样保留。

### 15.3 已知边界

- **跨文件原子性**：单文件靠 tmp+rename 原子；跨文件在主进程做两阶段（先全部 stage 再全部 rename），rename 阶段中途失败会返回「哪些已完成」的清单，不静默，但不是真正的事务（规格未要求）。
- **协议无转义**：`Add File` 的内容里若有一行以 `*** ` 开头（英文 Markdown 分隔线等），会被当成下一条指令。协议本身没有转义机制（与 Codex 一致），属已知边界。
- **硬链接判定偏保守**：`nlink > 1` 一律拒绝，即使链接其实也在根内。宁可让用户自己复制文件，也不冒「写到根外另一份」的风险。
- **只读根本轮不能通过 HITL 一次性放行**：HITL 批准后写盘层仍会拒绝（双层防线），这是有意的。
- **未做**：自动回滚 / undo 栈、目录遍历、批量删除语义、跨设备同步（规格 §13 已明确不做）；任务区 UI 未改（规格 §10 写「本轮不改 UI」，文件清单通过工具结果文本进入既有 `RolloutTimeline`）。

### 15.4 测试

| 侧 | 文件 | 用例 |
|---|---|---|
| web | `src/lib/fileEdit/parse.test.ts` | 32 |
| web | `src/lib/fileEdit/match.test.ts` | 25 |
| web | `src/lib/fileEdit/apply.test.ts` | 24 |
| web | `src/lib/fileEdit/paths.test.ts` | 26 |
| web | `src/lib/fileEdit/roots.test.ts` | 13 |
| web | `src/lib/fileEdit/safety.test.ts` | 9 |
| web | `src/lib/fileEdit/tools.test.ts` | 21 |
| web | `src/lib/fileEdit/ruleTargets.test.ts` | 12 |
| web | `src/lib/fileEdit/remember.test.ts` | 7 |
| web | `src/lib/fileEdit/patchPreview.test.ts` | 9 |
| web | `src/lib/hitl/policy-prefix.test.ts` | 17 |
| web | `src/components/FileEditCard.test.tsx` | 9 |
| web | `src/components/ToolApprovalModal.patch.test.tsx` | 7 |
| desktop | `path-guard.test.js` | 11（含「wiki-fs 与 path-guard 对同一组路径结论一致」） |
| desktop | `file-fs.test.js` | 30 |

合计新增 **252 例**（web 211 + desktop 41）。越界类用例一律同时断言「被拒绝」与「磁盘上没有新文件 / 原内容未变」；软链、硬链、`..`、NUL、二进制、超限各有用例（Windows 上普通目录软链需管理员权限，用例自动退到 junction，两者都不行时 skip 并注明）。

定向验证命令：

```
pnpm --filter @heming/web test -- src/lib/fileEdit src/lib/hitl src/lib/capability \
  src/components/FileEditCard.test.tsx src/components/ToolApprovalModal.patch.test.tsx
pnpm --filter @heming/web exec tsc --noEmit
cd packages/desktop && node --check file-fs.js path-guard.js \
  && node --test file-fs.test.js path-guard.test.js
```

### 15.5 需要 Lead 处理（不在本轮写入权限内）

1. `packages/desktop/package.json` 的 `build.files` 增加两行：`"path-guard.js",`、`"file-fs.js",`（建议紧跟 `"export-fs.js",` 之后）。
2. `packages/desktop/package.json` 的 `test` 脚本增加：`node --check path-guard.js`、`node --check file-fs.js`、`node --test path-guard.test.js`、`node --test file-fs.test.js`。
3. `docs/INDEX.md`：在「### 智能体运行时」表格加一行（建议）：

   `| [specs/2026-11-02-d53-file-edit-primitive.md](superpowers/specs/2026-11-02-d53-file-edit-primitive.md) | **d.55 文件编辑原语**：`file_patch`/`file_read`、上下文锚点协议与三级匹配、可写根、三态安全、HITL 路径前缀授权、确认卡行级 diff |`

4. `CHANGELOG.md` 文案建议（版本位 `feature`）：
   「新增文件编辑原语：智能体可在用户显式添加的可写根内，用上下文锚点补丁一次改多个文件；确认卡显示「将修改 N 个文件（A/M/D）」与行级 diff，支持按目录前缀记住授权；写盘经 tmp+rename，越界/软链/硬链/二进制/超限一律拒绝。」
