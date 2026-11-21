import { describe, expect, it } from "vitest";
import { checkApiKey, normalizeProviderUrl, providerTestVerdict } from "./providerForm.js";

describe("checkApiKey", () => {
  it("合法 Key 不报错也不提示", () => {
    expect(checkApiKey("sk-1234567890abcdef")).toEqual({ error: null, warning: null });
    expect(checkApiKey("  sk-1234567890abcdef  ")).toEqual({ error: null, warning: null });
  });

  it("空值、夹空白、带 Bearer 前缀、误填地址都是明确错误", () => {
    expect(checkApiKey("   ").error).toMatch(/粘贴 API Key/);
    expect(checkApiKey("sk-abc def").error).toMatch(/空格或换行/);
    expect(checkApiKey("Bearer sk-1234567890").error).toMatch(/不要带/);
    expect(checkApiKey("Authorization: sk-123").error).toMatch(/不要带/);
    expect(checkApiKey("https://api.deepseek.com/v1").error).toMatch(/接口地址/);
  });

  it("过短的 Key 只提醒，不阻止保存（各厂商格式差异大）", () => {
    const short = checkApiKey("sk-x");
    expect(short.error).toBeNull();
    expect(short.warning).toMatch(/只复制了一部分/);
  });
});

describe("normalizeProviderUrl", () => {
  it("公网地址自动补 https，去掉尾部斜杠", () => {
    expect(normalizeProviderUrl("api.deepseek.com/v1/")).toEqual({
      url: "https://api.deepseek.com/v1",
      error: null,
      hint: expect.stringContaining("补成 https://"),
    });
    expect(normalizeProviderUrl("https://api.moonshot.cn/v1///").url).toBe(
      "https://api.moonshot.cn/v1",
    );
  });

  it("本机与局域网地址补 http", () => {
    expect(normalizeProviderUrl("127.0.0.1:39001/v1").url).toBe("http://127.0.0.1:39001/v1");
    expect(normalizeProviderUrl("192.168.1.9:8080/v1").url).toBe("http://192.168.1.9:8080/v1");
    expect(normalizeProviderUrl("localhost:3425/v1").url).toBe("http://localhost:3425/v1");
  });

  it("已带 scheme 的地址原样保留（只做规范化）", () => {
    expect(normalizeProviderUrl("http://10.0.0.5:1234/v1").url).toBe("http://10.0.0.5:1234/v1");
    expect(normalizeProviderUrl("https://relay.example.com/v1").url).toBe(
      "https://relay.example.com/v1",
    );
  });

  it("误填到 /chat/completions 时提示只填到 /v1，但不擅自截断", () => {
    const result = normalizeProviderUrl("https://api.openai.com/v1/chat/completions");
    expect(result.error).toBeNull();
    expect(result.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(result.hint).toMatch(/\/v1/);
  });

  it("空值与非法输入给出可操作错误", () => {
    expect(normalizeProviderUrl("   ").error).toMatch(/接口地址/);
    expect(normalizeProviderUrl("ftp://files.example.com").error).toMatch(/http/);
    expect(normalizeProviderUrl("http://").error).toMatch(/格式|主机名/);
  });
});

describe("providerTestVerdict", () => {
  it("成功时给一句话结论，并附上内核输出（去 ANSI、压空白）", () => {
    expect(providerTestVerdict(true, "\u001b[32mok\u001b[0m  2 models")).toBe(
      "连通正常：ok 2 models",
    );
    expect(providerTestVerdict(true, "")).toBe("连通正常，模型已读入。");
  });

  it("失败时保留错误尾部，方便用户自己判断", () => {
    expect(providerTestVerdict(false, "HTTP 401 bad key")).toBe("连不上：HTTP 401 bad key");
    expect(providerTestVerdict(false, null)).toMatch(/没有输出/);
  });

  it("长输出截断按码点，不在 emoji 中间劈出乱码", () => {
    const verdict = providerTestVerdict(true, "a".repeat(139) + "😀" + "tail");
    expect(verdict.endsWith("…")).toBe(true);
    const hasLone = [...verdict].some((ch) => {
      const code = ch.charCodeAt(0);
      return ch.length === 1 && code >= 0xd800 && code <= 0xdfff;
    });
    expect(hasLone).toBe(false);
  });
});