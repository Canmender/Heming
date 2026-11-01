# magpie 多模型路由移植（候选链 / failover / 冷却 / 记账 / 脱敏）

来源：github.com/yetone/magpie（MIT）——**语义移植**，不是代码搬运。
路线：读示例项目的真实实现，能对上就照抄语义，少自我发明。
本文件是移植台账（哪些照搬、哪些改形、哪些刻意不做），不占版本号；
命名不带 d.NN 是因为本工作区有多个会话并行，号位归发布会话定。

## 一、照搬的 magpie 语义

| magpie 概念 | 本仓落点 |
| --- | --- |
| `retryable()` / `failure()` 分类器 | `lib/llmFailure.ts`：`kind` + `rests` + `scope` + `failover` |
| `carriedStatus`（HTTP 码随身） | `llmClient.ts` 抛错时带状态码，供分类器判档 |
| `holdWriter.passing`（字节已出→不换人） | `llmRoute.ts`：`surfaced` 标记，吐过 delta 就绝不做 failover |
| `roomy` / `withRoom`（窗口预筛） | `llmRoute.ts`：按 `modelCaps` 的能力表预筛，查不到＝未知，不猜 |
| 溢出后按 provider+baseUrl+model 排除 | `llmRoute.ts` 同键位排除 |
| `probeOne`（全休息也要问最快回来的） | `llmRoute.ts`：候选链绝不空转、绝不把链问死 |
| `restLast`（休息的排最后但绝不删） | `orderCandidates()`：醒→声明序，休息→回来早晚 |
| `served()` → `clearRest`（答上即清零） | `llmHealth`：命中候选后清本机冷却 |
| rate / credit 阶梯冷却 | `llmHealth`：429 与额度类分别按阶梯给时长 |
| `lastRetries`=2、`longestPause`=8s | `llmRoute.ts`：瞬时失败同一候选再问（1s/2s/4s），总停顿封顶 |
| 路由组只存连接引用 | `store/llm.ts`：`RouteMember.profileId`——Key 永不被复制进链 |
| Privacy masking = `redact` + `redactWords` + `redact.key` | `lib/llmMask.ts`：形状表 + 词表 + 本机 6 位钥匙 |
| Unrest（一键恢复冷却） | `RouteGroupsCard.tsx` 休息名单「立即恢复」 |
| 网关形态 | `llmPresets.ts` 的 `magpie` 预设：`http://127.0.0.1:3425/v1`，模型写 `provider/model` 或 `group/<id>` |

## 二、改形的地方（本仓不是网关，是客户端）

1. **冷却存本机内存 + 本机档**，不存服务端；重启即清零。云端服务器零 LLM 调用这条红线不动。
2. **脱敏按连接开关**（`LlmProfile.mask`），不是全局 Privacy 设置：本仓没有全局隐私面板，
   而「这个端点会不会存我数据」本来就是逐家判断。默认关。
3. **脱敏只换出站副本，不还原回复**。magpie 在出口整段还原；我们是流式客户端，
   占位符可能跨 SSE chunk 断开，半截既还原不了也难看；更关键的是还原＝把原文再寄出去一次，
   与脱敏初衷相反。改为留本机对照表（图例）让人知道隐去了什么。
4. **候选链留痕只进本机流式状态**，渲染在气泡下方一行；绝不拼进 `errorText`——
   那串要经 `sendError`/E2E 上行，会把本机连接名暴露给对方。
5. **记账归属修正**：绑候选链时旧实现把 token 记到链头合成模型上；现在按**真正答话的那个候选**
   记（`servingAttempt()`），维度补到 连接×模型，逐候选本月用量在候选链卡里展示。

## 三、刻意没做的

- 选路策略只实现 `order`（声明序）与 `cheap`（参考价优先）。
  smart / usage / pace / weight / fast 五档没有本机数据来源，先不装样子。
- 参考价只在**服务商报齐 input+output** 时估算，缺侧就不给（少算比按上界估更骗人）；
  价目表查不到的候选在 `cheap` 档排最后，不冒充「免费」。
- 形状认不出的字符串一律不动，宁可漏一个怪 Token。漏的可以补进词表，误伤的语义补不回来。

## 四、门禁

- `tsc -p tsconfig.json --noEmit`：0 错。
- `vitest run`（web 全量）：159 files / 2500 tests。
  **一处红**：`StaffPage.test.tsx > 未开启：空态说明 + 开启后立刻生成首份简报`
  断言 `trigger === "daily"`，而 `StaffPage.tsx:216` 用 `isDailyDue(updated, Date.now())` 真取当前时刻，
  `dailyAt` 默认 07:10 → **凌晨跑必挂**（前一晚 23:04 全绿，凌晨 04:02 复现失败）。
  与本轮无关（d.48 已入库代码里的时间敏感测试），修法是在该用例里冻结时钟，属幕僚会话的地盘，本轮不擅动。
- 新增/改动测试：`llmMask.test.ts` 19、`llmRoute.test.ts` 20、`agentStream.test.ts` 67、
  `store/tokenUsage.test.ts` 17、`AgentStreamBubble.test.tsx` 8、`RouteGroupsCard.test.tsx` 8。

## 五、浏览器实测（真机跑通，含发出去字节的核对）

栈全在本会话独占端口，用完即关、不留进程与库文件：
mock 供应商 `127.0.0.1:8791`（model 含 `flaky` → 429，其余 SSE 带 usage；`GET /__captured` 回吐收到的请求体）
+ 一次性服务端 `PORT=8899 HEMING_DB_PATH=.tmp/verify/serve.db HEMING_SEED_USERS=…`
+ `VITE_API_BASE=http://127.0.0.1:8899 npx vite --port 5188`（都没碰别的会话的 8787 与 5173–5176）。

| 验的东西 | 实况 |
| --- | --- |
| 预设 | 服务商条里出现「magpie 本地网关」 |
| 绑定 UI | 智能体表单「绑定连接」下拉有「候选链 · 顺序链（2 个候选）」，选中后 `bindings[agentId] = route.<id>` |
| failover | 声明序先问 `贵 Key · flaky-v1` → 429 → 换 `便宜 Key · deepseek-chat` 答上；气泡内流式期间出现「候选链 贵 Key · transient」留痕行 |
| 冷却 | 跑完后 `llmHealth` 留 `a:<id>` kind=`rate`、剩 31 秒；设置页显示「休息 1 分钟」「休息中的候选 · 还剩 1 分钟」，点「立即恢复」→ 名单归零 |
| cheap 档 | 同一链改成参考价优先后再发一条：mock 只收到**一次**请求，model=`deepseek-chat`（查不到价目的 `flaky-v1` 确实排到最后，没被问） |
| 出站脱敏 | 带 `mask` 的候选收到的 body 里两处 Key 全成 `〔隐去-2ku6vf-1/2〕`，5.2 KB body 内 `sk-…` 零命中；**没开 mask 的那个候选收到原文**（按连接开关，符合设计）；连上下文预算装进来的长期记忆/会话焦点也一起被脱敏 |
| 占位符稳定 | 同一条 Key 跨两条消息同一个号；对照表 2 条留在本机 |
| 记账 | `tokenUsage` 落 1 条：`profileId/profileLabel = 便宜 Key`、`model = deepseek-chat`、`tokens 17`、`input 12 / output 5`；设置页「本月逐候选用量」显示 `17 tokens ≈ ¥0.0001` + 参考价免责 |
| 控制台 | 只有预期的 429（那是触发 failover 的）、我探针猜错的 `/api/contacts` 404，以及导航期 WS 重连告警 |

两点实况记录（不是 bug，是设计后果）：
1. 留痕只在**流式期间**可见，答完收成正式消息后不留——消息体要走 E2E 与归档，
   本机的连接名不该进别人的会话记录；持久化的可查部分是「本月逐候选用量」与休息名单。
2. 组件单独挂进临时 root 会抛 `Invalid hook call`，那是探针引到第二份 vite 预打包 React 的坑，
   与应用内渲染无关。


