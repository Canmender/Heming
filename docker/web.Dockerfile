# syntax=docker/dockerfile:1
# 和鸣 Web 镜像：**这里不构建前端**。
#
# 为什么不构建（实测代价）：目标机是 2 核 2G 的轻量服务器，`pnpm --filter @heming/web build`
# （tsc + vite）峰值 1.0–1.4G，加上宿主、docker daemon 与 buildkit 已占的 ~500M，
# 就是「勉强能过、随时翻车」。2026-10-21 部署 d.25 时连撞两次：机器整机失联
# （ICMP 通、TCP 能连但 60 秒不回一个字节，异网探针 522），只能控制台重启。
#
# 所以现在由开发机跑 `pnpm --filter @heming/web build`，产物 `packages/web/dist`
# 随部署包一起上传，本镜像只做 nginx 托管——云端构建从分钟级降到秒级，且不吃内存。
# 打包步骤与排除表见 docs/deploy.md §2 与 §12。
#
# 缺 dist 时 `COPY` 直接失败并指出路径，不会静默产出空站点镜像。
FROM nginx:alpine

COPY docker/web-nginx.conf /etc/nginx/conf.d/default.conf
COPY packages/web/dist /usr/share/nginx/html
