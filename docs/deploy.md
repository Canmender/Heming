# 和鸣部署（Docker，单机）

目标机：`47.92.39.184`（阿里云 Linux x86_64）。架构：**api 容器**（Node 进程，Express + ws 同端口 8787，仅 compose 内网可达）+ **web 容器**（nginx 托管静态资源并反代 `/api` 与 WS，对外发布 80）。

## 0. 前置：服务器装 Docker

```bash
# 最省事（官方脚本，自动识别阿里云 Linux / CentOS 系）
curl -fsSL https://get.docker.com | sh
sudo systemctl enable --now docker

# 验证
docker --version
docker compose version
```

- 阿里云控制台**安全组**只放行 80（HTTP）；需要预览实例时临时放行 8788。
- 非 root 使用 docker：`sudo usermod -aG docker $USER`（重新登录生效）；或全程 sudo。

## 1. 端口表

| 端口 | 归属 | 说明 |
| --- | --- | --- |
| 80/tcp | web 容器 | **对外唯一端口**：静态页 + `/api` 反代 + WS |
| 127.0.0.1:8787 | api 容器（compose 回环映射） | 宿主机回环维护口（**有意发布**，仅本机可达，SSH 隧道调试用；若与宿主进程冲突可整体删除该行，维护改用 `docker compose exec api wget -qO- http://127.0.0.1:8787/api/health`） |
| 8788/tcp | preview 容器（profile） | 更新验证用，`docker compose --profile preview up -d` 才启动，平时不运行 |
| 9090/tcp | （预留） | 监控端口，本套件**不发布**任何监控服务，表内仅作占位说明 |

api 服务本身**不向公网发布端口**（compose 内网互通）；对外流量一律走 80 → nginx。

## 2. 上传代码（本地打包 → 服务器解包）

本地（排除依赖与版本库，镜像内会重建依赖）：

```bash
# 在仓库根目录（data/ 是本地开发库，不上传——服务器用数据卷）
tar --exclude=node_modules --exclude=.git --exclude=.superpowers \
    --exclude=dist --exclude=.worktrees --exclude=data \
    --exclude=release --exclude=.claude \
    -czf heming.tar.gz .
scp heming.tar.gz root@47.92.39.184:~/

# 服务器解包
ssh root@47.92.39.184
mkdir -p ~/heming && tar -xzf ~/heming.tar.gz -C ~/heming && cd ~/heming
```

## 3. 构建与启动

```bash
cd ~/heming
docker compose build
docker compose up -d
docker compose ps          # api healthy、web running 即就绪
```

验证：

```bash
curl -s http://127.0.0.1/api/health          # {"ok":true}
curl -s -i -X OPTIONS http://127.0.0.1/api/auth/login | head -5   # 204 + CORS 头
```

浏览器打开 `http://47.92.39.184`，用预设账号 `admin / admin` 登录。

**nginx 配置无法在本机静态验证**——首次启动务必看日志确认无报错：

```bash
docker compose logs web | tail -50   # 期望无 [emerg]/[error]，只有 "start worker process"
docker compose logs api  | tail -50   # 期望 "heming server listening on http://0.0.0.0:8787"
```

## 4. 增加预设账号

改 `HEMING_SEED_USERS`（逗号分隔 `用户名:密码`）后重新 up（环境变量变化会自动重建 api 容器）：

```bash
HEMING_SEED_USERS="admin:admin,alice:alice123,bob:bob1" docker compose up -d
```

或在仓库根目录放一个 `.env`（docker compose 会自动读取，不含在上传包内）：

```bash
HEMING_SEED_USERS=admin:admin,alice:alice123
# HEMING_ALLOW_REGISTER=1   # 取消注释才放开公开注册（默认关，403）
# HEMING_DB_PATH=/data/heming.db   # 容器内缺省已是此值（见 §4 注意），仅需改动时覆盖
```

注意：

- 播种只在进程启动时执行。数据已由 SQLite 持久化（卷 `heming_heming-data`，容器内 `/data`），容器重启、重建不丢运行期产生的账号、会话与消息（见 §6 备份）。
- 预设群「和鸣交流群」成员在**每次服务启动时补入当前全部账号**（B 语义，幂等）：`HEMING_SEED_USERS` 新增的账号在下一次启动后自动入群；用户自建同名群不会遮蔽预设群（预设匹配只认服务端播种的群）。M3 群管理开放后可调整。
- `HEMING_DB_PATH`：SQLite 库文件路径，缺省 `./data/heming.db`；compose 已注入容器内 `HEMING_DB_PATH=/data/heming.db`（named volume `heming-data` → `/data`），一般无需改动。

## 5. 更新流程与回滚

更新（数据卷不动，即持久）：整个流程只重建镜像与容器，`heming-data` 卷从不删除，SQLite 数据（账号/会话/消息/已读状态）原样保留：

```bash
# 本地重新打包上传解包（§2）
cd ~/heming
docker compose build
docker compose up -d
```

端口冲突排查：若 `up -d` 报 `bind: address already in use`（通常是 127.0.0.1:8787 维护口被宿主进程占用），按 §1 端口表该行的说明整体删除端口映射行即可，**不影响 80 对外服务**，维护改走 `docker compose exec api ...`。

回滚（二选一）：

```bash
# A. 代码回退后重建（上传旧版本包，或服务器上 git 管理时）
git checkout <上一个提交> && docker compose build && docker compose up -d

# B. 镜像 tag 回滚（更新前先打 tag，推荐生产用）
docker tag heming-api:latest heming-api:prev
docker tag heming-web:latest heming-web:prev
# 出问题后：把 compose 的 image 字段指到 heming-api:prev / heming-web:prev，再 up -d
```

数据卷 `heming-data` 在整个过程中不删除、不重建，回滚安全。

镜像名（`heming-api` / `heming-web`）与卷名（`heming_heming-data`）依赖 compose 项目名，**默认等于仓库目录名**；若目录名不是 `heming`、或要在别的路径下操作，统一加 `-p heming` 固定项目名（`docker compose -p heming build/up/tag ...`），否则镜像 tag、§6 备份里的卷名会对不上。

## 6. 备份

数据（SQLite 库 `heming.db`）落在 named volume `heming_heming-data`（容器内 `/data`）。**备份 = 打包该卷**，与代码/镜像无关：

```bash
# 备份（在 /root/heming 执行；文件名带日期）
docker run --rm -v heming_heming-data:/d -v "$PWD":/backup \
  alpine tar czf /backup/heming-data-$(date +%F).tar.gz -C /d .

# 恢复：停服务 → 解包回卷 → 起服务
cd ~/heming && docker compose -p heming stop api
docker run --rm -v heming_heming-data:/d -v "$PWD":/backup \
  alpine tar xzf /backup/heming-data-<日期>.tar.gz -C /d
docker compose -p heming start api
```

卷不删不重建时数据一直在：`docker compose down` 默认保留卷，回滚/更新见 §5。

## 7. CORS 与同源决策

- **同源（默认，Docker 部署）**：浏览器访问 `http://47.92.39.184` 时，页面（nginx:80）与 API（nginx 反代 `/api` → api:8787）**同源**，WS 走 `ws://47.92.39.184/api/ws` 同样被 nginx 反代。因此 **web 镜像构建时不注入 `VITE_API_BASE`**（留空 = 同源相对路径），配置最少、不依赖任何跨域。
- **CORS 兜底**：服务端仍带最小 CORS 头（`Allow-Origin: *`、预检 `OPTIONS` 直接 204），用于直连场景（如本机开发的 web 连远程 api、或桌面壳 file:// 页面）。鉴权是 Bearer token 而非 cookie，`*` 不带来凭据风险；未引入 `cors` 依赖，10 行手写。
- **`VITE_API_BASE` 只服务桌面壳**（`file://` 无同源可用），给桌面打包时单独注入绝对地址即可，与本套 Docker 部署互不影响。

## 8. 预览实例（更新验证）

```bash
docker compose --profile preview up -d     # 启动与 web 同镜像的 preview，端口 8788
curl -s http://127.0.0.1:8788/api/health   # 走同一 api 实例
docker compose --profile preview down      # 验证完关掉
```

用法：新代码上线前先 `docker compose build` 再起 preview，浏览器开 `http://47.92.39.184:8788`（安全组需临时放行 8788）确认无误，再 `docker compose up -d` 切正式 web。

## 9. 资源与运维参考

- 内存上限：api 512M、web/preview 各 128M（compose `deploy.resources.limits`）。
- 重启策略：`unless-stopped`（宿主机重启后自动拉起）。
- 健康检查：api 每 30s `wget http://127.0.0.1:8787/api/health`；web `depends_on` api healthy 后才启动。
- 常用命令：

```bash
docker compose ps
docker compose logs -f api
docker compose restart web
docker compose down            # 停（保留 heming-data 卷）
```
