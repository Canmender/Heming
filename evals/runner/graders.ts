/**
 * 判分器：把一次用例的观测结果折成「过 / 不过 + 一句人话」。
 *
 * 设计原则：**每条失败都必须能直接定位**
 * ——失败详情里带 grader 类型、期望值与实际值片段，看 CI 日志就知道该修用例还是修代码。
 */

import { readFile, access } from "node:fs/promises";
import path from "node:path";
import type { CaseObservation, EvalCase, Grader } from "./types.js";

export interface GraderResult {
  grader: Grader;
  ok: boolean;
  detail: string;
}

/** 取 grader 要检查的文本（多回合拼接；`in` 缺省 final——答案必须出现在给用户的回答里）。 */
function textOf(obs: CaseObservation, where: Grader["in"]): string {
  const finals = obs.finals.join("\n");
  const toolResults = obs.toolResults.join("\n");
  if (where === "final") return finals;
  if (where === "tool_result") return toolResults;
  if (where === "any") return `${finals}\n${toolResults}`;
  return finals;
}

/** 路径比较用：统一成 `/`、小写（Windows 大小写不敏感，证据里的路径可能带盘符或反斜杠）。 */
function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

/** 数组化（grader 的 value/contains 允许单串）。 */
function asList(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** 片段化展示实际值，避免把整篇文档塞进报告。 */
function snippet(text: string, limit = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}

async function fileText(abs: string): Promise<string | null> {
  try {
    return await readFile(abs, "utf8");
  } catch {
    return null;
  }
}

function resolveIn(dir: string, p: string): string {
  return path.isAbsolute(p) ? path.normalize(p) : path.resolve(dir, p);
}

async function gradeOne(grader: Grader, testCase: EvalCase, obs: CaseObservation): Promise<GraderResult> {
  const fail = (detail: string): GraderResult => ({ grader, ok: false, detail });
  const pass = (detail: string): GraderResult => ({ grader, ok: true, detail });

  switch (grader.type) {
    case "contains": {
      const text = textOf(obs, grader.in);
      const missing = asList(grader.value).filter((needle) => !text.includes(needle));
      return missing.length === 0
        ? pass(`包含全部 ${asList(grader.value).length} 个片段`)
        : fail(`缺少片段：${missing.map((m) => `「${m}」`).join("、")}；实际文本：${snippet(text)}`);
    }

    case "exact": {
      const expected = asList(grader.value).join("\n").trim();
      const text = textOf(obs, grader.in === "tool_result" ? "tool_result" : "final").trim();
      return text === expected ? pass("文本完全一致") : fail(`期望「${snippet(expected, 120)}」，实际「${snippet(text, 160)}」`);
    }

    case "regex": {
      let re: RegExp;
      try {
        re = new RegExp(grader.pattern ?? "");
      } catch (e) {
        return fail(`正则无法编译：${grader.pattern}（${e instanceof Error ? e.message : String(e)}）`);
      }
      const text = textOf(obs, grader.in);
      return re.test(text)
        ? pass(`正则 ${grader.pattern} 命中`)
        : fail(`正则 ${grader.pattern} 未命中；实际文本：${snippet(text)}`);
    }

    case "file_assert": {
      const abs = resolveIn(obs.dir, grader.path ?? "");
      const content = await fileText(abs);
      const wants = grader.exists !== false;
      if (!wants && content === null) return pass(`文件不存在（符合期望）：${grader.path}`);
      if (content === null) return fail(`文件不存在：${grader.path}（绝对路径 ${abs}）`);
      const missing = asList(grader.contains).filter((needle) => !content.includes(needle));
      if (missing.length > 0) {
        return fail(`${grader.path} 缺少片段：${missing.map((m) => `「${m}」`).join("、")}；实际内容：${snippet(content)}`);
      }
      const forbidden = asList(grader.not_contains).filter((needle) => content.includes(needle));
      if (forbidden.length > 0) {
        return fail(`${grader.path} 出现了不该有的片段：${forbidden.map((m) => `「${m}」`).join("、")}`);
      }
      return pass(`${grader.path} 内容符合期望`);
    }

    case "tool_called": {
      const name = grader.tool ?? "";
      const count = obs.toolCalls.filter((call) => call.name === name).length;
      // 不给 times = 「至少调用过一次」；给了 times = 要求**恰好**这么多次（README 的口径，
      // 确定性脚本下次数是可控的，多调一次就该红——那是最容易悄悄变贵的回归）。
      const ok = grader.times === undefined ? count >= 1 : count === grader.times;
      return ok
        ? pass(`${name} 调用 ${count} 次${grader.times === undefined ? "" : `（期望恰好 ${grader.times} 次）`}`)
        : fail(`${name} 调用 ${count} 次，期望${grader.times === undefined ? "至少 1 次" : `恰好 ${grader.times} 次`}`);
    }

    case "tool_sequence": {
      const wanted = grader.tools ?? [];
      let at = 0;
      for (const call of obs.toolCalls) {
        if (at < wanted.length && call.name === wanted[at]) at += 1;
      }
      const actual = obs.toolCalls.map((c) => c.name).join(" → ") || "（无调用）";
      return at === wanted.length
        ? pass(`工具序列包含 ${wanted.join(" → ")}`)
        : fail(`工具序列缺少第 ${at + 1} 项「${wanted[at]}」；实际：${actual}`);
    }

    case "max_rounds": {
      const max = grader.max ?? 1;
      return obs.rounds <= max
        ? pass(`回合数 ${obs.rounds} ≤ ${max}`)
        : fail(`回合数 ${obs.rounds} 超过上限 ${max}`);
    }

    case "hitl": {
      const name = grader.tool ?? "";
      const expect = grader.expect ?? "denied";
      const decisions = obs.decisions.filter((d) => d.name === name);
      const outcomes = obs.toolOutcomes.filter((o) => o.name === name);
      // 「最终有没有被执行」：闸门放行 **且** 工具真的成功，才算 allowed。
      const allowed = decisions.some((d) => d.decision === "allow") && outcomes.some((o) => o.ok);
      const denied = decisions.some((d) => d.decision === "deny") || outcomes.some((o) => !o.ok);
      const actual = allowed ? "allowed" : denied ? "denied" : "未发生";
      if (expect === "allowed") {
        return allowed
          ? pass(`${name} 被执行（allowed）`)
          : fail(`${name} 期望 allowed，实际 ${actual}${decisions.find((d) => d.reason)?.reason ? `：${decisions.find((d) => d.reason)?.reason}` : ""}`);
      }
      return denied
        ? pass(`${name} 未被写入（denied）`)
        : fail(`${name} 期望 denied，实际 ${actual}`);
    }

    case "no_side_effect": {
      const paths = grader.paths ?? (grader.path ? [grader.path] : []);
      if (paths.length === 0) return fail("no_side_effect 必须给 paths");
      for (const p of paths) {
        const abs = resolveIn(obs.dir, p);
        try {
          await access(abs);
          return fail(`出现了不该产生的文件：${p}（${abs}）`);
        } catch {
          /* 不存在 = 符合期望 */
        }
      }
      return pass(`${paths.length} 条路径都没有被创建`);
    }

    case "evidence": {
      // 完成即证据（P3/T15）：只认 assistant_final.evidence 里真实记下的文件/动作。
      // 没有证据 ≠ 通过：一个只会说「已完成」却没有任何写/命令记录的回合必须判负，
      // 否则「证据」就退化成又一句模型自述。
      const wantFiles = grader.files ?? [];
      const wantCommands = grader.evidence_commands ?? [];
      if (wantFiles.length === 0 && wantCommands.length === 0) {
        return fail("evidence 必须给 files 或 evidence_commands");
      }
      const entries = obs.evidence ?? [];
      if (entries.length === 0) {
        return fail("回合没有任何完成证据（assistant_final.evidence 为空）：只自称完成不算数");
      }
      const files = entries.flatMap((e) => e.files).map(normalizePath);
      const commands = entries.flatMap((e) => e.commands);
      const missingFiles = wantFiles.filter((p) => !files.some((f) => f.includes(normalizePath(p))));
      const missingCommands = wantCommands.filter((p) => !commands.some((c) => c.includes(p)));
      if (missingFiles.length > 0 || missingCommands.length > 0) {
        const parts: string[] = [];
        if (missingFiles.length) parts.push(`缺文件证据：${missingFiles.join("、")}`);
        if (missingCommands.length) parts.push(`缺动作证据：${missingCommands.join("、")}`);
        parts.push(`实际证据：文件 ${files.join("、") || "（无）"}；动作 ${commands.join("、") || "（无）"}`);
        return fail(parts.join("；"));
      }
      return pass(`证据齐全：${wantFiles.length} 个文件、${wantCommands.length} 个动作`);
    }

    case "llm_judge":
      // 确定性模式没有真实模型：按契约记为 skipped（不算失败，也不占 pass@1）。
      return pass("skipped：llm_judge 只在 --real 的夜间任务里生效");

    default:
      return fail(`未知 grader 类型：${String((grader as { type: string }).type)}`);
  }
}

/** 跑一遍全部 grader（**不短路**：一次列出所有失败，省一轮往返）。 */
export async function gradeCase(testCase: EvalCase, obs: CaseObservation): Promise<GraderResult[]> {
  const results: GraderResult[] = [];
  for (const grader of testCase.graders) {
    results.push(await gradeOne(grader, testCase, obs));
  }
  return results;
}
