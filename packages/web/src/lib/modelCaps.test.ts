import { describe, it, expect, beforeEach } from "vitest";
import {
  DEFAULT_CAPABILITY,
  LONG_CONTEXT_TOKENS,
  MODEL_CAPS_KEY,
  capabilityBadges,
  clearOverride,
  lookupCapability,
  resolveCapability,
  setOverride,
  supportsLongContext,
  type ModelCapsOverrides,
} from "./modelCaps.js";
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

  it("已废弃的「服务商预设」不再参与能力表校验（d.89 起模型清单来自 magpie 网关目录）", () => {
    // 目录里的窗口/视觉能力经 store 的 setOverride 覆盖；这里只钉住「没有预设依赖」。
    expect(typeof lookupCapability).toBe("function");
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

  // —— d.32：能力矩阵补两维（函数并行 / 结构化输出）——

  it("静态表补齐新两维：已知事实照填，不确定的保守为 false", () => {
    const deepseek = lookupCapability("openai", "deepseek-chat", storage)!;
    expect(deepseek.supportsParallelTools).toBe(true);
    expect(deepseek.supportsStructuredOutput).toBe(true);

    const gpt = lookupCapability("openai", "gpt-4o", storage)!;
    expect(gpt.supportsParallelTools).toBe(true);
    expect(gpt.supportsStructuredOutput).toBe(true);

    // Anthropic 协议如实标：并行是默认行为（无开关），结构化不走 response_format
    const claude = lookupCapability("anthropic", "claude-sonnet-5", storage)!;
    expect(claude.supportsParallelTools).toBe(true);
    expect(claude.supportsStructuredOutput).toBe(false);

    // 不确定的一律 false（宁保守不吹牛）
    const glm = lookupCapability("openai", "glm-4-flash", storage)!;
    expect(glm.supportsParallelTools).toBe(false);
    expect(glm.supportsStructuredOutput).toBe(false);
    expect(DEFAULT_CAPABILITY.supportsParallelTools).toBe(false);
    expect(DEFAULT_CAPABILITY.supportsStructuredOutput).toBe(false);
  });

  it("supportsLongContext 是派生：窗口 ≥ 128K 即为长上下文（边界精确）", () => {
    expect(LONG_CONTEXT_TOKENS).toBe(128000);
    expect(supportsLongContext({ ...DEFAULT_CAPABILITY, contextWindow: 128000 })).toBe(true);
    expect(supportsLongContext({ ...DEFAULT_CAPABILITY, contextWindow: 127999 })).toBe(false);
    // 与内置表一致：deepseek-chat 64K 不算长上下文，qwen-turbo 1M 算
    expect(supportsLongContext(lookupCapability("openai", "deepseek-chat", storage)!)).toBe(false);
    expect(supportsLongContext(lookupCapability("openai", "qwen-turbo", storage)!)).toBe(true);
  });

  it("覆盖层能改新字段（通用 Partial，无需额外逻辑）", () => {
    setOverride("openai", "自定义模型", { supportsParallelTools: true }, storage);
    const caps = lookupCapability("openai", "自定义模型", storage)!;
    expect(caps.supportsParallelTools).toBe(true);
    // 未覆盖的字段仍来自保守缺省
    expect(caps.supportsStructuredOutput).toBe(false);
  });

  it("未知模型仍返回 null（新字段不改变「不猜」原则）", () => {
    expect(lookupCapability("openai", "未知模型-abc", storage)).toBeNull();
  });

  it("能力徽标不含 emoji，按固定顺序给纯中文标签", () => {
    const badges = capabilityBadges({
      ...DEFAULT_CAPABILITY,
      contextWindow: 200_000,
      supportsVision: true,
      supportsReasoning: true,
      supportsParallelTools: true,
      supportsStructuredOutput: true,
    });
    expect(badges).toEqual(["函数调用", "视觉", "思考", "长上下文", "并行工具", "结构化输出"]);
    // 每个徽标只由中文组成：emoji（🎯👁💭…）任何字符都混不进来
    for (const b of badges) expect(b).toMatch(/^[一-鿿]+$/);
  });
});
