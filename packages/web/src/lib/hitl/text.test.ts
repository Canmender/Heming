import { describe, it, expect } from "vitest";
import { GIT_UNCHANGED, MUST_CONTAIN, allowedText, deniedText } from "./text.js";
import type { HitlCall } from "./types.js";

const call: HitlCall = {
  id: "call_1",
  name: "fs__delete_file",
  argsJson: '{"path":"D:/tmp/a.txt"}',
  displayName: "删除文件",
  risk: "danger",
  summary: "D:/tmp/a.txt",
  source: "mcp",
};

describe("拒绝文案", () => {
  it("必含的四个短语一个都不能少（防幻觉的硬底线）", () => {
    const text = deniedText(call);
    for (const phrase of MUST_CONTAIN) {
      expect(text).toContain(phrase);
    }
  });

  it("显式声明「文件与系统状态未被修改」", () => {
    expect(deniedText(call)).toContain(GIT_UNCHANGED);
    expect(GIT_UNCHANGED).toContain("未被修改");
  });

  it("带上中文动作名与参数摘要，便于模型知道自己被拒的是哪一次", () => {
    const text = deniedText(call);
    expect(text).toContain("用户拒绝了本次工具调用：删除文件");
    expect(text).toContain("D:/tmp/a.txt");
  });

  it("带拒绝原因时一并给出", () => {
    expect(deniedText(call, "用户中断")).toContain("用户中断");
  });

  it("明说「不存在部分写入或中间状态」，杜绝模型推断写了一半", () => {
    expect(deniedText(call)).toContain("不存在部分写入或中间状态");
  });

  it("明说不要基于「已完成」的假设继续构造参数或重试", () => {
    const text = deniedText(call);
    expect(text).toContain("不要基于该操作");
    expect(text).toContain("继续构造后续参数或重试同一调用");
  });
});

describe("放行文案", () => {
  it("本会话内允许时提示模型不要扩大授权范围", () => {
    const text = allowedText(call, "allow-session");
    expect(text).toContain("用户已授权本次调用，可以继续");
    expect(text).toContain("不要把授权扩大到本次参数之外的操作");
  });

  it("仅本次允许时不追加授权提示", () => {
    const text = allowedText(call, "allow");
    expect(text).toContain("用户已允许本次工具调用");
    expect(text).not.toContain("用户已授权本次调用");
  });
});
