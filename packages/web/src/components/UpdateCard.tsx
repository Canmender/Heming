import { useEffect, useMemo, useState } from "react";
import { ConfirmDialog } from "./ConfirmDialog.js";

/**
 * 自动更新卡（桌面安装版专属）。
 *
 * 三条不可让步的约束，都来自产品判断而非技术限制：
 *
 * 1. **绝不自动下载、绝不自动安装。** 更新会重启应用，用户可能正在打字或跑任务。
 *    发现更新只提示，下载要用户点，装完也要用户点最后一步。
 * 2. **拿不到更新桥时不报错、不显示空白卡。** 开发态（`electron .`）主进程不初始化
 *    更新器，这时界面上就不该出现「检查更新」按钮——否则点了没反应像坏了。
 * 3. **错误要能看见。** 「没更新」和「检查失败」在界面上长得一样时，
 *    用户唯一能做的就是卸载重装。
 */

/** 状态 → 按钮文案。刻意区分「已是最新」与「检查失败」，两者都该让用户知道。 */
function buttonLabel(state: UpdateState | null, busy: boolean): string {
  if (busy) return "处理中…";
  if (!state) return "检查更新";
  switch (state.status) {
    case "checking":
      return "检查中…";
    case "available":
      return "下载更新";
    case "downloading":
      return "下载中…";
    case "downloaded":
      return "重启并安装";
    case "up-to-date":
      return "重新检查";
    default:
      return "检查更新";
  }
}

/** 状态 → 说明文案。 */
function describe(state: UpdateState | null): string {
  if (!state) return "点击检查是否有新版本";
  switch (state.status) {
    case "checking":
      return "正在检查新版本…";
    case "available":
      return `发现新版本 ${state.available?.version ?? ""}`;
    case "downloading":
      return "正在下载，请保持网络连接…";
    case "downloaded":
      return "更新已下载完成，重启后生效";
    case "up-to-date":
      return "已是最新版本";
    case "error":
      return state.lastError || "检查失败";
    default:
      return "点击检查是否有新版本";
  }
}

export function UpdateCard({ currentVersion }: { currentVersion: string }) {
  const bridge = typeof window !== "undefined" ? window.__heming_update : undefined;
  const [state, setState] = useState<UpdateState | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmInstall, setConfirmInstall] = useState(false);

  // 订阅主进程推送的状态；组件卸载时务必退订，否则会向已销毁的组件 setState。
  useEffect(() => {
    if (!bridge?.subscribe) return;
    return bridge.subscribe(setState);
  }, [bridge]);

  const canAct = useMemo(
    () => Boolean(bridge) && state?.status !== "downloading",
    [bridge, state?.status],
  );

  // 开发态没有这个桥——整张卡不渲染，而不是显示一个点不动的按钮。
  if (!bridge) return null;

  const onAction = async () => {
    if (!canAct || !state) return;
    // 已下载完成 → 这一步是「重启并安装」，会终止当前进程，
    // 所以不再 setBusy：进程马上就没了，等下状态反而是错的。
    if (state.status === "downloaded") {
      setConfirmInstall(true);
      return;
    }
    setBusy(true);
    try {
      const next = state.status === "available" ? await bridge.download() : await bridge.check();
      setState(next);
    } catch {
      // 主进程已经会把错误写进 state.lastError 并推回来，这里不重复弹窗。
    } finally {
      setBusy(false);
    }
  };

  const hasUpdate = state?.status === "available" || state?.status === "downloaded";

  return (
    <section
      aria-label="软件更新"
      className="max-w-[520px] rounded-xl border border-line bg-white p-4 shadow-card"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="text-[12px] font-bold text-muted">软件更新</div>
        <span className="text-[11px] text-muted">当前 {currentVersion}</span>
      </div>

      <div className="mt-1 text-[11px] text-muted">{describe(state)}</div>

      {hasUpdate && state?.available && (
        <div className="mt-2 rounded-lg border border-line-soft bg-[#fafafa] px-2.5 py-2 text-[12px]">
          可更新至 <span className="font-bold">{state.available.version}</span>
        </div>
      )}

      {!state?.canDownload && (
        <div className="mt-1 text-[11px] text-muted">
          开发模式不支持下载更新，仅可检查。
        </div>
      )}

      <button
        type="button"
        aria-label="检查更新"
        disabled={!canAct || state?.status === "checking"}
        onClick={() => void onAction()}
        className="mt-2.5 rounded-lg border border-line px-3 py-1.5 text-[12px] font-medium hover:bg-[#fafafa] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {buttonLabel(state, busy)}
      </button>
      {confirmInstall && (
        <ConfirmDialog
          title="重启并安装更新"
          onCancel={() => setConfirmInstall(false)}
          footer={
            <>
              <button
                type="button"
                onClick={() => setConfirmInstall(false)}
                className="rounded-lg border border-line px-3 py-1.5 text-[12px] text-muted hover:bg-[#f7f7f7]"
              >
                稍后
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmInstall(false);
                  void bridge.install();
                }}
                className="rounded-lg bg-ink px-3 py-1.5 text-[12px] font-bold text-white"
              >
                重启并安装
              </button>
            </>
          }
        >
          <p className="text-[12px] leading-6">
            安装会关闭并重启应用，正在输入的内容、运行中的智能体任务与通话会中断。请先保存工作，再继续。
          </p>
        </ConfirmDialog>
      )}

    </section>
  );
}