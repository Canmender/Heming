import type { SVGProps } from "react";

/**
 * 表情选择器（输入栏上方浮层，点选插入草稿）：
 * emoji 只作为消息内容出现于此（界面 chrome 一律细线 SVG，见全局 UI 偏好）。
 */
const EMOJIS = [
  "😀", "😄", "😁", "😂", "🤣", "😊", "😍", "😘",
  "😎", "🤔", "😅", "😭", "👍", "👏", "🎉", "🔥",
  "💯", "🙏", "✅", "❌",
];

export function EmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
  return (
    <div className="absolute bottom-full left-12 z-40 mb-1 grid w-[220px] grid-cols-8 gap-1 rounded-xl border border-[#ececec] bg-white p-2 shadow-card">
      {EMOJIS.map((e) => (
        <button
          key={e}
          type="button"
          aria-label={e}
          className="rounded p-1 text-[17px] leading-none hover:bg-[#f3f3f3]"
          onClick={() => onPick(e)}
        >
          {e}
        </button>
      ))}
    </div>
  );
}
