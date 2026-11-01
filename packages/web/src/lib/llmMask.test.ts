import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  clearMaskLedger,
  maskLedger,
  maskMessages,
  maskText,
  maskWords,
  setMaskWords,
} from "./llmMask.js";
import { streamChat, type ChatMessage } from "./llmClient.js";
import type { LlmProfile } from "../store/llm.js";

/**
 * 出站脱敏（d.48）：认得出的形状才动、认出的一定动、发出去的副本才动。
 * 每条断言都对着 llmMask.ts 头部那三条设计约束写。
 */

const SK = "sk-ABCDEFGHIJKLMNOPQRSTUV";
const GHP = "ghp_AAAAAAAAAAAAAAAAAAAA";
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3OIn0.abcdefghijklmnopqrstuvwxyz";
const BEARER = "Bearer abcdefghijklmnopqrstuvwxyz0123456789";
const IDCARD = "110101199003074567";

beforeEach(() => localStorage.clear());

describe("maskText：内置形状", () => {
  it("五类形状各命中一次，原文全部消失", () => {
    for (const secret of [SK, GHP, JWT, BEARER, IDCARD]) {
      localStorage.clear();
      const r = maskText(`我的凭据是 ${secret}，帮我看看`);
      expect(r.hits).toBe(1);
      expect(r.text).not.toContain(secret);
      expect(r.text).toContain("〔隐去-");
      expect(maskLedger()[0].original).toBe(secret);
    }
  });

  it("身份证末位 X 也认；不够 18 位的数字串不误伤", () => {
    expect(maskText("证号 11010119900307456X").hits).toBe(1);
    expect(maskText("订单 12345678901234567").hits).toBe(0);
  });

  it("短 sk- 片段不动——形状不够长就不是凭据（不猜）", () => {
    expect(maskText("sk-abc 只是个前缀").hits).toBe(0);
  });

  it("一次命中多处：同类两个 + 异类一个，各占一个号", () => {
    const r = maskText(`${SK} 和 sk-1234567890abcdefghij 还有 ${IDCARD}`);
    expect(r.hits).toBe(3);
    expect(r.text).not.toContain(SK);
    expect(r.text).not.toContain("sk-1234567890abcdefghij");
    expect(r.text).not.toContain(IDCARD);
    expect(maskLedger().map((x) => x.reason)).toEqual([
      "credential",
      "credential",
      "idCard",
    ]);
  });

  it("没有命中 → 返回**同一个字符串**，也不写对照表", () => {
    const text = "今天天气不错，我们聊聊架构";
    const r = maskText(text);
    expect(r.text).toBe(text);
    expect(r.hits).toBe(0);
    expect(maskLedger()).toEqual([]);
  });
});

describe("maskText：占位符与本机钥匙", () => {
  it("同一段原文跨调用拿到同一个占位符（历史里反复出现的 Key 不会每次换号）", () => {
    const a = maskText(`key=${SK}`);
    const b = maskText(`请复用 ${SK}`);
    expect(b.text).toContain(a.text.match(/〔隐去-[a-z0-9]+-\d+〕/)![0]);
    expect(maskLedger()).toHaveLength(1);
  });

  it("占位符里的钥匙跨调用稳定（每次现编会让服务商能反查，也让对照表对不上）", () => {
    const tagOf = (s: string) => s.match(/〔隐去-([a-z0-9]+)-/)![1];
    expect(tagOf(maskText(SK).text)).toBe(tagOf(maskText(IDCARD).text));
  });

  it("对照表满 200 条后丢最早的，序号继续递增不回头", () => {
    for (let i = 0; i < 201; i++) maskText(`sk-KEY${String(i).padStart(16, "0")}`);
    const ledger = maskLedger();
    expect(ledger).toHaveLength(200);
    expect(ledger[0].original).toBe("sk-KEY0000000000000001");
    expect(ledger[199].original).toBe("sk-KEY0000000000000200");
    expect(Number(ledger[199].placeholder.match(/-(\d+)〕$/)![1])).toBe(201);
  });

  it("clearMaskLedger 清空对照表但保留序号与钥匙（还原不了的东西不该复用旧号）", () => {
    maskText(SK);
    clearMaskLedger();
    expect(maskLedger()).toEqual([]);
    const r = maskText(GHP);
    expect(Number(r.text.match(/-(\d+)〕$/)![1])).toBe(2);
  });
});

describe("maskText：自定义词表（magpie redactWords）", () => {
  it("默认空表；setMaskWords 去空白去重后落本机", () => {
    expect(maskWords()).toEqual([]);
    setMaskWords([" 内部代号 ", "内部代号", "", "项目甲"]);
    expect(maskWords()).toEqual(["内部代号", "项目甲"]);
  });

  it("大小写不敏感整串替换，理由记为 word", () => {
    setMaskWords(["Apollo"]);
    const r = maskText("apollo 和 APOLLO 都指它");
    expect(r.hits).toBe(2);
    expect(r.text.toLowerCase()).not.toContain("apollo");
    expect(maskLedger().map((x) => x.reason)).toEqual(["word", "word"]);
    // 原文大小写各自留档：服务商看到的是两个不同占位符
    expect(new Set(maskLedger().map((x) => x.original))).toEqual(new Set(["apollo", "APOLLO"]));
  });

  it("词表里的正则元字符按字面匹配，不当模式用", () => {
    setMaskWords(["a.*b"]);
    const r = maskText("aab 与 a.*b 与 axxxb");
    expect(r.hits).toBe(1);
    expect(r.text).toContain("axxxb");
  });
});

describe("maskMessages：只换出站副本", () => {
  it("正文命中才复制该行，未命中的行沿用原对象引用", () => {
    const clean: ChatMessage = { role: "system", content: "你是助手" };
    const dirty: ChatMessage = { role: "user", content: `key ${SK}` };
    const res = maskMessages([clean, dirty]);
    expect(res.messages[0]).toBe(clean);
    expect(res.messages[1]).not.toBe(dirty);
    expect(res.messages[1].content).toContain("〔隐去-");
    expect(dirty.content).toContain(SK); // 调用方手里的原文不动
  });

  it("内容片的文本打码、图片片原样保留", () => {
    const msg: ChatMessage = {
      role: "user",
      content: "",
      contentParts: [
        { type: "text", text: `图上写了 ${SK}` },
        { type: "image", mime: "image/png", data: "aW1n" },
      ],
    };
    const out = maskMessages([msg]).messages[0];
    const [textPart, imagePart] = out.contentParts!;
    expect(textPart.type).toBe("text");
    if (textPart.type === "text") expect(textPart.text).toContain("〔隐去-");
    expect(imagePart).toEqual({ type: "image", mime: "image/png", data: "aW1n" });
  });

  it("工具调用参数里的凭据同样隐去（工具循环是本机拼的，服务商照收）", () => {
    const msg: ChatMessage = {
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "t1", function: { name: "http_get", arguments: `{"url":"https://x","token":"${SK}"}` } },
      ],
    };
    const out = maskMessages([msg]).messages[0];
    expect(out.tool_calls![0].function.arguments).toContain("〔隐去-");
    expect(out.tool_calls![0].function.name).toBe("http_get");
    expect(msg.tool_calls![0].function.arguments).toContain(SK);
  });

  it("整段无命中 → hits 为 0 且不写对照表", () => {
    const res = maskMessages([{ role: "user", content: "普通一句话" }]);
    expect(res.hits).toBe(0);
    expect(maskLedger()).toEqual([]);
  });
});

describe("streamChat 接线：脱敏只发生在发出去的那份", () => {
  const profile: LlmProfile = { id: "p", label: "l", provider: "openai", apiKey: "k", model: "m" };

  function sseResponse(chunks: string[]): Response {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        for (const c of chunks) controller.enqueue(enc.encode(c));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  }

  function sentBody(): string {
    const init = vi.mocked(globalThis.fetch).mock.calls[0][1] as RequestInit;
    return String(init.body);
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("mask 开启：请求体里有占位符、没有 Key，调用方的 messages 仍是原文", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      sseResponse(['data: {"choices":[{"delta":{"content":"好"}}]}\n\n', "data: [DONE]\n\n"]),
    );
    const messages: ChatMessage[] = [{ role: "user", content: `我的 key 是 ${SK}` }];
    await streamChat({ ...profile, mask: true }, messages, {
      signal: new AbortController().signal,
      onDelta: vi.fn(),
    });
    expect(sentBody()).toContain("〔隐去-");
    expect(sentBody()).not.toContain(SK);
    expect(messages[0].content).toContain(SK);
  });

  it("mask 关闭（默认）：请求体逐字包含原文，零开销", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      sseResponse(["data: [DONE]\n\n"]),
    );
    const messages: ChatMessage[] = [{ role: "user", content: `我的 key 是 ${SK}` }];
    await streamChat(profile, messages, {
      signal: new AbortController().signal,
      onDelta: vi.fn(),
    });
    expect(sentBody()).toContain(SK);
  });

  it("Key 头不受脱敏影响：authorization 照旧带 profile.apiKey", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse(["data: [DONE]\n\n"]));
    await streamChat({ ...profile, mask: true, apiKey: "sk-realkey1234567890abcd" }, [
      { role: "user", content: "你好" },
    ], { signal: new AbortController().signal, onDelta: vi.fn() });
    const init = vi.mocked(globalThis.fetch).mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-realkey1234567890abcd");
  });
});
