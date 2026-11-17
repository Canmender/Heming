import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  TURN_NOTIFY_BODY_MAX,
  TURN_NOTIFY_GAP_MS,
  clipText,
  describeApprovalWait,
  describeTurnEnd,
  firstLine,
  notifyApprovalWait,
  notifyTurnEnd,
  resetTurnNotifyThrottle,
} from "./turnNotify.js";

const message = vi.fn();

beforeEach(() => {
  resetTurnNotifyThrottle();
  message.mockReset();
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
  window.__heming_notify = { message, onOpen: vi.fn(() => () => {}) };
});

afterEach(() => {
  delete window.__heming_notify;
  vi.restoreAllMocks();
});

describe("desktopNotify 风格的收口文案（d.208）", () => {
  it("用户自己停的：不打扰", () => {
    expect(describeTurnEnd({ status: "aborted" }, "和小鸣")).toBeNull();
  });

  it("做完了：标题带名，正文是首行文本", () => {
    const text = describeTurnEnd({ status: "ok", finalText: "第一行结论\n第二行细节" }, "和小鸣");
    expect(text).toEqual({ title: "和小鸣 这一轮做完了", body: "第一行结论" });
  });

  it("做完了但没文本：给一句可照做的兜底", () => {
    const text = describeTurnEnd({ status: "ok", finalText: "   \n  " }, "和小鸣");
    expect(text?.body).toBe("打开会话看结果。");
  });

  it("出错了：正文是原因首行", () => {
    const text = describeTurnEnd({ status: "error", error: "HTTP 500: upstream boom" }, "和小鸣");
    expect(text?.title).toBe("和小鸣 这一轮出错了");
    expect(text?.body).toBe("HTTP 500: upstream boom");
  });

  it("出错但没有原因：如实说在会话里", () => {
    expect(describeTurnEnd({ status: "error" }, "和小鸣")?.body).toBe("具体原因在会话里。");
  });

  it("撞轮次上限 / 预算到顶：各自说清下一步", () => {
    const rounds = describeTurnEnd({ status: "ok", maxRounds: true, finalText: "先到这" }, "和小鸣");
    expect(rounds?.title).toContain("轮次上限");
    expect(rounds?.body).toContain("继续");
    const budget = describeTurnEnd({ status: "ok", budgetStop: true }, "和小鸣");
    expect(budget?.title).toContain("上下文满了");
    expect(budget?.body).toContain("/compact");
  });

  it("确认等待：把要确认的工具名说清", () => {
    const text = describeApprovalWait([{ displayName: "写入文件" }, { displayName: "执行命令" }], "和小鸣");
    expect(text.title).toBe("和小鸣 需要你确认");
    expect(text.body).toContain("写入文件、执行命令");
    expect(text.body).toContain("打开会话处理");
  });

  it("firstLine / clipText：压换行、按码点截断", () => {
    expect(firstLine("\n\n  第二行才是正文  \n后文")).toBe("第二行才是正文");
    expect(firstLine(undefined)).toBe("");
    expect(clipText("abcdef", 4)).toBe("abc…");
    // emoji 是代理对：按 UTF-16 切会切成半个字符
    const emoji = "😀😀😀😀";
    expect([...clipText(emoji, 3)]).toEqual(["😀", "😀", "…"]);
    expect(clipText("short", 10)).toBe("short");
    expect(TURN_NOTIFY_BODY_MAX).toBe(120);
  });
});

describe("通知去重（d.208）", () => {
  it("同一会话同类通知 4 秒内只弹一次", () => {
    const result = { status: "ok" as const, finalText: "好了" };
    expect(notifyTurnEnd(result, "和小鸣", "c1", 1_000)).toBe(true);
    expect(notifyTurnEnd(result, "和小鸣", "c1", 1_000 + TURN_NOTIFY_GAP_MS - 1)).toBe(false);
    expect(notifyTurnEnd(result, "和小鸣", "c1", 1_000 + TURN_NOTIFY_GAP_MS)).toBe(true);
    expect(message).toHaveBeenCalledTimes(2);
  });

  it("不同会话 / 不同标题互不影响；reset 清空去重", () => {
    expect(notifyTurnEnd({ status: "ok", finalText: "a" }, "和小鸣", "c1", 1_000)).toBe(true);
    expect(notifyTurnEnd({ status: "ok", finalText: "b" }, "和小鸣", "c2", 1_001)).toBe(true);
    expect(notifyTurnEnd({ status: "error", error: "boom" }, "和小鸣", "c1", 1_002)).toBe(true);
    resetTurnNotifyThrottle();
    expect(notifyTurnEnd({ status: "ok", finalText: "a" }, "和小鸣", "c1", 1_003)).toBe(true);
    expect(message).toHaveBeenCalledTimes(4);
  });

  it("用户自己停的那一轮不拿去重，也不弹", () => {
    expect(notifyTurnEnd({ status: "aborted" }, "和小鸣", "c1", 1_000)).toBe(false);
    expect(message).not.toHaveBeenCalled();
  });

  it("同一个确认请求一小时内只提醒一次；不同的请求各提醒一次", () => {
    expect(notifyApprovalWait("req-1", [{ displayName: "写入文件" }], "和小鸣", "c1", 1_000)).toBe(true);
    // 一小时以内重复触发同一条请求（例如界面重渲染）：不重复弹
    expect(notifyApprovalWait("req-1", [{ displayName: "写入文件" }], "和小鸣", "c1", 1_000 + 3_599_999)).toBe(false);
    expect(notifyApprovalWait("req-2", [{ displayName: "写入文件" }], "和小鸣", "c1", 1_001)).toBe(true);
    expect(message).toHaveBeenCalledTimes(2);
  });

  it("通知里带上会话 id，点通知才能回到那个会话", () => {
    notifyTurnEnd({ status: "ok", finalText: "好了" }, "和小鸣", "c9", 1_000);
    expect(message).toHaveBeenCalledWith({ title: "和小鸣 这一轮做完了", body: "好了", conversationId: "c9" });
  });
});
