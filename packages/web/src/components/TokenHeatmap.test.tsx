import { render, screen, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { TokenHeatmap } from "./TokenHeatmap.js";
import { useTokenUsageStore, dayKeyOf } from "../store/tokenUsage.js";

/** 热力图容器改成了 role="group"（label 带合计/峰值），格子才是 role="img"。 */
function heatmap(): HTMLElement {
  return screen.getByTestId("token-heatmap");
}

function cells(): HTMLElement[] {
  return Array.from(heatmap().querySelectorAll<HTMLElement>("[data-day]"));
}

describe("TokenHeatmap", () => {
  beforeEach(() => {
    useTokenUsageStore.setState({ records: [] });
  });

  it("渲染 30 个格子，标题含日期与用量", () => {
    render(<TokenHeatmap />);
    const all = cells();
    expect(all).toHaveLength(30);
    // 末格 = 今天：断具体年月（原 /2026-10-\d{2}/）跨月必红，改与 dayKeyOf 今天比对
    const todayKey = dayKeyOf(new Date().toISOString());
    expect(all[29].getAttribute("data-day")).toBe(todayKey);
    expect(all[29].getAttribute("title")).toMatch(new RegExp(`^${todayKey} · `));
  });

  it("有记录的格子 data-total 非零且底色非空态", () => {
    useTokenUsageStore.setState({
      records: [{ model: "m", tokens: 50, at: new Date().toISOString() }],
    });
    render(<TokenHeatmap />);
    const today = cells()[29];
    expect(today.getAttribute("data-total")).toBe("50");
    expect((today as HTMLElement).style.backgroundColor).not.toBe("rgb(241, 244, 247)");
  });

  it("当天只有未上报 → 标题说「未上报」，不是「0 tokens」", () => {
    const todayKey = dayKeyOf(new Date().toISOString());
    useTokenUsageStore.setState({
      records: [{ model: "m", tokens: null, at: new Date().toISOString() }],
    });
    render(<TokenHeatmap />);
    const today = cells()[29];
    expect(today.getAttribute("title")).toBe(`${todayKey} · 未上报`);
    expect(today.getAttribute("data-total")).toBe("0"); // 数字口径仍是 0（null 不产生热度）
  });

  it("键盘可得：一个 Tab 停靠点，左右方向键逐日移动，aria-label 报日期与用量", () => {
    const todayKey = dayKeyOf(new Date().toISOString());
    useTokenUsageStore.setState({ records: [{ model: "m", tokens: 50, at: new Date().toISOString() }] });
    render(<TokenHeatmap />);
    const all = cells();

    // 默认停在今天（最后一格），它是唯一 tabIndex=0 的格子
    expect(all.filter((c) => c.getAttribute("tabindex") === "0")).toHaveLength(1);
    expect(all[29].getAttribute("tabindex")).toBe("0");
    expect(all[29].getAttribute("aria-label")).toBe(`${todayKey} · 50 tokens（多）`);

    all[29].focus();
    fireEvent.keyDown(all[29], { key: "ArrowLeft" });
    expect(document.activeElement).toBe(all[28]);
    expect(all[28].getAttribute("aria-label")).toMatch(/ · \d+ tokens（/);

    fireEvent.keyDown(all[28], { key: "Home" });
    expect(document.activeElement).toBe(all[0]);
    fireEvent.keyDown(all[0], { key: "ArrowLeft" }); // 已经到第一天，不越界
    expect(document.activeElement).toBe(all[0]);
    fireEvent.keyDown(all[0], { key: "End" });
    expect(document.activeElement).toBe(all[29]);
  });

  it("合计与峰值进容器 aria-label，读屏不移动焦点也能拿到概要", () => {
    useTokenUsageStore.setState({
      records: [
        { model: "m", tokens: 50, at: new Date().toISOString() },
        { model: "m", tokens: 30, at: new Date(Date.now() - 24 * 3600 * 1000).toISOString() },
      ],
    });
    render(<TokenHeatmap />);
    expect(heatmap().getAttribute("aria-label")).toContain("合计 80 tokens");
    expect(heatmap().getAttribute("aria-label")).toContain("按左右方向键逐日查看");
  });
});