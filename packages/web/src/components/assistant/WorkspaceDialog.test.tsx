import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { WorkspaceDialog, type WorkspaceDialogProps } from "./WorkspaceDialog.js";

function renderDialog(over: Partial<WorkspaceDialogProps> = {}) {
  const props: WorkspaceDialogProps = {
    open: true,
    mode: "new",
    onCancel: vi.fn(),
    onConfirm: vi.fn(),
    ...over,
  };
  render(<WorkspaceDialog {...props} />);
  return props;
}

function pathInput(dialog: HTMLElement): HTMLInputElement {
  return within(dialog).getByRole("textbox", { name: "工作区文件夹路径" }) as HTMLInputElement;
}

afterEach(() => {
  cleanup();
  delete (window as unknown as { heming?: unknown }).heming;
});

describe("WorkspaceDialog · 新建工作区", () => {
  it("标题与输入框就位；路径为空时「确定」禁用，填入后提交 trim 过的路径", () => {
    const props = renderDialog();
    const dialog = screen.getByRole("dialog", { name: "新建工作区" });
    expect(within(dialog).getByText("工作区是本机的一个文件夹；这一段对话会归到它下面。")).toBeInTheDocument();
    const confirm = within(dialog).getByRole("button", { name: "确定" });
    expect(confirm).toBeDisabled();
    expect(within(dialog).queryByRole("button", { name: "移出工作区（未分组）" })).not.toBeInTheDocument();

    fireEvent.change(pathInput(dialog), { target: { value: "  D:/项目/新工作区  " } });
    expect(confirm).not.toBeDisabled();
    fireEvent.click(confirm);
    expect(props.onConfirm).toHaveBeenCalledWith("D:/项目/新工作区");
  });

  it("取消 / Esc / 关闭按钮都走 onCancel", () => {
    const props = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(props.onCancel).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(props.onCancel).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(props.onCancel).toHaveBeenCalledTimes(3);
    expect(props.onConfirm).not.toHaveBeenCalled();
  });

  it("提交中（busy）所有按钮与输入框都禁用", () => {
    renderDialog({ busy: true });
    const dialog = screen.getByRole("dialog", { name: "新建工作区" });
    expect(within(dialog).getByRole("button", { name: "确定" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "取消" })).toBeDisabled();
    expect(pathInput(dialog)).toBeDisabled();
  });
});

describe("WorkspaceDialog · 移动到工作区", () => {
  it("标题是「移动到工作区」，initialPath 回填，确定提交新路径", () => {
    const props = renderDialog({ mode: "move", initialPath: "D:/项目/和鸣" });
    const dialog = screen.getByRole("dialog", { name: "移动到工作区" });
    expect(pathInput(dialog)).toHaveValue("D:/项目/和鸣");

    fireEvent.change(pathInput(dialog), { target: { value: "D:/项目/另一个组" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "确定" }));
    expect(props.onConfirm).toHaveBeenCalledWith("D:/项目/另一个组");
  });

  it("「移出工作区（未分组）」提交 null", () => {
    const props = renderDialog({ mode: "move", initialPath: "D:/项目/和鸣" });
    const dialog = screen.getByRole("dialog", { name: "移动到工作区" });
    fireEvent.click(within(dialog).getByRole("button", { name: "移出工作区（未分组）" }));
    expect(props.onConfirm).toHaveBeenCalledWith(null);
  });

  it("Enter 键提交（等价于点确定）", () => {
    const props = renderDialog({ mode: "move", initialPath: "D:/项目/和鸣" });
    const dialog = screen.getByRole("dialog", { name: "移动到工作区" });
    fireEvent.keyDown(pathInput(dialog), { key: "Enter" });
    expect(props.onConfirm).toHaveBeenCalledWith("D:/项目/和鸣");
  });
});

describe("WorkspaceDialog · 桌面目录选择器（可选能力）", () => {
  it("没有 window.heming.pickDirectory 时不渲染「选择文件夹…」", () => {
    renderDialog();
    expect(screen.queryByRole("button", { name: "选择文件夹…" })).not.toBeInTheDocument();
  });

  it("选中目录后填入输入框", async () => {
    const pickDirectory = vi.fn(async () => "D:/项目/选中的");
    (window as unknown as { heming: unknown }).heming = { pickDirectory };
    renderDialog();
    const dialog = screen.getByRole("dialog", { name: "新建工作区" });
    fireEvent.click(within(dialog).getByRole("button", { name: "选择文件夹…" }));
    await waitFor(() => expect(pathInput(dialog)).toHaveValue("D:/项目/选中的"));
    expect(pickDirectory).toHaveBeenCalled();
  });

  it("用户在原生弹窗点取消（返回 null）：输入框保持原样，也不弹错误", async () => {
    (window as unknown as { heming: unknown }).heming = { pickDirectory: vi.fn(async () => null) };
    renderDialog({ mode: "move", initialPath: "D:/项目/和鸣" });
    const dialog = screen.getByRole("dialog", { name: "移动到工作区" });
    fireEvent.click(within(dialog).getByRole("button", { name: "选择文件夹…" }));
    await waitFor(() => expect(pathInput(dialog)).toHaveValue("D:/项目/和鸣"));
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("选择器抛错时用 role=alert 提示可粘贴路径", async () => {
    (window as unknown as { heming: unknown }).heming = {
      pickDirectory: vi.fn(async () => {
        throw new Error("no dialog");
      }),
    };
    renderDialog();
    const dialog = screen.getByRole("dialog", { name: "新建工作区" });
    fireEvent.click(within(dialog).getByRole("button", { name: "选择文件夹…" }));
    await waitFor(() =>
      expect(within(dialog).getByRole("alert")).toHaveTextContent("打开文件夹选择器失败，可以直接粘贴路径。"),
    );
  });

  it("改路径会清掉上一次的选择器错误", async () => {
    (window as unknown as { heming: unknown }).heming = {
      pickDirectory: vi.fn(async () => {
        throw new Error("no dialog");
      }),
    };
    renderDialog();
    const dialog = screen.getByRole("dialog", { name: "新建工作区" });
    fireEvent.click(within(dialog).getByRole("button", { name: "选择文件夹…" }));
    await waitFor(() => expect(within(dialog).getByRole("alert")).toBeInTheDocument());
    fireEvent.change(pathInput(dialog), { target: { value: "D:/手输的" } });
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("WorkspaceDialog · open=false", () => {
  it("关闭状态整棵子树不渲染", () => {
    renderDialog({ open: false });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
