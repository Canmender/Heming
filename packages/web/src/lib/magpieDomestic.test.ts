import { describe, expect, it } from "vitest";
import {
  CHECKIN_SWITCHES,
  CHECKIN_VENDORS,
  DOMESTIC_AGENTS,
  DOMESTIC_GROUPS,
  DOMESTIC_KEY_NOTE,
  checkinFailed,
  domesticPluginInstalled,
  checkinLine,
  checkinSummary,
  checkinSwitchArgs,
  checkinSwitchState,
  checkinSwitchText,
  checkinVendorName,
  parseCheckin,
  parsePluginProviders,
  parseSettingValues,
  type CheckinEntry,
} from "./magpieDomestic.js";

/** 国产智能体端（d.280）：内核认这些端，但账号要插件才行，页面只负责说清楚。 */

function entry(patch: Partial<CheckinEntry>): CheckinEntry {
  return { user: "", vendor: "", outcome: "claimed", credit: 0, streak: 0, msg: "", ...patch };
}

describe("国产端清单", () => {
  it("只用内核确认过的 agent id 与插件包名", () => {
    const ids = DOMESTIC_AGENTS.map((item) => item.agent);
    // 国内站在前、国际站在后：Trae CN 与 MiniMax Code 的包名写在 *_checkin.go 里，没有 mover
    expect(ids).toEqual([
      "workbuddy",
      "qoder-cn",
      "trae-cn",
      "minimax-code",
      "mimo",
      "zcode",
      "workbuddy-ai",
      "qoder",
      "minimax-code-global",
    ]);
    for (const item of DOMESTIC_AGENTS) {
      expect(item.pkg.startsWith("@magpie-community/")).toBe(true);
      expect(item.label.length).toBeGreaterThan(0);
      expect(item.desc.length).toBeGreaterThan(0);
    }
    // 一个包服务两个站：国际站与国内站同一套登录
    for (const [cn, intl] of [
      ["workbuddy", "workbuddy-ai"],
      ["qoder-cn", "qoder"],
      ["minimax-code", "minimax-code-global"],
    ] as const) {
      const a = DOMESTIC_AGENTS.find((item) => item.agent === cn);
      const b = DOMESTIC_AGENTS.find((item) => item.agent === intl);
      expect(a?.pkg).toBe(b?.pkg);
      expect(a?.site).toBe("cn");
      expect(b?.site).toBe("intl");
    }
  });

  it("分组只分两档，且一张卡不漏", () => {
    expect(DOMESTIC_GROUPS.map((group) => group.title)).toEqual(["国内站", "国际站"]);
    expect(DOMESTIC_GROUPS.flatMap((group) => group.items)).toHaveLength(DOMESTIC_AGENTS.length);
    for (const group of DOMESTIC_GROUPS) {
      for (const item of group.items) expect(item.site).toBe(group.site);
      expect(group.items.length).toBeGreaterThan(0);
    }
  });

  it("会封号的端都写了风险，能签到的端都标了签到", () => {
    expect(DOMESTIC_AGENTS.filter((item) => item.risk).map((item) => item.agent)).toEqual([
      "workbuddy",
      "workbuddy-ai",
    ]);
    expect(DOMESTIC_AGENTS.filter((item) => item.checkin).map((item) => item.agent)).toEqual([
      "workbuddy",
      "qoder-cn",
      "trae-cn",
      "minimax-code",
      "workbuddy-ai",
      "qoder",
      "minimax-code-global",
    ]);
  });

  it("说清哪些国产端不在账号里（已能接的不再点名）", () => {
    for (const name of ["Qwen Code", "Kimi Code"]) {
      expect(DOMESTIC_KEY_NOTE).toContain(name);
    }
    // MiniMax Code 已经有账号插件了，留在「走 Key 的端」那句话里会把人带偏
    for (const name of ["MiniMax Code", "Trae CN", "WorkBuddy", "Qoder"]) {
      expect(DOMESTIC_KEY_NOTE).not.toContain(name);
    }
    for (const name of ["WorkBuddy", "Qoder", "Trae CN", "MiniMax Code"]) {
      expect(CHECKIN_VENDORS).toContain(name);
    }
  });
});

describe("parsePluginProviders", () => {
  it("从插件清单里取 provider id", () => {
    const stdout = JSON.stringify({
      plugins: [{ name: "qoder-auth" }],
      loaded: [],
      providers: [{ id: "qoder" }, { id: "qoder-cn" }, { id: "" }, {}],
      middleware: [],
    });
    expect([...parsePluginProviders(stdout)]).toEqual(["qoder", "qoder-cn"]);
  });

  it("没有插件时是空清单，不是错误", () => {
    expect(parsePluginProviders("[]").size).toBe(0);
    expect(parsePluginProviders("").size).toBe(0);
    expect(parsePluginProviders("No plugins. Add one: magpie plugin add <pkg>").size).toBe(0);
    expect(parsePluginProviders('{"providers":"nope"}').size).toBe(0);
    expect(parsePluginProviders('{"providers":[{"id":"mimo-app"}]}').has("mimo-app")).toBe(true);
  });
});

describe("domesticPluginInstalled", () => {
  const byAgent = (agent: string) => DOMESTIC_AGENTS.find((item) => item.agent === agent)!;

  it("小米认订阅 id mimo-app，不再被 agent 名 mimo 骗着重复装插件", () => {
    const mimo = byAgent("mimo");
    expect(mimo.accountId).toBe("mimo-app");
    expect(domesticPluginInstalled(mimo, new Set(["mimo-app"]))).toBe(true);
    // 只有别的同名 provider（不是这家的订阅）在，不算装过
    expect(domesticPluginInstalled(mimo, new Set(["mimo"]))).toBe(false);
    expect(domesticPluginInstalled(mimo, new Set())).toBe(false);
  });

  it("一个包服务两个站：装了一边，另一边的卡也算已装", () => {
    for (const [a, b] of [
      ["workbuddy", "workbuddy-ai"],
      ["qoder-cn", "qoder"],
      ["minimax-code", "minimax-code-global"],
    ] as const) {
      expect(domesticPluginInstalled(byAgent(a), new Set([b]))).toBe(true);
      expect(domesticPluginInstalled(byAgent(b), new Set([a]))).toBe(true);
    }
  });

  it("每家卡的 accountId 都能对上内核订阅（小米单独写对）", () => {
    for (const item of DOMESTIC_AGENTS) {
      expect(item.accountId.length).toBeGreaterThan(0);
    }
    expect(byAgent("mimo").accountId).toBe("mimo-app");
    expect(byAgent("workbuddy").accountId).toBe("workbuddy");
  });
});

describe("parseCheckin", () => {
  it("读内核的签到结果（by/outcome/credit/streak）", () => {
    const stdout = JSON.stringify([
      { user: "a@example.com", by: "", outcome: "claimed", credit: 100, streak: 3 },
      { user: "b@example.com", by: "plugin:qoder", outcome: "done" },
    ]);
    expect(parseCheckin(stdout)).toEqual([
      { user: "a@example.com", vendor: "", outcome: "claimed", credit: 100, streak: 3, msg: "" },
      { user: "b@example.com", vendor: "plugin:qoder", outcome: "done", credit: 0, streak: 0, msg: "" },
    ]);
  });

  it("坏 JSON、空清单、没有 outcome 的行都不算结果", () => {
    expect(parseCheckin("")).toEqual([]);
    expect(parseCheckin("not json")).toEqual([]);
    expect(parseCheckin("[]")).toEqual([]);
    expect(parseCheckin('{"outcome":"claimed"}')).toEqual([]);
    expect(parseCheckin('[{"user":"x"}]')).toEqual([]);
  });
});

describe("checkinVendorName", () => {
  it("WorkBuddy 的 by 是空串，插件的是 plugin:<id>", () => {
    expect(checkinVendorName("")).toBe("WorkBuddy");
    expect(checkinVendorName("trae")).toBe("Trae CN");
    expect(checkinVendorName("plugin:qoder")).toBe("qoder");
    expect(checkinVendorName("plugin:")).toBe("接入组件");
    expect(checkinVendorName("workbuddy")).toBe("workbuddy");
  });
});

describe("checkinLine / checkinSummary", () => {
  it("领到了就说领到多少、连了几天", () => {
    expect(checkinLine(entry({ credit: 100, streak: 3 }))).toBe("已签到 +100 · 连续 3 天");
    expect(checkinLine(entry({ credit: 0, streak: 1 }))).toBe("已签到");
    expect(checkinLine(entry({ vendor: "plugin:qoder", user: "a@b.c", credit: 50 }))).toBe(
      "已签到 +50",
    );
  });

  it("签过了、不能签、要验证码各有自己的说法", () => {
    expect(checkinLine(entry({ outcome: "done", user: "a@b.c" }))).toBe("WorkBuddy（a@b.c） 今天已经签过");
    expect(checkinLine(entry({ outcome: "ineligible", msg: "no plan" }))).toBe(
      "WorkBuddy 不能参加这个签到：no plan",
    );
    expect(checkinLine(entry({ outcome: "inactive", vendor: "trae" }))).toBe("Trae CN 现在没有签到活动");
    expect(checkinLine(entry({ outcome: "captcha" }))).toContain("验证码");
    expect(checkinLine(entry({ outcome: "own-app" }))).toContain("自家应用");
    expect(checkinLine(entry({ outcome: "failed", msg: "timeout" }))).toBe("WorkBuddy 签到失败：timeout");
    expect(checkinLine(entry({ outcome: "something-new" }))).toBe("WorkBuddy 签到失败");
  });

  it("总结：没有账号时点明哪几个端能签", () => {
    expect(checkinSummary([])).toContain("WorkBuddy");
    expect(checkinSummary([])).toContain("每天");
    expect(checkinSummary([entry({}), entry({ outcome: "done" })])).toBe("已签到；WorkBuddy 今天已经签过");
    const many = [entry({}), entry({ outcome: "done" }), entry({ outcome: "captcha" }), entry({})];
    expect(checkinSummary(many)).toContain("；等 4 个账号");
  });

  it("有失败就换告警色", () => {
    expect(checkinFailed([])).toBe(false);
    expect(checkinFailed([entry({ outcome: "claimed" })])).toBe(false);
    expect(checkinFailed([entry({ outcome: "failed" })])).toBe(true);
  });
});

describe("每天自动签到（settings 的四个厂商开关）", () => {
  it("四个开关都来自内核的 settings key", () => {
    expect(CHECKIN_SWITCHES.map((item) => item.key)).toEqual([
      "workbuddyCheckin",
      "qoderCheckin",
      "traeCheckin",
      "minimaxCheckin",
    ]);
  });

  it("读 settings list --json：取 key 与 value，坏 JSON 当空表", () => {
    const values = parseSettingValues(
      JSON.stringify([
        { key: "workbuddyCheckin", value: true },
        { key: "qoderCheckin", value: false },
        { key: "vision", value: "x" },
      ]),
    );
    expect(values.get("workbuddyCheckin")).toBe(true);
    expect(values.get("qoderCheckin")).toBe(false);
    expect(values.get("vision")).toBe("x");
    expect(parseSettingValues("").size).toBe(0);
    expect(parseSettingValues("not json").size).toBe(0);
    expect(parseSettingValues(JSON.stringify({ workbuddyCheckin: true })).size).toBe(0);
  });

  it("状态：全开、全关、开着一半", () => {
    const all = new Map<string, unknown>([
      ["workbuddyCheckin", true],
      ["qoderCheckin", true],
      ["traeCheckin", true],
      ["minimaxCheckin", true],
    ]);
    expect(checkinSwitchState(all)).toBe("on");
    expect(checkinSwitchState(new Map())).toBe("off");
    expect(checkinSwitchState(new Map([["workbuddyCheckin", true]]))).toBe("mixed");
    expect(checkinSwitchState(new Map([["workbuddyCheckin", "on"]]))).toBe("off");
  });

  it("三种状态的人话各不相同：off 不能说成 on（d.412 回归）", () => {
    expect(checkinSwitchText("on")).toBe("每天自动签到");
    expect(checkinSwitchText("mixed")).toBe("部分自动签到");
    expect(checkinSwitchText("off")).toBe("不自动签到");
  });

  it("改写：一条命令一扇开关，开或关同一个形状", () => {
    expect(checkinSwitchArgs(true)).toEqual([
      ["settings", "set", "workbuddyCheckin", "on"],
      ["settings", "set", "qoderCheckin", "on"],
      ["settings", "set", "traeCheckin", "on"],
      ["settings", "set", "minimaxCheckin", "on"],
    ]);
    expect(checkinSwitchArgs(false)[0]).toEqual(["settings", "set", "workbuddyCheckin", "off"]);
  });
});
