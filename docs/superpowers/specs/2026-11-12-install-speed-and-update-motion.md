# 安装提速与应用内更新动画

日期：2026-11-12
状态：已实现并验证（安装器 9 个测试文件共 62 例全绿、预取三态与工作屏/完成屏截图已过目；应用内更新动画 `tsc` 通过、`UpdateCard` 14 例全绿、桌面端 `auto-update`/`update-helper` 25 例全绿；真机联网安装与观感复验待完整仓/发布环境）

## 1. 需求

用户原话（2026-11-12）：

> 优化，优化安装速度，效率，以及应用内更新程序动画

拆成两件事：

1. **安装速度与效率**：自绘安装器（`packages/setup`）现在点「开始安装」才开始连服务器、下载 250MB 级安装包，用户干等；网络抖动时重试要从头下。要让用户填安装目录的那十几秒也被利用起来，并让断线重试只补缺的字节。
2. **应用内更新动画**：设置区「软件更新」卡在下载 250MB 包的过程中只有一行字和一条 1.5px 进度条，没有「它在动」的体感；下载完成到重启之间也缺少一个明确的收尾动作。

## 2. 安装器提速

### 2.1 预热（prefetch）

- 安装器窗口 `did-finish-load` 后立刻调用 `pipeline.prefetch()`（截图模式不跑，避免污染诊断）。解析 `latest.yml` → 下载安装包 → 校验 sha512，全程后台。
- 预取事件走独立通道 `{type:"prefetch", stage:"resolving"|"downloading"|"verifying"|"ready"|"failed"}`，不占用正常安装的 `phase/progress`；**失败只在日志与 ready 屏的小字里体现，绝不弹错误屏**——用户还没点开始，预取失败不是错误。
- ready 屏新增一行小字与 96px 发丝进度线：`正在准备安装包 · 42%` / `安装包已就绪 · d.140.0.1.0`（就绪时颜色转朱砂）。
- 用户点「开始安装」时：
  - 有未完成的预取任务 → 把它转为可见（`visible = true`，后续事件改走正常通道）并 `await` 同一个 Promise，不重新下载；
  - 预取已完成 → 直接用；
  - 预取失败或用户显式指定了本地安装包 → 现场重新解析（指定包时先 abort 预取）。
- 同一时刻只允许一个预取任务（单飞，`ensurePayloadTask`）；`cancel()` 在空闲时取消的是预取（`{ok:true, scope:"prefetch"}`），`dispose()` 也会 abort 预取。

### 2.2 断点续传

`downloadFile` 增加 `resume` 选项：

- 写入 `${dest}.part`，请求带 `Range: bytes=<已有> -`（`acceptPartial` 允许 206）；
- 服务器支持 Range → 先对已有前缀算哈希，再以追加模式补剩余字节；
- 服务器不认 Range 回 200 → 丢弃已有前缀，从头重写（绝不能把两段拼一起）；
- 服务器中途掐断 → 失败但保留 `.part`，下一次重试（最多 3 次，间隔 1s）接着续；
- 哈希不匹配 → 删掉 `.part` 与目标文件后重试，避免坏块被无限续用。

### 2.3 缓存命中

`latest.yml` 解析出文件名与大小后，先看工作目录里有没有 `inner-setup.exe`：

- 大小与 `latest.yml` 一致 → 再算一次 sha512；
- 校验通过 → 跳过下载，发一条 `phase`「使用已下载的安装包」；
- 大小不符 → 重新下载（不做「半信半疑地用」这种判断）。

下载成功时在包旁边写一份 `<包名>.meta.json`（版本 / 大小 / sha512 / mtime）。下次启动若元数据与当前文件的大小、mtime、目标版本都对得上，就直接信这份回执，省掉对 300MB 文件的全量 sha512（几百毫秒的纯读盘）。文件被动过（大小或 mtime 变了）就退回真正的哈希校验；认不出时宁可多算一次，不冒用坏包的风险。

### 2.4 让出 IO

安装期目录轮询从 600ms 放宽到 2500ms——解压本身在猛读写目标盘，轮询太密只会跟它抢 IO，进度条也没必要 600ms 一跳。2500ms 的依据见 2.8 的实测（一次统计 300~400ms，占比从约 80% 降到百分之十几）。

### 2.5 进度节流

下载回调是「每收一个数据块一次」（64KB 级，300MB 的包有几千次）。原样转发等于每秒上百次 IPC + 上百次界面重绘，进度条反而更抖。现在：

- 安装器侧（`pipeline.js`）按 `PROGRESS_EMIT_INTERVAL_MS = 120`（约 8fps）合并中间帧，但**首帧与收尾帧（`received >= total`）不受节流**——前者让界面立刻知道开始了，后者保证进度能走到 100%；
- 桌面端 `auto-update.js` 对 electron-updater 的 `download-progress` 做同样 120ms 节流，首帧与 100% 立即转发，避免更新卡下载时把渲染进程刷爆。

### 2.6 工作屏秒表

内层 NSIS 解压 + 复制占安装时间的大头，这段没有可信百分比。工作屏在状态行下加一行「已用 X 秒」（超过一分钟变「X 分 YY 秒」），让用户确认程序在走，也给「这台机器装一次要多久」留下可对照的数字。

### 2.7 分段计时与完成用时

`pipeline.start()` 用 `Date.now()` 记两段：安装包准备（含在线下载/校验，`timings.payloadMs`）与内层安装（`timings.installMs`）。`done` 事件携带 `elapsedMs` 与 `timings`，完成屏在安装路径下多一行「用时 54 秒 · 安装 41 秒」，安装日志同样记录三段数字（准备 / 安装 / 合计）。

这么做的理由：安装主体耗时在内层 NSIS，外层能动的只有准备与调度。没有真实分段数据，「还要不要换打包格式/压缩级别」就只能凭感觉；有了这份回执，才能在完整仓真机装一次后按数字决策。截图验收时 `applyCaptureState("done")` 会注入一组假耗时，保证这条新行也在视觉验收范围内。

### 2.8 目录统计本身也要便宜

`statTree()` 是安装期唯一的进度信号，但实测（`win-unpacked`，8486 个文件 / 882 MB）原来「逐文件 await stat」一次要 **799ms**——按旧节奏 900ms 一轮，等于线程池常驻占满、全程跟解压抢 IO。三处改动：

- **两段式**：先只 `opendir` 收路径（约 205ms），再用有界并发批量 `stat`（`STAT_CONCURRENCY = 8`）；
- **线程池**：主进程启动时把 `UV_THREADPOOL_SIZE` 调到 16（Node 默认 4），`fs.stat` 走 libuv 线程池，实测一次降到 **300~400ms**；
- **间隔**：轮询 900ms → 2500ms（见 2.4），轮询占用从约 80% 降到百分之十几。

代价是进度 2~3 秒才动一次，但「已写入 N 个文件 / X MB」仍是真实读数；对这条信息来说毫秒级抖动没有意义，而安装主体（内层解压 + 复制）能否拿到干净 IO 才重要。

## 3. 应用内更新动画

新增 `packages/web/src/components/UpdateMotion.tsx`，接到 `UpdateCard` 的四段状态：

| 阶段 | 画面 |
| --- | --- |
| checking | 三个墨点依次脉冲，告诉用户「后台真的在问」 |
| downloading | 18 个墨点波浪 + 26px 真实百分比 + 2px 进度线（线头一枚朱砂点）+ 原有的「已下载 X%（A / B · 速度）」 |
| downloaded | 34px 朱砂「和」印章落章（rotate -12°→-8°、scale 1.9→1） |
| installing | 落章 +「更新已就绪，正在重启…」（`role="status"`） |

关键约束：

- **百分比只来自真实字节**（`state.progress.percent`），不编造；
- `role="progressbar"`、`aria-label="更新下载进度"`、`aria-valuenow` 与「已下载 X%」文案保持在同一处，读屏行为与改造前一致；
- 确认「重启并安装」后先播约 800ms 落章，再调 `bridge.install()`（`reduced-motion` 下 160ms）——直接调 install 时进程会立刻退出，用户看不到任何「点了」的反馈，容易以为没生效而重复点击；
- 印章朱砂用字面量 `#a63d2e`（与安装器同色），web token 表没有这一档，不为一处点缀扩全局调色板；
- `prefers-reduced-motion: reduce` 下所有动画退化为静态（印章直接落下，不做缩放旋转）。

## 4. 变更文件

- `packages/setup/lib/download.js`：`headers`/`acceptPartial`/`resume`、`partSize`、`hashPrefix`。
- `packages/setup/lib/pipeline.js`：`prefetch()`、`ensurePayloadTask`、`cachedPayload`、`downloadPayload`（3 次重试）、`prefetchSinkFor`、轮询 2500ms、取消作用域。
- `packages/setup/lib/dir-stats.js`：`statTree()` 改两段式（收集路径 → 有界并发 stat），导出 `STAT_CONCURRENCY`。
- `packages/setup/lib/download.test.js`（新）：本地 http 服务器测完整下载/续传/服务器不支持 Range/中断保留 `.part`。
- `packages/setup/lib/pipeline.test.js`：+7 例（预取不重复下载、缓存命中、缓存不可信、缓存元数据跳过哈希、进度节流、预取失败不弹错、空闲取消预取）。
- `packages/setup/main.js`：`did-finish-load` 触发预取（截图模式除外）。
- `packages/setup/renderer/{index.html,app.js,styles.css}`：`#prefetch-note` 小字与进度线、`onPrefetch` 处理、工作屏「已用 X 秒」秒表。
- `packages/desktop/auto-update.js`：`download-progress` 转发按 120ms 节流（首帧与 100% 立即发）。
- `packages/web/src/components/UpdateMotion.tsx`（新）、`UpdateCard.tsx`、`UpdateCard.test.tsx`。

## 5. 验证

- `cd packages/setup && node --test lib/*.test.js`：9 个文件 62 例（含下载器 4 例、预取/缓存/节流 7 例、目录统计 5 例），预期全绿。
- `cd packages/desktop && node --test auto-update.test.js update-helper.test.js`：25 例全绿。
- `node --check` 覆盖全部改动文件；`pnpm exec tsc -p packages/web/tsconfig.json --noEmit`。
- 安装器视觉：`HEMING_SETUP_CAPTURE_DIR=<dir>` 启动打包产物（必须用 node spawn 启动，不能从 MSYS bash 前台跑），看 ready 屏预取小字、工作屏秒表与 6 张状态图。
- 应用内更新：`pnpm --filter @heming/web test`（`UpdateCard.test.tsx` 新增 3 例 + 改造后的安装确认例）。

## 6. 已知限制

- 预取的百分比来自下载器，但**首次打开时 `latest.yml` 的请求可能比窗口加载慢**，此时 ready 屏先显示「正在准备安装包」再跳到百分比，不闪烁错误。
- 断点续传只在服务器返回 `Accept-Ranges`/206 时生效；不走 Range 的服务器会退化为整包重下（已测）。
- 安装期仍无精确百分比：内层 NSIS 的 7z 解压是同步阻塞，外层只能按目标目录字节数给参考值。
- 应用内更新动画的「下载完成」印章只在设置区那张卡里出现，不接管全局提示条（两处共用同一份状态但渲染不同，避免一次更新弹两次动画）。
