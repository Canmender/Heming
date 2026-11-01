/** 幕僚运行锁：调度 tick 与手动「现在跑一次」共用，避免同一时刻跑两份简报。 */
let busy = false;

export function tryAcquireStaffRun(): boolean {
  if (busy) return false;
  busy = true;
  return true;
}

export function releaseStaffRun(): void {
  busy = false;
}

export function isStaffRunBusy(): boolean {
  return busy;
}
