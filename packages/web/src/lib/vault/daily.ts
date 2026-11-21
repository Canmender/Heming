/**
 * 日记（daily notes）的路径规则。
 *
 * 默认 `daily/YYYY-MM-DD.md`，文件夹与日期格式可在知识库设置里改。
 * 两个方向都要准：
 * - `dailyNotePath(config, date)`：日期 → 库内相对路径（「打开今天的日记」用）；
 * - `parseDailyPath(config, rel)`：路径 → 日期（列表/日历里反解某篇日记是哪天）。
 *
 * 非法配置**回退默认值并回报原因**（不静默、不抛错）：用户把格式写成
 * `YYYY/MM/DD` 时路径会变成多级目录、反解也对不上，必须明确告诉界面为什么回退。
 *
 * 纯函数：日期由调用方传入，按**本地时间**取年月日（与 `template.ts` 的格式化一致）。
 */

import { DEFAULT_DATE_FORMAT, formatDateTokens } from "./template.js";

/** 日记配置。 */
export interface DailyConfig {
  /** 日记文件夹（库内相对目录；空串 = 库根）。 */
  folder: string;
  /** 日期格式（Y/M/D/H/m/s 子集，必须含年/月/日才能反解）。 */
  format: string;
  /** 可选的日记模板路径（`templates/*.md`）。 */
  templatePath?: string;
}

/** 默认日记配置。 */
export const DEFAULT_DAILY_CONFIG: DailyConfig = {
  folder: "daily",
  format: DEFAULT_DATE_FORMAT,
};

/** 配置解析结果：`fallback` 为 true 时 `reason` 说明回退原因。 */
export interface ResolvedDailyConfig {
  config: DailyConfig;
  fallback: boolean;
  /** 中文原因（多个问题用「；」连接；无回退时为空串）。 */
  reason: string;
}

/** 路径/文件名里不允许的字符（Windows 与 Obsidian 的共同底线）。 */
const ILLEGAL_PATH_CHARS = /[\\/:*?"<>|\u0000-\u001f]/;

/** 单个路径段里不允许的字符（不含 `/`，因为 `/` 是段分隔符）。 */
const ILLEGAL_NAME_CHARS = /[\\:*?"<>|\u0000-\u001f]/;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeFolder(raw: unknown): { folder: string; reason: string } {
  if (raw === undefined || raw === null) return { folder: DEFAULT_DAILY_CONFIG.folder, reason: "" };
  if (typeof raw !== "string") {
    return {
      folder: DEFAULT_DAILY_CONFIG.folder,
      reason: "日记文件夹不是字符串，已回退为 daily",
    };
  }
  const text = raw.replace(/\\/g, "/").trim();
  if (!text) return { folder: "", reason: "" }; // 显式空串 = 库根，合法
  if (text.startsWith("/") || /^[A-Za-z]:/.test(text)) {
    return {
      folder: DEFAULT_DAILY_CONFIG.folder,
      reason: `日记文件夹必须是库内相对路径：${raw}`,
    };
  }
  const parts = text.split("/").filter(Boolean);
  for (const part of parts) {
    if (part === "." || part === "..") {
      return { folder: DEFAULT_DAILY_CONFIG.folder, reason: `日记文件夹不能包含 . 或 ..：${raw}` };
    }
    if (part.startsWith(".")) {
      return { folder: DEFAULT_DAILY_CONFIG.folder, reason: `日记文件夹不能是隐藏目录：${raw}` };
    }
    if (ILLEGAL_NAME_CHARS.test(part)) {
      return { folder: DEFAULT_DAILY_CONFIG.folder, reason: `日记文件夹包含非法字符：${raw}` };
    }
  }
  return { folder: parts.join("/"), reason: "" };
}

function normalizeTemplatePath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let text = raw.replace(/\\/g, "/").trim();
  while (text.startsWith("./")) text = text.slice(2);
  text = text.replace(/^\/+/, "");
  if (!text || text.length > 300) return null;
  if (/^[A-Za-z]:/.test(text)) return null;
  const parts = text.split("/");
  for (const part of parts) {
    if (!part || part === "." || part === "..") return null;
    if (part.startsWith(".")) return null;
    if (ILLEGAL_NAME_CHARS.test(part)) return null;
  }
  if (!/\.md$/i.test(text)) return null;
  return parts.join("/");
}

interface FormatPattern {
  regex: RegExp;
  /** 捕获组顺序（每个字母只捕获第一次出现）。 */
  order: string[];
  /** 年份用两位（`YY`）写出：反解时需把 0–99 扩成完整年份。 */
  shortYear: boolean;
}

/**
 * 两位年份的世纪分界：`YY` 只写下 `year % 100`（2026→"26"、1987→"87"），
 * 反解无法从两位数字唯一确定世纪，只能取一个固定分界（纯函数，不读时钟）。
 * 00–49 归 2000–2049，50–99 归 1950–1999：覆盖个人日记库实际可能出现的年代。
 */
const TWO_DIGIT_YEAR_PIVOT = 49;

/**
 * 把日期格式编译成正则：每个 Y/M/D/H/m/s 字母转成数字捕获组，其余字符按字面量。
 * 同一字母重复出现时后续只匹配不捕获（取值以第一次为准）。
 */
function buildFormatPattern(format: string): FormatPattern | null {
  if (!format) return null;
  const order: string[] = [];
  let shortYear = false;
  let source = "^";
  let index = 0;
  while (index < format.length) {
    const char = format[index];
    if ("YMDHms".includes(char)) {
      let run = 0;
      while (index + run < format.length && format[index + run] === char) run += 1;
      if (char === "Y" && run === 2) shortYear = true;
      let digitPattern: string;
      if (char === "Y") digitPattern = run >= 3 ? "\\d{4}" : run === 2 ? "\\d{2}" : "\\d{1,4}";
      else digitPattern = run >= 2 ? "\\d{2}" : "\\d{1,2}";
      if (order.includes(char)) source += `(?:${digitPattern})`;
      else {
        order.push(char);
        source += `(${digitPattern})`;
      }
      index += run;
      continue;
    }
    source += escapeRegExp(char);
    index += 1;
  }
  source += "$";
  try {
    return { regex: new RegExp(source), order, shortYear };
  } catch {
    return null;
  }
}

/**
 * 日期格式是否可用：必须含年/月/日（否则无法反解日期），且不能含路径非法字符。
 * 只做 Y/M/D/H/m/s 子集——`dddd`、`MMMM` 这类文本月份不支持。
 */
export function isValidDailyFormat(format: unknown): boolean {
  if (typeof format !== "string") return false;
  const text = format.trim();
  if (!text || text.length > 80) return false;
  if (ILLEGAL_PATH_CHARS.test(text)) return false;
  // 逐个 token 检查重复次数上限：Y ≤ 4，其余 ≤ 2。
  // 不能用 /Y{1,4}/ 这种未锚定的正则——它会匹配 5 个 Y 里的前 4 个，
  // 让 YYYYY 这类格式通过校验，但 formatDateTokens 会把 5 个 Y 渲成两段年份、
  // buildFormatPattern 只按 4 位解析，写出来的路径再也解析不回来（日记从此消失）。
  const tokenRe = /Y+|M+|D+|H+|m+|s+/g;
  const runs = text.match(tokenRe) ?? [];
  let hasY = false;
  let hasM = false;
  let hasD = false;
  for (const run of runs) {
    const max = run[0] === "Y" ? 4 : 2;
    if (run.length > max) return false;
    if (run[0] === "Y") hasY = true;
    else if (run[0] === "M") hasM = true;
    else if (run[0] === "D") hasD = true;
  }
  if (!hasY || !hasM || !hasD) return false;
  // 两个数字 token 直接相邻、又没有字面分隔符时，若其中一个是变长的
  // （单个 M/D/H/m/s 是 \d{1,2}，单个 Y 是 \d{1,4}），写出来的路径就无法
  // 唯一反解：如 YYYYMD 把 2026-01-18 写成 "2026118"，反解成 2026-11-08，
  // 日记被归到错误日期且再也找不回来。这类格式一律判非法、回退默认格式。
  // 定长 token（YY/YYYY/MM/DD/HH/mm/ss）相邻仍可唯一切分，不受影响。
  let previous: { end: number; variable: number } | null = null;
  for (let match = tokenRe.exec(text); match !== null; match = tokenRe.exec(text)) {
    const start = match.index;
    const run = match[0];
    const variable = (run[0] === "Y" && run.length === 1) || (run[0] !== "Y" && run.length === 1) ? 1 : 0;
    if (previous && previous.end === start && (previous.variable || variable)) return false;
    previous = { end: start + run.length, variable };
  }
  return buildFormatPattern(text) !== null;
}

/**
 * 解析日记配置：非法项回退默认值，并在 `reason` 里说明（中文）。
 * `folder` 显式空串表示库根（合法，不回退）。
 */
export function resolveDailyConfig(config?: Partial<DailyConfig> | null): ResolvedDailyConfig {
  const reasons: string[] = [];
  const folder = normalizeFolder(config?.folder);
  if (folder.reason) reasons.push(folder.reason);

  let format = DEFAULT_DAILY_CONFIG.format;
  const rawFormat = config?.format;
  if (rawFormat !== undefined && rawFormat !== null) {
    if (isValidDailyFormat(rawFormat)) format = String(rawFormat).trim();
    else {
      reasons.push(
        `日期格式不合法（${String(rawFormat)}），已回退为 ${DEFAULT_DAILY_CONFIG.format}`,
      );
    }
  }

  const resolved: DailyConfig = { folder: folder.folder, format };
  const rawTemplate = config?.templatePath;
  if (rawTemplate !== undefined && rawTemplate !== null) {
    const templatePath = normalizeTemplatePath(rawTemplate);
    if (templatePath) resolved.templatePath = templatePath;
    else reasons.push("日记模板路径不合法，已忽略");
  }

  return { config: resolved, fallback: reasons.length > 0, reason: reasons.join("；") };
}

/**
 * 日期 → 日记的库内相对路径。
 *
 * 例：默认配置 + 2026-11-08 → `daily/2026-11-08.md`。
 * 配置非法时静默用回退后的配置（需要原因就用 `resolveDailyConfig`）。
 */
export function dailyNotePath(
  config: Partial<DailyConfig> | null | undefined,
  date: Date,
): string {
  const { config: resolved } = resolveDailyConfig(config);
  const name = `${formatDateTokens(date, resolved.format)}.md`;
  return resolved.folder ? `${resolved.folder}/${name}` : name;
}

/**
 * 库内相对路径 → 日期（反解失败返回 null）。
 *
 * 只认 `folder/` 前缀 + 与 `format` 完全匹配的文件名；不存在的日期
 *（`2026-02-31`）也返回 null，而不是滚动到下个月。
 */
export function parseDailyPath(
  config: Partial<DailyConfig> | null | undefined,
  rel: string,
): Date | null {
  const { config: resolved } = resolveDailyConfig(config);
  let text = String(rel ?? "")
    .replace(/\\/g, "/")
    .trim();
  while (text.startsWith("./")) text = text.slice(2);
  text = text.replace(/^\/+/, "");
  if (!text) return null;

  const prefix = resolved.folder ? `${resolved.folder}/` : "";
  if (prefix && !text.startsWith(prefix)) return null;
  const name = prefix ? text.slice(prefix.length) : text;
  if (!name.endsWith(".md")) return null;
  const base = name.slice(0, -3);

  const pattern = buildFormatPattern(resolved.format);
  if (!pattern) return null;
  const match = pattern.regex.exec(base);
  if (!match) return null;

  const values = new Map<string, number>();
  pattern.order.forEach((letter, position) => {
    values.set(letter, Number(match[position + 1]));
  });
  let year = values.get("Y");
  if (year === undefined || !Number.isFinite(year)) return null;
  // JS 的 new Date(0..99, …) 会把年份映射到 1900+（26→1926），
  // 而 `YY` 格式写出的是 year%100，不还原就会让这类日记永远反解不出来。
  if (pattern.shortYear && year >= 0 && year <= 99) {
    year += year <= TWO_DIGIT_YEAR_PIVOT ? 2000 : 1900;
  }
  const month = values.get("M") ?? 1;
  const day = values.get("D") ?? 1;
  if (!Number.isFinite(month) || !Number.isFinite(day)) return null;

  const date = new Date(
    year,
    month - 1,
    day,
    values.get("H") ?? 0,
    values.get("m") ?? 0,
    values.get("s") ?? 0,
  );
  // 拒绝 2026-02-31 这种会被 Date 自动进位的日期
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return date;
}
