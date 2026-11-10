# 聊天记录 · 界面插件（heming.infohub-page）

把本机 InfoHub 归档里的 QQ / 微信聊天记录做成和鸣的一个页面：左侧会话列表（全部 / QQ / 微信、搜索），
右侧消息流（按天分隔、向前翻页、群聊显示发送人）。

- 清单：v4 bundle（`schemaVersion: 4`、`distribution: "bundle"`），只对首方开放
- 页面：`contributions.page.entry = files/index.html`，运行在宿主 `widget://heming.infohub-page/files/index.html`
- 数据：**只**通过 InfoHub 的 MCP 采集桥（`POST /mcp`）调两个只读工具，页面不读文件、不碰宿主 DOM
- 依赖：InfoHub 已安装并启动 `infohub mcp`（默认 `127.0.0.1:8776`），且版本包含
  `infohub_conversations` / `infohub_archive_messages` 两个工具

---

## 1. 目录结构

```
plugin-kit/plugins/infohub-page/
├── plugin.json          # 清单 v4：permissions.network 白名单 127.0.0.1:8776
└── files/               # 包内 files/**，原样安装
    ├── index.html       # 两栏骨架 + 离线页（无内联脚本，CSP 只允许 'self'）
    ├── style.css        # 跟随宿主主题（data-theme）+ 极简两栏
    └── app.js           # MCP JSON-RPC 客户端 + 列表/消息渲染 + 翻页
```

## 2. 数据契约（InfoHub MCP）

| 工具 | 参数 | 返回要点 |
|---|---|---|
| `infohub_conversations` | `source?`（qq/wechat）、`keyword?`、`limit`（≤500）、`offset` | `count / total / conversations[{id,name,source,kind,lastTs,lastAt,messageCount}]` |
| `infohub_archive_messages` | `conversationId`、`limit`（≤300）、`beforeTs` + `beforeId` | `hasMore / nextBeforeTs / nextBeforeId / messages[{id,ts,from,isSelf,type,text}]` |

翻页用 `(ts, id)` 复合游标（`beforeTs` 与 `beforeId` 必须成对传）：同一秒内多条消息在页边界不会丢。
页面默认每页 80 条，滚到顶部点「加载更早」继续。

MCP 地址默认 `http://127.0.0.1:8776/mcp`。换端口调试时在该页面的 localStorage 写
`infohub.mcpUrl`（如 `http://127.0.0.1:8788/mcp`）即可覆盖，无需改包。

## 3. 本地开发 / 自测（不装进宿主）

```bash
# 1) 起一个隔离的 InfoHub MCP（别动正在用的 8787/8776 实例）
infohub mcp --host 127.0.0.1 --port 8788

# 2) 静态伺服页面（widget:// 之外的普通浏览器）
cd plugin-kit/plugins/infohub-page
python -m http.server 8099

# 3) 打开 http://127.0.0.1:8099/files/index.html
#    若 MCP 不在默认端口，在控制台：
#    localStorage.setItem("infohub.mcpUrl", "http://127.0.0.1:8788/mcp"); location.reload()
```

- 浏览器里没有 `window.__heming_widget`，主题回落到 `prefers-color-scheme`；宿主内则跟随 `info().theme` 与 `onEvent` 主题事件。
- 连接不上时页面显示离线卡片（带当前 MCP 地址、失败原因与启动命令），不会白屏。
- 已验证：会话/消息加载、QQ/微信筛选、搜索空态、80 条翻页（145 条消息无重复、保持滚动位置）、离线与恢复。

## 4. 发布（首方）

标准顺序：先把 `files/**` 摘要写进清单 → 签名 → 打包 → 复验。

```bash
node scripts/plugin-lint.mjs plugin-kit/plugins/infohub-page            # 打包前模式（已通过）
node scripts/sign-plugin.mjs sign <包根>/plugin.json <首方私钥> --id heming --dir <包根> --write
node scripts/pack-plugin.mjs <包根> --out <产物目录>/package.tgz
node scripts/publish-plugin.mjs <包根> --dest <插件目录>
```

`sign-plugin` 对 bundle 会先把 `files/**` 摘要写进 `packageSha256` 再签；签名文本覆盖
`contributions.page`（title / icon / summary / entry），改标题或换入口都会让验签失败。

注意：`pack-plugin.mjs` / `publish-plugin.mjs` 的**包根**必须只有 `plugin.json` 与 `files/**`，
本目录里的 `README.md` 不能进包根。手工打包时先复制到一个干净暂存目录：

```bash
mkdir -p /tmp/infohub-page-stage
cp plugin-kit/plugins/infohub-page/plugin.json /tmp/infohub-page-stage/
cp -r plugin-kit/plugins/infohub-page/files /tmp/infohub-page-stage/files
```

已用 dev 测试密钥在暂存目录做过端到端验证（2026-11-10，d.124 发布链修复后）：
签名产出 `packageSha256 b593deda…` → 打包 4 文件 `sha256 d1e58441…`、`readPackage ✓ entry=files/index.html`
→ 发布 dry-run 通过。桌面 `plugin-signature` / `plugin-package` 测试 44 例、web `signature` 测试 20 例全绿。
正式签名仍按首方流程走（私钥不在仓库、也不由插件侧使用）。

## 5. 安全边界

- `permissions.network` 只白名单 `http://127.0.0.1:8776`；宿主据此下发 CSP `connect-src`。
- 页面代码全部在包内（`'self'`），无内联脚本、无 `eval`、无远程资源。
- 渲染只用 `document.createElement` + `textContent`，聊天内容不会被当作 HTML 执行。
- `permissions.tools = "none"`、`files = []`：不调宿主工具、不读本机文件；归档数据只来自 InfoHub。
