/**
 * 团队任务记录（d.347）的用例。
 *
 * 记录的价值是「活着能看进度、收口能回看」：这里测状态流转、成员归位、
 * 留档与上限；界面怎么排版由协作页的用例管。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TEAM_RUNS_KEY,
  TEAM_RUN_HISTORY_CAP,
  activeTeamRun,
  applyTeamProgress,
  beginTeamRun,
  clearTeamRuns,
  finishTeamRun,
  latestTeamRun,
  listTeamRuns,
  reloadTeamRuns,
  resetTeamRuns,
  teamMemberRole,
  teamRunMembersOf,
} from "./teamRuns.js";
import type { TeamPlan } from "./team.js";
import { parseSubagentDefs } from "./subagentDefs.js";

function begin(goal = "把登录链路摸清", conversationId = "c1") {
  return beginTeamRun({
    conversationId,
    goal,
    members: [
      { id: "scan", role: "通用成员", task: "列出 auth 文件" },
      { id: "review", role: "安全审查", task: "按威胁模型逐条对" },
    ],
    now: 1_000,
  });
}

beforeEach(() => {
  localStorage.clear();
  clearTeamRuns();
});

afterEach(() => {
  clearTeamRuns();
});

describe("团队任务记录（d.347）", () => {
  it("开始时每位成员都是 pending，并成为当前活跃任务", () => {
    begin();
    const run = activeTeamRun();
    expect(run).not.toBeNull();
    expect(run?.goal).toBe("把登录链路摸清");
    expect(run?.members.map((member) => member.status)).toEqual(["pending", "pending"]);
  });

  it("进度按 memberId 归位：轮次、工具次数、状态", () => {
    begin();
    applyTeamProgress({ taskId: "t1", memberId: "scan", task: "列出 auth 文件", phase: "start", round: 0, role: "通用成员" }, 2_000);
    applyTeamProgress({ taskId: "t1", memberId: "scan", task: "列出 auth 文件", phase: "tool", round: 1, tool: "file_glob", role: "通用成员" }, 3_000);
    applyTeamProgress({ taskId: "t1", memberId: "scan", task: "列出 auth 文件", phase: "done", round: 2, role: "通用成员" }, 4_000);
    const member = activeTeamRun()?.members.find((item) => item.id === "scan");
    expect(member?.status).toBe("done");
    expect(member?.rounds).toBe(2);
    expect(member?.toolCalls).toBe(1);
  });

  it("收口后不再是活跃任务，成员状态与整次成败一致", () => {
    begin();
    finishTeamRun(
      {
        ok: false,
        members: [
          { id: "scan", role: "通用成员", task: "列出 auth 文件", ok: true, rounds: 2, toolCalls: 1, text: "x" },
          { id: "review", role: "安全审查", task: "按威胁模型逐条对", ok: false, rounds: 1, toolCalls: 0, text: "y" },
        ],
      },
      5_000,
    );
    expect(activeTeamRun()).toBeNull();
    const run = latestTeamRun("c1");
    expect(run?.status).toBe("failed");
    expect(run?.endedAt).toBe(5_000);
    expect(run?.members.find((item) => item.id === "scan")?.status).toBe("done");
    expect(run?.members.find((item) => item.id === "review")?.status).toBe("failed");
  });

  it("留档只写收口的任务，重新打开还能回看", () => {
    begin("第一支队伍");
    finishTeamRun({ ok: true, members: [] }, 2_000);
    begin("第二支队伍");
    const raw = localStorage.getItem(TEAM_RUNS_KEY);
    expect(raw).not.toBeNull();
    expect(raw).not.toContain("第二支队伍");
    finishTeamRun({ ok: true, members: [] }, 3_000);
    reloadTeamRuns();
    expect(listTeamRuns().map((run) => run.goal)).toEqual(["第一支队伍", "第二支队伍"]);
  });

  it("并行派遣两支队伍时，进度与收口各归各的、成功不被记成失败（d.412 回归）", () => {
    // agent_team 是只读工具，同一条消息里可能并行派遣两次 → 同时存在两条 running。
    // 事件不带 runId，只能按成员 id 归位；旧版 activeTeamRun() 取最后一条，
    // 把两队的进度/收口都记到 B 上，A、B 两支队都被标成「没有执行（被中断）」。
    beginTeamRun({
      conversationId: "c1",
      goal: "TEAM-A",
      members: [{ id: "aScan", role: "通用成员", task: "扫描 A" }],
    });
    beginTeamRun({
      conversationId: "c1",
      goal: "TEAM-B",
      members: [{ id: "bDig", role: "通用成员", task: "挖掘 B" }],
    });

    // 两队各自的进度：应落到各自的记录
    applyTeamProgress({ taskId: "t", memberId: "aScan", task: "扫描 A", phase: "start", round: 0, role: "通用成员" }, 2_000);
    applyTeamProgress({ taskId: "t", memberId: "bDig", task: "挖掘 B", phase: "start", round: 0, role: "通用成员" }, 2_000);

    // 两队都成功收口
    finishTeamRun(
      { ok: true, members: [{ id: "aScan", role: "通用成员", task: "扫描 A", ok: true, rounds: 2, toolCalls: 1, text: "done" }] },
      3_000,
    );
    finishTeamRun(
      { ok: true, members: [{ id: "bDig", role: "通用成员", task: "挖掘 B", ok: true, rounds: 2, toolCalls: 1, text: "done" }] },
      3_000,
    );

    const persisted = JSON.parse(localStorage.getItem(TEAM_RUNS_KEY) ?? "[]") as {
      goal: string;
      status: string;
      members: { id: string; status: string; note: string | null }[];
    }[];
    const a = persisted.find((run) => run.goal === "TEAM-A");
    const b = persisted.find((run) => run.goal === "TEAM-B");
    expect(a?.status).toBe("done");
    expect(a?.members[0]?.status).toBe("done");
    expect(b?.status).toBe("done");
    expect(b?.members[0]?.status).toBe("done");
    expect(a?.members[0]?.note).not.toBe("没有执行（被中断）");
    expect(b?.members[0]?.note).not.toBe("没有执行（被中断）");
  });

  it("按会话取最近一次：别的会话的团队不串台", () => {
    begin("A 会话的任务", "c1");
    finishTeamRun({ ok: true, members: [] }, 2_000);
    begin("B 会话的任务", "c2");
    finishTeamRun({ ok: true, members: [] }, 3_000);
    expect(latestTeamRun("c1")?.goal).toBe("A 会话的任务");
    expect(latestTeamRun("c2")?.goal).toBe("B 会话的任务");
  });

  it("切会话只清在跑的那次，收口记录留着", () => {
    begin("跑着的", "c1");
    begin("收口的", "c2");
    finishTeamRun({ ok: true, members: [] }, 2_000);
    resetTeamRuns();
    expect(listTeamRuns().map((run) => run.goal)).toEqual(["收口的"]);
  });

  it(`留档最多 ${TEAM_RUN_HISTORY_CAP} 次`, () => {
    for (let i = 0; i < TEAM_RUN_HISTORY_CAP + 3; i += 1) {
      begin(`第 ${i} 次`);
      finishTeamRun({ ok: true, members: [] }, 2_000 + i);
    }
    const raw = localStorage.getItem(TEAM_RUNS_KEY);
    const parsed = JSON.parse(raw ?? "[]") as unknown[];
    expect(parsed).toHaveLength(TEAM_RUN_HISTORY_CAP);
  });

  it("坏档不炸：读不出来就当没有", () => {
    localStorage.setItem(TEAM_RUNS_KEY, "{not json");
    expect(() => reloadTeamRuns()).not.toThrow();
    expect(listTeamRuns()).toEqual([]);
  });

  it("成员角色按工作区定义解析，没点名就是通用成员", () => {
    const defs = parseSubagentDefs([
      { rel: ".heming/agents/review.md", text: "# 安全审查\n> 按威胁模型逐条对\n只挑安全问题。" },
    ]);
    expect(teamMemberRole("review", defs)).toBe("安全审查");
    expect(teamMemberRole(null, defs)).toBe("通用成员");
    const plan: TeamPlan = {
      goal: "g",
      maxRounds: 2,
      members: [
        { id: "a", agent: "review", task: "x", needs: [], write: false },
        { id: "b", agent: null, task: "y", needs: [], write: false },
      ],
    };
    expect(teamRunMembersOf(plan, defs)).toEqual([
      { id: "a", role: "安全审查", task: "x" },
      { id: "b", role: "通用成员", task: "y" },
    ]);
  });
});
