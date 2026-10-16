import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EmojiPicker } from "./EmojiPicker.js";

describe("EmojiPicker", () => {
  it("点表情回调所选字符", () => {
    const onPick = vi.fn();
    render(<EmojiPicker onPick={onPick} />);
    fireEvent.click(screen.getByRole("button", { name: "😀" }));
    expect(onPick).toHaveBeenCalledWith("😀");
  });

  it("渲染固定表情集（每枚一枚按钮）", () => {
    render(<EmojiPicker onPick={vi.fn()} />);
    expect(screen.getAllByRole("button")).toHaveLength(20);
  });
});
