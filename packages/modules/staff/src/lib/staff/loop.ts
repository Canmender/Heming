import { useEffect } from "react";
import { useLlmStore } from "@heming/sdk";
import {
  STAFF_AGENDA_REFRESH_MS,
  STAFF_TICK_MS,
  decideTick,
  inQuietHours,
  tokensToday,
} from "./model.js";
import { releaseStaffRun, tryAcquireStaffRun } from "./lock.js";
import { runStaffBrief } from "./runner.js";
import { liveFacts, refreshAgendaIfRunning } from "./runtime.js";
import { useStaffStore } from "./store.js";

/** 登录后先等一拍：让首页/任务区先把本机数据读完，再决定第一份简报。 */
export const STAFF_FIRST_TICK_MS = 3_000;

/**
 * 常驻幕僚（d.48 §7）。
 *
 * - 挂在 AppShell 登录后的同一层，切页不卸载；应用关闭即停止。
 * - 每 60 秒 tick 一次；议程最多每 15 分钟刷新一次，避免每次 tick 都打 IPC。
 * - 只读：议程仅在 InfoHub 已 `running` 时读取，绝不调用 connect/start。
 * - 与手动运行共用进程内锁，异常一律吞掉（幕僚失败不能拖垮主界面）。
 */
export function useStaffLoop(active: boolean): void {
  useEffect(() => {
    if (!active) return;

    let cancelled = false;
    let ticking = false;
    let lastAgendaRefresh = 0;
    const controller = new AbortController();

    const step = async (): Promise<void> => {
      if (cancelled || ticking) return;
      const store = useStaffStore.getState();
      const settings = store.settings;
      if (!settings.enabled) return;

      ticking = true;
      try {
        const startedAt = Date.now();
        if (settings.sources.agenda && startedAt - lastAgendaRefresh >= STAFF_AGENDA_REFRESH_MS) {
          lastAgendaRefresh = startedAt;
          try {
            await refreshAgendaIfRunning();
          } catch {
            /* 采集失败沿用上一份缓存；InfoHub store 自己记错误 */
          }
          if (cancelled) return;
        }

        const now = Date.now();
        const facts = liveFacts(settings, now);
        const current = useStaffStore.getState();
        const decision = decideTick({
          settings: current.settings,
          runs: current.runs,
          seen: current.seen,
          facts,
          now,
        });
        if (decision.kind !== "run") return;
        if (!tryAcquireStaffRun()) return;

        const runSettings = current.settings;
        try {
          const profile = runSettings.profileId
            ? (useLlmStore.getState().getProfile(runSettings.profileId) ?? null)
            : null;
          const outcome = await runStaffBrief({
            trigger: decision.trigger,
            settings: runSettings,
            facts: decision.facts,
            now,
            profile,
            tokensToday: tokensToday(current.runs, now),
            quiet: inQuietHours(runSettings.quietFrom, runSettings.quietTo, now),
            signal: controller.signal,
          });
          const latest = useStaffStore.getState();
          latest.recordRun(outcome.run);
          if (outcome.seenPatch.agenda.length || outcome.seenPatch.tasks.length) {
            latest.markSeen(outcome.seenPatch, outcome.run.startedAt);
          }
        } finally {
          releaseStaffRun();
        }
      } catch (err) {
        console.warn("[staff] 简报运行失败", err);
      } finally {
        ticking = false;
      }
    };

    const timer = window.setInterval(() => {
      void step();
    }, STAFF_TICK_MS);
    const first = window.setTimeout(() => {
      void step();
    }, STAFF_FIRST_TICK_MS);
    // 后台标签页的定时器会被节流，回到前台补一拍。
    const onVisible = (): void => {
      if (document.visibilityState === "visible") void step();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(timer);
      window.clearTimeout(first);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [active]);
}
