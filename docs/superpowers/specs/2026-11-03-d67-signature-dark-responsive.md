# d.67 · 签名信任、贡献级停用、暗色主题、窄窗响应式

- 日期：2026-11-03
- 状态：**本轮实施**
- 上游：`2026-11-03-d66-plugin-trust-toolpack-authz.md`（d.64.2.24.0 已上线）
- 触发：用户「插件签名/来源校验、停用粒度到单类贡献、暗色主题、<1200 窄窗响应式，全部做完」
- 本轮版本：`d.65.2.24.0`（特性 64→65，其余位保留）

## 1. 插件签名与发布者信任（T1 核心 + T2 UI）

**模型（TOFU，不建 PKI）**：清单新增可选 `publisher` 与 `signature`；用户在安装时首次信任发布者公钥，之后同发布者换钥必须显式复核。

```jsonc
"publisher": { "id": "acme", "publicKey": "<base64url Ed25519 raw 32B>" },
"signature": { "alg": "ed25519", "value": "<base64url 64B>" }
```

- `lib/plugins/signature.ts`（新）：
  - `signedManifestText(manifest)`：规范化文本（`canonicalManifestText` 同款排序）+ **包含 publisher、排除 signature**。
  - `verifyManifestSignature(manifest): Promise<SignatureCheck>`，`SignatureCheck = { status: "none" | "valid" | "invalid" | "unsupported"; reason?: string }`；WebCrypto `crypto.subtle.importKey("raw", pub, {name:"Ed25519"}, …)` + `verify`；无 subtle 或环境不支持时 `unsupported`（不假装验过）。
  - `publicKeyFingerprint(publicKey): Promise<string>`：SHA-256(raw key) 前 16 hex（`sha256:` 前缀）。
  - `PublisherTrustStore`（localStorage `heming.plugin.publishers.v1`）：`get(id)` / `remember({id, publicKey, fingerprint})` / `forget(id)`；坏 JSON 回退空表，不抛。
- `manifest.ts`：v3 增补 `publisher?` / `signature?`（v3 向后兼容；有 signature 必须有 publisher；alg 只允许 ed25519；publicKey 32B、signature 64B 的 base64url 校验；错误中文带字段路径）。
- `store.ts`：`install(manifest, options?: PluginInstallOptions)` 写入 `InstalledPlugin.publisher { id, fingerprint } | null` 与 `signature: { status, alg? } | null`；`preview.trust` 增 `signatureStatus` 与 `publisherKeyChanged`（比对 PublishersStore）。**store 保持同步**：验签在 UI 层异步完成后再调 install。
- **T2 UI（安装弹窗）**：解析后异步验签并显示「签名：有效 / 无效 / 未签名 / 环境不支持」与「发布者：<id> · 指纹 sha256:…」；
  - `invalid` → 确认按钮禁用且不可绕过；
  - 发布者首次出现 → 勾选「我信任发布者 <id> 的公钥」；同 id 公钥变化 → 勾选「我已核对发布者公钥变更」（比对 PublishersStore）；
  - 确认安装时写入信任记录；其它校验（权限、差异、覆盖确认）保持。
- 详情抽屉显示发布者 + 签名状态 + 公钥指纹；`scripts/sign-plugin.mjs`：`--gen-key` 生成 Ed25519 密钥、`sign <plugin.json> <private.b64>` 输出现成 `publisher`+`signature` 片段；文档写清「自签名/TOFU ≠ 公开 CA」。
- 边界：不引入证书链、不联网取公钥、不自动信任任何发布者；验签失败**绝不放行**。

## 2. 贡献级停用（T1 核心 + T2 UI）

- `InstalledPlugin.disabledKinds: PluginContributionKind[]`，`PluginContributionKind = "skills" | "mcpServers" | "commands" | "toolPacks"`（缺省 `[]`）。
- `store.setKindEnabled(pluginId, kind, on)`：立即作用到既有事实——`skills` 调 `skillPool.setEnabled`、`mcpServers` 调 `mcpRegistry.update(id,{enabled})`、`commands` 仅参与命令面板过滤、`toolPacks` 仅参与目录 `CatalogToolPack.enabled` 过滤；同时落盘 `disabledKinds`。
- 插件主开关语义不变（总开关关 = 全部不生效，且不受 disabledKinds 影响）。
- 读口径：`effectiveEnabled(plugin, kind)`（导出纯函数）+ 命令/工具束/技能/服务列表按此过滤；插件卡显示「部分停用」徽标。
- **T2 UI**：详情抽屉「贡献」段每类一行：名称 + 计数 + `role=switch`（受主开关控制；主开关关闭时禁用并注明）；切换即时生效并提示「已停用本插件的技能（不影响服务）」。**不提供全选/全不选**。

## 3. 暗色主题（T3）

- `tailwind.config.js` 颜色改 CSS 变量（light 值放 `:root`，dark 放 `[data-theme="dark"]`）：`line / line-soft / line-strong / muted / ink / panel` + 新增 `surface / subtle / subtle-2 / subtle-3 / subtle-4 / body / placeholder / danger / danger-soft / danger-line / warn / success`。
- `index.css`：
  - `:root` 与 `[data-theme="dark"]` 两套变量；`html { color-scheme: light/dark }`；`body` 用 `bg-surface text-ink`；
  - **暗色兼容层**（未改成 token 的既有字面量类，按类名覆盖，注释写明这是迁移期桥接、后续改 token 时删）：`bg-white`、`bg-[#fafafa]`、`bg-[#f7f7f7]`、`bg-[#f3f3f3]`、`bg-[#f0f0f0]`、`bg-[#fcfcfc]`、`bg-[#fef3f2]`、`text-[#555]/[#666]/[#6f6f6f]/[#1a1a1a]/[#b8b8b8]/[#b42318]/[#b45309]/[#1d6b3a]/[#15803d]`、`border-[#ececec]/[#e6e6e6]/[#fecdca]`、默认边框、滚动条、骨架、阴影；
  - `.bg-ink` 继续跟随 `--heming-accent`，暗色下默认墨色改用浅色强调（见下）。
- `lib/theme.ts`：新增 `ThemeMode = "light" | "dark" | "system"`；`getThemeMode()`/`setThemeMode()`（键 `heming.theme.mode.v1`）、`applyThemeMode(mode)`（写 `data-theme`，system 监听 `matchMedia("(prefers-color-scheme: dark)")`）、`resolveThemeMode`；暗色且主题色为默认墨黑时，`--heming-accent` 自动取浅色（保证 `.bg-ink` 按钮可读），用户改过颜色则尊重用户值；`main.tsx` / `pet.tsx` 启动时应用。
- 设置区新增「主题模式」卡（浅色/深色/跟随系统 三选一，`role=radiogroup`），持久化 + 即时生效；与既有主题色卡共存。
- 验收：暗色下 13 个导航页无「白底白字/黑底黑字」不可读块；文字对比度沿用既有 token 口径。

## 4. <1200 窄窗响应式（T4）

- `lib/viewport.ts`（新）：`useViewport()`（`window.innerWidth` + `resize` 监听）与 `NARROW_BREAKPOINT = 1200`、`isNarrow(width)` 纯函数。
- `App.tsx`：
  - 窄窗（<1200）默认**隐藏右侧「共享文件」栏**；顶部出现「共享文件」按钮，点击以**覆盖层抽屉**打开（`aria-modal` + 遮罩 + Esc 关闭 + 焦点归还），关闭后回到窄窗布局；
  - 宽窗恢复既有可拖拽 aside（宽度记忆、最小/最大不变）；
  - 当前页面切到 `settings/team/workspace/memory` 等宽页面时不横向溢出。
- `components/layout/PageShell.tsx`：内容内边距窄窗 `px-4`（宽窗 `px-6` 不变），页头 actions 允许换行不撑破。
- 断点用 `max-[1199px]:` / `min-[1200px]:` arbitrary variants（不新增 Tailwind 断点，避免影响既有 `md:`/`lg:` 语义）。
- 验收：1280 与 1024 两档宽度下逐页无横向滚动；aside 抽屉可开可关可 Esc。

## 5. 不改（红线）

- 不引入证书链/联网信任、不自动信任发布者、验签失败不放行。
- 贡献级停用不改变 HITL、权限上限、工具默认关闭；无批量启停。
- 暗色只改视觉 token，不改交互与文案；不引第三方主题库。
- 窄窗只改布局与可见性，不改数据与路由。

## 6. 四轨（文件级不重叠）

- **T1**（filepatch）：`lib/plugins/{manifest,store,signature.ts,index}.ts` + `scripts/sign-plugin.mjs` + 测试。
- **T2**（rollout）：`components/PluginsPage.tsx` + `components/plugins/**`（签名状态/发布者信任勾选、贡献级开关、部分停用徽标）+ 测试。
- **T3**（baseline）：`packages/web/tailwind.config.js`、`src/index.css`、`src/lib/theme.ts`、`src/main.tsx`、`src/pet.tsx`、`components/settings/ThemeModeCard.tsx`、`components/SettingsPage.tsx` + 测试。
- **T4**（hotpath）：`src/App.tsx`、`src/lib/viewport.ts`、`components/layout/PageShell.tsx` + `App.test.tsx` 增量 + 测试。
- Lead：规格、文档、版本、门禁、安装包、部署、证据、提交。

## 7. 验收

- 四轨定向用例全绿；`tsc --noEmit` 0；`pnpm -r build` 通过。
- 发布前全量门禁（逐包，允许单包重试一次）：shared / server / web / desktop。
- 真机（部署后）：暗色切换逐页巡检截图；1024/1280 两档布局；签名插件安装（有效/被改签名拒绝）、发布者首次信任与换钥复核；贡献级停用四类各自生效且主开关语义不变。
- 文档与部署/安装包/更新源证据回填。
