import { describe, it, expect } from "vitest";
import { McpRegistry, MCP_REMOVED_PRESETS_KEY, MCP_SERVERS_KEY } from "./store.js";
import { DEFAULT_PRESET_SERVERS } from "./presets.js";

/**
 * 「恢复预置服务」的行为用例（d.77）。
 *
 * 背景：`remove()` 删预置会写 removedPresets，`seedDefaults()` 之后永不再补——
 * 初衷是「用户能真正删掉」，但界面上没有回退路径。`restorePresets()` 补上这条路，
 * 语义是**可逆的删除**：清记录 + 补缺失 + 不覆盖用户已有配置。
 */

/** 内存存储，可预置初始内容以模拟「已经配过」。 */
function memStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    raw: map,
  };
}

const FIXED_NOW = () => "2026-11-07T00:00:00.000Z";
const PRESET_IDS = DEFAULT_PRESET_SERVERS.map((p) =>
  p.id === "windows-desktop" ? "mcp-windows-desktop" : "mcp-scrapling",
);

describe("恢复预置服务 restorePresets()", () => {
  it("没删过任何预置时：没有待恢复项，调用返回 0 且不动列表", () => {
    const storage = memStorage();
    const registry = new McpRegistry(storage, FIXED_NOW);
    const before = registry.servers().map((s) => s.id);
    expect(registry.removedPresetIds()).toEqual([]);
    expect(registry.restorePresets()).toBe(0);
    expect(registry.servers().map((s) => s.id)).toEqual(before);
  });

  it("删掉预置后能恢复：条数正确、id 原样、不重复、刷新后仍在", () => {
    const storage = memStorage();
    const first = new McpRegistry(storage, FIXED_NOW);
    for (const server of first.servers()) first.remove(server.id);
    expect(first.servers()).toHaveLength(0);
    expect(first.removedPresetIds()).toEqual(PRESET_IDS);

    // 重开一次确认「不自动补回」的既有语义没被破坏
    const second = new McpRegistry(storage, FIXED_NOW);
    expect(second.servers()).toHaveLength(0);

    // 显式恢复：两条都回来，id 与预置一致
    expect(second.removedPresetIds()).toEqual(PRESET_IDS);
    expect(second.restorePresets()).toBe(PRESET_IDS.length);
    expect(second.servers().map((s) => s.id)).toEqual(PRESET_IDS);
    expect(new Set(second.servers().map((s) => s.id)).size).toBe(PRESET_IDS.length);
    // 已落盘：重开不再重复预置
    const third = new McpRegistry(storage, FIXED_NOW);
    expect(third.servers().map((s) => s.id)).toEqual(PRESET_IDS);
    // 删除记录已清空 → 再删一次仍会被记住（可重复的删除/恢复循环）
    expect(third.removedPresetIds()).toEqual([]);
    third.remove(PRESET_IDS[0]);
    expect(third.removedPresetIds()).toEqual([PRESET_IDS[0]]);
  });

  it("幂等：连续调用第二次返回 0，不会补出重复条目", () => {
    const storage = memStorage();
    const registry = new McpRegistry(storage, FIXED_NOW);
    registry.remove(PRESET_IDS[1]);
    expect(registry.restorePresets()).toBe(1);
    expect(registry.restorePresets()).toBe(0);
    expect(registry.servers()).toHaveLength(PRESET_IDS.length);
  });

  it("已存在同名服务时不覆盖用户配置（不补、不顶掉）", () => {
    const storage = memStorage();
    const first = new McpRegistry(storage, FIXED_NOW);
    // 删掉 Scrapling，然后用同名服务手填一台自己的（不同命令）
    first.remove(PRESET_IDS[1]);
    const mine = first.add({
      name: "网页抓取（Scrapling）",
      transport: "http",
      url: "https://my-own.example.com/mcp",
    });
    // 同名服务已存在 → 不补这条；同步删掉的 Windows 仍在，所以一条都不用补
    expect(first.restorePresets()).toBe(0);
    const names = first.servers().map((s) => s.name);
    expect(names.filter((n) => n === "网页抓取（Scrapling）")).toHaveLength(1);
    const kept = first.servers().find((s) => s.name === "网页抓取（Scrapling）")!;
    expect(kept.id).toBe(mine.id);
    expect(kept.url).toBe("https://my-own.example.com/mcp");
    expect(names).toContain("Windows 桌面控制");
  });

  it("同名旧服务顶替预置时，下次再删仍记得住（删除记录照样清空）", () => {
    const storage = memStorage();
    const registry = new McpRegistry(storage, FIXED_NOW);
    registry.remove(PRESET_IDS[1]);
    registry.add({ name: "网页抓取（Scrapling）", transport: "http", url: "https://x.example.com/mcp" });
    registry.restorePresets();
    // 记录已清：再删预置 id 之外的同名服务不会被当成删预置
    expect(registry.removedPresetIds()).toEqual([]);
  });

  it("删除记录写在本机存储的固定键上，并且恢复后清空", () => {
    const storage = memStorage();
    const registry = new McpRegistry(storage, FIXED_NOW);
    registry.remove(PRESET_IDS[0]);
    const raw = storage.raw.get(MCP_REMOVED_PRESETS_KEY);
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!)).toEqual([PRESET_IDS[0]]);
    registry.restorePresets();
    expect(JSON.parse(storage.raw.get(MCP_REMOVED_PRESETS_KEY) ?? "[]")).toEqual([]);
    // 服务列表键仍在（恢复不删配置）
    expect(storage.raw.has(MCP_SERVERS_KEY)).toBe(true);
  });

  it("恢复不影响其它服务的工具授权与配置", () => {
    const storage = memStorage();
    const registry = new McpRegistry(storage, FIXED_NOW);
    const winId = PRESET_IDS[0];
    registry.autoEnableSafeTools(winId, [{ name: "Screenshot" }]);
    expect(registry.isToolEnabled(winId, "Screenshot")).toBe(true);
    registry.remove(PRESET_IDS[1]);
    registry.restorePresets();
    expect(registry.isToolEnabled(winId, "Screenshot")).toBe(true);
    // 恢复回来的服务是启用状态，等待连接
    const restored = registry.get(PRESET_IDS[1])!;
    expect(restored.enabled).toBe(true);
  });
});
