import { describe, it, expect } from "vitest";
import type { TeamMember } from "@heming/shared";
import { DEFAULT_NAV_ORDER } from "../../store/ui.js";
import { PALETTE_PAGES, findPalettePage, shortcutLabel } from "./pages.js";
import { PALETTE_SETTINGS, findPaletteSetting } from "./settings.js";
import { PALETTE_ACTIONS, findPaletteAction } from "./actions.js";
import {
  MAX_RECENT,
  RECENT_KEY,
  clearRecent,
  loadRecent,
  normalizeRecent,
  recordRecent,
  type RecentStorage,
} from "./recent.js";
import {
  buildEmptyGroups,
  flattenGroups,
  searchPalette,
  searchAll,
} from "./search.js";
import { readFileSync } from "node:fs";

/** 内存版 Storage：足够覆盖读/写/坏数据三条路径。 */
function fakeStorage(seed: Record<string, string> = {}): RecentStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v);
    },
  };
}

function member(id: string, displayName: string, over: Partial<TeamMember> = {}): TeamMember {
  return { user: { id, username: id, displayName }, lastSeenAt: null, online: false, ...over };
}

describe("palette · 页面目录", () => {
  it("覆盖 9 个导航页，且与 store 的默认导航顺序是同一集合", () => {
    expect(PALETTE_PAGES).toHaveLength(9);
    expect(PALETTE_PAGES.map((p) => p.page).sort()).toEqual([...DEFAULT_NAV_ORDER].sort());
  });

  it("Alt 快捷键与 App/NavRail 的绑定一致（1/2/5/6/8/0）", () => {
    const digits = Object.fromEntries(
      PALETTE_PAGES.filter((p) => p.digit).map((p) => [p.page, p.digit]),
    );
    expect(digits).toEqual({
      home: "1",
      team: "2",
      memory: "5",
      settings: "6",
      chat: "8",
      plugins: "0",
    });
  });

  it("显示名唯一，且每页都有一句描述（描述参与检索）", () => {
    const labels = PALETTE_PAGES.map((p) => p.label);
    expect(new Set(labels).size).toBe(labels.length);
    for (const p of PALETTE_PAGES) expect(p.description.trim().length).toBeGreaterThan(0);
  });

  it("findPalettePage / shortcutLabel：未知页面安全返回", () => {
    expect(findPalettePage("home")?.label).toBe("主页");
    expect(findPalettePage("nope")).toBeUndefined();
    expect(shortcutLabel("1")).toBe("Alt+1");
    expect(shortcutLabel(undefined)).toBeNull();
  });
});

describe("palette · 设置分区与动作目录", () => {
  it("设置分区固定 5 个且顺序固定（id 必须与 SettingsPage 一致）", () => {
    expect(PALETTE_SETTINGS.map((s) => s.tab)).toEqual([
      "profile",
      "model",
      "appearance",
      "navigation",
      "about",
    ]);
  });

  it("设置 id 与 SettingsPage 源码里的分区 id 对得上（防两处漂移）", () => {
    // vitest 的工作目录就是 packages/web，直接读相对路径即可
    // （不走 import.meta.url：jsdom 环境下它不是 file: 协议）。
    const src = readFileSync("src/components/SettingsPage.tsx", "utf8");
    for (const s of PALETTE_SETTINGS) {
      expect(src).toContain(`id: "${s.tab}"`);
    }
  });

  it("常用动作固定 5 个", () => {
    expect(PALETTE_ACTIONS.map((a) => a.id)).toEqual([
      "new-task",
      "new-agent",
      "notifications",
      "settings",
      "modules",
    ]);
    expect(findPaletteAction("new-task")?.label).toBe("新建任务");
    expect(findPaletteAction("modules")?.label).toBe("模块管理");
    expect(findPaletteAction("nope")).toBeUndefined();
  });

  it("findPaletteSetting 能按 tab 找回", () => {
    expect(findPaletteSetting("appearance")?.label).toBe("外观");
    expect(findPaletteSetting("nope")).toBeUndefined();
  });
});

describe("palette · 最近使用（本机 ≤5）", () => {
  it("空存储返回空数组；坏 JSON / 非数组也返回空（不抛）", () => {
    expect(loadRecent(fakeStorage())).toEqual([]);
    expect(loadRecent(fakeStorage({ [RECENT_KEY]: "{not json" }))).toEqual([]);
    expect(loadRecent(fakeStorage({ [RECENT_KEY]: '{"a":1}' }))).toEqual([]);
  });

  it("按最近一次在前排序，重复执行只前移不重复", () => {
    const store = fakeStorage();
    recordRecent({ kind: "page", id: "home" }, store);
    recordRecent({ kind: "page", id: "settings" }, store);
    recordRecent({ kind: "page", id: "home" }, store);
    expect(loadRecent(store)).toEqual([
      { kind: "page", id: "home" },
      { kind: "page", id: "settings" },
    ]);
  });

  it("容量上限 5：超出淘汰最旧的一条", () => {
    const store = fakeStorage();
    for (const id of ["home", "team", "chat", "plugins", "memory", "settings"] as const) {
      recordRecent({ kind: "page", id }, store);
    }
    const list = loadRecent(store);
    expect(list).toHaveLength(MAX_RECENT);
    expect(list[0]).toEqual({ kind: "page", id: "settings" });
    expect(list.some((e) => e.id === "home")).toBe(false); // 最早的被淘汰
  });

  it("写入后确实落盘（同一 storage 可重复读回）", () => {
    const store = fakeStorage();
    recordRecent({ kind: "action", id: "new-task" }, store);
    expect(JSON.parse(store.data.get(RECENT_KEY) ?? "[]")).toEqual([
      { kind: "action", id: "new-task" },
    ]);
  });

  it("normalizeRecent 丢掉未知 kind / 非字符串 id / 重复项", () => {
    expect(
      normalizeRecent([
        { kind: "page", id: "home" },
        { kind: "bogus", id: "x" },
        { kind: "page", id: 123 },
        { kind: "page", id: "home" },
        null,
      ]),
    ).toEqual([{ kind: "page", id: "home" }]);
  });

  it("存储抛错（隐私模式/配额满）时不影响调用方", () => {
    const broken: RecentStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(() => recordRecent({ kind: "page", id: "home" }, broken)).not.toThrow();
    expect(() => clearRecent(broken)).not.toThrow();
  });
});

describe("palette · 空查询分组", () => {
  it("无最近使用时只有「页面跳转」与「常用动作」两组", () => {
    const groups = buildEmptyGroups([]);
    expect(groups.map((g) => g.id)).toEqual(["page", "action"]);
    expect(groups[0].items).toHaveLength(9);
    expect(groups[1].items).toHaveLength(5);
  });

  it("有最近使用时置顶，且最多 5 条；不存在的条目静默跳过", () => {
    const groups = buildEmptyGroups([
      { kind: "page", id: "settings" },
      { kind: "setting", id: "model" },
      { kind: "action", id: "new-task" },
      { kind: "page", id: "gone-page" }, // 已不存在的页面
    ]);
    expect(groups[0].id).toBe("recent");
    expect(groups[0].items.map((i) => i.id)).toEqual([
      "page:settings",
      "setting:model",
      "action:new-task",
    ]);
  });

  it("组内同类型、组间不混排", () => {
    const groups = buildEmptyGroups([]);
    for (const g of groups) {
      expect(new Set(g.items.map((i) => i.kind)).size).toBe(1);
    }
  });
});

describe("palette · 输入检索", () => {
  it("按页面名命中：搜「设置」出设置区，且归在页面组", () => {
    const groups = searchPalette("设置", { members: [], archiveHits: [] });
    const pageGroup = groups.find((g) => g.id === "page");
    expect(pageGroup?.items.some((i) => i.page === "settings")).toBe(true);
  });

  it("按页面描述命中：搜「归档」能命中信息中枢（描述里才有归档）", () => {
    const groups = searchPalette("归档", { members: [], archiveHits: [] });
    const pageGroup = groups.find((g) => g.id === "page");
    expect(pageGroup?.items.some((i) => i.page === "infohub")).toBe(true);
  });

  it("按设置分区关键词命中：搜「主题」出「外观」分区", () => {
    const groups = searchPalette("主题", { members: [], archiveHits: [] });
    const settingGroup = groups.find((g) => g.id === "setting");
    expect(settingGroup?.items.map((i) => i.tab)).toContain("appearance");
  });

  it("按动作名命中：搜「通知」出「打开通知中心」", () => {
    const groups = searchPalette("通知", { members: [], archiveHits: [] });
    const actionGroup = groups.find((g) => g.id === "action");
    expect(actionGroup?.items.map((i) => i.actionId)).toContain("notifications");
  });

  it("成员结果沿用旧口径（前缀优先、在线优先、详情带 @用户名）", () => {
    const groups = searchPalette("张", {
      members: [member("u1", "群里的张三丰"), member("u2", "张三", { online: true })],
      archiveHits: [],
    });
    const list = groups.find((g) => g.id === "member")?.items ?? [];
    expect(list[0].name).toBe("张三");
    expect(list[0].detail).toContain("@u2");
    expect(list[0].detail).toContain("在线");
  });

  it("技能仍能被搜到（老功能不回归）", () => {
    const groups = searchPalette("AI", { members: [], archiveHits: [] });
    expect(groups.some((g) => g.id === "skill")).toBe(true);
  });

  it("归档命中单独成组，组内只有归档项", () => {
    const groups = searchPalette("免检单", {
      members: [],
      archiveHits: [
        {
          id: 1,
          conversationId: 25,
          ts: 1800000100,
          senderName: "叶老师",
          content: "请把免检单交上来",
          snippet: "请把<<免检单>>交上来",
          convName: "叶老师",
          source: "qq",
        },
      ],
    });
    const archive = groups.find((g) => g.id === "archive");
    expect(archive?.items).toHaveLength(1);
    expect(archive?.items[0].kind).toBe("archive");
    expect(new Set(archive?.items.map((i) => i.kind))).toEqual(new Set(["archive"]));
  });

  it("分组顺序固定：页面 → 设置 → 动作 → 成员 → 技能 → 归档", () => {
    const groups = searchPalette("a", {
      members: [member("u1", "alice")],
      archiveHits: [],
    });
    const order = groups.map((g) => g.id);
    const expected = ["page", "setting", "action", "member", "skill", "archive"].filter((id) =>
      order.includes(id as never),
    );
    expect(order).toEqual(expected);
  });

  it("无命中时返回空数组（面板显示「没有匹配」）", () => {
    expect(searchPalette("zzzz-not-exist", { members: [], archiveHits: [] })).toEqual([]);
  });

  it("空关键词走空查询分组（含最近使用传入时置顶）", () => {
    const groups = searchPalette("  ", { members: [], archiveHits: [] });
    expect(groups.map((g) => g.id)).toEqual(["page", "action"]);
  });

  it("flattenGroups 只摊平结果项，便于键盘游标", () => {
    const groups = buildEmptyGroups([]);
    expect(flattenGroups(groups)).toHaveLength(14);
  });

  it("旧口径 searchAll 仍可用（兼容导出）", () => {
    expect(searchAll("张", [member("u1", "张三")]).map((r) => r.name)).toEqual(["张三"]);
    expect(searchAll("", [member("u1", "张三")])).toEqual([]);
  });
});
