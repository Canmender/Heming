# 和鸣

原生电脑端智能体应用平台（云端中心化）：IM + 多 Agent 混合框架。

## 能力

- **智能体对话** — 每用户本机配置 LLM（OpenAI 兼容 + Anthropic），Key 仅存本机；群内 @ 触发流式回复；可将自建智能体加入自己创建的群（新建群时勾选，随后群内 @ 即可对话）
- **记忆与技能池** — Hermes 同款三层记忆（工作/情景/语义）按需注入系统提示词，技能池支持新建/导入导出（`SKILL.md`）/按查询路由；记忆区（Alt+4）管理，数据只落本机 `localStorage`，不上云、不进消息
- **上下文预算** — 设置区可对 @ 触发的历史做 token 预算：超出部分压缩为早期对话摘要（可选 LLM 摘要或零成本确定性摘要），供应商报上下文超限时自动收紧预算重试；只在本机执行
- **IM 与主页** — 消息撤回、回复引用、转发、语音消息、表情回应；输入栏表情/图片/文件/语音与附件消息；主页近 30 日 token 用量热力图
- **端到端加密** — 消息与附件端到端加密（前向保密棘轮，服务端只见信封）；本地明文缓存；明文存量自迁移；桌面端安全上下文白名单
- **共享文件** — 云端共享库文件投递到会话、内嵌预览（文本/Markdown/图片）、每用户存储配额（`HEMING_FILE_QUOTA_MB`，默认 200MB）

## 环境

- Node ≥ 24，pnpm ≥ 10

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
- `packages/server` — Express 5 + WebSocket + SQLite 持久化存储
- `packages/web` — React 18 + Tailwind 三栏 UI
- `packages/desktop` — Electron 壳

设计文档：`docs/superpowers/specs/2026-10-13-heming-platform-design.md`

## 数据

服务端数据（账号、会话、消息、已读状态）持久化在 SQLite：

- 库文件路径由 `HEMING_DB_PATH` 指定，缺省 `./data/heming.db`（相对进程工作目录）。
- Docker 部署（见 `docs/deploy.md`）注入 `HEMING_DB_PATH=/data/heming.db`，`/data` 挂 named volume `heming-data`——容器重启、镜像重建、回滚都不丢数据；备份/恢复针对该卷（`docs/deploy.md` §6）。
- 本地开发默认落 `./data/heming.db`，已在 `.gitignore` 排除（`data/`），不进版本库、不进部署包。
