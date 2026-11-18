/**
 * 工作区自定义子代理（d.287）：`.heming/agents/<名字>.md` 里的额外要求，派活时用 `agent` 点名。
 *
 * 为什么做：`agent_task`（d.162）只有一个通用人设——「查清楚再给结论」。
 * 但团队真正反复要的是**带着立场**去查：「安全审查」要按威胁模型逐条对、
 * 「性能排查」要先问数据规模再猜瓶颈、「文档校对」只挑与代码不一致的地方。
 * 这些要求此前只能每次塞进 task 文本（占主对话 token，还容易漏），
 * 或者写进 AGENTS.md（那是**每轮都发**的约定，代价更大）。
 * codex / Claude Code 一类应用的做法是「把角色定义存成文件，调用时点名」——这一版补上。
 *
 * 和自定义命令（`customCommands.ts`，d.240）同一套文件约定，学一次就够：
 * - **只认一个目录**：`.heming/agents/*.md`，不扫全仓、不猜别的扩展名。
 * - **文件名就是子代理名**：`review.md` → `agent: "review"`；名字只允许 `[a-z0-9-]`，
 *   因为这个名字要进工具的 `enum`，中文名会让模型照抄出错。
 * - **文件开头可选 `# 标题` 与紧随的 `> 说明`**（复用命令那边同一个拆分函数），其余全文是要求。
 * - 单文件封顶、总数封顶、同名取先读到的，坏文件跳过而不是让整批失效。
 *
 * 一条红线（写死在 `subagent.ts` 里，这里只提供文本）：
 * 定义**只能加严，不能放宽**——它不会给子代理多一件工具、多一轮预算、
 * 也不会把只读变成可写。写文件的人只能要求它「更严格地查」，要求不了「绕过限制」。
 */
import type { FileFsBridge } from "../fileEdit/bridge.js";
import type { FileRoot } from "../fileEdit/paths.js";
import { splitCommandFile } from "./customCommands.js";

/** 约定目录（相对工作区根，正斜杠）。 */
export const SUBAGENT_DEFS_DIR = ".heming/agents";
/** 一次最多认几个子代理定义：再多工具参数的 enum 会长到没人看。 */
export const MAX_SUBAGENT_DEFS = 20;
/** 单个定义的字符上限：定义是「一段角色要求」，不是长文档。 */
export const MAX_SUBAGENT_DEF_CHARS = 3000;
/** 子代理名（来自文件名，不含 `.md`）。 */
export const SUBAGENT_NAME_RE = /^[a-z][a-z0-9-]{0,29}$/;

export interface SubagentDefSource {
  /** 相对工作区的路径，例如 `.heming/agents/review.md`。 */
  rel: string;
  /** 文件全文。 */
  text: string;
}

export interface SubagentDef {
  /** 子代理名（`agent` 参数要传的就是它）。 */
  name: string;
  /** 标题：`# 标题` 那行，缺省用名字。 */
  title: string;
  /** 一行说明：`> 说明` 那行，缺省说明来源文件。 */
  hint: string;
  /** 追加到子代理系统提示里的额外要求（原文，超长时末尾写明截断）。 */
  instructions: string;
  /** 来源文件（相对工作区），用于「这份要求是哪来的」。 */
  rel: string;
  /** 是否因为超长被截断（截断处在正文末尾写明了）。 */
  truncated: boolean;
}

/** 从相对路径取子代理名：只看文件名、只要 `.md`。 */
export function subagentDefNameOf(rel: string): string | null {
  const file = rel.replace(/\\/g, "/").split("/").pop() ?? "";
  if (!file.toLowerCase().endsWith(".md")) return null;
  const name = file.slice(0, -3).toLowerCase();
  return SUBAGENT_NAME_RE.test(name) ? name : null;
}

/** 把一份文件解析成子代理定义；名字不合法 / 正文为空 → null（坏文件不该让整批失效）。 */
export function parseSubagentDef(source: SubagentDefSource): SubagentDef | null {
  const name = subagentDefNameOf(source.rel);
  if (name === null) return null;
  const { title, hint, body } = splitCommandFile(source.text);
  // 只有标题、没有要求 = 这份定义什么也没说，把它当成「不存在」比让子代理空转更诚实。
  if (body === "") return null;
  const truncated = body.length > MAX_SUBAGENT_DEF_CHARS;
  const instructions = truncated
    ? `${body.slice(0, MAX_SUBAGENT_DEF_CHARS)}\n\n（这份定义超过 ${MAX_SUBAGENT_DEF_CHARS} 字，只发了前面这些；需要完整内容请用 file_read 读 \`${source.rel}\`。）`
    : body;
  return {
    name,
    title: title ?? name,
    hint: hint ?? `自定义子代理（来自 ${source.rel}）`,
    instructions,
    rel: source.rel,
    truncated,
  };
}

/**
 * 解析整批定义：按路径排序保证结果稳定，同名取先读到的，超过上限的丢掉。
 *
 * 上限只影响「agent_task 的 enum 里列几个」，不影响已经点名的那个——调用方看 `length`。
 */
export function parseSubagentDefs(sources: readonly SubagentDefSource[]): SubagentDef[] {
  const sorted = [...sources].sort((a, b) => a.rel.localeCompare(b.rel));
  const out: SubagentDef[] = [];
  const seen = new Set<string>();
  for (const source of sorted) {
    const def = parseSubagentDef(source);
    if (def === null) continue;
    if (seen.has(def.name)) continue;
    seen.add(def.name);
    out.push(def);
    if (out.length >= MAX_SUBAGENT_DEFS) break;
  }
  return out;
}

/** 按名字找定义（模型传上来的可能是大写/带空白，这里统一小写比对）。 */
export function findSubagentDef(
  defs: readonly SubagentDef[],
  name: string | null | undefined,
): SubagentDef | null {
  const wanted = (name ?? "").trim().toLowerCase();
  if (!wanted) return null;
  return defs.find((def) => def.name === wanted) ?? null;
}

/** 拼给工具描述看的可用名字清单：`review（安全审查）、perf（性能）`；空列表返回空串。 */
export function describeSubagentDefs(defs: readonly SubagentDef[]): string {
  return defs.map((def) => `${def.name}（${def.title}）`).join("、");
}

const MAX_LISTED_FILES = MAX_SUBAGENT_DEFS;

/**
 * 从工作区读子代理定义。
 *
 * 读不到（没有桥 / 没有根 / 老桌面端没有 glob）一律返回空数组：
 * 自定义子代理是「锦上添花」，不能因为它让正常对话失败。
 */
export async function collectSubagentDefs(input: {
  bridge: FileFsBridge | null;
  roots: readonly FileRoot[];
}): Promise<SubagentDef[]> {
  const { bridge } = input;
  if (!bridge || !bridge.glob || input.roots.length === 0) return [];
  try {
    const found = await bridge.glob({
      roots: [...input.roots],
      pattern: `${SUBAGENT_DEFS_DIR}/*.md`,
    });
    if (!found.ok) return [];
    const files = found.paths.slice(0, MAX_LISTED_FILES);
    const sources: SubagentDefSource[] = [];
    for (const rel of files) {
      const res = await bridge.read({ roots: [...input.roots], path: rel });
      if (!res.ok) continue;
      sources.push({ rel, text: res.content });
    }
    return parseSubagentDefs(sources);
  } catch {
    return [];
  }
}
