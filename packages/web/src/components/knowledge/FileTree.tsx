import { useEffect, useRef, useState } from "react";
import type { VaultEntry } from "../../lib/vault/types.js";
import { ChevronIcon, FileIcon, FolderIcon, ImageIcon, PlusIcon } from "../icons.js";
import { ConfirmDialog } from "../ConfirmDialog.js";
import { PromptDialog } from "./PromptDialog.js";
import { ancestorsOf, baseName, ensureMdExt, findEntry, isDir, joinRel, parentOf } from "./model.js";

/**
 * 知识库文件树：折叠、当前文件高亮、右键菜单（新建笔记 / 新建文件夹 / 重命名 /
 * 删除 / 在资源管理器中显示）、未保存标记、键盘可达。
 *
 * 口子全部走 props：数据来自 `VaultStoreApi.tree`（或假 store），组件自己不 import
 * store 实现——索引层与界面并行开发时，两条线靠 `lib/vault/types.ts` 对齐。
 *
 * 两条安全/体验约定：
 * - 删除走**应用内二次确认**（`ConfirmDialog` + `useModalA11y`），并且只删单个文件，
 *   目录不给删除入口（与桌面桥「删除不递归」同口径）；
 * - 「新建文件夹」要占位桥的 `vault:create` 目前只建文件不建目录，所以入口按能力
 *   可选：调用方不提供 `onCreateFolder` 时该项禁用并写明原因，不假装成功。
 */

export interface FileTreeProps {
  /** 目录树（相对路径用 `/`）。 */
  tree: VaultEntry[];
  /** 当前打开的文件 rel（高亮用）。 */
  activeRel: string | null;
  /** 有未保存修改的 rel 集合。 */
  dirty?: ReadonlySet<string>;
  /** 展开目录时回调（大目录可据此懒加载 children）。 */
  onExpandDir?: (rel: string) => void;
  /** 打开文件。 */
  onOpen: (rel: string) => void;
  /** 新建笔记：`dirRel` 是目标目录（空串=库根），`fileName` 已补 `.md`。 */
  onCreateFile: (dirRel: string, fileName: string) => void;
  /** 新建文件夹；不传则右键菜单该项禁用（当前桥没有 mkdir 能力）。 */
  onCreateFolder?: (dirRel: string, folderName: string) => void;
  /** 重命名文件（`to` 已补 `.md`）。 */
  onRename: (from: string, to: string) => void;
  /** 删除文件（调用方已确认过一次，本组件还会二次确认）。 */
  onDelete: (rel: string) => void;
  /** 在系统资源管理器中定位。 */
  onReveal: (rel: string) => void;
  /** 库错误提示（读目录失败等），显示在树上方。 */
  error?: string | null;
}

interface MenuState {
  /** 被右键的目标（文件或目录）rel。 */
  rel: string;
  isFile: boolean;
  /** 目标所在目录（新建用）。 */
  dir: string;
  x: number;
  y: number;
}

interface PromptState {
  kind: "new-note" | "new-folder" | "rename";
  dir: string;
  /** 重命名时的原 rel。 */
  from?: string;
  initial: string;
}

/** 行内图标：目录 / 图片 / 其它文本。 */
function EntryIcon({ entry }: { entry: VaultEntry }) {
  if (isDir(entry)) return <FolderIcon width={13} height={13} className="shrink-0 text-muted" />;
  if (entry.kind === "image") return <ImageIcon width={13} height={13} className="shrink-0 text-muted" />;
  return <FileIcon width={13} height={13} className="shrink-0 text-muted" />;
}

export function FileTree({
  tree,
  activeRel,
  dirty,
  onExpandDir,
  onOpen,
  onCreateFile,
  onCreateFolder,
  onRename,
  onDelete,
  onReveal,
  error,
}: FileTreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /** 已经触发过懒加载的目录：收起再展开不重复拉 children。 */
  const loadedDirs = useRef<Set<string>>(new Set());
  /** onExpandDir 放 ref：自动展开的 effect 不该因为父组件传了新函数就重跑。 */
  const onExpandDirRef = useRef(onExpandDir);
  onExpandDirRef.current = onExpandDir;
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // 打开深层文件时，把它所在的目录链自动展开（否则高亮项根本不可见）；
  // 顺带按需拉这些目录的子项——树可能是按 depth 懒加载的，光展开不拉会看到空目录。
  useEffect(() => {
    if (!activeRel) return;
    const needed = ancestorsOf(activeRel);
    if (needed.length === 0) return;
    setExpanded((prev) => {
      if (needed.every((rel) => prev.has(rel))) return prev;
      const next = new Set(prev);
      for (const rel of needed) next.add(rel);
      return next;
    });
    for (const rel of needed) {
      if (loadedDirs.current.has(rel)) continue;
      const entry = findEntry(tree, rel);
      if (!entry || !isDir(entry)) continue;
      loadedDirs.current.add(rel);
      onExpandDirRef.current?.(rel);
    }
  }, [activeRel, tree]);

  // 菜单打开后：点外部或按 Esc 关闭（pointerdown 在 click 之前，先判断是不是菜单自身）。
  useEffect(() => {
    if (!menu) return;
    const onPointerDown = (e: PointerEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      setMenu(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    // 菜单第一项拿到焦点，键盘用户可以直接上下选
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus();
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menu]);

  const toggleDir = (rel: string) => {
    const willOpen = !expanded.has(rel);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(rel)) next.delete(rel);
      else next.add(rel);
      return next;
    });
    // 懒加载只在首次展开时触发（收起再展开不重复请求）
    if (willOpen && !loadedDirs.current.has(rel)) {
      loadedDirs.current.add(rel);
      onExpandDir?.(rel);
    }
  };

  const openMenu = (entry: VaultEntry, x: number, y: number) => {
    setMenu({
      rel: entry.rel,
      isFile: !isDir(entry),
      dir: isDir(entry) ? entry.rel : parentOf(entry.rel),
      x,
      y,
    });
  };

  const openPrompt = (state: PromptState) => {
    setMenu(null);
    setPrompt(state);
  };

  /** 键盘：上/下移动焦点，右键展开或收起目录，左键收起目录。 */
  const onRowKeyDown = (e: React.KeyboardEvent, entry: VaultEntry) => {
    const rows = Array.from(
      rootRef.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [],
    );
    const index = rows.indexOf(e.currentTarget as HTMLElement);
    if (e.key === "ArrowDown" && index >= 0 && index < rows.length - 1) {
      e.preventDefault();
      rows[index + 1].focus();
    } else if (e.key === "ArrowUp" && index > 0) {
      e.preventDefault();
      rows[index - 1].focus();
    } else if (e.key === "ArrowRight" && isDir(entry) && !expanded.has(entry.rel)) {
      e.preventDefault();
      toggleDir(entry.rel);
    } else if (e.key === "ArrowLeft" && isDir(entry) && expanded.has(entry.rel)) {
      e.preventDefault();
      toggleDir(entry.rel);
    }
  };

  const renderRows = (entries: readonly VaultEntry[], depth: number): React.ReactNode[] =>
    entries.flatMap((entry) => {
      const dir = isDir(entry);
      const open = expanded.has(entry.rel);
      const active = !dir && entry.rel === activeRel;
      const rows: React.ReactNode[] = [
        <div key={entry.rel} className="group flex items-center">
          <button
            type="button"
            role="treeitem"
            aria-level={depth + 1}
            aria-expanded={dir ? open : undefined}
            aria-selected={active}
            aria-current={active ? "page" : undefined}
            title={entry.rel}
            onClick={() => (dir ? toggleDir(entry.rel) : onOpen(entry.rel))}
            onContextMenu={(e) => {
              e.preventDefault();
              openMenu(entry, e.clientX, e.clientY);
            }}
            onKeyDown={(e) => onRowKeyDown(e, entry)}
            className={`flex min-h-[26px] w-full items-center gap-1.5 rounded-sm py-[3px] pr-1 text-left text-[12px] transition-colors ${
              active ? "bg-subtle-2 font-medium text-ink" : "text-body hover:bg-subtle-3 hover:text-ink"
            }`}
            style={{ paddingLeft: 6 + depth * 13 }}
          >
            {dir ? (
              <ChevronIcon
                width={11}
                height={11}
                className={`shrink-0 text-muted transition-transform ${open ? "rotate-90" : ""}`}
              />
            ) : (
              <span className="w-[11px] shrink-0" />
            )}
            <EntryIcon entry={entry} />
            <span className="truncate">{dir ? entry.name : baseName(entry.rel)}</span>
            {!dir && dirty?.has(entry.rel) ? (
              <span
                aria-label="未保存"
                title="有未保存的修改"
                className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-warn"
              />
            ) : null}
          </button>
          {/* 键盘可达的「更多操作」：右键菜单不是唯一入口（读屏/键盘用户点不到右键） */}
          <button
            type="button"
            aria-label={`更多操作 ${dir ? entry.name : baseName(entry.rel)}`}
            aria-haspopup="menu"
            onClick={(e) => {
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              openMenu(entry, rect.right, rect.bottom + 2);
            }}
            className="ml-0.5 hidden h-5 w-5 shrink-0 items-center justify-center rounded-sm text-muted hover:bg-subtle-3 hover:text-ink group-hover:flex focus:flex"
          >
            <span aria-hidden="true">⋯</span>
          </button>
        </div>,
      ];
      if (dir && open && entry.children?.length) {
        rows.push(...renderRows(entry.children, depth + 1));
      }
      return rows;
    });

  const menuItem = (
    label: string,
    action: (() => void) | null,
    disabledHint?: string,
  ) => (
    <button
      key={label}
      type="button"
      role="menuitem"
      aria-disabled={action ? undefined : true}
      disabled={!action}
      title={action ? undefined : disabledHint}
      onClick={action ?? undefined}
      className={`flex w-full items-center rounded-sm px-2.5 py-1 text-left text-[12px] ${
        action
          ? "text-ink hover:bg-subtle-3"
          : "cursor-not-allowed text-muted disabled:opacity-100"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 px-2 pb-1">
        <span className="ui-micro text-muted">文件</span>
        <button
          type="button"
          aria-label="新建笔记（库根）"
          title="新建笔记（库根）"
          onClick={() => setPrompt({ kind: "new-note", dir: "", initial: "" })}
          className="flex h-6 w-6 items-center justify-center rounded-sm text-muted hover:bg-subtle-3 hover:text-ink"
        >
          <PlusIcon width={13} height={13} />
        </button>
      </div>

      {error ? (
        <p className="ui-alert ui-alert-danger mx-2 mb-1" role="alert">
          {error}
        </p>
      ) : null}

      <div ref={rootRef} role="tree" aria-label="知识库文件树" className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {tree.length === 0 ? (
          <div className="px-2 py-6 text-center">
            <p className="ui-caption">这个库还没有文件。</p>
            <button
              type="button"
              onClick={() => setPrompt({ kind: "new-note", dir: "", initial: "" })}
              className="ui-btn ui-btn-sm ui-btn-ghost mt-2"
            >
              新建第一篇笔记
            </button>
          </div>
        ) : (
          renderRows(tree, 0)
        )}
      </div>

      {menu ? (
        <div
          ref={menuRef}
          role="menu"
          aria-label={`文件操作：${baseName(menu.rel)}`}
          className="fixed z-50 flex w-[168px] flex-col gap-0.5 rounded-lg border border-line bg-surface p-1 shadow-card"
          style={{ left: menu.x, top: menu.y }}
        >
          {menuItem("新建笔记", () =>
            openPrompt({ kind: "new-note", dir: menu.dir, initial: "" }),
          )}
          {menuItem(
            "新建文件夹",
            onCreateFolder
              ? () => openPrompt({ kind: "new-folder", dir: menu.dir, initial: "" })
              : null,
            "当前桌面桥只支持建文件、不建空目录，可先新建带路径的笔记（如 项目/想法）",
          )}
          {menu.isFile
            ? menuItem("重命名", () =>
                openPrompt({
                  kind: "rename",
                  dir: menu.dir,
                  from: menu.rel,
                  initial: baseName(menu.rel),
                }),
              )
            : null}
          {menu.isFile
            ? menuItem("删除", () => {
                setMenu(null);
                setConfirmDelete(menu.rel);
              })
            : null}
          {menuItem("在资源管理器中显示", () => {
            setMenu(null);
            onReveal(menu.rel);
          })}
        </div>
      ) : null}

      {prompt ? (
        <PromptDialog
          title={
            prompt.kind === "rename"
              ? "重命名"
              : prompt.kind === "new-folder"
                ? "新建文件夹"
                : "新建笔记"
          }
          label={prompt.kind === "rename" ? "新名称" : prompt.kind === "new-folder" ? "文件夹名" : "笔记名"}
          initialValue={prompt.kind === "rename" ? prompt.initial : prompt.initial}
          hint={prompt.kind === "new-note" ? "不写扩展名时会自动补 .md；可用 目录/文件名 建子目录。" : undefined}
          onCancel={() => setPrompt(null)}
          onConfirm={(value) => {
            const current = prompt;
            setPrompt(null);
            if (current.kind === "rename" && current.from) {
              onRename(current.from, joinRel(current.dir, ensureMdExt(value)));
            } else if (current.kind === "new-folder") {
              onCreateFolder?.(current.dir, value.trim());
            } else {
              onCreateFile(current.dir, ensureMdExt(value));
            }
          }}
        />
      ) : null}

      {confirmDelete ? (
        <ConfirmDialog
          title="删除文件"
          onCancel={() => setConfirmDelete(null)}
          footer={
            <>
              <button type="button" onClick={() => setConfirmDelete(null)} className="ui-btn ui-btn-md ui-btn-ghost">
                取消
              </button>
              <button
                type="button"
                onClick={() => {
                  const rel = confirmDelete;
                  setConfirmDelete(null);
                  onDelete(rel);
                }}
                className="ui-btn ui-btn-md ui-btn-danger"
              >
                删除
              </button>
            </>
          }
        >
          <p className="ui-body-sm">
            确定删除 <span className="font-medium">{baseName(confirmDelete)}</span>？
          </p>
          <p className="ui-caption mt-1">只删除这一个文件，目录与其它文件不受影响；删除后不可撤销。</p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
