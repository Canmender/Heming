/**
 * 和鸣 5 段版本比较（插件 `engines.heming` 的唯一实现）。
 *
 * 为什么不能用 semver：和鸣的版本是 `d.特性.破坏性.修订.构建`（见 `docs/VERSION-MANAGEMENT.md`），
 * 不是 semver；`d.103.2.42.0` 拿 semver 解析只会得到一堆非法版本。插件清单却需要
 * 「这个插件要求宿主至少多新」——所以这里自定义一套**只做最小版本比较**的规则：
 *
 * - 只支持「最小版本」语义（`>=`）：`engines.heming: "d.103"` 表示「需要 d.103 或更新」。
 *   明确不支持 semver range（`^`/`~`/`x`/`||`）：区间语法会带来解析歧义与测试面，
 *   而插件真正需要的只有「最低宿主版本」这一件事。
 * - 缺段按 0 补：`d.103` 等价于 `d.103.0.0.0`。
 * - 永远视为「开发通道」：允许 `-dev.N` 预发后缀（`d.103.2.42.0-dev.3`），比较时忽略后缀。
 * - 通道字母参与比较（`d` > `c` > `m` 的字典序没有业务含义，但同通道比较是常态；
 *   跨通道比较按字符序，且**不**声称支持跨通道升级）。
 *
 * 这个模块被三个地方共用，禁止各写一份：
 * 1. `packages/web` 安装预览与插件详情（判断「需要更新和鸣」）；
 * 2. `packages/server` 市场索引按宿主版本过滤（`?hostVersion=`）；
 * 3. `packages/shared` v5 清单解析（`engines.heming` 格式校验）。
 */

export interface ParsedHemingVersion {
  /** 原始字符串（去掉空白与 `-dev.N` 后缀后）。 */
  raw: string;
  /** 发布通道：`d` = desktop，`c` = cloud，`m` = mobile。 */
  channel: string;
  feature: number;
  breaking: number;
  revision: number;
  build: number;
}

/** 版本号最多 5 段（通道 + 4 个数字段）。 */
const MAX_SEGMENTS = 5;
/** 各数字段上限：防御清单里写 `d.999999999999` 这类值把比较器拖出安全整数。 */
const MAX_SEGMENT = 1_000_000;
const VERSION_RE = /^([dcm])((?:\.[0-9]{1,7}){1,4})(?:-dev\.[0-9]{1,7})?$/i;

/**
 * 解析 5 段版本。非法（空、段数不对、非数字、超出上限）返回 `null`——
 * 调用方负责把 `null` 翻译成中文错误，不在这里抛。
 */
export function parseHemingVersion(raw: unknown): ParsedHemingVersion | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text) return null;
  const match = VERSION_RE.exec(text);
  if (!match) return null;
  const channel = match[1].toLowerCase();
  // match[2] 以 `.` 开头（如 `.103.2`），先切掉首个点再分段，否则会多出一个空串段（Number("") = 0）。
  const numbers = match[2].slice(1).split(".").map((part) => Number(part));
  if (numbers.some((value) => !Number.isSafeInteger(value) || value < 0 || value > MAX_SEGMENT)) {
    return null;
  }
  // 缺段补 0：d.103 → d.103.0.0.0
  while (numbers.length < MAX_SEGMENTS - 1) numbers.push(0);
  return {
    raw: text,
    channel,
    feature: numbers[0] ?? 0,
    breaking: numbers[1] ?? 0,
    revision: numbers[2] ?? 0,
    build: numbers[3] ?? 0,
  };
}

/** 段数（供 UI/测试判断是「3 段」还是「5 段」写法）。 */
export function hemingVersionSegmentCount(raw: string): number {
  const match = VERSION_RE.exec(raw.trim());
  return match ? match[2].slice(1).split(".").length + 1 : 0;
}

/**
 * 比较两个 5 段版本：`a < b` 返回负数，相等 0，`a > b` 正数。
 *
 * 非法版本一律视为「最小」：这样 `satisfiesEngines` 在数据损坏时**失败关闭**
 * （把坏的 required 当成不满足），而不是放行一个说不清是否兼容的插件。
 */
export function compareHemingVersion(a: string, b: string): number {
  const left = parseHemingVersion(a);
  const right = parseHemingVersion(b);
  if (!left && !right) return 0;
  if (!left) return -1;
  if (!right) return 1;
  if (left.channel !== right.channel) return left.channel < right.channel ? -1 : 1;
  const pairs: Array<[number, number]> = [
    [left.feature, right.feature],
    [left.breaking, right.breaking],
    [left.revision, right.revision],
    [left.build, right.build],
  ];
  for (const [x, y] of pairs) {
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * `required` 是否被 `actual` 满足（actual >= required）。
 *
 * - `required` 为空/`undefined`：视为「不限制」（v1–v4 归一化后的 `d.0` 也走这条）；
 * - `required` 非法：**不满足**（失败关闭），由调用方给「插件声明的 engines 不合法」的文案；
 * - `actual` 非法：同样不满足（宿主版本读不到时不能假装兼容）。
 */
export function satisfiesEngines(required: string | undefined | null, actual: string): boolean {
  if (required == null || required === "") return true;
  if (!parseHemingVersion(actual)) return false;
  if (!parseHemingVersion(required)) return false;
  return compareHemingVersion(actual, required) >= 0;
}

/**
 * 兼容性判定的人读结果（安装预览/市场条目共用，保证文案一致）。
 *
 * `status` 三态：
 * - `compatible`：可安装；
 * - `needsNewerApp`：插件要求更高版本的和鸣；
 * - `invalidEngines`：插件写了非法版本号（这是包的问题，不是应用的问题）。
 */
export type EnginesStatus =
  | { status: "compatible"; required?: string }
  | { status: "needsNewerApp"; required: string; actual: string }
  | { status: "invalidEngines"; required: string };

export function enginesStatus(required: string | undefined | null, actual: string): EnginesStatus {
  if (required == null || required === "") return { status: "compatible" };
  if (!parseHemingVersion(required)) return { status: "invalidEngines", required };
  if (!parseHemingVersion(actual)) {
    return { status: "needsNewerApp", required, actual };
  }
  return satisfiesEngines(required, actual)
    ? { status: "compatible", required }
    : { status: "needsNewerApp", required, actual };
}

/** 兼容性文案（中文，带两侧版本；`invalidEngines` 单独一句）。 */
export function enginesStatusText(status: EnginesStatus): string {
  switch (status.status) {
    case "compatible":
      return status.required ? `需要和鸣 ${status.required} 或更高，当前满足` : "未声明最低版本";
    case "needsNewerApp":
      return `需要和鸣 ${status.required} 或更高，当前 ${status.actual}`;
    case "invalidEngines":
      return `engines.heming 不合法：${status.required}（应形如 d.103 或 d.103.2.42.0）`;
  }
}

/** 旧清单（v1–v4）归一化后的「不限制」版本。 */
export const LEGACY_ENGINES = "d.0";

/**
 * 归一化 `engines.heming`：接受 `{ heming: "..." }`、裸字符串或 `undefined`。
 *
 * 返回 `undefined` 表示「没声明」（合法，旧包）；返回 `null` 表示「声明了但非法」。
 */
export function normalizeEnginesHemmin(raw: unknown): string | undefined | null {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "string") {
    return parseHemingVersion(raw) ? raw.trim() : null;
  }
  if (typeof raw === "object") {
    const value = (raw as Record<string, unknown>).heming;
    if (value === undefined) return undefined;
    if (typeof value !== "string") return null;
    return parseHemingVersion(value) ? value.trim() : null;
  }
  return null;
}
