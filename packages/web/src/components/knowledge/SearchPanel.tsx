import { useState } from "react";
import type { SearchHit } from "../../lib/vault/types.js";

/**
 * 搜索面板：Obsidian 风格子集查询（`tag:` / `path:` / `file:` / `line:` / 引号短语 / `-` 排除）。
 *
 * 查询与结果都由页面（store）持有：组件只负责输入、语法提示、结果行与跳转，
 * 这样「输入 → runSearch → 索引重建后重算」这条链只有一份状态，不会输入框与结果各算一次。
 *
 * 高亮不用 markdown 链：结果是纯文本片段，按查询里的正向词切片加 <mark> 即可，
 * 既不会误解释标签，也不会引入 HTML 注入面。
 */

export interface SearchPanelProps {
  /** 受控查询串。 */
  query: string;
  onQueryChange: (value: string) => void;
  /** 已执行的结果（页面用 `runSearch(index, query, { lineOffsetOf })` 算好）。 */
  hits: SearchHit[];
  /** 是否已经执行过一次搜索（区分「还没搜」与「搜了没结果」）。 */
  searched?: boolean;
  /** 搜索中 / 索引构建中。 */
  busy?: boolean;
  /** 索引未就绪时禁用输入（仍显示提示）。 */
  disabled?: boolean;
  /** 打开命中（rel + 行号，行号已由 store 的 lineOffsetOf 还原成编辑器行）。 */
  onOpenHit: (hit: SearchHit) => void;
  /** 清空查询。 */
  onClear?: () => void;
}

/** 语法提示：点一下就把这个词插到查询末尾（省得用户背语法）。 */
const SYNTAX_HINTS: { token: string; label: string; title: string }[] = [
  { token: "tag:", label: "tag:", title: "按标签过滤，例如 tag:#项目" },
  { token: "path:", label: "path:", title: "按路径过滤，例如 path:inbox/" },
  { token: "file:", label: "file:", title: "按文件名过滤，例如 file:会议" },
  { token: "line:", label: "line:", title: "按正文关键字过滤，例如 line:结论" },
  { token: '""', label: "\"短语\"", title: "精确短语匹配" },
  { token: "-", label: "-排除", title: "排除词，例如 -草稿" },
];

/** 从查询串里取「正向词」（去掉 key: 前缀、引号、排除项），用于结果片段高亮。 */
export function highlightTerms(query: string): string[] {
  const terms: string[] = [];
  // 逐 token 扫描：保留引号内的空格，识别 key: 前缀与 - 排除
  const tokenRe = /\s*(-?)\s*(?:([a-zA-Z]+):)?\s*("([^"]*)"|[^\s"]+)/g;
  for (let match = tokenRe.exec(query); match; match = tokenRe.exec(query)) {
    if (match[1] === "-") continue; // 排除词不参与高亮
    const word = match[3].startsWith('"') ? (match[4] ?? "") : match[3];
    let value = word.trim();
    if (value.startsWith("#")) value = value.slice(1);
    // 纯语法符号（如刚点出来的 `tag:`）不参与高亮
    if (!value || /^[#:"]+$/.test(value)) continue;
    terms.push(value);
  }
  // 长词优先，避免短词把长词切成碎片
  return [...new Set(terms)].sort((a, b) => b.length - a.length);
}

/** 把片段按正向词切成「普通/命中」段（大小写不敏感，正则元字符已转义）。 */
export function splitHighlight(
  text: string,
  terms: readonly string[],
): { text: string; hit: boolean }[] {
  if (!terms.length || !text) return [{ text, hit: false }];
  const pattern = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return text
    .split(pattern)
    .filter((part) => part !== "")
    .map((part) => ({
      text: part,
      hit: terms.some((term) => term.toLowerCase() === part.toLowerCase()),
    }));
}

export function SearchPanel({
  query,
  onQueryChange,
  hits,
  searched = false,
  busy = false,
  disabled = false,
  onOpenHit,
  onClear,
}: SearchPanelProps) {
  const [focusedHint, setFocusedHint] = useState(false);
  const terms = highlightTerms(query);
  const trimmed = query.trim();

  const appendToken = (token: string) => {
    const needsSpace = query.length > 0 && !query.endsWith(" ");
    onQueryChange(`${query}${needsSpace ? " " : ""}${token}`);
  };

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-center gap-1.5 px-2 pb-1.5">
        <input
          className="ui-input h-7 text-[12px]"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onFocus={() => setFocusedHint(true)}
          onBlur={() => setFocusedHint(false)}
          disabled={disabled}
          placeholder='搜全库：tag: path: "短语" -排除'
          aria-label="搜索知识库"
          autoComplete="off"
          spellCheck={false}
        />
        {query ? (
          <button
            type="button"
            onClick={() => (onClear ? onClear() : onQueryChange(""))}
            aria-label="清空搜索"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-muted hover:bg-subtle-3 hover:text-ink"
          >
            ×
          </button>
        ) : null}
      </div>

      {focusedHint ? (
        <div className="flex flex-wrap gap-1 px-2 pb-1.5" aria-label="搜索语法提示">
          {SYNTAX_HINTS.map((hint) => (
            <button
              key={hint.token}
              type="button"
              title={hint.title}
              aria-label={hint.title}
              // 用 mouseDown 而不是 click：输入框 blur 会先收起提示，click 就点不到了
              onMouseDown={(e) => {
                e.preventDefault();
                appendToken(hint.token);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  appendToken(hint.token);
                }
              }}
              className="ui-chip cursor-pointer hover:border-line-strong hover:text-ink"
            >
              {hint.label}
            </button>
          ))}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2" aria-live="polite">
        {disabled ? (
          <p className="px-2 py-3 text-[12px] leading-5 text-muted">索引还在建，稍等一下就能搜。</p>
        ) : !trimmed ? (
          <p className="px-2 py-3 text-[12px] leading-5 text-muted">
            输入关键词开始搜索。数据全部在本机，不会上传。
          </p>
        ) : busy ? (
          <p className="px-2 py-3 text-[12px] text-muted">正在搜索…</p>
        ) : hits.length === 0 ? (
          <p className="px-2 py-3 text-[12px] leading-5 text-muted">
            {searched ? "没有匹配的笔记。试试减少关键词，或换个 tag:/path: 条件。" : "回车开始搜索。"}
          </p>
        ) : (
          <>
            <p className="ui-caption px-2 pb-1">
              {hits.length} 条结果{trimmed ? `：${trimmed}` : ""}
            </p>
            {hits.map((hit, index) => (
              <button
                key={`${hit.rel}-${hit.line}-${index}`}
                type="button"
                onClick={() => onOpenHit(hit)}
                aria-label={`打开 ${hit.rel} 第 ${hit.line} 行`}
                className="mb-0.5 flex w-full flex-col rounded-sm px-2 py-1 text-left transition-colors hover:bg-subtle-3"
              >
                <span className="flex items-baseline gap-1.5">
                  <span className="truncate text-[12px] font-medium text-ink">{hit.rel}</span>
                  <span className="shrink-0 text-[10px] tabular-nums text-muted">第 {hit.line} 行</span>
                </span>
                <span className="line-clamp-2 text-[11px] leading-[17px] text-muted">
                  {splitHighlight(hit.snippet, terms).map((part, partIndex) =>
                    part.hit ? (
                      <mark
                        key={partIndex}
                        className="rounded-[2px] bg-[#fde68a] px-0.5 text-[#3b2b00]"
                      >
                        {part.text}
                      </mark>
                    ) : (
                      <span key={partIndex}>{part.text}</span>
                    ),
                  )}
                </span>
              </button>
            ))}
            {hits.length >= 200 ? (
              <p className="ui-caption px-2 py-1">已到 200 条上限，缩小条件可以看更多。</p>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
