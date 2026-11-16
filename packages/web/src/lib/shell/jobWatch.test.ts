import { describe, it, expect, vi } from "vitest";
import {
  JOB_WATCH_MAX_MS,
  JOB_WATCH_POLL_MS,
  jobContinuePrompt,
  runningJobs,
  summarizeWatchedJobs,
  watchJobs,
} from "./jobWatch.js";
import type { ShellJobOutputResponse } from "./bridge.js";

function output(jobId: string, running: boolean, exitCode: number | null, stdout = ""): ShellJobOutputResponse {
  return { ok: true, jobId, running, exitCode, stdout, stderr: "" } as unknown as ShellJobOutputResponse;
}

describe("盯后台作业（d.182）", () => {
  it("作业一开始就结束：只读一次、不空转轮询", async () => {
    const jobOutput = vi.fn(async () => output("job-1", false, 0, "done"));
    const result = await watchJobs({ bridge: { jobOutput }, jobIds: ["job-1"], pollMs: 1 });

    expect(jobOutput).toHaveBeenCalledTimes(1);
    expect(result.allFinished).toBe(true);
    expect(result.stopped).toBe(false);
    expect(result.jobs[0]).toMatchObject({ jobId: "job-1", running: false, exitCode: 0, stdout: "done" });
  });

  it("还在跑就继续读，直到结束（并保留最后一段输出）", async () => {
    let calls = 0;
    const jobOutput = vi.fn(async () => {
      calls += 1;
      return calls < 3 ? output("job-1", true, null, "building…") : output("job-1", false, 1, "boom");
    });
    const result = await watchJobs({ bridge: { jobOutput }, jobIds: ["job-1"], pollMs: 1 });

    expect(jobOutput).toHaveBeenCalledTimes(3);
    expect(result.allFinished).toBe(true);
    expect(result.jobs[0]!.exitCode).toBe(1);
    expect(result.jobs[0]!.stdout).toBe("boom");
  });

  it("读失败不算完成：不把「状态未知」写成「跑完了」", async () => {
    const jobOutput = vi.fn(async () => {
      throw new Error("ipc 断了");
    });
    const result = await watchJobs({ bridge: { jobOutput }, jobIds: ["job-1"], pollMs: 1, maxMs: 5 });

    expect(result.allFinished).toBe(false);
    expect(result.stopped).toBe(true);
    expect(result.jobs[0]!.running).toBe(true);
    expect(result.jobs[0]!.timedOut).toBe(true);
  });

  it("作业已被清理（unknown-job）按「已结束、退出码未知」记，不报错", async () => {
    const jobOutput = vi.fn(async () => ({
      ok: false as const,
      code: "unknown-job" as const,
      error: "没有这个作业",
    }));
    const result = await watchJobs({ bridge: { jobOutput }, jobIds: ["job-9"], pollMs: 1 });

    expect(result.stopped).toBe(false);
    expect(result.jobs[0]).toMatchObject({ jobId: "job-9", running: false, exitCode: null });
  });

  it("用户中断就立刻停，并把已拿到的状态带回去", async () => {
    const controller = new AbortController();
    const jobOutput = vi.fn(async () => {
      controller.abort();
      return output("job-1", true, null, "还在跑");
    });
    const result = await watchJobs({ bridge: { jobOutput }, jobIds: ["job-1"], pollMs: 1, signal: controller.signal });

    expect(result.stopped).toBe(true);
    expect(result.allFinished).toBe(false);
    expect(jobOutput).toHaveBeenCalledTimes(1);
  });

  it("超时会把还在跑的作业标成 timedOut", async () => {
    const jobOutput = vi.fn(async () => output("job-1", true, null, "跑不完"));
    const result = await watchJobs({ bridge: { jobOutput }, jobIds: ["job-1"], pollMs: 1, maxMs: 3 });

    expect(result.stopped).toBe(true);
    expect(result.jobs[0]!.timedOut).toBe(true);
    expect(JOB_WATCH_MAX_MS).toBeGreaterThan(JOB_WATCH_POLL_MS);
  });

  it("多个作业：一个结束、一个还在跑，进度里两个都能看到", async () => {
    const jobOutput = vi.fn(async ({ jobId }: { jobId: string }) =>
      jobId === "a" ? output("a", false, 0, "ok") : output("b", true, null, ""));
    const seen: number[] = [];
    const result = await watchJobs({
      bridge: { jobOutput },
      jobIds: ["a", "b"],
      pollMs: 1,
      maxMs: 4,
      onTick: (states) => seen.push(states.filter((s) => !s.running).length),
    });

    expect(result.stopped).toBe(true);
    expect(seen.some((n) => n === 1)).toBe(true);
    expect(result.jobs.find((job) => job.jobId === "b")!.timedOut).toBe(true);
  });

  it("摘要与续写口令：退出码未知时写「未知」，不编 0", () => {
    const jobs = [
      { jobId: "job-1", running: false, exitCode: 0, stdout: "", stderr: "" },
      { jobId: "job-2", running: false, exitCode: null, stdout: "", stderr: "" },
      { jobId: "job-3", running: true, exitCode: null, stdout: "", stderr: "" },
    ];
    const summary = summarizeWatchedJobs(jobs);
    expect(summary).toContain("job-1：已结束（退出码 0）");
    expect(summary).toContain("job-2：已结束（退出码未知）");
    expect(summary).toContain("job-3：仍在运行");

    const prompt = jobContinuePrompt(jobs);
    expect(prompt).toContain("后台作业已经结束");
    expect(prompt).toContain("command_output");
    expect(prompt).toContain("job-2：已结束（退出码未知）");
  });

  it("runningJobs 按 id 过滤（与 command_list 的字段名不同：列表用 id）", () => {
    const watched = [
      { jobId: "a", running: true, exitCode: null, stdout: "", stderr: "" },
      { jobId: "b", running: false, exitCode: 0, stdout: "", stderr: "" },
    ];
    const list = [
      { id: "a", command: "x", cwd: ".", running: true, exitCode: null, startedAt: 0, finishedAt: null, bytes: 0, dropped: 0 },
      { id: "b", command: "y", cwd: ".", running: false, exitCode: 0, startedAt: 0, finishedAt: 1, bytes: 1, dropped: 0 },
    ];
    expect(runningJobs(watched, list)).toEqual(["a"]);
    expect(runningJobs(watched)).toEqual(["a"]);
  });
});
