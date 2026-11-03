import { describe, expect, it } from "vitest";
import {
  SETTINGS_CARDS,
  SETTINGS_SECTION_LABELS,
  matchSettingsCards,
  sectionLabelOf,
  settingsCardById,
  settingsCardLabel,
} from "./registry.js";

/**
 * 设置页卡片元数据（UX-E）：
 * - 纯函数：跨分区匹配口径（标题 / 关键词 / 分区名，空格分词 AND）；
 * - 源码守卫：SettingsPage 里的 `data-settings-id` 集合必须与 registry 完全一致
 *   （新增卡片只加一行；少了是漏挂锚点，多了是死项）。
 */

const SETTINGS_TAB_IDS = new Set(["profile", "model", "appearance", "navigation", "about"]);

describe("registry 完整性", () => {
  it("14 张卡、id 唯一、分区合法、标题与关键词非空", () => {
    expect(SETTINGS_CARDS).toHaveLength(14);
    const ids = SETTINGS_CARDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const card of SETTINGS_CARDS) {
      expect(card.title.trim().length).toBeGreaterThan(0);
      expect(card.keywords.length).toBeGreaterThan(0);
      expect(SETTINGS_TAB_IDS.has(card.section)).toBe(true);
      expect(SETTINGS_SECTION_LABELS[card.section].length).toBeGreaterThan(0);
    }
  });

  it("每个分区都有卡片；标签文案与设置页标签一致", () => {
    for (const section of SETTINGS_TAB_IDS) {
      expect(SETTINGS_CARDS.some((c) => c.section === section)).toBe(true);
    }
    expect(SETTINGS_SECTION_LABELS.profile).toBe("个人资料");
    expect(SETTINGS_SECTION_LABELS.model).toBe("模型");
    expect(SETTINGS_SECTION_LABELS.appearance).toBe("外观");
    expect(SETTINGS_SECTION_LABELS.navigation).toBe("导航");
    expect(SETTINGS_SECTION_LABELS.about).toBe("关于");
  });

  it("settingsCardById / settingsCardLabel / sectionLabelOf 与表同源", () => {
    expect(settingsCardById("hitl-policy")?.title).toBe("工具调用确认");
    expect(settingsCardById("nope")).toBeUndefined();
    expect(sectionLabelOf("appearance")).toBe("外观");
    expect(settingsCardLabel(settingsCardById("pet")!)).toBe("桌宠 · 外观");
  });
});

describe("matchSettingsCards（跨分区匹配）", () => {
  it("空查询/纯空格 → 空数组（界面回到普通分区视图）", () => {
    expect(matchSettingsCards("")).toEqual([]);
    expect(matchSettingsCards("   ")).toEqual([]);
  });

  it("按关键词命中（含同义说法）：免问 → 工具调用确认", () => {
    const ids = matchSettingsCards("免问").map((c) => c.id);
    expect(ids).toContain("hitl-policy");
  });

  it("跨分区命中：搜「主题色」命中外观、搜「更新」命中关于", () => {
    expect(matchSettingsCards("主题色").map((c) => c.id)).toEqual(["accent-color"]);
    const update = matchSettingsCards("更新").map((c) => c.id);
    expect(update).toContain("update");
    expect(update).toContain("changelog");
  });

  it("分区名也参与匹配：搜「外观」命中该分区全部卡片", () => {
    const ids = matchSettingsCards("外观").map((c) => c.id);
    expect(ids).toEqual(["accent-color", "theme-mode", "pet"]);
  });

  it("大小写不敏感、空格分词为 AND：搜「key 存储」→ 密钥存储", () => {
    expect(matchSettingsCards("KEY 存储").map((c) => c.id)).toEqual(["key-storage"]);
    // 两个词分布在标题与关键词里也能命中
    expect(matchSettingsCards("文件 只读").map((c) => c.id)).toEqual(["file-edit"]);
  });

  it("结果顺序 = 设置页渲染顺序（按分区先后，不按匹配度乱排）", () => {
    const ids = matchSettingsCards("模型").map((c) => c.id);
    const order = SETTINGS_CARDS.map((c) => c.id);
    expect([...ids].sort((a, b) => order.indexOf(a) - order.indexOf(b))).toEqual(ids);
    expect(ids[0]).toBe("llm-connection");
  });

  it("没有命中 → 空数组（不抛）", () => {
    expect(matchSettingsCards("zzz-不存在")).toEqual([]);
  });
});

describe("源码守卫：SettingsPage 的 data-settings-id 与 registry 一致", () => {
  const mods = import.meta.glob("../../components/SettingsPage.tsx", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>;

  it("每张注册的卡都在设置页挂了一个 data-settings-id", () => {
    const src = Object.values(mods)[0] ?? "";
    // 过滤 `data-settings-id="${focusTarget}"` 这类查询选择器，只留静态字面量
    const inSource = [...src.matchAll(/data-settings-id="([^"]+)"/g)]
      .map((m) => m[1])
      .filter((id) => /^[a-z0-9-]+$/.test(id));
    const unique = new Set(inSource);
    const registryIds = new Set(SETTINGS_CARDS.map((c) => c.id));
    // 双向：不多（死项）不少（漏挂）
    expect([...unique].sort()).toEqual([...registryIds].sort());
  });

  it("没有重复挂同一个 id（重复会让滚动定位指到第一个）", () => {
    const src = Object.values(mods)[0] ?? "";
    const inSource = [...src.matchAll(/data-settings-id="([^"]+)"/g)]
      .map((m) => m[1])
      .filter((id) => /^[a-z0-9-]+$/.test(id));
    expect(inSource.length).toBe(new Set(inSource).size);
  });
});
