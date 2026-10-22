# 和鸣 · 深度调研与后续完善计划（2026-10-22）

> 基线：`d.29.1.8.0`（云端与 `/updates` 两处均已发布，证据见 `docs/HANDOFF.md` §2）。
> 用途：给「接下来几个月往哪儿补」定优先级与验收口径，不是本轮的交付说明。

## 0. 这份结论怎么来的

四路并行代码勘察（记忆与知识 / 协作与 IM / 能力扩展与安全 / 桌面壳与发布链），**每条结论本轮都回到代码里复核过**，并在正文标了等级：

- **已核实** = 有 `file:line` 与判据，本轮亲自读过源码确认；
- **线索** = 调研代理给出、逻辑成立但本轮没逐字验证，落地前要重新取证。

复核同时**证伪/修正了几条**，列在 §9。文档里的行号会随改动漂移，执行时先 `grep` 符号名再定位。

## 1. 一句话结论

结构性风险大于功能缺口，而且三类风险彼此独立、不能靠「继续加功能」顺带解决：

1. **安全红线的实现完整度低于文档表述**。四条红线（不新增全放行、个人数据不出设备、E2E 不降级、闸门故障即拒绝）里，前三条在代码里有**可绕开的口子或明文落盘面**；红线本身没被文档骗人，但 UI 与传输细节让红线打了折扣。
2. **本机存储是一个 5MB 单源预算，而键位设计的最坏情况已经超它一个量级**。多个 `*BYTE_LIMIT` 各自为政、互不知情，溢出后是静默回退还是丢数据取决于各处 `writeJson` 的兜底，界面上**没有任何水位可见性**。
3. **「有账无埋点」比「没账」更危险**。首页 Token 热力图、配额、沉淀节奏这些数据面板已经在界面上被当事实展示，但写入端是空的或半空的——用户看到的是自己脑补的确定性。

## 2. P0：安全与红线（先做，且做完就能收口一批 §6 技术债）

| 编号 | 现象 | 证据（已核实） | 影响 | 修法 | 验收 |
|---|---|---|---|---|---|
| P0-1 | HITL「免问下限」可以把下限选到 `danger`，等于**全部不问** | `HitlPolicyCard.tsx:84` 第三个 `<option value="danger">危险（全部不问）</option>`；判定式 `hitl/policy.ts:201` 是 `RISK_ORDER[call.risk] <= RISK_ORDER[policy.floor]`，`floor=danger` 时**所有档位恒真** | 与红线「绝不新增 HITL 全部放行档」正面冲突，而且是**设置页里一个下拉框的距离**；一旦用户误选，`self_write`、删除类操作全部静默执行 | 下拉只留 `read`/`write`；`policy.ts` 解析时把 `danger` 夹回 `write`（**读侧也拦**，不只改 UI，否则旧 localStorage 里的 `danger` 仍生效）；文案改成「风险不高于 X 的操作不问」，去掉「全部不问」字样 | 用例：存 `floor:"danger"` → 解析后不是 `danger`；danger 级调用在任何策略下都进确认队列；UI 无该选项（testing-library 断言 option 数量） |
| P0-2 | `/api/ice-servers` **无鉴权** | `app.ts:455` `app.get("/api/ice-servers", (_req, res) => …)`，全仓唯一一条 `ice-servers` 路由，没有 `authOnly` | 一旦按 `docs/deploy.md` §4 配了 `HEMING_TURN_*`，TURN 凭据对**任何未登录者可读**，等于把中继带宽白送（可被拿来做流量放大/匿名转发） | 加 `authOnly`；顺带在 `deploy` 文档里把「配 TURN 前先补鉴权」写成前置条件 | server 用例：未带 token → 401；带 token → 200 且结构不变 |
| P0-3 | WS 鉴权 token 走 **query string** | `web/src/lib/ws.ts:46` `new WebSocket(\`${resolveWsUrl()}/api/ws?token=${token}\`)` | token 会进 nginx `access_log`、云厂商日志与任何中间代理日志；结合 P0-4（HTTP 明文）等于会话凭据长期躺在明文日志里 | 改成连上后**首帧鉴权**（`{type:"auth",token}`，超时未鉴权即由服务端断开）；短期兜底：`deploy/nginx-heming.conf` 对 `= /api/ws` 关掉 `access_log` 并把 `$arg_token` 从 log_format 里剔除 | ws 用例：未鉴权帧不返回业务事件、超时断开；线上 `grep token= /var/log/nginx/access.log` 命中 0 |
| P0-4 | 桌面端**零崩溃兜底** | `packages/desktop/main.js` 内 `uncaughtException` / `unhandledRejection` / `render-process-gone` / `crashReporter` **grep 全部 0 命中** | 主进程抛未捕获异常直接静默退出，用户表现为「应用莫名其妙没了」，且无任何本机日志可查；渲染进程白屏也不会自恢复 | 主进程 `process.on("uncaughtException"/"unhandledRejection")` → **只写本机日志**（`~/Heming/logs/crash-*.log`，带版本与 UTC 时间），不弹窗打断、不上报；`webContents.on("render-process-gone")` → 一次自动 reload + 落日志 | `desktop` 的 `node --test`：注入抛错桩，断言日志文件生成、内容含版本号、**没有任何网络发送** |
| P0-5 | 密钥与凭据**全部明文 localStorage** | `safeStorage` 在 `packages/desktop/**` **0 命中**；`heming.llmConfigs`（含供应商 apiKey）、`heming.mcp.servers.v1`（含请求头 token）、`heming.e2e.*`（含导出的 JWK 私钥）都直写 localStorage；另有 `main.js:202` 的 `unsafely-treat-insecure-origin-as-secure` 放宽 | 「个人数据不出设备」仍然成立（没出设备），但**设备上的静态保护为零**：同机任意进程/备份/误提交的 `.git` 拖走就能拿走全部密钥与 E2E 私钥 | 桌面端把三类敏感键走 Electron `safeStorage`（Windows DPAPI）：新增 IPC `secret:read/secret:write`，**首次启动做一次性迁移**（明文 → 加密 → 删明文键，迁移失败则保持原样并提示，绝不静默丢）；浏览器端保持明文但在设置页写明「浏览器端不落安全存储」 | desktop 用例：mock `safeStorage.available` 两态；迁移幂等（跑两次不重复加密、不丢数据）；web 端不受影响（现有用例全绿） |
| P0-6 | 无 CSP（三处皆缺） | `Content-Security-Policy` / `onHeadersReceived` 在 web/server/desktop **0 命中** | 一旦某处接入第三方脚本或 markdown 渲染出现逃逸，没有任何纵深 | 先只在**桌面壳**加（`session.defaultSession.webRequest.onHeadersReceived`），基线 `default-src 'self' app:; connect-src 'self' http://47.92.39.184 ws://…; img-src 'self' app: data: blob:; style-src 'self' 'unsafe-inline'`；**`'unsafe-inline'` 对 style 先留着**（KaTeX 与内联样式是既成事实），script 不给 | 手工跑一次桌面端全流程（聊天/知识库/图表/通话）确认没有资源被挡；灰度开关：出问题用 `HEMING_CSP_OFF=1` 关掉并落日志 |

> P0-1、P0-2、P0-3、P0-4 都是**小改动**（各一文件为主），合起来就是一轮；P0-5、P0-6 各自需要设计规格与迁移方案，单独立轮。

## 3. P1：数据一致性与「空账」

| 编号 | 现象 | 证据 | 影响 | 修法 | 验收 |
|---|---|---|---|---|---|
| P1-1 | 本机存储最坏情况**远超 5MB 单源配额**，且各键互不知情 | `memory/storage.ts:17` `KEY_SIZE_LIMIT = 1.2MB`，作用在 4 个键上（同文件 `:10-13`：working/episodic/semantic/settings）= 4.8MB；再加 `tasks/store.ts:39` 1.1MB、`recallLog.ts:24` 256KB、`usage.ts:39` 64KB、`notifications.ts:29` 64KB、`e2eSession.ts:890` 的**每会话 500 条明文缓存**（`heming.msgCache.<convId>`，会话数不设上限） | 浏览器/Chromium 同源约 5MB。超配额时 `setItem` 抛 `QuotaExceededError`，各处兜底是「回退空表 / 静默不落」，表现为**记忆权重无故退回 ×1、任务记录消失**这类无法解释的降级；用户完全看不见 | 三步：①**水位可见**——设置页加「本机存储用量」条（按键统计字节 + 总量），超 80% 变黄；②**统一淘汰优先级**——`msgCache` 加全局会话数上限（LRU 淘汰最久未打开的会话缓存），记忆/任务/日志按「可再生 > 不可再生」排序；③**把最大块搬走**——桌面端改走文件（`wiki-fs.js` 已有先例）或 IndexedDB，浏览器端保留 localStorage | 用例：模拟配额打满（注入抛错的 storage stub）→ 断言**只丢最旧的可再生数据**、水位条变黄、无未捕获异常；新用例覆盖 `msgCache` LRU |
| P1-2 | Token 用量**有账无埋点** | `store/tokenUsage.ts:112` 定义 `record(model, tokens, at)`，全仓非测试调用点 **0**（`grep` 只有 `HomePage.test.tsx`/`tokenUsage.test.ts` 在写）；`HomePage.tsx:111` 与 `TokenHeatmap.tsx:9` 只读展示 | 首页热力图/配额显示的是**空数据或测试残留**，而界面把它当事实呈现——这是「假确定性」里最容易被用户信以为真的一类 | 从供应商响应回填：OpenAI 兼容与 Anthropic 的流式尾包都带 `usage`，在 `agentStream` 收口处（已有 `runRecorder` 的落点）调一次 `record`；**拿不到 usage 的供应商不落 0**，而是标「未上报」并在界面区分「0」与「未知」 | 用例：喂一段带 usage 的假流 → records 增加且模型名正确；不带 usage → 不写记录、界面显式标未知；真实跑一轮对话后首页热力图出现今天的格子 |
| P1-3 | 编辑记忆**无条件刷新 `updatedAt`**，连带重置时效与抗淘汰判定 | `memory/store.ts:583` `updatedAt: new Date(this.now()).toISOString()`（patch 只含 key/value/pinned/confidence 时也照刷）；而打分与重排都读 `updatedAt`（`:537`、`:704`），冷清单与权重也按它判「长期未被引用」 | 用户改一个错别字 → 这条记忆在系统眼里「刚刚更新过」，recency 满血、冷门判定失效；**给人看的「时效」和机器用的「时效」被同一个字段绑死** | 拆两个字段：`updatedAt`（内容变更）与 `metaUpdatedAt`（pin/置信度等元数据）；recency/冷清单只吃 `updatedAt`；旧数据缺字段时以 `updatedAt` 兜底（不迁移、不报错） | 用例：只改 `pinned` → `updatedAt` 不变、`recencyScore` 不变；改 `value` → 两者都变；缺字段回退路径 |
| P1-4 | 沉淀节奏计数**只在内存** | `memory/store.ts:254` 注释自陈「会话 → 距上次沉淀已累计的成功轮次（仅本实例内存态，不落盘）」，`pending = new Map()` | 刷新页面/重启客户端后计数归零 → **长会话永远沉淀不出来**（每 N 轮才沉淀一次，N 从未攒满）；用户表现为「聊了很久记忆区没东西」 | 把 `pending` 落一个小键（会话→整数，几十字节；带 `updatedAt`，会话删除时清）；读侧容错：坏 JSON 回退空表 | 用例：模拟实例重建（新 `MemoryStore`）后计数仍在、能按阈值触发沉淀 |
| P1-5 | Wiki 检索对中文退化成**整串子串匹配** | `wiki/tools.ts:93-100`：`query.trim().toLowerCase()` 后对 title/tags/body 做 `includes`，**没有任何分词** | 中文多词查询（「项目 预算 风险」）几乎必然 0 命中；用户会以为知识库是空的 | 查询侧按 CJK 二元组（bigram）切 + 空白/标点分词，标题命中权重高于正文；**只做读侧，不改文档结构、不动 `wiki/index.ts`（含字面 NUL 的禁改文件）** | 用例：给定固定 wiki 集，中文分词查询前后命中数对照（断命中数上升且不引入非中文查询的回归） |
| P1-6 | 任务记录**60 条静默淘汰，不看状态** | `tasks/store.ts:348` `sort((a,b)=>b.createdAt-a.createdAt).slice(0, MAX_TASKS)`（`MAX_TASKS=60`，`:25`），排序键是创建时间、不区分 `running` | 一个跑了很久的任务（创建最早）会被新任务挤掉，随后 `onRunSettled` 无处可写 → **任务悄悄消失且报告缺失**；这与 d.24「不静默丢，也不误标成功」的口径矛盾 | 淘汰只从**已结束**任务里按最旧摘；若已结束任务不足以腾出空间，则对将被淘汰的**进行中**任务先发一条通知（复用 `notifications`）再摘；字节裁剪路径（截 result/prompt）保持原样 | 用例：61 条含 1 条 `running`（创建最早）→ `running` 仍在、报告可写；全是 `running` 且必须淘汰 → 有通知记录 |
| P1-7 | 记忆导出**不含召回日志与用量账本**，且只能复制到剪贴板 | d.27/d.28 的刻意设计（`HANDOFF.md` §6 已写明「不参与记忆导出」），导出落点是 `lib/export/`，输出走 Blob/剪贴板、无文件 | 换设备或重装后，**记忆条目搬走了但权重与判定依据丢了**，新设备上召回排序无故变差且无法解释；「备份个人数据」这件事目前没有可用路径 | 给导出加一个**可选附块**（默认关）：`usage`/`recallLog` 作为独立 JSON 段，标注「可再生数据」；桌面端导出写 `~/Heming/exports/`（复用 `wiki-fs.js`/`chart-fs.js` 的文件桥）；**绝不新增上云路径** | 用例：勾选附块 → 导出含段且带 `version`；不勾 → 与今天逐字节一致；文件写入只在桌面端发生（web 用例断言走 Blob） |
| P1-8 | WS 离线发送队列**无上限**，且无 token 时**不再安排重连** | `lib/ws.ts:40` `const queue: string[] = []`，`:74` 未就绪就 `queue.push(frame)`，没有任何 cap；`:44-46` `if (!token) return;` 直接返回且**不 `setTimeout` 重试**（只有 `onclose` 分支会重排） | 长断网/大消息（带附件的帧会 `JSON.stringify` 整段 base64）→ 队列无界增长，内存吃紧且重连瞬间一次性冲刷；更糟的是 token 被清（401 处理）而组件仍挂载时，链路进入「只进不出」的死状态，**用户以为在发、其实永远没发** | 队列设上限（如 100 帧或 4MB 字节护栏），溢出按「丢弃并显式提示发送失败」处理——**不静默**；无 token 时改为按退避重试或明确 `close()` 并回调 `onClose`，让上层知道链路死了 | 用例：连续 send 未就绪 101 帧 → 第 101 帧被拒且有回调；token 缺失 → 不会永远挂着（断言重试或关闭回调）；队列在 `onopen` 冲刷的顺序不变 |

## 4. P2：体感缺口（用户当天就会撞到）

| 编号 | 现象 | 证据 | 修法 | 验收 |
|---|---|---|---|---|
| P2-1 | **草稿不持久 + 跨会话串字** | `ChatPage.tsx:479` `const [draft] = useState("")`（组件态、不落盘）；`App.tsx:283` 的注释「ChatPage 常驻底层（保持 WS/草稿状态）」说明**切会话时组件不卸载** ⇒ 草稿不会重置（`:2045` 一带的 effect 只管 `taskDraft`，没有 `setDraft("")`），上一个会话写一半的字直接带进下一个会话；同时刷新即全丢 | 草稿改**按会话存**（`heming.draft.<convId>`，LRU 上限 20 个会话、截尾 2000 字），读时按当前 `convId` 取——**不能靠卸载重置**（常驻是刻意的，为了保 WS 与流式状态）；发送成功即清该会话的草稿 | 用例：A 写→切 B→B 是空且 A 回来还在；刷新后仍在；发送后清空 |
| P2-2 | 长会话**全量渲染**，无窗口化 | `ChatPage.tsx:2694` `visibleMessages.map(…)`；`packages/web/package.json` 里 `virtual`/`react-window`/`tanstack` **0 命中**；`loadMessages(…).slice(-30)`（`:1208`）只在个别路径截尾 | 上虚拟列表（或先做「只渲染最近 N 条 + 上滑加载」的轻量窗口）；与 P1-1 的 `msgCache` 上限**一起做**，否则渲染省了、存储还是涨 | 造 800 条消息的会话，测首屏挂载耗时前后对照（vitest 计时断言上限），滚动加载路径有测试 |
| P2-3 | **群通话实际是星型，文档写的是 Mesh** | `voiceCall.ts:316` 主叫给每个 `peerId` 建 PC；`:390`/`:477` 被叫只建 `peerIds: [invite.initiatorId]` 一路 → 3 人以上时**所有人都只连主叫**，主叫带宽 = N 路上行 + N 路下行；而 `:8` 的文件注释与 `HANDOFF.md` §11 都写「Mesh 点对点」 | 二选一并写进规格：①**承认星型**（改注释与文档，并加「主叫离开=整通结束」的显式提示）；②**补真 Mesh**（新成员进来了，老成员互相也建 PC，信令加 `voice_call_join` 广播） | 无论选哪个，先补一个**拓扑断言**用例（3 人入会后的 PC 数：星型=N-1、Mesh=N(N-1)/2），让文档与实现再也骗不了人 |
| P2-4 | HITL 待确认**不产生通知**，且切会话=替用户拒绝 | `HANDOFF.md` §6 通知中心条目自认「HITL 待确认不产生通知」；d.23 口径「切会话按拒绝收口」 | 待确认进通知中心（`kind:"approval"`，不自动消失、点开跳回来源会话）；切会话**不再自动拒绝**，改为「待确认仍在、以通知形式挂住」，超时才按拒绝（超时值写进规格，与 60 分钟队列口径对齐） | 用例：确认框在飞时切会话 → 通知里有 1 条 approval、回来后队列仍在；超时 → 记 denied 且原因是 timeout |
| P2-5 | 在线状态**硬编码** | `RadarContacts.tsx:584` `<small>在线</small>`（常量，非数据） | 服务端已有 WS 连接视图 → 加 `presence`（在线/离线/最后活跃），客户端按事件更新；离线不等于禁止 @，只是视觉降级 | 用例：mock presence 两态渲染；server 侧 presence 接口有测试 |
| P2-6 | 好友**只能申请与接受**，群成员**只能查** | `app.ts:146-168` 只有 `GET /friends`、`GET /friends/requests`、`POST /friends/request`、`POST /friends/:id/accept`；`app.ts:237` 只有 `GET /conversations/:id/members`（`:379`/`:399` 是智能体增删，不是人） | 补 `POST /friends/:id/decline`、`DELETE /friends/:id`（含会话可见性口径：删好友后历史消息还在不在，规格要先定）、群 `POST/DELETE /conversations/:id/members` + 群主权限；**这批要连 E2E 群密钥一起设计**（新人能否解历史、踢人后如何重协商棘轮） | server 契约测试 + 双 Store 实现（`store.ts`/`sqliteStore.ts`）都要跑 |
| P2-7 | 「@我」无角标（未读有） | `ChatConvStrip.tsx:35-56` 只按 `conv.unreadCount` 渲染数字角标；`store/chat.ts:80/91` 的 `mentions` 仅作 payload 透传，**没有任何 mention 计数或过滤** | 会话未读里拆出 `mentionUnread`，标签页与头像列显示 `@3` 样式 | 用例：群内 @ 我 3 条 → 未读数与 mention 数分别正确 |

## 5. P3：功能缺口（竞品对照里价值/成本比高的）

| 编号 | 缺什么 | 现状证据 | 建议做法（保守版） |
|---|---|---|---|
| P3-1 | **多模型同题对比** | `grep 对比/compareModels` 只有 `MarkdownMessage.tsx:15` 的一句注释 | 价值最高、改动集中：一条消息扇出到 2–4 个接口，并排渲染 + 「按回答选一个继续」；Key 仍直连供应商，**不经云端**（红线）；HITL 不变 |
| P3-2 | **定时任务/计划触发** | web 侧无任何 schedule/cron 实现（`grep -i 定时\|cron` 只命中动画与录音计时） | 只在桌面端做（本机定时器，进程在才生效，**不做云端调度**）：任务区加「每天/每周/间隔」触发，触发时新建任务记录；错过不补跑、显式提示 |
| P3-3 | **子智能体协作 / 技能市场** | 技能池只有内置 + 本地分配（`lib/skills/`）；无市场与评分 | 先把「渐进披露」做掉（技能描述分层：一行摘要 → 详情 → 全文），市场接入要另立许可证调研，**不做代发** |
| P3-4 | **harness 桥接**（本机 CLI 作为工具） | 未实现；本地运行时探测与 `spawn(shell:false)` 链已在 `local-runtime.js`/`mcp-stdio.js` | 复用现有 stdio 桥 + 三层危险命令围栏 + HITL；`shell:true` 依然是硬禁止 |
| P3-5 | **模型能力矩阵补全** | `supportsKind` 只覆盖工具/图片两维 | 补「思考/长上下文/函数并行/结构化输出」四维，来源写成**本地静态表 + 用户可覆写**，不做在线探测（省 token、免误判）；判定与丢弃同源（d.25 口径） |
| P3-6 | **公式输入侧预览 / 本地包一键检查修复** | LaTeX 渲染已落（remark-math + KaTeX 本地），输入侧无预览；本地包探测已落，缺「补全目录清单 + 自检」 | 输入框下方按需显示 KaTeX 预览（只在检测到 `$…$` 时）；接口区加「运行环境自检」按钮，逐项列 Node/uv/npx 路径与版本，可复制诊断文本（**不自动上传**） |

## 6. P4：工程与发布链

| 编号 | 问题 | 证据 | 修法 |
|---|---|---|---|
| P4-1 | **发布是两处、全靠手工编排**，本轮就差点发出旧包 | r31 作废事件（`docs/deploy.md` §9 坑 #4）；`deploy-bare.py` 与 `publish-update.sh` 之间没有任何「产物==提交代码」闸 | 写 `scripts/release.sh`：脏工作区拒绝 → `pnpm -r build && test` → 云端 tar（构建后**立刻**打）→ 部署+健康检查+**线上 bundle md5 与本机比对** → `pnpm --filter @heming/desktop dist` → 核对内嵌 bundle 名与版本串 → 备份拷回本机 → 发布 `/updates` → 远端 Range 校验 → 回写证据。任何一步失败即停，不允许「先传了再说」 |
| P4-2 | `docker/` 与 `docker-compose.yml` 已停用未清理，两处 nginx 配置互为出处 | `HANDOFF.md` §5 #6、`docs/deploy.md` §11 | 删除 `docker/`（历史在 git 里，不需要留尸体），nginx 配置**只留 `deploy/nginx-heming.conf` 一份**，文档指向它 |
| P4-3 | `kb.ts` 是遗留死码但仍进产物 | `memory/kb.ts:128` 导出 `knowledgeBase`，全仓除 `memory/index.ts:17` 的 `export *` 外**无调用点** | 删文件 + 删 re-export；删前再 grep 一次符号名（`KnowledgeSource`/`KnowledgeEntry`）确认无引用 |
| P4-4 | 每轮全量 `JSON.stringify` 做字节护栏 | `tasks/store.ts:349` 一带、`usage.ts`/`notifications.ts` 同类路径 | 先测量（大记忆集下 stringify 耗时），确实进热路径再改增量估算；**不预先优化** |
| P4-5 | EBUSY 根因未查，靠「换目录」绕过 | `HANDOFF.md` §5 #5 | 低优先：查一次 `handle.exe`/PowerShell `Get-Process` 句柄占用，查到就把惯例改回固定目录；查不到就在 release.sh 里固化「每次新目录 + 保留最近 2 个」 |
| P4-6 | 更新源仍是 HTTP，`unsafely-treat-insecure-origin-as-secure` 常驻 | `deploy.md` §9 取舍说明、`main.js:202` | 需要用户决策（域名 + HTTPS 的运维成本 vs. 首次包可被篡改的风险）。若做：清单加签名校验（sha512 只防损坏不防篡改，签名才防）、`/api/ws` 上 wss、CSP 同步收紧 |

## 7. 分轮落地（建议节奏，每轮都是一次完整门禁 + 两处发布）

版本规则照旧：`node scripts/bump-version.mjs auto <fix|feature|breaking|build>`，**数字只增不归零**。以下编号按「特性位 +1」排（含新能力）；纯修复轮走修订位。

| 轮次 | 范围 | bump | 验收证据（写进 HANDOFF §2 的形态） |
|---|---|---|---|
| **d.30.1.8.0** | P0-1 + P0-2 + P0-3 + P0-4（红线口子与安全兜底，四处小改）+ P1-3 + P1-4（记忆两处一致性）+ P1-8（同 `ws.ts` 文件，顺手带上队列上限与无 token 死链） | `feature` | HITL：`floor:"danger"` 读侧被夹回、danger 恒进队列的用例；server：ice-servers 401 用例；ws：首帧鉴权 + 队列 cap + 无 token 不挂死 + 线上 nginx 日志 `grep token=` 命中 0；desktop：崩溃兜底写本机日志（断言无网络）；记忆：`pinned` 不刷新 `updatedAt`、重建成活计数 |
| **d.31.1.8.0** | P1-1 本机存储水位（①可见 + ②统一淘汰 + msgCache LRU）+ P2-1 草稿按会话持久 | `feature` | 配额打满的注入测试（只丢可再生数据）；设置页字节水位条；草稿三态用例（切换/刷新/发送） |
| **d.32.1.8.0** | P1-2 token 用量埋点 + P3-5 能力矩阵四维 | `feature` | 真跑一轮对话后首页热力图出现当日格；usage 缺失时界面显式标「未上报」；能力表覆写路径有测试 |
| **d.33.1.8.0** | P2-2 消息列表窗口化（与 P1-1 的存储上限合流复测） | `feature` | 800 条会话首屏计时前后对照；滚动加载用例 |
| **d.34.1.8.0** | P2-4 HITL 待确认进通知 + 不再「切会话=拒绝」（含 timeout 口径） | `feature` | 通知条目、回跳、超时 denied 三段用例；HITL 四红线复核（deny 优先、danger 不记允许）不回退 |
| **d.35.1.8.0** | P1-5 wiki 中文分词 + P1-6 任务淘汰护进行中 + P1-7 导出附块与文件落盘 | `feature` | 命中数对照用例；running 不丢；导出不勾附块时与今天逐字节一致 |
| **d.36 起（需先写规格）** | P0-5 `safeStorage`（迁移方案）、P0-6 CSP、P4-1 `release.sh`、P4-2 docker 清理 | 各轮独立 | 迁移幂等用例、全流程手测记录、发布脚本的一次完整跑通日志 |
| **P2-6 / P2-7** | 好友与群成员管理：涉及 **E2E 群密钥重协商**，必须先出安全规格再动接口 | 规格轮 | 规格文档 + 契约测试；没有规格不动代码 |
| **P3-1 多模型对比** | 用户价值最高，但会牵动 HITL/用量/并发；排在 P0/P1 之后 | `feature` | 并排渲染 + 选一个继续的端到端用例；Key 直连供应商、零上云断言 |

排期原则：**红线口子（P0）与静默数据降级（P1）优先于新功能**；每轮结束都要 `pnpm -r build && pnpm -r --workspace-concurrency=1 test` 全绿 + 两处发布 + 证据回写，不接受「代码合了但没发布」。

## 8. 明确不做 / 需要用户拍板

- **不做**：HITL「全部放行」档（连下拉框里的 `danger` 也要拿掉，见 P0-1）；Registry 安装静默化；MCP `annotations` 参与判定；`packageArguments`/`environmentVariables` 恢复；stdio `shell:true`；云端存个人明文；AGPL/GPL 代码复制。
- **要用户定**：①更新源要不要上 HTTPS + 签名（P4-6，运维成本换篡改防护）；②删好友后历史消息与 E2E 群密钥如何处理（P2-6，涉及可解密性）；③定时任务是否只做桌面端（P3-2，本计划默认是）；④虚拟列表选窗口化还是引依赖（P2-2，倾向不引第三方依赖）。
- **验证类（不是实现类）**：NVDA/VoiceOver 实测、TURN/弱网真机通话、观感真机过目——需要额外机器。

## 9. 复核台账（证伪与修正）

| 调研结论 | 复核结果 |
|---|---|
| 「HITL 有实质全放行口子」 | **成立**，且比报告说得更直接：`policy.ts:201` 的 `<=` 让 `floor=danger` 恒真（见 P0-1） |
| 「群通话是星型不是 Mesh」 | **成立**：主叫扇出（`:316`）、被叫单路（`:390`/`:477`）；文件注释与 HANDOFF §11 的「Mesh」措辞需一并修正 |
| 「记忆编辑重置时效」 | **成立**：`store.ts:583` 无条件刷新；但「抗淘汰」是间接影响（经 `updatedAt` 参与打分），措辞按 P1-3 收紧 |
| 「沉淀计数只在内存」 | **成立**：`store.ts:254` 注释即自陈 |
| 「`kb.ts` 是死码」 | **成立**：除 `memory/index.ts:17` 的 `export *` 外无调用点；注意别把它和 `lib/wiki/` 混为一谈 |
| 「任务 60 条静默淘汰含进行中」 | **成立**：`slice(0, MAX_TASKS)` 前只按 `createdAt` 排序 |
| 「`tokenUsage` 有账无埋点」 | **成立**：生产代码 0 调用点，只有测试在写 |
| 「localStorage 1.2MB×4 近 5MB 配额」 | **修正**：不止 4 个键——记忆 4 键 ×1.2MB + 任务 1.1MB + 召回日志 256KB + 用量 64KB + 通知 64KB + **无总量闸的每会话 msgCache**，最坏情况是「超配额一个量级」而不是「接近」 |
| 「@我无角标」 | **成立**（本轮补证）：`ChatConvStrip.tsx:35-56` 只有 `unreadCount` 角标，`mentions` 在 `store/chat.ts:80/91` 只做 payload 透传，无 mention 计数路径 |
| 「WS 离线队列无上限」 | **成立且更严重**：`ws.ts:40/74` 队列无 cap；另外 `ws.ts:44-46` 在 `getToken()` 为空时直接 `return` 且**不安排重试**（只有 `onclose` 会重排），此时链路进入「只进不出」的死状态 → 合并进 P1-8 |
| 「好友无拒绝/删除」「群成员管理零接口」 | **成立**：路由枚举见 P2-6 |
| 「在线状态硬编码」 | **成立**：`RadarContacts.tsx:584` 是常量 `<small>在线</small>` |
| 「无 CSP」「`safeStorage` 零使用」「主进程无崩溃兜底」 | **成立**：三项 grep 均 0 命中 |
| 「长会话无虚拟列表」 | **成立**（依赖表 0 命中 + `ChatPage.tsx:2694` 全量 map）；但「卡顿到什么程度」未测量，别把 P2-2 写成性能结论 |
