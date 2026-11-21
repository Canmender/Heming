import { describe, expect, it } from "vitest";
import { createEventSink, jsonLine, type CliEvent } from "./events.js";
import type { ExecJson } from "./run.js";

const result: ExecJson = {
  ok: true,
  stopReason: "ok",
  text: "好了",
  rounds: 1,
  toolCalls: [],
  writes: [],
  usage: { input: 10, output: 2 },
  durationMs: 5,
};

describe("jsonLine", () => {
  it("任何事件序列化后都恰好一行（消费方按行读）", () => {
    const events: CliEvent[] = [
      { type: "start", command: "exec", cwd: "D:/repo", maxRounds: 12, allowDanger: false },
      { type: "round", round: 1 },
      { type: "round", round: 2, tool: "file_read" },
      { type: "delta", text: "第一行\n第二行" },
      { type: "tool_start", name: "file_read", args: "path=a.txt" },
      { type: "tool_end", name: "file_read", ok: true, denied: false },
      { type: "retry", attempt: 1, max: 2, delayMs: 800, reason: "上游暂时不可用（HTTP 503）" },
      { type: "final", result },
      { type: "error", message: "缺少 API Key" },
    ];
    for (const event of events) {
      const line = jsonLine(event);
      expect(line.endsWith("\n")).toBe(true);
      // 除结尾那一个换行外不能再有换行：否则「一行一条」的契约就破了。
      expect(line.slice(0, -1).includes("\n")).toBe(false);
      expect(JSON.parse(line)).toEqual(event);
    }
  });

  it("回答里的换行、引号、反斜杠都被转义，不破坏 JSON", () => {
    const text = '他说："先跑测试"\n然后改 \\src\\a.ts';
    const parsed = JSON.parse(jsonLine({ type: "delta", text })) as { text: string };
    expect(parsed.text).toBe(text);
  });

  it("U+2028/U+2029 转义成 \\uXXXX：JS 消费方按行读也不拆行、能还原原文", () => {
    const text = "A\u2028B\u2029C";
    const line = jsonLine({ type: "delta", text });
    // 裸的 U+2028/U+2029 一个都不留（它们是 ECMA-262 行终止符，按行读会被拆开）。
    expect(line).not.toMatch(/[\u2028\u2029]/);
    // 用「ECMA-262 行终止符」切分仍是一行，且能解析回原文。
    const fragments = line.split(/\r\n|[\n\r\u2028\u2029]/).filter(Boolean);
    expect(fragments).toHaveLength(1);
    expect((JSON.parse(fragments[0]!) as { text: string }).text).toBe(text);
  });

  it("createEventSink 按 emit 顺序写出，每次一条", () => {
    const written: string[] = [];
    const sink = createEventSink((chunk) => written.push(chunk));
    sink.emit({ type: "round", round: 1 });
    sink.emit({ type: "final", result });
    expect(written).toHaveLength(2);
    expect((JSON.parse(written[0]!) as CliEvent).type).toBe("round");
    expect((JSON.parse(written[1]!) as CliEvent).type).toBe("final");
  });
});
