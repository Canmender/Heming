# 自绘安装器（和鸣安装程序）

> 日期：2026-11-12　状态：已实现并验收（构建成功、单测 40/40、打包后 6 张状态截图与字形诊断通过；待完整仓补齐 web-dist/runtime/magpie 后做一次真实体积的真机安装复验）
> 关联：`docs/superpowers/specs/2026-11-07-installer-branding.md`（内层 NSIS 品牌化）、`packages/desktop/auto-update.js`（自动更新链路）、`packages/setup/`

## 1. 为什么要重做安装界面

现有安装体验是 electron-builder 生成的 NSIS MUI 向导，`packages/desktop/build/installer.nsh` 只能改文案与品牌图。`2026-11-07-installer-branding.md` 已明确留下三条未做项：

- 页面配色/字体不可控——MUI 用系统控件画页面；
- 装不了动效——MUI 页面是静态位图 + 文本；
- 高 DPI 下逐档截图没法保证。

用户要求「高自定义」，并指定参考 `https://github.com/mshumer/unslop` 的反套路设计口径。因此本轮新增一个**自绘安装器**：窗口、排版、动画全部由我们画，但**安装动作仍交给 electron-builder 的 NSIS 安装包**。

## 2. 架构：外壳窗口 + 静默 NSIS

自动更新（`auto-update.js` + `electron-updater`）要求发布产物仍是「electron-builder NSIS 安装包 + latest.yml」，这是硬约束。所以自绘安装器不能替换安装机制，只能包在它外面：

```
和鸣安装程序 <版本>.exe        ← 外层：electron-builder portable 目标（单 exe）
  └─ 自解压（静态 splash.bmp，1–3s，无法动画）
     └─ Electron 进程：packages/setup
        ├─ 主进程 main.js：900×620 无边框窗口、IPC、pipeline
        ├─ 渲染层 renderer/：手写 wordmark、四屏状态机、动效
        └─ 安装动作：spawn 内层 NSIS 安装包静默执行
            和鸣 Setup <5段版本>.exe /S /NCRC /D=<安装目录>
```

内层安装包保持原样构建与发布（`pnpm dist:desktop`），自带注册表卸载项、快捷方式、卸载器、差分更新与 per-machine 升级自提权。外层只负责「看起来和用起来」，不碰安装语义。

### 2.1 内层安装包从哪来（三种来源，按顺序）

1. **内嵌**：`scripts/build-setup.mjs --embed-inner[=<path>]` 把内层包复制到 `packages/setup/payload/inner-setup.exe`，sha512 写进 `config/generated.json`，体积大但完全离线；
2. **同目录离线兜底**：setup.exe 旁边有 `和鸣 Setup *.exe` 时直接用它（按 5 段版本取最大，排除自身）；
3. **在线下载**：读 `http://47.92.39.184/updates/latest.yml`（`HEMING_UPDATE_FEED` 可覆盖），取 Windows 安装包 URL 与 sha512，下载到 `%TEMP%\heming-setup\inner-setup.exe` 并校验。

在线模式（默认）产物体积小，但要求更新服务器上已有对应版本的安装包与 latest.yml。内嵌模式用于「离线分发/客户现场」。

## 3. 关键实现契约（都是踩过或预判的坑）

### 3.1 `/D=` 参数

- NSIS 的 `/D=` 必须是**最后一个参数**，且**整体不能加引号**（引号会被当成目录的一部分）；
- Node `spawn` 默认会为含空格的参数加引号 → 必须 `windowsVerbatimArguments: true`；
- verbatim 模式下 `file` 路径本身也不能含空格，所以下载文件名固定为 `inner-setup.exe`，不用原始中文名；
- `/NCRC`：外层已校验 sha512，跳过内层自校验，省一遍全文件读取。

`packages/setup/lib/args.js` 把这四条写成断言（含引号直接抛错），`pipeline.js` 只通过 `buildInstallCommand()` 拼命令。

### 3.2 退出码不可信

UAC 取消、安装器被外部结束、静默安装在部分路径下都可能返回 0。因此**安装成功以磁盘为准**：安装后在目标目录找 `Heming.exe`，找不到再探一层子目录（electron-builder 在部分配置下会把应用放进子目录 `Heming\`），仍找不到就是 `install-failed`。

### 3.3 进度语义

- **下载阶段**：有真实 Content-Length，给百分比、速度、剩余时间（`EtaEstimator` 窗口 8 个样本、跨度 ≥500ms 才算速率）；
- **安装阶段**：内层安装器不暴露进度，主进程每 600ms `statTree()` 统计目标目录文件数与字节数，界面显示「已安装 N 个文件 / X MB」；`config.installedBytes`（构建期算好的总体积）已知时给百分比，未知时进度条退化为不确定态——**绝不编假百分比**。

### 3.4 取消语义

- 下载/校验阶段可取消（AbortController，清理半截文件，事件 `cancelled`）；
- 安装阶段**不提供取消**（`cancel()` 返回 `{ok:false, reason:"installing"}`）：静默安装中途杀掉会留下半装目录，正确做法是装完再让用户从应用内卸载/重装。界面在安装开始后把「取消」换成不可用态并给出说明。

### 3.5 其他

- sha512 用 base64 与 latest.yml 的 `sha512` 字段对齐（electron-builder 的格式）；
- 磁盘检查：`statfs` 最近的已存在祖先目录，需求 = `installedBytes + 200MB` 余量；
- 日志：`%TEMP%\heming-setup\setup.log`（内存保留最近 80 行给错误页），错误页提供「打开日志」；
- 单实例锁；安装中关窗弹确认「继续安装 / 仍然退出」；`HEMING_SETUP_PAYLOAD` 环境变量可指定本地安装包（调试用）。

## 4. 设计口径（unslop：反套路）

设计取向来自 `https://github.com/mshumer/unslop` 的 `profiles/react-design.md`：不是给模板，而是把默认套路去掉——

**不用**：渐变/光斑、玻璃拟态、大圆角卡片网格、投影、磨砂、渐变文字、居中大标题 + 双按钮、假信任数字（「百万用户」「Trusted by」）、Inter 默认字体、深色底 + 青紫辉光。

**用**：

- 纸白 `#f5f2ea`、墨黑 `#161616`、发丝线 `#d9d3c4`、朱砂 `#a63d2e`（只做小面积点缀：印章、写完的圆点、关闭键 hover）；
- **手写 wordmark**：与 `packages/web/src/components/wordmarkGlyphs.ts` 同源（10 条 path，viewBox `0 0 400 150`），按笔画长度分配时间逐笔描画（约 1.25s），写完朱砂圆点淡入——这是「安装动画」的主体；
- 宋体（SimSun / Source Han Serif）作标题、微软雅黑作正文、等宽作详情；右上角自绘最小化/关闭；
- 页边注版式：右侧 232px 窄栏放 4 条事实（安装位置、体积、更新方式、卸载），底部案语「鹤鸣于九皋，声闻于天。」+ 字距拉开的 H E M I N G；
- 四屏（`ready` / `work` / `done` / `error`），动效只服务状态变化：安装期 24 个墨点波浪、2px 进度线；完成时朱砂印章 scale/rotate 落章；
- `prefers-reduced-motion: reduce` 关闭全部动效；键盘 Enter/Esc 可全程操作；`aria-live` 播报阶段变化。

截图验收用 `electron . --capture=<dir>`：主进程在 `did-finish-load` 后按 `lib/capture.js` 的 6 个状态（ready 描画中/ready/work 下载/work 安装/done/error）调 `webContents.capturePage()` 出 PNG。

## 5. 文件结构

```
packages/setup/
├─ package.json          @heming/setup，win.target portable
├─ main.js              BrowserWindow、IPC、--capture、单实例
├─ preload.js           contextBridge：window.setup
├─ lib/
│  ├─ config.js         读 config/generated.json → 运行配置
│  ├─ paths.js          默认安装目录、工作目录、包名识别、路径清洗
│  ├─ args.js           /S /NCRC /D= 命令拼装与断言
│  ├─ feed.js           手写 latest.yml 解析（无依赖）
│  ├─ download.js       流式下载 + 边下边算 sha512 + 空闲超时
│  ├─ dir-stats.js      目录文件数/字节数（可中断）
│  ├─ installer.js      spawn 内层安装器 + 结束进程树
│  ├─ pipeline.js       prepare→download→verify→install→done 编排与事件
│  ├─ eta.js            速率与剩余时间
│  ├─ format.js         字节/速度/时长/千分位
│  ├─ log.js            落盘日志
│  └─ capture.js        截图验收
├─ renderer/            index.html、styles.css、app.js、wordmark.js
├─ build/               生成的 icon.ico、splash.bmp（提交入库）
├─ config/              generated.json（构建生成，不入库）
├─ payload/             inner-setup.exe 槽位（不入库）
└─ release/             electron-builder 输出（不入库）
```

`scripts/make-setup-assets.py`（Pillow，4× 超采样）生成 `build/icon.ico` 与 `build/splash.bmp`；`scripts/build-setup.mjs` 写 `config/generated.json` 并调 electron-builder。

## 6. 构建与验证

```bash
node scripts/make-setup-assets.py                 # 首次或改设计后
pnpm dist:setup                                   # 在线版（默认）
pnpm dist:setup -- --embed-inner                  # 内嵌内层安装包
electron packages/setup --capture=<dir>           # 开发态出 6 张状态截图
cd packages/setup && node --test                  # 纯函数与编排测试
```

门禁：`node --check` 覆盖 main/preload/lib 全部文件；7 个 `node --test`（feed/args/format/eta/paths/download/pipeline；`download.test.js` 用本地 http 服务器验断点续传与中断保留，pipeline 用注入的 fake services，不真装）；打包后用 `win-unpacked` 或安装到测试用户目录真机走一遍。

打包后的 exe 不方便透传命令行参数，截图目录也可以用环境变量给出：`HEMING_SETUP_CAPTURE_DIR=<dir>`（优先级高于 `--capture=`，见 `main.js` 的 `readCaptureTarget`）。

安装包预取：窗口加载完成后（`main.js` 的 `did-finish-load`）立即调 `pipeline.prefetch()`，在用户选安装位置的十几秒里把安装包下好；ready 屏只多一行「安装包 已准备 X%」的细进度。点「开始安装」时直接接管同一个下载任务（`prefetchTask.visible = true`），不重复下载；上次下好的包大小与 sha512 都对得上则跳过整次下载。断点续传落盘为 `inner-setup.exe.part`，失败重试与下次启动只补缺的字节。截图模式（`--capture` / `HEMING_SETUP_CAPTURE_DIR`）不预取，避免截图时后台下载干扰。细节见 `2026-11-12-install-speed-and-update-motion.md`。

2026-11-12 验收记录：`node --check` 17 个文件通过；7 个测试文件共 49 例全绿（含同日提速新增的预取、断点续传、缓存命中用例）；`scripts/make-setup-assets.py` 生成 `build/splash.bmp`（1.67 MB）与 `build/icon.ico`（20 KB）；`node scripts/build-setup.mjs` 打出 `和鸣安装程序 d.135.3.54.7.exe`（105.2 MB），复制到普通用户目录运行后，在 900×622（DPR 1.5）窗口产出 6 张状态 PNG 与 `diagnostics.json`（10 条词标 path 的 `strokeDashoffset` 全为 0、无渲染异常）。打包态排查看 `%TEMP%\heming-setup\bootstrap.log`（`main.js` 的 `traceStep` 记录启动各阶段）。

## 7. 已知限制

- **外层自解压是无动画的**：portable 目标在启动 Electron 前要解压 ~90MB，期间只有 `BgImage` 静态图（1–3s），真正的动画从窗口出现开始；
- 无代码签名，仍是「未知发布者」；
- 安装阶段没有精确百分比（内层不暴露），只能按文件数/字节数给实感；
- 外层安装器自身的自动更新未做（应用内更新由第 8 节的内置更新助手承接，助手版本随桌面版本一起换，不单独自更新）；
- 内置更新助手让桌面安装包多约 105MB（一个完整 Electron 运行时），换来更新时与首次安装完全一致的画面；
- 只做 zh_CN/Windows x64；arm64、多语言、埋点均未做；
- electron-builder 26 的 `portable.splashImage` / `portable.requestExecutionLevel` 已随构建验证有效；
- **本机环境坑**：从仓库目录（`D:\Heming\...\packages\setup\release\`）启动 portable exe 时，NSIS 外壳写临时文件失败并弹 `Error writing temporary file. Make sure your temp folder is valid.`（与 `2026-11-07-installer-branding.md` 里卸载器那条同源）；把 exe 复制到普通用户目录（如 `%TEMP%\heming-setup\psetup-final\setup.exe`）再运行即正常。属于本机 DSH 启动环境的 TEMP 限制，不是产品缺陷，验收时按复制方式跑。

## 8. 更新助手：把自绘安装器内置进桌面端

应用内更新原本调 `autoUpdater.quitAndInstall(false, true)`，electron-updater 会启动内层 NSIS 包并显示 MUI 向导——用户装过一次之后，更新时又看到另一套界面，视觉上和「程序」断开了。这里把同一套自绘窗口复用为**更新助手**。

为什么必须是独立进程：Windows 会锁住正在运行的程序文件，应用自己不能在退出前重装自己；所以助手是 `packages/setup` 打出来的单 exe，以 ~105MB 的代价内置进桌面安装包（`resources/updater/setup.exe`），不用时只是磁盘占用。

流程：

1. 渲染层确认「重启并安装」→ 桌面主进程 `installUpdate()`；
2. 主进程把计划写到 `%TEMP%\heming-setup\update-plan.json`：

   ```json
   { "installerPath": "…\\和鸣 Setup d.136.0.0.0.exe", "installDir": "…\\Programs\\Heming",
     "version": "d.136.0.0.0", "currentVersion": "d.135.3.54.7", "relaunch": true }
   ```

3. `detached` 启动助手，环境变量 `HEMING_SETUP_UPDATE=1`、`HEMING_SETUP_UPDATE_PLAN=<计划路径>`（不用命令行参数：portable 的 NSIS 外壳会重拼参数，含空格/中文的路径容易坏）；
4. 500ms 后 `app.quit()`，助手窗口此时已经出现，接管画面；
5. 助手校验计划 → 直接进 work 屏（标题「更新程序」、headline「正在更新。」）→ 用 `installerPath` 作 payload 跑静默 NSIS（`/S /NCRC /D=`）→ 按 `relaunch` 拉起新版本；
6. 计划文件在 done 事件后删除；渲染层参数在更新模式下被忽略（安装位置与包都来自计划，不接受用户改）。

回退：助手不存在、计划读写失败、状态不是 `downloaded`、下载文件缺失 → `quitAndInstall()`（原 MUI 路径），保证老安装包与异常情况仍能更新。

构建：`scripts/build-desktop.mjs` 的 `stageUpdateHelper()` 在打包前把 `packages/setup/release/和鸣安装程序 *.exe` 里最新者复制成 `packages/desktop/update-helper/setup.exe`（该目录被 `extraResources` 搬到 `resources/updater/`，`*.exe` 不入库）。找不到 setup 产物时只告警并清掉旧暂存，不中止打包。

测试：`packages/setup/lib/update-plan.test.js`（6 例：模式识别、路径解析、计划校验/归一化、缺失与坏 JSON 归 `no-payload`）、`packages/desktop/update-helper.test.js`（6 例：助手/计划路径、计划组装、`ELECTRON_RUN_AS_NODE` 清理、跨包常量一致）。

2026-11-12 冒烟：把计划里的 `installerPath` 指向一个假安装包，用真实 `main.js` 跑更新模式——窗口标题「更新 和鸣」、标题栏「更新程序」、直接进 work 屏，右栏三条事实变成「版本 / 现在是什么版本 / 已在后台下载」，失败后错误屏为「更新没能完成。」+ `install-failed`，说明「读计划 → 自动开跑 → 按磁盘结果判定」整条链路是通的（计划缺失时错误屏为「更新包已经不在原处了」，「重试」改为关窗回应用）。

## 9. 与既有资产的关系

- 内层 NSIS 完全保留：`2026-11-07-installer-branding.md` 的文案、侧栏、页头、图标继续生效；用户若直接运行 `和鸣 Setup <版本>.exe`（例如自动更新下载的包），看到的是原来的 MUI 向导，功能不受影响；
- `publish-update.mjs` 仍上传内层安装包与 latest.yml，发布流程不变；外层 `和鸣安装程序 <版本>.exe` 另行分发，不参与自动更新；
- 新增 `packages/setup` 已加入 `scripts/bump-version.mjs` 的 `SYNCED_PACKAGES`，5 段版本与派生 semver 随主版本同步；
- 字形仍只有一份真源，`packages/desktop/wordmark-drift.test.js` 同时断言 `splash.html` 与 `packages/setup/renderer/wordmark.js` 与 `wordmarkGlyphs.ts` 一致。

## 10. 后续（未做，按需）

1. 给安装器加签名（同时解决内层的「未知发布者」）；
2. 外层安装器的自更新（或直接让官网/更新源永远给最新 setup）；
3. 安装阶段接内层日志（若 electron-builder 开放进度文件可换真进度）；
4. 多语言与暗色（暗色要另画一套 token，不做系统色反转）；
5. 安装完成页「首次启动引导」复用同一套动效语言。
