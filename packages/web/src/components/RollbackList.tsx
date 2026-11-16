import { useCallback, useEffect, useState } from "react";
import {
  getFileBridge,
  hasBackupsBridge,
  hasUndoBridge,
  type FileBackupItem,
  type FileFsBridge,
} from "../lib/fileEdit/bridge.js";
import { currentFileRoots } from "../lib/fileEdit/roots.js";
import { relFromRoot } from "../lib/fileEdit/paths.js";
import { Button } from "./ui/Button.js";

/**
 * 设置区 · 「最近改动（可回滚）」列表（d.171）。
 *
 * 为什么要有这块界面：d.170 给智能体加了 `file_undo`，但**只有模型会调**——
 * 用户看到文件被改坏了，除了对智能体说「退回去」再没有别的入口。一个能力
 * 只有在用户能直接点的时候才算交付。
 *
 * 三条口径：
 * - 列表只来自主进程的备份索引（`file:backups`），**只列可写根内的文件**：
 *   列出来的每一行都必须真的能点「回滚」，列出只读根是骗人；
 * - 每个文件只列最新一份（更早的靠连续回滚拿）——这是给人看的列表，不是版本浏览器；
 * - 回滚也走 `file:undo`：**一份备份只能用一次**，点完那一行就消失。
 */
export function RollbackList({ bridge }: { bridge?: FileFsBridge | null }) {
  const fileBridge = bridge === undefined ? getFileBridge() : bridge;
  const canList = hasBackupsBridge(fileBridge);
  const canUndo = hasUndoBridge(fileBridge);

  const [items, setItems] = useState<FileBackupItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const roots = currentFileRoots();

  const load = useCallback(async () => {
    if (!fileBridge?.backups) return;
    try {
      const response = await fileBridge.backups({ roots: currentFileRoots() });
      setLoaded(true);
      if (!response.ok) {
        setError(response.error || "读取最近改动失败");
        return;
      }
      setError(null);
      setItems(response.items);
    } catch (e) {
      setLoaded(true);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [fileBridge]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!canList) {
    return null;
  }

  const restore = async (item: FileBackupItem) => {
    if (!fileBridge?.undo) return;
    const rel = relFromRootLabel(item.path) ?? item.path;
    setBusyPath(item.path);
    setStatus(null);
    try {
      const response = await fileBridge.undo({ roots: currentFileRoots(), path: item.path });
      if (!response.ok) {
        setError(`${rel} 回滚失败：${response.error}`);
        return;
      }
      setError(null);
      setStatus(`已把 ${rel} 回滚到 ${formatTime(response.restoredFrom)} 的版本。`);
      await load();
    } catch (e) {
      setError(`${rel} 回滚失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusyPath(null);
    }
  };

  return (
    <section className="mt-5" aria-labelledby="rollback-heading">
      <div className="flex items-center gap-2">
        <h3 id="rollback-heading" className="text-ui-md font-medium text-ink">
          最近改动（可回滚）
        </h3>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => void load()} busy={false}>
          刷新
        </Button>
      </div>
      <p className="mt-1 text-ui-sm leading-5 text-muted">
        智能体每次覆盖或删除文件之前都会留一份备份。这里列出每个文件的最新一份，点「回滚」就把内容恢复成写之前的样子；一份备份只能用一次。
      </p>

      {status && (
        <p role="status" aria-live="polite" className="mt-2 text-ui-sm text-success">
          {status}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-ui-sm text-danger">
          {error}
        </p>
      )}

      {items.length === 0 ? (
        <p className="mt-2 text-ui-sm text-muted">
          {loaded ? "还没有可回滚的改动。" : "正在读取…"}
        </p>
      ) : (
        <ul className="mt-2 space-y-1">
          {items.map((item) => {
            const rel = relFromRootLabel(item.path) ?? item.path;
            const busy = busyPath === item.path;
            return (
              <li
                key={item.path}
                className="flex items-center gap-2 rounded-sm bg-subtle-2 px-2 py-1.5"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-ui-sm text-ink" title={item.path}>
                  {rel}
                </span>
                <span className="shrink-0 text-ui-sm text-muted">{formatTime(item.at)}</span>
                <span className="shrink-0 text-ui-sm text-muted">{formatBytes(item.bytes)}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  busy={busy}
                  disabled={!canUndo || (busyPath !== null && !busy)}
                  onClick={() => void restore(item)}
                  aria-label={`回滚 ${rel} 到 ${formatTime(item.at)} 的版本`}
                >
                  回滚
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** 绝对路径 → 当前根内的相对路径（只用于展示；取不到就退回绝对路径）。 */
function relFromRootLabel(absPath: string): string | null {
  for (const root of currentFileRoots()) {
    const rel = relFromRoot(root.path, absPath);
    if (rel) return rel;
  }
  return null;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return kb < 1024 ? `${Math.max(1, Math.round(kb))} KB` : `${(kb / 1024).toFixed(1)} MB`;
}
