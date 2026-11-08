import { useMemo, useState } from "react";

/**
 * 左栏标签面板：标签计数 + 点击过滤 + 搜索框筛标签。
 *
 * 数据直接吃 `VaultIndex.tags`（tag → 页面 rel 列表），组件自己不维护索引状态。
 * 点击当前已选标签 = 取消过滤（同一个入口进、同一个入口出，不用另找「清除」）。
 */

export interface TagPanelProps {
  /** tag → 页面 rel 列表（`VaultIndex.tags`）。 */
  tags: Map<string, string[]> | Array<{ tag: string; count: number }>;
  /** 当前过滤标签；null 表示不过滤。 */
  activeTag?: string | null;
  /** 选择标签；传 null 表示清除过滤。 */
  onSelectTag: (tag: string | null) => void;
  /** 面板标题（缺省「标签」）。 */
  title?: string;
}

/** 统一成 `{tag, count}` 并按「数量降序 → 名称升序」排序（确定性）。 */
export function normalizeTags(
  tags: TagPanelProps["tags"],
): { tag: string; count: number }[] {
  const entries: { tag: string; count: number }[] = Array.isArray(tags)
    ? [...tags]
    : [...tags.entries()].map(([tag, rels]) => ({ tag, count: rels.length }));
  return entries.sort(
    (a, b) => b.count - a.count || a.tag.localeCompare(b.tag, "zh-Hans-CN"),
  );
}

export function TagPanel({ tags, activeTag = null, onSelectTag, title = "标签" }: TagPanelProps) {
  const [filter, setFilter] = useState("");
  const all = useMemo(() => normalizeTags(tags), [tags]);
  const keyword = filter.trim().toLowerCase();
  const visible = keyword
    ? all.filter((item) => item.tag.toLowerCase().includes(keyword))
    : all;

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 px-2 pb-1">
        <span className="ui-micro text-muted">{title}</span>
        {activeTag ? (
          <button
            type="button"
            onClick={() => onSelectTag(null)}
            className="ui-link h-5 text-[10px]"
            aria-label={`清除标签过滤：${activeTag}`}
          >
            清除过滤
          </button>
        ) : null}
      </div>
      <div className="px-2 pb-1.5">
        <input
          className="ui-input h-7 text-[12px]"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="筛选标签"
          aria-label="筛选标签"
        />
      </div>

      {activeTag ? (
        <p className="ui-caption px-2 pb-1">
          正在按 <span className="font-medium text-ink">#{activeTag}</span> 过滤
        </p>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2" aria-label="标签列表">
        {all.length === 0 ? (
          <p className="px-2 py-3 text-[12px] leading-5 text-muted">
            还没有标签。正文里写 #标签，或在 frontmatter 的 tags 里加一项。
          </p>
        ) : visible.length === 0 ? (
          <p className="px-2 py-3 text-[12px] leading-5 text-muted">没有匹配「{filter.trim()}」的标签。</p>
        ) : (
          visible.map((item) => {
            const active = activeTag?.toLowerCase() === item.tag.toLowerCase();
            return (
              <button
                key={item.tag}
                type="button"
                aria-pressed={active}
                aria-label={`按标签 ${item.tag} 过滤（${item.count} 篇）`}
                onClick={() => onSelectTag(active ? null : item.tag)}
                className={`flex w-full items-center gap-1.5 rounded-sm px-2 py-1 text-left text-[12px] leading-5 transition-colors ${
                  active
                    ? "bg-subtle-3 font-medium text-ink"
                    : "text-body hover:bg-subtle-3 hover:text-ink"
                }`}
              >
                <span className="truncate">#{item.tag}</span>
                <span className="ml-auto shrink-0 text-[10px] tabular-nums text-muted">{item.count}</span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
