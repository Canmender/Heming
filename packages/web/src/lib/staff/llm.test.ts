import { describe, expect, it } from "vitest";
import {
  buildBriefMessages,
  buildFactPayload,
  parseBriefJson,
  refsOfFacts,
  tokensOf,
} from "./llm.js";
import { collectFacts } from "./model.js";

const NOW = new Date(2026, 10, 1, 9, 0).getTime();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const facts = collectFacts(
  {
    agenda: [
      {
        id: 12,
        title: "交材料",
        detail: "这是不该发给模型的正文细节",
        dueTs: NOW - HOUR,
        dueText: "昨天 18:00",
        convName: "2601班群",
        senderName: "叶老师",
      },
    ],
    tasks: [
      {
        id: "abc",
        conversationId: "conv-1",
        title: "整理名单",
        status: "failed",
        updatedAt: NOW - MINUTE,
        error: "接口超时",
      },
    ],
  },
  NOW,
);

describe("脱敏事实载荷", () => {
  it("只发标题/到期/会话名/发送者与任务状态，不发 detail", () => {
    const payload = buildFactPayload(facts);
    const raw = JSON.stringify(payload);
    expect(payload.agenda[0]).toEqual({
      refId: "agenda:12",
      title: "交材料",
      dueText: "昨天 18:00",
      bucket: "overdue",
      convName: "2601班群",
      senderName: "叶老师",
    });
    expect(raw).not.toContain("不该发给模型");
    expect(payload.tasks[0]).toEqual({
      refId: "task:abc",
      title: "整理名单",
      issue: "failed",
      error: "接口超时",
    });
  });

  it("提示词要求纯 JSON 且禁止编造 refId", () => {
    const messages = buildBriefMessages(buildFactPayload(facts));
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toContain("只输出一个 JSON 对象");
    expect(messages[0].content).toContain("不得编造");
    expect(messages[1].content).toContain("agenda:12");
  });
});

describe("模型输出校验", () => {
  const refs = refsOfFacts(facts);

  it("解析 ```json 围栏，按 refs 建证据与跳转", () => {
    const parsed = parseBriefJson(
      [
        "这是简报：",
        "```json",
        JSON.stringify({
          summary: "今天有一份材料逾期。",
          findings: [
            { severity: "urgent", title: "交材料已逾期", detail: "叶老师在班群通知", refs: ["agenda:12"] },
            { severity: "warn", title: "任务失败", detail: "接口超时", refs: ["task:abc"] },
          ],
        }),
        "```",
      ].join("\n"),
      refs,
    );
    expect(parsed?.summary).toBe("今天有一份材料逾期。");
    expect(parsed?.findings).toHaveLength(2);
    expect(parsed?.findings[0].evidence[0]).toEqual({
      label: "本机归档 · 2601班群",
      kind: "agenda",
      refId: "agenda:12",
    });
    expect(parsed?.findings[0].action).toEqual({ kind: "open-infohub" });
    expect(parsed?.findings[1].action).toEqual({
      kind: "open-task",
      targetId: "abc",
      conversationId: "conv-1",
    });
  });

  it("编造的 refId 与非法级别被丢弃；全被丢光 → null（回退规则）", () => {
    expect(
      parseBriefJson(
        JSON.stringify({
          summary: "编的",
          findings: [{ severity: "critical", title: "x", detail: "", refs: ["agenda:12"] }],
        }),
        refs,
      ),
    ).toBeNull();
    expect(
      parseBriefJson(
        JSON.stringify({
          summary: "编的",
          findings: [{ severity: "urgent", title: "x", detail: "", refs: ["agenda:999"] }],
        }),
        refs,
      ),
    ).toBeNull();
  });

  it("坏 JSON / 空文本 → null", () => {
    expect(parseBriefJson("", refs)).toBeNull();
    expect(parseBriefJson("模型今天不想说话", refs)).toBeNull();
    expect(parseBriefJson("{坏", refs)).toBeNull();
  });

  it("标题/详情按模型档位截断，findings 最多 7 条", () => {
    const parsed = parseBriefJson(
      JSON.stringify({
        summary: "s".repeat(300),
        findings: Array.from({ length: 10 }, (_, i) => ({
          severity: "info",
          title: `标题${i}`.repeat(30),
          detail: "d".repeat(300),
          refs: ["agenda:12"],
        })),
      }),
      refs,
    );
    expect(parsed?.summary.length).toBe(200);
    expect(parsed?.findings).toHaveLength(7);
    expect(parsed?.findings[0].title.length).toBe(40);
    expect(parsed?.findings[0].detail.length).toBe(160);
  });
});

describe("用量口径", () => {
  it("total 优先，其次 input+output；全空 = null（不是 0）", () => {
    expect(tokensOf({ totalTokens: 30, inputTokens: 10, outputTokens: 20 })).toBe(30);
    expect(tokensOf({ inputTokens: 10, outputTokens: 20 })).toBe(30);
    expect(tokensOf({ inputTokens: 10 })).toBe(10);
    expect(tokensOf(undefined)).toBeNull();
    expect(tokensOf({})).toBeNull();
  });
});
