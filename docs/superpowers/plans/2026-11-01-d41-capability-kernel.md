# d.41 实施计划 · 能力内核

- 规格：`docs/superpowers/specs/2026-11-01-d41-capability-kernel.md`
- 目标版本：`d.41.1.11.0`（feature +1）
- 范围：`packages/web` 一个包，无协议/服务端变更

## 任务

1. **能力内核**
   - 新增 `src/lib/capability/types.ts`（`ToolOrigin`、`CapabilityProvider`、`CapabilityContext`、`CapabilityRegistry` 接口）。
   - 新增 `src/lib/capability/registry.ts`（注册/构建/合并/meta 归属）。
   - 新增 `src/lib/capability/providers.ts`（mcp/charts/tone/wiki/self 五个）。
   - 新增 `src/lib/capability/index.ts`（默认单例，按原顺序注册）。
   - `agentStream.ts` 的 `ToolBridge.meta` 返回值补可选 `origin` / `providerId`。
   - 导出 `merge.ts` 的 `listsName`（注册表复用同一「谁声明了这个名字」判据）。

2. **接线**
   - `ChatPage.buildToolsFor` 改为 `capabilityRegistry.build({ agentId, conversationId, selfEdit })`。
   - 删除 ChatPage 里五个桥的直接 import；`toolMetaOf` 签名与行为不变。

3. **技能边界**
   - `skills/router.ts`：`RouteContext.allowed`，过滤在 disabled 之后。
   - `skills/store.ts`：`route()` 传 `assigned(agentId)`。
   - 新增用例：未分配自定义技能不命中；已分配命中；无分配记录时内置默认命中。

4. **测试**
   - 新增 `src/lib/capability/registry.test.ts`：顺序、空桥、未知工具、meta 归属/origin、重复 id、全空。
   - 新增 `src/lib/capability/providers.test.ts`：注册顺序与来源分类；self 未配置时不注入。

5. **收口**
   - `pnpm -r build && pnpm -r --workspace-concurrency=1 test`。
   - `node scripts/bump-version.mjs auto feature` → `d.41.1.11.0`。
   - 写 `CHANGELOG.md` → `node scripts/build-changelog.mjs`。
   - 更新 `docs/HANDOFF.md`（里程碑 39、下一步指向 d.42 插件包）与 `docs/INDEX.md`。
