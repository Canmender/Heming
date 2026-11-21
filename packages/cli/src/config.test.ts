import { describe, expect, it } from "vitest";
import { resolveModelConfig } from "./config.js";

describe("resolveModelConfig 的 baseUrl 校验", () => {
  it("只有 scheme 没有主机的残址被拒绝，不会压成 http: 发错地方", () => {
    for (const url of ["http://", "https://", "http:///", " https:// "]) {
      const result = resolveModelConfig({ apiKey: "k" }, { HEMING_BASE_URL: url });
      expect(result.ok).toBe(false);
      expect((result as { error: string }).error).toMatch(/带主机的 http/);
    }
  });

  it("没有 scheme 的地址照旧被拒绝", () => {
    const result = resolveModelConfig({ apiKey: "k" }, { HEMING_BASE_URL: "api.example.com/v1" });
    expect(result.ok).toBe(false);
  });

  it("合法地址归一掉末尾斜杠后保留主机", () => {
    const result = resolveModelConfig(
      { apiKey: "k" },
      { HEMING_BASE_URL: "https://api.example.com/v1///" },
    );
    expect(result).toEqual({
      ok: true,
      config: { apiKey: "k", baseUrl: "https://api.example.com/v1", model: "gpt-4o-mini" },
    });
  });

  it("非 http(s) 协议被拒绝", () => {
    const result = resolveModelConfig({ apiKey: "k" }, { HEMING_BASE_URL: "ftp://example.com/v1" });
    expect(result.ok).toBe(false);
  });
});
