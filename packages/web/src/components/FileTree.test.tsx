import { describe, it, expect, vi } from "vitest";
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

  it("全空时给统一空态说明（告诉用户下一步在哪上传/绑定）", () => {
    render(<FileTree items={[]} localPaths={[]} />);
    expect(screen.getByText("还没有文件。点上方「上传」或「绑定」，把文件放进来。")).toBeInTheDocument();
    // 空态下不再显示两个各自为政的分区占位
    expect(screen.queryByText("未绑定本地目录")).not.toBeInTheDocument();
    expect(screen.queryByText("（空）")).not.toBeInTheDocument();
  });

  it("有云端文件、本地未绑定时显示绑定入口文案", () => {
    render(<FileTree items={[items[1]]} localPaths={[]} />);
    expect(screen.getByText("未绑定本地目录")).toBeInTheDocument();
  });

  it("文件行提供发送到会话与预览操作（目录行没有）", () => {
    render(
      <FileTree
        items={[
          { id: "d1", owner: "me", name: "docs", mime: "inode/directory", size: 0, updatedAt: "" },
          { id: "f1", owner: "me", name: "a.txt", mime: "text/plain", size: 1, updatedAt: "" },
        ]}
        localPaths={[]}
        onSendToConversation={vi.fn()}
        onPreview={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("发送到会话 a.txt")).toBeTruthy();
    expect(screen.getByLabelText("预览 a.txt")).toBeTruthy();
    // 目录行只给展开/折叠，不给文件操作
    expect(screen.queryByLabelText("发送到会话 docs")).toBeNull();
    expect(screen.queryByLabelText("预览 docs")).toBeNull();
  });

  it("未传操作回调时不渲染操作钮", () => {
    render(
      <FileTree
        items={[{ id: "f1", owner: "me", name: "a.txt", mime: "text/plain", size: 1, updatedAt: "" }]}
        localPaths={[]}
      />,
    );
    expect(screen.queryByLabelText("发送到会话 a.txt")).toBeNull();
    expect(screen.queryByLabelText("预览 a.txt")).toBeNull();
  });
});
