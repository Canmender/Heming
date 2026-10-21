# 本地包运行时策略（npm / pypi）· 实施记录

- 日期：2026-10-21（d.25）
- 状态：**桌面端可装 npm/pypi 包；浏览器端明确标「需桌面版」；运行时一律不内置**
- 关联：`2026-10-19-mcp-tool-calling.md`（stdio 传输）、`docs/research/2026-10-22-registry-architecture.md`（T08/T09）

---

## 1. 一句话结论

Registry 里的 `npm` / `pypi` 服务要在**用户机器上**跑 `npx` / `uvx`。我们**不内置这两个运行时**，
改成「先探测、再确认、启动时翻译」三段，配一条不可协商的底线：**stdio 启动永远 `shell:false`**。

## 2. 为什么不内置

内置 Node + uv ≈ 安装包 +30MB，且上游一发新版就得重打包；而 npm/pypi 类 MCP 服务只是**发现页里的一类条目**，
大多数用户只用远程服务。为一个可选能力让所有用户多下载 30MB，不划算。

代价是「能不能装」不再是常量，于是必须探测；探测结果直接决定界面文案，见 §5。

## 3. 三层防线

```
① 映射层（渲染进程，纯函数）  map.ts
   LOCAL_TYPES = ["npm","pypi"]  ← 白名单，不是「除未知皆可」
   validatePackage(): SAFE_IDENTIFIER=/^[A-Za-z0-9@/._-]+$/、SAFE_VERSION=/^[A-Za-z0-9.+-]+$/、MAX_IDENTIFIER=200
   无固定 version → 拒绝（浮动版本 = 确认的不是跑的）
   packageArguments / environmentVariables → 一律丢弃
        ↓ 只产出**逻辑命令** npx / uvx + 参数数组
② 探测层                    registry/runtime.ts + desktop/local-runtime.js
   window.__heming_runtime.probe() → {platform, npm:boolean, pypi:boolean, note}
        ↓ 齐备才进 HITL 确认卡
③ 启动层（主进程）           mcp-stdio.js + local-runtime.js:planStdioSpawn
   把逻辑命令翻译成本机真正可执行的文件（绝对路径），恒定 shell:false
```

**顺序不能换**：白名单挡的是注入本身（靠一个正则，不靠转义函数没有漏洞）；探测挡的是「装了跑不起来」；
翻译层挡的是 Windows 的执行模型差异。

## 4. Windows 实测事实（决定了 §6 的形态）

| 尝试 | 结果 |
| --- | --- |
| `spawn("npx")` | **ENOENT** —— PATH 里没有无扩展名的可执行文件（`npx` 本体是 2073 字节的 shell 脚本） |
| `spawn("npx.cmd")` | **EINVAL** —— Node ≥18.20.2 拒绝直接执行 `.cmd/.bat`（CVE-2024-27980 加固） |
| `spawn("uvx")` | OK（`uvx` 是真 `.exe`） |
| `spawn("node", ["…/npx-cli.js", …])` | OK ← **走这条** |

另一条实测：**libuv 在 Windows 上按父进程的 PATH 找可执行文件**，`options.env.PATH` 里补的目录不参与搜索。
所以 `buildChildEnv` 补全的目录只对**绝对路径**有意义 → `resolveExecutablePath()` 返回绝对路径，
候选顺序 `.exe → .cmd → .bat → 原名`（原名放最后，让真 exe 优先命中）。

## 5. 界面与安装流

- **发现页挂载即探测**（`probeRuntime()`，单飞、永不抛），点安装时再兜一次。
- 三种「装不了」的文案必须分开，因为用户要做的事完全不同：
  - `暂不支持` = Registry 侧没有可用装法（oci / nuget / mcpb / 未知类型 / 包名不合法 / 没钉版本）
  - `缺运行时` = 本机没有 Node 或 uv，`本机未检测到 uv（uvx）。安装 uv（提供 uvx）后再装，或改用远程服务。`
  - `需桌面版` = 浏览器环境，`本地包服务需要桌面版（浏览器无法拉起本机进程）`
  原因写在行的 meta 里（可见），不只藏在按钮 `title`（触屏与读屏拿不到）。
- ★ **探测在 HITL 之前**：让用户逐项确认一个根本跑不起来的东西没有意义。
  「先探测」与「安装永远要确认」是两条独立约束，前者不放松后者（供应链决策 ≠ 工具执行）。
- ★ **探测失败（IPC 坏了）在桌面端不拦**：探测失败是我们的问题，不该变成用户的安装障碍；
  真跑不起来时启动层会给准确错误（`本机未找到 uv/uvx（pypi 包需要 uv）…`）。
- 页头显示 `本机运行时：Node.js 可用 · uv 未检测到`，装完工具仍默认关闭。

## 6. 配置里存什么

`McpServerConfig` 存**逻辑命令**（`npx` / `uvx`）而不是本机真实形态 —— 配置因此可移植，
翻译只发生在执行那一刻、紧挨着 `shell:false` 这段代码。

新增两个台账字段（`registryType` / `registryVersion`）：只是账本，供接口区显示
`Registry · npm · v1.2.3`，**不作为执行输入**。它们必须同时出现在 `add()` 与 `coerceServer()` 的字段白名单里，
否则写进 localStorage 会被静默丢掉。顺带修了一个不一致：`add()` 之前不传 `origin` 时留 `undefined`，
重启读回却是 `manual` —— 现在缺省定死 `manual`。

## 7. 删除必须回收进程

`stopStdioServer(serverId)`（`lib/mcp/runtime.ts`）只在**删除路径**调用，不放 `resetClient()` 里：
`refreshServerTools` 每次都 resetClient，一并 kill 会让「重连一次」变成「重启一次进程」
（实测 Windows-MCP 冷启动 5.4s）。它**永不抛** —— 进程可能已自己退出，删除不该被回收失败阻断。
不 stop 的后果是「界面已删除、进程还在读写本机」。

## 8. 测试

| 文件 | 覆盖 |
| --- | --- |
| `packages/desktop/local-runtime.test.js` (22) | `pathEntriesOf`/`findNpmCli`/探测/翻译；★ 翻译结果绝不是 `.cmd/.bat`；`uv` → `["tool","run",…]`（`uvx` 是 `uv tool run` 的别名） |
| `packages/desktop/mcp-stdio.test.js` (30) | `resolveExecutablePath` 候选顺序；`planSpawn` 收到补全后的 PATH；planSpawn 抛错则不 spawn；翻译后仍非法命令照样拒 |
| `packages/desktop/{main,preload}.test.js` | `planSpawn: planStdioSpawn` 已接线；`runtime:probe` IPC；`__heming_runtime`；源码不含 `shell: true` |
| `src/lib/registry/runtime.test.ts` (17) | `normalize()` 逐字段校验；`missingRuntimeReason` 三种分支；远程装法永远返回 null |
| `src/lib/registry/map.test.ts` (45) | `pinnedSpec`（pypi 用 `==`）；缺版本拒装；台账字段 |
| `src/store/registry.test.ts` (17) | 缺运行时**不进确认卡**；探测只做一次；运行时齐备≠免确认；台账落盘 |
| `src/components/RegistryPage.test.tsx` (8) | 需桌面版 / 缺运行时 / 齐备可点 / 探测失败不拦 / 未知类型仍标暂不支持 |
| `src/lib/mcp/{mcp,stdioClient}.test.ts` | 台账穿过存储往返；`resetClient` 不碰进程；stop 透传 serverId 且吞错 |

## 9. 已知边界

- 桌面端 Electron 从快捷方式启动时继承**安装那一刻**的 PATH，用户后装的 node/uv 可能不在其中 ——
  已由「绝对路径解析 + `buildChildEnv` 补全常见目录」缓解，但补全目录是写死的清单，装在非常规路径仍可能探不到。
- `uv` 只支持 `uvx`/`uv tool run` 这一条路径，不用 venv、不装依赖到项目里。
- oci / nuget / mcpb 类型明确不支持（不猜启动命令）。
- 包版本钉在 Registry 快照那一刻；上游发新版不会自动跟进，需要重装（这是「确认一次=跑这一版」的代价）。
- **与内置运行时的关系**：`scripts/prepare-runtime.mjs` 当前只打 Python + 两个 MCP 入口脚本，
   **不含 `uv`/`uvx`**（预置里的 `uvx` 是退回系统 PATH 找的），所以 pypi 本地包现在确实要本机装 uv。
   但探测跑在 `buildChildEnv(bundledEnv(...))` 之后的 PATH 上 —— **将来若把 uv 装进 `mcp-env/Scripts`，
   `planStdioSpawn` 与探测会直接认它**，pypi 本地包就变成零外部依赖，不需要改这段逻辑。
   Node 侧没有这条捷径：npm 包要的是 `node.exe` + `npx-cli.js`，随包带 Node 才是真正的 +30MB。
