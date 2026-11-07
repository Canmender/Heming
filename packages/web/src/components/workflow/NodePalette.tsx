/**
 * 节点面板：搜索 + 分组 + 键盘选择，回车/点击把节点加进画布。
 *
 * 为什么按 `description.group` 分组而不是维护一份手写清单：节点库会持续增加，
 * 分组信息已经在节点描述里；再抄一份清单必然漂移。这里只负责「注册表里有什么」。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { listNodeTypes } from "../../lib/workflow/registry.js";
import type { NodeGroup, NodeTypeDescription } from "../../lib/workflow/types.js";
import { NodeIcon } from "./nodeIcons.js";

export interface NodePaletteProps {
  open: boolean;
  onPick: (type: string) => void;
  onClose: () => void;
}

const GROUP_LABEL: Record<NodeGroup, string> = {
  trigger: "触发器",
  action: "动作",
  transform: "数据与转换",
  flow: "流程与分支",
  ai: "智能",
  output: "输出",
};

const GROUP_ORDER: NodeGroup[] = ["trigger", "transform", "flow", "action", "ai", "output"];

interface PaletteItem {
  type: string;
  displayName: string;
  description: string;
  group: NodeGroup;
  isTrigger: boolean;
  /** 节点描述的 icon key（画布与面板共用一套映射）。 */
  icon?: string;
}

function toItems(types: readonly { description: NodeTypeDescription }[]): PaletteItem[] {
  return types.map((node) => ({
    type: node.description.type,
    displayName: node.description.displayName,
    description: node.description.description,
    group: node.description.group,
    isTrigger: node.description.isTrigger === true,
    ...(node.description.icon ? { icon: node.description.icon } : {}),
  }));
}

/** 搜索：名称、类型 id、说明都参与匹配（中文直接 includes）。 */
export function filterPaletteItems(items: readonly PaletteItem[], query: string): PaletteItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...items];
  return items.filter(
    (item) =>
      item.displayName.toLowerCase().includes(q) ||
      item.type.toLowerCase().includes(q) ||
      item.description.toLowerCase().includes(q),
  );
}

export function NodePalette({ open, onPick, onClose }: NodePaletteProps) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const items = useMemo(() => toItems(listNodeTypes()), []);
  const filtered = useMemo(() => filterPaletteItems(items, query), [items, query]);
  const groups = useMemo(() => {
    const map = new Map<NodeGroup, PaletteItem[]>();
    for (const item of filtered) {
      const list = map.get(item.group) ?? [];
      list.push(item);
      map.set(item.group, list);
    }
    return GROUP_ORDER.filter((group) => (map.get(group)?.length ?? 0) > 0).map((group) => ({
      group,
      label: GROUP_LABEL[group],
      items: map.get(group)!,
    }));
  }, [filtered]);
  const flat = useMemo(() => groups.flatMap((group) => group.items), [groups]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setCursor(0);
    // 打开即落焦：用户可以直接打字搜索
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  useEffect(() => {
    setCursor((current) => Math.min(current, Math.max(0, flat.length - 1)));
  }, [flat.length]);

  if (!open) return null;

  const pick = (item: PaletteItem | undefined) => {
    if (!item) return;
    onPick(item.type);
  };

  return (
    <div
      className="absolute inset-0 z-30 flex items-start justify-center bg-black/20 pt-[12vh]"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="节点面板"
        className="flex max-h-[70vh] w-[520px] max-w-[92vw] flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-float"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
            return;
          }
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setCursor((current) => Math.min(Math.max(0, flat.length - 1), current + 1));
            return;
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            setCursor((current) => Math.max(0, current - 1));
            return;
          }
          if (event.key === "Enter") {
            event.preventDefault();
            pick(flat[cursor]);
          }
        }}
      >
        <div className="border-b border-line-soft p-3">
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索节点：HTTP、代码、条件、大模型…"
            aria-label="搜索节点"
            className="ui-input w-full"
          />
          <p className="mt-1.5 ui-micro">
            共 {filtered.length} 个节点；↑↓ 选择，回车添加，Esc 关闭。
          </p>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {groups.length === 0 ? (
            <p className="p-6 text-center ui-caption">没有匹配的节点。换个关键词试试，或清空搜索。</p>
          ) : (
            groups.map((group) => (
              <section key={group.group} aria-label={`节点分组 ${group.label}`} className="mb-1">
                <h2 className="px-2 py-1 ui-caption">{group.label}</h2>
                <ul>
                  {group.items.map((item) => {
                    const index = flat.indexOf(item);
                    const active = index === cursor;
                    return (
                      <li key={item.type}>
                        <button
                          type="button"
                          onClick={() => pick(item)}
                          onPointerEnter={() => setCursor(index)}
                          aria-label={`添加节点 ${item.displayName}`}
                          className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left ${
                            active ? "bg-subtle-2" : "hover:bg-subtle"
                          }`}
                        >
                          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-line-soft bg-white text-ink">
                            <NodeIcon icon={item.icon} width={15} height={15} />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate ui-body-sm font-medium">{item.displayName}</span>
                            <span className="block truncate ui-micro">{item.description}</span>
                          </span>
                          {item.isTrigger ? (
                            <span className="shrink-0 rounded border border-line-soft px-1 text-[10px] text-muted">
                              触发
                            </span>
                          ) : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
