# d.44 实施计划 · 插件更新预览与能力详情

- 日期：2026-11-01
- 规格：`docs/superpowers/specs/2026-11-01-d44-plugin-update-preview.md`
- 基线：d.43.1.11.0 → 目标：d.44.1.11.0
- 全程只改 `packages/web`；不改服务端、shared、桌面端

## 任务

1. **规格**（已完成）
   - `docs/superpowers/specs/2026-11-01-d44-plugin-update-preview.md`。

2. **存储层：`preview` + `skillsOf` / `serversOf`**（`packages/web/src/lib/plugins/store.ts`、`index.ts`）
   - `preview(input: string | unknown): PluginPreview`：`parsePluginManifest` → 找 existing → 技能 diff（按 `pluginId` 从技能池实际取，字段全等判 unchanged）→ 服务 diff（`pluginServerId` + `mcp.get`，冲突先摘出）→ `hosts`（`URL.host` 去重保序）→ `limitReached`（新插件且已满 50）。
   - 纯读：不调 `skills.update/create/remove`，不调 `mcp.add/update/remove`，不 `save()`，不改 `this.data`。
   - `skillsOf(pluginId)` / `serversOf(pluginId)` 返回窄结构（规格 B 的字段与顺序）；`serversOf` 以记录 `serverIds` 为索引、跳过注册表里已不存在的。
   - `index.ts` 导出 `PluginPreview`、`PluginServerDiff` 类型。
   - `removed` 服务 key = id 去掉 `plugin:<插件 id>:` 前缀，兜底用 id；name 取注册表实际值。

3. **插件页：更新差异 + 详情弹窗**（`packages/web/src/components/PluginsPage.tsx`）
   - 安装面板把本地 `parsePluginManifest` 预览换成 `plugins.preview(text)`（try/catch 显示 `PluginManifestError`），保留文件选择、非法清单报错、`install(text)` 调用与成功文案。
   - 新插件：`技能 N · 服务 M` 计数；更新：两行 `+/~/=/-` 摘要 + `+ / ~ / -` 前缀 chip（unchanged 只计数）+ 保留声明（请求头、已启用工具、启停状态、`installedAt`）。
   - `conflicts` 用 `role="alert"` 阻断并禁用确认；`limitReached` 同样阻断并禁用。
   - 卡片操作区加「详情」；在 `PluginsPage.tsx` 内加本地组件 `PluginDetailDialog`（`useModalA11y`、`role="dialog" aria-modal="true"`），展示元数据 + 技能列表（启用徽标）+ 服务列表（host + 启用徽标）+ 空态；页脚 `查看技能` / `查看接口` / `卸载`（卸载先 `setDetail(null)` 再 `setRemoveTarget(plugin)`）。
   - 不改 `install / setEnabled / remove` 与接口区、卸载确认文案。

4. **测试 + 全量门禁**
   - `lib/plugins/store.test.ts` 新增 `describe("PluginStore · 预览")`：
     1) 新插件：`existing === null`、技能/服务全 `added`、`hosts` 去重含端口、`limitReached === false`；
     2) 纯函数：调用前后 plugins/skills/mcp 存储字符串逐字不变；
     3) 更新四分类：新增技能、改 `instructions`、改 `triggers` 各归位、等值技能 `unchanged`、清单删名 `removed`；
     4) 技能以池为准：手删技能后报 `added` 而非 `unchanged`；
     5) 服务：改 `url` → `changed`、改名 → `changed`、等值 → `unchanged`、旧 `serverIds` 残留 → `removed`、用户转正后不列 `removed`；
     6) 冲突：手填占用 `plugin:<id>:<key>` → `conflicts` 命中且不出现在 changed/unchanged；
     7) 上限：装满 50 后新插件 `limitReached === true`，同 id 更新为 `false`；
     8) 非法清单抛 `PluginManifestError` 且不写盘；
     9) `skillsOf/serversOf` 字段与启用状态正确，手删技能后不再出现。
   - `components/PluginsPage.test.tsx`：新插件计数与 host、更新前缀 chip 与保留声明、冲突禁用确认、上限提示、详情弹窗内容与空态、Esc 关闭与焦点归还、详情内卸载先关弹窗、详情「查看接口」切页。
   - 跑 `pnpm -r build && pnpm -r --workspace-concurrency=1 test`，记录四包用例数。

5. **真实浏览器验证**
   - `.tmp/mock-mcp.mjs`（临时、不入库）起最小 HTTP MCP 服务，暴露 `echo` 工具；`pnpm --filter @heming/web dev`。
   - 装 base 包 `acme.weather v1.0.0`（技能 A、服务 weather）；接口区连接、补请求头 `X-Demo: 1`、启用 `echo`。
   - 用 v1.1.0 更新：技能 A 改指令、新增技能 B、删技能 C（C 先在旧版里存在）、服务 weather 改 url、新增服务 air、删旧服务 old。核对面板：`~A / +B / -C`、服务 `~weather / +air / -old`、保留声明可见；确认后请求头 `X-Demo`、`echo` 仍启用、`installedAt` 未变、启停状态未变。
   - 冲突：手填服务 id 撞 `plugin:acme.weather:air` 后重装，确认按钮禁用并给出冲突 id；删掉手填服务后恢复。
   - 详情：打开弹窗核对技能与服务两侧都列全、host 与启用徽标正确；Esc 关闭；详情内卸载走二次确认并清理服务。

6. **收口**
   - `node scripts/bump-version.mjs auto feature` → `d.44.1.11.0`（五包同步）。
   - CHANGELOG 顶部加 d.44 段（差异预览、详情视图、边界不变、明确不做、用例数），跑 `node scripts/build-changelog.mjs`。
   - 更新 `docs/HANDOFF.md`（当前版本/标签/main、里程碑 42、测试实跑数、插件边界口径补「预览与详情」）、`docs/INDEX.md`（d.44 已完成 + spec 链接）、`README.md`（当前版本与插件条目）。
   - 复核未改 `install` 语义与 d.42/d.43 文案口径。
