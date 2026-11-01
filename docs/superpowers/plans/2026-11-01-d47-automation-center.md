# d.47 实施计划 · 信息中枢操作面与自动化中心

- 日期：2026-11-01
- 规格：`docs/superpowers/specs/2026-11-01-d47-automation-center.md`
- 基线：d.46.1.11.0 → 目标：d.47.1.11.0
- 范围：`packages/web`（自动化模型/调度/执行、自动化页、信息中枢入口、导航）

## 任务

1. **规格**（已完成）
   - 写入 `2026-11-01-d47-automation-center.md`。

2. **数据层**
   - `lib/automation/model.ts`：任务/草稿类型、频率、`nextRunAt`、校验、展示文案、读盘归一。
   - `lib/automation/store.ts`：zustand；`create/update/remove/setEnabled/beginRun/finishRun/rescheduleMissed`；
     `heming.automations.v1` 落盘；并发保护与 20 条上限。

3. **执行与调度**
   - `lib/automation/runner.ts`：白名单动作 → `callInfohub`；未连接/浏览器返回 skipped；
     sync 后刷新共享状态；agenda 重扫写回共享日程。
   - `lib/automation/scheduler.ts`：`useAutomationScheduler(enabled)`，15 秒轮询、串行执行、
     启动顺延、浏览器不消耗计划。
   - `AppShell` 登录后挂载调度器。

4. **页面与接线**
   - `components/AutomationPage.tsx`：列表、空态、编辑弹窗、启停、立即运行、删除确认。
   - `store/ui.ts`：`automations` 页、默认顺序、`automationIntent` / `openAutomations` / 消费。
   - `components/NavRail.tsx` + `icons.tsx`：自动化入口（无数字快捷键）。
   - `components/InfohubPage.tsx`：页头「定时」、同步面板「保存为定时」、日程「定时重扫」。

5. **测试与门禁**
   - model / store / runner / scheduler / page / nav / infohub 入口测试；
   - `pnpm --filter @heming/web typecheck`；
   - `pnpm -r build && pnpm -r --workspace-concurrency=1 test`；
   - 浏览器实测：自动化页在无桥时的提示、创建任务持久化、信息中枢入口跳转。

6. **收口**
   - `node scripts/bump-version.mjs auto feature` → `d.47.1.11.0`；
   - `node scripts/build-changelog.mjs`；
   - 更新 `CHANGELOG.md`、`README.md`、`docs/HANDOFF.md`、`docs/INDEX.md`。
