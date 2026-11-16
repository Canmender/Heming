import { Button } from "./ui/Button.js";

/**
 * 本轮改动可撤回（d.176）。
 *
 * ## 为什么要有这一条
 *
 * d.170 给了 `file_undo`，d.171 又在设置里加了「最近改动（可回滚）」列表——但两处都要求用户
 * **先意识到要撤、再找到入口、再翻路径**。真正会出事的时刻是「它刚写完，我看不对」：那一步
 * 应当就在眼前。这一条把「撤回」放到刚出结果的位置，点一次就行。
 *
 * ## 口径
 *
 * - 只显示「这一轮真的落盘的文件」——路径由工具桥显式返回（`RunSettled.writes`），
 *   **不从结果文案里反推**：文案会为了可读性调整，反推出错就是撤错文件。
 * - 撤回仍然是逐个文件走 `file_undo`（一份备份只能用一次），所以失败要给理由，
 *   不能说「已撤回」了事：可能那份备份已经被用过、或这轮只删了文件。
 * - 撤回结果用一句话说清成功数与失败数，不弹对话框——用户下一步还要继续干活。
 */
export function TurnUndoBar({
  paths,
  busy,
  onUndo,
  onDismiss,
}: {
  /** 本轮落盘的绝对路径（正斜杠）。 */
  paths: readonly string[];
  busy?: boolean;
  onUndo: () => void;
  onDismiss: () => void;
}) {
  if (paths.length === 0) return null;
  const names = paths.map((path) => path.split("/").pop() ?? path);
  const preview = names.slice(0, 3).join("、");
  const more = names.length > 3 ? ` 等 ${names.length} 个` : "";

  return (
    <div
      role="status"
      aria-live="polite"
      className="mx-4 mb-1 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-subtle-2 px-3 py-1.5 text-ui-sm text-ink"
    >
      <span className="min-w-0 truncate" title={paths.join("\n")}>
        本轮改了 {preview}
        {more}——改错了可以撤回。
      </span>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <Button variant="ghost" size="sm" onClick={onDismiss} disabled={busy}>
          保留
        </Button>
        <Button size="sm" onClick={onUndo} disabled={busy}>
          {busy ? "正在撤回…" : "撤回本轮改动"}
        </Button>
      </div>
    </div>
  );
}
