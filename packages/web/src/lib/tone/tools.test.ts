import { describe, it, expect } from "vitest";
import { buildToneToolBridge, TONE_TOOL_PREFIX } from "./tools.js";

/** 调工具。 */
async function call(name: string, args: unknown) {
  const bridge = buildToneToolBridge();
  return bridge.execute({ name, arguments: JSON.stringify(args) });
}

describe("去 AI 味工具", () => {
  it("工具名带 tone_ 前缀（便于在轨迹里认出）", () => {
    expect(TONE_TOOL_PREFIX).toBe("tone_");
    const bridge = buildToneToolBridge();
    const names = bridge.tools.map(
      (t) => (t as { function?: { name?: string } }).function?.name ?? "",
    );
    expect(names.every((n) => n.startsWith("tone_"))).toBe(true);
  });

  it("工具声明符合 OpenAI tools 形状", () => {
    const bridge = buildToneToolBridge();
    for (const t of bridge.tools) {
      const fn = (t as { type?: string; function?: { name?: string; parameters?: unknown } }).function;
      expect(t).toHaveProperty("type", "function");
      expect(fn?.name).toBeTruthy();
      expect(fn?.parameters).toBeTruthy();
    }
  });

  it("检测到痕迹时列出规则编号与位置", async () => {
    const res = await call("tone_detect", { text: "答案其实很简单——专注。" });
    expect(res.ok).toBe(true);
    expect(res.text).toContain("第 4 条");
    expect(res.text).toContain("逐字保留");
  });

  it("干净文本明确说不要改写", async () => {
    const res = await call("tone_detect", {
      text: "他今天下午去了趟超市，买了牛奶和面包。回来路上顺手取了个快递。",
    });
    expect(res.ok).toBe(true);
    expect(res.text).toContain("不要改写");
  });

  it("工具描述里点明哪些不是 AI 痕迹（比喻/设问/句长）", () => {
    const bridge = buildToneToolBridge();
    const desc =
      (bridge.tools[0] as { function?: { description?: string } }).function?.description ?? "";
    expect(desc).toContain("比喻");
    expect(desc).toContain("设问");
    expect(desc).toContain("句长");
  });

  it("缺 text 参数时给出明确提示", async () => {
    const res = await call("tone_detect", {});
    expect(res.ok).toBe(false);
    expect(res.text).toContain("缺少 text");
  });

  it("空文本给出提示而不是当成干净", async () => {
    const res = await call("tone_detect", { text: "   " });
    expect(res.ok).toBe(false);
  });

  it("参数不是合法 JSON 时不抛异常", async () => {
    const bridge = buildToneToolBridge();
    const res = await bridge.execute({ name: "tone_detect", arguments: "{坏 JSON" });
    expect(res.ok).toBe(false);
    expect(res.text).toContain("JSON");
  });

  it("未知工具名给提示", async () => {
    const res = await call("tone_xxx", {});
    expect(res.ok).toBe(false);
  });
});
