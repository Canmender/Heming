import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SessionChangesBar } from "./SessionChangesBar.js";

describe("本会话改动回顾条（d.210）", () => {
  it("没有记录时不渲染（不占屏幕）", () => {
    const { container } = render(<SessionChangesBar changes={[]} onOpen={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("列出前三个文件名，多于三个时补「等 N 个」，点按钮打开回顾", () => {
    const onOpen = vi.fn();
    render(
      <SessionChangesBar
        changes={[
          { path: "/w/a.ts", at: 4000, writes: 2 },
          { path: "/w/b.ts", at: 3000, writes: 1 },
          { path: "/w/c.ts", at: 2000, writes: 1 },
          { path: "/w/d.ts", at: 1000, writes: 1 },
        ]}
        onOpen={onOpen}
      />,
    );

    expect(screen.getByTestId("session-changes")).toHaveTextContent("本会话改过 a.ts、b.ts、c.ts 等 4 个");
    fireEvent.click(screen.getByRole("button", { name: "查看改动" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("只有一两个文件时不显示「等 N 个」", () => {
    render(
      <SessionChangesBar
        changes={[
          { path: "/w/a.ts", at: 2000, writes: 1 },
          { path: "/w/b.ts", at: 1000, writes: 1 },
        ]}
        onOpen={() => {}}
      />,
    );
    const bar = screen.getByTestId("session-changes");
    expect(bar).toHaveTextContent("本会话改过 a.ts、b.ts");
    expect(bar).not.toHaveTextContent("等 2 个");
  });
});
