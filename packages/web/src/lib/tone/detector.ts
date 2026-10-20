/**
 * 去 AI 味检测器 —— 把规则集变成可执行的算子。
 *
 * 移植自 [lieflat-less-ai-tone](https://github.com/larashero3-dotcom/lieflat-less-ai-tone)
 * 的 SKILL.md 与 `scripts/*.py`（MIT License）。
 *
 * **为什么要有检测器而不只是提示词**：
 * 上游的核心方法论是「白名单式改写」——只能改规则清单内的 11 项，
 * 没命中任何规则的句子必须逐字保留。这条约束靠提示词是守不住的：
 * 模型一上手就会"顺便润色"。而每条规则都有**可定位的触发标记**，
 * 于是可以先用算子把「哪里命中了哪条规则」算清楚，改写范围自然被框死。
 *
 * **统计依据**（上游 283 万字对照语料，R = 生成侧频率 ÷ 人类侧频率）：
 * R ≥ 2.0 纳入；1.25 ≤ R < 2.0 条件纳入；R < 1.25 无区分力。
 * 区分力最强的两项是「段首零回指评论」(4.4×) 与「拟人化喻体」(7.3×)。
 *
 * **重要**：有一批流行建议实测**站不住**，本检测器刻意不查它们——
 * 比喻（人类是 AI 的 2.4 倍）、正文设问（17 倍）、句长参差（0.87 无差异）、
 * 单字虚词偏少、句内同构排比、被动句、名词化。见 `NOT_A_TELLS`。
 * 查了它们会把文本改得**更不像人写的**。
 */

import { z } from "zod";

/** 规则编号 → 规则名（与上游 SKILL.md 的编号一致）。 */
export const TONE_RULES: Record<number, string> = {
  1: "翻案腔（不是 A 而是 B）",
  2: "顿号罗列过密",
  3: "相邻句结构同款",
  4: "破折号滥用",
  5: "冒号滥用",
  6: "序数词当小标题",
  7: "拟人化喻体",
  8: "把已有的具体数据写回概括表述",
  9: "禁用起手式",
  10: "翻译腔（只保留五种）",
  11: "段首零主语评论",
};

/**
 * 明确**不查**的特征及原因（上游实测结论）。
 *
 * 这一张表和「要查的」一样重要：删掉它，模型会按流行建议去改
 * 比喻、设问、句长——那会把文本改得更不像人写的。
 */
export const NOT_A_TELLS: { feature: string; why: string }[] = [
  { feature: "句长、段落长度不够参差", why: "实测与人类写作无差别（R=0.87）" },
  { feature: "单字虚词偏少（就/很/了）", why: "方向是补不是删，且无法验收" },
  { feature: "反复写全称、少用代词", why: "人类比 AI 更常重复同一名词" },
  { feature: "被动句（抽象被动）", why: "远低于收录门槛" },
  { feature: "名词化、长句本身", why: "现代汉语书面语的正常写法" },
  { feature: "正文里的「首先……其次」", why: "与人类写作无差别；第 6 条只管小标题编号" },
  { feature: "句内同构排比", why: "人类用得不比 AI 少；只处理句间重复" },
  { feature: "问句、设问、问句小标题", why: "正文问句人类远多于 AI（17 倍）" },
  { feature: "比喻本身、比喻独立成段", why: "人类用得比 AI 多（2.4 倍）；只处理理想化拟人喻体" },
  { feature: "抽象名词配具体动词", why: "两边都几乎不写" },
];

/** 一处命中。 */
export interface ToneHit {
  /** 规则编号（对应上游 SKILL.md 的 11 条）。 */
  rule: number;
  /** 规则名。 */
  name: string;
  /** 命中的原文片段（截断后）。 */
  excerpt: string;
  /** 在原文中的起始下标。 */
  index: number;
  /** 命中所在的行号（0 起）。 */
  line: number;
}

/** 检测结果。 */
export interface ToneReport {
  /** 全部命中。 */
  hits: ToneHit[];
  /** 按规则编号分组的命中数。 */
  byRule: Record<number, number>;
  /** 文本里的汉字数（用于密度判断）。 */
  chars: number;
  /** 每千字的命中数。 */
  perKilo: number;
  /** 总体判断：干净 / 有痕迹 / 痕迹明显。 */
  verdict: "clean" | "some" | "many";
}

/* ------------------------------------------------------------------ 算子 */

/** 一条规则：正则 + 说明。 */
interface Operator {
  rule: number;
  name: string;
  /** 命中即记一条。 */
  re: RegExp;
  /** 该规则是否只在小标题/标题行生效（规则 6）。 */
  headingOnly?: boolean;
  /** 全局匹配的辅助正则（需要跨行上下文时用）。 */
}

/**
 * 算子定义。
 *
 * 正则大多沿用上游 `scripts/check-translationese.py` 与 `check-structure.py` 的实现，
 * 但**收紧了匹配范围**：上游的宽正则（如任意汉字 + 冒号）会把标题、列表、
 * 对话一并算进来，导致测量失误——上游自己记录了六次这类失误。
 */
const OPERATORS: Operator[] = [
  {
    rule: 1,
    name: "翻案腔（不是 A 而是 B）",
    // 已知句式：不是…而是 / 并非…而是 / 不在…而在 / 与其说…不如说 / 看似…实则
    //
    // 注意「与其说 A，不如说 B」中间是**逗号**，所以前半段不能排除逗号，
    // 否则这条最典型的句式反而匹配不上（实测踩过）。
    re: /(不是|并非|不在于)[^，。；！？\n]{1,20}?(而是|而在|，而)|与其说[^；！？\n]{1,25}?不如说|表面[^；！？\n]{1,20}实际|看似[^；！？\n]{1,20}实则|(不是|并非)[^，。；！？\n]{1,10}[，、]\s*(是|而是)/,
  },
  {
    rule: 4,
    name: "破折号滥用",
    re: /——/,
  },
  {
    rule: 5,
    name: "冒号滥用",
    // 只匹配「提示语 + 冒号」，与上游 BASELINE 的收窄口径一致。
    // 句中冒号（总说加分说）人类内部差异过大，不查。
    re: /(一句话(?:总结|说|概括)|简单说|说白了|总结|小结|结论|核心(?:是|在于|观点)|关键(?:是|在于)|重点(?:是)|原因(?:如下|有|在于)|问题(?:是|在于)|答案(?:是)|本质(?:是|上)|定义(?:是)|具体(?:来说|如下|包括)|举例(?:来说)?|换句话说|也就是说|我的(?:观点|判断|结论)|建议(?:是)?)[：:]/,
  },
  {
    rule: 7,
    name: "拟人化喻体",
    // 上游触发标记：「像／相当于 + 一(个|位) + 职业角色」**且**（带褒义修饰 或 后接「不仅…更…」）。
    //
    // 「且」这个条件不能省：「像一个老师傅」是具体的人当喻体，人类就这么写（上游明确列为不改）。
    // 少了它就会把「老师」「朋友」这类普通词误报成拟人化喻体。
    re: /(?:像|相当于)(?:是)?一[个位名](?:永不|永远)?(?:.{0,4})?(?:智慧的|全能的|不知疲倦的|永不疲倦的|贴身的|贴心的|勤劳的)(?:导师|秘书|助手|顾问|管家|审查员|实习生|专家|老师|朋友|伙伴|搭档)|(?:像|相当于)(?:是)?一[个位名](?:.{0,6})?(?:导师|秘书|助手|顾问|管家|审查员|实习生|专家|老师|朋友|伙伴|搭档)[^。！？\n]{0,20}不仅[^。！？\n]{0,20}更/,
  },
  {
    rule: 9,
    name: "禁用起手式",
    // 起手式在句首。用 (?:^|\n) 而不是 ^，配合 m 标志才能覆盖非首行——
    // 但非首行的起手式也是起手式（每段开头都算）。
    re: /(?:^|\n)\s*(说白了|说穿了|先说结论)[，,、]/,
  },
  {
    rule: 10,
    name: "翻译腔（只保留五种）",
    // 只保留上游实测通过的 5 种：长前置定语 / 当…时从句 / 前置话题壳 / 句首连接词 / 这意味着式复述
    re: /(?:一个|一种|一套|这种|这个)[^，。、；：！？\n]{15,}的[一-鿿]{2,5}|的[^，。\n]{1,8}的[^，。\n]{1,8}的|当[^，。\n]{2,25}时，|(?:对于[^，。\n]{2,15}来说|对[^，。\n]{2,15}而言|就[^，。\n]{2,15}而言|在[^，。\n]{2,12}方面)|(?:^|\n)\s*(?:然而|因此|此外|与此同时|换言之|总而言之)[，、]|(这意味着|这表明|这说明|换句话说)/,
  },
  {
    rule: 11,
    name: "段首零主语评论",
    // 非首段以评论语开头，且整句没有回指成分
    re: /(?:^|\n)\s*(听起来|看起来|说白了|值得注意的是|更重要的是|关键在于|问题在于|不难看出)[^这那其此上][^\n]{0,40}/,
  },
];

/** 规则 2：顿号串起三项以上并列（一个分句内两个以上顿号）。 */
const DUNHAO_RE = /[^，。；！？\n]{0,30}、[^，。；！？\n]{0,30}、[^，。；！？\n]{0,30}/;

/** 规则 6：序数词当小标题（`#` 开头或独立成行的加粗文本），连续三个以上。 */
const HEADING_ORD_RE = /^(?:#{1,6}\s*|\*\*)([一二三四五六七八九十]+、|第[一二三四五六七八九十]+[，,、])/;

/** 规则 8：概括表述盖住已有具体数据。 */
const VAGUE_RE = /(显著提升|大幅增长|明显改善|显著改善|大幅提升|明显提升|效率的提升|数量的大幅|大量|众多|极大地)/;

/** 数字/时间/对象等具体材料。 */
const CONCRETE_RE = /\d|[一二三四五六七八九十百千万亿两]+\s*(个|次|天|小时|分钟|秒|人|元|块|倍|%|％)|\d{1,4}[年月份日]/;

/** 规则 10 里「当…时」的收窄：需以「时，」收尾且中间是完整主谓。 */
const WHEN_CLAUSE_RE = /当[^，。\n]{2,30}时，/;

/* ------------------------------------------------------------------ 检测 */

/** 统计行号索引。 */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

/** 二分查找：下标所在的行号（0 起）。 */
function lineOf(starts: number[], index: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** 截断片段用于展示。 */
function excerptAt(text: string, index: number, length: number): string {
  const from = Math.max(0, index - 8);
  const to = Math.min(text.length, index + length + 8);
  return text.slice(from, to).replace(/\n/g, " ").trim();
}

/** 检测文本里的 AI 痕迹。 */
export function detectAiTone(text: string): ToneReport {
  const source = String(text ?? "");
  const starts = lineStarts(source);
  const hits: ToneHit[] = [];

  const push = (rule: number, index: number, length: number) => {
    hits.push({
      rule,
      name: TONE_RULES[rule],
      excerpt: excerptAt(source, index, length),
      index,
      line: lineOf(starts, index),
    });
  };

  // —— 逐条算子 ——
  for (const op of OPERATORS) {
    const re = new RegExp(op.re.source, op.re.flags.includes("g") ? op.re.flags : `${op.re.flags}g`);
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      push(op.rule, m.index, m[0].length);
    }
  }

  // —— 规则 2：顿号串三项以上 ——
  {
    const re = new RegExp(DUNHAO_RE.source, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      push(2, m.index, m[0].length);
    }
  }

  // —— 规则 6：小标题序数词编号（需连续三个以上才成立）——
  {
    const lines = source.split("\n");
    let offset = 0;
    const numbered: { index: number; len: number }[] = [];
    for (const line of lines) {
      const m = HEADING_ORD_RE.exec(line);
      if (m) numbered.push({ index: offset, len: m[0].length });
      offset += line.length + 1;
    }
    // 连续三个以上（允许中间夹一两个非编号行——通篇编号常在章节间出现）
    let run = 0;
    for (const n of numbered) {
      run++;
      if (run >= 3) push(6, n.index, n.len);
    }
  }

  // —— 规则 8：概括表述盖住同段已有的具体数据 ——
  {
    const re = new RegExp(VAGUE_RE.source, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      // 看同段（前后各一段）里有没有具体材料
      const paraStart = source.lastIndexOf("\n\n", m.index) + 2;
      const paraEnd = source.indexOf("\n\n", m.index + m[0].length);
      const para = source.slice(paraStart, paraEnd < 0 ? source.length : paraEnd);
      if (CONCRETE_RE.test(para)) push(8, m.index, m[0].length);
    }
  }

  // —— 规则 3：相邻句结构同款（连续两句：逗号数相同 + 长度接近）——
  {
    const sentences = source
      .split(/(?<=[。！？；])/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 6);
    let offset = 0;
    for (let i = 0; i < sentences.length - 1; i++) {
      const a = sentences[i];
      const b = sentences[i + 1];
      const commasA = (a.match(/[，,]/g) ?? []).length;
      const commasB = (b.match(/[，,]/g) ?? []).length;
      const lenDiff = Math.abs(a.length - b.length);
      // 逗号数相同、长度接近、且都不是短句
      if (commasA > 0 && commasA === commasB && lenDiff <= Math.max(6, a.length * 0.25)) {
        push(3, source.indexOf(a, offset), a.length);
      }
      offset += a.length;
    }
  }

  // —— 规则 10 细分：把「当…时」从句与其它翻译腔分开标记 ——
  // （上面的 OPERATORS 已用一个大正则覆盖，这里不重复计）

  // —— 排序与去重 ——
  hits.sort((x, y) => x.index - y.index || x.rule - y.rule);

  const byRule: Record<number, number> = {};
  for (const h of hits) byRule[h.rule] = (byRule[h.rule] ?? 0) + 1;

  const chars = (source.match(/[一-鿿]/g) ?? []).length;
  const perKilo = chars > 0 ? (hits.length / chars) * 1000 : 0;
  const verdict: ToneReport["verdict"] =
    hits.length === 0 ? "clean" : perKilo > 12 ? "many" : "some";

  return { hits, byRule, chars, perKilo, verdict };
}

/** 规则 10 的「当…时」单独检测（供需要细分时使用）。 */
export function detectWhenClauses(text: string): ToneHit[] {
  const source = String(text ?? "");
  const starts = lineStarts(source);
  const re = new RegExp(WHEN_CLAUSE_RE.source, "g");
  const out: ToneHit[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    out.push({
      rule: 10,
      name: TONE_RULES[10],
      excerpt: excerptAt(source, m.index, m[0].length),
      index: m.index,
      line: lineOf(starts, m.index),
    });
  }
  return out;
}

/* ------------------------------------------------------------------ 工具 */

const TextBody = z.object({
  text: z.string().max(200_000),
});

/**
 * 工具实现：把检测结果整理成给模型看的报告。
 *
 * 输出要**指明规则编号与原文位置**——模型据此改写，改完能自查。
 * 同时明确列出「不查什么」，免得模型按流行建议乱改。
 */
export function runToneDetect(raw: string): string {
  const parsed = TextBody.safeParse({ text: raw });
  if (!parsed.success) {
    return "文本不合法或过长（上限 20 万字符）。";
  }
  const report = detectAiTone(parsed.data.text);

  const lines: string[] = [];
  if (report.hits.length === 0) {
    lines.push(
      "未命中任何规则：这篇文字没有可定位的 AI 痕迹。",
      "",
      "按白名单原则，这意味着**不要改写**——没有命中规则的句子必须逐字保留。",
    );
    return lines.join("\n");
  }

  lines.push(
    `命中 ${report.hits.length} 处（${report.chars} 汉字，密度 ${report.perKilo.toFixed(1)} 处/千字）。`,
    "",
  );
  for (const [rule, count] of Object.entries(report.byRule)) {
    const id = Number(rule);
    lines.push(`- 第 ${id} 条 ${TONE_RULES[id]}：${count} 处`);
  }
  lines.push("", "具体位置：");
  for (const h of report.hits.slice(0, 40)) {
    lines.push(`  [第${h.rule}条 · 第${h.line + 1}行] 「${h.excerpt}」`);
  }
  if (report.hits.length > 40) {
    lines.push(`  …… 另有 ${report.hits.length - 40} 处未列出`);
  }
  lines.push(
    "",
    "改写要求：",
    "1. 只改上面列出的位置，且只改解决该问题所必需的最小范围。",
    "2. 未命中的文字逐字保留；不增删信息、不改文章框架（标题层级/章节顺序/列表/表格/引用/代码块位置）。",
    "3. 改完自检：每处改动都能指出对应规则编号，每个实词都能在原文指出出处。",
  );
  return lines.join("\n");
}

/** 工具声明。 */
export const TONE_DETECT_TOOL = {
  name: "tone_detect",
  description: [
    "检测文本里的 AI 写作痕迹，给出命中位置与对应规则编号。",
    "基于 283 万字人类/生成语料对照统计得出的 11 条可定位规则。",
    "改写前先调用它：命中位置就是允许改写的范围，没命中的文字必须逐字保留。",
    "注意：比喻、正文设问、句长参差、被动句、名词化**不是** AI 痕迹（实测人类用得更多），",
    "不要以这些理由改写——本工具刻意不查它们。",
  ].join(""),
  parameters: {
    type: "object" as const,
    properties: {
      text: { type: "string" as const, description: "待检测的文本" },
    },
    required: ["text"],
  },
};
