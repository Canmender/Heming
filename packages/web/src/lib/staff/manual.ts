import { useLlmStore } from "../../store/llm.js";
import { inQuietHours, tokensToday, type StaffRun, type StaffTrigger } from "./model.js";
import { releaseStaffRun, tryAcquireStaffRun } from "./lock.js";
import { runStaffBrief } from "./runner.js";
import { liveFacts, refreshAgendaIfRunning } from "./runtime.js";
import { useStaffStore } from "./store.js";

export type StaffManualResult =
  | { ok: true; run: StaffRun }
  | { ok: false; reason: "busy" | "error"; error?: string };

/**
 * 用户主动运行（「现在跑一次」，以及首次开启时立即生成第一份晨报）。
 *
 * 与调度 tick 共用同一把锁：手动跑的时候 tick 不会插进来抢计划；
 * 手动运行不弹系统通知（用户就在界面前），也不受事件冷却与每日次数上限约束。
 */
export async function runStaffNow(
  trigger: StaffTrigger = "manual",
  opts: { signal?: AbortSignal } = {},
): Promise<StaffManualResult> {
  if (!tryAcquireStaffRun()) return { ok: false, reason: "busy" };
  try {
    const settings = useStaffStore.getState().settings;
    if (settings.sources.agenda) {
      try {
        await refreshAgendaIfRunning();
      } catch {
        /* 议程刷新失败沿用缓存，不阻断本次简报 */
      }
    }
    const now = Date.now();
    const facts = liveFacts(settings, now);
    const profile = settings.profileId
      ? (useLlmStore.getState().getProfile(settings.profileId) ?? null)
      : null;
    const outcome = await runStaffBrief({
      trigger,
      settings,
      facts,
      now,
      profile,
      tokensToday: tokensToday(useStaffStore.getState().runs, now),
      quiet: inQuietHours(settings.quietFrom, settings.quietTo, now),
      signal: opts.signal,
    });
    const store = useStaffStore.getState();
    store.recordRun(outcome.run);
    if (outcome.seenPatch.agenda.length || outcome.seenPatch.tasks.length) {
      store.markSeen(outcome.seenPatch, outcome.run.startedAt);
    }
    return { ok: true, run: outcome.run };
  } catch (err) {
    return {
      ok: false,
      reason: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    releaseStaffRun();
  }
}
