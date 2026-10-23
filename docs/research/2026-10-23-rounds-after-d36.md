# d.36 之后的几轮：可开工的设计备忘（2026-10-23）

> 用途：d.36（safeStorage）之后剩余的 P0-6 / P4-1 / P4-2 各自独立成轮。
> 这份文档把**开工前必须先想清楚的事**写下来，免得每轮重新调研。
> 每条都对齐 `docs/research/2026-10-22-deep-audit-followup-plan.md` 的编号。

## 1. P0-6 · 桌面壳 CSP（下一轮候选）

### 现状

- web / server / desktop 三处 `Content-Security-Policy` **0 命中**（已核实）。
- 桌面页是 `app://heming`，`secure-origins.js` 已把它与 `http://47.92.39.184` 视为安全上下文。
- KaTeX、图表、Markdown 渲染都依赖**内联样式**；Shiki 高亮是构建期产物。

### 必须先定的事

1. **策略基线**（只加在桌面壳，不动云端——云端由 nginx 加头，属另一件事）：
   ```
   default-src 'self' app:;
   connect-src 'self' http://47.92.39.184 ws://47.92.39.184 app:;
   img-src 'self' app: data: blob:;
   style-src 'self' app: 'unsafe-inline';
   script-src 'self' app:;
   font-src 'self' app: data:;
   media-src 'self' app: blob:;
   ```
2. **`'unsafe-inline'` 只给 style**：KaTeX 与内联样式是既成事实，`script` 绝不放。
   若将来要收掉 style 的内联，需要先给 KaTeX 加 nonce/hash——不在本轮。
3. **`connect-src` 必须包含用户自填的 `baseUrl`**：智能体直连供应商（红线），
   地址由用户配置，无法在构建期枚举。两个选择：
   - **A（推荐）**：桌面壳在启动时读一次 `heming.llmConfigs` 的 `baseUrl` 集合，
     与默认源一起拼进 CSP（主进程 `onHeadersReceived` 动态生成）；
   - B：给 `connect-src` 放 `https:` 通配——更简单但**削弱了纵深**，不推荐。
   ★ 选 A 时注意：CSP 是**文档级**的，配置变更后要重载页面才生效（提示用户或自动 reload）。
4. **灰度开关**：`HEMING_CSP_OFF=1` 关掉整条策略并落一条本机日志（复用 `crash-log` 的目录约定，
   但**不是崩溃日志**——单独 `~/Heming/logs/csp-off.log`）。

### 验收

- 手工全流程：登录 → 聊天（含附件/语音）→ 知识库 → 图表 → 通话 → 设置，**控制台零 CSP 拦截**；
- 一条自动化证据：主进程单测断言「生成的头包含 connect-src 且包含配置里的 baseUrl、不含 `script 'unsafe-inline'`」；
- 关掉开关时日志落地且页面正常。

### 风险

- 任何漏配的域名都会让功能**当场静默失效**（fetch 被拦、UI 无提示）。所以必须手工全流程过一遍，
  不能只看单测。**这一条是 CSP 轮最花时间的部分，排期时不要低估。**

## 2. P4-1 · `release.sh`：把两处发布固化

### 现状

两处发布（云端 tar + 桌面安装包 + `/updates`）全靠手工编排，本轮 d.29 就出过一次
「r31 内嵌旧前端」的事故。`deploy-bare.py` 与 `publish-update.sh` 之间**没有任何**「产物 == 提交代码」的闸。

### 脚本要做的顺序（任何一步失败即停）

1. `git status --porcelain` 非空 → 拒绝（除非 `--allow-dirty`）；
2. `pnpm -r build && pnpm -r --workspace-concurrency=1 test`；
3. **立刻**打云端 tar（在任何会改写 `packages/web/dist` 的步骤之前）；
4. 部署 → `/api/health` → **线上 bundle md5 与本机比对**；
5. 备份（强制先拷回本机，未拷回即停）；
6. `pnpm --filter @heming/desktop dist`（`HEMING_RELEASE_DIR=…/release/rNN`，NN 自动递增）；
7. 核对内嵌 bundle：版本串命中、`VITE_API_BASE` 命中 2 次、文件名与云端不同；
8. 发布 `/updates` → sha512 比对 → 远端 Range 206；
9. 重跑 `pnpm --filter @heming/web build` 把本机 `dist` 恢复成云端口径；
10. 把证据（字节数、md5、sha512、时间）写进 `docs/HANDOFF.md` §2 的对应行。

### 必须先定的事

- **证据回写**是人工编辑 Markdown，脚本化容易写错格式；建议脚本只**输出**一段可粘贴的
  Markdown 块，人来贴（保持 HANDOFF 的可读性），或做模板替换但先加一条校验。
- 发布目录递增规则与 `HEMING_RELEASE_DIR` 的约定（见 `docs/deploy.md` §9 坑 #4）。

## 3. P4-2 · 清理 `docker/` 与 `docker-compose.yml`

### 现状

Docker 路径已停用（机器重置、未装 Docker）。两份 nginx 配置互为出处
（`deploy/nginx-heming.conf` 与 `docker/web-nginx.conf`）——**清理时必须一起处理**，
只删一半会让「`/updates/` 顺序」「`= /api/ws` 精确匹配」这两条硬约束失去唯一出处。

### 做法

1. 先在 `docs/deploy.md` 里把那两条硬约束**补全为自包含说明**（现在写在「两份配置互为出处」的语境里）；
2. 删 `docker/`、`docker-compose.yml`、`.dockerignore`；
3. 全仓 grep `docker` 确认无代码引用（文档里的历史说明保留，属于迭代记录）；
4. `docs/INDEX.md` §5 与 HANDOFF §5 #6 同步更新。

### 风险

低。唯一要小心的是**别把「历史记录」当成「当前配置」删掉**——文档里的 d.25 之前的历史陈述要保留。

## 4. 另有两项要用户拍板，别自行开工

- **P4-6 更新源 HTTPS + 签名**：运维成本（域名、证书续期、wss）换取「首次安装包不可被篡改」。
  属于对外基础设施决策，**必须先问**。
- **P2-6 好友/群成员管理**：涉及 **E2E 群密钥重协商**（新人能否解历史、踢人后棘轮如何处理），
  必须先出安全规格再动接口，没有规格不动代码。

## 5. 建议的轮次顺序

| 轮次 | 内容 | 理由 |
|---|---|---|
| **d.36** | P0-5 safeStorage（规格已写：`specs/2026-10-23-d36-safestorage.md`） | 风险最高且边界清晰，先做 |
| **d.37** | P0-6 桌面壳 CSP | 与 safeStorage 同属桌面安全；需要手工全流程验证，单独一轮 |
| **d.38** | P4-1 `release.sh` | 纯工程，做完之后每轮发布省半小时且少一类事故 |
| **d.39** | P4-2 docker 清理（可与任一文档轮合并） | 低风险收尾 |
| 之后 | P0-5b（msgCache/chains 加密）、P2-6（需安全规格） | 各自需要独立设计 |
