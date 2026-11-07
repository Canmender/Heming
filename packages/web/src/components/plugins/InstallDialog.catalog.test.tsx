import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PluginCatalogEntry } from "@heming/shared";
import { InstallDialog } from "./InstallDialog.js";
import { PublisherTrustStore } from "../../lib/plugins/index.js";

/**
 * 安装弹窗 · 云端插件入口（d.86）。
 *
 * 这条路径的价值是「少让人手抄 JSON」，但安装语义必须与手动粘贴完全一致：
 * 下载 → 填进同一个 textarea → 走同一套预览/确认，不新增第二条安装路径。
 */

const manifestText = JSON.stringify(
  {
    schemaVersion: 4,
    id: "heming.magpie-gateway",
    name: "magpie 网关",
    version: "0.1.0",
    permissions: { network: ["127.0.0.1:3425"], tools: "none", files: [] },
    contributions: { llmPresets: [{ id: "p", label: "P", provider: "openai", baseUrl: "http://127.0.0.1:3425/v1", model: "m" }] },
  },
  null,
  2,
);

const entry: PluginCatalogEntry = {
  id: "heming.magpie-gateway",
  name: "magpie 网关",
  version: "0.1.0",
  schemaVersion: 4,
  description: "本机网关",
  author: "和鸣",
  publishedAt: "2026-11-07T12:00:00.000Z",
  sha256: "a".repeat(64),
  size: manifestText.length,
  permissions: { network: ["127.0.0.1:3425"], tools: "none", files: [] },
  contributions: { skills: 0, mcpServers: 0, commands: 0, toolPacks: 0 },
};

function memStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}

function renderDialog(catalog: Parameters<typeof InstallDialog>[0]["catalog"] = {}) {
  const onTextChange = vi.fn();
  render(
    <InstallDialog
      text=""
      previewState={{ data: null, error: null }}
      onTextChange={onTextChange}
      onFile={() => {}}
      onInstall={() => {}}
      onClose={() => {}}
      publishers={new PublisherTrustStore(memStorage())}
      installed={[]}
      catalog={catalog}
    />,
  );
  return { onTextChange };
}

describe("InstallDialog · 云端插件目录", () => {
  it("挂载时不联网；点「从云端浏览」才拉目录", async () => {
    const apiImpl = vi.fn(async () => ({
      plugins: [entry],
      generatedAt: "2026-11-07T12:00:00.000Z",
    }));
    renderDialog({ apiImpl });
    expect(apiImpl).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "云端插件目录" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "从云端浏览插件" }));
    await screen.findByRole("region", { name: "云端插件目录" });
    await waitFor(() => expect(screen.getByText("magpie 网关")).toBeInTheDocument());
    expect(apiImpl).toHaveBeenCalledTimes(1);
  });

  it("载入清单：下载并校验指纹后填进同一个 textarea，面板收起", async () => {
    const bytes = new TextEncoder().encode(manifestText);
    const { onTextChange } = renderDialog({
      apiImpl: async () => ({ plugins: [entry], generatedAt: "2026-11-07T12:00:00.000Z" }),
      fetchImpl: async () =>
        new Response(bytes as unknown as BodyInit, {
          status: 200,
          headers: { "content-type": "application/json", "x-plugin-sha256": "a".repeat(64) },
        }),
      sha256Hex: async () => "a".repeat(64),
    });

    fireEvent.click(screen.getByRole("button", { name: "从云端浏览插件" }));
    await waitFor(() => expect(screen.getByText("magpie 网关")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "载入 magpie 网关" }));

    await waitFor(() => expect(onTextChange).toHaveBeenCalledWith(manifestText));
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "云端插件目录" })).toBeNull(),
    );
  });

  it("目录不可用：面板内报错并给重试，手动粘贴路径不受影响", async () => {
    renderDialog({
      apiImpl: async () => {
        throw new Error("http 502");
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "从云端浏览插件" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("云端插件目录不可用"),
    );
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
    // 清单输入框仍在
    expect(screen.getByLabelText("插件清单 JSON")).toBeInTheDocument();
  });
});
