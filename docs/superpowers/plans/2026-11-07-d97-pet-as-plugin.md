# d.97 实施计划 · 桌宠拆成界面插件

> 规格：[`../specs/2026-11-07-d94-pet-as-plugin.md`](../specs/2026-11-07-d94-pet-as-plugin.md)
> 分支：`feat/d94-pet-content`（从 `feat/d77-heming-core` 的 `93f9b65` 拉出，独立 worktree）
> 版本：`d.97.2.42.0`

## 依赖图

```
T4 契约（shared/server/发布脚本）──┐
T1 宿主运行时（desktop）──────────┼─→ 集成联调 ─→ T5 文档/版本/门禁
T2 插件包（pet-widget 迁移+构建）──┤
T3 主窗（web：插件区/设置/事件/删桌宠）┘
```

## T1 · 宿主运行时（desktop）

- [x] `plugin-window.js`：清单归一化、窗口参数、几何/吸附/档位、`widget://<id>/` URL 与同 origin 判定
- [x] `plugin-package.js`：`package.tgz` 结构校验 + 清单守卫 + sha256（签名可选、结构校验）
- [x] `plugin-tar.js`：确定性 tar 读写（gzip 9、固定 mtime/uid/gid/排序、配额/穿越/链接校验）
- [x] `plugin-store.js`：`userData/plugins` 注册表、版本目录 + `current.json`、state/settings、staging、迁移
- [x] `plugin-host.js`：窗口/托盘/穿透/拖拽/位置/事件、`widget:*` 按 sender 自校验、chatConfig 缓存
- [x] `widget-preload.js`：最小桥 `__heming_widget`
- [x] `main.js` / `preload.js` / `app-protocol.js`：widget scheme + CSP、`widgets:*` 通道、反向推送、移除 pet
- [x] `magpie-proxy.js`：widget origin 放行判定注入（默认 fail-closed）
- [x] 删除 `pet-host.js` / `pet-window.js` 及其测试；`build-desktop-web.mjs` 改为「出现 pet.html 即失败」
- [x] 门禁：`node --check` + `node --test` 全绿（新增 98 例）

## T2 · 插件包（packages/pet-widget）

- [x] 迁移 `pet.html` / `src/pet.tsx` / `components/pet/**` / `lib/pet{Pose,Prefs,Event}.ts` / `public/pet/**`（5MB）
- [x] 适配层：`widgetBridge.ts`（契约 + 容错）、`gatewayChat.ts`（本机网关 SSE + 错误人话化）
- [x] 偏好改宿主 settings（`agentId/modelPath/presence`）、主题 `info()`、事件 `onEvent`、对话 `chatConfig()`
- [x] 独立 vite 构建 + `plugin.json` v4 + `scripts/build-pet-widget.mjs` / `scripts/pack-plugin.mjs`
- [x] 迁移单测（132 例），确定性 tgz（重复打包 sha 一致）
- [x] 删除 web 侧 `lib/petWindow.ts`（窗口身份判定归宿主，插件内为死代码）

## T3 · 主窗（web）

- [x] 清单 v4：`manifest.ts` 支持 schemaVersion 4 / `distribution` / `desktopWidgets` / 新 permissions；v3 语义不变
- [x] 插件区「桌面小组件」：列表/启停/卸载/设置、云端 bundle 安装、本地 `.tgz` 导入
- [x] 设置区「外观 · 桌面小组件」：通用表单 + 宿主动作
- [x] `lib/widgetEvents.ts`：通知 → 脱敏 → `publish`（10 分钟频控仍在主进程/插件侧口径）
- [x] 删除桌宠引用：App / SettingsPage / settings registry / types / vite 入口 / pixi 依赖
- [x] 迁移：`lib/widgets/legacy.ts` 读 `heming.pet.v1` + `heming.pet.presence.v1` → `widgets:migrateLegacy`
- [x] 测试：manifest v4 / widget store / 设置字段 / 事件脱敏 / 插件区

## T4 · 契约与分发

- [x] `shared/pluginCatalog.ts`：`distribution` / `package{sha256,size}` / `contributions.desktopWidgets`
- [x] server：`readPackage` + `GET /api/plugins/:id/:version/package`
- [x] `scripts/publish-plugin.mjs`：目录型 bundle → 确定性 `package.tgz` + 目录布局
- [x] server 测试：bundle 条目、包下载、bundle 缺包跳过

## T5 · 收口

- [x] 文档：`docs/PET.md` 重写、`docs/PLUGINS.md` §9、`docs/INDEX.md`、`docs/HANDOFF.md`
- [x] `CHANGELOG.md` + `docs/RELEASE-NOTES.md` + `node scripts/build-changelog.mjs`
- [x] `node scripts/bump-version.mjs auto feature`
- [x] 全量门禁 `pnpm -r build && pnpm -r test && pnpm -r typecheck`
- [x] 本机 Electron 冒烟（脚本留在 `.tmp`、不入库）：安装 → 建窗 → widget:// 加载 → 桥/设置/事件/主题，0 console 错误
- [ ] 真机人工：拖拽/穿透/右键菜单/对话的实际手感（自动化覆盖不到鼠标与合成层观感）

## 明确不做（本轮）

- 第三方界面插件（另立沙箱规格）；多 widget 并存；插件内嵌主窗面板（iframe）
- 逐包 Ed25519 签名与官方公钥白名单（P1）；宿主代发对话（P1）
- 远端 magpie 网关（P1）；插件独立 session partition（P1）
