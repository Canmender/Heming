# 基线（`evals/baselines/`）

这里是**评测基线**：一次被人工确认过的 `pnpm eval:agent -- --json` 报告，改名入库后作为后续对比的锚点。

## 命名

- `<model>-<date>.json`：历史基线，按时间累积，例如 `eval-offline-2026-11-15.json`。
- `latest.json`：**当前有效基线**的副本，CI 与本地门禁只认这一个文件
  （`pnpm eval:agent -- --compare evals/baselines/latest.json`）。

确定性模式（不带 `--real`）的模型名是 `eval-offline`；夜间真实模型基线用返回里的 `model` 字段。

## 冻结流程（必须人工确认）

```bash
# 1. 连跑 3 次，确认分数极差 ≤3 个百分点（脚本自己会判断，超了直接 exit 1）
pnpm eval:agent -- --repeat 3 --json evals/reports/freeze.json

# 2. 人工看一眼报告：用例数、pass@1、tokens/pass、p95、失败的 grader
#    确认「这次数字是被认可的现状」，而不是「刚坏掉的样子被拍成基线」

# 3. 改名为基线并更新 latest（Windows PowerShell）
Copy-Item evals/reports/freeze.json evals/baselines/eval-offline-2026-11-15.json
Copy-Item evals/reports/freeze.json evals/baselines/latest.json

# 4. 与基线一起提交；基线文件要随 PR 一起被 review
```

## 红线（写死在 `evals/runner/report.ts`，不允许放宽）

| 指标 | 阈值 |
| --- | --- |
| 分数（pass@1）下降 | > 2 个百分点即红 |
| 每通过用例 token（`tokens_per_pass`）上涨 | > 10% 即红 |
| p95 延迟上涨 | > 15% 即红 |
| security 用例 | 任一失败一票否决，不吃 2% 容差 |
| 多次运行分数极差 | > 3 个百分点即「不稳定」，不得当基线 |

**新增用例后基线不必立刻重冻**：`pass@1` 与 `tokens_per_pass` 是聚合指标，只要新用例全绿、
每通过用例 token 不涨，旧基线继续有效；用例数变化本身不是红线（d.159 新增 6 条后是 24 条
对基线 18 条，`--compare latest.json` 仍全绿）。什么时候该重冻：新增/删除用例改变了
「这批数字代表什么」，或人工确认了新的性能现状。

**注意「更重的用例会抬高聚合 token」**：d.161 新增的 `ctx-003`（多轮系统提示词）与 `long-001`
（14 回合、14280 tokens）把 26 条用例的 `tokens_per_pass` 从基线的 2607 抬到 2864（+9.9%）——
距 10% 红线只剩 0.1 个百分点。这不是性能退化，是新用例本身更重（多轮 + 每轮都带系统提示词）；
但也说明聚合口径在「用例集权重变化」时很敏感。**建议下一次由人复核后重冻基线**（先跑
`--json evals/reports/freeze.json`，确认 26 条全绿再替换），别让门禁长期贴着红线跑。

## 为什么没有 `--update-baseline`

基线一旦可以被脚本改写，就等于「让被测对象自己给自己判分」：所有回归都会被下一次运行
悄悄吸收进基线，门禁从此只会绿。所以运行器**只读基线**，更新只能由人改文件。
