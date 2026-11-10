# 聊天记录 · 自带引擎插件（heming.infohub-page）

把本机 QQ / 微信聊天记录做成和鸣的一个页面，**装完即用、不依赖任何外部服务**：左侧会话列表
（全部 / QQ / 微信、搜索），右侧消息流（按天分隔、向前翻页、群聊显示发送人）；顶部一键「采集」
同步本机归档，并可调用和鸣「后台任务模型」生成摘要、自动存入和鸣内置知识库。

插件自带一个 Python 本机引擎（随包发行），由宿主用内置 Python 拉起，**不开端口、不收外部连接**，
只经 stdin/stdout 与宿主通信。不引入智能体编排、不做企业微信推送。

- 清单：v4 bundle（`schemaVersion: 4`、`distribution: "bundle"`），只对首方开放
- 页面：`contributions.page.entry = files/index.html`，运行在 `widget://heming.infohub-page/files/index.html`
- 引擎：`contributions.engine = { entry: "files/engine/bridge.py", lib: "files/engine/lib" }`
- 权限：`chat: true`（拿后台任务模型）、`kb: true`（拿知识库根 + writeDirs）、`network: []`、`tools: "none"`、`files: []`
- 数据：页面只调 `window.__heming_widget.engineCall`，不读文件、不碰宿主 DOM、不发网络请求

---

## 1. 目录结构

```
plugin-kit/plugins/infohub-page/
├── plugin.json          # 清单 v4：permissions.chat/kb，contributions.page + engine
├── build.mjs            # 暂存脚本：把 infohub 核心 + 必需依赖 vendor 进 dist/package
├── engine/
│   └── bridge.py        # 插件引擎入口（JSONL stdio 协议，编排采集 / 入库）
└── files/               # 页面资源（包内 files/**）
    ├── index.html       # 顶部工具栏 + 两栏骨架 + 引擎错误页（无内联脚本）
    ├── style.css        # 跟随宿主主题（data-theme）+ 工具栏 / 进度条 / 两栏
    └── app.js           # engineCall 客户端 + 行映射 + 列表/消息渲染 + 采集/入库
```

`build.mjs` 产出干净的包根 `dist/package/`（只有 `plugin.json` 与 `files/**`，README/build.mjs 不进包）：

```
dist/package/
├── plugin.json
└── files/
    ├── index.html / style.css / app.js
    └── engine/
        ├── bridge.py
        ├── infohub/…    # 从 packages/infohub vendor 的核心（去掉 ui/ 与 __pycache__）
        └── lib/…        # 采集必需依赖（wechatauto / zstandard / cryptography / PIL …）
```

## 2. 引擎方法（页面 ↔ bridge.py）

协议与 InfoHub 核心桥一致：请求 `{id,method,params}` → `{id,ok:true,result}` / `{id,ok:false,error:{type,message}}`，
引擎主动上报 `{event:"progress",phase,stage,current,total}`。读类方法直接复用 vendor 的 infohub 核心，
返回 **snake_case** 行，页面侧 `mapConv` / `mapMsg` 统一映射成渲染用的 camelCase。

| 方法 | 参数 | 返回要点 |
|---|---|---|
| `ping` / `status` | — | 运行态；`chat:{model,available}`、`kb:{vaults,archiveCursor,lastArchive}`、`hasDb`、`stats` |
| `conversations` | `source?`、`keyword?`、`limit`（≤5000） | `{items:[{id,name,source,kind,last_ts,message_count,…}], total}`；无库时 `{items:[],dbMissing:true}` |
| `messages` | `conversationId`、`limit`（≤1000）、`beforeTs?` | `{conversation, items:[{id,ts,sender_name,content,type_label,is_self,…}], hasMore, beforeTs}` |
| `sync` | `sources?`、`full?`、`archive?`、`vaultId?` | 采集 QQ/微信 → 更新日程 →（默认）自动入库；`{reports[],agenda,kb}` |
| `kb.archive` | `vaultId?`、`hours?` | 不采集，只把已有归档生成摘要存入知识库 |
| `kb.roots` | — | `{vaults:[{id,name,root,writeDirs,writable,target}]}` |

消息翻页只用 `beforeTs`（核心按 `ts < beforeTs` 取更早一批），页面默认每页 80 条、按 id 去重后前插，
保持滚动位置。会话列表核心不支持 offset，「加载更多」通过增大 `limit` 重取。

## 3. 运行目录与知识库边界

- **归档目录**：优先复用和鸣默认归档 `~/Heming/infohub`（存在 `config.json` 或 `data/archive.db` 时），
  让老用户装完即见已有聊天；否则落到插件数据目录 `<data>/infohub`。可用插件设置 `home`（绝对路径）覆盖。
  必须在 import infohub 之前定好 `INFOHUB_HOME`（核心在导入时即按它算 HOME）。
- **后台任务模型**：宿主经 `HEMING_CHAT={baseUrl,key,model}` 下发；引擎只在**进程内存**里启用 LLM
  （`INFOHUB_LLM_*` 环境 + 内存配置），绝不写回共享 `config.json`。未配置时摘要回落到规则生成。
- **知识库写入**：宿主经 `HEMING_KB_ROOTS=[{id,name,root,writeDirs}]` 下发；引擎把 `cfg.kb.vault`
  指到 `root/<writeDirs[0]>/InfoHub`，所有落点都收在 writeDirs 边界内，不污染库根、不越界。
- **入库游标**：放在插件自己的 `state.json`（`archiveCursor` / `lastArchive`），不动共享库的 digest 游标；
  单次入库最多回看 24h，积压时多次调用逐步补齐。

## 4. 构建 / 发布（首方）

```bash
# 1) 暂存：vendor infohub 核心 + 必需依赖，并跑内置 Python 导入自检
node plugin-kit/plugins/infohub-page/build.mjs

# 2) 打包前 lint（对暂存包根）
node scripts/plugin-lint.mjs plugin-kit/plugins/infohub-page/dist/package

# 3) 签名（首方私钥不在仓库、不由插件侧使用）→ 打包 → 复验
node scripts/sign-plugin.mjs sign <包根>/plugin.json <首方私钥> --id heming --dir <包根> --write
node scripts/pack-plugin.mjs plugin-kit/plugins/infohub-page/dist/package --out <产物目录>/package.tgz
```

`build.mjs` 的必需依赖正则与 `build-module.mjs` 一致（wechatauto / zstandard / uiautomation / comtypes /
colorama / cryptography / cffi / pycparser / PIL / pillow / psutil / pyperclip）。包体上限 64MB / 4000 文件 /
单文件 16MB；当前约 627 文件 / 解包前 30MB。`sign-plugin` 对 bundle 会先把 `files/**` 摘要写进
`packageSha256` 再签；签名覆盖 `contributions.page` 与 `contributions.engine`，改入口会让验签失败。
宿主在每次版本首次拉起引擎前会按 `packageSha256` 复验磁盘文件。

## 5. 本地开发 / 自测

- 浏览器里没有 `window.__heming_widget`：页面显示「请在和鸣里打开」整屏提示，主题回落 `prefers-color-scheme`；
  宿主内则跟随 `info().theme` 与 `onEvent` 主题事件。
- 引擎不可用（未启用 / 启动失败 / 超时）时页面弹整屏引擎错误卡（带原因与重试），不会白屏。
- 真实自测须用**隔离端口 / 临时归档库**，不要动正在用的实例；采集与入库会写本机归档与知识库，
  验证时指向临时目录。

## 6. 安全边界

- `permissions.network = []`：页面与引擎都不发网络请求；模型调用走和鸣网关（由宿主下发地址）。
- 页面代码全部在包内（`'self'`），无内联脚本、无 `eval`、无远程资源；渲染只用 `createElement` + `textContent`，
  聊天内容不会被当作 HTML 执行。
- `permissions.tools = "none"`、`files = []`：不调宿主工具；归档数据只来自带引擎。
- 引擎只读注册表里的知识库根，写入严格落在 `root/<writeDir>/InfoHub`；密钥只在进程内存，不落盘。
