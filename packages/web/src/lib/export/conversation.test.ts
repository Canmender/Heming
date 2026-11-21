import { describe, expect, it } from "vitest";
import {
  MAX_EXPORT_STEPS,
  buildConversationJson,
  buildConversationMarkdown,
  conversationFileName,
  formatBytes,
  formatExportTime,
  type ConversationExportInput,
} from "./conversation.js";

const input: ConversationExportInput = {
  id: "c1",
  title: "评审组",
  exportedAt: new Date(2026, 9, 21, 14, 5, 9).getTime(),
  messages: [
    {
      id: "m1",
      role: "user",
      sender: "我",
      at: "2026-10-21T01:00:00.000Z",
      text: "看下这个公式 $E=mc^2$",
    },
    {
      id: "m2",
      role: "assistant",
      sender: "和小鸣",
      at: "2026-10-21T01:01:00.000Z",
      text: "结论如下",
      attachment: { id: "f1", name: "报告.pdf", mime: "application/pdf", size: 2048 },
    },
    {
      id: "m3",
      role: "user",
      sender: "我",
      at: "2026-10-21T01:02:00.000Z",
      text: "这句不该出现",
      recalled: true,
    },
  ],
};

describe("会话导出", () => {
  it("Markdown：头部元信息、消息、附件与撤回占位齐全", () => {
    const md = buildConversationMarkdown(input);
    expect(md).toContain("# 会话：评审组");
    expect(md).toContain("- 会话 ID：c1");
    expect(md).toContain("- 消息数：3");
    expect(md).toContain("看下这个公式 $E=mc^2$"); // 公式原文保留，渲染交给展示端
    expect(md).toContain("**附件**：报告.pdf（application/pdf，2.0 KB）");
    expect(md).toContain("（消息已撤回）");
    expect(md).not.toContain("这句不该出现");
    expect(md).toContain("仅包含本机可解密的明文消息");
  });

  it("同一输入生成逐字相同的 Markdown（导出时间由参数决定）", () => {
    expect(buildConversationMarkdown(input)).toBe(buildConversationMarkdown({ ...input }));
  });

  it("JSON：带版本号，撤回消息清空正文但保留标记", () => {
    const doc = JSON.parse(buildConversationJson(input)) as Record<string, unknown>;
    expect(doc.version).toBe(1);
    expect(doc.messages).toHaveLength(3);
    const recalled = (doc.messages as Record<string, unknown>[])[2];
    expect(recalled).toMatchObject({ id: "m3", recalled: true, text: "" });
  });

  it("JSON 也带过程投影，与 Markdown 一致（d.412 回归）", () => {
    const doc = JSON.parse(
      buildConversationJson({
        ...input,
        messages: [
          {
            id: "mp",
            role: "assistant",
            sender: "和鸣",
            at: "2026-01-01T00:00:00.000Z",
            text: "结论",
            process: [
              { kind: "tool", label: "file_read · x.md", status: "ok" },
              { kind: "think", label: "先看一下" },
            ],
          },
        ],
      }),
    ) as { messages: Array<{ process?: unknown[] }> };
    expect(doc.messages[0]?.process).toHaveLength(2);
  });

  it("文件名剔除非法字符并带时间戳", () => {
    const name = conversationFileName('评审/组: "A"', input.exportedAt, "md");
    expect(name).toContain("评审 组 A");
    expect(name).not.toMatch(/[\\/:*?"<>|]/);
    expect(name.endsWith("-20261021-1405.md")).toBe(true);
  });

  it("大小与时间格式化对异常输入不抛错", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(2 * 1024 * 1024)).toBe("2.0 MB");
    expect(formatBytes(Number.NaN)).toBe("大小未知");
    expect(formatExportTime("not-a-date")).toBe("not-a-date");
  });

  it("过程收进 <details>：一次工具调用一行，带状态/耗时/原因（d.356）", () => {
    const md = buildConversationMarkdown({
      ...input,
      messages: [
        {
          id: "m1",
          role: "assistant",
          sender: "和小鸣",
          at: "2026-10-21T01:00:00.000Z",
          text: "读到了",
          process: [
            { kind: "think", label: "先确认入口在哪" },
            { kind: "tool", label: "file_read · core/app.ts", status: "ok", ms: 120 },
            { kind: "tool", label: "file_write", status: "denied", detail: "没有写盘权限" },
          ],
        },
      ],
    });
    expect(md).toContain("<summary>过程（3 步）</summary>");
    expect(md).toContain("· 思考 · 先确认入口在哪");
    expect(md).toContain("✓ 工具 · file_read · core/app.ts · 120ms");
    expect(md).toContain("⊘ 工具 · file_write · 没有写盘权限");
    expect(md).toContain("</details>");
  });

  it("过程里的尖括号被转义，不把 <details> 结构顶坏（d.356）", () => {
    const md = buildConversationMarkdown({
      ...input,
      messages: [
        {
          id: "m1",
          role: "assistant",
          sender: "和小鸣",
          at: "2026-10-21T01:00:00.000Z",
          text: "好",
          process: [{ kind: "tool", label: "<script>alert(1)</script>", status: "ok" }],
        },
      ],
    });
    expect(md).not.toContain("<script>");
    expect(md).toContain("&lt;script&gt;");
  });

  it("过程太长只列前若干步，并如实写还有多少步（d.356）", () => {
    const process = Array.from({ length: MAX_EXPORT_STEPS + 3 }, (_, i) => ({
      kind: "tool" as const,
      label: `file_read · f${i}.ts`,
      status: "ok" as const,
    }));
    const md = buildConversationMarkdown({
      ...input,
      messages: [
        {
          id: "m1",
          role: "assistant",
          sender: "和小鸣",
          at: "2026-10-21T01:00:00.000Z",
          text: "完",
          process,
        },
      ],
    });
    expect(md).toContain(`<summary>过程（${MAX_EXPORT_STEPS + 3} 步）</summary>`);
    expect(md).toContain("…还有 3 步");
    expect(md).toContain(`f${MAX_EXPORT_STEPS - 1}.ts`);
    expect(md).not.toContain(`f${MAX_EXPORT_STEPS + 2}.ts`);
  });

  it("没有过程时不留空 <details>（d.356）", () => {
    const md = buildConversationMarkdown({
      ...input,
      messages: [
        {
          id: "m1",
          role: "assistant",
          sender: "和小鸣",
          at: "2026-10-21T01:00:00.000Z",
          text: "直接答",
          process: [],
        },
      ],
    });
    expect(md).not.toContain("<details>");
  });
});

describe("导出统计", () => {
  it("导出的头上有轮次与过程统计（d.408）", () => {
    const md = buildConversationMarkdown({
      id: "c1",
      title: "统计",
      exportedAt: Date.parse("2026-11-19T10:00:00+08:00"),
      messages: [
        { id: "m1", role: "user", at: "2026-11-19T09:59:00+08:00", sender: "我", text: "跑一下" },
        {
          id: "m2",
          role: "assistant" as const,
          at: "2026-11-19T10:00:00+08:00",
          sender: "和小鸣",
          text: "好了",
          process: [
            { kind: "tool", label: "read_file", status: "ok" },
            { kind: "tool", label: "run_shell", status: "denied" },
          ],
        },
      ],
    });
    expect(md).toContain("- 轮次：1（用户发了几条）");
    expect(md).toContain("- 过程：2 步 · 1 步没成");
  });
});

