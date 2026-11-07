# d.94 清掉最后一层 provider 死代码：Anthropic 协议、价格档、插件残留字段

- 日期：2026-11-07
- 版本：`d.94.2.42.0`（特性 +1）
- 承接 d.90（模型层只连 magpie 网关）、d.92（内置托管）。本轮把「协议 / 价格 / 插件模型预设」
  三处只存在于代码里的旧世界残留一并删除，让「模型提供商」这个抽象彻底消失。

## 1. 删除 Anthropic 协议实现

- 删除 `lib/llmAnthropic.ts`（333 行：OpenAI IR ↔ Anthropic content blocks）与
  `lib/promptCache.ts`（前缀缓存标记，只服务 Anthropic）及两者测试；
- `llmClient.ts` 重写为 **OpenAI 兼容单协议**：去掉 `provider === "anthropic"` 分支、
  `x-api-key`/`anthropic-version` 请求头、`cache_control`/前缀缓存、`cache_read_input_tokens`/
  `cache_creation_input_tokens` 口径、Anthropic 的 `content_block_*` 流式解析与
  `thinking_delta`；`UsageTotals` 只保留 `inputTokens/outputTokens/totalTokens`；
- 400 降级链从「按协议分档」缩成一条：关 `stream_options` 重试一次；
- `ChatMessage.toolError` 删除（只服务 `is_error` 映射）；`maxTokens`/`promptCache`/`omitTools`
  选项删除，调用点（ChatPage 摘要、桌宠、幕僚简报、路由层 roomy）同步清理；
- `capabilityNotice` / `agentStream` 里指向已删文件的注释改写（不再提 Anthropic 一票否决）。

为什么可以删：d.90 起所有请求只发往 magpie 网关，网关对上游做协议翻译；
和鸣再保留一套 Anthropic 实现 = 两套口径、两份测试、一条永远不会走到的分支。

## 2. 删除价格与 `cheap` 档

- 网关 `/v1/models` 不提供价格，`modelCaps` 的 `pricing` 字段与全部价目表删除，
  `PRICING_DISCLAIMER` 删除；
- `cheap`（参考价优先）策略从 `RouteStrategy`、路由排序、候选链 UI、模型路由说明中删除；
- `smart` 档公式改为 `0.65 × 本月用量占比 + 0.35 × 近期失败占比`（原 0.5/0.3/0.2 去掉价格后
  重新归一，保持两项相对优先级），注释写明「网关不提供价格」；
- 候选链的「本月逐候选用量」仍列 token；金额与「暂无可估的费用数据」不再出现。

## 3. 插件目录 DTO 收尾

- `contributions.llmPresets` 从 shared 目录条目 schema、服务端计数、Web viewModel/store
  计数中删除（d.90 已删清单声明能力与设置层消费方，本轮把协议层字段也清掉）。

## 4. 验证

- `llmClient.test.ts` 重写为 15 例 OpenAI-only（URL/头/body、Key 红线、多模态、流式/非流式、
  工具拼装、用量、400 降级、200 携带错误、Abort）；
- 路由/候选链/模型路由/设置/插件目录相关用例同步更新；`pnpm --filter @heming/web typecheck` 零错；
- 受影响用例集（插件 25 文件、模型层 173 例、价格/路由/UI）全部通过；全量门禁见 CHANGELOG。

## 5. 边界

- magpie 网关侧仍支持 Anthropic/Gemini 等协议翻译与它自己的价格/额度信息，那些属于 magpie，
  和鸣不再复制；用户在 magpie 里看价格与额度。
- 插件系统仍不执行代码；本轮只删字段，不改插件安装/信任链路。
