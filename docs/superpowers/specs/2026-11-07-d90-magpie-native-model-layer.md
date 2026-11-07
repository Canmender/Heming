# d.90 magpie 内化为原生模型层：删掉「模型提供商」

- 日期：2026-11-07
- 版本：`d.90.2.42.0`（特性 +1）
- 分支：`feat/d77-heming-core`
- 产品决定：**模型能力统一由本机 magpie 网关提供**。和鸣不再让用户配置「服务商 / 协议 / Base URL / API Key」，
  那些账号（Claude Code、Codex、各家 API Key、订阅）由 magpie 统一管理，用户已有的 Agent 登录即可供 token。

## 0. 一句话

```
旧：设置 → 模型 → 选服务商 → 填 BaseURL + Key → 连接（每条连接一套 Key）
新：设置 → 模型 → 填 magpie 网关地址 + 网关 Key → 读取模型（目录来自 /v1/models）
    智能体绑定 = 选模型；候选链 = 多个模型之间的 failover
```

## 1. 删掉了什么

- **服务商预设**（DeepSeek / Moonshot / 智谱 / 通义 / SiliconFlow / Ollama / Anthropic / magpie 八个按钮）；
- **协议选择**（openai / anthropic）与手填 Base URL、模型名、API Key 的表单；
- **逐连接的 Key 管理**：`heming.llmConfigs` 与它指向的系统安全存储条目；
- **旧绑定与候选链**：它们引用的是「连接」，语义已不存在；**按产品决定直接清除**（一次性迁移，见 §3）；
- **插件清单的模型预设能力**（d.88 引入的 `contributions.llmPresets`）：模型不再由插件声明；
  清单 v4 也随之收回，只接受 v1/v2/v3（v3 里写 `llmPresets` 会被忽略）。`plugins/magpie-gateway` 包删除。

## 2. 新模型层

| 层 | 实现 |
| --- | --- |
| 网关配置 | `store/llm.ts` 的 `gateway { baseUrl, key }`，存 `heming.magpie.v1`；默认 `http://127.0.0.1:3425/v1` + `magpie-heming` |
| 目录 | `lib/magpieClient.ts`：`GET /v1/models`（OpenAI 形状 + magpie 扩展字段：display_name / context_window / max_output_tokens / modalities / reasoning levels）；顺带 `GET /api/hello` 拿版本并确认「这是 magpie」 |
| 模型档案 | 目录 → `mp:<模型 id>` 的**派生**档案（含网关地址/Key），不落盘、不带供应商 Key；绑定与候选链只存模型引用 |
| 能力表 | 目录明确给出的窗口/输出/视觉/推理会写进 `modelCaps` 本机覆盖，能力判定与网关一致 |
| 设置区 | `MagpieGatewayCard`：网关地址 / 网关 Key / 「读取模型」/ 「仅保存」/ 模型表（上下文、看图、推理档位）；只请求用户填的地址，不经过和鸣服务端 |
| 迁移 | `clearLegacyModelConfig()`：一次性清掉旧连接（含 `.__heming_undecryptable` / `.__heming_plaintext_backup`）、旧绑定、旧候选链、旧冷却键；**提示词与历史用量保留** |

浏览器/云端网页版没有本机 magpie：把网关地址填成「已共享出来的远端 magpie」+ 其网关 Key 即可
（magpie 的 Settings → Network and sharing 会发网关 Key）；否则如实提示连不上。

## 3. 迁移口径（一次、可回滚性说明）

- 标记键 `heming.magpie.migrated.v1`：落盘后不再清任何东西——用户之后新建的绑定/候选链不会被误删；
- 清除是**不可恢复**的（含安全存储里的供应商 Key），这是本轮明确的产品决定；
- 提示词（`heming.agentPrompts`）、历史 token 用量、记忆/技能/MCP 配置都不在清除范围。

## 4. 验证

- 新增 `lib/magpieClient.test.ts` 11 例（目录解析/探活/401 点名 Key/地址校验/只发两个请求）；
- 新增 `components/MagpieGatewayCard.test.tsx` 4 例（默认值、仅保存不联网、读取模型渲染表、失败提示）；
- 重写 `store/llm.test.ts` 8 例（网关落盘、目录派生、迁移清除、提示词保留、候选链绑定模型）；
- 更新 `SettingsPage.test`（不再有服务商预设/供应商 Key，改为网关卡）、`AgentFormModal.test`、`modelCaps.test`、
  `bundledPlugins.test`（magpie 插件包已删）、`manifest.test`（v4 拒绝、llmPresets 忽略）；
- `pnpm --filter @heming/web typecheck` 零错。

## 5. 未做（下一轮）

1. **桌面端内置 magpie 二进制并托管生命周期**（官方 Windows CLI 单文件约 70MB）：下载到产物目录、主进程
   spawn/健康检查/退出回收、`/v1` 与 `/api/hello` 的渲染层访问（CORS 或主进程代理）——本轮只做「连已有网关」；
2. **删除 Anthropic 协议实现**（`lib/llmAnthropic.ts`、`llmClient` 的 anthropic 分支、promptCache 的 Anthropic 类型）：
   网关统一 OpenAI 兼容后已是死代码，但牵连 5+ 文件与测试，单独一轮清；
3. 价格表/`cheap` 档：网关目录不提供价格，`cheap` 目前仍按本机能力表（已无厂商价目）→ 排不出差别，应删除该档；
4. 插件目录 DTO 里 `llmPresets` 字段保留为 0（服务端契约兼容），下一轮随客户端一起删。
