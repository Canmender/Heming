import { useState } from "react";
import type { SharedFileMeta } from "@heming/shared";
import { ChevronIcon, FileIcon, FolderIcon } from "./icons.js";

export type TreeItem = SharedFileMeta & { parentId?: string };

interface Props {
  items: TreeItem[];
  localPaths: string[];
}

function Row({ label, depth, onClick, ariaLabel, expandable, expanded }: {
  label: string;
  depth: number;
  onClick?: () => void;
  ariaLabel?: string;
  expandable?: boolean;
  expanded?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={onClick}
      className="flex w-full items-center gap-1.5 rounded px-2 py-[3px] text-left text-[12px] text-[#444] hover:bg-[#f3f3f3]"
      style={{ paddingLeft: 8 + depth * 14 }}
    >
      {expandable ? (
        <ChevronIcon
          width={11}
          height={11}
          className={`shrink-0 text-muted transition-transform ${expanded ? "rotate-90" : ""}`}
        />
      ) : (
        <span className="w-[11px] shrink-0" />
      )}
      <span className="truncate">{label}</span>
    </button>
  );
}

function SectionRows({ title, items, rootParentId }: { title: string; items: TreeItem[]; rootParentId?: string }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const children = (id: string) => items.filter((i) => i.parentId === id);
  const roots = rootParentId === undefined ? items.filter((i) => !i.parentId) : children(rootParentId);

  const render = (list: TreeItem[], depth: number): JSX.Element[] =>
    list.map((item) => {
      const isDir = item.mime === "inode/directory";
      const kids = isDir ? children(item.id) : [];
      const isOpen = open.has(item.id);
      return (
        <div key={item.id}>
          <Row
            label={item.name}
            depth={depth}
            ariaLabel={isDir ? `切换文件夹 ${item.name}` : undefined}
            expandable={isDir}
            expanded={isOpen}
            onClick={isDir ? () => toggle(item.id) : undefined}
          />
          {isDir && isOpen ? render(kids, depth + 1) : null}
        </div>
      );
    });

  return (
    <div className="mb-3">
      <div className="px-2 pb-1 text-[10px] font-bold uppercase tracking-wider text-muted">{title}</div>
      {roots.length > 0 ? render(roots, 0) : <div className="px-2 text-[11px] text-muted">（空）</div>}
    </div>
  );
}

export function FileTree({ items, localPaths }: Props) {
  return (
    <div className="flex h-full flex-col gap-1 overflow-y-auto bg-panel py-2">
      <SectionRows title="云端共享" items={items} />
      <div className="mx-2 border-t border-line-soft" />
      <div className="mb-1 mt-1 px-2 pb-0 text-[10px] font-bold uppercase tracking-wider text-muted">
        本地工作目录
      </div>
      {localPaths.length === 0 ? (
        <div className="px-2 text-[11px] text-muted">未绑定本地目录</div>
      ) : (
        localPaths.map((p) => (
          <Row key={p} label={p.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? p} depth={0} />
        ))
      )}
    </div>
  );
}
