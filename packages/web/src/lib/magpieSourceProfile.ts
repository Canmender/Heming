/**
 * 来源的「它是什么」四项（d.364）：算不算免费、上下文报多大、族标签、原文发不发。
 *
 * 这四项都是 `provider set` 的键（`free=` / `context=` / `family=` / `unmasked=`），
 * 所以能合成一条命令发出去，不用像调流那样一项一条。
 *
 * 为什么要单独放 lib：`context` 的写法内核只认 `200000` / `200k` / `1.5m` 这一类
 * （`provider.ParseTokens`），页面得自己先判一遍——填错了当场点出来，别等内核报错。
 * 留空一律是「这次不改」。
 */

export type SourceProfileKey = "free" | "context" | "family" | "unmasked";

export interface SourceProfileField {
  key: SourceProfileKey;
  label: string;
  hint: string;
  options?: ReadonlyArray<{ value: string; label: string }>;
  placeholder?: string;
}

export const SOURCE_PROFILE_FIELDS: readonly SourceProfileField[] = [
  {
    key: "free",
    label: "这个来源怎么算钱",
    hint: "«算免费» 之后，Free first 与 Cheapest 会把它排在收费的来源前面；价目与用量里的花费照旧。",
    options: [
      { value: "yes", label: "算免费（免费额度）" },
      { value: "no", label: "按价目收费" },
    ],
  },
  {
    key: "context",
    label: "上下文带宽",
    hint: "厂商没说、或说少了的窗口大小：写 200000、200k、1.5m 都行。留空不改。",
    placeholder: "如 272k",
  },
  {
    key: "family",
    label: "族标签",
    hint: "给一组来源打个共同标签（如 fast），规则里能按族挑。留空不改。",
    placeholder: "如 fast",
  },
  {
    key: "unmasked",
    label: "原文照发",
    hint: "«原文照发» 时这一家收到的就是你写的话，不吃和鸣的脱敏；与别家共用的地址建议保持脱敏。",
    options: [
      { value: "no", label: "吃脱敏（默认）" },
      { value: "yes", label: "原文照发（不脱敏）" },
    ],
  },
];

const TOKENS = /^(?:\d+(?:\.\d+)?)(?:k|m)?$/i;

/** 与内核 `provider.ParseTokens` 同口径：只认 200000 / 200k / 1.5m 这类写法。 */
export function parseTokensInput(raw: string): number | null {
  const value = raw.trim().toLowerCase().replace(/_/g, "");
  if (!value) return null;
  if (!TOKENS.test(value)) return null;
  const factor = value.endsWith("k") ? 1_000 : value.endsWith("m") ? 1_000_000 : 1;
  const number = Number.parseFloat(factor === 1 ? value : value.slice(0, -1));
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.round(number * factor);
}

/** 填了但看不懂的那几格（页面点名用）；留空不算。 */
export function sourceProfileRejected(
  values: Partial<Record<SourceProfileKey, string>>,
): string[] {
  const rejected: string[] = [];
  const context = (values.context ?? "").trim();
  if (context && parseTokensInput(context) === null) rejected.push("上下文带宽");
  const family = (values.family ?? "").trim();
  if (family && /\s/.test(family)) rejected.push("族标签");
  return rejected;
}

/**
 * 拼成 `provider set` 的一项项 `k=v`（顺序固定：算钱 → 窗口 → 族 → 原文）。
 * 没来源 id、或一项都没填时返回空数组，调用方据此把按钮置灰。
 */
export function sourceProfilePairs(
  values: Partial<Record<SourceProfileKey, string>>,
): string[] {
  const pairs: string[] = [];
  if (sourceProfileRejected(values).length > 0) return pairs;

  const free = (values.free ?? "").trim();
  if (free === "yes" || free === "no") pairs.push(`free=${free}`);

  const context = (values.context ?? "").trim();
  if (context) pairs.push(`context=${context}`);

  const family = (values.family ?? "").trim();
  if (family) pairs.push(`family=${family}`);

  const unmasked = (values.unmasked ?? "").trim();
  if (unmasked === "yes" || unmasked === "no") pairs.push(`unmasked=${unmasked}`);

  return pairs;
}

/** 「provider set」后面那一整串：没东西可发时返回 null。 */
export function sourceProfileCommand(
  id: string,
  values: Partial<Record<SourceProfileKey, string>>,
): string[] | null {
  const providerId = id.trim();
  if (!providerId) return null;
  const pairs = sourceProfilePairs(values);
  if (pairs.length === 0) return null;
  return ["provider", "set", providerId, ...pairs];
}
