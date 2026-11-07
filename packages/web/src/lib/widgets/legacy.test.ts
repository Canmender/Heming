import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StorageLike } from "../memory/types.js";
import {
  PET_MIGRATION_HINT_KEY,
  PET_PLUGIN_ID,
  PET_PREFS_LEGACY_KEY,
  PET_PRESENCE_LEGACY_KEY,
  collectLegacyPetPrefs,
  dismissPetMigrationHint,
  migrateLegacyPetPrefs,
  readLegacyPrefs,
  shouldShowPetMigrationHint,
} from "./legacy.js";
import type { WidgetRecord, WidgetsBridge } from "../../types/widgets.js";

/**
 * 桌宠迁移与一次性提示（d.97 §4.3）：
 * - 只挑已知字段交给主进程（localStorage 里的任意内容不原样外传）；
 * - 老键（heming.pet.v1 / presence）保留不删；
 * - 「桌宠已改为插件」只提示一次，且只在桌面端 + 未安装 heming.pet 时提示。
 */

function memStorage(seed: Record<string, string> = {}): StorageLike {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

function bridge(overrides: Partial<WidgetsBridge> = {}): WidgetsBridge {
  return {
    migrateLegacy: vi.fn(async () => ({ ok: true })),
    ...overrides,
  } as unknown as WidgetsBridge;
}

function petRecord(): WidgetRecord {
  return {
    id: PET_PLUGIN_ID,
    name: "桌宠",
    version: "1.0.0",
    enabled: true,
    widget: {
      id: "pet",
      name: "桌宠",
      entry: "files/index.html",
      width: 300,
      height: 420,
      scales: [1],
      defaultScale: 1,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      clickThrough: "auto",
      position: { anchor: "bottom-right", margin: 24, remember: true },
    },
    settings: {},
    installedAt: "2026-11-07T12:00:00.000Z",
  };
}

describe("readLegacyPrefs / collectLegacyPetPrefs", () => {
  it("没有老键 → null", () => {
    const storage = memStorage();
    expect(readLegacyPrefs(PET_PREFS_LEGACY_KEY, storage as unknown as Storage)).toBeNull();
    expect(collectLegacyPetPrefs(storage as unknown as Storage)).toBeNull();
  });

  it("只挑已知字段（enabled / agentId / modelPath + presence）", () => {
    const storage = memStorage({
      [PET_PREFS_LEGACY_KEY]: JSON.stringify({
        enabled: true,
        agentId: "agent-1",
        modelPath: "pet/Hiyori/Hiyori.model3.json",
        evil: "不该外传",
      }),
      [PET_PRESENCE_LEGACY_KEY]: JSON.stringify({ intensity: "eager", extra: 1 }),
    });
    expect(collectLegacyPetPrefs(storage as unknown as Storage)).toEqual({
      enabled: true,
      agentId: "agent-1",
      modelPath: "pet/Hiyori/Hiyori.model3.json",
      presence: "eager",
    });
  });

  it("坏 JSON / 非对象 / 未知强度 → 忽略该键", () => {
    const broken = memStorage({ [PET_PREFS_LEGACY_KEY]: "{不是 JSON" });
    expect(collectLegacyPetPrefs(broken as unknown as Storage)).toBeNull();
    const array = memStorage({ [PET_PREFS_LEGACY_KEY]: "[]" });
    expect(collectLegacyPetPrefs(array as unknown as Storage)).toBeNull();
    const badPresence = memStorage({
      [PET_PREFS_LEGACY_KEY]: JSON.stringify({ enabled: false }),
      [PET_PRESENCE_LEGACY_KEY]: JSON.stringify({ intensity: "loud" }),
    });
    expect(collectLegacyPetPrefs(badPresence as unknown as Storage)).toEqual({ enabled: false });
  });
});

describe("migrateLegacyPetPrefs", () => {
  beforeEach(() => {
    delete window.__heming_widgets;
  });

  it("没有老数据 → 成功且不触发 IPC", async () => {
    const b = bridge();
    const result = await migrateLegacyPetPrefs(b, memStorage() as unknown as Storage);
    expect(result).toEqual({ ok: true });
    expect(b.migrateLegacy).not.toHaveBeenCalled();
  });

  it("有老数据 → 交给主进程做一次性迁移", async () => {
    const b = bridge();
    const storage = memStorage({
      [PET_PREFS_LEGACY_KEY]: JSON.stringify({ enabled: true, agentId: "a1" }),
    });
    const result = await migrateLegacyPetPrefs(b, storage as unknown as Storage);
    expect(result).toEqual({ ok: true });
    expect(b.migrateLegacy).toHaveBeenCalledWith({ prefs: { enabled: true, agentId: "a1" } });
  });

  it("主进程失败 / 无桥 → 如实返回错误（安装本身已成功，提示迁移失败即可）", async () => {
    const storage = memStorage({
      [PET_PREFS_LEGACY_KEY]: JSON.stringify({ enabled: true }),
    });
    const failed = await migrateLegacyPetPrefs(
      bridge({ migrateLegacy: async () => ({ ok: false, error: "磁盘只读" }) }),
      storage as unknown as Storage,
    );
    expect(failed).toEqual({ ok: false, error: "磁盘只读" });
    const noBridge = await migrateLegacyPetPrefs(undefined, storage as unknown as Storage);
    expect(noBridge.ok).toBe(false);
  });
});

describe("shouldShowPetMigrationHint / dismissPetMigrationHint", () => {
  it("浏览器（无桥）不提示；桌面端未安装且没提示过 → 提示", () => {
    const storage = memStorage();
    expect(
      shouldShowPetMigrationHint([], { bridge: undefined, storage: storage as unknown as Storage }),
    ).toBe(false);
    expect(
      shouldShowPetMigrationHint([], { bridge: bridge(), storage: storage as unknown as Storage }),
    ).toBe(true);
  });

  it("已安装 heming.pet 或已提示过 → 不再提示", () => {
    const storage = memStorage();
    expect(
      shouldShowPetMigrationHint([petRecord()], {
        bridge: bridge(),
        storage: storage as unknown as Storage,
      }),
    ).toBe(false);
    dismissPetMigrationHint(storage as unknown as Storage);
    expect((storage as unknown as StorageLike).getItem(PET_MIGRATION_HINT_KEY)).toBe("1");
    expect(
      shouldShowPetMigrationHint([], { bridge: bridge(), storage: storage as unknown as Storage }),
    ).toBe(false);
  });

  it("存储不可用时宁可不提示（不每次刷新都弹）", () => {
    const throwing = {
      getItem: () => {
        throw new Error("隐私模式");
      },
      setItem: () => {
        throw new Error("隐私模式");
      },
      removeItem: () => {},
    } as unknown as Storage;
    expect(() => dismissPetMigrationHint(throwing)).not.toThrow();
    expect(
      shouldShowPetMigrationHint([], { bridge: bridge(), storage: throwing }),
    ).toBe(false);
  });
});
