import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { BUILTIN_MODULES } from "../modules/registry.js";
import { defaultModuleState, useModuleStore } from "../modules/store.js";
import {
  __resetUnitsForTest,
  buildUnitStatuses,
  disposeUnit,
  mountContribution,
  mountedContributionCount,
  refreshUnits,
  unitMountDiagnostics,
  unitMountFailures,
  useUnitStatuses,
} from "./registry.js";

/**
 * 能力单元注册表（d.105）：撤销顺序/幂等/失败不阻断/异步串行 + 读投影订阅。
 * 全部用内存态，不依赖 React 组件与真实 store 数据。
 */

afterEach(() => {
  __resetUnitsForTest();
  useModuleStore.setState(defaultModuleState());
});

describe("mountContribution / disposeUnit", () => {
  it("按后注册先撤销的顺序执行，并返回撤销数量", async () => {
    const order: string[] = [];
    mountContribution("page", "unit.a", () => () => void order.push("first"));
    mountContribution("homeCard", "unit.a", () => () => void order.push("second"));
    mountContribution("backgroundJob", "unit.a", () => () => void order.push("third"));

    const result = await disposeUnit("unit.a");
    expect(result).toEqual({ disposed: 3, failures: [] });
    expect(order).toEqual(["third", "second", "first"]);
    expect(mountedContributionCount("unit.a")).toBe(0);
  });

  it("重复撤销幂等：第二次返回 0 且不再调用撤销函数", async () => {
    let calls = 0;
    mountContribution("page", "unit.b", () => () => {
      calls += 1;
    });
    expect(await disposeUnit("unit.b")).toEqual({ disposed: 1, failures: [] });
    expect(await disposeUnit("unit.b")).toEqual({ disposed: 0, failures: [] });
    expect(calls).toBe(1);
  });

  it("单个撤销抛错不阻断其余，失败进诊断", async () => {
    const order: string[] = [];
    mountContribution("page", "unit.c", () => () => void order.push("a"));
    mountContribution("homeCard", "unit.c", () => () => {
      order.push("b");
      throw new Error("provider 已释放");
    });
    mountContribution("backgroundJob", "unit.c", () => () => void order.push("c"));

    const result = await disposeUnit("unit.c");
    expect(result.disposed).toBe(2);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("撤销「首页卡片」失败");
    expect(order).toEqual(["c", "b", "a"]);
    expect(unitMountFailures("unit.c")[0]).toContain("provider 已释放");
    expect(unitMountDiagnostics("unit.c")).toEqual([
      { kind: "degraded", detail: expect.stringContaining("provider 已释放") },
    ]);
  });

  it("异步撤销串行 await：前一个结束后才开始下一个", async () => {
    const events: string[] = [];
    mountContribution("page", "unit.d", () => async () => {
      events.push("a:start");
      await Promise.resolve();
      events.push("a:end");
    });
    mountContribution("homeCard", "unit.d", () => async () => {
      events.push("b:start");
      await Promise.resolve();
      events.push("b:end");
    });

    await disposeUnit("unit.d");
    expect(events).toEqual(["b:start", "b:end", "a:start", "a:end"]);
  });

  it("mount 自身抛错：不抛出、不计数，失败进诊断", () => {
    const dispose = mountContribution("page", "unit.e", () => {
      throw new Error("渲染器不可用");
    });
    expect(typeof dispose).toBe("function");
    expect(mountedContributionCount("unit.e")).toBe(0);
    expect(unitMountFailures("unit.e")[0]).toContain("挂载「页面」失败");
    expect(unitMountFailures("unit.e")[0]).toContain("渲染器不可用");
  });

  it("mount 返回非函数：按挂载失败处理（不做静默放行）", () => {
    mountContribution("page", "unit.f", (() => undefined) as unknown as () => () => void);
    expect(unitMountFailures("unit.f")[0]).toContain("必须返回撤销函数");
  });

  it("返回的撤销句柄只撤销自己那一条，重复调用不重复撤销", async () => {
    const calls: string[] = [];
    const dispose = mountContribution("page", "unit.g", () => () => void calls.push("only"));
    expect(mountedContributionCount("unit.g")).toBe(1);
    dispose();
    dispose();
    await Promise.resolve();
    expect(calls).toEqual(["only"]);
    expect(mountedContributionCount("unit.g")).toBe(0);
  });

  it("不同单元的撤销互不影响", async () => {
    mountContribution("page", "unit.h", () => () => {});
    mountContribution("page", "unit.i", () => () => {});
    await disposeUnit("unit.h");
    expect(mountedContributionCount("unit.h")).toBe(0);
    expect(mountedContributionCount("unit.i")).toBe(1);
  });
});

describe("读投影（registry 薄层）", () => {
  it("buildUnitStatuses 用注入数据源计算，自动化不依赖信息中枢", () => {
    const statuses = buildUnitStatuses({
      modules: BUILTIN_MODULES,
      moduleEnabled: { staff: true, infohub: false, automations: true },
    });
    const byId = new Map(statuses.map((status) => [status.unit.id, status] as const));
    expect(statuses).toHaveLength(BUILTIN_MODULES.length);
    expect(byId.get("infohub")!.reason).toEqual({ kind: "disabled" });
    expect(byId.get("automations")!.effective).toBe(true);
    expect(byId.get("staff")!.effective).toBe(true);
  });

  it("useUnitStatuses 只列已安装模块，并订阅模块安装/开关变化", () => {
    refreshUnits();
    const { result } = renderHook(() => useUnitStatuses());
    const ids = result.current.map((status) => status.unit.id);
    expect(ids).toContain("heming.core");
    // 原生应用不显示未安装模块：默认一个都不在投影里
    for (const mod of BUILTIN_MODULES) expect(ids).not.toContain(mod.id);
    expect(result.current.every((status) => status.unit.source !== "bundle")).toBe(true);

    act(() => {
      useModuleStore.setState({
        installed: { staff: true, infohub: true, automations: true, workflows: true },
        enabled: { staff: false, infohub: true, automations: true, workflows: true },
      });
    });
    const installedIds = result.current.map((status) => status.unit.id);
    for (const mod of BUILTIN_MODULES) expect(installedIds).toContain(mod.id);
    const staff = result.current.find((status) => status.unit.id === "staff");
    expect(staff!.effective).toBe(false);
    expect(staff!.reason).toEqual({ kind: "disabled" });

    act(() => {
      useModuleStore.setState({
        installed: { staff: true, infohub: false, automations: true, workflows: true },
        enabled: { staff: false, infohub: false, automations: true, workflows: true },
      });
    });
    const infohub = result.current.find((status) => status.unit.id === "infohub");
    // 未安装的模块不再投影（原生应用不显示「内置模块」卡片）
    expect(infohub).toBeUndefined();
  });
});
