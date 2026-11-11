import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { CapabilityUnit, UnitStatus } from "@heming/shared";
import type { PluginHealth } from "../../lib/plugins/index.js";
import { UnitListView } from "./UnitListView.js";
import { UnitDiagnostics } from "./UnitDiagnostics.js";

/**
 * 统一能力单元列表与诊断（d.105）：四类来源可列、来源筛选/搜索可用、阻断原因可读。
 * 这里全部注入 `statuses`，不碰真实 store。
 */

function status(overrides: Partial<UnitStatus> = {}): UnitStatus {
  const unit: CapabilityUnit = {
    source: "package",
    id: "acme.report-kit",
    name: "报告工具箱",
    version: "1.2.0",
    description: "周报与月报",
    enabled: true,
    contributions: [{ kind: "skills", count: 2, enabled: true }],
  };
  return {
    unit,
    effective: true,
    activeKinds: ["skills"],
    diagnostics: [],
    ...overrides,
  };
}

const UNITS: UnitStatus[] = [
  status({
    unit: {
      source: "system",
      id: "heming.core",
      name: "系统能力",
      version: "1.0.0",
      description: "随应用内置",
      enabled: true,
      readonly: true,
      contributions: [
        { kind: "skills", count: 2, enabled: true },
        { kind: "mcpServers", count: 1, enabled: true },
      ],
    },
    activeKinds: ["skills", "mcpServers"],
  }),
  status({
    unit: {
      source: "builtin",
      id: "infohub",
      name: "信息中枢",
      version: "v1.0.0",
      description: "本机归档",
      enabled: true,
      contributions: [{ kind: "page", count: 1, enabled: true }],
    },
    activeKinds: ["page"],
  }),
  status(),
  status({
    unit: {
      source: "bundle",
      id: "heming.pet",
      name: "桌宠",
      version: "1.0.0",
      description: "桌面小组件：桌宠",
      enabled: true,
      contributions: [{ kind: "desktopWidgets", count: 1, enabled: true }],
    },
    activeKinds: ["desktopWidgets"],
  }),
];

describe("UnitListView", () => {
  it("四类来源都列出：来源徽标、版本、状态与贡献摘要", () => {
    render(<UnitListView statuses={UNITS} />);
    expect(screen.getByText("系统能力")).toBeInTheDocument();
    expect(screen.getByText("信息中枢")).toBeInTheDocument();
    expect(screen.getByText("报告工具箱")).toBeInTheDocument();
    expect(screen.getByText("桌宠")).toBeInTheDocument();
    // 来源徽标
    expect(screen.getAllByText("插件").length).toBeGreaterThan(0);
    expect(screen.getAllByText("模块").length).toBeGreaterThan(0);
    expect(screen.getAllByText("插件").length).toBeGreaterThan(0);
    // 贡献摘要与只读标记
    const system = screen.getByRole("region", { name: "能力单元 系统能力" });
    expect(system).toHaveTextContent("技能 2 · 工具服务 1");
    expect(system).toHaveTextContent("只读");
    expect(screen.getByText("共 4 个单元")).toBeInTheDocument();
  });

  it("来源筛选只保留对应来源，计数按当前来源范围变化", () => {
    render(<UnitListView statuses={UNITS} />);
    fireEvent.click(screen.getByRole("button", { name: "插件" }));
    expect(screen.getByRole("region", { name: "能力单元 报告工具箱" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "能力单元 系统能力" })).toBeNull();
    // d.133：内置模块/声明式/插件不再分来源，统一算插件
    expect(screen.getByText("匹配 3 / 共 3 个单元")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "全部插件" }));
    expect(screen.getByText("共 4 个单元")).toBeInTheDocument();
  });

  it("搜索按名称/描述匹配，无结果给清除出口", () => {
    render(<UnitListView statuses={UNITS} />);
    const search = screen.getByLabelText("搜索插件");
    fireEvent.change(search, { target: { value: "桌宠" } });
    expect(screen.getByRole("region", { name: "能力单元 桌宠" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "能力单元 报告工具箱" })).toBeNull();
    expect(screen.getByText("匹配 1 / 共 4 个单元")).toBeInTheDocument();

    fireEvent.change(search, { target: { value: "不存在的单元" } });
    expect(screen.getByRole("region", { name: "筛选无结果" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
    expect(screen.getByRole("region", { name: "能力单元 系统能力" })).toBeInTheDocument();
    expect(search).toHaveValue("");
  });

  it("focusUnit：清空筛选、滚动到目标单元并短暂高亮（d.108 命令 target=unit）", async () => {
    const scrollSpy = vi.fn();
    (Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = scrollSpy;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { rerender } = render(<UnitListView statuses={UNITS} />);
      // 先让筛选把目标藏起来：focusUnit 必须自己清筛选，否则「点了没反应」
      fireEvent.change(screen.getByLabelText("搜索插件"), { target: { value: "报告" } });
      expect(screen.queryByRole("region", { name: "能力单元 桌宠" })).toBeNull();

      rerender(<UnitListView statuses={UNITS} focusUnit={{ id: "heming.pet", seq: 1 }} />);
      await act(async () => {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      });

      const row = document.querySelector<HTMLElement>('[data-unit-id="heming.pet"]')!;
      expect(row).not.toBeNull();
      expect(row.className).toContain("outline-ink");
      expect(scrollSpy).toHaveBeenCalled();
      // 筛选被清空，目标行真实可见（不是只改了 className）
      expect(screen.getByLabelText("搜索插件")).toHaveValue("");
      expect(screen.getByRole("region", { name: "能力单元 桌宠" })).toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(2100);
      });
      expect(row.className).not.toContain("outline-ink");
    } finally {
      vi.useRealTimers();
      delete (Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });
});

describe("UnitDiagnostics", () => {
  it("逐条展示阻断原因：停用 / 依赖未生效 / engines 不兼容", () => {
    const units: UnitStatus[] = [
      status({
        unit: {
          source: "builtin",
          id: "staff",
          name: "幕僚",
          version: "v1.0.0",
          description: "",
          enabled: false,
          contributions: [{ kind: "page", count: 1, enabled: false }],
        },
        effective: false,
        activeKinds: [],
        reason: { kind: "disabled" },
        diagnostics: [{ kind: "disabled" }],
      }),
      status({
        unit: {
          source: "builtin",
          id: "automations",
          name: "自动化",
          version: "v1.0.0",
          description: "",
          enabled: true,
          requires: ["infohub"],
          contributions: [{ kind: "page", count: 1, enabled: true }],
        },
        effective: false,
        activeKinds: [],
        reason: { kind: "missingRequirement", unitId: "infohub" },
        diagnostics: [{ kind: "missingRequirement", unitId: "infohub" }],
      }),
      status({
        effective: false,
        activeKinds: [],
        reason: { kind: "incompatible", required: "d.106", actual: "d.105" },
        diagnostics: [{ kind: "incompatible", required: "d.106", actual: "d.105" }],
      }),
    ];
    render(<UnitDiagnostics statuses={units} />);
    const panel = screen.getByRole("region", { name: "能力单元诊断" });
    expect(within(panel).getByText("已停用")).toBeInTheDocument();
    expect(within(panel).getByText("需要「infohub」启用后才生效")).toBeInTheDocument();
    expect(
      within(panel).getByText("需要和鸣 d.106 或更高，当前 d.105"),
    ).toBeInTheDocument();
    expect(within(panel).getAllByRole("listitem")).toHaveLength(3);
  });
});

/* ───────────────────── 健康度与修复入口（d.113） ───────────────────── */

const degradedHealth: PluginHealth = {
  pluginId: "acme.report-kit",
  level: "degraded",
  issues: [
    {
      code: "fingerprint-mismatch",
      severity: "degraded",
      message: "记录里的内容指纹与清单不一致（清单可能被手工修改）",
    },
  ],
  danglingSkills: 0,
  danglingServers: 0,
};

const brokenHealth: PluginHealth = {
  pluginId: "acme.report-kit",
  level: "broken",
  issues: [
    {
      code: "invalid-record",
      severity: "broken",
      message: "安装记录损坏：v5 清单记录损坏：engines 必填",
    },
    {
      code: "dangling-skill",
      severity: "degraded",
      message: "技能引用悬空：skill-gone 已不在技能池",
      target: "skill-gone",
    },
  ],
  danglingSkills: 1,
  danglingServers: 0,
};

describe("UnitListView · 健康徽标与修复记录（d.113）", () => {
  it("按单元显示健康徽标（降级/损坏可扫读，正常也带徽标）", () => {
    render(
      <UnitListView
        statuses={UNITS}
        healthByUnitId={{
          "acme.report-kit": degradedHealth,
          "heming.core": {
            pluginId: "heming.core",
            level: "ok",
            issues: [],
            danglingSkills: 0,
            danglingServers: 0,
          },
        }}
      />,
    );
    expect(screen.getByLabelText("健康度 降级")).toBeInTheDocument();
    expect(screen.getByLabelText("健康度 正常")).toBeInTheDocument();
    // 悬停提示带 issue 明细
    expect(screen.getByLabelText("健康度 降级").getAttribute("title")).toContain(
      "内容指纹与清单不一致",
    );
  });

  it("broken 单元显示「修复记录」按钮，点击回调插件 id", () => {
    const onRepair = vi.fn();
    render(
      <UnitListView
        statuses={UNITS}
        healthByUnitId={{ "acme.report-kit": brokenHealth }}
        onRepair={onRepair}
      />,
    );
    expect(screen.getByLabelText("健康度 损坏")).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "修复记录 报告工具箱" });
    fireEvent.click(button);
    expect(onRepair).toHaveBeenCalledWith("acme.report-kit");
  });

  it("degraded 单元不显示修复按钮（只有 broken 需要修记录）", () => {
    render(
      <UnitListView statuses={UNITS} healthByUnitId={{ "acme.report-kit": degradedHealth }} onRepair={vi.fn()} />,
    );
    expect(screen.queryByRole("button", { name: /修复记录/ })).toBeNull();
  });

  it("修复中：按钮禁用并显示「修复中…」", () => {
    render(
      <UnitListView
        statuses={UNITS}
        healthByUnitId={{ "acme.report-kit": brokenHealth }}
        onRepair={vi.fn()}
        repairingPluginId="acme.report-kit"
      />,
    );
    const button = screen.getByRole("button", { name: "修复记录 报告工具箱" });
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent("修复中…");
  });
});

describe("UnitDiagnostics · 健康问题明细（d.113）", () => {
  it("逐条列出健康 issue，broken 单元带修复入口", () => {
    const onRepair = vi.fn();
    render(
      <UnitDiagnostics
        statuses={UNITS}
        healthByUnitId={{ "acme.report-kit": brokenHealth }}
        onRepair={onRepair}
      />,
    );
    const panel = screen.getByRole("region", { name: "能力单元诊断" });
    expect(within(panel).getByText(/健康度损坏：安装记录损坏/)).toBeInTheDocument();
    expect(within(panel).getByText(/技能引用悬空：skill-gone/)).toBeInTheDocument();
    const button = within(panel).getByRole("button", { name: "修复记录 报告工具箱（诊断）" });
    fireEvent.click(button);
    expect(onRepair).toHaveBeenCalledWith("acme.report-kit");
  });

  it("没有问题时仍给「全部正常」文案", () => {
    render(<UnitDiagnostics statuses={UNITS} />);
    expect(screen.getByText(/没有发现问题/)).toBeInTheDocument();
  });
});
