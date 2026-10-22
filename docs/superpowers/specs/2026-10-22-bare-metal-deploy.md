# 和鸣 · 云端裸机部署（去 Docker）· 设计文档

- 日期：2026-10-22
- 状态：**已实施**（d.25.1.6.0 上线即采用本方案，`docs/deploy.md` 已改写为裸机流程）
- 关联：`docs/deploy.md`（runbook）、`2026-10-18-embed-web-in-client-design.md`（UI 随包发布，云端只当 IM 桥梁）、`2026-10-13-heming-platform-design.md`（架构红线）

---

## 1. 动机

目标机是阿里云**轻量应用服务器：2 vCPU / 1613MB 内存 / 40GB 磁盘**，最初无 swap。发 d.25 时在 Docker 路径上连撞两次整机失联：

| 次序 | 触发 | 现象 |
|---|---|---|
| ① | web 镜像内跑 `tsc+vite`（峰值 1.0–1.4GB） | ICMP 通、TCP 握手成功但 60 秒零字节；异网探针 522 |
| ② | 只是跑了 `docker builder du` / `docker system df` 做诊断 | 同上，当时并没有在构建 |

两次都只能控制台重启，第二次之后源 IP 还被云盾的爆破防护临时封了 22 端口（`Error reading SSH protocol banner`，而 80 正常），部署彻底卡住。最终用户把实例**重置为 Ubuntu 24.04**（连带 Docker、镜像、卷与生产数据全部消失），并要求换更简单的路子。

根因不是「Docker 慢」而是**常驻开销叠在峰值上**：dockerd + containerd + buildkit 静态占 ~500MB，剩给构建的余量不足 1.1GB，任何一项把它顶穿就是整机冻住——不是 OOM killer 杀进程（那只会失败一次），而是可中断上下文之外的内存回收把用户态拖死。

## 2. 决策

**云端只跑两样东西：`node` 进程（systemd 托管）+ 宿主机 nginx。** 去掉 Docker、去掉镜像、去掉云端构建。

三个推论：

1. **本机构建什么，就发什么**。部署包直接带 `packages/{shared,server}/dist` 与 `packages/web/dist`——即本地门禁 `pnpm -r build` 的原样产物。云端只做「装生产依赖 + 摆文件 + 起服务」。
2. 这条同时解决了「云端构建的产物 ≠ 本机验证过的产物」这类不一致，且服务器 CPU/内存负担降到接近零：`pnpm install --prod --filter @heming/server...` 与一次 SQLite 建表就是全部工作。
3. 部署脚本入库（`deploy/`），不再依赖任何一台特定开发机上的 Python 编排；编排脚本本身留在 `.superpowers/`（含凭据，gitignored）。

## 3. 目标形态

```
浏览器 / 桌面客户端
   └─ http://47.92.39.184:80  ← 宿主机 nginx（唯一对外端口）
        ├─ /            → /opt/heming/app/packages/web/dist（SPA，try_files 回落 index.html）
        ├─ /api/        → 127.0.0.1:8787（反代，原样透传路径）
        ├─ = /api/ws    → 127.0.0.1:8787（HTTP/1.1 + Upgrade，精确匹配优先）
        └─ /updates/    → alias /opt/heming/updates/（自动更新源；必须排在 location / 之前）

heming-api.service（User=heming，HOST=127.0.0.1，只绑回环）
   ├─ EnvironmentFile=/etc/heming/api.env
   ├─ ExecStart=/usr/local/bin/node packages/server/dist/index.js
   └─ 写盘只有一处：/var/lib/heming（SQLite 库 + WAL；附件是库内 base64，无独立文件目录）
```

| 落点 | 内容 |
|---|---|
| `/opt/heming/app` | 解包后的仓库（含 `node_modules` 与 dist） |
| `/opt/heming/updates` | 安装包 + `latest.yml` + `.blockmap` |
| `/opt/heming/keep` | 每一版的原始部署包 —— 裸机没有镜像 tag，回滚就是拿旧包重放 |
| `/var/lib/heming` | `heming.db`（唯一需要备份的路径） |
| `/etc/heming/api.env` | 环境变量（640，provision 只在缺失时创建） |
| `/etc/nginx/sites-available/heming` | 站点配置，由 `install-app.sh` 从包内 `deploy/` 落地 |

## 4. 版本与端口

- **Node 24**：根 `package.json` 要求 `engines.node >= 24`，Ubuntu 24.04 的 apt nodejs 是 18.x，不可用。走 npmmirror 官方二进制包解到 `/usr/local/lib/nodejs/`，软链进 `/usr/local/bin`；`pnpm@10.33.2` 与 `docker/*.Dockerfile` 钉同一代（lockfileVersion 9.0）。
- **swap 属于配置**：裸机方案里把 2G `/swapfile` 写进 `/etc/fstab`（Docker 时代的部署脚本刻意只临时挂、重启即失效；那是把 swap 当「本机临时变更」，现在它是服务器配置的一部分）。`vm.swappiness=15` 只写运行时，不持久化到 `/etc/sysctl.d/`——它不是正确性依赖，只是让回收更早开始。

## 5. 红线与明确不做

- **不给这台机装回 Docker**：常驻开销与本机无关的收益不成比例，且镜像层把「哪个文件在跑」藏起来，排查失联时反而更慢。
- **不在云端跑 vite/tsc**：见 §1；`install-app.sh` 发现产物缺失直接失败，不会退化成「云端帮你补一次构建」。
- **`docker/`、`docker-compose.yml` 保留但停用**：删除它们会让 `docs/deploy.md` 引用的 `web-nginx.conf` 与更新源顺序说明失去出处；两处硬约束（`/updates/` 顺序、WS 的 HTTP/1.1+Upgrade）在新旧两份配置里都必须同时成立。将来确认不再回退时一并清理。
- **不引入 HTTPS**：更新源与页面均无机密性要求（鉴权是 Bearer token，E2E 在应用层），证书续期对单人运维是净负担。桌面端因 `app://` 已注册为 secure context，不受影响。
- `deploy/**` 必须 LF：`core.autocrlf=true` 的 Windows 检出会把 `set -o pipefail\r` 变成语法错误，已写进 `.gitattributes`。

## 6. 发布 / 回滚 / 备份

```bash
# 发布（本地）
pnpm -r build                                   # 门禁产物，云端跑的就是它
tar ... -czf /tmp/heming-<版本>.tar.gz .         # 排除表见 docs/deploy.md §2，两条校验必做
# 服务器：一次性 provision.sh（已完成）→ 每次发版只需
bash /root/install-app.sh /root/heming-<版本>.tar.gz <版本>

# 回滚
bash /opt/heming/app/deploy/install-app.sh /opt/heming/keep/heming-<旧版本>.tar.gz <旧版本>

# 备份（唯一需要备份的东西）
systemctl stop heming-api && tar czf /root/heming-data-$(date +%F).tar.gz -C /var/lib/heming . && systemctl start heming-api
```

`install-app.sh` 是幂等的：解包覆盖、`daemon-reload` + `restart`、`nginx -t` 通过才 reload（校验失败自动把 default 站点放回去并退出），最后轮询 `/api/health` 30 秒；不通就把 `journalctl -u heming-api -n 40` 打进日志。

## 7. 本轮数据后果（不可逆，已发生）

实例重置清空了 SQLite 库与两份卷备份（原在 `/root/heming`），本机只存过部署包、没有 `heming.db` 副本。上线后服务器是全新库：只有 `HEMING_SEED_USERS=admin:admin` 预设账号与预设群，历史账号、会话与消息全部不存在。备份纪律（§6）自此成为发版流程的一部分。
