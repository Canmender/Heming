import { useState } from "react";
import { Button } from "./ui/Button.js";

/**
 * 本轮改动可撤回（d.176；d.185 起可以逐个文件撤）。
 *
 * ## 为什么要有这一条
 *
 * d.170 给了 `file_undo`，d.171 又在设置里加了「最近改动（可回滚）」列表——但两处都要求用户
 * **先意识到要撤、再找到入口、再翻路径**。真正会出事的时刻是「它刚写完，我看不对」：那一步
 * 应当就在眼前。这一条把「撤回」放到刚出结果的位置，点一次就行。
 *
 * ## 为什么还要逐个撤（d.185）
 *
 * 一轮改了五个文件、只有两个不对时，「全部撤回」等于把对的也扔了，用户只能再让模型写一遍。
 * 所以清单可以展开：每行一个文件、各自一个「撤回」，撤掉的从清单里消失。
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
  busyPath,
  onUndo,
  onUndoOne,
  onPreview,
  onReveal,
  onDismiss,
}: {
  /** 本轮落盘的绝对路径（正斜杠）。 */
  paths: readonly string[];
  busy?: boolean;
  /** 正在单独撤回的那一个文件（正斜杠绝对路径）。 */
  busyPath?: string | null;
  onUndo: () => void;
  /** 只撤这一个文件；不传就不展示清单（老调用方行为不变）。 */
  onUndoOne?: (path: string) => void;
  /**
   * 看这一个文件「改成了什么」（d.207.4.110）。
   *
   * 撤之前得先能看——不给看的话「撤回」这个功能用户平时不敢点。不传就不展示这个按钮
   * （老安装包没有 `file:backup-preview` 通道）。
   */
  onPreview?: (path: string) => void;
  /**
   * 在系统文件管理器里定位这个文件（d.234）。
   *
   * 「改完的东西在哪儿」是落盘之后第一个真问题：不给入口就得让人肉导航路径。
   * 不传就不展示（老安装包没有 `file:reveal` 通道）。
   */
  onReveal?: (path: string) => void;
  onDismiss: () => void;
}) {
  const [open, setOpen] = useState(false);
  if (paths.length === 0) return null;
  const names = paths.map((path) => path.split("/").pop() ?? path);
  const preview = names.slice(0, 3).join("、");
  const more = names.length > 3 ? ` 等 ${names.length} 个` : "";
  const expandable = onUndoOne !== undefined && paths.length > 0;

  return (
    <div
      role="status"
      aria-live="polite"
      className="mx-4 mb-1 rounded-lg border border-line bg-subtle-2 px-3 py-1.5 text-ui-sm text-ink"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 truncate" title={paths.join("\n")}>
          本轮改了 {preview}
          {more}——改错了可以撤回。
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {expandable ? (
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={open}
              onClick={() => setOpen((value) => !value)}
              disabled={busy}
            >
              {open ? "收起清单" : "看清单"}
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" onClick={onDismiss} disabled={busy}>
            保留
          </Button>
          <Button size="sm" onClick={onUndo} disabled={busy}>
            {busy ? "正在撤回…" : "撤回本轮改动"}
          </Button>
        </div>
      </div>
      {open && expandable ? (
        <ul aria-label="本轮改动的文件" className="mt-1.5 space-y-0.5 border-t border-line pt-1.5">
          {paths.map((path) => {
            const name = path.split("/").pop() ?? path;
            const rowBusy = busyPath === path;
            return (
              <li key={path} className="flex items-center gap-2">
                <span className="min-w-0 truncate font-mono text-ui-xs" title={path}>
                  {name}
                </span>
                <span className="min-w-0 truncate text-ui-xs text-muted" title={path}>
                  {path.slice(0, path.length - name.length).replace(/\/$/, "")}
                </span>
                {onPreview ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className={onReveal ? undefined : "ml-auto"}
                    aria-label={`看 ${name} 改成了什么`}
                    onClick={() => onPreview(path)}
                    disabled={busy}
                  >
                    改动
                  </Button>
                ) : null}
                {onReveal ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className={onPreview ? undefined : "ml-auto"}
                    aria-label={`在文件夹里显示 ${name}`}
                    onClick={() => onReveal(path)}
                    disabled={busy}
                  >
                    定位
                  </Button>
                ) : null}
                <Button
                  variant="ghost"
                  size="sm"
                  className={onPreview || onReveal ? undefined : "ml-auto"}
                  aria-label={`撤回 ${name}`}
                  onClick={() => onUndoOne?.(path)}
                  disabled={busy || rowBusy}
                >
                  {rowBusy ? "撤回中…" : "撤回"}
                </Button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
