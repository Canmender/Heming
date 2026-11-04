# 和鸣版本管理

> ## 最高优先级规则（先看这里）
>
> 1. **每一次修改、修复、重构，无论大小，都要改版本号。** 没有 bump 的改动视为未完成。
> 2. **数字只增不减**：任一位只允许 +1，**永不归零**。`d.5.1.0.0` 的下一个 feature 是
>    `d.6.1.0.0`，中间的破坏/修订/构建数原样保留——每一位都是「至今累计做了多少次这类改动」，
>    版本号本身就是迭代记录。bump 脚本会拦住任何试图写小的版本号。
> 3. 一条命令搞定，不用手算：`node scripts/bump-version.mjs auto <fix|feature|breaking|build>`
>    （等价 `pnpm version:bump auto fix`）。一条命令会**同步全部 5 个 package.json**。
> 4. 想知道当前是哪一版：`node scripts/version.mjs`（等价 `pnpm version:show`）——
>    一次打印 5 段版本、semver、CHANGELOG 最近条目、磁盘上的安装包与时间、最近提交。
> 5. 改完版本要在 `CHANGELOG.md` 顶部补一行条目，说明这次改了什么。
> 6. 安装包文件名、Windows「应用和功能」、主页版本徽标、设置区底部展示，全部取自同一个
>    `hemingVersion`，所以只要版本号变了，这几处会一起变，不会出现「文件名是新版、界面写旧版」。
>
> 本文其余部分是规则细节与理由。

规则沿用 MultiAgent（合鸣）的 5 段版本方案，本文件是 heming 的落地说明。

## 版本号格式

```
<通道>.<特性>.<破坏性>.<修订>.<构建>        例：d.5.1.0.0
<通道>.<特性>.<破坏性>.<修订>.<构建>-dev.<n>  例：d.5.1.0.0-dev.3（预发）
```

| 段 | 含义 | 什么时候加 |
|----|------|-----------|
| 通道 | `d` = desktop（桌面安装包；云端网页沿用同一版本号）、`c` = cloud、`m` = mobile | 换发布通道才动 |
| 特性 | 新功能**累计**次数 | 本次发布有新能力 → 加 1 |
| 破坏性 | 不兼容变更（数据格式、接口、配置项语义）**累计**次数 | 会让旧数据/旧配置失效才加 1 |
| 修订 | 缺陷修复**累计**次数 | 只有修复没有新功能 → 加 1 |
| 构建 | 每次发布的构建序号 | 同版本重出包（修打包问题、重签名）→ 加 1 |

### 为什么低位不再归零

早期规则是「高位 +1、低位清零」，于是 `d.3.0.1.0`（修过 1 次）会变成 `d.4.0.0.0`——
修订数被抹掉，看版本号已经无法知道历史累积了多少次修复，迭代记录只能去翻 CHANGELOG。

改成累积计数后，每一位数字都单调不减：`d.5.1.0.0` → `d.6.1.0.0`，那个 `1` 一直在。
这也顺带消除了「版本号变小看起来像降级」的困扰——过去低位归零时，
`d.3.0.1.0 → d.4.0.0.0` 的数字是**在变小**的。

> 历史条目（`d.5.1.0.0` 之前）沿用旧规则，不追溯改写——改了等于伪造迭代历史。
> `version-sync.test.js` 的「只增不减」检查从规则切换点 `d.5.1.0.0` 起生效。

配套字段（`scripts/bump-version.mjs` 一次写齐五个包，不要手工改）：

| 字段 | 值 | 谁在用 |
|------|-----|--------|
| `hemingVersion` | `d.5.1.0.0` | 用户可见的版本：设置区展示、更新比较、文档、vite 注入 |
| `version` | `5.1.0` | electron-builder 只接受 semver，由 5 段派生；**不带构建号** |
| `shortVersion` / `shortVersionWindows` | `5.1.0.0` | Windows 四段版本，仅记录与工具用 |

> ⚠️ **别把构建号加回 `version`**（即不要写成 `5.1.0-build.0`）。
> semver 里 `-` 之后是 **prerelease**，`5.1.0-build.0` 会被判成预发布版，
> 而 **electron-updater拒绝发布预发布版**——表现是不生成 `latest.yml`、
> 客户端永远提示「已是最新」，界面上与正常无差别，靠看日志发现不了。
> 构建号并没有丢：它完整保留在 5 段 `hemingVersion` 与 Windows 四段里，
> 5 段版本才是「同版本重出包」与用户展示的依据。

**会被同步的包**（`bump-version.mjs` 的 `SYNCED_PACKAGES`）：

| 包 | 写 `hemingVersion` + `version` | 额外字段 |
|----|-------------------------------|---------|
| 仓库根 `package.json` | 是 | — |
| `packages/desktop/package.json` | 是 | `shortVersion` / `shortVersionWindows` |
| `packages/web/package.json` | 是 | — |
| `packages/server/package.json` | 是 | — |
| `packages/shared/package.json` | 是 | — |

`hemingVersion` 与 `version` 写在**全部五个包**，由脚本一次改完——过去手工改版本只动其中一处，
根包与应用漂移过；而 web/server/shared 三个子包的 `version` 曾长期停在 `0.0.1`，
`vite.config.ts` 注入的正是 web 包自己的 `version`，主页徽标因此永远显示「版本 v0.0.1」。
子包是 `workspace:*` 内部包，版本号不参与依赖解析，改它不影响 lockfile。

## 怎么改版本

```bash
node scripts/bump-version.mjs auto fix       # 或 pnpm version:bump auto fix
node scripts/bump-version.mjs d.5.2.0.0      # 或直接指定（必须大于当前版本）
```

脚本会打印每个包的 `旧 → 新` 与派生值。**目标版本必须大于当前版本**，否则直接退出——
这是「只增不减」的强制执行点，防止手滑把版本号改小导致安装包互相覆盖。

**每次发布必做，漏改版本等于没发版**：安装包文件名、
「应用和功能」里的显示名、设置区展示、主页徽标全部取自 `hemingVersion`。

发布顺序：

1. `node scripts/bump-version.mjs auto <fix|feature|breaking|build>`
2. 在 `CHANGELOG.md` 顶部补条目（标题格式固定：`## d.x.y.z（YYYY-MM-DD）— 一句话标题`）
3. `node scripts/build-changelog.mjs` —— 把 CHANGELOG 转成设置区「更新日志」卡读的
   `packages/web/src/generated/changelog.ts`（忘了会被 `changelog-sync.test.js` 抓出来）
4. `pnpm dist:desktop`（内部会先构建嵌入用的 web 产物）
5. 需要时部署云端（见 `docs/deploy.md`）
6. **打发布标签并推送**（每版必做，便于回滚与对照）：
   `git tag -a d.x.y.z -m "release d.x.y.z（YYYY-MM-DD 部署）"` → `git push origin d.x.y.z`。
   （`d.66.2.25.0` / `d.67.2.25.0` / `d.68.2.26.0` 是 2026-11-04 补打的示例；标签打在「版本 + CHANGELOG + 证据回填」所在的提交上）
7. **合并与推送**：在 clean 的 main 工作树里 `git merge --ff-only <发布提交>`，再 `git push origin main`；
   远端 feature 分支合并后即可删除（`git push origin --delete <分支>`、`git branch -d <分支>`）。
8. **清理旧版**（发布后）：`/opt/heming/updates/` 只保留最近 **2 版**（当前 latest + 上一版，客户端回滚够用）；
   `/opt/heming/keep/` 是服务器回滚依赖，**不清理**；本机 `packages/desktop/release/` 只留最近 2 个 `rNN`。
   仓库侧建议保持 `fetch.prune=true` / `pull.ff=only`（本机已设），已合并分支及时删，未合并分支不要删。

## 一条命令发版

上面那串顺序（加上门禁、备份、部署与更新源上传）已固化成 `scripts/release.mjs`——
Node ESM 实现，刻意不写 bash：Git Bash(MSYS) 会把 `/opt/x` 转成 `E:/...`，`publish-update.sh`
已经为此加过 `MSYS_NO_PATHCONV=1`，再用 bash 编排只会放大同一类问题。

```bash
node scripts/release.mjs --dry-run                    # 先看它打算做什么（命令/目录/会写哪些文件，零副作用）
node scripts/release.mjs --bump=fix                   # 门禁 → bump → 校验 CHANGELOG → 生成 changelog.ts
node scripts/release.mjs --desktop                    # 再加：打包安装包（输出目录自动递增 rNN）
node scripts/release.mjs --desktop --deploy           # 再加：备份 → 部署云端
node scripts/release.mjs --desktop --publish          # 再加：安装包 + latest.yml 发到更新源
```

想「一条命令连 bump 一起跑通」：先 `--dry-run --bump=fix` 看它算出的目标版本，把 `CHANGELOG.md`
顶部条目直接写成那个版本，再带 `--bump=fix` 正式跑——脚本是先 bump（第 4 步）再校验（第 5 步），
条目写在目标版本上才能一次过；忘了写就会停在第 5 步，并明确告诉你「去掉 --bump 重跑」。

十步（任何一步失败立即停止，打印失败步骤、最后 40 行输出与「下一步该做什么」）：

| 步 | 做什么 | 关键约束 |
|---|---|---|
| 1 | 工作区与工具链预检 | `git status` 非空 → 拒绝（`--allow-dirty` 放行并记进证据）；Node ≥ 24；`deploy-bare.py` 的 `VERSION` 必须等于本轮目标版本（带 `--bump` 时是 bump 后的版本），不一致在预检就停 |
| 2 | `pnpm -r build` | 云端口径：不注入 `VITE_API_BASE`；产物缺 `web/dist/index.html` 等直接失败 |
| 3 | 逐包 `test` | 串行 `pnpm --filter <包> test`，**单包失败重试一次**（本机偶发 `0xC0000409`），连续两次失败即停 |
| 4 | bump（`--bump`） | `bump-version.mjs auto <fix\|feature\|breaking\|build>`；数字只增不减 |
| 5 | 校验 CHANGELOG 顶部条目 | 顶部标题的版本号必须等于当前 `hemingVersion`，且带日期与标题 |
| 6 | `node scripts/build-changelog.mjs` | 写 `packages/web/src/generated/changelog.ts`，并回查里面含当前版本串 |
| 7 | 打包（`--desktop`） | `pnpm -w run dist:desktop`；核对 `latest.yml` 存在、sha512/size 与安装包一致、内嵌 web 产物含版本串且与 `web-dist` 同名 |
| 8 | 备份 + 部署（`--deploy`） | **强制先 `backup`**，备份没落到本机就整轮中止；再打/校验 tar → `upload` → `install` → `smoke` |
| 9 | 更新源（`--publish`） | win32 走 `node scripts/publish-update.mjs`（不依赖 Git Bash），其它平台走 `bash scripts/publish-update.sh`；先 `--dry-run` → 真传 → 输出必须含「校验通过」（远端大小与 sha512 均与本地一致） |
| 10 | 证据清单 | 每步退出码/耗时、产物路径与大小、待人工填写的校验项、可粘进 `docs/HANDOFF.md` §2 的 Markdown |

安全边界：**部署、上传、删除默认全不做**，必须显式 `--deploy` / `--publish`；`--dry-run` 只打印十步计划，
跑前跑后 `git status` 与 `packages/*/dist` 的修改时间都不变。

顺带固化下来的两个顺序陷阱：

- `--desktop` 与 `--deploy` 同时开时，脚本在打 tar 前**先重跑 `pnpm --filter @heming/web build`**，
  把 `packages/web/dist` 从「注入 `VITE_API_BASE` 的桌面版」恢复成云端口径——否则上云的就是写死 IP 的那份
  （`docs/deploy.md` §2 ★）。只打包不部署时该目录会停留在注入版，脚本会在第 7 步明确提示，
  手工上云前记得重跑一次 web 构建。
- 打包输出目录每版换一个新的 `release/rNN`（`--release-r 46` 可显式指定，`--release-dir` 可给整条路径），
  且**打包与发布用同一个目录**：两边都读 `HEMING_RELEASE_DIR`，由脚本统一注入，不会再出现一边 r45、
  一边默认目录。

**它不替代的三件事**（脚本只打印待填项，不替你判断）：

1. **CHANGELOG 正文由人写**：脚本只校验「顶部有条目且版本号等于当前版本」，文案与取舍是人写的。
2. **线上 `/api/health` 与主 bundle 的人工比对**：脚本能跑的是服务器本机 `127.0.0.1:8787/api/health`
   （由 `deploy-bare.py smoke` 完成）；公网那一次、以及线上 `index.html` 引用的 bundle 是否与本机云端产物
   同名同字节，仍要人看一眼。
3. **安装包 sha512 的最终对照**：脚本已把本地 exe 与本地 `latest.yml` 的 sha512/size 对上；上传后
   `publish-update.mjs`（win32）/ `publish-update.sh` 也会在远端重算 sha512 并与本地核对。
   但「远端那份 `latest.yml` 里的 sha512」与「真上传上去的安装包」仍是两份独立事实，可再人对一次。

完整开关与退出码见 `node scripts/release.mjs --help`。

## 打包入口

> ⚠️ **改了前端代码后必须先跑 `build-desktop-web.mjs`，否则打出来的包是旧界面。**
> `build-desktop.mjs` **只打包，不构建 web**。它读 `packages/desktop/web-dist/`，
> 而 `pnpm -r build` 只更新 `packages/web/dist`——两者不是同一个目录。
> d.14.1.3.0 出包时正是漏了这一步：包成功生成、版本号也对，但里面还是 10/19 的界面，
> d.10~d.14 的新功能（去 AI 味、图表、自我修改、网页抓取）**一个都没有**，
> 只看「打包成功」发现不了。**推荐直接用 `pnpm -w run dist:desktop`**，它按正确顺序串好了两步。

```bash
pnpm -w run dist:desktop                                # 推荐：先构建 web 再打包
node scripts/build-desktop-web.mjs                      # 仅重建 web 产物
```

**出包后自查**（别只看日志说成功）——在包内界面产物里搜新代码的标识串：

```bash
node -e "const fs=require('fs');const p='D:/Heming/packages/desktop/release/win-unpacked/resources/web/assets/';const f=fs.readdirSync(p).find(x=>x.endsWith('.js'));const s=fs.readFileSync(p+f,'utf8');console.log(s.includes('tone_detect')?'有去AI味':'缺',s.includes('chart_render')?'有图表':'缺图表');"
```

**在 WorkBuddy 会话里打包的环境坑**（都不是代码问题）：

1. `NODE_OPTIONS` 注入了会话级 `node-safe-delete-shim`，会拦「单轮删除超过 50 个文件」。
   electron-builder 清自己的 `win-unpacked` 暂存目录必然触发（electron 自带 64 个语言包），
   报 `SAFE_DELETE_BULK_CONFIRM_REQUIRED`。打包时 `export NODE_OPTIONS=""` 跳过该注入即可。
2. `ELECTRON_BUILDER_CACHE` / `ELECTRON_CACHE` 是**用户级**变量，本次 bash 会话不一定继承。
   没继承就回落到 `AppData\Local`，并在解压 `winCodeSign` 时因缺符号链接权限失败
   （`Cannot create symbolic link : 客户端没有所需的特权`）。打包前显式 `export` 这两个变量，
   指向工作区 `.tmp/cache/` 下已解压好的那份。
3. **打包慢到 1 小时以上**（d.18.1.5.0 遇到）：内置运行时 `win-unpacked/resources/runtime`
   有 7000+ 个小文件（5026 个 `.py`），electron-builder 每轮都要**逐个删除**上一版的。
   实测删除小文件极慢——300 个文件：C 盘 89168ms（带 shim）、不带 shim 也只有 72 文件/秒，
   7367 个文件要 1 小时以上，而这段时间**没有任何产出**。
   `build-desktop.mjs` 现在会**先把旧 `win-unpacked` 改名让位**（同盘改名是元数据操作，瞬时完成），
   electron-builder 面对不存在的目录，从根上跳过删除。
   > 顺带一提：PowerShell 的 `Remove-Item -Recurse` 删同样两个目录只要 **0.06 秒**，
   > 比 Node 的 `fs.rmSync` 快上万倍。要手工清理残留时用 PowerShell，别用 Node。

**用 `scripts/build-desktop.mjs`，不要直接 `electron-builder`**：

```bash
node scripts/build-desktop.mjs --win nsis                                    # 标准打包
node scripts/build-desktop.mjs --win nsis --config.directories.output=release-new   # 换目录出包
```

**产物输出目录**（不进 C 盘）：`scripts/release-dir.mjs` 是唯一解析点，优先级为
`HEMING_RELEASE_DIR` 环境变量 > `D:\Heming\packages\desktop\release`（检测到 D 盘时）>
仓库内 `packages/desktop/release`（兜底）。`build-desktop.mjs` 未被显式指定输出目录时自动注入
`--config.directories.output=<解析结果>`，日志会打印实际路径；`scripts/version.mjs` 的
「已有安装包」列表走同一解析。所以**本机默认把安装包放在 D 盘**，仓库里不再留产物。
临时换目录：`HEMING_RELEASE_DIR=E:/tmp/out node scripts/build-desktop.mjs --win nsis`。

它替你做三件事：

1. 把 `hemingVersion` 注入 `HEMING_APP_VERSION`——`build.nsis.artifactName` /
   `uninstallDisplayName` 写的是 `${env.HEMING_APP_VERSION}`，直接跑 electron-builder 会得到
   带字面量 `${env.…}` 的文件名；
2. 自动探测 `node_modules/.pnpm/electron@*/…/dist` 并传 `--config.electronDist`
   （本机为省 C 盘删掉了 electron 下载 zip，缺这一项时 electron-builder 会尝试联网重下并失败）；
3. 其余参数原样透传。

### electron 二进制与 electronDist 的两个坑（d.55 升 Electron 45 实测）

这两条都不会让「打包命令」报错，但会让**打出来的包装着错误的 Electron**，或者干脆找不到 electronDist。

**坑 1：`pnpm install` 不一定执行 electron 的 postinstall，`dist/` 可能是空的。**

升级 Electron 大版本后遇到：`pnpm install` 成功退出、`node_modules/electron/package.json` 版本也对，
但 `node_modules/electron/dist` 根本不存在（`path.txt` 也没有），`build-desktop.mjs` 因此探测不到
electronDist。表现是打包报找不到 electron，或者 electron-builder 尝试联网重下再失败。

```bash
# 判定：没有 dist 就是没装成
ls packages/desktop/node_modules/electron/dist/electron.exe   # 必须存在（约 238MB）

# 修复：直连 GitHub Releases 可能 fetch failed，走镜像后重跑 install.js
cd packages/desktop/node_modules/electron
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node install.js
# zip 会落到 %LOCALAPPDATA%\electron\Cache，之后 install 走缓存
```

**任何一次全新 `pnpm install` 之后都要确认 `packages/desktop/node_modules/electron/dist/electron.exe`
存在再打包**；缺了就用上面那条命令补。

**坑 2：`detectElectronDist()` 取的是「第一个」有 `dist/` 的 `electron@*`，残留旧版本会打错版本。**

`build-desktop.mjs` 的实现是：列 `node_modules/.pnpm` 下所有 `electron@*`，挑出 `dist/` 存在的，
**取 `candidates[0]`**。升级后如果旧版本的目录还留在 `.pnpm` 里（升级当时实测 `electron@31.7.7`
与 `electron@45.2.1` 并存，且旧版本已不在 `pnpm-lock.yaml`），按目录序会先命中**旧版本**，
于是打出来的是旧 Electron——日志里那句「使用本地已解包的 electron：…」会暴露它。

```bash
# 出包前二选一（推荐前者：顺带清掉所有不在 lockfile 里的残留包）
pnpm prune
# 或显式指定，绕过自动探测
node scripts/build-desktop.mjs --win nsis --config.electronDist=<绝对路径>/node_modules/electron/dist
```

出包后**再核对一次包里真实带的 Electron 版本**，别只看日志：对 `release/rNN/win-unpacked/electron.exe`
查文件版本（PowerShell `(Get-Item …).VersionInfo.FileVersion`），或直接看 `win-unpacked` 下
`resources/` 与 electron 相关的版本串，确认与 `packages/desktop/package.json` 的 `electron` range 一致。

> 顺带一条：用户级 `ELECTRON_CACHE` 可能指向**另一个 worktree** 的历史路径（升级当时它指向一个已不存在的
> `…\Worktrees\Heming\main-*/\.tmp\cache\electron\Cache`）。按上面第 2 条 export 缓存变量之前先确认路径存在，
> 否则改指向 `%LOCALAPPDATA%\electron\Cache`。

## 版本比较

`packages/desktop/app-version.js` 提供纯函数 `parseVersion` / `compareVersions`（主进程与 preload 共用）：

- 5 段通道版本**恒高于**旧 semver 基线 —— 否则首次从 `0.0.1` 迁到 `d.0.1.0.0` 会被误判成降级；
- 通道不同视为**不可比**（返回 0，桌面版与移动端各走各的更新通道）；
- 数值段逐位比较，缺失位按 0；
- `-dev.<n>` 低于同数值的正式版，正式版高于任何预发版；
- 非法输入返回 0 —— 调用方据此判定「无更新」，绝不因为读不懂版本就提示用户升级。

单测见 `packages/desktop/app-version.test.js`（`node --test`）。

`appVersion()` 从**同目录**的 `./package.json` 读版本（早先写成 `../package.json`，
指向并不存在的 `packages/package.json`，异常被吞成 `0.0.0`，导致桌面端各处一直显示 0.0.0）。
`version-sync.test.js` 会断言它读到的值等于当前 `hemingVersion`。

## 展示位置

全部取自同一个 `hemingVersion`，不存在「某处写死版本号」的情况：

- **设置区**底部：`和鸣 d.5.1.0.0`（桌面端由 preload 注入；浏览器里显示「网页版」，不伪造版本号）；
- **更新日志**卡（设置区）：来自 CHANGELOG.md 的构建期生成产物，当前版本那条默认展开并带「当前」徽标；
- **主页**版本徽标：`版本 d.5.1.0.0` —— `vite.config.ts` 在**构建期**读桌面包的 `hemingVersion`
  并以 `__APP_VERSION__` 注入（不是运行期 fetch，故 file:// 桌面端也能拿到）；
- **安装包文件名**：`和鸣 Setup d.5.1.0.0.exe`；
- **Windows「应用和功能」**：显示名 `和鸣 d.5.1.0.0`；
- **主进程启动日志**：`[heming] 版本 d.5.1.0.0`（排障时先看这一行）。

## 测试把守

`packages/desktop/version-sync.test.js`（`node --test`）卡住这几条，改坏了直接红：

1. 五个 package.json 的 `hemingVersion` 与 `version` 全部一致；
2. semver 与 Windows 四段确实由 5 段版本派生得出；
3. `appVersion()` 读得到真版本，不是兜底的 `0.0.0`；
4. README 顶部「当前版本」不落后；
5. CHANGELOG 历史版本号逐条严格递增，且自 `d.5.1.0.0` 起每一位数字都单调不减。