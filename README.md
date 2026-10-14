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

# 终端 C（可选）：桌面壳
HEMING_DEV_URL=http://localhost:5173 pnpm --filter @heming/desktop dev
```

## 测试

```bash
pnpm -r test
pnpm -r typecheck
```

## 结构

- `packages/shared` — 协议类型与 Zod schema（前后端唯一事实来源）
- `packages/server` — Express 5 + WebSocket + 内存存储（M2 换 SQLite）
- `packages/web` — React 18 + Tailwind 三栏 UI
- `packages/desktop` — Electron 壳

设计文档：`docs/superpowers/specs/2026-10-13-heming-platform-design.md`
