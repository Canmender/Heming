# d.88 云端插件目录：插件独立分发，不随安装包

- 日期：2026-11-07
- 版本：`d.88.2.42.0`（特性 +1）
- 分支：`feat/d77-heming-core`
- 起因：**信息采集与 magpie 网关是独立插件**——安装包不携带它们；包上传云端插件目录，用户自行下载安装。

## 0. 一句话架构

```
仓库 plugins/<包>/plugin.json
  → node scripts/publish-plugin.mjs（校验 + 摆目录）
  → 服务器 HEMING_PLUGIN_DIR/<id>/<version>/plugin.json
  → GET /api/plugins（公开目录） + GET /api/plugins/:id/:version/manifest（原样字节 + sha256）
  → 客户端「插件区 → 安装插件 → 从云端浏览」：下载 → 校验 sha256 → 填进清单框
  → 既有安装预览 / 信任确认 / 写入（不新增第二条安装路径）
```

两端口径都写在 `@heming/shared` 的 `pluginCatalog.ts`（目录条目 schema、id/版本/指纹正则），
服务端与 Web 共用一份，不各写一套。

## 1. 服务端：只做目录与原样分发

- `packages/server/src/pluginCatalog.ts`：扫 `HEMING_PLUGIN_DIR`（缺省 `<cwd>/plugins-catalog`），
  布局 `<id>/<version>/plugin.json`；一个 id 多版本时只列**最新版本**（数字段按数值比，`1.10 > 1.9`）；
- 坏清单/坏版本目录只跳过该条并 warn，不让整份目录 500；目录不存在 = 空列表（新部署合法状态）；
- `read(id, version)` 只接受 shared 里的 id/版本正则并只拼这两段路径——**永不越界读文件**；
- 路由：`GET /api/plugins`、`GET /api/plugins/:id/:version/manifest`（公开、无 auth；带 `X-Plugin-Sha256`）；
- **不做缓存**：目录很小，「发了新版本但客户端看不到」比省几个 readFile 更糟。

## 2. 客户端：浏览 → 下载 → 指纹校验 → 既有安装管线

- `lib/plugins/catalogClient.ts`：`fetchPluginCatalog()`（zod 校验服务端返回形状）、
  `downloadPluginManifest()`（原文 + **sha256 必须一致**，不一致直接拒绝且不返回内容）；
- **没有 `crypto.subtle` 就不下载**（`file://` / 非回环 http）：明确报「当前环境无法校验指纹」，
  不回退到「跳过校验」——指纹是这条链唯一的信任锚；
- `components/plugins/OnlineCatalogPanel.tsx`：纯展示组件（加载/错误/空/条目四态，
  每行给出：版本、已装/可更新、贡献计数、权限（主机数 + 风险上限）、指纹前 8 位、载入按钮）；
- `InstallDialog` 增加「从云端浏览」入口：**首次展开才联网**，失败只影响面板；载入后把文本交给同一个
  `onTextChange`，预览/信任确认/写入与手动粘贴完全一致；
- `PluginsPage` 把已装列表（id + 版本）传给弹窗，用于「已装 / 可更新」提示。

## 3. 清单 v4：模型接入预设（`contributions.llmPresets`）

magpie 网关这类「第三方接入配置」不该内置在安装包里，也不该让用户手抄 Base URL。新增第五类声明面：

```json
"contributions": {
  "llmPresets": [
    { "id": "magpie-gateway", "label": "magpie 本地网关", "provider": "openai",
      "baseUrl": "http://127.0.0.1:3425/v1", "model": "deepseek/deepseek-chat", "note": "…" }
  ]
}
```

- 只填**协议 / Base URL / 模型 / 说明**；**没有 `apiKey` 字段**（zod `strictObject`：写了直接拒绝）；
- 地址规则与 MCP 服务一致：远程必须 https，http 仅回环；且 Base URL 主机**必须**被
  `permissions.network` 覆盖（声明即约束）；
- v3 清单带预设直接拒绝并提示升 v4（不静默丢字段）；v1–v3 归一化为空数组；
- 设置区「模型」里多一组「插件带来的模型预设」：来源写明插件名，点击只填表单、焦点交给 API Key；
  插件停用后整组消失；**已保存的连接不受影响**（属于用户，不属于插件）。

顺带把 d.48 内置的 magpie 预设从 `llmPresets.ts` 移除——网关接入现在由插件提供，安装包不再带第三方接入配置。

## 4. 两个独立插件包

| 包 | 类型 | 声明 | 运行时（用户自装） |
|---|---|---|---|
| `plugins/infohub-collector` | v3 | 本机 MCP 服务（`127.0.0.1:8776/mcp`）+ 技能 + 命令；`tools: write`（采集写归档） | InfoHub 项目 `infohub mcp`（上一轮已提供） |
| `plugins/magpie-gateway` | v4 | 模型接入预设（`127.0.0.1:3425/v1`）+ 技能 + 命令；`tools: none` | magpie 本体（独立软件） |

两个包都不含代码/命令/环境变量/请求头/密钥，由 `bundledPlugins.test.ts` 扫描 `plugins/` 目录统一守卫。

**不随安装包**：`packages/desktop/packaging.plugins.test.js` 断言 electron-builder 的
`files` / `extraResources` 不含任何 `plugins/` 路径；`scripts/publish-plugin.mjs` 是唯一发布入口
（`--dry-run`、`--dest`、`HEMING_PLUGIN_DIR`；不做 SSH，上传沿用现有部署链把目录同步到服务器）。

## 5. 验证

- 契约/服务端：`pluginCatalog.test.ts` 7 例（版本选择、坏包跳过、防穿越、mtime、HTTP 公开路由与 sha 头）；
- 客户端：`catalogClient.test.ts` 10 例（形状校验、HTTP/网络错误、指纹不一致、无 subtle 拒绝）；
  `OnlineCatalogPanel.test.tsx` 6 例（四态、已装/可更新、载入回调）；
  `InstallDialog.catalog.test.tsx` 3 例（首次展开才联网、载入填入同一 textarea、离线不影响手动路径）；
- 清单 v4：`manifest.test.ts` 新增 4 例（合法预设、v3 带预设拒绝、主机未声明拒绝、重复 id/明文远程/携带 apiKey 拒绝）；
- 设置区：`LlmSettingsCard.test.tsx` 新增 2 例（插件预设填表单并聚焦 Key、停用后消失）；
- 真实链路：临时服务端 `HEMING_PLUGIN_DIR=.tmp/plugin-catalog` 后
  `GET /api/plugins` 返回两包、manifest 带 `X-Plugin-Sha256`；
  真实浏览器（headless Edge）：从云端目录载入 magpie 包 → 预览显示 v4 / 模型预设 1 / 主机 127.0.0.1:3425 →
  安装成功 → 设置区出现「套用插件预设 magpie 本地网关」→ 点击后名称 / Base URL / 模型三项填好。

## 6. 部署与未做

- 部署：`node scripts/publish-plugin.mjs plugins/` 生成目录 → 同步到服务器的 `HEMING_PLUGIN_DIR`
  （与现有部署链同一套账号与凭据，不新增发布通道）。服务端与客户端都可独立升级：旧客户端不认 v4，
  装 magpie 包时会被清单校验拒绝并提示升级，不会半安装。
- 未做：目录缓存/ETag（量小不做）、插件评分/下载量（需要运营数据）、真正的签名分发链
  （服务端目录只是搬运，签名信任仍是客户端安装时的 TOFU 流程）、离线批量安装。
