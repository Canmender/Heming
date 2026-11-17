import { describe, it, expect } from "vitest";
import type { AssignedTeamTask } from "./assignedTasks.js";
import { buildClaimTaskPrompt, buildMyTaskPrompt, describeMyTaskMeta } from "./myTaskPrompt.js";

/**
 * 「我的任务」→ 一条用户消息（d.259）。
 *
 * 断言只看「该说的说清、缺的如实写、不替用户决定」：需求原文/截止/前置/交付规矩。
 */

const NOW = Date.parse("2026-11-17T12:00:00.000Z");

function task(over: Partial<AssignedTeamTask["task"]> = {}, blocked?: AssignedTeamTask["openBlockers"]): AssignedTeamTask {
  return {
    teamId: "t1",
    teamName: "产品组",
    task: {
      id: "k1",
      title: "整理接口文档",
      detail: "把 v2 的接口整理成一份 md",
      status: "todo",
      dueAt: "2026-11-18T12:00:00.000Z",
      assigneeId: "u2",
      ...over,
    },
    ...(blocked === undefined ? {} : { openBlockers: blocked }),
  };
}

describe("我的任务：变成一句话就能接着做（d.259）", () => {
  it("把团队、id、标题、需求、截止都写进消息，并带上 done + result 的交付规矩", () => {
    const prompt = buildMyTaskPrompt(task(), NOW);
    expect(prompt).toContain("请接着做这条团队任务");
    expect(prompt).toContain("团队：产品组");
    expect(prompt).toContain("任务 id：k1");
    expect(prompt).toContain("标题：整理接口文档");
    expect(prompt).toContain("需求：把 v2 的接口整理成一份 md");
    expect(prompt).toContain("截止：明天");
    expect(prompt).toContain("team_task_update");
    expect(prompt).toContain("result");
    expect(prompt).toContain("不该由你来做");
  });

  it("没写需求说明时如实说，让模型先去看完整上下文", () => {
    const prompt = buildMyTaskPrompt(task({ detail: "  " }), NOW);
    expect(prompt).toContain("没写需求说明");
    expect(prompt).toContain("team_get");
  });

  it("没截止、没有前置时不留空行噪声", () => {
    const prompt = buildMyTaskPrompt(task({ dueAt: null }), NOW);
    expect(prompt).not.toContain("截止：");
    expect(prompt).not.toContain("注意：");
  });

  it("前置没做完时写明「先确认前置真的完成了」", () => {
    const prompt = buildMyTaskPrompt(
      task({}, [{ id: "k0", title: "先定接口规范" }]),
      NOW,
    );
    expect(prompt).toContain("前置还没完成");
    expect(prompt).toContain("先定接口规范");
    expect(prompt).toContain("先确认前置");
  });

  it("卡片副标题按「团队 · 状态 · 截止 · 前置」拼，缺项就少一段", () => {
    expect(describeMyTaskMeta(task(), NOW)).toBe("产品组 · 未开始 · 明天截止");
    expect(describeMyTaskMeta(task({ status: "doing", dueAt: null }), NOW)).toBe("产品组 · 在做");
    expect(
      describeMyTaskMeta(task({}, [{ id: "k0", title: "先定接口规范" }]), NOW),
    ).toContain("前置还没完成");
  });
});

describe("待认领的活：先认领再动手（d.260）", () => {
  it("先写清认领动作，再给做完标 done + result 的规矩", () => {
    const prompt = buildClaimTaskPrompt(task(), NOW);
    expect(prompt).toContain("先认领");
    expect(prompt).toContain("assignee_id");
    expect(prompt).toContain("team_task_update");
    expect(prompt).toContain("整理接口文档");
    expect(prompt).toContain("result");
    expect(prompt).toContain("不该由你做");
  });

  it("没写需求时如实说，并保留截止与前置提醒", () => {
    const prompt = buildClaimTaskPrompt(
      task({ detail: "   " }, [{ id: "k0", title: "先定接口规范" }]),
      NOW,
    );
    expect(prompt).toContain("没写需求说明");
    expect(prompt).toContain("先定接口规范");
    expect(prompt).toContain("截止：明天");
  });
});

describe("退回过的活：认领前先说清上个负责人为什么退（d.261）", () => {
  it("带退回原因时写进提示词：先看看上一个人为什么做不了", () => {
    const prompt = buildClaimTaskPrompt(
      task({ assigneeId: null, returnedAt: "2026-11-17T08:00:00.000Z", returnNote: "没有发布权限，需要管理员" }),
      NOW,
    );
    expect(prompt).toContain("上一个负责人退回时说过：没有发布权限，需要管理员");
  });

  it("没有退回痕迹时不写这一行（不凭空编原因）", () => {
    const prompt = buildClaimTaskPrompt(task({ assigneeId: null }), NOW);
    expect(prompt).not.toContain("上一个负责人退回时说过");
  });
});

describe("进展：接着做之前先看看走到哪了（d.262）", () => {
  it("我的任务提示词带上上次进展，并说明接着做而不是重来", () => {
    const prompt = buildMyTaskPrompt(
      task({ progress: "接口契约已对齐，正在写 handler", progressAt: "2026-11-17T08:00:00.000Z" }),
      NOW,
    );
    expect(prompt).toContain("上次进展：接口契约已对齐，正在写 handler");
    expect(prompt).toContain("不要从头重来");
  });

  it("认领提示词同样带上进展；没有进展时不写这一行", () => {
    const withProgress = buildClaimTaskPrompt(
      task({ assigneeId: null, progress: "写了一半", progressAt: "2026-11-17T08:00:00.000Z" }),
      NOW,
    );
    expect(withProgress).toContain("上次进展：写了一半");
    const bare = buildClaimTaskPrompt(task({ assigneeId: null }), NOW);
    expect(bare).not.toContain("上次进展");
  });
});

describe("被催办过的活，提示词里先说一句（d.265）", () => {
  it("有催办痕迹时写明催了几次、最近一次什么时候，并要求先说明进展", () => {
    const prompt = buildMyTaskPrompt(
      {
        teamId: "t1",
        teamName: "产品组",
        task: {
          id: "k1",
          title: "整理接口文档",
          detail: "按新接口重写",
          status: "doing",
          dueAt: null,
          assigneeId: "u1",
          nudgedAt: "2026-11-17T10:00:00.000Z",
          nudgedBy: "u2",
          nudgeCount: 2,
        },
      },
      new Date("2026-11-17T12:00:00.000Z").getTime(),
    );
    expect(prompt).toContain("组长催过 2 次");
    expect(prompt).toContain("先说明现在进展");
  });

  it("没被催过时不出现这一段", () => {
    const prompt = buildMyTaskPrompt(
      {
        teamId: "t1",
        teamName: "产品组",
        task: { id: "k1", title: "整理接口文档", detail: "", status: "todo", dueAt: null, assigneeId: "u1" },
      },
      Date.now(),
    );
    expect(prompt).not.toContain("组长催过");
  });
});
