import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { PluginDetailDialog } from "./PluginDetailDialog.js";
import { parsePluginManifest, type InstalledPlugin } from "../../lib/plugins/index.js";

/**
 * 插件详情里新增的两类贡献（d.125）：
 * - 首页卡片：清单 `contributions.homeCards`（数据，运行时由插件回填文案）；
 * - 后台运行：清单 `contributions.background.entry`（宿主建隐藏窗口跑该页）。
 * 两者都跟着插件主开关走，所以行尾文案要说清「已生效 / 运行中」还是「主开关已关闭」。
 */

function plugin(contributions: Record<string, unknown>, enabled = true): InstalledPlugin {
  return {
    manifest: parsePluginManifest({
      schemaVersion: 4,
      id: "heming.info-hub",
      name: "信息中枢",
      version: "1.0.0",
      description: "本机聊天记录与日程",
      distribution: "bundle",
      permissions: { network: [], tools: "none" },
      contributions,
    }),
    enabled,
    skillIds: [],
    serverIds: [],
    fingerprint: "fnv1a64b:0000000000000000",
    publisher: null,
    signature: null,
    disabledKinds: [],
    installedAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
  };
}

const noop = () => {};

function renderDetail(subject: InstalledPlugin) {
  return render(
    <PluginDetailDialog
      plugin={subject}
      skills={[]}
      servers={[]}
      toolPacks={[]}
      mcp={{ setToolEnabled: vi.fn() }}
      serverNameOf={() => ""}
      hostOf={(url) => url}
      onRemove={noop}
      onGoSkills={noop}
      onGoInterfaces={noop}
      onKindToggle={noop}
      onClose={noop}
    />,
  );
}

const archiveCard = {
  id: "archive",
  title: "信息中枢",
  summary: "本机 QQ / 微信聊天记录与日程",
  icon: "grid",
  page: "plugin:heming.info-hub",
  primary: "还没有归档数据",
};

describe("插件详情 · 首页卡片与后台运行", () => {
  it("声明了就多两行：首页卡片（列出标题）与后台运行（列出入口）", () => {
    renderDetail(plugin({ homeCards: [archiveCard], background: { entry: "background.html" } }));
    expect(screen.getByText("首页卡片")).toBeInTheDocument();
    // 插件名也叫「信息中枢」，标题出现两次（页头 + 卡片标题）是预期的。
    expect(screen.getAllByText("信息中枢").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("后台运行")).toBeInTheDocument();
    expect(screen.getByText("background.html")).toBeInTheDocument();
    // 贡献摘要也要带上卡片数，否则摘要与明细对不上。
    expect(screen.getByText(/首页卡片 1/)).toBeInTheDocument();
  });

  it("主开关关闭时两行都写明「主开关已关闭」（不给假运行态）", () => {
    renderDetail(
      plugin({ homeCards: [archiveCard], background: { entry: "background.html" } }, false),
    );
    expect(screen.getAllByText("主开关已关闭").length).toBeGreaterThanOrEqual(2);
  });

  it("没声明就不出现这两行（不给空区块）", () => {
    // bundle 插件只允许贡献 commands/desktopWidgets/homeCards/background，且至少要有一项能力
    // （空贡献清单会在解析阶段被拒）；这里给一条命令，验证没声明这两类时详情不渲染空区块。
    renderDetail(plugin({ commands: [{ id: "open", title: "打开", target: { kind: "plugin" } }] }));
    expect(screen.queryByText("首页卡片")).toBeNull();
    expect(screen.queryByText("后台运行")).toBeNull();
  });
});
