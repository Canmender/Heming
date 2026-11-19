/**
 * 从 `provider show <id>` 的输出里读回「这个来源现在设了什么」。
 *
 * 页面这一侧原来只能读地址与模型清单（`providerModels.ts`），可选设置一律是「填什么发什么」：
 * 改一个请求头要把整行重填，也看不出这个来源算不算免费、有没有原文照发。内核的 show
 * （`vendor/magpie-core/internal/cli/providers_cli.go` 的 showProvider :849）其实把
 * `unmasked` / `free` / `header` / `refresh` / `include` 都打出来了，只是键名左对齐补到十格、
 * 值后面还挂一段灰字说明（形如 `  header     X-Trace: abc`）。
 *
 * 这里只做「读」：解析出来的东西用来回填表单与显示现状，命令仍由各自的按钮发。
 * 注意 show **不打印** `context=` 与 `family=`（内核没往外写），所以这两项仍然是只写不读。
 */

/** show 里的一行请求头。 */
export interface ShownHeader {
  name: string;
  value: string;
}

/** show 能读回来的那几项；没有的项给空值，调用方不必判 undefined。 */
export interface SourceShowFlags {
  headers: ShownHeader[];
  /** `free yes` → 算免费（供 Free first / Cheapest 路由）。 */
  free: boolean;
  /** `unmasked yes` → 原文照发。 */
  unmasked: boolean;
  /** `refresh every 6h` → "6h"；没设是空串。 */
  refreshEvery: string;
  /** `include claude-* gpt-4o*` → 规则列表；没设是空数组。 */
  autoInclude: string[];
}

/** 键与值之间的分隔；键名被 pad 到十格，所以按「至少一个空白」切。 */
const LINE = /^\s*(unmasked|free|header|refresh|include)\s+(.+)$/;

/** 值的灰字说明用两个空格接在后面：取第一段就是真正的值。 */
function head(value: string): string {
  return value.split(/\s{2,}/)[0]?.trim() ?? "";
}

export function parseSourceShow(showText: string): SourceShowFlags {
  const flags: SourceShowFlags = {
    headers: [],
    free: false,
    unmasked: false,
    refreshEvery: "",
    autoInclude: [],
  };

  for (const raw of showText.replace(/\r/g, "").split("\n")) {
    const line = raw.trimEnd();
    const matched = LINE.exec(line);
    if (!matched) continue;
    const key = matched[1];
    const rest = matched[2] ?? "";

    if (key === "header") {
      const text = head(rest);
      // 名字里不会有冒号，所以第一个冒号就是分隔（值里的冒号原样留着）；
      // 值留空时内核打出来就是 `X-Old:`，切完名字带不走那个冒号。
      const at = text.indexOf(":");
      const name = at >= 0 ? text.slice(0, at).trim() : text.trim();
      const value = at >= 0 ? text.slice(at + 1).trim() : "";
      if (name) flags.headers.push({ name, value });
      continue;
    }
    if (key === "free") {
      flags.free = head(rest).toLowerCase() === "yes";
      continue;
    }
    if (key === "unmasked") {
      flags.unmasked = head(rest).toLowerCase() === "yes";
      continue;
    }
    if (key === "refresh") {
      // `every 6h` / `every 1d`
      const text = head(rest);
      flags.refreshEvery = text.toLowerCase().startsWith("every ") ? text.slice(6).trim() : "";
      continue;
    }
    if (key === "include") {
      flags.autoInclude = head(rest).split(/\s+/).filter(Boolean);
    }
  }

  return flags;
}

/** 把读回来的请求头还原成「一行一个」的文本，填回多行框用。 */
export function headersToText(headers: ShownHeader[]): string {
  return headers.map((item) => `${item.name}: ${item.value}`).join("\n");
}

/**
 * 一句话说清这个来源现在设了什么，给折叠区里的那行现状用。
 *
 * 什么都没设时返回空串——调用方据此不显示这一行，免得每个来源都挂一句「现在设着：没有」。
 */
export function describeShowFlags(flags: SourceShowFlags): string {
  const parts: string[] = [];
  if (flags.headers.length > 0) {
    parts.push(`请求头 ${flags.headers.map((item) => item.name).join("、")}`);
  }
  if (flags.free) parts.push("算免费");
  if (flags.unmasked) parts.push("原文照发");
  if (flags.refreshEvery) parts.push(`每 ${flags.refreshEvery} 刷清单`);
  if (flags.autoInclude.length > 0) parts.push(`自动收 ${flags.autoInclude.join(" ")}`);
  return parts.join("；");
}

