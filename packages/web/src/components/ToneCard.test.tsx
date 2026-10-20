import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ToneCard } from "./ToneCard.js";

describe("写作能力卡", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("展示标题与 11 条规则入口", () => {
    render(<ToneCard />);
    expect(screen.getByRole("region", { name: "写作能力" })).toBeInTheDocument();
    expect(screen.getByText("写作能力 · 去 AI 味")).toBeInTheDocument();
    expect(screen.getByText("查看 11 条规则")).toBeInTheDocument();
  });

  it("展开后列出全部 11 条规则", () => {
    render(<ToneCard />);
    fireEvent.click(screen.getByText("查看 11 条规则"));
    expect(screen.getByText("翻案腔（不是 A 而是 B）")).toBeInTheDocument();
    expect(screen.getByText("段首零主语评论")).toBeInTheDocument();
  });

  it("明确列出「刻意不查的」那些（比喻、设问、句长）", () => {
    render(<ToneCard />);
    fireEvent.click(screen.getByText("查看 11 条规则"));
    expect(screen.getByText(/刻意不查的/)).toBeInTheDocument();
    expect(screen.getByText(/比喻本身、比喻独立成段/)).toBeInTheDocument();
    expect(screen.getByText(/句长与段长的参差/)).toBeInTheDocument();
  });

  it("空文本时检测按钮禁用", () => {
    render(<ToneCard />);
    expect(screen.getByRole("button", { name: "检测 AI 痕迹" })).toBeDisabled();
  });

  it("检测到痕迹时给出命中数与位置", () => {
    render(<ToneCard />);
    const box = screen.getByLabelText("待检测文本");
    fireEvent.change(box, { target: { value: "答案其实很简单——专注。" } });
    fireEvent.click(screen.getByRole("button", { name: "检测 AI 痕迹" }));
    expect(screen.getByText(/命中 1 处/)).toBeInTheDocument();
    expect(screen.getByText(/第4条/)).toBeInTheDocument();
  });

  it("干净文本提示未命中任何规则", () => {
    render(<ToneCard />);
    const box = screen.getByLabelText("待检测文本");
    fireEvent.change(box, {
      target: { value: "他今天下午去了趟超市，买了牛奶和面包。回来路上顺手取了个快递。" },
    });
    fireEvent.click(screen.getByRole("button", { name: "检测 AI 痕迹" }));
    expect(screen.getByText("未命中任何规则")).toBeInTheDocument();
  });

  it("改文本后旧结果清空（不显示过期结果）", () => {
    render(<ToneCard />);
    const box = screen.getByLabelText("待检测文本");
    fireEvent.change(box, { target: { value: "答案其实很简单——专注。" } });
    fireEvent.click(screen.getByRole("button", { name: "检测 AI 痕迹" }));
    expect(screen.getByText(/命中 1 处/)).toBeInTheDocument();
    fireEvent.change(box, { target: { value: "他去了趟超市。" } });
    expect(screen.queryByText(/命中 1 处/)).not.toBeInTheDocument();
  });
});
