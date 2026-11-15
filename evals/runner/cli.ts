/**
 * `pnpm eval:agent` 的实现主体（CLI 外壳在 `scripts/eval-agent.mjs`）。
 *
 * 用法（与 CI / 夜间任务共用同一口径）：
 *   node scripts/eval-agent.mjs                       # 确定性跑全部用例
 *   node scripts/eval-agent.mjs --filter ctx          # 只跑某一组
 *   node scripts/eval-agent.mjs --repeat 3            # 稳定性（T5 冻结基线前必跑）
 *   node scripts/eval-agent.mjs --compare evals/baselines/latest.json
 *   node scripts/eval-agent.mjs --real --model gpt-4o-mini   # 需要 HEMING_EVAL_API_KEY
 *
 * 退出码：0 = 全绿且无红线；1 = 有用例失败或基线对比红线；2 = 配置/环境错误。
 */

import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadCases } from "./loader.js";
import { buildReport, checkStability, compareToBaseline, loadBaseline, type EvalReport } from "./report.js";
import { runCase, type CaseRunResult } from "./run.js";

/**
 * 报告里记 pnpm 版本（基线的一部分：同分数不同工具链不算可比）。
 *
 * 两条路：`pnpm eval:agent` 启动时 user-agent 里就带着版本；直接 `node` 跑时再问一次。
 * 两条都失败就写 "unknown"——宁可如实说不知道，也不要编一个版本号进基线。
 */
function detectPnpm(): string {
  const agent = process.env.npm_config_user_agent ?? "";
  const matched = /pnpm\/(\d+\.\d+\.\d+)/.exec(agent);
  if (matched) return matched[1] ?? "unknown";
  try {
    const bin = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
    const out = execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 10_000 }).trim();
    return out || "unknown";
  } catch {
    return "unknown";
  }
}

const PNPM_VERSION = detectPnpm();

export interface CliOptions {
  repoRoot: string;
  casesDir: string;
  fixturesDir: string;
  json?: string;
  compare?: string;
  repeat: number;
  filter?: string;
  real: boolean;
  model: string;
  keep: boolean;
  log: (line: string) => void;
}

function arg(argv: string[], name: string): string | undefined {
  // 同时认 `--x value` 与 `--x=value`（与 scripts/design-audit.mjs 同一约定）。
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  if (index >= 0 && index + 1 < argv.length && !argv[index + 1].startsWith("--")) return argv[index + 1];
  return undefined;
}

function has(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`) || argv.some((a) => a.startsWith(`--${name}=`));
}

/** 解析 CLI 参数（不抛，把错误交给 runCli 决定退出码）。 */
export function parseArgs(argv: string[], repoRoot: string, log: (line: string) => void): CliOptions | { error: string } {
  const repeatRaw = arg(argv, "repeat");
  const repeat = repeatRaw === undefined ? 1 : Number(repeatRaw);
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 10) {
    return { error: `--repeat 需要 1..10 的整数，收到「${repeatRaw}」` };
  }
  return {
    repoRoot,
    casesDir: path.resolve(repoRoot, arg(argv, "cases") ?? "evals/cases"),
    fixturesDir: path.resolve(repoRoot, arg(argv, "fixtures") ?? "evals/fixtures"),
    ...(arg(argv, "json") ? { json: path.resolve(repoRoot, arg(argv, "json")!) } : {}),
    ...(arg(argv, "compare") ? { compare: path.resolve(repoRoot, arg(argv, "compare")!) } : {}),
    repeat,
    ...(arg(argv, "filter") ? { filter: arg(argv, "filter")! } : {}),
    real: has(argv, "real"),
    model: arg(argv, "model") ?? process.env.HEMING_EVAL_MODEL ?? "gpt-4o-mini",
    keep: has(argv, "keep"),
    log,
  };
}

/** 跑一轮全部用例。 */
async function runOnce(options: CliOptions, workRoot: string, label: string): Promise<CaseRunResult[]> {
  const cases = await loadCases(options.casesDir, options.filter);
  options.log(`\n${label}：${cases.length} 条用例（${options.real ? "真实模型" : "确定性脚本"}）`);
  const results: CaseRunResult[] = [];
  for (const testCase of cases) {
    const result = await runCase(testCase, {
      repoRoot: options.repoRoot,
      fixturesDir: options.fixturesDir,
      workRoot,
      real: options.real,
      model: options.model,
      keep: options.keep,
    });
    results.push(result);
    const mark = result.passed ? "✓" : "✗";
    const tokens = result.obs.tokens.input + result.obs.tokens.output;
    options.log(`  ${mark} ${testCase.id.padEnd(12)} ${String(result.obs.rounds).padStart(2)} 回合  ${String(tokens).padStart(6)} tokens  ${String(result.obs.durationMs).padStart(5)}ms`);
    for (const failure of result.results.filter((r) => !r.ok)) {
      options.log(`      ↳ ${failure.grader.type}: ${failure.detail}`);
    }
  }
  return results;
}

/** 入口：返回进程退出码。 */
export async function runCli(argv: string[], repoRoot: string): Promise<number> {
  const log = (line: string) => process.stdout.write(`${line}\n`);
  const parsed = parseArgs(argv, repoRoot, log);
  if ("error" in parsed) {
    log(`参数错误：${parsed.error}`);
    return 2;
  }
  const options = parsed;

  if (options.real && !process.env.HEMING_EVAL_API_KEY) {
    log("--real 需要 HEMING_EVAL_API_KEY（没有 Key 时不允许静默降级成确定性模式）");
    return 2;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  // 沙箱放在仓库的 `.tmp/evals/<时间戳>/<用例 id>/`：写盘路径都在仓库内，且 .tmp 已被 gitignore。
  const workRoot = path.join(options.repoRoot, ".tmp", "evals", stamp);
  await mkdir(workRoot, { recursive: true });
  let exitCode = 0;
  const reports: EvalReport[] = [];

  try {
    for (let i = 0; i < options.repeat; i += 1) {
      const results = await runOnce(options, workRoot, options.repeat > 1 ? `第 ${i + 1}/${options.repeat} 次` : "运行");
      reports.push(buildReport(results, { model: options.real ? options.model : "eval-offline", pnpm: PNPM_VERSION }));
      if (results.some((r) => !r.passed)) exitCode = 1;
    }

    const report = reports[0];
    const totals = report.totals;
    log(
      `\n汇总：${totals.passed}/${totals.cases} 通过（pass@1 ${(totals["pass@1"] * 100).toFixed(1)}%），` +
        `tokens/pass ${totals.tokens_per_pass}，缓存读占比 ${(totals.cache_read_ratio * 100).toFixed(1)}%，p95 ${totals.p95_ms}ms`,
    );

    if (options.compare) {
      const baseline = await loadBaseline(options.compare);
      log(`\n基线对比：${path.relative(options.repoRoot, options.compare)}（${baseline.model} · ${baseline.date}）`);
      const comparison = compareToBaseline(report, baseline);
      for (const note of comparison.notes) log(`  · ${note}`);
      for (const violation of comparison.violations) log(`  ✗ ${violation}`);
      if (!comparison.ok) exitCode = 1;
    }

    const stability = checkStability(reports);
    if (reports.length > 1) log(`\n稳定性：${stability.detail}`);
    if (!stability.ok) exitCode = 1;

    if (options.json) {
      await mkdir(path.dirname(options.json), { recursive: true });
      const payload = {
        ...report,
        ...(reports.length > 1 ? { stability: { runs: reports.length, spread: stability.spread } } : {}),
      };
      await writeFile(options.json, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      log(`\n报告：${path.relative(options.repoRoot, options.json)}`);
    }

    if (exitCode === 0) log("\n结果：全绿");
    else log("\n结果：红");
    return exitCode;
  } catch (e) {
    log(`\n评测无法完成：${e instanceof Error ? e.message : String(e)}`);
    return 2;
  } finally {
    if (!options.keep) {
      await rm(workRoot, { recursive: true, force: true });
    } else {
      log(`\n沙箱保留在：${workRoot}`);
    }
  }
}
