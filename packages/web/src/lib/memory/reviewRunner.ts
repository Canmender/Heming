/**
 * 复盘分身接线层：把 review.ts 的纯逻辑接到本机单例（记忆 store + 技能池 + 偏好表）。
 *
 * 这里是唯一允许直接读 localStorage 的地方，其余函数保持可注入、便于单测。
 */
import { memoryStore } from "./index.js";
import { skillPool } from "../skills/index.js";
import { agentPrefsStore } from "./agentPrefs.js";
import { streamChat } from "../llmClient.js";
import type { LlmProfile } from "../../store/llm.js";
import {
  DEFAULT_REVIEW_SETTINGS,
  REVIEW_COUNTERS_KEY,
  REVIEW_REPORT_KEY,
  REVIEW_SETTINGS_KEY,
  readReviewReport,
  resolveReviewSettings,
  runReview,
  semanticChars,
  type ReviewDeps,
  type ReviewReport,
  type ReviewSettings,
  type RunReviewInput,
} from "./review.js";

/** 本机存储不可用时（隐私模式）退化为内存对象，功能只在本次会话有效。 */
const memoryFallback = new Map<string, string>();
const storage = {
  getItem(k: string): string | null {
    try {
      return window.localStorage.getItem(k);
    } catch {
      return memoryFallback.get(k) ?? null;
    }
  },
  setItem(k: string, v: string): void {
    try {
      window.localStorage.setItem(k, v);
    } catch {
      memoryFallback.set(k, v);
    }
  },
  removeItem(k: string): void {
    try {
      window.localStorage.removeItem(k);
    } catch {
      memoryFallback.delete(k);
    }
  },
};

function readJson(key: string): unknown {
  try {
    const raw = storage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** 读复盘设置（脏数据回落默认）。 */
export function getReviewSettings(): ReviewSettings {
  return resolveReviewSettings(readJson(REVIEW_SETTINGS_KEY));
}

/** 写复盘设置（先规整再落盘，非法值不会污染存储）。 */
export function setReviewSettings(patch: Partial<ReviewSettings>): ReviewSettings {
  const next = resolveReviewSettings({ ...getReviewSettings(), ...patch });
  storage.setItem(REVIEW_SETTINGS_KEY, JSON.stringify(next));
  return next;
}

/** 最近一次复盘报告（记忆区展示用）。 */
export function getLastReviewReport(): ReviewReport | null {
  return readReviewReport(storage);
}

function writeLastReviewReport(report: ReviewReport): void {
  storage.setItem(REVIEW_REPORT_KEY, JSON.stringify(report));
}

/** 当前智能体的语义记忆字符占用与上限（记忆区容量条用）。 */
export function reviewCapacity(agentId: string): { used: number; limit: number } {
  return {
    used: semanticChars(memoryStore, agentId),
    limit: getReviewSettings().semanticCharLimit,
  };
}

/** 复盘用的依赖包（模型调用走智能体绑定的 LLM 连接）。 */
export function buildReviewDeps(profile: LlmProfile | undefined, agentId: string): ReviewDeps {
  return {
    store: memoryStore,
    skills: skillPool,
    // 用智能体自己的连接做复盘：同一个模型判断「这次对话有什么值得记」，口径才一致
    callModel: async (messages) => {
      if (!profile) throw new Error("该智能体未绑定 LLM 连接");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20_000);
      try {
        let out = "";
        await streamChat(profile, messages, {
          signal: controller.signal,
          onDelta: (t) => {
            out += t;
          },
        });
        return out;
      } finally {
        clearTimeout(timer);
      }
    },
    readAgentPrefs: (id) => agentPrefsStore.get(id),
    readSettings: getReviewSettings,
    writeSettings: setReviewSettings,
    readCounters: () => {
      const raw = readJson(REVIEW_COUNTERS_KEY);
      return raw && typeof raw === "object" ? (raw as Record<string, number>) : {};
    },
    writeCounters: (counters) => storage.setItem(REVIEW_COUNTERS_KEY, JSON.stringify(counters)),
  };
}

export type MaybeReviewInput = RunReviewInput & {
  /** 智能体绑定的 LLM 连接；缺失则跳过复盘（不猜模型）。 */
  profile: LlmProfile | undefined;
};

/**
 * 轮次结束后调用：**即发即忘**，不 await、不阻塞流式渲染。
 *
 * 三道闸门（任一不过就静默跳过）：记忆总开关开着、智能体长期记忆开着、有绑定的 LLM 连接。
 * 跑完把结果写进「最近一次报告」，供记忆区展示——机制可见，不做黑盒。
 */
export function maybeRunReview(input: MaybeReviewInput): void {
  try {
    if (!memoryStore.getSettings().enabled) return;
    const prefs = input.profile ? agentPrefsStore.get(input.agentId) : null;
    if (!prefs?.longTerm && input.profile) {
      // 没开长期记忆就不做复盘（技能沉淀也一并跳过：它同属「沉淀」语义）
      return;
    }
    if (!input.profile) return;
    const deps = buildReviewDeps(input.profile, input.agentId);
    void runReview(deps, input)
      .then((report) => {
        writeLastReviewReport(report);
      })
      .catch(() => {
        /* 复盘失败静默：绝不影响主链路 */
      });
  } catch {
    /* 同上 */
  }
}

/**
 * 手动触发一次复盘（记忆区「立即复盘」按钮）：忽略频率与计数器，但**仍然**遵守
 * 敏感信息拒绝、长期记忆开关与容量上限——手动也不能绕过安全阀。
 */
export async function runReviewNow(
  input: RunReviewInput & { profile: LlmProfile | undefined },
): Promise<ReviewReport> {
  const deps = buildReviewDeps(input.profile, input.agentId);
  const forced: ReviewDeps = {
    ...deps,
    readSettings: () => ({ ...getReviewSettings(), frequency: "always", turnsThreshold: 1 }),
  };
  const report = await runReview(forced, input);
  writeLastReviewReport(report);
  return report;
}

export { DEFAULT_REVIEW_SETTINGS };
export type { ReviewReport, ReviewSettings };