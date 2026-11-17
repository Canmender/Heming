import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { describe, expect, it } from "vitest";
import { ContextMeter } from "./ContextMeter.js";

describe("上下文用量指示（d.187）", () => {
  it("安静档整个不渲染（短对话里加一行数字是噪音）", () => {
    const { container } = render(<ContextMeter used={300} budget={25_000} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("正常档显示用量与百分比，且是 status 而不是 alert", () => {
    render(<ContextMeter used={12_400} budget={25_900} />);
    const meter = screen.getByRole("status", { name: "上下文用量" });
    expect(meter).toHaveTextContent("上下文 ≈ 12.4K / 25.9K（48%）");
    expect(meter).not.toHaveAttribute("role", "alert");
  });

  it("接近上限时文案给动作（/compact），配色切到警告色", () => {
    render(<ContextMeter used={20_500} budget={25_000} />);
    const meter = screen.getByRole("status", { name: "上下文用量" });
    expect(meter).toHaveTextContent("可以发 /compact 压一次");
    expect(meter.className).toContain("text-warn");
  });

  it("超过预算时说明下一轮会压缩，配色切到危险色", () => {
    render(<ContextMeter used={26_000} budget={25_000} />);
    const meter = screen.getByRole("status", { name: "上下文用量" });
    expect(meter).toHaveTextContent("下一轮会压缩早期内容");
    expect(meter.className).toContain("text-danger");
  });
  it("校准过就在 title 里说清楚（d.215）：别让用户把修正过的数字当朴素估算", () => {
    render(<ContextMeter used={12_400} budget={25_900} calibrated />);
    const meter = screen.getByRole("status", { name: "上下文用量" });
    expect(meter.getAttribute("title")).toContain("真实提示 token 校准");
    expect(meter).toHaveTextContent("上下文 ≈ 12.4K / 25.9K（48%）");
  });
});