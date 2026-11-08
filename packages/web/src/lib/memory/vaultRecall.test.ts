import { describe, it, expect } from "vitest";
import { MemoryStore } from "./store.js";
import { MEMORY_CHAR_BUDGET, formatMemorySection, summarizeInjection } from "./format.js";
import { recallMemory } from "./recall.js";
import type { StorageLike } from "./types.js";
import { buildAgentContext } from "../agentRuntime/context.js";

/**
 * 知识库条目参与召回与注入（d.114）用例。
 *
 * 三条契约：
 * - 有知识库条目时：进语义段、文案标「来自知识库《rel》」、不再当普通长期记忆；
 * - 设置关闭 / 源不可用 / 没有条目时：**整体跳过且可观测**（`vault.skippedReason`）；
 * - 没有知识库也没有传选项时：返回值形状与旧版逐字一致（不回归既有调用点）。
 */

const NOW = new Date("2026-11-08T08:00:00.000Z").getTime();
const T0 = "2026-11-08T07:00:00.000Z";

class FakeStorage implements StorageLike {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    const value = this.map.get(key);
    return value === undefined ? null : value;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

function makeStore(): MemoryStore {
  return new MemoryStore(new FakeStorage(), () => NOW);
}

function seedVault(store: MemoryStore): void {
  store.upsertVaultEntries([
    {
      rel: "notes/发布计划.md",
      vaultId: "v1",
      mtime: T0,
      hash: "h1",
      value: "发布计划：周五前完成回归，线上监听 8787 端口。",
    },
    {
      rel: "notes/设计约定.md",
      vaultId: "v1",
      mtime: T0,
      hash: "h2",
      value: "设计约定：所有列表接口统一分页，默认每页 20 条。",
    },
  ]);
}

describe("知识库条目参与语义召回", () => {
  it("命中查询时进语义候选，分数与 entry 对得上", () => {
    const store = makeStore();
    seedVault(store);
    const recalled = recallMemory(
      store,
      { agentId: "a1", conversationId: "c1", query: "发布计划的端口" },
      undefined,
      { enabled: true, available: true },
    );

    expect(recalled.vault).toMatchObject({ enabled: true, available: true, skippedReason: null, candidates: 2 });
    expect(recalled.vault?.picked).toBeGreaterThan(0);
    const vaultEntries = recalled.semantic.filter((entry) => entry.source === "vault");
    expect(vaultEntries.length).toBeGreaterThan(0);
    expect(vaultEntries[0].key).toBe("notes/发布计划.md");
    expect(recalled.scores[vaultEntries[0].id]).toBeGreaterThan(0);
  });

  it("知识库条目排在普通语义记忆之后（长期记忆优先占预算）", () => {
    const store = makeStore();
    store.upsertSemantic({ agentId: "a1", key: "偏好-语言", value: "简体中文", source: "manual" });
    seedVault(store);
    const recalled = recallMemory(
      store,
      { agentId: "a1", conversationId: "c1", query: "语言与发布计划" },
      undefined,
      { enabled: true, available: true },
    );
    const firstVaultAt = recalled.semantic.findIndex((entry) => entry.source === "vault");
    const lastPlainAt = recalled.semantic.map((entry) => entry.source !== "vault").lastIndexOf(true);
    if (firstVaultAt >= 0 && lastPlainAt >= 0) expect(firstVaultAt).toBeGreaterThan(lastPlainAt);
  });

  it("同一输入两次召回完全一致（无随机、tie-break 稳定）", () => {
    const store = makeStore();
    seedVault(store);
    const input = { agentId: "a1", conversationId: "c1", query: "发布计划 端口 设计约定" };
    const a = recallMemory(store, input, undefined, { enabled: true, available: true });
    const b = recallMemory(store, input, undefined, { enabled: true, available: true });
    expect(a.semantic.map((e) => e.id)).toEqual(b.semantic.map((e) => e.id));
    expect(a.scores).toEqual(b.scores);
    expect(a.vault).toEqual(b.vault);
  });
});

describe("注入文案与预算", () => {
  it("格式化标「来自知识库《rel》」，单条 ≤ 400 字", () => {
    const store = makeStore();
    store.upsertVaultEntries([
      { rel: "notes/长文.md", vaultId: "v1", mtime: T0, hash: "h", value: "正文".repeat(500) },
    ]);
    const recalled = recallMemory(
      store,
      { agentId: "a1", conversationId: "c1", query: "" },
      undefined,
      { enabled: true, available: true },
    );
    const text = formatMemorySection(recalled);
    expect(text).toContain("来自知识库《notes/长文.md》");
    const line = text.split("\n").find((row) => row.includes("来自知识库")) ?? "";
    expect([...line].length).toBeLessThanOrEqual(400 + "来自知识库《notes/长文.md》：".length + 2);
  });

  it("整轮仍受 1200 字总预算约束（知识库不额外加预算）", () => {
    const store = makeStore();
    seedVault(store);
    store.upsertSemantic({ agentId: "a1", key: "称呼", value: "阿和".repeat(100), source: "manual" });
    store.addEpisodic({ agentId: "a1", conversationId: "c1", summary: "很长的情景".repeat(100) });
    const recalled = recallMemory(
      store,
      { agentId: "a1", conversationId: "c1", query: "发布计划 称呼 情景" },
      undefined,
      { enabled: true, available: true },
    );
    expect(formatMemorySection(recalled).length).toBeLessThanOrEqual(MEMORY_CHAR_BUDGET);
  });
});

describe("整体跳过且可观测", () => {
  it("设置关闭 → 不注入，旁路里能看出 disabled", () => {
    const store = makeStore();
    seedVault(store);
    store.updateSettings({ vaultMemory: false });
    const recalled = recallMemory(store, { agentId: "a1", conversationId: "c1", query: "发布计划" });
    expect(recalled.semantic.some((entry) => entry.source === "vault")).toBe(false);
    expect(recalled.vault?.skippedReason).toBe("disabled");
    expect(recalled.vault?.candidates).toBe(2);
    expect(formatMemorySection(recalled)).not.toContain("来自知识库");
  });

  it("源未接入 → 不注入，旁路里能看出 unavailable（不是静默变空）", () => {
    const store = makeStore();
    seedVault(store);
    const recalled = recallMemory(store, { agentId: "a1", conversationId: "c1", query: "发布计划" }, undefined, {
      enabled: true,
      available: false,
    });
    expect(recalled.semantic.some((entry) => entry.source === "vault")).toBe(false);
    expect(recalled.vault?.skippedReason).toBe("unavailable");
  });

  it("没有纳入任何笔记 → empty（有记录可查，并不等于「功能坏了」）", () => {
    const store = makeStore();
    const recalled = recallMemory(store, { agentId: "a1", conversationId: "c1", query: "x" }, undefined, {
      enabled: true,
      available: true,
    });
    expect(recalled.vault).toEqual({
      enabled: true,
      available: true,
      skippedReason: "empty",
      candidates: 0,
      picked: 0,
    });
  });

  it("没有知识库条目且调用方没传选项 → 返回值形状与旧版一致（不含 vault 字段）", () => {
    const store = makeStore();
    const recalled = recallMemory(store, { agentId: "a1", conversationId: "c1", query: "x" });
    expect("vault" in recalled).toBe(false);
    const trace = summarizeInjection(recalled).observability;
    expect("vault" in trace).toBe(false);
  });
});

describe("buildAgentContext 的 vault 段（同步注入）", () => {
  const BASE = "你是和小鸣";

  it("知识库条目的摘要直接进提示词（不 await 读正文），且标来源", () => {
    const memory = makeStore();
    seedVault(memory);
    const out = buildAgentContext({
      agentId: "a1",
      conversationId: "c1",
      userText: "发布计划怎么定的",
      basePrompt: BASE,
      memory,
      vaultMemory: { available: true },
    });
    expect(out.systemPrompt.startsWith(BASE)).toBe(true);
    expect(out.systemPrompt).toContain("来自知识库《notes/发布计划.md》");
    expect(out.recallTrace.vault).toMatchObject({ enabled: true, available: true, skippedReason: null });
    expect(out.recallTrace.vault!.injected).toBeGreaterThan(0);
  });

  it("开关关闭 → 严格原样返回 basePrompt（无其它记忆时），旁路标 disabled", () => {
    const memory = makeStore();
    seedVault(memory);
    const out = buildAgentContext({
      agentId: "a1",
      conversationId: "c1",
      userText: "发布计划怎么定的",
      basePrompt: BASE,
      memory,
      vaultMemory: { enabled: false, available: true },
    });
    expect(out.systemPrompt).toBe(BASE);
    expect(out.recallTrace.vault?.skippedReason).toBe("disabled");
    expect(out.recallTrace.injected).toEqual([]);
  });

  it("源不可用 → 不注入但可见原因（basePrompt 原文不动）", () => {
    const memory = makeStore();
    seedVault(memory);
    const out = buildAgentContext({
      agentId: "a1",
      conversationId: "c1",
      userText: "发布计划怎么定的",
      basePrompt: BASE,
      memory,
      vaultMemory: { available: false },
    });
    expect(out.systemPrompt).toBe(BASE);
    expect(out.recallTrace.vault?.skippedReason).toBe("unavailable");
  });

  it("条目快照可覆盖（同步函数）：用传入条目而不是仓库里的", () => {
    const memory = makeStore();
    const out = buildAgentContext({
      agentId: "a1",
      conversationId: "c1",
      userText: "外部快照",
      basePrompt: BASE,
      memory,
      vaultMemory: {
        available: true,
        entries: () => [
          {
            id: "v-snap",
            agentId: "a1",
            key: "notes/快照.md",
            value: "快照摘要：外部笔记",
            scope: "user",
            confidence: 0.6,
            pinned: false,
            source: "vault",
            createdAt: T0,
            updatedAt: T0,
            vault: { vaultId: "v1", rel: "notes/快照.md", mtime: T0, hash: "h" },
          },
        ],
      },
    });
    expect(out.systemPrompt).toContain("来自知识库《notes/快照.md》");
    expect(out.recallTrace.vault?.candidates).toBe(1);
  });
});
