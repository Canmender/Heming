import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import type { ModuleState } from "./store.js";
import { MODULE_IDS } from "./registry.js";

const useWorkflowScheduler = vi.fn();

vi.mock("../workflow/scheduler.js", () => ({ useWorkflowScheduler: (...a: unknown[]) => useWorkflowScheduler(...a) }));
// 模块包加载 hook 在 jsdom 下不可用：显式返回 null entry，走内置回退路径
const useWebModuleEntry = vi.fn(() => ({ entry: null, loading: false, error: "" }));
vi.mock("./useWebModule.js", () => ({
  useWebModuleEntry: (...a: unknown[]) => useWebModuleEntry(...(a as [])),
}));

const { MODULE_PAGES, ModuleBackgroundSlots, modulePageOf, useModuleBackgroundLoops } = await import("./runtime.js");

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
    useWorkflowScheduler.mockClear();
  });

  it("除已迁出模块外，每个内置模块仍有页面回退；id 与 registry 一致", () => {
    // staff 已迁到模块包（d.131 M2），其余三个仍是内置回退。
    expect(Object.keys(MODULE_PAGES).sort()).toEqual(
      MODULE_IDS.filter((id) => id === "workflows").sort(),
    );
    for (const id of Object.keys(MODULE_PAGES)) expect(MODULE_PAGES[id as keyof typeof MODULE_PAGES]).toBeTruthy();
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
    expect(useWorkflowScheduler).toHaveBeenLastCalledWith(true);
    // d.131 M2：幕僚循环已随模块包迁出，宿主 hook 不再直接挂（只由模块后台导出提供）。

    const staffOff = state({ enabled: { staff: false, infohub: true, automations: false, workflows: true } } as Partial<ModuleState>);
    render(<Host authUser={false} moduleState={staffOff} />);
    expect(useWorkflowScheduler).toHaveBeenLastCalledWith(false);

    // 模块包未加载（mock entry=null）→ 槽位不渲染任何循环，也不崩
    render(<ModuleBackgroundSlots authUser moduleState={allOn} />);
    render(<ModuleBackgroundSlots authUser={false} moduleState={staffOff} />);
  });
});
