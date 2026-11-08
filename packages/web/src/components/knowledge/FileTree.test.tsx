import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { VaultEntry } from "../../lib/vault/types.js";
import { FileTree, type FileTreeProps } from "./FileTree.js";

/** 测试夹具：一个目录（两个文件）+ 一个根文件。 */
function fixtureTree(): VaultEntry[] {
  const mtime = "2026-11-08T08:00:00.000Z";
  return [
    {
      rel: "inbox",
      name: "inbox",
      kind: "dir",
      size: 0,
      mtime,
      children: [
        { rel: "inbox/a.md", name: "a.md", kind: "md", size: 12, mtime },
        { rel: "inbox/b.md", name: "b.md", kind: "md", size: 20, mtime },
      ],
    },
    { rel: "hello.md", name: "hello.md", kind: "md", size: 8, mtime },
  ];
}

function setup(overrides: Partial<FileTreeProps> = {}) {
  const props: FileTreeProps = {
    tree: fixtureTree(),
    activeRel: null,
    onOpen: vi.fn(),
    onCreateFile: vi.fn(),
    onCreateFolder: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
    onReveal: vi.fn(),
    onExpandDir: vi.fn(),
    ...overrides,
  };
  const view = render(<FileTree {...props} />);
  return { props, view };
}

describe("知识库文件树", () => {
  it("空目录态：给出空态文案与「新建第一篇笔记」入口", () => {
    const { props } = setup({ tree: [] });
    expect(screen.getByText("这个库还没有文件。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "新建第一篇笔记" }));
    fireEvent.change(screen.getByLabelText("笔记名"), { target: { value: "第一篇" } });
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    expect(props.onCreateFile).toHaveBeenCalledWith("", "第一篇.md");
  });

  it("目录默认折叠：点开才出现子文件，再点收起；展开只回调一次", () => {
    const { props } = setup();
    expect(screen.queryByRole("treeitem", { name: /a\.md/ })).not.toBeInTheDocument();
    const dir = screen.getByRole("treeitem", { name: /inbox/ });
    expect(dir).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(dir);
    expect(screen.getByRole("treeitem", { name: /a\.md/ })).toBeInTheDocument();
    expect(dir).toHaveAttribute("aria-expanded", "true");
    expect(props.onExpandDir).toHaveBeenCalledTimes(1);
    expect(props.onExpandDir).toHaveBeenCalledWith("inbox");

    fireEvent.click(dir);
    expect(screen.queryByRole("treeitem", { name: /a\.md/ })).not.toBeInTheDocument();
    // 收起再展开不重复触发懒加载
    fireEvent.click(dir);
    expect(props.onExpandDir).toHaveBeenCalledTimes(1);
  });

  it("键盘：右方向键展开目录、左方向键收起", () => {
    const { props } = setup();
    const dir = screen.getByRole("treeitem", { name: /inbox/ });
    fireEvent.keyDown(dir, { key: "ArrowRight" });
    expect(screen.getByRole("treeitem", { name: /a\.md/ })).toBeInTheDocument();
    fireEvent.keyDown(dir, { key: "ArrowLeft" });
    expect(screen.queryByRole("treeitem", { name: /a\.md/ })).not.toBeInTheDocument();
    expect(props.onOpen).not.toHaveBeenCalled();
  });

  it("当前文件高亮：aria-current=page / aria-selected=true", () => {
    setup({ activeRel: "hello.md" });
    const row = screen.getByRole("treeitem", { name: /hello\.md/ });
    expect(row).toHaveAttribute("aria-current", "page");
    expect(row).toHaveAttribute("aria-selected", "true");
    // 目录行不参与选中高亮
    expect(screen.getByRole("treeitem", { name: /inbox/ })).toHaveAttribute(
      "aria-selected",
      "false",
    );
  });

  it("未保存标记：dirty 集合里的文件带「未保存」标记", () => {
    setup({ dirty: new Set(["hello.md"]) });
    expect(screen.getByLabelText("未保存")).toBeInTheDocument();
  });

  it("点文件打开；活动文件在深层目录时自动展开祖先", () => {
    const { props } = setup({ activeRel: "inbox/a.md" });
    // 祖先自动展开后可见
    expect(screen.getByRole("treeitem", { name: /a\.md/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("treeitem", { name: /hello\.md/ }));
    expect(props.onOpen).toHaveBeenCalledWith("hello.md");
  });

  it("右键菜单：在资源管理器中显示", () => {
    const { props } = setup();
    fireEvent.contextMenu(screen.getByRole("treeitem", { name: /hello\.md/ }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "在资源管理器中显示" }));
    expect(props.onReveal).toHaveBeenCalledWith("hello.md");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("右键菜单：重命名走输入弹窗并补 .md", () => {
    const { props } = setup();
    fireEvent.contextMenu(screen.getByRole("treeitem", { name: /hello\.md/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "重命名" }));
    const input = screen.getByLabelText("新名称");
    fireEvent.change(input, { target: { value: "world" } });
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    expect(props.onRename).toHaveBeenCalledWith("hello.md", "world.md");
  });

  it("右键菜单：新建笔记落在目标目录里", () => {
    const { props } = setup();
    fireEvent.contextMenu(screen.getByRole("treeitem", { name: /inbox/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "新建笔记" }));
    fireEvent.change(screen.getByLabelText("笔记名"), { target: { value: "c" } });
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    expect(props.onCreateFile).toHaveBeenCalledWith("inbox", "c.md");
  });

  it("删除走应用内二次确认：取消不删、确认才删", () => {
    const { props } = setup();
    fireEvent.contextMenu(screen.getByRole("treeitem", { name: /hello\.md/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
    expect(screen.getByRole("dialog", { name: "删除文件" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(props.onDelete).not.toHaveBeenCalled();

    fireEvent.contextMenu(screen.getByRole("treeitem", { name: /hello\.md/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(props.onDelete).toHaveBeenCalledWith("hello.md");
  });

  it("目录不提供删除/重命名入口（删除不递归）", () => {
    setup();
    fireEvent.contextMenu(screen.getByRole("treeitem", { name: /inbox/ }));
    expect(screen.queryByRole("menuitem", { name: "删除" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "重命名" })).not.toBeInTheDocument();
  });

  it("新建文件夹：调用方没提供能力时禁用并说明原因", () => {
    setup({ onCreateFolder: undefined });
    fireEvent.contextMenu(screen.getByRole("treeitem", { name: /hello\.md/ }));
    const item = screen.getByRole("menuitem", { name: "新建文件夹" });
    expect(item).toBeDisabled();
    expect(item.getAttribute("title")).toContain("不建空目录");
  });

  it("新建文件夹：提供能力时走输入弹窗", () => {
    const { props } = setup();
    fireEvent.contextMenu(screen.getByRole("treeitem", { name: /hello\.md/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "新建文件夹" }));
    fireEvent.change(screen.getByLabelText("文件夹名"), { target: { value: "资料" } });
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    expect(props.onCreateFolder).toHaveBeenCalledWith("", "资料");
  });

  it("库错误提示以 alert 呈现", () => {
    setup({ error: "读目录失败：权限不足" });
    expect(screen.getByRole("alert")).toHaveTextContent("读目录失败：权限不足");
  });
});
