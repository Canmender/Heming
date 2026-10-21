# 自我修改（self-modification）

> 用户 2026-10-20 要求：为功能留接口，方便内置智能体修改技能、记忆、MCP 等内容，
> 辅助自身优化。授权范围经确认：**MCP 完全放开**（可新增/修改/删除服务，含 stdio 命令）、
> **默认开启**。

## 两条通道

| 通道 | 触发时机 | 写什么 | 实现 |
|------|---------|--------|------|
| **复盘分身**（review fork） | 任务结束后后台自审 | 语义记忆 + 技能沉淀 | `lib/memory/review.ts` |
| **self.\* 工具** | 模型在会话中按需调用 | 记忆 / 技能 / MCP | `lib/selfEdit/tools.ts` |

两者互补而非替代：复盘是**事后**沉淀，self.\* 是**事中**修正——
模型发现「我记错了」「这类问题该有个固定流程」时当场就能改，不必攒到下一轮复盘。

## self.\* 工具清单

| 工具 | 作用 |
|------|------|
| `self_memory_list` | 读自己的长期记忆 |
| `self_memory_write` | 写入/更新（相同 key 覆盖，不重复新增） |
| `self_memory_remove` | 删除记错或过期的记忆 |
| `self_skill_list` | 读已分配技能的完整定义 |
| `self_skill_create` | 沉淀新技能（`source=distilled`） |
| `self_skill_update` | 改进同名技能 |
| `self_mcp_list` | 读 MCP 服务与工具启用状态 |
| `self_mcp_enable` / `self_mcp_disable` | 启用/停用工具（`serverId::toolName`） |
| `self_mcp_add_server` / `update_server` / `remove_server` | 增改删 MCP 服务 |
| `self_snapshot_list` | 列出可回滚的修改（只读） |
| `self_rollback` | 回滚一条修改（danger，走 HITL） |

**形状对齐既有 MCP 工具**（OpenAI 的 `{type:"function",…}` + `{name, arguments}`），
所以模型不需要学新协议，`agentStream` 的工具循环也不用改。两个桥由
`lib/selfEdit/merge.ts` 的 `mergeToolBridges` 合并，执行时按工具名路由。

## 护栏（`lib/selfEdit/guards.ts`）

授权是放开的，护栏只解决「**写坏**」而非「不许写」：

1. **密钥类内容不落盘** —— 记忆、技能正文、MCP headers 命中敏感模式即拒绝，
   并提示改用引用（如「密钥在环境变量 X」）而非字面量。
   这类内容一旦落盘就会跟着每次模型调用被复制到别处，清不干净。
2. **单轮变更上限**（默认 8 次）—— 防「改一下→发现不对→再改一下」的死循环把配置写满。
   触顶后明确回复而非静默失败；换轮自动重置（`onStart` 里调 `budget.reset`）。
3. **变更留痕** —— 每次改动记 `{时间, 智能体, 域, 动作, 对象, 理由}`，
   **被拒绝的尝试也留痕**（「它想写什么但被拦下」比「什么都没发生」更值得知道）。
   上限 300 条，最新在前。
4. **按智能体的开关** —— 存储 `heming.selfEdit.v1`，缺省为**允许**。
   在技能区底部「自我优化」卡里可逐个智能体关闭，并查看最近 20 条变更记录。

## 护栏为什么要共用

`containsSensitive` 从 `lib/memory/review.ts` 抽到 `guards.ts`，两条通道共用同一份判据。
两处各写一份正则，迟早漂移成「一条通道拦得住、另一条拦不住」——
那种 bug 极难发现，因为两条路径的测试都只覆盖自己那条。

## 内置技能不可直接改

`self_skill_update` 遇到 `builtin` 技能会拒绝并提示改用 `self_skill_create`。
内置技能是所有智能体的公共基线，让单个智能体改它会影响别人；
真要调整就沉淀一条自己的技能，来源是 `distilled`，归属清楚。

## 快照与回滚（`lib/selfEdit/snapshots.ts`）

留痕只回答「改了什么」，回不了退；快照补上「**改之前是什么**」。

- 每次**成功**的记忆 / 技能 / MCP 变更记一条反向操作（记忆写入前的原条目、技能更新前的
  完整定义、被删服务的配置等），**不是整库复制**——localStorage 只有几 MB，
  整库复制几次就会挤掉用户自己的数据
- 上限 50 条（`heming.selfEdit.snapshots.v1`），超出丢最旧的；快照与审计分开存，
  清空快照不影响留痕
- `self_rollback` 按**快照所属域**走 HITL（改 MCP 的回滚同样是危险操作），
  成功后移除该快照并留痕 `other/rollback`；失败保留快照并说明原因，便于重试或手工处理
- 回滚**永不抛**：目标可能已被用户手工改动或删除，此时返回可读原因而不是崩掉本轮对话
- 快照按智能体隔离：A 智能体看不到、也回滚不了 B 的快照；技能区「自我优化」卡
  只列出当前智能体的可回滚项
- 已知代价：记忆条目回滚后内部 id 会变（内容、key、置顶状态照旧），且不覆盖审计记录本身

## 开关接线

`SelfEditStore.allowed(agentId)` 为 false 时，`buildSelfToolBridge` 返回
**空 tools 数组**（不是 null）——null 在编排层意味着「本轮没有工具」，
会连带跳过后续桥合并；空数组则只是「这个智能体看不到 self 工具」。