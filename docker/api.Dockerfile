# syntax=docker/dockerfile:1
# 和鸣 API 镜像：多阶段构建。
# 构建上下文 = 仓库根目录（docker-compose.yml: context: . + dockerfile: docker/api.Dockerfile）。

# ---------------------------------------------------------------------------
# build：安装依赖并编译 @heming/shared + @heming/server
# ---------------------------------------------------------------------------
FROM node:24-alpine AS build

# 固定 pnpm 版本（与 pnpm-lock.yaml 的 lockfileVersion 9.0 同代）。
# 不走 corepack enable：其默认 pnpm 版本未钉死，且历史出现过签名密钥过期
# 导致下载失败的问题；npm 全局安装固定版本行为最可控。
RUN npm install -g pnpm@10.33.2

WORKDIR /app

# 先只拷清单文件以命中层缓存：改源码不触发重装依赖。
# packages/* 的 package.json 全部带上，保证 --frozen-lockfile 校验时
# lockfile 里的 importer 都在（web/desktop 由 --filter 排除不安装）。
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/web/package.json packages/web/package.json
COPY packages/desktop/package.json packages/desktop/package.json

# 只装 server 及其工作区依赖（shared）与它们的传递依赖
RUN pnpm install --frozen-lockfile --filter @heming/server...

# 拷源码并编译（shared 必须先建，server 的 tsc 要读它的 .d.ts）
COPY packages/shared packages/shared
COPY packages/server packages/server
RUN pnpm --filter @heming/shared build \
 && pnpm --filter @heming/server build

# ---------------------------------------------------------------------------
# prod：仅生产依赖，单独阶段安装
# 说明：不用 pnpm deploy / prune（不同 pnpm 大版本行为差异大且受 .npmignore
# 影响），改为按锁文件冻结重装一次 prod 依赖，行为确定、可复现；
# 独立阶段保证最终镜像既无 pnpm 也无 devDeps。
# ---------------------------------------------------------------------------
FROM node:24-alpine AS prod

RUN npm install -g pnpm@10.33.2
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/web/package.json packages/web/package.json
COPY packages/desktop/package.json packages/desktop/package.json

RUN pnpm install --frozen-lockfile --prod --filter @heming/server...

# ---------------------------------------------------------------------------
# run：仅 node + 生产依赖 + 编译产物，非 root 运行（不含 pnpm 等构建工具）
# ---------------------------------------------------------------------------
FROM node:24-alpine AS run

WORKDIR /app

# pnpm 布局是相对 symlink，node_modules 与 packages 同时按 /app 前缀拷入即保持有效
COPY --from=prod /app/package.json ./package.json
COPY --from=prod /app/node_modules ./node_modules
COPY --from=prod /app/packages ./packages
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/server/dist ./packages/server/dist

# M2 排雷：named volume 首次挂载会继承镜像内 /data 的属主，
# 预建为 node:node，避免将来 SQLite 落盘时以 root 属主触发 EACCES
RUN mkdir -p /data && chown node:node /data

# HOST=0.0.0.0：容器内需让 compose 内网的 nginx 反代可达（进程代码本地默认仍是 127.0.0.1）
ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0

USER node
EXPOSE 8787

# dist/index.js 以 .js 结尾，命中入口的 isDirectRun 判断，进程自启动
CMD ["node", "packages/server/dist/index.js"]
