import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { PluginCatalogEntry } from "@heming/shared";
import { PluginRepositoryPanel } from "./PluginRepositoryPanel.js";
import { fetchPluginCatalog } from "../../lib/plugins/catalogClient.js";

vi.mock("../../lib/plugins/catalogClient.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/plugins/catalogClient.js")>();
  return { ...actual, fetchPluginCatalog: vi.fn() };
});

const entry = (over: Partial<PluginCatalogEntry> = {}): PluginCatalogEntry => ({
  id: "acme.report",
  name: "财报速读",
  version: "1.2.0",
  schemaVersion: 3,
  description: "把归档里的财报读成结论",
  author: "ACME",
  publishedAt: "2026-11-07T10:00:00.000Z",
  sha256: "a".repeat(64),
  size: 2048,
  permissions: { network: ["mcp.example.com"], tools: "read", files: [] },
  contributions: { skills: 2, mcpServers: 1, commands: 0, toolPacks: 1, desktopWidgets: 0 },
  distribution: "manifest",
  ...over,
});

beforeEach(() => {
  vi.mocked(fetchPluginCatalog).mockReset();
});

describe("插件仓库面板（d.95）", () => {
  it("加载目录后按卡展示名称/版本/权限/贡献；可搜索过滤", async () => {
    vi.mocked(fetchPluginCatalog).mockResolvedValue([
      entry(),
      entry({ id: "acme.clean", name: "清理助手", description: "清理临时文件", permissions: { network: [], tools: "none", files: [] } }),
    ]);
    render(<PluginRepositoryPanel installed={[]} onLoad={vi.fn()} />);

    expect(await screen.findByText("财报速读")).toBeInTheDocument();
    const card = screen.getByText("财报速读").closest("li") as HTMLElement;
    expect(within(card).getByText("v1.2.0")).toBeInTheDocument();
    expect(within(card).getByText(/只读/)).toBeInTheDocument();
    expect(within(card).getByText("技能 2")).toBeInTheDocument();
    expect(within(card).getByText("未安装")).toBeInTheDocument();
    // 共 2 个
    expect(screen.getByText(/共 2 个/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("搜索插件仓库"), { target: { value: "清理" } });
    expect(screen.queryByText("财报速读")).toBeNull();
    expect(screen.getByText("清理助手")).toBeInTheDocument();
    expect(screen.getByText(/共 1 个/)).toBeInTheDocument();
  });

  it("已装同版本显示「已装」，有新版本显示可更新；点按钮把该条目交给上层下载", async () => {
    vi.mocked(fetchPluginCatalog).mockResolvedValue([
      entry(),
      entry({ id: "acme.old", name: "旧插件", version: "0.3.0" }),
    ]);
    const onLoad = vi.fn();
    render(
      <PluginRepositoryPanel
        installed={[
          { id: "acme.report", version: "1.2.0" },
          { id: "acme.old", version: "0.2.0" },
        ]}
        onLoad={onLoad}
      />,
    );

    expect(await screen.findByText("已装 v1.2.0")).toBeInTheDocument();
    const oldCard = screen.getByText("旧插件").closest("li") as HTMLElement;
    expect(within(oldCard).getByText(/可更新：v0.2.0 → v0.3.0/)).toBeInTheDocument();
    const updateBtn = within(oldCard).getByRole("button", { name: "更新" });
    fireEvent.click(updateBtn);
    expect(onLoad).toHaveBeenCalledWith(expect.objectContaining({ id: "acme.old", version: "0.3.0" }));
  });

  it("目录不可用：给可重试的错误；重试成功后恢复列表", async () => {
    vi.mocked(fetchPluginCatalog)
      .mockRejectedValueOnce(new Error("云端插件目录不可用：网络异常"))
      .mockResolvedValueOnce([entry()]);
    render(<PluginRepositoryPanel installed={[]} onLoad={vi.fn()} />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/云端插件目录不可用/);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("财报速读")).toBeInTheDocument();
  });

  it("仓库为空 / 搜索无结果：两种空态文案不同", async () => {
    vi.mocked(fetchPluginCatalog).mockResolvedValue([]);
    const { unmount } = render(<PluginRepositoryPanel installed={[]} onLoad={vi.fn()} />);
    expect(await screen.findByText("仓库里还没有插件")).toBeInTheDocument();
    unmount();

    vi.mocked(fetchPluginCatalog).mockResolvedValue([entry()]);
    render(<PluginRepositoryPanel installed={[]} onLoad={vi.fn()} />);
    await screen.findByText("财报速读");
    fireEvent.change(screen.getByLabelText("搜索插件仓库"), { target: { value: "不存在的名字" } });
    expect(screen.getByText("没有匹配的插件")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "清空搜索" }));
    expect(await screen.findByText("财报速读")).toBeInTheDocument();
  });
});
