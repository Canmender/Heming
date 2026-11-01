# d.45 实施计划 · 信息中枢本机边车

- 日期：2026-11-01
- 规格：`docs/superpowers/specs/2026-11-01-d45-infohub-local-sidecar.md`
- 基线：d.44.1.11.0 → 目标：d.45.1.11.0
- 范围：`packages/infohub`（并入）、`packages/desktop`（桥 + IPC + preload）、`packages/web`（页面/导航）

## 任务

1. **规格**（已完成）
   - `docs/superpowers/specs/2026-11-01-d45-infohub-local-sidecar.md`。

2. **并入 InfoHub 核心**
   - 复制 `infohub/`、`tests/`、`pyproject.toml`、README 到 `packages/infohub`；不复制 `config.json`、`data/`、`.venv/`。
   - `.gitignore` 追加 `__pycache__/`、`*.pyc`、`packages/infohub/config.json`、`packages/infohub/data/`。
   - Python 桥（`infohub/bridge.py`）：
     - 行分隔 JSON；stdout 改指 stderr；
     - 方法白名单 + 参数校验；`sync` 懒加载 `sync_all` / `export_all`；
     - `Store(readonly=True)` 只读浏览；`config.summary` 只返回脱敏信息；
     - hello 握手与 progress 节流事件。
   - `tests/test_bridge.py`：ping/status、会话/消息/检索、议程、未知方法、只读 SHA-256 不变性。

3. **桌面端 stdio 桥**（`packages/desktop/infohub-bridge.js`）
   - 纯函数：包目录解析、默认 home、绝对路径校验、Python 解析、分帧编码/解码、方法校验。
   - `createInfohubBridge`：spawn `[python, "-m", "infohub.bridge"]`（`shell:false`、`windowsHide:true`），env 带 `INFOHUB_HOME` / `PYTHONPATH` / UTF-8；hello 超时 20s；配置变化时重启；退出拒绝 pending。
   - `registerInfohubIpc`：6 个通道 + 方法白名单 + 目录/文件选择器。
   - `main.js` 在 `whenReady` 中创建桥、广播 `infohub:event`、注册 IPC；`will-quit` 调 `dispose()`。
   - `preload.js` 暴露 `__heming_infohub`；`package.json` 的 typecheck/test/build.files/extraResources 接线。

4. **Web 客户端与页面**
   - `lib/infohub/client.ts`：类型、配置读写（`heming.infohub.home.v1` / `python.v1`）、可用性判断、IPC 错误清洗、事件订阅、时间/字节格式化。
   - `components/InfohubPage.tsx`：浏览器降级；连接设置；统计；会话列表/只读消息/检索/议程；同步面板；脱敏配置；错误条。
   - `icons.tsx` 新增 `InfoHubIcon`；`store/ui.ts` 的 `Page` 与默认顺序加 `infohub`；`NavRail` 加无数字项；`SettingsPage` 的 `NAV_LABELS` 补名；`App.tsx` 路由。
   - `types/heming.d.ts` 补 `Window.__heming_infohub`。

5. **修复 sandbox preload**
   - 去掉 `require("./app-version")`；主进程注册 `ipcMain.on("app:version", event => event.returnValue = appVersion())`；preload 用 `sendSync` 读取并回落 `0.0.0`。
   - `preload.test.js` 加「版本同步 IPC」与「禁止本地 require」两例。

6. **测试与门禁**
   - 新增 web client 7 例、页面 7 例；desktop 桥 12 例、preload 4 例；Python 5 例。
   - 更新 `ui.test.ts` / `SettingsPage.test.tsx` 的默认导航顺序期望。
   - 跑 `pnpm -r build && pnpm -r --workspace-concurrency=1 test`。
   - 真实 Electron 连 `D:/wohaolei`：连接 → 255 会话 / 126,085 条消息 / 44.4MB → 检索「免检单」命中并回会话 → 议程 133 条（逾期 121）→ 配置脱敏 → 断开；浏览器验证降级页与导航入口。

7. **收口**
   - `node scripts/bump-version.mjs auto feature` → `d.45.1.11.0`。
   - CHANGELOG 顶部加 d.45 段；`node scripts/build-changelog.mjs`。
   - 更新 `docs/HANDOFF.md`（版本/标签/测试实跑数/里程碑 43/目录结构/存储键）、`docs/INDEX.md`（标题区间与 spec 链接）、`README.md`（能力条目）。
