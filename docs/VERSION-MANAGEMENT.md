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