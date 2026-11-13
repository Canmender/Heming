# UI/UX 重构交付记录（d.140.3.72.11）

- 日期：2026-11-13
- 版本基线：`d.140.3.55.10`（HEAD `e7151e9b`）→ 第 1 轮随 `d.140.3.56.x` 出包 → 第 2–4 轮 `d.140.3.57.11` → 第 5 轮 `d.140.3.58.11` → 第 6 轮 `d.140.3.59.11` → 第 7 轮 `d.140.3.60.11` → 第 8 轮 `d.140.3.61.11` → 第 9 轮 `d.140.3.62.11` → 第 10 轮 `d.140.3.63.11` → 第 11 轮 `d.140.3.64.11` → 第 12 轮 `d.140.3.65.11` → 第 13 轮 `d.140.3.66.11` / `d.140.3.67.11`（安装包外壳 + 打包版实测）→ 第 14 轮 `d.140.3.68.11`（NSIS 安装器取消确认）→ 第 15 轮 `d.140.3.69.11`（字形图标归位）→ 第 16 轮 `d.140.3.70.11`（字重与字号刻度）→ 第 17 轮 `d.140.3.71.11`（技能页浮层并入 Dialog）→ 第 18 轮 `d.140.3.72.11`（写死色值清零）
- 配套审计：`docs/UIUX-AUDIT-2026-11-13.md`（139 条：S1 9 / S2 73 / S3 57，含三份分报告索引）
- 技能说明：用户指定的 `mshumer/unslop`、`alchaincyf/huashu-skills` 本机无外网无法拉取；本次以本机 `anthropic-frontend-design`（anti-slop 铁律）与 `ui-design-pro`（UI UX Pro Max 原则）作为审计与改造标尺，两者冲突处以 anti-slop 为准（字体、去装饰、去 emoji 图标）。

## 0. 一句话结论

四轮改造都落在「全局杠杆」上（token → 基元 → 壳层 → 页面级定点），**没有引入新的视觉语言**：把已有的 token 体系补全、把重复的定义合并、把写死的字面量收回到变量、把页面级特例拉回基元。净效果是同屏字号档位从 6 档收到 3 档、卡片阴影从 6 套收到 1 套描边、暗色不再依赖 116 条类名补丁兜底。

## 1. 四轮清单

### 第 1 轮 · 布局重构（信息密度与响应式）

| 文件 | 改动 |
| --- | --- |
| `packages/web/src/components/layout/PageShell.tsx` | 页头 `px-6 py-4` → `px-6 py-3`，`items-start` → `items-center`，`gap-4` → `gap-x-4 gap-y-2`；宽度档新增 `form`(760px) / `prose`(680px)，`WIDTH_CLASS` 改为导出；`padded` 注释明确「仅 scroll=true 生效」 |
| `packages/web/src/index.css` | `.ui-page-title` 28/36 → **22/30**（`tracking-[-0.015em]`）；`.ui-page-sub` 14/22 → **13/20**（`mt-0.5`）；`.ui-section-title` 15 → **14**；`.ui-micro` 10 → **11**；新增 `--chat-gutter`（1.5rem，≤640px 时 0.75rem） |
| `packages/web/src/App.tsx` | 根节点去掉多余 1px 外框与 `bg-white`；共享文件表头三个按钮统一 `ui-btn ui-btn-sm ui-btn-ghost`；ReconnectPanel 全部改基元类；拖宽手柄 8px → 12px，补 `aria-valuemin/max/now` 与 `hover:bg-[var(--line-soft)]`；抽屉遮罩 `bg-black/30` → `bg-[var(--scrim)]`，面板去 `shadow-xl` 改 `ui-overlay-shadow` |
| `packages/web/src/components/NavRail.tsx` | 帮助/固定按钮 26 → 32px，头像 28 → 32px，组间距统一 `gap-2`/`pt-2`，`font-bold` → `font-semibold` |
| `packages/web/src/components/assistant/ConversationRail.tsx` | `<900px` 时自动收起（`matchMedia` + `change` 监听，JSDOM 下安全退化），避免 264px 侧栏在 375 视口把对话区挤成一条缝；`text-[#666]` → `text-muted` |
| `packages/web/src/components/assistant/AgentFormPanel.tsx` | 弹窗 `w-[380px]` 补 `max-w-[min(380px,92vw)]`，`bg-white` → `bg-surface` |
| `packages/web/src/components/NotificationCenter.tsx` | 面板补 `max-w-[calc(100vw-80px)]`（原先 60px 轨 + 320px 面板在 375 下越界） |
| `packages/web/src/components/ChatPage.tsx` | 15 处 `px-6` 统一为 `px-[var(--chat-gutter)]`（页头 / 提示条 / 消息区 / 状态行 / composer / 底部提示） |
| `packages/web/src/lib/navPrefs.test.ts` | 字号断言同步到 22/30 与 13/20，测试名改为「四档字号语义类名保持不变（尺度值随轮次重定）」 |

### 第 2 轮 · 样式重构（token 与基元收敛）

| 文件 | 改动 |
| --- | --- |
| `packages/web/src/index.css` | 新增 `--danger-on / --warn-on / --success-on / --info-on`（亮色 `#fff`，暗色深底 `#2a0f0f` 等）：原先暗色下亮底 + 白字只有 1.7–2.3:1；新增 `--shadow-overlay` 并让 `.ui-overlay-shadow` 只引用变量；`.ui-card` 删阴影只留 `border-line-soft` 描边；`.ui-alert` 合并同名两份定义（原 271 与 560 各一份，后者覆盖前者，danger/warn/info/success 部分成死代码），补 `muted` 变体；`.ui-btn` / `.ui-segment` / `.ui-filter-chip` 补 `cursor-pointer`，`.ui-btn-danger` 改 `color: var(--danger-on)`；`@layer base` 补统一 `:focus-visible` 焦点环与 `button:not(:disabled)` 光标；`.ui-chip` 改胶囊；`--chart-2` 紫 `#7c6bd6` → 蓝绿 `#0f9d8a`，`--chart-label` 提对比到 `#5c6673` |
| `packages/web/src/components/ux/OnboardingCard.tsx` | 完成徽标 `text-white` → `text-[var(--success-on)]` |
| `packages/web/src/components/ToolApprovalModal.tsx`、`home/RecentConversations.tsx` | 危险操作按钮 `text-white` → `text-[var(--danger-on)]` |

### 第 3 轮 · 设计优化 I（字面量 → 语义 token）

批量替换（`ops_replace`，`**/*.tsx`，逐条核对测试断言后再落）：

- `bg-white` → `bg-surface`（16 处 / 14 文件，含 `ConfirmDialog`、`LoginPage`、`Skeleton`、`AgentPicker`…）
- `bg-black/20`、`bg-black/30` → `bg-[var(--scrim)]`（14 处）；**保留** 图片灯箱 `bg-black/75` 与拖拽层 `bg-black/10`
- `text-[#555]/#444]` → `text-body`，`text-[#999]/#666]` → `text-muted`，`text-[#2563eb]` → `text-[var(--info)]`，`text-[#15803d]` → `text-[var(--success)]`，`text-[#8a5a00]/#92400e]` → `text-[var(--warn)]`
- `bg-[#f3f3f3]` → `bg-subtle-3`，`bg-[#f1f1f1]` → `bg-subtle-4`，`bg-[#fffbeb]` → `bg-[var(--warn-soft)]`
- `accent-[#1a1a1a]` → `accent-[var(--ink)]`，`focus:border-[#bbb]` → `focus:border-ink`，`divide-[#f4f4f4]` → `divide-line-soft`
- 故意未动：`text-[#b42318]`（`plugins/shared.tsx` 的 `ERROR_TEXT` / `BTN_DANGER_SM`，`PluginsPage.capabilities.test.tsx` 断言该字面量存在）、`text-[#b45309]`（`ContextSettingsCard`，另有测试对它做了反向断言）。这两处留给「把语义类写进测试断言」的下一轮。

### 第 4 轮 · 设计优化 II（可达性与破坏性操作）

| 文件 | 改动 |
| --- | --- |
| `packages/web/src/components/RouteGroupsCard.tsx` | 删候选链接 `ConfirmDialog`（说明「绑定它的智能体会回到默认连接，已有用量记录不受影响」＋「这一步不能撤销」），同时卡片壳换 `ui-card` |
| `packages/web/src/components/ModelPage.tsx` | 删分组 / 删密钥原为 `onClick` 直执行，改为原地两步确认（`dangerConfirm` state；复用该页 `agentConfirm` 的就地提示习惯），确认后才 `run(...)` |
| `packages/web/src/App.tsx` | `SharedFilesPanel` 三处 `window.alert`（上传失败 / 未开会话绑定 / 未开会话发送）改为面板内联 `role="alert"` 提示行，可关闭、不阻塞整页；成功时自动清空 |
| `packages/web/src/components/ui/Switch.tsx` | 视觉仍是 18×32，但用 `after:` 伪元素把命中区撑到 32×48（原按钮高度 18px 远低于 32px 标尺） |
| `packages/web/src/index.css` | 新增 `.ui-hit`（`::after` 扩 7/6px）供 24–28px 小图标按钮复用 |

## 2. 遗留与未做

审计 139 条里，本轮只覆盖了全部 9 条 S1 与约三分之一的 S2/S3。明确留给后续：

1. **基元采用率**：全仓仍有 265 处手拼 `"ui-btn …"`、`ErrorState` 零采用、`TextField` 仅 1 处。第 3/4 轮只做了「新代码用基元 + 字面量收口」，没有做批量替换（改动面太大、无 typecheck 兜底时风险不可控）。
2. **三态统一**：加载 4 种 / 空 3 套 / 失败 5 种仍在；第 5 轮把插件区三处逐字重复的空态收进 `EmptyState framed`，整体仍需一次 `ui/AsyncBoundary` 级别的抽象，属独立一轮。
3. **弹窗壳统一**：11 个弹窗各自拼壳（4 种宽度、2 种圆角）。审计建议抽出 `ui/Dialog`，本轮 `ConfirmDialog` 已是事实标准但未强制。
4. **ModelPage 表单语义**（S1-9）：第 5 轮已做「枚举中文化 + 来源表单/多机同步 7 个字段的可见 label」，其余 20+ 字段仍是 `aria-label`（读屏有名字，但填过内容后看不到这一格是什么），需要按表单分组逐块补 label + 必填/错误关联，属独立一轮。
5. **暗色兼容层**：`index.css` 里 116 条按类名覆盖仍是兜底网，本轮把常见字面量换成了 token，但没删桥接规则——删早了会一屏花掉，应等页面全部改用 token 类后再逐条删。
6. **`.ui-btn` 12px 与页脚 `.ui-caption` 12px** 保持不变：再降会牺牲中文可读性，反而违反「更简洁」的目标。

## 3. 验证与冒烟

**已执行**（合并到主干时 shell 通道恢复，2026-11-13 14:00–14:10）：

| 命令 | 结果 |
| --- | --- |
| `pnpm -r typecheck` | 通过（5 个包；合并时 `App.tsx` 的 `asideNotice` 状态声明落到 `App` 而不是 `AppShell`，typecheck 报 10 处 `Cannot find name`，已把 `useState` 移到 `SharedFilesPanel` 的宿主 `AppShell` 里） |
| `pnpm --filter @heming/web test` | **297 个文件 / 4366 例全通过**（唯一失败是 `navPrefs.test.ts` 里旧的 `box-shadow: 0 8px 24px rgba(…0.14)` 字面量断言——第 2 轮已把浮层阴影收成 `--shadow-overlay` 变量，断言同步改为「类引用变量 + 亮暗两档 token 值」） |
| `pnpm -r build` | 通过（web 的 vite 产物与 server/shared 的 tsc 产物均落盘） |

> 早前那一轮记录写的是「shell 不可用、未跑任何检查」，其风险已由这次的实跑覆盖：三个门禁全绿，没有留下「靠肉眼核对的断言」。

人工冒烟清单（真浏览器回归时按此走）：

1. 宽窗 / 窄窗（<1200）切换：右栏共享文件、拖宽手柄（键盘 Tab 聚焦后方向键行为不变）、窄窗抽屉遮罩颜色与暗色一致。
2. 375 宽（DevTools 设备模式）：聊天页、智能体页（会话轨自动收起）、通知面板、智能体表单弹窗均无横向滚动。
3. 亮 / 暗切换：页面标题、卡片描边、图表（`--chart-2` 现在是蓝绿）、危险按钮、完成徽标文字对比。
4. 键盘：Tab 走一遍导航栏 → 页头按钮 → 列表行，焦点环处处可见（含 `.ui-btn` 与 `.ui-segment`）。
5. 破坏性操作：删候选链（弹 `ConfirmDialog`）、删分组 / 删密钥（原地两步确认），Esc 可取消。
6. 共享文件：不开会话点「绑定」/目录里发文件，提示出现在面板内而不是 `alert` 弹窗。
7. 开关：18px 高的开关点边缘也能切换（命中区已撑大）。

## 4. 回滚

改动集中在样式与壳层，无数据/接口变更。回滚按轮次：

- 只回样式：还原 `packages/web/src/index.css` 至 `d.140.3.55.10` 版本。
- 只回第 4 轮：`RouteGroupsCard.tsx`、`ModelPage.tsx`、`App.tsx` 三文件的 `dangerConfirm`/`asideNotice` 段。

## 5. 与审计文档的对应

| 审计条目 | 本轮处置 |
| --- | --- |
| S1-1 暗色 danger 按钮对比 | 第 2 轮 `--danger-on` |
| S1-2 暗色完成徽标对比 | 第 2 轮 `--success-on` |
| S1-3 375 聊天区仅 111px | 第 1 轮会话轨自动收起 |
| S1-4 智能体表单 380px 溢出 | 第 1 轮 `max-w` |
| S1-5 通知面板 320px 越界 | 第 1 轮 `max-w` |
| S1-6/7/8 三处删除零确认 | 第 4 轮 `ConfirmDialog` / 两步确认 |
| S1-9 表单语义与英文枚举 | 第 5 轮部分：枚举中文化 + 7 个字段可见 label（其余见 §2.4） |
| A 组字号 6 档 / 阴影 6 套 | 第 1、2 轮收敛到 3 档 / 1 套 |
| C 组 17 处手写遮罩 | 第 3 轮收进 `var(--scrim)` |
| C 组 116 条暗色补丁 | 部分（常见字面量已换 token，桥接规则保留） |

## 6. 第 5 轮（`d.140.3.58.11`）· 枚举中文化 + 空态收口

第 1–4 轮把全局杠杆（token → 基元 → 壳层）做完后，第 5 轮回到审计剩下的两条结构性问题，取其中可在一次改动里验证干净的部分：

| 文件 | 改动 |
| --- | --- |
| `packages/web/src/components/ModelPage.tsx` | 新增 `ROUTING_LABEL` / `SYNC_KIND_LABEL` / `SYNC_COMMAND_LABEL` / `API_LABEL` 四张映射（CLI 值 → 中文文案），覆盖分组选路策略（两处，18/30 空格两种缩进各一处）、请求协议、多机同步类型与动作——`value` 一律保持原值，命令与协议不变；「其他 OpenAI 兼容地址」4 个字段与「多机同步」3 个字段改为 `<label class="grid gap-1">` + `.ui-caption` 可见文案（文案沿用原 `aria-label`，`getByLabelText` 与读屏名称不变） |
| `packages/web/src/components/ui/EmptyState.tsx` | 新增 `framed` 变体：`.ui-card` 描边 + `py-8`，用于「空态自己就是一块卡片」的场景；`compact` 与 `className` 行为不变 |
| `packages/web/src/components/PluginsPage.tsx` | 插件列表为空：手写 `rounded-xl border border-line-soft … shadow-card` 壳 + `plugin-icon-tile h-11 w-11` + `ui-section-title`/`ui-caption` → `<section aria-label="插件列表为空"><EmptyState framed …/></section>`（region 语义与文案逐字保留） |
| `packages/web/src/components/plugins/UnitListView.tsx` | 筛选无结果：同壳改 `EmptyState framed` + `actions`（「清除筛选」按钮），保留 `role="region" aria-label="筛选无结果"` |
| `packages/web/src/components/plugins/PluginBundlePage.tsx` | 浏览器降级（`!canMount`）与「无页面 / 已停用」两处：同壳改 `EmptyState framed className="w-full max-w-[520px]"`，后者把「打开插件详情」放进 `actions` |

**门禁**：`pnpm --filter @heming/web typecheck` 通过；`pnpm --filter @heming/web test` 297 文件 / 4366 例全通过；`pnpm -r typecheck`、`pnpm -r build` 通过。

**同时修掉的发版缺口**：上一轮 bump 到 `d.140.3.57.11` 时漏写 `docs/RELEASE-NOTES.md` 条目，`changelog.test.ts` 的「最新一条必须有用户版说明」与 `latestUserUpdates` 两例因此失败（4 例）。本轮补 `d.140.3.57.11`、`d.140.3.58.11` 两条用户版说明后重跑 `node scripts/build-changelog.mjs` 恢复绿色。教训写进发版清单：**bump 之后立刻补 RELEASE-NOTES，否则 `pnpm -r test` 必挂**。

## 7. 第 6 轮（`d.140.3.59.11`）· 卡片壳收口

第 2 轮把 `.ui-card` 的 `box-shadow` 删掉后，仓里仍有一批手写卡片壳自带 `shadow-card`——同一屏会出现「有投影 / 无投影」两种卡片。本轮按审计 C-S2-04 收尾：

| 文件 | 改动 |
| --- | --- |
| `ContextSettingsCard.tsx`、`KeyStorageCard.tsx`、`StorageUsageCard.tsx`、`HitlPolicyCard.tsx`、`FileEditCard.tsx`、`ux/OnboardingCard.tsx`、`settings/ThemeModeCard.tsx`、`UpdateCard.tsx`、`InterfacesPage.tsx`（两处） | `rounded-xl border border-line[ -soft] bg-surface p-4 shadow-card` → `ui-card` + 原有位置/宽度/内边距类（`mt-3`、`mb-4`、`max-w-[520px]`、`max-w-full`、`p-4`） |
| `skills/SkillHubPanel.tsx` | 两个浮层（详情 / 安装）不属卡片体系：`shadow-card` → `ui-overlay-shadow` |
| 未动 | `ChatPage.tsx`（提示条 / 下拉 / 复制按钮）、`ChatChart.tsx`（工具条按钮）、`ConfirmDialog.tsx`（弹窗）、`EmojiPicker.tsx`（浮层）里的 `shadow-card`：这些是浮层与工具条阴影，留给后续「浮层阴影统一」一轮 |

**门禁**：`pnpm --filter @heming/web typecheck` 通过；`pnpm --filter @heming/web test` **297 文件 / 4367 例全通过**（新增了 `EmptyState` 的 `framed` 用例）；受影响卡片与 changelog 相关的 6 个测试文件 136 例单独复跑通过。
## 8. 第 7 轮（`d.140.3.60.11`）· 浮层阴影统一

第 6 轮把卡片壳收编后，`packages/web/src` 里还剩 28 处 `shadow-card`。本轮按「是否真的浮在内容上」分成三类，把阴影从「随手加的装饰」变成两个语义：**卡片 = 描边无阴影**，**浮层 = `ui-overlay-shadow` 一档**。

| 处理 | 处数 | 位置 |
| --- | --- | --- |
| → `ui-overlay-shadow` | 13 | `ChatPage.tsx`（模型下拉 / 附加上传弹层 / 回到底部）、`ConfirmDialog.tsx`、`EmojiPicker.tsx`、`FilePreviewModal.tsx`（预览面板）、`NavRail.tsx`（工具浮签）、`NotificationCenter.tsx`、`ShortcutsHelp.tsx`、`SkillsPage.tsx`（详情抽屉）、`knowledge/FileTree.tsx`（右键菜单）、`knowledge/QuickOpen.tsx`（速开面板）、`assistant/AgentFormPanel.tsx`、`assistant/ConversationRail.tsx`（会话菜单） |
| 去掉投影 | 13 | `ChatChart.tsx`（缩放按钮 ×2）、`ChatPage.tsx`（提示条 ×2 / 复制按钮）、`FilePreviewModal.tsx`（文本、代码块）、`SettingsPage.tsx`（重试按钮 / 自定义色点）、`ShortcutsHelp.tsx`（`<kbd>`）、`WikiGraphView.tsx`（工具条）、`WikiPanel.tsx`（小按钮） |
| → `ui-card` | 2 | `InterfacesPage.tsx`「预置服务」（`mb-4` + `p-3`）、`LoginPage.tsx` 登录卡（`w-[340px]` + `p-7`） |

**结果**：`grep -rn 'shadow-card' packages/web/src --include=*.tsx` 归零（只剩 `ui/Skeleton.tsx` 的一句注释在提醒「别再手写 shadow-card」）。

**判断标准**（写给下一个改界面的人）：元素下面有内容、会盖住内容 → 浮层，用 `ui-overlay-shadow`；元素与内容同层、只是分组 → 卡片，用 `ui-card`；元素是内容本身的一部分（按钮、提示条、`kbd`、色点）→ 不加投影，靠边框和底色区分。

**门禁**：`pnpm --filter @heming/web typecheck` 通过；`pnpm --filter @heming/web test` **297 文件 / 4367 例全通过**；`pnpm -r typecheck`、`pnpm -r build` 通过。

## 9. 第 8 轮（`d.140.3.61.11`）· `ui/Dialog`：内容弹窗统一外壳

审计 A/C 记了「11 个弹窗各自拼壳：4 种宽度 / 2 种圆角 / 有的有 border 有的没有」。逐个数下来，它们其实混了三类不同的东西，只有第一类该共用一个壳：

1. **内容弹窗**（有标题、有关闭、有底栏按钮）——本轮统一；
2. **全屏灯箱**（看大图，`z-[60] bg-black/75`，内容就是图本身）——不统一，套壳只会让图变小；
3. **顶对齐搜索面板**（命令面板 / 代码速开，自带搜索框、没有标题栏）——不统一，它们的第一个元素就是输入框，硬加头部会把键盘焦点顶歪。

### 9.1 新增 `components/ui/Dialog.tsx`

| 维度 | 取值 |
| --- | --- |
| 宽度 | `size: sm | md | lg | xl` → `w-[min(480px,92vw)]` / 560 / 660 / 860（`94vw`） |
| 头部 | 图标砖 `.ui-icon-tile h-8 w-8`（`aria-hidden`）+ 标题 `.ui-section-title` + 说明 `.ui-caption` + 关闭按钮（`aria-label` 可覆盖） |
| 身体 | `min-h-0 flex-1 overflow-y-auto`，内边距默认 `p-4`，可传 `bodyClassName` |
| 底栏 | 传了 `footer` 才渲染，默认 `justify-end gap-2 border-t px-4 py-2.5` |
| 行为 | `useModalA11y`（焦点陷阱 / Esc / 归还焦点）、点遮罩关闭、`maxHeightVh` 默认 80 |
| 无头模式 | 不传 `title` 就不渲染头部（给「自带搜索框」的浮层留口） |

### 9.2 迁移清单

| 文件 | 原形态 | 现形态 |
| --- | --- | --- |
| `ConfirmDialog.tsx` | 82 行自拼壳，`shadow-card` + `rounded-xl` | 20 行包装：`<Dialog ariaLabel={title} title={title} closeLabel="关闭并拒绝">`，默认聚焦拒绝按钮不变 |
| `ShortcutsHelp.tsx` | 自拼壳 + 手写头部 | `size="sm"`、`closeLabel="关闭快捷键"`、底栏放「Esc 关闭」提示 |
| `FilePreviewModal.tsx` | 自拼壳，标题是 13px 手写 | `size="md"`、标题走 `truncate` 的 13px 语义、`closeLabel="关闭预览"` |
| `plugins/InstallDialog.tsx` | 自拼壳 + 浅色底 footer | `size="lg"` `maxHeightVh={88}`，`footerClassName` 保留浅色底 |
| `plugins/PluginDetailDialog.tsx` | 自拼壳 + 内部再套一层滚动 | `size="lg"`，`PackageDetailBody` 去掉 `min-h-0 flex-1 overflow-y-auto`（滚动交给 Dialog） |
| `plugins/PluginRepositoryDialog.tsx` | 自拼壳 + 内部滚动 | `size="xl"` `maxHeightVh={86}`，列表容器同样去掉滚动层 |

**可访问名逐字保留**（测试钉死的）：`快捷键`、`关闭快捷键`、`命令面板`、`关闭预览`、`关闭并拒绝`、`查看大图`、`查看图片`。

### 9.3 暂不合并的（连同理由写在这里，避免下一轮又「顺手统一」）

| 位置 | 为什么保留 |
| --- | --- |
| `MarkdownMessage.tsx:160`、`ChatPage.tsx:402` | 全屏灯箱：`z-[60] bg-black/75`，交互是「点任意处关闭」，内容就是图本身 |
| `SkillsPage.tsx:454` | 右侧抽屉：`border-l` + 全高，和居中弹窗的空间模型不同 |
| `CommandPalette.tsx:421`、`knowledge/QuickOpen.tsx:106` | 顶对齐面板：第一个元素是搜索框，没有头部 |
| `assistant/AgentFormPanel.tsx` | 同一个 `<form>` 兼作内联卡片与弹窗（`role` 条件切换），拆壳会把两种形态一起改坏 |
| `MemoryPage.tsx:335`、`SkillsPage.tsx:222` / `:1237` | 窄表单弹窗（460 / 440 / 440），下一轮并入 `size="sm"` 并补可见 label 时一起做 |

**门禁**：`pnpm -r typecheck` 通过；`pnpm --filter @heming/web test` **298 文件 / 4372 例全通过**（新增 `ui/Dialog.test.tsx` 5 例）；`pnpm -r build` 通过。

## 10. 第 9 轮（`d.140.3.62.11`）· 模型页表单语义收口（审计 S1-9 收尾）

第 5 轮把「来源」卡的 4 个字段和多机同步 3 个字段做成了可见 label，但模型页还有 21 个输入只剩占位符、4 个下拉靠 `aria-label` 顶着。占位符一旦输入就消失，用户填到一半就不知道自己在填什么——这是 S1 级问题。

| 处理 | 处数 | 说明 |
| --- | --- | --- |
| → `ui/TextField` | 21 | `label` 可见、`htmlFor` 绑定、占位符降级为示例；`className` 只留布局（`sm:col-span-2` 等） |
| → `<label class="grid gap-1"><span class="ui-caption">` 包裹 | 4 | 下拉不是 input，TextField 不覆盖：请求协议、来源分发策略、错误处理、分组选路策略 |
| `text-[13px] font-bold` → `.ui-section-title` | 7 | 卡片标题回到全站一档（14px/600），模型页不再有自己的标题字号 |
| `text-[11px] font-bold tracking-wide text-muted` → `.ui-micro` | 3 | 「连接」「模型」这类小标题 |

**保留 `aria-label` 的输入**（连同理由）：模型搜索框、搜索 API / 搜索 Key、API Key 行内输入 + 「更新 Key」按钮、命令 / 命令输入。这些是工具栏与控制台里的即时输入，加标题会把行高撑开；它们的无障碍名已由 `aria-label` 提供。这一条写在这里，避免下一轮把它们也「补上标题」反而变差。

**验证**：`ModelPage.test.tsx` 的 `getByLabelText` 覆盖 12 个字段名（属性模型 ID、模型显示名、来源分发策略、错误处理、规则分组 / 模型 / token 阈值、新密钥名称、更新 Key、API Key、命令…），改用 label 后全部照旧通过——测试没有为了改法而改断言。

**门禁**：`pnpm -r typecheck` 通过；`pnpm --filter @heming/web test` **298 文件 / 4372 例全通过**；`pnpm -r build` 通过。

## 11. 第 10 轮（`d.140.3.63.11`）· 失败态统一（审计「三态各自为战」起步）

审计里「失败态 5 种写法」的第一刀。**没有新增组件**：仓里早有 `ui/ErrorState` 与 `.ui-alert*` 两套失败样式，缺的是采用率（`ErrorState` 本轮之前全仓 0 采用）。

| 处理 | 处数 | 位置 | 说明 |
| --- | --- | --- | --- |
| 区块级裸红字 → `.ui-alert ui-alert-danger` | 8 | `TeamPage` ×4、`TeamBoardPage`、`HomePage`、`FilePreviewModal`、`MemoryPage` ×2 | 原文案与重试按钮一字不动，测试的文本查询不受影响 |
| 整块加载失败 → `ErrorState` | 2 | `ChatPage`（历史消息）、`TeamBoardPage`（看板） | 手拼的「13px 加粗红字 + 圆角按钮」换成与空态同骨架的失败块，`role="alert"` 由组件提供 |

**分类标准**（写下来避免下一轮又混）：

- 整块区域没内容可用（整页 / 整个列表区加载失败）→ `ErrorState`：图标 + 一句话 + 重试，和空态同骨架，只是语义更重。
- 区块内的一条失败（侧栏、卡内小段、表单校验汇总）→ `.ui-alert ui-alert-danger`：单行、浅底、有描边，不抢版面。
- 字段级错误（输入框正下方）→ `ui-caption text-[var(--danger)]` 保持不动：换成提示条会把表单撑开、把相邻字段推走。
- 弱提示（如「用量排行暂时取不到」）→ 保持 `text-muted`，它不是失败，不该染红。

**有意未动**：`plugins/shared.tsx` 的 `ERROR_TEXT` / `BTN_DANGER_SM` 字面量被 `PluginsPage.capabilities.test.tsx:821/846` 钉住（断言 `text-[#b42318]` 必须存在），留到插件区整体改色时同批处理。

**门禁**：`pnpm --filter @heming/web typecheck` 通过；`pnpm --filter @heming/web test` **298 文件 / 4372 例全通过**。

## 12. 第 11 轮（`d.140.3.64.11`）· 弹窗统一收尾 + 登录页 token 收口

第 8 轮把 6 个内容弹窗并进 `ui/Dialog` 时，留下了 5 类「暂不合并」的例外。本轮处理其中最没争议的一类：**窄表单弹窗**里的记忆页那一处。

| 处理 | 处数 | 说明 |
| --- | --- | --- |
| 本地 `Modal` 外壳 → `ui/Dialog` | 2 个弹窗 / 1 处外壳 | `MemoryPage` 的「添加记忆」「添加知识条目」共用同一份本地外壳，改一处即覆盖两个 |
| 写死底色 → token | 1 | `LoginPage` 的 `bg-[#fafafa]` → `bg-subtle` |
| 固定宽度 → 可收缩 | 1 | 登录卡 `w-[340px]` → `w-[min(340px,100%)]` |

**为什么这处值得并**：旧外壳把 `overflow-y-auto` 放在面板本身，长表单会把标题和关闭按钮一起滚走；`Dialog` 是「头部固定 + body 滚动」，且焦点陷阱 / Esc / 焦点归还由组件统一接管——记忆页自己那份 `useModalA11y` 就不再需要了。

**仍然保持原形态的**（与第 8 轮 §9.3 的理由一致，没有变化）：全屏灯箱 ×2、技能页右侧抽屉、命令面板 / 代码速开这类顶部对齐面板、`AgentFormPanel`（同一份 form 兼作内联卡片与弹窗）、`SkillsPage` 的两个表单弹窗（面板本身是 `<form>`，提交按钮在表单内，改成 `Dialog` 需要 `form` 属性跨节点关联，收益不抵风险，留待专门一轮）。

**验证**：`LoginPage.test.tsx`（17 例）+ `MemoryPage.test.tsx`（43 例）共 60 例通过；`getByRole("dialog", { name: "添加记忆" })`、`getByLabelText("主题")` 等查询逐字未改。

## 13. 第 12 轮（`d.140.3.65.11`）· 空态收口

审计里「三态各自为战」的最后一类残留：`.ui-empty*` 基元在各页被手拼，标题/说明/按钮的间距与字号靠各自补类。本轮把最后 6 处收进 `ui/EmptyState`。

| 文件 | 位置 | 处理 |
| --- | --- | --- |
| `RegistryPage.tsx` | 加载中 / 无结果（2 处） | `framed` + `border-dashed`；无结果拆成标题 + 说明 |
| `SkillsPage.tsx` | 技能池为空（1 处） | 两个按钮进 `actions` |
| `TeamPage.tsx` | 动向为空（1 处） | `compact`，不再撑高卡片 |
| `collaboration/CollabView.tsx` | 模板空态（1 处） | `framed` + `actions` 里放模板按钮组 |
| `assistant/ConversationRail.tsx` | 无对话 / 无匹配（2 处） | 保留 `px-2 py-6` 窄版，只换结构 |

**判断标准**（与第 10 轮失败态的三分法配套）：

- 整块区域没有内容 → `EmptyState`（空态）/ `ErrorState`（失败态）
- 卡片内部的小空白 → `EmptyState compact`
- 空态本身就是一张卡片 → `EmptyState framed`
- 需要虚线「占位」语感 → `framed` 之外再叠 `border-dashed`

**验证**：受影响 8 个测试文件 101 例通过；`AssistantPage.test.tsx` 的「没有匹配的对话」、`SkillsPage.test.tsx` 的按钮查询都未改断言。
## 14. 第 13 轮（`d.140.3.66.11`）· 安装包外壳

前 12 轮都在 `packages/web`。安装包外壳是另一套自绘界面（`packages/setup`：900×620 无边框窗口、纸面 / 墨线 / 朱砂印），它下载安装包并静默调起 NSIS，所以**用户看到的「安装程序」其实就是它**，NSIS 那层页面看不见。本轮按同一套标尺（对比度、触控尺寸、状态完备、可复制、小屏不裁切）过一遍。

### 14.1 版心自适应

| 问题 | 处理 |
| --- | --- |
| 900×620 写死，1366×768 的笔记本开 150% 缩放时工作区只有约 500 DIP，底部按钮被顶到屏幕外 | 新增 `fitToWorkArea()`：按光标所在显示器 `workAreaSize` 收窗口（留 32px 边），下限 720×480 |
| 缩到 720 宽时右侧页边注与正文抢宽度 | `@media (max-width: 800px)` 单列 + 隐藏页边注 |
| 720×480 时 ready 屏仍溢出 9px | 新增 `@media (max-width: 800px) and (max-height: 600px)` 再收一档留白 |

### 14.2 看得见 / 摸得着

| 问题 | 处理 |
| --- | --- |
| 报错只能截图，用户没法把原因贴给客服 | 失败屏加「复制详情」：主进程 `clipboard` + `ipcMain.handle("setup:copy-text")`，渲染侧拼「说明 + 错误码 + 详情」，成功后按钮短暂显示「已复制」 |
| 切屏后焦点留在旧按钮上，键盘用户要 Tab 找主操作 | `PRIMARY_ACTION` 映射（ready→开始安装 / done→打开和鸣 / error→重试），切屏即聚焦 |
| 安装路径、错误详情、装好的目录选不中 | 四处 `user-select: text` |
| 长堆栈被 `overflow: hidden` 无声截断 | `overflow-y: auto` + `overscroll-behavior: contain`，`max-height 76 → 96px` |

### 14.3 对比度与细节

| 位置 | 原值 | 现值 |
| --- | --- | --- |
| `--faint`（步骤标签 / 提示字 / 页脚） | `#8a8578`（3.29:1） | `#6f6a5e`（4.81:1） |
| `.note-sig` / `.footline` | `#a39c8b`（2.44:1） | `var(--faint)` |
| 窗口按钮 | 30px | 32px |
| `:focus-visible` 轮廓 | 1px | 2px |
| 失败详情字号 | 11px | 11.5px |

另外：`::selection` 改成墨色反白（默认蓝落在纸面很跳）、`.body`/`.detail` 换 8px 细滚条、进度条补 `aria-label="安装进度"`。

### 14.4 版面怎么验的

本会话看不了截图，所以给 `--capture` 加了逐屏量尺：`lib/capture.js` 现在量每屏 `main/body` 的 `clientHeight`/`scrollHeight`、`actions` 底边与 `clipped`。**第一版量出来全是假数据**——截图停在 error 屏，那一屏仍可见，把主列一起撑高（ready 屏量到 `main.client=709`）。修法是量之前先隐藏所有 `.screen`。

修正后三档实跑（`clipped:false` 表示主按钮没有被裁出视口）：

| 窗口 | main（client/scroll） | body（client/scroll） | 最大 actionsBottom |
| --- | --- | --- | --- |
| 900×620 | 484/484 | 530/530 | 556 |
| 800×540 | 434/434 | 464/464 | 454 |
| 720×480 | 374/374 | 404/404 | 438（收紧前 454 且差 9px 出滚动条） |

三档 `diagnostics.errors` 均为空；`pnpm --filter @heming/setup typecheck`、`test`（19 例）通过。

### 14.5 有意未动

- `packages/desktop/build/installer.nsh`：NSIS 层在外壳之下静默执行，用户看不到它的页面；改文案没有可见收益，且本机无法联网重打包验证，留到能真跑一次 `build-desktop --win nsis` 的机器上做。
- 版心比例、宋体标题、朱砂印这些品牌选择没有动——它们是这套外壳唯一「不像模板」的地方。


### 14.6 打包版实测（`d.140.3.67.11`）

镜像里有一套完整的打包链，本轮顺手跑通并**打开真包看过界面**（这是前 12 轮都没做到的验证层级）：

- `node scripts/build-setup.mjs` 离线打包成功：`packages/setup/release/和鸣安装程序 d.140.3.66.11.exe`（97.8 MB，脚本用主仓已解包的 electron 作 `electronDist`，不需要联网）。
- 启动该 exe 后读 UIA：窗口标题「安装 和鸣」、DIP 尺寸 900×622（`fitToWorkArea` 在大屏上保持版心）、标题栏 / 正文 / 页边注 / 页脚四段结构完整、「开始安装」拿到焦点（`PRIMARY_ACTION` 在打包版生效）、预取进度「正在准备安装包 · 21%」在跑；点「退出」正常关窗，没有开始安装。
- 由此抓到两处只有真包才暴露的问题，已在 `d.140.3.67.11` 修掉：
  1. 右栏 `<dt>版本</dt>` 显示的是**这次会装上的版本**（在线形态取自更新服务器），与下面的「现有版本」并排读极易混淆 → 改为「将要安装」。
  2. 主按钮的无障碍名字把 CSS 伪元素箭头也算了进去（UIA 读到「开始安装→」，读屏会念「箭头」）→ 三个主按钮补 `aria-label`。

## 15. 第 14 轮 · NSIS 安装器的取消确认（d.140.3.68.11）

### 15.1 问题

第 13 轮改的是 `packages/setup`（我们自绘的安装外壳），但用户真正双击的是 electron-builder 产的 NSIS 安装包——它的欢迎页、安装模式页、目录页、进度页、完成页都是系统原生控件，和我们那套纸面排版不是一回事。这一层原来只放文案与品牌图，有一处行为缺口：

装到一半点「取消」或关窗，**直接退出**，已经解到 `$INSTDIR` 的文件留在那里没有任何交代。重装的用户会看到「已经存在一个安装」，却又缺文件——这是那种只有真装一次才会撞见的问题。

### 15.2 做法

`packages/desktop/build/installer.nsh` 加两行：

```nsis
!define MUI_ABORTWARNING
!define MUI_ABORTWARNING_TEXT "安装还没完成。现在退出的话，已经解到安装目录里的文件会留在那里，下次要重新运行安装程序才能补全。确定退出吗？"
```

文案特意写清「后果 + 怎么补」，而不是通用的「确定要取消吗」——后者没有回答「我这算装完了吗」。

覆盖之所以生效，是因为 electron-builder 的 `NsisTarget` 把自定义 include 拼在脚本公共头部、早于 `!include "MUI2.nsh"`：我们的 `!define` 在 MUI 读默认值之前就位。

### 15.3 真包验证

`node scripts/build-desktop.mjs --win nsis`（约 3 分钟，用本地 electronDist）→ `packages/desktop/release/和鸣 Setup d.140.3.67.11.exe`，启动后逐页读 UIA：

| 页面 | 读到的内容 |
| --- | --- |
| 欢迎页 | 标题「安装 和鸣」、正文含「本机优先的 AI 工作站…请先备份需要保留的内容。」 |
| 安装模式页 | 页头「和鸣 140.3.67」、「为哪位用户安装该应用？」、两个单选、旧安装提示 |
| 目录页 | 页头「选定安装位置」、「选定 和鸣 要安装的文件夹。」、路径 `E:\Heming`、所需 841.8 MB / 可用 46.5 GB |
| 点取消 | 弹出 `#32770` 模态确认框，正文逐字为上面那句，按钮「是(Y) / 否(N)」；主窗口控件同时置灰 |

### 15.4 刻意没做（写进 nsh 注释，避免下一个人重复踩）

- **页头那行「和鸣 140.3.67」改不了**：它由 electron-builder 按 semver 写入，而 `MUI_HEADER_TEXT` 定义在 MUI2.nsh 之后，我们的 include 够不到；要改只能整套替换 NSIS 模板。
- **安装模式页的中文文案改不了**：来自 `multiUserUi.nsh` 内置 LangString，`addCustomMessageFileInclude` 只认包内置的 `messages.yml`，不接受 build 目录覆盖。
- **安装包体积/图标没动**：那是品牌资产与打包配置的事，不属于本轮。

## 16. 第 15 轮 · 字形图标归位（d.140.3.69.11）

### 16.1 问题

审计 S2「图标双轨」：`icons.tsx` 里有 49 个 1.5px 描边图标，但按钮里还散着
`‹ › ⋯ ▾ ▸ ↑ ↓ × ✓` 这些键盘字符当图标用。它们的问题不是审美，是**不可控**：

- 宽度与基线来自系统字体（PingFang / 雅黑 / Noto 各不同），同一行里和 SVG 混排会错位；
- 字重随字体回退跳动，125% / 150% 缩放下尤其明显；
- 「⋯」这类字符在部分字体里会被渲染成省略号宽度，把按钮撑得比设计稿宽。

### 16.2 做法

`icons.tsx` 补 `MoreIcon`（三颗 1.4r 实心点），然后把 9 处字形换掉，**全部保留原 `aria-label`**，
读屏名一个没改：

| 位置 | 原字形 | 现在 |
| --- | --- | --- |
| `AgentStreamBubble` 折叠箭头 | `▾ / ▸` | `ChevronIcon` 12px + `rotate-90`，150ms 位移过渡（`motion-reduce:transition-none`） |
| `AgentStreamBubble` 候选成功标记 | ` ✓` | `CheckIcon` 11px，装饰绿 |
| `knowledge/FileTree` 行尾更多 | `⋯` | `MoreIcon` 14px |
| `ConversationRail` 会话更多 / 收起 / 展开 | `⋯ › ‹` | `MoreIcon` 14 / `ChevronIcon` 14（左向 `rotate-180`） |
| `AgentEditorView` 返回 | `‹ 返回名册` | `ChevronIcon` + 文字 |
| `ChatPage` 搜索条 | `↑ ↓ ×` | `ChevronIcon` ±90° / `XIcon` 13px |
| `ChatPage` 新消息浮标 | `↓ 新消息` | `ChevronIcon` + 文字 |
| `NotificationCenter` 关闭 | `×` ×2 | `XIcon` 14 / 13px |

### 16.3 有意保留的字形

- `<kbd>↑↓</kbd>`：键盘提示，本来就是文字；
- 注释与测试名里的 `⋯`：描述用，不是渲染；
- `×1` / `×{factor}`（`MemoryPage` 个性化加权）：数学倍率，不是图标。

### 16.4 验证

字形换成 SVG 会改变 DOM 文本，测试里唯一按文本查的一处（`AgentStreamBubble.test.tsx` 的
「备用 Key ✓ 1.2k」）随之改为查 `备用 Key 1.2k` + 断言该 chip 内含 `svg`；
其余用例都按 `aria-label` 查询，未受影响。门禁：web typecheck 过、**298 文件 / 4372 例**全过。


## 17. 第 16 轮 · 字重与字号刻度（d.140.3.70.11）

### 17.1 问题

审计 A 的「六个视觉维度没有刻度」里，最后一块是字重：仓里同时存在 400 / 500 / 600 / 700 / **800**。
`font-extrabold`（800）出现在 11 处，全是卡片标题（插件名、能力单元名、技能名）和两个统计数字。
它们比 `.ui-page-title`（600）、`.ui-section-title`（600）粗两级 —— 这不是层级，是「拿加粗当强调」，
结果就是满屏都在喊，谁也不突出。

同一轮里还有一处同高不同号：`.ui-btn` 与 `.ui-input` 都是 32px 高，但按钮 12px、输入框 13px。
搜索框旁边并排一个「搜索」按钮时，框里的字明显比按钮上的字大一号。

### 17.2 做法

- `font-extrabold` → `font-semibold`（11 处）：`HomePage`、`MemoryPage` ×2、`SkillsPage`、
  `ux/OnboardingCard`、`skills/SkillHubPanel`、`plugins/BundlePluginCard`、
  `plugins/PluginCard`、`plugins/PluginDetailDialog`、`plugins/SystemPluginCard`、`plugins/UnitListView`。
- 两个统计数字补 `ui-numeric`（`tabular-nums`）：数字跳动时不再左右位移。
- `.ui-btn` 基础字号 12 → 13px，`.ui-btn-sm` 显式 12px：32px 的 md 按钮与同高输入框对齐，
  28px 的 sm 按钮保持原样（13px 配 28px 高会挤）。

### 17.3 现在的刻度

| 维度 | 取值 |
| --- | --- |
| 字号 | 22 / 14 / 13 / 12 / 11（标题 / 区块 / 正文 / 辅助 / 微） |
| 字重 | 400 / 500 / 600（700 仅正文 `<strong>`） |
| 行高 | 30 / 22 / 20 / 18 / 16 |
| 控件高 | 28（sm）/ 32（md，与输入框同高） |

### 17.4 验证

门禁：web typecheck 过、**298 文件 / 4372 例**全过、`pnpm -r typecheck` 6 包过、`pnpm -r build` 过。
（字重与字号不是测试能守住的东西，这一轮的判据是「同一屏里不再出现 800」——
`grep -rn "font-extrabold" packages/web/src` 现在为 0。）


## 18. 第 17 轮 · 技能页两个表单浮层并入 `ui/Dialog`（d.140.3.71.11）

### 18.1 当时为什么留着

第 8 轮把 6 个内容弹窗迁到 `ui/Dialog`，第 11 轮又并了记忆页两个，技能页这两个留着，
理由写在 §12：面板本身就是 `<form>`，提交按钮在表单内部，而 `Dialog` 的底栏渲染在
`children` 之外——搬过去要么拆掉表单语义，要么让按钮脱离表单。

### 18.2 这一轮怎么解

用 HTML 的 `form` 属性：表单留在 body 里（`id="skill-create-form"`），底栏那个「创建技能」
写 `type="submit" form="skill-create-form"`。浏览器把它当作该表单的默认提交按钮——
点按钮、输入框内回车都照旧提交，表单语义没有丢。

- 「新建技能」：`<Dialog title="新建技能" description="只需名称和内容，其余可空" size="sm"
  maxHeightVh={90} initialFocusRef={nameRef} closeLabel="关闭新建技能">`，头部（标题/提示/关闭）
  与底栏都交给 Dialog；字段仍是原来的 `<form>`，只是从「壳」降级成「内容」。
- 「添加技能」：走 `title={...}`（标题里带智能体名）+`maxHeightVh={70}`，列表的
  `max-h-[320px] overflow-y-auto` 去掉，由 Dialog body 承担滚动。
- 两处宽度从 440 → `sm`(480)：宽度不再是各弹窗自己写的魔数。

### 18.3 顺带的两处字面量

- 技能详情抽屉的遮罩 `bg-black/10` → `bg-[var(--scrim)]`：白底页面上 10% 黑几乎看不出压暗，
  也和第 3 轮把 `bg-black/20·30` 统一成 `--scrim` 的方向不一致（当时漏了这一处）。
- 「添加技能」列表的 `divide-[#f1f1f1]` → `divide-line-soft`：暗色下原本要靠桥接规则兜底。

### 18.4 验证

`SkillsPage.test.tsx` 21 例全过（含「点创建技能提交」「Esc 关闭」「添加面板选技能」）；
全量 web **298 文件 / 4372 例**过。读屏名逐字保留：`新建技能` / `添加技能` / `关闭新建技能` /
`关闭添加面板`。

### 18.5 现在弹窗的统一面

`ui/Dialog` 承担 12 个：确认框、快捷键、文件预览、安装、插件详情、插件源、记忆页 ×2、
技能页 ×2、工具审批（走 ConfirmDialog）。**仍各自拼壳**的只剩：
全屏灯箱 ×2（内容是图片本身）、技能页右侧抽屉（`w-[380px]` 贴边滑出）、
命令面板与代码速开（顶部对齐、自带搜索框、无头部）、`AgentFormPanel`（同一份 form 兼作内联卡片）。


## 19. 第 18 轮 · 写死色值清零 + 桥接层清死规则（d.140.3.72.11）

### 19.1 剩了什么

第 3 / 11 / 16 轮已经把大部分字面量换成了 token。这一轮扫描 `-(bg|text|border|divide|ring)-[#hex]`，
生产代码里只剩 10 处，分三类：

| 位置 | 原值 | 现在 | 为什么原来留着 |
| --- | --- | --- | --- |
| `MemoryPage` ×3、`plugins/PluginCard` | `ring-[#1a1a1a]/25` | `ring-ink/25` | 「聚焦高亮环」需要带透明度，当时以为 token 类接不了 `/25` |
| `FileTree` ×2、`RouteGroupsCard` ×2、`UpdateCard`、`AgentFormPanel`、`WikiPanel` | `bg-[#fafafa]` 等 | `bg-subtle / bg-panel / bg-subtle-2 / hover:bg-subtle-4` | 桥接层「看起来已经对了」，没急着改 |
| `ContextSettingsCard`、`plugins/shared.tsx` ×2 | `text-[#b42318]` / `text-[#b45309]` | `var(--danger)` / `var(--warn)` | 后者被两条测试用例钉着字面量 |

`ring-ink/25` 能成立，是因为 `ink` 在 `tailwind.config.js` 里映射到 `var(--ink)`——
Tailwind 对自定义调色板生成的是 `--tw-ring-color: color-mix(...)`，透明度修饰照样生效。

那两条钉字面量的用例（`PluginsPage.capabilities.test.tsx`）断言的是「错误文案走危险色」，
不是「必须写死 #b42318」，所以跟着改成断言 `var(--danger)`——测试的意图没变，只是把实现细节换掉。

### 19.2 新增 `--mark-bg` / `--mark-ink`

搜索结果里的命中片段原先写死 `bg-[#fde68a] text-[#3b2b00]`。亮色没问题，暗色下：
亮黄底刺眼，而且桥接层只覆盖了 `bg-[#fde68a]` 之外的少量类名，`text-[#3b2b00]` 一直是深字压深底。
现在两个 token 各给一套：亮 `#fde68a`/`#3b2b00`，暗 `#5f4d12`/`#ffe9a8`。

### 19.3 桥接层：116 → 42 条

`index.css` 末尾那段 `[data-theme="dark"] .bg-[#fafafa]` 之类的按类名兜底，是 d.67 建暗色时的权宜之计，
注释里写着「后续换成 token 后逐条删除」。本轮做了一个**纯静态**的判定：把选择器里的十六进制类名提取出来，
在整个 `src`（含测试，宁可保守）里搜一遍；搜不到的规则删掉——没有组件在用的类名，
删掉它不可能改变任何渲染。结果：删 21 条（116 → 42），`index.css` 1229 → 1130 行。
剩下的 42 条都有真实引用，等对应类换成 token 后再删。

### 19.4 验证

`grep -rE "(bg|text|border|divide|ring)-\[#[0-9a-f]{3,8}\]" packages/web/src --include=*.tsx`
现在**生产代码 0 处**（仅剩 2 处在 `StorageUsageCard.test.tsx` 的「不得出现」断言里）。
门禁：web typecheck 过、**298 文件 / 4372 例**全过、`pnpm -r typecheck` 6 包过、`pnpm -r build` 过。

