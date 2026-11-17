import { describe, it, expect } from "vitest";
import type { TeamBrief } from "@heming/shared";
import {
  TEAM_BRIEF_GOAL_MAX,
  TEAM_BRIEF_MEMBERS_MAX,
  TEAM_BRIEF_TEAMS_MAX,
  describeTeamBriefLines,
} from "./teamBrief.js";

function brief(overrides: Partial<TeamBrief> = {}): TeamBrief {
  return {
    id: "team-1",
    name: "产品组",
    goal: "",
    ownerId: "u-1",
    role: "owner",
    counts: { open: 0, done: 0, overdue: 0, unassigned: 0, blocked: 0 },
    members: [
      { id: "u-1", displayName: "阿鸣", role: "owner", open: 0 },
      { id: "u-2", displayName: "小李", role: "member", open: 0 },
    ],
    ...overrides,
  };
}

describe("团队简报进提示词（d.253）", () => {
  it("没有团队就什么都不写", () => {
    expect(describeTeamBriefLines([])).toEqual([]);
  });

  it("组长：写清团队名、我的身份、成员名字与 id", () => {
    const lines = describeTeamBriefLines([brief()]);
    const text = lines.join("\n");
    expect(text).toContain("## 团队（你在的）");
    expect(text).toContain("产品组（你是组长）");
    expect(text).toContain("阿鸣（u-1，组长）");
    expect(text).toContain("小李（u-2）");
  });

  it("成员：如实写「你是成员」，不冒充组长", () => {
    const lines = describeTeamBriefLines([brief({ role: "member", ownerId: "u-9" })]);
    expect(lines.join("\n")).toContain("产品组（你是成员）");
  });

  it("团队目标太长要截断，不能把预算吃光", () => {
    const goal = "把".repeat(TEAM_BRIEF_GOAL_MAX + 20);
    const text = describeTeamBriefLines([brief({ goal })]).join("\n");
    expect(text).toContain(`目标「${"把".repeat(TEAM_BRIEF_GOAL_MAX - 1)}…」`);
    expect(text).not.toContain("把".repeat(TEAM_BRIEF_GOAL_MAX + 1));
  });

  it("成员多、团队多都只列上限，并如实说还有多少", () => {
    const members = Array.from({ length: TEAM_BRIEF_MEMBERS_MAX + 2 }, (_, index) => ({
      id: `u-${index}`,
      displayName: `成员${index}`,
      role: (index === 0 ? "owner" : "member") as "owner" | "member",
      open: 0,
    }));
    const teams = Array.from({ length: TEAM_BRIEF_TEAMS_MAX + 1 }, (_, index) =>
      brief({ id: `team-${index}`, name: `团队${index}`, members }),
    );
    const text = describeTeamBriefLines(teams).join("\n");
    expect(text).toContain(`等 ${members.length} 人`);
    expect(text).toContain(`还有 1 个团队没列出来（用 team_list 看全部）`);
  });

  it("概览：未完成/逾期/待认领/被前置卡都写出来（d.256）", () => {
    const text = describeTeamBriefLines([
      brief({ counts: { open: 4, done: 2, overdue: 1, unassigned: 1, blocked: 1 } }),
    ]).join("\n");
    expect(text).toContain("任务：4 项未完成（逾期 1、待认领 1、被前置卡住 1）");
  });

  it("概览：全清时明说没有未完成", () => {
    const text = describeTeamBriefLines([brief({ counts: { open: 0, done: 3, overdue: 0, unassigned: 0, blocked: 0 } })]).join("\n");
    expect(text).toContain("任务：没有未完成（已完成 3 项）");
  });

  it("成员手上有活才写「N 项未完成」", () => {
    const text = describeTeamBriefLines([
      brief({
        members: [
          { id: "u-1", displayName: "阿鸣", role: "owner", open: 2 },
          { id: "u-2", displayName: "小李", role: "member", open: 0 },
        ],
      }),
    ]).join("\n");
    expect(text).toContain("阿鸣（u-1，组长，2 项未完成）");
    expect(text).toContain("小李（u-2）");
  });

  it("规则说明按概览回答进度，别逐个翻", () => {
    const text = describeTeamBriefLines([brief()]).join("\n");
    expect(text).toContain("被问进度时按上面每行的数字回答");
    expect(text).toContain("不要逐个团队 team_get 去数");
    expect(text).toContain("先调 team_digest");
  });

  it("规则说清「写 assigneeId」「只能同队」「成员别往别人名下派」", () => {
    const text = describeTeamBriefLines([brief()]).join("\n");
    expect(text).toContain("team_task_add");
    expect(text).toContain("assigneeId");
    expect(text).toContain("只能是同队成员");
    expect(text).toContain("不要往别人名下派");
    expect(text).toContain("不要凭印象编一个 id");
  });
});
