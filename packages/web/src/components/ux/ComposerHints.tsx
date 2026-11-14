/**
 * 输入区快捷键提示（UX-A · U4 后半段）。
 *
 * 常驻但弱化：会的人扫一眼就过、不会的人第一次就看见；不占提示位（不参与 sendNotice 那条行）。
 * Esc 的实际语义（ChatPage A10）：没有草稿、没有浮层开着时停止生成——文案按有无流动态切换。
 */
import { Kbd } from "../ui/Kbd";

export function ComposerHints({ streaming = false }: { streaming?: boolean }) {
  return (
    <p
      aria-label="输入快捷键提示"
      className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-ui-xs leading-4 text-muted"
    >
      <span>
        <Kbd>Enter</Kbd> 发送
      </span>
      <span aria-hidden="true">·</span>
      <span>
        <Kbd>Shift</Kbd>
        {/* 组合键之间要有一个可见的「+」，否则两个键帽并排读起来像两个独立按键 */}
        <span aria-hidden="true" className="mx-0.5">
          +
        </span>
        <Kbd>Enter</Kbd> 换行
      </span>
      <span aria-hidden="true">·</span>
      <span>
        <Kbd>Esc</Kbd>{" "}
        {streaming ? "停止生成" : "停止生成（生成中可用）"}
      </span>
    </p>
  );
}
