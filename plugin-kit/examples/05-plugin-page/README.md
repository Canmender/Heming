# 示例 05 · 插件页面（v5 声明式）

**教会你**：给插件加一个导航入口；页面内容用受控块写；什么时候该改用界面插件（bundle）自带页面。

> 页面是 **d.124** 新增的贡献点，`engines.heming` 至少写 `d.124`（旧版宿主不认识 `contributions.page`）。

```bash
node scripts/plugin-lint.mjs plugin-kit/examples/05-plugin-page
```

## 装完是什么样

- 左侧导航**末位**（模块入口之后）多一项「运维看板」，图标用清单里的 `icon`；
- 点进去是插件自己的页面，页头是 `title` + `summary`，下面按 `blocks` 顺序渲染；
- 插件停用或卸载后入口自动消失；卸载时如果正停在该页，会回到主页。

## 清单结构

```
05-plugin-page/
├── plugin.json   # contributions.page = { title, icon?, summary?, blocks[] }
└── README.md
```

`contributions.page` 是**对象不是数组**——每个插件最多一个页面，页内也没有 Tab/子路由。

| 字段 | 必填 | 限制 |
|---|---|---|
| `title` | 是 | 1–40 字；导航项与页面标题共用 |
| `icon` | 否 | 宿主图标 id（如 `activity` / `chart` / `list`）；未知值回落默认图标，不报错 |
| `summary` | 否 | ≤200 字；页面副标题 |
| `blocks` | 是 | 1–12 个；未知 `type` 直接报错 |

## 块词表（全部纯文本，宿主转义后渲染）

| type | 字段 | 限制 |
|---|---|---|
| `markdown` | `title?`、`text` | `text` ≤4000 字；禁原始 HTML |
| `stats` | `title?`、`items[{label,value}]` | ≤8 项，各 ≤40 字 |
| `table` | `title?`、`columns[]`、`rows[][]` | 列 ≤6、行 ≤50、单元格 ≤120 字；每行格数必须等于列数 |
| `list` | `title?`、`items[{title,description?,badge?}]` | ≤20 项；标题 ≤60 / 描述 ≤160 / badge ≤12 |
| `actions` | `title?`、`items[{label,target}]` | ≤6 项；`label` ≤24；`target` 与命令 target 同形，只做跳转 |
| `contributions` | `kind` | `skills` / `mcpServers` / `commands` / `toolPacks`；自动列出本插件该类贡献，空则显示空态 |

页面**不新增权限**、不发起网络请求、不能编辑清单：它只展示清单里的文本与本地投影。

## 想改成「界面插件自带页面」

只有**首方签名**的界面插件（bundle）可以带自己的 HTML；第三方仍用上面的声明式页面。
改法（同时参考 [`04-widget-bundle`](../04-widget-bundle/) 的清单格式）：

1. 清单改成 `schemaVersion: 4` + `distribution: "bundle"` + `packageSha256`（打包/签名脚本写入，不手写）；
2. 把 `contributions.page` 换成 `{ "title": "运维看板", "icon": "activity", "entry": "files/page.html" }`；
   `entry` 必须是包内 `.html`（无 `..`/反斜杠/协议前缀），且**出现在 `files` 清单里**；
3. 页面放 `files/page.html`（脚本外置，CSP 只放 `'self'` 脚本；无 Node/密钥/文件桥）；
4. 页面与桌面小组件可以并存（`desktopWidgets` + `page`），每类最多 1 个；
5. 自带页只在**安装版**显示（浏览器版不可用，宿主缺页面视图能力时给降级说明），代码在 `widget://<插件 id>/` 沙箱里跑。

完整字段见 [../../STANDARD.md](../../STANDARD.md) §3.7，发布顺序见 [../04-widget-bundle/README.md](../04-widget-bundle/README.md)。
