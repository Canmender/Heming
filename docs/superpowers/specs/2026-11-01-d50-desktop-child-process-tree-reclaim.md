# d.50 · 桌面子进程整树回收（消灭孤儿进程）

- 日期：2026-11-01
- 状态：**已完成并本机验证**（`packages/desktop` 门禁 351 例全绿，真实进程四组合实测缺陷成立且已修复）
- 轮次号说明：**本文件按 d.50 编号，若与并行会话撞号则顺延，标题与内容不受影响**。落地前先看 `git log -1` 与 `docs/HANDOFF.md` 的版本表——工作区 `package.json` 已是 `48.1.11`（并行会话的 d.48），而 HANDOFF 的版本表还停在 d.47。
- 并行改动警告：本轮**全部落在 `packages/desktop`**，与并行会话正在改的 `packages/web`（`ChatPage.tsx`、`store/tokenUsage.ts`、`lib/llmRoute.ts` 等）**零交集**；唯一共享的是 `docs/HANDOFF.md`，写里程碑前先 `git diff -- docs/HANDOFF.md` 确认没有别人的未提交改动。
- 借鉴来源：Nous Research **hermes-agent**（MIT, © 2025）`apps/desktop/electron/backend-child.ts`。搬的是**判据与分支形状**（grace → 组信号 → 强杀 → 再确认、Windows 与 POSIX 不对称、"没证明死就如实说没证明"），不搬源码：和鸣没有 HTTP 后端，它的 descriptor/claim 文件锁那一整套不需要。

---

## 0. 这一轮要解决什么

和鸣在主进程里拉起两类**外部进程**：MCP stdio 服务（`mcp-stdio.js`）与 InfoHub Python 边车（`infohub-bridge.js`）。两边的关闭路径都只做到 `child.kill()`——**那只打到直接子进程**。于是：

- MCP 服务普遍再拉起孙子（`npx → node → Chromium`、`uvx → python`），停服务或关应用后孙子全活着。
- InfoHub 的 Python 会 `subprocess` 起转写与 bot 进程，同样留下。
- 后果不是"脏"，是**用户能感觉到的**：孤儿占内存、锁住归档 SQLite（下次连接报"库被占用"）、锁住 `release/rNN` 目录（发布时 EBUSY，这一轮之前已经靠递增目录号绕过两次）。

顺带修掉同一个根因引出的第二个缺陷：**应用退出时的回收根本没跑完**。`will-quit` 是同步事件，旧的 `dispose()` 也只是发信号就返回，Electron 立刻退；而 `stop()` 里的兜底 kill 定时器还 `unref()` 了——事件循环一空就直接被丢掉，**一个进程都没杀**。

本轮范围只有这一件事：**把"杀直接子进程"换成"回收整棵树，并且退出前真的等它跑完"**。不改协议、不改渲染层、不动 Python。

## 1. 已核实的事实（本轮亲自读过源码，并在本机真实进程上实跑）

### 1.1 三个 kill 点（`git show HEAD:` 原样，改造前）

| 位置 | 代码 | 后果 |
|---|---|---|
| `infohub-bridge.js:466-470` | `if (killDelayMs <= 0) { targetChild.kill(); }` | 只杀 Python 父进程，`voice.py` / `wecom_bot.py` 起的孙子留下 |
| `infohub-bridge.js:471-480` | `setTimeout(() => targetChild.kill(), killDelayMs)` + `timer.unref?.()` | 同上，且见 §1.2 |
| `mcp-stdio.js:342-352` | `stop()` 里 `entry.child.kill()`，**连 stdin 都不关** | `npx` 的 node/Chromium 孙子留下；礼貌退出（EOF）这条路根本没有 |

### 1.2 `unref()` 就是孤儿成因

`infohub-bridge.js:480` 的 `timer.unref?.()`：设计意图是"别因为一个待杀的进程拖住退出"，实际效果相反——**用户点停止后立刻关应用时，这个定时器正是唯一会发信号的东西**，而它被事件循环丢弃了。`child-kill.js` 里所有兜底定时器**故意不 unref**，并由源码守卫钉住（§4）。

同一文件另两处 `unref`（`:339` hello 超时、`:442` 请求超时）**保留**：它们是"别 hold 住循环"的超时，不是回收手段；hello 超时到点后走 `stop()` → `beginTeardown()`，那里的定时器是 ref 的（`infohub-bridge.js:332-339`）。

### 1.3 退出路径是同步的，回收是异步的

- `main.js:436-439`（改造前）：`app.on("will-quit", () => { mcpStdio.disposeAll(); infohubBridge?.dispose(); })` —— 两个返回值都被丢掉。
- `infohub-bridge.js:486-488`（改造前）：`function dispose() { return stop({ killDelayMs: 0, silent: true }); }` —— 同步。
- `mcp-stdio.js:355-357`（改造前）：`disposeAll()` 循环 `stop()`，无等待。

⇒ 光把 `kill()` 换成 `taskkill /T /F` 不够：**发完信号进程不一定已经死了**，`waitForExit` 必须存在，且退出流程必须愿意等它。

### 1.4 孙子进程是真的存在（Python 侧证据）

- `packages/infohub/infohub/voice.py:112`、`:167`：`subprocess.run(...)`（转写/音频工具链）。
- `packages/infohub/infohub/wecom_bot.py:433`：`subprocess.Popen([str(exe), "-m", "infohub", "bot", "--serve"], ...)` —— bot 再起一个 Python 进程。
- MCP 侧由用户配置的 `command` 决定，`npx` / `uvx` 是最常见形态（`mcp-stdio.js:271` 的注释记录了这条）。

### 1.5 两个平台没有对称做法（本轮最重要的设计约束）

- **Windows 没有"礼貌地问整棵树退出"的原生手段**：`taskkill /T` 不带 `/F` 只对 GUI 程序发 `WM_CLOSE`，控制台服务收不到。所以礼貌只能交给**协议层**（InfoHub 先写 `shutdown`、MCP 关 `stdin` 让服务读到 EOF），超时后直接 `taskkill /T /F` 拔树。
- **POSIX 的 `kill(-pid)` 只有当子进程是自己进程组组长时才安全**——负号会打在别人那一组的头上。所以两个桥的 spawn 在非 Windows 上加了 `detached: true`（`infohub-bridge.js:320`、`mcp-stdio.js:279`），Windows **不加**（那里没有进程组，`detached` 只会让子进程更难收口）。

### 1.6 本机实测：缺陷在什么形态下才暴露（四组合，真实进程）

脚本做法：父 = `node -e` 起一个孙子并打印两个 PID；判活用 `tasklist /FI "PID eq N" /NH`（★ **不能用 `process.kill(pid, 0)`**：Windows 上它对"已退出但未被父进程 reap"的 PID 返回 true，第一轮实测就是被这个假阳性骗成"全都活着"）。

| 组合 | 回收前 | 回收后 | 结论 |
|---|---|---|---|
| A. 孙子 detached + 旧做法 `child.kill()` | 父=活 孙=活 | 父=死 **孙=活** | ★ 缺陷成立 |
| B. 孙子 detached + 新做法 `teardownChild` | 父=活 孙=活 | 父=死 孙=死 | `via=tree`，已修复 |
| C. 孙子不 detached + 旧做法 | 父=活 孙=活 | 父=死 孙=死 | 这种形态**测不出缺陷** |
| D. 孙子不 detached + 新做法 | 父=活 孙=活 | 父=死 孙=死 | — |

⇒ 一条必须记进文档的教训：**前两轮实测报"缺陷未复现"，是因为探针起了个不 detached 的 node 孙子**（C 组）——普通 node 孙随父进程一起没了，而真实的 `npx → Chromium` 与 `Python → bot` 正是 A 组那种形态。探针换成 detached 后才看见孤儿。**"我改好了"必须配一个能证伪的探针。**

### 1.7 `execFileSync("taskkill")` 会同步阻塞主进程

它是 `execFileSync`——阻塞的是 Electron 主进程。缺省预算从初稿的 5s 降到 **`TASKKILL_TIMEOUT_MS = 2_000`**（`child-kill.js:32`）。拔树发生在宽限期之后（用户点停止约 1.5s 后），且只在"进程真没自己退"时触发，2s 足够。

## 2. 决策

### 2.1 回收逻辑只允许有一个家：`child-kill.js`

新增 **`packages/desktop/child-kill.js`**（CommonJS，零依赖，约 215 行）导出 `hasExited` / `forceKillProcessTree` / `signalTree` / `signalEscalate` / `waitForExit` / `teardownChild` / `createChildReclaimer` + 四个时间常量。两个桥**只 require、不再自己 kill**——这条由源码守卫测试钉住（§4 变异 ⑭）：`infohub-bridge.js` 与 `mcp-stdio.js` 剥掉注释后**一个 `.kill(` 都不许出现**。

为什么不用"约定"而用守卫：本轮改造前，`child.kill()` 在两个文件里各写了一遍，第三次加边车的人还会再写一遍。

### 2.2 回收序列：每一步都要"证明死了"

`teardownChild(child, deps)`（`child-kill.js:139-156`）：

1. `!child` → `{exited:true, via:"none"}`；`hasExited` → `"already"`。
2. `graceMs`（缺省 1500）内等到 exit → `"graceful"`。这条是协议层礼貌退出（`shutdown` / stdin EOF）真正起作用的路径，绝大多数情况在这里就结束，**一次信号都不发**。
3. `signalTree`：Windows 拔树（`taskkill /T /F`，返回 `"tree"`）；POSIX `kill(-pid, SIGTERM)`（`"group"`），ESRCH/EPERM 退化成单打（`"direct"`）。
4. `waitForExit(killWaitMs=1000)` 确认；没死再 `signalEscalate`（POSIX 补 `SIGKILL` 整组；**Windows 返回 false 不再拔第二次**——见 §2.3）；再确认一次。
5. 返回 `{exited, via}`。`exited:false` 意味着**没证明它死了**，调用方必须如实写日志，不能当已经回收（`infohub-bridge.js:469-489`、`mcp-stdio.js:358-373`）。

`hasExited` 的口径（`child-kill.js:44`）：`exitCode`/`signalCode` **任一非 null** 即已死；字段**缺失也按已死算**（反过来把缺失当"活着"会导致对已死进程零信号）。这条由变异 ② 与专门的用例钉住。

### 2.3 Windows 全程只拔一次树

初稿在 grace 超时后 `signalTree` 拔一次、`signalEscalate` 再拔一次——同一棵 `taskkill /T /F` 发两遍，第二遍必然失败（进程已经没了）还多阻塞一次主进程。改成 `signalEscalate` 在 Windows 直接返回 false（`child-kill.js:99-101`），有专门用例「teardownChild：Windows 全程只拔一次树」（变异 ③ 红它）。

### 2.4 `stop()` 保持同步，`dispose()` 改异步，`idle()` 覆盖在途

- `stop()`（渲染层 IPC 每次都走它）签名与返回值不变：`shutdown` + `stdin.end()` 照发，然后把进程交给 `beginTeardown()` 后台跑。**不能让它 await**：界面点"停止"要立刻返回，`start()` 重新拉起也不该被上一棵树的回收拖住。
- `dispose()` / `disposeAll()` 改成 `async`，先停全部、再 `while (teardowns.size > 0) await Promise.allSettled([...teardowns])`（`infohub-bridge.js:519-532`、`mcp-stdio.js:395-400`）。
- 新增 `idle()`：`servers.size === 0 && teardowns.size === 0` / `!child && teardowns.size === 0`。**判据是"有没有活着的或正在回收的子进程"，不是"界面有没有在跑"**——用户几秒前点过停止、回收还在后台，这时关应用照样要等它。

### 2.5 退出闸：拦一次 → 等回收 → 再退，带硬超闸

`createChildReclaimer`（`child-kill.js:172-201`）+ `main.js:442-454`：

```js
app.on("will-quit", (event) => reclaimChildren(event));
```

- 没有任务（`tasks()` 返回空数组）→ **完全不拦**，退出零延迟。这是绝大多数情况。
- 有任务 → `armed = true` + `event.preventDefault()`，`Promise.race([settled, cap])`，超闸 `QUIT_CAP_MS = 4_000`，然后 `onQuit()` → `app.quit()`。
- **`armed` 闩只上不下**：第二次 `will-quit` 直接放行。否则 `app.quit()` 自己触发的事件会被自己吃掉 ⇒ 应用永远退不出去（变异 ④′ 红这一条）。
- **超闸定时器不 unref**：任务永远挂着时，事件循环可能已经空了，unref 就等于"没人再推进退出"。这比留一个孤儿更糟。★ 这条**单测抓不到**（§4 变异 E：改成 `.unref()` 后 0 例红），补了两道护栏：模块级源码守卫 + 真起子进程的 reclaimer 测试。
- 预算不变量 `DEFAULT_GRACE_MS + ESCALATION_WAIT_MS × 2 ≤ QUIT_CAP_MS`（1500+2000 ≤ 4000）有用例守着：改任何一个数都要先看它有没有把最坏情况挤出超闸。
- `tasks()` 枚举本身抛错 → 记日志后**不拦**（没有已知子进程，别拖慢关闭）；`onQuit` 抛错 → 只记日志，不变成未捕获异常。

### 2.6 礼貌退出仍然是协议层的事

`mcp-stdio.js:375-389` 的 `stop()` 先 `entry.child.stdin?.end?.()` 再回收，注释记录了为什么：**stdio 传输的礼貌关闭方式就是关 stdin**，合规服务读到 EOF 会自己退出，而且**它退出时会带走自己的孙子**——比我们先杀父进程干净得多。InfoHub 同理先写 `shutdown`（`infohub-bridge.js:491-511`）。`/T /F` 是兜底，不是常规路径。

### 2.7 参数注入 + 命令注入防线

`forceKillProcessTree` 走 `execFileSync("taskkill", ["/T","/F","/PID", String(pid)])`：参数是数组、`shell` 不开、PID 先过 `Number.isInteger(pid) && pid > 0`（`child-kill.js:56`）。拼字符串给 shell 就是注入口——用例专门喂了 `"4321 & del x"` 这种假 PID 并要求 `execFileSync` **一次都不被调用**（变异 ⑤ 红"taskkill 失败被当致命错误"）。

测试注入面：`spawn` / `isWindows` / `teardown` / `execFileSync` / `killGroup` 全部可注入，所以**单测从不向真实进程发信号**；真实进程只在 §1.6 的探针和那条 `spawnSync` 用例里出现。

## 3. 兼容与迁移

- **协议、存储、服务端零改动**：不动 stdio 协议帧、不动 shared schema、不动 SQLite、不碰 E2E 与信封、不动 localStorage ⇒ 无发布耦合，渲染层与 preload 一行没改。
- **打包必须带上 `child-kill.js`**：`packages/desktop/package.json:34` 的 `build.files` 加了它。★ 漏这一条的失败方式很难看——开发态一切正常，**打包后的应用在主进程 require 时直接崩**，用户看到的是"打不开"。同文件 `typecheck` 与 `test` 脚本也各加了一次 `node --check child-kill.js` / `node --test child-kill.test.js`（共 3 行改动，本轮对 package.json 只动了这 3 行）。
- **已发布的旧桌面包**：本轮全在主进程，无持久化形状变化 ⇒ 旧包新包读同一份数据，无兼容动作。旧包自身的孤儿行为不变（要等下一次发版才享受修复）。
- **回滚**：三个文件（`infohub-bridge.js` / `mcp-stdio.js` / `main.js`）回退到 HEAD + 删掉 `child-kill.js` 即可，没有数据迁移要逆。`teardown` 是注入参数，也可以在 `createInfohubBridge` / `createStdioBridge` 处传一个空实现来临时停用回收（不需要这种开关长期存在，所以没做）。
- **红线核对**（`docs/HANDOFF.md:16`）：不新增网络路径、不碰密钥、不碰 E2E、不执行第三方代码（`taskkill` 是操作系统自带二进制，参数走数组且 PID 过整数校验）；**绝不自动拉起 Python 边车**这条仍然成立——hello 超时那条路径只做回收、不做启动（`infohub-bridge.js:332-339`），回收逻辑里没有 `spawn`。

## 4. 测试计划（★ 下面是实跑结果，不是计划）

**新增/改动用例（2026-11-01 实跑）**：

- `child-kill.test.js`：**27 例，全绿**（新文件）。`hasExited`（null vs 缺失）、taskkill 参数形状与"无 shell"、PID 校验对 `0/-1/1.5/"4321"/"4321 & del x"/null/undefined/NaN` **一律不调 exec**、失败吞掉、`signalTree` 四分支、Windows escalate 空转、`teardownChild` 六路径（含"只拔一次树"）、预算不变量、`waitForExit`、reclaimer 七例（拦一次/第二次放行/任务抛错/枚举抛错/onQuit 抛错/无任务不拦/超闸）、两条源码守卫（不许 unref、逐字检查 taskkill 参数）。
- `infohub-bridge.test.js`：**20 例，全绿**（+7）。detached 按平台、宽限预算与平台一并传下去、缺省 1.5s、`dispose` 必等在途回收（用 gate promise 逼出真实时序）、`exited:false` 如实写日志、hello 超时也回收、`idle()`；跨文件守卫「这两个桥不许自己杀进程，回收一律交给 child-kill」。
- `mcp-stdio.test.js`：**35 例，全绿**（+5，另 11 处改用注入的假 teardown）。同形态：detached 按平台、teardown 调用形状 `{pid, graceMs:1500, isWindows:false}`、`exited:false` 留痕、`disposeAll` 等在途、`idle()`；`stop` 用例新增断言 `stdin.ended`（礼貌退出这条路本身被钉住，变异 ⑫ 红它）。★ 本文件跑 30s 是**既有**缺陷（`planSpawn` 那批用例挂了 30s 请求超时定时器），已用 `git show HEAD:` 版本对比证明与本改动无关（旧版同样 30s，28 过 2 败）；新增用例自己带 `timeoutMs: 20`，旧的一律不碰（超出本轮范围）。
- `main.test.js`：**34 例，全绿**（+1）。源码守卫：`will-quit` 必须挂 `(event) => reclaimChildren(event)`，并**反向断言**旧的 `app.on("will-quit", () =>` 形态不再出现。
- 真子进程用例（在 `child-kill.test.js` 内）：`spawnSync(process.execPath, ["-e", script])` 起一个"父挂 exit 钩子等回收"的子进程，断言 stdout 含 `RELEASED` 且退出码 7——**这条存在的唯一理由是 §4 的变异 E**：普通单测看不见 unref。

**门禁**：`pnpm --filter @heming/desktop test` → **351 例全绿 / fail 0**（改造前 310，本轮 +41）；`pnpm --filter @heming/desktop typecheck` → 绿。**未跑 `pnpm -r build`**：它会覆写 `packages/web/dist`，而 dist 是云端发布产物的登记对象；本轮没有需要构建的产物。

**变异验证**（每条改坏都要立刻红，共 14 条 + 1 条逃逸后补护栏）：

| # | 改坏的地方 | 结果 |
|---|---|---|
| ① | infohub `stop` 退回裸 `child.kill()`（旧孤儿成因） | 红 **6** 例（含护栏） |
| ② | `teardownChild` 发完信号不确认退出就当成功 | 红 2 例 |
| ③ | Windows 分支不拔树、只杀直接子进程 | 红 2 例 |
| ④ | infohub spawn 去掉 `detached` | 红 1 例 |
| ⑤ | `dispose` 不等在途回收就返回 | 红 2 例 |
| ⑥ | MCP `stop` 退回裸 `child.kill()` | 红 4 例 |
| ⑦ | 回收闸不 `preventDefault`（异步回收被 Electron 抢在前面） | 红 1 例 |
| ⑧ | MCP `disposeAll` 不等在途回收 | 红 2 例 |
| ⑨ | MCP spawn 去掉 `detached` | 红 1 例 |
| ⑩ | MCP `stop` 不再关 stdin（丢掉礼貌退出这条路） | 红 2 例 |
| ⑪ | infohub `dispose` 改成同步包装 | 整文件红 |
| ⑫ | infohub 自己写一套回收（不 require `child-kill`） | 护栏红 1 例 |
| ⑬ | main.js `will-quit` 退回同步 dispose | 红 1 例 |
| ⑭ | `forceKillProcessTree` 抛穿（taskkill 失败被当致命错误） | 红 1 例 |
| ⑮ | 去掉 `armed` 闩（每次 will-quit 都拦 → 永远退不出去） | 红 1 例 |
| **E** | 超闸定时器 `.unref()` | ★ **首轮 0 例红** |

★ **两处变异首轮没红，都是测试自己的问题，都已修**：

1. **E（unref 逃逸）**：单测里没有"事件循环空下来"这个场景，所以把它改成 unref 完全不被察觉——而这条正是 §1.2 那个原始缺陷的复发路径。补了两道护栏：`child-kill.js` 的源码守卫「本模块的兜底定时器一个都不许 unref」+ 上面那条真子进程用例。重跑 E ⇒ **红掉 1 例：正是那条护栏**（已实跑，还原后逐字一致）。
2. **锚点没匹配上的假"0 例红"**：初版变异脚本用多行 `\n` 锚点，而文件是 CRLF ⇒ 替换静默失败、报告"0 例红"，看起来像"这条改动无关紧要"。改用带 EOL 探测的 `swap()` 后，⑭/⑮ 与原先报 0 的几条各自红 1 例。**教训：变异脚本必须断言"文件真的被改过"**，否则它给出的绿灯是假的。
3. 还有一条**设计错的变异**（把 `armed = true` 挪位）其实与原代码语义等价，永远不会红——真正的缺陷形态是"闩会被重置"或"根本没有闩"，所以换成 ⑮（删掉 `if (armed) return;`）。等价变异要认出来并丢掉，不然会误以为代码没被覆盖。

**实测（真实进程，见 §1.6）**：A 组（detached 孙子 + 旧做法）孙子存活 = **缺陷成立**；B 组（同形态 + 新做法）孙子死亡 = **已修复**。C/D 组作为对照说明"为什么之前两次探针都报未复现"。

## 5. 不做 / 边界

- **hello 超时仍是固定 20s**（`infohub-bridge.js`）。Hermes 那套是"渐进探测 + 可配超时"。本轮只保证**超时后进程被回收**（以前超时后进程留着占库），没改超时值本身——改了会连带影响慢机器上的首连成功率，那是另一个决策。
- **reused-PID 误判没根治**。`taskkill /PID N` 打的是"当前叫这个 PID 的进程"；极端情况下父进程早已退出、PID 被系统复用，我们会去拔一窝别人的树。Hermes 用 descriptor/claim 文件锁解决，需要它的 HTTP 后端形态才划算。本轮的缓解：`hasExited` 先判（已退出就不发任何信号）+ Windows 只在必要时拔一次 + POSIX 只对 `detached` 起过的组发负号信号。**如实标注为已知残留，不是"已解决"。**
- **POSIX 分支只过了单测**，本机是 Windows，`kill(-pid)` / `SIGKILL` 整组的行为没有在真机上实测过（用例靠注入 `killGroup`）。
- **孙子"越狱"管不到**：`taskkill /T` 依赖 OS 记的父子关系；如果孙子把自己重新挂到别处（作业对象逃逸、被 init 收养），拔不到。这类服务只能靠协议层礼貌退出（§2.6）解决。
- **不做运行历史可视化**，不加"回收了几次/失败几次"的界面；日志只在 `exited:false` 时写一行 warn。遵循「少活动部件」。
- **不引入 `tree-kill` 之类的第三方包**（那是又一个依赖 + 又一个 kill 路径），也不动 Python 侧让它自己 `atexit` 收孙子——和鸣不能假设边车版本。
- **渲染层原语**（Hermes `apps/desktop/electron/` 的 composer-draft-stash、session-pin-sync、use-messages-below、escape-layers、markdown-code、fixed-row-window）**不在本轮**：那是另一批文件、另一个风险面（React 19.3 vs 和鸣 18，`@hermes/shared` 在该仓库不存在），只能"带着改写移植"，另开规格。

## 6. 参考（判据出处）

hermes-agent @ MIT © 2025 Nous Research：`apps/desktop/electron/backend-child.ts` —— grace → 组信号 → 强杀 → 再确认的序列、`exited:false` 必须如实上报、Windows 与 POSIX 的不对称处理、"判据是进程而不是界面状态"。改写点：两个消费者（`infohub-bridge` / `mcp-stdio`）共用一个模块、descriptor/claim 文件锁整套删除、reclaimer 的 armed 闩与超闸按 Electron `will-quit` 的实际时序重写。

本轮 = d.49 规格 §6 里记下的那条候选：「`apps/desktop/electron/` 的 8 个后端生命周期文件约 740 行可原样移植，解决和鸣 Python 边车与 MCP stdio 子进程的孤儿进程、reused-PID 误判与固定 20s hello 超时问题」——**实际只做了孤儿进程这一项**，后两项落进 §5。

## 7. 实现回写（落点清单）

- **新增**：
  - `packages/desktop/child-kill.js`：`hasExited:44` / `forceKillProcessTree:55` / `signalTree:74` / `signalEscalate:99` / `waitForExit:117` / `teardownChild:139` / `createChildReclaimer:172`，常量 `DEFAULT_GRACE_MS=1500:24`、`ESCALATION_WAIT_MS=1000:26`、`TASKKILL_TIMEOUT_MS=2000:32`、`QUIT_CAP_MS=4000:34`。
  - `packages/desktop/child-kill.test.js`（27 例）。
- **改动**：
  - `infohub-bridge.js`：require `teardownChild`:25；注入面 `isWindows` / `teardown`:155-168；`teardowns` 集合；spawn 参数改对象 + `detached`:310-320；hello 超时改为"就地回收":332-339；`beginTeardown`:469；`stop` 换成回收、删掉 unref 定时器:491-511；`dispose` 改 async 并等在途:519；新增 `idle`:534 并导出。
  - `mcp-stdio.js`：require `DEFAULT_GRACE_MS, teardownChild`:25；注入面:211-222；spawn `detached`:271-279；`beginTeardown`:358；`stop` 先关 stdin 再回收:375-389；`disposeAll` 改 async:395；新增 `idle`:407 并导出:411。
  - `main.js`：require `createChildReclaimer`:13；`will-quit` 换成回收闸:437-454。
  - `package.json`：`typecheck`/`test` 各加一条 `node --check child-kill.js` / `node --test child-kill.test.js`:10-11；`build.files` 加 `"child-kill.js"`:34。**只有这 3 行**。
  - `infohub-bridge.test.js` / `mcp-stdio.test.js` / `main.test.js`：见 §4。
- **未动**：`packages/web` 全部（并行会话正在改）、`packages/{server,shared,infohub}`、preload、stdio 协议、任何存储形状。
- **门禁**：desktop **351 例全绿**（改造前 310）、typecheck 绿；真实进程四组合实测缺陷成立且已修复（§1.6）；15 条变异全部能红（E 补护栏后红，其余首轮 0 红的三条已定位为脚本锚点/等价变异并复跑确认）。
- **待补**：① POSIX 分支的真机验证（需要 mac/linux 上跑一次 §1.6 那个探针）；② reused-PID 的彻底方案（descriptor 或 Job Object），本轮只在 §5 如实标注残留；③ hello 超时改可配/渐进（要先定慢机器的验收标准）；④ `docs/HANDOFF.md` 里程碑里 d.45 那句"`will-quit` 兜底回收"现在应读作"整树回收 + 等跑完"。
