import { describe, expect, it, vi } from "vitest";
import { createWidgetApi, type WidgetBridge } from "./widgetBridge.js";

/**
 * 数据目录桥（`dataGet/dataSet/dataDelete/dataKeys/dataDir`）。
 *
 * 两件事必须成立：
 * 1. 旧宿主 preload 没有这些方法时**不白屏**（返回 null/false/[]，不抛）；
 * 2. 数据值里的 `false` / `0` / `""` 不能被兜底逻辑吞掉（它们都是合法 JSON 值）。
 */
describe("数据目录桥（data API）", () => {
  it("没有宿主桥：全部降级，不抛错", async () => {
    const api = createWidgetApi(null);
    expect(api.available).toBe(false);
    await expect(api.dataGet("k")).resolves.toBeNull();
    await expect(api.dataSet("k", 1)).resolves.toBeNull();
    await expect(api.dataDelete("k")).resolves.toBe(false);
    await expect(api.dataKeys()).resolves.toEqual([]);
    await expect(api.dataDir()).resolves.toBeNull();
  });

  it("旧宿主缺少 data* 方法：能力探测降级，不影响其他方法", async () => {
    const raw = { settings: async () => ({ bubble: true }) } as unknown as Partial<WidgetBridge>;
    const api = createWidgetApi(raw);
    await expect(api.dataGet("k")).resolves.toBeNull();
    await expect(api.dataKeys()).resolves.toEqual([]);
    await expect(api.settings()).resolves.toEqual({ bubble: true });
  });

  it("正常宿主：透传参数与结果", async () => {
    const dataGet = vi.fn(async () => ({ hits: 2 }));
    const dataSet = vi.fn(async (key: string, _value: unknown) => ({ key, bytes: 12 }));
    const dataDelete = vi.fn(async () => true);
    const dataKeys = vi.fn(async () => ["a", "b"]);
    const dataDir = vi.fn(async () => ({ dir: "C:/userData/plugins/heming.pet/data" }));
    const api = createWidgetApi({
      dataGet,
      dataSet,
      dataDelete,
      dataKeys,
      dataDir,
    } as unknown as Partial<WidgetBridge>);

    await expect(api.dataGet<{ hits: number }>("cache")).resolves.toEqual({ hits: 2 });
    expect(dataGet).toHaveBeenCalledWith("cache");
    await expect(api.dataSet("cache", { hits: 3 })).resolves.toEqual({ key: "cache", bytes: 12 });
    expect(dataSet).toHaveBeenCalledWith("cache", { hits: 3 });
    await expect(api.dataDelete("cache")).resolves.toBe(true);
    expect(dataDelete).toHaveBeenCalledWith("cache");
    await expect(api.dataKeys()).resolves.toEqual(["a", "b"]);
    await expect(api.dataDir()).resolves.toEqual({ dir: "C:/userData/plugins/heming.pet/data" });
  });

  it("合法假值（false/0/空串/null）原样返回，不被兜底吞掉", async () => {
    for (const value of [false, 0, "", null]) {
      const api = createWidgetApi({ dataGet: async () => value } as unknown as Partial<WidgetBridge>);
      await expect(api.dataGet("k")).resolves.toBe(value);
    }
  });

  it("宿主抛错：读回 null、删除 false、列表空，不把异常漏给组件", async () => {
    const boom = async () => {
      throw new Error("disk full");
    };
    const api = createWidgetApi({
      dataGet: boom,
      dataSet: boom,
      dataDelete: boom,
      dataKeys: boom,
      dataDir: boom,
    } as unknown as Partial<WidgetBridge>);
    await expect(api.dataGet("k")).resolves.toBeNull();
    await expect(api.dataSet("k", 1)).resolves.toBeNull();
    await expect(api.dataDelete("k")).resolves.toBe(false);
    await expect(api.dataKeys()).resolves.toEqual([]);
    await expect(api.dataDir()).resolves.toBeNull();
  });

  it("畸形回执收敛：keys 只留字符串、dir 必须是 {dir:string}", async () => {
    const api = createWidgetApi({
      dataKeys: async () => ["a", 1, null] as unknown as string[],
      dataDir: async () => ({ dir: "" }) as unknown as { dir: string },
    } as unknown as Partial<WidgetBridge>);
    await expect(api.dataKeys()).resolves.toEqual(["a"]);
    await expect(api.dataDir()).resolves.toBeNull();
  });
});
