# d.42 实施计划 · 插件包与插件区

- 规格：`docs/superpowers/specs/2026-11-01-d42-plugin-packages.md`
- 目标版本：`d.42.1.11.0`（feature +1）
- 范围：`packages/web` 一个包；技能池新增归属字段，导航新增一页

## 任务

1. **技能归属**
   - `lib/skills/types.ts`：`SkillDefinition.pluginId?: string`。
   - `lib/skills/store.ts`：`coerceSkill` / `create` 保留 `pluginId`；`assigned()` 默认集合改为「内置 + 插件技能」；新增 `assignToAllWithAssignments(skillIds)` 供安装时追加分配。

2. **插件清单**
   - 新增 `lib/plugins/manifest.ts`：zod schema、`parsePluginManifest`（接受文本或对象）、`PluginManifestError`、中文字段错误。
   - 规范化：trim、列表去重、未知字段丢弃、重复技能名拒绝。

3. **插件存储**
   - 新增 `lib/plugins/store.ts`：`PluginStore(storage?, skills?, now?)`。
   - `install` / `setEnabled` / `remove` / `list` / `get`；上限 50；容错读取；写入异常静默。
   - 技能物化：`source: "imported"` + `pluginId`；更新按名称对齐、增删同步。
   - 新增 `lib/plugins/index.ts`：默认单例（复用 `skillPool`）。

4. **插件页**
   - 新增 `components/PluginsPage.tsx`：列表、启用开关、安装/更新对话框（粘贴 + 文件）、解析预览、卸载确认、空态与提示。
   - 新增 `PackageIcon`；`SkillsPage` 详情补插件归属展示（只读，不改管理口径）。

5. **导航接线**
   - `store/ui.ts`：`Page` 增加 `plugins`，`DEFAULT_NAV_ORDER` 放在 `skills` 之后。
   - `components/NavRail.tsx`：插件项 `Alt+0`。
   - `App.tsx`：`SHORTCUT_PAGES` 末尾追加 `plugins`；按键白名单加 `"0"`；渲染分支。
   - `components/SettingsPage.tsx`：`NAV_LABELS` 补 `plugins`。

6. **测试**
   - `lib/plugins/manifest.test.ts`：合法最小清单、默认值/去重、非法 JSON、坏 id、空技能、重名、超长、未知字段。
   - `lib/plugins/store.test.ts`：安装、更新增删、启停、卸载、分配补齐、上限、损坏存储。
   - `lib/skills/skills.test.ts`：插件技能进入默认分配。
   - `components/PluginsPage.test.tsx`：空态、解析错误、安装预览与安装、开关、卸载确认。

7. **收口**
   - `pnpm -r build && pnpm -r --workspace-concurrency=1 test`。
   - `node scripts/bump-version.mjs auto feature` → `d.42.1.11.0`。
   - 写 `CHANGELOG.md` → `node scripts/build-changelog.mjs`。
   - 更新 `docs/HANDOFF.md`、`docs/INDEX.md`、`README.md`。
