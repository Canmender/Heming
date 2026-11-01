# d.45 · 信息中枢：把 InfoHub 并入和鸣（本机 stdio 边车）

- 日期：2026-11-01
- 相关版本：d.44.1.11.0（基线）、本 spec = d.45.1.11.0（特性位 +1）
- 涉及包：`packages/infohub`（新，Python ≥3.11）、`packages/desktop`（主进程 stdio 桥 + IPC + preload）、`packages/web`（信息中枢页、导航、图标、设置页标签）、`packages/infohub/tests`（桥协议测试）
- 上游判断：`D:\wohaolei` 的 InfoHub 已经把 QQ/微信归档、全文检索、议程抽取、日报与 Obsidian 导出做成了本机 Python 工具，但它是独立 CLI，和和鸣的导航、主题、数据边界都没有关系。

## 0. 问题

- **不能重写成 TS**：归档读取依赖 SQLCipher/微信 `db_storage` 解密、Silk 语音、sherpa-onnx 转写，全部是 Python 生态；用 JS 重写等于重新造一遍且必然丢能力。
- **不能放到云端**：归档是个人聊天记录的明文库，上传云端直接违背「个人数据不出设备」红线。
- **不能开 HTTP 端口**：本机监听端口会引入新的网络暴露面，也让「只在本机可用」的边界变得模糊。
- **不能把配置带进仓库**：`D:\wohaolei\config.json` 里有企业微信机器人密钥、LLM API Key、SMTP 账号；一旦复制进工作区就可能被提交或打包。

## 1. 决策

### A. 源码并入，运行时保持独立边车

- 把 InfoHub 的 Python 源码（`infohub/`、`tests/`、`pyproject.toml`、README）**原样并入** `packages/infohub`。
- 不复制 `config.json`、`data/`、`.venv/`；仓库根 `.gitignore` 追加 `__pycache__/`、`*.pyc`、`packages/infohub/config.json`、`packages/infohub/data/`。
- 运行时由 Electron 主进程用 **stdio** 拉起 `python -m infohub.bridge`：不开端口、不走网络、不用 shell。
- 开发态包目录 = `packages/infohub`；打包后由 electron-builder `extraResources` 放到 `resources/infohub`。解释器默认用内置运行时（浏览/检索只需标准库）；采集依赖缺失时由界面提示改选 InfoHub 的 venv Python。

### B. 协议：行分隔 JSON，stdout 只跑协议

请求：

```json
{"id": 1, "method": "search", "params": {"query": "免检单", "limit": 50}}
```

响应：

```json
{"id": 1, "ok": true, "result": {"items": [], "query": "免检单"}}
{"id": 1, "ok": false, "error": {"type": "ValueError", "message": "…"}}
```

事件（无 id）：

```json
{"event": "hello", "app": "infohub", "version": "0.1.0", "protocol": 1}
{"event": "progress", "phase": "sync", "stage": "wechat", "current": 3, "total": 10}
```

- `main()` 把 `sys.stdout` 改指 stderr：业务代码里的 `print` 不能污染协议流。
- 白名单方法：`ping / status / conversations / messages / search / agenda / sync / config.summary / shutdown`；渲染层只能调前 8 个，`shutdown` 仅主进程用。
- `sync` 是长任务（30 分钟超时），其余默认 60 秒；`agenda` 重建 5 分钟。进度只按节流频率上报。

### C. 只读浏览

- 所有读方法通过 `Store(path, readonly=True)` 打开归档：SQLite URI `file:...?mode=ro`。
- 单测对归档做 SHA-256 前后比对，证明浏览/检索不写库。
- 同步是唯一写路径，且必须由用户显式选择来源（QQ / 微信 / 全量重扫 / 导出知识库）后触发。

### D. 密钥不越界

- Python 侧 `config.summary` 只回 `hasCredentials` / `hasKey` 等布尔与公开配置（目录、模型名、渠道、开关），不回任何密钥值。
- Node 桥只转发 `home` / `python` 两个路径参数，不接收或返回密钥。
- Web 端配置区以 `<details>` 展示脱敏摘要；页面不发云端请求。

### E. 桌面端桥与 IPC

`packages/desktop/infohub-bridge.js`：

- `createInfohubBridge({spawn, packageDir, defaultHome, bundledPythonPath, exists, log})`：进程复用、hello 握手、按 id 配对、每方法超时、退出时拒绝全部 pending 并附 stderr 尾部。
- 路径校验：必须是绝对路径、≤1024 字符、不含 CR/LF/NUL；数据目录不存在时由主进程创建。
- `registerInfohubIpc(ipcMain, {bridge, dialog, windowFromEvent})` 注册：
  - `infohub:info` / `infohub:start` / `infohub:call` / `infohub:stop`
  - `infohub:pick-home`（选目录）/ `infohub:pick-python`（选解释器，Windows 过滤 exe）
- `infohub:call` 在 IPC 层再次校验方法白名单，渲染层无法调用 `shutdown`。
- preload 暴露 `window.__heming_infohub`：`info/start/call/stop/pickHome/pickPython/onEvent`；`call(method, params, config)` 只转发 `home/python`。

### F. 信息中枢页

- 浏览器环境直接显示「信息中枢仅桌面端可用」，不尝试连接任何地址。
- 未连接：数据目录输入 + 浏览 + 默认目录快捷项；高级设置可选 Python 解释器；点「连接」才拉起进程。若已有进程在跑则复用，不重复 spawn。
- 已连接：会话/消息/日程/最后消息/归档大小统计；QQ/微信来源与同步状态；会话列表（来源筛选 + 关键词过滤）；只读消息气泡（附件只显示大小）；FTS5 trigram 检索（`<<…>>` 命中高亮，点结果回到会话）；议程（逾期/今天/本周）。
- 同步面板：来源勾选、全量重扫、导出知识库、进度条；不自动同步。
- 导航新增「信息中枢」（无数字快捷键，默认排在会话之后）；设置区导航标签同步；`heming.navOrder.v1` 缺失项由 `normalizeNavOrder` 补到默认位置。

### G. 顺带修复：sandbox preload 的版本号

真实 Electron 验证时发现 `sandbox: true` 的 preload **不能 require 本地模块**，原 `require("./app-version")` 使整个 preload 加载失败——所有桥（密钥、通知、更新、导出、Wiki、图表、MCP）在真实桌面端都不存在。改为主进程注册 `app:version` 同步 IPC，preload 用 `sendSync` 读取；拿不到时回落 `0.0.0`。新增源码守卫测试，禁止 preload 再出现本地 require。

## 2. 测试

- Python：`PYTHONPATH=packages/infohub python -m unittest discover -s packages/infohub/tests -p "test_bridge.py" -v`（5 例：ping/status、会话/消息/检索、议程、未知方法、只读不变性）。
- Desktop：`infohub-bridge.test.js` 12 例（协议分帧、路径校验、解释器解析、spawn 参数/env、hello、id 配对、进度订阅、白名单、异常退出、配置切换、IPC 校验/对话框）；preload 新增 4 例（InfoHub 转发、事件订阅、无本地 require、版本同步 IPC）。
- Web：`client.test.ts` 7 例（可用性、事件、配置读写、错误清洗、格式化）；`InfohubPage.test.tsx` 7 例（浏览器降级、连接统计与脱敏、检索高亮、议程重扫、同步参数、断开、连接失败）。
- 全量门禁：`pnpm -r build && pnpm -r --workspace-concurrency=1 test`。
- 真实应用：Electron + 真实归档 `D:/wohaolei` 验证连接、统计、检索命中回会话、议程、脱敏配置与断开；浏览器验证降级页与导航。

## 3. 明确不做

- 不把 InfoHub 改成 TypeScript、不开 HTTP/WS 端口、不把归档上传云端。
- 不在和鸣里重做采集/解密/转写；同步仍调用 InfoHub 原有流水线。
- 不自动启动、不自动同步、不自动连接任何外部渠道。
- 不读取、复制或展示 `config.json` 里的密钥；不做配置编辑界面。
- 不做消息发送/撤回/转发（归档是只读历史）。
- 不新增数字快捷键；不改既有 1–9/0 的页面映射。
