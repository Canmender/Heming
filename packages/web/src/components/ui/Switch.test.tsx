import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import { Switch } from "./Switch.js";

afterEach(() => cleanup());

describe("Switch（开关基元）", () => {
  it("用 role=switch + aria-checked 表达状态，可访问名来自 label", () => {
    render(<Switch label="和小鸣 短期记忆" checked onChange={() => {}} />);
    const sw = screen.getByRole("switch", { name: "和小鸣 短期记忆" });
    expect(sw.getAttribute("aria-checked")).toBe("true");
  });

  it("点击把取反后的值交给调用方（关闭 → true）", () => {
    const onChange = vi.fn();
    render(<Switch label="长期记忆" checked={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole("switch"));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("开启时滑块在右侧（left-[16px]），关闭时在左侧（left-[2px]）", () => {
    const { rerender } = render(<Switch label="个人数据库" checked onChange={() => {}} />);
    expect(screen.getByRole("switch").firstElementChild?.className).toContain("left-[16px]");
    rerender(<Switch label="个人数据库" checked={false} onChange={() => {}} />);
    expect(screen.getByRole("switch").firstElementChild?.className).toContain("left-[2px]");
  });

  it("disabled 时不触发 onChange，并带 aria-disabled", () => {
    const onChange = vi.fn();
    render(<Switch label="置顶" checked={false} disabled onChange={onChange} />);
    const sw = screen.getByRole("switch");
    expect(sw.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(sw);
    expect(onChange).not.toHaveBeenCalled();
  });
});
