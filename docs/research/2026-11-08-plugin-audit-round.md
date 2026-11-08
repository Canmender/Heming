# 插件/技能社区对抗审计（d.111，只读）

> 审计时点：`3c977a8`（d.109）；期间并行提交 `c640bf9`/`5028f79`；**结论已按当时 HEAD 复核**。
> 结论：2 个 P0 + 8 个 P1 + 10 个 P2。**除 P1-1（正式公钥未就位，需发布方提供密钥）外，全部已在
> `d.111.3.43.0` 修复**（提交见 CHANGELOG；`packageSha256` 最终实现为 `files/**` 的确定性内容摘要，
> 与本文 P0-1 建议的「绑 files」一致，比「整包 tgz 哈希」更可落地）。
> 本文保留审计原文，便于复核修复是否覆盖到位；行号以审计时点为准，当前代码可能已移动。

# d.110 对抗性审计（只读）：插件体系 d.107–d.109 + 技能社区

- **基线**：审计起点 `3c977a8`（d.109.2.42.0）；审计期间并行会话提交了 `c640bf9`（技能社区 SSRF 防护）与 `5028f79`（d.110 社区技能批量更新 + 插件孤儿诊断），当前 HEAD = `5028f79`。**关键结论已按当前 HEAD 复核**；技能社区的 SSRF/缓存/重定向部分读的就是 c640bf9 之后的代码，其余文件（store/signature/plugin-package/app.ts/pluginCatalog）在两次提交中未变。本审计只读，未改任何文件、未 commit。
- **方法**：静态阅读（按危害排序逐条追调用链）+ 交叉核对测试与注释里的承诺；**未运行测试套件**，所有结论均为代码路径推导，行号基于该 HEAD。
- **约定**：`P0` = 数据丢失 / 安全绕过 / 崩溃；`P1` = 明显错误或体验断裂；`P2` = 小问题/加固建议。带 ★ 的是我认为**上线前必须处理**的。

---

## 0. 结论先行

- **P0 共 2 条**：①界面插件首方签名**只覆盖 `plugin.json`，不覆盖 `files/**` 代码字节**，配合本地安装不校验 sha256 → 可"签名有效但代码被换"；②卸载路径**没有事务/回滚**，写失败会留下半卸载。
- **P1 共 8 条**，其中 ★3 条建议首发前修：正式公钥未就位（打包版所有界面插件装不上）、已发布版本的 `package.tgz` 可被覆盖（与"版本不可变"矛盾）、插件总开关/贡献级停用写失败被吞（重启回弹）。
- 好的部分也确认了：安装事务的快照/读回校验/回滚报告设计是扎实的（§3）；zip 解包与 SSRF 防线在本轮代码里是认真写的（§4）；bundle 的 CSP 与导航闸收口到位（§5）。

---

## 1. P0 清单

### P0-1 ★ 界面插件签名不覆盖代码字节 → 本地安装可"借壳"过验签（安全绕过）

**证据链**
- 验签输入只有清单文本：`packages/desktop/plugin-signature.js:379` `const data = Buffer.from(canonicalManifestText(manifest), "utf8")`；签名覆盖字段见同文件 `:21-28`（`id/version/name/description/author/publisher/permissions/contributions`），**没有任何 `files/**` 的哈希**。
- 安装器只验清单、只检查 entry 路径存在，不校验文件内容：`packages/desktop/plugin-package.js:399-414`（验签失败才拒绝）、`:418-437`（`paths.has(widget.entry)` 仅判断存在）；`readPackage` 原样返回 `files` 字节（`:441`）。
- 本地安装不传任何指纹：`packages/desktop/main.js:1214-1227` `widgetStore.install({ bytes })`——**没有 `expectedSha256`**；云端路径才带（`packages/web/src/components/PluginInstallDialog.tsx:134-136`、`packages/web/src/lib/widgets/store.ts:221-236`）。

**触发（复现思路）**
1. 取官方 `heming.pet` 的 `plugin.json`（含合法 `signature`）与其 `files/` 目录；
2. 保留 `plugin.json`（不改一字节），把 `files/index.html` 或它引用的 JS 换成任意脚本，打回 `package.tgz`；
3. 走「插件区 → 桌面小组件 → 导入本地文件」（`main.js:1214`）安装：验签通过、entry 存在、安装成功。
4. UI 与 changelog 的承诺是"来源不明的包会被拒绝/必须通过官方签名"（`plugin-package.js:22-28` 注释、`d.107` 更新说明），实际只验证了清单。

**影响**：攻击者脚本获得 `widget://<id>/` origin 与 `__heming_widget` 桥（`packages/desktop/widget-preload.js:30-92`：通知、`openPage`、读写设置、`chatConfig` 等）。爆炸半径被 CSP/导航闸限制在该 origin（见 §5），但"签名=整包可信"的承诺不成立。

**修法（择一或叠加）**
- 清单里增加 `files: [{path, sha256}]` 并纳入签名文本（推荐；发布脚本 `scripts/pack-plugin.mjs` 已在算整包 sha256，改造成本可控）；
- 或对 `package.tgz` 整体签名/签名清单外再签一个 `checksums.json`；
- `widgets:installFromFile` 至少把"本地来源、无指纹"显式告知用户（当前 record 只有 `packageSha256`，无来源字段），并考虑要求本地包同样来自目录（用目录 sha 固定）。

---

### P0-2 卸载没有事务：写失败会留下半卸载（数据丢失不可逆）

**证据链**
- `packages/web/src/lib/plugins/store.ts:1825-1836`：`remove(id)` 先逐个 `this.skills.remove(skillId)`、再 `this.mcp.remove(serverId)`、再改内存 `this.data.plugins`，最后才 `this.saveOrThrow()`；**全程没有 `snapshotTransactionKeys()` / `rollbackTransaction()`**。
- `skills.remove` 的落盘是吞异常的：`packages/web/src/lib/skills/store.ts:227-233`（`this.save(); this.saveBindings();`；`save()` 最终走 `write()` 的 `try/catch` 吞掉异常，见 `skills/store.ts:439-446, 518-526`）。
- 对比：安装路径有完整事务（`store.ts:1313` 快照、`:1473-1481` 回滚、`:1689-1776` 实现），注释明确"关键路径用 saveOrThrow"（`:1852-1866`）——卸载没享受同一待遇。

**触发**：存储配额紧张 / 隐私模式 / `mcp.remove` 抛错，使 `saveOrThrow` 在技能已删后失败。结果：**技能与绑定/使用统计已从存储删除，插件记录仍在**；重载后插件 `skillIds` 变成悬空引用，用户数据无法恢复（技能区也不会再显示这些技能）。

**补充**：d.110 新增的 `detectUnitOrphans` 只做**只读检测/提示**（`packages/web/src/lib/units/projection.ts:323-380`：技能看 `pluginId`、服务看 `plugin:<id>:` 前缀，返回清单不删任何东西），能缓解"悬空引用无感知"，但**不能恢复已删数据**，不替代卸载事务。

**修法**：卸载包进同一套事务（`PLUGIN_TXN_KEYS` 已包含 `SKILLS_KEY/SKILL_BINDINGS_KEY/SKILL_ASSIGNMENTS_KEY/MCP_*`），失败走 `rollbackTransaction` 并如实报 `rollback.ok`；`remove()` 返回 `InstallApplyResult` 类似结构而不是 `void`。

---

## 2. P1 清单

### P1-1 ★ 正式公钥未就位：打包版会拒绝所有界面插件
- `packages/desktop/resources/official-keys.json:5` 目前只有 `dev-test-2026-11` 一把开发钥；文件头注释写着"上线前必须替换为正式公钥"。
- 生产开关按"表里没有非 dev 键就失败关闭"：`plugin-signature.js:366-377`（`!loaded.hasProductionKey && !allowDevKeys` → 拒绝）；`main.js:38-39` 只在 `!app.isPackaged` 时注入 `HEMING_ALLOW_DEV_PLUGIN_KEYS=1`。
- **后果**：正式安装包里装任何界面插件（含桌宠）都会返回"首方公钥表里只有开发调试公钥"。这是**发布阻断**，且 CI 的 30 例测试用的是 `dev-test` fixture，测不出来。
- 修：换正式公钥 + 加一条"打包产物冒烟"（对打包后的 `app.asar` 内 `official-keys.json` 断言存在 `official-*` 键）。

### P1-2 ★ 已发布版本的 `package.tgz` 可被静默覆盖（与"版本不可变"矛盾）
- 清单发布有不可变保护：同 id+版本内容不同 → 409（`packages/server/src/app.ts:201-236`，注释引 N15/MCP Registry）。
- 包发布没有：`packages/server/src/pluginCatalog.ts:340-353` 直接 `rename` 覆盖 `package.tgz`，只返回 `created: !existsSync(targetFile)`，**不比较已有 sha**；`app.ts:280-300` 也不检查。
- 后果：同版本代码字节可变；客户端目录/响应头 sha 缓存（`catalogClient.ts:132,186`）与"版本不可变"假设失效，审计/复现困难。修：同版本已有包且 sha 不同 → 409，与清单同策略。

### P1-3 ★ 插件总开关 / 贡献级停用写失败被吞（重启回弹）
- `store.ts:1766-1793` `setEnabled` 末尾 `this.save();`（吞异常）；`store.ts:1795-1816` `setKindEnabled` 同样 `this.save();`（`:1816`）。
- 这两个是用户显式操作，无失败提示；配额满/隐私模式下 UI 显示已停用、重载后恢复原状。修：改 `saveOrThrow` + 失败 toast（与安装路径一致）。

### P1-4 社区技能详情页 `homepage` 直出 `<a href>`，无协议白名单（XSS，需点击）
- 渲染：`packages/web/src/components/skills/SkillHubPanel.tsx:414-421` `href={detail.homepage}`、`target="_blank"`。
- 服务端只做长度截断：`packages/server/src/skillHub.ts:165` `homepage = text(raw.homepage, 500)`——没有协议校验（`checkDownloadUrl` 只用于下载地址，不用于 homepage）。
- 注意：`MarkdownMessage` 里的链接是安全的（react-markdown v10 默认 `defaultUrlTransform` 会过滤危险协议，`packages/web/node_modules/react-markdown/lib/index.js:320, 421`），风险只在这条**直出**的 homepage。
- React 19 只对 form action 做 `sanitizeURL`（`packages/web/node_modules/react-dom/cjs/react-dom-client.development.js:3348-3350, 20723`），**不会拦 `<a href="javascript:…">`**；上游数据可由发布者填写。
- 修：客户端 + 服务端都按 `new URL()` 白名单 `http/https`（复用 `checkDownloadUrl` 的协议部分），非法值不渲染链接。

### P1-5 技能社区 `register` 无鉴权、无本地限流
- `packages/server/src/skillHub.ts:731-780`（`POST /api/auth/register` 路由在 `:814`）对任何调用者开放：只校验名字正则，直接向上游建号并把 `api_key` 回给调用方。
- 本机服务若被网页跨站 POST（无 CORS 读取也能触发写），或脚本批量调用 → 用他人上游额度/制造垃圾账号；本地只在上游 429 时才限流。
- 修：本地令牌/同源校验（`Origin`/自定义头）+ 简单速率限制（每 IP/每会话 N 次）；仅在桌面端启用注册。

### P1-6 市场"兼容"过滤与客户端判定口径不一致（展示可装、装时被拒）
- 服务端/共享过滤：`packages/shared/src/plugin/market.ts:198-201` `isVersionCompatible` 只比较版本；`engines` 非法时 `compareHemingVersion` 把非法值当最小（`version.ts:100-110`）→ 判"兼容"。
- 客户端：`packages/web/src/lib/plugins/manifest.ts:1590-1605` 对非法 `engines` 返回 `invalidEngines`（失败关闭）并阻断安装。
- 后果：坏清单在市场里显示"可安装"，点安装才报错。修：`filterMarketByHostVersion` 先 `parseHemingVersion` 校验 engines，非法条目直接剔除或标 `invalid`。

### P1-7 损坏的 v5 记录被静默降级为 v4（兼容性失败打开）
- `store.ts:818-832` `parseStoredManifest`：v5 解析失败时 `parsePluginManifest({...record, schemaVersion: 4})` 再 `schemaVersion: 5` 回填；v4 解析不产出 `engines` → `pluginEnginesStatus` 落到"旧包=不限制"（`manifest.ts:1593-1604`）。
- 后果：本该判"engines 非法/需更新"的坏记录变成"兼容"，与 v5 `engines` 必填、失败关闭的规格相悖。修：降级读取时保留 `enginesStatus = invalid` 标记（或在 UI 标红"记录损坏，请重装"），不要复用 v4 的"不限制"语义。

### P1-8 技能池硬上限与安装体积预检口径不一致 → 装插件可静默淘汰技能
- 安装预检按 `INSTALL_WRITE_BUDGET_BYTES = 0.8 × DEFAULT_QUOTA_BYTES`（≈4MB）判超限（`store.ts:72-76, 1633-1646`）。
- 但技能池另有独立硬上限 `MAX_POOL_CHARS = 1_200_000`（`packages/web/src/lib/skills/types.ts:69`）：`evictToQuota()` 一旦超限就按最久未使用**静默删除技能（含内置/用户技能）并清理绑定**（`skills/store.ts:518-526, 531-552`），无提示、无回滚报告；且内置技能删除后**不会复活**（`seeded: true` 守卫，`skills/store.ts:33-40, 147-152`，注释明言「删除后不再复活」）。
- 触发：当前技能池接近 1.2MB 时安装一个含较多/较大 `skills` 的插件；预检算的是 4MB 预算 → 通过；实际写入触发淘汰，可能把**这次要装的技能或用户已有技能**删掉，插件记录里的 `skillIds` 随后出现悬空引用。
- 修：预检把"技能池写后是否超 MAX_POOL_CHARS"也算进去并阻断；或淘汰时返回被删清单并在安装结果里显式提示/进回滚。

---

## 3. 事务/半装：验证过 OK 的部分（避免误伤）

- `applyPlan` 在写任何键前 `snapshotTransactionKeys()`（`store.ts:1313`，键集 `PLUGIN_TXN_KEYS` `:85-93`），失败逐键恢复 + 三个单例 `reload()`（`:1724-1776`），失败如实 `rollback.ok=false`（`:1474-1481`）。
- 技能/MCP 的 `save()` 吞异常由"读回校验"兜住：`assertKeyChanged`（`:1707-1722`）在 `diffTouchedSkills/servers` 时比对快照字节，不一致即抛 → 回滚。
- `previous` / `highestVersion` 是**随插件记录一次性写入**的（`store.ts:1439-1457` 构造 record、`:1458` 单次 `saveOrThrow`），不存在"先写 previous 再失败"的中间态；`previous` 体积上限在 `buildPrevious`（`:1546-1575`）先算后写。
- 计划过期有守卫：`stale` 比对 live 指纹（`:1286-1301`）。
- 仅发现一个并发缺口（P2）：stale 只比指纹，另一标签页改 `enabled/disabledKinds` 不会被发现，后写覆盖前写（`:1306-1310` 用计划里的 `existing.enabled`）。

---

## 4. 技能社区（服务端）：SSRF / zip / Key

**确认做得好的**
- 下载地址：`redirect: "manual"` + 每跳复检 + 最多 3 跳（`skillHub.ts:319-390`）；`checkDownloadUrl`（`:279-317`）拒非 https、账号信息、回环/私网/链路本地/元数据地址，IPv4/IPv6（含 IPv4-mapped、fc00::/7、fe80::/10）都判；注释如实写明残余面"DNS 重绑定需出口防火墙兜底"。
- zip：总 5MB、单条 1MB、200 条、总量 16MB、`inflateRawSync({maxOutputLength})`、拒 ZIP64/加密/未知方法、路径归一化拒 `..`/绝对路径/盘符/NUL（`packages/server/src/zip.ts:20-40, 118-206`）。
- Key：只从请求头取（`skillHub.ts:613-615`），不落库、不进 URL、缓存只放公开只读接口（`:447-452`）；web 侧优先系统加密桥、明文兜底有明确 UI 提示（`packages/web/src/lib/skills/hubClient.ts:266-292`；`SkillHubPanel.tsx:145-147, 209-217`）。未发现 Key 进日志/DOM 的路径（`console.*` 在该文件为 0 处）。

**遗留风险（P2 级，列在后文）**：zip 重复条目不合并、不校验 CRC；注册接口滥用（P1-5）；homepage 协议（P1-4）。

---

## 5. 界面插件窗口 / CSP / 协议

- 导航闸与 `window.open` 拒绝：`packages/desktop/plugin-host.js:379-397`；`widget:*` IPC 按 `fromWebContents` 反查 runtime、查不到拒绝（同文件 `:31-33` 注释 + 实现）。
- `widget://` 协议：`resolveAssetPath` 做 root 包含判定、拒非法百分号编码（`app-protocol.js:55-68`）；`resolveWidgetRequest` 不做 SPA 回落、不允许越出版本目录（`:313-320`）。
- CSP：主窗禁 `unsafe-inline`/`unsafe-eval`（`app-protocol.js:167-207`）；widget 侧 `connect-src` 只继承"回环 + 清单 network"、`eval` 仅在 `permissions.eval: true` 时放开、`frame-src 'none'`、`form-action 'none'`、`base-uri 'none'`（`:258-300`）。
- tar 只接受普通文件/目录，拒符号链接/硬链接/设备（`packages/desktop/plugin-tar.js:13-15, 135-150`）→ 解包不出符号链接，`resolveAssetPath` 的字符串前缀判定够用。

---

## 6. P2 清单（简短）

1. **SVG 同源直发**：`pluginMarket.ts:35-41` 以 `image/svg+xml` 返回资源；`<img>` 不执行脚本，但用户在标签页直接打开该 URL 可在同源执行。建议 `Content-Disposition: attachment` 或禁 svg。
2. **zip 重复条目不去重**：`zip.ts:206` 直接 `push`；当前消费者只取 `SKILL.md` + 文件清单，影响小，但建议按 path 去重（首条或末条）并记录 warning。
3. **Windows 保留名/尾点**：`shared/src/pluginCatalog.ts:17-18` 的 id/version 正则允许 `con`、`a..` 这类值，`join(dir,id,version)` 落盘可能异常（Windows 设备名）。
4. **zip 不校验 CRC**（`zip.ts:1-20` 注释自述）：损坏包只在 `SKILL.md` 解析阶段暴露，错误文案可能不精确。
5. **发布密钥比较非常量时间**：`app.ts:167-170`（`given.length === publishKey.length && given === publishKey`）；本地/内网风险低。
6. **界面插件安装记录无来源字段**：record 只有 `packageSha256`（`plugin-store.js` installed.json 结构注释），审计时分不清"云端/本地导入"。
7. **市场请求无超时**：`marketClient.ts:79` 等处 `fetch` 未带 `AbortSignal`；服务器挂起时 UI 依赖浏览器默认超时（`MarketView.tsx:218-230` 有 fallback 回调，但 loading 可能很久）。
8. **`widgets:install` 的 `payload.bytes` 无大小上限**（`main.js:1206-1212`）：大包由 `readPackage`/`plugin-tar` 上限兜底，但 IPC 层先收进内存；建议 IPC 层就限 40MB。
9. **`handleDownload` 返回 `zipSha256` 但 web 侧未使用**：`skillHub.ts:718-730` 计算了 `zipSha256`，`hubClient` 下载后未与任何目录比对（本地无固定值可对，聊胜于无）。
10. **`register` 回传的 `api_key` 直接进状态并落本机**（`SkillHubPanel.tsx:166-169`）：UI 已提示，但建议"创建账号"后强制用户确认再保存（当前是自动保存）。

---

## 7. 覆盖范围与未覆盖（诚实边界）

- **未运行测试**；未做动态验证（不构造恶意包、不打真实网络）。所有 P0/P1 都可用单测/手工复现，但需要拿测试夹具造包（`packages/desktop/plugin-signature.test.js` 的 FIXTURE 可直接复用造"签名有效、文件被换"的样本）。
- **未逐行覆盖**：`plugin-window.js` 的 `webPreferences` 实际值（本轮只从 `plugin-host.js` 的导航闸/收口反推，未读 `widgetWindowOptions` 定义）；`plugin-host.js` 全部 IPC handler；`app.ts` 其余路由与中间件顺序；浏览器端（无桌面桥）每个组件的降级路径（只确认 `widgetsAvailable()` 门禁与 `installWidgetFromBytes` 的"仅桌面端可用"）。建议下一轮补这三块。
- **合规**：只读审计，未修改 `D:/Heming`、未 commit；`git status` 中的并行会话改动未触碰。

---

## 8. 最值得先修的 3 条（给 lead）

1. **P0-1 签名覆盖代码字节**（安全承诺不成立；配合 P1-2 的包可覆盖问题一起修，形成"清单+代码+包"三层绑定）。
2. **P1-1 正式公钥**（否则打包版界面插件全拒，属发布阻断；顺手加打包冒烟）。
3. **P0-2 卸载事务**（唯一会不可逆丢用户数据的路径；复用现成事务设施，改动小）。
