import { describe, it, expect, beforeEach } from "vitest";
import {
  DEFAULT_CAPABILITY,
  MODEL_CAPS_KEY,
  clearOverride,
  lookupCapability,
  resolveCapability,
  setOverride,
  type ModelCapsOverrides,
} from "./modelCaps.js";
import { LLM_PRESETS } from "./llmPresets.js";
import type { StorageLike } from "./memory/types.js";

/** 内存存储：每个测试一份，互不干扰。 */
class FakeStorage implements StorageLike {
  private readonly map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
}

describe("模型能力表", () => {
  let storage: FakeStorage;
  beforeEach(() => {
    storage = new FakeStorage();
  });

  it("llmPresets 的 7 个预设模型全部命中非 null", () => {
    for (const preset of LLM_PRESETS) {
      const caps = lookupCapability(preset.provider, preset.model, storage);
      expect(caps, `预设 ${preset.label}（${preset.model}）应命中能力表`).not.toBeNull();
      expect(caps!.contextWindow).toBeGreaterThan(0);
    }
  });

  it("未知模型返回 null（不猜——猜错会让供应商 400）", () => {
    expect(lookupCapability("openai", "某个完全没见过的模型", storage)).toBeNull();
    expect(lookupCapability("openai", "", storage)).toBeNull();
  });

  it("前缀匹配：deepseek-reasoner 命中 deepseek 家族且支持思考", () => {
    const caps = lookupCapability("openai", "deepseek-reasoner", storage);
    expect(caps).not.toBeNull();
    expect(caps!.supportsReasoning).toBe(true);
    // 同一家族的非思考型号不带思考能力
    expect(lookupCapability("openai", "deepseek-chat", storage)!.supportsReasoning).toBe(false);
  });

  it("家族启发：带 deepseek 的衍生型号也能命中", () => {
    expect(lookupCapability("openai", "deepseek-v3-0324", storage)).not.toBeNull();
  });

  it("用户覆盖层优先级最高", () => {
    setOverride("openai", "deepseek-chat", { contextWindow: 999999 }, storage);
    const caps = lookupCapability("openai", "deepseek-chat", storage);
    expect(caps!.contextWindow).toBe(999999);
    // 覆盖只改指定字段，其余仍来自表
    expect(caps!.supportsTools).toBe(true);
  });

  it("覆盖层对未知模型也生效（用户手填了就认）", () => {
    expect(lookupCapability("openai", "私有部署模型", storage)).toBeNull();
    setOverride("openai", "私有部署模型", { contextWindow: 128000, supportsTools: false }, storage);
    const caps = lookupCapability("openai", "私有部署模型", storage);
    expect(caps).not.toBeNull();
    expect(caps!.contextWindow).toBe(128000);
    expect(caps!.supportsTools).toBe(false);
  });

  it("删掉覆盖后回到内置表", () => {
    setOverride("openai", "deepseek-chat", { contextWindow: 1 }, storage);
    clearOverride("openai", "deepseek-chat", storage);
    const caps = lookupCapability("openai", "deepseek-chat", storage);
    expect(caps!.contextWindow).toBe(64000);
  });

  it("覆盖层只落本机（键带版本后缀）", () => {
    setOverride("openai", "deepseek-chat", { contextWindow: 1 }, storage);
    const raw = JSON.parse(storage.getItem(MODEL_CAPS_KEY) as string) as ModelCapsOverrides;
    expect(raw["openai:deepseek-chat"]).toEqual({ contextWindow: 1 });
  });

  it("存储损坏时覆盖层读成空（不抛错）", () => {
    storage.setItem(MODEL_CAPS_KEY, "{ 不是 json");
    expect(lookupCapability("openai", "deepseek-chat", storage)!.contextWindow).toBe(64000);
  });

  it("resolveCapability 查不到时给保守缺省（永不返回 null）", () => {
    const caps = resolveCapability({ provider: "openai", model: "某个没见过的模型" }, storage);
    expect(caps).toEqual(DEFAULT_CAPABILITY);
    // 缺省窗口刻意保守：宁可少发历史，也不撞供应商上限
    expect(caps.contextWindow).toBe(8192);
  });
});
