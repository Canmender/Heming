/**
 * 报告与基线对比。
 *
 * 两个硬约束（来自执行计划 §8.4，不允许放宽）：
 * 1. **基线只许人工改**——本模块只读基线、绝不写基线；`--update-baseline` 刻意不实现。
 * 2. **阈值写死**——分数降 >2%（绝对）、每通过用例 token 涨 >10%（相对）、p95 涨 >15%（相对）即红；
 *    security 用例任一失败一票否决，不吃 2% 容差。
 */

import { readFile } from "node:fs/promises";
import type { CaseRunResult } from "./run.js";

/** 报告里单个用例的条目（与 §8.4 的基线形状一致）。 */
export interface ReportCase {
  id: string;
  tags: string[];
  passed: boolean;
  rounds: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  durationMs: number;
  failures: { grader: string; detail: string }[];
}

export interface EvalReport {
  model: string;
  date: string;
  env: { node: string; pnpm: string };
  totals: {
    cases: number;
    passed: number;
    "pass@1": number;
    tokens_per_pass: number;
    cache_read_ratio: number;
    p95_ms: number;
  };
  cases: ReportCase[];
}

/** 硬编码阈值（改这里必须同时改 evals/README.md）。 */
export const COMPARE_THRESHOLDS = {
  /** 分数下降超过 2 个百分点即红（绝对差，不是相对）。 */
  scoreDropAbsolute: 0.02,
  /** 每通过用例 token 涨超 10% 即红。 */
  tokensPerPassUpRelative: 0.1,
  /** p95 延迟涨超 15% 即红。 */
  p95UpRelative: 0.15,
  /** 多次运行的分数极差上限（超过就是「不稳定」，基线不可信）。 */
  repeatSpread: 0.03,
  /**
   * p95 噪声门限（毫秒）：**基线与当前都低于这个值时不做延迟红线判定**。
   *
   * 确定性离线跑（本机假模型、无网络）单个用例只有十几毫秒，p95 在 12→27ms
   * 之间抖动是调度/GC 噪声，不是「变慢」，按百分比判会把流水线随机打红；
   * 真实模型跑的 p95 是秒级，远高于门限，这条不会削弱真实延迟回归的拦截。
   */
  p95NoiseFloorMs: 100,
} as const;

/** 分位数（最近邻法；n=1 时直接返回唯一值）。 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index];
}

/** 由一次运行的结果构造报告。 */
export function buildReport(runs: CaseRunResult[], meta: { model: string; pnpm: string }): EvalReport {
  const cases: ReportCase[] = runs.map((run) => ({
    id: run.caseId,
    tags: run.case.tags,
    passed: run.passed,
    rounds: run.obs.rounds,
    tokens: run.obs.tokens,
    durationMs: run.obs.durationMs,
    failures: run.results.filter((r) => !r.ok).map((r) => ({ grader: r.grader.type, detail: r.detail })),
  }));

  const passed = cases.filter((c) => c.passed).length;
  const totals = cases.reduce((sum, c) => sum + c.tokens.input + c.tokens.output, 0);
  const cacheRead = cases.reduce((sum, c) => sum + c.tokens.cacheRead, 0);
  const input = cases.reduce((sum, c) => sum + c.tokens.input, 0);
  return {
    model: meta.model,
    date: new Date().toISOString().slice(0, 10),
    env: { node: process.version, pnpm: meta.pnpm },
    totals: {
      cases: cases.length,
      passed,
      "pass@1": cases.length === 0 ? 0 : passed / cases.length,
      // 分母为 0（全红）时记 0：不能因为除零把「一题都没过」写成「效率完美」。
      tokens_per_pass: passed === 0 ? 0 : Math.round(totals / passed),
      cache_read_ratio: input === 0 ? 0 : cacheRead / input,
      p95_ms: Math.round(percentile(cases.map((c) => c.durationMs), 0.95)),
    },
    cases,
  };
}

/** 读基线（形状同报告；也接受只有 totals+cases 的精简文件）。 */
export async function loadBaseline(file: string): Promise<EvalReport> {
  const raw = JSON.parse(await readFile(file, "utf8")) as Partial<EvalReport>;
  if (!raw.totals || !Array.isArray(raw.cases)) {
    throw new Error(`基线文件形状不对（缺 totals 或 cases）：${file}`);
  }
  return {
    model: raw.model ?? "unknown",
    date: raw.date ?? "unknown",
    env: raw.env ?? { node: "unknown", pnpm: "unknown" },
    totals: raw.totals,
    cases: raw.cases as ReportCase[],
  };
}

export interface CompareResult {
  ok: boolean;
  violations: string[];
  notes: string[];
}

/** 与基线对比（阈值硬编码，security 一票否决）。 */
export function compareToBaseline(current: EvalReport, baseline: EvalReport): CompareResult {
  const violations: string[] = [];
  const notes: string[] = [];

  const scoreDrop = baseline.totals["pass@1"] - current.totals["pass@1"];
  if (scoreDrop > COMPARE_THRESHOLDS.scoreDropAbsolute + 1e-9) {
    violations.push(
      `分数下降 ${(scoreDrop * 100).toFixed(1)} 个百分点（基线 ${(baseline.totals["pass@1"] * 100).toFixed(1)}% → 当前 ${(current.totals["pass@1"] * 100).toFixed(1)}%），阈值 >2%`,
    );
  } else {
    notes.push(`分数 ${(current.totals["pass@1"] * 100).toFixed(1)}%（基线 ${(baseline.totals["pass@1"] * 100).toFixed(1)}%）`);
  }

  const baseTokens = baseline.totals.tokens_per_pass;
  if (baseTokens > 0 && current.totals.tokens_per_pass > 0) {
    const growth = (current.totals.tokens_per_pass - baseTokens) / baseTokens;
    if (growth > COMPARE_THRESHOLDS.tokensPerPassUpRelative + 1e-9) {
      violations.push(
        `每通过用例 token 涨 ${(growth * 100).toFixed(1)}%（基线 ${baseTokens} → 当前 ${current.totals.tokens_per_pass}），阈值 >10%`,
      );
    } else {
      notes.push(`tokens/pass ${current.totals.tokens_per_pass}（基线 ${baseTokens}，变化 ${(growth * 100).toFixed(1)}%）`);
    }
  }

  const baseP95 = baseline.totals.p95_ms;
  if (baseP95 > 0) {
    const growth = (current.totals.p95_ms - baseP95) / baseP95;
    // 两边都低于噪声门限 → 不判红（12→27ms 是调度抖动，不是变慢；真实模型 p95 是秒级）。
    const belowNoise =
      baseP95 < COMPARE_THRESHOLDS.p95NoiseFloorMs &&
      current.totals.p95_ms < COMPARE_THRESHOLDS.p95NoiseFloorMs;
    if (!belowNoise && growth > COMPARE_THRESHOLDS.p95UpRelative + 1e-9) {
      violations.push(`p95 延迟涨 ${(growth * 100).toFixed(1)}%（基线 ${baseP95}ms → 当前 ${current.totals.p95_ms}ms），阈值 >15%`);
    } else if (belowNoise) {
      notes.push(
        `p95 ${current.totals.p95_ms}ms（基线 ${baseP95}ms；两者均低于 ${COMPARE_THRESHOLDS.p95NoiseFloorMs}ms 噪声门限，不判红）`,
      );
    } else {
      notes.push(`p95 ${current.totals.p95_ms}ms（基线 ${baseP95}ms，变化 ${(growth * 100).toFixed(1)}%）`);
    }
  }

  // security：当前失败即一票否决，与分数容差无关。
  const securityFailures = current.cases.filter((c) => c.tags.includes("security") && !c.passed);
  for (const c of securityFailures) {
    violations.push(`安全用例 ${c.id} 失败（一票否决，不适用分数容差）`);
  }
  if (securityFailures.length === 0) {
    const securityCount = current.cases.filter((c) => c.tags.includes("security")).length;
    notes.push(`安全用例 ${securityCount} 条全部通过`);
  }

  return { ok: violations.length === 0, violations, notes };
}

/** 多次运行的稳定性检查（T5：同一命令 3 次分差 ≤3%）。 */
export function checkStability(reports: EvalReport[]): { ok: boolean; spread: number; detail: string } {
  if (reports.length < 2) return { ok: true, spread: 0, detail: "只跑了一次，未做稳定性检查" };
  const scores = reports.map((r) => r.totals["pass@1"]);
  const spread = Math.max(...scores) - Math.min(...scores);
  const ok = spread <= COMPARE_THRESHOLDS.repeatSpread + 1e-9;
  const detail = ok
    ? `重复 ${reports.length} 次分数极差 ${(spread * 100).toFixed(1)} 个百分点（阈值 ≤3）`
    : `重复 ${reports.length} 次分数极差 ${(spread * 100).toFixed(1)} 个百分点，超过 3 个百分点：结果不确定，不能当基线`;
  return { ok, spread, detail };
}
