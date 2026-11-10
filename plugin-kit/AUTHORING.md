# 和鸣插件编写标准（PLUGIN-AUTHORING）

> 这份文件是**操作标准**：从零到发布怎么做、每条命令干什么、提交前逐条过什么。
> 契约与语义见 [STANDARD.md](STANDARD.md)（字段为什么这样、宿主怎么强制）；
> 场景菜谱见 [COOKBOOK.md](COOKBOOK.md)，卡住时查 [FAQ.md](FAQ.md)；实现细节与红线见 [../docs/PLUGINS.md](../docs/PLUGINS.md)。
> 三者冲突时以 `parsePluginManifestV5()` 的代码为准。
>
> 现行：声明式插件 `schemaVersion: 5`；界面插件 `schemaVersion: 4` + `distribution: "bundle"`（仅首方）。

---

## 0. 从哪份示例抄

| 你的需求 | 抄这份 | 形态 |
|---|---|---|
| 只要「会做某件事」 | [`examples/01-hello-skill/`](examples/01-hello-skill/) | v5 声明式 |
| 要查外部/本机服务、要快捷入口 | [`examples/02-mcp-and-commands/`](examples/02-mcp-and-commands/) | v5 声明式 |
| 只想加命令跳转（页面/设置/单元/插件/技能） | [`examples/03-commands/`](examples/03-commands/) | v5 声明式 |
| 想在左侧导航多一个插件页面（导航入口） | [`examples/05-plugin-page/`](examples/05-plugin-page/) | v5 声明式 |
| 要做桌面窗口（仅首方） | [`examples/04-widget-bundle/`](examples/04-widget-bundle/) | v4 bundle |
| 想看校验怎么报错 | [`examples/_invalid/demo-bad/`](examples/_invalid/demo-bad/)、[`examples/_invalid/page-entry-on-declarative/`](examples/_invalid/page-entry-on-declarative/)（别抄） | 故意非法 |

所有合法示例都能过 `pnpm plugin:lint`；`_invalid` 由 `plugin:check` 默认跳过。

---

## 1. 三条命令开始

```bash
# ① 生成骨架（含 plugin.json / README，自动跑一次校验）
pnpm plugin:new acme.hello --name 问候工具

# ② 校验（与安装预览同一个权威解析器；--strict 让 warning 也失败）
pnpm plugin:lint                 # 批量校验 plugin-kit/plugins 与 plugin-kit/examples
node scripts/plugin-lint.mjs plugin-kit/plugins/hello/plugin.json --strict

# ③ 在应用里试装：插件区 → 安装 → 选文件/粘贴 plugin.json → 先看预览，再点安装
```

生成后的目录（声明式）：

```
plugin-kit/plugins/hello/
├── plugin.json       # 清单（唯一必填产物）
└── README.md         # 说明：装了什么、要什么权限、数据放哪
```

界面插件（`--kind bundle`）的包根**只能有 `plugin.json` + `files/**`**（`pack-plugin` 会拒绝其它根文件），
所以脚手架把 README 放进 `files/README.md`：

```
plugin-kit/plugins/demo-widget/
├── plugin.json
└── files/
    ├── index.html    # entry
    ├── app.js        # 外置脚本（CSP script-src 只放 'self'，不要写内联脚本）
    └── README.md
```

> **打包前把临时文件移出包根**：作者习惯在包根放 README/截图/草稿，但 `pack-plugin`
> 与安装端都只接受「`plugin.json` + `files/**`」这两类根内容，混进 README 之类会直接
> 拒绝（入口 `entry` 找不到只是其中一种表现）。正确做法是把作者说明放到 `files/README.md`
> （会随包分发），或打包前挪到包根**之外**（如 `dist/README.md`）再跑 `pack-plugin`。

没有 MCP 服务时可以整段省略 `permissions`；合法最小清单见 [STANDARD.md §9.A](STANDARD.md)。

---

## 2. 先定五个字段

| 字段 | 怎么定 | 常见错法 |
|---|---|---|
| `id` | 反向域名或 `作者.能力`，小写，`^[a-z0-9][a-z0-9._-]{0,63}$`，**发布后不改** | 大写/空格/中文；改 id 后用户看到两个插件 |
| `version` | semver 风格（`1.2.3`），**内容变了就升** | 同版本改内容再发布（服务端 409 拒绝） |
| `engines.heming` | 只写**真正需要的最低宿主版本**，如 `d.117`；不要写 `d.119.3.47.0` 这种过细版本 | 写 semver range（`^`/`~`）——不支持 |
| `meta` | 图标用 https URL；分类/标签/关键词 ≤ 上限；详情 ≤16KB 或包内 `.md` | `data:` 内联大图（占本机配额）；`homepage` 用 http |
| `permissions` | 最小化：只写实际要用的 host / 风险上限 / 事件 | 服务 host 没写进 `network`（直接装不上） |

---

## 3. 贡献点菜谱

### 3.1 最小技能包（最常见）

```json
{
  "schemaVersion": 5,
  "id": "acme.hello",
  "name": "问候工具",
  "version": "1.0.0",
  "engines": { "heming": "d.117" },
  "contributions": {
    "skills": [
      {
        "name": "写问候",
        "description": "按场合生成得体的问候语",
        "instructions": "先问清对象与场合（正式/熟人/节日），再给 1–3 条候选，不要堆形容词。",
        "triggers": ["问候", "寒暄"],
        "tags": ["写作"]
      }
    ]
  }
}
```

`instructions` 是给模型的正文：写**步骤与边界**，不写营销话术；触发词是召回线索，宁少勿滥。

### 3.2 技能 + 远程 MCP

```json
"permissions": { "network": ["mcp.acme.com"], "tools": "read" },
"contributions": {
  "skills": [{ "name": "查订单", "instructions": "…" }],
  "mcpServers": [{ "key": "orders", "name": "订单服务", "url": "https://mcp.acme.com/mcp" }]
}
```

- 服务 URL 只 https；本机调试可用 `http://127.0.0.1:<port>/mcp`。
- **每个服务 host 必须出现在 `permissions.network`**（默认端口可省略）。
- 装完不会自动连接、工具默认关闭；`tools: "read"` 时写工具不会注入给模型（执行期强制）。
- 写操作仍逐次人工确认（HITL），权限上限只收紧、不放宽。

### 3.3 命令 + 工具束

```json
"contributions": {
  "skills": [{ "name": "生成周报", "instructions": "…" }],
  "commands": [
    {
      "id": "weekly-report",
      "title": "生成周报",
      "keywords": ["周报", "weekly"],
      "target": { "kind": "skill", "name": "生成周报" }
    }
  ],
  "toolPacks": [
    { "id": "orders-tools", "name": "订单工具", "tools": ["orders_search", "orders_get"] }
  ]
}
```

- `commands[].target.kind: "skill"` 的 `name` **必须是本插件 skills 里的名字**，否则解析失败。
- `target` 其他取值：`page`（页面 id）、`plugin`、`settings`（设置卡 id）、`unit`（能力单元 id）。
- `toolPacks` 只声明归属、不改开关；工具名**不得跨束重复**。

### 3.4 界面插件（bundle，仅首方）

第三方不开放 bundle（安全红线，见 [STANDARD.md §6.4](STANDARD.md)）。首方流程：

1. 用 `--kind bundle` 生成骨架：`pnpm plugin:new heming.demo --kind bundle`（生成 `files/index.html` + `files/app.js` + `files/README.md`）。
2. 清单：`schemaVersion: 4` + `distribution: "bundle"`；**`packageSha256` 不手写**——由打包/签名脚本写入。
3. 开发时用 `window.__heming_widget`（类型见 `packages/shared/src/plugin/widget.ts` 的 `HemingWidgetApi`）；偏好走 `settings()`，
   业务数据走 `data*`，**不要**用 localStorage（独立 origin 下不可靠）与密钥。
4. 发布顺序（实测口径）：`node scripts/plugin-lint.mjs <包目录>`（打包前模式，允许缺 `packageSha256`）
   → `node scripts/sign-plugin.mjs sign <包根>/plugin.json <私钥> --id heming --write`（写入源清单的 `packageSha256`）
   → `node scripts/pack-plugin.mjs <包根>`（在产物里重算摘要并按**安装口径**回读，`readPackage ✓` 才算可发布）。
   先 pack 后 sign 会被 `readPackage` 拒绝（缺签名），这是预期顺序。
5. 发版前跑 `node scripts/check-release-keys.mjs`（正式版不认 dev 公钥）。

参考实现：`plugin-kit/plugins/pet-widget`（官方桌宠）。

### 3.5 给插件加一个页面（导航里多一个入口，d.124）

装好插件 → 左侧导航**末位**（模块入口之后）多一项 → 点进去是插件自己的页面。每插件最多一个页面。

先选形态：

| 形态 | 清单里写什么 | 能不能带代码 | 谁能用 / 在哪看得见 |
|---|---|---|---|
| **声明式页**（默认，推荐） | `contributions.page.blocks`（受控块） | 不能（宿主渲染，全部纯文本转义） | 任何作者；安装版 + 浏览器版都能看 |
| **自带页**（仅首方 bundle） | `contributions.page.entry`（包内 `.html`） | 能（`widget://` 沙箱里跑，必须首方签名） | 仅首方；只在安装版显示（浏览器版给降级说明） |

声明式最小示例（`engines.heming` 至少 `d.124`，旧版宿主不认识 `page`）：

```json
{
  "schemaVersion": 5,
  "id": "acme.collector",
  "name": "采集桥",
  "version": "1.0.0",
  "engines": { "heming": "d.124" },
  "contributions": {
    "skills": [{ "name": "采集状态", "instructions": "汇总各来源的采集结果，缺数据就直说。" }],
    "page": {
      "title": "采集桥",
      "icon": "activity",
      "summary": "本机采集服务状态与用法",
      "blocks": [
        { "type": "markdown", "title": "怎么用", "text": "在设置里填来源，然后点「开始同步」。" },
        { "type": "stats", "items": [{ "label": "已采集", "value": "128 条" }] },
        { "type": "table", "columns": ["来源", "状态"], "rows": [["QQ", "就绪"], ["微信", "未连接"]] },
        { "type": "list", "items": [{ "title": "开始同步", "description": "调用插件命令", "badge": "命令" }] },
        { "type": "actions", "items": [{ "label": "打开插件区", "target": { "kind": "page", "page": "plugins" } }] },
        { "type": "contributions", "kind": "skills" }
      ]
    }
  }
}
```

块怎么选（全部纯文本，宿主转义；未知 `type` 直接报错，不静默丢弃）：

| 想展示 | 用 | 上限 |
|---|---|---|
| 说明 / 用法 | `markdown` | 正文 ≤4000 字，禁原始 HTML |
| 几个数字 | `stats` | ≤8 项，label/value 各 ≤40 字 |
| 对照表 | `table` | ≤6 列 × ≤50 行，单元格 ≤120 字，每行格数 = 列数 |
| 条目列表 | `list` | ≤20 项；标题 ≤60 / 描述 ≤160 / badge ≤12 |
| 跳转按钮 | `actions` | ≤6 项；只做导航，不执行代码 |
| 本插件贡献清单 | `contributions` | `skills` / `mcpServers` / `commands` / `toolPacks` |

注意：

- `blocks` 至少 1 个、最多 12 个；`page` 是对象不是数组（没有多页面/Tab/子路由）。
- 页面**不新增权限、不联网**：它是**静态展示**（清单文本 + 本地贡献清单），宿主不代拉数据；要展示会变化的信息，用技能/命令产出结果，发版时更新清单文本。
- 没有 `page` 贡献的纯能力包照旧不新增导航入口；有 `page` 的才多一项，入口固定在模块入口之后、不受插件加载顺序影响。
- 想改成首方 bundle 自带页：按 §3.4 的清单格式，把 `page` 换成 `{ "title": "…", "entry": "files/page.html" }`，`entry` 必须出现在 `files` 里；页面与桌面小组件可并存。可抄 [`examples/05-plugin-page/README.md`](examples/05-plugin-page/README.md) 的改法说明。

---

## 4. 权限最小化（评审必看）

| 声明 | 问自己 | 不合格的样子 |
|---|---|---|
| `network` | 每个 host 都真的会连吗？能省端口吗？ | 把 `https://api.acme.com/v1` 写进去（只能写 host:port） |
| `tools` | 只读够不够？ | 无脑写 `write`（模型手上多一批可写工具） |
| `files` | 真的需要携包文件吗？（当前只展示） | 列一堆用不上的路径 |
| `events` | 需要哪些事件？ | 全声明（`theme`/`tray` 会真的投递，用户按声明判断风险） |
| `chat`（bundle） | 需要调本机模型网关吗？ | 声明了但代码不调用；注意人设提示词永不下发 |
| `eval`（bundle） | 真的需要 eval 吗？ | 为了某个库随手开（CSP 会放开 `'unsafe-eval'`） |

**空声明也是声明**：用户看到的是这份清单，不是你的代码。

---

## 5. 版本与兼容

- 插件版本 `version` 管更新；**同版本内容不可变**（服务端 409）。
- 兼容性写 `engines.heming`：只写最低宿主版本；写高了自己把用户挡在门外。
- 破坏性改字段形状（例如改变某个贡献的含义）→ 在宿主侧要新开 `schemaVersion`；插件作者按新格式重新发版，
  **旧包保持能装**。
- 新版本若扩大权限，用户会被要求重新确认；想避免骚扰就别顺手加权限。
- 防降级：默认拒绝安装比已装版本更旧的包。

---

## 6. 校验与调试

| 手段 | 命令/位置 | 用途 |
|---|---|---|
| 权威校验 | `pnpm plugin:lint` / `node scripts/plugin-lint.mjs <file\|dir> [--strict] [--json]` | 中文报错 + 字段路径，CI 可挡坏包 |
| 编辑器补全 | `plugin.json` 里 `"$schema": "../../plugin.schema.json"`（从 `plugin-kit/plugins/<包>/` 相对到 kit） | 字段提示（**不等于**能装） |
| 安装预览 | 插件区 → 安装 → 粘贴/选文件 | 只读差异、冲突、权限、兼容性；不点安装不写盘 |
| 诊断 | 插件详情 →「诊断」 | 为什么没生效：停用/贡献级关/依赖/需更新/签名/超权限/孤儿 |
| 健康检查 | 插件区 → 健康检查 →「修复记录」 | 记录损坏、技能或服务对不上 |

装完不生效的排查顺序：**总开关 → 贡献级开关 → 兼容性（需更新和鸣）→ 签名/信任 → 工具上限（未注入）→ 孤儿记录**。
不要靠猜，诊断区直接写原因。

装了带页面的插件却没多出导航入口：① 插件是否启用（停用即撤入口）；② 宿主版本是否 ≥ `d.124`（`page` 是 d.124 增补）；
③ 清单里是否真的写了 `contributions.page`（纯能力包照旧没有入口）；④ 浏览器版只有声明式页，bundle 自带页会显示「只在安装版可用」，不是坏包。

---

## 7. 发布

```bash
pnpm plugin:check                  # shared 构建 + 批量 lint + schema 一致性（CI/发版前）
node scripts/plugin-schema.mjs     # 清单字段变了才需要重新生成编辑器 schema
pnpm plugin:publish -- <plugin.json 或目录> --dest <插件目录>     # 写本地发布目录
HEMING_PLUGIN_PUBLISH_KEY=*** pnpm plugin:publish -- <目录> --push https://heming.example.com  # 推云端仓库
```

- 发布目录布局：`<dir>/<id>/<version>/plugin.json`（原样字节）。
- 市场索引 v2：v5 包才会出现在「市场」页；`hostVersion` 过滤按 `engines` 判定。
- bundle 额外：`pnpm plugin:pack` 打包（确定性 tgz）→ 签名 → 再发布；发版前 `node scripts/check-release-keys.mjs`。

---

## 8. 常见错误 → 修法

| 报错（片段） | 原因 | 修法 |
|---|---|---|
| `schemaVersion 必须是 5` | 清单版本不对 | 声明式包写 `5`；bundle 写 `4` |
| `permissions.network 未覆盖 MCP 服务主机 X` | 服务 host 没写进白名单 | 把 `X` 加进 `network`（默认端口省略） |
| `只支持 https（本机 http 仅限 localhost…）` | MCP URL 用了 http 外网地址 | 换 https，或本机回环调试 |
| `贡献点… 至少一类非空` | `contributions` 全空 | 至少给一个技能/服务/命令/工具束 |
| `技能名重复：与第 N 项同名` | 同清单内重名 | 改名，保持插件内唯一 |
| `工具 X 同时出现在工具束 A 与 B` | 工具归属重复 | 只放在一个束里，或合并束 |
| `命令 target：技能 X 不在本插件 contributions.skills 里` | 指向外部技能 | 命令只能指向本插件自己的技能 |
| `distribution: bundle 只允许 commands + desktopWidgets + page` | bundle 声明了技能/MCP | 拆成声明式包，或删掉越界贡献 |
| `声明式插件的页面必须提供至少 1 个 contributions.page.blocks` | 写了 `page` 但没写块 | 补 1–12 个 `blocks`；自带 HTML 才用 bundle |
| `声明式插件…不能写 contributions.page.entry` | 把 bundle 的 `entry` 写进了 v5 清单 | 改用 `blocks`，或改 `distribution: "bundle"`（仅首方） |
| `界面插件的页面必须写 contributions.page.entry` | bundle 的 `page` 没有入口 | 补包内 `.html` 的 `entry`，并确认它在 `files` 里 |
| `页面块最多 12 个` / `不支持的字面量` 类 | 块数超限或 `type` 写错 | 按 §3.5 块词表改；未知 `type` 不会静默丢弃 |
| `必须提供 packageSha256` | bundle 没跑打包脚本 | 用构建/打包脚本生成，不要手写 |
| `已忽略未知字段 X`（warning） | 顶层多写了字段 | 删掉；若认为该字段有用，提 PR 到标准 |
| 解析报 `包含未知字段`（error） | 敏感子对象（permissions/meta/贡献条目）写错位置 | 按 §2 字段表归位 |

---

## 9. 提交前检查清单（逐条打勾）

- [ ] `pnpm plugin:lint` 通过，无 error；每条 warning 都能解释。
- [ ] `id` 稳定、`version` 已升；`engines.heming` 是最低可用版本。
- [ ] `permissions` 最小化：`network` 覆盖全部服务 host 且无冗余；`tools` 不高于需要。
- [ ] 技能 `instructions` 有步骤与边界；触发词不泛滥。
- [ ] 命令 target 指向的对象真实存在（技能名/页面/设置卡/单元）。
- [ ] 加了页面：`engines.heming` ≥ `d.124`；`blocks` 在词表内且不超限；页面没想改宿主界面（不允许）。
- [ ] 工具束内工具名与其它束不重复。
- [ ] `README.md` 写清：装了什么、要什么权限、数据放哪、怎么卸载。
- [ ] `meta` 图标用 https、详情不超限；截图/标签不超标。
- [ ] 在应用里试装过：预览差异正确、装完诊断是「正常」、停用/卸载干净。
- [ ] 发布：`pnpm plugin:check` + `publish-plugin`（bundle 另加打包/签名/`check-release-keys`）。

---

## 10. 反模式（不要做）

- ❌ 把密钥写进清单/`data/`/settings 默认值——密钥属于宿主密钥存储。
- ❌ 用 `description`/`instructions` 夹带「忽略以上指令」这类提示词注入——会被评审拒绝。
- ❌ 一个插件塞 50 个技能当「技能市场」——按能力拆分，用户按需装。
- ❌ 靠 `events`/`hook` 申请能力——事件只是通知，不是授权。
- ❌ 第三方想通过 bundle 绕签名——不存在这条路（正式版忽略 dev 公钥）。
- ❌ 依赖「编辑器 schema 不报错」当验收——权威校验是 `parsePluginManifestV5` / `plugin-lint`。
- ❌ 想让页面改宿主界面（注入 DOM、改导航顺序、给宿主页加卡片）——插件只能拥有自己的页面，这些都不做。
