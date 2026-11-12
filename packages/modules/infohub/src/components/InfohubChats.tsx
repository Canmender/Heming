import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { callInfohub, describeInfohubError, readInfohubConfig } from "@heming/sdk";

/**
 * 「会话」页签：浏览归档里的 QQ / 微信聊天记录。
 *
 * 为什么并进模块、而不是继续用 infohub-page 插件：插件自带一份 Python 引擎和浏览器壳，
 * 数据源、只读红线、UI 规范都要和维护两遍；并入后只走宿主桥的 conversations / messages，
 * 归档仍然只在本机读取，插件也不再需要单独安装与授权。
 *
 * 交互对齐原插件：左列表（来源筛选 + 会话名关键词 + 总数）、右消息流（按天分隔、
 * 群聊显示发送人、自己靠右、向前翻页时保持滚动位置、按 id 去重）。
 *
 * 插件原有的「把会话生成摘要写入知识库」不并进来：它依赖插件的 kb.archive 私有通道，
 * 宿主桥没有这个能力，硬接会绕开模块权限边界；需要摘要时走检索/日程已有的能力。
 */

/** 会话一次多取一些：列表本身很轻，频繁翻页反而更烦；真实总数由桥返回，用「加载更多」继续。 */
const CONV_PAGE = 200;
/** 消息一页 80 条：一次渲染太多会让首屏和翻页都变慢。 */
const MSG_PAGE = 80;
/** 同一发送人 5 分钟内连发合并成一组，少一截重复的发送人头。 */
const MERGE_GAP_SECONDS = 300;
/** 关键词防抖：边输入边打桥会让管道排队，220ms 足够覆盖正常打字间隔。 */
const KEYWORD_DEBOUNCE_MS = 220;

type SourceFilter = "all" | "qq" | "wechat";

/**
 * 本地最小接口：桥返回的是归档库原始行（snake_case）。
 *
 * 为什么不在 module.sdk.json 里补类型：SDK 生成器只生成运行时值（`export const x = ...`），
 * 不支持纯类型导出；把 interface 塞进去会变成运行时取值，语义是错的。模块目录也不参与
 * `pnpm -r typecheck`，这里只声明真正用到的字段，避免和宿主类型各维护一份大接口。
 */
interface ChatConversation {
  id: number;
  source: string;
  name: string;
  kind: string;
  last_ts: number;
  message_count?: number;
}

interface ChatMessage {
  id: number;
  conversation_id: number;
  ts: number;
  sender_id: string;
  sender_name: string;
  is_self: boolean | null;
  type_label: string;
  content: string;
}

interface ChatConversationsResult {
  items: ChatConversation[];
  total?: number;
  dbMissing?: boolean;
}

interface ChatMessagesResult {
  conversation: ChatConversation | null;
  items: ChatMessage[];
  hasMore?: boolean;
  dbMissing?: boolean;
}

/**
 * 只声明本组件用得到的归档状态字段（宿主 InfohubStatus 的结构子集）。
 * sdk 里的类型导出是运行时占位值，模块不参与 tsc，这里用结构类型比 import type 更可靠。
 */
interface ChatArchiveStatus {
  hasDb?: boolean;
}

interface InfohubChatsProps {
  /** 归档边车就绪后才拉数据；未就绪时页面显示的是启动卡片，不会渲染本组件。 */
  ready: boolean;
  /** 用于区分「库还没建」和「库是空的」两种空态。 */
  status: ChatArchiveStatus | null;
  /** 归档规模变化（同步完成 / 手动刷新）时换一个 token，触发列表重载；没变就不打扰。 */
  refreshToken?: string;
  /** 复用页面顶部的错误条：数据加载失败不静默吞掉。 */
  onError: (message: string) => void;
}

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

const AVATAR_VARS = [
  "var(--avatar-1)",
  "var(--avatar-2)",
  "var(--avatar-3)",
  "var(--avatar-4)",
  "var(--avatar-5)",
  "var(--avatar-6)",
];

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** 日历天差：用本地零点而不是 24h 除法，避免「昨天 23:59 和今天 00:01」算成同一天。 */
function daysAgo(date: Date, now: Date): number {
  return Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
}

function formatClock(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** 会话列表右侧的时间：今天只给 HH:mm，昨天给「昨天」，今年给月日，跨年给完整日期。 */
function formatListTime(ts: number): string {
  if (!ts) return "";
  const date = new Date(ts * 1000);
  const now = new Date();
  const ago = daysAgo(date, now);
  if (ago === 0) return formatClock(date);
  if (ago === 1) return "昨天";
  if (date.getFullYear() === now.getFullYear()) {
    return `${date.getMonth() + 1}月${date.getDate()}日`;
  }
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** 消息流的按天分隔标题：今天/昨天 → 月日 周X → 跨年补年份。 */
function formatDayLabel(ts: number): string {
  const date = new Date(ts * 1000);
  const now = new Date();
  const ago = daysAgo(date, now);
  if (ago === 0) return "今天";
  if (ago === 1) return "昨天";
  const base = `${date.getMonth() + 1}月${date.getDate()}日 ${WEEKDAYS[date.getDay()]}`;
  return date.getFullYear() === now.getFullYear() ? base : `${date.getFullYear()}年${base}`;
}

/** 按本地日历日分组：同一天的消息共享一个分隔标题。 */
function dayKeyOf(ts: number): string {
  const date = new Date(ts * 1000);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function sourceLabel(source: string): string {
  if (source === "qq") return "QQ";
  if (source === "wechat") return "微信";
  return source || "未知";
}

/** 头像取名字首字（中文一个字、英文一个字母），空名兜底成「?」。 */
function initialOf(name: string): string {
  const trimmed = (name || "").trim();
  if (!trimmed) return "?";
  return Array.from(trimmed)[0].toUpperCase();
}

/**
 * 头像底色按名字哈希取 --avatar-N：同一会话永远同一色，切主题时跟着 token 走，
 * 不会像写死 rgb 那样在暗色下突然刺眼。
 */
function avatarColor(seed: string | number): string {
  const text = String(seed);
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  return AVATAR_VARS[Math.abs(hash) % AVATAR_VARS.length];
}

/** 翻页拼接时按 id 去重：边界上重复的一两条不渲染两遍。 */
function dedupeMessages(items: ChatMessage[]): ChatMessage[] {
  const seen = new Set<number>();
  const out: ChatMessage[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

/** 分组后的渲染行：按天分隔 + 消息（标记是否与上一条合并）。 */
type MessageRow =
  | { kind: "day"; key: string; label: string }
  | { kind: "message"; key: string; message: ChatMessage; merged: boolean };

function buildRows(messages: ChatMessage[]): MessageRow[] {
  const rows: MessageRow[] = [];
  let currentDay = "";
  let previous: ChatMessage | null = null;
  for (const message of messages) {
    const dayKey = dayKeyOf(message.ts);
    if (dayKey !== currentDay) {
      rows.push({ kind: "day", key: `day-${dayKey}`, label: formatDayLabel(message.ts) });
      currentDay = dayKey;
      previous = null;
    }
    const merged = Boolean(
      previous &&
        previous.sender_id === message.sender_id &&
        dayKeyOf(previous.ts) === dayKey &&
        message.ts - previous.ts < MERGE_GAP_SECONDS,
    );
    rows.push({ kind: "message", key: `msg-${message.id}`, message, merged });
    previous = message;
  }
  return rows;
}

/** 列表骨架：首屏加载时占位，避免左栏先塌成空白再弹出内容。 */
function ListSkeleton() {
  return (
    <div className="px-3 py-2">
      {[0, 1, 2, 3].map((index) => (
        <div key={index} className="flex items-center gap-2.5 py-2.5">
          <div className="h-8 w-8 animate-pulse rounded-full bg-[var(--subtle-3)]" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="h-3 w-2/3 animate-pulse rounded bg-[var(--subtle-3)]" />
            <div className="h-2.5 w-1/3 animate-pulse rounded bg-[var(--subtle-3)]" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** 消息骨架：切换会话时右栏给三行占位，比整块空白更不容易误判成「没有消息」。 */
function MessageSkeleton() {
  return (
    <div className="space-y-3 px-4 py-4">
      {[0, 1, 2].map((index) => (
        <div key={index} className={`flex ${index % 2 === 0 ? "justify-start" : "justify-end"}`}>
          <div
            className={`h-9 animate-pulse rounded-lg bg-[var(--subtle-3)] ${
              index % 2 === 0 ? "w-2/5" : "w-1/3"
            }`}
          />
        </div>
      ))}
    </div>
  );
}

export function InfohubChats({ ready, status, refreshToken, onError }: InfohubChatsProps) {
  const [conversations, setConversations] = useState<ChatConversation[]>([]);
  const [convTotal, setConvTotal] = useState(0);
  const [convLimit, setConvLimit] = useState(CONV_PAGE);
  const [convLoading, setConvLoading] = useState(false);
  const [listDbMissing, setListDbMissing] = useState(false);

  const [source, setSource] = useState<SourceFilter>("all");
  const [keywordInput, setKeywordInput] = useState("");
  const [keyword, setKeyword] = useState("");

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [messagesDbMissing, setMessagesDbMissing] = useState(false);

  const msgSeqRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /** 渲染后要恢复的滚动位置：首屏/切会话贴底，向前翻页保持视口内容不动。 */
  const pendingScrollRef = useRef<
    { mode: "bottom" } | { mode: "preserve"; height: number; top: number } | null
  >(null);

  /** 关键词防抖：输入停下 220ms 才真正打桥。 */
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setKeyword(keywordInput.trim());
    }, KEYWORD_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [keywordInput]);

  /** 筛选条件变了就回到列表顶部并清空列表与选中：旧结果不再符合条件，留着会让人误以为筛选没生效。 */
  useEffect(() => {
    setConvLimit(CONV_PAGE);
    setConversations([]);
    setConvTotal(0);
    setSelectedId(null);
    setMessages([]);
    setHasMore(false);
  }, [source, keyword]);

  /** 会话列表：按当前筛选/关键词/已加载上限重取；桥自己做了筛选与总数统计。 */
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    setConvLoading(true);
    const params: Record<string, unknown> = { limit: convLimit };
    if (source !== "all") params.source = source;
    if (keyword) params.keyword = keyword;
    callInfohub<ChatConversationsResult>("conversations", params, readInfohubConfig())
      .then((data) => {
        if (cancelled) return;
        const items = Array.isArray(data.items) ? data.items : [];
        setConversations(items);
        setConvTotal(typeof data.total === "number" ? data.total : items.length);
        setListDbMissing(Boolean(data.dbMissing));
        // 首次进入或筛选后自动打开第一个会话；用户已经选中的会话如果还在列表里就保留。
        setSelectedId((current) => {
          if (current !== null && items.some((item) => item.id === current)) return current;
          return items.length > 0 ? items[0].id : null;
        });
      })
      .catch((err) => {
        if (!cancelled) onError(describeInfohubError(err));
      })
      .finally(() => {
        if (!cancelled) setConvLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ready, source, keyword, convLimit, refreshToken, onError]);

  /** 选中会话后拉最近一页消息；切走时旧请求由 msgSeq 判废，不会把旧会话的消息写进新会话。 */
  useEffect(() => {
    if (!ready || selectedId === null) return;
    const seq = ++msgSeqRef.current;
    setMessages([]);
    setHasMore(false);
    setMessagesDbMissing(false);
    setMessagesLoading(true);
    callInfohub<ChatMessagesResult>(
      "messages",
      { conversationId: selectedId, limit: MSG_PAGE },
      readInfohubConfig(),
    )
      .then((data) => {
        if (seq !== msgSeqRef.current) return;
        // 首屏（以及同步后重载）从最新一条看起：滚动位置在数据渲染后贴底。
        pendingScrollRef.current = { mode: "bottom" };
        setMessages(dedupeMessages(Array.isArray(data.items) ? data.items : []));
        setHasMore(Boolean(data.hasMore));
        setMessagesDbMissing(Boolean(data.dbMissing));
      })
      .catch((err) => {
        if (seq === msgSeqRef.current) {
          pendingScrollRef.current = null;
          onError(describeInfohubError(err));
        }
      })
      .finally(() => {
        if (seq === msgSeqRef.current) setMessagesLoading(false);
      });
  }, [ready, selectedId, refreshToken, onError]);

  /**
   * 向前翻页（beforeTs）：取比当前最旧一条更早的一页，prepend 后把滚动位置补回去，
   * 视口里原本的内容不会因为上面插入了几十条而整体往下跳。
   */
  async function loadOlder() {
    if (selectedId === null || messagesLoading) return;
    const oldest = messages[0]?.ts;
    if (!oldest) return;
    const seq = ++msgSeqRef.current;
    const element = scrollRef.current;
    const pending = element
      ? { mode: "preserve" as const, height: element.scrollHeight, top: element.scrollTop }
      : null;
    pendingScrollRef.current = pending;
    setMessagesLoading(true);
    try {
      const data = await callInfohub<ChatMessagesResult>(
        "messages",
        { conversationId: selectedId, limit: MSG_PAGE, beforeTs: oldest },
        readInfohubConfig(),
      );
      if (seq !== msgSeqRef.current) {
        if (pendingScrollRef.current === pending) pendingScrollRef.current = null;
        return;
      }
      const older = Array.isArray(data.items) ? data.items : [];
      setMessages((current) => dedupeMessages([...older, ...current]));
      // 桥用「本页条数 >= limit」判断还有更早的；空页就没有必要再显示按钮。
      setHasMore(Boolean(data.hasMore) && older.length > 0);
      setMessagesDbMissing(Boolean(data.dbMissing));
    } catch (err) {
      if (seq === msgSeqRef.current) {
        pendingScrollRef.current = null;
        onError(describeInfohubError(err));
      }
    } finally {
      if (seq === msgSeqRef.current) setMessagesLoading(false);
    }
  }

  /** 滚动恢复放在 layout 阶段：浏览器绘制前调整，用户看不到跳一下。 */
  useLayoutEffect(() => {
    const element = scrollRef.current;
    const pending = pendingScrollRef.current;
    if (!element || !pending) return;
    pendingScrollRef.current = null;
    if (pending.mode === "bottom") {
      element.scrollTop = element.scrollHeight;
    } else {
      element.scrollTop = pending.top + (element.scrollHeight - pending.height);
    }
  }, [messages]);

  const rows = useMemo(() => buildRows(messages), [messages]);

  const selected = useMemo(
    () => conversations.find((item) => item.id === selectedId) ?? null,
    [conversations, selectedId],
  );

  const hasFilter = source !== "all" || keyword !== "";

  function changeSource(next: SourceFilter) {
    if (next === source) return;
    setSource(next);
  }

  function renderEmptyList() {
    const title = hasFilter ? "没有匹配的会话" : "归档里还没有会话";
    const desc = hasFilter
      ? "换个关键词或来源再试；筛选只作用于会话名和来源，不检索消息正文。"
      : status?.hasDb === false || listDbMissing
        ? "先在「同步」里选择来源并开始采集；采集完成后列表会自动刷新。"
        : "归档里暂时没有带消息的会话。完成一次采集后再回来看看。";
    return (
      <div className="ui-empty">
        <div className="ui-empty-title">{title}</div>
        <div className="ui-empty-desc">{desc}</div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-[300px] shrink-0 flex-col border-r border-line-soft">
        <div className="shrink-0 space-y-2 border-b border-line-soft px-3 py-2.5">
          <div className="ui-segment-group w-full" role="group" aria-label="按来源筛选会话">
            {(
              [
                ["all", "全部"],
                ["qq", "QQ"],
                ["wechat", "微信"],
              ] as [SourceFilter, string][]
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={source === value}
                onClick={() => changeSource(value)}
                className="ui-segment flex-1 justify-center"
              >
                {label}
              </button>
            ))}
          </div>
          <input
            aria-label="按会话名搜索"
            value={keywordInput}
            onChange={(event) => setKeywordInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setKeywordInput("");
            }}
            placeholder="搜索会话名（Esc 清空）"
            className="ui-input"
          />
          <div className="flex items-center justify-between ui-micro">
            <span>
              {convTotal} 个会话
              {hasFilter ? " · 已筛选" : ""}
            </span>
            {convLoading && conversations.length > 0 ? <span>加载中…</span> : null}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {convLoading && conversations.length === 0 ? <ListSkeleton /> : null}
          {!convLoading && conversations.length === 0 ? renderEmptyList() : null}
          {conversations.map((conversation) => {
            const active = conversation.id === selectedId;
            return (
              <button
                key={conversation.id}
                type="button"
                aria-current={active ? "true" : undefined}
                onClick={() => setSelectedId(conversation.id)}
                className={`flex w-full items-start gap-2.5 border-b border-line-soft px-3 py-2 text-left transition-colors last:border-b-0 ${
                  active ? "bg-[var(--subtle-3)]" : "hover:bg-[var(--subtle)]"
                }`}
              >
                <span
                  className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold text-white"
                  style={{ backgroundColor: avatarColor(conversation.name || conversation.id) }}
                  aria-hidden
                >
                  {initialOf(conversation.name)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate ui-body-sm font-medium text-ink">
                      {conversation.name || "未命名会话"}
                    </span>
                    <span className="shrink-0 ui-micro">{formatListTime(conversation.last_ts)}</span>
                  </span>
                  <span className="mt-0.5 flex items-center gap-1.5 ui-micro">
                    <span className="shrink-0">{sourceLabel(conversation.source)}</span>
                    {typeof conversation.message_count === "number" ? (
                      <span className="shrink-0">· {conversation.message_count} 条</span>
                    ) : null}
                    {conversation.kind === "group" ? (
                      <span className="shrink-0 rounded-sm border border-line px-1 leading-4">
                        群聊
                      </span>
                    ) : null}
                  </span>
                </span>
              </button>
            );
          })}
          {!convLoading && conversations.length < convTotal ? (
            <div className="p-2">
              <button
                type="button"
                onClick={() => setConvLimit((current) => current + CONV_PAGE)}
                className="ui-btn ui-btn-sm ui-btn-ghost w-full"
              >
                加载更多（已显示 {conversations.length} / {convTotal}）
              </button>
            </div>
          ) : null}
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        {selected ? (
          <div className="flex shrink-0 items-center gap-2 border-b border-line-soft px-4 py-2">
            <span className="min-w-0 truncate ui-body font-medium">{selected.name || "未命名会话"}</span>
            <span className="ui-chip">{sourceLabel(selected.source)}</span>
            {typeof selected.message_count === "number" ? (
              <span className="ui-micro">{selected.message_count} 条消息</span>
            ) : null}
            <div className="ml-auto flex shrink-0 items-center gap-2">
              {hasMore ? (
                <button
                  type="button"
                  onClick={() => void loadOlder()}
                  disabled={messagesLoading}
                  className="ui-btn ui-btn-sm ui-btn-ghost"
                >
                  {messagesLoading ? "加载中…" : "加载更早的消息"}
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
          {!selected ? (
            <div className="ui-empty mt-16">
              <div className="ui-empty-title">选择一个会话</div>
              <div className="ui-empty-desc">
                左侧列出归档里的 QQ / 微信会话，点开后在右侧按时间顺序查看消息。
              </div>
            </div>
          ) : messagesLoading && messages.length === 0 ? (
            <MessageSkeleton />
          ) : rows.length === 0 ? (
            <div className="ui-empty mt-16">
              <div className="ui-empty-title">这个会话没有消息</div>
              <div className="ui-empty-desc">
                {messagesDbMissing
                  ? "归档库还没建好；先在「同步」里采集一次。"
                  : "归档里该会话的消息条数为 0，可能只采到了会话名。"}
              </div>
            </div>
          ) : (
            <ol className="py-2">
              {rows.map((row) =>
                row.kind === "day" ? (
                  <li key={row.key} className="my-2 flex items-center gap-3 px-4">
                    <span className="h-px flex-1 bg-[var(--line-soft)]" />
                    <span className="ui-micro">{row.label}</span>
                    <span className="h-px flex-1 bg-[var(--line-soft)]" />
                  </li>
                ) : (
                  <MessageItem
                    key={row.key}
                    message={row.message}
                    merged={row.merged}
                    group={selected.kind === "group"}
                  />
                ),
              )}
            </ol>
          )}
        </div>
      </section>
    </div>
  );
}

/** 单条消息：自己靠右、他人靠左；同一发送人连发时隐藏重复的头像与发送人。 */
function MessageItem({
  message,
  merged,
  group,
}: {
  message: ChatMessage;
  merged: boolean;
  group: boolean;
}) {
  const isSelf = message.is_self === true;
  const senderName = isSelf ? "我" : message.sender_name || message.sender_id || "未知发送人";
  const time = formatClock(new Date(message.ts * 1000));
  const content = (message.content || "").trim();
  const typeLabel = (message.type_label || "").trim();
  const isText = !typeLabel || typeLabel === "文本";
  const showSender = group && !isSelf;

  return (
    <li
      className={`flex px-4 ${isSelf ? "justify-end" : "justify-start"} ${
        merged ? "mt-0.5" : "mt-3"
      }`}
    >
      {!isSelf ? (
        <span
          className={`mr-2 mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white ${
            merged ? "invisible" : ""
          }`}
          style={{ backgroundColor: avatarColor(message.sender_id || message.sender_name) }}
          aria-hidden
        >
          {initialOf(message.sender_name)}
        </span>
      ) : null}
      <div className={`flex max-w-[72%] flex-col ${isSelf ? "items-end" : "items-start"}`}>
        {!merged ? (
          <div className="mb-1 flex items-center gap-2 ui-micro">
            {showSender ? <span className="truncate">{senderName}</span> : null}
            <span>{time}</span>
          </div>
        ) : null}
        <div
          className={`rounded-lg px-3 py-1.5 text-[13px] leading-[21px] text-ink ${
            isSelf ? "bg-[var(--info-soft)]" : "bg-[var(--subtle-2)]"
          }`}
        >
          {content ? (
            <span className="whitespace-pre-wrap break-words">{content}</span>
          ) : (
            // 图片/语音/文件等消息没有正文：给类型占位，不留一个空气泡。
            <span className="ui-caption">[{typeLabel || "非文本消息"}]</span>
          )}
        </div>
        {!isText && content ? <span className="mt-1 ui-chip">{typeLabel}</span> : null}
      </div>
    </li>
  );
}
