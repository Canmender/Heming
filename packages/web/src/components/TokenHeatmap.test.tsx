import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { TokenHeatmap } from "./TokenHeatmap.js";
import { useTokenUsageStore } from "../store/tokenUsage.js";

describe("TokenHeatmap", () => {
  beforeEach(() => {
    useTokenUsageStore.setState({ records: [] });
  });

  it("渲染 30 个格子，标题含日期与用量", () => {
    render(<TokenHeatmap />);
    const cells = screen.getByRole("img", { name: "近 30 日 token 用量" }).querySelectorAll("[data-day]");
    expect(cells).toHaveLength(30);
    expect(cells[29].getAttribute("title")).toMatch(/2026-10-\d{2}/);
  });

  it("有记录的格子 data-total 非零且底色非空态", () => {
    useTokenUsageStore.setState({
      records: [{ model: "m", tokens: 50, at: new Date().toISOString() }],
    });
    render(<TokenHeatmap />);
    const today = screen.getByRole("img", { name: "近 30 日 token 用量" }).querySelectorAll("[data-day]")[29];
    expect(today.getAttribute("data-total")).toBe("50");
    expect((today as HTMLElement).style.backgroundColor).not.toBe("rgb(241, 244, 247)");
  });
});
