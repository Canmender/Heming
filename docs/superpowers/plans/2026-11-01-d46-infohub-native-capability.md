# d.46 实施计划 · 信息中枢原生融入

- 日期：2026-11-01
- 规格：`docs/superpowers/specs/2026-11-01-d46-infohub-native-capability.md`
- 基线：d.45.1.11.0 → 目标：d.46.1.11.0
- 范围：`packages/web`（能力、状态、首页、命令面板、信息中枢页意图）

## 任务

1. **规格**（已完成）
   - 写入 `2026-11-01-d46-infohub-native-capability.md`。

2. **共享状态**
   - `lib/infohub/store.ts`：zustand store；`boot` 只读 `info()`，`connect` 才 `start()`；
     `refresh` 拉 `status` + `agenda`；`rebuildAgenda` 显式传 `rebuild:true`；
     `syncInfo` / `markStopped` 供页面同步。
   - `App.tsx` 挂载时 `boot()` 一次。

3. **能力提供者**
   - `lib/infohub/tools.ts`：四个工具 + 风险声明 + 中文格式化 + 来源；
     执行前校验桌面端与连接态；不 spawn、不调用 `sync`。
   - `lib/capability/providers.ts` 增加 `infohubProvider`，注册在 `wiki` 与 `self` 之间。
   - `ToolSource` 增加 `kind?: "archive"`；`sourceFooter` 按类型切换标题。

4. **体验**
   - `components/InfohubHomeCard.tsx`：连接入口 / 日程摘要 / 归档规模 / 跳转；
     插入 `HomePage` 热力图与两栏之间，浏览器不渲染。
   - `components/CommandPalette.tsx`：已连接时防抖检索归档，合并结果、键盘选择、
     跳转信息中枢并投递检索意图。
   - `store/ui.ts`：`infohubIntent` + `openInfohub` + `consumeInfohubIntent`。
   - `components/InfohubPage.tsx`：消费意图（检索/日程）；连接、断开后同步 store。

5. **测试与门禁**
   - store / tools / home card / command palette / page intent 测试；
   - 更新 provider 注册顺序、来源脚注测试；
   - `pnpm -r build && pnpm -r --workspace-concurrency=1 test`；
   - 浏览器实测：无桥时首页无卡、命令面板文案不变；有桥时（jsdom/组件测试）摘要与跳转可用。

6. **收口**
   - `node scripts/bump-version.mjs auto feature` → `d.46.1.11.0`；
   - `node scripts/build-changelog.mjs`；
   - 更新 `CHANGELOG.md`、`README.md`、`docs/HANDOFF.md`、`docs/INDEX.md`。
