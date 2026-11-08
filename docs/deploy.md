# 和鸣部署（裸机，单机）

目标机：`47.92.39.184`（阿里云轻量应用服务器，Ubuntu 24.04，2 vCPU / 1613MB / 40GB）。

架构：**宿主机 nginx（对外唯一端口 80）+ 一个 node 进程（systemd 托管，只绑 127.0.0.1:8787）**。没有 Docker、没有镜像、**云端不构建任何东西**——本地门禁产物是什么，线上跑的就是什么。

为什么去掉 Docker：见 `docs/superpowers/specs/2026-10-22-bare-metal-deploy.md`。一句话：dockerd + containerd + buildkit 常驻约 500MB，叠上构建峰值把这台 1613MB 的机器整机冻住过两次。

脚本都在 `deploy/`（**必须 LF**，已由 `.gitattributes` 的 `deploy/** text eol=lf` 钉住；CRLF 会让 bash 报语法错误、让 systemd 把 `\r` 当成参数的一部分）：

| 文件 | 跑几次 | 干什么 |
|---|---|---|
| `deploy/provision.sh` | 装机时一次 | apt 包、2G swap（写 fstab）、Node 24 + pnpm、`heming` 账号与目录、`/etc/heming/api.env` |
| `deploy/install-app.sh` | **每次发版** | 存档 → 解包校验 → 装生产依赖 → 落 nginx 站点与 systemd 单元 → 起服务 → 自检 |
| `deploy/nginx-heming.conf` | 随包落地 | 站点：静态页 + `/api` 反代 + WS + `/updates/` |
| `deploy/heming-api.service` | 随包落地 | api 进程：`User=heming`、`MemoryMax=512M`、只写 `/var/lib/heming` |

## 1. 端口与落点

| 端口 | 归属 | 说明 |
| --- | --- | --- |
| 80/tcp | 宿主 nginx | **对外唯一端口**：静态页 + `/api` 反代 + WS + `/updates/` |
| 127.0.0.1:8787 | `heming-api.service` | 只绑回环（`HOST=127.0.0.1`），公网不可达；调试走 SSH 隧道 |

阿里云控制台**安全组只放行 80**。api 进程不对公网发布端口，对外流量一律走 80 → nginx。

| 落点 | 内容 |
|---|---|
| `/opt/heming/app` | 解包后的仓库（含 `node_modules` 与 `packages/*/dist`） |
| `/opt/heming/updates` | 自动更新源：安装包 + `latest.yml` + `.blockmap`（§9） |
| `/opt/heming/keep` | **每一版的原始部署包**——裸机没有镜像 tag，回滚靠它 |
| `/var/lib/heming` | `heming.db`（唯一需备份的路径；附件是库内 base64，没有独立文件目录） |
| `/etc/heming/api.env` | 环境变量，`chmod 640`，provision 只在缺失时创建（§4） |

## 2. 打包上传（本地）

云端不跑 vite，**前端产物必须在本地先出**，忘跑就得到一个空站点：

```bash
# 1) 产物 = 门禁产物：web 给 nginx，shared/server 给 node 进程
pnpm -r build
```

> ★ **同一轮里既出安装包又上云时的顺序陷阱**：`scripts/build-desktop-web.mjs` 会**就地重写 `packages/web/dist`**（注入 `VITE_API_BASE=http://47.92.39.184`），再拷进 `packages/desktop/web-dist`。所以先跑桌面打包、后跑上面的 tar，上云的就是那份写死绝对地址的产物——今天云端恰好就是这个 IP，看不出问题；换成域名 + HTTPS 那天就会变成前端打不开。两处都发时：**云端 tar 用 `pnpm -r build` 之后立刻打**，或者打完桌面包后重跑一次 `pnpm --filter @heming/web build` 再打 tar。校验口径：云端产物与安装包内嵌产物**主 bundle 文件名应当不同**（d.29.1.8.0 实测云端 `index-Dx-9oEL6.js` 1439212 字节 vs 安装包 `index-BZWAOsNB.js` 1439231 字节，多出的 19 字节正好等于注入的 `http://47.92.39.184` 字面量长度，grep 该 IP 云端命中 1 次、安装包命中 2 次；打完包重跑云端口径构建会**复现出与线上同名同字节**的 bundle，可据此确认没有误传注入版——本轮 15:25 重跑后本机 `packages/web/dist` 正是 1439212 字节，`curl` 线上同名文件也是 1439212 字节）。

```bash
# 2) 打包（在仓库根目录；data/ 是本机开发库，不上云）
#
# 排除表**逐项写全路径**，别再用裸 `--exclude=dist`：
#   tar 的 --exclude 只匹配路径段名，`--exclude=dist` 会把必须上传的
#   `packages/web/dist` 与 `packages/{shared,server}/dist` 一起排掉。
# 其余几个易漏的大体积产物：
#   packages/desktop/web-dist —— 桌面壳嵌入用产物（注入了 VITE_API_BASE，绝不能上云）
#   packages/desktop/runtime —— 内置 Python + MCP 运行时（约 378MB），只打进安装包
#   release —— 桌面安装包产物
#   @hemingdesktop —— electron-builder 偶发落在仓库根的产物目录（约 260MB！）
#   data .tmp .workbuddy —— 本机开发库 / 临时目录 / 项目记忆
#
# 产物**写到树外**（/tmp）：`-czf heming.tar.gz .` 会把正在增长的 tar 自己
# 卷进归档，GNU tar 报 `tar: .: file changed as we read it` 并以 exit 1 结束。
tar --exclude=node_modules --exclude=.git --exclude=.superpowers \
    --exclude=.worktrees --exclude=data \
    --exclude=release --exclude=.claude --exclude=.tmp --exclude=.workbuddy \
    --exclude='packages/desktop/runtime' \
    --exclude='packages/desktop/web-dist' \
    --exclude='@hemingdesktop' \
    -czf /tmp/heming.tar.gz .

# 3) 两条校验，一条都不能省
# ① 不该有的东西：结果必须为 0（曾经漏排 @hemingdesktop，把包从 0.7MB 撑成 111MB）
tar -tzf /tmp/heming.tar.gz | grep -cE \
  "node_modules|\.superpowers|@hemingdesktop|release/|\.tmp/|\.workbuddy|packages/desktop/(runtime|web-dist)"
# ② 必须有的东西：结果必须 ≥1（空站点/缺 dist 不报错，只会线上白屏——比缺文件更难查）
tar -tzf /tmp/heming.tar.gz | grep -c "packages/web/dist/index.html"
tar -tzf /tmp/heming.tar.gz | grep -c "packages/server/dist/"
```

①返回非 0 时**先看具体是哪几行**再决定：`tar -tzf /tmp/heming.tar.gz | grep -E "……"`。目录名命中不等于有问题（例如 `.workbuddy/` 只是几个 md），关键是**别漏排大体积产物**。包体积 **5MB 量级**（含前端产物）是预期的，变成几十 MB 就是排除表漏了。

> ★ **排除项必须用裸段名，不能带 `./` 前缀**（d.30 实测踩过）：
> `--exclude='./node_modules'` 这种写法**一条都不生效**——tar 的 `--exclude` 匹配的是路径段名，
> 不认 `./` 前缀。包会从 5.6MB 撑到 **2.19GB**（把 `packages/desktop/release` 里的历史安装包全卷进去），
> 而上传命令照样「成功」，要等远端解包才炸。
> 打完先看体积：5MB 量级才对；几十 MB 以上先查排除表，别急着上传。

上传：本机没有 `sshpass`/`plink`，密码认证只能走 paramiko。`.superpowers/deploy-bare.py` 是分步编排（凭据从同目录 `deploy-d21.py` 读，不入库、不回显），各步可单独重跑：

```bash
python -u .superpowers/deploy-bare.py probe      # 机器现状
python -u .superpowers/deploy-bare.py upload "<本地 tar 的绝对路径>"
```

## 3. 装机与发版（服务器）

```bash
# 一次性装机（幂等；已装好的 Node 不会重下）
bash /root/provision.sh            # 结尾打印 PROVISION DONE

# 每次发版
mkdir -p /opt/heming/app /opt/heming/keep
bash /root/install-app.sh /root/heming-<版本>.tar.gz <版本>   # 结尾打印 INSTALL DONE: <版本>
```

`install-app.sh` 做的事：把原始包存档到 `/opt/heming/keep/heming-<版本>.tar.gz` → 解包并校验（包内 `hemingVersion` 与参数一致，`web/dist/index.html`、`server/dist/index.js`、`shared/dist/index.js` 缺一即停）→ `pnpm install --frozen-lockfile --prod --filter @heming/server...`（实测 67 个包、3 秒）→ `chown -R heming` + `chmod -R a+rX packages/web/dist`（nginx worker 是 www-data，要能遍历并读取）→ 落站点与单元 → 轮询 `/api/health` 30 秒。

**nginx 站点的落地方式**：先把 Ubuntu 默认站点移到 `/root/nginx-default-site.bak`（两份 `default_server` 会让 `nginx -t` 直接失败），`nginx -t` 通过才 reload；校验失败会把默认站点放回原处再退出，不会留下半套配置。

浏览器打开 `http://47.92.39.184`，用预设账号 `admin / admin` 登录。验证：

```bash
curl -s http://127.0.0.1:8787/api/health          # {"ok":true}
curl -s http://127.0.0.1/api/health               # 经 nginx
curl -s -i -X OPTIONS http://127.0.0.1/api/auth/login | head -5   # 204 + CORS 头
journalctl -u heming-api -n 30 --no-pager         # "heming server listening on http://127.0.0.1:8787"
nginx -T | grep -c 'location /updates/'           # 站点配置真的生效了
```

**WS 别用 curl 验**：握手不靠 URL 里的 token，而是连上后**首帧**发 `{type:"auth",token}`。
连上但不发 auth 帧时，服务端会在超时后主动断开（d.30 起），
nginx 可能报 `502 upstream prematurely closed`——看着像反代坏了，其实正常。
要验就带真 token 完成一次握手，例如用 `websockets` 连 `ws://47.92.39.184/api/ws`，
再发一帧 `{"type":"auth","token":"…"}`，收到服务端回执（哪怕是不认识的事件报 `bad_event`）就说明握手与事件管线都通。

> **d.30 的鉴权口径**：新客户端一律走首帧 auth，**URL 里不再带 token**
> （query 会进 nginx access_log 与任何中间代理日志）。
> 服务端**仍兼容** `?token=`（旧版桌面安装包在服务端升级后仍能连），
> 该兼容路径要等所有在网客户端都升级后再删。
> 站点配置已给 `= /api/ws` 加 `access_log off`，兜住「握手 URL 可能带 token」这件事。

## 4. 环境变量与预设账号

全部配置在 `/etc/heming/api.env`（改完 `systemctl restart heming-api` 生效）：

```bash
NODE_ENV=production
HOST=127.0.0.1            # 只绑回环，对外一律经 nginx:80
PORT=8787
HEMING_DB_PATH=/var/lib/heming/heming.db
HEMING_SEED_USERS=admin:admin
# HEMING_ALLOW_REGISTER=1   # 取消注释才放开公开注册（默认关，403）
# HEMING_FILE_QUOTA_MB=200   # 每用户共享文件存储配额（MB），超限上传 413 quota_exceeded
# HEMING_STUN / HEMING_TURN_URL / HEMING_TURN_USERNAME / HEMING_TURN_CREDENTIAL   # 语音通话需公网 TURN 时才配
```

服务端读到的环境变量就这些（`HOST`、`PORT`、`NODE_ENV`、`HEMING_DB_PATH`、`HEMING_SEED_USERS`、`HEMING_ALLOW_REGISTER`、`HEMING_FILE_QUOTA_MB`、`HEMING_STUN`、`HEMING_TURN_*`）。

加预设账号直接编辑该文件的 `HEMING_SEED_USERS`（逗号分隔 `用户名:密码`）后重启。注意：

- **`provision.sh` 只在 `/etc/heming/api.env` 不存在时创建它**——里面可能已被手工改过，重装不覆盖。
- 播种只在进程启动时执行。数据由 SQLite 持久化在 `/var/lib/heming`，重启与重发版都不丢运行期产生的账号、会话与消息（备份见 §6）。
- 预设群「和鸣交流群」成员在**每次服务启动时补入当前全部账号**（B 语义，幂等）：`HEMING_SEED_USERS` 新增的账号在下一次重启后自动入群；用户自建同名群不会遮蔽预设群（预设匹配只认服务端播种的群）。群管理开放后可调整。
- `HEMING_FILE_QUOTA_MB`：每用户共享文件配额（MB，缺省 200，解析失败/≤0 回退 200）；超限上传 413 `quota_exceeded`，前端右栏目录头部显示已用/总量。
- `HEMING_TURN_*`：**d.30 起 `/api/ice-servers` 已加鉴权**（未带 token 一律 401）。
  TURN 凭据不再对未登录者可读，但前提是**客户端带 token 去拉**——渲染层登录后自动拉一次（`packages/web/src/lib/iceServers.ts`）。
  旧版桌面安装包（d.29 及以前）由主进程代拉、无 token，会拿不到 ICE 而回落公共 STUN；
  自动更新到 d.30 后即恢复正常。TURN 配不配都不影响登录与聊天。

### 4.1 插件目录（d.88 云端分发 · d.94 界面插件包）

插件包（信息采集 / magpie 网关 / 桌宠等）**不随安装包分发**，由服务端目录提供：

```bash
# 1) 本机把仓库里的插件包摆成服务端布局（声明式包 = 原样 plugin.json）
node scripts/publish-plugin.mjs plugins/            # 缺省写到 ./plugins-catalog

# 1b) 界面插件（d.94，带代码与资源）：先构建 → 再发布成 plugin.json + package.tgz
node scripts/build-pet-widget.mjs
node scripts/pack-plugin.mjs packages/pet-widget/dist/package     # → dist/package.tgz（确定性 sha）
node scripts/publish-plugin.mjs packages/pet-widget/dist/package  # → plugins-catalog/heming.pet/1.0.0/{plugin.json,package.tgz}

# 2) 同步到服务器（沿用现有部署账号；只读发布，不含用户数据）
scp -r plugins-catalog/* root@<server>:/opt/heming/plugins/
# 3) api.env 指到该目录并重启
echo 'HEMING_PLUGIN_DIR=/opt/heming/plugins' >> /etc/heming/api.env
systemctl restart heming-api
curl -s http://127.0.0.1:8787/api/plugins | head -c 300   # 应看到插件列表（bundle 条目带 package.sha256）
```

- 目录布局：`/opt/heming/plugins/<插件 id>/<版本>/plugin.json`，界面插件另有 `package.tgz`；
  同 id 多版本时目录接口只返回最新版；
- 接口公开（不含用户数据）：`GET /api/plugins`（条目含 `distribution` 与 `package{sha256,size}`）、
  `GET /api/plugins/:id/:version/manifest`（带 `X-Plugin-Sha256`）、
  **`GET /api/plugins/:id/:version/package`（带 `X-Plugin-Package-Sha256`，仅 `distribution:"bundle"`）**；
- 客户端下载后**自行校验 sha256**（清单与整包各一次），不一致拒绝安装；服务端只搬运、不解析执行；
- **版本门槛**：`package` 路由需要服务端 ≥ d.94；桌面客户端 ≥ d.94 才有「桌面小组件」安装入口；
  声明式清单仍只接受 v1/v2/v3（v4 的模型预设已在 d.90 收回），v4 现在的唯一用途是界面插件；
- 界面插件安装落点是客户端 `<userData>/plugins/<id>/<版本>/`（服务端不保存插件运行期数据），
  卸载/升级由客户端管，服务端只负责「有哪些包、哪个版本、指纹多少」。

## 5. 回滚

```bash
# 拿上一版的原始包重放即可（每版都留在 keep/ 里）
ls -la /opt/heming/keep
bash /opt/heming/app/deploy/install-app.sh /opt/heming/keep/heming-<旧版本>.tar.gz <旧版本>
```

`/var/lib/heming` 全程不动，回滚不涉及数据。`/opt/heming/keep/` **不清理**：服务器回滚依赖它（40G 磁盘、每包约 17MB，留得起）。
注意与「更新源（`/opt/heming/updates/`）」区分：后者只保留最近 2 版安装包即可（客户端回滚够用），2026-11-04 已按此清理过一次（5 版 1.1G → 2 版 436M）。

## 6. 备份

要备份的只有 `/var/lib/heming`（`heming.db` 与其 `-wal`/`-shm`）：

```bash
systemctl stop heming-api
# 文件名带版本号：以前只按日期命名，同一天发第二版会把上一份覆盖掉（d.28/d.30/d.57/d.59 都踩过）
tar czf /root/heming-data-$(date +%F)-<版本号>.tar.gz -C /var/lib/heming .
systemctl start heming-api

# 恢复（覆盖前把现库改名留档）
systemctl stop heming-api
tar xzf /root/heming-data-<日期>-<版本号>.tar.gz -C /var/lib/heming
chown -R heming:heming /var/lib/heming
systemctl start heming-api
```

> `deploy-bare.py backup` 自 2026-11-02 起也按 `heming-data-<日期>-<VERSION>.tar.gz` 命名（脚本里的 `VERSION` 与当轮发版号同步）；本机 `.tmp/backups/` 同名留档，不再互相覆盖。

停进程是为了拿到一致快照：WAL 在进程存活时可能尚未合并，热拷贝容易只拷走 `.db`、把最近的写入留在 `-wal` 里。

> **2026-10-22 的教训**：实例重置（换系统）把 SQLite 库连同放在 `/root/heming` 的卷备份一起清掉了，本机没有库的副本，线上只剩预设账号。备份必须**落到本机或对象存储**，别只留在服务器磁盘上。

所以**每次发版前先备份，而且当场拷回本机**——只跑上面那段 tar 不算备份。`.superpowers/deploy-bare.py backup` 一次做完：停服务 → tar → 起服务 → SFTP 取回本机 `.tmp/backups/` → 校验本机文件非空 + `/api/health` 仍是 `{"ok":true"}`。库只有几十 KB，别省这一步。两个已知的操作细节：备份文件名只带日期，**同一天发第二版会盖掉第一版**，要在跑下一版 `backup` 前把上一份改名留档；脚本修正前（`__file__` 未 resolve、少算一层 parent）落点是 `.superpowers/.tmp/backups/`，那儿若有旧档别当丢了，现在起统一是仓库根 `.tmp/backups/`。

> **「备份不通过就不许 install」由脚本强制**：`node scripts/release.mjs --deploy` 先跑
> `deploy-bare.py backup`，随后核对本机 `.tmp/backups/` 里确实多了**本次**的文件（非空、时间在本次运行内）；
> 任一条件不满足就整轮中止，`upload` / `install` 根本不会被调用。
> 打包与更新源上传各是独立开关（`--desktop` / `--publish`），默认全关；`--dry-run` 只打印十步计划，
> 不连服务器。用法与它不替代的人工环节见 `docs/VERSION-MANAGEMENT.md` §「一条命令发版」。

## 7. CORS 与同源决策

- **同源（默认）**：浏览器访问 `http://47.92.39.184` 时，页面（nginx:80）与 API（反代 `/api` → 127.0.0.1:8787）**同源**，WS 走 `ws://47.92.39.184/api/ws` 同样被反代。因此**本地构建 web 产物时不注入 `VITE_API_BASE`**（留空 = 同源相对路径），配置最少、不依赖任何跨域。
- **CORS 兜底**：服务端仍带最小 CORS 头（`Allow-Origin: *`、预检 `OPTIONS` 直接 204），用于直连场景（本机开发的 web 连远程 api、桌面壳 `app://` 页面）。鉴权是 Bearer token 而非 cookie，`*` 不带来凭据风险；未引入 `cors` 依赖，10 行手写。
- **`VITE_API_BASE` 只服务桌面壳**，给桌面打包时单独注入绝对地址即可，与云端部署互不影响。

## 8. 桌面端嵌入的 web 产物（与云端发布的关系）

桌面客户端**不从云端加载界面**——web 构建产物打进安装包，用自定义协议 `app://heming` 本地加载；API 与 WS 仍走云端。设计见 `docs/superpowers/specs/2026-10-18-embed-web-in-client-design.md`。

**为什么用自定义协议而不是 `file://`**：`file://` 不是安全上下文，`crypto.subtle` 不可用会让 E2E 加密失效（红线：无安全上下文拒绝发送）。`app://` 注册为 privileged + secure 后实测 `isSecureContext === true`、明文 `ws://` 仍可连、且**不需要** `allowRunningInsecureContent` 之类放宽。

### 两套产物，一处差别

| | 云端（本文件 §2–§3） | 桌面嵌入（`pnpm -w run dist:desktop`） |
|---|---|---|
| 命令 | `pnpm -r build` 出产物 → 打进 tar → `install-app.sh` 摆文件 | `node scripts/build-desktop-web.mjs` 预构建 |
| `VITE_API_BASE` | **不注入**（同源相对路径） | **注入**云端绝对地址（跨域，靠服务端 CORS `*`） |
| 产物落点 | `packages/web/dist` → nginx `root` | `packages/desktop/web-dist/` → 打包进 `resources/web` |
| 更新方式 | 部署一次，**所有浏览器用户立刻生效** | **重发安装包**；之后由自动更新源（§9）分发 |

`VITE_API_BASE` 取值：`HEMING_WEB_URL` 环境变量 > 默认 `http://47.92.39.184`（与 `secure-origins.js` 的 `APP_DEFAULT_URL` 同源，避免两处常量漂移）。

### 发布顺序

改了 web 代码要**两处分别发布**：

```bash
# 1) 云端（浏览器端 + 尚未升级的用户）
pnpm -r build && tar ... -czf /tmp/heming.tar.gz .              # §2
python -u .superpowers/deploy-bare.py upload "<tar>"
python -u .superpowers/deploy-bare.py install                   # provision 之后的日常路径

# 2) 桌面端（嵌入产物随安装包）
pnpm -w run dist:desktop                  # 内部先跑 scripts/build-desktop-web.mjs
node scripts/publish-update.mjs           # 安装包 + latest.yml → /updates（§9；win32 用这个）
# 非 Windows 或无 Node 脚本时：bash scripts/publish-update.sh
```

**只发其中一处会出现新旧界面并存**：浏览器看云端、已装客户端看包内。排查「为什么我这没有新功能」时先确认客户端版本。

### 地址优先级（`main.js` 的 `resolveAppUrl`）

```
HEMING_DEV_URL（本地开发，热更新）
  > HEMING_WEB_URL（显式指定远程）
  > app://heming/index.html（默认；包内 web-dist 存在时）
  > http://47.92.39.184（兜底：产物缺失时退回远程，不至于打不开）
```

开发时仍走 `HEMING_DEV_URL` 连本地 vite，**热更新不受影响**。

## 9. 自动更新源（客户端升级）

### 拓扑

```
客户端（安装版）
  └─ 查 http://47.92.39.184/updates/latest.yml
       ├─ version / sha512 → 判断要不要更新
       └─ path + .blockmap → 下载（优先差分包）
```

nginx 的 `location /updates/` 直接 `alias /opt/heming/updates/`（裸机上这就是宿主目录本尊，没有挂载）。
**不用子域名、不用 HTTPS**：更新清单与安装包都没有机密性要求，而 HTTPS 需要证书与自动续期，对当前规模是额外运维负担。
代价是首次安装包必须用户手动下载一次（明文链路可被篡改）——之后所有更新都从已装好的客户端发起，且清单里有 sha512 校验。

### 发版流程

```bash
# 1) 出包（build-desktop.mjs 已默认注入 --publish always，产物里必须有 latest.yml）
pnpm --filter @heming/desktop dist     # = build-desktop-web.mjs（注入地址 + 拷 web-dist）→ build-desktop.mjs --win nsis

# 2) 上传（密码只走环境变量，不落盘；脚本内部用 paramiko）
export HEMING_SSH_PWD='***'
node scripts/publish-update.mjs --dry-run   # 先看要传什么（win32 用 Node 版；非 Windows 用 bash scripts/publish-update.sh）
node scripts/publish-update.mjs             # 真传：大小与 sha512 都校验

# 3) 验证
curl -sI http://47.92.39.184/updates/latest.yml | head -3
curl -s  http://47.92.39.184/updates/latest.yml | head -8
```

**产物不在默认目录时要给 `HEMING_RELEASE_DIR`**。`dist:desktop` 反复在 `win-unpacked/resources/app.asar` 上撞 `EBUSY`（根因未查，见 HANDOFF §5 待办），**已固化成惯例：每版换一个新的输出目录**——r25 打 d.25.1.7.0、r26/r27/r28 依次到 r29 打 d.28.1.7.0、r30 打 d.29.1.7.0（均一次通过）、**r31 是一次被中止的尝试（产出的安装包内嵌旧产物，没发布就废掉了）、r32 打 d.29.1.8.0、r33 打 d.30.1.8.0（一次通过）**，下一版 **d.31 用 `release/r34`**。打包与发布两处必须指同一目录（`build-desktop.mjs`、`publish-update.mjs` 与 `publish-update.sh` 都读 `HEMING_RELEASE_DIR`）：

```bash
HEMING_RELEASE_DIR=D:/Heming/packages/desktop/release/r34 pnpm --filter @heming/desktop dist
HEMING_RELEASE_DIR=D:/Heming/packages/desktop/release/r34 node scripts/publish-update.mjs --dry-run
```

> 这三步也可以一条命令串起来：`node scripts/release.mjs --desktop --publish`（先 `--dry-run` 看计划）。
> 新目录用 `--release-r 45`，或整条路径用 `--release-dir D:/Heming/packages/desktop/release/r45`；
> 脚本把 `HEMING_RELEASE_DIR` 同时注入打包与发布两处，不会再出现「打包进 r45、上传读默认目录」。
> 部署那一路同理：`--deploy` 会强制先 `backup`（见 §6），中止时不碰线上。


> **d.30 实测的两个坑**：
> ① `tar --exclude=./node_modules` 这种带 `./` 前缀的写法**全部失效**（GNU tar 的 `--exclude` 匹配路径段名，
>    不认 `./` 前缀）——包会从 5.6MB 撑到 **2.19GB**（把 `packages/desktop/release` 的历史安装包全卷进去）。
>    必须用**裸段名**（`--exclude=node_modules --exclude=release …`），并额外排掉 `@hemingdesktop`。
>    打完先跑 deploy.md §2 的两条校验（体积与清单）再上传。
> ② 同日二次发版会覆盖上午那份备份（备份名按日期生成）——发版前先把新备份改名留档
>    （本轮存为 `heming-data-2026-10-22-d30.tar.gz`）。

### 四个必须知道的坑

1. **`latest.yml` 不会自动生成。** electron-builder 默认不产出更新元数据，少了它客户端永远提示「已是最新」——**界面上与正常无差别，无法靠肉眼发现**。`build-desktop.mjs` 已默认注入 `--publish always`，产物目录里必须能看到 `latest.yml` 才算打包成功。
2. **`/updates/` 必须排在 nginx `location /` 之前。** 否则 `try_files` 会把 `latest.yml` 回落成 `index.html`，客户端拿到 HTML 报「解析更新信息失败」。该顺序已固化在 `deploy/nginx-heming.conf`，改动时别调换。
3. **上传后要比大小与 sha512。** 两个发布脚本都会在远端重算 sha512 并与本地逐字节核对：shell 版用 `stat -c '%s|%n'` 比大小，Node 版（`publish-update.mjs`）额外用 `sha512sum` 比哈希。这套对照不是形式主义——Git Bash 的 MSYS 路径转换能让「上传成功」变成只写到本机磁盘，日志一切正常、云端目录里没文件。shell 版因此在开头 `export MSYS_NO_PATHCONV=1`，并在远端目录不是绝对 POSIX 路径时立刻停下；**本机没有 Git Bash，win32 请直接用 Node 版**（`release.mjs --publish` 会自动优先它）。
4. **`node scripts/build-desktop.mjs` 单独跑会打进上一轮的旧嵌入产物。** 注入并拷贝 `packages/desktop/web-dist` 的那一步在 `scripts/build-desktop-web.mjs` 里，`build-desktop.mjs` 不会替你跑它——于是安装包里的前端还是上一版，`latest.yml`、版本号、文件名全是对的，**只有内容是旧的**（d.29.1.8.0 实测：r31 那份 178MB 的安装包内嵌 `index-ChSMGDkh.js`，grep 到的是 `d.29.1.7.0`，整个 r31 作废重打）。入口因此只能是 `pnpm --filter @heming/desktop dist`（= 两步串起来）。出包后**核对一眼再传**：`grep -c "<新版本号>" packages/desktop/release/<rNN>/win-unpacked/resources/web/assets/index-*.js` 应当命中，且文件名与 `packages/desktop/web-dist/assets/` 里那个一致。

上线后务必确认清单**不是 HTML**，并且支持断点续传：

```bash
curl -sI http://47.92.39.184/updates/latest.yml | grep -E 'HTTP|Content-Type|Content-Length'
# 期望 200 + application/octet-stream + 352 字节（不是 text/html）
curl -sI -H 'Range: bytes=0-16' "http://47.92.39.184/updates/<URL 编码后的安装包名>" | head -3
# 期望 206 Partial Content（差分更新靠它）
```

### 回滚

把 `/opt/heming/updates/latest.yml` 换回上一版的（连同安装包与 blockmap）即可。已安装的客户端下次检查会回到旧版本——**这正是要的效果**。所以更新源**至少保留上一版**；现行口径是「保留最近 2 版」（当前 + 上一版），更早的可以清理。**`/opt/heming/keep/` 不适用这条**：服务器回滚依赖全部历史包，不要清理。

## 10. 资源与运维参考

- 内存上限：`heming-api.service` 的 `MemoryHigh=384M` / `MemoryMax=512M`。**这是护栏不是功能**：真正的保护是「云端不构建」；触顶时进程被 systemd 杀掉、3 秒后重启，表现为掉线一下。
- swap：2G `/swapfile` **写在 `/etc/fstab` 里**（裸机部署中它属于配置，不再是一次性临时兜底），`vm.swappiness=15` 只设运行时、不落 `/etc/sysctl.d/`——它不是正确性依赖，只是让回收更早开始。实测本轮部署全程 swap 用量 < 1MB。
- Node 版本：`v24.18.0`，npmmirror 二进制包解到 `/usr/local/lib/nodejs/`，软链进 `/usr/local/bin`。不用 apt 的 `nodejs`：Ubuntu 24.04 给的是 18.x，而根 `package.json` 要求 `engines.node >= 24`。`pnpm@10.33.2` 与 `docker/*.Dockerfile` 钉同一代（lockfileVersion 9.0）。
- 不需要 `build-essential`：服务端依赖树里没有需编译的原生模块（SQLite 用 Node 24 内置的 `node:sqlite`，express/ws/zod 是纯 JS）。
- 开机自启：`systemctl enable nginx heming-api`（provision / install 已做）。
- 磁盘：包 5MB + 生产依赖 67 个包 + `keep/` 历史包，40G 用不到零头。

```bash
systemctl status heming-api --no-pager | head -12
journalctl -u heming-api -f
systemctl restart heming-api
tail -50 /var/log/nginx/error.log
free -m | head -3; swapon --show
```

> **失联判据（记牢）**：能 ping 通、TCP 能握手、60 秒不回一个字节 = **用户态冻住**，不是网络问题、不是安全组。这台机两次事故都长这样，第二次甚至只是跑了 `docker builder du`（当时并没有在构建）。裸机方案下若再出现，先看 `dmesg | tail` 与 `free -m`；**别猛连 22 端口**——云盾的爆破防护会封源 IP，届时 80 正常而 SSH 一直 `Error reading SSH protocol banner`，只能等冷却或换出口。

## 11. 旧 Docker 路径（已清理）

`docker/`（`api.Dockerfile`、`web.Dockerfile`、`web-nginx.conf`）与 `docker-compose.yml` 已在「全面升级」轮删除：机器已重置且没有装 Docker，发版一律走 §2–§3。

删除前确认过两件事：① 没有脚本/构建引用它们（只有本文件的历史说明）；② 容器版 nginx 配置里唯一的硬约束——「`/updates/` 排在 `location /` 之前」「WS 用 HTTP/1.1 + Upgrade 且 `= /api/ws` 精确匹配」——已完整写在 §9 坑 2，宿主版 `deploy/nginx-heming.conf` 继续满足，知识没有随文件一起丢。

那套流程里的旧做法在裸机方案各有替代，别再按 Docker 时代的命令操作线上：

| Docker 时代 | 现在 |
|---|---|
| `docker compose build && up -d`（api 仍在云端构建） | `install-app.sh`，云端零构建 |
| 镜像 tag `heming-api:prev` 回滚 | `/opt/heming/keep` 里旧包重放 |
| named volume `heming_heming-data`（容器内 `/data`） | `/var/lib/heming` 目录（§6） |
| compose `deploy.resources.limits` | 单元里的 `MemoryHigh` / `MemoryMax` |
| `--profile preview` 起 8788 验证实例 | 已取消：预发靠本地门禁 + `install-app.sh` 自检。要独立预发就另开机器，别再往这台 2C2G 上叠进程 |
| `docker builder prune -f` 清缓存 | 没有缓存可清了（也别在这台机上跑任何要遍历镜像层的诊断命令） |

## 12. CSP 基线（P0-6）

两处交付路径各设一份**同源策略**：

| 环境 | 头在哪里 | 说明 |
|---|---|---|
| 云端 web | `deploy/nginx-heming.conf` 的 `add_header` | 本文件默认启用 **report-only**，确认无违例后换成 `Content-Security-Policy` 即 enforce |
| 桌面 `app://` | `packages/desktop/app-protocol.js` → `main.js` 的协议响应头 | `HEMING_CSP_MODE=off|report|enforce`，**默认 report**（先收集违例） |
| vite dev | **不设头** | dev 下插件会注入内联 preamble，设头会把 HMR 弄挂；dev 不是交付形态 |

### 12.1 最终策略

**主窗口（web 云端与桌面 `app://` 同一份语义）**

```
default-src 'self' app:;
script-src 'self' app: 'wasm-unsafe-eval';
style-src 'self' app: 'unsafe-inline';
img-src 'self' app: data: blob:;
font-src 'self' app: data:;
media-src 'self' app: blob: data:;
worker-src 'self' blob:;
connect-src 'self' app: <API 源与 ws/wss> https: wss: http://127.0.0.1:* http://localhost:*;
object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'
```

（云端版本没有 `app:` 来源；`<API 源与 ws/wss>` 在云端是 `ws://$host wss://$host`，桌面是 `http://47.92.39.184 ws://47.92.39.184` 或 `HEMING_WEB_URL` 的源。）

**桌宠窗口（`/pet.html`，桌面端单独一份）**：与主窗口相同，另加 `form-action 'none'`，
且 `script-src` **额外有 `'unsafe-eval'`**（理由见下表最后一行）。

### 12.2 每条的理由与豁免依据（都有实测/源码证据）

| 指令 | 取值理由 |
|---|---|
| `script-src` 无 `'unsafe-inline'` | `index.html` / `pet.html` 的内联脚本 **0**（构建产物实测：外链 1、内联 0）；vite dev 的内联 preamble 不设头，不受影响。 |
| `script-src 'wasm-unsafe-eval'` | **硬证据**：① 代码高亮 shiki 用 oniguruma WASM（`lib/markdown/highlight.ts` 的 `createOnigurumaEngine(import("shiki/wasm"))`）；② PDF/Office 解析的 pdfjs 用 WASM 解图像；③ 桌宠 Live2D cubism core 是 WASM。它只放开 **WebAssembly 编译**，不放开 `eval` / `new Function`（源码 `eval(`/`new Function` **0 命中**）。 |
| `style-src 'unsafe-inline'` | **唯一的内联样式豁免**：KaTeX 渲染输出自带 style 属性、26 处 React `style={{…}}`（主题色/布局）、图表样式。要收掉需给 KaTeX 加 nonce/hash（另立一轮）。 |
| `worker-src 'self' blob:` | pdfjs 的 module worker（同源 asset）+ blob 兜底。pdfjs **6.5.438** 实测：worker 是 `new Worker(<同源 hashed asset>, { type: "module" })`，`app://` 下取 200 / `text/javascript`，enforce 下真实 worker 完成 `getTextContent`（无 fake worker 回退）——**`'self'` 就够，无需放宽**；`blob:` 留给 officeparser 的 `URL.createObjectURL(new Blob(...))` worker 路径。 |
| `img-src data: blob:` / `media-src blob: data:` | 录音、图片预览、附件预览走 blob/data URL。 |
| `connect-src` 的 `https:`/`wss:`/回环 | **为什么不收窄**：模型供应商 `baseUrl`、MCP HTTP 服务、插件 Registry 都是**用户运行期配置**，静态头无法枚举；CSP 的主要收益在 `script-src`，这里只挡「远程明文 http」。**已知边界**：远程明文 http 的供应商会被拦——请上 https，或在部署时把来源加进来（nginx 改 `connect-src`；桌面用 `HEMING_CSP_CONNECT`，逗号分隔）。 |
| `frame-ancestors 'none'` / `object-src 'none'` / `base-uri 'self'` / `form-action 'self'` | 防点击劫持、插件注入、base 标签劫持与表单外发。 |
| 桌宠 `script-src 'unsafe-eval'` | **硬证据（enforce 冒烟）**：不放开时桌宠页面直接显示「桌宠没能加载：Current environment does not allow unsafe-eval, please use @pixi/unsafe-eval」——pixi 6 在 `generateProgram` 里用 `new Function` 生成着色器。pixi 8 才移除该依赖，而 `pixi-live2d-display` 硬绑 pixi 6。桌宠窗口只加载 app:// 本地资源、不渲染用户 HTML，风险面远小于主窗口；**pixi 8 可升级时这一条随 `buildCsp({pet:true})` 一起删**。 |

> ☆ 经验记录：初稿把 `http://[::1]:*` 写进 `connect-src`，Chromium 报
> 「contains an invalid source: 'http://[::1]:*'，ignored」。**CSP 不接受 IPv6 字面量的端口通配**，
> 已移除；只监听 IPv6 的本机服务请用 `HEMING_CSP_CONNECT` 显式加来源。
> （report-only 期日志里出现 `blocked=invalid-source` 时，先查是不是这类写法问题。）

### 12.3 为什么不在 `index.html` 写 `<meta http-equiv>`

① meta 对 vite dev 同样生效，而 dev 会注入内联 preamble（React Refresh），会当场把 dev 弄挂；
② meta **不支持 report-only**，没法先灰度；
③ 两个交付路径都能发头，meta 没有额外收益。CSP 只走 nginx 头与桌面协议头。

### 12.4 report-only → enforce 切换

1. 当前发布即 report-only：nginx 发 `Content-Security-Policy-Report-Only`；桌面默认 `HEMING_CSP_MODE=report`。
2. 观察一轮：
   - 桌面：`~/Heming/logs/csp-report.log`（**限长 256KB、同一条违例只记一次、只记指令/被拦 URI/来源，绝不记页面内容**）；
   - 云端：浏览器 DevTools 控制台（nginx 没有报告收集端点，report-only 只发头、不发报告请求）。
3. 无违例后切换：
   - 云端：`deploy/nginx-heming.conf` 里把 report-only 那行注释、enforce 那行取消注释，`nginx -t && nginx -s reload`；
   - 桌面：启动环境加 `HEMING_CSP_MODE=enforce`。**下一版本把默认改 enforce** = 改
     `packages/desktop/app-protocol.js` 里的 `DEFAULT_CSP_MODE = "report"` 为 `"enforce"`（`normalizeCspMode`
     的非法值兜底也读这同一个常量，只改这一处即可；`main.js` 的 `cspMode()` 默认值自动跟随）。
4. 回滚：桌面 `HEMING_CSP_MODE=off`；云端注释 CSP 头后 reload。**数据/配置都不受影响**。

### 12.5 冒烟证据（2026-11-02，d.60 轮）

**report-only 期间（桌面 `app://`，`HEMING_CSP_MODE=report`）**

- 文档响应头：`content-security-policy-report-only`，内容为本节 §12.1 的主窗口策略（已去掉非法的 `[::1]`）；
- 首屏 `#root` 有子节点、标题「和鸣」、外链脚本 1 个、**应用自身 0 条违例**；
- 只有人为探测产生的两条（用来验证管道与去重）：
  - `directive=script-src blocked=inline`（注入内联脚本，report-only 下仍执行）；
  - `directive=connect-src blocked=http://example.invalid/csp-probe`；
  - 同一违例重复上报只落一条（去重生效）；`wasm` 编译 `ok`。
- 桌宠窗口（同一份产物）：`canvas` 创建成功、无未捕获错误；pixi 的 `Function(...)` 特性探测产生一条
  `'unsafe-eval' is not an allowed source`（report-only 下照常执行）。

**enforce 后（三环境）**

| 环境 | 结果 |
|---|---|
| vite dev（`http://localhost:5198`） | 不注入 CSP 头；页面正常渲染、HMR preamble 正常（零违例可报，因为没有策略限制）。 |
| 生产构建 web（本机静态服务注入 nginx 同款头） | enforce 头存在；首屏渲染正常（字体/样式/图片全过）；内联脚本**被拦**（`inlineExecuted=false`）；`wasm-unsafe-eval` 下 WASM `ok`；connect 越界被拦。 |
| 桌面 `app://` | enforce 头存在；主窗口正常渲染；内联脚本被拦、WASM `ok`、越界 connect 被拦；**桌宠窗口**加 `'unsafe-eval'` 后 canvas 正常、无错误。 |

结论：主窗口 `script-src` 已收紧到「self + wasm-unsafe-eval」，内联脚本/远程明文 http 在 enforce 下确实被挡；
`style` 的内联豁免与桌宠的 `unsafe-eval` 都有硬证据与移除条件，已在 §12.2 写明。

**2026-11-02 完整产物复核（pdfjs 升到 6.5.438 之后重建）**

- 重建完整生产产物（`.tmp/csp-web-dist`，63 chunk）后重跑三环境 + 桌宠：结果与上表一致，**CSP 策略 0 处 diff**
  （`buildCsp` / `CSP_HEADER` 未改，`DEFAULT_CSP_MODE` 仍为 `report`）；
- 新增 pdfjs v6 worker 复核：在真实应用页里 `await import(<pdf chunk>)` → `getWorkerSrc` 指向同源
  `assets/pdf.worker.min-<hash>.mjs` → 建 module worker → `getDocument` → `getTextContent`，
  四种组合（`app://`/生产 web × report-only/enforce）全部抽到 `Heming pdfjs smoke test 12345`，
  耗时 38–51ms，CSP 违例 0、fake worker 警告 0；构建 chunk 中 `eval(`/`new Function(` 均 0 命中；
- 结论：**pdfjs v6 的 module worker 由现有 `worker-src 'self' blob:` 覆盖，无需调整策略**；
  证据明细见 `.tmp/csp-evidence.md`（含 pdfjs 复核表）。

### 12.6 桌面端自测命令

```bash
# report-only（默认）：启动应用后操作一轮，然后看本机日志
cd packages/desktop
pnpm exec electron .                 # 或安装版直接启动
cat ~/Heming/logs/csp-report.log

# enforce：确认无误后切
HEMING_CSP_MODE=enforce pnpm exec electron .
# 临时关掉整条策略（排障用）
HEMING_CSP_MODE=off pnpm exec electron .
```

> 注意：CSP 是**文档级**的——改 `HEMING_CSP_MODE` 后重启/重载页面才生效；
> 改模型供应商 `baseUrl` 不需要动 CSP（TLS 端点已放通）。