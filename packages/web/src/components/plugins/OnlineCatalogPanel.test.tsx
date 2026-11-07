import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { PluginCatalogEntry } from "@heming/shared";
import { OnlineCatalogPanel } from "./OnlineCatalogPanel.js";

/**
 * 云端插件目录面板（d.86）：纯展示组件的状态口径。
 *
 * 关注点是「用户能不能判断该不该装」：版本、已装状态、权限与指纹都要在行内可见；
 * 空态/错误/加载三态各有出路（重试/关闭），不把网络失败伪装成「没有插件」。
 */

const entry = (overrides: Partial<PluginCatalogEntry> = {}): PluginCatalogEntry => ({
  id: "heming.magpie-gateway",
  name: "magpie 网关",
  version: "0.1.0",
  schemaVersion: 4,
  description: "把本机 magpie 网关接成模型来源",
  author: "和鸣",
  publishedAt: "2026-11-07T12:00:00.000Z",
  sha256: "abcdef0123456789".repeat(4),
  size: 1024,
  permissions: { network: ["127.0.0.1:3425"], tools: "none", files: [] },
  contributions: { skills: 1, mcpServers: 0, commands: 1, toolPacks: 0, llmPresets: 1 },
  ...overrides,
});

const baseProps = {
  entries: null,
  loading: false,
  error: null,
  onRefresh: () => {},
  onLoad: () => {},
  onClose: () => {},
};

describe("OnlineCatalogPanel", () => {
  it("加载中：只说正在获取，不显示空态", () => {
    render(<OnlineCatalogPanel {...baseProps} loading />);
    expect(screen.getByText(/正在获取云端插件目录/)).toBeInTheDocument();
    expect(screen.queryByText(/云端还没有可安装的插件/)).toBeNull();
  });

  it("错误：role=alert + 重试与关闭都有出口", () => {
    const onRefresh = vi.fn();
    render(
      <OnlineCatalogPanel {...baseProps} entries={[]} error="云端插件目录不可用：http 502" onRefresh={onRefresh} />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("云端插件目录不可用");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "关闭云端插件目录" })).toBeInTheDocument();
  });

  it("空目录：明确说云端还没有插件", () => {
    render(<OnlineCatalogPanel {...baseProps} entries={[]} />);
    expect(screen.getByText("云端还没有可安装的插件。")).toBeInTheDocument();
  });

  it("条目：版本/权限/贡献/指纹可见，未安装显示「新插件」", () => {
    render(<OnlineCatalogPanel {...baseProps} entries={[entry()]} />);
    expect(screen.getByRole("region", { name: "云端插件目录" })).toBeInTheDocument();
    expect(screen.getByText("magpie 网关")).toBeInTheDocument();
    expect(screen.getByText("v0.1.0")).toBeInTheDocument();
    expect(screen.getByText("新插件")).toBeInTheDocument();
    expect(screen.getByText(/技能 1 · MCP 0 · 命令 1 · 模型预设 1/)).toBeInTheDocument();
    expect(screen.getByText(/主机 1 · 风险上限 不提供工具/)).toBeInTheDocument();
    expect(screen.getByText(/指纹 abcdef01…/)).toBeInTheDocument();
  });

  it("已装同版本 / 可更新：文案不同但都允许载入（重装/覆盖走既有预览）", () => {
    render(
      <OnlineCatalogPanel
        {...baseProps}
        entries={[entry(), entry({ id: "heming.other", name: "别的包", version: "2.0.0" })]}
        installed={[
          { id: "heming.magpie-gateway", version: "0.1.0" },
          { id: "heming.other", version: "1.0.0" },
        ]}
      />,
    );
    expect(screen.getByText("已装 v0.1.0")).toBeInTheDocument();
    expect(screen.getByText("已装 v1.0.0 · 可更新到 v2.0.0")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "载入 别的包" })).toBeEnabled();
  });

  it("载入：回调对应条目；下载中禁用并显示文案", () => {
    const onLoad = vi.fn();
    render(
      <OnlineCatalogPanel
        {...baseProps}
        entries={[entry()]}
        loadingKey="heming.magpie-gateway@0.1.0"
        onLoad={onLoad}
      />,
    );
    const button = screen.getByRole("button", { name: "载入 magpie 网关" });
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent("下载中…");
    expect(onLoad).not.toHaveBeenCalled();
  });
});
