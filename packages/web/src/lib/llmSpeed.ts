/**
 * 候选测速账本（`fast` 档的数据源）：首 token 时延（TTFT）+ 生成速度。
 *
 * 语义来源：magpie（github.com/yetone/magpie，MIT）的 `Fastest` 选路——
 * 用「首 token + 生成 200 个 token 的用时」（`ttft + 200 × 单 token 生成耗时`）
 * 作为比较键，越小越快；没测过速的候选排测过的后面。
 *
 * 与 magpie 的差异（都是本仓是客户端的必然结果）：
 * - **纯内存**：不落盘、不进 localStorage、不上云；重启清零（magpie 同样只在内存里存速度）。
 *   所以模块卡片的「本机数据键」里**没有** `heming.llmSpeed.v1` 这个键，别去展示它。
 * - **样本按时间衰减**：20 分钟前的样本权重减半（`SPEED_HALF_LIFE_MS`）。供应商的
 *   速度随时段/负载变化，一次慢样本不该永久压着一个候选；衰减在 `record` 时用
 *   加权平均折进一个值，读取时零成本。
 * - **最多 4096 条**（一家连接×模型的组合不会这么多，纯粹是别让 Map 无限长），
 *   超了淘汰「最久没更新」的那条。
 *
 * 采集点：`lib/llmRoute.ts` 的候选调用循环（每次真正问一个候选时计时）。
 * 单候选透传路径不采集（透传时没有选路决策，也不该因为测速改变调用 opts 的对象身份）。
 * 若将来 `agentStream.ts` 也要采集，务必按「真实答话的候选（profileId×model）」记，
 * 不要记到 `route.<gid>` 合成档上——那个键永远不会被 fast 档读到。
 *
 * 刻意不做：不探测、不主动测速、不做网络请求。只有真实请求顺手留下的样本。
 */

/** 速度样本的时间半衰期：20 分钟。 */
export const SPEED_HALF_LIFE_MS = 20 * 60_000;
/** 最多保留多少条「连接×模型」样本（超出淘汰最久未更新的）。 */
export const MAX_SPEED_SAMPLES = 4096;
/** magpie `Fastest` 的参照生成长度：首 token + 200 个 token 的用时。 */
export const SPEED_REF_TOKENS = 200;

/** 一次真实调用留下的原始测速样本。 */
export interface SpeedSample {
  /** 首 token 时延（毫秒，从发起请求到第一个正文增量）。 */
  ttftMs: number;
  /** 本次输出 token 数（供应商上报；未上报传 undefined）。 */
  outputTokens?: number;
  /** 本次调用总用时（毫秒，发起请求到流结束）。 */
  elapsedMs: number;
}

/** 一条已折好的测速记录（同一连接×模型只留一条）。 */
export interface SpeedRecord {
  /** 比较键：`ttftMs + 200 × 单 token 生成耗时`（毫秒，越小越快）。 */
  metric: number;
  /** 最近一次样本的时刻（Date.now() 毫秒）。 */
  at: number;
  /** 累计样本数（未加权）。 */
  samples: number;
}

/**
 * 由原始样本算比较键。
 *
 * - `outputTokens` 缺失/为 0 时无法算生成速度，只留首 token 时延（宁可少算，
 *   也不拿「整段用时」冒充「200 token 用时」——那会把长回答判成慢模型）；
 * - 总用时短于 TTFT（时钟抖动）时按 TTFT 算，生成耗时为 0；
 * - 负数一律夹到 0：坏样本不该翻转排序。
 */
export function metricOf(sample: SpeedSample): number {
  const ttft = Math.max(0, sample.ttftMs);
  const elapsed = Math.max(ttft, sample.elapsedMs);
  const out = sample.outputTokens ?? 0;
  if (!Number.isFinite(out) || out <= 0) return ttft;
  const genMs = Math.max(0, elapsed - ttft);
  return ttft + (genMs * SPEED_REF_TOKENS) / out;
}

/** 测速账本：内存单例（重启清零）。 */
export class LlmSpeed {
  private readonly samples = new Map<string, SpeedRecord>();

  private static keyOf(profileId: string, model: string): string {
    return `${profileId}\u0000${model}`;
  }

  /**
   * 记一次真实调用（只该在**成功**且拿到首 token 后调用；失败没有速度可言）。
   * `now` 可注入：单测要精确验证 20 分钟半衰，生产调用方别传。
   */
  record(profileId: string, model: string, sample: SpeedSample, now = Date.now()): void {
    const key = LlmSpeed.keyOf(profileId, model);
    const metric = metricOf(sample);
    const prev = this.samples.get(key);
    if (!prev) {
      this.samples.set(key, { metric, at: now, samples: 1 });
    } else {
      // 时间加权平均：旧值的权重按「距上次样本多久」半衰，新样本权重 1。
      const age = Math.max(0, now - prev.at);
      const w = 0.5 ** (age / SPEED_HALF_LIFE_MS);
      this.samples.set(key, {
        metric: (prev.metric * w + metric) / (w + 1),
        at: now,
        samples: prev.samples + 1,
      });
    }
    this.trim();
  }

  /** 比较键；没测过速返回 undefined（调用方据此把候选排到测过的后面）。 */
  rankOf(profileId: string, model: string): number | undefined {
    return this.samples.get(LlmSpeed.keyOf(profileId, model))?.metric;
  }

  /** 完整记录（界面/调试用）；没有返回 undefined。 */
  sampleOf(profileId: string, model: string): SpeedRecord | undefined {
    return this.samples.get(LlmSpeed.keyOf(profileId, model));
  }

  /** 当前样本条数（单测断言上限用）。 */
  size(): number {
    return this.samples.size;
  }

  /** 超过上限时淘汰最久未更新的样本（O(n)，只在越界那一次发生）。 */
  private trim(): void {
    while (this.samples.size > MAX_SPEED_SAMPLES) {
      let oldestKey: string | null = null;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [key, rec] of this.samples) {
        if (rec.at < oldestAt) {
          oldestAt = rec.at;
          oldestKey = key;
        }
      }
      if (oldestKey === null) return;
      this.samples.delete(oldestKey);
    }
  }

  /** 清空（单测用；生产不要调——重启自然清零）。 */
  reset(): void {
    this.samples.clear();
  }
}

/** 页面级测速账本（纯内存，不落盘）。 */
export const llmSpeed = new LlmSpeed();
