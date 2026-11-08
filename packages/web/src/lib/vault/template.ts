/**
 * 笔记模板渲染（`templates/*.md` 与日记模板共用）。
 *
 * 支持的是 Obsidian 模板变量的一个**小子集**——刻意不做完整模板引擎：
 * - `{{title}}` 笔记标题；
 * - `{{date}}` / `{{time}}` 日期与时间（默认 `YYYY-MM-DD` / `HH:mm`）；
 * - `{{vault}}` 库名；
 * - `{{date:FORMAT}}` 自定义格式，只认 Y/M/D/H/m/s 六种字母（连续出现即补零位数）。
 *
 * 未知占位符**原样保留**并在 `unknown` 里回报：模板里写错变量时用户能看见
 * （而不是被静默替换成空串），界面可以据此提示。
 *
 * 全部纯函数：时间由调用方传入（`applyTemplate` 的 `now` 缺省才取当前时间），
 * 同一输入同一输出。
 */

/** 模板变量。 */
export interface TemplateVars {
  /** 笔记标题（`{{title}}`）。 */
  title?: string;
  /** 渲染基准时间（`{{date}}` / `{{time}}` / `{{date:FORMAT}}`）。 */
  date?: Date;
  /** 库名（`{{vault}}`）。 */
  vault?: string;
}

/** 渲染结果：正文 + 未被识别的占位符（原样保留）。 */
export interface RenderTemplateResult {
  text: string;
  /** 未识别的占位符（去重、按出现顺序；不含花括号）。 */
  unknown: string[];
}

/** 默认日期格式。 */
export const DEFAULT_DATE_FORMAT = "YYYY-MM-DD";
/** 默认时间格式。 */
export const DEFAULT_TIME_FORMAT = "HH:mm";

/** 非法的 Date 统一按本地 1970-01-01 00:00:00 处理（不随系统时区漂移）。 */
function validDate(value: Date | undefined): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  return new Date(1970, 0, 1, 0, 0, 0);
}

function pad(value: number, length: number): string {
  return String(value).padStart(length, "0");
}

/**
 * 按模板格式渲染日期。
 *
 * 格式里除 Y/M/D/H/m/s 之外的字符原样输出（所以 `YYYY年MM月DD日` 可用）；
 * 连续同一字母算一个 token：`M` 不补零、`MM` 补两位，`YYYY` 四位、`YY` 两位。
 */
export function formatDateTokens(date: Date, format: string): string {
  const value = validDate(date);
  const source = String(format ?? "");
  return source.replace(/Y{1,4}|M{1,2}|D{1,2}|H{1,2}|m{1,2}|s{1,2}/g, (token) => {
    const length = token.length;
    switch (token[0]) {
      case "Y": {
        const year = value.getFullYear();
        if (length === 2) return pad(year % 100, 2);
        if (length >= 3) return pad(year, 4);
        return String(year);
      }
      case "M":
        return length >= 2 ? pad(value.getMonth() + 1, 2) : String(value.getMonth() + 1);
      case "D":
        return length >= 2 ? pad(value.getDate(), 2) : String(value.getDate());
      case "H":
        return length >= 2 ? pad(value.getHours(), 2) : String(value.getHours());
      case "m":
        return length >= 2 ? pad(value.getMinutes(), 2) : String(value.getMinutes());
      case "s":
        return length >= 2 ? pad(value.getSeconds(), 2) : String(value.getSeconds());
      default:
        return token;
    }
  });
}

/**
 * 渲染模板正文。
 *
 * 占位符语法：`{{ name }}`（花括号内允许空格，不允许换行）。
 * 未知名字保持原样，并记进 `unknown`（同一名字只报一次）。
 */
export function renderTemplate(text: string, vars: TemplateVars = {}): RenderTemplateResult {
  const source = String(text ?? "");
  const date = validDate(vars.date);
  const title = String(vars.title ?? "");
  const vault = String(vars.vault ?? "");
  const unknown: string[] = [];
  const seenUnknown = new Set<string>();

  const rendered = source.replace(/\{\{\s*([^{}\n]*?)\s*\}\}/g, (whole: string, rawName: string) => {
    const name = rawName.trim();
    if (!name) return whole;
    const lower = name.toLowerCase();
    if (lower === "title") return title;
    if (lower === "date") return formatDateTokens(date, DEFAULT_DATE_FORMAT);
    if (lower === "time") return formatDateTokens(date, DEFAULT_TIME_FORMAT);
    if (lower === "vault") return vault;
    if (lower.startsWith("date:")) {
      const format = name.slice(name.indexOf(":") + 1).trim();
      return formatDateTokens(date, format || DEFAULT_DATE_FORMAT);
    }
    if (!seenUnknown.has(name)) {
      seenUnknown.add(name);
      unknown.push(name);
    }
    return whole;
  });

  return { text: rendered, unknown };
}

/** `applyTemplate` 的入参。 */
export interface ApplyTemplateOptions {
  /** 模板原文。 */
  template: string;
  /** 新笔记标题。 */
  title: string;
  /** 渲染基准时间（缺省取当前时间；测试传固定值保证确定性）。 */
  now?: Date;
  /** 库名。 */
  vaultName?: string;
}

/**
 * 把模板渲染成新笔记正文（W3 新建笔记/日记用）。
 *
 * 只返回字符串：未知占位符已按原样保留，界面不需要为它分叉；
 * 需要展示「哪些变量不认识」时用 `renderTemplate` 拿 `unknown`。
 */
export function applyTemplate(options: ApplyTemplateOptions): string {
  const template = String(options?.template ?? "");
  return renderTemplate(template, {
    title: String(options?.title ?? ""),
    date: options?.now ?? new Date(),
    vault: String(options?.vaultName ?? ""),
  }).text;
}
