import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryStorage } from "./memory/storage.js";
import {
  ONBOARDING_KEY,
  chatExamplesFor,
  deriveOnboardingSteps,
  normalizeOnboarding,
  onboardingAllDone,
  readOnboardingState,
  setOnboardingStorage,
  shouldShowOnboarding,
  useOnboardingStore,
} from "./onboarding.js";

/**
 * UX-A 首跑引导：三步骤状态从真实计数派生；关闭状态只存本机且可持久化。
 * 这里只测纯函数与 store，不测卡片长相（组件测试另有一份）。
 */

const INPUTS = { connections: 0, conversations: 0, tasks: 0 };

beforeEach(() => {
  localStorage.removeItem(ONBOARDING_KEY);
  setOnboardingStorage(createMemoryStorage());
  useOnboardingStore.setState({ dismissedAt: null });
});

describe("deriveOnboardingSteps", () => {
  it("三步定义固定：配模型 → 对话 → 建任务，顺序与去处确定", () => {
    const steps = deriveOnboardingSteps(INPUTS);
    expect(steps.map((s) => s.id)).toEqual(["model", "chat", "task"]);
    expect(steps.map((s) => s.target)).toEqual(["settings", "chat", "tasks"]);
    expect(steps.every((s) => s.done === false)).toBe(true);
    expect(onboardingAllDone(steps)).toBe(false);
  });

  it("完成状态由真实计数派生（不是硬编码）", () => {
    const steps = deriveOnboardingSteps({ connections: 1, conversations: 2, tasks: 0 });
    expect(steps.map((s) => s.done)).toEqual([true, true, false]);
    expect(onboardingAllDone(steps)).toBe(false);
    expect(onboardingAllDone(deriveOnboardingSteps({ connections: 1, conversations: 1, tasks: 1 }))).toBe(
      true,
    );
  });

  it("每步都带可执行按钮文案（完成前可用）", () => {
    for (const step of deriveOnboardingSteps(INPUTS)) {
      expect(step.actionLabel.length).toBeGreaterThan(0);
      expect(step.title.length).toBeGreaterThan(0);
    }
  });
});

describe("shouldShowOnboarding", () => {
  it("无任何模型连接且没关过 → 显示", () => {
    expect(shouldShowOnboarding(INPUTS, null)).toBe(true);
  });

  it("已有连接 → 不再显示（引导只服务首跑）", () => {
    expect(shouldShowOnboarding({ ...INPUTS, connections: 1 }, null)).toBe(false);
  });

  it("用户关闭过 → 永不显示（关闭只存本机时间戳）", () => {
    expect(shouldShowOnboarding(INPUTS, Date.now())).toBe(false);
  });

  it("三步骤全部完成 → 自动消失", () => {
    const inputs = { connections: 1, conversations: 1, tasks: 1 };
    expect(shouldShowOnboarding(inputs, null)).toBe(false);
  });
});

describe("关闭状态持久化", () => {
  it("dismiss 只写本机 heming.onboarding.v1（时间戳），reset 清空", () => {
    const store = createMemoryStorage();
    setOnboardingStorage(store);

    useOnboardingStore.getState().dismiss(1_700_000_000_000);
    expect(useOnboardingStore.getState().dismissedAt).toBe(1_700_000_000_000);
    const raw = JSON.parse(store.getItem(ONBOARDING_KEY) ?? "{}") as { dismissedAt?: number };
    expect(raw.dismissedAt).toBe(1_700_000_000_000);
    expect(readOnboardingState(store).dismissedAt).toBe(1_700_000_000_000);

    useOnboardingStore.getState().reset();
    expect(useOnboardingStore.getState().dismissedAt).toBeNull();
    expect(readOnboardingState(store).dismissedAt).toBeNull();
  });

  it("坏数据/旧结构回落为「没关闭过」，不抛", () => {
    expect(normalizeOnboarding(null)).toEqual({ dismissedAt: null });
    expect(normalizeOnboarding({ dismissedAt: -1 })).toEqual({ dismissedAt: null });
    expect(normalizeOnboarding({ dismissedAt: "昨天" })).toEqual({ dismissedAt: null });
    const store = createMemoryStorage();
    store.setItem(ONBOARDING_KEY, "{ 坏 json");
    expect(readOnboardingState(store).dismissedAt).toBeNull();
  });
});

describe("chatExamplesFor（对话空态示例）", () => {
  it("永远给 3 条、文本非空且互不相同", () => {
    for (const input of [{}, { tools: true }, { vision: true }, { tools: true, vision: true }]) {
      const examples = chatExamplesFor(input);
      expect(examples).toHaveLength(3);
      expect(new Set(examples.map((e) => e.text)).size).toBe(3);
      expect(examples.every((e) => e.text.trim().length > 0)).toBe(true);
    }
  });

  it("按能力挑选第三条：有工具给工具示例，只有视觉给视觉示例，都没有给润色示例", () => {
    expect(chatExamplesFor({ tools: true })[2]!.id).toBe("tool");
    expect(chatExamplesFor({ vision: true })[2]!.id).toBe("vision");
    expect(chatExamplesFor({})[2]!.id).toBe("polish");
    // 工具优先于视觉（工具能做的事更具体）
    expect(chatExamplesFor({ tools: true, vision: true })[2]!.id).toBe("tool");
  });
});
