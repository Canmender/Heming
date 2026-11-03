# d.51 实施计划 · 自动化执行内核

- 日期：2026-11-03
- 规格：`docs/superpowers/specs/2026-11-03-d51-automation-execution-kernel.md`
- 基线：d.48.1.11.0 → 目标：`d.51.1.11.0`（d.49/d.50 代码已落但未 bump，本轮累计到 51）
- 范围：`packages/web`（自动化动作注册表/运行记录/失败通知/页面/通知中心/UI 意图/存储水位）
- 调研依据：`docs/research/2026-11-03-n8n-engine-notes.md`、`2026-11-03-n8n-license-and-reuse.md`、`2026-11-03-heming-automation-audit.md`

## 任务

1. **规格与计划**（Lead，已完成）
   - 本文件 + 规格；三篇调研文档落 `docs/research/`。

2. **动作注册表**（`automation-registry`，task-1）
   - 新增 `lib/automation/kinds.ts`（纯数据：kind 常量、元数据、类型守卫）。
   - 新增 `lib/automation/actions.ts`（两个动作的 `run()` 从 `runner.ts` 迁入）。
   - `model.ts`：kind 白名单/校验/归一/文案/默认草稿全部走注册表；`AutomationKind` 由 `kinds.ts` re-export。
   - `runner.ts`：只留门禁 + `getAction()` 查表 + 错误归一。
   - 行为等价，用户可见文案逐字不变；新增 `kinds.test.ts`。

3. **运行记录 + 失败通知**（`automation-runs`，task-2）
   - 新增 `lib/automation/runs.ts`：`heming.automations.runs.v1`、40 条 / 192KB 双淘汰、
     `useAutomationRunsStore`（recordRun/removeForTask/clearAll）、`setAutomationRunStorage`。
   - `store.ts`：`beginRun` 加 `trigger`（默认 schedule）、`finishRun` 固定顺序写记录 → 推通知 → 落盘；
     `remove` 级联删记录。
   - `store/notifications.ts`：新 kind `automation` + `automationId` 字段。
   - `components/NotificationCenter.tsx`：KIND_LABEL + 跳转分支。
   - `store/ui.ts`：`automationFocusId` / `focusAutomation` / `consumeAutomationFocus` + 四处清理。
   - `lib/storageUsage.ts`：登记 `heming.automations.` → 「自动化」。

4. **页面集成**（Lead）
   - `AutomationPage.tsx`：动作下拉/同步面板改注册表驱动；任务卡运行记录展开区（状态/时间/耗时/触发/详情）、
     空态、「清空记录」二次确认；消费 `automationFocusId`（滚动 + 展开 + 高亮）；浏览器分支与 aria 契约保持。
   - `AutomationPage.test.tsx` 补 4 例左右。

5. **门禁与验证**
   - 单文件与整组：`cd packages/web && npx vitest run src/lib/automation ...`。
   - 类型：`cd packages/web && npx tsc -p tsconfig.json --noEmit`。
   - 全量：`pnpm -r build && pnpm -r --workspace-concurrency=1 test`（失败先单跑该包，排除 Windows 偶发崩溃）。

6. **收口**
   - `node scripts/bump-version.mjs d.51.1.11.0`（显式版本：d.49/d.50 两轮已落代码未 bump，累计到 51）；
   - `node scripts/build-changelog.mjs`；补 `CHANGELOG.md` 顶部条目（含 n8n 来源与许可短声明）；
   - 更新 `README.md` 自动化条目、`docs/HANDOFF.md`（里程碑 46、边界段改写「没有运行历史明细」一句、键位表补新键）、
     `docs/INDEX.md`（三篇调研 + 本篇规格/计划）、调研文档索引；
   - `git status` 复核只含本轮预期文件；不 commit（等 Lead 终审后由用户决定提交）。

## 依赖与并行

```
task-1（注册表，lib 侧）  ─┐
                          ├→ 页面集成（Lead）→ 全量门禁 → 文档/版本
task-2（记录+通知，含通知/UI store）─┘
```

- task-1 与 task-2 文件集**零重叠**（task-1 不碰 `store.ts`；`AutomationResult` 留在 `store.ts`，
  `actions.ts` 用 type-only import）。
- 页面集成必须等两者都完成：它同时消费注册表（动作下拉）与 `useAutomationRunsStore`/`automationFocusId`。

## 风险控制

- 每个实现者只跑自己文件集的测试，Lead 跑全量；避免并发写同一文件。
- 守护三条护栏用例（不补跑 / 不自动重试 / 未连接不 spawn）必须在全量里保持绿。
- `writeJson` 失败静默是既有事实，本轮不改造它，只在页面写明。
