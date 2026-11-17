/**
 * 超长消息的提醒（d.233）。
 *
 * 只测「判多大 / 说什么」——真去拦下发送是 ChatPage 的事（见 I4f 用例）。
 */
import { describe, expect, it } from "vitest";

import {
  MESSAGE_WARN_TOKENS,
  inspectOutgoingText,
  largeMessageNotice,
} from "./messageBudget.js";

describe("一条消息有多大（d.233）", () => {
  it("普通提问远小于阈值，不拦", () => {
    const report = inspectOutgoingText("帮我把登录页的按钮改成蓝色，顺便跑一下测试");
    expect(report.tooLarge).toBe(false);
    expect(report.chars).toBeGreaterThan(10);
    expect(report.tokens).toBeGreaterThan(0);
  });

  it("字符数按码点算：emoji 不会被当成两个字符", () => {
    expect(inspectOutgoingText("😀😀😀").chars).toBe(3);
  });

  it("拼进一大段中文（约一字一 token）会越过阈值", () => {
    const report = inspectOutgoingText("啊".repeat(MESSAGE_WARN_TOKENS));
    expect(report.tooLarge).toBe(true);
    expect(report.chars).toBe(MESSAGE_WARN_TOKENS);
    expect(report.tokens).toBeGreaterThanOrEqual(MESSAGE_WARN_TOKENS);
  });

  it("同样字符数的英文代码风险小得多：用 token 而不是字节判", () => {
    const text = "const a = 1;\n".repeat(Math.ceil(MESSAGE_WARN_TOKENS / 4));
    const report = inspectOutgoingText(text);
    // 字符数已经超过阈值，但 token 估算只有四分之一左右 → 不拦
    expect(report.chars).toBeGreaterThan(MESSAGE_WARN_TOKENS);
    expect(report.tokens).toBeLessThan(MESSAGE_WARN_TOKENS);
    expect(report.tooLarge).toBe(false);
  });

  it("刚好卡在阈值上也算大（`>=`，边界不留缝）", () => {
    const text = "啊".repeat(MESSAGE_WARN_TOKENS);
    expect(inspectOutgoingText(text).tooLarge).toBe(true);
  });
});

describe("提醒怎么说（d.233）", () => {
  it("给出字数与 token 数，说清会挤上下文/被拒，并给更好的做法", () => {
    const notice = largeMessageNotice({ chars: 300_000, tokens: 300_000, tooLarge: true });
    expect(notice).toContain("300,000 字");
    expect(notice).toContain("300,000 tokens");
    expect(notice).toContain("挤掉前面的对话");
    expect(notice).toContain("被服务端直接拒绝");
    // 可执行的替代路径，而不是只吓人
    expect(notice).toContain("引用工作区文件");
    // 拦一道但不能拦死
    expect(notice).toContain("再点一次发送");
  });
});
