/**
 * 模型页「来源」区的厂商与地址类型（Coding Plan）映射（d.104）。
 *
 * 内核 `provider add <preset> <key> [region=…]` 里，部分厂商同时提供
 * 「按量普通地址」和「套餐专用地址」（Coding Plan / Step Plan / 会员计划）。
 * 普通 Key 发到套餐地址、或套餐 Key 发到按量地址，都会被回「无余额」，
 * 所以页面必须在添加前就把地址类型问清楚。
 *
 * 这里只收敛**当前 UI 暴露的**厂商（不求覆盖内核全部 preset）：
 * 每一项带一组 planOptions，其中 `region` 就是内核 accepted 的 region= 值；
 * 没有 `region` 的选项表示该地址不需要额外参数（同一地址，或独立 preset）。
 */

import { stripAnsi } from "./magpieCli.js";

export type PlanKind = "coding" | "normal";

export interface PlanOption {
  /** 选项 id，页面按它记选中态（不一定是 coding/normal）。 */
  id: string;
  label: string;
  /** 选中后显示在输入框下面的一句话。 */
  hint?: string;
  /** 选中后显示的小提示条（说明这个地址只收哪种 Key）。 */
  notice?: string;
  /** 传给内核的 region= 值；普通地址不传，避免对没有 Regions 的 preset 报错。 */
  region?: string;
  /** 这一项其实是另一个独立 preset（Kimi 会员计划走 kimi-code）。 */
  presetId?: string;
  /** 徽标口径：套餐地址算 coding，其余 normal。 */
  kind: PlanKind;
}

export interface MagpiePreset {
  id: string;
  name: string;
  desc: string;
  planOptions: PlanOption[];
}

const NORMAL: PlanOption = { id: "api", label: "普通地址", hint: "按量计费", kind: "normal" };

const PLAN_NOTICE = "该地址只接受 Coding Plan 的 Key；普通按量 Key 会报「余额为 0」。";

const CODING: PlanOption = {
  id: "coding",
  label: "Coding Plan",
  hint: "包月编码套餐专用地址",
  notice: PLAN_NOTICE,
  region: "coding",
  kind: "coding",
};

/** 当前 UI 暴露的厂商（顺序即网格顺序）；新增厂商只在确有套餐区别时才需要选项。 */
export const MAGPIE_PRESETS: MagpiePreset[] = [
  { id: "deepseek", name: "DeepSeek", desc: "官方 API", planOptions: [NORMAL] },
  { id: "openai", name: "OpenAI", desc: "官方 API", planOptions: [NORMAL] },
  { id: "anthropic", name: "Anthropic", desc: "官方 API", planOptions: [NORMAL] },
  {
    id: "moonshot",
    name: "Kimi",
    desc: "Moonshot 按量",
    planOptions: [NORMAL],
  },
  {
    id: "kimi-code",
    name: "Kimi Code",
    desc: "会员计划",
    planOptions: [
      {
        id: "membership",
        label: "Kimi Code 会员",
        hint: "Coding 会员专用地址",
        notice: "该地址只接受 Kimi Code 会员订阅的 Key；普通按量 Key 会报无权限。",
        kind: "coding",
      },
    ],
  },
  {
    id: "zhipu",
    name: "智谱 GLM",
    desc: "官方 API",
    planOptions: [NORMAL, CODING],
  },
  {
    id: "stepfun",
    name: "StepFun",
    desc: "阶跃星辰",
    planOptions: [
      NORMAL,
      {
        id: "plan",
        label: "Step Plan",
        hint: "Step Plan 套餐专用地址",
        notice: "该地址只接受 Step Plan 的 Key；普通按量 Key 会报无余额。",
        region: "plan",
        kind: "coding",
      },
    ],
  },
  {
    id: "minimax",
    name: "MiniMax",
    desc: "官方 API",
    planOptions: [
      NORMAL,
      {
        id: "coding-key",
        label: "Coding Plan Key",
        hint: "同一地址，粘贴 Coding Plan 专用 Key，内核自动识别",
        notice: "这个地址与普通地址相同：粘 Coding Plan 的 Key 即可，内核按 Key 前缀识别套餐。",
        kind: "coding",
      },
    ],
  },
  { id: "qwen", name: "通义千问", desc: "DashScope", planOptions: [NORMAL] },
  { id: "mistral", name: "Mistral", desc: "官方 API", planOptions: [NORMAL] },
  { id: "groq", name: "Groq", desc: "官方 API", planOptions: [NORMAL] },
  { id: "xai", name: "xAI", desc: "Grok", planOptions: [NORMAL] },
];

export function findPreset(presetId: string): MagpiePreset | undefined {
  return MAGPIE_PRESETS.find((preset) => preset.id === presetId);
}

/** 默认选项：有普通地址就用普通地址，否则第一条（会员计划类只有一条）。 */
export function defaultPlanOption(preset: MagpiePreset): PlanOption {
  return preset.planOptions.find((option) => option.kind === "normal") ?? preset.planOptions[0]!;
}

export function planOptionOf(
  preset: MagpiePreset | undefined,
  planId: string | null | undefined,
): PlanOption | undefined {
  if (!preset) return undefined;
  if (!planId) return defaultPlanOption(preset);
  return preset.planOptions.find((option) => option.id === planId) ?? defaultPlanOption(preset);
}

/**
 * 生成 `provider add` 的参数。
 *
 * 普通/默认选项不带 region：内核里没有 Regions 的 preset 收到 region= 会直接报错，
 * 带 Regions 的 preset 默认就是按量地址，少传一个参数就等于少一处抄错的机会。
 */
export function presetAddArgs(
  presetId: string,
  planId: string | null | undefined,
  key: string,
): string[] {
  const preset = findPreset(presetId);
  const option = planOptionOf(preset, planId);
  const target = option?.presetId ?? presetId;
  const args = ["provider", "add", target, key.trim()];
  if (option?.region) args.push(`region=${option.region}`);
  return args;
}

/** `provider show` 里三条地址；解析不到就是空串。 */
export interface ShowUrls {
  chat: string;
  responses: string;
  anthropic: string;
}

/** 解析 `provider show <id>` 的 chat / responses / anthropic 三行（带 ANSI 也能认）。 */
export function parseShowUrls(showText: string): ShowUrls {
  const urls: ShowUrls = { chat: "", responses: "", anthropic: "" };
  for (const rawLine of showText.split(/\r?\n/)) {
    const line = stripAnsi(rawLine).trim();
    const match = /^(chat|responses|anthropic)\s+(https?:\/\/\S+)/i.exec(line);
    if (!match) continue;
    const key = match[1]!.toLowerCase() as keyof ShowUrls;
    if (!urls[key]) urls[key] = match[2]!;
  }
  return urls;
}

/** 套餐地址的路径特征：Coding / Step Plan / Token Plan（小米等按区域分 host）。 */
const CODING_PATH_MARKERS = ["/coding", "/step_plan", "token-plan"];
/** GLM 的 Coding Plan 在 /api/v1 上单独提供 Responses；按量地址没有这一条。 */
const CODING_RESPONSES_HOST = /^https?:\/\/([a-z0-9-]+\.)*bigmodel\.cn\/api\/v1(\/|$)|^https?:\/\/api\.z\.ai\/api\/v1(\/|$)/;

/**
 * 从 `provider show` 文本判断这个来源是普通地址还是套餐地址。
 *
 * 只有 host 的 `providers` 列表判断不了，所以按需（展开高级时）读一次详细地址。
 * 认不出地址（命令失败/输出变了）返回 null，调用方按普通展示。
 */
export function detectPlanFromShow(showText: string): PlanKind | null {
  const urls = parseShowUrls(showText);
  const all = [urls.chat, urls.responses, urls.anthropic].filter(Boolean);
  if (all.length === 0) return null;
  for (const url of all) {
    const lower = url.toLowerCase();
    if (CODING_PATH_MARKERS.some((marker) => lower.includes(marker))) return "coding";
    if (CODING_RESPONSES_HOST.test(lower)) return "coding";
  }
  return "normal";
}
