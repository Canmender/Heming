import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dialog } from "./ui/Dialog.js";
import { Button } from "./ui/Button.js";
import { FOCUS_RING } from "../lib/a11y/focus.js";
import { MAX_FILE_REFS } from "../lib/fileEdit/fileRefs.js";
import type { FileFsBridge } from "../lib/fileEdit/bridge.js";
import type { FileRoot } from "../lib/fileEdit/paths.js";
import { relFromRoot, toPosixPath } from "../lib/fileEdit/paths.js";

/**
 * 选工作区文件（d.175）。
 *
 * ## 为什么是一个对话框而不是输入框里的 `@`
 *
 * 和鸣的输入框已经有一套 mention 机制（智能体 mention，`runAgentMentions` 那条线），
 * 再塞一套键盘驱动的 `@` 弹层会和它抢按键、抢候选列表。对话框是确定性的：点一下、
 * 勾几个、确定，没有「浮层跟着光标漂」的坑，也不需要处理 IME。
 *
 * ## 只列出、不读取
 *
 * 这里只用 `bridge.glob` 拿路径（一次最多 200 条）；**内容由发送时
 * `fileEdit/fileRefs.ts` 读**——原因有两个：①用户可能勾了又删，读早了是白读；
 * ②读取要按「根内可读」校验一遍，放在发送路径上只做一次。
 *
 * ## 上限与空态
 *
 * 最多 3 个（`MAX_FILE_REFS`）；列表为空时明说「这个工作区里没有可引用的文件」，
 * 不要给一个永远转圈的加载态——没有桥（浏览器端）时直接说明不可用。
 */
export function FileRefPicker({
  bridge,
  roots,
  selected,
  onConfirm,
  onClose,
}: {
  bridge: FileFsBridge | null;
  roots: readonly FileRoot[];
  /** 已经引用的路径（绝对、正斜杠）。 */
  selected: readonly string[];
  onConfirm: (paths: string[]) => void;
  onClose: () => void;
}) {
  const [files, setFiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string[]>(() => selected.map((p) => toPosixPath(p)));
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    if (!bridge?.glob || roots.length === 0) {
      setFiles([]);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await bridge.glob({ roots: [...roots], pattern: "**/*" });
      if (!mounted.current) return;
      if (res.ok) {
        // glob 回的是绝对路径；这里按第一个能匹配的根折成相对路径展示。
        setFiles(res.paths.map((abs) => toPosixPath(abs)));
      } else {
        setFiles([]);
        setError(res.error || "列目录失败，无法读取工作区文件。");
      }
    } catch {
      if (mounted.current) {
        setFiles([]);
        setError("列目录失败，无法读取工作区文件。");
      }
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [bridge, roots]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return files
      .map((abs) => {
        const root = roots.find((r) => relFromRoot(toPosixPath(r.path), abs) !== null);
        const rel = root ? (relFromRoot(toPosixPath(root.path), abs) ?? abs) : abs;
        return { abs, rel };
      })
      .filter((row) => (keyword ? row.rel.toLowerCase().includes(keyword) : true))
      .slice(0, 200);
  }, [files, query, roots]);

  const toggle = (abs: string) => {
    setPicked((prev) => {
      if (prev.includes(abs)) return prev.filter((p) => p !== abs);
      if (prev.length >= MAX_FILE_REFS) return prev; // 到上限就不再加，按钮上已说明
      return [...prev, abs];
    });
  };

  const full = picked.length >= MAX_FILE_REFS;

  return (
    <Dialog
      ariaLabel="引用工作区文件"
      title="引用工作区文件"
      description={`勾选后内容会随这一轮一起交给智能体（最多 ${MAX_FILE_REFS} 个，不上传）。`}
      size="md"
      onClose={onClose}
      bodyClassName="p-0"
      footer={
        <>
          <span className="mr-auto text-ui-sm text-muted">
            已选 {picked.length} / {MAX_FILE_REFS}
          </span>
          <Button variant="ghost" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button size="sm" disabled={picked.length === 0} onClick={() => onConfirm(picked)}>
            确定引用
          </Button>
        </>
      }
    >
      <div className="border-b border-line-soft px-4 py-2">
        <input
          type="search"
          aria-label="搜索工作区文件"
          placeholder="搜索文件名…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className={`w-full rounded-md border border-line bg-surface px-2 py-1.5 text-ui-sm text-ink placeholder:text-muted ${FOCUS_RING}`}
        />
      </div>
      {error ? (
        <p role="alert" className="px-4 py-3 text-ui-sm text-danger">
          {error}
        </p>
      ) : null}
      {!error && !loading && rows.length === 0 ? (
        <p className="px-4 py-3 text-ui-sm text-muted">
          {files.length === 0 ? "这个工作区里没有可引用的文件。" : "没有匹配的文件。"}
        </p>
      ) : null}
      {loading ? <p className="px-4 py-3 text-ui-sm text-muted">正在读取文件列表…</p> : null}
      {rows.length > 0 ? (
        <ul role="list" aria-label="工作区文件" className="divide-y divide-line-soft">
          {rows.map((row) => {
            const checked = picked.includes(row.abs);
            const disabled = !checked && full;
            return (
              <li key={row.abs}>
                <label
                  className={`flex cursor-pointer items-center gap-2 px-4 py-1.5 text-ui-sm ${
                    disabled ? "cursor-not-allowed text-muted" : "text-ink hover:bg-subtle-2"
                  }`}
                  title={row.rel}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={disabled}
                    onChange={() => toggle(row.abs)}
                    className={FOCUS_RING}
                  />
                  <span className="truncate">{row.rel}</span>
                </label>
              </li>
            );
          })}
        </ul>
      ) : null}
    </Dialog>
  );
}
