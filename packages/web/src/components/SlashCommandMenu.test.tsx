import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SlashCommandMenu } from "./SlashCommandMenu.js";
import { SLASH_COMMANDS } from "../lib/agentRuntime/slashCommands.js";

describe("SlashCommandMenu（d.184）", () => {
  it("空列表不渲染任何东西", () => {
    const { container } = render(<SlashCommandMenu items={[]} activeIndex={0} onPick={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("列出命令名、标题与说明，并把当前行标成选中", () => {
    render(<SlashCommandMenu items={SLASH_COMMANDS} activeIndex={1} onPick={() => {}} />);
    const list = screen.getByRole("listbox", { name: "可用命令" });
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(SLASH_COMMANDS.length);
    expect(list).toBeInTheDocument();
    expect(options[0]).toHaveAttribute("aria-selected", "false");
    expect(options[1]).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("/compact")).toBeInTheDocument();
    expect(screen.getByText("压缩这段对话")).toBeInTheDocument();
  });

  it("高亮索引越界时收口到最后一个，不抛错", () => {
    render(<SlashCommandMenu items={SLASH_COMMANDS} activeIndex={9} onPick={() => {}} />);
    const options = screen.getAllByRole("option");
    expect(options[options.length - 1]).toHaveAttribute("aria-selected", "true");
  });

  it("点某一行把它的命令交给上层（不自己改草稿）", () => {
    const onPick = vi.fn();
    render(<SlashCommandMenu items={SLASH_COMMANDS} activeIndex={0} onPick={onPick} />);
    fireEvent.mouseDown(screen.getByText("/plan"));
    expect(onPick).toHaveBeenCalledWith("/plan");
  });
});
