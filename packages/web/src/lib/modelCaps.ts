/**
 * 模型能力元数据表（上下文窗口 / 是否支持函数调用 / 视觉 / 思考 / 定价）。
 *
 * 为什么要有这张表：
 * - **上下文窗口**决定历史预算能开多大（超了供应商就 400）；
 * - **是否支持函数调用**决定能不能开工具（不支持时给了 tools 也没用）；
 * - **定价**只是给用户看的参考。
 *
 * 为什么是**静态表**而不是联网拉：离线可用是本项目的硬要求，
 * 而且这张表半年才动一次，联网拉取反而引入「断网就没数据」的问题。
 *
 * ★ 定价是**参考价**：模型厂商调价频繁，写死在代码里必然过期。
 *   界面上一律标注「参考价，以服务商账单为准」。
 */

import type { LlmProfile, LlmProvider } from "../store/llm.js";
import { createDefaultStorage, readJson, writeJson } from "./memory/storage.js";
import type { StorageLike } from "./memory/types.js";

/** 用户手改覆盖层的存储键（带版本后缀）。 */
export const MODEL_CAPS_KEY = "heming.modelCaps.v1";

/** 定价文案的免责说明（界面必须原样展示）。 */
export const PRICING_DISCLAIMER = "参考价，以服务商账单为准";

/** 一个模型的能力描述。 */
export interface ModelCapability {
  /** 上下文窗口上限（token）。 */
  contextWindow: number;
  /** 单次输出的上限（token）。 */
  maxOutput: number;
  /** 是否支持函数调用（工具）。 */
  supportsTools: boolean;
  /** 是否支持图片输入。 */
  supportsVision: boolean;
  /** 是否输出思考过程。 */
  supportsReasoning: boolean;
  /** 定价：每百万 token，单位「元」。 */
  pricing?: { input: number; output: number };
}

/** 用户可手改的字段（其余按表填）。 */
export type ModelCapabilityOverride = Partial<ModelCapability>;

/** 覆盖层：key = `provider:model` → 用户手改的字段。 */
export type ModelCapsOverrides = Record<string, ModelCapabilityOverride>;

/** 未知模型时的保守缺省：窗口小、只支持文本与工具。 */
export const DEFAULT_CAPABILITY: ModelCapability = {
  contextWindow: 8192,
  maxOutput: 4096,
  supportsTools: true,
  supportsVision: false,
  supportsReasoning: false,
};

/**
 * 静态表：精确模型 id → 能力。
 *
 * 覆盖 `llmPresets.ts` 里的全部预设模型，另加几个常见的衍生型号。
 * 定价是参考价（每百万 token，单位元）。
 */
const EXACT: Record<string, ModelCapability> = {
  // —— DeepSeek ——
  "deepseek-chat": {
    contextWindow: 64000,
    maxOutput: 8192,
    supportsTools: true,
    supportsVision: false,
    supportsReasoning: false,
    pricing: { input: 2, output: 8 },
  },
  "deepseek-reasoner": {
    contextWindow: 64000,
    maxOutput: 8192,
    supportsTools: true,
    supportsVision: false,
    supportsReasoning: true,
    pricing: { input: 4, output: 16 },
  },
  // —— Kimi / Moonshot ——
  "moonshot-v1-8k": {
    contextWindow: 8192,
    maxOutput: 4096,
    supportsTools: true,
    supportsVision: false,
    supportsReasoning: false,
    pricing: { input: 12, output: 12 },
  },
  "moonshot-v1-32k": {
    contextWindow: 32768,
    maxOutput: 4096,
    supportsTools: true,
    supportsVision: false,
    supportsReasoning: false,
    pricing: { input: 12, output: 12 },
  },
  // —— 智谱 GLM ——
  "glm-4-flash": {
    contextWindow: 128000,
    maxOutput: 4096,
    supportsTools: true,
    supportsVision: false,
    supportsReasoning: false,
    pricing: { input: 0.5, output: 5 },
  },
  "glm-4-plus": {
    contextWindow: 128000,
    maxOutput: 8192,
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: false,
    pricing: { input: 4, output: 12 },
  },
  // —— 通义千问 ——
  "qwen-plus": {
    contextWindow: 131072,
    maxOutput: 8192,
    supportsTools: true,
    supportsVision: false,
    supportsReasoning: false,
    pricing: { input: 0.8, output: 2 },
  },
  "qwen-max": {
    contextWindow: 32768,
    maxOutput: 8192,
    supportsTools: true,
    supportsVision: false,
    supportsReasoning: false,
    pricing: { input: 2.4, output: 9.6 },
  },
  "qwen-turbo": {
    contextWindow: 1000000,
    maxOutput: 8192,
    supportsTools: true,
    supportsVision: false,
    supportsReasoning: false,
    pricing: { input: 0.3, output: 0.6 },
  },
  "qwen2.5-vl-7b-instruct": {
    contextWindow: 32768,
    maxOutput: 4096,
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: false,
  },
  // —— 本地 / 私有部署 ——
  "Qwen/Qwen2.5-7B-Instruct": {
    contextWindow: 32768,
    maxOutput: 4096,
    supportsTools: true,
    supportsVision: false,
    supportsReasoning: false,
  },
  "qwen2.5:7b": {
    contextWindow: 32768,
    maxOutput: 4096,
    supportsTools: true,
    supportsVision: false,
    supportsReasoning: false,
  },
  // —— Anthropic ——
  "claude-sonnet-5": {
    contextWindow: 200000,
    maxOutput: 64000,
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: true,
    pricing: { input: 21, output: 105 },
  },
  "claude-opus-5": {
    contextWindow: 200000,
    maxOutput: 64000,
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: true,
    pricing: { input: 105, output: 525 },
  },
  // —— OpenAI 兼容端点常见的几个 ——
  "gpt-4o": {
    contextWindow: 128000,
    maxOutput: 16384,
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: false,
    pricing: { input: 18, output: 72 },
  },
  "gpt-4o-mini": {
    contextWindow: 128000,
    maxOutput: 16384,
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: false,
    pricing: { input: 1.1, output: 4.3 },
  },
  "o3-mini": {
    contextWindow: 200000,
    maxOutput: 100000,
    supportsTools: true,
    supportsVision: false,
    supportsReasoning: true,
    pricing: { input: 11, output: 44 },
  },
};

/**
 * 前缀规则：模型 id 以某个串开头 → 能力。
 *
 * 比家族启发更准（`qwen2.5-vl-*` 是视觉而 `qwen2.5-*` 不是），
 * 所以排在家族启发之前。
 */
const PREFIX: { prefix: string; caps: ModelCapability }[] = [
  {
    prefix: "deepseek-reasoner",
    caps: EXACT["deepseek-reasoner"],
  },
  {
    prefix: "qwen2.5-vl",
    caps: EXACT["qwen2.5-vl-7b-instruct"],
  },
  {
    prefix: "qwen-vl",
    caps: EXACT["qwen2.5-vl-7b-instruct"],
  },
  {
    prefix: "qwen-max",
    caps: EXACT["qwen-max"],
  },
  {
    prefix: "qwen-turbo",
    caps: EXACT["qwen-turbo"],
  },
  {
    prefix: "qwen-plus",
    caps: EXACT["qwen-plus"],
  },
  {
    prefix: "qwen",
    caps: EXACT["Qwen/Qwen2.5-7B-Instruct"],
  },
  {
    prefix: "deepseek",
    caps: EXACT["deepseek-chat"],
  },
  {
    prefix: "moonshot",
    caps: EXACT["moonshot-v1-8k"],
  },
  {
    prefix: "kimi",
    caps: EXACT["moonshot-v1-8k"],
  },
  {
    prefix: "glm-4-flash",
    caps: EXACT["glm-4-flash"],
  },
  {
    prefix: "glm-4",
    caps: EXACT["glm-4-plus"],
  },
  {
    prefix: "glm",
    caps: EXACT["glm-4-flash"],
  },
  {
    prefix: "claude",
    caps: EXACT["claude-sonnet-5"],
  },
  {
    prefix: "gpt-4o",
    caps: EXACT["gpt-4o"],
  },
  {
    prefix: "gpt-4",
    caps: EXACT["gpt-4o"],
  },
  {
    prefix: "gpt-3.5",
    caps: EXACT["gpt-4o-mini"],
  },
  {
    prefix: "gpt",
    caps: EXACT["gpt-4o"],
  },
];

/** 家族启发：模型名里含某个词 → 能力。 */
const FAMILY: { token: string; caps: ModelCapability }[] = [
  { token: "deepseek", caps: EXACT["deepseek-chat"] },
  { token: "qwen", caps: EXACT["Qwen/Qwen2.5-7B-Instruct"] },
  { token: "glm", caps: EXACT["glm-4-flash"] },
  { token: "moonshot", caps: EXACT["moonshot-v1-8k"] },
  { token: "kimi", caps: EXACT["moonshot-v1-8k"] },
  { token: "claude", caps: EXACT["claude-sonnet-5"] },
  { token: "gpt", caps: EXACT["gpt-4o"] },
  { token: "llama", caps: EXACT["Qwen/Qwen2.5-7B-Instruct"] },
  { token: "mistral", caps: EXACT["Qwen/Qwen2.5-7B-Instruct"] },
  { token: "yi-", caps: EXACT["Qwen/Qwen2.5-7B-Instruct"] },
];

/** 覆盖层 key：`provider:model`。 */
function overrideKey(provider: LlmProvider, model: string): string {
  return `${provider}:${model}`;
}

/** 读用户覆盖层（损坏 / 缺失 → 空）。 */
export function readOverrides(storage?: StorageLike): ModelCapsOverrides {
  const store = storage ?? createDefaultStorage();
  return readJson<ModelCapsOverrides>(store, MODEL_CAPS_KEY, {});
}

/** 写用户覆盖层（写失败静默：只是记不住手改值，不影响功能）。 */
export function writeOverrides(
  overrides: ModelCapsOverrides,
  storage?: StorageLike,
): void {
  const store = storage ?? createDefaultStorage();
  writeJson(store, MODEL_CAPS_KEY, overrides);
}

/** 给某个模型写一条覆盖（合并已有的）。 */
export function setOverride(
  provider: LlmProvider,
  model: string,
  patch: ModelCapabilityOverride,
  storage?: StorageLike,
): void {
  const overrides = readOverrides(storage);
  const key = overrideKey(provider, model);
  overrides[key] = { ...overrides[key], ...patch };
  writeOverrides(overrides, storage);
}

/** 删掉某个模型的覆盖（回到内置表）。 */
export function clearOverride(
  provider: LlmProvider,
  model: string,
  storage?: StorageLike,
): void {
  const overrides = readOverrides(storage);
  delete overrides[overrideKey(provider, model)];
  writeOverrides(overrides, storage);
}

/**
 * 查一个模型的能力。
 *
 * 匹配顺序：**用户覆盖层 → 精确 id → 前缀规则 → 家族启发 → null**。
 * 覆盖层优先级最高——用户手填的永远比内置表准。
 *
 * @param provider 服务商（OpenAI 兼容 / Anthropic）
 * @param model 模型 id
 * @param storage 覆盖层存储（默认 localStorage）
 * @returns 查不到时返回 null（**不猜**：宁可让界面显示「能力未知」，
 *          也不给一个错的窗口上限导致供应商 400）
 */
export function lookupCapability(
  provider: LlmProvider,
  model: string,
  storage?: StorageLike,
): ModelCapability | null {
  const id = model.trim();
  if (!id) return null;

  // ① 用户覆盖层
  const override = readOverrides(storage)[overrideKey(provider, id)];
  const base = baseCapability(id);
  if (override && Object.keys(override).length > 0) {
    return { ...(base ?? DEFAULT_CAPABILITY), ...override };
  }
  if (base) return base;
  return null;
}

/** 内置表查找（精确 → 前缀 → 家族）。 */
function baseCapability(id: string): ModelCapability | null {
  const exact = EXACT[id];
  if (exact) return exact;
  const lower = id.toLowerCase();
  for (const { prefix, caps } of PREFIX) {
    if (lower.startsWith(prefix.toLowerCase())) return caps;
  }
  for (const { token, caps } of FAMILY) {
    if (lower.includes(token.toLowerCase())) return caps;
  }
  return null;
}

/**
 * 查一个连接的能力；查不到时给**保守缺省**。
 *
 * 与 `lookupCapability` 的区别：这里永不返回 null——
 * 「历史预算按 60% 窗口算」这类计算需要一个数，不能没有。
 * 但缺省值刻意保守（窗口 8K），宁可少发历史也不撞供应商上限。
 */
export function resolveCapability(
  profile: Pick<LlmProfile, "provider" | "model">,
  storage?: StorageLike,
): ModelCapability {
  return lookupCapability(profile.provider, profile.model, storage) ?? DEFAULT_CAPABILITY;
}

/** 能力徽标（界面用）。 */
export function capabilityBadges(caps: ModelCapability): string[] {
  const out: string[] = [];
  if (caps.supportsTools) out.push("🎯 函数调用");
  if (caps.supportsVision) out.push("👁 视觉");
  if (caps.supportsReasoning) out.push("💭 思考");
  return out;
}
