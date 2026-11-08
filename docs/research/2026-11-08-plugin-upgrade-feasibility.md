# 插件体系升级 · 可实现性自检（d.104）

> 目的：在动代码之前，把 `docs/superpowers/specs/2026-11-08-plugin-system-upgrade.md` 里的**每条技术假设**拿代码/可运行实验验一遍，把「想当然」挑出来。
> 方法：① 读真实代码；② 在仓库里跑探针（node 单文件脚本、zod 实测、签名实验、体积估算）；③ 对照证据给出「可实现 / 需调整 / 阻塞」。
> 基线：`feat/d103-plugin-system`，HEAD `c6d81a8`（d.103.2.42.0）。探针命令与输出见 §1，全部可复现。

## 0. 结论速览

| # | 规格假设 | 判定 | 一句话原因 |
|---|---|---|---|
| A1 | 5 段版本比较 + `engines.heming` 能在三端复用 | **可实现** | 纯函数；`shared` 是 ESM+tsc，web/server 都能 import；web 有 `__APP_VERSION__` |
| A2 | v5 清单用 zod 校验，并生成 JSON Schema 给编辑器 | **需调整** | zod 4.6.7 有 `z.toJSONSchema`，但**实测 `.refine()` 静默丢失** → schema 只能当提示，lint 必须跑真解析器 |
| A3 | v5 对未知字段「拒绝而不是静默 strip」 | **需调整** | 现清单全是非 strict `z.object`；改 strict 属**破坏性收紧**，只能对 v5 生效 |
| A4 | 统一「能力单元」只读投影 | **可实现** | 四套存储都有 list/read；`modules/registry.ts` 是编译期常量，天然可适配 |
| A5 | 新贡献点统一「注册返回撤销句柄」 | **需调整** | 运行时目前是硬接线渲染；阶段 A 只做**纯函数注册表**，接线放阶段 C，避开 903 行的 `App.tsx` |
| A6 | 安装失败可回滚（快照 localStorage） | **可实现但不够** | 存储回滚可行，但三个类单例（技能池/MCP/插件）**没有 reload**，内存仍是脏的 → 必须新增 `reload()` |
| A7 | 更新支持「回滚到上一版」 | **需调整** | 存储成本实测：典型清单 11.4KB、最坏 1.2MB；每插件存两份会顶爆 5MB 配额 → 必须设上限/只存可重放字段 |
| A8 | 市场索引 v2 | **可实现** | 200 插件×3 版本 index 实测 **225KB**；服务端 `express.json 8mb`；索引由发布工具生成、服务端只存字节 |
| A9 | 详情文档/图标/截图分发 | **可实现** | 现有 `pluginCatalog` 的 id/version 字符集校验与字节读取可复用，补白名单扩展名即可 |
| A10 | 首方 bundle 签名（Ed25519） | **可实现，但现状是从零做** | Node 24 `crypto.verify` + 32 字节 raw key 实测通过；**但当前 bundle 完全没验签**（代码注释与实现相互矛盾） |
| A11 | bundle 的 `commands` 物化 | **需调整** | bundle 不允许 `skills` → 命令 target 只能是 `page`/`plugin`，规格里「复用三 target」不成立，要收紧 |
| A12 | Agent 侧 `plugin_*` 工具 | **可实现但有坑** | capability provider 模式现成；但必须复用 UI 的 plan/apply + HITL，不能绕过预览直接写 |
| A13 | 门禁不会被这次改动拖红 | **未完全验证** | 基线 `shared build` + `web typecheck` 实测通过；全量 `pnpm -r test` 未跑（约 4000+ 例，预计 3–5 分钟） |
| A14 | 与并行会话不冲突 | **需调整** | `App.tsx`(903 行)/`SettingsPage`/`HomePage` 是冲突热点（另一会话刚改过）→ 阶段 A 不碰 |

**总体判断**：升级方案**可行**，但有 4 处必须改设计（A2/A3/A7/A11）、2 处必须新增基础能力（A6 的 reload、A10 的验签实现），以及 1 处必须控制范围（A5/A14）。修正清单见 §3，需要拍板的取舍见 §4。

## 1. 自检方法与探针

| 探针 | 命令（在 `D:/Heming` 下） | 实测结果 |
|---|---|---|
| zod 是否支持 JSON Schema | `cd packages/shared && node -e "const z=require('zod'); console.log(z.toJSONSchema)"` | zod `4.6.7`，`toJSONSchema` 存在，输出 draft 2020-12 |
| refine 是否进入 schema | 同上，对 `.refine()` 的 object 调 `toJSONSchema` | 输出里**没有** refine 规则（无 `if/then`）→ 跨字段规则丢失 |
| Node Ed25519 验签 | `node -e "…generateKeyPairSync('ed25519')…verify()"` | `verify ok: true` / 篡改后 `false`；raw 32B 公钥经 JWK 可用 |
| 最坏/典型清单体积 | node 脚本按 `manifest.ts` 限额构造 | 最坏 **1,216KB**；典型 **11.4KB**（3 技能×1KB 指令） |
| 索引体积 | node 脚本 200 插件×3 版本 | **225KB** |
| 基线构建 | `pnpm --filter @heming/shared build`、`pnpm --filter @heming/web typecheck` | 均 exit 0 |
| 服务端 body 上限 | `grep express.json packages/server/src/app.ts` | `8mb`（索引 225KB 无压力） |
| 版本注入 | `grep __APP_VERSION__ packages/web/vite.config.ts` | `define: __APP_VERSION__ = hemingVersion` |

## 2. 逐项自检

### 2.1 版本比较与 `engines`（对应规格 §4.2/§4.3）

**可实现。** 和鸣版本是 5 段（`docs/VERSION-MANAGEMENT.md`），解析与比较是纯函数，放进 `packages/shared/src/plugin/version.ts` 即可；`shared` 是 `type: module` + `tsc` 构建（`packages/shared/package.json:13-18`），web/server 都依赖它（`packages/web/src/lib/plugins/catalogClient.ts:3` 已 import `@heming/shared`）。

应用版本三端来源都现成：

- web：`__APP_VERSION__`（`packages/web/vite.config.ts:25`，`packages/web/src/vite-env.d.ts` 有声明）；
- 桌面：preload 暴露 `__heming_version`（`packages/desktop/preload.js:67`，`app-version.js` 读取）；
- 服务端：不需要（服务端不判定兼容性，目录只发数据）。

**注意**：`engines.heming` 用「最小版本」语义（`>=`），不要引入 semver range —— 和鸣版本不是 semver，range 会带来解析歧义（规格已写明，此处确认可行）。

### 2.2 v5 清单校验与 JSON Schema（对应规格 §4.2/§9）

**需调整。** 探针结论：

1. zod 4.6.7 支持 `z.toJSONSchema`，但它**静默丢弃** `.refine()`/`.superRefine()` 这类跨字段规则（实测：`.refine()` 的 object 输出里没有任何约束）。而 v5 的关键规则恰恰是跨字段的（如「bundle 只许 commands+desktopWidgets」「`meta.detail` 内联与路径二选一」「`requires` 不得自引用」）。
2. 因此：`docs/plugin.schema.json` **只能作编辑器补全/提示**，**不能当权威校验**。`scripts/plugin-lint.mjs` 必须直接调用 shared 里的 zod 解析器（`node` 可 `import` 编译后的 `packages/shared/dist/index.js`，ESM 直接可用），而不是读 JSON Schema。
3. 生成物要在 CI 里比对，防止手改漂移（参照仓库既有「生成目录 + verify 脚本」的做法，如 `docs/tool-catalog` 的生成/校验，见 `packages/server/README` 相关脚本约定）。

### 2.3 v5 对未知字段「拒绝」（对应规格 §4.6）

**需调整（破坏性收紧）。** 现状：`packages/web/src/lib/plugins/manifest.ts` 全部用普通 `z.object`（不是 `.strict()`），未知字段被 zod 静默丢弃——这正是「装完不报错、新字段全丢」的根因（`manifest.ts:1250` 注释也写了这一点）。

改 strict 的正确姿势：

- 只对 `schemaVersion: 5` 使用 `z.strictObject`；
- v1–v4 保持 strip（旧包可能有历史遗留字段，如 d.88 的 `llmPresets`，strict 会误杀）；
- 错误文案要能指出「未知字段 `xxx`（v5 不接受）」，而不是 zod 默认的难懂文案。

### 2.4 统一单元投影（对应规格 §3.1）

**可实现。** 四套来源都有稳定的读接口：

- 插件：`pluginStore.list()`（`packages/web/src/lib/plugins/store.ts`）；
- 模块：`BUILTIN_MODULES` 常量（`packages/web/src/lib/modules/registry.ts:58-113`）+ `useModuleStore`；
- 系统能力：`describeCapabilityCatalog`（`packages/web/src/lib/capability/catalog.ts`）；
- 界面插件：`window.__heming_widgets.list()`（`packages/desktop/preload.js:296`，web 侧已封在 `packages/web/src/lib/widgets/store.ts`）。

投影层是纯函数，不依赖 React，可直接单测。

### 2.5 撤销挂载与内存态回滚（对应规格 §3.3/§5.2）

**需调整。** 两个问题：

1. **运行时没有「注册表」**：页面/首页卡/设置卡/后台循环目前是硬接线（`App.tsx:559-561,588`、`HomePage.tsx`、`lib/settings/registry.ts`）。要「撤销即下线」必须先把这些接线改成「注册 + 撤销」；`App.tsx` 已 903 行且刚被并行会话改过（d.103 模型页），阶段 A 动它风险高。
   → **修正**：阶段 A 只做**纯函数注册表**（`mountContribution` 存根 + 单测），接线（App/Settings/Home）放阶段 C，并单独排期避开并行会话。
2. **三个类单例没有 reload**：`skillPool`（`lib/skills/index.ts:8`）、`mcpRegistry`（`lib/mcp/store.ts:584`）都是构造期从 localStorage 读一次，`pluginStore` 同理。安装事务回滚只恢复存储，**内存仍是脏的**（比如技能池里多了一条插件技能）。
   → **必须新增** `reload()`（重新读存储并重建内存态），三个都加，各约 10 行；`McpRegistry` 已有 `hydrate`/`refreshAfterHydrate` 的先例（`store.ts:222-231`），照抄即可。

### 2.6 安装事务与配额（对应规格 §5.2）

**可实现，但要把「体积预检」写进 plan。** 探针数据：

- 最坏合法清单 **1.2MB**（技能 50×8000 字指令 + 10 服务 + 30 命令），50 个插件最坏 59MB；
- 典型清单 **11.4KB**，20 个插件 229KB；
- localStorage 同源预算约 5MB（`lib/storageUsage.ts:24` `DEFAULT_QUOTA_BYTES = 5MB`）；
- `pluginStore.save()` 直接 `setItem`、**无单键上限**且吞异常（`store.ts:857-863`），而通用 `writeJson` 有 1.2MB 单键上限（`lib/memory/storage.ts:38`）。

结论与修正：

1. `planInstall` 阶段就要估算写入后各键总字节（现有 `lib/storageUsage.ts` 的 `utf8Length` 可复用），超阈值**直接拒绝并给出「先清理什么」的建议**，而不是写完再靠回滚。
2. 快照/恢复用 `StorageLike` 的 `getItem/setItem/removeItem` 可行；恢复失败（配额/隐私模式）必须如实报 `rollback.ok=false`（规格已写）。
3. 统一走 `writeJson` 会把最坏清单挡在 1.2MB 边缘（实测最坏 1,216KB 恰好超一点）→ 需要把清单单键上限提到 2MB 或在 v5 里收紧技能指令总额；这是**决策点**（§4）。

### 2.7 「回滚到上一版」的存储成本（对应规格 §5.3）

**需调整。** `InstalledPlugin` 存的是**完整归一化清单**（`store.ts` 的 `manifest` 字段），更新回滚要再存一份旧清单：

| 场景 | 单插件 | 20 插件 | 50 插件 |
|---|---|---|---|
| 典型 | 11.4KB | 229KB | 572KB |
| +previous（翻倍） | 22.8KB | 458KB | 1.1MB |
| 最坏 | 1.2MB | — | 远超 5MB |

→ 修正：`previous` **不超过 128KB/插件**且总量不超过 **512KB**，超出即放弃本次回滚能力（UI 如实标注「本插件未保留上一版」）；更优做法是**只存差量**（技能名/服务 key 的增删改），回滚时用差量反推——但差量反推有信息损失风险，建议先做「限额 + 放弃」，把差量留给后续版本。

### 2.8 市场索引 v2（对应规格 §6）

**可实现。** 实测 200 插件×3 版本索引 225KB；服务端 JSON body 上限 8MB（`packages/server/src/app.ts:95`），4MB 的 PUT 上限合理。三条边界确认：

1. **服务端「只存字节」原则能保持**：索引由 `scripts/publish-plugin.mjs` 在本地生成后 PUT，服务端只做「JSON 对象 + 大小」检查，不解析插件语义（与现有发布路由同一口径，`app.ts:149-180`）。
2. **公开读**：现有目录接口就是公开的（`app.ts:120-133`），索引同样不需要登录；客户端 `catalogClient` 里清单下载用的是原生 `fetch`（不是带 Bearer 的 `api()`），索引照此实现即可（`catalogClient.ts:97-108`）。
3. **回落**：索引 404 → 客户端回落到 `/api/plugins` 现成面板，无需后端兜底。

### 2.9 详情/资源分发（对应规格 §6.1）

**可实现。** 现有 `createPluginCatalog` 已有 id/version 字符集校验（`pluginCatalog.ts:24-28`）与按目录读字节的实现（`:288-310`），扩展成「读 `<id>/<version>/detail.md` 与白名单扩展名的资源」是同一类代码。需要新增的只有：

- 扩展名白名单（png/jpeg/webp/svg/ico）+ 单文件大小上限（建议 2MB）；
- `Content-Type` 映射与 `X-Content-Type-Options: nosniff`；
- 路径穿越守卫（沿用 id/version 正则 + `path.resolve` 前缀校验，仓库已有同类实现可参照 `packages/desktop/path-guard.js`）。

### 2.10 首方 bundle 签名（对应规格 §7.1）

**可实现，但必须承认：现状是从零实现，不是「收紧」。** 三处证据相互矛盾：

| 位置 | 说法 | 事实 |
|---|---|---|
| `packages/web/src/lib/plugins/store.ts:367-368` | 「代码、窗口、**签名校验**全在主进程的 `widgets:install` 里」 | 主进程不验签 |
| `packages/desktop/plugin-package.js:21-22` | 「本文件**不校验** ed25519 签名本身（那是 web 侧 signature.ts 的事）」 | web 侧对 bundle 清单一律拒绝（`store.ts:371`），也不会走到那 |
| `packages/web/src/components/PluginInstallDialog.tsx:24-30` | 「签名与首方限制由主进程安装器判定」 | 主进程只查「带了 publisher + signature」结构（`plugin-package.js:140-160`），不验签 |

→ 也就是说：**任何能拿到发布密钥（或本地 `.tgz` 文件）的人都能装进一个带假签名的界面插件**。这是本次升级必须补的真缺口。

可实现链路（探针已验证）：

1. 主进程用 `node:crypto` `verify(null, canonicalBytes, publicKey, signature)`；公钥以 raw 32 字节 base64url 存于 `resources/official-keys.json`（`electron-builder` 的 `files` 白名单需加一行）。
2. **规范化字节的跨进程方案**（三选一，推荐 A）：
   - **A（推荐）**：主进程复制一份 `canonicalJsonText`（约 40 行）+ 固定 fixture 交叉校验（web 生成签名 → fixture 里存 canonical 文本与签名 → desktop 测试断言一致）。成本小，可测试。
   - B：把 `@heming/shared` 的 CJS/ESM 产物打进桌面包 —— `shared` 是 ESM，桌面 main 是 CJS，Electron 45 的 `require(esm)` 兼容性不能赌。
   - C：渲染层把 canonical 文本传给主进程再验签 —— **不可取**：渲染层可伪造文本，等于没验。
3. 签名覆盖面要从 v4 的字段扩到 v5（`engines`/`meta`），**规范化版本化**：`canonical-v2`；对 v4 包继续用 v1 规则验签，否则所有旧签名立刻失效。
4. 过渡：先发签名版 `heming.pet 1.0.1`，客户端切「bundle 必须首方验签」；本地 `.tgz` 安装同样要求签名（否则「只允许官方」名不副实）。

### 2.11 bundle 的 `commands` 物化（对应规格 §7.3）

**需调整。** 现状：bundle 清单允许 `commands`（`plugin-package.js:192-202`），但主进程不物化、web 也不认识（命令面板只读声明式插件，`store.ts:571-588`）。

修正：

- web 可经 `window.__heming_widgets.list()` 拿到已安装 bundle 的清单 → 在命令面板合并展示（桌面端才有；浏览器端自然为空）；
- **target 必须收紧**：bundle 不允许 `skills`，所以 `target.kind: "skill"` 对 bundle 无意义 → bundle 的命令只允许 `page` / `plugin` / `settings`；在 `plugin-package.js` 的校验里加这条（现在是接受全部 target 形状）；
- 命令执行仍走既有分发（`CommandPalette.tsx:249-263`），不改语义。

### 2.12 Agent 侧 `plugin_*` 工具（对应规格 §9）

**可实现，但有一个安全口径要先定。** 现有 capability provider 模式（`packages/web/src/lib/capability/providers.ts`）与 `self_*`/`team_*` 工具的先例都在；工具里读插件列表、检索索引都无障碍。

坑在「安装」：UI 安装路径是「预览 → 用户确认 → plan/apply」，工具直接调 `applyPlan` 会**绕过预览与确认**。两种可行口径：

- 保守（推荐）：工具只做 `plugin_search`（只读）与 `plugin_preview_install`（只读，返回差异/权限/兼容性），**安装仍由用户在插件区点**；等有 HITL 工具级确认后再开放写。
- 激进：工具 `plugin_install` 走 HITL（`danger`），确认弹窗里复用 UI 的预览组件。技术上可行，但需要 HITL 支持「非聊天页的确认卡」，工作量明显更大。

### 2.13 门禁与测试基线

- 已实测：`pnpm --filter @heming/shared build` ✅、`pnpm --filter @heming/web typecheck` ✅（探针记录见 §1）。
- 未实测：全量 `pnpm -r test`（web 228 文件/3401 例、server 141 例、desktop 538 例）。阶段 A 开工前应先跑一次基线，否则改完分不清是谁弄红的。
- 现有护栏可直接用：`manifest.test.ts` 53 例、`store.test.ts` 53 例、`plugin-package.test.js` 14 例、`pluginCatalog.test.ts` 17 例；新增 v5 用例时**不要改旧断言**（旧语义不变）。

### 2.14 与并行会话的冲突面

`git log` 显示同一分支上有另一会话提交的 `9c4bfd2`（d.103 模型页重构，改了 `HomePage/SettingsPage/App.tsx` 等 16 文件）。阶段 A 的落点若包含这些文件，会直接冲突。

→ 修正：阶段 A 只碰 `packages/shared/src/plugin/**`、`packages/web/src/lib/plugins/**`、`packages/web/src/lib/units/**`、`packages/server/src/pluginMarket.ts`、`scripts/plugin-*.mjs`；`App.tsx`/`SettingsPage.tsx`/`HomePage.tsx` 留给阶段 C，并在开工前 re-check `git status`。

## 3. 对规格的修正清单

| # | 规格位置 | 原表述 | 修正 |
|---|---|---|---|
| F1 | §4.2 / §9 | 「生成 JSON Schema 供校验」 | 只作编辑器提示；权威校验与 lint 必须用 zod 解析器，CI 比对生成物 |
| F2 | §4.6 | 未知字段一律拒绝 | 仅 v5 strict；v1–v4 保持 strip，避免误杀历史字段 |
| F3 | §3.3 / §5.2 | 「停用/回滚走撤销」 | 增加三个单例的 `reload()`；阶段 A 只做纯函数注册表，接线延后 |
| F4 | §5.2 | 「快照 + 恢复」 | 再加「写入前体积预检」，超阈值直接拒绝并给清理建议 |
| F5 | §5.3 | 「保存 previous 清单」 | previous ≤128KB/插件、总量 ≤512KB，超限放弃并如实标注 |
| F6 | §7.1 | 「收紧到首方签名」 | 现状无验签，属**新实现**；规范化版本化（v4 用 v1 规则、v5 用 v2）；本地 tgz 也要求签名 |
| F7 | §7.3 | 「bundle commands 物化」 | bundle 命令 target 收紧为 `page/plugin/settings` |
| F8 | §9 | 「Agent 安装工具」 | 默认只读（search + preview）；写操作待 HITL 非聊天页确认再做 |
| F9 | §10 阶段 A | 含「接线」 | 阶段 A 去掉接线（只做纯函数层），接线移入阶段 C |
| F10 | §4.2 | `meta.icon` 允许 data URI | 存储侧只留 https URL 或 ≤8KB data URI；`meta.detail` 内联 markdown 不进 `InstalledPlugin.manifest`（另存 catalog 缓存），否则 50 插件 × 48KB 顶爆配额 |

## 4. 需要拍板的取舍

1. **清单体积上限**：最坏合法清单 1.216MB 恰好顶到 1.2MB 单键上限。选 A「提高单键上限到 2MB」还是 B「v5 收紧技能指令总额（如单插件 256KB）」？→ 建议 B（顺带修掉存量超限风险）。
2. **previous 回滚的代价**：接受「限额 512KB、超出放弃回滚」还是「只存差量、信息有损」？→ 建议前者。
3. **首方签名的规范化方案**：A 复制 canonicalizer + fixture / B 打包 shared / C 渲染层传文本。→ 建议 A。
4. **v5 破坏性收紧**：strict 只对 v5 意味着 v5 包更严、v3/v4 更松；是否接受同一产品里两种严格度？→ 建议接受（并在文档写清）。

## 5. 最小可验证切片（建议第一步就做这个）

六个文件、半天量级，能把最大风险点（事务 + 兼容 + 签名）先证伪：

| 文件 | 内容 | 验收 |
|---|---|---|
| `packages/shared/src/plugin/version.ts` | 5 段版本解析/比较 + `satisfiesEngines` | 12 例（含 `-dev.n`、缺段补 0） |
| `packages/shared/src/plugin/version.test.ts` | 同上 | — |
| `packages/web/src/lib/plugins/manifest.v5.test.ts` | v5 合法/非法/归一化/engines 的用例（先写测试驱动 schema） | 20 例，不改旧断言 |
| `packages/desktop/plugin-signature.js` + `.test.js` | 复制 canonicalizer + `verifyOfficialSignature()`；fixture 用 web 侧生成 | 通过/篡改/换钥/无签名 4 例 |
| `packages/web/src/lib/plugins/store.txn.test.ts` | 用注入 StorageLike 模拟 `setItem` 抛错 → 断言快照恢复 | 1 例关键回归 |
| `scripts/plugin-lint.mjs` | 读 plugin.json → 调 shared 解析器 → 中文报错/字段路径 | 对 `plugins/infohub-collector` 通过、对坏样例非 0 |

完成这 6 个文件后再排阶段 A 的其余部分，可以把「设计不可行」的风险提前到第一天暴露。
