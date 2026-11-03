# 和鸣 · 全面升级计划（d.54 之后）

- 日期：2026-11-02
- 状态：执行中
- 工作树/分支：`D:\Heming\.claude\worktrees\team-system` @ `feat/team-system`
- 起点版本：`d.54.2.17.0`（2026-11-02 15:32 提交，15:34 已部署到 47.92.39.184）
- 依据：用户要求「全面升级，以及其他功能的升级改进，全面的去做，不要停下」

---

## 0. 总原则

1. **分批推进，每批一个发布**：一批一个版本号、一次全量门禁、一次 CHANGELOG 条目；能部署的部署、能出包的出包，证据回写 `docs/HANDOFF.md`。
2. **不做无证据的升级**：依赖大版本升级必须查 registry 实际最新版、读取 breaking changes、逐步验证；不能升的要写下「不升的理由 + 证据」，不允许静默跳过。
3. **红线不动**：本地驱动、E2E 不降级、个人数据不出设备、HITL 人工确认四条架构红线在本计划中保持不变。
4. **每个改动都要有测试与文档**：本仓惯例是「新增用例 + 设计/变更文档 + HANDOFF/CHANGELOG 回填」三件套。
5. **不确定就记录，不停工**：产品问题在实施前给出默认决策（写进规格文档「决策」一节），后续可回头改。

## 1. 现状基线（开工前实测）

| 项 | 值 |
|---|---|
| 版本 | `d.54.2.17.0`（五包同步） |
| 分支 | `feat/team-system`（`main` 落后 1 个提交：`c782b82`，d.54.2.16.0） |
| 工作树 | 干净（无未提交改动） |
| 线上 | `http://47.92.39.184` 已部署 d.54.2.17.0；`/api/health` `{"ok":true}`；线上主 bundle `main-DmpLGi7z.js` 与本机 `build-cloud-d54.2.17.0.log` 产物同名同源 |
| 门禁 | 2026-11-02 15:44 实跑：build 通过；desktop 402 例、shared 24 例通过；server 首次跑出 `0xC0000409`（已知偶发），web 因 pnpm 短路未跑 → **本计划要求逐包跑并允许单包重试** |
| 安装包 | `D:\Heming\packages\desktop\release\r43\和鸣 Setup d.54.2.17.0.exe`（86,426,793 字节）**缺内置运行时**：`resources/runtime` 不存在（工作树没有 `packages/desktop/runtime`，该目录被 gitignore，只存在于主检出）。r43 因此不可发布 |
| 工具链 | Node 24.15.0 / pnpm 10.33.2；TS 5.6、Vite 5.4、Vitest 1.6、React 18.3、Electron 31.7.7、zod 3.23、zustand 4.5、Tailwind 3.4、pixi 6.5 + pixi-live2d-display 0.4 |

## 2. 四批分解

### 批次 ④ 发布与文档收尾（先行，因为后续每批都要靠它落地）

| 轮 | 内容 | 版本位 | 验收 |
|---|---|---|---|
| ④-1 | HANDOFF/INDEX 回填到 d.54.2.17.0 与实际部署状态；新增本计划索引 | build | 文档不再声称「线上 d.35.1.8.0」；新会话可据此接手 |
| ④-2 | 修「安装包缺内置运行时」：工作树缺少被 gitignore 的 `packages/desktop/runtime`，打包前用目录联接指向主检出的运行时；重打 r44 并核对 `resources/runtime/mcp-env` 存在、内嵌 bundle 名与版本串、`latest.yml` sha512 | build | 安装包体积回到 ~178MB 量级；包内 runtime 文件数 ≈ 5026 个 `.py` |
| ④-3 | 旧 IM 数据处置：`scripts/purge-im-data.mjs` 备份后 dry-run 出计数，报数给用户后再决定 `--yes` | build | 有 dry-run 证据；**不在未确认时删线上数据** |
| ④-4 | 合回 `main`：`main` 当前被 WorkBuddy 工作树占用，需先与用户确认再动；不擅自改他人工作树 | build | 见 §5 协作约束 |

### 批次 ① 工程基线升级（逐包、逐层）

顺序按「影响面从小到大」，每一步单独验证、失败即停并记录：

| 轮 | 内容 | 版本位 |
|---|---|---|
| ①-1 | 测试与构建链：TypeScript 5.x 最新、`@types/node`、Vite 5 → 最新、`@vitejs/plugin-react`、Vitest 1 → 最新、jsdom、testing-library 全家 | fix |
| ①-2 | 运行时依赖（web）：React 18 → 19、react-dom、`@types/react*`、zustand 4 → 5、zod 3 → 4（shared/server/web 同步）、react-markdown/remark/rehype/katex/shiki、pdfjs-dist、officeparser | fix |
| ①-3 | 样式链：Tailwind 3 → 4（含 postcss 配置形态变化、自定义 token 迁移）、autoprefixer 去留 | fix |
| ①-4 | 桌面壳：Electron 31 → 最新 LTS、electron-builder 25 → 最新、electron-updater；安装包冒烟（启动、safeStorage、通知、桌宠透明窗、自动更新清单） | fix |
| ①-5 | 图形栈评估：pixi 6 → 8 与 pixi-live2d-display 的兼容性（该库 peer 依赖 pixi 6）；**不兼容则明确不升**并记录证据 | fix |

规则：每一步都先读 changelog/migration guide，改完跑 `pnpm -r build` + 受影响包 `test`，再跑全量；任一步失败且 2 轮修不动就回退该步并记录「暂不升级 + 原因」。

### 批次 ② 功能与技术债补齐（规格已写好的优先）

| 轮 | 内容 | 依据 | 版本位 |
|---|---|---|---|
| ②-1 | `file_patch` 文件编辑原语（d.55） | `specs/2026-11-02-d53-file-edit-primitive.md` | feature |
| ②-2 | 回合日志回放/重跑/分叉（d.56） | `specs/2026-11-02-d54-rollout-recovery-fork.md` | feature |
| ②-3 | 团队能力：用量排行（服务端聚合）、团队级日程/里程碑 | HANDOFF §5 二期主线 5 | feature |
| ②-4 | 桌宠在场感：任务收尾/日程临期/幕僚简报经 `pet:event` 推姿态与气泡 | `specs/2026-11-02-pet-presence.md` + `docs/PET.md` §4.3 | feature |
| ②-5 | P0-5b：`msgCache` 与 `e2e.chains` 本地明文搬进安全存储（先出设计稿，再实施） | HANDOFF §6 分发 | feature/breaking |
| ②-6 | P0-6 CSP 基线（`connect-src` 含用户自填 `baseUrl`） | `research/2026-10-23-rounds-after-d36.md` | fix |
| ②-7 | 工程发布链：`release.sh` 十步固化、`docker/` 与 `docker-compose.yml` 清理、WS `?token=` 兼容路径删除 | 同上 | fix |

### 批次 ③ 体验与安全加固

| 轮 | 内容 | 版本位 |
|---|---|---|
| ③-1 | 包体与首屏：`officeparser`（5.5MB 单块）按需加载、主 bundle（1.37MB）路由级 code-split、PDF worker 策略 | fix |
| ③-2 | 无障碍：模态焦点、`aria-live`、键盘可达性全站巡检（沿用 `useModalA11y`） | fix |
| ③-3 | 错误态与离线：全站失败态、重试、断网行为的一致性巡检 | fix |
| ③-4 | 安全复审：E2E 路径、存储明文、IPC 校验、主进程网络能力白名单 | fix |

## 3. 每批准入标准（Definition of Done）

1. `pnpm -r build` 通过；
2. 逐包 `test` 全绿（shared / server / web / desktop；偶发 `0xC0000409` 允许单包重跑一次并在台账注明）；
3. `node scripts/bump-version.mjs auto <位>` 已跑，五包版本一致；
4. `CHANGELOG.md` 顶部有条目，`node scripts/build-changelog.mjs` 已同步（`changelog-sync.test.js` 会抓）；
5. 设计/变更文档已写，`docs/INDEX.md` 有索引；
6. `docs/HANDOFF.md` 的版本、测试、线上、安装包四行已按实测回填；
7. 需要部署的批次：备份 → 部署 → `/api/health` + 线上 bundle 版本串核对。

## 4. 协作与写入边界

- **版本号 / CHANGELOG / HANDOFF / INDEX / 提交**：只有 Lead 动，同一时刻只有一个写入者。
- **依赖清单（`package.json`/`pnpm-lock.yaml`/vite/vitest/tsconfig/postcss/tailwind 配置）**：批次 ① 的负责人独占；其他轨道不得 `pnpm add/remove/install`。
- **全量门禁与打包**：只在 Lead 的整合点跑，轨道负责人只跑受影响包的 `test`/`typecheck`，避免构建产物互相覆盖。
- **线上部署与安装包发布**：只有 Lead 动；部署前必须备份 `heming.db`（`deploy-bare.py backup`）。
- 同一时刻不超过 2 个写入者处于活动状态；跨轨道共用的文件（如 `ChatPage.tsx`、`capability/registry.ts`）先申请再由 Lead 指派。

## 5. 进度台账

| 批次/轮 | 状态 | 版本 | 关键证据 |
|---|---|---|---|
| 基线门禁复跑 | ✅ 完成（2026-11-02 15:46） | d.54.2.17.0 | `.tmp/gate-baseline-retry.log`：shared 24 / server 122 / web 2317 / desktop 402 全绿；首跑 server `0xC0000409` 重跑即绿 |
| ④-1 文档回填 | ✅ 完成（2026-11-02 16:00） | d.54.2.17.0 | HANDOFF §2 四行 + §5 下一步 + INDEX 三行（本计划、file_patch、rollout fork）；线上证据写入 §2 |
| ④-2 安装包 runtime 修复 | ✅ 完成（2026-11-02 15:52） | d.54.2.17.0 | `release/r44/和鸣 Setup d.54.2.17.0.exe` 183,694,913 字节；runtime 7371 文件 / 5026 `.py`；sha512 与 `latest.yml` 一致 |
| ④-2b 安装包上传更新源 | 待定（等用户确认是否把 d.54 推给在网客户端） | d.54.2.17.0 | 需 `scripts/publish-update.sh` + SSH；当前线上 `latest.yml` 仍指 35.1.8 |
| ④-3 旧 IM 数据 dry-run | ✅ 完成（2026-11-02 16:02，对最新线上备份副本跑） | d.54.2.17.0 | `.tmp/purge-dryrun/`：将删 conversations 1 / conversation_members 1 / conversation_agents 1，messages 0、message_reads 0，合计 3 行；保留 users 1 / agents 1。**数据量极小，清理与否无实际影响**；真正执行需用户点头 |
| ④-4 合回 main | 待协调（main 被 WorkBuddy 工作树占用） | | |
| ①-1 测试与构建链 | ✅ 完成（2026-11-02 16:07） | d.54.2.17.0 | vite 5→8.3.5 / plugin-react 6.2 / vitest 1→5.0.5 / jsdom 30.1.3 / jest-dom 7 / TS 5.9.3 range；`clearMocks:false` 保持旧语义（526 处 `vi.fn` 零改动）；改 1 个非配置文件 `test-setup.ts` |
| ①-2a React 19 | ✅ 完成（2026-11-02 16:22） | d.54.2.17.0 | React 19.3.1 + @types 19.3.0；4 文件 6 处类型适配（`type JSX` 导入、`RefObject<T \| null>`）；web 2424 例全绿 |
| ①-2b zustand 5 | ✅ 完成（2026-11-02 16:22） | d.54.2.17.0 | zustand 5.0.16；修掉 `ChatPage` selector 每次返回新数组（v5 `useSyncExternalStore` 直接报错），改模块级 `EMPTY_MESSAGES`；顺带修 1 个 jsdom 30 暴露的测试竞态 |
| ①-2c zod 4 | ✅ 完成（2026-11-02 16:37） | d.54.2.17.0 | zod 3→4.6.7（三包同步）；仅 `plugins/manifest.ts` 需真改（`error` 统一入口 + `typeParams` 保持中文文案逐字不变）；**坑：改 shared 依赖后必须重建 shared/dist** |
| ①-2d 补丁级依赖 | ✅ 完成（2026-11-02 16:43） | d.54.2.17.0 | katex 0.19.1 / shiki 4.6.0 / officeparser 8.4.1（`~` 钉住避开 engines 不满足的 8.5.0）；dev 模式加 `optimizeDeps.include` 消除懒发现抖动 |
| ①-3 Tailwind 4 | 进行中（2026-11-02 16:43 起） | — | 验收口径：test/tsc/build/dev 四绿；视觉由 Lead 用 `.tmp/visual/*` 像素对比 |
| ①-4 Electron 45 / electron-builder 26 | 待开始（排在最后，含打包冒烟） | — | 当前 Electron 31.7.7 / builder 25.1.8 |
| ①-5 pixi 8 评估 | ✅ 结论：**不升**（2026-11-02 16:20） | — | `pixi-live2d-display@0.4` 仍硬绑 `@pixi/* ^6`，升 8 = 桌宠渲染全废；pdfjs-dist 4.10.38 同样不升（需 Chromium≥128，Electron 升级后再议）；TypeScript 6/7 不升 |
| ②-1 file_patch | P1–P3 完成（249 例，2026-11-02 16:54）；待「任意根即可注入 file_read」判据调整 | d.55 待 bump | `lib/fileEdit/**` 16 模块 + `FileEditCard` + 桌面 `file-fs.js`/`path-guard.js`；web 208 例 / desktop 41 例；越界=免问 + 工具层拒绝（有意偏差，已在规格记录） |
| ②-7a WS `?token=` 兼容路径删除 | ✅ 完成（2026-11-02 16:30） | d.54.2.17.0 | `packages/server/src/ws.ts` 不再读 query token；`ws.test.ts` 改为「query token 不再鉴权」+ 断言不入库；server 9 文件 / 122 例全绿 |
| ②-7b docker 清理 | ✅ 完成（2026-11-02 16:25） | d.54.2.17.0 | 删除 `docker/`（3 文件）与 `docker-compose.yml`；`docs/deploy.md` §11 改为「已清理」并保留 nginx 顺序约束的出处；HANDOFF §6 第 6 条同步 |
| ③-0 视觉基线截图 | ✅ 完成（2026-11-02 16:26） | 线上 d.54.2.17.0 | `.tmp/visual/before/` 13 页 PNG（1440×900）+ `manifest.json`；脚本 `.tmp/visual-capture.mjs`（CDP，可复跑）；Tailwind 4 迁移后对本地 dev 再截一轮做像素级对比 |
| ②-2 rollout 回放/重跑/分叉 | P0 完成（57 例纯逻辑，2026-11-02 16:32）；UI 增强进行中 | d.56 待 bump | `lib/rollout/{types,log,pair,fork,view}.ts`、`lib/tasks/store.ts`、`agentStream.ts`；`buildForkPrefix` 已用 `toAnthropicMessages`/`buildRequest` 验证合法形状；分叉/重跑落点已拍板 |
| ②-7c 发布流水线 `scripts/release.mjs` | 进行中（子代理，2026-11-02 16:33 起） | — | 十步固化 + `--dry-run` + 证据清单；部署/上传默认关闭需显式开关 |
| ②-5 P0-5b 热路径加密设计 | 进行中（子代理，2026-11-02 16:33 起） | — | 输出 `docs/superpowers/specs/2026-11-02-p0-5b-hotpath-encryption.md`（方案对比/迁移/性能预算/测试矩阵/分阶段） |
| ②-3 团队能力（用量排行/团队日程） | 待开始（等 baseline 的 zod4/Tailwind 落地再开 UI 轨） | — | — |
| ②-4 桌宠在场感 | 待开始（依赖 desktop 主进程改动收口） | — | — |
| ②-6 CSP 基线 | 待开始（依赖 desktop main.js 与 vite 配置收口） | — | — |
| ③-1 包体与首屏 | 待开始（依赖 Tailwind 落地） | — | 现状：主 bundle 1.47MB（React 19 后 +133KB）、officeparser 懒加载块 5.41MB |
| ③-2/③-3/③-4 无障碍/错误态/安全复审 | 待开始 | — | — |

### 追加记录（2026-11-02 17:00 前后）

| 批次/轮 | 状态 | 关键证据 |
|---|---|---|
| ②-2 rollout P0 纯逻辑 + P0 UI + P1/P2 纯逻辑 | ✅ 完成（168 例，2026-11-02 16:52）；最后 3 个文件的 UI 接线等 Tailwind 落地 | `.tmp/rollout-handoff.md`（INDEX 行/CHANGELOG 草稿/已知边界 5 条）；剪贴板失败三态已排队 |
| ②-5 P0-5b 设计稿 | ✅ 完成（455 行，2026-11-02 16:43）；Q1 fail-open / Q2 保持明文 / Q3 备份一个版本 已拍板 | `docs/superpowers/specs/2026-11-02-p0-5b-hotpath-encryption.md` §11 拍板记录 |
| ②-5 P0-5b P1 实施（web 侧） | 进行中（hotpath，2026-11-02 16:56 起） | 只改 `e2eSession.ts` / 新 `cacheEnvelope.ts` / `secureStorage.ts` / 测试；ChatPage 2 处调用与桌面批量通道留给 integration |
| ②-7c 发布流水线 `scripts/release.mjs` | ✅ 完成（2026-11-02 16:58） | 十步固化、`--dry-run` 实测无副作用、逐包重试分支双向验证；文档在 `VERSION-MANAGEMENT.md` §一条命令发版 与 `deploy.md` §6/§9；**注意**：worktree 脏需 `--allow-dirty`；`.superpowers/deploy-bare.py` 的 VERSION 硬编码在 D:\Heming 主检出，bump 后需手工同步 |

## 6. 第一波 integration 与发布清单（Lead 执行）

前提：①②两条轨的全部改动落在同一个工作树（`feat/team-system`），因此**一波一次发布**，版本号按「本波实际新增的能力数」累计：

| 项 | 内容 |
|---|---|
| 本波包含 | ① 工程基线（vite 8 / vitest 5 / React 19 / zustand 5 / zod 4 / Tailwind 4 / Electron 最新 / 补丁级依赖）；②-1 `file_patch`；②-2 回合日志回放/重跑/分叉；②-5 P0-5b P1（消息缓存与棘轮加密）；②-7 技术债（WS `?token=` 删除、docker 清理、release.mjs） |
| 目标版本 | **`d.57.2.18.0`**（特性 54→57：三个新能力；修订 17→18：工程基线与技术债；构建位不动），由 `node scripts/bump-version.mjs d.57.2.18.0` 一次写入五包 |
| 门禁 | `node scripts/release.mjs --only=gate --allow-dirty`（等价于 `pnpm -r build` + 逐包 test，允许单包重试一次），失败即停 |
| 手工核对 | ① `.tmp/visual/after/` 与 `.tmp/visual/before-local/` 13 页像素对比（Tailwind/React 19 视觉漂移）；② 桌宠窗口与输入框在 Electron 新版下可用；③ `file_patch` 在真实桌面端走通一次「加写根 → 改文件 → 确认卡 diff → 落盘」；④ P0-5b 迁移后「发消息 → 重载 → 仍能解密显示」；⑤ 旧明文备份键存在且可读 |
| 打包 | `pnpm -w run dist:desktop`（`release/r45`），核对 `resources/runtime` 7371 文件、内嵌 bundle 名与版本串、`latest.yml` sha512 |
| 部署 | `deploy-bare.py` 的 `VERSION` 需先手工改成 `d.57.2.18.0`（该文件在主检出且硬编码），然后 `backup` → `install`；`/api/health` 与线上 bundle 版本串人工核对 |
| 更新源 | `scripts/publish-update.sh` 上传 r45（需要 `HEMING_SSH_PWD`）；远端 `latest.yml` sha512 与 Range 206 人工核对 |
| 文档 | CHANGELOG 一条（含四个小节的 bullet）；HANDOFF §2 四行 + §5/§6 回填；INDEX 三行（已更新）；本文件台账回填 |

★ 已知风险：`d.57.2.18.0` 是本轮第一个「多轨合并」版本，回滚只能整体回退到 `d.54.2.17.0`（分支 `feat/team-system` 的上一提交），没有逐轨回滚路径——这一点要写进 HANDOFF 的已知风险。

### 视觉核对结论（2026-11-02 17:15，Lead）

- 工具：`.tmp/visual-capture.mjs`（CDP，登录后等 6.5s 让 4.5s 启动动画结束再截）+ `.tmp/visual-diff.ps1`（缩放到 360×225 后逐像素比）。
- 对照：线上生产构建 `d.54.2.17.0`（`.tmp/visual/before/`）vs 本地 dev（Tailwind 4 后，`.tmp/visual/after/`），13 页。
- 结果：像素差异 0.67%–6.9%，但**逐页裁切目视一致**（技能区/接口区/团队页已抽查）；差异集中在文字抗锯齿——生产包与 Vite dev 的字体渲染不同，不是布局漂移。位移搜索（dx/dy −2…2）确认无整体偏移。
- 结论：Tailwind 4 迁移**无结构性视觉回归**；最终构建产物出来后会在真实安装包上再对一轮。
- 已知可接受差异：`outline-hidden` 55 处、裸 `rounded→rounded-sm` 108 处、`blur→blur-sm` 4 处、base 层恢复 v3 默认边框色 `#e5e7eb`；`space-x/y` 改 `:not(:last-child)`（17 处）可能有 1px 级行距差异。

### 批次 ① 收口（2026-11-02 17:30）

- **①-1**：vite 8.3.5 / plugin-react 6.2.0 / vitest 5.0.5 / jsdom 30.1.3 / jest-dom 7.0.1 / RTL 16.3.3 / TS ^5.9.3 / 删 dommatrix；`clearMocks:false` 保持 526 处 `vi.fn` 语义。
- **①-2**：React 19.3.1（4 文件 6 处类型适配）、zustand 5.0.16（`ChatPage` selector 新数组 → `EMPTY_MESSAGES` 模块常量，v5 `useSyncExternalStore` 语义修复）、zod 4.6.7（三包；`plugins/manifest.ts` 的 `typeParams` 保持中文文案逐字不变；**shared 依赖变更后必须重建 shared/dist**）、katex 0.19.1 / shiki 4.6.0 / officeparser ~8.4.1。
- **①-3**：Tailwind 4.3.3 + `@tailwindcss/postcss`（移除 autoprefixer）；`outline-none→outline-hidden` 55 处、裸 `rounded→rounded-sm` 108 处、`blur→blur-sm` 4 处、base 层恢复 v3 默认边框色 `#e5e7eb`；42 个 className 文件；token 同名同值。视觉核对见上节。
- **①-4**：Electron 31.7.7→45.2.1、electron-builder 25.1.8→26.18.0、electron-updater 6.8.9→6.8.11；desktop 28 文件 / 443 例全绿；两条「45 破坏点不命中」证据（preload 只用 `require("electron")`+`process.platform`；`app://` 走 `protocol.registerSchemesAsPrivileged`+`protocol.handle`）。**safeStorage 同步三件套在 45 弃用、46 移除**——已在 `secret-store.js` 头部留提示，迁 `*Async` 需单独规格。
- **①-5**：pixi 6.5.10 不升（peer 死钉 ^6）；pdfjs-dist 4.10.38 本轮不升（Electron 45 的 Chromium≥128 已满足 `Promise.try`，下一批可评估 + 真机 PDF 冒烟）；TS 6/7、@types/node 26 不升。
- **环境坑（已写进 VERSION-MANAGEMENT）**：pnpm 不跑 electron postinstall（需 `ELECTRON_MIRROR` 重跑 install.js）；`detectElectronDist()` 会命中 `.pnpm` 下第一个 electron 目录，升级后必须先 `pnpm prune`。
- **批次 ① 最终验收**：web 175 文件 / 2664 例、shared 24、server 122、desktop 443 全绿；三包 tsc 0 错误；web build 通过。

### 第一波发布记录（2026-11-02 17:36 → ）

| 项 | 结果 |
|---|---|
| 全量门禁 | ✅ 2026-11-02 17:36 `node scripts/release.mjs --allow-dirty --only=build,tests`：build 8.7s / 逐包测试 4/4 无重试；shared 24、server 122、web 176 文件 / 2678 例、desktop 443 例；日志 `.tmp/gate-wave1.log` |
| 版本 | ✅ `d.57.2.18.0`（特性 54→57 三条新能力；修订 17→18 工程基线与技术债）；`bump-version.mjs` 五包同步，README 同步 |
| CHANGELOG | ✅ 六节条目（工程基线 / file_patch / 回合日志 v2 / 热路径加密 / 技术债 / 测试与验收），`build-changelog.mjs` 已同步 75 条 |
| 提交 | ✅ `e8cb91f`（149 文件，含删除 docker/） |
| 安装包 | 进行中：`node scripts/release.mjs --desktop --release-r 45`（r45） |
| 部署 + 更新源 | 进行中：同一条命令 `--deploy --publish`（备份 → 上传 → install → smoke → 传安装包 + latest.yml） |
| 文档回填 | HANDOFF §2 四行 + 里程碑 50–54 + §6 六条新边界已写入；线上/安装包两行等部署完成后回填 |

### 第一波发布完成（2026-11-02 19:55）

| 项 | 结果与证据 |
|---|---|
| 安装包 | ✅ `release/r45/和鸣 Setup d.57.2.18.0.exe` 228,090,147 字节；runtime 7371 文件 / 5026 `.py`；内嵌 `web/assets/main-3CwM7stV.js`；`和鸣.exe` 文件版本 57.2.18.0；sha512 与 `latest.yml` 逐字一致 |
| 云端部署 | ✅ `release.mjs` 第 8 步（备份 → 上传 15.5MB 包 → install → smoke）；`/api/health` `{"ok":true}`；线上主 bundle `main-qndET7YU.js` md5 `749A0318FC4D569242BE70F589CDFECC`，内含 `d.57.2.18.0` |
| 更新源 | ✅ `/updates/latest.yml` 200 + `application/octet-stream` + 355B，指向 57.2.18；远端 sha512（hex）与本地实算逐字一致；Range 206 |
| 发布链缺口 | ⚠ `release.mjs --publish` 调 `bash scripts/publish-update.sh`，但本机**没有 Git Bash**，`bash` 落到 WSL 并失败（`0x8007054f`）→ 本次用 `.tmp/publish-update.py`（paramiko）手工完成；**下一轮应把 publish 步骤改成 Node/Python 实现，或脚本内自动回退** |
| 备份 | ✅ `.tmp/backups/heming-data-2026-11-02.tar.gz` 6.2KB（同名覆盖当天旧备份，见 HANDOFF 提醒） |
| 提交 | `e8cb91f`（代码+文档），发布证据回填后再补一个 docs 提交 |

## 7. 第二波（2026-11-02 20:00 起，目标 d.59.2.19.0）

第一波已发布（d.57.2.18.0 上线 + r45 安装包与更新源已上传）。第二波四轨并行：

| 轨 | 内容 | 负责人 | 关键文件 | 主要风险 |
|---|---|---|---|---|
| ③-1 性能与包体 | 文档解析/PDF 按需加载、主 bundle 路由级拆分、首屏 gzip 对比 | baseline | `vite.config.ts`、`App.tsx`、各页面 import | 懒加载边界错会导致运行时报错；需行为不变的证明 |
| 发布链修复 | `scripts/publish-update.mjs` 替代依赖 Git Bash 的 shell 版；`release.mjs` 第 9 步改用它 | baseline | `scripts/` | 本次发布已踩坑（WSL bash 失败），必须修 |
| ②-4 桌宠在场感 | 任务收尾/日程临期/幕僚简报 → `pet:event` → 姿态+气泡+点击直达；渠道互斥、三档打扰 | hotpath | `pet-host.js`、`lib/pet*`、`components/pet` | 主窗口前台互斥与文案脱敏 |
| ②-3 团队能力 | 用量排行（服务端聚合、白名单摘要、默认只显示本人）+ 团队日程只读区 | rollout | `server/team.ts`、`TeamPage.tsx`、`shared` | 隐私红线（不含正文/提示词/参数）；新表幂等 |
| 安全收口 | safeStorage 同步→异步迁移（Electron 46 前必须）+ P0-5b P3 备份键清理 | filepatch | `secret-store.js`、`preload.js`、`secureStorage.ts`、`e2eSession.ts` | 渲染层同步读改异步的时序风险；回退路径 |

**写入边界**：`App.tsx`/`main.tsx` 归 baseline；`TeamPage/TeamBoard` 归 rollout；`pet-host/main.js` 归 hotpath；`secret-store/preload/secureStorage/e2eSession` 归 filepatch；`scripts/` 与 `vite.config.ts` 归 baseline。版本号/CHANGELOG/HANDOFF/INDEX/提交/门禁/打包/部署仍归 Lead。

**版本预期**：特性 57→59（桌宠在场感 + 团队能力两项新能力）、修订 18→19（性能/发布链/安全收口），即 `d.59.2.19.0`；若某项未完成则相应少加，发布前按实际落地项重算。

### 第二波完成与发布准备（2026-11-02 20:35）

| 轨 | 结果 |
|---|---|
| ③-1 首屏与包体 | ✅ 首屏 JS gzip 579.8→**119.7 KB（−79.4%）**，应用自有代码 −92%，chunk 28→62；`petEvent` 82.8→**2.7 KB gzip** 并移出 index 预载；两处工程发现（顶层 await 碎块、lazy 与 d39 断言）已入文档 |
| 发布链修复 | ✅ `scripts/publish-update.mjs`（Node+paramiko，win32 直跑），`release.mjs` 第 9 步接线；自检上传/校验/删除通过，线上 latest.yml 未被覆盖 |
| ②-4 桌宠在场感 | ✅ 90 web 例 + 67 desktop 例；零生产者改动、渠道互斥、三档强度即时生效、文案脱敏、错过不补发 |
| ②-3 团队能力 | ✅ 39 例（server 双实现 + web）；用量排行白名单聚合、默认关、清除 + 水位、团队日程只读；隐私断言覆盖 |
| 安全收口 | ✅ 47 例（desktop 22 / web 25）；safeStorage 异步迁移 + 批量白名单 + 300ms hydrate + P3 备份安全清理 + msgCache 全量迁移 |
| 全量门禁 | ✅ 2026-11-02 20:31：4/4 包通过无重试；shared 29 / server 141 / web 181 文件 2762 例 / desktop 28 文件 474 例；三包 tsc 0 错误 |
| 版本 | `d.59.2.19.0`（特性 57→59 两条新能力：桌宠在场感、团队能力；修订 18→19：首屏/发布链/安全收口） |
| 待办 | 打包 r46 → 部署 → 发布更新源 → 回填 HANDOFF §2 与证据 |

### 第二波发布完成（2026-11-02 20:42）

| 项 | 结果与证据 |
|---|---|
| 提交 | ✅ `032a8e1`（d.59.2.19.0，本波全部改动 + 文档） |
| 门禁 | ✅ build 通过；逐包 4/4 无重试（shared 29 / server 141 / web 181 文件 2762 例 / desktop 28 文件 474 例）；三包 tsc 0 |
| 安装包 | ✅ `release/r46/和鸣 Setup d.59.2.19.0.exe` 228,168,519 字节；sha512 三方一致；runtime 7371 文件 / 5026 `.py`；内嵌 `web/assets/main-BcTTEUM3.js` 仅 120,666 字节（首屏瘦身反映到包内） |
| 云端部署 | ✅ `release.mjs` 8 步 OK（备份 → 上传 → install → smoke）；`/api/health` `{"ok":true}`；线上 `main-JIK5hIB3.js`（md5 `03BA7DD7…`），版本串在懒加载 chunk `SettingsPage-DnT0NC0q.js`（md5 与本地逐字一致 `D11B2584…`） |
| 更新源 | ✅ `latest.yml` 355B/200/octet-stream，指向 59.2.19，与本地字节逐一相同（中文名未重编码）；安装包 Range 206；**发布脚本换成了 `publish-update.mjs`，不再依赖 Git Bash** |
| 备份 | ✅ `.tmp/backups/heming-data-2026-11-02.tar.gz`（同名覆盖当天旧版，仍是待改的运维纪律） |
| 第三波候选 | `task-9` CSP 基线（report-only 起步）、`task-10` 启动时序（hydrate 后 setState，Electron 46 前必须）、`task-11` 无障碍与错误态巡检、`task-12` pdfjs 6 评估 |

## 8. 第三波（2026-11-02 20:45 起）

第二波已发布 d.59.2.19.0（上线 + r46 安装包 + 更新源）。第三波四轨并行：

| 轨 | 内容 | 负责人 | 主要风险/边界 |
|---|---|---|---|
| ②-6 CSP 基线 | web/桌面 `app://` 的 CSP，先 report-only 收集违例再 enforce；`connect-src` 必须含用户自填 baseUrl | filepatch | 内联脚本/样式是否需豁免；不能挡模型直连供应商 |
| 启动时序（Electron 46 前置） | hydrate 完成后 `store/llm.ts`、`lib/mcp/store.ts` 自动补全且不覆盖用户编辑；E2E identity 纳入时序 | hotpath | 与用户编辑竞态；46 无同步桥兜底 |
| ③-2/③-3 无障碍与错误态 | 键盘可达、焦点环、aria-live（流式不高频播报）、对比度计算、异步三态与断网行为 | rollout | 只标注不改视觉；清单逐条「已修/已存在/不适用」 |
| pdfjs-dist 6 评估 | v6 breaking + Electron 45 真机 PDF 冒烟，决定升/不升 | baseline | worker 崩溃风险；只动 pdfjs 相关行 |

**已顺手完成的运维根治**：`deploy-bare.py backup` 文件名加版本号（`heming-data-<日期>-<VERSION>.tar.gz`），不再同日覆盖；`docs/deploy.md` §6 与 HANDOFF §5-1 已同步。

**版本预期**：第四波发布时按实际落地项重算（CSP/时序/无障碍偏 fix，pdfjs 若升则算依赖维护）。

### 第三波完成（2026-11-02 21:30）

| 轨 | 结果 |
|---|---|
| ②-6 CSP 基线 | ✅ 主/桌宠分别策略；`HEMING_CSP_MODE=off|report|enforce`，默认 report；完整产物 6 组合 + pdfjs v6 worker 4 组合冒烟全过、违例 0；`wasm-unsafe-eval` 与桌宠 `unsafe-eval` 均有硬证据并限定作用域 |
| 启动时序（46 前置） | ✅ hydrate 后 llm/mcp/e2e 三路补读（三条合并规则 + MCP 推迟预置 + 身份 1.5s 等待），13 例；契约入迁移文档 §10 |
| ③-2 无障碍与可读性 | ✅ 修焦点环系统性回归（59 处）、登录/通知/流式/附件语义；`muted` 达 AA、`line-strong` 表单边界、138 处文字色统一；审计文档入库 |
| ③-3 错误态与离线 | ✅ 逐入口三态复核；附件上传刻意不重试（已记录取舍） |
| pdfjs 6 | ✅ 4.10.38 → 6.5.438，真机冒烟通过、parse.ts 零改动、首屏零影响、回退一步 |
| 全量门禁 | ✅ shared 29 / server 141 / web 186 文件 2798 例 / desktop 28 文件 494 例，4/4 无重试；三包 tsc 0 |
| 版本 | `d.59.2.20.0`（纯加固与维护：修订 19→20） |

### 第三波发布完成（2026-11-02 21:45）

| 项 | 结果与证据 |
|---|---|
| 提交 | `96878ae`（d.59.2.20.0）+ `c349463`（BOM 修复与守卫） |
| 门禁 | build 通过；逐包 4/4 无重试（shared 29 / server 141 / web 186 文件 2798 例 / desktop 28 文件 494 例）；三包 tsc 0 |
| 安装包 | `release/r47/和鸣 Setup d.59.2.20.0.exe` 228,193,912 字节，sha512 本地/远端/清单三方一致 |
| 云端部署 | ✅ 首次**失败**（nginx 配置带 UTF-8 BOM → unknown directive → 回退默认站点），去 BOM + release.mjs 预检加 BOM 守卫后重跑成功；`/api/health` ok、首页 200、线上 bundle `main-CUKCJzyM.js` 与本地同名 |
| CSP | ✅ 线上响应头 `Content-Security-Policy-Report-Only` 已生效（策略含 `script-src 'self' 'wasm-unsafe-eval'`、`connect-src … https: wss: localhost/127.0.0.1`），本版按计划**只 report-only** |
| 更新源 | ✅ latest.yml 指向 59.2.20，sha512 与安装包一致，Range 206 |
| 备份 | ✅ `heming-data-2026-11-02-d.59.2.20.0.tar.gz`（8.1KB）——**文件名带版本号已生效，不再同日覆盖** |
| 第四波 | `task-13` ③-4 安全复审、`task-14` Electron 46 前置收尾（E2E 热路径异步化 / 明文写窗口 / 同步桥降级） |

### 第四波完成（2026-11-02 22:15）

| 轨 | 结果 |
|---|---|
| ③-4 安全复审 | ✅ 28 条结论（`research/2026-11-02-security-review.md`）；**修掉越权 IPC**（能力型 IPC 复审前对任意渲染进程开放，桌宠共用 preload 可越权）+ 桌宠导航闸 + wiki-fs 上限 + IPC 通道不变量守卫（负向验证过）；待修 4 条入档 |
| Electron 46 就绪 | ✅ E2E 热路径「预取 + 内存视图 + 异步落盘」（零同步 IPC）；`secureSetItem` 异步写优先、明文窗口消除（用例断言返回时磁盘是密文或未写）；同步桥降级为 45 兜底；46 升级检查清单 8 步 |
| 全量门禁 | ✅ shared 29 / server 141 / web 188 文件 2815 例 / desktop 29 文件 518 例，4/4 无重试；三包 tsc 0 |
| 版本 | `d.59.2.21.0`（纯加固：修订 20→21） |

### 「全面升级」目标完成情况（四批八轨全部落地）

| 批次 | 内容 | 状态 |
|---|---|---|
| ④ 发布与文档收尾 | HANDOFF/INDEX 回填、安装包缺 runtime 修复、备份名版本化、BOM 守卫、旧 IM 数据 dry-run | ✅（旧 IM 真删待用户点头） |
| ① 工程基线升级 | React 19 / zustand 5 / zod 4 / Vite 8 / Vitest 5 / Tailwind 4 / Electron 45 / pdfjs 6；pixi 与 TS6 有证据不升 | ✅ |
| ② 功能与技术债 | `file_patch`、回合日志回放/重跑/分叉、团队用量/日程/清除、桌宠在场感、P0-5b 加密与清理、CSP、release.mjs + publish-update.mjs、docker 清理、WS `?token=` 删除 | ✅ |
| ③ 体验与安全加固 | 首屏 −79.4%、无障碍 AA 与焦点环、错误态/离线巡检、safeStorage 异步迁移、安全复审（越权 IPC 修复） | ✅ |
| 需用户决定的遗留 | ① `feat/team-system` 合并回 `main`（main 被 WorkBuddy 工作树占用）；② 线上旧 IM 数据是否真删（dry-run 仅 3 行）；③ CSP 何时从 report-only 切 enforce；④ NVDA 真机走查与桌宠/file_patch 手工联调；⑤ 安全复审待修 4 条（草稿/token 明文、可写根 rootId、files mime nosniff）排期 | 待定 |

### 第四波发布完成（2026-11-02 22:22）——「全面升级」四批全部发布

| 项 | 结果与证据 |
|---|---|
| 提交 | `73cfa51`（d.59.2.21.0 全部改动与文档） |
| 门禁 | build 通过；逐包 4/4 无重试（shared 29 / server 141 / web 188 文件 2815 例 / desktop 29 文件 518 例）；三包 tsc 0 |
| 安装包 | `release/r48/和鸣 Setup d.59.2.21.0.exe` 228,200,790 字节，sha512 本地/远端/清单三方一致 |
| 云端部署 | ✅ 8 步 OK；`/api/health` ok、首页 200、线上 bundle `main-C_syY_6C.js` 与本地同名、CSP report-only 头在位 |
| 更新源 | ✅ latest.yml 指向 59.2.21，sha512 与安装包一致 |
| 备份 | ✅ `heming-data-2026-11-02-d.59.2.21.0.tar.gz` |
| 结论 | 目标四个批次全部落地并已上线：`d.57.2.18.0` → `d.59.2.19.0` → `d.59.2.20.0` → `d.59.2.21.0`（同一天四个发布，每个都有全量门禁与证据回填） |

## 9. 第五波：用户体验优化轮（2026-11-02 22:30 起）

触发：用户「继续优化用户体验」。规格 `docs/superpowers/specs/2026-11-02-d60-ux-round.md`，审计截图 `.tmp/ux/before/`（13 张流程图）。

| 轨 | 内容 | 负责人 | 关键风险 |
|---|---|---|---|
| UX-A | 首跑引导卡（三步骤真实状态、可关闭、本机持久化）+ 未绑定模型提示统一（对话页/任务区同源、禁用发送）+ 对话空态示例提示（点击只填不发）+ 输入快捷键提示 | rollout | ChatPage 改动大，需保证既有发送/流式/草稿用例不回归 |
| UX-B | 命令面板 v2：分组（最近使用/页面跳转/常用动作）、检索页面+设置分区+动作、键盘完整、动作走既有 store | baseline | 不新增 IPC/依赖；最近使用只存本机 |
| UX-C | `PageFallback` 骨架（保留 d39 测试锚点）、登录页圆环不压表单、文件栏标题与空态 | filepatch | 骨架不能挡交互；d39 「切页建连」用例必须仍绿 |

验收：三轨定向用例 + tsc + build；发布前全量门禁；用 `.tmp/ux-capture.mjs` 重截同一批流程与 `.tmp/ux/before` 对照（脚本已改为用 CDP Input 发送 Ctrl+K/Escape，避免合成事件关不掉面板）。

### 第五波：用户体验优化轮完成（2026-11-02 23:00）

| 轨 | 结果 |
|---|---|
| UX-A 首跑引导与提示同源 | ✅ 主页「开始使用」三步骤（真实状态派生、本机持久化）+ 未绑定模型提示三处同源（对话页禁用发送）+ 空态 3 条可点击示例（只填不发，用例断言无请求）+ 输入快捷键提示；33 例；顺手修掉「Event 当时间戳」真 bug |
| UX-B 命令面板 v2 | ✅ 空查询三分组（最近使用/13 页面/4 动作）、输入检索页面+设置分区+动作+成员+技能+归档、完整键盘与 listbox a11y、四个动作真执行（意图槽内存态幂等）；55 例 |
| UX-C 骨架与静态细节 | ✅ PageFallback 页面骨架（保留 d39 锚点）、登录页圆环根因是 BootWave 波纹（登录场景只落右半区）、文件栏标题与空态；9 例 |
| 全量门禁 | ✅ shared 29 / server 141 / web 194 文件 2913 例 / desktop 29 文件 518 例；4/4 无重试；三包 tsc 0 |
| 视觉证据 | `.tmp/ux/before` → `.tmp/ux/after`（13 张同流程截图）；命令面板与首跑主页变化最明显 |
| 版本 | `d.60.2.21.0`（特性 59→60：命令面板 v2 与首跑引导为新能力；修订位不变） |

### 第五波发布完成（2026-11-02 23:12）

| 项 | 结果与证据 |
|---|---|
| 提交 | `a1a7805`（d.60.2.21.0 全部改动与文档） |
| 门禁 | build 通过；逐包 4/4 无重试（shared 29 / server 141 / web 194 文件 2913 例 / desktop 29 文件 518 例）；三包 tsc 0 |
| 安装包 | `release/r49/和鸣 Setup d.60.2.21.0.exe` 228,208,571 字节，sha512 三方一致 |
| 云端部署 | ✅ 8 步 OK；`/api/health` ok、首页 200、线上 bundle `main-BR3JMFt_.js` 与本地同名、CSP report-only 在位 |
| 更新源 | ✅ latest.yml 指向 60.2.21，sha512 与安装包一致 |
| 备份 | ✅ `heming-data-2026-11-02-d.60.2.21.0.tar.gz` |
| 视觉 | `.tmp/ux/before` → `.tmp/ux/after` 13 张同流程对照（首跑引导卡与新命令面板已截到） |

## 10. 第六波：体验优化第二轮（2026-11-02 23:15 起）

触发：用户「继续」。规格 `docs/superpowers/specs/2026-11-02-d61-ux-round2.md`。

| 轨 | 内容 | 负责人 | 关键边界 |
|---|---|---|---|
| UX-D | 全局本机搜索：任务/记忆/插件进命令面板（分组顺序、每组 ≤5、意图槽定位） | baseline | 只搜本机、不发请求、不搜消息正文 |
| UX-E | 设置页内搜索：卡片级 registry + 跨分区过滤 + 点击滚动高亮 2 秒 | rollout | 只加搜索与锚点，不改设置项行为 |
| UX-F | 快捷键帮助面板（`?`/`Ctrl+/`，导航 Alt 从 palette 生成）+ 通知中心类型筛选与清空二次确认 | filepatch | Esc 只关自己；不改通知存储格式 |

版本预期：`d.61.2.21.0`（特性 +1：全局本机搜索与快捷键帮助）。

### 第六波完成（2026-11-02 23:38）

| 轨 | 结果 |
|---|---|
| UX-D 全局本机搜索 | ✅ 任务/记忆/插件进命令面板（固定顺序、每组 ≤5 + 「还有 N 条」）；任务复用 `focusTask`，记忆/插件意图槽定位 + 2 秒高亮；只读本机、不搜消息正文；28 例 |
| UX-E 设置页内搜索 | ✅ 13 张卡 registry + 双向源码守卫；跨分区匹配、点击切分区滚动 + ink 高亮、Esc 清空；18 例 |
| UX-F 快捷键帮助 + 通知中心 | ✅ `?`/`Ctrl+/` 面板（导航组从 pages 生成、输入框不触发、Esc 只关自己）+ 通知类型筛选（未读口径不变）+ 清空确认补「不可恢复」；12 例 |
| 全量门禁 | ✅ shared 29 / server 141 / web 199 文件 2971 例 / desktop 29 文件 518 例；4/4 无重试；三包 tsc 0 |
| 版本 | `d.61.2.21.0`（特性 60→61） |

### 第六波发布完成（2026-11-02 23:45）

| 项 | 结果与证据 |
|---|---|
| 提交 | `210c9bb`（d.61.2.21.0） |
| 门禁 | build 通过；逐包 4/4 无重试（shared 29 / server 141 / web 199 文件 2971 例 / desktop 29 文件 518 例）；三包 tsc 0 |
| 安装包 | `release/r50/和鸣 Setup d.61.2.21.0.exe` 228,214,478 字节，sha512 三方一致 |
| 云端部署 | ✅ 8 步 OK；`/api/health` ok、首页 200、线上 bundle `main-DN-9K-jH.js` 与本地同名、CSP report-only 在位 |
| 更新源 | ✅ latest.yml 指向 61.2.21，sha512 与安装包一致 |
| 备份 | ✅ `heming-data-2026-11-02-d.61.2.21.0.tar.gz` |

## 11. 第七波：页面布局与 UI 排版统一（2026-11-03 08:30 起）

触发：用户「优化页面布局和 UI 排版」。规格 `docs/superpowers/specs/2026-11-03-d62-layout-typography.md`。

**审计结论**：字号 11 档（10/11/12px 各上百处）、页面标题 15/16/17px 混用、内边距 24/32px 混用、内容宽度通栏/520/900 三种、页头结构不一、滚动容器位置不一、聊天正文行宽近 980px。

**Lead 已落地的基础**：
- `index.css` 新增语义排版类（`ui-page-title`/`ui-page-sub`/`ui-section-title`/`ui-body`/`ui-body-sm`/`ui-caption`/`ui-micro`/`ui-numeric`），中文行高 1.55–1.7；
- `components/layout/PageShell.tsx`：统一页头 + 内容宽度档位（full/wide 1200/readable 960/narrow 720）+ 可选自管滚动；
- `HomePage` 作为参考实现已迁移（页头 + wide + gap-4），新增 `PageShell.test.tsx` 4 例。

**三轨**：A 列表页（Plugins/Interfaces/Automation/Staff/Skills/Registry/Infohub）、B 分栏页（Team/TeamBoard/Settings/Memory）、C 聊天与壳（Assistant/Chat/TaskArea/App 右栏）。文件级不重叠。

**基线截图**：`.tmp/layout/before/`（对线上 d.61.2.21.0 生产构建截 13 页），改造后 `.tmp/layout/after/` 对照。

### 第七波完成与发布（2026-11-03 08:50）

| 项 | 结果 |
|---|---|
| 排版基元 | ✅ 8 个 `ui-*` 语义档（18/700? 见 spec）+ `PageShell`（固定页头/24px/宽度档/滚动归属）+ PageShell 4 例 |
| A 列表页 | ✅ 7 页迁 PageShell（wide/readable/full），删自写 h1、section 统一、gap-4、去内层双重限宽；74 例 |
| B 分栏页 | ✅ 团队/团队看板/设置/记忆 统一页头 + headerExtra；设置内容列 720 左对齐；布局守卫 4 例 |
| C 聊天与壳 | ✅ 智能体/聊天/任务区/App 右栏统一；聊天消息列与输入区 880 居中；ChatPage 布局断言 1 例 |
| 全量门禁 | ✅ shared 29 / server 141 / web 200 文件 2980 例 / desktop 29 文件 518 例；4/4 无重试；三包 tsc 0 |
| 版本 | `d.61.2.22.0`（修订 21→22） |
| 视觉基线 | `.tmp/layout/before`（线上 d.61.2.21.0 生产构建 13 页）→ `.tmp/layout/after` / `after2` |

### 第七波发布完成（2026-11-03 08:56）

| 项 | 结果与证据 |
|---|---|
| 提交 | `4905c26`（排版基元 + 主页参考）+ `a13a3e4`（16 页落地 + 文档） |
| 门禁 | build 通过；逐包 4/4 无重试（shared 29 / server 141 / web 200 文件 2980 例 / desktop 29 文件 518 例）；三包 tsc 0 |
| 安装包 | `release/r51/和鸣 Setup d.61.2.22.0.exe` 228,217,379 字节，sha512 三方一致 |
| 云端部署 | ✅ 8 步 OK；`/api/health` ok、首页 200、线上 bundle `main-BMT7S661.js` 与本地同名、CSP report-only 在位 |
| 更新源 | ✅ latest.yml 指向 61.2.22，sha512 与安装包一致 |
| 备份 | ✅ `heming-data-2026-11-03-d.61.2.22.0.tar.gz` |
| 视觉 | `.tmp/layout/before`（线上 d.61.2.21.0）→ `.tmp/layout/after` / `after2`；左边缘对齐、页头固定、标题档统一、聊天列 880 |

## 12. 第八波：组件级排版与控件规范（2026-11-03 08:58 起）

触发：用户「继续全部优化改进」。规格 `docs/superpowers/specs/2026-11-03-d63-component-typography.md`。

**d.62 留下的 5 项一起做**：① 卡片内部字号各写一套；② 控件尺寸不统一（按钮 h-7/8/9、输入框高度、胶囊 10/11px）；③ 表格/列表行无规范（th 档位、行高、数字列对齐）；④ 空态与骨架各写一套；⑤ 登录页不在新排版体系里。

**Lead 已落地基元**（`index.css`，`@layer components`）：`.ui-input`（高 32）、`.ui-btn*`（两档尺寸 + 三个变体）、`.ui-chip`、`.ui-table`、`.ui-list-row`、`.ui-empty*`、`.ui-skeleton`（含 reduced-motion 降级）。设计约束：字号只走 `ui-*` 档、点击区 ≥28、hover 150ms、焦点环仍由 GlobalFocusRing 统一提供。

**三轨**：T1 设置卡片与弹窗（12 张卡 + SettingsPage + 3 个弹窗）、T2 表格/列表/密集控件（Interfaces/Registry/Skills/Plugins/Team/Memory/Infohub）、T3 空态骨架组件 + 登录页（Home/Automation/Staff/TeamBoard/PageFallback/LoginPage）。

### 第八波完成与发布（2026-11-03 09:20）

| 项 | 结果 |
|---|---|
| 控件基元 | ✅ `index.css` 七组基元（input/btn 两档三变体/chip/table/list-row/empty/skeleton + reduced-motion） |
| T1 设置卡与弹窗 | ✅ 12 卡 + SettingsPage + 3 弹窗，152 处 className 收口；15 文件 177 例全绿；保留 7 处「不敢统一」并写明理由 |
| T2 表格/列表/密集控件 | ✅ 7 页；三张表统一 `.ui-table`（宽表内部滚动、数字列右对齐）+ 列表 `.ui-list-row` + 胶囊/按钮/输入档位；102 例全绿，新增 0（纯 class 迁移） |
| T3 空态骨架 + 登录页 | ✅ 新增 EmptyState/Skeleton 组件并替换 5 处；登录页归位新体系；+8 例；d39 仍绿 |
| 事故与修复 | ⚠ 首轮全量门禁 web 红 1 例（`paletteLocalConsume` 断言 `ring-2`，T2 把记忆条目定位高亮改成 bg）→ 统一回 ring 高亮（三层一致），复跑全绿；另 dev server 旧模块热更导致 `PageFallback` 运行时报错（清 Vite 缓存重启即正常，非代码缺陷） |
| 全量门禁 | ✅ shared 29 / server 141 / web 202 文件 2988 例 / desktop 29 文件 518 例；4/4 无重试；三包 tsc 0 |
| 版本 | `d.61.2.23.0`（修订 22→23） |
| 视觉 | `.tmp/d63/pages`（13 页）+ `.tmp/d63/after`（流程）对照 d.62 |

### 第八波发布完成（2026-11-03 09:28）

| 项 | 结果与证据 |
|---|---|
| 提交 | `bed1923`（控件基元）+ `623e9a0`（三轨落地 + 文档） |
| 门禁 | build 通过；逐包 4/4 无重试（shared 29 / server 141 / web 202 文件 2988 例 / desktop 29 文件 518 例）；三包 tsc 0 |
| 安装包 | `release/r52/和鸣 Setup d.61.2.23.0.exe` 228,219,273 字节，sha512 三方一致 |
| 云端部署 | ✅ 8 步 OK；`/api/health` ok、首页 200、线上 bundle `main-DHGyw_9J.js` 与本地同名、CSP report-only 在位 |
| 更新源 | ✅ latest.yml 指向 61.2.23，sha512 与安装包一致 |
| 备份 | ✅ `heming-data-2026-11-03-d.61.2.23.0.tar.gz` |
| 视觉 | `.tmp/d63/pages`（13 页）+ `.tmp/d63/after`（流程） |
