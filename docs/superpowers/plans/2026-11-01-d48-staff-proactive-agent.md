# d.48 · 常驻幕僚实施计划

- 规格：`docs/superpowers/specs/2026-11-01-d48-staff-proactive-agent.md`
- 目标：在 `packages/web` 内完成「晨报 + 日程临期 + 任务异常」三路主动简报，只读、本机、可预算。
- 不碰：`packages/{server,shared,desktop}`；不新增依赖。

## 1. 数据层

新建：

- `packages/web/src/lib/staff/model.ts`
  - 类型：`StaffSettings` / `StaffRun` / `StaffFinding` / `StaffSeen` / `StaffTrigger`
  - 常量：`DEFAULT_STAFF_SETTINGS`、`MAX_STAFF_RUNS=30`、`STAFF_RUNS_BYTE_LIMIT=192KB`、`MAX_SEEN=200`、`AGENDA_LOOKAHEAD_MS=24h`、`AUTO_COOLDOWN_MS=10min`
  - 纯函数：`normalizeSettings`、`normalizeRun`、`pruneRuns`、`normalizeSeen`、`pruneSeen`、`parseClock`、`todayKey`、`inQuietHours`、`nextDailyAt`、`collectFacts`、`buildRuleBrief`、`sortFindings`、`mergeLlmBrief`、`decideTick`
- `packages/web/src/lib/staff/store.ts`
  - zustand：`settings/runs/seen`，`updateSettings/recordRun/markSeen/clearRuns/reset`
  - 持久化：`readJson/writeJson`；测试注入 `setStaffStorage`

测试：`model.test.ts`、`store.test.ts`

## 2. 生成层

新建：

- `packages/web/src/lib/staff/llm.ts`
  - `buildFactPayload`（脱敏）
  - `parseBriefJson`（严格校验 + refs 过滤）
  - `callBriefModel(profile, payload, { signal })`：`streamChat` + `onUsage`
- `packages/web/src/lib/staff/runner.ts`
  - `runStaffBrief(...)`：规则 → 可选 LLM → 合并 → 通知，返回 run + seenPatch
  - 依赖注入：`profile`、`tokensToday`、`quiet`、`callModel`、`pushNotification`、`notifyDesktop`
- `packages/web/src/lib/staff/runtime.ts`：`liveFacts` / `refreshAgendaIfRunning`（只读）
- `packages/web/src/lib/staff/manual.ts`：`runStaffNow`（与调度共用锁）
- `packages/web/src/lib/staff/lock.ts`：进程内运行锁

测试：`llm.test.ts`、`runner.test.ts`、`manual.test.ts`

## 3. 调度层

新建：

- `packages/web/src/lib/staff/loop.ts`
  - `useStaffLoop(active)`
  - tick 60s；采集节流 15min；在途锁；`visibilitychange` 补跑
  - 议程只在 `isInfohubAvailable() && running` 时 `loadAgenda()`，**不** `connect()`

测试：`loop.test.tsx`（fake timers）

## 4. 界面

新建：

- `packages/web/src/components/StaffPage.tsx`
- `packages/web/src/components/StaffHomeCard.tsx`

修改：

- `store/ui.ts`：`Page` + `"staff"`；`DEFAULT_NAV_ORDER` 在 `conversations` 后插入
- `components/icons.tsx`：`StaffIcon`
- `components/NavRail.tsx`：导航项（无 digit）
- `components/SettingsPage.tsx`：`NAV_LABELS.staff`
- `App.tsx`：页面分支 + `useStaffLoop(Boolean(authUser))`
- `components/HomePage.tsx`：首页卡
- `store/notifications.ts`：`NotificationKind` + normalize 白名单
- `components/NotificationCenter.tsx`：`KIND_LABEL` + 跳转
- `lib/storageUsage.ts`：`heming.staff.` → 幕僚

测试：`StaffPage.test.tsx`、`StaffHomeCard.test.tsx`、`notifications.test.ts` 补一例

## 5. 验收

1. `pnpm --filter @heming/web test`
2. `pnpm --filter @heming/web build`
3. 浏览器实测：开启 → 首份简报 → 手动运行 → 历史 → 跳转 → 关闭；控制台无报错
4. 不自动拉起 InfoHub；浏览器端任务路可用、议程路自动禁用
5. 版本与提交：d.47 未提交，先不 bump；完成后按用户确认决定提交范围
