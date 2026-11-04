import { describe, expect, it } from "vitest";
import { carriedStatus, classifyFailure, decodeWords, humanizeProviderError, retryable } from "./llmFailure.js";

/**
 * 失败分类判据（规则来自 magpie 的 failure()/retryable()）。
 * 每个用例都写成供应商真实返回的样子，不写「假想的错误」。
 */

const sig = (status: number, body: string, retryAfterMs = 0) => ({ status, body, retryAfterMs });

describe("decodeWords：JSON 转义要先解码再匹配", () => {
  it("网关把中文错误写成 \\uXXXX 时仍能命中词表", () => {
    const raw = String.raw`{"message":"\u4f59\u989d\u4e0d\u8db3\uff0c\u8bf7\u5145\u503c"}`;
    expect(decodeWords(raw)).toContain("余额不足");
    expect(classifyFailure(sig(429, raw)).kind).toBe("credit");
  });
});

describe("overflow：会话太长不是账号的错", () => {
  const cases: [number, string][] = [
    [400, '{"error":{"message":"This model\'s maximum context length is 8192 tokens"}}'],
    [400, '{"error":{"code":"context_length_exceeded"}}'],
    [400, '{"error":{"type":"invalid_request_error","message":"prompt is too long: 210000 tokens"}}'],
  ];
  it.each(cases)("HTTP %d %s → overflow、不冷却、只排除这个模型", (status, body) => {
    const v = classifyFailure(sig(status, body));
    expect(v.kind).toBe("overflow");
    expect(v.rests).toBe(false);
    expect(v.scope).toBe("model");
    // magpie :1623 说「换账号也没用」——但换窗口更大的模型值得试（roomy/withRoom）
    expect(v.failover).toBe(true);
  });

  it("context_length_exceeded 里的 exceeded 不得被读成限流（magpie #1944）", () => {
    expect(classifyFailure(sig(400, '{"code":"context_length_exceeded"}')).kind).not.toBe("quota");
  });
});

describe("429 的四种读法", () => {
  it("每分钟速率限制 → rate（短冷却）", () => {
    const v = classifyFailure(
      sig(429, '{"error":{"message":"Rate limit reached for requests per minute (RPM). Please retry."}}'),
    );
    expect(v.kind).toBe("rate");
    expect(v.scope).toBe("account");
  });

  it("套餐额度用完（带「用量/额度」字样）→ quota（中冷却）", () => {
    const v = classifyFailure(sig(429, '{"error":{"message":"您本月套餐额度已用尽"}}'));
    expect(v.kind).toBe("quota");
  });

  it("说了何时回来的 429 按额度处理，不等一分钟", () => {
    const v = classifyFailure(sig(429, '{"error":{"message":"usage limit reached"}}', 3 * 60_000));
    expect(v.kind).toBe("quota");
  });

  it("429 但说的是余额没钱 → credit（长阶梯）", () => {
    const v = classifyFailure(sig(429, '{"error":{"message":"余额不足或无可用资源包，请充值"}}'));
    expect(v.kind).toBe("credit");
  });

  it("裸 429 没有措辞也按 rate 处理，且要换候选", () => {
    const v = classifyFailure(sig(429, ""));
    expect(v.kind).toBe("rate");
    expect(retryable(v)).toBe(true);
  });

  it("429 里链接上的「daily quota」不算套餐词，仍按速率（magpie urlWords）", () => {
    const v = classifyFailure(
      sig(429, '{"error":{"message":"too many requests, see https://x.ai/your-daily-quota"}}'),
    );
    expect(v.kind).toBe("rate");
  });
});

describe("钱的问题", () => {
  it("402 → credit", () => {
    expect(classifyFailure(sig(402, '{"error":{"type":"insufficient_quota"}}')).kind).toBe("credit");
  });
  it("400 + 积分不足 → credit（SuperMagic 那种 400 说没钱）", () => {
    const v = classifyFailure(sig(400, '{"message":"您的可用积分已不足，请通过「充值」通道补充积分"}'));
    expect(v.kind).toBe("credit");
    expect(retryable(v)).toBe(true);
  });
});

describe("Key 与账号状态", () => {
  it("裸 401 → auth：换候选，账号冷却", () => {
    const v = classifyFailure(sig(401, '{"error":{"type":"authentication_error"}}'));
    expect(v.kind).toBe("auth");
    expect(v.rests).toBe(true);
    expect(v.failover).toBe(true);
  });

  it("403 + 账号受限 → restricted（要申诉，不是等）", () => {
    const v = classifyFailure(sig(403, '{"error":{"message":"your account is restricted, please appeal"}}'));
    expect(v.kind).toBe("restricted");
  });

  it("403 + 要你验证 → verify", () => {
    const v = classifyFailure(sig(403, '{"error":{"message":"verification is required for this account"}}'));
    expect(v.kind).toBe("verify");
  });
});

describe("模型层面的拒绝只关这个模型", () => {
  it("410 模型下架 → modelGone，作用域到模型", () => {
    const v = classifyFailure(
      sig(410, '{"error":{"type":"ModelDeprecated","message":"Model exo-free has been deprecated."}}'),
    );
    expect(v.kind).toBe("modelGone");
    expect(v.scope).toBe("model");
    expect(retryable(v)).toBe(true);
  });

  it("403「当前 token plan 不含此模型」→ 只冷却模型，Key 其他模型照问", () => {
    const v = classifyFailure(sig(403, '{"error":{"message":"model is not available in the current token plan"}}'));
    expect(v.kind).toBe("modelGone");
    expect(v.scope).toBe("model");
  });

  it("中转池说该模型凭据都在冷却 → modelGone", () => {
    const v = classifyFailure(
      sig(429, '{"error":{"message":"All credentials for model deepseek-chat are cooling down"}}'),
    );
    expect(v.kind).toBe("modelGone");
    expect(v.scope).toBe("model");
  });
});

describe("请求形状/地域/拒客：下一个候选可能吃，本候选不冷却", () => {
  it("400 参数形状不认 → shape、不冷却", () => {
    const v = classifyFailure(sig(400, '{"error":{"message":"unknown_parameter: top_k"}}'));
    expect(v.kind).toBe("shape");
    expect(v.rests).toBe(false);
    expect(retryable(v)).toBe(true);
  });

  it("400 地域不支持 → region、不冷却", () => {
    const v = classifyFailure(sig(400, '{"error":{"code":"unsupported_country_region_territory"}}'));
    expect(v.kind).toBe("region");
    expect(v.rests).toBe(false);
  });

  it("非法调用渠道 → refused、不冷却", () => {
    const v = classifyFailure(sig(403, '{"error":{"message":"Illegal API invocation from an unapproved channel"}}'));
    expect(v.kind).toBe("refused");
    expect(v.rests).toBe(false);
  });

  it("内容保护挡下 → protection，谁都不冷却、也不换（同一条历史每个账号都挡）", () => {
    const v = classifyFailure(sig(502, '{"error":{"message":"response protection is unavailable"}}'));
    expect(v.kind).toBe("protection");
    expect(v.rests).toBe(false);
    expect(retryable(v)).toBe(false);
  });
});

describe("服务端故障与中止", () => {
  it("500/502/503/408 → transient（同候选可再问）", () => {
    for (const s of [500, 502, 503, 408]) {
      const v = classifyFailure(sig(s, "<html>Bad Gateway</html>"));
      expect(v.kind).toBe("transient");
      expect(retryable(v)).toBe(true);
    }
  });

  it("传输层失败（status 0）→ transient", () => {
    const v = classifyFailure(sig(0, "Failed to fetch"));
    expect(v.kind).toBe("transient");
  });

  it("529 overloaded 是厂牌在忙，不是这家 Key 的错", () => {
    const v = classifyFailure(sig(529, '{"type":"error","error":{"type":"overloaded_error"}}'));
    expect(v.kind).toBe("transient");
    expect(retryable(v)).toBe(true);
  });
});

describe("carriedStatus：200 里携带的错误按真实状态读", () => {
  it("非 2xx 原样", () => {
    expect(carriedStatus(429, "anything")).toBe(429);
  });
  it("200 + 限流措辞 → 429", () => {
    expect(carriedStatus(200, '{"error":{"message":"Rate limit reached"}}')).toBe(429);
  });
  it("200 + 过载 → 529", () => {
    expect(carriedStatus(200, '{"error":{"type":"overloaded_error"}}')).toBe(529);
  });
  it("200 + 超限先于限流词（#1944）", () => {
    expect(carriedStatus(200, '{"error":{"code":"context_length_exceeded"}}')).toBe(400);
  });
  it("200 且没有错误措辞就还是 200", () => {
    expect(carriedStatus(200, '{"choices":[]}')).toBe(200);
  });
});

describe("裸 4xx 一律中止（magpie retryable 对普通 400 返回 false）", () => {
  it("400 无任何可换语义 → fatal", () => {
    const v = classifyFailure(sig(400, '{"error":{"message":"nothing recognizable here"}}'));
    expect(v.kind).toBe("fatal");
    expect(v.rests).toBe(false);
    expect(retryable(v)).toBe(false);
  });
});

describe("humanizeProviderError：供应商原文翻成人话（展示层用）", () => {
  it("429 不再把 JSON 原文甩给用户，但保留状态码", () => {
    const raw = 'provider_error: HTTP 429 {"error":{"message":"rate limit exceeded","type":"rate_limit_error"}}';
    const text = humanizeProviderError(raw);
    expect(text).toContain("HTTP 429");
    expect(text).toContain("稍等");
    expect(text).not.toContain("rate_limit_error");
    expect(text).not.toContain("provider_error");
  });

  it("401/404/5xx/400 各自给可操作的一句", () => {
    expect(humanizeProviderError("provider_error: HTTP 401 bad key")).toContain("API Key");
    expect(humanizeProviderError("provider_error: HTTP 404 not found")).toContain("Base URL");
    expect(humanizeProviderError("provider_error: HTTP 503 boom")).toContain("暂时不可用");
    expect(humanizeProviderError("provider_error: HTTP 400 nope")).toContain("模型名或参数");
  });

  it("网络层失败（无状态码）与未绑定连接都有明确指引", () => {
    expect(humanizeProviderError("provider_error: fetch failed")).toContain("检查网络");
    expect(humanizeProviderError("未绑定 LLM 连接")).toContain("设置 → 模型");
  });

  it("其它文案原样返回（不二次翻译，避免走样）", () => {
    expect(humanizeProviderError("长时间无响应，生成可能已中断")).toBe("长时间无响应，生成可能已中断");
    expect(humanizeProviderError("")).toBe("生成失败，请重试。");
  });
});
