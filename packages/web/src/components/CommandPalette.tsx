import { useEffect, useMemo, useRef, useState } from "react";
import type { TeamMember } from "@heming/shared";
import { fetchTeam } from "../lib/api.js";
import { useUiStore } from "../store/ui.js";
import { skillPool } from "../lib/skills/index.js";
import {
  callInfohub,
  formatInfohubTime,
  readInfohubConfig,
  type InfohubSearchHit,
  type InfohubSearchResult,
} from "../lib/infohub/client.js";
import { useInfohubStore } from "../lib/infohub/store.js";
import { Avatar } from "./Avatar.js";
import { useModalA11y } from "./useModalA11y.js";

/**
 * 全局搜索（Ctrl/⌘+K）。
 *
 * ## 搜什么
 *
 * 去 IM 后不再有会话可搜：成员（团队名册）、技能、以及（桌面端连接信息中枢时）
 * 本机 QQ/微信归档。成员与技能已在内存/一次拉取中，输入即出结果；
 * 归档走防抖的 FTS 检索，不在每次击键时打服务端。
 */

export type SearchResult =
  | { kind: "member"; id: string; name: string; username: string; avatar?: string; detail: string }
  | { kind: "skill"; id: string; name: string; detail: string }
  | { kind: "archive"; id: string; name: string; detail: string; hit: InfohubSearchHit };

/** 归档检索防抖与条数：命令面板是快速找东西，不要每敲一个字就打一次 FTS。 */
const ARCHIVE_DEBOUNCE_MS = 250;
const ARCHIVE_LIMIT = 5;

function archiveResult(hit: InfohubSearchHit): SearchResult {
  const text = (hit.content || hit.snippet || "").replace(/<<|>>/g, "").replace(/\s+/g, " ").trim();
  const name = Array.from(text).slice(0, 48).join("") || "（空消息）";
  const source = hit.source === "qq" ? "QQ" : hit.source === "wechat" ? "微信" : hit.source;
  return {
    kind: "archive",
    id: `archive-${hit.id}`,
    name,
    detail: `${source} · ${hit.convName} · ${formatInfohubTime(hit.ts, true)}`,
    hit,
  };
}

/** 相对活跃度：在线 › 最近活跃 › 从未登录。 */
function presenceText(m: TeamMember): string {
  if (m.online) return "在线";
  if (!m.lastSeenAt) return "从未登录";
  const diff = Math.max(0, Date.now() - Date.parse(m.lastSeenAt));
  if (!Number.isFinite(diff)) return "最近活跃";
  if (diff < 3_600_000) return `${Math.max(1, Math.floor(diff / 60_000))} 分钟前活跃`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前活跃`;
  return `${Math.floor(diff / 86_400_000)} 天前活跃`;
}

/** 把成员翻成一条结果。 */
function memberResult(m: TeamMember): SearchResult {
  return {
    kind: "member",
    id: m.user.id,
    name: m.user.displayName,
    username: m.user.username,
    avatar: m.user.avatar,
    detail: `@${m.user.username} · ${presenceText(m)}`,
  };
}

export interface SearchOutcome {
  /** 截断后实际展示的结果（成员最多 8、技能最多 5）。 */
  results: SearchResult[];
  /** 命中总数（含被上限截掉的），用于「还有 N 条」提示。 */
  total: number;
}

/**
 * 纯函数版搜索，便于单测：输入关键词，出成员 + 技能结果。
 *
 * 排序规则：前缀命中优先于包含命中；同前缀内在线成员优先——
 * 找成员时「现在在线的那个人」通常就是要找的人。
 */
export function searchAllDetailed(keyword: string, members: TeamMember[]): SearchOutcome {
  const q = keyword.trim().toLowerCase();
  if (!q) return { results: [], total: 0 };

  const memberMatches = members
    .filter(
      (m) =>
        m.user.displayName.toLowerCase().includes(q) || m.user.username.toLowerCase().includes(q),
    )
    .map(memberResult)
    .sort((a, b) => {
      const aName = a.name.toLowerCase();
      const bName = b.name.toLowerCase();
      const aPrefix = aName.startsWith(q) ? 0 : 1;
      const bPrefix = bName.startsWith(q) ? 0 : 1;
      if (aPrefix !== bPrefix) return aPrefix - bPrefix;
      const aMember = members.find((m) => m.user.id === a.id);
      const bMember = members.find((m) => m.user.id === b.id);
      if (aMember && bMember && aMember.online !== bMember.online) {
        return aMember.online ? -1 : 1;
      }
      return a.name.localeCompare(b.name, "zh");
    });

  const skillMatches: SearchResult[] = skillPool
    .list()
    .filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.description ?? "").toLowerCase().includes(q),
    )
    .map((s) => ({
      kind: "skill" as const,
      id: s.id,
      name: s.name,
      detail: s.description ? s.description.slice(0, 40) : "技能",
    }));

  const results = [...memberMatches.slice(0, 8), ...skillMatches.slice(0, 5)];
  return { results, total: memberMatches.length + skillMatches.length };
}

export function searchAll(keyword: string, members: TeamMember[]): SearchResult[] {
  return searchAllDetailed(keyword, members).results;
}

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const setPage = useUiStore((s) => s.setPage);
  const focusTeamMember = useUiStore((s) => s.focusTeamMember);
  const openInfohub = useUiStore((s) => s.openInfohub);
  const infohubRunning = useInfohubStore((s) => s.running);

  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [membersReady, setMembersReady] = useState(false);
  const [archiveHits, setArchiveHits] = useState<InfohubSearchHit[]>([]);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // 名册一次拉全：成员数量级很小，打开面板时取一次即可，不随击键重复请求。
  useEffect(() => {
    let alive = true;
    fetchTeam()
      .then((roster) => {
        if (alive) setMembers(roster.members);
      })
      .catch(() => {
        if (alive) setMembers([]);
      })
      .finally(() => {
        if (alive) setMembersReady(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  // 归档全文检索：仅在桌面端已连接时启用；防抖 250ms，旧的词立刻清掉避免错配。
  useEffect(() => {
    const q = query.trim();
    if (!q || !infohubRunning) {
      setArchiveHits([]);
      setArchiveBusy(false);
      return;
    }
    let alive = true;
    setArchiveHits([]);
    const timer = window.setTimeout(() => {
      setArchiveBusy(true);
      callInfohub<InfohubSearchResult>("search", { query: q, limit: ARCHIVE_LIMIT }, readInfohubConfig())
        .then((data) => {
          if (alive) setArchiveHits(Array.isArray(data.items) ? data.items : []);
        })
        .catch(() => {
          if (alive) setArchiveHits([]);
        })
        .finally(() => {
          if (alive) setArchiveBusy(false);
        });
    }, ARCHIVE_DEBOUNCE_MS);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [query, infohubRunning]);

  const base = useMemo(() => searchAllDetailed(query, members), [query, members]);
  const results = useMemo(
    () => [...base.results, ...archiveHits.map(archiveResult)],
    [base, archiveHits],
  );
  const hidden = base.total - base.results.length;

  // 唤起即聚焦 + Tab 困在面板内：命令面板的整个意义就是「键盘打字开始找」
  useModalA11y(panelRef, onClose, { closeOnEscape: false, initialFocusRef: inputRef });

  // 结果集变化时把光标收回第一项，避免停在一个已经不存在的位置
  useEffect(() => {
    setCursor(0);
  }, [query, members]);

  const run = (r: SearchResult | undefined) => {
    if (!r) return;
    if (r.kind === "member") {
      focusTeamMember(r.id);
    } else if (r.kind === "archive") {
      // 归档页自己会跑同词检索；这里只投递意图，不在面板里复制结果页
      openInfohub({ tab: "search", query: query.trim() });
    } else {
      // 技能没有「详情页路由」，跳到技能区即可——到了列表里一眼能认出来
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
          aria-label="搜索成员与技能"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索成员、技能…"
          className="w-full border-b border-line-strong px-3.5 py-2.5 text-[13px] outline-hidden placeholder:text-[#bbb]"
        />

        <div className="max-h-[46vh] overflow-y-auto py-1">
          {query.trim() === "" ? (
            <div className="px-3.5 py-3 text-[12px] text-muted">
              输入关键词开始搜索。当前可搜：团队成员、技能
              {infohubRunning ? "、本机归档" : ""}。
              <div className="mt-1 text-[11px] text-muted">
                {infohubRunning
                  ? "本机归档只在本机检索，不会上传。"
                  : "连接信息中枢后，可在这里搜本机 QQ/微信历史消息。"}
              </div>
            </div>
          ) : !membersReady ? (
            <div className="px-3.5 py-3 text-[12px] text-muted">正在加载团队成员…</div>
          ) : results.length === 0 ? (
            <div className="px-3.5 py-3 text-[12px] text-muted">
              {archiveBusy ? `正在检索本机归档「${query.trim()}」…` : `没有匹配「${query}」的结果。`}
            </div>
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
                {r.kind === "member" ? (
                  <Avatar user={{ displayName: r.name, avatar: r.avatar }} size={22} />
                ) : (
                  <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-sm bg-[#f0f0f0] text-[10px] text-muted">
                    {r.kind === "archive" ? "档" : "技"}
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{r.name}</span>
                  <span className="block truncate text-[10px] text-muted">{r.detail}</span>
                </span>
                {r.kind === "member" ? (
                  <span className="shrink-0 rounded-sm border border-line px-1 text-[10px] text-muted">
                    团队
                  </span>
                ) : r.kind === "archive" ? (
                  <span className="shrink-0 rounded-sm border border-line px-1 text-[10px] text-muted">本机</span>
                ) : null}
              </button>
            ))
          )}
          {archiveBusy && results.length > 0 ? (
            <div className="px-3.5 py-1 text-[10px] text-muted">正在检索本机归档…</div>
          ) : null}
          {hidden > 0 && (
            <div className="border-t border-line-soft px-3.5 py-1.5 text-[11px] text-muted">
              还有 {hidden} 条
            </div>
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
