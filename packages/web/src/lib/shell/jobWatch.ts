/**
 * 后台作业的「跑完了记得叫我」——d.182。
 *
 * 为什么需要它：d.180 让命令可以起成后台作业，但作业不会被 await。模型起完作业说一句
 * 「已经开始了，跑完我再继续」就收口了；此刻**没有任何东西会再叫醒它**——用户得自己回来
 * 问一句「好了没」。真实长任务里这几乎必然发生：一次 `pnpm build` 两三分钟，模型不可能
 * 一直挂着轮询（那会把工具轮次和 token 都烧光）。
 *
 * 这里只做「盯」这一件事：在回合收口之后、由界面继续定时读作业状态，全部结束（或超时）
 * 就回调一次。要不要继续对话由界面决定（和 `RoundLimitHint` 一致：给一个明确的按钮，
 * 不偷偷替用户花 token）。
 */

import type { ShellBridge, ShellFailure, ShellJobOutputResponse, ShellJobSummary } from "./bridge.js";

/** 轮询间隔：作业输出是按「未读缓冲」增量给的，1.5 秒粒度对构建/测试类命令足够细。 */
export const JOB_WATCH_POLL_MS = 1_500;

/** 最长盯多久：超过这个时间就不再替用户等，交回界面显示「还在跑」。 */
export const JOB_WATCH_MAX_MS = 30 * 60 * 1_000;

/** 单个作业的最终状态（能拿到多少就给多少：拿不到退出码时 `exitCode` 为 null）。 */
export interface WatchedJob {
  jobId: string;
  running: boolean;
  exitCode: number | null;
  /** 最后读到的增量输出（可能为空：作业早就在上一次读里结束）。 */
  stdout: string;
  stderr: string;
  /** 没等到结束就被超时/中断停下的，标出来——别把「还在跑」写成「完成了」。 */
  timedOut?: boolean;
}

export interface WatchJobsOptions {
  /** 显式要求 `jobOutput` 存在：调用方判断过 `hasJobBridge` 才进来，这里不再可选。 */
  bridge: { jobOutput: NonNullable<ShellBridge["jobOutput"]> };
  jobIds: readonly string[];
  signal?: AbortSignal;
  pollMs?: number;
  maxMs?: number;
  /** 每次轮询后回调一次（界面可用来显示「还在跑 2 个」）。 */
  onTick?: (states: WatchedJob[]) => void;
}

export interface WatchJobsResult {
  jobs: WatchedJob[];
  /** 全部作业都已结束（没有 timedOut / 没有中断）。 */
  allFinished: boolean;
  /** 被中断（用户离开会话、点了停止）或超时。 */
  stopped: boolean;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
    signal?.addEventListener("abort", finish, { once: true });
  });
}

/**
 * 盯一批后台作业直到它们全部结束。
 *
 * 语义刻意保守：
 * - 只读不写（`jobOutput` 是增量读，不杀进程、不改状态）；
 * - 一次读一个作业，不并发打桌面端（作业通道本身是串行队列）；
 * - 任何一次读取失败就当作「这个作业读不到了」，不再重试——界面要能说「状态未知」。
 */
export async function watchJobs(options: WatchJobsOptions): Promise<WatchJobsResult> {
  const { bridge, jobIds } = options;
  const pollMs = options.pollMs ?? JOB_WATCH_POLL_MS;
  const maxMs = options.maxMs ?? JOB_WATCH_MAX_MS;
  const startedAt = Date.now();

  const states = new Map<string, WatchedJob>();
  for (const jobId of jobIds) {
    states.set(jobId, { jobId, running: true, exitCode: null, stdout: "", stderr: "" });
  }

  const snapshot = (): WatchedJob[] => [...states.values()];
  let stopped = false;

  while (Date.now() - startedAt < maxMs) {
    if (options.signal?.aborted) {
      stopped = true;
      break;
    }
    let anyRunning = false;
    for (const jobId of jobIds) {
      const state = states.get(jobId)!;
      if (!state.running) continue;
      let res: ShellJobOutputResponse | ShellFailure;
      try {
        res = await bridge.jobOutput({ jobId, waitMs: pollMs });
      } catch {
        // 读失败：不再重试，按「状态未知但仍算在跑」处理，避免把失败写成完成。
        anyRunning = true;
        continue;
      }
      if (!res.ok) {
        // 作业被清理/不存在：也不再当「在跑」，直接标成已结束但退出码未知。
        state.running = false;
        state.exitCode = null;
        continue;
      }
      state.running = res.running;
      state.exitCode = res.exitCode;
      if (res.stdout) state.stdout = res.stdout;
      if (res.stderr) state.stderr = res.stderr;
      if (res.running) anyRunning = true;
    }
    options.onTick?.(snapshot());
    if (!anyRunning) break;
    await sleep(pollMs, options.signal);
  }

  if (options.signal?.aborted) stopped = true;
  const jobs = snapshot();
  const timedOut = Date.now() - startedAt >= maxMs && jobs.some((j) => j.running);
  if (timedOut) {
    stopped = true;
    for (const job of jobs) if (job.running) job.timedOut = true;
  }
  return { jobs, allFinished: !stopped && jobs.every((j) => !j.running), stopped };
}

/** 把完成情况压成一句给用户/模型看的话（退出码缺失时写「未知」，不编 0）。 */
export function summarizeWatchedJobs(jobs: readonly WatchedJob[]): string {
  const lines = jobs.map((job) => {
    const state = job.running
      ? job.timedOut
        ? "仍在运行（等待超时）"
        : "仍在运行"
      : job.exitCode === null
        ? "已结束（退出码未知）"
        : `已结束（退出码 ${job.exitCode}）`;
    return `- ${job.jobId}：${state}`;
  });
  return lines.join("\n");
}

/** 把完成情况变成「让模型继续干活」的一句话（不重发原提问，理由同 retryStream）。 */
export function jobContinuePrompt(jobs: readonly WatchedJob[]): string {
  const finished = jobs.filter((job) => !job.running);
  const head = finished.length > 0 ? "后台作业已经结束：" : "后台作业仍然在跑：";
  const body = summarizeWatchedJobs(jobs);
  const tail = finished.length > 0
    ? "\n\n请根据这些结果接着完成任务；需要看完整输出时用 `command_output` 再读（它只返回新增输出）。"
    : "\n\n可以先用 `command_output` 看看进展，或者告诉我先做别的。";
  return `${head}\n${body}${tail}`;
}

/** 列表里哪些还在跑（界面摘要用）。 */
export function runningJobs(jobs: readonly WatchedJob[], list?: readonly ShellJobSummary[]): string[] {
  const ids = new Set(jobs.filter((job) => job.running).map((job) => job.jobId));
  if (!list) return [...ids];
  return list.filter((job) => job.running && ids.has(job.id)).map((job) => job.id);
}
