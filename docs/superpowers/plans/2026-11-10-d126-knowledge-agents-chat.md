# d.126 · 知识库 / 智能体 / 对话 / 插件 五件事（分阶段计划）

> 用户 2026-11-10 晚五点诉求（原话见会话）。本文件只定**范围与顺序**，实现细节由各任务规格/代码注释承载。
> 背景：仓库当前有另一个会话在同时改 `packages/desktop/*plugin*`、`App.tsx`、`SettingsPage.tsx`、
> `store/llm.ts` 等插件/模型相关文件；本计划**刻意不碰**这些文件，避免同仓并行编辑互相覆盖。

## 0. 决策与解释（先定口径，避免各做各的）

1. **知识库的「安装目录」**：默认根改为「应用可写根」——打包版取可执行文件所在目录下的 `wiki/`，
   开发版回退 `~/Heming/wiki`；两者都不可写时回落 `%USERPROFILE%\Heming\wiki`，并在知识库页显式展示
   当前根路径 + 一键打开目录。现有 `vaults.json` 里指向旧根的库**不迁移、不删除**，新增默认库时建同结构。
2. **卡帕西 LLM Wiki 标准**作为知识库的**结构约束**（不是另一套 UI）：
   `raw/`（只读来源）、`wiki/{entities,concepts,sources,synthesis,notes}/`（LLM 维护页）、
   `index.md`（目录）、`log.md`（追加流水）、`schema.md`（规约）、`首页.md`（导航入口）；
   每个 `.md` 必须有 `created` + `tags` frontmatter。缺什么由知识库页「标准检查」一次性列出，
   初始化按钮一次补齐（幂等，不碰已有内容）。
3. **图谱**：现有 `WikiGraphView` 已支持滚轮缩放 + 拖拽平移；本轮改为**以光标为中心的连续缩放**
   （不再一格一格跳）、滚轮步进与拖拽阈值可测，并补「重置视图 / 缩放百分比 / 拖拽提示」。
4. **插件独立化**：目标 = 插件（含内置能力模块）不占用本体程序代码，能力/页面/引擎由插件包自带。
   这是跨轮架构工程（涉及 幕僚/信息中枢/自动化/工作流 四个内置模块的迁移、分发、签名、设置页入口），
   本计划只做**方案 + 第一步**：先盘点「本体里属于插件的东西」并给出迁移表；具体迁移另立规格。
   与并行会话（正在做 `plugin-engine.js`）协同：本轮不改插件运行时文件。
5. **技能页去 AI 味卡片**：删除 `ToneCard` 独立卡片；「去 AI 味」保留为内置技能（`builtin-less-ai-tone`），
   默认参与写作类技能调用（技能池默认启用、不再单独占一张卡片/入口）。
6. **智能体页**：三个一级 Tab：**对话 / 协作 / 智能体**。
   - 对话：左栏 = Claude Code 风格会话列表（顶部 新建/搜索，按智能体分组、会话名为一级信息）；
   - 协作：现有 `CollabView` 原样收进；
   - 智能体：名册 + **独立编辑页**（不再用弹窗），负责新建/编辑/删除/绑定模型。
7. **对话界面**：不展示头像；消息按「普通 agent 工具输出」呈现——用户/助手文本、思考块、工具调用块
   都是转录的一部分，会话结束后仍可展开查看（落盘/历史消息模型需带 thinking/tools）。
8. **UI/UX**：继续沿用 d.125 的 `.ui-card` / `.ui-segment` / `.ui-alert` / token；新页面不再引入新的
   写死颜色或任意阴影。

## 1. 阶段与验收

| 阶段 | 内容 | 验收 |
|---|---|---|
| A（本轮） | 技能页去 AI 味卡片删除 + 默认技能；知识库标准根/结构检查/初始化；图谱光标缩放与重置 | 对应单测全绿；知识库页能显示「标准检查」结果与根路径；图谱滚轮缩放以指针为中心 |
| B（本轮/下轮） | 智能体页三 Tab + Claude Code 会话栏 + 智能体编辑页 | 三 Tab 可切、会话名在左栏、编辑不再弹窗；相关组件测试 |
| C（本轮/下轮） | 对话去头像 + thinking/tools 转录持久化 | 历史消息里能看到思考/工具块；会话结束后展开可见；不再渲染头像 |
| D（另立） | 插件独立化（模块迁出本体、插件包自带页面/引擎、分发与签名） | 另立规格；本轮只交盘点表 |

## 2. 写范围（避免与并行会话冲突）

- 阶段 A：`packages/web/src/components/skills/**`、`components/SkillsPage.tsx`、`components/ToneCard.tsx`、
  `components/knowledge/**`、`components/WikiGraphView.tsx`、`lib/vault/**`、`packages/desktop/vault-fs.js`(+test)。
- 阶段 B：`components/AssistantPage.tsx`(+test)、新建 `components/assistant/**`、`AgentFormModal.tsx`（只做复用/拆分）。
- 阶段 C：`components/ChatPage.tsx`(+test)、`components/AgentStreamBubble.tsx`(+test)、`store/chat.ts`（消息模型持久化字段）。
- **不碰**：`App.tsx`、`SettingsPage.tsx`、`packages/desktop/main.js`、`plugin-*`、`store/llm.ts`、`types/widgets.ts`。

## 3. 已知风险

- 并行会话正在改插件/模型相关文件：本计划所有任务开始前先 `git status --short` 复核，只 add 自己的文件。
- `wiki/index.ts` 含历史 NUL，禁止整文件重写；检索相关只读。
- 知识库页的「安装目录」写权限：Program Files 安装可能只读，必须回落并如实提示，不允许静默失败。
