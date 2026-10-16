import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MentionPicker } from "./MentionPicker.js";

describe("MentionPicker", () => {
  it("点击条目回调 onPick", () => {
    const onPick = vi.fn();
    render(<MentionPicker items={[{ id: "a1", name: "和小鸣" }]} onPick={onPick} />);
    fireEvent.click(screen.getByText("和小鸣"));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: "a1" }));
  });
  it("空列表显示提示", () => {
    render(<MentionPicker items={[]} onPick={() => {}} />);
    expect(screen.getByText(/群内暂无智能体/)).toBeInTheDocument();
  });
});
