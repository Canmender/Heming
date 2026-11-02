/**
 * 输入区快捷键提示（UX-A · U4 后半段）。
 *
 * 常驻但弱化：会的人扫一眼就过、不会的人第一次就看见；不占提示位（不参与 sendNotice 那条行）。
 * Esc 的实际语义（ChatPage A10）：没有草稿、没有浮层开着时停止生成——文案按有无流动态切换。
 */
export function ComposerHints({ streaming = false }: { streaming?: boolean }) {
  return (
    <p
      aria-label="输入快捷键提示"
      className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] leading-4 text-muted"
    >
      <span>
        <kbd className="rounded-sm border border-line px-1">Enter</kbd> 发送
      </span>
      <span aria-hidden="true">·</span>
      <span>
        <kbd className="rounded-sm border border-line px-1">Shift+Enter</kbd> 换行
      </span>
      <span aria-hidden="true">·</span>
      <span>
        <kbd className="rounded-sm border border-line px-1">Esc</kbd>{" "}
        {streaming ? "停止生成" : "停止生成（生成中可用）"}
      </span>
    </p>
  );
}
