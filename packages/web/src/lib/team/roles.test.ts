/**
 * 团队角色口径（d.249）：创建者即组长，组长才能把任务派给别人。
 *
 * 这些判定单独放一处，是因为它们同时被三处使用：成员下拉（谁能被指）、
 * 任务行的「负责」选择（谁能改派）、以及说明文案。服务端有同一套校验
 * （`not_leader`），界面这边只是少放一个选项，不重复业务实现。
 */

import { describe, expect, it } from "vitest";

import {
  assigneeAgentHint,
  isTeamLeader,
  LEADER_ASSIGN_HINT,
  memberLabel,
  teamRoleText,
} from "./roles.js";

describe("团队角色口径（d.249）", () => {
  const team = { ownerId: "u-owner" };

  it("创建者就是组长，其他人是成员", () => {
    expect(isTeamLeader(team, "u-owner")).toBe(true);
    expect(isTeamLeader(team, "u-other")).toBe(false);
    expect(teamRoleText(team, "u-owner")).toBe("组长");
    expect(teamRoleText(team, "u-other")).toBe("成员");
  });

  it("拿不到团队或用户时一律按成员处理（宁可不放行）", () => {
    expect(isTeamLeader(null, "u-owner")).toBe(false);
    expect(isTeamLeader({}, "u-owner")).toBe(false);
    expect(isTeamLeader({ ownerId: null }, "u-owner")).toBe(false);
    expect(isTeamLeader(team, "")).toBe(false);
    expect(isTeamLeader(team, null)).toBe(false);
    expect(teamRoleText(null, "u-owner")).toBe("成员");
  });

  it("成员下拉里组长的名字带后缀", () => {
    expect(memberLabel({ id: "u-owner", displayName: "李雷" }, team)).toBe("李雷（组长）");
    expect(memberLabel({ id: "u-other", displayName: "韩梅梅" }, team)).toBe("韩梅梅");
    // 团队信息还没加载出来时不要乱加后缀
    expect(memberLabel({ id: "u-owner", displayName: "李雷" }, null)).toBe("李雷");
  });

  it("说明文案说清边界，也给出可行的做法", () => {
    expect(LEADER_ASSIGN_HINT).toContain("只有组长能把任务派给别人");
    expect(LEADER_ASSIGN_HINT).toContain("给自己派活");
    expect(assigneeAgentHint("韩梅梅")).toContain("韩梅梅 的智能体");
    expect(assigneeAgentHint("韩梅梅")).toContain("下一轮");
  });
});
