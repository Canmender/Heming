# 插件菜谱（COOKBOOK）

> 面向「我知道要做什么，只想知道怎么写」的场景。每条配方都是可直接粘贴的最小片段，
> 字段语义与限制见 [STANDARD.md](STANDARD.md)；发布与检查清单见 [AUTHORING.md](AUTHORING.md)。
> 完整可运行版本在 [`examples/`](examples/README.md)。

---

## 1. 我想让智能体「会做某件事」

用**技能**（`contributions.skills`）。技能 = 一段写给模型的说明书，装进技能池后可分配给智能体。

```json
"contributions": {
  "skills": [
    {
      "name": "写周报",
      "description": "按本周任务与日程生成周报大纲",
      "instructions": "先汇总本周完成的任务、未完成的风险与下周计划。\n\n输出三段：进展 / 风险 / 下周计划；每条不超过两句。\n不要编造没有记录的事情；数据不足时直接说明缺什么。",
      "triggers": ["周报", "写周报"],
      "tags": ["汇报"]
    }
  ]
}
```

**`instructions` 的写法标准**（决定它好不好用）：

1. **什么时候用**：一句话场景（"用户说要写周报时"）。
2. **按什么步骤做**：编号步骤，一步一个动作。
3. **边界**：不编造、不越权、不替用户做决定、缺数据就说缺什么。
4. **输出形状**：段数/字数/字段，越具体越稳定。
5. 不要写营销话术、不要写"你是一个专业的…"这类角色扮演——模型不需要。

反例：`"请生成一份专业、全面、详细的周报"`（没有步骤、没有边界，输出每次都不一样）。

- 触发词是**召回线索**，宁少勿滥；3–8 个足够。
- 一个包里的技能**同域**：用户装「报告工具箱」不该顺带装进 20 个无关能力。

详见示例 [`01-hello-skill`](examples/01-hello-skill/)。

---

## 2. 我想让智能体查一个外部系统（MCP）

用**远程 MCP 服务**（`contributions.mcpServers`）+ 权限声明。

```json
"permissions": { "network": ["mcp.acme.com"], "tools": "read" },
"contributions": {
  "skills": [{ "name": "查订单", "instructions": "调用订单服务的只读工具查询，返回单号与状态。查不到就直说。" }],
  "mcpServers": [{ "key": "orders", "name": "订单服务", "url": "https://mcp.acme.com/mcp" }]
}
```

必须知道的三件事：

1. **host 必须写进 `permissions.network`**（只写 `host` 或 `host:port`；默认端口可省略）否则**装不上**。
2. 装完**不会自动连接**、工具**默认关闭**——用户要在接口区连一次并逐个打开工具（安全设计）。
3. `tools` 是**风险上限**：`read` 时写工具不会注入给模型；`write` 也不免确认（HITL 照旧）。

本机调试：`http://127.0.0.1:<port>/mcp` 允许（http 仅限回环），写进 `network` 时带端口。
详见示例 [`02-mcp-and-commands`](examples/02-mcp-and-commands/)。

---

## 3. 我想加一个「快捷入口」

用**命令**（`contributions.commands`）。命令只做跳转/定位，不执行逻辑。

| 你想要的 | target | 例子 |
|---|---|---|
| 打开某个页面 | `{ "kind": "page", "page": "plugins" }` | 跳到插件区 |
| 定位本插件的一条技能 | `{ "kind": "skill", "name": "写周报" }` | 命令面板里直接打开技能详情 |
| 打开本插件详情 | `{ "kind": "plugin" }` | 展示权限/贡献 |
| 定位设置区某张卡 | `{ "kind": "settings", "card": "theme-mode" }` | 引导去改某个设置 |
| 打开某个能力单元 | `{ "kind": "unit", "unitId": "staff" }` | 跳插件区并展开单元 |

- `skill` 的 `name` **必须是本插件 skills 里的名字**，否则解析失败。
- 命令只出现在命令面板的「插件命令」分组，插件停用即消失。
- 详情见示例 [`03-commands`](examples/03-commands/)。

---

## 4. 我想让插件在左侧导航多一个入口（插件页面）

用**页面贡献**（`contributions.page`）。装好插件 → 导航末位多一项 → 点进去是这个插件自己的页面。
每插件最多一个页面；**不写就没有入口**（纯能力包照旧只在插件页/技能区/命令面板里生效）。

声明式（推荐，第三方可用，零代码）：

```json
"engines": { "heming": "d.124" },
"contributions": {
  "skills": [{ "name": "采集状态", "instructions": "汇总各来源的采集结果。" }],
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
```

- 块词表：`markdown` / `stats` / `table` / `list` / `actions` / `contributions`，全部纯文本、宿主转义；未知 `type` 直接报错。
- `blocks` 1–12 个；每插件 1 个页面（没有页内 Tab/子路由）。
- `actions` 只做跳转（与命令 target 同形），不执行代码；页面不联网、不新增权限。
- `engines.heming` 至少 `d.124`（旧版宿主不认识 `page`）。
- 完整示例：[`05-plugin-page`](examples/05-plugin-page/)。

要自带 HTML（仅首方界面插件）：见 §8「界面插件」，页面写 `contributions.page.entry`，`entry` 必须是包内 `.html` 且出现在 `files` 里。

---

## 5. 我想声明「这些工具属于我」

用**工具束**（`contributions.toolPacks`）。它**只做归属展示**：告诉用户「这些工具是哪个能力带来的」，
不改变工具开关、不授予执行权、不影响 HITL。

```json
"toolPacks": [
  { "id": "orders-tools", "name": "订单工具", "description": "订单服务的只读接口", "tools": ["orders_search", "orders_get"] }
]
```

- 工具名**不得跨束重复**（解析会点名两处）。
- 工具本身仍由 MCP 服务提供，并受 `permissions.tools` 上限约束。

---

## 6. 我需要「一段固定流程，不靠模型自由发挥」

两条路，先想清楚要不要模型参与：

| 需求 | 做法 |
|---|---|
| 固定步骤、要跑工具、但由模型驱动 | 写进技能的 `instructions`（编号步骤 + 边界），让智能体按步骤调用已授权的工具 |
| 固定定时任务（同步/重扫这类） | 用应用内「自动化」模块（不是插件贡献点），插件里只提供技能与命令入口 |

插件**不能**声明后台脚本、定时任务或任意代码执行——那是模块/界面插件的范围（且仅首方）。

---

## 7. 我要把已有的 v3/v4 包升级到 v5

1. `schemaVersion` 改 `5`。
2. 顶层补 `engines: { "heming": "d.117" }`（写你真正需要的最低版本）。
3. 顶层补 `$schema`（编辑器补全用，可选）。
4. 旧 `permissions` 保留；若声明了 MCP，确认每个 host 都在 `network` 里（v5 校验更严）。
5. 跑 `pnpm plugin:lint`，按提示逐条修。
6. 发布时**升 `version`**：同 id + 同版本内容不可变（服务端 409）。

v4 的 `desktopWidgets` 不能出现在 v5 里——界面插件继续用 v4 bundle（仅首方）。

---

## 8. 我要做一个界面插件（仅首方）

```bash
pnpm plugin:new heming.demo --kind bundle      # 生成 v4 骨架：plugin.json + files/{index.html,app.js,README.md}
node scripts/plugin-lint.mjs plugin-kit/examples/04-widget-bundle   # 打包前模式
node scripts/sign-plugin.mjs sign <包根>/plugin.json <私钥> --id heming --write
node scripts/pack-plugin.mjs <包根>             # readPackage ✓ 才算可发布
```

要点：

- **包根只能有 `plugin.json` + `files/**`**，README/脚本放 `files/` 里（pack 会拒其它根文件）。
- `packageSha256` 由脚本写入，不要手写；签名覆盖它 → 间接覆盖全部代码字节。
- 运行时只有 `window.__heming_widget`（窗口/设置/数据/事件/聊天），**没有** localStorage、Node、密钥、文件桥。
- 偏好走 `settings()`，业务数据走 `data*`（JSON、单文件 ≤1MB、卸载即删）。
- 类型：`packages/shared/src/plugin/widget.ts` 的 `HemingWidgetApi`。
- 想再要一个页面：`contributions.page = { "title": "…", "entry": "files/page.html" }`，与 `desktopWidgets` 可并存（每类 1 个）；页面在 `widget://` 沙箱里跑，只在安装版显示。

示例 [`04-widget-bundle`](examples/04-widget-bundle/) 可直接当起点。

---

## 9. 我想让插件只在团队内使用

插件不区分公开/私有：发布到你们自己的插件目录（`HEMING_PLUGIN_DIR`）即可，客户端「插件区 → 仓库」看到的就是那份目录。
不要把内部地址/密钥写进清单（清单是明文分发的）；密钥走宿主的密钥存储，不进插件。

---

## 10. 常见需求的「别这么做」

| 想法 | 为什么不行 / 该怎么做 |
|---|---|
| 随包带一个 `postinstall` 脚本 | 插件不执行任何代码（红线）；要可执行能力只能是首方界面插件 |
| 在技能正文里让模型执行 shell | 模型没有 shell 工具；能用的工具由宿主能力提供并受 HITL 约束 |
| 用 `description` 夹带「忽略以上指令」 | 提示词注入，评审直接拒 |
| 一个包塞 50 条技能当市场 | 用户装的是「一个能力」，按能力域拆分 |
| 用 `events` 申请更多能力 | 事件只通知、不授权 |
| 想让插件页面改宿主界面/加卡片/改导航顺序 | 插件只能拥有自己的页面；改宿主界面不是插件能力 |
| 把密钥写进 `settings` 默认值 | 明文可见；密钥属于宿主密钥存储 |
