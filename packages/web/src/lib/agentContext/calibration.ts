/**
 * 上下文估算校准（d.215）。
 *
 * 上下文用量（d.187）与自动压缩（d.183）都建立在 `estimateRowsTokens` 上：
 * CJK 一字一 token、ASCII 四字符一 token。可真实计费口径由供应商给（`usage.prompt_tokens`），
 * 两边的偏差来自三处——**工具 schema 的开销**（估算里根本没有）、各家分词器差异（英文/代码尤其明显）、
 * 以及消息结构与角色模板。偏差平时只是数字难看，危险的是它让「快到上限了」这句提醒出现得太晚：
 * 真到超限时上游只会回 400，压缩链再紧急收紧也救不回已经发出的这一轮。
 *
 * 这里做的事很小：**拿真实上报的提示 token 与同一批消息的估算值比一比**，
 * 按模型记一个平滑倍率；界面与提醒用校准后的数字。三条边界：
 * 1. **只校准显示与提醒**，不改变压缩决策——压缩是否需要发生仍由 `prepareHistory` 自己算，
 *    否则一次异常样本就会让整段历史被误压（那是不可逆的）。
 * 2. 估算太小时不采样：短对话的偏差主要来自工具 schema 这类固定开销，
 *    把固定开销摊成倍率会让小上下文虚高。
 * 3. 倍率夹在 `RATIO_MIN..RATIO_MAX`：样本再离谱也不许把界面数字翻倍或腰斩。
 *
 * 存储只在本机（localStorage），坏数据一律当没有；任何异常静默降级为「倍率 1」。
 */

/** localStorage 键（只存倍率与样本数，不存原文）。 */
export const CONTEXT_CALIBRATION_KEY = "heming.contextCalibration.v1";

/** 最多记几个模型（按最近使用淘汰）。 */
export const MAX_CALIBRATION_ENTRIES = 12;

/** 估算低于这个值不采样：短对话的偏差主要是工具 schema 的固定开销，不是比例关系。 */
export const MIN_SAMPLE_ESTIMATE = 2_000;

/** 倍率下限：再低也不许把用量显示得比「朴素估算」还小一半以下。 */
export const RATIO_MIN = 0.8;

/** 倍率上限：再高也不许把用量显示翻倍以上（会让提醒变成狼来了）。 */
export const RATIO_MAX = 1.8;

/** 平滑系数：新样本占一半。单个异常样本不该立刻改写界面口径，但也不该被历史长期压住。 */
export const SMOOTHING = 0.5;

/** 一条样本（只用于计算，不落盘原文）。 */
export interface ContextSample {
  model: string;
  estimated: number;
  actual: number;
  at?: number;
}

/** 落盘与读取的条目形状。 */
export interface CalibrationEntry {
  /** 实际 / 估算的平滑倍率。 */
  ratio: number;
  /** 参与计算的样本数。 */
  samples: number;
  /** 最近一次采样的时间（毫秒）。 */
  updatedAt: number;
}

type Store = Record<string, CalibrationEntry>;

/** 内存表：localStorage 不可用时也能在本次会话内生效。 */
let store: Store = {};
let loaded = false;

function storage(): Storage | null {
  try {
    const candidate = globalThis.localStorage;
    return candidate ?? null;
  } catch {
    return null;
  }
}

function isEntry(value: unknown): value is CalibrationEntry {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.ratio === "number" &&
    Number.isFinite(item.ratio) &&
    item.ratio > 0 &&
    typeof item.samples === "number" &&
    Number.isInteger(item.samples) &&
    item.samples > 0 &&
    typeof item.updatedAt === "number" &&
    Number.isFinite(item.updatedAt)
  );
}

/** 模型名归一：大小写与首尾空白都不该产生两条账。 */
function modelKey(model: string): string {
  const text = typeof model === "string" ? model.trim() : "";
  return text.toLowerCase();
}

function load(): void {
  if (loaded) return;
  loaded = true;
  const target = storage();
  if (!target) return;
  try {
    const raw = target.getItem(CONTEXT_CALIBRATION_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return;
    const next: Store = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (key && isEntry(value)) next[key] = value;
    }
    store = next;
  } catch {
    /* 坏数据当没有：估算校准本来就是「有更好、没有也能过」 */
  }
}

function persist(): void {
  const target = storage();
  if (!target) return;
  try {
    const keys = Object.keys(store);
    if (!keys.length) {
      target.removeItem(CONTEXT_CALIBRATION_KEY);
      return;
    }
    target.setItem(CONTEXT_CALIBRATION_KEY, JSON.stringify(store));
  } catch {
    /* 配额满/隐私模式：只丢持久化，内存里照样用 */
  }
}

/** 按最近更新时间裁剪到上限（超出的丢最旧）。 */
function prune(next: Store): Store {
  const keys = Object.keys(next);
  if (keys.length <= MAX_CALIBRATION_ENTRIES) return next;
  const keep = keys
    .sort((a, b) => (next[b]?.updatedAt ?? 0) - (next[a]?.updatedAt ?? 0))
    .slice(0, MAX_CALIBRATION_ENTRIES);
  const out: Store = {};
  for (const key of keep) out[key] = next[key] as CalibrationEntry;
  return out;
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.min(RATIO_MAX, Math.max(RATIO_MIN, value));
}

/**
 * 记一条样本，返回新的倍率（被跳过时返回 null）。
 *
 * 跳过条件（都是「算了也不可信」）：模型名为空、估算没到 `MIN_SAMPLE_ESTIMATE`、
 * 实际值不是正数、两者有一个不是有限数。
 */
export function recordContextSample(sample: ContextSample): number | null {
  load();
  const key = modelKey(sample.model);
  if (!key) return null;
  const estimated = sample.estimated;
  const actual = sample.actual;
  if (!Number.isFinite(estimated) || estimated < MIN_SAMPLE_ESTIMATE) return null;
  if (!Number.isFinite(actual) || actual <= 0) return null;
  const now = Number.isFinite(sample.at) ? (sample.at as number) : Date.now();
  const observed = clampRatio(actual / estimated);
  const prev = store[key];
  const ratio = prev ? clampRatio(prev.ratio * (1 - SMOOTHING) + observed * SMOOTHING) : observed;
  store[key] = {
    ratio,
    samples: (prev?.samples ?? 0) + 1,
    updatedAt: now,
  };
  store = prune(store);
  persist();
  return ratio;
}

/** 当前模型的校准倍率（没有样本就是 1，即「不校准」）。 */
export function contextCalibrationRatio(model: string): number {
  load();
  const entry = store[modelKey(model)];
  if (!entry) return 1;
  return clampRatio(entry.ratio);
}

/**
 * 用校准倍率修正估算值。
 *
 * 倍率恰好为 1（没有样本、或样本算出来就是 1）时**原样返回**：
 * 让「没采样」与「采样得到 1」在数字上一致，调用方不必特判。
 */
export function calibrateEstimate(estimate: number, model: string): number {
  if (!Number.isFinite(estimate) || estimate <= 0) return estimate;
  const ratio = contextCalibrationRatio(model);
  if (ratio === 1) return estimate;
  return Math.round(estimate * ratio);
}

/** 当前记了哪些模型（按最近更新在前），供 `/status` 之类的自检使用。 */
export function listContextCalibration(): { model: string; ratio: number; samples: number; updatedAt: number }[] {
  load();
  return Object.entries(store)
    .map(([model, entry]) => ({ model, ratio: clampRatio(entry.ratio), samples: entry.samples, updatedAt: entry.updatedAt }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 清空（测试与「重置本地数据」用）。 */
export function resetContextCalibration(): void {
  store = {};
  loaded = true;
  const target = storage();
  if (!target) return;
  try {
    target.removeItem(CONTEXT_CALIBRATION_KEY);
  } catch {
    /* 清不掉也不该崩 */
  }
}
