# 和鸣 UI 体验问题调研与修复方案（知识库左栏字号 / 任务输出顺序）

> 日期：2026-11-20　｜　状态：**两个问题均已实施并通过测试**。
> 实施记录（2026-11-20 20:53）：问题一已按 1.4 节改完 4 个文件的刻度类；`vitest run src/lib/designScales.test.ts src/components/knowledge` → 15 文件 / 206 测试全过；`tsc --noEmit` exit 0。文件树缩进同步改为 `6+depth*15`、占位 `w-[13px]`。
> 实施记录（2026-11-20 21:15）：问题二按 2.4 节四处方案实施，answer 仅作**流式展示态**，不改落盘转录（避开并行会话对 transcript 的改动）：`TranscriptStep.kind` 加 `"answer"`；`buildStreamSteps` 增收 answer 文本+切点、按 think→answer→tool 真实先后 emit；`markReasoningBreak` 同步记录正文长度切点；`MessageSteps` 加 answer 行内渲染（末段流式带 ▌）；气泡正文在有 answer 步时不再整段重画以避免重复。`tsc --noEmit` exit 0；`vitest run src/store/chat.test.ts src/components/AgentStreamBubble.test.tsx` → 92 测试全过；`vitest run src/components/ChatPage.test.tsx` → 209 测试全过（仅 pre-existing act() 警告）。新增 2 个交错顺序测试（answer 夹在工具之间顺序正确、末段光标）。
> 用户反馈（两条，原文）：
> 1. 「左边的那一栏字体可以大一点，现在有点小了。」——指**知识库页左栏**。
> 2. 「输出格式还是有问题，在任务过程进行一次回答输出后，应该在它下面再显示后面的调用和思考，不是一直在上方一个接着一个显示。」——指**会话页任务过程中，回答与后续调用/思考的排列顺序**。
> 事实来源：`kb-font-explorer` / `flow-order-explorer` 两个只读调研代理，均基于当前 `D:\Heming\packages\web\src\` 代码，未修改任何文件。
> 说明：这两项与团队协作功能无关，是和鸣自身的 UI/UX 细节，单独成文，便于与协作方案分别评审。

---

## 0. 结论速览

| # | 问题 | 根因 | 最小修复 | 工作量 |
|---|---|---|---|---|
| 1 | 知识库左栏字体偏小 | 左栏主体用 11–12px 刻度类（`text-ui-xs`/`text-ui-sm`），比中栏正文 13px 小 1–2px | 只改知识库页相关文件的刻度类（`text-ui-sm→text-ui-md`、`text-ui-xs→text-ui-sm`），**不动全局 token** | ~0.5 人日 |
| 2 | 回答之后的调用/思考堆在上方 | `TranscriptStep` 只有 `think`/`tool` 两种、无 `answer`，正文始终是单一字符串，无法按真实时间插入时间线 | 给 `TranscriptStep` 加 `answer` 类型，按工具开始 marks 同步切分正文，行内渲染 answer 步骤 | ~1.5 人日 |

---

## 1. 问题一：知识库左栏字体偏小

### 1.1 现状定位

- 三栏容器：`packages/web/src/components/knowledge/KnowledgePage.tsx:784` `<div className="flex min-h-0 flex-1">`。
- **左栏**：`KnowledgePage.tsx:786-893` `<aside data-testid="knowledge-left" className="flex w-[248px] shrink-0 flex-col border-r border-line-soft bg-panel">`——宽度固定 248px。
  - 页签条 `:793` `px-1.5 py-1`；页签按钮 `:800` `ui-hit flex-1 rounded-sm px-1.5 py-1 text-ui-sm`。
  - 内容区 `:811` `min-h-0 flex-1 overflow-hidden`；`:815` `ui-caption`；`:827`、`:835` `text-ui-sm`。
  - 三个子组件挂载点：`:848` FileTree、`:870` SearchPanel、`:883` TagPanel。
- **左栏三个子组件的字号**：
  - `FileTree.tsx:211` `flex min-h-[26px] ... py-[3px] pr-1 text-left text-ui-sm`；`:214` `style={{ paddingLeft: 6 + depth * 13 }}`（树缩进）；`:223` 缩进占位 `w-[11px]`；`:226` `truncate`；`:269` 右键菜单 `text-ui-sm`；`:282` `ui-micro`；`:303` `ui-caption`。
  - `SearchPanel.tsx:99` `ui-input h-7 text-ui-sm`；`:151/153/159` `px-2 py-3 text-ui-sm leading-5`；`:176` `truncate text-ui-sm`；`:177/179` `text-ui-xs`（`:179` 另带 `leading-snug`）；`:164/196` `ui-caption`。
  - `TagPanel.tsx:58` `ui-input h-7 text-ui-sm`；`:76/81/92` `text-ui-sm leading-5`；`:44` `ui-micro`；`:49/99` `text-ui-xs`。

### 1.2 字号刻度的唯一来源与硬约束

- 唯一样式源 `packages/web/src/index.css`（无 `ui-*.css` 分文件）。`@theme` 定义于 `:87-90`：
  - `--text-ui-xs: 11px`、`--text-ui-sm: 12px`、`--text-ui-md: 13px`、`--text-ui-base: 14px`。
- 工具类：`:653-658` `.ui-body-sm` = 13px/20px、`.ui-caption` = 12px/18px；`:667` `.ui-micro` = 12px；`:718` `.ui-input` = 13px。
- `tailwind.config.js` 只配 colors，无 fontSize。
- **硬约束**：`lib/designScales.test.ts:38-46` 禁止源码中出现 `text-[Npx]` 这类字面量——**只能换刻度类，不能写死 px**。这是决定修复方式的关键：不能图省事直接写 `text-[13px]`，必须在既有刻度里升级一档。

### 1.3 对比：左栏确实偏小

- 页头标题 22px（`index.css:93` `--text-ui-xl`）。
- 中栏页签 `KnowledgePage.tsx:922` `text-ui-sm`；面包屑 `:955` `text-ui-xs`；正文 `PreviewPane.tsx:404` `text-ui-md leading-reading`（13px/1.75），标题 `:319-334` `text-ui-lg/base/md`。
- 右栏 `BacklinkPane.tsx:67` `text-ui-sm leading-5`、`:128` `text-ui-xs`。
- **左栏主体 11–12px，比中栏正文 13px 小 1–2px**——反馈属实。

### 1.4 最小修复方案

**决策：不动全局 token**（改 `--text-ui-sm` 会影响全站所有用到该刻度的地方，回归面不可控），只把知识库页左栏相关节点升一档：

| 文件 | 改动 |
|---|---|
| `components/knowledge/KnowledgePage.tsx` | `:800`、`:827`、`:835` `text-ui-sm → text-ui-md`；`:815` `ui-caption → ui-body-sm` |
| `components/knowledge/FileTree.tsx` | `:211`、`:269` `text-ui-sm → text-ui-md`；`:282` `ui-micro → ui-body-sm` |
| `components/knowledge/SearchPanel.tsx` | `:99`、`:151`、`:153`、`:159`、`:176` `text-ui-sm → text-ui-md`；`:177`、`:179` `text-ui-xs → text-ui-sm` |
| `components/knowledge/TagPanel.tsx` | `:58`、`:76`、`:81`、`:92` `text-ui-sm → text-ui-md`；`:49`、`:99` `text-ui-xs → text-ui-sm`；`:44` `ui-micro → ui-body-sm` |

**布局影响与注意点（必须一起处理）**：
- 左栏宽度固定 248px（`:788`），字号升一档后 `truncate` 行（`FileTree.tsx:226`、`SearchPanel.tsx:176`、`TagPanel.tsx:98`）更容易截断——权衡是可读性优先，必要时把 aside 宽度调到 ~272px。
- 树缩进 `6 + depth * 13`（`FileTree.tsx:214`）与占位 `w-[11px]`（`:223`）需同步加宽到约 15px / 13px，否则展开图标与文字会对错位。
- 行高 `min-h-[26px]`（`:211`）与 `leading-5` 可升到 `leading-6`；代价是可见行数略减。
- 相关 `*.test.tsx` 无字号断言，`data-testid="knowledge-left"` 保持不变，测试无需改。

**验收**：左栏文件树/搜索/标签文字肉眼明显比现在大、与中栏正文协调；深层树节点图标与文字不错位；248px 宽度下常用文件名不被截断到无法辨认。

---

## 2. 问题二：回答之后的调用/思考堆在上方

### 2.1 现象与定位

期望：任务执行中，一次"回答/回复文本"输出后，**其后的工具调用与思考显示在这条回答的下方**（按真实发生顺序交织）。
实际：所有思考/工具块在上、所有回答正文在下，"一直在上方一个接着一个显示"。

- 会话页主组件：`packages/web/src/components/ChatPage.tsx`（7471 行）；消息列表 `:6340` `windowedMessages.map(...)`，窗口计算 `:2695-2698`。
- 流式气泡子组件：`packages/web/src/components/AgentStreamBubble.tsx`。
- **消息本身的顺序没问题**：按到达顺序 append（`store/chat.ts:819-837 appendMessage`；`:838-851 setMessages` 按 createdAt 插回），没有 sort。问题出在**单条消息内部"步骤 vs 正文"的排布**。

### 2.2 根因：数据结构里没有"回答"这个步骤类型

- `store/chat.ts:152-156`：
  ```ts
  export interface TranscriptStep { kind: "think" | "tool"; text?: string; toolId?: string; }
  ```
  **只有 `think` / `tool` 两种，没有 `answer`**。
- 因此回答正文永远单独渲染在步骤**之后**：
  - 非流式：`ChatPage.tsx:6447-6459` 先渲染 `MessageProcess` / `ReasoningBlock` / `ToolTraceGroup`，最后 `:6459` 才渲染 `<div ...>{messageBody}</div>`。
  - 流式：`AgentStreamBubble.tsx:81-94` 先步骤、`:97-109` 后正文。
- 事件流本身带顺序信息：WebSocket（`lib/ws.ts:102` `/api/ws`），`WsServerEvent` 定义在 `packages/shared/src/schemas.ts:290-339`——`agent_chunk` 带 `streamId` + `index`（`:312`），`message_new` 带 `streamId`（`:294`）。但前端**不按 index 排序**，只按 `streamId` 累积到 `streaming`（`store/chat.ts:1008-1137`），`index` 仅用于 E2E AAD 解密。
- 三条平行累加器：`onReasoning`（`ChatPage.tsx:3454`）、`onToolTrace`（`:3468`）、正文 delta（`:3138 onLocalDelta`）；收口 `:1937 collectStreamTranscript` 只把 think/tool 折成 steps，正文留在 `payload.text`。
- 交错切分逻辑在 `ChatPage.tsx:775-796 buildStreamSteps`，但它**只切 reasoning + tools**，marks 由 `:1855 markReasoningBreak` 在工具开始时记录思考长度——**正文不参与切分**。

### 2.3 为什么现在才暴露（回归来源）

d.362（`8f0fe97d`）起，工具轮的"过渡话术"正文也 emit 进 `text`（`ChatPage.tsx:3138 onLocalDelta`），正文在时间上已经与工具交错；但 `text` 仍是**单一字符串**、`TranscriptStep` 仍无 `answer` 类型，无法把回答按时间插进步骤时间线。于是出现"时间上交错、展示上分离"——全部思考/工具在上、全部回答在下。教训：**d.350 只让"思考/工具"交错，d.362 让正文进入时间流后没有同步扩展 step 类型**，是本次回归的根源。

### 2.4 最小修复方案（四处）

1. **`store/chat.ts:152-156`**：`TranscriptStep.kind` 增加 `"answer"`，复用 `text` 字段存回答片段。
2. **`ChatPage.tsx:775-796 buildStreamSteps`**：增加入参（answer 文本及其切点），按工具开始的 marks **同时切分 reasoning 与 text**，按真实先后 emit `{kind:"answer"}` / `{kind:"think"}` / `{kind:"tool"}`。需要仿 `streamMarksRef`（`:1854`）新增一组记录 text 长度的 marks，并在 `:3479 markReasoningBreak` 处同步记录当前 text 长度。
3. **`AgentStreamBubble.tsx:149-167 MessageSteps`**：增加 `kind==="answer"` 分支，行内渲染 `<MarkdownMessage text={step.text}/>`。
4. **`ChatPage.tsx:6447-6459`**：有 steps 时改用"含 answer 的 MessageProcess"展开，并**避免 `:6459` 再次重复渲染尾部正文**（否则答案会显示两遍）。

**不做的事**：不改后端事件顺序、不新增 ws 字段（消息顺序与 stream index 都是对的，问题纯在前端步骤建模）；不重新排序 messages（append 顺序本就正确）。

**验收**：一个"先说一句话 → 调工具 → 再解释 → 再调工具"的任务，界面呈现顺序与发生顺序一致（回答、工具、回答、工具自上而下）；历史会话（已落库、无 answer step）渲染兼容不回退；流式与结束后渲染一致，不出现正文重复。

---

## 3. 实施顺序与工作量

1. 问题一（~0.5 人日）：改动集中、风险低，可先做；做完在知识库页目视核对深层树节点对齐。
2. 问题二（~1.5 人日）：涉及 `TranscriptStep` 契约与流式收口，建议补一条 E2E：模拟"answer→tool→answer"的 chunk 序列，断言渲染顺序；注意 `packages/web/src/lib/designScales.test.ts` 等契约测试的约束不冲突。

合计 ~2 人日。两项均**未实施**，等评审确认后再动代码。

---

## 4. 关键文件索引

- 知识库页：`packages/web/src/components/knowledge/KnowledgePage.tsx`（三栏 :784、左栏 :786-893、字号节点 :800/815/827/835）、`FileTree.tsx`（:211/214/223/226/269/282）、`SearchPanel.tsx`（:99/151/153/159/176/177/179）、`TagPanel.tsx`（:44/49/58/76/81/92/99）。
- 样式刻度：`packages/web/src/index.css`（@theme :87-90、工具类 :653-658/667/718）、`packages/web/src/lib/designScales.test.ts:38-46`（禁止写死 px 的硬约束）。
- 会话渲染：`packages/web/src/components/ChatPage.tsx`（列表 :6340、buildStreamSteps :775-796、marks :1854-1855、正文 delta :3138、reasoning :3454、tool :3468、markReasoningBreak :3479、collectStreamTranscript :1937、消息体渲染 :6447-6459）、`packages/web/src/components/AgentStreamBubble.tsx`（气泡 :52、步骤 :81-94/137/149-167、正文 :97-109、MessageProcess :179、ReasoningBlock :235、ToolTraceGroup :308、ToolTraceList :341）。
- 数据契约：`packages/web/src/store/chat.ts`（TranscriptStep :152-156、append/setMessages :819-851、streaming :1008-1137）、`packages/shared/src/schemas.ts:290-339`（WsServerEvent；agent_chunk index :312）、`packages/web/src/lib/ws.ts:102`。
