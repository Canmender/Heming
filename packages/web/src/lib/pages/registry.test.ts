import { describe, expect, it } from "vitest";
import type { InstalledPlugin } from "../plugins/store.js";
import type { WidgetRecord } from "../../types/widgets.js";
import {
  isPluginPagePage,
  pluginIdFromPage,
  pluginPageEntries,
  pluginPageEntry,
  pluginPageId,
  pluginNavPages,
  withPluginNav,
} from "./registry.js";
import { normalizePluginPageIcon } from "./icons.js";

/** 最小插件记录：只填本文件关心的字段，其余用空值兜住（测试不跑安装事务）。 */
function installedPlugin(input: {
  id: string;
  page?: { title: string; icon?: string } | null;
  enabled?: boolean;
  installedAt?: string;
  invalidRecord?: boolean;
}): InstalledPlugin {
  return {
    manifest: {
      schemaVersion: 5,
      id: input.id,
      name: input.id,
      version: "1.0.0",
      description: "",
      author: "",
      distribution: "manifest",
      contributions: {
        skills: [],
        mcpServers: [],
        commands: [],
        toolPacks: [],
        desktopWidgets: [],
        llmPresets: [],
        ...(input.page
          ? {
              page: {
                kind: "blocks" as const,
                title: input.page.title,
                icon: input.page.icon ?? "",
                summary: "",
                blocks: [{ type: "markdown" as const, text: "内容" }],
              },
            }
          : {}),
      },
      permissions: { network: [], tools: "read", files: [], events: [], graphics: [], eval: false, chat: false },
    },
    enabled: input.enabled ?? true,
    skillIds: [],
    serverIds: [],
    fingerprint: "fnv1a64b:0",
    publisher: null,
    signature: null,
    disabledKinds: [],
    installedAt: input.installedAt ?? "2026-11-10T00:00:00.000Z",
    updatedAt: input.installedAt ?? "2026-11-10T00:00:00.000Z",
    ...(input.invalidRecord ? { invalidRecord: true as const, invalidReason: "清单损坏" } : {}),
  };
}

/** 最小界面插件记录（`widget` 只为满足类型；本文件不碰窗口规格）。 */
function widgetRecord(input: {
  id: string;
  page?: { title: string; icon?: string } | null;
  enabled?: boolean;
  installedAt?: string;
  error?: string;
}): WidgetRecord {
  const record = {
    id: input.id,
    name: input.id,
    version: "1.0.0",
    enabled: input.enabled ?? true,
    settings: {},
    installedAt: input.installedAt ?? "2026-11-10T00:00:00.000Z",
    ...(input.page
      ? { page: { title: input.page.title, icon: input.page.icon ?? "", summary: "", entry: "page/index.html" } }
      : {}),
    ...(input.error ? { error: input.error } : {}),
  };
  return record as unknown as WidgetRecord;
}

describe("插件页面 id", () => {
  it("生成 / 解析 / 判定一致，且空 id 不算页面", () => {
    expect(pluginPageId("acme.kit")).toBe("plugin:acme.kit");
    expect(pluginIdFromPage(pluginPageId("acme.kit"))).toBe("acme.kit");
    expect(isPluginPagePage("plugin:acme.kit")).toBe(true);
    expect(isPluginPagePage("plugin:")).toBe(false);
    expect(isPluginPagePage("plugins")).toBe(false);
  });
});

describe("pluginPageEntries", () => {
  it("声明式页面：按安装时间升序，停用仍出现在列表但 available=false", () => {
    const entries = pluginPageEntries({
      plugins: [
        installedPlugin({ id: "b.kit", page: { title: "B" }, installedAt: "2026-11-10T02:00:00.000Z" }),
        installedPlugin({ id: "a.kit", page: { title: "A" }, installedAt: "2026-11-10T01:00:00.000Z" }),
        installedPlugin({ id: "c.kit", page: { title: "C" }, enabled: false }),
      ],
      widgets: [],
      desktop: false,
    });
    // c.kit 用默认安装时间（更早），所以排在最前——排序只看时间，不看启用状态。
    expect(entries.map((entry) => entry.pluginId)).toEqual(["c.kit", "a.kit", "b.kit"]);
    expect(entries.map((entry) => entry.available)).toEqual([false, true, true]);
    expect(entries[1]).toMatchObject({ source: "declarative", pageId: "plugin:a.kit", title: "A" });
  });

  it("没有 page 贡献、或记录已损坏的插件不建入口", () => {
    const entries = pluginPageEntries({
      plugins: [
        installedPlugin({ id: "no-page" }),
        installedPlugin({ id: "broken", page: { title: "坏" }, invalidRecord: true }),
      ],
      widgets: [],
      desktop: true,
    });
    expect(entries).toEqual([]);
  });

  it("界面插件页面：排在声明式之后；浏览器里 available=false；损坏记录/停用不可用", () => {
    const entries = pluginPageEntries({
      plugins: [installedPlugin({ id: "a.kit", page: { title: "A" }, installedAt: "2026-11-10T03:00:00.000Z" })],
      widgets: [
        widgetRecord({ id: "heming.pet", page: { title: "宠物面板" }, installedAt: "2026-11-10T00:00:00.000Z" }),
        widgetRecord({ id: "acme.sick", page: { title: "坏" }, error: "包损坏" }),
        widgetRecord({ id: "acme.off", page: { title: "关" }, enabled: false }),
        widgetRecord({ id: "acme.tiny" }),
      ],
      desktop: true,
    });
    // 三个 bundle 记录同刻安装（默认时间）→ 按 pageId 字典序；声明式永远排在 bundle 之前。
    expect(entries.map((entry) => entry.pluginId)).toEqual(["a.kit", "acme.off", "acme.sick", "heming.pet"]);
    expect(entries.map((entry) => entry.source)).toEqual(["declarative", "bundle", "bundle", "bundle"]);
    expect(entries.map((entry) => entry.available)).toEqual([true, false, false, true]);

    const browser = pluginPageEntries({
      plugins: [],
      widgets: [widgetRecord({ id: "heming.pet", page: { title: "宠物面板" } })],
      desktop: false,
    });
    expect(browser[0].available).toBe(false);
  });

  it("同一安装时刻按 pageId 字典序，保证每次启动顺序一致", () => {
    const entries = pluginPageEntries({
      plugins: [
        installedPlugin({ id: "z.kit", page: { title: "Z" }, installedAt: "2026-11-10T01:00:00.000Z" }),
        installedPlugin({ id: "a.kit", page: { title: "A" }, installedAt: "2026-11-10T01:00:00.000Z" }),
      ],
      widgets: [],
      desktop: false,
    });
    expect(entries.map((entry) => entry.pluginId)).toEqual(["a.kit", "z.kit"]);
  });

  it("图标归一化：未知/空值回落 package", () => {
    const entries = pluginPageEntries({
      plugins: [
        installedPlugin({ id: "a.kit", page: { title: "A", icon: "Activity" } }),
        installedPlugin({ id: "b.kit", page: { title: "B", icon: "not-an-icon" } }),
        installedPlugin({ id: "c.kit", page: { title: "C" } }),
      ],
      widgets: [],
      desktop: false,
    });
    expect(entries.map((entry) => entry.icon)).toEqual(["activity", "package", "package"]);
    expect(normalizePluginPageIcon(undefined)).toBe("package");
  });
});

describe("pluginPageEntry / pluginNavPages / withPluginNav", () => {
  const entries = pluginPageEntries({
    plugins: [
      installedPlugin({ id: "a.kit", page: { title: "A" }, installedAt: "2026-11-10T01:00:00.000Z" }),
      installedPlugin({ id: "b.kit", page: { title: "B" }, enabled: false }),
    ],
    widgets: [widgetRecord({ id: "heming.pet", page: { title: "宠物面板" } })],
    desktop: true,
  });

  it("按路由 id 反查；不存在回 undefined", () => {
    expect(pluginPageEntry(entries, "plugin:a.kit")?.title).toBe("A");
    expect(pluginPageEntry(entries, "plugin:nope")).toBeUndefined();
    expect(pluginPageEntry(entries, "plugins")).toBeUndefined();
  });

  it("导航只收可用页面，顺序与注册表一致", () => {
    expect(pluginNavPages(entries)).toEqual(["plugin:a.kit", "plugin:heming.pet"]);
  });

  it("withPluginNav 追加在宿主页之后，且不重复、不改原顺序", () => {
    const order = ["home", "plugins"] as const;
    const next = withPluginNav([...order], entries);
    expect(next).toEqual(["home", "plugins", "plugin:a.kit", "plugin:heming.pet"]);
    // 已存在时幂等（模块页/插件页混排的极端情况）
    expect(withPluginNav(next, entries)).toEqual(next);
  });
});
