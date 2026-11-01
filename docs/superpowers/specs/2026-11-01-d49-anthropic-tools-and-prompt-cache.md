# d.49 · Anthropic 原生工具调用 + 前缀缓存（P0-6）

- 日期：2026-11-01
- 状态：规格（未开工）
- 轮次号说明：**本文件按 d.49 编号，若与并行会话撞号则顺延，标题与内容不受影响**。落地前先看 `git log -1` 与 `docs/HANDOFF.md` 的版本表。
- 依赖面警告：工作区当前有**未提交的并行改动**正好压在本轮要改的文件上——`packages/web/src/lib/llmClient.ts`、`packages/web/src/store/llm.ts`、`components/{AgentFormModal,ChatPage,SettingsPage}.tsx`，以及新增的 `lib/llmRoute.ts`、`lib/llmHealth.ts`、`lib/llmFailure.ts`。本轮开工必须**先等那批改动落库并 rebase**，否则两边在同一段 body 组装逻辑上互相覆盖。
- 借鉴来源：Nous Research **hermes-agent**（MIT, © 2025）。移植的文件需保留版权说明；本轮借的是 `agent/anthropic_message_convert.py`（787 行）与 `agent/prompt_caching.py`（377 行）的**判据与踩坑清单**，不搬 Python 源码。

---

## 0. 这一轮要解决什么

两件事，都是「用户看得见、系统不解释」的类型。

1. **绑 Anthropic 的智能体没有工具**。`docs/HANDOFF.md:236` 记着这条债：消息结构（content blocks）与 OpenAI 不同，所以绑 Anthropic 连接的名册成员用不了 MCP / 图表 / self 工具。开关是一行硬判定（见 §1.1），它同时**把 Claude 的视觉能力误判成「不支持」**——Claude 是视觉原生模型，现在历史图片会被当场丢弃。
2. **同一轮对话里的重复前缀从不缓存**。一次 @ 提及最多发 4 个请求（1 次正文 + 最多 3 轮工具，`agentStream.ts:10`），每个请求都重带整段「系统提示词 + 记忆 + 技能 + 历史」，Anthropic 按未缓存输入全价收费。`cache_control` 在全仓一次都没出现。

本轮把这两个补上，**不改**智能体主循环、不改 HITL、不改服务端、不碰 E2E。

## 1. 已核实的事实（本轮亲自读过源码）

### 1.1 工具被关在哪一行

- `lib/capabilityNotice.ts:16`：`if (profile.provider === "anthropic") return false;`——在查能力表**之前**就一票否决，且 `kind` 不分 `tools` 还是 `vision`。
- `lib/agentStream.ts:577-581`：`useTools = !!bridge && bridge.tools.length > 0 && supportsKind(profile, "tools") && !aborted`；`:600` 才把 `bridge!.tools` 塞进请求。所以 `supportsKind` 是唯一的活动闸。
- `lib/llmClient.ts:196`：注释「工具调用只对 OpenAI 兼容协议开放（anthropic 的消息结构不同，另行适配）」；`:197` 只在 openai 分支发 `tools` + `tool_choice`。
- **但 anthropic 分支已经盲塞了一次**：`llmClient.ts:179` `...(opts.tools?.length ? { tools: opts.tools } : {})` 把 **OpenAI 形状**的 `tools` 原样发出去。今天没人触发它（`useTools` 早判 false），一旦只把 `supportsKind` 放开，Anthropic 会直接 400。**这是本轮最容易踩的假开关**。
- `lib/mcp/bridge.ts:72-79` 已有 `toAnthropicTools`（字段名 `input_schema`），全仓**零消费者**（只在 `lib/mcp/index.ts:22` 转出一行导出）。本轮是它的第一个消费者。

### 1.2 消息形状的四处不匹配

内部表示（IR）是 OpenAI 形状的 `ChatMessage[]`，Anthropic 分支现在只做浅转换：

| IR 里的形状 | `llmClient.ts` 现在 | Anthropic 要 |
|---|---|---|
| `role:"system"` 行（可多行，含上下文摘要） | `:168-172` 全部 `join("\n")` 成一个字符串塞 `system` | 字符串可行，但要挂 `cache_control` 就必须是 **text block 数组** |
| `role:"assistant", tool_calls:[...]`（`agentStream.ts:710`，`content` 就是这一轮的文本，**可能为空串**） | `:173-178` 原样 `role + content` | `assistant` 消息的 `content` 必须含 `tool_use` block；**空 text block 是硬 400** |
| `role:"tool", tool_call_id, content`（`agentStream.ts:711-716`，每个调用一行） | `:173-178` 原样发（Anthropic 没有 `tool` 角色 ⇒ 400） | 同一事务的多个 `tool_result` 要**合进一条 user 消息**；失败要 `is_error:true` |
| `contentParts` 图片 | `:54-64` 已转 base64 `source`，形状正确 | 供应商**不接受** svg/bmp/tiff；这类图一旦进了历史，**之后每次重放都 400**（Hermes 的处理：能栅格化就转 PNG，否则退成文本占位） |

### 1.3 工具名与 id：和鸣已经安全，不用做映射

- `lib/mcp/bridge.ts:10-23`：`slugPart()` 把非 `[a-z0-9_-]` 换成 `-`，中文名走短哈希；`TOOL_NAME_SEP = "__"`，`TOOL_NAME_MAX = 64`。内置工具同理（`charts/tools.ts:50` `chart_types`、`selfEdit/tools.ts:92` `self_memory_list`）。
- 结论：**名称天然合规**，不需要 Hermes 式的名称编解码。但 `tool_use_id` 要照 Hermes 清洗（`:115-117`：非 `[a-zA-Z0-9_-]` 换 `_`、绝不空）——因为 id 可能来自第三方兼容网关（`llmClient.ts:373` 本机自造的 `call_xxxx` 是安全的）。

### 1.4 流式与用量

- `llmClient.ts:348-378`：`collectToolCalls` 只认 OpenAI 的 `delta.tool_calls` 按 `index` 分片；Anthropic 的 `content_block_start`(tool_use) / `input_json_delta.partial_json` / `content_block_stop` **一个都不读**。
- `llmClient.ts:431-433`：非流式兼容分支只取 `json.content?.[0]?.text`。开了思考块以后 `[0]` 可能不是文本 ⇒ **这是本轮顺带要修的既有 bug**，与 Anthropic 工具无关也存在。
- `llmClient.ts:84-88, 315-346`：`UsageTotals` 只有 input/output/total；Anthropic 的 `cache_read_input_tokens` / `cache_creation_input_tokens` 被丢掉 ⇒ **缓存到底有没有命中，界面永远看不见**。
- `llmClient.ts:165`：`max_tokens` 缺省 **1024**。工具轮的 `input_json_delta` 也算输出，长参数会被截断成半个 JSON。
- `llmClient.ts:397-400`：400 单次降级重试**显式排除 anthropic**（`profile.provider !== "anthropic"`）——本轮要复用同一形态给 `cache_control` 兜底。

### 1.5 前缀为什么现在不稳

`agentStream.ts:429` 每次 @ 都重算系统提示词，顺序是 `base → 记忆 → 技能`；上下文摘要也是一条 `system` 角色行（`agentContext/history.ts:98`）并进 `system`。记忆命中依赖 `userText`，摘要依赖指纹缓存 `heming.contextSummaries.v1`。⇒ **跨 @ 提及的前缀不保证逐字相同**；本轮只承诺 **run 内**（同一轮 ≤4 次请求）稳定，跨轮稳定要另开一轮（§5）。

## 2. 决策

### 2.1 IR 不动，只在边缘转换

内部继续用 OpenAI 形状的 `ChatMessage[]`（`agentStream` / HITL / 审计 / 摘要链路一行不改），新增纯函数模块 **`lib/llmAnthropic.ts`** 负责 `IR → Anthropic body`。这与 Hermes 的做法一致（它的内部也是 OpenAI 形状，Anthropic 转换单独成 787 行的一个文件）。

`llmAnthropic.ts` 的导出契约：

```ts
toAnthropicMessages(messages: ChatMessage[]): AnthropicBlock[]   // 含角色折叠与配对修复
toAnthropicSystem(messages: ChatMessage[]): TextBlock[]          // 数组形状，供挂 cache_control
normalizeInputSchema(schema: unknown): object                    // 见 §2.2 末条
sanitizeToolId(id: string): string
```

**必须遵守的规则**（每条都是 Anthropic 的真实 400 或静默失效，不是风格偏好）：

1. `assistant.tool_calls` → `content: [{type:"text", text}, {type:"tool_use", id, name, input}]`；`text` 为空时**填占位 `"(empty)"`**，绝不发空 text block。
2. 连续的 `role:"tool"` 行 → **合并成一条 `user` 消息**，`content` 是 `tool_result` 数组，`tool_use_id` 用清洗后的原 id。
3. 工具结果文本为空 → 同样填占位；`ok:false`（含 HITL 拒绝，`agentStream.ts:665-677`）**映射成 `is_error:true`，文案原样保留**。拒绝语义因此天然进协议，不需要新造状态。
4. 每个 `tool_use` **必须有后继 `tool_result`**：中止、轮次上限（`agentStream.ts:639`）或坏缓存都可能留下孤立的 `tool_use`。转换层丢弃无配对的 `tool_use`（并 `console.warn`），而不是让整轮 400。
5. `input` 参数：OpenAI 侧是 JSON **字符串**，Anthropic 侧要 **对象**；解析失败退回 `{}` 并记 warn——**绝不把半个 JSON 当参数发**（Hermes `_parse_tool_args` 同此）。
6. `input_schema` 归一（借 `_normalize_tool_input_schema`）：顶层 `oneOf`/`allOf`/`anyOf` 删掉并补 `type:"object"`；`anyOf:[{...},{type:"null"}]` 这类可空并集折成非空分支（可选性已由 `required` 表达）；`type:"object"` 缺 `properties` 补 `{}`；整体不是对象 → `{type:"object",properties:{}}`。
7. 工具名去重兜底：Anthropic 对重名**硬 400**；注册表虽是 first-declared-wins（`capability/registry.ts:36`），转换层仍要再过一遍 `seen_names` 并丢弃重复项。
8. 图片 mime 白名单之外（svg/bmp/tiff）→ 转文本占位「[不支持的图片格式: xxx]」，**在转换层做而不是在上传层做**：已经躺在历史里的坏图片每次重放都会 400，上传时拦不住。
9. `tool_choice`：Anthropic 形状是 `{type:"auto"}`，不是字符串 `"auto"`。
10. `max_tokens`：带工具时抬到 **2048**（`profile.maxTokens` 显式覆盖则尊重覆盖）。

### 2.2 活动闸改回能力表，删掉供应商一票否决

`capabilityNotice.ts:16` 的那行改成走 `resolveCapability(profile)` 的真实判定：

- `tools`：Anthropic 原生即支持，缺省**判真**（用户可在能力矩阵里显式改判为不支持，覆盖仍优先）。
- `vision`：同样交能力表 ⇒ 顺带解锁 Claude 的看图。
- 红线相关：`supportsKind` 是 d.32「判定 → 丢弃」的**唯一判据源**，放开它等于同时改变两条链路的行为，所以 §4 要求 `capabilityNotice.test.ts:12-15` 的 `undefined → false` 那条**逐字不变**（未绑定连接仍然什么都不给）。

### 2.3 流式：给 Anthropic 单独一条 block 累加器

`streamChat` 内新增 `collectAnthropicBlocks(parsed)`，与现有 `collectToolCalls` 并存、按 `parsed.type` 分派：

- `content_block_start` 且 `content_block.type === "tool_use"` → 按 `index` 开一个累加槽（存 `id`/`name`）。
- `content_block_delta` 且 `delta.type === "input_json_delta"` → `partial_json` 追加进该槽。
- `delta.type === "text_delta"` → 现有正文路径（`:483-486` 改读 `parsed.delta?.text ?? ""` 的行为不变，但要显式排除 `thinking_delta` 参与正文——今天已由 `:478-482` 分流，**加一条断言用例钉住**）。
- `message_delta.stop_reason === "tool_use"` 或 `message_stop` → `flushToolCalls()` 时机与今天一致（流读完才回调，`:510-513`）。

**收口不变**：`onToolCalls` 仍然**恰好一次**；用量仍然合并后只报一次；中止/网络错不回调。

### 2.4 前缀缓存：断点规划独立成 `lib/promptCache.ts`

借 Hermes `build_prompt_cache_plan` 的三条不变量，不借它的 provider 兼容矩阵（和鸣只有 openai / anthropic 两个分支）：

1. **一次请求最多 4 个断点**，且**每次调用先剥掉上一轮的标记**（幂等）——绝不累积成第 5 个，那是硬报错。
2. **断点只落在「已完成的工具事务末尾」**（`assistant(tool_calls) → 一串 tool` 的最后一行），**不落在** open turn（末尾是 user、或末尾是还没回填结果的 assistant）上——因为事务没结束，下一请求这一段的字节一定会变，写了缓存也是白付 1.25×。
3. **布局**：`system` 最后一块 → `tools` 最后一个工具 → 已完成事务末尾（从最近往前取），**额度用满即止**（4 个）。缺省命中「system + tools + 最近两个事务」；缺一项时额度**顺延**给后一项（无 tools 时可以打到最近 3 个事务）。
4. **TTL**：缺省 `5m`。`1h` 档写入价 2×，和鸣的自动化/幕僚是机器节拍、人类会话也常在 5 分钟内有下一句，所以**不默认开 1h**；`planCache` 收 `ttl` 入参但本轮没有调用方传 1h。
5. **开关**：`promptCache?: "off" | "auto"` 是**每次请求的入参**（不是 profile 字段）——`buildRequest` 缺省 **不打标记**，`streamChat` 缺省 `"auto"`。这样 `testConnection` 那种一次性冒烟不会白付写入费，也不用碰 `LlmProfile` 的存储形状。`"off"` 时 body 除「消息内容统一成 block 数组」外与 d.48 逐字一致：`system` 仍是字符串、`cache_control` 一个都不出现。
6. **只在存在「会被重用的前缀」时规划**：既没有 system、也没有 tools、也没有已完成事务时不调 `planCache`（单次请求打标记等于纯亏 1.25×）。

### 2.5 用量与界面：命中与否必须可见

- `UsageTotals` 加 `cacheReadTokens?: number` / `cacheWriteTokens?: number`；`readUsage`（`llmClient.ts:315`）只认数字字段的老规矩不变（**拿不到就 undefined，绝不落 0**）。
- `agentStream.ts` 的 `onUsage`：**缓存读/写要补进总量**（与初稿相反，实现时改判）。理由：Anthropic 的 `input_tokens` **不含**被缓存的那一段，而 OpenAI 的 `prompt_tokens` 含——不补的话同一个智能体换个连接，用量账本凭空少一大截，而这块 token 确实是本轮提示词的规模。补法是 `inputTokens ?? 0 + outputTokens ?? 0 + cacheRead + cacheWrite`，只在没有 `totalTokens` 时生效；供应商原字段不做任何换算，`UsageTotals.inputTokens` 仍是供应商口径。
- `store/tokenUsage.ts` 行形状加这两个字段（向后兼容：旧行读作 undefined）；首页/热力图补一句「本轮缓存读 N token」；**没上报就写「未上报」**，沿用 d.32 的措辞纪律。★ **实现时缓做**：记账入口在 `ChatPage.tsx` 的 `deps.recordUsage`，而该文件正被并行会话改（d.48 路由/健康）。本轮只做「缓存字段进了 `UsageTotals` 与总量口径」，**行形状与界面文案另开一轮**，避免两条线在同一段代码上互相覆盖。
- `lib/storageUsage.ts` 的模块前缀表同步（那是单一真源，别再在组件里另抄一份）。同上，随界面那一轮一起做。
- **必须实测一条**：Anthropic 的最低可缓存前缀按模型分档（Sonnet/Opus 4 系 1024 token，Haiku 3.5/3 是 2048，Haiku 4.5 是 4096），**低于阈值时静默不缓存、不报错**，`cache_creation_input_tokens` 直接是 0。⇒ 界面在「连续多轮 `cache_read` 恒为 0」时如实显示「未命中：前缀过短或该网关不支持缓存」，绝不显示省钱结论。

### 2.6 兼容降级：沿用 400 单次重试的既有形态

第三方 Anthropic 兼容网关可能不认 `cache_control` 或 `tools`。把 `llmClient.ts` 的 400 降级从「只关 `stream_options`、只给非 anthropic」扩成**一条按供应商分档的降级链**：

1. **openai**：`{}` → `{includeUsage:false}`（与 d.32 逐字等价，两发封顶）。
2. **anthropic**：`{}` → 剥掉全部 `cache_control` → 再去掉 `tools`（`stream_options` 那一档对 anthropic 不存在，它本来就带 usage）。
3. **跳过无差异的档位**：下一档 body 与上一次**逐字相同**就不发（本轮没带 `cache_control` 或没带 `tools` 时，那一档是空降级——发出去只会让人以为「重试过」，实际什么都没变）。因此「无 system、无 tools 的 Anthropic 请求 400」仍然只发 1 次，与改造前一致。

每一档最多一次，最后一步仍失败就抛**那一步**的错误——与 `stream_options` 的现有纪律逐字对齐，不无限重试、不掩盖真实问题。★ 修正初稿的一处顺序错误：**先剥缓存、后丢 tools**（剥标记的代价小、覆盖面大；丢 tools 是真降级，必须留到最后）。留痕只在**丢 tools** 这一档 `console.warn`（那是「智能体突然不会查资料」级别的行为变化）；剥标记不留痕（只是省钱手段，且下一轮还会带上）。**都不在界面弹窗**。

## 3. 兼容与迁移

- **服务端零改动**，不动 shared schema、不动 SQLite、不碰 E2E 与信封 ⇒ 无发布耦合，桌面/网页两端口径一致。
- localStorage：**本轮不动任何存储形状**（§2.5 的用量行扩展已推后）。记忆/E2E 私钥/导出格式都不受影响（P0-5b 仍按原计划另开轮）。
- 已发布的旧桌面包：本轮全在 `packages/web` 渲染层，且没有新增持久化字段 ⇒ 旧包与新包读同一份存储，无兼容动作。
- **回滚**：`promptCache:"off"`（或不传给 `buildRequest`）时请求体不出现 `cache_control`、`system` 仍是字符串；唯一的形状变化是**消息 `content` 统一成 block 数组**（Anthropic 官方两种形态都接受，`tool_use`/`tool_result` 本来只能是数组）。要把工具也收回去，就在 `supportsKind` 恢复那行 `provider === "anthropic"` 否决——单点、一行。不需要降级安装包。
- **红线核对**（`docs/HANDOFF.md:16`）：Key 仍只进 `buildRequest` 的请求头（`:142-143` 的 baseUrl 必须带 scheme 守卫原样保留）；缓存是**供应商侧**行为，和鸣本机不新增任何落盘，个人数据不出设备这条不被触碰；不执行第三方代码；不自动拉起 Python 边车。

## 4. 测试计划

新增文件与用例数（沿用「分包串行 + `pnpm -r build`」门禁口径）。★ 下面是实跑结果，不是计划：

- `lib/llmAnthropic.test.ts`：**35 例，实跑绿**。覆盖：空 assistant/tool_result 补占位、多 `tool_result` 合并成一条 user、`is_error` 来自 `toolError`、两个方向的孤儿（无结果的 `tool_use`、无出处的 `tool_result`）都丢弃、`partial_json` 坏参数退 `{}`、顶层 `oneOf/allOf/anyOf/$schema` 删除、可空并集折叠、重名工具去重、非白名单图片 mime 退文本、`tool_choice` 不出现、相邻同角色合并、id 清洗后两侧逐字相等。
- `lib/promptCache.test.ts`：**13 例，实跑绿**。断点 ≤4、额度顺延、只落已完成事务、下标越界跳过不抛、`stripCacheMarkers` 递归剥净、TTL 可覆盖、空输入 0 断点。
- Anthropic 请求体与流式用例并入既有的 `lib/llmClient.test.ts`（原计划的 `llmClient.anthropic.test.ts` 单独文件**没另开**——同一条 `streamChat` 链路的用例放一起更好读，也少一个文件）：**新增 13 例**，含 `content_block_start/input_json_delta/content_block_stop` 拼出 `onToolCalls` **恰好一次**、`thinking_delta` 不进正文、usage 合并 cache 两字段且只回调一次、非流式 `content` 多 block 取全部文本（顺手修掉旧版「只读 `content[0].text`」的丢文本缺陷）、请求体层「空 text block 绝不进 body」、400 降级链三档 + 无差异档不发请求。
- `capabilityNotice.test.ts`：+2 例（Anthropic 的 `tools`/`vision` 交回能力表）；`supportsKind(undefined) === false` 老用例**未动**；原「Anthropic 一律不支持工具」用例改写成新事实。
- ~~`agentStream.test.ts` +2~~：**本轮未做**。`agentStream.test.ts` 与 `ChatPage.tsx` 正被并行会话改（d.48 路由/健康 + 用量拆分），同一文件双写会互相覆盖；`agentStream.ts` 的三处改动（工具闸注释、`toolError` 回灌、usage 补缓存段）已由 `llmAnthropic`/`llmClient` 的用例间接钉住，端到端「Anthropic 走工具轮 + HITL 拒绝回灌」留给补做轮。
- **变异验证**（每条改坏都要立刻红）——已实跑：
  - ① 把 `ANTHROPIC_EMPTY_TEXT` 改成 `""` ⇒ **4 例红**（三例在 `llmAnthropic`、一例在请求体层）。★ 首轮只红 1 例，因为另两例在拿常量自比（`toBe(ANTHROPIC_EMPTY_TEXT)` 恒真）——已改成断言字面量 `"(empty)"`，否则这条护栏形同虚设。
  - ② 把 `is_error` 写死 `false` ⇒ **2 例红**（拒绝语义 + tool_result 形状全等）。
  - ③ 去掉「先剥旧标记」⇒ 首轮 **0 例红**：同一份输入重复规划，标记落在同一批节点上，写两次与写一次自然等价，幂等用例抓不到。★ 补了一条真正的检测用例：**同一份对象换一批事务再规划**（模拟上下文裁剪后重算），旧标记不清就会累积到 6 个 ⇒ 现在 1 例红。这正是 Hermes 那条不变量防的场景。
  - ④（额外）把两个孤儿过滤同时关掉 ⇒ **4 例红**。
- **实测项**：本机没有可用的 Anthropic Key，`cache_read_input_tokens > 0` 这条**仍未验证**——按 d.32 的措辞纪律，只能说「标记已按不变量打好」，不能说「省钱已生效」。真连验收时若 `cache_read` 恒为 0，先查前缀是否够 1024 token（§2.5），再怀疑代码。

## 5. 不做 / 边界

- **跨 @ 提及的前缀冻结**：要做到「整段会话前缀逐字不变」，得把记忆/技能从系统提示词里搬出来、改挂到 user 行或工具结果上（Hermes 的「中途注入只走 user/tool 行」纪律）。那是**提示词结构的一轮改版**，牵动 d.27 的注入可观测性与召回记录口径，本轮不做。本轮收益只在 run 内（最多 4 次请求），估算：无缓存 `4P` vs 有缓存 `1.25P + 3×0.1P ≈ 1.55P`，**省约 60%**（前提：前缀 `P ≥ 1024 token`，见 §2.5）。
- **extended thinking**：开思考要同时满足 `temperature = 1`、块顺序、以及回放 `thinking` block（Hermes 有 `anthropic_thinking_replay.py` 专门管）。和鸣现有 `onReasoning` 走的是兼容网关的 `reasoning` 字段，本轮不引入 thinking block 的生成与回放。
- **OpenAI 侧的 `prompt_tokens_details.cached_tokens`**：不动 OpenAI 分支的请求体与 usage（那是另一轮的账）。
- **并行工具调用、结构化输出、batch API、Bedrock 区域 id 归一**：`buildRequest` 从不发 `parallel_tool_calls`/`response_format`（d.32 已如实标注为「选型参考，不驱动行为」），本轮继续不假装。
- **`stop_reason` 细分**（`max_tokens` 截断 vs `tool_use` vs `end_turn`）：本轮只在 `tool_use` 上收口工具循环；把「被 `max_tokens` 截断」当成失败告诉用户是另一条体验线，不在本轮。
- **Anthropic 上的 MCP 名称映射**：§1.3 已证明和鸣的名字天然合规，不做映射表。

## 6. 参考（移植判据出处）

hermes-agent @ MIT：`agent/anthropic_message_convert.py`（模块头一句话就列了四个坑：`tool_use/tool_result` 配对、`cache_control` 摆放、截图退役、空 text block）、`:100-165`（模型名归一 / `_sanitize_tool_id` / `_normalize_tool_input_schema` / `convert_tools_to_anthropic` 的重名丢弃）、`agent/prompt_caching.py:154-177`（TTL：机器节拍 5m、人类节拍 1h）、`:276-312`（`_completed_transaction_endpoint_indexes`）、`:313-377`（`build_prompt_cache_plan` / `apply_anthropic_cache_control` 的「先剥旧标记 ⇒ 永不累积过 4 个」）。

下一轮候选（同一来源，另开规格）：`apps/desktop/electron/` 的 8 个后端生命周期文件约 740 行可原样移植，解决和鸣 Python 边车与 MCP stdio 子进程的孤儿进程、 reused-PID 误判与固定 20s hello 超时问题。

## 7. 实现回写（落点清单）

- **新增**：`packages/web/src/lib/llmAnthropic.ts`（IR → 协议体，纯函数，只 `import type` `llmClient`，无运行时环）、`packages/web/src/lib/promptCache.ts`（断点规划）。各带同名测试文件。
- **改动**：
  - `llmClient.ts`：`ChatMessage` 多一个 `toolError?: boolean`（只有 role=tool 有意义，OpenAI 分支不读）；`BuildRequestOpts` 多 `promptCache`/`omitTools`；`UsageTotals` 多 `cacheReadTokens`/`cacheWriteTokens`；`StreamChatOpts` 多 `promptCache`；anthropic 分支改走转换器 + `planCache`；`readUsage`/`mergeUsage` 认 cache 两字段；新增 `collectAnthropicBlock`（与 OpenAI 的 `toolCalls` 槽位表共用，`flushToolCalls` 的「恰好一次」口径未动）；非流式分支改读 `readAnthropicContent`；400 降级从「一个布尔参数」改成 `attempts` 数组。删掉私有 `toAnthropicContent`（被转换器取代）。
  - `capabilityNotice.ts`：删掉 `provider === "anthropic"` 一票否决（它同时杀掉了 tools 与 vision）。
  - `agentStream.ts`：三处——工具闸注释改口、`extra` 里的 tool 行带 `toolError`、`onUsage` 把缓存段补回总量。
  - `llmClient.test.ts`：anthropic 的 `buildRequest` 用例按新形状改断言；d.32 那条「Anthropic 400 不重试」按降级链改写成一组用例。
- **未动**（与并行会话的 d.48 避让）：`ChatPage.tsx`、`store/tokenUsage.ts`、`store/llm.ts`、`lib/llmRoute.ts`、`lib/llmHealth.ts`、`lib/llmFailure.ts`。`streamChatRouted` 整包透传 `opts`，所以 `promptCache` 不需要在路由层接线。
- **门禁**：`pnpm --filter @heming/web typecheck` 绿；`vitest run`（web）**158 文件 / 2481 例全绿**（含并行会话本轮新进的用例）。★ 未跑 `pnpm -r build`：它会覆写 `packages/web/dist`，而 dist 是云端发布产物的登记对象。
- **待补**：① §2.5 的用量字段与界面文案（要动 `ChatPage.tsx`）；② `agentStream.test.ts` 的 Anthropic 工具轮端到端 2 例；③ 真连 Anthropic 的 `cache_read > 0` 验收；④ `docs/HANDOFF.md` 第 6 节仍写着「Anthropic 不支持工具调用」这条已知限制，待 d.48 那轮的空档一起改。
