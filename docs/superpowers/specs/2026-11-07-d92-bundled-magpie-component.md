# d.92 内置 magpie：把模型网关做成随包托管的原生组件

- 日期：2026-11-07
- 版本：`d.92.2.42.0`（特性 +1）
- 分支：`feat/d77-heming-core`
- 承接 d.90（模型层改为只连 magpie 网关）与 d.91（设置页网关卡）：本轮把「magpie 本体」也做成
  和鸣自己的组件——安装包自带 CLI，主进程负责启动/探活/回收，渲染层走带 CORS 的本机反代。

## 0. 一句话

```
安装包 → resources/magpie/magpie-cli.exe（构建时下载 + SHA256 校验）
主进程 → 启动 `magpie serve`；GET /api/hello 就绪；退出时整树回收
反代   → 127.0.0.1:<随机端口>：只接受和鸣本机页面来源，去掉 Origin/Referer 转发给 3425
渲染层 → preload __heming_magpie：status / start / stop / gateway；自动采用反代 baseUrl
```

## 1. 二进制与构建

- 官方 Windows CLI 单文件约 70MB，**不进仓库**：`scripts/fetch-magpie.mjs`
  - 钉版本 `v0.1.3246`（`HEMING_MAGPIE_VERSION` 可覆盖），下载 release 资源 + `SHA256SUMS` 并校验；
  - Node 自带 CA 在部分 Windows 机器上不认 GitHub 证书，脚本失败时回落系统 `curl`（仍是只读下载）；
  - 落点 `packages/desktop/resources/magpie/magpie-cli.exe`（gitignore，只留 `.gitkeep`）；
  - `--check` 供发布前自检；`--force` 重下。
- `scripts/build-desktop.mjs` 打包前强制 `--check`，缺失就自动下载；失败中止打包
  （**安装包不能缺模型网关**）。
- electron-builder：`extraResources` 把 `resources/magpie` 打进 `resources/magpie/`；
  `build.files` 增加 `magpie-host.js` / `magpie-proxy.js`。

## 2. 主进程托管（`packages/desktop/magpie-host.js`）

- `resolveBinaryPath`：打包态 `resources/magpie/…`、开发态 `packages/desktop/resources/magpie/…`、
  `HEMING_MAGPIE_BIN` 可覆盖；找不到时启动给出可执行提示；
- `start()`：spawn `magpie serve`（`windowsHide`、POSIX `detached` 便于整组回收），
  轮询 `/api/hello` 就绪（默认 30s，拿到版本），超时/失败时带出 stderr 尾巴并回收进程；
- `stop()`：Windows `taskkill /T /F`、POSIX 进程组信号，8s 后放弃（**退出流程不能被卡死**）；
- `status()`：available / running / port / version / binaryPath / lastError / stderrTail；
- 并发 `start()` 复用同一个 Promise；应用 `will-quit` 进入既有子进程回收闸。

## 3. 本机反代（`packages/desktop/magpie-proxy.js`）

为什么需要：magpie 的 Origin 策略默认拒绝网页跨源请求，而渲染层也不能自己起 HTTP 服务。

- 随机端口、只监听 `127.0.0.1`；
- 来源白名单：`app://heming`、`http://localhost:<port>`、`http://127.0.0.1:<port>`；其余 Origin 403；
- 转发前去掉 `Origin`/`Referer`/`Host`，补 `Host` 指向上游；
- 响应补 CORS 头；SSE 直接 pipe（不缓冲，聊天流式不受影响）；
- 上游不可用 → 502 + 人话错误。

## 4. 渲染层接入

- preload 暴露 `__heming_magpie`（status/start/stop/gateway），通道全部登记在 `TRUSTED_CHANNELS`；
- `lib/magpieHost.ts`：桥探测、`resolveDesktopGateway()`（没运行就先启动）、`ensureDesktopGateway()`
  （幂等；取反代地址 → `store.adoptDesktopGateway` → 刷新模型目录；失败静默返回原因）；
- store 的网关配置增加 `source: "desktop" | "manual"`：**桌面反代地址自动采用且可随端口变化更新；
  用户手填的网关永不覆盖**；
- `App` 启动时调用一次 `ensureDesktopGateway()`（浏览器无桥 → 直接 no-op）；
- 设置页 `MagpieGatewayCard` 增加「内置 magpie」区块：运行状态/版本/反代端口、启动/重启、停止；
  手填地址收进「高级：手动指定网关（远端 magpie / 自装）」折叠区。

## 5. 验证

- 桌面端 `node --test magpie-host.test.js magpie-proxy.test.js`：6 + 8 例（路径解析、spawn/就绪/超时回收/
  并发去重、Origin 白名单、请求头清洗、GET/POST/SSE 转发、403/502）；
- 主进程/预加载既有守卫测试通过（新增通道均在 `TRUSTED_CHANNELS`，preload 暴露的桥被登记）；
- 渲染层 `magpieHost` 7 例（无桥退化、未安装提示、启动取址、采用反代地址、manual 不覆盖）；
  `MagpieGatewayCard` 新增 2 例（内置状态/停止、浏览器不渲染内置区块）；store 增 1 例（source 语义）；
- 真实二进制（若本机网络允许下载）：`magpie serve` 起在 3425，反代 `GET /v1/models` 200/401 行为与预期一致，
  `magpie-host` 的 status/stop 实测（见交付报告）。

## 6. 边界与未做

- 只支持随包托管「本机回环」；远端已共享的 magpie 仍走设置页手填地址 + 网关 Key；
- 不读写 magpie 的账号/配置，不做账号 OAuth 导入（那是 magpie 自己的界面）；
- 二进制升级跟随 `HEMING_MAGPIE_VERSION`，与和鸣版本解耦；安装包体积 +约 73MB；
- macOS/Linux 安装包未在项目发布范围内（脚本可下载对应资源，但未做签名/公证）；
- 代理未做鉴权（仅回环 + 来源白名单）；magpie 网关 Key 仍由渲染层携带并转发。
