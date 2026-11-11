import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { useModuleStore } from "./store.js";
import type { WebModuleEntry } from "./webModules.js";

/**
 * 模块宿主接缝（d.131 M2–M5）：页面/首页卡/后台循环全部来自模块包，
 * 模块包缺失或抛错时只显示失败原因/不渲染，绝不回退到本体实现。
 */

const useWebModuleEntry = vi.fn((_id: string) => ({
  entry: null as WebModuleEntry | null,
  loading: false,
  error: "模块包未安装",
}));
vi.mock("./useWebModule.js", () => ({
  useWebModuleEntry: (...args: unknown[]) => useWebModuleEntry(...(args as [string])),
}));

const { ModuleBackgroundSlots, ModuleHomeCard, ModulePage, modulePageOf } = await import(
  "./runtime.js"
);

beforeEach(() => {
  useWebModuleEntry.mockClear();
  useWebModuleEntry.mockReturnValue({ entry: null, loading: false, error: "模块包未安装" });
});

describe("modulePageOf", () => {
  it("四个模块页 id 都认（实现已全部迁出，不能再依赖内置页面表）", () => {
    for (const id of ["staff", "infohub", "automations", "workflows"]) {
      expect(modulePageOf(id)).toBe(id);
    }
  });

  it("非模块页返回 null", () => {
    expect(modulePageOf("home")).toBeNull();
    expect(modulePageOf("chat")).toBeNull();
    expect(modulePageOf("settings")).toBeNull();
  });
});

describe("ModulePage", () => {
  it("模块包缺失：显示未就绪原因，不渲染空壳", () => {
    render(<ModulePage moduleId="staff" />);
    expect(screen.getByText("模块「staff」未就绪")).toBeInTheDocument();
    expect(screen.getByText("模块包未安装")).toBeInTheDocument();
  });

  it("模块包提供页面：渲染模块页面", () => {
    useWebModuleEntry.mockReturnValue({
      entry: {
        manifest: { id: "workflows", version: "1.0.0" },
        pages: { workflows: () => <div>工作流模块页</div> },
      },
      loading: false,
      error: "",
    });
    render(<ModulePage moduleId="workflows" />);
    expect(screen.getByText("工作流模块页")).toBeInTheDocument();
  });

  it("模块页面抛错：错误边界兜底，不打白整棵 App", () => {
    useWebModuleEntry.mockReturnValue({
      entry: {
        manifest: { id: "workflows", version: "1.0.0" },
        pages: {
          workflows: () => {
            throw new Error("module boom");
          },
        },
      },
      loading: false,
      error: "",
    });
    render(<ModulePage moduleId="workflows" />);
    expect(screen.getByText("模块「workflows」未就绪")).toBeInTheDocument();
  });
});

describe("ModuleHomeCard", () => {
  it("模块未生效 → 不渲染（即使模块包有卡）", () => {
    useWebModuleEntry.mockReturnValue({
      entry: {
        manifest: { id: "staff", version: "1.0.0" },
        pages: { staff: () => null },
        homeCards: { staff: () => <div>幕僚卡</div> },
      },
      loading: false,
      error: "",
    });
    render(<ModuleHomeCard moduleId="staff" active={false} />);
    expect(screen.queryByText("幕僚卡")).toBeNull();
  });

  it("模块生效且加载成功 → 渲染模块卡", () => {
    useWebModuleEntry.mockReturnValue({
      entry: {
        manifest: { id: "staff", version: "1.0.0" },
        pages: { staff: () => null },
        homeCards: { staff: () => <div>幕僚卡</div> },
      },
      loading: false,
      error: "",
    });
    render(<ModuleHomeCard moduleId="staff" active />);
    expect(screen.getByText("幕僚卡")).toBeInTheDocument();
  });
});

describe("ModuleBackgroundSlots", () => {
  it("按模块生效状态挂载模块后台组件（不再由宿主直接调用 hook）", () => {
    const calls: boolean[] = [];
    useWebModuleEntry.mockImplementation((id: string) => ({
      entry: {
        manifest: { id, version: "1.0.0" },
        pages: { [id]: () => null },
        background: {
          [id]: ({ active }: { active: boolean }) => {
            calls.push(active);
            return <div data-testid={`bg-${id}`} />;
          },
        },
      },
      loading: false,
      error: "",
    }));
    for (const id of ["staff", "automations", "workflows"] as const) {
      useModuleStore.getState().install(id);
    }
    render(
      <ModuleBackgroundSlots authUser moduleState={useModuleStore.getState()} />,
    );
    expect(screen.getByTestId("bg-staff")).toBeInTheDocument();
    expect(screen.getByTestId("bg-automations")).toBeInTheDocument();
    expect(screen.getByTestId("bg-workflows")).toBeInTheDocument();
    expect(calls).toEqual([true, true, true]);
  });
});
