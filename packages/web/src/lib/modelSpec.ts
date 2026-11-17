/**
 * `magpie model spec <provider/model>` 的只读输出。
 *
 * 原版 magpie 的 Model settings 打开时显示的就是「现在生效的值，以及它是你设的还是厂商清单给的」——
 * 我们照它做，让编辑器一开始就是真实状态，而不是照网关目录猜一遍：
 *
 *   deepseek/deepseek-flash
 *     context    1048576            the vendor's list / models.dev
 *     max output 393216             the vendor's list / models.dev
 *     vision     on                 the vendor's list / models.dev
 *     reasoning  none,low,high,max  the vendor's list / models.dev
 *
 * 用户自己设过的行，第三列以 `yours` 开头（`yours · --context auto goes back to the vendor's list`、
 * `yours for every model of <provider>`）；两边都不知道时是
 * `neither the vendor's list nor models.dev says · --<flag> sets it`。
 */

/** 一项规格：现在生效的值，以及它是不是用户自己设的。 */
export interface ModelSpecValue {
  value: string;
  yours: boolean;
}

export interface ModelSpec {
  context?: ModelSpecValue;
  output?: ModelSpecValue;
  vision?: ModelSpecValue;
  reasoning?: ModelSpecValue;
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

const LABELS: Record<string, keyof ModelSpec> = {
  context: "context",
  "max output": "output",
  vision: "vision",
  reasoning: "reasoning",
};

/** 解析 `model spec <p/m>` 的四项；只认带两个以上空格缩进、且有值列的规格行。 */
export function parseModelSpec(raw: string): ModelSpec {
  const text = raw.replace(ANSI, "");
  const spec: ModelSpec = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s{2,}(context|max output|vision|reasoning)\s+(\S+)\s{2,}(.*)$/.exec(line);
    if (!match) continue;
    const key = LABELS[match[1]!];
    if (!key) continue;
    spec[key] = { value: match[2]!, yours: /^yours\b/i.test(match[3]!.trim()) };
  }
  return spec;
}

/** 规格里是否有任何一项（用来判断「读到东西了没有」）。 */
export function specHasValues(spec: ModelSpec): boolean {
  return Boolean(spec.context || spec.output || spec.vision || spec.reasoning);
}

/**
 * 把读到的规格变成编辑器草稿：思考档 `off` 表示「不发 reasoning 字段」，图片 `on`/`off`。
 * 一项都没读到就返回 null（调用方保持现有草稿）。
 */
export function specDraft(spec: ModelSpec): {
  context: string;
  output: string;
  efforts: string;
  vision: boolean;
} | null {
  if (!specHasValues(spec)) return null;
  const reasoning = spec.reasoning?.value ?? "";
  return {
    context: spec.context?.value ?? "",
    output: spec.output?.value ?? "",
    efforts: reasoning === "off" ? "" : reasoning,
    vision: (spec.vision?.value ?? "").toLowerCase() === "on",
  };
}

/** 哪几项是用户自己设的（用来在字段下面写一句「你自己设的」）。 */
export function specFieldsOfYours(spec: ModelSpec): string[] {
  const out: string[] = [];
  if (spec.context?.yours) out.push("窗口");
  if (spec.output?.yours) out.push("最大输出");
  if (spec.vision?.yours) out.push("图片输入");
  if (spec.reasoning?.yours) out.push("思考档");
  return out;
}
