import { describe, expect, it } from "vitest";
import {
  CHECKIN_VENDORS,
  DOMESTIC_AGENTS,
  DOMESTIC_KEY_NOTE,
  checkinFailed,
  checkinLine,
  checkinSummary,
  checkinVendorName,
  parseCheckin,
  parsePluginProviders,
  type CheckinEntry,
} from "./magpieDomestic.js";

/** 国内智能体端（d.280）：内核认这些端，但账号要插件才行，页面只负责说清楚。 */

function entry(patch: Partial<CheckinEntry>): CheckinEntry {
  return { user: "", vendor: "", outcome: "claimed", credit: 0, streak: 0, msg: "", ...patch };
}

describe("国内端清单", () => {
  it("只用内核确认过的 agent id 与插件包名", () => {
    const ids = DOMESTIC_AGENTS.map((item) => item.agent);
    expect(ids).toEqual(["workbuddy", "workbuddy-ai", "qoder", "qoder-cn", "mimo", "zcode"]);
    for (const item of DOMESTIC_AGENTS) {
      expect(item.pkg.startsWith("@magpie-community/")).toBe(true);
      expect(item.label.length).toBeGreaterThan(0);
      expect(item.desc.length).toBeGreaterThan(0);
    }
    // 一个包服务两个端：国际版与国内版同一套登录
    const workbuddy = DOMESTIC_AGENTS.find((item) => item.agent === "workbuddy");
    const workbuddyAi = DOMESTIC_AGENTS.find((item) => item.agent === "workbuddy-ai");
    expect(workbuddy?.pkg).toBe(workbuddyAi?.pkg);
    expect(workbuddy?.agent).not.toBe(workbuddyAi?.agent);
  });

  it("会封号的端都写了风险，能签到的端都标了签到", () => {
    expect(DOMESTIC_AGENTS.filter((item) => item.risk).map((item) => item.agent)).toEqual([
      "workbuddy",
      "workbuddy-ai",
    ]);
    expect(DOMESTIC_AGENTS.filter((item) => item.checkin).map((item) => item.agent)).toEqual([
      "workbuddy",
      "workbuddy-ai",
      "qoder",
      "qoder-cn",
    ]);
  });

  it("说清哪些国内端不在账号里", () => {
    for (const name of ["Qwen Code", "Kimi Code", "MiniMax Code"]) {
      expect(DOMESTIC_KEY_NOTE).toContain(name);
    }
    expect(CHECKIN_VENDORS).toContain("WorkBuddy");
    expect(CHECKIN_VENDORS).toContain("Qoder");
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
    expect(parsePluginProviders('{"providers":[{"id":"mimo"}]}').has("mimo")).toBe(true);
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
    expect(checkinVendorName("plugin:")).toBe("插件");
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
