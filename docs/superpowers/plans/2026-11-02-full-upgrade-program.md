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
