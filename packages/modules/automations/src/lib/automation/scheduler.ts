import { useEffect } from "react";
import { isInfohubAvailable } from "@heming/sdk";
import { useInfohubStore } from "@heming/sdk";
import { runAutomationTask } from "./runner.js";
import { useAutomationStore } from "./store.js";

/** 轮询间隔：到点误差最多 15 秒；对「每天/每几分钟」的任务足够细。 */
export const AUTOMATION_TICK_MS = 15_000;

/**
 * 本机自动化调度器（独立插件，不受信息中枢模块启停门禁影响）。
 *
 * - `enabled` 只由「登录态 + 自动化模块自身启用」决定；信息中枢模块停用
 *   不会把调度器摘掉——任务到点后由 runner 如实报「信息中枢未连接」。
 * - 浏览器里没有本机边车：不消费计划（否则等于把任务悄悄跑掉）。
 * - 登录后才挂载：退出登录后不让后台继续写本机归档。
 * - 启动时把「本次启动前就到点」的任务顺延，不补跑（规格 §4）。
 * - 串行：`beginRun` 是执行权锁，调度与手动运行共用。
 */
export function useAutomationScheduler(enabled: boolean): void {
  useEffect(() => {
    if (!enabled || !isInfohubAvailable()) return;
    const since = Date.now();
    useAutomationStore.getState().rescheduleMissed(since, since);

    let cancelled = false;
    const step = async (): Promise<void> => {
      if (cancelled) return;
      // 启动探测还没完成时先不下结论：下一轮再看，避免把「尚未探测」当成「未连接」。
      if (!useInfohubStore.getState().booted) return;
      const store = useAutomationStore.getState();
      if (store.runningId) return;
      const now = Date.now();
      const task = store.tasks.find((item) => item.enabled && item.nextRunAt <= now);
      if (!task) return;
      if (!store.beginRun(task.id, now)) return;
      try {
        const outcome = await runAutomationTask(task);
        useAutomationStore.getState().finishRun(task.id, outcome, Date.now());
      } catch (err) {
        useAutomationStore.getState().finishRun(
          task.id,
          { status: "error", detail: err instanceof Error ? err.message : String(err) },
          Date.now(),
        );
      }
      // 多条同时到点时继续下一条；nextRunAt 已顺延，不会重复跑同一条。
      if (!cancelled) void step();
    };

    void step();
    const timer = window.setInterval(() => {
      void step();
    }, AUTOMATION_TICK_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [enabled]);
}
