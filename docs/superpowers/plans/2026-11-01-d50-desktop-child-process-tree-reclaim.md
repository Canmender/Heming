# d.50 · 桌面子进程整树回收实施计划

- 规格：`docs/superpowers/specs/2026-11-01-d50-desktop-child-process-tree-reclaim.md`
- 目标：把「杀直接子进程」换成「回收整棵树，且退出前真的等它跑完」，消灭 MCP stdio 与 InfoHub Python 边车留下的孤儿进程。
- 只碰 `packages/desktop`；不新增依赖；不动 stdio 协议、存储形状、服务端、渲染层。

## 1. 新模块 `child-kill.js`（唯一允许 kill 的地方）

- 常量：`DEFAULT_GRACE_MS=1500`、`ESCALATION_WAIT_MS=1000`、`TASKKILL_TIMEOUT_MS=2000`、`QUIT_CAP_MS=4000`
- `hasExited(child)`：`exitCode`/`signalCode` 任一非 null 即已死；字段缺失也按已死算
- `forceKillProcessTree(pid, deps)`：`execFileSync("taskkill", ["/T","/F","/PID", String(pid)], {windowsHide, stdio:"ignore", timeout})`；PID 先过 `Number.isInteger && >0`；失败吞掉返回 false
- `signalTree` / `signalEscalate`：Windows 拔树且 escalate 空转（全程只拔一次）；POSIX `kill(-pid, SIGTERM/SIGKILL)`，ESRCH/EPERM 退化单打
- `waitForExit(child, ms)`：已退出立刻 resolve；**定时器不 unref**
- `teardownChild(child, deps)` → `{exited, via}`：none/already → grace → tree/group → confirm → escalate → confirm；`exited:false` 表示没证明死了
- `createChildReclaimer({tasks, onQuit, capMs, log})`：armed 闩只上不下、无任务不拦、`preventDefault` → `Promise.race([settled, cap])` → `onQuit`

## 2. 两个桥改成"只交进程、不动手"

`infohub-bridge.js`：

- require `teardownChild`；注入面加 `isWindows`、`teardown`
- spawn 参数改对象，非 Windows 加 `detached: true`
- `stop({killDelayMs=1500, silent})` 保持同步：`shutdown` + `stdin.end()` 照发，进程交给 `beginTeardown()`；**删掉 unref 的 kill 定时器**
- hello 超时 → 就地 `stop({killDelayMs:0})` 回收（起不来的 Python 不能占着归档库）
- `dispose()` 改 async，`while (teardowns.size>0) await allSettled`；新增 `idle()` = `!child && teardowns.size===0`

`mcp-stdio.js`：同形态 —— `detached`:279、`beginTeardown`:358、`stop` 先关 stdin 再回收:375-389、`disposeAll` 改 async:395、`idle()`:407

## 3. `main.js`：退出走闸

```js
const reclaimChildren = createChildReclaimer({
  tasks: () => [!mcpStdio.idle() && mcpStdio.disposeAll, infohubBridge && !infohubBridge.idle() && ...].filter(Boolean).map(fn => () => fn()),
  onQuit: () => app.quit(),
  log: (line) => console.warn(line),
});
app.on("will-quit", (event) => reclaimChildren(event));
```

判据是 `idle()`（活进程 **或在途回收**），不是"界面有没有在跑"。

## 4. 测试

- 新增 `child-kill.test.js`（27 例）：PID 校验拒绝注入形态、taskkill 参数逐字、signalTree/escalate 分支、teardownChild 六路径、Windows 只拔一次、预算不变量、reclaimer 七例、两条源码守卫（不 unref、参数形状）、真子进程 `spawnSync` 用例
- `infohub-bridge.test.js` +7、`mcp-stdio.js` +5、`main.test.js` +1；跨文件守卫「两个桥剥注释后一个 `.kill(` 都不许有」
- 注入面：`spawn` / `isWindows` / `teardown` / `execFileSync` / `killGroup` —— 单测绝不向真实进程发信号
- 门禁：`pnpm --filter @heming/desktop test`（实跑 **351 例全绿**，改造前 310）+ `typecheck` 绿；**不跑 `pnpm -r build`**（会覆写 `packages/web/dist` 这个云端产物）
- 变异 15 条逐条红（见规格 §4），其中 E（unref）首轮 0 红 ⇒ 补源码守卫 + 真子进程用例后红
- 真实进程探针（已删）：四组合 + `tasklist` 判活；A 组（detached 孙子 + 旧 kill）孙子存活 ⇒ 缺陷成立，B 组 ⇒ 已修复

## 5. 打包与回滚

- `package.json` 只改 3 行：`typecheck` / `test` 各加 `child-kill`，**`build.files` 必须加 `"child-kill.js"`**（漏了 ⇒ 打包后主进程 require 直接崩）
- 回滚 = 三个文件回 HEAD + 删 `child-kill.js`，无数据迁移
