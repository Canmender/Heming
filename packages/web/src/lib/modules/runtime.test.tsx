import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import type { ModuleState } from "./store.js";
import { MODULE_IDS } from "./registry.js";

const useAutomationScheduler = vi.fn();
const useWorkflowScheduler = vi.fn();
const useStaffLoop = vi.fn();

vi.mock("../automation/scheduler.js", () => ({ useAutomationScheduler: (...a: unknown[]) => useAutomationScheduler(...a) }));
vi.mock("../workflow/scheduler.js", () => ({ useWorkflowScheduler: (...a: unknown[]) => useWorkflowScheduler(...a) }));
vi.mock("../staff/loop.js", () => ({ useStaffLoop: (...a: unknown[]) => useStaffLoop(...a) }));

const { MODULE_PAGES, modulePageOf, useModuleBackgroundLoops } = await import("./runtime.js");

function state(partial: Partial<Record<keyof ModuleState, unknown>> = {}): ModuleState {
  return {
    installed: { staff: true, infohub: true, automations: true, workflows: true },
    enabled: { staff: true, infohub: true, automations: true, workflows: true },
    ...partial,
  } as ModuleState;
}

function Host({ authUser, moduleState }: { authUser: boolean; moduleState: ModuleState }) {
  useModuleBackgroundLoops(authUser, moduleState);
  return null;
}

describe("模块运行时注册表（App 与模块实现之间的唯一接缝）", () => {
  beforeEach(() => {
    useAutomationScheduler.mockClear();
    useWorkflowScheduler.mockClear();
    useStaffLoop.mockClear();
  });

  it("每个内置模块都有页面实现，且 id 与 registry 一致", () => {
    expect(Object.keys(MODULE_PAGES).sort()).toEqual([...MODULE_IDS].sort());
    for (const id of MODULE_IDS) expect(MODULE_PAGES[id]).toBeTruthy();
  });

  it("modulePageOf：模块页返回 id，其它页面返回 null", () => {
    expect(modulePageOf("staff")).toBe("staff");
    expect(modulePageOf("infohub")).toBe("infohub");
    expect(modulePageOf("automations")).toBe("automations");
    expect(modulePageOf("workflows")).toBe("workflows");
    expect(modulePageOf("chat")).toBeNull();
    expect(modulePageOf("plugin:acme.ops")).toBeNull();
  });

  it("后台循环按登录态与模块生效状态挂载（停用/未登录 → false）", () => {
    const allOn = state();
    render(<Host authUser moduleState={allOn} />);
    expect(useAutomationScheduler).toHaveBeenLastCalledWith(true);
    expect(useWorkflowScheduler).toHaveBeenLastCalledWith(true);
    expect(useStaffLoop).toHaveBeenLastCalledWith(true);

    const staffOff = state({ enabled: { staff: false, infohub: true, automations: false, workflows: true } } as Partial<ModuleState>);
    render(<Host authUser={false} moduleState={staffOff} />);
    expect(useAutomationScheduler).toHaveBeenLastCalledWith(false);
    expect(useWorkflowScheduler).toHaveBeenLastCalledWith(false);
    expect(useStaffLoop).toHaveBeenLastCalledWith(false);
  });
});
