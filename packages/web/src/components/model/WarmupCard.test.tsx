import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WarmupCard } from "./WarmupCard.js";

const values = (rows: Record<string, unknown>): Map<string, unknown> => new Map(Object.entries(rows));

const setup = (rows: Record<string, unknown> = {}) => {
  const onLevel = vi.fn();
  const onTimes = vi.fn();
  render(<WarmupCard values={values(rows)} busy={false} onLevel={onLevel} onTimes={onTimes} />);
  return { onLevel, onTimes };
};

describe("WarmupCard", () => {
  it("两家厂商各一行，默认都不预热，档位说明挂在选择框上", () => {
    setup();
    const codex = screen.getByLabelText("ChatGPT 的预热");
    expect(codex).toHaveValue("off");
    expect(screen.getByLabelText("Claude 的预热")).toHaveValue("off");
    expect(codex.getAttribute("title")).toMatch(/窗口从你第一次用到它的那一刻才开始算/);
    expect(screen.getByText(/两家都还没预热/)).toBeInTheDocument();
  });

  it("切档就把内核那两个字面值交出去", () => {
    const { onLevel } = setup();
    fireEvent.change(screen.getByLabelText("ChatGPT 的预热"), { target: { value: "week" } });
    expect(onLevel).toHaveBeenCalledWith("codexWarmup", "week");
    fireEvent.change(screen.getByLabelText("Claude 的预热"), { target: { value: "all" } });
    expect(onLevel).toHaveBeenCalledWith("claudeWarmup", "all");
  });

  it("时间点按回车提交：整理成 09:00 这样再交出去", () => {
    const { onTimes } = setup();
    const input = screen.getByLabelText("ChatGPT 每天开 5 小时窗口的时间");
    fireEvent.change(input, { target: { value: "15:05 9:00" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onTimes).toHaveBeenCalledWith("codexWarmAts", ["09:00", "15:05"]);
  });

  it("没改动就不提交：失焦不会白发一条命令", () => {
    const { onTimes } = setup({ codexWarmAts: ["06:00"] });
    const input = screen.getByLabelText("ChatGPT 每天开 5 小时窗口的时间");
    expect(input).toHaveValue("06:00");
    fireEvent.blur(input);
    expect(onTimes).not.toHaveBeenCalled();
  });

  it("看不懂的时间只提示、不提交", () => {
    const { onTimes } = setup();
    const input = screen.getByLabelText("Claude 每天开 5 小时窗口的时间");
    fireEvent.change(input, { target: { value: "中午" } });
    fireEvent.blur(input);
    expect(onTimes).not.toHaveBeenCalled();
    expect(screen.getByText(/时间看不懂：写成 06:00 这样/)).toBeInTheDocument();
  });

  it("清空就是「不开」：交出去的是空列表，内核那边会重置", () => {
    const { onTimes } = setup({ claudeWarmAts: ["06:00", "15:05"] });
    const input = screen.getByLabelText("Claude 每天开 5 小时窗口的时间");
    expect(input).toHaveValue("06:00 15:05");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onTimes).toHaveBeenCalledWith("claudeWarmAts", []);
  });

  it("已经开着并设了时间时，底部那句总结把两家都说出来", () => {
    setup({
      codexWarmup: "all",
      codexWarmAts: ["06:00", "15:05"],
      claudeWarmup: "week",
    });
    expect(
      screen.getByText("ChatGPT：每周与 5 小时窗口，每天 06:00、15:05 开一次；Claude：每周窗口"),
    ).toBeInTheDocument();
  });
});
