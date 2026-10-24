import { useEffect, useMemo, useRef, useState } from "react";
import type { Conversation } from "@heming/shared";
import { activeConversationsOf, useChatStore } from "../store/chat.js";
import { useUiStore } from "../store/ui.js";
import { skillPool } from "../lib/skills/index.js";
import { convLabel } from "./ChatPage.js";
import { Avatar } from "./Avatar.js";
import { useModalA11y } from "./useModalA11y.js";

/**
 * 全局搜索（Ctrl/⌘+K）。
 *
 * ## 为什么先做这几类
 *
 * 搜的是**已经在内存里的东西**：会话与技能。不碰消息正文——
 * 那要先按会话逐个拉取（N+1 请求），还要本地建索引，是单独一件事。
 * 与其做一个点下去要转圈好几秒的「全局搜索」，不如先把「找会话」这个
 * 最高频场景做到瞬时响应，并在结果里明确说明当前搜的是哪几类。
 *
 * ## 归档会话也参与搜索
 *
 * 归档的含义是「不在列表里占位置」，不是「搜不到」。
 * 找不到的东西才会去归档，所以这里必须能找到它——结果里会标出「已归档」。
 */

export type SearchResult =
  | { kind: "conversation"; id: string; name: string; avatar?: string; detail: string; archived: boolean }
  | { kind: "skill"; id: string; name: string; detail: string };

/** 把会话翻成一条结果。 */
function convResult(c: Conversation): SearchResult {
  const label = convLabel(c);
  const type = label.group ? "群聊" : c.type === "agent" ? "智能体" : "好友";
  return {
    kind: "conversation",
    id: c.id,
    name: label.name,
    avatar: label.avatar,
    detail: c.archivedAt ? `${type} · 已归档` : type,
    archived: Boolean(c.archivedAt),
  };
}

/**
 * 纯函数版搜索，便于单测：输入关键词，出结果列表。
 *
 * 排序规则：前缀命中优先于包含命中——打「张三」时，叫「张三」的会话
 * 应该排在「张三李四群」前面，而不是靠数据顺序碰运气。
 */
export interface SearchOutcome {
  /** 截断后实际展示的结果（会话最多 8、技能最多 5）。 */
  results: SearchResult[];
  /** 命中总数（含被上限截掉的），用于「还有 N 条」提示。 */
  total: number;
}

export function searchAllDetailed(keyword: string, conversations: Conversation[]): SearchOutcome {
  const q = keyword.trim().toLowerCase();
  if (!q) return { results: [], total: 0 };

  const convMatches = conversations
    .map(convResult)
    .filter((r) => r.name.toLowerCase().includes(q))
    .sort((a, b) => {
      const aPrefix = a.name.toLowerCase().startsWith(q) ? 0 : 1;
      const bPrefix = b.name.toLowerCase().startsWith(q) ? 0 : 1;
      if (aPrefix !== bPrefix) return aPrefix - bPrefix;
      // 未归档的排前：更可能是当下要处理的
      if (a.kind === "conversation" && b.kind === "conversation" && a.archived !== b.archived) {
        return a.archived ? 1 : -1;
      }
      return a.name.localeCompare(b.name, "zh");
    });

  const skillMatches: SearchResult[] = skillPool
    .list()
    .filter((s) => s.name.toLowerCase().includes(q) || (s.description ?? "").toLowerCase().includes(q))
    .map((s) => ({
      kind: "skill" as const,
      id: s.id,
      name: s.name,
      detail: s.description ? s.description.slice(0, 40) : "技能",
    }));

  const results = [...convMatches.slice(0, 8), ...skillMatches.slice(0, 5)];
  return { results, total: convMatches.length + skillMatches.length };
}

export function searchAll(keyword: string, conversations: Conversation[]): SearchResult[] {
  return searchAllDetailed(keyword, conversations).results;
}

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const conversations = useChatStore((s) => s.conversations);
  const openConversation = useUiStore((s) => s.openConversation);
  const setPage = useUiStore((s) => s.setPage);

  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const { results, total } = useMemo(() => searchAllDetailed(query, conversations), [query, conversations]);
  const hidden = total - results.length;

  // 唤起即聚焦 + Tab 困在面板内：命令面板的整个意义就是「键盘打字开始找」
  useModalA11y(panelRef, onClose, { closeOnEscape: false, initialFocusRef: inputRef });

  // 结果集变化时把光标收回第一项，避免停在一个已经不存在的位置
  useEffect(() => {
    setCursor(0);
  }, [query]);

  const run = (r: SearchResult | undefined) => {
    if (!r) return;
    if (r.kind === "conversation") {
      openConversation(r.id);
    } else {
      // 技能没有「详情页路由」，跳到技能区即可——比什么都不做强，
      // 而且用户在这个位置真正想做的是找那个技能，到了列表里一眼能认出来
      setPage("skills");
    }
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
      setCursor((c) => (results.length === 0 ? 0 : (c + 1) % results.length));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => (results.length === 0 ? 0 : (c - 1 + results.length) % results.length));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      run(results[cursor]);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/20 pt-[12vh]"
      onMouseDown={onClose}
      role="presentation"
    >
      <div
        ref={panelRef}
        className="w-[520px] max-w-[92vw] overflow-hidden rounded-xl border border-line bg-white shadow-[0_12px_40px_rgba(0,0,0,0.18)]"
        onMouseDown={(e) => e.stopPropagation()}
        // 键盘约定挂在面板容器上而不是输入框：焦点移到结果按钮后（Tab/方向键），
        // Esc 与上下选择仍然生效，不需要先把焦点移回输入框。
        onKeyDown={onKeyDown}
        role="dialog"
        aria-modal="true"
        aria-label="全局搜索"
      >
        <input
          ref={inputRef}
          aria-label="搜索会话与技能"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索会话、技能…"
          className="w-full border-b border-line-soft px-3.5 py-2.5 text-[13px] outline-none placeholder:text-[#bbb]"
        />

        <div className="max-h-[46vh] overflow-y-auto py-1">
          {query.trim() === "" ? (
            <div className="px-3.5 py-3 text-[12px] text-muted">
              输入关键词开始搜索。当前可搜：会话（含已归档）、技能。
              <div className="mt-1 text-[11px] text-[#aaa]">
                消息正文的全文检索尚未支持——它需要按会话逐条拉取与索引，是单独一项工作。
              </div>
            </div>
          ) : results.length === 0 ? (
            <div className="px-3.5 py-3 text-[12px] text-muted">没有匹配「{query}」的结果。</div>
          ) : (
            results.map((r, i) => (
              <button
                key={`${r.kind}-${r.id}`}
                type="button"
                aria-label={`选择 ${r.name}`}
                onMouseEnter={() => setCursor(i)}
                onClick={() => run(r)}
                className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[12px] ${
                  i === cursor ? "bg-[#f4f4f4]" : ""
                }`}
              >
                {r.kind === "conversation" ? (
                  <Avatar user={{ displayName: r.name, avatar: r.avatar }} size={22} />
                ) : (
                  <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded bg-[#f0f0f0] text-[10px] text-muted">
                    技
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{r.name}</span>
                  <span className="block truncate text-[10px] text-muted">{r.detail}</span>
                </span>
                {r.kind === "conversation" && r.archived ? (
                  <span className="shrink-0 rounded border border-line px-1 text-[10px] text-muted">
                    已归档
                  </span>
                ) : null}
              </button>
            ))
          )}
          {hidden > 0 && (
            <div className="border-t border-line-soft px-3.5 py-1.5 text-[11px] text-muted">
              还有 {hidden} 条
            </div>
          )}
        </div>

        <div className="flex items-center gap-3 border-t border-line-soft px-3.5 py-1.5 text-[10px] text-[#aaa]">
          <span>↑↓ 选择</span>
          <span>Enter 打开</span>
          <span>Esc 关闭</span>
        </div>
      </div>
    </div>
  );
}