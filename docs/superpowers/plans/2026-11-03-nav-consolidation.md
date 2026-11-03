# 实施计划：导航合并（d.67）

- 规格：`docs/superpowers/specs/2026-11-03-nav-consolidation.md`
- 执行切分（写作用域互不重叠）：

| 执行者 | 任务 | 写作用域 |
|---|---|---|
| Lead | T1 导航核心：类型/别名/`pageView`/`normalizeNavOrder`/`focusTask`、NavRail、App 路由与快捷键、palette 目录、设置区导航卡、命令面板与通知中心跳转、核心测试、文档/版本/提交 | `store/ui.ts`、`components/NavRail.tsx`、`App.tsx`、`lib/palette/pages.ts`、`SettingsPage.tsx`、核心测试、`docs/**`、`CHANGELOG.md` |
| `nav-team-agent` | T2 团队看板 → 团队「看板」Tab；T3 通用智能体 → 智能体「任务」Tab | `TeamPage.tsx`、`TeamBoardPage.tsx`、`AssistantPage.tsx`、`TaskAreaPage.tsx` + 各自测试 |
| `nav-plugins` | T4 技能区 → 插件区「技能」Tab；T5 接口区 → 插件区「MCP」Tab；页内跨页跳转改切 Tab | `PluginsPage.tsx`、`SkillsPage.tsx`、`InterfacesPage.tsx`、`components/plugins/**` + 各自测试 |

## Lead 任务

- [ ] T1a `store/ui.ts`：`Page` 收成 9 项、`LegacyPage`/`PageId`/`PageView`/`resolvePage`、`pageView` + `consumePageView`、`setPage(page, view?)`、`focusTask`→chat+tasks、各跳转清视图意图
- [ ] T1b `normalizeNavOrder` 折叠旧项并去重（`heming.navOrder.v1` 平滑迁移）
- [ ] T1c `NavRail` ITEMS 9 项；数字键 2→团队、8→智能体，3/4 空置
- [ ] T1d `App.tsx`：`SHORTCUT_PAGES`、页面路由删 4 个旧分支、懒加载清单
- [ ] T1e `lib/palette/pages.ts` 9 项；`SettingsPage.NAV_LABELS` 9 项
- [ ] T1f 核心测试更新：`ui.test`、`palette.test`、`NavRail.test`、`App.test`、`CommandPalette.test`、`CommandPalette.pluginCommands.test`、`NotificationCenter.test`、`ChatPage.test`（任务投递前置状态）
- [ ] T1g 版本 bump、CHANGELOG、HANDOFF 回填、提交

## 串行门禁（Lead 收尾执行）

```bash
pnpm --filter @heming/shared build
pnpm -r build
pnpm -r --workspace-concurrency=1 test
```

web 测试串行（`--no-file-parallelism` 由 vitest 配置负责）；失败先单跑该文件确认，
排除 Windows 原生偶发崩溃（`0xC0000409`）后再判定回归。
