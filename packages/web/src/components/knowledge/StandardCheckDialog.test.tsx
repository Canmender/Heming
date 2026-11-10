import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { StandardCheckDialog } from "./StandardCheckDialog.js";
import type { StandardReport } from "../../lib/vault/standard.js";

function report(over: Partial<StandardReport> = {}): StandardReport {
  return {
    missingDirs: [],
    missingFiles: [],
    pageIssues: [],
    pageIssueCount: 0,
    scannedPages: 3,
    frontmatterChecked: true,
    complete: true,
    ...over,
  };
}

function renderDialog(over: Partial<Parameters<typeof StandardCheckDialog>[0]> = {}) {
  const onCheck = vi.fn();
  const onRepair = vi.fn();
  const onClose = vi.fn();
  const view = render(
    <StandardCheckDialog
      rootPath="C:/app/wiki"
      report={report()}
      checking={false}
      repairing={false}
      message={null}
      failures={[]}
      onCheck={onCheck}
      onRepair={onRepair}
      onClose={onClose}
      {...over}
    />,
  );
  return { view, onCheck, onRepair, onClose };
}

describe("标准检查弹窗", () => {
  it("结构完整：给通过结论，补齐按钮不可用", () => {
    renderDialog();
    expect(screen.getByRole("dialog", { name: "标准检查" })).toBeInTheDocument();
    expect(screen.getByText(/结构完整/)).toBeInTheDocument();
    expect(screen.getByText(/当前库根：C:\/app\/wiki/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "一键补齐结构" })).toBeDisabled();
  });

  it("缺目录/缺根文件：逐条列出，补齐按钮可点并回调", () => {
    const { onRepair } = renderDialog({
      report: report({
        complete: false,
        missingDirs: ["raw", "wiki/entities"],
        missingFiles: ["schema.md"],
      }),
    });
    expect(screen.getByText(/缺目录（2）/)).toBeInTheDocument();
    expect(screen.getByText(/· raw/)).toBeInTheDocument();
    expect(screen.getByText(/缺根文件（1）/)).toBeInTheDocument();
    const repair = screen.getByRole("button", { name: "一键补齐结构" });
    expect(repair).toBeEnabled();
    fireEvent.click(repair);
    expect(onRepair).toHaveBeenCalledTimes(1);
  });

  it("只剩缺 frontmatter：按钮禁用并说明不会自动改写", () => {
    renderDialog({
      report: report({
        complete: false,
        pageIssues: [{ rel: "notes/a.md", missing: ["created", "tags"] }],
        pageIssueCount: 1,
      }),
    });
    expect(screen.getByText(/notes\/a\.md（缺 created \/ tags）/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "一键补齐结构" })).toBeDisabled();
    expect(screen.getByText(/不会被自动改写/)).toBeInTheDocument();
  });

  it("索引未就绪：明说这次只查了结构，不假装 frontmatter 通过", () => {
    renderDialog({ report: report({ frontmatterChecked: false, scannedPages: 0 }) });
    expect(screen.getByText(/只查了结构/)).toBeInTheDocument();
  });

  it("补齐结果与失败项如实展示", () => {
    renderDialog({
      report: report({ complete: false, missingDirs: ["raw"] }),
      message: "补齐完了，但有 1 项没成功（见下）。",
      failures: [{ rel: "raw", message: "没有写权限" }],
    });
    expect(screen.getByRole("status")).toHaveTextContent("补齐完了，但有 1 项没成功");
    expect(screen.getByRole("alert")).toHaveTextContent("raw：没有写权限");
  });

  it("重新检查/关闭走各自回调", () => {
    const { onCheck, onClose } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "重新检查" }));
    expect(onCheck).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("检查中禁用动作，避免连点重复跑", () => {
    renderDialog({ checking: true, report: null });
    expect(screen.getByRole("button", { name: "检查中…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "一键补齐结构" })).toBeDisabled();
    expect(screen.getByText(/正在检查/)).toBeInTheDocument();
  });
});
