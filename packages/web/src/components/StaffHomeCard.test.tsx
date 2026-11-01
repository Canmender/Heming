import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { StaffHomeCard } from "./StaffHomeCard.js";
import { useStaffStore } from "../lib/staff/store.js";
import {
  DEFAULT_STAFF_SETTINGS,
  normalizeSeen,
  type StaffRun,
  type StaffSettings,
} from "../lib/staff/model.js";
import { useUiStore } from "../store/ui.js";

/**
 * 首页幕僚卡（d.48）三态：未开启 / 已开启无简报 / 有简报。
 * 卡片只做露出与入口，不生成简报、不改设置。
 */

function reset(overrides: Partial<StaffSettings> = {}): void {
  useStaffStore.setState({
    settings: {
      ...DEFAULT_STAFF_SETTINGS,
      sources: { ...DEFAULT_STAFF_SETTINGS.sources },
      ...overrides,
    },
    runs: [],
    seen: normalizeSeen(null),
  });
  useUiStore.setState({ page: "home" });
}

function sampleRun(count: number): StaffRun {
  return {
    id: "staff-card",
    trigger: "daily",
    mode: "llm",
    startedAt: Date.now() - 120_000,
    finishedAt: Date.now() - 119_000,
    summary: "今天有 2 条日程临期、1 个任务需要留意。",
    tokens: 1200,
    findings: Array.from({ length: count }, (_, i) => ({
      id: `f-${i}`,
      severity: i === 0 ? ("urgent" as const) : ("warn" as const),
      title: `事项 ${i + 1}`,
      detail: "",
      evidence: [{ label: "日程", kind: "agenda" as const, refId: `agenda:${i}` }],
    })),
  };
}

describe("StaffHomeCard", () => {
  beforeEach(() => {
    localStorage.clear();
    reset();
  });

  it("未开启：定位说明 + 跳转幕僚页", () => {
    render(<StaffHomeCard />);
    expect(screen.getByText("未开启")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "开启幕僚" }));
    expect(useUiStore.getState().page).toBe("staff");
  });

  it("已开启无简报：显示下次检查", () => {
    reset({ enabled: true });
    render(<StaffHomeCard />);
    expect(screen.getByText(/还没有简报/)).toBeInTheDocument();
    expect(screen.getByText(/常驻/)).toBeInTheDocument();
  });

  it("有简报：摘要 + 最多 3 条 finding + 查看全部", () => {
    reset({ enabled: true });
    useStaffStore.setState({ runs: [sampleRun(5)] });
    render(<StaffHomeCard />);

    expect(screen.getByText("今天有 2 条日程临期、1 个任务需要留意。")).toBeInTheDocument();
    expect(screen.getByText("事项 1")).toBeInTheDocument();
    expect(screen.getByText("事项 3")).toBeInTheDocument();
    expect(screen.queryByText("事项 4")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "查看全部" }));
    expect(useUiStore.getState().page).toBe("staff");
  });
});
