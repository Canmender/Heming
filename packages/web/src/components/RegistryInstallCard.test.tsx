import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RegistryInstallDialog } from "./RegistryInstallCard.js";
import { buildInstallPreview } from "../lib/registry/preview.js";
import type { RegistryEntry } from "../lib/registry/types.js";

function entry(patch: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    key: "com.example/tool",
    title: "示例服务",
    description: "",
    status: "active",
    options: [],
    ...patch,
  };
}

const remote = { kind: "http" as const, label: "远程", url: "https://mcp.example.com/mcp" };
const stdio = { kind: "stdio" as const, label: "npm · pkg@1.0.0", command: "npx", args: ["pkg"] };

describe("RegistryInstallDialog", () => {
  it("低风险远程：说明不装代码，且始终出现「不代表已通过安全审核」", () => {
    const preview = buildInstallPreview(entry(), remote);
    render(<RegistryInstallDialog requestId="r1" preview={preview} onDecide={() => {}} />);

    expect(screen.getByRole("dialog", { name: /安装 示例服务/ })).toBeInTheDocument();
    expect(screen.getByText(/不安装任何代码/)).toBeInTheDocument();
    expect(screen.getByText(/不代表已通过安全审核/)).toBeInTheDocument();
    expect(screen.getByText("com.example/tool")).toBeInTheDocument();
  });

  it("中风险 stdio：出现「以本机进程运行」", () => {
    const preview = buildInstallPreview(entry(), stdio);
    render(<RegistryInstallDialog requestId="r1" preview={preview} onDecide={() => {}} />);
    expect(screen.getByText(/以本机进程运行/)).toBeInTheDocument();
  });

  it("高风险：已下架 + 来源与仓库不一致都要提示", () => {
    const preview = buildInstallPreview(
      entry({ status: "deprecated", repoUrl: "https://github.com/other/repo" }),
      stdio,
    );
    render(<RegistryInstallDialog requestId="r1" preview={preview} onDecide={() => {}} />);
    expect(screen.getByText(/已标记为「deprecated」/)).toBeInTheDocument();
    expect(screen.getByText(/不一致/)).toBeInTheDocument();
    expect(screen.getByText(/不代表已通过安全审核/)).toBeInTheDocument();
  });

  it("必填请求头未填时不能确认；填好后裁决带上头值", () => {
    const onDecide = vi.fn();
    const preview = buildInstallPreview(entry(), {
      ...remote,
      headerHints: [{ name: "Authorization", isRequired: true, isSecret: true, description: "Bearer key" }],
    });
    render(<RegistryInstallDialog requestId="r1" preview={preview} onDecide={onDecide} />);

    const confirm = screen.getByRole("button", { name: "确认安装" });
    expect(confirm).toBeDisabled();

    fireEvent.change(screen.getByLabelText("请求头 Authorization"), {
      target: { value: "Bearer secret" },
    });
    expect(confirm).not.toBeDisabled();
    fireEvent.click(confirm);

    expect(onDecide).toHaveBeenCalledWith({
      approved: true,
      headers: { Authorization: "Bearer secret" },
    });
  });

  it("取消返回 approved:false", () => {
    const onDecide = vi.fn();
    const preview = buildInstallPreview(entry(), remote);
    render(<RegistryInstallDialog requestId="r1" preview={preview} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole("button", { name: "取消安装" }));
    expect(onDecide).toHaveBeenCalledWith({ approved: false });
  });
});
