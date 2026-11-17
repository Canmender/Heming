import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_PENDING_PLUGIN_NOTICES,
  PLUGIN_NOTICE_KEY,
  peekPluginInstallNotices,
  recordPluginInstall,
  resetPluginInstallNotices,
  takePluginInstallNotices,
  type PluginInstallNotice,
} from "./installedNotice.js";

/** 造一条合法告知；测试里只需要改 id/版本这类少数字段。 */
function notice(overrides: Partial<PluginInstallNotice> = {}): PluginInstallNotice {
  return {
    pluginId: "com.example.charts",
    name: "图表增强",
    version: "1.0.0",
    at: 1_700_000_000_000,
    updated: false,
    servers: ["plugin:com.example.charts:charts"],
    skills: ["画图"],
    ...overrides,
  };
}

beforeEach(() => {
  globalThis.localStorage?.clear();
  resetPluginInstallNotices();
});

describe("刚装插件的告知（d.241）", () => {
  it("记一条就能读到，字段原样保留", () => {
    recordPluginInstall(notice());
    const rows = peekPluginInstallNotices();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      pluginId: "com.example.charts",
      name: "图表增强",
      version: "1.0.0",
      updated: false,
      servers: ["plugin:com.example.charts:charts"],
      skills: ["画图"],
    });
  });

  it("同一个插件记两次只留最新一次（升级覆盖首装，提示词里不说两遍）", () => {
    recordPluginInstall(notice({ version: "1.0.0", updated: false }));
    recordPluginInstall(notice({ version: "1.1.0", updated: true, at: 1_700_000_100_000 }));
    const rows = peekPluginInstallNotices();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.version).toBe("1.1.0");
    expect(rows[0]?.updated).toBe(true);
  });

  it("最多挂 10 条，超出时丢最早的", () => {
    for (let i = 0; i < MAX_PENDING_PLUGIN_NOTICES + 2; i += 1) {
      recordPluginInstall(notice({ pluginId: `p-${i}`, name: `插件 ${i}`, at: 1_700_000_000_000 + i }));
    }
    const rows = peekPluginInstallNotices();
    expect(rows).toHaveLength(MAX_PENDING_PLUGIN_NOTICES);
    expect(rows[0]?.pluginId).toBe("p-2");
    expect(rows.at(-1)?.pluginId).toBe(`p-${MAX_PENDING_PLUGIN_NOTICES + 1}`);
  });

  it("peek 不消费：连看两次都还在", () => {
    recordPluginInstall(notice());
    expect(peekPluginInstallNotices()).toHaveLength(1);
    expect(peekPluginInstallNotices()).toHaveLength(1);
  });

  it("take 读走并清空，落盘键一起删掉", () => {
    recordPluginInstall(notice());
    const taken = takePluginInstallNotices();
    expect(taken).toHaveLength(1);
    expect(peekPluginInstallNotices()).toHaveLength(0);
    expect(globalThis.localStorage?.getItem(PLUGIN_NOTICE_KEY)).toBeNull();
  });

  it("字段不合法的一条不记（不能把半条 JSON 带进提示词）", () => {
    // 少了 version/servers 之类，运行期可能从旧版本残留过来：直接丢。
    recordPluginInstall({ pluginId: "bad", name: "坏插件" } as unknown as PluginInstallNotice);
    expect(peekPluginInstallNotices()).toHaveLength(0);
  });

  it("存储里是坏数据时当作没有（不抛、不崩安装流程）", async () => {
    globalThis.localStorage?.setItem(PLUGIN_NOTICE_KEY, "{ not json");
    vi.resetModules();
    const broken = await import("./installedNotice.js");
    expect(broken.peekPluginInstallNotices()).toEqual([]);

    globalThis.localStorage?.setItem(PLUGIN_NOTICE_KEY, JSON.stringify([{ pluginId: "x" }, notice()]));
    vi.resetModules();
    const mixed = await import("./installedNotice.js");
    // 数组里只有一条合法：坏的那条被过滤，好的留下。
    expect(mixed.peekPluginInstallNotices()).toHaveLength(1);
  });

  it("localStorage 抛异常时不影响内存里的告知", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    try {
      recordPluginInstall(notice());
      expect(peekPluginInstallNotices()).toHaveLength(1);
    } finally {
      setItem.mockRestore();
    }
  });
});
