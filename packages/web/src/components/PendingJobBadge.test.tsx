import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PendingJobBadge } from "./PendingJobBadge.js";
import {
  enqueueSubagentJob,
  resetSubagentJobs,
  takeUndeliveredJobs,
} from "../lib/agentRuntime/subagentJobs.js";

function start(conversationId = "c1") {
  return {
    conversationId,
    agentId: "a1",
    agentName: "和小鸣",
    label: "查入口",
    task: "查入口在哪",
    taskId: "bg-badge",
    run: () => Promise.resolve({ ok: true, text: "入口在 core/app.ts", rounds: 1, toolCalls: 2 }),
  };
}

afterEach(() => {
  act(() => resetSubagentJobs());
});

describe("PendingJobBadge · 侧栏的「结论」徽标（d.383）", () => {
  it("有结论没送进去时出现，点开会话（取走）后消失", async () => {
    render(<PendingJobBadge conversationId="c1" />);
    expect(screen.queryByTestId("pending-job-badge")).toBeNull();

    await act(async () => {
      enqueueSubagentJob(start());
      // 让 run 的 promise 落地，作业进入 done + 未交付
      await Promise.resolve();
    });

    const badge = await screen.findByTestId("pending-job-badge");
    expect(badge).toHaveTextContent("结论");
    expect(badge.getAttribute("title")).toContain("1 条后台子代理的结论");

    await act(async () => {
      takeUndeliveredJobs("c1");
    });
    expect(screen.queryByTestId("pending-job-badge")).toBeNull();
  });

  it("别的会话的结论不算在这个会话头上", async () => {
    render(<PendingJobBadge conversationId="c1" />);
    await act(async () => {
      enqueueSubagentJob(start("c2"));
      await Promise.resolve();
    });
    expect(screen.queryByTestId("pending-job-badge")).toBeNull();
  });
});
