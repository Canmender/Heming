import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { CapabilityUnit, UnitStatus } from "@heming/shared";
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
    expect(screen.getAllByText("内置模块").length).toBeGreaterThan(0);
    expect(screen.getAllByText("界面插件").length).toBeGreaterThan(0);
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
    expect(screen.getByText("匹配 1 / 共 1 个单元")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "全部来源" }));
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
