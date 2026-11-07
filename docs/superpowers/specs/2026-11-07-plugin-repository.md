# 云端插件仓库：一份仓库 + 预留接口 + 用户自助下载安装（d.95 后一轮）

- 日期：2026-11-07
- 分支：`feat/d77-heming-core`
- 用户指令：「云端用一个插件仓库，预留好接口，用户可以在这里下载插件使用」
- 说明：与并行会话（magpie 宿主/模型层）同工作区；本批只动插件仓库相关文件

## 1. 现状与目标

d.86 已有「云端插件目录」骨架：服务端读 `<dir>/<id>/<version>/plugin.json` 出目录与原文，
客户端在**安装弹窗里**「从云端浏览」。缺口是：
1. 用户没有「逛仓库」的入口——想装插件得先打开「安装插件」弹窗；
2. 仓库只有只读目录，没有发布/下线的接口与工具链（只能手工同步目录）；
3. 没有「某个插件有哪些版本」的查询，客户端无法展示更新记录。

本轮把它收成**一份云端插件仓库**：公开读接口 + 发布密钥写接口 + 客户端「插件区 → 仓库」一等入口。

## 2. 服务端（仓库）

目录布局不变：`<dir>/<id>/<version>/plugin.json`（原样字节）；
`HEMING_PLUGIN_DIR` 指定目录，缺省 `<cwd>/plugins-catalog`。

| 方法 | 路径 | 鉴权 | 语义 |
|---|---|---|---|
| GET | `/api/plugins` | 公开 | 每个 id 最新版元数据（原有） |
| GET | `/api/plugins/:id` | 公开 | 该 id 全部版本（新→旧，坏版本跳过） |
| GET | `/api/plugins/:id/:version/manifest` | 公开 | 原样清单 + `X-Plugin-Sha256`（原有） |
| PUT | `/api/plugins/:id/:version` | `x-publish-key` | 发布/覆盖：body 为 plugin.json 全文，路径 id/版本必须与清单一致 |
| DELETE | `/api/plugins/:id/:version` | `x-publish-key` | 下线一个版本 |

写接口规则：
- 仅当配置 `HEMING_PLUGIN_PUBLISH_KEY` 时开启，否则 503；密钥错 401；
- 校验只有四条：id/版本字符集、≤256KB、JSON 对象、清单内 id/version 与路径一致；
  **不解析权限、不执行代码**（权限/签名/安装校验仍由客户端在下载后做）；
- 落盘先写临时文件再 `rename`，并发发布或半文件读取都不存在；
- 同版本重复 PUT = 覆盖（200，`created=false`）；首次 201。

`PluginCatalog` 相应扩了 `detail / publish / remove` 三个方法（内存目录与文件系统同语义），
`PluginCatalogDetail` / `PluginCatalogPublishResult` 契约放进 shared。

## 3. 客户端（用户下载安装）

- 插件区 Tab 从 5 个变 6 个：**插件 / 仓库 / 模块 / 技能 / 工具 / MCP 服务**；
- 「仓库」面板：搜索（名称/id/描述/作者）、包卡（版本、已装/可更新、权限上限、网络主机数、
  技能/MCP/命令计数）、刷新、空态（仓库为空 vs 搜不到）、错误可重试；
- 点「安装/更新」→ `downloadPluginManifest`（校验 sha256）→ 填进**同一个安装弹窗**：
  安装预览、信任确认、写入语义与手动粘贴/选文件完全一致，不新增第二条安装路径；
- 安装完成后回到「插件」Tab 并高亮新卡（沿用既有安装成功流程）。

## 4. 发布工具链（预留接口的可执行形态）

`scripts/publish-plugin.mjs` 新增 `--push <apiBase>`：
- 缺省仍是写本地 `--dest` 目录（沿用「同步目录到服务器」的部署链）；
- `--push` 直接 `PUT /api/plugins/<id>/<version>`，密钥读 `HEMING_PLUGIN_PUBLISH_KEY`；
- 两种方式都先做基础校验（可解析、id/版本合规、schemaVersion 整数、有名字），坏包退出码非 0。

## 5. 测试与验证

- 服务端：`pluginCatalog.test` +7（detail 全版本/坏版本跳过、publish 校验与覆盖、remove 只下线指定版本、
  REST 401/400/404/503/201/200/204、未配置密钥时读可用写关闭）
- Web：`PluginRepositoryPanel.test` 4 例（列表/搜索/已装与可更新/安装回调/错误重试/两种空态）、
  `PluginsPage.test` +1（仓库 Tab → 安装 → 清单进预览）；插件相关 19 文件 278 例全绿
- 真机（临时服务 8799 + 独立 vite 5176）：用 `--push` 发布 InfoHub 采集桥 → 插件区「仓库」出现该包
  （共 1 个 · 云端同一份插件仓库）→ 搜索 → 点安装 → 预览里是原样清单 → 0 error；
  验证后停临时服务、删临时目录与 `plugins-catalog/`
- `plugins-catalog/` 加入 `.gitignore`（发布产物是部署数据，不入库）

## 6. 未做 / 边界

- 不做评分、评论、下载量统计（需要用户体系与存储；先保持「静态仓库 + 原样分发」）；
- 不做服务端签名校验（客户端已有 TOFU 发布者信任与清单签名验签）；
- 不开放 DELETE 给普通用户（仅发布密钥持有者可下线版本）；
- 仓库页面暂不做分类/标签（插件数量少时搜索足够；数量上来再加 tags）。
