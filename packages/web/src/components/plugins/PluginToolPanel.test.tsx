import { describe, expect, it } from "vitest";
import { plainToolDescription } from "./PluginToolPanel.js";

/**
 * 工具描述面向模型（含 Markdown 标记与对模型的指令），界面展示前要去标记，
 * 但不能改写句子本身——这里钉住「只去标记 + 压空白」的边界。
 */
describe("工具描述面向用户化", () => {
  it("去掉加粗/斜体标记与行内代码，保留文字", () => {
    expect(plainToolDescription("被动句、名词化**不是** AI 痕迹")).toBe("被动句、名词化不是 AI 痕迹");
    expect(plainToolDescription("调用 `chart_render` 后把结果贴回来")).toBe(
      "调用 chart_render 后把结果贴回来",
    );
    expect(plainToolDescription("__重要__：先读再写")).toBe("重要：先读再写");
  });

  it("多行压成一行、首尾空白去掉（列表行只有两行高）", () => {
    expect(plainToolDescription("  第一行\n\n第二行\t第三行  ")).toBe("第一行 第二行 第三行");
  });

  it("没有标记时原样返回（不改写语义）", () => {
    const text = "读取本机归档里的消息，只读。";
    expect(plainToolDescription(text)).toBe(text);
  });
});
