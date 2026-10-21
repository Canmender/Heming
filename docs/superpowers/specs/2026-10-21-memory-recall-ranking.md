# 记忆召回：时效覆盖与多样性重排 · 实施记录

- 日期：2026-10-21（d.25）
- 状态：**语义层按主题键覆盖旧值、语义/情景都走 MMR 名额；全部确定性可解释，零学习参数**
- 关联：`2026-10-17-agent-memory-skills-design.md`（三层记忆原始设计）

---

## 1. 补的是两个具体的错，不是「调权重」

此前的审计把这项列为暂缓，理由是「没有真实使用数据，调权重视为拍脑袋」。这个理由仍然成立——
所以**这一版没有引入任何学习式权重或新的数据模型字段**（`SemanticEntry` 仍是
`createdAt/updatedAt/pinned/confidence/scope/source`，`packages/web/src/lib/memory/types.ts:37-60`）。
落地的是两条**不做就会出错**的规则：

1. **自相矛盾的记忆**：语义条目默认落全局桶，但某个智能体也能往自己的桶写同名 key，
   复盘／手动／显式三条写入路径可能在两个桶各留一份「称呼」。原样注入 = 模型同时看到
   「称呼=老王」和「称呼=王总」。**自相矛盾的记忆比没有记忆更糟**。
2. **近似重复挤占预算**：注入预算只有 1200 字（`format.ts` 的 `MEMORY_CHAR_BUDGET`，
   三层比例 0.4/0.4/0.2），同一件事的三个近似版本能把名额占满，别的什么都进不去。

## 2. 时效覆盖（supersede）

两条路径，写入时与召回时各一半：

- **写入时**：`store.ts:481` `upsertSemantic` —— 同桶 + 规范化 `key` 就地更新，
  保留 `id/createdAt/pinned`，只刷新 `value/updatedAt`。同一桶里不会同时存在新旧两版。
- **召回时**：`recall.ts:128` `supersedeSemantic()` —— **跨桶**按 `key` 只留 `updatedAt` 最新的一条。
  这是必要的补充：桶是隔离的，写入时的 upsert 管不到「全局桶 vs 本智能体桶」。
  - 时间戳不可解析（脏数据）→ `atMs()` 记 0 = 最旧，于是被同键的新条目覆盖（`recall.ts:73`）。
  - ★ **pinned 表主题不表版本**：同键存在更新条目时，最新那条**继承置顶位**。
    置顶项可能被换掉，但「这个主题必带」不会丢。

超期过滤不在召回层：情景层由 `store.ts:368` `episodic()` 按 `retentionDays`（默认 90）在读取时丢弃，
工作层丢弃 >2h（`WORKING_TTL_MS`），**语义层没有硬过期**，只有衰减——长期事实不该某天突然消失。

## 3. 打分与名额

```
recencyScore(t, now, halfLife) = 0.5 ^ (days / halfLife)      store.ts:58

语义 rankSemantic  (recall.ts:145)
   pinned 全带；其余 = (查询词重合数 / |查询词|) × recency(90d) × (0.5 + confidence)
情景 rankEpisodic  (recall.ts:172)
   = bm25Score(bigram 分词) × recency(14d) × (0.5 + importance)

多样性 pickDiverse (recall.ts:91)  ← MMR 贪心
   每轮取 score × (1 − 0.6 × maxJaccard(已选)) 最高的候选
```

| 常量 | 值 | 位置 |
| --- | --- | --- |
| `SEMANTIC_TOP` / `EPISODIC_TOP` / `WORKING_TOP` | 5 / 3 / 6 | `recall.ts:16/18/20` |
| `SEMANTIC_HALF_LIFE_DAYS` | 90 | `recall.ts:30` |
| `EPISODIC_HALF_LIFE_DAYS` | 14 | `store.ts` |
| `DIVERSITY_DAMP` | 0.6（重合度=1 时打 4 折） | `recall.ts:32` |
| `BM25_K1` / `BM25_B` | 1.2 / 0.75 | `recall.ts:34-35` |
| `IMPORTANCE_FLOOR` / `CONFIDENCE_FLOOR` | 0.5（使 0.5 档权重恰为 1） | `recall.ts:22/24` |
| `WORKING_LIMIT` / `EPISODIC_LIMIT` / `SEMANTIC_LIMIT` | 40 / 500 / 300 | `store.ts` |
| `SEDIMENT_EVERY` / `EXPLICIT_CONFIDENCE` | 6 / 0.9 | `store.ts` |

两个刻意的选择：

- **只降权，不硬删**（`pickDiverse`）。高度重复的条目仍可补位，否则 top 名额会被空置——
  少注入一条是损失，注入一条重复只是浪费点预算。
- **半衰期分两层**：「某次对话发生了什么」本就该快速淡出（14d）；
  长期事实用 14 天衰减会让三个月前记下的「用户在杭州」在召回时几乎归零（90d）。

## 4. 为什么不算「拍脑袋调权重」

- 每一项都能用一句话解释给**用户**听：「同主题只带最新」「近 3 个月记得的比 3 年前的更可能还有用」
  「重复的只占一个名额」。
- 没有任何一项需要训练数据才能定：半衰期是「事实 vs 事件」的语义差别，`DIVERSITY_DAMP` 上界 0.6
  保证「最相关的重复条目仍排在不相关的独占条目之后」这一条不变量。
- 幂等、确定、可单测：同一输入两次召回结果逐字相同（`now` 注入，不是 `Date.now()`）。
  没有真实使用数据时，**可解释比最优更重要**。

## 5. 测试（全部只依赖注入的 `now`）

`recall.test.ts` — describe「recallMemory：时效覆盖与多样性重排」：
- 同主题键只注入最新那条：全局桶与本智能体桶不会各带一份
- 同一桶里的历史重复条目同样被最新值覆盖（老版本数据不留双份）
- 置顶的是主题而不是那一版内容：同键有更新条目时由它继承置顶位
- 置信度与 90 天半衰期共同决定排序：久远的强相关事实压过刚写的弱相关事实
- 情景层近似重复的摘要只占一个名额，其余名额让给不同内容

`memory.test.ts`：
- 同 agentId + key upsert：保留 `id/createdAt`，刷新 `value/updatedAt`
- 情景记忆按 `retentionDays` 过滤超期条目（读取时）
- Working 读取时过滤 2 小时前的过期轮次

## 6. 已知边界

- 没有真实使用数据，所以以上数值未经校准；将来若有反馈，应先能**归因**（哪条被注入后模型用了/用了错的），再动权重。
- 语义层没有失效日期概念：被推翻的旧值靠「同键更新」覆盖，若用户换了表述方式（不同 key）旧值仍在。
- 召回是单文件纯函数（`recallMemory`，`recall.ts:200`），记忆状态是类单例 `memoryStore`
  （`store.ts:250`、`index.ts:22`），**没有 Zustand store**，别按界面状态去理解它。
