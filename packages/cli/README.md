# @heming/cli

和鸣的无头命令行入口：把桌面端同一条智能体循环（`runAgentMentions`）、同一套文件工具与
同一条审批口径搬到终端与 CI 里，不依赖 Electron / React / 浏览器存储。

> 这是 monorepo 内部包（`private`），通过根脚本运行：
>
> ```bash
> pnpm cli --help
> ```

## 用法

```bash
# 跑一轮：最终回答流式写到 stdout，进度/工具轨迹写到 stderr
pnpm cli "读一下 README，用三句话总结这个项目"

# 非交互 + 机器可读：stdout 恰好一个 JSON 对象
pnpm --silent cli exec --json "把 src 下所有 TODO 列出来"

# 允许危险工具（run_command 会真的执行，没有人工确认）
pnpm cli --allow-danger "跑一下测试，失败了就修"

# 指定工作目录、模型、端点和轮次上限
pnpm cli exec --cwd D:/repo --model gpt-4o-mini --max-rounds 6 "解释这里的构建流程"

# 边跑边说：stdout 每行一条事件（给 CI / 别的 agent 读）
pnpm --silent cli exec --output-format stream-json "跑一下测试并修掉失败"

# 指令从 stdin 读（把上一步的产物直接喂给它）
git diff | pnpm --silent cli exec - 

# 给别的编辑器当 MCP 服务（不调模型，只把本机工具暴露出去）
pnpm --silent cli mcp serve --cwd D:/repo
```

### 命令

| 命令 | 说明 |
| --- | --- |
| `heming run <prompt...>` | 交互给人看的一轮。stdout 只有模型最终回答；进度、工具调用、失败原因在 stderr。 |
| `heming run -` | 同上，指令从 stdin 读（`git diff | heming run -`）。 |
| `heming exec [--json] <prompt...>` | 非交互执行。`--json` 时 stdout 只有一个 JSON 对象（日志/进度仍走 stderr）。 |
| `heming exec --output-format stream-json <prompt...>` | 非交互执行，stdout 每行一条事件（见下文事件契约）。 |
| `heming exec -` | 非交互执行，指令从 stdin 读。 |
| `heming mcp serve [--cwd <dir>] [--allow-danger]` | 以 MCP 服务端身份在 stdio 上讲 JSON-RPC，把同一套文件工具交给别的编辑器/客户端（不调模型）。见下文「MCP 服务」。 |
| `heming sessions [--json] [--cwd <dir>]` | 列出本机的会话存档（id / 时间 / 条数 / 最后一句），不调模型。见下文「会话：接着上次聊」。 |
| `heming --version` | 打印 `@heming/cli <版本>`。 |
| `heming --help` | 用法与能力边界。 |

### 选项

| 选项 | 说明 |
| --- | --- |
| `--cwd <dir>` | 工作目录，同时是唯一可写根（`{ path: <cwd>, mode: "write", name: "work" }`）。默认 `process.cwd()`。 |
| `--max-rounds <n>` | 最多允许 `n` 个工具轮。第 `n+1` 轮如果模型还要调工具，CLI 会提前收口（第 `n+1` 轮直接作答仍然允许）。`n` 必须是正整数。 |
| `--allow-danger` | 放行 `run_command` 等 danger 工具。不加时命令工具**不会出现在工具清单里**；模型硬调会得到「未执行」而不是真正执行。 |
| `--output-format <f>` | stdout 格式：`text`（默认）/ `json`（= `--json`，exec 专用）/ `stream-json`（一行一条事件，run 与 exec 都可用）。 |
| `--model <id>` | 模型 id，默认 `gpt-4o-mini`。 |
| `--base-url <url>` | OpenAI 兼容端点，默认 `https://api.openai.com/v1`。必须以 `http://` / `https://` 开头。 |
| `--api-key <key>` | API Key，优先于环境变量。 |
| `--continue` | 接着这个工作目录下最近一次会话聊（没有同目录的就接全局最近一次）。 |
| `--resume <id>` | 接着指定会话聊。支持唯一前缀（如 `--resume 20261118-14`）；匹配到多份会列出来让你挑。 |
| `--session-dir <dir>` | 会话存档目录，默认 `~/.heming/cli-sessions`（也可用环境变量 `HEMING_CLI_SESSION_DIR`）。 |

选项同时支持 `--x value` 与 `--x=value`；`--` 之后的所有内容都按 prompt 处理
（prompt 里出现 `--foo` 时用 `--` 保命）。未知选项是用法错误，不会被静默忽略。
`--json` 与 `--output-format stream-json` 互相冲突（一个是「跑完给一个对象」，一个是「边跑边说」），
同时给会当场报错而不是让一种静默盖掉另一种。

## 模型配置

优先级：**命令行 > `HEMING_*` > `OPENAI_*`**。

| 用途 | 命令行 | 环境变量（优先） | 环境变量（回退） |
| --- | --- | --- | --- |
| API Key | `--api-key` | `HEMING_API_KEY` | `OPENAI_API_KEY` |
| 端点 | `--base-url` | `HEMING_BASE_URL` | `OPENAI_BASE_URL` |
| 模型 | `--model` | `HEMING_MODEL` | `OPENAI_MODEL` |

没有任何 API Key 时不会尝试请求：CLI 打印「要配哪个环境变量」的说明并以退出码 `2` 退出，
不会输出半截堆栈。

协议固定为 OpenAI Chat Completions（`provider: "openai"`）。第三方兼容网关把
`HEMING_BASE_URL` 指过去即可（地址不要以 `/` 结尾也能用，CLI 会去掉尾斜杠）。

## `exec --json` 输出契约

stdout **只有一个 JSON 对象**（一行），所有进度/日志都在 stderr：

> 通过根脚本运行时请加 `--silent`（`pnpm --silent cli ...`）：`pnpm run` 默认会往 stdout
> 打印 `> heming@... cli` 两行横幅，那会把 JSON 弄脏。也可以绕过 pnpm 直接跑
> `node --import tsx packages/cli/src/index.ts ...`。

```json
{
  "ok": true,
  "text": "模型最终回答全文",
  "rounds": 2,
  "toolCalls": [
    { "name": "file_read", "ok": true, "denied": false, "text": "工具回给模型的文本（≤500 字符）" }
  ],
  "writes": ["D:/repo/notes.md"],
  "usage": { "input": 1800, "output": 240, "cacheRead": 0 },
  "durationMs": 4321,
  "sessionId": "20261118-144230-ab12",
  "error": "仅失败时出现"
}
```

| 字段 | 含义 |
| --- | --- |
| `ok` | 运行是否完成且没有运行级失败。单个工具失败/被拒**不**把它翻成 `false`（看 `toolCalls`）。达到 `--max-rounds` 的主动收口也不算失败。 |
| `text` | 最终回答。失败/中断时是已经产生的部分文本（可能为空串）。 |
| `rounds` | 实际调用模型的次数（工具循环每轮 +1，含最后的作答轮）。 |
| `toolCalls[].name` | 工具名。 |
| `toolCalls[].ok` | 工具层结果是否为成功。 |
| `toolCalls[].denied` | 是否因策略未执行：闸门拒绝，或未授权 `run_command`。 |
| `toolCalls[].text` | 工具回给模型的文本，截断到 500 字符；没有文本时省略。 |
| `writes` | 本回合**真正成功落盘**的绝对路径（正斜杠），被拒/失败的写不在里面。 |
| `usage.input` / `usage.output` | 各轮上报的 token 之和；供应商没上报时是 `0`。 |
| `usage.cacheRead` / `usage.cacheWrite` | 仅当网关上报过缓存口径时出现（`0` 与「没上报」靠字段是否存在区分）。 |
| `durationMs` | 从启动到收口的墙钟耗时。 |
| `sessionId` | 本次会话的存档 id。下次 `--resume <id>` 就接着这份聊（见「会话：接着上次聊」）。 |
| `error` | 运行级失败原因（仅 `ok: false` 时出现）。 |

## `--output-format stream-json` 事件契约

stdout **每行恰好一个 JSON 对象**（行分隔，可直接 `readline` 读），进度/日志仍在 stderr。
适合 CI 里实时展示「它现在在干什么」，或让另一个程序边跑边决策。

顺序固定为：`start` →（`round` / `delta` / `tool_start` / `tool_end` / `retry` 任意交错）→ `final`。
运行前的配置错误（没配 Key、`--cwd` 不存在）会在 `start` 之前发一条 `error` 并以退出码 `2` 结束。

| `type` | 字段 | 含义 |
| --- | --- | --- |
| `start` | `command` / `cwd` / `maxRounds` / `allowDanger` | 这次运行的基本参数，消费方据此确定后面事件的归属。 |
| `round` | `round`，可选 `tool` | 进入第 N 轮；带 `tool` 表示这一轮正在调用该工具。 |
| `delta` | `text` | 最终回答的**增量**（拼接后等于 `final.result.text`）。 |
| `tool_start` | `name` / `args` | 工具开始执行。`args` 是**摘要**（`path=` / `command=` / `pattern=`），不是完整参数——写文件时完整参数是整份正文，不该进事件流。 |
| `tool_end` | `name` / `ok` / `denied` | 工具结束。`denied` 单独标出「策略拒绝」，与「工具执行失败」区分。 |
| `retry` | `attempt` / `max` / `delayMs` / `reason` | 上游瞬时错误，正在退避重试。 |
| `final` | `result` | 运行收尾（失败/中断也发）。`result` 与 `exec --json` 的对象**同构**，字段见上一节。 |
| `error` | `message` | 运行前的用法/配置错误。 |

## 从 stdin 读指令

prompt 位置写 `-` 时，指令从 stdin 读（`git diff | heming exec -`、`cat failures.log | heming run --allow-danger -`）。

- 上限 1 MB：prompt 是一段指令，不是整份大文件；超限会报「改用 `--cwd` 让智能体自己读文件」并以退出码 `2` 结束。
- 读到的内容会去掉首尾空白；**空输入**是用法错误（`从 stdin 没有读到内容`）。
- 不是 `-` 的普通 prompt 不受影响（`exec "读一下 - 后面的文件"` 不会被当成 stdin）。

## 退出码

| 码 | 含义 |
| --- | --- |
| `0` | 跑完且没有运行级失败。 |
| `1` | 运行失败（模型/工具/收口失败，或非预期的内部异常）。 |
| `2` | 用法或配置错误（参数错、`--cwd` 不存在、没配 API Key、base URL 非法）。 |
| `130` | Ctrl+C 中断（SIGINT 时调用 `run.abortAll()`；再按一次立即退出）。 |

`exec --json` 被中断时仍会输出一个 JSON 对象（`ok: false` + `error`），随后以 `130` 退出。

## 会话：接着上次聊

`run` 默认是单轮的：跑完一次就忘掉上一次说过什么。要让终端里的和鸣接着上一轮，
用 `--continue` 或 `--resume`；`sessions` 用来看有哪些会话可接。

### 三条用法

```bash
# 接这个目录下最近一次会话
pnpm --silent cli run --continue "把刚才那两个失败用例修掉"

# 接指定会话（支持唯一前缀）
pnpm --silent cli run --resume 20261118-144230-ab12 "继续"

# 看有哪些会话
pnpm --silent cli sessions
pnpm --silent cli sessions --json --cwd D:/repo
```

`heming run --continue "…"` 与 `heming run "…" --continue` 等价。

### 存档里有什么

- **只有文字问答**：你的提问 + 模型的最终回答。工具调用、中间话术、思考过程不进存档
  ——它们体积大，而且旧的工具结果里提到的文件可能已经不在当前目录，重放只会误导下一轮。
- **一个会话一个文件**：`<dir>/<id>.json`，`<id>` 形如 `20261118-144230-ab12`。
  写盘用「临时文件 + rename」，不会留下半截 JSON。
- **容量**：最多 50 个会话（按更新时间淘汰）、单会话最多 200 条轮次、单条最多 20000 字
  （超了会截断并在存档里注明）。
- **坏存档不会挡住运行**：读侧全部容错，坏文件跳过、目录不存在当空；写失败只在 stderr
  提示一句，本次结果与退出码都不受影响。

### 存档放哪

默认 `~/.heming/cli-sessions/`，按优先级：

1. `--session-dir <dir>`
2. 环境变量 `HEMING_CLI_SESSION_DIR`
3. `~/.heming/cli-sessions`（Windows 上是 `%USERPROFILE%\.heming\cli-sessions`）

`--continue` 优先接**同一工作目录**下最近一次会话，没有同目录的才退到全局最近一次。
`--resume` 只认 id（整串或唯一前缀），不看工作目录。

### 脚本里接着跑

`heming exec --json` 的返回值多一个 `sessionId` 字段：

```bash
sid=$(pnpm --silent cli exec --json "读一遍仓库结构" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).sessionId))')
pnpm --silent cli exec --json --resume "$sid" "按刚才看到的，改一下构建脚本"
```

### 已知留白

- 只接文字问答：`--continue` 后模型看到的是「你问过什么、它答了什么」，不是「它用过哪些工具」。
- 不做跨机器同步：存档是本机文件，换机器或清掉目录就没了。
- `--continue` 只按工作目录匹配，不判断「是不是同一件事」；同一目录下两个不相干的会话会被当成一条线。
- 中断（Ctrl+C）那一轮只留提问：下次接上时模型知道你问过什么，但不知道当时答到哪。
## MCP 服务：`heming mcp serve`

同一个可执行文件换个身份：不做智能体，只把本机文件工具按
[MCP](https://modelcontextprotocol.io)（Model Context Protocol）暴露出去，让 Cursor、Claude Code、
Claude Desktop 之类支持 MCP 的客户端直接调用。**这条路不调模型**，所以不需要 `--api-key`，
也不需要 `--model` / `--max-rounds` / 输出格式——带了会报用法错误，而不是被静默忽略。

```bash
# 在 D:/repo 上开一个 stdio MCP 服务（唯一的可写根就是这个目录）
heming mcp serve --cwd D:/repo
```

客户端配置（以 Claude Desktop 的 `claude_desktop_config.json` 为例，路径换成你的）：

```json
{
  "mcpServers": {
    "heming": {
      "command": "node",
      "args": [
        "D:/Heming/packages/cli/bin/heming.mjs",
        "mcp", "serve", "--cwd", "D:/repo"
      ]
    }
  }
}
```

`bin/heming.mjs` 是给客户端用的稳定入口：它用仓库里已装好的 `tsx` 转译 `src/index.ts`，
不需要 `pnpm` 在 PATH 里、也不依赖 `dist`（本包的 `build` 只做类型检查，不产出 `dist`）。
参数原样透传，`Ctrl+C` / 被客户端杀掉时会把信号交给真正的进程并如实返回退出码。
在仓库里开发时用 `pnpm cli mcp serve --cwd D:/repo` 也一样。

### 支持的方法

| 方法 | 行为 |
| --- | --- |
| `initialize` | 回协议版本（客户端认识的版本原样照抄，否则回 `2025-06-18`）、`capabilities.tools`、`serverInfo`，以及一段 `instructions`：可写范围、有没有 `run_command`、当前工具清单。 |
| `ping` | 回空对象（探活）。 |
| `tools/list` | 把同一份工具声明转成 MCP 描述：`parameters` → `inputSchema`，并按工具声明的风险加 `annotations`（只读带 `readOnlyHint`，`run_command` 带 `destructiveHint` + `openWorldHint`）。没有风险声明的工具**不硬塞** annotations。 |
| `tools/call` | 先过确定性闸门，再执行。 |

不认识的请求回 `-32601` 并点名支持的方法；通知（没有 `id`）**绝不回包**（回了会让客户端收到一条
无法对应请求的响应）。

### stdout 是协议通道

- stdout 只有 JSON-RPC 响应，一行一条；
- 启动提示、错误、收工信息全部写 stderr（`[heming] mcp serve 已就绪：工作区 …，N 个工具…`）；
- stdin 关闭 = 正常收工，退出码 `0`；Ctrl+C 时第一次优雅关闭 stdin，再按一次 `130`。

### 错误码

| 码 | 场景 |
| --- | --- |
| `-32700` | 这一行不是 JSON（坏消息不会断连，下一行照常处理）。 |
| `-32600` | 不是对象 / `id` 类型非法（只接受字符串、数字、null）/ 缺 `method`。 |
| `-32601` | 方法未知。 |
| `-32602` | `tools/call` 的参数不合法：缺 `name`、`arguments` 不是对象、工具不存在。 |
| `-32603` | 我们自己的内部异常（客户端可重试）。 |

### 安全边界（与 `run` 完全同一条口径）

- 闸门与 `run` 是**同一份代码**（`src/tooling.ts`），不会出现「CLI 拒绝、MCP 放行」的缝；
- 工具只在一个根里干活：`--cwd` 指向的目录。根外、删除/改名、改可执行脚本等「本该问人」的写**一律拒绝**；
- 没有 `--allow-danger` 时工具清单里**没有** `run_command`，硬调会拿到「未执行」而不是真的执行；
- 客户端发来的绝对路径会被换算成相对工作区的写法（`D:/repo/src/a.ts` → `src/a.ts`）：契约要求相对路径，
  但真实客户端都发绝对路径，不换算等于一次合法的写直接失败；工作区外的绝对路径换算成 `../…` 后照样被越界检查挡下。

### 已知留白

- 只实现了 `tools` 能力：没有 `resources` / `prompts` / `sampling`（客户端要的是工具，不是我们的提示词）。
- 请求串行处理：stdio 上并行回包时序难调，而单机文件工具没有并发收益。
- `file_patch` 里的多个文件路径不做换算（补丁是一段文本，逐行改写会弄坏上下文），需要补丁时请用相对路径。
- 没有鉴权：MCP 客户端与 CLI 是同一个用户、同一台机器，进程边界就是权限边界。

## 工具与审批口径

默认提供真实的内置工具：

- 文件：`file_read` / `file_write` / `file_edit` / `file_patch` / `file_glob` / `file_grep` /
  `file_image` / `file_undo`（与桌面端同一份 `fileEdit` 实现，Node fs 桥）；
- 任务清单：`todo_write`；
- 长输出回读：`tool_output_read`；
- `run_command` **仅**在 `--allow-danger` 时提供，并同时提供 `command_output` /
  `command_list` / `command_kill`（后台作业通道）。

没有人类可问，所以审批是确定性的（**fail-closed**）：

| 调用 | 结果 |
| --- | --- |
| 只读（`file_read` / `file_glob` / `file_grep` / `file_image` / `todo_write` / `tool_output_read`） | 放行 |
| 根内普通文件写 | 放行 |
| 写根外、删除/改名、改可执行脚本或依赖清单等「本应问人」的写 | **拒绝** |
| `run_command` 未加 `--allow-danger` | 返回「未执行：CLI 未授权危险工具（需要 --allow-danger）」，命令不会执行 |
| 认不出风险的工具 | **拒绝**（不猜测） |

## 能力边界

- **不接 MCP 客户端**：没有 MCP 服务发现/调用（不把别人的工具挂进来）。反过来，`heming mcp serve`
  让我们作为 MCP **服务端**被别的编辑器调用——只出不进。
- **不接联网搜索**：没有 web search 工具；需要联网请用 `--allow-danger` 跑命令（如 `curl`）。
- **没有 HITL 人工确认**：无人值守时「问」一律按拒绝处理；危险能力必须由启动参数显式授权。
- **单轮、无历史**：每次调用都是独立会话，不读写桌面端的聊天历史/记忆/任务清单。
  需要多轮请把上下文写进 prompt，或分多次调用。
- **不是 Electron**：系统提示词按「文件工具会真的改本机文件」描述运行环境；
  不包含桌面端 UI、通知、文件选择器等能力。
- **路径写法**：目前在 Windows（Git Bash / PowerShell）上验证过；路径统一转成绝对路径 + 正斜杠。
  其它平台理论上可用（同一套 Node fs 桥），但尚未在本仓做过真机验证。
- 命令工具复用桌面端的 `shell-run.js`（工作目录校验、超时、杀进程树）；因此 CLI 的运行时
  依赖 monorepo 里的 `packages/desktop/shell-run.js`，不是独立发布物。

## CI 示例

GitHub Actions（只读任务，不需要 `--allow-danger`）：

```yaml
name: heming-cli
on: [workflow_dispatch]

jobs:
  ask:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - name: 让智能体检查仓库
        env:
          HEMING_API_KEY: ${{ secrets.HEMING_API_KEY }}
          HEMING_BASE_URL: ${{ secrets.HEMING_BASE_URL }}
          HEMING_MODEL: gpt-4o-mini
        run: |
          pnpm --silent cli exec --json --cwd . "检查仓库里是否有 TODO 注释，按文件分组列出" > result.json
          node -e "const r=require('./result.json'); console.log(r.text); if(!r.ok) process.exit(1)"
```

机器可读结果建议只消费 `exec --json`：stdout 不会被进度行污染，stderr 可以原样进 CI 日志。

要在 CI 里**实时**看到它在做什么，用事件流 + 一个按行解析的小脚本：

```yaml
      - name: 让智能体修构建
        env:
          HEMING_API_KEY: ${{ secrets.HEMING_API_KEY }}
        run: |
          pnpm --silent cli exec --output-format stream-json --allow-danger --cwd . \
            "跑 pnpm build，失败就看报错修掉，最多两轮" \
          | node -e '
            const lines = require("node:readline").createInterface({ input: process.stdin });
            lines.on("line", (line) => {
              const e = JSON.parse(line);
              if (e.type === "tool_start") console.log(`→ ${e.name} ${e.args}`);
              if (e.type === "tool_end" && (!e.ok || e.denied)) console.log(`✗ ${e.name}${e.denied ? "（被拒）" : "（失败）"}`);
              if (e.type === "final") { console.log(e.result.text); process.exitCode = e.result.ok ? 0 : 1; }
            });
          '
```

把上一步的产物直接当指令：

```bash
git diff | pnpm --silent cli exec --json - > review.json
cat build.log | pnpm --silent cli exec --output-format stream-json --allow-danger - 
```

## 开发与测试

```bash
pnpm --filter @heming/cli typecheck
pnpm --filter @heming/cli test
```

测试**不会**调用外部 API：`startAgentRun` 接受注入的 `streamChat`，用例用脚本化的假模型
驱动真实编排层与真实文件工具。`run.test.ts` 覆盖：

1. 模型先 `file_read` 再作答 → JSON 含文件内容、`toolCalls` 记录 `file_read`、退出码 0；
2. 未授权时调用 `run_command` → 工具结果是「未执行」，且命令的可观测副作用没有发生。

## 设计取舍

- **复用而不是复制**：直接跑 `packages/web/src/lib/agentStream.ts` 的 `runAgentMentions`
  与真实 `fileEdit` 工具，保证 CLI 与桌面端的工具轮次、拒绝文案、预算收口一致。
- **`index.ts` 只做 I/O**：参数解析（`args.ts`）与模型配置解析（`config.ts`）都是纯函数，
  错误在加载模型/打开文件之前就按退出码 `2` 收场。
- **失败不抛栈**：用户看到的是「哪个环境变量没配」「哪个目录不存在」，不是 Node 的堆栈。
- **JSON 契约固定**：字段只增不改；`toolCalls[].text` 截断到 500 字符，`writes` 只收成功写盘。
