# 导航常驻 / 技能区 / 记忆区 三块改造 · 实施记录

- 日期：2026-10-18
- 触发：用户需求（导航常驻、IM 细节、技能页、记忆页）
- 状态：已完成并验证（**通话新窗口一项未做**，见 §6）

---

## 1. 需求原文

> 左侧导航栏应该常驻，不应该移动。增加一个技能页面。
> 1、IM：雷达界面应该可以放大缩小，聊天界面增加头像，左侧应该对方头像贴近边缘然后跟着气泡，右边为用户本人头像加气泡。下侧聊天栏默认大一点，用户可以自己调整，并且支持用户自己定义大小，拖动改变。语音和视频聊天点击后应该开启一个新窗口
> 2、技能：分为技能和技能池，技能分为内置技能、已装技能、沉淀技能、自定义技能。
> 3、记忆：分为短期记忆，数据库记忆，个人知识库。云端共享数据可以视为个人知识库的一部分。智能体需要手动开启是否需要短期、长期记忆，但是个人数据库默认允许使用

## 2. 导航常驻

| 项 | 改动 |
|---|---|
| `store/ui.ts` | 删除 `navCollapsed` / `setNavCollapsed`；`openConversation` 不再折叠导航 |
| `App.tsx` | 不再渲染 `NavPeek`，恒渲染 `<NavRail />`；移除 ⌘/Ctrl+\ 折叠快捷键 |
| `NavRail.tsx` | 删除 `NavPeek` 导出；新增「技能区」项 |
| 快捷键 | 重排为 Alt+1 主页 / 2 工作区 / **3 技能区** / 4 接口区 / 5 记忆区 / 6 设置区 |

## 3. IM 细节

### 3.1 雷达缩放

- `radar-stage` 包住环线/扇区/扫描/圆心/节点，`transform: scale(z)`；信息卡与缩放控件留在舞台外（不跟着缩）。
- 范围 0.6–1.8、步进 0.1；右下角「− / 百分比（点击复位）/ ＋」，另支持 Ctrl/⌘+滚轮（原生监听 + `passive:false`，普通滚轮不劫持）。
- 纯函数 `clampRadarZoom` 单测覆盖。

### 3.2 聊天头像

- 对方：头像贴左缘 + `gap-2` 紧贴气泡；自己：气泡在左、头像贴右缘（左右镜像）。
- 自己头像取 `useAuthStore` 的当前用户（含 avatar，缺图回落首字）。

### 3.3 输入栏可拖拽

- 单行 `<input>` → `<textarea>`：**Enter 发送、Shift+Enter 换行**（输入法组词中不拦）。
- 默认高度 **132px**（原单行约 56px），拖拽上沿调整，范围 72–360，写入 `heming.chat.composerHeight.v1`，下次进入沿用。
- 行内 `items-end` 对齐，麦克风/发送按钮贴底，不再被拉成整行高。

## 4. 技能区（新页面）

- 入口：导航「技能区」+ Alt+3；`page === "skills"` → `SkillsPage`。
- **技能 tab**：四组分类卡片（数量徽标 + 卡片网格 + 启用开关 + 详情/删除）
  - 内置 `source=builtin` / 已装 `imported` / 沉淀 `distilled`（新增取值）/ 自定义 `user`
  - 分组走纯函数 `categorizeSkill`（可单测）
- **技能池 tab**：全部技能（含未启用）列表：搜索、来源、启用、使用次数、最近使用、导入 SKILL.md、导出、**「转为沉淀」**。
- 数据层复用 `lib/skills/store.ts`；仅为「沉淀」补最小 API。

## 5. 记忆区（重构）

三个分区 + 智能体开关：

| 分区 | 数据来源 |
|---|---|
| 短期记忆 | `WorkingTurn`（会话级近若干轮，2h/40 轮过期），按会话分组、可清空 |
| 数据库记忆 | `EpisodicEntry`（情景）+ `SemanticEntry`（语义），搜索/置顶/删除/新增/导入导出/保留天数 |
| 个人知识库 | 本机知识库条目（localStorage `heming.kb.v1`）+ **云端共享数据**（来自共享文件库，只读展示，可「加入知识库」） |

智能体记忆开关：

- 每个智能体三列：短期记忆（默认**关**）、长期记忆（默认**关**）、个人数据库（默认**允许**，即开）。
- 持久化 `heming.memory.agentPrefs.v1`；纯函数 `resolveAgentMemoryPrefs` 处理缺省与脏数据。
- 文案明确「短期/长期需手动开启；个人知识库默认允许使用」。

技能池相关内容从记忆页移除（已独立成技能区），底层代码保留。

## 6. 语音/视频通话：改为独立窗口（已实现）

**做法**：通话 UI 从「盖满主界面的浮层」改为**独立窗口**，主窗口只负责开窗。

| 层 | 改动 |
|---|---|
| `lib/callWindow.ts`（新） | 纯函数 `buildCallWindowUrl` / `parseCallWindowParams` + `openCallWindow`；窗口名固定 `heming-call`（重复点击复用同一窗口） |
| `components/CallWindow.tsx`（新） | 独立窗口的极简界面：自己建 WS、自己起 `useVoiceCall`，WS 一连上就 `call()`；视频模式渲染本地/远端 `<video>`；静音 / 挂断 / 关窗 |
| `main.tsx` | `?hemingWindow=call` → 只渲染 `<CallWindow/>`，不挂整个 App |
| `ChatPage` | 直聊新增「发起语音通话」「发起视频通话」两个按钮（原来只有一个语音按钮）；群通话确认框也走新窗口。**弹窗被拦截时回退页内面板**，功能不丢 |
| `lib/voiceCall.ts` | 新增 `mode: "voice" \| "video"`（视频时同时采集摄像头）；对外暴露 `localStream` / `remoteStreams` 供视频窗渲染 |
| `desktop/call-window.js`（新） | 纯函数 `isCallWindowUrl`（同源 + 标记才放行）+ `callWindowOptions`（420×640、置顶、最小尺寸） |
| `desktop/main.js` | `setWindowOpenHandler` 增加**唯一例外**：通话窗口 allow 并套用窗口参数；其余仍 deny + 转系统浏览器 |

**为什么必须独立客户端**：新窗口是独立渲染进程，WS 与 `RTCPeerConnection` 都在它自己进程里；所以「发起通话」必须由它自己做，主窗口不能代劳。同源（`app://heming` 或同站点）让 localStorage 的 token 天然共享，不需要传凭证。

**已验证**：
- 单测：`callWindow.test.ts`（URL 往返/缺参/mode 兜底）+ `desktop/call-window.test.js`（同源判定、外部站点拒绝、窗口参数）全绿。
- 真机（Electron 内 `window.open`）：主进程放行 → 新 target `app://heming/index.html?hemingWindow=call…` 出现，标题「通话」、无主界面 nav、有挂断按钮。
- 浏览器直开该 URL：窗口正常渲染，状态提示「仅桌面端支持语音通话」（浏览器端通话本就是关闭的）。

**已知取舍**：
- 浏览器端不支持通话（既有设计），所以网页里点通话按钮会看到该提示。
- 视频为 v1：本地画面为整宽预览，远端按对端数量纵向排列，未做画中画/等比裁切优化。
- 主窗口仍保留页内通话面板（用于**来电**）；即来电仍在主窗口接听，外呼走新窗口。

## 6.5 技能按智能体分配（2026-10-19 追加）

用户要求：技能页要能**选智能体**再分配技能；**技能页只显示已分配**，**技能池全量**；每个分类加「＋」按钮添加。

| 层 | 改动 |
|---|---|
| `lib/skills/types.ts` | 新增 `SKILL_ASSIGNMENTS_KEY = "heming.skillAssignments.v1"` |
| `lib/skills/store.ts` | 新增 `assigned(agentId)` / `assign` / `unassign`（幂等、落盘、过滤已删技能）。**无记录时默认分配全部内置技能**（新智能体开箱可用；已装/沉淀/自定义需显式添加） |
| `SkillsPage` | 顶部「分配对象」下拉（名册来自 `listAgents`，默认选第一个）；技能 tab 只列 `assigned` 里的技能；每个分类标题旁 ＋ 按钮打开「添加技能」浮层（只列该分类下未分配的技能）；卡片操作区新增「移除」（取消分配）；沉淀动作会自动把副本分配给当前智能体 |

验证：`SkillsPage.test.tsx` 12 例（含「切智能体后按 agent 隔离」「＋ 只列未分配」「移除后池里仍在」）、
`skills.test.ts` 43 例（含分配幂等/隔离/重水合/已删过滤）；全量 **52 文件 / 741 用例全绿**。真实页面（云端账号）：
分配对象「和小鸣」、已分配 4 个、＋ 面板按分类过滤。

## 7. 验证

| 项 | 结果 |
|---|---|
| 门禁 | web **51 文件 / 728 用例全绿**（改造前 721），typecheck 通过 |
| 导航常驻 | `ui.test` / `NavRail.test` / `App.test` 覆盖：进入会话后 `nav` 仍在、无「呼出」条 |
| 雷达缩放 | `clampRadarZoom` 单测；真实页面点击 ＋ 两档 → 120%（截图 `05-radar-zoom.png`） |
| 聊天 | 真实登录云端后进入「和鸣交流群」：对方头像贴左缘、自己头像贴右缘，输入栏 132px + 拖拽把手（截图 `08-chat.png`） |
| 技能区 | 四分类 + 技能池（截图 `01-skills` / `02-skills-pool`） |
| 记忆区 | 三分区 + 智能体开关默认值（截图 `03-memory`） |

## 8. 遗留

- 通话新窗口（§6）未做。
- 雷达缩放后悬浮信息卡的定位仍按缩放后的 DOM 矩形计算，极端倍数下可能贴边（未做边界夹取）。
- 输入栏高度只记数值，不随窗口尺寸自适应（窗口很矮时可能挤压消息区）。

---

## 9. 打包与部署记录（2026-10-18 本批）

- **云端已部署**：`tar`（排除 `.tmp`，719KB）→ SFTP → `~/heming` 解包 → `docker compose -p heming build` → `up -d`。
  线上产物 `assets/index-BDHYz_UP.js`，`/api/health` = `{"ok":true}`；nginx 日志无 error。
- **桌面安装包已重打**：`packages/desktop/release/和鸣 Setup 0.0.1.exe`（75MB，23:47），内含本批 UI。
- **打包注意（重要）**：为省 C 盘空间，`.tmp/cache/electron/Cache` 里本项目的 electron zip 已删除。
  因此 `electron-builder` 会尝试重新下载而失败（`ERR_ELECTRON_BUILDER_CANNOT_EXECUTE`）。
  现在必须显式指向解包好的 electron 目录：

  ```bash
  cd packages/desktop
  ELECTRON_BUILDER_CACHE=<repo>/.tmp/cache/electron-builder/Cache \
  ELECTRON_CACHE=<repo>/.tmp/cache/electron/Cache \
  pnpm exec electron-builder --win nsis \
    --config.directories.output=release-new \
    --config.electronDist=<repo>/node_modules/.pnpm/electron@31.7.7/node_modules/electron/dist
  ```

  再把 `release-new/和鸣 Setup 0.0.1.exe` 覆盖回 `release/`（`release/win-unpacked` 里旧 `app.asar` 有时被占用，
  覆盖会失败，所以换目录打包）。
