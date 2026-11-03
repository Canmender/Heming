import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ThemeModeCard } from "./ThemeModeCard.js";
import { THEME_MODE_KEY, resetThemeModeWatcherForTest } from "../../lib/theme.js";

/**
 * d.67 T3：设置区「主题模式」卡（浅色 / 深色 / 跟随系统）。
 *
 * 只验 UI 选择与即时生效这条线：radiogroup 语义、点击/键盘切换、落盘键、
 * 以及 html 上的 data-theme 立刻变化。主题模式本身的纯函数用例在 lib/theme.mode.test.ts。
 */

function installMatchMedia(matches: boolean) {
  const mq = {
    matches,
    media: "(prefers-color-scheme: dark)",
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  window.matchMedia = vi.fn(() => mq) as unknown as typeof window.matchMedia;
  return mq;
}

beforeEach(() => {
  resetThemeModeWatcherForTest();
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
  document.documentElement.removeAttribute("style");
  installMatchMedia(false);
});

afterEach(() => cleanup());

describe("主题模式卡", () => {
  it("渲染 radiogroup 三选一，默认「跟随系统」被选中", () => {
    render(<ThemeModeCard />);
    expect(screen.getByRole("radiogroup", { name: "主题模式" })).toBeInTheDocument();
    const radios = screen.getAllByRole("radio");
    expect(radios.map((r) => r.getAttribute("aria-label"))).toEqual([
      "主题模式 跟随系统",
      "主题模式 浅色",
      "主题模式 深色",
    ]);
    expect(screen.getByRole("radio", { name: "主题模式 跟随系统" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("点「深色」→ 即时写 data-theme=dark 并落盘", () => {
    render(<ThemeModeCard />);
    fireEvent.click(screen.getByRole("radio", { name: "主题模式 深色" }));

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(window.localStorage.getItem(THEME_MODE_KEY)).toBe("dark");
    expect(screen.getByRole("radio", { name: "主题模式 深色" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("点「浅色」→ data-theme=light，且暗色强调色被撤回", () => {
    window.localStorage.setItem(THEME_MODE_KEY, "dark");
    render(<ThemeModeCard />);
    fireEvent.click(screen.getByRole("radio", { name: "主题模式 浅色" }));

    expect(document.documentElement.dataset.theme).toBe("light");
    expect(window.localStorage.getItem(THEME_MODE_KEY)).toBe("light");
    // 浅色下默认墨黑不应残留暗色强调值（回到 CSS 默认，即无内联变量）
    expect(document.documentElement.style.getPropertyValue("--heming-accent")).toBe("");
  });

  it("「跟随系统」按系统偏好即时解析（系统为深色 → dark）", () => {
    installMatchMedia(true);
    window.localStorage.setItem(THEME_MODE_KEY, "light");
    render(<ThemeModeCard />);
    fireEvent.click(screen.getByRole("radio", { name: "主题模式 跟随系统" }));

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(window.localStorage.getItem(THEME_MODE_KEY)).toBe("system");
  });

  it("键盘 ←/→ 在三个选项间循环切换（单选组语义）", () => {
    render(<ThemeModeCard />);
    const group = screen.getByRole("radiogroup", { name: "主题模式" });

    fireEvent.keyDown(group, { key: "ArrowRight" }); // system → light
    expect(screen.getByRole("radio", { name: "主题模式 浅色" })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    fireEvent.keyDown(group, { key: "ArrowRight" }); // light → dark
    expect(screen.getByRole("radio", { name: "主题模式 深色" })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    fireEvent.keyDown(group, { key: "ArrowRight" }); // dark → system（循环）
    expect(screen.getByRole("radio", { name: "主题模式 跟随系统" })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    fireEvent.keyDown(group, { key: "ArrowLeft" }); // system → dark（反向循环）
    expect(screen.getByRole("radio", { name: "主题模式 深色" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("读取既有选择：存储是 dark 时进页面即选中深色并应用", () => {
    window.localStorage.setItem(THEME_MODE_KEY, "dark");
    render(<ThemeModeCard />);
    expect(screen.getByRole("radio", { name: "主题模式 深色" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});
