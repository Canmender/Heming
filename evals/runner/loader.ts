/**
 * 用例装载：读 YAML → 结构校验 → 稳定排序。
 *
 * 校验原则：**宁可开局报错，也不要跑到一半才发现字段名写错**。
 * 每条错误都带文件名与字段路径，修起来不用猜。
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { EvalCase, Grader, GraderType, ScriptTurn } from "./types.js";

/**
 * 惰性解析 js-yaml（CJS/ESM 两种发布形态都认）。
 *
 * 曾经写成静态 `import yamlModule from "js-yaml"`：一旦这个包以 ESM 具名导出发布，
 * 默认导入在运行时就是 `undefined`，报错点会落在第一条用例解析上，
 * 看起来像「YAML 写错了」。这里在首次用到时才解析一次，并同时接受
 * `{load}` 与 `{default:{load}}` 两种形状。
 */
type YamlLike = { load: (text: string) => unknown };
let yamlPromise: Promise<YamlLike> | null = null;

function yamlModule(): Promise<YamlLike> {
  if (!yamlPromise) {
    yamlPromise = (async () => {
      const ns = (await import("js-yaml")) as unknown as Record<string, unknown>;
      const candidates = [ns, ns.default as Record<string, unknown> | undefined];
      for (const candidate of candidates) {
        if (candidate && typeof candidate.load === "function") return candidate as unknown as YamlLike;
      }
      throw new Error("js-yaml 没有导出 load()（检查根 devDependencies 里的版本）");
    })();
  }
  return yamlPromise;
}

const GRADER_TYPES: GraderType[] = [
  "contains",
  "regex",
  "exact",
  "file_assert",
  "tool_called",
  "tool_sequence",
  "max_rounds",
  "hitl",
  "no_side_effect",
  "evidence",
  "llm_judge",
];

const ROOT_MODES = ["read", "write"] as const;
const OUT_OF_ROOT = ["ask", "reject"] as const;

class CaseError extends Error {
  constructor(
    readonly file: string,
    readonly field: string,
    detail: string,
  ) {
    super(`${file}: ${field} ${detail}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(file: string, field: string, value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new CaseError(file, field, "必须是非空字符串");
  }
  return value;
}

function optionalString(file: string, field: string, value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireString(file, field, value);
}

function stringOrArray(file: string, field: string, value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value as string[];
  throw new CaseError(file, field, "必须是字符串或字符串数组");
}

function parseScript(file: string, field: string, value: unknown): ScriptTurn[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new CaseError(file, field, "必须是非空数组（每项是一次模型回合）");
  }
  return value.map((turn, i) => {
    const at = `${field}[${i}]`;
    if (!isRecord(turn)) throw new CaseError(file, at, "必须是对象");
    const text = optionalString(file, `${at}.text`, turn.text);
    const rawCalls = turn.tool_calls;
    let calls: ScriptTurn["tool_calls"];
    if (rawCalls !== undefined) {
      if (!Array.isArray(rawCalls) || rawCalls.length === 0) {
        throw new CaseError(file, `${at}.tool_calls`, "必须是非空数组");
      }
      calls = rawCalls.map((call, k) => {
        const cat = `${at}.tool_calls[${k}]`;
        if (!isRecord(call)) throw new CaseError(file, cat, "必须是对象");
        const name = requireString(file, `${cat}.name`, call.name);
        const args = call.arguments;
        if (args !== undefined && !isRecord(args)) {
          throw new CaseError(file, `${cat}.arguments`, "必须是对象（runner 会序列化成 JSON 字符串）");
        }
        return { name, arguments: (args as Record<string, unknown>) ?? {} };
      });
    }
    if (text === undefined && !calls) {
      throw new CaseError(file, at, "至少要给 text 或 tool_calls 之一");
    }
    return { ...(text !== undefined ? { text } : {}), ...(calls ? { tool_calls: calls } : {}) };
  });
}

function parseGraders(file: string, value: unknown): Grader[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new CaseError(file, "graders", "必须是非空数组");
  }
  return value.map((raw, i) => {
    const at = `graders[${i}]`;
    if (!isRecord(raw)) throw new CaseError(file, at, "必须是对象");
    const type = requireString(file, `${at}.type`, raw.type) as GraderType;
    if (!GRADER_TYPES.includes(type)) {
      throw new CaseError(file, `${at}.type`, `未知 grader「${type}」（支持：${GRADER_TYPES.join(" / ")}）`);
    }
    const grader: Grader = { type };
    // `max_rounds` 的 value 是正整数（ctx-001 的 `value: 6`），不能走字符串校验，
    // 否则合法用例会被判成「value 必须是字符串或字符串数组」。它的校验在下面单独做。
    if (type !== "max_rounds") {
      const value_ = stringOrArray(file, `${at}.value`, raw.value);
      if (value_) grader.value = typeof raw.value === "string" ? value_[0] : value_;
    }
    const contains = stringOrArray(file, `${at}.contains`, raw.contains);
    if (contains) grader.contains = contains;
    const notContains = stringOrArray(file, `${at}.not_contains`, raw.not_contains);
    if (notContains) grader.not_contains = notContains;
    const tools = stringOrArray(file, `${at}.tools`, raw.tools);
    if (tools) grader.tools = tools;
    const files = stringOrArray(file, `${at}.files`, raw.files);
    if (files) grader.files = files;
    // YAML 里写成 `commands:`，但 Grader 上已有 `commands` 之外的同义字段会与 tool_sequence
    // 混淆；证据的动作断言用 `evidence_commands`，契约见 evals/README.md §3。
    const evidenceCommands = stringOrArray(file, `${at}.evidence_commands`, raw.evidence_commands);
    if (evidenceCommands) grader.evidence_commands = evidenceCommands;
    if (raw.pattern !== undefined) grader.pattern = requireString(file, `${at}.pattern`, raw.pattern);
    if (raw.path !== undefined) grader.path = requireString(file, `${at}.path`, raw.path);
    const paths = stringOrArray(file, `${at}.paths`, raw.paths);
    if (paths) grader.paths = paths;
    if (raw.in !== undefined) {
      const v = requireString(file, `${at}.in`, raw.in);
      if (v !== "final" && v !== "tool_result" && v !== "any") {
        throw new CaseError(file, `${at}.in`, "只能是 final / tool_result / any");
      }
      grader.in = v;
    }
    if (raw.exists !== undefined) {
      if (typeof raw.exists !== "boolean") throw new CaseError(file, `${at}.exists`, "必须是布尔值");
      grader.exists = raw.exists;
    }
    if (raw.tool !== undefined) grader.tool = requireString(file, `${at}.tool`, raw.tool);
    if (raw.times !== undefined) {
      if (typeof raw.times !== "number" || !Number.isInteger(raw.times) || raw.times < 0) {
        throw new CaseError(file, `${at}.times`, "必须是非负整数");
      }
      grader.times = raw.times;
    }
    const maxValue = raw.max ?? raw.value;
    if (type === "max_rounds") {
      const n = typeof maxValue === "number" ? maxValue : Number(maxValue);
      if (!Number.isInteger(n) || n <= 0) throw new CaseError(file, `${at}.value`, "max_rounds 需要正整数");
      grader.max = n;
    }
    if (raw.expect !== undefined) {
      const v = requireString(file, `${at}.expect`, raw.expect);
      if (v !== "allowed" && v !== "denied") throw new CaseError(file, `${at}.expect`, "只能是 allowed / denied");
      grader.expect = v;
    }
    if (raw.rubric !== undefined) grader.rubric = requireString(file, `${at}.rubric`, raw.rubric);
    return grader;
  });
}

function parseCase(file: string, raw: unknown): EvalCase {
  if (!isRecord(raw)) throw new CaseError(file, "（根）", "必须是一个 YAML 映射");
  const id = requireString(file, "id", raw.id);
  const name = requireString(file, "name", raw.name);
  const owner = requireString(file, "owner", raw.owner);
  const tagsRaw = raw.tags;
  if (!Array.isArray(tagsRaw) || tagsRaw.length === 0 || !tagsRaw.every((t) => typeof t === "string")) {
    throw new CaseError(file, "tags", "必须是非空字符串数组");
  }

  const setupRaw = raw.setup;
  if (setupRaw !== undefined && !isRecord(setupRaw)) throw new CaseError(file, "setup", "必须是对象");
  const setup = setupRaw
    ? (() => {
        const s = setupRaw as Record<string, unknown>;
        const fixture = optionalString(file, "setup.fixture", s.fixture);
        const outOfRoot = s.outOfRoot === undefined ? undefined : requireString(file, "setup.outOfRoot", s.outOfRoot);
        if (outOfRoot !== undefined && !OUT_OF_ROOT.includes(outOfRoot as (typeof OUT_OF_ROOT)[number])) {
          throw new CaseError(file, "setup.outOfRoot", "只能是 ask / reject");
        }
        let roots: { path: string; mode: "read" | "write"; name?: string }[] | undefined;
        if (s.roots !== undefined) {
          if (!Array.isArray(s.roots) || s.roots.length === 0) throw new CaseError(file, "setup.roots", "必须是非空数组");
          roots = s.roots.map((r, i) => {
            const at = `setup.roots[${i}]`;
            if (!isRecord(r)) throw new CaseError(file, at, "必须是对象");
            const p = requireString(file, `${at}.path`, r.path);
            const mode = requireString(file, `${at}.mode`, r.mode);
            if (!ROOT_MODES.includes(mode as (typeof ROOT_MODES)[number])) {
              throw new CaseError(file, `${at}.mode`, "只能是 read / write");
            }
            const rootName = optionalString(file, `${at}.name`, r.name);
            return { path: p, mode: mode as "read" | "write", ...(rootName ? { name: rootName } : {}) };
          });
        }
        return {
          ...(fixture ? { fixture } : {}),
          ...(roots ? { roots } : {}),
          ...(outOfRoot ? { outOfRoot: outOfRoot as "ask" | "reject" } : {}),
        };
      })()
    : {};

  const prompt = optionalString(file, "prompt", raw.prompt);
  const script = parseScript(file, "script", raw.script);

  let steps: EvalCase["steps"];
  if (raw.steps !== undefined) {
    if (!Array.isArray(raw.steps) || raw.steps.length === 0) throw new CaseError(file, "steps", "必须是非空数组");
    steps = raw.steps.map((step, i) => {
      const at = `steps[${i}]`;
      if (!isRecord(step)) throw new CaseError(file, at, "必须是对象");
      const stepPrompt = requireString(file, `${at}.prompt`, step.prompt);
      const stepScript = parseScript(file, `${at}.script`, step.script);
      return { prompt: stepPrompt, ...(stepScript ? { script: stepScript } : {}) };
    });
  }
  // 顶层 script 在 `steps` 用例里是**最后一步的兜底脚本**（ctx-001 就是这种写法：
  // 前两步各自带 script，第三步只写 prompt，答案放在顶层 script）。所以两者都保留。
  if (!steps && !prompt) throw new CaseError(file, "prompt", "单步用例必须写 prompt");
  if (!steps && !script) throw new CaseError(file, "script", "单步用例必须写 script（确定性模式没有真实模型）");

  const fakeToolsRaw = raw.fake_tools;
  let fakeTools: EvalCase["fake_tools"];
  if (fakeToolsRaw !== undefined) {
    if (!Array.isArray(fakeToolsRaw) || fakeToolsRaw.length === 0) {
      throw new CaseError(file, "fake_tools", "必须是非空数组");
    }
    fakeTools = fakeToolsRaw.map((t, i) => {
      const at = `fake_tools[${i}]`;
      if (!isRecord(t)) throw new CaseError(file, at, "必须是对象");
      const toolName = requireString(file, `${at}.name`, t.name);
      const resultRaw = t.result;
      if (resultRaw !== undefined && !isRecord(resultRaw)) throw new CaseError(file, `${at}.result`, "必须是对象");
      const result = resultRaw as Record<string, unknown> | undefined;
      const text = result ? optionalString(file, `${at}.result.text`, result.text) : undefined;
      let ok: boolean | undefined;
      if (result && result.ok !== undefined) {
        if (typeof result.ok !== "boolean") throw new CaseError(file, `${at}.result.ok`, "必须是布尔值");
        ok = result.ok;
      }
      return { name: toolName, result: { ...(text ? { text } : {}), ...(ok !== undefined ? { ok } : {}) } };
    });
  }

  const usageRaw = raw.usage;
  let usage: EvalCase["usage"];
  if (usageRaw !== undefined) {
    if (!isRecord(usageRaw)) throw new CaseError(file, "usage", "必须是对象");
    const u = usageRaw as Record<string, unknown>;
    const pickNumber = (key: string) => {
      const v = u[key];
      if (v === undefined) return undefined;
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
        throw new CaseError(file, `usage.${key}`, "必须是非负数字");
      }
      return Math.floor(v);
    };
    usage = {
      ...(pickNumber("input") !== undefined ? { input: pickNumber("input") } : {}),
      ...(pickNumber("output") !== undefined ? { output: pickNumber("output") } : {}),
      ...(pickNumber("cacheRead") !== undefined ? { cacheRead: pickNumber("cacheRead") } : {}),
      ...(pickNumber("cacheWrite") !== undefined ? { cacheWrite: pickNumber("cacheWrite") } : {}),
    };
  }

  return {
    id,
    name,
    owner,
    tags: tagsRaw as string[],
    setup,
    ...(prompt ? { prompt } : {}),
    ...(script ? { script } : {}),
    ...(steps ? { steps } : {}),
    ...(fakeTools ? { fake_tools: fakeTools } : {}),
    ...(usage ? { usage } : {}),
    graders: parseGraders(file, raw.graders),
    file,
  };
}

/** 载入目录下全部 `*.yaml` / `*.yml`，按 id 排序（保证多次运行顺序一致）。 */
export async function loadCases(casesDir: string, filter?: string): Promise<EvalCase[]> {
  const entries = await readdir(casesDir, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && /\.ya?ml$/i.test(e.name))
    .map((e) => path.join(casesDir, e.name))
    .sort();
  if (files.length === 0) throw new Error(`${casesDir} 下没有找到任何 *.yaml 用例`);

  const cases: EvalCase[] = [];
  const yaml = await yamlModule();
  for (const file of files) {
    const text = await readFile(file, "utf8");
    let raw: unknown;
    try {
      raw = yaml.load(text);
    } catch (e) {
      throw new Error(`${path.basename(file)}: YAML 解析失败：${e instanceof Error ? e.message : String(e)}`);
    }
    const parsed = parseCase(path.basename(file), raw);
    if (filter && !parsed.id.includes(filter)) continue;
    cases.push(parsed);
  }
  if (cases.length === 0) throw new Error(`没有用例匹配过滤条件「${filter}」`);

  const seen = new Set<string>();
  for (const c of cases) {
    if (seen.has(c.id)) throw new Error(`用例 id 重复：${c.id}`);
    seen.add(c.id);
    const expected = path.basename(c.file ?? "").replace(/\.ya?ml$/i, "");
    if (expected !== c.id) throw new Error(`${c.file}: id「${c.id}」与文件名「${expected}」不一致`);
  }

  return cases.sort((a, b) => a.id.localeCompare(b.id));
}
