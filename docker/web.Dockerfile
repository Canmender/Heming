# syntax=docker/dockerfile:1
# 和鸣 Web 镜像：构建阶段跑 vite build，运行阶段用 nginx 托管静态页并反代 /api。
# 构建上下文 = 仓库根目录（docker-compose.yml: context: . + dockerfile: docker/web.Dockerfile）。

# ---------------------------------------------------------------------------
# build
# ---------------------------------------------------------------------------
FROM node:20-alpine AS build

# 版本与 api.Dockerfile 保持一致（理由见该文件注释）
RUN npm install -g pnpm@10.33.2

WORKDIR /app

# 清单先拷以命中层缓存；package.json 全带，配合 --frozen-lockfile 校验
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/web/package.json packages/web/package.json
COPY packages/desktop/package.json packages/desktop/package.json

# web 连同其工作区依赖（shared）安装；vite/tsc 等 devDependencies 必须保留
RUN pnpm install --frozen-lockfile --filter @heming/web...

# 不注入 VITE_API_BASE：浏览器访问 http://47.92.39.184 时页面与 API 同源
# （都经 nginx:80），空 base 即走同源相对路径 + nginx 反代；只有桌面壳
# （file://）才需要绝对地址，见 docs/deploy.md「同源决策」。
COPY packages/shared packages/shared
COPY packages/web packages/web
RUN pnpm --filter @heming/shared build \
 && pnpm --filter @heming/web build

# ---------------------------------------------------------------------------
# run：nginx 托管静态文件 + 反代 /api 与 WS
# ---------------------------------------------------------------------------
FROM nginx:alpine AS run

COPY docker/web-nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/packages/web/dist /usr/share/nginx/html
