# d.124 · 插件页面（页贡献点：声明式宿主渲染 + 界面插件自带页面）

> 用户口径（2026-11-10）：**「我需要安装插件后会导航栏多一个这个插件的入口，点击可以进入查看具体内容」**；
> 插件既要给自己人写，也要给外部第三方用；先写本文档，确认后 A + B 一起做。

## 0. 决策

1. **插件新增第五类贡献点：页面（`page`）**。装好插件 → 导航轨末位多一个入口 → 点进去是该插件自己的页面。
2. **两条渲染路径，同一套页面注册表**：
   - **A · 声明式页面**：清单里写页面内容（`contributions.page`，宿主渲染的受控块），**永不执行代码**，第三方可提交、浏览器与桌面都可用；
   - **B · 插件自带页面**：界面插件（`distribution: "bundle"`）在包里带自己的 HTML/CSS/JS（`contributions.page.entry`），在 `widget://` 独立 origin 沙箱里跑，**主窗内嵌**（桌面端）。本轮仍只对首方签名包开放。
3. **每插件最多一个页面**（`page` 是对象不是数组）。导航入口就是它，页内不提供 Tab。
4. **决策变更记录**：d.70 曾明确「第三方页面贡献不做，只对内置模块开放」；d.98 把「widget 页面贡献（主窗内嵌）」列为 P2 另立规格。本规格就是那份「另立规格」，放开的前提是：声明式页**零代码**、bundle 页**沙箱 + 首方签名**，且插件页**只能拥有自己的页面，不能改宿主界面**（见 §8）。
5. 与 d.122 的口径冲突要写明：d.122 的「纯能力包不会新增导航页」**只对没有 `page` 贡献的旧插件继续成立**；声明了 `page` 的插件才多入口。

## 1. 名词

| 名词 | 含义 |
|---|---|
| 插件页面 | 归属于某个插件的宿主内页面：导航有入口，路由是 `plugin:<pluginId>` |
| 声明式页 | 页面内容写在清单里，由宿主用受控块（markdown / 指标 / 表格 / 列表 / 动作 / 贡献清单）渲染 |
| 自带页 | 界面插件包里的 HTML 入口，由主进程在 `widget://` origin 的沙箱视图里渲染 |
| 页面注册表 | web 侧把「已装且启用的模块页 + 声明式页 + 自带页」投影成导航/路由/命令面板同一份数据 |
| 页面视图 | B 路径里主进程创建、嵌在主窗内容区的 `WebContentsView`（独立 origin，独立 preload） |

## 2. 不变量（任何阶段都不许破）

1. **声明式包永不执行代码**；页面内容只是数据，宿主渲染时全部按纯文本转义，不解析 HTML。
2. **界面插件代码只在沙箱里跑**：`widget://<pluginId>/` 独立 origin、`sandbox: true` / `contextIsolation: true` / `nodeIntegration: false`、preload 只有 `widget-preload.js` 那份白名单桥。
3. **插件只能拥有自己的页面**：不能改宿主现有页面/布局/导航顺序、不能注入宿主 DOM、不能给宿主页加卡片（首页卡/设置卡仍不做）。
4. 页面视图的**导航与开窗一律拒绝**（`will-navigate` / `will-redirect` / `setWindowOpenHandler` / 下载），只能在自己的 origin 内翻页。
5. **能力不因"有页面"而增加**：页面里能调到的宿主能力 = 现有 `__heming_widget` 桥（按清单权限收紧），没有新增的 secrets / files / MCP / 会话桥。
6. 安装/卸载/启停/更新后页面入口**即时生效**（声明式）或**销毁重建**（bundle，d.104 N14 的口径）；卸载即撤入口并清视图，不在内存里留孤儿。
7. 页面 id 不落 `localStorage`（与 `navOrder` 无关）；重启后按已装插件重新投影，顺序稳定。
8. 浏览器版（无桌面桥）**只渲染声明式页**；自带页显示「只在安装版可用」的降级说明，不渲染空壳。

## 3. 清单扩展

### 3.1 声明式（`schemaVersion: 5`，向后兼容增补）

`contributions.page`（可选，对象；不写就没有入口）：

```json
{
  "schemaVersion": 5,
  "id": "acme.collector",
  "name": "采集桥",
  "version": "1.0.0",
  "contributions": {
    "page": {
      "title": "采集桥",
      "icon": "activity",
      "summary": "本机采集服务状态与用法",
      "blocks": [
        { "type": "markdown", "title": "怎么用", "text": "在设置里填来源，然后……" },
        { "type": "stats", "items": [{ "label": "已采集", "value": "128 条" }] },
        { "type": "table", "columns": ["来源", "状态"], "rows": [["QQ", "就绪"]] },
        { "type": "list", "items": [{ "title": "开始同步", "description": "调用插件命令", "badge": "命令" }] },
        { "type": "actions", "items": [{ "label": "打开信息中枢", "target": { "kind": "page", "page": "infohub" } }] },
        { "type": "contributions", "kind": "skills" }
      ]
    },
    "skills": []
  }
}
```

字段与限制：

| 字段 | 类型 | 必填 | 限制 / 语义 |
|---|---|---|---|
| `title` | string | 是 | 1–40 字；导航项与页面标题都用它 |
| `icon` | string | 否 | 宿主图标词表 id（§9），未知值回落默认图标，不报错 |
| `summary` | string | 否 | ≤200 字；页面副标题 |
| `blocks` | Block[] | 是 | 1–12 个；未知 `type` 直接拒绝（严格，**不做静默丢弃**） |

Block 词表（v1，全部纯文本，宿主转义后渲染）：

| type | 字段 | 限制 | 渲染 |
|---|---|---|---|
| `markdown` | `title?`, `text` | text ≤4 000 字 | 复用聊天消息的 markdown 渲染器（禁原始 HTML） |
| `stats` | `title?`, `items[{label,value}]` | ≤8 项，label/value 各 ≤40 字 | 指标卡横排 |
| `table` | `title?`, `columns[]`, `rows[][]` | 列 ≤6，行 ≤50，单元格 ≤120 字 | 只读表格 |
| `list` | `title?`, `items[{title,description?,badge?}]` | ≤20 项，标题 ≤60 / 描述 ≤160 / badge ≤12 | 列表行 |
| `actions` | `title?`, `items[{label,target}]` | ≤6 项；label ≤24 | 按钮；`target` 与命令 target 同形（`page` / `plugin` / `settings` / `unit`），只做导航，不执行任意代码 |
| `contributions` | `kind` | `skills` / `mcpServers` / `commands` / `toolPacks` 之一 | 自动列出本插件的这类贡献（数量 + 名称），空则显示一句空态 |

校验规则（错误中文 + 字段路径，与 v5 现有风格一致）：

- `page` 出现时 `blocks` 不能为空；未知字段按 v5 既有规则（顶层 strip + 警告，`contributions` 内 strict 报错）。
- 声明式页**不引入**任何网络请求：宿主不代拉数据，页面只展示清单文本与本地投影（贡献计数、安装信息）。
- 权限不需要新增：页面不授予任何能力，`permissions` 不变。

### 3.2 界面插件（`schemaVersion: 4` + `distribution: "bundle"`）

`contributions.page`（可选，对象；与 `commands` / `desktopWidgets` 并存）：

```json
{
  "schemaVersion": 4,
  "distribution": "bundle",
  "contributions": {
    "page": { "title": "我的面板", "icon": "layout", "entry": "page/index.html" },
    "commands": []
  },
  "files": ["page/index.html", "page/app.js", "page/style.css"]
}
```

| 字段 | 限制 |
|---|---|
| `title` | 1–40 字 |
| `icon` | 同宿主图标词表 |
| `entry` | 包内相对路径，必须 `.html`、无 `..`/反斜杠/协议前缀、≤200 字符，且**必须出现在 `files`** |

规则：

- 只允许 `bundle` 声明 `page.entry`；声明式（v5）清单出现 `entry` 直接拒绝，提示改用 `blocks`。
- bundle 现在允许的贡献 = `commands` + `desktopWidgets` + `page`；仍**不允许** `skills` / `mcpServers` / `toolPacks`（d.98 的边界不变）。
- `page` 与 `desktopWidgets` 可并存（同一插件既能有浮窗又能有页面），但每类最多 1 个。
- 主进程安装时校验 entry 在包内且能解包；`packageSha256` 继续覆盖 `files/**`，签名即覆盖页面代码字节。

## 4. A · 声明式页面渲染（web）

1. 页面数据来源：`lib/plugins/store.ts` 里已装插件的 `manifest.contributions.page`（安装时已 zod 校验，渲染层不再信任外部输入，仍逐块容错）。
2. 组件：`components/plugins/PluginDeclarativePage.tsx`
   - 页头：图标 + `title` + `summary` + 来源徽标（`声明式插件`）+ 版本；
   - 顺序渲染 blocks；未知/非法块跳过并在开发日志里记一条（生产不白屏）；
   - `actions` 的 `page` target 用现有 `setPage`，`settings` / `plugin` / `unit` 复用命令面板同一套跳转函数（单一真源，不复制白名单）。
3. 空态：`contributions` 块无数据时显示「这个插件还没有声明该类贡献」。
4. 数据只读：页面不提供编辑插件清单的能力（清单在插件页/仓库更新）。

## 5. B · 自带页面运行时（desktop + web）

### 5.1 主进程

- `plugin-host.js` 增加「页面视图」运行时：
  - `widgets:page-mount` `{ id, rect }` → 找已装且启用的 bundle 记录；无 `page` 则拒绝；
  - 创建/复用 `WebContentsView`（`webPreferences`：`preload` 指 `widget-preload.js`、`sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`、`spellcheck: false`），`win.contentView.addChildView(view)`，`setBounds(rect)`；
  - `loadURL("widget://<id>/<entry>")`（协议已在 `app-protocol.js` 注册为 standard + secure，CSP 用 `widgetCspHeaders(record.permissions)`）；
  - `widgets:page-bounds` `{ rect }` → `setBounds`；`widgets:page-unmount` → 移除并销毁，清 map；
  - 主窗 resize / 最小化 / 恢复 / 切到其它页面 / 插件停用 / 卸载 / 更新 → 由 web 侧或主进程对账销毁，**不留孤儿视图**；
  - 导航守卫：`will-navigate` 只允许同 origin；`setWindowOpenHandler` 一律 deny；`will-download` 取消；
  - 视图创建失败（entry 缺失/包损坏）→ 回 `{ ok:false, error }`，web 显示错误态而不是白屏。
- IPC 身份校验：现有 `withRuntime(event)` 按 `sender === win.webContents` 判身份；页面视图要扩成 `sender → runtime` 映射（widget 窗与页面视图都登记），页面视图**不允许**拖拽/托盘/穿透类通道（返回「不适用于页面」）。
- 关闭顺序：主窗关闭时先销毁页面视图再关窗；`app.quit` 前清空所有页面视图。

### 5.2 web

1. `lib/widgets/store.ts` 的 `WidgetRecord` 增加 `page?: WidgetPageSpec`（`widgets:list` 读取并回填，旧记录缺省 undefined）。
2. 路由：`Page` 增加模板字面量类型 `` `plugin:${string}` ``；`App.tsx` 在路由链里加一支 `isPluginPagePage(page)` → `PluginBundlePageHost`。
3. 宿主组件 `components/plugins/PluginBundlePage.tsx`：
   - 一个 `div` 占位（铺满内容区），`ResizeObserver` + `getBoundingClientRect()` 上报 `rect`（DIP，扣除侧栏/标题栏后的内容区坐标）；
   - 挂载 → `page-mount`；尺寸变化 → `page-bounds`；卸载/切页 → `page-unmount`；
   - 无桌面桥（浏览器）→ 降级说明「插件页面只在安装版里可用」；
   - 错误态：主进程返回 error 时显示原因 + 「重建视图」「打开插件详情」两个可执行动作。
4. 主题：页面视图复用 `widget:info` 拿 `theme`，主窗切主题时按现有 `widget:event` 推送（不新增通道）。

### 5.3 坐标口径

`rect` 用主窗 `contentView` 坐标系（CSS px = DIP，缩放按 1 处理；主窗 `zoomFactor` 恒为 1，见 `main.js`）。窗口 DPI 变化/全屏切换由 ResizeObserver 触发重报；主进程对 rect 做边界钳制（宽高 ≥1、超出内容区裁掉）。

## 6. 页面注册表与导航/路由（web，A+B 共用）

新建 `lib/pages/registry.ts`（纯函数，便于单测）：

```ts
export type PluginPageSource = "declarative" | "bundle";

export interface PluginPageEntry {
  pageId: `plugin:${string}`;   // 路由 id
  pluginId: string;
  title: string;
  icon: string;                 // 已归一化到词表
  source: PluginPageSource;
  installedAt: string;
  available: boolean;           // 已装 && 已启用 &&（bundle 还要求桌面桥存在）
}

/** 已装插件 → 页面入口，按「首次安装时间升序，同刻 pluginId 字典序」稳定排序。 */
export function pluginPageEntries(input: {
  plugins: readonly InstalledPlugin[];       // 声明式
  widgets: readonly WidgetRecord[];          // bundle
  desktop: boolean;
}): PluginPageEntry[];

/** 导航追加：模块页之后接插件页，宿主 8 项顺序原样不动。 */
export function withPluginNav(order: readonly NavPage[], entries: readonly PluginPageEntry[]): NavPage[];
```

接线点（全部读同一份投影，禁止各自判断）：

| 位置 | 行为 |
|---|---|
| `NavRail` | `withModuleNav` 之后再 `withPluginNav`；插件页归「能力」组（`navGroupOf` 对 `plugin:` 前缀返回 `capability`） |
| `App.tsx` 路由 | `plugin:` 前缀 → 由注册表反查，未装/停用 → `fallbackPage` 回主页 |
| `store/ui.ts` | `Page` 联合类型加模板字面量；`normalizePage` 对 `plugin:` 前缀放行（是否有效由路由守卫判，**不写进 navOrder**） |
| 命令面板 | 不出「页面跳转」组（v1 明确不做，见 §10） |
| 插件页 | 插件卡/详情显示「页面」贡献行 + 「打开页面」按钮（仅 `available`） |
| 设置区 · 导航说明 | 只读列表追加「已装插件页面」（与模块入口同口径） |
| 快捷键 | 不分配（导航数字键仍只绑 8 个宿主页） |

稳定性口径：导航 = 8 个宿主页 → 模块页（注册表顺序）→ 声明式插件页（`installedAt` 升序）→ bundle 页（`installedAt` 升序）；同一插件升级不改变位置（沿用首次 `installedAt`），卸载后重新安装排到末尾。

## 7. 安装 / 更新 / 卸载

| 场景 | 声明式 | bundle |
|---|---|---|
| 安装预览 | 贡献行多一项「页面 1」 | 同左（`page` 计入预览） |
| 存储 | 不新增键：页面从 `heming.plugins.v1` 的清单派生 | 主进程 `installed.json` 记录增加 `page`；`widgets:list` 暴露 |
| 更新 | 清单替换即生效；当前页按新清单重渲染 | 若 `entry`/`page` 变化或版本更新 → 主进程销毁旧视图，下次进入重建；设置与 `data/` 保留 |
| 停用 | 入口消失（可用性判定），页面不渲染 | 入口消失 + 视图立即销毁 |
| 卸载 | 记录删除 → 入口与路由消失；若正停在该页 → 回主页 | 同左 + 主进程删包目录（现有事务），视图先销毁 |
| 降级 | 沿用现有口径 | 沿用现有口径；页面随包回旧版 |
| 新增权限 | 页面不新增权限，不需要重确认 | 页面**不**新增权限项（CSP 仍按 `permissions.network`），不需要重确认；将来若页面允许联网，按 Chrome 口径「新增权限 → 重新同意」 |

## 8. 安全边界（新增项）

1. 声明式页：禁止任何 HTML/脚本入口（markdown 渲染器沿用聊天侧「禁原始 HTML」配置；链接只允许 `http(s)` 与宿主页面跳转，外链走系统浏览器确认）。
2. 自带页：只能在 `widget://<id>/` 内导航；`frame-src 'none'` 不变（不自嵌外网、不互嵌）；`connect-src` 仍按 `permissions.network` 白名单；`script-src 'self'`；无 `nodeIntegration`；无新增桥方法（除 `widget:info`/`settings`/`data`/`openPage` 这些既有方法，页面场景只读不写窗口几何）。
3. 视图隔离：页面视图的 `webContents.id` 登记进 runtime map；任何 IPC 先按 sender 反查，查不到即拒绝（与 d.98 的收口同一条纪律）。
4. 反冒充：`heming.*` 仍是首方保留命名；bundle 页面只有首方签名包能装（现有 `plugin-package.js` + `official-keys.json`），第三方页面在 v1 只能走声明式（零代码）。
5. 隐私：页面不上传任何数据；声明式页展示的是本机清单数据；自带页的数据读写仍只到 `<userData>/plugins/<id>/data/`（现有单文件 ≤1MB 配额）。

## 9. 图标词表（导航与页头共用）

`lib/pages/icons.ts` 提供固定 20 个图标 id（如 `activity` / `book` / `calendar` / `chart` / `database` / `file` / `globe` / `grid` / `hammer` / `key` / `layers` / `layout` / `link` / `list` / `message` / `package` / `play` / `settings` / `shield` / `terminal`），渲染复用 `components/icons` 的既有线条图标；未知 id → `package` 默认图标（不报错、不空白）。

## 10. 明确不做（本轮）

1. 插件修改宿主现有界面：注入 DOM、替换/隐藏宿主页元素、给宿主页加卡片、改导航顺序/分组/快捷键——**都不做**；插件只拥有自己的页面。
2. 每插件多页面 / 页面内 Tab / 子路由。
3. 命令面板的「插件页面」跳转组（导航入口已够，避免双入口漂移）。
4. 第三方 bundle 页面开放（信任链另立规格：发布者密钥、审核、权限重确认）。
5. 页面内嵌外部网页、iframe、视频、下载。
6. 声明式页的数据绑定/远程请求（页面是静态展示，不代拉数据）。
7. 浏览器版渲染自带页（只给降级说明）。

## 11. 分期与验收

| 阶段 | 内容 | 验收 |
|---|---|---|
| A（本轮） | 清单 `page`（声明式）+ 页面注册表 + 导航/路由 + `PluginDeclarativePage` + 插件页入口 | 装一个带 `page` 的声明式包 → 导航末位多入口 → 点进去看到全部块；卸载后入口消失、停在页上时回主页 |
| B（本轮） | bundle `page` + `plugin-host` 页面视图 + `PluginBundlePage` 宿主组件 + 降级/错误态 | 首方示例 bundle 装好后进入页面视图，尺寸随窗口变化；切页/卸载后视图销毁（无残留）；浏览器端显示降级说明 |
| C（另立） | 第三方 bundle 页面信任链 | 另立规格 |

版本口径：新功能 → 特性位 +1（`d.124.3.48.0`）。

## 12. 测试计划

| 层 | 新增用例（约） | 重点 |
|---|---|---|
| shared | 12 | v5 `page` 合法/非法（块数、长度、未知 type、entry 混入）、bundle `page.entry` 校验、向后兼容（无 page 的旧包照旧可装） |
| web 单元 | 25 | 注册表投影/排序/可用性/卸载即撤、导航追加顺序、`fallbackPage` 对插件页、块渲染容错、错误态文案 |
| web 组件 | 15 | 导航入口出现/消失、点击进页、卸载回主页、浏览器降级、`page` target 跳转、插件卡「打开页面」 |
| desktop | 20 | `widgets:page-mount` 创建/复用/拒绝非法、bounds、unmount 销毁、停用/卸载销毁、导航守卫、sender 校验、页面视图无拖拽通道 |
| 回归门槛 | — | `pnpm -r test` 全绿；插件既有 500+ 例语义一条不改 |

## 13. 风险与回滚

| 风险 | 影响 | 缓解 |
|---|---|---|
| `Page` 联合类型改动波及大量 `switch` | 编译错误/漏判 | 用模板字面量类型 + 单一 `isPluginPage()`；路由兜底回主页 |
| 导航顺序被插件页挤动 | 用户体感（d.122 刚修过） | 插件页只追加末位、模块页之后；顺序纯函数单测钉死 |
| WebContentsView 与渲染层抢焦点/覆盖侧栏 | 交互异常 | rect 由宿主算、边界钳制；只覆盖内容区；卸载即销毁；真机验证多档窗口 |
| 声明式页内容被当成 HTML | XSS | 复用「禁原始 HTML」markdown 渲染器 + 全部字段转义 + 回归用例 |
| 卸载后视图孤儿 | 内存/窗口残留 | 主进程对账（记录消失即销毁）+ 停用/卸载路径用例 |
| 旧 bundle（无 page）行为变化 | 兼容 | `page` 全链路可选，缺省走旧路径 |
