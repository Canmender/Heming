import { useEffect, useMemo, useRef, useState } from "react";
import type { VaultIndex } from "../../lib/vault/types.js";
import { useModalA11y } from "../useModalA11y.js";
import { matchKindLabel, rankQuickOpenNotes, type QuickOpenNote } from "./quickOpenModel.js";

/**
 * 页面内快速切换（Ctrl/⌘+O）：输入过滤、↑↓ 选择、Enter 打开、Esc 关闭。
 *
 * 与命令面板的分工：命令面板是「去哪里 / 做什么」，这里只做**当前库里换文件**，
 * 所以不放页面/动作，检索与排序复用 `rankQuickOpen`（与命令面板 vault 组同一口径）。
 * 挂在知识库页内部而不是全局：离开知识库就不该响应 Ctrl+O。
 */

export interface QuickOpenProps {
  open: boolean;
  index: VaultIndex | null;
  onClose: () => void;
  onOpen: (rel: string) => void;
  /** 最近打开过的 rel（空查询时引擎按它排序）。 */
  recent?: readonly string[];
  /** 排序函数注入（缺省 `rankQuickOpenNotes`；测试可注入假实现）。 */
  rank?: (
    index: VaultIndex | null,
    query: string,
    limit: number,
    recent: readonly string[],
  ) => QuickOpenNote[];
}

const LISTBOX_ID = "vault-quickopen-listbox";
const optionId = (index: number) => `vault-quickopen-option-${index}`;

export function QuickOpen({ open, index, onClose, onOpen, recent = [], rank }: QuickOpenProps) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const notes = useMemo(() => {
    const rankFn = rank ?? rankQuickOpenNotes;
    return rankFn(index, query, 10, recent);
  }, [rank, index, query, recent]);

  // 打开即重置：上一次的查询词与游标不该残留
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setCursor(0);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [open]);

  // 结果集变化时游标回到第一项（否则可能停在一个已经不存在的下标上）
  useEffect(() => {
    setCursor(0);
  }, [query]);

  useModalA11y(panelRef, onClose, { active: open, closeOnEscape: false, initialFocusRef: inputRef });

  if (!open) return null;

  const execute = (note: QuickOpenNote | undefined) => {
    if (!note) return;
    onOpen(note.rel);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => (notes.length === 0 ? 0 : (c + 1) % notes.length));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => (notes.length === 0 ? 0 : (c - 1 + notes.length) % notes.length));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      execute(notes[cursor]);
    }
  };

  const active = notes[cursor];

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/20 pt-[14vh]"
      onMouseDown={onClose}
      role="presentation"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="快速切换笔记"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        className="w-[520px] max-w-[92vw] overflow-hidden rounded-xl border border-line bg-surface shadow-card"
      >
        <input
          ref={inputRef}
          aria-label="输入笔记名快速切换"
          aria-autocomplete="list"
          aria-controls={LISTBOX_ID}
          aria-expanded
          aria-activedescendant={active ? optionId(cursor) : undefined}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="输入笔记名…"
          className="w-full border-b border-line px-3.5 py-2.5 text-[13px] text-ink outline-hidden placeholder:text-placeholder"
        />
        <div
          id={LISTBOX_ID}
          role="listbox"
          aria-label="快速切换结果"
          className="max-h-[46vh] overflow-y-auto py-1"
        >
          {notes.length === 0 ? (
            <p className="px-3.5 py-3 text-[12px] text-muted">
              {index ? "没有匹配的笔记。" : "索引还没建好，稍等一下再试。"}
            </p>
          ) : (
            notes.map((note, i) => (
              <div
                key={note.rel}
                id={optionId(i)}
                role="option"
                aria-selected={i === cursor}
                aria-label={`打开 ${note.title}`}
                tabIndex={-1}
                onMouseEnter={() => setCursor(i)}
                onClick={() => execute(note)}
                className={`flex cursor-pointer items-baseline gap-2 px-3 py-1.5 text-[12px] ${
                  i === cursor ? "bg-subtle-3" : ""
                }`}
              >
                <span className="min-w-0 flex-1 truncate">{note.title}</span>
                <span className="shrink-0 truncate text-[10px] text-muted">
                  {matchKindLabel(note.matchKind) ? `${matchKindLabel(note.matchKind)} · ` : ""}
                  {note.dir || "库根"}
                </span>
              </div>
            ))
          )}
        </div>
        <div className="flex items-center gap-3 border-t border-line-soft px-3.5 py-1.5 text-[10px] text-muted">
          <span>↑↓ 选择</span>
          <span>Enter 打开</span>
          <span>Esc 关闭</span>
        </div>
      </div>
    </div>
  );
}
