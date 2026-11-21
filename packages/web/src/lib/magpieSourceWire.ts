/**
 * 「端的小开关」：搜索、压缩、User-Agent 这两三项。
 *
 * 三者都是 `provider set` 的键，所以和「它是什么」那组一样**合成一条**命令：
 *
 * - `search=yes|no`：yes 是让来源自己搜网页（前端挂中转时用），no（默认）是按客户端发的那样发。
 * - `compaction=native|magpie`：native 把 Codex 的压缩原样交给来源，magpie（默认）由和鸣压。
 * - `user-agent=agent|magpie`：agent 用智能体自己给的 UA，magpie（默认）用和鸣自己的。
 *   订阅账号自带客户端、UA 由它自己发，内核因此拒绝给账号设 `agent`。
 *
 * 语义照抄内核 `vendor/magpie-core/internal/cli/providers_cli.go` 的 applyPairs
 * （`user-agent` :1215、`search` :1232、`compaction` :1240），不自己加解释。
 */
import type { SourceShowFlags } from "./magpieSourceShow.js";

export type SourceWireKey = "userAgent" | "search" | "compaction";

export interface SourceWireOption {
  value: string;
  label: string;
}

export interface SourceWireField {
  key: SourceWireKey;
  /** 键名（页面上的标签）。 */
  label: string;
  hint: string;
  options: SourceWireOption[];
}

export const SOURCE_WIRE_FIELDS: SourceWireField[] = [
  {
    key: "userAgent",
    label: "请求带谁的 User-Agent",
    hint: "智能体自己的（默认）或和鸣自己的；订阅账号自带客户端，这一项对它无效。",
    options: [
      { value: "agent", label: "智能体自己的" },
      { value: "magpie", label: "和鸣自己的" },
    ],
  },
  {
    key: "search",
    label: "网页搜索由谁做",
    hint: "由来源自己搜（前端挂中转时用），或者按客户端发的那样原样发（默认）。",
    options: [
      { value: "yes", label: "由来源自己搜" },
      { value: "no", label: "照客户端发的" },
    ],
  },
  {
    key: "compaction",
    label: "上下文压缩由谁做",
    hint: "交给来源（Codex 原生，它自己封）或者由和鸣压（默认）。",
    options: [
      { value: "native", label: "交给来源" },
      { value: "magpie", label: "由和鸣压" },
    ],
  },
];

/** 表单里的键 → `provider set` 的键名。 */
const SET_KEYS: Record<SourceWireKey, string> = {
  userAgent: "user-agent",
  search: "search",
  compaction: "compaction",
};

/** 只发填过的项，顺序固定（User-Agent → 搜索 → 压缩），与 `SOURCE_WIRE_FIELDS` 一致。 */
export function sourceWirePairs(values: Partial<Record<SourceWireKey, string>>): string[] {
  const pairs: string[] = [];
  for (const field of SOURCE_WIRE_FIELDS) {
    const value = values[field.key]?.trim() ?? "";
    if (!value) continue;
    if (!field.options.some((option) => option.value === value)) continue;
    pairs.push(`${SET_KEYS[field.key]}=${value}`);
  }
  return pairs;
}

/** 一条 `provider set`；什么都没填或没有来源 id 就是 null（调用方据此禁用按钮）。 */
export function sourceWireCommand(
  id: string,
  values: Partial<Record<SourceWireKey, string>>,
): string[] | null {
  // 与 sourceProfileCommand / sourceModelsCommands 一致：校验用 trim 后的 id，
  // 下发也必须用 trim 后的——否则带空白的 id 会原样进 CLI，和兄弟命令对不上。
  const provider = id.trim();
  if (!provider) return null;
  const pairs = sourceWirePairs(values);
  if (pairs.length === 0) return null;
  return ["provider", "set", provider, ...pairs];
}

/**
 * 现状那一句里的这三个开关。
 *
 * 与 `describeShowFlags` 分开：那句挂在「更多设置」标题下面，说的是整家来源，
 * 这里说的是这一组里设过哪几个，显示在这一组里面。
 */
export function describeWireFlags(flags: SourceShowFlags): string {
  const parts: string[] = [];
  parts.push(flags.magpieUserAgent ? "带和鸣的 UA" : "带智能体的 UA");
  if (flags.searches) parts.push("搜索由来源做");
  if (flags.nativeCompaction) parts.push("压缩交给来源");
  return parts.join("；");
}
