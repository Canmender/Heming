# 和鸣

原生电脑端智能体应用平台（云端中心化）：IM + 多 Agent 混合框架。

## 环境

- Node ≥ 20，pnpm ≥ 10

## 启动

```bash
pnpm install
pnpm -r build

# 终端 A：云端服务端（http://127.0.0.1:8787）
pnpm --filter @heming/server dev

# 终端 B：前端（Vite，代理 /api 到 8787）
pnpm --filter @heming/web dev

# 终端 C（可选）：桌面壳（本地 dev：加载 Vite 开发服务器，由其代理 /api）
HEMING_DEV_URL=http://localhost:5173 pnpm --filter @heming/desktop dev
```

> 桌面壳（`packages/desktop`）是原生 Electron 外壳，不打包本地 web 产物，直接加载远程页面。加载地址优先级：`HEMING_DEV_URL`（本地开发，如 `http://localhost:5173`）> `HEMING_WEB_URL`（自定义生产地址）> 默认云端 `http://47.92.39.184`。`pnpm --filter @heming/desktop start` 即以默认云端地址启动。

## 打包 Windows 安装包

```bash
# 国内网络需先设置 electron-builder 二进制镜像（NSIS / winCodeSign 下载）
export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
pnpm --filter @heming/desktop dist    # 或根目录：pnpm dist:desktop
```

产物在 `packages/desktop/release/`（NSIS 安装包，`oneClick: false` 可选安装目录，快捷方式名「和鸣」）。暂未配置应用图标，使用 Electron 默认图标，待提供 `.ico` 后补 `build.win.icon`。

## 测试

```bash
pnpm test        # 等价于 pnpm -r build && pnpm -r test
pnpm typecheck   # 等价于 pnpm -r build && pnpm -r typecheck
```

说明：根目录 `pnpm test` / `pnpm typecheck` 会先自动 `pnpm -r build`（`shared` 的类型产物被其他包经 workspace 引用，fresh clone 直接跑测试会因缺 `dist` 失败），再执行各包的 test/typecheck。

## 结构

- `packages/shared` — 协议类型与 Zod schema（前后端唯一事实来源）
- `packages/server` — Express 5 + WebSocket + 内存存储（M2 换 SQLite）
- `packages/web` — React 18 + Tailwind 三栏 UI
- `packages/desktop` — Electron 壳

设计文档：`docs/superpowers/specs/2026-10-13-heming-platform-design.md`
