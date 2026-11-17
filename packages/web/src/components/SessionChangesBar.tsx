import { Button } from "./ui/Button.js";
import type { SessionChange } from "../lib/fileEdit/sessionChanges.js";

/**
 * 本会话改动回顾入口（d.210）。
 *
 * ## 为什么要有这一条
 *
 * d.207 的「改动对照」只能看**当前这一轮**：`TurnUndoBar` 一出下一轮就被新清单覆盖，
 * 用户点了「保留」它就消失了。可长任务往往改了十几轮，用户真正会问的是
 * 「这个会话到现在一共动过哪些文件」——答案不在屏幕上，只能靠记忆或去翻编辑器。
 *
 * ## 口径
 *
 * - 数字与清单都来自本机台账（`lib/fileEdit/sessionChanges.ts`），只记「哪个文件改过几次」；
 *   具体内容对照仍走写盘备份通道，点进去才读。
 * - 不显示「改动行数」：跨轮累计的行数没有可靠来源（备份是一份一份的），宁可不给。
 * - 没有任何记录时不渲染（不占屏幕）。
 */
export function SessionChangesBar({
  changes,
  onOpen,
}: {
  /** 本会话改过的文件（最近改的在前）。 */
  changes: readonly SessionChange[];
  /** 打开会话级回顾弹窗。 */
  onOpen: () => void;
}) {
  if (changes.length === 0) return null;
  const preview = changes
    .slice(0, 3)
    .map((item) => item.path.split("/").pop() ?? item.path)
    .join("、");
  const more = changes.length > 3 ? ` 等 ${changes.length} 个` : "";

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="session-changes"
      className="mx-4 mb-1 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-subtle-2 px-3 py-1.5 text-ui-sm text-ink"
    >
      <span className="min-w-0 truncate" title={changes.map((item) => item.path).join("\n")}>
        本会话改过 {preview}
        {more}
      </span>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <Button variant="ghost" size="sm" onClick={onOpen}>
          查看改动
        </Button>
      </div>
    </div>
  );
}
