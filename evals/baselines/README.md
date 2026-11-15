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

## 为什么没有 `--update-baseline`

基线一旦可以被脚本改写，就等于「让被测对象自己给自己判分」：所有回归都会被下一次运行
悄悄吸收进基线，门禁从此只会绿。所以运行器**只读基线**，更新只能由人改文件。
