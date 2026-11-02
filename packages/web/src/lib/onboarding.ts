import { create } from "zustand";
import { createDefaultStorage, readJson, writeJson } from "./memory/storage.js";
import type { StorageLike } from "./memory/types.js";

/**
 * 首跑引导（本机）与对话示例（纯数据）。
 *
 * 边界：
 * - 只有「用户手动关闭」这一件事需要落盘，键 `heming.onboarding.v1`，**只存本机**、不上云；
 * - 三步骤的完成状态**不落盘**：每次从真实 store 派生（连接数 / 会话数 / 任务数），
 *   硬编码状态迟早和现实对不上。
 */

export const ONBOARDING_KEY = "heming.onboarding.v1";
/** 这个键只存一个时间戳，4KB 足够；写满/写失败静默（下次打开最多再看一遍引导）。 */
const ONBOARDING_BYTE_LIMIT = 4 * 1024;

export interface OnboardingState {
  /** 用户点「不再显示」的时刻（epoch ms）；null = 没关闭过。 */
  dismissedAt: number | null;
}

export const DEFAULT_ONBOARDING: OnboardingState = { dismissedAt: null };

export function normalizeOnboarding(raw: unknown): OnboardingState {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_ONBOARDING };
  const o = raw as Record<string, unknown>;
  return {
    dismissedAt:
      typeof o.dismissedAt === "number" && Number.isFinite(o.dismissedAt) && o.dismissedAt > 0
        ? Math.floor(o.dismissedAt)
        : null,
  };
}

let storage: StorageLike | null = null;

/** 测试注入点：传 null 恢复默认（jsdom localStorage）。 */
export function setOnboardingStorage(next: StorageLike | null): void {
  storage = next;
}

function getStorage(): StorageLike {
  return (storage ??= createDefaultStorage());
}

export function readOnboardingState(store: StorageLike = getStorage()): OnboardingState {
  return readJson(store, ONBOARDING_KEY, { ...DEFAULT_ONBOARDING }, normalizeOnboarding);
}

function persist(state: OnboardingState): void {
  writeJson(getStorage(), ONBOARDING_KEY, state, ONBOARDING_BYTE_LIMIT);
}

interface OnboardingStore extends OnboardingState {
  /** 用户主动关闭：只记本机，之后不再出现（除非 reset）。 */
  dismiss: (now?: number) => void;
  /** 重新打开引导（设置区/测试用）。 */
  reset: () => void;
}

export const useOnboardingStore = create<OnboardingStore>((set) => ({
  dismissedAt: readOnboardingState().dismissedAt,
  dismiss: (now = Date.now()) => {
    // 调用方可能误传事件对象（onClick 直接传函数时）：只有数字时间戳才认，否则用当前时间
    const at = typeof now === "number" && Number.isFinite(now) && now > 0 ? Math.floor(now) : Date.now();
    persist({ dismissedAt: at });
    set({ dismissedAt: at });
  },
  reset: () => {
    persist({ ...DEFAULT_ONBOARDING });
    set({ ...DEFAULT_ONBOARDING });
  },
}));

/* ------------------------------------------------------------ 三步骤派生 */

/** 引导步骤的去处（用 Page 的字面量类型，避免 lib 依赖整个 store）。 */
export type OnboardingTarget = "settings" | "chat" | "tasks";

export type OnboardingStepId = "model" | "chat" | "task";

export interface OnboardingStep {
  id: OnboardingStepId;
  title: string;
  /** 一句话说明这一步做什么（不是「已完成/未完成」那种废话）。 */
  description: string;
  done: boolean;
  /** 完成前按钮文案。 */
  actionLabel: string;
  target: OnboardingTarget;
}

export interface OnboardingInputs {
  /** 已配置的 LLM 连接数。 */
  connections: number;
  /** 已有的智能体会话数（真实会话列表，不是「点过智能体页」）。 */
  conversations: number;
  /** 本机任务记录数。 */
  tasks: number;
}

/** 三步骤定义 + 真实状态派生：同一个函数既给界面也给测试，避免两套判定。 */
export function deriveOnboardingSteps(inputs: OnboardingInputs): OnboardingStep[] {
  return [
    {
      id: "model",
      title: "配置模型连接",
      description: "填一个可用的模型服务地址与 Key，智能体才能开口说话。",
      done: inputs.connections > 0,
      actionLabel: "去配置模型",
      target: "settings",
    },
    {
      id: "chat",
      title: "和智能体对话",
      description: "在「智能体」页选一个已绑定的智能体，发第一句话。",
      done: inputs.conversations > 0,
      actionLabel: "去对话",
      target: "chat",
    },
    {
      id: "task",
      title: "建第一个任务",
      description: "把要做的事写成目标，让智能体带着工具跑一遍并留下汇总。",
      done: inputs.tasks > 0,
      actionLabel: "去建任务",
      target: "tasks",
    },
  ];
}

export function onboardingAllDone(steps: OnboardingStep[]): boolean {
  return steps.every((step) => step.done);
}

/**
 * 引导卡何时出现。
 *
 * 口径（规格 §2.A）：**没有任何模型连接**的首跑场景才出现；用户关过就永不出现；
 * 全部完成也自动消失（例如先在本机导入了配置）。「有没有连接」是唯一的入口闸，
 * 因为第二步/第三步在没有连接时本来也做不成。
 */
export function shouldShowOnboarding(
  inputs: OnboardingInputs,
  dismissedAt: number | null,
  steps: OnboardingStep[] = deriveOnboardingSteps(inputs),
): boolean {
  if (dismissedAt !== null) return false;
  if (onboardingAllDone(steps)) return false;
  return inputs.connections === 0;
}

/* ------------------------------------------------------------ 对话示例 */

export interface ChatExample {
  id: string;
  /** 点一下填进输入框的完整文本（不发送）。 */
  text: string;
}

/** 通用起步示例：不依赖任何工具能力，任何模型都能接。 */
const BASE_EXAMPLES: ChatExample[] = [
  { id: "summarize", text: "帮我把今天要做的事按优先级列一遍，并说明理由" },
  { id: "explain", text: "用通俗的话解释一下「端到端加密」，再给一个生活中的类比" },
];

/**
 * 空对话的 3 条示例（按能力挑选，只填入不发送）。
 *
 * 只挑**文本就能表达**的示例：示例里不假设用户已经附了图片/文件，
 * 否则点进去发出去只会得到「我没看到图」。
 */
export function chatExamplesFor(input: {
  tools?: boolean;
  vision?: boolean;
} = {}): ChatExample[] {
  const third: ChatExample = input.tools
    ? { id: "tool", text: "查一下本机的系统时间，再用一句话告诉我现在几点" }
    : input.vision
      ? { id: "vision", text: "我稍后发一张截图，你先告诉我可以从哪些角度帮你分析界面问题" }
      : { id: "polish", text: "把这句话改得更简洁有力：「这个方案在成本和可维护性上都比较平衡」" };
  return [...BASE_EXAMPLES, third].slice(0, 3);
}
