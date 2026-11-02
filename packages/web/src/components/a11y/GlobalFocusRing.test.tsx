import { afterEach, describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { FOCUS_CSS, FOCUS_STYLE_ID, GlobalFocusRing } from "./GlobalFocusRing.js";

/**
 * 全站焦点环注入（③-2）：一条 `:focus-visible` 规则覆盖所有 `outline-hidden` 控件。
 * 断言的是「规则存在且幂等」，不是像素。
 */

afterEach(() => {
  document.getElementById(FOCUS_STYLE_ID)?.remove();
});

describe("GlobalFocusRing", () => {
  it("注入一条 :focus-visible 规则（键盘才出环，鼠标不出）", () => {
    render(<GlobalFocusRing />);
    const style = document.getElementById(FOCUS_STYLE_ID);
    expect(style).not.toBeNull();
    const css = style!.textContent ?? "";
    expect(css).toContain(":focus-visible");
    expect(css).toContain("outline: 2px solid");
    expect(css).toContain("outline-offset: 2px");
    // 不能用 :focus——鼠标点击也会出环，是噪音
    expect(css).not.toMatch(/(^|[\s,{]):focus\s*\{/);
  });

  it("使用主题强调色变量，换主题时焦点环跟着换", () => {
    expect(FOCUS_CSS).toContain("var(--heming-accent");
  });

  it("高对比模式下交还系统色（自定义色不能盖掉系统可见性）", () => {
    expect(FOCUS_CSS).toContain("forced-colors: active");
    expect(FOCUS_CSS).toContain("Highlight");
  });

  it("幂等：重复挂载只留一份 style", () => {
    const first = render(<GlobalFocusRing />);
    render(<GlobalFocusRing />);
    expect(document.querySelectorAll(`#${FOCUS_STYLE_ID}`)).toHaveLength(1);
    first.unmount();
  });
});
