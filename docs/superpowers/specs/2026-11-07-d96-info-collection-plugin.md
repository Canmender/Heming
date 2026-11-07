# d.96 信息采集中枢插件：本机采集桥随和鸣托管 + 完整可分发插件包

- 日期：2026-11-07
- 版本：`d.96.2.42.0`（特性 +1）
- 分支：`feat/d96-infohub-plugin`（独立 worktree `.worktrees/infohub-plugin`，从 `d.94` 的 `46360a5` 拉出）
- 交付物：① 完整可安装、可发布到云端目录的第三方插件「信息采集中枢」（`plugins/infohub-collector/`）；
  ② 随包 Python 采集桥（`packages/infohub/infohub/mcp_server.py`）；③ 桌面端托管的采集桥生命周期 +
  信息中枢页的「采集桥」区块；④ 文档、测试、版本与发布说明。

---

## 0. 一句话

把「让智能体采集 QQ / 微信消息」这件事做成**装一个插件就能用**：插件声明本机采集桥的 MCP 服务、
技能、命令与权限；和鸣桌面端负责把采集桥拉起来（只回环、用户显式启动、退出回收）；
采集与检索仍只在本机，写操作仍走人工确认。

## 1. 现状与缺口（事实，均可在本分支复核）

| 现状 | 位置 | 缺口 |
|---|---|---|
| 插件包只有声明（v3，0.1.0），指向 `http://127.0.0.1:8776/mcp` | `plugins/infohub-collector/plugin.json` | 名字仍是「采集桥」、版本 0.1.0、能力说明单薄；**装了也没有端点** |
| 采集桥实现只在 `D:\wohaolei`（InfoHub 项目） | `D:\wohaolei\infohub\mcp_server.py` | 不随和鸣分发；用户必须自己开窗口跑 `infohub mcp` |
| 随包 Python 没有 MCP 服务 | `packages/infohub/infohub/`（无 `mcp_server.py`） | 桌面端无从托管端点 |
| 桌面端 InfoHub 只有 stdio 边车 | `packages/desktop/infohub-bridge.js` | 浏览器版 / 插件 MCP 都拿不到 HTTP 端点 |
| 内置模块的 `infohub_*` 工具只在「桌面端 + 已连接」注入 | `lib/infohub/tools.ts` | 浏览器版没有采集能力；`sync` 不暴露给模型 |
| 信息中枢页只有「连接 / 检索 / 日程 / 同步」 | `components/InfohubPage.tsx` | 没有「采集桥」这一层可观察、可启停的入口 |

结论：**插件模型（声明式、不执行代码）是对的，缺的是「端点由谁提供」**。端点必须由和鸣自己提供
（随包 Python + 桌面主进程托管），插件只负责声明与接线。

## 2. 目标 / 非目标

### 2.1 目标

- 插件「信息采集中枢」v1.0.0：1 个本机 MCP 服务 + 1 个技能 + 3 个命令 + 权限声明，能通过云端目录分发；
- 采集桥进随包 Python：7 个工具（5 个对齐 InfoHub，新增 2 个），纯标准库协议层；
- 桌面端托管采集桥：显式启动 / 停止、健康检查、端口占用如实报错、退出回收、**绝不自动启动**；
- 信息中枢页「采集桥」区块：状态、启停、地址、边界说明；浏览器端只能探测不能拉起；
- 门禁：Python 单测、桌面单测、Web 单测全绿；发布脚本可把新包摆成云端目录布局；
- 文档：`docs/PLUGINS.md`、`README.md`、`CHANGELOG.md`、`docs/RELEASE-NOTES.md`、`docs/INDEX.md`、
  `docs/HANDOFF.md` 同步。

### 2.2 非目标（本版明确不做）

- 不做 **插件贡献页面**（d.85 红线：第三方插件不贡献 React 页面，安装即执行 UI 代码不可接受）；
- 不做 **stdio MCP**（和鸣的 MCP 客户端只支持 http(s)，浏览器版也需要稳定地址）；
- 不做 **鉴权 / token**：本机回环就是边界（与 InfoHub 桌面端一致），但**只监听 127.0.0.1**、
  Host 白名单、请求体上限、无 SO_REUSEADDR；
- 不做 **自动启动**：不因为「装了插件 / 打开了页面 / 连上了 stdio 边车」就拉起 Python 进程；
- 不把归档上传、不新增云端数据、不导出密钥；**不让模型直接调 `sync` 而不确认**（HITL 仍按名字判写）；
- 不做公网 https 页面访问本机回环的兼容承诺（PNA / 混合内容策略不在本轮，文档如实写）；
- 不合并、不部署（本轮只交付分支）。

## 3. 架构

```
插件「信息采集中枢」(plugin.json v3)          ← 云端目录分发，安装后物化成技能/服务/命令
  ├─ mcpServers.infohub  → http://127.0.0.1:8776/mcp
  ├─ skills             → 何时用哪个工具、写操作先确认、不可用如实说
  ├─ commands            → 打开信息中枢 / 查看采集状态 / 采集本机消息
  └─ permissions        → network ["127.0.0.1:8776"]、tools "write"、files []

和鸣桌面端（Electron 主进程）
  infohub-mcp-host.js ── spawn(python -m infohub.mcp_server --host 127.0.0.1 --port 8776)
      │                  env: INFOHUB_HOME=<用户选的归档目录>、PYTHONPATH=<随包目录>
      ├─ /health 探测 → running/starting/failed（含外部进程已在跑的情况）
      ├─ 端口被占 / 缺解释器 / 缺依赖 → 如实报错，不静默失败
      └─ 退出时用 child-kill 整树回收（与 stdio 边车同一闸）

随包 Python（packages/infohub）
  mcp_server.py ── 标准库实现的 MCP Streamable HTTP 最小子集（POST /mcp、GET /health）
      工具：infohub_status / infohub_sync / infohub_archive_search /
            infohub_archive_read / infohub_archive_agenda /
            infohub_conversations / infohub_agenda_rebuild

Web（渲染层）
  信息中枢页「采集桥」区块 ── 状态 / 启动 / 停止 / 浏览器端探测
  插件区（既有）── 安装、启停、权限与工具上限（d.77 已落到注入点）
```

## 4. Python 采集桥（`packages/infohub/infohub/mcp_server.py`）

以 `D:\wohaolei\infohub\mcp_server.py` 为蓝本移植，**按和鸣的 `Store(readonly=...)` 口径改写**：

- 只读工具 → `Store(cfg.archive_db, readonly=True)`（`mode=ro`，不建表、不写库）；
- 写工具（`infohub_sync` / `infohub_agenda_rebuild`）→ `Store(cfg.archive_db)`；
- 配置 → `load_config(create=False)`；归档目录由 `INFOHUB_HOME` 决定（与 stdio 边车一致）；
- 协议层与安全边界照抄：只监听回环、Host 白名单、CORS `*`（浏览器版需要）、请求体 ≤256KB、
  `allow_reuse_address=False`、通知回 202、JSON-RPC 错误码齐全、异常收口成人话（traceback 只进 stderr）。

### 4.1 工具（7 个）

| 工具 | 读写 | 参数 | 说明 |
|---|---|---|---|
| `infohub_status` | 只读 | — | 会话/消息数、各来源最近一次采集时间与结果 |
| `infohub_sync` | **写** | `sources?[]`（qq/wechat）、`full?` | 增量或全量采集；不重扫日程、不导出知识库、不推送 |
| `infohub_archive_search` | 只读 | `query`（必填）、`limit?`（1–50） | 归档全文检索，返回会话/时间/发信人/片段 |
| `infohub_archive_read` | 只读 | `conversationId`（必填）、`limit?`（1–100） | 按会话读最近消息，时间正序 |
| `infohub_archive_agenda` | 只读 | `days?`（1–60）、`overdue?`（1–365） | 从消息里识别出的日程（逾期/今天/本周） |
| `infohub_conversations` | 只读 | `source?`（qq/wechat）、`keyword?`、`limit?`（1–200） | 列归档会话（id/名称/来源/最近消息时间/消息数） |
| `infohub_agenda_rebuild` | **写** | `days?`（1–90） | 重扫日程（MCP 的 sync 不重扫，否则新采集的消息没有日程） |

新增两个工具的理由：

1. **`infohub_conversations`**：页面已放弃会话浏览（d.85 收回），智能体要「看看最近有哪些群/会话」时
   只能靠检索猜；这个工具补上「先列会话、再读消息」的入口，且限制 200 条、只读。
2. **`infohub_agenda_rebuild`**：MCP 版 `sync` 刻意不重扫日程（d.85 边界），但只采集不重扫会让
   `infohub_archive_agenda` 长期为空——必须有一个显式、走 HITL 的补齐入口（与内置模块的
   `infohub_agenda_rebuild` 同名同语义）。

### 4.2 CLI

`packages/infohub/infohub/cli.py` 新增子命令（与 InfoHub 对齐）：

```
python -m infohub mcp [--host 127.0.0.1] [--port 8776]
```

打印「MCP 服务已启动：http://127.0.0.1:8776/mcp」到 stderr；非回环地址直接拒绝启动。

### 4.3 测试（`packages/infohub/tests/test_mcp_server.py`）

移植 InfoHub 的 13 例并扩展：协议层起真实 HTTP（initialize / tools/list 顺序 / 通知 202 /
未知方法 -32601 / 未知工具 -32602 / ping / health / 404 / CORS 预检 / 伪造 Host 403 / 坏 JSON 400），
工具层用临时 sqlite 归档（不碰真实数据）：status / search+read / agenda / conversations /
agenda_rebuild / 参数错 isError / sync 用 mock 证明只调采集、未知来源报错。
跑法：`cd packages/infohub && python -m unittest tests.test_mcp_server -v`。

## 5. 桌面端托管（`packages/desktop/infohub-mcp-host.js`）

新增模块，风格与 `infohub-bridge.js` / `magpie-proxy.js` 一致（CommonJS、零依赖、可单测）：

```js
createInfohubMcpHost({ spawn, log, packageDir, bundledPythonPath, defaultHome, fetchImpl, platform })
  → { status(), start(config), stop(), dispose(), idle(), onEvent(cb) }
```

- `start({home?, python?})`：
  1. 先 `GET http://127.0.0.1:8776/health` 探测——已有端点（用户自己跑的 `infohub mcp`）⇒
     直接标记 `running`、`source:"external"`，**不再重复拉进程**；
  2. 解释器：用户配置优先，其次内置运行时（与 stdio 边车同一套 `resolvePython` 语义，可复用/复制纯函数）；
  3. `spawn(python, ["-m", "infohub.mcp_server", "--host", "127.0.0.1", "--port", "8776"], {cwd: packageDir, env})`，
     `env` 带 `INFOHUB_HOME`、`PYTHONPATH`（与 `infohub-bridge.js` 的 launch 一致）；
  4. 轮询 `/health`（≤15s，200ms 间隔），成功即 `running`、`source:"app"`；进程提前退出/端口被占/
     解释器缺失都抛中文错误（含 stderr 尾部 ≤4000 字符）；
- `stop()`：先 `SIGTERM`（Windows 走 child-kill 整树），确认回收；`dispose()` 等回收完；
- `status()` 形状见 §6；每次状态变化 `onEvent` 推一次；
- **不自动启动**：模块里没有 `app.whenReady` / 页面事件触发；只有 IPC `infohub:bridge-start` 会调 `start()`。

`main.js` 接线：创建实例（与 `createInfohubBridge` 同一处）、`reclaimChildren` 里加 `dispose()`、
`infohub:bridge-event` 广播给所有窗口；`preload.js` 扩展 `__heming_infohub`（见 §6）。

`packages/desktop/package.json` 的 `typecheck` / `test` 脚本要加 `node --check infohub-mcp-host.js`
与 `node --test infohub-mcp-host.test.js`；如 `main.test.js` / `preload.test.js` 有模块/API 清单守卫，一并更新。

## 6. 契约（IPC / preload / web 客户端）

### 6.1 状态形状（唯一事实来源，桌面端产出、渲染层消费）

```ts
type InfohubBridgeStatus = {
  running: boolean;          // /health 通过
  starting: boolean;         // 正在拉起/等待健康
  url: string | null;        // running 时为 "http://127.0.0.1:8776/mcp"
  port: number | null;       // 8776
  home: string | null;       // 采集桥读的归档目录（INFOHUB_HOME）
  python: string | null;     // 实际用的解释器（external 时为空）
  pythonSource: "configured" | "bundled" | "missing" | "external" | "unknown";
  source: "app" | "external" | "none";
  since: number | null;      // 启动时间（epoch ms）
  error: string | null;      // 失败原因（中文、可执行）
};

type InfohubBridgeConfig = { home?: string; python?: string };
```

### 6.2 IPC（主进程）

| 通道 | 签名 | 说明 |
|---|---|---|
| `infohub:bridge-status` | `() => InfohubBridgeStatus` | 只读状态，不做探测写操作 |
| `infohub:bridge-start` | `(config?: InfohubBridgeConfig) => InfohubBridgeStatus` | 显式启动（或复用外部端点）；失败抛中文 Error |
| `infohub:bridge-stop` | `() => boolean` | 只停和鸣自己拉起的进程；外部端点返回 false 并说明 |
| `infohub:bridge-event` | 推送 | 状态变化时广播全窗口 |

### 6.3 preload（`window.__heming_infohub` 扩展）

```ts
bridgeStatus(): Promise<InfohubBridgeStatus>
bridgeStart(config?: InfohubBridgeConfig): Promise<InfohubBridgeStatus>
bridgeStop(): Promise<boolean>
onBridgeEvent(cb: (status: InfohubBridgeStatus) => void): () => void
```

### 6.4 web 客户端（`packages/web/src/lib/infohub/client.ts`）

```ts
export function infohubBridgeStatus(): Promise<InfohubBridgeStatus>   // 浏览器端抛「仅桌面端可用」
export function startInfohubBridge(config?: InfohubConfig): Promise<InfohubBridgeStatus>
export function stopInfohubBridge(): Promise<boolean>
export function onInfohubBridgeEvent(cb: (status: InfohubBridgeStatus) => void): () => void
export async function probeInfohubBridge(url?: string, opts?: { timeoutMs?: number; fetchImpl?: typeof fetch }):
  Promise<{ ok: boolean; name?: string; error?: string }>          // 浏览器可用：GET /health，1.5s 超时
```

`probeInfohubBridge` 是纯异步函数（不依赖 Electron），浏览器端用它显示「检测到本机采集桥 / 未检测到」；
`isInfohubAvailable()` 仍表示桌面桥是否存在（不因采集桥而变）。

## 7. 插件清单（`plugins/infohub-collector/plugin.json`）

- `schemaVersion: 3`；`id: "heming.infohub-collector"`（**保持不变**——同 id 才是更新而不是新增）；
- `name: "信息采集中枢"`；`version: "1.0.0"`；`author: "和鸣"`；
- `description`：说清「装完还需要在信息中枢页启动采集桥」这一事实，不写成「一装就自动采集」；
- `permissions`：`network: ["127.0.0.1:8776"]`、`tools: "write"`、`files: []`；
- `contributions.mcpServers`：1 个，`key: "infohub"`、`name: "信息采集中枢（本机采集桥）"`、
  `url: "http://127.0.0.1:8776/mcp"`；
- `contributions.skills`：1 个「本机信息采集与归档查询」——写清 7 个工具的用途、
  `infohub_sync` / `infohub_agenda_rebuild` 是写操作必须先确认、端点没起来时如实说、
  引用标注「来自本机归档」、不把归档当当前会话；
- `contributions.commands`：3 个（查看采集状态 / 采集本机消息 / 查看本机日程），target 都是 `page: infohub`；
- 不携带代码、命令、环境变量、请求头、密钥；`bundledPlugins.test.ts` 的守卫同步更新
  （目录名=id 末段、服务 key、权限、工具名出现在技能说明里）。

## 8. 信息中枢页「采集桥」区块

放在页面「连接」区之后、检索区之前（桌面端与浏览器端都渲染，能力不同）：

- 状态行：`未运行` / `启动中…` / `运行中 · 127.0.0.1:8776 · 由和鸣托管` / `运行中 · 外部进程` / `失败：<原因>`；
- 桌面端操作：`启动采集桥` / `停止`（外部进程时不显示停止，说明「请在你启动它的窗口里关闭」）；
- 浏览器端：自动 `probeInfohubBridge()` 一次 + `重新检测` 按钮，显示「检测到本机采集桥 / 未检测到」，
  并说明「浏览器版不能拉起进程，请在和鸣桌面端启动」；
- 说明区：只监听本机回环、不自动启动、写操作仍走人工确认、`info` 级隐私口径；
- 入口：`去插件区安装/查看「信息采集中枢」`（`setPage("plugins")`）；
- 不阻塞主流程：采集桥未运行时，页面既有的连接/检索/日程/同步照常可用（两条路互不依赖）。

## 9. 分发

- `node scripts/publish-plugin.mjs plugins/` → `<dest>/<id>/<version>/plugin.json`（原样字节）；
- 服务端 `GET /api/plugins` 原样分发 + `X-Plugin-Sha256`；客户端下载、校验 sha256 后走安装预览（d.88 链路，不改）；
- 文档写清：本功能**不随安装包分发**，发布靠这条链路；`plugins/infohub-collector/README.md` 同步重写。

## 10. 验证矩阵

| 层 | 命令 | 通过标准 |
|---|---|---|
| Python 协议/工具 | `cd packages/infohub && python -m unittest tests.test_mcp_server -v` | 全部通过（≥20 例） |
| Python 既有 | 同上目录 `python -m unittest discover -s tests -p "test_*.py"` | 无回归 |
| 桌面 | `pnpm --filter @heming/desktop test` | node --check + node --test 全绿 |
| Web 相关 | `pnpm --filter @heming/web test` | 全绿（新增用例覆盖采集桥区块 + 插件守卫） |
| 全量门禁 | `pnpm -r build && pnpm -r test` | shared/server/web/desktop 全绿 |
| 真实端点 | 起 Python 采集桥 → `curl /health`、`initialize`、`tools/list`、`tools/call(infohub_status)` | 回 JSON，工具 7 个、顺序正确 |
| 发布链路 | `node scripts/publish-plugin.mjs plugins/ --dest .tmp/plugin-catalog` | 目录布局正确、字节原样、id/version 合规 |

**如实说明（未验证项）**：Electron 真机点「启动采集桥」（需要装包或 `electron .` 跑一次）、
公网 https 页面访问 `127.0.0.1` 的浏览器 PNA 行为、真实 QQ/微信采集的耗时与失败态——
本轮以单测 + 本机真实 Python 端点 + curl 为准，真机项在交接里列明。

## 11. 边界与红线（逐条对应既有承诺）

1. 插件仍**只声明、不执行代码**，不贡献页面（d.85 红线不动）；
2. 采集桥**只监听回环**、无鉴权但有 Host 白名单与体积上限；不对外网开放；
3. **不自动拉起** Python 边车/采集桥（d.45/d.47 红线不动）；只有用户点「启动采集桥」才启动；
4. 写操作（`infohub_sync` / `infohub_agenda_rebuild`）按名字判风险，仍走 HITL；
5. 归档不上传、不进和鸣会话记录；引用标注「来自本机归档」；
6. 退出时整树回收，不留孤儿进程（复用 `child-kill.js`）；
7. 端口固定 8776；被占/缺依赖/缺解释器都如实报错，不静默降级。

## 12. 明确不做（附原因）

- 不做 stdio MCP（浏览器版用不上，且和鸣 MCP 客户端只认 http/https）；
- 不做 `/health` 的 Host 校验补丁外的鉴权（本机回环即边界，与 InfoHub 一致；加 token 会让插件装入变复杂）；
- 不做「装插件即启动」（违反不自动拉起红线）；
- 不做归档会话浏览页面（d.85 已收回；需要时用 `infohub_conversations` 工具）；
- 不做知识库导出 / 简报 / 画像 / 需求采集的 MCP 暴露（写面太大，单独立轮）；
- 不做云端任何新存储（插件目录只存原样清单）。
