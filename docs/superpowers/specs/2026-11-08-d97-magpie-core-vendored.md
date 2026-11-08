# d.97 模型网关内核改为「复用 magpie 源码、自己编译」——不是插件，也不是别人的安装包

- 日期：2026-11-08
- 版本：`d.97.2.42.0`（特性 +1）
- 范围：只动模型接入（magpie 内核），不涉及信息采集插件等其它能力。

## 1. 为什么改

d.92 的实现是「构建时下载 magpie 官方 CLI（约 73MB）+ SHA256 校验，随安装包分发」。
这能满足「装完就能用」，但不符合产品要求：

- **不是复用代码，而是分发别人的安装包**：仓库里只有下载脚本，出问题无法改、无法审计；
- 与「内化为和鸣原生能力」的方向相悖：模型网关应当是我们自己的组件。

d.97 改为：**把 magpie 的 MIT 源码裁剪后放进本仓库，由本仓库的构建脚本编译成和鸣自己的内核**。

## 2. 做法

### 2.1 vendored 源码

- 上游：`github.com/yetone/magpie`，标签 `v0.1.3246`（MIT）；
- 位置：`vendor/magpie-core/`，含 `LICENSE`、`THIRD_PARTY_NOTICES`、`PROVENANCE.md`（来源/裁剪口径/升级步骤）；
  **该目录不入库**（`.gitignore`）：它只是编译 `magpie-core.exe` 的输入，且含随 Gemini CLI / Antigravity 分发的 OAuth client 凭据，
  GitHub 密钥扫描会拦下整条历史。构建机本地放好源码后，`scripts/build-magpie-core.mjs` 照常工作；
- 裁剪：去掉 `site/`、`docs/`、`native/`、`build/`、全部 `*_test.go`、`testdata/`、`internal/gui/tests/`、
  上游 README/Dockerfile/Makefile/CI —— 与本应用（只跑 `magpie serve` 网关）无关；
- 保留：`main.go`、`internal/**`（含 `internal/gui` 的少量辅助函数引用与内置插件注册表 `plugins/`）。

### 2.2 构建

- 新增 `scripts/build-magpie-core.mjs`：`CGO_ENABLED=0 go build -tags nogui -trimpath -ldflags "-s -w -X main.version=<上游版本>-heming.<应用版本>"`，
  产物 `packages/desktop/resources/magpie/magpie-core.exe`（gitignore；仓库只有源码）；
- `--check` 判断「产物是否存在且不比源码旧」；`--force` 强制重建；
  需要 Go ≥ 1.26.8（上游 `go.mod` 要求），依赖从 Go module proxy 获取（可用 `HEMING_GOPROXY` 指定镜像）；
- `scripts/build-desktop.mjs` 打包前置检查改为调用它：缺/旧就现场构建，失败中止打包；
- 删除 `scripts/fetch-magpie.mjs`（不再下载任何官方二进制）。

### 2.3 运行时不变

主进程托管、`/api/hello` 探活、本机反代、渲染层桥、设置页「内置 magpie」区块、
「本机已有 magpie 在跑就直接接入」全部沿用 d.91/d.92/d.95 的设计；只是内核换成了我们自己编译的
`magpie-core.exe`，`/api/hello` 的 version 形如 `0.1.3246-heming.d.97.2.42.0`，可据此确认是自家内核。

## 3. 边界（如实说明）

- **它仍是独立的 OS 进程**：Go 代码无法在 Electron 主进程里直接跑，所以是「随本体发布的内部内核」
  （由主进程托管、不通过插件系统、不出现在插件列表），不是 JS 同进程模块；
- `internal/gui` 的网页/托盘界面不参与构建产物（`nogui`），本项目只用其网关与 CLI 能力；
- 构建机需要 Go 工具链与首次依赖下载；终端用户不需要任何 Go/magpie 安装。

## 4. 验证

- vendored 源码可独立构建：`node scripts/build-magpie-core.mjs --force` → 产物约 69MB；
- 自建内核真实启动：`magpie-core.exe serve` → `/api/hello` 返回 `{"name":"magpie","version":"0.1.3246-heming.d.97.2.42.0"}`，
  `/v1/models` 200；
- host/反代链路、采用已有实例、设置页文案用例沿用并通过；
- 桌面应用真启动：主进程自动拉起自建内核并打印 `[magpie] 就绪`，退出后端口释放。
