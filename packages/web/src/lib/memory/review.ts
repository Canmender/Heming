/**
 * 复盘分身（review fork）：任务结束后，后台起一次「只带记忆/技能两个工具」的轻量复盘，
 * 把值得长期记住的事实与可复用的流程沉淀下来。
 *
 * 机制对齐 Hermes Agent（Nous Research）：
 * - **nudge 频率可配**：always / after_complex_tasks / never（默认后者）；
 * - **不每轮都复盘**：由 turnsThreshold 计数器节流（默认 10 轮），避免每次都多花一次 LLM 调用；
 * - **复杂任务才复盘**：默认口径——用过工具、用户输入较长、或回答明显展开；
 * - **敏感信息一律不落盘**：命中密钥/口令/令牌的候选直接拒绝，只在结果里报告；
 * - **有容量上限**：语义记忆超过字符上限时拒绝写入并说明原因，逼迫整理而不是无声膨胀。
 *
 * 复盘本身是「后台自我审查」：它不走主对话，不打断流式渲染，失败静默降级。
 */
import type { ChatMessage } from "../llmClient.js";
import type { SkillPool } from "../skills/store.js";
import type { MemoryStore } from "./store.js";
import { resolveAgentMemoryPrefs } from "./agentPrefs.js";
import { containsSensitive } from "../selfEdit/guards.js";

/** 复盘频率（对应 Hermes 的 `memory.nudge_frequency`）。 */
export type ReviewFrequency = "always" | "after_complex_tasks" | "never";

export interface ReviewSettings {
  frequency: ReviewFrequency;
  /** 距上次复盘至少经过多少轮才再来一次（对应 `_turns_since_memory`）。 */
  turnsThreshold: number;
  /** 语义记忆字符上限：超限拒绝写入（对应 Hermes 的 2200 字符硬上限）。 */
  semanticCharLimit: number;
}

export const REVIEW_SETTINGS_KEY = "heming.memory.review.v1";
export const REVIEW_COUNTERS_KEY = "heming.memory.review.counters.v1";

export const DEFAULT_REVIEW_SETTINGS: ReviewSettings = {
  frequency: "after_complex_tasks",
  turnsThreshold: 10,
  semanticCharLimit: 2200,
};

/** 复盘结果的最近一次摘要：给记忆区展示，避免机制变成黑盒。 */
export interface ReviewReport {
  at: string;
  agentId: string;
  /** 本次是否真的跑了模型（false = 被频率/计数器/复杂度挡掉）。 */
  ran: boolean;
  reason: string;
  memoryWritten: number;
  skillWritten: string | null;
  /** 被拒绝的候选与原因（敏感信息、容量满、开关关闭）。 */
  rejected: { text: string; reason: string }[];
}

const FREQUENCIES: ReviewFrequency[] = ["always", "after_complex_tasks", "never"];

/** 规整复盘设置：非法值回落默认，绝不因为脏数据让复盘失控。 */
export function resolveReviewSettings(raw: unknown): ReviewSettings {
  const base = { ...DEFAULT_REVIEW_SETTINGS };
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Record<string, unknown>;
  const frequency = FREQUENCIES.includes(r.frequency as ReviewFrequency)
    ? (r.frequency as ReviewFrequency)
    : base.frequency;
  const threshold = Number(r.turnsThreshold);
  const limit = Number(r.semanticCharLimit);
  return {
    frequency,
    turnsThreshold:
      Number.isFinite(threshold) && threshold >= 1 ? Math.floor(threshold) : base.turnsThreshold,
    semanticCharLimit:
      Number.isFinite(limit) && limit >= 200 ? Math.floor(limit) : base.semanticCharLimit,
  };
}

/**
 * 复杂任务判定（默认口径）：用过工具、用户输入较长、或回答明显展开。
 * 纯函数、无 LLM 成本——nudge 只是「值不值得复盘」的门槛，不是质量判据。
 */
export function isComplexTask(input: {
  userText: string;
  assistantText: string;
  toolCallCount?: number;
}): boolean {
  if ((input.toolCallCount ?? 0) > 0) return true;
  if ([...(input.userText ?? "")].length >= 120) return true;
  if ([...(input.assistantText ?? "")].length >= 600) return true;
  return false;
}

/** 复盘计数器：会话维度累计「距上次复盘经过的轮数」。 */
export function bumpReviewCounter(
  counters: Record<string, number>,
  key: string,
  threshold: number,
): { shouldReview: boolean; counters: Record<string, number> } {
  const seen = counters[key] ?? 0;
  if (seen + 1 >= threshold) {
    const next = { ...counters };
    next[key] = 0;
    return { shouldReview: true, counters: next };
  }
  const next = { ...counters };
  next[key] = seen + 1;
  return { shouldReview: false, counters: next };
}

/**
 * 敏感信息检测已抽到 `lib/selfEdit/guards.ts`：复盘分身与会话内的 self.* 工具
 * 共用同一份判据。两处各写一份正则的话，迟早漂移成"一条通道拦得住、另一条拦不住"。
 * 这里保留原函数名与导出，调用方（含 review.test）无需改动。
 */
export { containsSensitive } from "../selfEdit/guards.js";

/** 语义记忆当前字符占用（与召回拼装口径一致：key + value）。 */
export function semanticChars(store: MemoryStore, agentId: string): number {
  return store
    .semantic(agentId)
    .reduce((n, e) => n + e.key.length + e.value.length, 0);
}

export interface ReviewMemoryCandidate {
  key: string;
  value: string;
  /** user = 关于用户的偏好/画像；agent = 环境事实/项目约定/踩坑。 */
  scope: "user" | "agent";
  confidence: number;
}

export interface ReviewSkillCandidate {
  name: string;
  description: string;
  instructions: string;
  triggers: string[];
  tags: string[];
}

export interface ReviewOutput {
  memories: ReviewMemoryCandidate[];
  skill: ReviewSkillCandidate | null;
}

/**
 * 宽容解析复盘输出：模型可能包 markdown 代码块、可能漏字段、可能多话。
 * 解析失败一律返回空结果（不猜、不造），绝不让脏数据进记忆。
 */
export function parseReviewOutput(raw: string): ReviewOutput {
  const empty: ReviewOutput = { memories: [], skill: null };
  const text = String(raw ?? "").trim();
  if (!text) return empty;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    // 模型常在 JSON 字符串里吐**裸换行/制表符**（非法 JSON 但语义明确）：
    // 把裸控制字符换成空格再试一次；JSON 源码里的 \n 转义序列不受影响。
    try {
      parsed = JSON.parse(text.slice(start, end + 1).replace(/[\u0000-\u001f]/g, " "));
    } catch {
      return empty;
    }
  }
  if (!parsed || typeof parsed !== "object") return empty;
  const r = parsed as Record<string, unknown>;

  const memories: ReviewMemoryCandidate[] = [];
  const rawMemories = Array.isArray(r.memories) ? r.memories : [];
  for (const item of rawMemories) {
    if (!item || typeof item !== "object") continue;
    const m = item as Record<string, unknown>;
    const key = typeof m.key === "string" ? m.key.trim().slice(0, 24) : "";
    const value = typeof m.value === "string" ? m.value.trim().slice(0, 500) : "";
    if (!key || !value) continue;
    const scope = m.scope === "agent" ? "agent" : "user";
    const confidence = Number(m.confidence);
    memories.push({
      key,
      value,
      scope,
      confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0.1, confidence)) : 0.6,
    });
  }

  let skill: ReviewSkillCandidate | null = null;
  const s = r.skill;
  if (s && typeof s === "object") {
    const sk = s as Record<string, unknown>;
    const name = typeof sk.name === "string" ? sk.name.trim().slice(0, 32) : "";
    const instructions = typeof sk.instructions === "string" ? sk.instructions.trim().slice(0, 4000) : "";
    if (name && instructions.length >= 20) {
      skill = {
        name,
        description: typeof sk.description === "string" ? sk.description.trim().slice(0, 200) : "",
        instructions,
        triggers: Array.isArray(sk.triggers)
          ? sk.triggers.filter((t): t is string => typeof t === "string").slice(0, 8)
          : [],
        tags: Array.isArray(sk.tags)
          ? sk.tags.filter((t): t is string => typeof t === "string").slice(0, 8)
          : [],
      };
    }
  }

  return { memories, skill };
}

/** 复盘提示词：只输出 JSON，不许寒暄；并把「什么不该记」写清楚。 */
export function buildReviewPrompt(input: {
  userText: string;
  assistantText: string;
  recentTurns: { userText: string; assistantText: string }[];
  knownKeys: string[];
}): string {
  const window = input.recentTurns
    .slice(-6)
    .map(
      (t, i) =>
        `【第 ${i + 1} 轮】用户：${t.userText.slice(0, 400)}\n助手：${t.assistantText.slice(0, 600)}`,
    )
    .join("\n\n");
  const known = input.knownKeys.length ? input.knownKeys.slice(0, 30).join("、") : "（暂无）";
  return [
    "你是一个后台复盘器。审查下面这段对话，判断有哪些内容值得**长期**留存。",
    "",
    "## 输出格式（只输出一个 JSON 对象，不要任何解释文字）",
    '{"memories":[{"key":"简短主题键","value":"一条事实","scope":"user|agent","confidence":0.6}],"skill":null}',
    "",
    "## 规则",
    "1. memories 只记长期成立的内容：用户偏好/习惯/禁忌、环境事实、项目约定、踩过的坑。",
    "2. **不要记**：一次性的会话流水、临时状态、大段原文、需要时可检索到的内容。",
    "3. **绝对不要记任何密钥、令牌、密码、口令**（出现即整条丢弃）。",
    "4. key 要稳定可归一（同名主题就复用同一个 key，便于更新而非堆叠）。",
    "5. skill 字段：只有当这段对话沉淀出**可复用的多步骤流程**（下次遇到同类任务可直接照做）时，",
    '   才填 {"name":"英文或拼音短名","description":"一句话","instructions":"分步骤 Markdown",',
    '   "triggers":["触发词"],"tags":["标签"]}；否则填 null。',
    "",
    "## 已知主题键（避免重复造 key）",
    known,
    "",
    "## 本轮对话",
    window,
    "",
    "## 本轮",
    `用户：${input.userText.slice(0, 600)}\n助手：${input.assistantText.slice(0, 1200)}`,
  ].join("\n");
}

export interface ReviewDeps {
  store: MemoryStore;
  skills: SkillPool;
  /** 调模型拿复盘结论；只需一次普通（非流式）请求。 */
  callModel: (messages: ChatMessage[]) => Promise<string>;
  /** 读智能体记忆开关（长期记忆关则不写语义层）。 */
  readAgentPrefs: (agentId: string) => { shortTerm: boolean; longTerm: boolean; personalDb: boolean };
  readSettings: () => ReviewSettings;
  writeSettings: (settings: ReviewSettings) => void;
  readCounters: () => Record<string, number>;
  writeCounters: (counters: Record<string, number>) => void;
  now?: () => number;
}

export interface RunReviewInput {
  agentId: string;
  conversationId: string;
  userText: string;
  assistantText: string;
  recentTurns: { userText: string; assistantText: string }[];
  toolCallCount?: number;
}

/**
 * 跑一次复盘。**永不抛**：任何异常都转成带 reason 的报告，调用方直接忽略即可。
 * 返回报告用于记忆区展示「最近一次复盘发生了什么」。
 */
export async function runReview(
  deps: ReviewDeps,
  input: RunReviewInput,
): Promise<ReviewReport> {
  const now = deps.now ?? (() => Date.now());
  const report: ReviewReport = {
    at: new Date(now()).toISOString(),
    agentId: input.agentId,
    ran: false,
    reason: "",
    memoryWritten: 0,
    skillWritten: null,
    rejected: [],
  };

  try {
    const settings = deps.readSettings();
    if (settings.frequency === "never") {
      report.reason = "复盘已关闭";
      return report;
    }
    if (settings.frequency === "after_complex_tasks" && !isComplexTask(input)) {
      report.reason = "本轮不算复杂任务";
      return report;
    }

    const key = `${input.agentId}\u0000${input.conversationId}`;
    const { shouldReview, counters } = bumpReviewCounter(
      deps.readCounters(),
      key,
      settings.turnsThreshold,
    );
    if (!shouldReview) {
      deps.writeCounters(counters);
      report.reason = `未到复盘间隔（${settings.turnsThreshold} 轮）`;
      return report;
    }
    deps.writeCounters(counters);

    const known = deps.store.semantic(input.agentId).map((e) => e.key);
    const raw = await deps.callModel([
      { role: "system", content: buildReviewPrompt({ ...input, knownKeys: known }) },
      { role: "user", content: "按格式输出复盘 JSON。" },
    ]);
    report.ran = true;
    const parsed = parseReviewOutput(raw);

    // —— 记忆候选落盘 ——
    const prefs = deps.readAgentPrefs(input.agentId);
    let chars = semanticChars(deps.store, input.agentId);
    for (const cand of parsed.memories) {
      if (containsSensitive(cand.value) || containsSensitive(cand.key)) {
        report.rejected.push({ text: cand.value.slice(0, 60), reason: "疑似密钥/口令，不落盘" });
        continue;
      }
      if (!prefs.longTerm) {
        report.rejected.push({ text: cand.value.slice(0, 60), reason: "该智能体未开启长期记忆" });
        continue;
      }
      // 同 key 已存在视为更新（按 store 的键归一口径判定），不重复占额度
      const existing = deps.store.findSemantic(input.agentId, cand.key);
      const exists = Boolean(existing);
      const cost = (existing?.key ?? cand.key).length + cand.value.length;
      if (!exists && chars + cost > settings.semanticCharLimit) {
        report.rejected.push({
          text: cand.value.slice(0, 60),
          reason: `语义记忆已满（${chars}/${settings.semanticCharLimit} 字符）`,
        });
        continue;
      }
      deps.store.upsertSemantic({
        agentId: input.agentId,
        key: cand.key,
        value: cand.value,
        scope: cand.scope,
        source: "review",
        confidence: cand.confidence,
      });
      chars += exists ? 0 : cost;
      report.memoryWritten += 1;
    }

    // —— 技能候选沉淀 ——
    if (parsed.skill) {
      if (containsSensitive(parsed.skill.instructions)) {
        report.rejected.push({ text: parsed.skill.name, reason: "技能内容含密钥/口令，不落盘" });
      } else {
        // 同名沉淀技能已存在就原地更新（自我改进），否则新建一条 source=distilled
        const existing = deps.skills.list().find(
          (s) => s.source === "distilled" && s.name === parsed.skill!.name,
        );
        const payload = {
          name: parsed.skill.name,
          description: parsed.skill.description,
          instructions: parsed.skill.instructions,
          triggers: parsed.skill.triggers,
          tags: parsed.skill.tags,
          enabled: true,
          version: "1.0.0",
          source: "distilled" as const,
        };
        const saved = existing
          ? deps.skills.update(existing.id, payload)
          : deps.skills.create(payload);
        deps.skills.assign(input.agentId, saved.id);
        report.skillWritten = parsed.skill.name;
      }
    }

    report.reason = report.memoryWritten || report.skillWritten ? "已沉淀" : "没有值得沉淀的内容";
    return report;
  } catch (err) {
    report.ran = true;
    report.reason = `复盘失败：${err instanceof Error ? err.message : String(err)}`;
    return report;
  }
}

/** 最近一次复盘报告的存储键（记忆区展示用，单条覆盖）。 */
export const REVIEW_REPORT_KEY = "heming.memory.review.last.v1";

/** 读取最近一次报告；脏数据按「没有报告」处理。 */
export function readReviewReport(storage: Pick<Storage, "getItem"> | null): ReviewReport | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(REVIEW_REPORT_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const r = parsed as Record<string, unknown>;
    if (typeof r.at !== "string" || typeof r.reason !== "string") return null;
    return {
      at: r.at,
      agentId: typeof r.agentId === "string" ? r.agentId : "",
      ran: r.ran === true,
      reason: r.reason,
      memoryWritten: Number(r.memoryWritten) || 0,
      skillWritten: typeof r.skillWritten === "string" ? r.skillWritten : null,
      rejected: Array.isArray(r.rejected)
        ? r.rejected
            .filter((x): x is { text: string; reason: string } =>
              Boolean(x) && typeof (x as { text?: unknown }).text === "string",
            )
            .map((x) => ({ text: x.text, reason: x.reason }))
        : [],
    };
  } catch {
    return null;
  }
}

/** 便捷构造：读偏好（带缺省），供 ChatPage 接线用。 */
export function prefsFor(
  raw: unknown,
  agentId: string,
): { shortTerm: boolean; longTerm: boolean; personalDb: boolean } {
  const all = resolveAgentMemoryPrefs(raw);
  return all[agentId] ?? { shortTerm: false, longTerm: false, personalDb: true };
}