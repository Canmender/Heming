import { describe, expect, it, vi } from "vitest";
import type { ShellBridge, ShellJobSummary } from "./bridge.js";
import {
  JOB_PANEL_POLL_MS,
  killPanelJob,
  listPanelJobs,
  pollPanelJobs,
  previewPanelJob,
  resetPanelJobs,
  setPanelJobPreview,
  subscribePanelJobs,
  syncPanelJobs,
  hasRunningPanelJobs,
} from "./jobPanel.js";

/** 造一条主进程作业摘要：默认在跑。 */
function summary(extra: Partial<ShellJobSummary> = {}): ShellJobSummary {
  return {
    id: "job-1",
    command: "pnpm test",
    cwd: "D:/repo",
    running: true,
    exitCode: null,
    startedAt: 1_000,
    finishedAt: null,
    bytes: 0,
    dropped: 0,
    ...extra,
  };
}

/** 最小可用的假桥：只实现面板用到的方法，其余留空由调用方补。 */
function fakeBridge(overrides: Partial<ShellBridge> = {}): ShellBridge {
  return {
    run: async () => ({ ok: false, code: "spawn-failed", error: "not used" }),
    ...overrides,
  };
}

describe("后台作业面板数据层（d.203）", () => {
  it("合并主进程作业表：新增按开始时间旧→新排列，重复同步不重复插入", () => {
    resetPanelJobs();
    syncPanelJobs([
      summary({ id: "job-2", startedAt: 2_000 }),
      summary({ id: "job-1", startedAt: 1_000 }),
    ]);
    expect(listPanelJobs().map((job) => job.id)).toEqual(["job-1", "job-2"]);
    syncPanelJobs([summary({ id: "job-1", startedAt: 1_000 })]);
    expect(listPanelJobs()).toHaveLength(2);
    resetPanelJobs();
  });

  it("同步只更新事实字段，保留已预览的输出（用户可能正看着那一段）", () => {
    resetPanelJobs();
    syncPanelJobs([summary({ id: "job-1" })]);
    setPanelJobPreview("job-1", "第一行\n第二行", false);
    syncPanelJobs([
      summary({ id: "job-1", running: false, exitCode: 0, finishedAt: 5_000, bytes: 128 }),
    ]);
    const job = listPanelJobs()[0];
    expect(job.running).toBe(false);
    expect(job.exitCode).toBe(0);
    expect(job.preview).toBe("第一行\n第二行");
    resetPanelJobs();
  });

  it("超过上限先丢最旧的已完成作业，跑着的一条都不丢", () => {
    resetPanelJobs();
    const rows: ShellJobSummary[] = [];
    for (let i = 0; i < 25; i += 1) {
      rows.push(
        summary({
          id: `done-${i}`,
          running: false,
          exitCode: 0,
          startedAt: i,
          finishedAt: i + 1,
        }),
      );
    }
    rows.push(summary({ id: "running", startedAt: 100 }));
    syncPanelJobs(rows);
    const ids = listPanelJobs().map((job) => job.id);
    expect(ids).toContain("running");
    expect(ids.length).toBeLessThanOrEqual(20);
    expect(ids).toContain("done-24");
    resetPanelJobs();
  });

  it("hasRunningPanelJobs / 订阅：内容变化才通知，退订后不再通知", () => {
    resetPanelJobs();
    const listener = vi.fn();
    const unsubscribe = subscribePanelJobs(listener);
    expect(hasRunningPanelJobs()).toBe(false);
    syncPanelJobs([summary({ id: "job-1" })]);
    expect(hasRunningPanelJobs()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    // 同一个快照再同步一次：没有字段变化，不该再通知。
    syncPanelJobs([summary({ id: "job-1" })]);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    syncPanelJobs([summary({ id: "job-2", startedAt: 2_000 })]);
    expect(listener).toHaveBeenCalledTimes(1);
    resetPanelJobs();
  });

  it("pollPanelJobs：没有作业通道返回 false（界面据此不渲染面板）", async () => {
    expect(await pollPanelJobs(null)).toBe(false);
    expect(await pollPanelJobs(fakeBridge())).toBe(false);
  });

  it("pollPanelJobs：拉到作业表就合并进来", async () => {
    resetPanelJobs();
    const jobs = vi.fn(async () => ({ ok: true as const, jobs: [summary({ id: "job-9" })] }));
    expect(await pollPanelJobs(fakeBridge({ jobs }))).toBe(true);
    expect(listPanelJobs().map((job) => job.id)).toEqual(["job-9"]);
    expect(jobs).toHaveBeenCalledTimes(1);
    resetPanelJobs();
  });

  it("previewPanelJob：只读快照写进面板，stdout/stderr 都拼上，cut 如实记", async () => {
    resetPanelJobs();
    syncPanelJobs([summary({ id: "job-1" })]);
    const jobPreview = vi.fn(async () => ({
      ok: true as const,
      jobId: "job-1",
      running: true,
      exitCode: null,
      stdout: "构建中\n",
      stderr: "warning: x\n",
      cut: true,
      produced: 100,
      dropped: 0,
    }));
    expect(await previewPanelJob(fakeBridge({ jobPreview }), "job-1")).toBeNull();
    const job = listPanelJobs()[0];
    expect(job.preview).toContain("构建中");
    expect(job.preview).toContain("[stderr]");
    expect(job.preview).toContain("warning: x");
    expect(job.previewCut).toBe(true);
    resetPanelJobs();
  });

  it("previewPanelJob：老安装包缺 jobPreview / 桌面端报错时给可读文案", async () => {
    resetPanelJobs();
    expect(await previewPanelJob(fakeBridge(), "job-1")).toContain("不支持在界面上看作业日志");
    const jobPreview = vi.fn(async () => ({ ok: false as const, code: "unknown-job" as const, error: "没有这个作业（可能已被清理）" }));
    expect(await previewPanelJob(fakeBridge({ jobPreview }), "job-1")).toBe("没有这个作业（可能已被清理）");
    resetPanelJobs();
  });

  it("killPanelJob：真的杀了就刷新一次作业表；已结束就说「不需要停止」", async () => {
    resetPanelJobs();
    syncPanelJobs([summary({ id: "job-1" })]);
    const jobs = vi.fn(async () => ({
      ok: true as const,
      jobs: [summary({ id: "job-1", running: false, exitCode: 143, finishedAt: 3_000 })],
    }));
    const jobKill = vi.fn(async () => ({ ok: true as const, jobId: "job-1", killed: true, alreadyFinished: false }));
    expect(await killPanelJob(fakeBridge({ jobs, jobKill }), "job-1")).toBeNull();
    expect(listPanelJobs()[0].running).toBe(false);

    const already = vi.fn(async () => ({ ok: true as const, jobId: "job-1", killed: false, alreadyFinished: true }));
    expect(await killPanelJob(fakeBridge({ jobs, jobKill: already }), "job-1")).toBe("这条作业已经结束了，不需要停止。");
    resetPanelJobs();
  });

  it("killPanelJob：没有 jobKill 通道时明确说不支持，不假装停了", async () => {
    expect(await killPanelJob(fakeBridge(), "job-1")).toContain("不支持停止后台作业");
  });

  it("预览文本超长时只留末尾（面板不是日志查看器）", () => {
    resetPanelJobs();
    syncPanelJobs([summary({ id: "job-1" })]);
    setPanelJobPreview("job-1", "x".repeat(20_000) + "TAIL", false);
    const preview = listPanelJobs()[0].preview ?? "";
    expect(preview.endsWith("TAIL")).toBe(true);
    expect(preview.length).toBeLessThanOrEqual(16_000);
    resetPanelJobs();
  });

  it("轮询间隔是 2 秒（界面状态最多晚两秒）", () => {
    expect(JOB_PANEL_POLL_MS).toBe(2000);
  });
});
