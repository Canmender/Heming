import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { ModulesView } from "./ModulesView.js";
import { useModuleStore } from "../../lib/modules/store.js";

/**
 * 插件区 · 模块 Tab（d.70）。
 *
 * 断言用户能看到的东西：三张内置模块卡、开关、依赖说明、停用后的状态与「打开页面」禁用。
 * 不碰导航/首页（那些由 lib/modules/nav 的纯函数用例与 NavRail/HomePage 用例覆盖）。
 */
describe("ModulesView 内置能力模块卡", () => {
  beforeEach(() => {
    useModuleStore.getState().reset();
  });

  it("展示三个模块与版本/贡献/本机数据说明，默认全部启用", () => {
    render(<ModulesView />);
    for (const name of ["幕僚", "信息中枢", "自动化"]) {
      expect(screen.getByRole("region", { name: `模块 ${name}` })).toBeInTheDocument();
    }
    expect(screen.getByRole("switch", { name: "停用模块 信息中枢" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    // 贡献与边界要写清楚：停用不删数据是这套开关对用户的承诺
    const infohub = screen.getByRole("region", { name: "模块 信息中枢" });
    expect(within(infohub).getByText(/导航入口 \+ 页面/)).toBeInTheDocument();
    expect(within(infohub).getAllByText(/infohub_\*/).length).toBeGreaterThan(0);
    expect(within(infohub).getByText(/停用后导航入口/)).toBeInTheDocument();
    // 本机数据：只读展示占用；外部数据（InfoHub 归档）明确「不在和鸣存储内」
    expect(within(infohub).getByText(/不在和鸣存储内/)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("已启用 3/3 个模块");
    const staff = screen.getByRole("region", { name: "模块 幕僚" });
    expect(within(staff).getByText(/个本机键/)).toBeInTheDocument();
  });

  it("停用信息中枢：卡片状态变为已停用、打开页面禁用；自动化显示依赖未启用", () => {
    render(<ModulesView />);
    fireEvent.click(screen.getByRole("switch", { name: "停用模块 信息中枢" }));
    expect(useModuleStore.getState().enabled.infohub).toBe(false);

    const infohub = screen.getByRole("region", { name: "模块 信息中枢" });
    expect(within(infohub).getByRole("switch", { name: "启用模块 信息中枢" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(within(infohub).getByRole("button", { name: "打开页面" })).toBeDisabled();

    // 启用数是「实际生效」而不是「开关打开」：只剩幕僚 1/3
    expect(screen.getByRole("status")).toHaveTextContent("已启用 1/3 个模块");

    // 自动化的开关仍是「开」，但因为依赖不满足而实际不生效
    const automations = screen.getByRole("region", { name: "模块 自动化" });
    expect(within(automations).getByText("依赖未启用")).toBeInTheDocument();
    expect(within(automations).getByRole("button", { name: "打开页面" })).toBeDisabled();
    expect(useModuleStore.getState().enabled.automations).toBe(true);
  });

  it("重新启用依赖后自动化自动生效；「全部恢复启用」把三个都打开", () => {
    render(<ModulesView />);
    fireEvent.click(screen.getByRole("switch", { name: "停用模块 幕僚" }));
    fireEvent.click(screen.getByRole("switch", { name: "停用模块 信息中枢" }));
    expect(screen.getByRole("region", { name: "模块 自动化" })).toHaveTextContent("依赖未启用");

    // 重新打开信息中枢 → 自动化恢复生效，无需再点一次
    fireEvent.click(screen.getByRole("switch", { name: "启用模块 信息中枢" }));
    expect(screen.getByRole("region", { name: "模块 自动化" })).not.toHaveTextContent(
      "依赖未启用",
    );

    fireEvent.click(screen.getByRole("button", { name: "全部恢复启用" }));
    expect(useModuleStore.getState().enabled).toEqual({
      staff: true,
      infohub: true,
      automations: true,
    });
  });

  it("停用幕僚后不再显示「已启用」，且打开页面禁用", () => {
    render(<ModulesView />);
    fireEvent.click(screen.getByRole("switch", { name: "停用模块 幕僚" }));
    const staff = screen.getByRole("region", { name: "模块 幕僚" });
    expect(within(staff).getByRole("switch", { name: "启用模块 幕僚" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(within(staff).getByRole("button", { name: "打开页面" })).toBeDisabled();
  });
});
