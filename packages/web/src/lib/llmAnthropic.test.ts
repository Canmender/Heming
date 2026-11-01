/**
 * IR → Anthropic 协议体的契约测试（d.49）。
 *
 * 每条规则都对应一个真实 400，所以断言写的是**形状**而不是「调用没抛」。
 * 三条护栏有专门的变异用例（空 text block、is_error、孤立事务）：把它们改坏必须立刻红。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  ANTHROPIC_EMPTY_TEXT,
  normalizeInputSchema,
  parseToolInput,
  readAnthropicContent,
  sanitizeToolId,
  toAnthropicMessages,
  toAnthropicSystemBlocks,
  toAnthropicSystemText,
  toAnthropicTools,
  type AnthropicBlock,
  type ToolResultBlock,
  type ToolUseBlock,
} from "./llmAnthropic.js";
import type { ChatMessage } from "./llmClient.js";

const msg = (m: Partial<ChatMessage> & { role: ChatMessage["role"] }): ChatMessage => ({
  content: "",
  ...m,
});

const text = (blocks: AnthropicBlock[]): string =>
  blocks.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");

afterEach(() => {
  vi.restoreAllMocks();
});


describe("sanitizeToolId", () => {
  it("非法字符换成下划线，空值给稳定占位", () => {
    expect(sanitizeToolId("call:1/2")).toBe("call_1_2");
    expect(sanitizeToolId("")).toBe("tool_0");
    expect(sanitizeToolId(undefined)).toBe("tool_0");
    expect(sanitizeToolId("ok-name_1")).toBe("ok-name_1");
  });

  it("同一 id 清洗两次相等：tool_use.id 与 tool_use_id 必须逐字一致", () => {
    const id = "a:b:c";
    expect(sanitizeToolId(id)).toBe(sanitizeToolId(id));
    const { messages } = toAnthropicMessages([
      msg({
        role: "assistant",
        tool_calls: [{ id, type: "function", function: { name: "t", arguments: "{}" } }],
      }),
      msg({ role: "tool", content: "结果", tool_call_id: id }),
    ]);
    const use = messages[0].content[0] as ToolUseBlock;
    const result = messages[1].content[0] as ToolResultBlock;
    expect(use.id).toBe(result.tool_use_id);
  });
});

describe("parseToolInput", () => {
  it("OpenAI 的 JSON 字符串 → Anthropic 的 input 对象", () => {
    expect(parseToolInput('{"a":1,"b":"x"}')).toEqual({ a: 1, b: "x" });
  });

  it("半个 JSON / 非对象 / 空串一律退回 {}", () => {
    expect(parseToolInput('{"a":')).toEqual({});
    expect(parseToolInput("[1,2]")).toEqual({});
    expect(parseToolInput('"str"')).toEqual({});
    expect(parseToolInput("")).toEqual({});
    expect(parseToolInput(undefined)).toEqual({});
    expect(parseToolInput(42)).toEqual({});
  });
});

describe("normalizeInputSchema", () => {
  it("缺 schema 给合法空对象（Anthropic 拒空 input_schema）", () => {
    expect(normalizeInputSchema(undefined)).toEqual({ type: "object", properties: {} });
    expect(normalizeInputSchema(null)).toEqual({ type: "object", properties: {} });
    expect(normalizeInputSchema("x")).toEqual({ type: "object", properties: {} });
    expect(normalizeInputSchema([1])).toEqual({ type: "object", properties: {} });
  });

  it("顶层 oneOf/allOf/anyOf 被拒 ⇒ 删掉并补 type:object", () => {
    const out = normalizeInputSchema({ oneOf: [{ type: "object" }, { type: "object" }] });
    expect(out).not.toHaveProperty("oneOf");
    expect(out).not.toHaveProperty("allOf");
    expect(out.type).toBe("object");
    expect(out.properties).toEqual({});
  });

  it("顶层 $schema 删掉（常是 URI 字符串，Anthropic 不认）", () => {
    const out = normalizeInputSchema({ $schema: "http://json-schema.org/draft-07/schema#", type: "object" });
    expect(out).not.toHaveProperty("$schema");
  });

  it("可空并集折成非空分支：anyOf:[obj,null] → obj", () => {
    const out = normalizeInputSchema({
      type: "object",
      properties: {
        limit: { anyOf: [{ type: "integer" }, { type: "null" }] },
      },
    });
    expect(out.properties).toEqual({ limit: { type: "integer" } });
  });

  it("三条以上分支的可空并集不动（折了会丢信息，宁原样发给供应商）", () => {
    const list = [{ type: "integer" }, { type: "string" }, { type: "null" }];
    const out = normalizeInputSchema({ type: "object", properties: { x: { anyOf: list } } });
    expect((out.properties as { x: { anyOf: unknown } }).x.anyOf).toHaveLength(3);
  });

  it("type:object 缺 properties ⇒ 补空对象", () => {
    expect(normalizeInputSchema({ type: "object" })).toEqual({ type: "object", properties: {} });
  });
});

describe("toAnthropicTools", () => {
  it("OpenAI tools 形状 → {name, description, input_schema}", () => {
    const out = toAnthropicTools([
      {
        type: "function",
        function: {
          name: "charts__bar",
          description: "画柱状图",
          parameters: { type: "object", properties: { a: { type: "string" } } },
        },
      },
    ]);
    expect(out).toEqual([
      {
        name: "charts__bar",
        description: "画柱状图",
        input_schema: { type: "object", properties: { a: { type: "string" } } },
      },
    ]);
  });

  it("重名丢弃后一个（Anthropic 对重复工具名硬 400）", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = toAnthropicTools([
      { type: "function", function: { name: "dup", parameters: { type: "object" } } },
      { type: "function", function: { name: "dup", parameters: { type: "object" } } },
    ]);
    expect(out).toHaveLength(1);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("dup"));
  });

  it("没有 name 或不是对象的条目跳过", () => {
    expect(toAnthropicTools([{ type: "function" }, null, { function: { name: "" } }] as never[])).toEqual([]);
    expect(toAnthropicTools(undefined)).toEqual([]);
  });

  it("缺 description/parameters 也能出合法形状", () => {
    expect(toAnthropicTools([{ function: { name: "t" } }])).toEqual([
      { name: "t", description: "", input_schema: { type: "object", properties: {} } },
    ]);
  });
});

describe("system 两种形态", () => {
  const rows = [msg({ role: "system", content: "A" }), msg({ role: "system", content: "B" })];

  it("字符串形态按 \\n 连接，没有 system 给 undefined", () => {
    expect(toAnthropicSystemText(rows)).toBe("A\nB");
    expect(toAnthropicSystemText([msg({ role: "user", content: "hi" })])).toBeUndefined();
    expect(toAnthropicSystemText([msg({ role: "system", content: "" })])).toBeUndefined();
  });

  it("block 形态把多条 system 合并成一块（块数影响缓存前缀稳定性）", () => {
    expect(toAnthropicSystemBlocks(rows)).toEqual([{ type: "text", text: "A\nB" }]);
    expect(toAnthropicSystemBlocks([msg({ role: "system", content: "A" })])).toEqual([
      { type: "text", text: "A" },
    ]);
    expect(toAnthropicSystemBlocks([msg({ role: "user", content: "hi" })])).toEqual([]);
  });
});

describe("toAnthropicMessages", () => {
  it("system 不进 messages；user 文本转 text block", () => {
    const { messages } = toAnthropicMessages([
      msg({ role: "system", content: "sys" }),
      msg({ role: "user", content: "hi" }),
    ]);
    expect(messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
  });

  it("护栏①：空内容转 (empty) 占位，绝不发空 text block", () => {
    const { messages } = toAnthropicMessages([msg({ role: "user", content: "" })]);
    expect(messages[0].content).toEqual([{ type: "text", text: "(empty)" }]);
    expect(ANTHROPIC_EMPTY_TEXT).toBe("(empty)");
  });

  it("多模态：可接受的图片走 base64 source，其余 mime 退成文本占位", () => {
    const { messages } = toAnthropicMessages([
      msg({
        role: "user",
        content: "看图",
        contentParts: [
          { type: "text", text: "看图" },
          { type: "image", mime: "image/png", data: "AAAA" },
          { type: "image", mime: "image/tiff", data: "BBBB" },
        ],
      }),
    ]);
    expect(messages[0].content).toEqual([
      { type: "text", text: "看图" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      { type: "text", text: "[不支持的图片格式: image/tiff]" },
    ]);
  });

  it("四种图片 mime 全认；其余一律退文本", () => {
    for (const mime of ["image/jpeg", "image/png", "image/gif", "image/webp"]) {
      const { messages } = toAnthropicMessages([
        msg({ role: "user", content: "", contentParts: [{ type: "image", mime, data: "x" }] }),
      ]);
      expect(messages[0].content[0].type).toBe("image");
    }
    const { messages } = toAnthropicMessages([
      msg({ role: "user", content: "", contentParts: [{ type: "image", mime: "image/bmp", data: "x" }] }),
    ]);
    expect(messages[0].content[0].type).toBe("text");
  });

  it("role:tool → tool_result 挂在 user 消息里，且连续结果合并成同一条", () => {
    const { messages } = toAnthropicMessages([
      msg({
        role: "assistant",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "a", arguments: "{}" } },
          { id: "c2", type: "function", function: { name: "b", arguments: "{}" } },
        ],
      }),
      msg({ role: "tool", content: "一", tool_call_id: "c1" }),
      msg({ role: "tool", content: "二", tool_call_id: "c2" }),
    ]);
    expect(messages.map((m) => m.role)).toEqual(["assistant", "user"]);
    expect(messages[1].content).toEqual([
      { type: "tool_result", tool_use_id: "c1", content: "一" },
      { type: "tool_result", tool_use_id: "c2", content: "二" },
    ]);
  });

  it("护栏②：toolError → is_error:true；成功不带 is_error 字段", () => {
    const { messages } = toAnthropicMessages([
      msg({ role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "a", arguments: "{}" } }] }),
      msg({ role: "tool", content: "用户拒绝了这次修改", tool_call_id: "c1", toolError: true }),
      msg({ role: "assistant", tool_calls: [{ id: "c2", type: "function", function: { name: "b", arguments: "{}" } }] }),
      msg({ role: "tool", content: "好的", tool_call_id: "c2" }),
    ]);
    const results = messages.filter((m) => m.content.some((b) => b.type === "tool_result"));
    const flat = results.flatMap((m) => m.content) as ToolResultBlock[];
    expect(flat[0]?.is_error).toBe(true);
    expect(flat[1]).not.toHaveProperty("is_error");
  });

  it("空结果的 tool_result 也要占位（供应商同样不吃空 content）", () => {
    const { messages } = toAnthropicMessages([
      msg({ role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "a", arguments: "{}" } }] }),
      msg({ role: "tool", content: "", tool_call_id: "c1" }),
    ]);
    expect((messages[1].content[0] as ToolResultBlock).content).toBe("(empty)");
  });

  it("护栏③：没有结果的 tool_use 丢弃（留着每次重放都 400）", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { messages } = toAnthropicMessages([
      msg({
        role: "assistant",
        content: "我这就去查",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "a", arguments: "{}" } },
          { id: "c2", type: "function", function: { name: "b", arguments: "{}" } },
        ],
      }),
      msg({ role: "tool", content: "只有 c1 有结果", tool_call_id: "c1" }),
      msg({ role: "user", content: "继续" }),
    ]);
    const assistant = messages.find((m) => m.role === "assistant");
    expect(assistant?.content.map((b) => b.type)).toEqual(["text", "tool_use"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("丢弃 1 个没有结果的 tool_use"));
  });

  it("事务全孤时 assistant 退成 (empty)，而不是发一条空 assistant", () => {
    const { messages } = toAnthropicMessages([
      msg({ role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "a", arguments: "{}" } }] }),
      msg({ role: "user", content: "换个话题" }),
    ]);
    expect(messages[0]).toEqual({ role: "assistant", content: [{ type: "text", text: "(empty)" }] });
  });

  it("找不到出处的 tool_result 丢弃（另一方向的孤儿同样会 400）", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { messages } = toAnthropicMessages([
      msg({ role: "user", content: "先说话" }),
      msg({ role: "tool", content: "不知道哪来的结果", tool_call_id: "ghost" }),
    ]);
    expect(messages).toHaveLength(1);
    expect(text(messages[0].content)).toBe("先说话");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ghost"));
  });

  it("assistant 的 tool_calls 参数还原成 input 对象", () => {
    const { messages } = toAnthropicMessages([
      msg({
        role: "assistant",
        tool_calls: [{ id: "c1", type: "function", function: { name: "a", arguments: '{"q":"和鸣"}' } }],
      }),
      msg({ role: "tool", content: "ok", tool_call_id: "c1" }),
    ]);
    expect(messages[0].content[0]).toEqual({
      type: "tool_use",
      id: "c1",
      name: "a",
      input: { q: "和鸣" },
    });
  });

  it("相邻同角色合并，产出严格交替的 user/assistant", () => {
    const { messages } = toAnthropicMessages([
      msg({ role: "user", content: "一" }),
      msg({ role: "user", content: "二" }),
      msg({ role: "assistant", content: "好" }),
      msg({ role: "assistant", content: "继续" }),
    ]);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(text(messages[0].content)).toBe("一二");
    expect(text(messages[1].content)).toBe("好继续");
  });

  it("只有无出处的 tool_result 时产出为空（丢掉不可发的内容）", () => {
    const { messages } = toAnthropicMessages([msg({ role: "tool", content: "x", tool_call_id: "y" })]);
    expect(messages).toEqual([]);
  });
});

describe("transactionEnds（缓存断点选点）", () => {
  const call = (id: string) => ({
    id,
    type: "function" as const,
    function: { name: "t", arguments: "{}" },
  });

  it("每个闭合事务记一条，落在该条消息最后一个 block", () => {
    const { messages, transactionEnds } = toAnthropicMessages([
      msg({ role: "user", content: "开始" }),
      msg({ role: "assistant", tool_calls: [call("c1")] }),
      msg({ role: "tool", content: "r1", tool_call_id: "c1" }),
      msg({ role: "assistant", tool_calls: [call("c2")] }),
      msg({ role: "tool", content: "r2", tool_call_id: "c2" }),
      msg({ role: "assistant", content: "答案" }),
    ]);
    expect(transactionEnds).toHaveLength(2);
    for (const end of transactionEnds) {
      const block = messages[end.index].content[end.blockIndex];
      expect(block.type).toBe("tool_result");
    }
  });

  it("还开着的那一轮不进候选（结果没回填，下一请求必变）", () => {
    const { transactionEnds } = toAnthropicMessages([
      msg({ role: "user", content: "开始" }),
      msg({ role: "assistant", tool_calls: [call("c1")] }),
    ]);
    expect(transactionEnds).toEqual([]);
  });

  it("事务后面又接了普通 user 消息时不认作末尾（合并后不再是纯 tool_result）", () => {
    const { messages, transactionEnds } = toAnthropicMessages([
      msg({ role: "assistant", tool_calls: [call("c1")] }),
      msg({ role: "tool", content: "r1", tool_call_id: "c1" }),
      msg({ role: "user", content: "顺便问一句" }),
    ]);
    expect(transactionEnds).toEqual([]);
    expect(messages[1].content.map((b) => b.type)).toEqual(["tool_result", "text"]);
  });
});

describe("readAnthropicContent", () => {
  it("多个 text block 拼成一段，tool_use 还原成 OpenAI 形状", () => {
    const out = readAnthropicContent([
      { type: "thinking", thinking: "想了想" },
      { type: "text", text: "你" },
      { type: "text", text: "好" },
      { type: "tool_use", id: "c1", name: "a", input: { q: 1 } },
    ]);
    expect(out.text).toBe("你好");
    expect(out.calls).toEqual([
      { id: "c1", type: "function", function: { name: "a", arguments: '{"q":1}' } },
    ]);
  });

  it("非数组 / 缺字段不抛，text 为空", () => {
    expect(readAnthropicContent(undefined)).toEqual({ text: "", calls: [] });
    expect(readAnthropicContent("x")).toEqual({ text: "", calls: [] });
    expect(readAnthropicContent([null, {}])).toEqual({ text: "", calls: [] });
  });

  it("缺 input 的 tool_use 也要给合法 arguments（模型下一轮要能解析）", () => {
    const out = readAnthropicContent([{ type: "tool_use", id: "c", name: "a" }]);
    expect(out.calls[0]).toMatchObject({ function: { arguments: "{}" } });
  });
});
