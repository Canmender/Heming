import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FileTree } from "./FileTree.js";

const items = [
  { id: "f1", owner: "me", name: "docs", mime: "inode/directory", size: 0, updatedAt: "2026-10-13" },
  { id: "f2", owner: "me", name: "需求草案.md", mime: "text/markdown", size: 100, updatedAt: "2026-10-13" },
  { id: "f3", owner: "me", name: "需求草案-v2.md", mime: "text/markdown", size: 120, updatedAt: "2026-10-13", parentId: "f1" },
];

describe("FileTree", () => {
  it("默认折叠文件夹，点击箭头展开", () => {
    render(<FileTree items={items} localPaths={[]} />);
    expect(screen.getByText("需求草案.md")).toBeInTheDocument();
    expect(screen.queryByText("需求草案-v2.md")).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("切换文件夹 docs"));
    expect(screen.getByText("需求草案-v2.md")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("切换文件夹 docs"));
    expect(screen.queryByText("需求草案-v2.md")).not.toBeInTheDocument();
  });

  it("本地未绑定时显示绑定入口文案", () => {
    render(<FileTree items={[]} localPaths={[]} />);
    expect(screen.getByText("未绑定本地目录")).toBeInTheDocument();
  });
});
