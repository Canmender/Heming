import { describe, expect, it } from "vitest";
import {
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
});
