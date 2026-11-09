import { describe, expect, it } from "vitest";
import {
  MAGPIE_PRESETS,
  defaultPlanOption,
  detectPlanFromShow,
  findPreset,
  parseShowUrls,
  planOptionOf,
  presetAddArgs,
} from "./magpiePresets.js";

/** 厂商 / 地址类型（Coding Plan）映射的纯函数：参数生成与 show 输出解析。 */

describe("MAGPIE_PRESETS", () => {
  it("每个厂商都有至少一个地址类型，id 不重复", () => {
    const ids = MAGPIE_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const preset of MAGPIE_PRESETS) {
      expect(preset.planOptions.length).toBeGreaterThan(0);
      expect(preset.name).not.toBe("");
    }
  });

  it("有普通地址可选时默认普通（只有会员地址的 kimi-code 例外）", () => {
    for (const preset of MAGPIE_PRESETS) {
      const option = defaultPlanOption(preset);
      const hasNormal = preset.planOptions.some((item) => item.kind === "normal");
      expect(option.kind).toBe(hasNormal ? "normal" : "coding");
    }
    expect(defaultPlanOption(findPreset("kimi-code")!).kind).toBe("coding");
  });

  it("Coding Plan 选项带内核认的 region：zhipu=coding，stepfun=plan，minimax 不传", () => {
    expect(planOptionOf(findPreset("zhipu"), "coding")?.region).toBe("coding");
    expect(planOptionOf(findPreset("stepfun"), "plan")?.region).toBe("plan");
    expect(planOptionOf(findPreset("minimax"), "coding-key")?.region).toBeUndefined();
    expect(planOptionOf(findPreset("kimi-code"), "membership")?.kind).toBe("coding");
  });
});

describe("presetAddArgs", () => {
  it("普通地址不传 region", () => {
    expect(presetAddArgs("zhipu", "api", "sk-1")).toEqual(["provider", "add", "zhipu", "sk-1"]);
    expect(presetAddArgs("deepseek", "api", " sk-2 ")).toEqual([
      "provider",
      "add",
      "deepseek",
      "sk-2",
    ]);
  });

  it("planId 缺省也按普通地址走（页面首次选中时）", () => {
    expect(presetAddArgs("zhipu", null, "sk-1")).toEqual(["provider", "add", "zhipu", "sk-1"]);
    expect(presetAddArgs("zhipu", undefined, "sk-1")).toEqual(["provider", "add", "zhipu", "sk-1"]);
  });

  it("Coding Plan 追加 region=", () => {
    expect(presetAddArgs("zhipu", "coding", "sk-1")).toEqual([
      "provider",
      "add",
      "zhipu",
      "sk-1",
      "region=coding",
    ]);
    expect(presetAddArgs("stepfun", "plan", "sk-1")).toEqual([
      "provider",
      "add",
      "stepfun",
      "sk-1",
      "region=plan",
    ]);
  });

  it("minimax 的 Coding Plan Key 与普通地址同一个，不追加参数", () => {
    expect(presetAddArgs("minimax", "coding-key", "sk-cp-1")).toEqual([
      "provider",
      "add",
      "minimax",
      "sk-cp-1",
    ]);
    expect(presetAddArgs("minimax", "api", "sk-1")).toEqual(["provider", "add", "minimax", "sk-1"]);
  });

  it("kimi-code 是独立 preset：普通 Kimi 走 moonshot", () => {
    expect(presetAddArgs("kimi-code", "membership", "sk-1")).toEqual([
      "provider",
      "add",
      "kimi-code",
      "sk-1",
    ]);
    expect(presetAddArgs("moonshot", "api", "sk-1")).toEqual([
      "provider",
      "add",
      "moonshot",
      "sk-1",
    ]);
  });

  it("不认识的 preset / planId 原样下发，不带 region", () => {
    expect(presetAddArgs("my-relay", "coding", "sk-1")).toEqual([
      "provider",
      "add",
      "my-relay",
      "sk-1",
    ]);
    expect(presetAddArgs("zhipu", "nope", "sk-1")).toEqual(["provider", "add", "zhipu", "sk-1"]);
  });
});

describe("parseShowUrls / detectPlanFromShow", () => {
  const zhipuCoding = [
    "  Zhipu GLM  zhipu",
    "  chat       https://open.bigmodel.cn/api/coding/paas/v4",
    "  responses  https://open.bigmodel.cn/api/v1",
    "  anthropic  https://open.bigmodel.cn/api/anthropic",
    "  key        ••••abcd",
  ].join("\n");

  const zhipuNormal = [
    "  Zhipu GLM  zhipu",
    "  chat       https://open.bigmodel.cn/api/paas/v4",
    "  anthropic  https://open.bigmodel.cn/api/anthropic",
  ].join("\n");

  it("认 ANSI 与对齐空白", () => {
    const urls = parseShowUrls("\u001b[2m  chat       \u001b[0mhttps://api.deepseek.com");
    expect(urls).toEqual({ chat: "https://api.deepseek.com", responses: "", anthropic: "" });
  });

  it("GLM Coding Plan（chat 带 /coding、responses 是 /api/v1）→ coding", () => {
    expect(detectPlanFromShow(zhipuCoding)).toBe("coding");
  });

  it("GLM 按量（/api/paas/v4）→ normal", () => {
    expect(detectPlanFromShow(zhipuNormal)).toBe("normal");
  });

  it("Step Plan 的 /step_plan → coding；Kimi Code 的 /coding → coding", () => {
    expect(detectPlanFromShow("  chat       https://api.stepfun.ai/step_plan/v1")).toBe("coding");
    expect(detectPlanFromShow("  chat       https://api.kimi.ai/coding/v1")).toBe("coding");
  });

  it("Token Plan 的 host（token-plan-cn.xiaomimimo.com）→ coding", () => {
    expect(
      detectPlanFromShow("  chat       https://token-plan-cn.xiaomimimo.com/v1"),
    ).toBe("coding");
  });

  it("只靠 /api/v1 认 GLM，别家的 /api/v1 不误判", () => {
    expect(detectPlanFromShow("  responses  https://open.bigmodel.cn/api/v1")).toBe("coding");
    expect(detectPlanFromShow("  chat       https://relay.example.com/api/v1")).toBe("normal");
  });

  it("认不出地址（命令失败/输出变了）→ null", () => {
    expect(detectPlanFromShow("")).toBeNull();
    expect(detectPlanFromShow("no such provider: zhipu")).toBeNull();
  });
});
