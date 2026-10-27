import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Conversation, Message, MessagePayload } from "@heming/shared";
import {
  activeConversationsOf,
  useChatStore,
  type E2eOpenHandler,
  type E2eOpenOutcome,
  type ToolTrace,
} from "../store/chat.js";
import { useUiStore, type TaskDraft } from "../store/ui.js";
import { useNotificationStore } from "../store/notifications.js";
import { clearDraft, getDraft, setDraft as saveDraft } from "../lib/drafts.js";
import {
  DEFAULT_WINDOW,
  countToInclude,
  expandCount,
  shouldLoadMore,
} from "../lib/messageWindow.js";
import { useTaskStore } from "../lib/tasks/store.js";
import { useAuthStore } from "../store/auth.js";
import { useLlmStore } from "../store/llm.js";
import { useTokenUsageStore } from "../store/tokenUsage.js";
import {
  fetchMembers,
  uploadEncryptedFile,
  fetchFileBlobUrl,
  downloadEncryptedFile,
  fetchE2eKeys,
  putE2eKeys,
} from "../lib/api.js";
import { hasSubtle } from "../lib/e2eCrypto.js";
import {
  initSession,
  sealMessage,
  openMessage,
  msgCache,
  isForMe,
  sweepDeferred,
  recvChainOwners,
  chunkAad,
  errorAad,
  exportOwnDeviceKeys,
  type E2eDeps,
  type PlainEnvelope,
  type SealedEnvelope,
} from "../lib/e2eSession.js";
import { streamChat, type ChatMessage } from "../lib/llmClient.js";
import { resolveCapability } from "../lib/modelCaps.js";
import {
  attachImageParts,
  isVisionImage,
  visionImageDataUrl,
  type HistoryRow,
  type VisionImageSlot,
} from "../lib/vision/history.js";
import { runAgentMentions, type TriggerDeps } from "../lib/agentStream.js";
import { buildAgentContext } from "../lib/agentRuntime/context.js";
import {
  loadContextSettings,
  prepareHistory as prepareAgentHistory,
  summaryCache,
} from "../lib/agentContext/index.js";
import { memoryStore } from "../lib/memory/index.js";
import { recallRecorder } from "../lib/memory/runRecorder.js";
import { maybeRunReview } from "../lib/memory/reviewRunner.js";
import { skillPool } from "../lib/skills/index.js";
import { connectWs, type WsHandle } from "../lib/ws.js";
import { VideoIcon, ChevronIcon, MenuIcon, SmileIcon, ImageIcon, FileIcon, MicIcon, PhoneIcon, DownloadIcon, SearchIcon, SelectIcon, ChatIcon } from "./icons.js";
import { findMessageHits, hitPosition, stepHit } from "../lib/chat/search.js";
import { Avatar } from "./Avatar.js";
import { MentionPicker, type MentionItem } from "./MentionPicker.js";
import { AgentStreamBubble } from "./AgentStreamBubble.js";
import { ChatInfoCard } from "./ChatInfoCard.js";
import { EmojiPicker } from "./EmojiPicker.js";
import { VoiceCallPanel } from "./VoiceCallPanel.js";
import { useVoiceCall } from "../lib/voiceCall.js";
import { buildToolBridge } from "../lib/mcp/index.js";
import {
  buildConversationJson,
  buildConversationMarkdown,
  conversationFileName,
  type ExportMessage,
} from "../lib/export/conversation.js";
import { buildWikiToolBridge } from "../lib/wiki/tools.js";
import { autoConnectAll } from "../lib/mcp/runtime.js";
import {
  SelfEditBudget,
  SelfEditStore,
  buildSelfToolBridge,
} from "../lib/selfEdit/index.js";
import { mergeToolBridges } from "../lib/selfEdit/merge.js";
import { createHitlGate, toHitlBatch } from "../lib/hitl/gate.js";
import { HitlPolicyStore } from "../lib/hitl/policy.js";
import { useHitlStore, type PendingConfirm } from "../store/hitl.js";
import { ToolApprovalModal } from "./ToolApprovalModal.js";
import { appendToolAudit } from "../lib/hitl/audit.js";
import type { HitlVerdict } from "../lib/hitl/types.js";
import type { StorageLike } from "../lib/memory/types.js";
import { buildChartToolBridge } from "../lib/charts/tools.js";
import { buildToneToolBridge } from "../lib/tone/tools.js";
import { extractCharts, stripChartFences } from "../lib/charts/spec.js";
import { docFileBlock, isDocumentLike, parseDocument } from "../lib/docs/parse.js";
import { ChatChart } from "./ChatChart.js";
import { MarkdownMessage } from "./MarkdownMessage.js";
import { mcpRegistry } from "../lib/mcp/store.js";
import { openCallWindow } from "../lib/callWindow.js";
import { useModalA11y } from "./useModalA11y.js";
import { capabilityNotice } from "../lib/capabilityNotice.js";
import { formatClock, formatDayClock, needsTimeSeparator } from "../lib/formatTime.js";

/** 无 subtle 环境的常驻提示（横幅 + 发送拦截共用文案，设计 §2.1：拒绝发送不降级明文）。 */
export const NO_E2E_NOTICE = "当前环境不支持端到端加密，请使用桌面端或 HTTPS";

/** 与正文同发的本轮附件：图片转内容片、文档拼正文，重试时按它复原同一轮。 */
type TurnAttachment = NonNullable<MessagePayload["file"]>;

/**
 * HITL 闸门（工具执行前人工确认）的**模块级单例**。
 *
 * 为什么必须在组件外创建：闸门持有「本会话内允许此工具」的授权表
 * （`HitlPolicyStore` 里的内存 Map）。若每次渲染新建一份，
 * 用户刚点下的「本会话内允许」会立刻失效——授权就等于没给。
 */
const hitlPolicy = new HitlPolicyStore();

/** 工具确认留痕的存储（与策略同在本机 localStorage）。 */
const hitlAuditStorage: StorageLike = {
  getItem: (k) => {
    try {
      return window.localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  setItem: (k, v) => {
    try {
      window.localStorage.setItem(k, v);
    } catch {
      /* 隐私模式：留痕失败不影响确认本身 */
    }
  },
  removeItem: (k) => {
    try {
      window.localStorage.removeItem(k);
    } catch {
      /* 同上 */
    }
  },
};

/**
 * 待确认的超时时长（d.34）：60 分钟。
 *
 * 从请求**成为当前待定项**开始计时（排队中的请求等排到再计）。
 * 短了会把「用户去开个会」变成误拒；长了会让一轮对话无限挂起。
 * 超时按拒绝收口，并在审计里写明原因——与用户手动拒绝可区分。
 */
export const HITL_APPROVAL_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * 闸门本体。
 *
 * `ask` 注入的是 store 的 enqueue：闸门把待确认项交给它，
 * 它在 UI 侧排队，用户决定后 resolve 回裁决。
 */
const hitlGate = createHitlGate({
  policy: hitlPolicy,
  ask: (batch) =>
    useHitlStore.getState().enqueue(
      { kind: "tool-call", payload: batch.calls, auto: batch.auto },
      {
        agentId: batch.agentId,
        conversationId: batch.conversationId,
        streamId: batch.streamId,
        agentName: batch.agentName,
      },
    ),
});

/**
 * 会话 → 显示名与头像（转发目标选择、通话标题、标签栏等多处共用）。
 * 三种会话各取各的字段，集中在这里而不是散落各处写三元——
 * 加 agent 会话时只改这一处，漏改别处会在转发面板里显示成 undefined。
 */
export function convLabel(c: Conversation): { name: string; avatar?: string; group: boolean } {
  if (c.type === "direct") return { name: c.peer.displayName, avatar: c.peer.avatar, group: false };
  if (c.type === "agent") {
    return { name: c.agent.name, avatar: c.agent.avatar ?? undefined, group: false };
  }
  return { name: c.name, avatar: undefined, group: true };
}

/** chips 空表的稳定引用（selector 兜底，防每次渲染新建 {} 触发多余重渲染）。 */
const NO_PLAIN: Record<string, PlainEnvelope> = {};

/** 单条消息的回应 chip（emoji + 参与 userIds）。 */
export type ReactionChip = { emoji: string; userIds: string[] };

/**
 * Electron preload 暴露的语音通话桥接面（仅桌面端存在；网页端为 undefined）。
 * 各方法均可选：老版本 preload 可能未提供某些方法，渲染层需守卫降级。
 */
interface VoiceCallBridge {
  /** 订阅最小化事件；返回取消订阅函数（卸载时清理，防监听器累积）。 */
  onMinimize?: (callback: () => void) => (() => void) | void;
  /** 请求主进程弹系统通知（主进程一并闪烁任务栏）。 */
  notify?: (title: string, body: string) => void;
}

declare global {
  interface Window {
    /** Electron preload 注入的语音通话桥接面（网页端不存在）。 */
    __heming_voice_call?: VoiceCallBridge;
  }
}

/** aggregateChips 结果里「无 chips」的稳定空表。 */
const NO_CHIPS: ReactionChip[] = [];

/** 会话标题（与 header 同口径；通知列表按此显示来源）。 */
function convTitleOf(conv: Conversation): string {
  return conv.type === "direct"
    ? conv.peer.displayName
    : conv.type === "agent"
      ? conv.agent.name
      : `${conv.name}（${conv.memberCount} 人）`;
}

/** 进程内聚合缓存（fix I4）：同 (messages, plainOf) 引用 → 返回同一结果对象（可断言「不重复计算」）。 */
let chipAggCache: {
  messages: Message[];
  plainOf: Record<string, PlainEnvelope>;
  result: Map<string, ReactionChip[]>;
} | null = null;

/**
 * 聚合各消息的回应 chips（fix I4：原每渲染对每条消息全量扫 reaction 消息 = O(n²)）：
 * 存量 payload.reactions 打底，再按消息序叠加解密出的 kind=reaction 事件（add 进/remove 出），
 * 空集条目剔除。同引用输入命中进程内缓存；渲染层经 useMemo 只在 messages/plainOf 变化时调用。
 */
export function aggregateChips(
  messages: Message[],
  plainOf: Record<string, PlainEnvelope>,
): Map<string, ReactionChip[]> {
  if (chipAggCache && chipAggCache.messages === messages && chipAggCache.plainOf === plainOf) {
    return chipAggCache.result;
  }
  const acc = new Map<string, Map<string, Set<string>>>();
  const bucket = (msgId: string, emoji: string): Set<string> => {
    let byEmoji = acc.get(msgId);
    if (!byEmoji) {
      byEmoji = new Map();
      acc.set(msgId, byEmoji);
    }
    let set = byEmoji.get(emoji);
    if (!set) {
      set = new Set();
      byEmoji.set(emoji, set);
    }
    return set;
  };
  // 存量（服务端 toggle 时代）打底
  for (const m of messages) {
    for (const r of m.payload.reactions ?? []) {
      const set = bucket(m.id, r.emoji);
      for (const uid of r.userIds) set.add(uid);
    }
  }
  // 解密出的 reaction 事件按消息序叠加
  for (const ev of messages) {
    if (ev.recalledAt != null || ev.enc !== "e2e") continue;
    const p = plainOf[ev.id];
    if (p?.kind !== "reaction" || !p.reaction) continue;
    const set = bucket(p.reaction.target, p.reaction.emoji);
    if (p.reaction.op === "add") set.add(ev.senderId);
    else set.delete(ev.senderId);
  }
  const result = new Map<string, ReactionChip[]>();
  for (const [msgId, byEmoji] of acc) {
    const chips: ReactionChip[] = [];
    for (const [emoji, set] of byEmoji) {
      if (set.size > 0) chips.push({ emoji, userIds: [...set] });
    }
    if (chips.length) result.set(msgId, chips);
  }
  chipAggCache = { messages, plainOf, result };
  return result;
}

/**
 * E2E 公钥短缓存：seal 内逐成员调 fetchPeerKeys，不缓存会让一次 seal 打 N 次
 * GET /api/e2e/keys（群聊风暴）。3s TTL——新设备上云后最迟下次 seal 可见。
 */
let peerKeysCache: { at: number; data: Awaited<ReturnType<typeof fetchE2eKeys>> } | null = null;
async function fetchPeerKeysCached(userId: string) {
  if (!peerKeysCache || Date.now() - peerKeysCache.at > 3000) {
    peerKeysCache = { at: Date.now(), data: await fetchE2eKeys() };
  }
  return peerKeysCache.data[userId] ?? null;
}

/** 正则转义：mention 名按字面量匹配（名字可含 . * + 等元字符）。 */
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 他机流 watchdog 清扫周期（Task 7）：15s 一次扫全局 streaming 的过期项（阈值在 store 内 60s）。 */
const STREAM_SWEEP_INTERVAL_MS = 15_000;

/** 表情回应浮排的常用 emoji（Task 6；emoji 仅作回应数据，不作图标）。 */
/** 输入栏（文本行）高度：默认比单行大一些，用户可拖动上沿调整，写 localStorage 持久化。 */
const COMPOSER_HEIGHT_KEY = "heming.chat.composerHeight.v1";
const DEFAULT_COMPOSER_HEIGHT = 132;
const MIN_COMPOSER_HEIGHT = 72;
const MAX_COMPOSER_HEIGHT = 360;

/** 夹住输入栏高度（拖拽与读存储共用；非法值回落默认）。 */
export function clampComposerHeight(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_COMPOSER_HEIGHT;
  return Math.min(MAX_COMPOSER_HEIGHT, Math.max(MIN_COMPOSER_HEIGHT, Math.round(n)));
}

const QUICK_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🙏", "🎉", "🔥", "✅", "👀", "🤔", "👏"];

/**
 * 「贴底」判定阈值（A3）：距底小于该值即视为正在看最新消息。
 * 留 80px 余量是因为滚动条末端的 1~2px 抖动不该被当成「用户上滑了」。
 */
const STICK_BOTTOM_PX = 80;

/**
 * 输入区提示行（A9）：info 3 秒自动消失；error 用红色 + role="alert"，
 * 纯文本发送失败时附带「重试」（附件场景不提供，避免重放一次上传）。
 */
type SendNotice = { kind: "info" | "error"; text: string; retry?: () => void };

/**
 * 气泡文本 mentions 高亮（M3 Task 7）：按各 name 在 text 中的出现位置 split 拆分——
 * 命中段包浅蓝 chip span，其余段为 Fragment 纯文本节点（React 文本输出天然转义，防注入）。
 * 名字按长度降序参与 alternation，防「小鸣」吃掉「和小鸣」的前缀；无 mentions 时原样单节点。
 */
export function renderTextWithMentions(
  text: string,
  mentions?: { agentId: string; name: string }[],
): JSX.Element[] {
  const names = [...new Set((mentions ?? []).map((m) => m.name).filter((n) => n.length > 0))].sort(
    (a, b) => b.length - a.length,
  );
  if (names.length === 0) return [<Fragment key="t0">{text}</Fragment>];
  const re = new RegExp(`(${names.map(escapeRegExp).join("|")})`, "g");
  return text.split(re).map((part, i) =>
    part !== "" && names.includes(part) ? (
      <span key={i} className="rounded bg-[#eef3f8] px-0.5">
        {part}
      </span>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}

/**
 * 附件气泡（图片缩略图 / 文件卡）：content 路由 authOnly，裸 src/href 会 401 →
 * 挂载时走鉴权 blob 拿 objectURL，卸载或换附件时 revoke（含「fetch 还没回来就已卸载」的
 * 竞态：取到即弃），防 objectURL 内存泄漏。加载失败（401/网络/解密失败）给可见占位，
 * 不渲染断链的 <img>/<a>。
 * E2E Task 5：payload.file.key 存在（消息附件已加密）→ downloadEncryptedFile 鉴权取密文
 * 并解密成 Blob 再建 objectURL；无 key（legacy 明文附件 / 右栏投递）→ fetchFileBlobUrl
 * 明文直通（规格 §2.4：无 key 照旧显示）。
 */
function AttachmentPreview({
  file,
}: {
  file: { id: string; name: string; mime: string; size: number; key?: string };
}): JSX.Element | null {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  /** 图片放大（A6）：气泡内是受限缩略图，点击看原图；Esc/点遮罩关闭。 */
  const [zoomOpen, setZoomOpen] = useState(false);
  const zoomPanelRef = useRef<HTMLDivElement | null>(null);
  useModalA11y(zoomPanelRef, () => setZoomOpen(false), { active: zoomOpen, autoFocus: false });

  useEffect(() => {
    let alive = true;
    let owned: string | null = null; // 本 effect 实例持有的 objectURL（闭包内跨 then/cleanup 可见）
    setUrl(null);
    setFailed(false);
    const load: Promise<string> = file.key
      ? downloadEncryptedFile(file.id, file.key, file.mime).then((b) => URL.createObjectURL(b))
      : fetchFileBlobUrl(file.id);
    load
      .then((u) => {
        if (!alive) {
          URL.revokeObjectURL(u); // 晚到的结果：无人再用，直接销
          return;
        }
        owned = u;
        setUrl(u);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
      if (owned) URL.revokeObjectURL(owned);
    };
  }, [file.id, file.key, file.mime]);

  if (failed) {
    return (
      <div className="mt-1 flex items-center gap-2 rounded-md border border-line bg-white px-2 py-1.5 text-[12px] text-muted shadow-card">
        <FileIcon width={15} height={15} />
        <span className="min-w-0 truncate">{file.name}</span>
        <span className="shrink-0 text-[10px]">加载失败</span>
      </div>
    );
  }
  if (!url) return null; // 取 blob 期间不渲染，避免闪出断链
  return file.mime.startsWith("image/") ? (
    <>
      <button
        type="button"
        aria-label={`查看图片 ${file.name}`}
        className="mt-1 block max-w-full cursor-zoom-in overflow-hidden rounded-md"
        onClick={() => setZoomOpen(true)}
      >
        <img src={url} alt={file.name} className="max-h-40 rounded-md object-cover" />
      </button>
      {zoomOpen ? (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 p-6"
          onClick={() => setZoomOpen(false)}
        >
          <div
            ref={zoomPanelRef}
            role="dialog"
            aria-modal="true"
            aria-label="查看图片"
            className="flex max-h-full max-w-full items-center justify-center"
            onClick={(e) => e.stopPropagation()}
          >
            <img
              src={url}
              alt={file.name}
              className="max-h-[88vh] max-w-[88vw] rounded object-contain"
              data-testid="image-lightbox"
            />
          </div>
        </div>
      ) : null}
    </>
  ) : (
    <a
      href={url}
      download={file.name}
      className="mt-1 flex items-center gap-2 rounded-md border border-line bg-white px-2 py-1.5 text-[12px] shadow-card hover:bg-[#f7f7f7]"
    >
      <FileIcon width={15} height={15} />
      <span className="min-w-0 truncate">{file.name}</span>
      <span className="shrink-0 text-[10px] text-muted">
        {(file.size / 1024).toFixed(1)} KB
      </span>
    </a>
  );
}

/**
 * 音频气泡（Task 5）：audio/* 附件在 image 分支之前路由到此——鉴权取 blob 后渲染
 * `<audio controls>` 播放器，替代通用文件卡。blob 生命周期与 AttachmentPreview 同款：
 * 晚到即销 + cleanup revoke（防 objectURL 泄漏），加载失败给可见占位不出断链播放器。
 * E2E Task 5：fileKey 存在 → 解密后渲染（下载面同 key 判别；无 key 走明文 blob）。
 */
function AudioBubble({
  fileId,
  fileKey,
  mime = "audio/webm",
}: {
  fileId: string;
  fileKey?: string;
  mime?: string;
}): JSX.Element | null {
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let revoked: string | null = null; // 本 effect 实例持有的 objectURL（闭包内跨 then/cleanup 可见）
    let alive = true;
    setUrl(null);
    setErr("");
    const load: Promise<string> = fileKey
      ? downloadEncryptedFile(fileId, fileKey, mime).then((b) => URL.createObjectURL(b))
      : fetchFileBlobUrl(fileId);
    void load
      .then((u) => {
        if (!alive) {
          URL.revokeObjectURL(u); // 晚到的结果：无人再用，直接销
          return;
        }
        revoked = u;
        setUrl(u);
      })
      .catch((e) => {
        if (alive) setErr((e as Error).message);
      });
    return () => {
      alive = false;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [fileId, fileKey, mime]);

  if (err) return <div className="mt-1 text-[11px] text-[#b42318]">音频加载失败：{err}</div>;
  return url ? (
    <audio
      controls
      src={url}
      aria-label="语音消息"
      className="mt-1 w-full max-w-[260px]"
      data-testid="audio-bubble"
    />
  ) : null;
}

/**
 * @param embedded 任务区嵌入态：隐藏「返回工作区」按钮（返回会切页并卸载
 *   ChatPage，等于中断正在跑的任务）；其余行为与聊天页完全一致。
 */
export function ChatPage({
  embedded = false,
  // 待确认超时可注入：生产用 60 分钟，测试用它把「超时 → 拒绝 + 留痕」跑到，
  // 不必依赖 fake timers（那会与流式/等待逻辑互相打架）。
  hitlTimeoutMs = HITL_APPROVAL_TIMEOUT_MS,
}: { embedded?: boolean; hitlTimeoutMs?: number } = {}) {
  const convId = useUiStore((s) => s.activeConversationId)!;
  const leave = useUiStore((s) => s.leaveConversation);
  const taskDraft = useUiStore((s) => s.taskDraft);
  const consumeTaskDraft = useUiStore((s) => s.consumeTaskDraft);
  const conversations = useChatStore((s) => s.conversations);
  const messages = useChatStore((s) => s.messages[convId] ?? []);
  /** A1：历史三态（加载中 / 失败 / 加载成功且为空）按会话分桶读。 */
  const messagesLoading = useChatStore((s) => s.messagesLoading[convId] ?? false);
  const messagesError = useChatStore((s) => s.messagesError[convId] ?? null);
  /** 本会话是否已经完成过一次历史拉取（含失败）：首帧骨架与「真空态」的区分依据。 */
  const [historyLoaded, setHistoryLoaded] = useState<Record<string, boolean>>({});
  const plainById = useChatStore((s) => s.plainById);
  const appendMessage = useChatStore((s) => s.appendMessage);
  const reads = useChatStore((s) => s.reads);
  const loadReads = useChatStore((s) => s.loadReads);
  const streaming = useChatStore((s) => s.streaming);
  const streamOwner = useChatStore((s) => s.streamOwner);
  const upsertStream = useChatStore((s) => s.upsertStream);
  const removeStream = useChatStore((s) => s.removeStream);
  const markStreamOwner = useChatStore((s) => s.markStreamOwner);
  const clearStreamsForConversation = useChatStore((s) => s.clearStreamsForConversation);
  const sweepStaleStreams = useChatStore((s) => s.sweepStaleStreams);
  const agentsRoster = useChatStore((s) => s.agentsRoster);
  const me = useAuthStore((s) => s.user);
  const [draft, setDraft] = useState("");
  /** 最新草稿的只读镜像：重试成功后判断「用户有没有在这期间改过字」。 */
  const draftRef = useRef(draft);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);
  /**
   * 草稿持久化（d.31 · P2-1）：`ChatPage` 常驻（切会话不卸载），草稿却是组件态 ⇒
   * 上一个会话写一半的字会串进下一个会话，刷新还全丢。按会话存盘后各归各位。
   *
   * 写盘做 300ms 节流（每敲一个字写一次 localStorage 没必要），
   * 但切会话 / 发送成功 / 卸载时**立即落盘或清除**，不丢最后几百毫秒的输入。
   */
  const draftSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftSavePending = useRef<{ convId: string; text: string } | null>(null);
  /** 把待写草稿立刻落盘（并清掉定时器）。 */
  const flushDraftSave = useCallback(() => {
    if (draftSaveTimer.current) {
      clearTimeout(draftSaveTimer.current);
      draftSaveTimer.current = null;
    }
    const pending = draftSavePending.current;
    draftSavePending.current = null;
    if (pending) saveDraft(pending.convId, pending.text);
  }, []);
  /** 安排一次节流写盘（同一会话连续输入只写最后一次）。 */
  const scheduleDraftSave = useCallback(
    (cid: string, text: string) => {
      draftSavePending.current = { convId: cid, text };
      if (draftSaveTimer.current) clearTimeout(draftSaveTimer.current);
      draftSaveTimer.current = setTimeout(() => {
        draftSaveTimer.current = null;
        flushDraftSave();
      }, 300);
    },
    [flushDraftSave],
  );
  /** 丢弃待写草稿（发送成功后用：否则几百毫秒前的旧文本会被重新写回去）。 */
  const cancelDraftSave = useCallback(() => {
    if (draftSaveTimer.current) {
      clearTimeout(draftSaveTimer.current);
      draftSaveTimer.current = null;
    }
    draftSavePending.current = null;
  }, []);
  // 切会话：先把**上一个会话**还没落盘的草稿写掉（pending 里记的是旧 convId），
  // 再读当前会话的。★ 不能靠卸载重置——ChatPage 常驻是刻意的（保持 WS 与流式状态）。
  useEffect(() => {
    flushDraftSave();
    setDraft(getDraft(convId));
    return () => {
      // 切走/卸载时把最后几百毫秒的输入补上，别丢字
      flushDraftSave();
    };
  }, [convId, flushDraftSave]);
  const [sendNotice, setSendNoticeState] = useState<SendNotice | null>(null);
  /** info 提示 3 秒自动消失的定时器（新提示/切换会话/卸载时清）。 */
  const sendNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * 写提示行：text=null 清除；kind=info 3 秒后自动消失，error 保留到下一次操作。
   * 与旧 setSendNotice(string) 调用面兼容（缺省 info）。
   */
  const setSendNotice = useCallback(
    (text: string | null, kind: "info" | "error" = "info", retry?: () => void) => {
      if (sendNoticeTimer.current) {
        clearTimeout(sendNoticeTimer.current);
        sendNoticeTimer.current = null;
      }
      if (text === null) {
        setSendNoticeState(null);
        return;
      }
      setSendNoticeState(retry ? { kind, text, retry } : { kind, text });
      if (kind === "info") {
        sendNoticeTimer.current = setTimeout(() => {
          sendNoticeTimer.current = null;
          setSendNoticeState(null);
        }, 3000);
      }
    },
    [],
  );
  useEffect(
    () => () => {
      if (sendNoticeTimer.current) clearTimeout(sendNoticeTimer.current);
    },
    [],
  );
  /** 附件上传进行中（A8）：四个入口禁用 + 提示行占位；ref 兜底防同帧连点。 */
  const [uploading, setUploading] = useState(false);
  const uploadingRef = useRef(false);
  const [exportOpen, setExportOpen] = useState(false);
  /**
   * 多选导出：勾出若干条，只导出这些。
   * 选择状态是本会话的临时视图状态（切会话即清），不落盘——
   * 导出的原料（明文消息）本来就在本机，没必要再存一份勾选。
   */
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  /** 会话内搜索：只在打开时占用 header 下方一条，不常驻挤压消息区。 */
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchHitId, setSearchHitId] = useState<string | null>(null);
  const exportRef = useRef<HTMLDivElement>(null);
  const [connected, setConnected] = useState(false);
  /** WS 三态：首次连接 / 已连接 / 已断开（用于标题与横幅，不用 connected 二元冒充）。 */
  const [connState, setConnState] = useState<"connecting" | "open" | "closed">("connecting");
  /** 断线后恢复的短暂提示（3 秒）。 */
  const [recovered, setRecovered] = useState(false);
  const recoveredTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hadClosedRef = useRef(false);
  // 卸载时清掉「已恢复连接」的 3 秒定时器，防对已卸载组件 setState
  useEffect(
    () => () => {
      if (recoveredTimer.current) clearTimeout(recoveredTimer.current);
    },
    [],
  );
  /** 会话信息卡（三横线弹出）开关。 */
  const [infoOpen, setInfoOpen] = useState(false);
  /** 表情选择器开关（输入区工具行左上角）。 */
  const [emojiOpen, setEmojiOpen] = useState(false);
  /** 语音输入进行中（Web Speech API 可用时；不可用时 toggleVoice 给可见提示）。 */
  const [listening, setListening] = useState(false);
  /** 语音双选项浮层（mic 按钮弹出：转文字 / 录音），会话级清理。 */
  const [voiceMenu, setVoiceMenu] = useState(false);
  /** MediaRecorder 录音进行中（录音态提示行与中止收尾共用）。 */
  const [recording, setRecording] = useState(false);
  /** @ 选择器：null=关；via 区分按钮/键入 token（键入选中后锁到 token 消失，防草稿未变时每击键重弹）。 */
  const [picker, setPicker] = useState<{ via: "button" | "token"; query: string } | null>(null);
  /** 已选 mention（输入栏下 chip）：与草稿文本解耦，发送时非空才进 payload.mentions。 */
  const [selectedMentions, setSelectedMentions] = useState<{ agentId: string; name: string }[]>(
    [],
  );
  const [tokenLock, setTokenLock] = useState(false);
  /** 回复引用目标（Task 3）：非空时输入区上方出引用预览条，发送带顶层 replyTo。 */
  const [replyTarget, setReplyTarget] = useState<Message | null>(null);
  /** 转发目标源消息（Task 4）：非空时出会话选择浮层；null=关。 */
  const [forwardMsg, setForwardMsg] = useState<Message | null>(null);
  /** 表情回应浮排当前打开的消息 id（Task 6）：null=关；点选 emoji 或 Esc 关闭。 */
  const [reactFor, setReactFor] = useState<string | null>(null);
  /**
   * 群成员挂载快照（带 convId 防跨会话串数据）：
   * byId = id→{名, 头像}（他人气泡署名与头像，M2 消息体无 senderName/avatar）；
   * agents = kind=agent 行 → @ 选择器候选（**只认本会话群 members**，评审 F1——跨群 join 视图不作数）；
   * userIds = kind=user 行 id → E2E chaindist 分发对象（agent 无设备公钥，不参与）。
   */
  const [groupMembers, setGroupMembers] = useState<{
    convId: string;
    byId: Record<string, { name: string; avatar?: string }>;
    agents: MentionItem[];
    userIds: string[];
  } | null>(null);
  const wsHandleRef = useRef<WsHandle | null>(null);
  /** 语音识别器实例：切会话/卸载时 stop，避免后台继续识别回填草稿。 */
  const recRef = useRef<{ start(): void; stop(): void } | null>(null);
  /** MediaRecorder 录音实例（与 STT 的 recRef 区分）：停录/中止收口都在 onstop。 */
  const voiceRecRef = useRef<MediaRecorder | null>(null);
  /** 录音起点毫秒（Date.now）：<1s 拒发与 60s 上限后的时长判定依据。 */
  const voiceRecStartRef = useRef(0);
  /** 60s 上限定时器 id：onstop 即清，防悬空回调作用于已结束的录音。 */
  const voiceRecTimerRef = useRef<number | null>(null);
  /**
   * 当前录音的「取消」闭包（置取消位 + stop）：切会话/卸载/取消钮共用——
   * 取消位放闭包而非共享 ref，防前一实例的晚到 onstop 误清后一实例的标志。
   */
  const voiceRecCancelRef = useRef<(() => void) | null>(null);
  /**
   * 授权 `await getUserMedia` 挂起期的 pending 占位（身份 token 对象）：voiceRecRef 要到
   * `recorder.start()` 后才有值，此窗口内录音态仍 false、浮层未禁用，不挡住会并发开第二条并
   * 覆写 cancelRef → 首实例取消链断裂（麦克风轨无人停、60s 也管不到、且无「录音中」指示）。
   * finally 只在「仍是本实例占位」时清，不误清后一实例。
   */
  const voiceRecPendingRef = useRef<object | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  /** A3：最近一次滚动是否贴底（距底 <80px）。贴底才跟随新消息/流式文本。 */
  const atBottomRef = useRef(true);
  /** A3：用户上滑期间来了新内容 → 右下角浮动「↓ 新消息」。 */
  const [newBelow, setNewBelow] = useState(false);
  /** A5：刚复制过的消息 id（短暂显示「已复制」）。 */
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** A11：@ 选择器的键盘高亮项下标。 */
  const [pickerIndex, setPickerIndex] = useState(0);
  /** 触发句柄（convId → 集合）：「中断」只 abort 当前会话的流；卸载时全部中止（关页不空烧 token）。 */
  const runsRef = useRef<Record<string, Set<{ abortAll(): void }>>>({});
  /** 本机流元数据（streamId → 触发上下文）：onLocalDelta 回填 agentId、重试取原触发文本与本轮附件。 */
  const streamMeta = useRef<
    Record<string, { agentId: string; name: string; text: string; attachment?: TurnAttachment }>
  >({});
  /** 任务区的流归属（streamId → taskId）：工具步骤与终态写进对应任务记录。 */
  const streamTaskRef = useRef<Record<string, string>>({});
  /** 从任务区投递进来、等连接就绪后自动发送的任务（一次消费一条）。 */
  const [autoTask, setAutoTask] = useState<TaskDraft | null>(null);
  /** 存量自迁移已尝试集（组件生命周期内）：跨 messages.length 变化的 effect 批次去重。 */
  const migratedRef = useRef<Set<string>>(new Set());
  /**
   * 发送侧出站箱（`${chainKid}:${n}` → 明文）：自发消息的 echo 没有对应 recv 链（发送链
   * 只有对方持有），openMessage 解不开——send 时把明文暂存这里，echo 到达时按链索引取回
   * 并落 msgCache（§6 缓存优先，重载后走缓存自解）。上限 200 条溢出丢最旧（Map 插入序）。
   */
  const outboxRef = useRef(new Map<string, PlainEnvelope>());
  /** subtle 可用性（每渲染实测）：横幅常驻与全发送路径拦截的统一开关。 */
  const subtleOk = hasSubtle();

  // —— E2E Task 4：会话接线（deps 组装 / 解密 handler / 公钥上云）——

  /** seal 用 deps：sendRaw 走当前 WS 句柄（chaindist 与正文同一连接有序上行）。 */
  const e2eDeps = (): E2eDeps => ({
    fetchPeerKeys: fetchPeerKeysCached,
    sendRaw: (e) => wsHandleRef.current?.send(e),
    now: Date.now,
  });

  /**
   * 解密 handler（注入 chat store）：isForMe 先滤非本机定向 chaindist（硬验收②——
   * 群聊他设备的分发静默忽略不抛错）→ openMessage（chaindist 内自动落链）→
   * chaindist 结果 await sweepDeferred 完成暂挂重扫（store 随即重试占位）→
   * "duplicate"（硬验收③）查明文缓存补齐渲染、缓存无则忽略 → 异常映射
   * e2e_not_for_device=skip、其余=failed 占位。
   */
  const makeOpenHandler = (conv: string): E2eOpenHandler => {
    return async (env, ctx): Promise<E2eOpenOutcome> => {
      const sealed: SealedEnvelope = {
        id: env.id,
        ...(env.senderId !== undefined ? { senderId: env.senderId } : {}),
        ...(env.chainKid !== undefined ? { chainKid: env.chainKid } : {}),
        ...(env.n !== undefined ? { n: env.n } : {}),
        cipher: env.cipher,
        ...(env.createdAt !== undefined ? { createdAt: env.createdAt } : {}),
      };
      if (!isForMe(sealed)) return { status: "skip" };
      // 缓存优先（§6）：已解密过的（含重加密自发消息/本会话已开过的）直接取——
      // 也是 (chainKid,n) 重放/并发 sweep 抢先解开时的补齐路径（硬验收③）。
      const cached = msgCache.list(conv).find((c) => c.id === env.id);
      if (cached) return { status: "ok", plain: cached.plain };
      // 出站箱：自己的 echo 按链索引取回明文（对方能开、自己开不了），落缓存后返回
      const outKey =
        env.chainKid !== undefined && env.n !== undefined ? `${env.chainKid}:${env.n}` : "";
      const outPlain = outKey ? outboxRef.current.get(outKey) : undefined;
      if (outPlain) {
        outboxRef.current.delete(outKey);
        // 错误是流式瞬态（不入历史/不渲染消息列表）：不落明文缓存，其余（含自发正文）落
        if (outPlain.kind !== "error") {
          msgCache.append(conv, {
            id: env.id,
            senderId: env.senderId ?? "unknown",
            at: env.createdAt ? Date.parse(env.createdAt) || Date.now() : Date.now(),
            plain: outPlain,
          });
        }
        return { status: "ok", plain: outPlain };
      }
      try {
        const opts = ctx
          ? {
              aad:
                ctx.kind === "error"
                  ? errorAad(conv, ctx.streamId) // fix I2：错误信封独立 AAD 命名空间
                  : chunkAad(conv, ctx.streamId, ctx.index ?? 0),
              noDefer: true,
            }
          : undefined;
        const r = await openMessage(
          { id: conv, memberIdOf: (kid) => recvChainOwners(conv)[kid] },
          sealed,
          msgCache,
          opts,
        );
        if (r === "defer") return { status: "defer" };
        if (r === "duplicate") {
          const cached = msgCache.list(conv).find((c) => c.id === env.id);
          return cached ? { status: "ok", plain: cached.plain } : { status: "skip" };
        }
        if (r.kind === "chaindist") {
          await sweepDeferred(conv); // 等重扫完成：store 的 pending 重试直接命中明文缓存
          return { status: "ok", plain: r };
        }
        return { status: "ok", plain: r };
      } catch (e) {
        if ((e as Error).message === "e2e_not_for_device") return { status: "skip" };
        return { status: "failed" };
      }
    };
  };

  /**
   * seal 分发对象（硬验收①的对端集合）：direct=对端+自己；group=本群 user 行+自己
   * （自己设备由 distributeChain 按公钥指纹自跳过，带上是为了多设备自同步）。
   */
  const resolveMembers = async (target: string): Promise<string[]> => {
    const mine = me ? [me.id] : [];
    const targetConv = conversations.find((c) => c.id === target);
    if (targetConv?.type === "direct") return [targetConv.peer.id, ...mine];
    if (groupMembers?.convId === target) return [...groupMembers.userIds, ...mine];
    try {
      const list = await fetchMembers(target);
      return [...list.filter((m) => m.kind === "user").map((m) => m.id), ...mine];
    } catch {
      return []; // 成员快照缺失：正文照封（chaindist 留待下次 seal 重试分发）
    }
  };

  /**
   * E2E 统一封发：无 subtle 一律拦截给提示且不发送（硬验收⑤——绝不降级明文）；
   * sealMessage 内部先分发 chaindist 再封正文，事件自带 enc/cipher/chainKid/n。
   */
  const sealAndSend = async (plain: PlainEnvelope, target: string = convId): Promise<boolean> => {
    if (!hasSubtle()) {
      setSendNotice(NO_E2E_NOTICE);
      return false;
    }
    try {
      const members = await resolveMembers(target);
      const ev = await sealMessage({ id: target, members }, plain, e2eDeps());
      if (ev.type === "send_message" && ev.cipher && ev.chainKid !== undefined && ev.n !== undefined) {
        // 出站箱登记（echo 自解用）：Map 插入序裁最旧
        const ob = outboxRef.current;
        ob.set(`${ev.chainKid}:${ev.n}`, plain);
        if (ob.size > 200) {
          const oldest = ob.keys().next().value;
          if (oldest !== undefined) ob.delete(oldest);
        }
      }
      wsHandleRef.current?.send(ev);
      return true;
    } catch (err) {
      setSendNotice(`发送失败：${(err as Error).message}`, "error");
      return false;
    }
  };

  // conversations 为联合类型（M2）：仅 direct 有 peer；群显群名+人数
  const conv = conversations.find((c) => c.id === convId);
  const peer = conv?.type === "direct" ? conv.peer : undefined;
  const memberInfoById = groupMembers?.convId === convId ? groupMembers.byId : undefined;
  /** 本会话群的 @ 候选：只认本群 members 的 agent 行（评审 F1；快照未落定/失败则空）。 */
  const mentionCandidates = groupMembers?.convId === convId ? groupMembers.agents : [];
  // 仅 direct 有「已读」：取对方（peer）在本会话的读点；ISO 时间戳同构（…Z），字符串比较即时间序
  const peerReadAt =
    conv?.type === "direct"
      ? reads[convId]?.find((r) => r.userId === conv.peer.id)?.at
      : undefined;
  const headerTitle = conv
    ? conv.type === "direct"
      ? conv.peer.displayName
      : conv.type === "agent"
        ? conv.agent.name
        : `${conv.name}（${conv.memberCount} 人）`
    : "会话";
  const isGroup = conv?.type === "group";

  // —— 语音通话（Task 4/5）：useVoiceCall 状态机；信令复用当前 WS 通道 ——
  // 仅 Electron 桌面端支持通话：以 preload 暴露的桥接 API 是否存在为判定依据。
  const voiceBridge =
    typeof window !== "undefined"
      ? (window as unknown as { __heming_voice_call?: VoiceCallBridge }).__heming_voice_call
      : undefined;
  const isElectron = voiceBridge !== undefined;
  /** C1 群聊发起通话确认弹窗开关（null=关；非空=显示确认）。 */
  const [groupCallConfirm, setGroupCallConfirm] = useState(false);
  const groupCallPanelRef = useRef<HTMLDivElement | null>(null);
  const forwardPanelRef = useRef<HTMLDivElement | null>(null);
  useModalA11y(groupCallPanelRef, () => setGroupCallConfirm(false), {
    active: groupCallConfirm,
    autoFocus: false,
  });
  useModalA11y(forwardPanelRef, () => setForwardMsg(null), {
    active: forwardMsg !== null,
    autoFocus: false,
  });
  const voiceCall = useVoiceCall({
    send: (e) => wsHandleRef.current?.send(e),
    myUserId: me?.id ?? "",
    isDesktop: isElectron,
  });

  /** 通话对端名映射（1:1 用 conv.peer.displayName）；ringing 横幅与面板共用。 */
  const voicePeerNames = useMemo(() => {
    const map = new Map<string, string>();
    if (conv?.type === "direct" && conv.peer) {
      map.set(conv.peer.id, conv.peer.displayName);
    }
    for (const [id, info] of Object.entries(groupMembers?.byId ?? {})) {
      map.set(id, info.name);
    }
    return map;
  }, [conv, groupMembers]);

  /**
   * C1 群聊 Mesh 通话：从群成员快照取「其他人类成员」作为通话 peer。
   * 只认本群（groupMembers.convId === convId）；agent 无设备公钥不参与通话。
   */
  const groupCallPeerIds = useMemo(() => {
    if (!isGroup || groupMembers?.convId !== convId) return [];
    return groupMembers.userIds.filter((id) => id !== me?.id);
  }, [isGroup, groupMembers, convId, me?.id]);
  /** C1 确认弹窗是否可发起：群聊 + idle + 桌面端 + 成员已加载。 */
  const canInitiateGroupCall =
    isGroup && voiceCall.state.status === "idle" && isElectron && groupMembers?.convId === convId;

  // —— 语音通话桌面通知接线（Task 5 fix）：仅桌面端生效，网页端（桥接缺失）静默跳过 ——
  // 通话状态存 ref：onMinimize 回调挂载期订阅一次，需读取最新状态避免闭包过期。
  /** 本机流 → 工具调用轨迹（只用于 UI 展示，不进消息、不上行）。 */
  const toolTraceRef = useRef<Record<string, ToolTrace[]>>({});
  /** 本轮工具调用次数（复盘判「复杂任务」用；onTurnComplete 拿不到 streamId，故按轮次累计）。 */
  const turnToolCountRef = useRef(0);
  /**
   * 自我修改工具桥（self.*）的依赖与预算。
   *
   * 预算跨轮复用：一轮里改了 N 次就到上限，换一轮重新计数——
   * 上限防的是「单轮内自我膨胀」，不是永久限制。
   */
  const selfEditRef = useRef<{ budget: SelfEditBudget; policy: SelfEditStore } | null>(null);
  selfEditRef.current ??= { budget: new SelfEditBudget(), policy: new SelfEditStore() };

  /**
   * MCP 懒预检（用户要求：工具要自动识别并加载）。
   *
   * 应用启动时 App 已自动连过一次，但那次可能失败（uvx 首次下载依赖要一两分钟、
   * 命令不在 PATH、服务当时没起来）。不补这一步，这次对话就会静默地少一批工具——
   * 模型不知道自己本可以用它，用户也看不出发生了什么。
   *
   * **不在挂载时判断**：挂载 effect 里读 registry 会让组件多一个副作用来源，
   * 且 ChatPage 是常驻的，改一次配置就会触发一轮不可预期的重连。
   * 改成发送时现查现判——条件不满足就是一次 Map 查找，成本可忽略。
   */
  const mcpPrefetched = useRef(false);

  /** 是否还有「启用中但没发现过工具」的服务（决定要不要补连）。异常时返回 false，不拦发送。 */
  const mcpNeedsConnect = () => {
    try {
      return mcpRegistry.servers().some((s) => s.enabled && !mcpRegistry.hasDiscovered(s.id));
    } catch {
      return false;
    }
  };
  /** 新一轮开始时清掉旧轨迹。 */
  const resetToolTrace = (streamId: string) => {
    toolTraceRef.current[streamId] = [];
  };
  const voiceStatusRef = useRef(voiceCall.state.status);
  useEffect(() => {
    voiceStatusRef.current = voiceCall.state.status;
  }, [voiceCall.state.status]);

  // 窗口最小化 → 若仍在通话中则系统通知「通话中」（任务栏不可见时提示用户）。
  // onMinimize 返回取消订阅函数：卸载/桥接变化时退订，防监听器累积（老版本 preload 不返回时降级）。
  useEffect(() => {
    if (!voiceBridge?.onMinimize) return;
    const off = voiceBridge.onMinimize(() => {
      if (voiceStatusRef.current === "active") {
        voiceBridge.notify?.("和鸣", "通话中");
      }
    });
    return typeof off === "function" ? off : undefined;
  }, [voiceBridge]);

  // 来电（被叫 ringing）→ 系统通知（主进程一并闪烁任务栏）；同一 callId 仅通知一次（ref 去重）。
  const notifiedCallRef = useRef<string | null>(null);
  useEffect(() => {
    if (!voiceBridge) return;
    if (voiceCall.state.status !== "ringing" || voiceCall.state.role !== "callee") return;
    const callId = voiceCall.state.callId;
    if (!callId || notifiedCallRef.current === callId) return;
    notifiedCallRef.current = callId;
    voiceBridge.notify?.("和鸣", "语音来电");
  }, [voiceBridge, voiceCall.state.status, voiceCall.state.role, voiceCall.state.callId]);

  /** 消息署名（气泡/引用卡/引用预览共用）：自己「我」；direct 对方名；agent 会话为 agent 名；群内成员映射名（缺失回退 undefined 由调用方处理）。 */
  const displaySenderName = (m: Message) =>
    m.senderId === me?.id
      ? "我"
      : conv?.type === "direct"
        ? peer?.displayName
        : conv?.type === "agent"
          ? conv.agent.name
          : memberInfoById?.[m.senderId]?.name;
  /**
   * 他人气泡左侧头像数据（Task 7）：direct 恒为 peer；agent 会话恒为该 agent 名册项
   * （无 avatar 走首字回退）；group 仅当该 sender 在成员快照中带 avatar 时给出
   * （无则不出头像元素，群内无头像不多占位）。
   */
  const bubbleAvatar = (m: Message): { displayName: string; avatar?: string } | undefined => {
    if (m.senderId === me?.id) return undefined;
    if (conv?.type === "direct") return peer;
    if (conv?.type === "agent") {
      return { displayName: conv.agent.name, avatar: conv.agent.avatar ?? undefined };
    }
    const info = memberInfoById?.[m.senderId];
    return info?.avatar ? { displayName: info.name, avatar: info.avatar } : undefined;
  };
  /**
   * 导出（本机生成）：只导出本机已解密的明文，解不开的信封直接跳过，
   * 不用占位符冒充内容。附件只带元信息，避免把文档正文再抄一份。
   *
   * @param onlyIds 传入时只导出这些消息（多选导出）；不传导出整段会话。
   */
  const exportConversation = (format: "md" | "json", onlyIds?: string[]) => {
    const source = onlyIds
      ? messages.filter((m) => onlyIds.includes(m.id))
      : messages;
    const rows: ExportMessage[] = [];
    for (const m of source) {
      let text = "";
      let file: { id?: string; name: string; mime: string; size: number } | undefined;
      if (m.enc === "e2e") {
        const p = plainOf[m.id];
        if (!p) {
          // 解不开的信封：撤回消息仍保留「已撤回」记录，其余直接跳过
          if (!m.recalledAt) continue;
        } else {
          if (p.kind !== "text" && p.kind !== "file" && p.kind !== "forward") continue; // reaction/chunk/...
          text = p.text ?? "";
          file = p.file;
        }
      } else {
        text = m.payload.text;
        file = m.payload.file;
      }
      if (m.recalledAt) {
        text = "";
        file = undefined;
      }
      if (!text && !file && !m.recalledAt) continue;
      rows.push({
        id: m.id,
        role: m.senderType === "user" ? "user" : "assistant",
        sender: displaySenderName(m) || "成员",
        at: m.createdAt,
        text,
        ...(m.recalledAt ? { recalled: true } : {}),
        ...(file
          ? {
              attachment: {
                ...(file.id ? { id: file.id } : {}),
                name: file.name,
                mime: file.mime,
                size: file.size,
              },
            }
          : {}),
      });
    }

    if (rows.length === 0) {
      setSendNotice(onlyIds ? "所选消息里没有可导出的明文" : "没有可导出的明文消息");
      setExportOpen(false);
      return;
    }
    const input = {
      id: convId,
      title: headerTitle,
      exportedAt: Date.now(),
      messages: rows,
    };
    const content =
      format === "md" ? buildConversationMarkdown(input) : buildConversationJson(input);
    const name = conversationFileName(headerTitle, input.exportedAt, format);
    try {
      const url = URL.createObjectURL(
        new Blob([content], {
          type: format === "md" ? "text/markdown;charset=utf-8" : "application/json;charset=utf-8",
        }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      setSendNotice(`已导出 ${rows.length} 条消息（仅本机明文）`);
    } catch {
      setSendNotice("导出失败，请检查浏览器下载权限", "error");
    }
    setExportOpen(false);
  };

  /**
   * 通知：他会话的新消息进通知中心。
   *
   * 只有 ChatPage 挂着 WS，所以「应用开着时收到他才提醒」是这套结构的既成事实：
   * 系统级推送需要服务端与桌面通知权限，本机时间线不做那件事。
   * E2E 消息此刻还没解密，正文留空（绝不把密文写进通知）。
   */
  const notifyIncomingMessage = (m: Message) => {
    if (m.senderId === me?.id) return;
    // 经 getState 读：WS 回调闭包只随 convId 建立，列表快照会过期
    const conv = useChatStore.getState().conversations.find((c) => c.id === m.conversationId);
    useNotificationStore.getState().push({
      kind: "message",
      key: `message:${m.id}`,
      title: conv ? convTitleOf(conv) : "新消息",
      ...(m.enc === "e2e" ? {} : m.payload.text ? { body: m.payload.text } : {}),
      conversationId: m.conversationId,
    });
  };

  /** 通知：任务收尾进通知中心（用户常在发起任务后切去别处）。 */
  const notifyTaskSettled = (
    taskId: string,
    status: "done" | "failed" | "cancelled",
    detail: string,
  ) => {
    const task = useTaskStore.getState().tasks.find((t) => t.id === taskId);
    const label =
      status === "done" ? "已完成" : status === "failed" ? "执行失败" : "已中断";
    useNotificationStore.getState().push({
      kind: "task",
      key: `task:${taskId}:${status}`,
      title: `${task?.title ?? "任务"}${label}`,
      ...(detail ? { body: detail } : {}),
      taskId,
      ...(task ? { conversationId: task.conversationId } : {}),
    });
  };

  // 导出菜单的「点外面关闭」：临时监听器只在打开时挂，避免常驻。
  useEffect(() => {
    if (!exportOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!exportRef.current?.contains(e.target as Node)) setExportOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [exportOpen]);

  /** 选择器条目：剔除已选（防重复 chip）+ 按 token query 过滤（空串=全量）。 */
  const pickerItems = mentionCandidates.filter(
    (a) =>
      !selectedMentions.some((m) => m.agentId === a.id) &&
      a.name.toLowerCase().includes((picker?.query ?? "").toLowerCase()),
  );

  /**
   * 本次要触发的智能体。
   *
   * 群聊 = 用户手动 @ 选中的（selectedMentions）；智能体一对一 = 固定 @ 对方那个 agent，
   * 不需要（也不能）再手动选——一对一里「跟谁说话」已由会话本身确定，
   * 让用户重复 @ 一遍是多余操作。已选中的会合并去重，避免两边同时指定时重复触发。
   */
  const effectiveMentions = useMemo(() => {
    if (conv?.type !== "agent") return selectedMentions;
    const auto = { agentId: conv.agent.id, name: conv.agent.name };
    return selectedMentions.some((m) => m.agentId === auto.agentId)
      ? selectedMentions
      : [...selectedMentions, auto];
  }, [conv, selectedMentions]);

  /**
   * 能力降级的当场提示（工具）：模型不支持函数调用时编排层会静默丢掉 tools，
   * 用户只会觉得「智能体没去查资料」。这里把降级说破，附带该改绑模型的指引。
   * 只提示**已经授权给模型的工具存在**的情况——一个工具都没开时不谈降级。
   */
  const llmProfiles = useLlmStore((s) => s.profiles);
  const llmBindings = useLlmStore((s) => s.bindings);
  const toolsNotice = useMemo(() => {
    if (mcpRegistry.enabledTools().length === 0) return null;
    return capabilityNotice(
      "tools",
      effectiveMentions.map((m) => ({
        name: m.name,
        profile: (() => {
          const pid = llmBindings[m.agentId];
          return pid ? llmProfiles.find((x) => x.id === pid) : undefined;
        })(),
      })),
    );
  }, [effectiveMentions, llmBindings, llmProfiles]);

  /** agentId → LLM 连接（绑定表解析）：无绑定/连接已删都归为 undefined（发送前拦截与触发共用）。 */
  const resolveProfile = (agentId: string) => {
    const llm = useLlmStore.getState();
    const pid = llm.bindings[agentId];
    return pid ? llm.getProfile(pid) : undefined;
  };

  /**
   * 构造某个智能体这一轮的工具桥。
   *
   * 抽成函数而不是内联在 deps 里：HITL 闸门也要按工具名查风险元数据，
   * 桥必须**是同一个**——查的不是实际执行者的桥 = 问错了人。
   */
  const buildToolsFor = (agentId: string) => {
    const mcpBridge = buildToolBridge();
    const chartBridge = buildChartToolBridge();
    // tone_detect：单个只读工具（算子定位 AI 痕迹，不改任何东西），
    // 描述不长，默认注入。与 self.* 不同——后者是 13 个带写操作的长描述工具，
    // 才需要用户显式开启才给。
    const toneBridge = buildToneToolBridge();
    // wiki_search / wiki_read：只读，默认注入；回答末尾的来源脚注由编排层拼。
    const wikiBridge = buildWikiToolBridge();
    if (!selfEditRef.current!.policy.configured(agentId)) {
      // 没开过自我优化 → 只给 MCP、图表、去 AI 味与知识库工具，self.* 保持不注入
      return mergeToolBridges(mcpBridge, chartBridge, toneBridge, wikiBridge);
    }
    return mergeToolBridges(
      mcpBridge,
      chartBridge,
      toneBridge,
      wikiBridge,
      buildSelfToolBridge(
        {
          memory: memoryStore,
          skills: skillPool,
          mcp: mcpRegistry,
          policy: selfEditRef.current!.policy,
          budget: selfEditRef.current!.budget,
        },
        { agentId, conversationId: convId },
      ),
    );
  };

  /**
   * 按工具名取风险元数据（闸门分类用）。
   *
   * 只认**我们自己写的桥**的显式声明（self.* 的 riskHint、chart.* / tone.* 的只读）；
   * MCP 桥不提供——它的 `annotations` 是 untrusted hint，服务端自述不算数。
   */
  const toolMetaOf = (name: string, agentId: string) => {
    const bridge = buildToolsFor(agentId);
    return bridge?.meta?.(name);
  };

  /** HITL 待确认请求（工具调用确认弹窗的数据源）。 */
  const pendingHitl = useHitlStore((s) => s.pending);
  /**
   * 跨会话的待确认请求：后台会话的流仍可能在跑，弹窗出现在当前会话里时
   * 必须标出归属，否则用户会把 A 会话的工具调用当成 B 会话的动作。
   */
  const pendingElsewhere = Boolean(pendingHitl && pendingHitl.conversationId !== convId);
  const pendingConv = pendingElsewhere
    ? conversations.find((c) => c.id === pendingHitl!.conversationId)
    : undefined;
  const pendingConvLabel = pendingElsewhere
    ? pendingConv
      ? pendingConv.type === "direct"
        ? pendingConv.peer.displayName
        : pendingConv.type === "agent"
          ? pendingConv.agent.name
          : pendingConv.name
      : pendingHitl!.conversationId
    : undefined;

  /**
   * 收口一次工具确认的**唯一路径**（d.34）：写审计 → 按 key 清通知 → decide。
   *
   * 用户点击与超时都走这里——两条路径各自写一遍审计，迟早会分叉（超时那条忘记留痕）。
   * 审计口径不变：批准与拒绝都记一笔。
   */
  const resolveToolApproval = useCallback(
    (
      pending: PendingConfirm,
      verdicts: HitlVerdict[],
      timeoutNotice?: { title: string; body?: string },
    ) => {
      for (const v of verdicts) {
        const call = pending.calls.find((c) => c.id === v.callId);
        if (!call) continue;
        appendToolAudit(hitlAuditStorage, {
          agentId: pending.agentId,
          action: v.decision,
          target: `${call.displayName}（${call.name}）`,
          ...(v.decision === "deny" ? { rejected: v.reason ?? "用户拒绝" } : {}),
        });
      }
      // 处理完的那条「待确认」通知要摘掉，否则用户会点开一个已经结束的请求。
      useNotificationStore.getState().removeByKey(`approval:${pending.requestId}`);
      if (timeoutNotice) {
        // 超时也是一次「替他做了决定」，必须让人知道（否则工具悄悄没执行）。
        useNotificationStore.getState().push({
          kind: "approval",
          key: `approval-timeout:${pending.requestId}`,
          title: timeoutNotice.title,
          body: timeoutNotice.body ?? "",
          conversationId: pending.conversationId,
        });
      }
      useHitlStore.getState().decide({ requestId: pending.requestId, verdicts });
    },
    [],
  );

  // 待确认**属于其他会话**时进通知中心（d.34）：用户可能正在别的页面，弹窗未必在视野里。
  // 当前会话的请求不推——弹窗就在眼前，再来一条只是噪音。
  useEffect(() => {
    if (!pendingHitl || pendingHitl.kind !== "tool-call") return;
    if (pendingHitl.conversationId === convId) return;
    useNotificationStore.getState().push({
      kind: "approval",
      key: `approval:${pendingHitl.requestId}`,
      title: `${pendingHitl.agentName} 请求调用工具`,
      body: `${pendingHitl.calls.map((c) => c.displayName).join("、")}（等待确认）`,
      conversationId: pendingHitl.conversationId,
    });
    // 去重键兜底：切回再切走时重复触发也不会重复推。
  }, [pendingHitl?.requestId, pendingHitl?.conversationId, pendingHitl?.agentName, convId]);

  // 超时按拒绝收口（d.34）：60 分钟没人裁决，逐项 deny 并留痕。
  useEffect(() => {
    if (!pendingHitl || pendingHitl.kind !== "tool-call") return;
    const requestId = pendingHitl.requestId;
    const timer = setTimeout(() => {
      // 读**当前** pending：排队顶上的可能是另一个请求，requestId 对不上就跳过。
      const current = useHitlStore.getState().pending;
      if (!current || current.kind !== "tool-call" || current.requestId !== requestId) return;
      resolveToolApproval(
        current,
        current.calls.map((c) => ({
          callId: c.id,
          decision: "deny" as const,
          reason: "超时未确认",
        })),
        {
          title: "工具确认已超时（已按拒绝处理）",
          body: current.calls.map((c) => c.displayName).join("、"),
        },
      );
    }, hitlTimeoutMs);
    return () => clearTimeout(timer);
  }, [pendingHitl?.requestId, pendingHitl?.kind, resolveToolApproval, hitlTimeoutMs]);

  /** 流气泡署名：本会话 members 映射名优先，其次名册，兜底「智能体」。 */
  const nameOf = (agentId: string) =>
    memberInfoById?.[agentId]?.name ?? agentsRoster.find((a) => a.id === agentId)?.name ?? "智能体";

  /** 本会话的打字机项（含他机流）：渲染在消息列表尾部。 */
  const streamEntries = Object.entries(streaming).filter(([, s]) => s.conversationId === convId);
  /** 「生成中」提示行只报本机流（他机流错误行短暂停留，不占中断入口）。 */
  const activeLocal = streamEntries.filter(([id, s]) => streamOwner[id] && s.status === "streaming");

  /** 本会话已解密明文（占位判定与 reaction kind 判定的数据源；未解密消息无记录）。 */
  const plainOf = plainById[convId] ?? NO_PLAIN;
  /**
   * 表情回应事件消息（kind="reaction" 的 e2e 消息）不画气泡——渲染前过滤，
   * 由 chipsFor 聚合进目标消息的 chips（设计 §5.4）。未解密的事件暂以占位显示。
   */
  // 表情回应（reaction）是「事件」不是「消息」，不进消息流。
  // 用 useMemo 是为了让引用稳定：窗口化与搜索跳转的 effect 都拿它当依赖，
  // 每次渲染都新建数组会让那些 effect 反复触发（尤其是 scrollIntoView）。
  const visibleMessages = useMemo(
    () => messages.filter((m) => !(m.enc === "e2e" && plainOf[m.id]?.kind === "reaction")),
    [messages, plainOf],
  );
  /**
   * 本次停留的未读快照：切进会话时取一次服务端 unreadCount，之后只用于分隔线。
   *
   * 不能实时读 conversations.unreadCount：打开即发 mark_read，很快就会被清零。
   */
  const [unreadMarker, setUnreadMarker] = useState<{ convId: string; count: number } | null>(null);
  const unreadCapturedRef = useRef<string | null>(null);

  useEffect(() => {
    // 切会话先清旧快照；真正的捕获等 conversations 里有这条会话再做（首帧可能还没加载）。
    unreadCapturedRef.current = null;
    setUnreadMarker(null);
  }, [convId]);

  useEffect(() => {
    if (unreadCapturedRef.current === convId) return;
    const target = conversations.find((c) => c.id === convId);
    if (!target) return; // 会话数据还没到，等下一次 conversations 变化
    unreadCapturedRef.current = convId;
    if (target.unreadCount > 0) setUnreadMarker({ convId, count: target.unreadCount });
  }, [convId, conversations]);
  /**
   * 消息列表窗口化（d.33 · P2-2）：只渲染最近 `windowCount` 条。
   *
   * 数据仍全量加载（服务端一次给全、E2E 解密也在数据层），这里只限制同时挂多少
   * DOM 节点——800 条消息 × 每条带引用卡/chips/图表的开销是线性增长的首屏成本。
   * 窗口**只增不减**：往上翻过的历史不因新消息到达被收回（收回去会让阅读位置跳走）。
   */
  const [windowCount, setWindowCount] = useState(DEFAULT_WINDOW);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /** 追加历史前的 scrollHeight：渲染完成后据它补偿 scrollTop，避免内容整体下移一屏。 */
  const prevScrollHeightRef = useRef<number | null>(null);
  const windowedMessages = useMemo(
    () => visibleMessages.slice(-windowCount),
    [visibleMessages, windowCount],
  );
  /** 本次停留的未读锚点：解析一次后冻结（新消息不能让分隔线漂移/二次抢滚动）。 */
  const [unreadAnchor, setUnreadAnchor] = useState<{
    convId: string;
    id: string | null;
    overflow: boolean;
  } | null>(null);
  const anchorResolvedRef = useRef<string | null>(null);
  /** 分隔线只在第一次出现时定位一次；之后用户自己滚，不再抢滚动条。 */
  const dividerScrolledRef = useRef<string | null>(null);

  // 切会话：清旧锚点与定位去重（不跨停留保留，回到会话时重新定位）。
  useEffect(() => {
    anchorResolvedRef.current = null;
    dividerScrolledRef.current = null;
    setUnreadAnchor(null);
  }, [convId]);

  useEffect(() => {
    if (anchorResolvedRef.current === convId) return;
    if (!unreadMarker || unreadMarker.convId !== convId) return;
    if (messagesLoading) return; // 等历史落定再解析锚点
    anchorResolvedRef.current = convId;
    let remaining = unreadMarker.count;
    let id: string | null = null;
    for (let i = visibleMessages.length - 1; i >= 0; i -= 1) {
      const m = visibleMessages[i];
      if (m.senderId === me?.id) continue;
      remaining -= 1;
      if (remaining === 0) {
        id = m.id;
        break;
      }
    }
    const overflow = remaining > 0;
    if (overflow) id = visibleMessages[0]?.id ?? null;
    setUnreadAnchor({ convId, id, overflow });
  }, [convId, unreadMarker, messagesLoading, visibleMessages, me?.id]);

  const unreadDivider =
    unreadAnchor && unreadAnchor.convId === convId
      ? unreadAnchor
      : { convId, id: null, overflow: false };

  // 锚点可能落在初始渲染窗口之外（未读数 > DEFAULT_WINDOW 时）：把窗口扩到包含它，
  // 否则分隔线/提示/定位整条链路都匹配不到 DOM。扩窗不做滚动补偿——随后由分隔线定位接管。
  useEffect(() => {
    if (!unreadAnchor || unreadAnchor.convId !== convId) return;
    if (unreadAnchor.overflow || !unreadAnchor.id) return;
    if (windowedMessages.some((m) => m.id === unreadAnchor.id)) return;
    const idx = visibleMessages.findIndex((m) => m.id === unreadAnchor.id);
    if (idx < 0) return;
    const needed = visibleMessages.length - idx;
    if (needed > windowCount) {
      prevScrollHeightRef.current = null;
      setWindowCount(needed);
    }
  }, [unreadAnchor, convId, visibleMessages, windowedMessages, windowCount]);

  useLayoutEffect(() => {
    if (!unreadAnchor || unreadAnchor.convId !== convId || !unreadAnchor.id) return;
    const key = unreadAnchor.overflow ? `${convId}:overflow` : `${convId}:${unreadAnchor.id}`;
    if (dividerScrolledRef.current === key) return;
    atBottomRef.current = false;
    if (unreadAnchor.overflow) {
      // 未读多到超出已加载窗口：滚到顶，让「有更多未读消息在上方」的提示可见
      const el = scrollRef.current;
      if (el) el.scrollTop = 0;
      dividerScrolledRef.current = key;
      return;
    }
    const el = document.getElementById("unread-divider");
    if (!el) return; // 窗口还没包含锚点，等扩窗后的下一次提交再定位（不记「已定位」）
    dividerScrolledRef.current = key;
    el.scrollIntoView({ block: "start", behavior: "auto" });
  }, [convId, unreadAnchor, windowCount]);
  /** 向更早的方向追加一窗（滚到顶或点「加载更早的消息」）。 */
  const loadEarlierMessages = useCallback(() => {
    const el = scrollRef.current;
    if (!el || windowCount >= visibleMessages.length) return;
    prevScrollHeightRef.current = el.scrollHeight;
    setWindowCount((count) => expandCount(count, visibleMessages.length));
  }, [windowCount, visibleMessages.length]);
  // 切会话：窗口回到初始值（回到该会话时从最近的一窗开始看）。
  // A3：阅读位置复位到最新消息——切进来先看到的是「现在」，不是上次翻到一半的位置。
  // 例外：切进来的会话有未读 → 先不贴底，交给未读分隔线的定位 effect（否则 A3 会先平滑滚底）。
  useEffect(() => {
    setWindowCount(DEFAULT_WINDOW);
    prevScrollHeightRef.current = null;
    const unreadAtSwitch =
      useChatStore.getState().conversations.find((c) => c.id === convId)?.unreadCount ?? 0;
    atBottomRef.current = unreadAtSwitch === 0; // 有未读时先别贴底，交给分隔线定位
    setNewBelow(false);
    if (unreadAtSwitch === 0) {
      bottomRef.current?.scrollIntoView({ behavior: "auto" });
    }
  }, [convId]);
  // 追加后补偿滚动位置：上方长出来的高度要加回 scrollTop，否则正在看的内容会跳走。
  // 用 useLayoutEffect 是为了在绘制前完成补偿，避免看到一帧跳动。
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const prev = prevScrollHeightRef.current;
    if (!el || prev === null) return;
    prevScrollHeightRef.current = null;
    el.scrollTop += el.scrollHeight - prev;
  }, [windowCount]);
  /** 多选：勾/去勾一条（顺序按点击顺序记录，导出仍按消息原始顺序取）。 */
  const toggleSelected = (id: string) =>
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const selectAllVisible = () => setSelectedIds(visibleMessages.map((m) => m.id));
  const exitSelectMode = () => {
    setSelectMode(false);
    setSelectedIds([]);
  };
  /**
   * 会话内搜索的数据源：只取本机明文。未解开的信封不参与——
   * 搜索需要展示/跳转原文，而密文既搜不到也不该被当成空消息。
   */
  const searchableMessages = useMemo(() => {
    const out: { id: string; text: string; recalled?: boolean }[] = [];
    for (const m of visibleMessages) {
      const payload = m.enc === "e2e" ? plainOf[m.id] : m.payload;
      const text = payload && typeof payload.text === "string" ? payload.text : "";
      if (text) out.push({ id: m.id, text, recalled: m.recalledAt != null });
    }
    return out;
  }, [visibleMessages, plainOf]);
  const searchHits = useMemo(
    () => findMessageHits(searchableMessages, searchQuery),
    [searchableMessages, searchQuery],
  );
  const searchIndex = hitPosition(searchHits, searchHitId);
  const activeSearchHit = searchHits[searchIndex >= 0 ? searchIndex : 0] ?? null;
  const activeSearchId = activeSearchHit?.id ?? null;

  useEffect(() => {
    if (!searchOpen || !activeSearchId) return;
    // 命中可能在窗口之外（那条消息没渲染）——先把窗口扩到包含它（留两条上下文），
    // 扩窗后本 effect 会因 windowCount 变化再跑一次，那时节点已在 DOM 里。
    const index = visibleMessages.findIndex((m) => m.id === activeSearchId);
    if (index >= 0) {
      const needed = countToInclude(index, visibleMessages.length, windowCount);
      if (needed > windowCount) {
        setWindowCount(needed);
        return;
      }
    }
    document.getElementById(`msg-${activeSearchId}`)?.scrollIntoView({ block: "center" });
  }, [searchOpen, activeSearchId, visibleMessages, windowCount]);

  const closeSearch = () => {
    setSearchOpen(false);
    setSearchQuery("");
    setSearchHitId(null);
  };

  const goSearch = (delta: 1 | -1) => {
    // 用「当前高亮」而不是 searchHitId：首次输入时还没有显式选中，
    // 高亮的是第一条，按「下一个」应当去第二条而不是原地不动。
    const next = stepHit(searchHits, activeSearchId, delta);
    if (next) setSearchHitId(next.id);
  };
  // 回应 chips 聚合（fix I4）：useMemo 按 messages/plainOf 引用单次聚合——
  // 原实现每渲染对每条消息全量扫 reaction 事件（O(n²)）
  const chipsByMsgId = useMemo(() => aggregateChips(messages, plainOf), [messages, plainOf]);

  /**
   * 启动一次 mention 触发（发送成功 / 错误行重试共用）：
   * deps 全部从 stores + WS 句柄组装；fetchHistory 映射 role 并剔掉刚发出的这条
   * （服务端很可能已入库，否则当前 user 轮会在提示词里出现两遍）。
   * `attachment`：与正文同发的本轮附件——它不进历史，而是直接拼进当前 user 轮
   * （图片内容片 / 文档文本），否则刚上传的附件要等下一轮才进模型。
   */
  const startRun = (
    mentions: { agentId: string; name: string }[],
    text: string,
    taskId?: string,
    attachment?: TurnAttachment,
  ) => {
    // 无 subtle：触发端无法封 chunk/finish——拦截不启动（硬验收⑤：不降级明文回复）
    if (!hasSubtle()) {
      setSendNotice(NO_E2E_NOTICE);
      return;
    }
    const deps: TriggerDeps = {
      getProfile: resolveProfile,
      getPrompt: (agentId) => useLlmStore.getState().prompts[agentId] ?? "",
      fetchHistory: async (historyProfile) => {
        // spec §3：提示词只带近 30 条历史；已撤回跳过；E2E 信封经 loadMessages 合并
        // （缓存优先 → handler 解密 → 占位）——**解不开的不进提示词**（硬验收⑤），
        // reaction/chaindist 控制消息同样不进。
        const msgs = (await useChatStore.getState().loadMessages(convId)).slice(-30);
        const plainOf = useChatStore.getState().plainById[convId] ?? {};
        // 视觉能力按**本智能体绑定的模型**判定：群里两个智能体可能一个能看图、一个不能。
        const vision = resolveCapability(historyProfile).supportsVision;
        const rows: HistoryRow[] = [];
        const images: VisionImageSlot[] = [];
        for (const m of msgs) {
          if (m.recalledAt != null) continue;
          // 本轮同发的附件不进历史：它由 buildUserTurn 拼在当前 user 轮上，
          // 回声若已入库会在这里出现第二份（同一张图发两遍）。
          if (attachment && m.payload.file?.id === attachment.id) continue;
          if (m.enc === "e2e") {
            const p = plainOf[m.id];
            if (!p) continue; // 占位（无法解密）→ 不外发模型供应商
            if (p.kind !== "text" && p.kind !== "file" && p.kind !== "forward") continue;
          }
          // 附件文本要拼进 content，否则模型看不到文件内容——
          // 此前 `content: m.payload.text` 把附件完全忽略了，
          // 用户传了文件、模型却只能说「我看不到文件」。
          //
          // 拼在正文之后：先让用户的话完整呈现，再跟上文件内容，
          // 模型更容易把「问题」和「参考资料」区分开。
          const docText = m.payload.file?.text;
          const content = docText
            ? `${m.payload.text}\n\n${docFileBlock(m.payload.file!.name, docText)}`
            : m.payload.text;
          // 图片不进正文文本，而是作为内容片（供应商各要各的形状）。
          if (vision && isVisionImage(m.payload.file)) {
            images.push({ rowIndex: rows.length, file: m.payload.file });
          }
          rows.push({
            role: m.senderType === "user" ? "user" : "assistant",
            content,
          });
        }
        const last = rows[rows.length - 1];
        if (last && last.role === "user" && last.content === text) rows.pop();
        return attachImageParts(rows, images, visionImageDataUrl);
      },
      // 本轮附件拼进当前 user 轮（与历史行的口径一致：文档文本跟在正文后、图片走内容片）。
      // 附件此刻多半还没进历史（WS 回声未到），走历史就得等下一轮才让模型看到图。
      buildUserTurn: async (turnText, profile) => {
        if (!attachment) return { role: "user", content: turnText };
        const docText = attachment.text;
        const content = docText
          ? `${turnText}\n\n${docFileBlock(attachment.name, docText)}`
          : turnText;
        const row: ChatMessage = { role: "user", content };
        // 与历史同一条能力闸：非视觉模型不解密读图（判定与丢弃同源）。
        if (resolveCapability(profile).supportsVision && isVisionImage(attachment)) {
          const data = await visionImageDataUrl(attachment);
          if (data)
            row.contentParts = [
              { type: "text", text: content },
              { type: "image", mime: attachment.mime, data },
            ];
        }
        return row;
      },
      send: (e) => wsHandleRef.current?.send(e),
      streamChat,
      // Token 用量记账（d.32）：编排层在成功收口前调用一次；
      // null = 供应商一次都没上报 → 记「未上报」，而不是写 0 冒充真实用量。
      recordUsage: (model, tokens) =>
        tokens === null
          ? useTokenUsageStore.getState().recordUnreported(model)
          : useTokenUsageStore.getState().record(model, tokens),
      // E2E 流式（硬验收④）：chunk 走 chunkAad（convId+streamId+index）信封、
      // finish 全文进信封——由 agentStream 统一串行上行，加密失败跳过/报错不发明文。
      sealChunk: async (streamId, index, delta) => {
        const members = await resolveMembers(convId);
        const ev = await sealMessage(
          { id: convId, members },
          { kind: "chunk", text: delta },
          e2eDeps(),
          { aad: chunkAad(convId, streamId, index) },
        );
        if (ev.type !== "send_message" || !ev.cipher) return null;
        return { cipher: ev.cipher, chainKid: ev.chainKid, n: ev.n };
      },
      sealFinish: async (full) => {
        const members = await resolveMembers(convId);
        const plain: PlainEnvelope = { kind: "text", text: full };
        const ev = await sealMessage({ id: convId, members }, plain, e2eDeps());
        if (ev.type !== "send_message" || !ev.cipher) return null;
        // finish 的入库 echo 也是自发信封：登记出站箱（同 sealAndSend）
        if (ev.chainKid !== undefined && ev.n !== undefined) {
          outboxRef.current.set(`${ev.chainKid}:${ev.n}`, plain);
        }
        return { cipher: ev.cipher, chainKid: ev.chainKid, n: ev.n };
      },
      // E2E 错误封条（fix I2）：错误正文（可回显供应商请求片段）同款信封上行。
      // fix round 2：登记出站箱——本机触发的错误经 WS 回声没有 recv 链可解，
      // 只能按链索引取回明文；不登记则回声恒降级为通用文案（丢失真实错误原因）。
      sealError: async (streamId, message) => {
        const members = await resolveMembers(convId);
        const plain: PlainEnvelope = { kind: "error", text: message };
        const ev = await sealMessage(
          { id: convId, members },
          plain,
          e2eDeps(),
          { aad: errorAad(convId, streamId) },
        );
        if (ev.type !== "send_message" || !ev.cipher) return null;
        if (ev.chainKid !== undefined && ev.n !== undefined) {
          outboxRef.current.set(`${ev.chainKid}:${ev.n}`, plain);
        }
        return { cipher: ev.cipher, chainKid: ev.chainKid, n: ev.n };
      },
      onLocalDelta: (streamId, acc) => {
        const meta = streamMeta.current[streamId];
        if (!meta) return;
        // 本机流文本已本地累积（不等 WS 回声），回声由 onWsEvent 按 streamOwner 跳过
        upsertStream(streamId, {
          agentId: meta.agentId,
          conversationId: convId,
          text: acc,
          status: "streaming",
          lastAt: Date.now(), // Task 7 watchdog：累积即刷新
          errorMessage: undefined, // 清掉可能残留的 watchdog 误报（恢复即自愈）
        });
      },
      onStart: (streamId, mention) => {
        streamMeta.current[streamId] = { ...mention, text, attachment };
        if (taskId) {
          streamTaskRef.current[streamId] = taskId;
          useTaskStore.getState().bindStream(taskId, streamId);
        }
        resetToolTrace(streamId);
        turnToolCountRef.current = 0;
        // 新一轮开始：重置自我修改的单轮预算（上轮用掉的次数不该拖累这一轮）
        selfEditRef.current!.budget.reset(mention.agentId, convId);
        markStreamOwner(streamId);
        upsertStream(streamId, {
          agentId: mention.agentId,
          conversationId: convId,
          text: "",
          status: "streaming",
          lastAt: Date.now(),
        });
      },
      // 系统提示词：原提示词 + 三层记忆 + 命中技能（本机拼装，不出设备）。
      // 组装失败（记忆/技能读写异常）回落原提示词，绝不阻断生成。
      buildSystemPrompt: async (agentId, text) => {
        const basePrompt = useLlmStore.getState().prompts[agentId] ?? "";
        try {
          const built = buildAgentContext({
            agentId,
            conversationId: convId,
            userText: text,
            basePrompt,
            memory: memoryStore,
            skills: skillPool,
            // 个性化加权（d.28）：被疑似引用过的记忆在同等相关度下排前面；读不到账本就退化成不加权。
            usage: recallRecorder.usageView,
          });
          // 登记本次注入旁路，供轮次收尾时写召回日志（可观测性；零注入不留档）。
          recallRecorder.capture(agentId, convId, text, built.recallTrace);
          return built.systemPrompt;
        } catch {
          return basePrompt;
        }
      },
      // 思考过程（reasoning/thinking）：本机展示用，不参与最终消息文本。
      onReasoning: (streamId, text) => {
        const meta = streamMeta.current[streamId];
        if (!meta) return;
        upsertStream(streamId, {
          agentId: meta.agentId,
          conversationId: convId,
          reasoning: text,
          status: "streaming",
          lastAt: Date.now(),
        });
      },
      // 工具调用轨迹：start 立刻出「调用中」，end 补结果与成败。
      onToolTrace: (streamId, e) => {
        const meta = streamMeta.current[streamId];
        if (!meta) return;
        const taskId = streamTaskRef.current[streamId];
        const list = (toolTraceRef.current[streamId] ??= []);
        const idx = list.findIndex((t) => t.id === e.id);
        if (e.phase === "start") {
          turnToolCountRef.current += 1;
          const entry: ToolTrace = {
            id: e.id,
            name: e.name,
            args: e.args,
            status: "running",
            startedAt: Date.now(),
          };
          if (idx >= 0) list[idx] = entry;
          else list.push(entry);
          if (taskId) {
            useTaskStore.getState().stepStart(taskId, { id: e.id, name: e.name, args: e.args });
          }
        } else if (idx >= 0) {
          const status = e.denied ? "denied" : e.ok ? "ok" : "error";
          list[idx] = {
            ...list[idx],
            // 「已拒绝」与「失败」分开：被拒的工具**根本没执行**，
            // 混成失败用户会以为「我拒了，但它还是跑了」。
            status,
            result: e.result,
            endedAt: Date.now(),
          };
          if (taskId) {
            useTaskStore.getState().stepEnd(taskId, e.id, {
              status,
              ...(e.result === undefined ? {} : { result: e.result }),
              ...(e.sources?.length ? { sources: e.sources } : {}),
              ...(e.denyCause ? { denyCause: e.denyCause } : {}),
            });
          }
        }
        upsertStream(streamId, {
          agentId: meta.agentId,
          conversationId: convId,
          tools: [...list],
          status: "streaming",
          lastAt: Date.now(),
        });
      },
      // 工具调用：MCP 外部工具 + 图表工具（chart.*）+ 自我修改工具（self.*）合并成一个桥。
      // 三者形状一致（OpenAI tools + {name, arguments}），模型不需要分别学几套协议；
      // 执行时按工具名分流到各自的桥，失败都带 ok=false 回给模型而不是抛。
      // getTools 带 agentId 参数（群聊 @ 多个 agent 时逐个构造，self.* 的上下文才准确）。
      //
      // 【按需提供】self.* 一共 13 个工具、描述不算短，全部塞进每次请求会明显推高 token。
      // 因此只在用户**显式开启过**该智能体的自我优化时才注入；从未配置过 = 不给。
      // 想开的话去技能区底部「自我优化」卡勾选（那里默认是勾上的）。
      //
      // chart.* 只有 2 个工具、描述短，且不写任何存储、无副作用（只是把数据变成图），
      // 所以默认注入——用户随时可能让智能体画图，不该先去设置里开开关。
      getTools: (agentId: string) => buildToolsFor(agentId),
      // HITL 闸门（设计 §4.3）：工具执行**之前**问用户同不同意。
      //
      // 这是整个 HITL 层的**唯一接线点**：agentStream 在拿到 tool_calls 之后、
      // 调 bridge.execute 之前调它一次。被拒的项不会被执行——
      // 闸门把结果原样带回来，编排层据此改回「未执行」的文案。
      //
      // ★ 闸门异常一律按**拒绝**处理。
      //
      // 「闸门异常不得让整轮对话失败」= 模型总能收到一条 tool 消息，
      // **不是「工具总能执行」**——工具不执行时模型照样收到「未执行」的消息，对话继续。
      // 反过来若这里放行，闸门一坏就等于所有危险工具静默执行，
      // 而那恰恰是最不该放行的时刻。
      //
      // 兜底方向的选择比索引正确性更关键：兜底是 deny 时出错只会「误拒」
      //（用户立刻发现并报告）；兜底是 allow 时出错就是「误放行」，**静默且不可见**。
      confirmToolCalls: async (calls, ctx) => {
        try {
          return await hitlGate.review(
            toHitlBatch(calls, ctx, (name) => toolMetaOf(name, ctx.agentId)),
          );
        } catch (e) {
          console.warn("HITL 闸门异常，按拒绝处理", e);
          return calls.map((call) => ({
            kind: "deny" as const,
            call: {
              id: call.id,
              name: call.function.name,
              argsJson: call.function.arguments,
              displayName: call.function.name,
              risk: "write" as const,
              summary: "",
              source: "unknown" as const,
            },
            reason: "确认流程异常，本次调用未执行",
            cause: "gate" as const,
          }));
        }
      },
      // 轮次收尾写记忆（设计 §3）：成功轮次走 recordTurn（Working + 显式抽取 + 6 轮沉淀）；
      // 中断/失败只记 Working 并标 partial，不沉淀长期记忆。全程静默，绝不影响发送与流式渲染。
      // appendTurn 本身不判总开关，故这里先看 settings.enabled（关闭=不记录也不召回）。
      onTurnComplete: (agentId, userText, assistantText, status) => {
        try {
          if (!memoryStore.getSettings().enabled) return;
          if (status === "ok") {
            memoryStore.recordTurn(agentId, convId, userText, assistantText);
            // 召回日志：本轮真注入了记忆才留档（判据与写入见 memory/runRecorder.ts）。
            recallRecorder.settle({ agentId, conversationId: convId, userText, assistantText });
            // 复盘分身：任务结束后后台自评「有什么值得长期记住」，即发即忘、不阻塞流式。
            // 三道闸门（记忆总开关 / 长期记忆开关 / 有绑定的 LLM 连接）都在 runner 内判断。
            maybeRunReview({
              agentId,
              conversationId: convId,
              userText,
              assistantText,
              recentTurns: memoryStore.working(convId, agentId).slice(-6),
              toolCallCount: turnToolCountRef.current,
              profile: resolveProfile(agentId),
            });
          }
          else {
            memoryStore.appendTurn({
              conversationId: convId,
              agentId,
              userText,
              assistantText,
              partial: true,
            });
          }
        } catch {
          /* 记忆失败静默降级 */
        }
      },
      // 任务区终态：每个流恰好一次。只有从任务区发起的流带 taskId；
      // 普通聊天流不建档，任务区列表也不会被日常对话刷屏。
      onRunSettled: (streamId, result) => {
        const taskId = streamTaskRef.current[streamId];
        if (!taskId) return;
        delete streamTaskRef.current[streamId];
        const status =
          result.status === "ok" ? "done" : result.status === "aborted" ? "cancelled" : "failed";
        useTaskStore.getState().settle(taskId, {
          status,
          ...(result.finalText === undefined ? {} : { result: result.finalText }),
          ...(result.error === undefined ? {} : { error: result.error }),
        });
        notifyTaskSettled(taskId, status, result.error ?? result.finalText ?? "");
      },
      // 上下文预算（设计 §4）：agentStream 在 fetchHistory 之后调用——按本机设置做 token
      // 预算切分与早期对话压缩（摘要置于历史之前）；溢出重试带 aggressive 重新调用。
      // LLM 摘要用该 agent 绑定的 profile 走 streamChat（非 event-stream 分支整段返回），
      // 不落库、不上行 WS、失败返回 null（回落确定性摘要）；异常一律返回原 rows。
      prepareHistory: async (rows, agentId, opts) => {
        try {
          const profile = resolveProfile(agentId);
          return await prepareAgentHistory(rows, {
            settings: loadContextSettings(),
            cache: summaryCache,
            conversationId: convId,
            aggressive: opts?.aggressive,
            summarize: profile
              ? async (messages) => {
                  if (!messages.length) return null;
                  try {
                    let collected = "";
                    // 摘要请求独立于本次生成的中断（生成尚未开始）；只读不改：不落库
                    const text = await streamChat(profile, messages, {
                      signal: new AbortController().signal,
                      maxTokens: 400,
                      onDelta: (d) => {
                        collected += d;
                      },
                    });
                    return text || collected || null;
                  } catch {
                    return null; // 摘要失败 → 回落零成本的确定性摘要
                  }
                }
              : undefined,
          });
        } catch {
          return rows; // 压缩失败不阻断生成：按原样发送
        }
      },
    };
    // 同步拿句柄（挂在 promise 上）：中断按钮不必等 fetchHistory/流完成
    const run = runAgentMentions(convId, mentions, text, deps);
    const runs = (runsRef.current[convId] ??= new Set());
    runs.add(run);
    // 完成即摘除：卸载时 WS cleanup 据此判断是否还有「进行中流」需延迟 close（F1）
    run.then(
      () => runs.delete(run),
      (e) => {
        runs.delete(run);
        // fetchHistory 失败等启动期错误：生成未开始，可见提示而非静默
        console.warn("智能体生成启动失败", e);
        setSendNotice("智能体生成启动失败，请稍后重试", "error");
      },
    );
  };

  /** 中断当前会话全部进行中流：abort → 各流 catch 走 finish-partial + agent_error(aborted)。 */
  const abortRuns = () => {
    for (const h of runsRef.current[convId] ?? []) h.abortAll();
    // 确认弹窗也要收掉：否则用户按了停止，弹窗还杵在屏幕上，
    // 闸门的 await 永不 resolve → 整轮挂死（设计 §4.4）。
    useHitlStore.getState().cancelAll("用户中断");
  };

  /** 错误行重试：清掉旧项，按原触发文本重新跑该单个 mention（新 streamId 重新登记）。 */
  const retryStream = (streamId: string) => {
    const meta = streamMeta.current[streamId];
    if (!meta) return;
    // 任务区的流重试：任务记录跟着回到「进行中」，否则重试成功也不会更新汇总
    const taskId =
      streamTaskRef.current[streamId] ??
      useTaskStore.getState().tasks.find((t) => t.streamId === streamId)?.id;
    if (taskId) useTaskStore.getState().reopen(taskId);
    removeStream(streamId);
    delete streamMeta.current[streamId];
    delete streamTaskRef.current[streamId];
    startRun([{ agentId: meta.agentId, name: meta.name }], meta.text, taskId, meta.attachment);
  };

  // 切会话清 @ 选择态 + 输入区浮层：chip/picker/锁/表情/语音都是会话级（ChatPage 常驻不重挂），
  // 防跨会话带出 mentions 或把识别中的收尾状态留给新会话。语音必须真正 stop 旧识别器并清实例——
  // 只复位 listening 标志的话，旧实例仍在后台识别：onresult 回填新会话草稿、晚到的 onend 误清新指示。
  useEffect(() => {
    recRef.current?.stop();
    recRef.current = null;
    setSelectedMentions([]);
    setPicker(null);
    setTokenLock(false);
    setEmojiOpen(false);
    setVoiceMenu(false);
    // 录音同为会话级：中止旧会话录音（置取消位 → stop，onstop 停轨且跳过发送），录音态即时退出
    setRecording(false);
    voiceRecCancelRef.current?.();
    setListening(false);
    // 回复引用也是会话级：A 会话的引用目标不得带进 B 会话
    setReplyTarget(null);
    // 转发浮层同为会话级：A 会话选中的转发目标不得带进 B 会话
    setForwardMsg(null);
    // 表情回应浮排同为会话级：A 会话打开的回应对不得带进 B 会话
    setReactFor(null);
    // 发送提示也是会话级：A 会话的「上传失败/不支持语音」不得带进 B 会话
    setSendNotice(null);
    // 多选状态同为会话级：A 会话勾的 id 在 B 会话里不存在，留着只会导出空文件
    setSelectMode(false);
    setSelectedIds([]);
  }, [convId]);

  // E2E Task 4：会话初始化 + 解密 handler 注入 + 身份公钥上云（硬验收①——不上云则
  // 对端 fetchPeerKeys 恒 null：chaindist 永不发出、消息全 defer）。声明位置在 WS 效果
  // 之前：effects 按声明序执行，首帧网络事件到达时 handler 必已就位。
  useEffect(() => {
    if (!hasSubtle()) return; // 无 subtle：横幅 + 拦截，不建链不注入
    void initSession(convId, e2eDeps());
    useChatStore.getState().setOpenHandler(makeOpenHandler(convId));
    void exportOwnDeviceKeys()
      .then((keys) => putE2eKeys(keys))
      .catch((e) => console.warn("E2E 公钥上云失败", e));
    return () => {
      useChatStore.getState().setOpenHandler(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convId]);

  // 历史拉取走 store.loadMessages：plain 直通、信封经 handler 解密合并（§6 缓存优先），
  // 解不开的留占位（渲染无法解密、不进提示词）；alive 挡卸载/切会话后的晚到写入。
  // A1：loadMessages 自己吞掉失败（落 messagesError），这里只记「本会话已完成过一次拉取」，
  // 用于区分首帧骨架 / 真空态（成功且为空才是「还没有消息」）。
  useEffect(() => {
    let alive = true;
    void useChatStore
      .getState()
      .loadMessages(convId, () => alive)
      .finally(() => {
        if (alive) setHistoryLoaded((prev) => ({ ...prev, [convId]: true }));
      });
    return () => {
      alive = false;
    };
  }, [convId]);

  // 存量自迁移（设计 §7）：挂载后后台把本会话自己发的 plain 消息重封为 e2e 信封，
  // store 内 20/s 节流逐条 PUT；attempted ref 跨批次去重（成功后 enc 变 e2e 自然出局）
  useEffect(() => {
    if (!hasSubtle() || !me) return;
    const list = useChatStore.getState().messages[convId] ?? [];
    if (!list.some((m) => m.enc === "plain" && m.senderId === me.id)) return;
    let alive = true;
    void (async () => {
      const members = await resolveMembers(convId);
      if (!alive) return;
      await useChatStore
        .getState()
        .migrateOwnPlain(convId, members, e2eDeps(), migratedRef.current, me.id, () => alive);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convId, messages.length, me?.id]);

  // 挂载拉本会话已读态（direct 气泡「已读」依赖；失败不阻断会话）
  useEffect(() => {
    void loadReads(convId).catch(() => {
      /* 已读是增强信息：拉取失败静默降级（无「已读」标记） */
    });
  }, [convId, loadReads]);

  // 群会话挂载拉一次成员表：id→名（气泡署名）+ agent 行（@ 候选，本会话群口径）；direct 走 peer.displayName
  useEffect(() => {
    if (conv?.type !== "group") return;
    let alive = true;
    void fetchMembers(convId)
      .then((list) => {
        if (!alive) return;
        setGroupMembers({
          convId,
          // Task 7：id→{名, 头像}（avatar 非空才带键）——署名与群内他人气泡头像共用此快照
          byId: Object.fromEntries(
            list.map((m) => [m.id, { name: m.name, ...(m.avatar ? { avatar: m.avatar } : {}) }]),
          ),
          agents: list
            .filter((m) => m.kind === "agent")
            .map((m) => ({ id: m.id, name: m.name, avatar: m.avatar })),
          userIds: list.filter((m) => m.kind === "user").map((m) => m.id),
        });
      })
      .catch(() => {
        /* 成员缺失仅影响署名与 @ 候选，不阻断会话 */
      });
    return () => {
      alive = false;
    };
  }, [convId, conv?.type]);

  useEffect(() => {
    let alive = true; // 挡卸载后晚到的补拉写入（同 loadMessages effect 口径）
    const handle = connectWs({
      onEvent: (e) => {
        // 流式三事件收口（chunk 累积/message_new{streamId} 移除/agent_error 分态）在 store 统一处理
        useChatStore.getState().onWsEvent(e);
        // 语音通话信令（voice_call_*）转交 useVoiceCall 状态机
        voiceCall.handleServerEvent(e);
        if (e.type === "message_new" && e.message.conversationId === convId) {
          appendMessage(e.message);
          // 会话内正在看的新消息即时标记已读：否则退出后 loadWorkspace 会把已读内容算作未读
          if (e.message.senderId !== useAuthStore.getState().user?.id) {
            wsHandleRef.current?.send({ type: "mark_read", conversationId: convId });
          }
        } else if (e.type === "message_new") {
          // 他会话的新消息：未读 +1（A12：自己发的不算）+ 进通知中心
          if (e.message.senderId !== useAuthStore.getState().user?.id) {
            useChatStore.getState().bumpUnread(e.message.conversationId);
            notifyIncomingMessage(e.message);
          }
        } else if (e.type === "read_update") {
          // A12：自己在别的端/页面读过 → 该会话未读清零（不只是当前会话）。
          if (e.userId === useAuthStore.getState().user?.id) {
            useChatStore.getState().clearUnread(e.conversationId);
          }
          if (e.conversationId === convId) {
            // 事件只带 userId/at：整表重拉（读数很小），direct 气泡「已读」随动；他会话忽略
            void loadReads(convId).catch(() => {
              /* 同挂载期降级：拉取失败保留旧读态 */
            });
          }
        } else if (e.type === "error") {
          console.warn(`[${e.code}] ${e.message}`);
        }
      },
      onOpen: () => {
        setConnected(true);
        setConnState("open");
        if (hadClosedRef.current) {
          setRecovered(true);
          if (recoveredTimer.current) clearTimeout(recoveredTimer.current);
          recoveredTimer.current = setTimeout(() => setRecovered(false), 3000);
        }
        // 断线重连成功：补拉断档消息（合并去重语义，幂等；信封同走解密合并）
        void useChatStore.getState().loadMessages(convId, () => alive);
        // Task 7：重连成功补齐「断线期间的已读」——仍有未读则补发 mark_read
        // （与挂载逻辑同款读法；handle 取本 effect 闭包里的，非 ref，防重连期间句柄已换）
        const unread =
          useChatStore.getState().conversations.find((c) => c.id === convId)?.unreadCount ?? 0;
        if (unread > 0) handle?.send({ type: "mark_read", conversationId: convId });
      },
      onClose: () => {
        // 本端主动断开（切会话/卸载）不是「断线」：effect 已重连，别闪一条断线横幅。
        if (!alive) return;
        setConnected(false);
        setConnState("closed");
        hadClosedRef.current = true;
      },
      // d.30 · P1-8：离线队列溢出/无 token 发送失败 → 复用既有 setSendNotice 提示，
      // 不新造组件（规格 §5）。静默丢帧的话用户永远不知道有东西没发出去。
      onSendError: (reason) => setSendNotice(`发送失败：${reason}`, "error"),
    });
    wsHandleRef.current = handle;
    // 进会话即报已读（有未读才发；send 在未连通时入队，连接后随首帧冲刷）。
    // 经 getState 读，避免把 conversations 放进依赖导致 WS 随列表刷新重连
    const unread = useChatStore
      .getState()
      .conversations.find((c) => c.id === convId)?.unreadCount ?? 0;
    if (unread > 0) {
      handle?.send({ type: "mark_read", conversationId: convId });
    }
    return () => {
      alive = false;
      // F1 回归：进行中流被卸载中止时，catch 要经此连接补发 finish(partial)+agent_error
      // （服务端入库 partial、他机端收 error 收口）。立即 close + 清 ref 会把两帧静默丢弃——
      // catch 在微任务里跑，故把 close 延后一个宏任务（微任务必先排空），ref 同步清空也一并延后。
      // 无进行中流则立即关（绝大多数切会话/卸载路径，行为不变）。
      const hasInFlight = Object.values(runsRef.current).some((s) => s.size > 0);
      if (hasInFlight && handle) {
        setTimeout(() => {
          handle.close();
          if (wsHandleRef.current === handle) wsHandleRef.current = null;
        }, 0);
      } else {
        handle?.close();
        wsHandleRef.current = null;
      }
    };
  }, [convId, appendMessage, loadReads]);

  /**
   * A3 滚动贴底跟随：贴底时才跟着新消息与流式文本走；用户上滑后不再强行拽底，
   * 改为在右下角亮起「↓ 新消息」。切会话由上面的 convId effect 强制回到底部。
   *
   * 用 `streamTick`（各流文本/思考长度之和）当依赖：流式每帧文本变化都会推进它，
   * 而对象引用本身每次都变、不能直接进依赖。
   */
  const streamTick = streamEntries
    .map(([, s]) => (s.text?.length ?? 0) + (s.reasoning?.length ?? 0))
    .join(",");
  useEffect(() => {
    if (atBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    } else {
      setNewBelow(true);
    }
  }, [messages.length, streamTick]);

  // I1 挂载清扫：上一轮卸载中止流后 socket 已关，finish/echo 收不到，store（整页刷新
  // 才会清空）里可能残留本会话的「生成中」孤儿项与 streamOwner 键。新挂载时 runsRef
  // 必为空 → 该 convId 下不可能有进行中流，残留一律按孤儿清（他/其他会话条目不动）。
  // 空依赖 = 只在新挂载执行；切会话（convId 变化）不清——那时他机流条目仍有效。
  useEffect(() => {
    clearStreamsForConversation(convId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 他机流 watchdog（Task 7）：存在 status==="streaming" 的在飞项时，每 15s 扫一次全局 streaming，
  // 把长时间无响应（>60s 未刷新）的打字机项置 error 行（阈值在 store；本机流不自动重试，error 行有手动重试）。
  // 门取「存在 streaming 项」而非「streaming 非空」——纯 error 残留（本机 retry 行 / 他机流 6s 自清窗口）
  // 不再挂表：既不空转、也不让假时钟测试的 runAllTimers 无法收敛。有在飞流即起、全部收口即卸。
  const hasLiveStream = Object.values(streaming).some((s) => s.status === "streaming");
  useEffect(() => {
    if (!hasLiveStream) return;
    const timer = window.setInterval(
      () => sweepStaleStreams(Date.now()),
      STREAM_SWEEP_INTERVAL_MS,
    );
    return () => window.clearInterval(timer);
  }, [hasLiveStream, sweepStaleStreams]);

  // 卸载（离开聊天页）：中止全部进行中流，不再空烧供应商 token；语音识别同停；
  // 录音中止同走取消位（onstop 停麦克风轨、放弃发送，60s 定时器一并清）
  useEffect(
    () => () => {
      for (const set of Object.values(runsRef.current)) {
        for (const h of set) h.abortAll();
      }
      // 离开聊天页时确认弹窗也要收：闸门在等用户的裁决，
      // 不收就是整轮挂死（设计 §4.4）。
      useHitlStore.getState().cancelAll("页面离开");
      recRef.current?.stop();
      voiceRecCancelRef.current?.();
    },
    [],
  );

  // 切走会话**不再**替用户拒绝（d.34）：待确认请求保持待定，弹窗标注来源会话，
  // 用户切回来还能裁决。闸门在裁决到达前不会执行工具（兜底方向是「不执行」），
  // 所以「保持待定」是安全的；反过来「用户没同意却被记成拒绝」才是不对的。

  /** 右栏目录「发送到会话」投递：单槽命中本会话即封 e2e 信封经 WS 发送并清槽。 */
  const pendingAttachment = useUiStore((s) => s.pendingAttachment);
  useEffect(() => {
    if (!pendingAttachment || pendingAttachment.conversationId !== convId) return;
    if (!hasSubtle()) {
      // 硬验收⑤：附件路径同样拦截不降级；清槽防切会话后再次触发
      setSendNotice(NO_E2E_NOTICE);
      useUiStore.getState().consumePendingAttachment();
      return;
    }
    void sealAndSend({
      kind: "file",
      text: "",
      file: pendingAttachment.file,
    });
    useUiStore.getState().consumePendingAttachment();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAttachment, convId]);

  /** 键入触发：草稿尾随 @token（空格一断 token 即结束）→ 过滤弹选择器；direct 不触发。 */
  /**
   * 输入栏高度（可拖动）：只作用于「文本行」这一块，不挤压上方的提示/引用/工具行。
   * 初次读 localStorage（用户上次拖的高度），无记录用默认值。
   */
  const [composerHeight, setComposerHeight] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(COMPOSER_HEIGHT_KEY);
      if (raw !== null) return clampComposerHeight(Number(raw));
    } catch {
      /* 存储不可用：用默认值 */
    }
    return DEFAULT_COMPOSER_HEIGHT;
  });
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);

  const onComposerDragStart = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    dragRef.current = { startY: e.clientY, startH: composerHeight };
  };
  const onComposerDragMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    // 向上拖（clientY 变小）= 加高
    setComposerHeight(clampComposerHeight(d.startH - (e.clientY - d.startY)));
  };
  const onComposerDragEnd = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    try {
      localStorage.setItem(COMPOSER_HEIGHT_KEY, String(composerHeight));
    } catch {
      /* 配额/隐私模式异常：高度只在本次会话生效 */
    }
  };

  const onDraftChange = (value: string) => {
    setDraft(value);
    scheduleDraftSave(convId, value);
    if (!isGroup) return;
    const token = /@([^\s@]*)$/.exec(value);
    if (token) {
      if (!tokenLock) setPicker({ via: "token", query: token[1] });
    } else {
      if (tokenLock) setTokenLock(false);
      // token 触发的选择器随 token 消失关闭；按钮开的保留（靠 Esc/发送关）
      setPicker((p) => (p?.via === "token" ? null : p));
    }
  };

  const pickMention = (item: MentionItem) => {
    setSelectedMentions((prev) =>
      prev.some((m) => m.agentId === item.id)
        ? prev
        : [...prev, { agentId: item.id, name: item.name }],
    );
    // 键入路径：草稿保持原样（@token 还在），锁住到 token 消失，否则继续输入会每击键重弹
    if (picker?.via === "token") setTokenLock(true);
    setPicker(null);
  };

  /** Esc 关信息卡（文档级：焦点不在输入框也能关；input 内 Esc 由 onInputKeyDown 管 picker）。 */
  useEffect(() => {
    if (!infoOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setInfoOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [infoOpen]);

  /** Esc 关语音双选项浮层（文档级，与信息卡/转发浮层同口径）。 */
  useEffect(() => {
    if (!voiceMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setVoiceMenu(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [voiceMenu]);

  /** Esc 关表情回应浮排（文档级，与信息卡/转发/语音浮层同口径）。 */
  useEffect(() => {
    if (reactFor === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setReactFor(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [reactFor]);

  /** A11：选择器查询变化/已选项变化时，键盘高亮回到第一项。 */
  useEffect(() => {
    setPickerIndex(0);
  }, [picker?.query, picker?.via, selectedMentions.length]);

  /**
   * A10：无浮层、无草稿时 Esc 停止生成。
   * 挂在文档级而不是输入框上：用户可能正把光标放在消息区/刚点过别处，
   * 但只要没有正在编辑的内容、也没有任何浮层在等 Esc，Esc 的语义就是「停」。
   */
  useEffect(() => {
    if (activeLocal.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (draft.trim() !== "") return;
      if (
        picker ||
        emojiOpen ||
        voiceMenu ||
        reactFor !== null ||
        forwardMsg ||
        infoOpen ||
        exportOpen ||
        groupCallConfirm ||
        searchOpen
      ) {
        return;
      }
      abortRuns();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // abortRuns 每帧重建；本 effect 只关心「是否该接 Esc」的门槛状态
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeLocal.length,
    draft,
    picker,
    emojiOpen,
    voiceMenu,
    reactFor,
    forwardMsg,
    infoOpen,
    exportOpen,
    groupCallConfirm,
    searchOpen,
  ]);

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (picker) {
      // A11：↑/↓ 移动、Enter 选中、Esc 关闭（焦点一直在输入框，按键在这里分派）
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setPickerIndex((i) => Math.max(0, Math.min(pickerItems.length - 1, i + 1)));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setPickerIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === "Enter" && !e.nativeEvent.isComposing) {
        const item = pickerItems[Math.min(pickerIndex, pickerItems.length - 1)];
        if (item) {
          e.preventDefault();
          pickMention(item);
          return;
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setPicker(null);
        setTokenLock(false); // Esc 关闭同步解锁：后续键入可重开（否则旧锁卡住 token 路径）
        return;
      }
    }
    // 多行输入框：Enter 发送、Shift+Enter 换行（输入法组词中不拦，否则中文选词会被当成发送）
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      e.currentTarget.form?.requestSubmit();
    }
  };

  /** A7：粘贴截图/文件 → 走 sendFile 同一套校验（6MB、类型、E2E 拦截）。 */
  const onComposerPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length === 0) return; // 纯文本粘贴不拦
    e.preventDefault();
    void sendFile(files[0]);
  };

  /**
   * 发送一条消息（聊天输入栏与任务区自动执行共用；附件入口带 attachment 走同一条）。
   *
   * 返回失败原因而不是只设提示：任务区自动执行失败时要把任务收口成「失败」，
   * 光靠 sendNotice 的异步 state 拿不到。
   */
  const submitMessage = async (
    rawText: string,
    mentions: { agentId: string; name: string }[],
    replyTo: Message | null,
    taskId?: string,
    attachment?: TurnAttachment,
  ): Promise<{ ok: true } | { ok: false; error: string }> => {
    const text = rawText.trim();
    if (!text) return { ok: false, error: "消息为空" };
    /**
     * MCP 懒预检（用户要求：工具要自动识别并加载）。
     *
     * 应用启动时已经自动连过一次，但那次可能失败（uvx 首次下载依赖要一两分钟、
     * 命令不在 PATH、服务当时没起来）。若不补这一步，这次对话就会静默地
     * 少一批工具——模型不知道自己本可以用 PowerShell，用户也看不出发生了什么。
     *
     * 只在「有启用中的服务却还没发现过工具」时才连，正常路径零开销。
     * 永不阻塞发送：预检失败只是这轮没有 MCP 工具，聊天照常。
     * 已预检过（mcpPrefetched）就不再重复——一次会话里补连一次就够了。
     */
    if (!mcpPrefetched.current && mcpNeedsConnect()) {
      mcpPrefetched.current = true;
      void autoConnectAll()
        .then(() => {
          // 连完把标记复位：下次仍有「未发现」的服务时还能再补
          mcpPrefetched.current = false;
        })
        .catch(() => {
          /* 静默：这轮没有 MCP 工具，但不该挡住聊天 */
        });
    }
    // 硬验收⑤：无 subtle 先拦（保留草稿与已选 mention），绝不降级明文发送
    if (!hasSubtle()) {
      return { ok: false, error: NO_E2E_NOTICE };
    }
    // 发送前拦截：@ 到的智能体没绑 LLM 连接 → 不发消息，本地提示去设置页配置（草稿/chip 保留）
    const unbound = mentions.find((m) => !resolveProfile(m.agentId));
    if (unbound) {
      const error = `${unbound.name} 未绑定 LLM 连接，请先在设置页配置`;
      return { ok: false, error };
    }
    if (!wsHandleRef.current) {
      // 保留草稿与已选 mention，给出可见提示（不静默丢弃）
      const error = "连接未就绪，消息未发送";
      return { ok: false, error };
    }
    // 正文/mentions/replyTo 全进密文（§3.3），事件 payload 只留 {text:""} 占位
    const plain: PlainEnvelope = {
      kind: attachment ? "file" : "text",
      text,
      ...(attachment ? { file: attachment } : {}),
      ...(mentions.length ? { mentions } : {}),
      ...(replyTo ? { replyTo: replyTo.id } : {}),
    };
    // 拦截/封失败：草稿与浮层状态原样保留
    if (!(await sealAndSend(plain))) return { ok: false, error: "消息发送失败" };
    // 发送成功即触发各 mention 的本机流式生成（失败/中断由 WS 三事件回声收口）
    if (mentions.length) startRun(mentions, text, taskId, attachment);
    return { ok: true };
  };

  /** 发送成功后清空输入区（草稿 / @ chip / 回复引用 / 旧提示）。 */
  const resetComposer = () => {
    setDraft("");
    cancelDraftSave();
    clearDraft(convId);
    setSelectedMentions([]);
    setPicker(null);
    setTokenLock(false);
    setSendNotice(null);
    setReplyTarget(null);
  };

  /**
   * A9：纯文本发送失败后的「重试」——重放失败时的那份内容（文本/mentions/引用），
   * 不读当前草稿（用户可能已经改过字）；附件场景不提供重试（避免重放一次上传）。
   * 失败仍在 → 继续挂重试入口，用户可再点。
   */
  const retryTextSend = async (
    text: string,
    mentions: { agentId: string; name: string }[],
    replyTo: Message | null,
  ) => {
    const result = await submitMessage(text, mentions, replyTo);
    if (!result.ok) {
      setSendNotice(result.error, "error", () => void retryTextSend(text, mentions, replyTo));
      return;
    }
    // 失败后用户可能已经改了草稿：只在「还是原来那份」时清空输入区，
    // 否则保留他新写的字，只把提示换成成功态（避免重试把他刚输入的内容吞掉）。
    if (draftRef.current === text) {
      resetComposer();
      return;
    }
    setSendNotice("已重新发送", "info");
  };

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    // 空草稿：按钮已 disabled；回车/表单提交也要兜住，不把「消息为空」当成错误弹红
    if (!draft.trim()) return;
    const text = draft;
    const mentions = effectiveMentions;
    const replyTo = replyTarget;
    const result = await submitMessage(text, mentions, replyTo);
    if (!result.ok) {
      // 纯文本发送失败：红色 role=alert + 「重试」（附件路径见 sendFile，不给重试）。
      // NO_E2E 例外：常驻横幅本身就是 role=alert，不再重复一条同样的红字。
      if (result.error !== NO_E2E_NOTICE) {
        setSendNotice(result.error, "error", () => void retryTextSend(text, mentions, replyTo));
      }
      return;
    }
    resetComposer();
  };

  // 任务区投递：把目标写进输入区并排队自动发送（连接可能还没就绪，见下一个 effect）。
  // 命中会话才消费——投递槽是单条，别的会话的草稿不该在这里被吃掉。
  useEffect(() => {
    if (!taskDraft || taskDraft.conversationId !== convId) return;
    consumeTaskDraft();
    setDraft(taskDraft.text);
    // 投递来的目标也要落盘：否则刷新一下这段文本就没了
    saveDraft(convId, taskDraft.text);
    setSelectedMentions(taskDraft.mentions);
    setPicker(null);
    setTokenLock(false);
    setSendNotice(null);
    setAutoTask(taskDraft);
  }, [taskDraft, convId, consumeTaskDraft]);

  // 自动执行：等 WS 连接就绪再发（首次打开会话时 connected 还是 false）。
  // 失败只收口任务记录并保留用户写的目标——不静默丢，也不误标成功。
  useEffect(() => {
    if (!autoTask || !connected) return;
    const pending = autoTask;
    setAutoTask(null);
    void (async () => {
      const result = await submitMessage(pending.text, pending.mentions, null, pending.taskId);
      if (!result.ok) {
        useTaskStore.getState().settle(pending.taskId, { status: "failed", error: result.error });
        notifyTaskSettled(pending.taskId, "failed", result.error);
        setSendNotice(result.error, "error");
        return;
      }
      setDraft("");
      cancelDraftSave();
      clearDraft(convId);
      setSelectedMentions([]);
      setPicker(null);
      setTokenLock(false);
      setSendNotice(null);
    })();
    // submitMessage 每帧重建；本 effect 只该在「投递到达 / 连接就绪」时跑一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoTask, connected]);

  /**
   * 转发（Task 4）：原 text + 原 file 原样带走，**剥离 mentions**（@ 语境属于源会话），
   * forward 来源进密文（§3.3）封 e2e 信封发到目标会话（server 只按 isMember 校验）。
   * 无 subtle 拦截不发送（硬验收⑤：转发路径同样不降级）。转发到非当前会话时借
   * sendNotice 给提示行（转发到当前会话则清提示）。
   */
  const doForward = async (target: Conversation) => {
    if (!forwardMsg || !wsHandleRef.current) return;
    if (!hasSubtle()) {
      setSendNotice(NO_E2E_NOTICE);
      return;
    }
    const src = conversations.find((x) => x.id === convId);
    const plain: PlainEnvelope = {
      kind: "forward",
      text: forwardMsg.payload.text,
      ...(forwardMsg.payload.file ? { file: forwardMsg.payload.file } : {}),
      forward: {
        from:
          forwardMsg.senderId === me?.id
            ? "我"
            : (memberInfoById?.[forwardMsg.senderId]?.name ?? peer?.displayName ?? "未知"),
        source: src ? convLabel(src).name : "未知会话",
      },
    };
    if (!(await sealAndSend(plain, target.id))) return;
    setForwardMsg(null);
    setSendNotice(target.id === convId ? null : `已转发到 ${convLabel(target).name}`);
  };

  /** 附件上限：服务端 json 体上限 8MB，base64 膨胀约 4/3 → 6MB 留余量（超限给可见提示）。 */
  const MAX_UPLOAD = 6 * 1024 * 1024;

  /** 工具行「图片/文件」入口：临时 file input（不入 DOM），选中即走 sendFile。 */
  const pickFile = (accept: string | undefined) => {
    const input = document.createElement("input");
    input.type = "file";
    if (accept) input.accept = accept;
    input.onchange = () => {
      const f = input.files?.[0];
      if (!f) return;
      void sendFile(f);
    };
    input.click();
  };

  /** 附件发送：先传共享库拿 meta，再封 file 信封经 WS 发（无正文时 text 空串，气泡只渲染附件段）。
   *  **输入框里有正文就同发**：一条消息带 text + file，并当场触发 @ 到的智能体——
   *  拆成两条会让刚上传的图片只落到历史里，等下一轮才进模型，这一轮的提问也就问给了空气。
   *  无 subtle 在上传前拦截——不白跑一次上传（硬验收⑤：附件/语音全路径不降级）。 */
  const sendFile = async (f: File) => {
    // A8：上传中防重入（入口按钮已禁用，这里兜住粘贴/拖拽/快捷键同帧连发）
    if (uploadingRef.current) return;
    if (!hasSubtle()) {
      // 常驻横幅已说明原因（role=alert），这里不再叠第二条相同提示
      return;
    }
    const handle = wsHandleRef.current;
    if (!handle) {
      setSendNotice("连接未就绪，消息未发送", "error");
      return;
    }
    if (f.size > MAX_UPLOAD) {
      setSendNotice("文件需小于 6MB", "error");
      return;
    }
    const draftText = draft.trim();
    // 同发前先把「@ 了没绑模型的智能体」拦在上传之前：上传要几秒，
    // 传完才被 submitMessage 拦下等于白传一个占配额又发不出去的孤儿文件。
    if (draftText) {
      const unbound = effectiveMentions.find((m) => !resolveProfile(m.agentId));
      if (unbound) {
        setSendNotice(`${unbound.name} 未绑定 LLM 连接，请先在设置页配置`, "error");
        return;
      }
    }
    uploadingRef.current = true;
    setUploading(true);
    try {
      // 解析不放"正在读取"这类提示：它通常几百毫秒就完，
      // 闪一下反而干扰；更要紧的是 status 那个位置要留给真正的错误
      //（上传失败 / 内容提取失败），被占住会让错误提示延后出现。
      const mime = f.type || "application/octet-stream";
      // 图片能被模型读到的前提是绑定的模型支持视觉（能力表）；不支持时照常发送，
      // 但要当场说明「模型看不到内容」，而不是让用户等一句「我看不到图片」。
      // 文案与工具降级共用 capabilityNotice，两处口径一致。
      const visionNotice = capabilityNotice(
        "vision",
        effectiveMentions.map((m) => ({ name: m.name, profile: resolveProfile(m.agentId) })),
      );
      const doc = isDocumentLike(f.name, mime) ? await parseDocument(f, f.name) : null;

      const meta = await uploadEncryptedFile(f);
      // await 后闭包已旧：切了会话或 socket 已换/已关则丢弃，防发错会话/向已关句柄静默发送
      const live = wsHandleRef.current;
      if (live !== handle || useUiStore.getState().activeConversationId !== convId) {
        setSendNotice("已切换会话，文件未发送", "error");
        return;
      }
      // 消息侧保留原名/原 mime/原大小（气泡按它路由与展示），fileKey 随消息进密文；
      // meta 是服务端密文形态（.enc 名 + octet-stream），仅取 id。
      // text：解析出的文档内容，随文件一起进密文——服务端始终拿不到明文。
      const file: TurnAttachment = {
        id: meta.id,
        name: f.name,
        mime,
        size: f.size,
        key: meta.key,
        ...(doc?.ok && doc.text ? { text: doc.text } : {}),
      };
      // 解析/能力提示与发送结果共用一条口径：图片没有文档文本，成功时保留
      // 「模型不支持视觉」的提示——这一条比「已发送」更有用，用户据此决定要不要换模型或改问法。
      const notice = !doc
        ? visionNotice
        : doc.ok
          ? doc.truncated
            ? `已发送；内容较长，模型只读到前 ${doc.chars} 字`
            : null
          : `已发送；内容未能提取：${doc.error ?? "未知原因"}`;
      if (draftText) {
        // 同发：正文 + 附件进同一条 file 消息，走文本消息的全套拦截与触发路径
        const result = await submitMessage(
          draftText,
          effectiveMentions,
          replyTarget,
          undefined,
          file,
        );
        if (!result.ok) {
          // 附件场景不给「重试」：重放会再上传一次（A9 的取舍）
          setSendNotice(result.error, "error");
          return; // 草稿原样保留
        }
        resetComposer();
        // resetComposer 已清 sendNotice；成功/能力提示要最后落（否则被清掉）
        setSendNotice(notice);
        return;
      }
      const ok = await sealAndSend({ kind: "file", text: "", file });
      if (ok) setSendNotice(notice);
    } catch (err) {
      setSendNotice(`上传失败：${(err as Error).message}`, "error");
    } finally {
      uploadingRef.current = false;
      setUploading(false);
    }
  };

  /**
   * 语音输入开关（Web Speech API）：环境缺构造器（Electron/无 Google 语音 key 属预期）
   * → 可见提示，不自造录音/转写；可用时识别结果直接追加进草稿。
   */
  const toggleVoice = () => {
    const SR =
      (window as unknown as {
        SpeechRecognition?: new () => never;
        webkitSpeechRecognition?: new () => never;
      }).SpeechRecognition ??
      (window as unknown as { webkitSpeechRecognition?: new () => never }).webkitSpeechRecognition;
    if (!SR) {
      setSendNotice("当前环境不支持语音输入");
      return;
    }
    if (listening) {
      recRef.current?.stop();
      return;
    }
    const rec = new (SR as unknown as new () => {
      lang: string;
      interimResults: boolean;
      continuous: boolean;
      onresult: (e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void;
      onend: () => void;
      onerror: () => void;
      start(): void;
      stop(): void;
    })();
    rec.lang = "zh-CN";
    rec.interimResults = true;
    rec.continuous = false;
    // 迟到回调守卫：切会话后 recRef 已置空/换新，旧实例的收尾回调不得作用于新会话
    // （onresult 回填新会话草稿、onend 误清新指示、onerror 弹无关的错误提示）
    rec.onresult = (e) => {
      if (recRef.current !== rec) return;
      let t = "";
      for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript;
      setDraft((d) => {
        const next = d ? `${d}${t}` : t;
        // 语音回填也要落盘（StrictMode 下 updater 可能被调两次，写入同一份文本，幂等）
        scheduleDraftSave(convId, next);
        return next;
      });
    };
    rec.onend = () => {
      if (recRef.current !== rec) return;
      setListening(false);
    };
    rec.onerror = () => {
      if (recRef.current !== rec) return;
      setListening(false);
      setSendNotice("语音识别不可用", "error");
    };
    recRef.current = rec;
    rec.start();
    setListening(true);
  };

  /** 特性检测：无 MediaRecorder 或缺 mediaDevices.getUserMedia 时录音选项禁用 + 小字提示（不自造降级）。 */
  const hasRecorder = typeof MediaRecorder !== "undefined" && !!navigator.mediaDevices?.getUserMedia;

  /**
   * 开始录音（语音消息选项）：getUserMedia → MediaRecorder 录 webm。
   * 结束（自然停 / 60s 上限 / 手动停）统一在 onstop：停轨 → 时长判定（<1s 拒发）
   * → 复用 sendFile（上传 + 纯附件消息，6MB 上限与失败提示一并继承）。
   */
  const startRecording = async () => {
    // 录音中 或 授权 await 挂起中都挡重入：voiceRecRef 要到 recorder.start() 后才有值，
    // 授权窗口内再点一次会覆写 voiceRecCancelRef，首实例取消链断裂 → 麦克风轨无「录音中」指示且无人停
    if (voiceRecRef.current || voiceRecPendingRef.current) return;
    const pendingToken = {}; // 身份 token：resolve/失败路径只清「仍是本实例」的占位，不误清后一实例
    voiceRecPendingRef.current = pendingToken;
    let stream: MediaStream | null = null;
    let rec: MediaRecorder | null = null;
    let cancelled = false; // 本实例取消位（闭包）：取消/切会话/卸载 → 停止启动/跳过发送
    // 取消位必须在 await getUserMedia「之前」注册：首次授权弹窗可能挂起数秒~数分钟，
    // 该窗口内切会话/卸载调的 voiceRecCancelRef.current?.() 才不是 no-op。cancel 对尚未
    // 创建的 rec 判空——此时只置位，resolve 后由下面的校验停轨且不启动。
    const cancel = () => {
      cancelled = true;
      if (rec && rec.state === "recording") rec.stop();
    };
    voiceRecCancelRef.current = cancel;
    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream = mediaStream;
      // resolve 后先校验：授权等待期已被取消/切会话 → 立即停轨返回，不启动录音、不上传
      if (cancelled) {
        mediaStream.getTracks().forEach((t) => t.stop());
        return;
      }
      const recorder = new MediaRecorder(mediaStream);
      rec = recorder; // 供 cancel（await 前注册）与 finally 判空：闭包内改用窄化后的 recorder
      const chunks: BlobPart[] = [];
      recorder.ondataavailable = (e) => chunks.push(e.data);
      recorder.onstop = () => {
        mediaStream.getTracks().forEach((t) => t.stop()); // 无论发不发送都停麦克风轨（防占用/泄漏）
        if (voiceRecTimerRef.current != null) {
          clearTimeout(voiceRecTimerRef.current); // 60s 上限定时器随结束即清
          voiceRecTimerRef.current = null;
        }
        if (voiceRecRef.current === recorder) voiceRecRef.current = null;
        if (voiceRecCancelRef.current === cancel) voiceRecCancelRef.current = null;
        setRecording(false);
        if (cancelled) return; // 取消/切会话/卸载：静默放弃，不上传不发送
        const dur = Date.now() - voiceRecStartRef.current;
        const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
        if (dur < 1000) {
          setSendNotice("录音太短，未发送", "error");
          return;
        }
        const f = new File(
          [blob],
          `语音-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}.webm`,
          { type: blob.type },
        );
        void sendFile(f); // 既有上传 + 发 file 消息（MAX_UPLOAD 6MB 检查复用）
      };
      recorder.start();
      voiceRecRef.current = recorder;
      voiceRecStartRef.current = Date.now();
      setRecording(true);
      setSendNotice(null);
      voiceRecTimerRef.current = window.setTimeout(() => {
        if (voiceRecRef.current === recorder && recorder.state === "recording") recorder.stop(); // 60s 上限自动停
      }, 60_000);
    } catch {
      if (stream) stream.getTracks().forEach((t) => t.stop()); // 半途失败（权限拒/无设备）不留活轨
      if (!cancelled) setSendNotice("无法访问麦克风", "error"); // 取消/切会话后的授权失败保持静默
    } finally {
      // 本次启动未接续到录音（授权等待期被取消 / getUserMedia 失败）：清掉可能残留的 cancel 注册。
      // rec 非空时交给 onstop 收口，且不误清后一实例已注册的 cancel。
      if (!rec && voiceRecCancelRef.current === cancel) voiceRecCancelRef.current = null;
      // pending 占位同样按身份清（成功启动时：占位仍为本实例，一并清；voiceRecRef 已接管重入防线）
      if (voiceRecPendingRef.current === pendingToken) voiceRecPendingRef.current = null;
    }
  };

  /** 正常停止：onstop 里按时长判定发送（<1s 拒发）。 */
  const stopRecording = () => {
    const rec = voiceRecRef.current;
    if (rec && rec.state === "recording") rec.stop();
  };

  /** 取消：置本实例取消位后 stop——onstop 停轨、跳过发送，静默退出录音态。 */
  const cancelRecording = () => {
    voiceRecCancelRef.current?.();
  };

  // —— A3：滚动贴底与「↓ 新消息」 ——

  /** 主动回到底部（浮动按钮/切会话用）：同时重置贴底状态，后续继续跟随。 */
  const scrollToLatest = useCallback((behavior: ScrollBehavior = "smooth") => {
    atBottomRef.current = true;
    setNewBelow(false);
    bottomRef.current?.scrollIntoView({ behavior });
  }, []);

  /** 消息区滚动：更新贴底判定（<80px 视为贴底），顺带触发「加载更早」。 */
  const onMessageScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distance < STICK_BOTTOM_PX;
    atBottomRef.current = atBottom;
    if (atBottom) setNewBelow(false); // 自己滚回底部即视为看过
    if (shouldLoadMore(el.scrollTop, visibleMessages.length, windowCount)) {
      loadEarlierMessages();
    }
  };

  /** A7：拖拽拖入消息区 → 直接走 sendFile（同一套 6MB/类型/E2E 校验）。 */
  const onMessagesDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (Array.from(e.dataTransfer?.types ?? []).includes("Files")) e.preventDefault();
  };
  const onMessagesDrop = (e: React.DragEvent<HTMLDivElement>) => {
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    e.preventDefault();
    void (async () => {
      for (const f of files) await sendFile(f); // 串行：上传状态与消息顺序都只走一个通道
    })();
  };

  // —— A5：整条消息复制（clipboard + execCommand 兜底，短暂「已复制」） ——

  const copyMessage = async (m: Message) => {
    const text = m.payload.text ?? "";
    let ok = true;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(text);
    } catch {
      // 非安全上下文/权限缺失的退路：临时 textarea + execCommand（与代码块复制同款）
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      } finally {
        document.body.removeChild(area);
      }
    }
    if (!ok) return; // 两条路都失败就不装作成功
    setCopiedMsgId(m.id);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopiedMsgId(null), 1600);
  };
  // 卸载时清掉复制态定时器（避免对已卸载组件 setState）
  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    [],
  );

  return (
    <div className="relative flex h-full flex-col">
      <header className="relative flex items-center gap-2.5 border-b border-line-soft px-5 py-3">
        {!embedded && (
          <button
            type="button"
            aria-label="返回"
            className="rounded p-1 text-muted hover:bg-[#f3f3f3]"
            onClick={leave}
          >
            <ChevronIcon width={15} height={15} className="rotate-180" />
          </button>
        )}
        {conv && (
          <Avatar
            user={
              conv.type === "direct"
                ? conv.peer
                : conv.type === "agent"
                  ? { displayName: conv.agent.name, avatar: conv.agent.avatar ?? undefined }
                  : { displayName: conv.name }
            }
            size={28}
          />
        )}
        <span className="text-[14px] font-bold">{headerTitle}</span>
        <span className="flex items-center gap-1 text-[12px] text-muted">
          <span
            aria-hidden="true"
            className={`h-1.5 w-1.5 rounded-full ${
              connState === "open"
                ? "bg-[#12b76a]"
                : connState === "closed"
                  ? "bg-[#b45309]"
                  : "bg-[#c4c4c4]"
            }`}
          />
          {connState === "open" ? "已连接" : connState === "closed" ? "连接已断开" : "连接中…"}
        </span>
        {recovered && (
          <span role="status" className="text-[11px] text-[#12b76a]">
            已恢复连接
          </span>
        )}
        {conv?.type === "direct" && voiceCall.state.status === "idle" && (
          <>
            {/* 语音 / 视频通话都开独立窗口：面板不再盖住消息区，窗口可拖动/置顶。
                被浏览器拦截弹窗（或 Electron 未放行）时回退到页内面板，不丢功能。 */}
            <button
              type="button"
              aria-label="发起语音通话"
              className="rounded-lg p-1.5 hover:bg-[#f3f3f3]"
              onClick={() => {
                if (conv?.type !== "direct") return;
                const opened = openCallWindow({
                  conversationId: conv.id,
                  peerIds: [conv.peer.id],
                  mode: "voice",
                  title: conv.peer.displayName,
                });
                if (!opened) {
                  setSendNotice("通话窗口被拦截，已在当前窗口发起语音通话");
                  void voiceCall.call(conv.id, [conv.peer.id]);
                }
              }}
            >
              <PhoneIcon width={17} height={17} />
            </button>
            <button
              type="button"
              aria-label="发起视频通话"
              className="rounded-lg p-1.5 hover:bg-[#f3f3f3]"
              onClick={() => {
                if (conv?.type !== "direct") return;
                const opened = openCallWindow({
                  conversationId: conv.id,
                  peerIds: [conv.peer.id],
                  mode: "video",
                  title: conv.peer.displayName,
                });
                if (!opened) {
                  setSendNotice("通话窗口被拦截，已在当前窗口发起视频通话");
                  void voiceCall.call(conv.id, [conv.peer.id]);
                }
              }}
            >
              <VideoIcon width={17} height={17} />
            </button>
          </>
        )}
        {canInitiateGroupCall && (
          <button
            type="button"
            aria-label="发起群通话"
            className="rounded-lg p-1.5 hover:bg-[#f3f3f3]"
            onClick={() => setGroupCallConfirm(true)}
          >
            <PhoneIcon width={17} height={17} />
          </button>
        )}
        {/* 会话内搜索：在已解密明文里找关键词，跳转并高亮命中的消息。 */}
        <button
          type="button"
          aria-label="搜索会话"
          aria-pressed={searchOpen}
          className={`ml-auto rounded-lg p-1.5 hover:bg-[#f3f3f3]${searchOpen ? " bg-[#f3f3f3]" : ""}`}
          onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
        >
          <SearchIcon width={17} height={17} />
        </button>
        {/* 多选导出：进入勾选态后，消息行左侧出复选框，header 下方出工具条。 */}
        <button
          type="button"
          aria-label="选择消息导出"
          aria-pressed={selectMode}
          className={`rounded-lg p-1.5 text-muted hover:bg-[#f3f3f3]${
            selectMode ? " bg-[#f3f3f3] text-ink" : ""
          }`}
          onClick={() => {
            if (selectMode) {
              exitSelectMode();
            } else {
              setSelectMode(true);
              setSelectedIds([]);
            }
          }}
        >
          <SelectIcon width={17} height={17} />
        </button>
        {/* 导出：只读本机已解密密文，生成 Markdown / JSON 下载（不经过服务端）。 */}
        <div ref={exportRef} className="relative">
          <button
            type="button"
            aria-label="导出会话"
            aria-haspopup="menu"
            aria-expanded={exportOpen}
            className="rounded-lg p-1.5 text-muted hover:bg-[#f3f3f3]"
            onClick={() => setExportOpen((v) => !v)}
          >
            <DownloadIcon width={17} height={17} />
          </button>
          {exportOpen && (
            <div
              role="menu"
              aria-label="导出会话"
              className="absolute right-0 top-full z-30 mt-1 w-[180px] rounded-xl border border-[#ececec] bg-white p-1 shadow-card"
            >
              <button
                type="button"
                role="menuitem"
                className="w-full rounded-lg px-2 py-1.5 text-left text-[12px] hover:bg-[#f7f7f7]"
                onClick={() => exportConversation("md")}
              >
                导出 Markdown
              </button>
              <button
                type="button"
                role="menuitem"
                className="w-full rounded-lg px-2 py-1.5 text-left text-[12px] hover:bg-[#f7f7f7]"
                onClick={() => exportConversation("json")}
              >
                导出 JSON
              </button>
              <p className="px-2 pb-1 pt-0.5 text-[10px] leading-4 text-[#999]">
                仅包含本机可解密的明文
              </p>
            </div>
          )}
        </div>
        {groupCallConfirm && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/20"
            onClick={() => setGroupCallConfirm(false)}
          >
            <div
              ref={groupCallPanelRef}
              role="dialog"
              aria-modal="true"
              aria-label="发起群通话确认"
              className="w-[280px] rounded-xl border border-[#ececec] bg-white p-3 shadow-card"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mb-3 text-[13px] font-bold">邀请 {groupCallPeerIds.length} 人加入通话？</div>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  className="rounded-lg border border-line px-3 py-1.5 text-[12px] text-muted hover:bg-[#f7f7f7]"
                  onClick={() => setGroupCallConfirm(false)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="rounded-lg bg-ink px-3 py-1.5 text-[12px] font-bold text-white"
                  onClick={() => {
                    setGroupCallConfirm(false);
                    const opened = openCallWindow({
                      conversationId: convId,
                      peerIds: groupCallPeerIds,
                      mode: "voice",
                      title: conv?.type === "group"
                        ? conv.name
                        : conv?.type === "agent"
                          ? conv.agent.name
                          : conv?.peer.displayName,
                    });
                    if (!opened) {
                      setSendNotice("通话窗口被拦截，已在当前窗口发起群通话");
                      void voiceCall.call(convId, groupCallPeerIds);
                    }
                  }}
                >
                  确认
                </button>
              </div>
            </div>
          </div>
        )}
        <button
          type="button"
          aria-label="会话信息"
          className={`rounded-lg p-1.5 hover:bg-[#f3f3f3]${infoOpen ? " bg-[#f3f3f3]" : ""}${conv?.type === "direct" && voiceCall.state.status === "idle" && !canInitiateGroupCall ? "" : " ml-auto"}`}
          onClick={() => setInfoOpen((v) => !v)}
        >
          <MenuIcon width={17} height={17} />
        </button>
        {infoOpen && conv && <ChatInfoCard conv={conv} onClose={() => setInfoOpen(false)} />}
      </header>
      {connState === "closed" && (
        <div
          role="status"
          className="border-b border-[#f0d58c] bg-[#fff7e6] px-5 py-1.5 text-[11px] text-[#b45309]"
        >
          连接已断开，正在自动重连…消息会排队，恢复后自动补发
        </div>
      )}
      {searchOpen && (
        <div className="flex items-center gap-2 border-b border-line-soft bg-[#fafafa] px-5 py-2">
          <SearchIcon width={14} height={14} className="shrink-0 text-[#999]" />
          <input
            autoFocus
            aria-label="搜索本会话"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setSearchHitId(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                goSearch(e.shiftKey ? -1 : 1);
              } else if (e.key === "Escape") {
                e.preventDefault();
                closeSearch();
              }
            }}
            placeholder="在本会话中搜索…"
            className="min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-[#bbb]"
          />
          <span className="shrink-0 text-[11px] text-muted">
            {searchQuery.trim()
              ? searchHits.length
                ? `${(searchIndex >= 0 ? searchIndex : 0) + 1}/${searchHits.length}`
                : "无匹配"
              : ""}
          </span>
          <button
            type="button"
            aria-label="上一个匹配"
            disabled={searchHits.length === 0}
            onClick={() => goSearch(-1)}
            className="rounded px-1.5 py-0.5 text-[12px] text-[#777] hover:bg-[#f0f0f0] disabled:text-[#ccc]"
          >
            ↑
          </button>
          <button
            type="button"
            aria-label="下一个匹配"
            disabled={searchHits.length === 0}
            onClick={() => goSearch(1)}
            className="rounded px-1.5 py-0.5 text-[12px] text-[#777] hover:bg-[#f0f0f0] disabled:text-[#ccc]"
          >
            ↓
          </button>
          <button
            type="button"
            aria-label="关闭搜索"
            onClick={closeSearch}
            className="rounded px-1.5 py-0.5 text-[12px] text-[#777] hover:bg-[#f0f0f0]"
          >
            ×
          </button>
        </div>
      )}
      {/* 多选导出工具条：与搜索条同层（header 下方一条），不常驻挤压消息区。 */}
      {selectMode && (
        <div className="flex items-center gap-2 border-b border-line-soft bg-[#fafafa] px-5 py-2 text-[12px]">
          <span className="shrink-0 text-muted">已选 {selectedIds.length} 条</span>
          <button
            type="button"
            onClick={selectAllVisible}
            className="shrink-0 rounded-lg border border-line bg-white px-2 py-1 hover:bg-[#f3f3f3]"
          >
            全选
          </button>
          <button
            type="button"
            onClick={() => setSelectedIds([])}
            disabled={selectedIds.length === 0}
            className="shrink-0 rounded-lg border border-line bg-white px-2 py-1 hover:bg-[#f3f3f3] disabled:opacity-40"
          >
            清空
          </button>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => exportConversation("md", selectedIds)}
              disabled={selectedIds.length === 0}
              className="rounded-lg border border-line bg-white px-2.5 py-1 hover:bg-[#f3f3f3] disabled:opacity-40"
            >
              导出所选 Markdown
            </button>
            <button
              type="button"
              onClick={() => exportConversation("json", selectedIds)}
              disabled={selectedIds.length === 0}
              className="rounded-lg border border-line bg-white px-2.5 py-1 hover:bg-[#f3f3f3] disabled:opacity-40"
            >
              导出所选 JSON
            </button>
            <button
              type="button"
              onClick={exitSelectMode}
              className="rounded-lg px-2 py-1 text-muted hover:bg-[#f0f0f0] hover:text-ink"
            >
              退出选择
            </button>
          </div>
        </div>
      )}
      {/* 来电横幅（ringing 状态时显示）。
          接听/拒绝按钮不在此渲染：VoiceCallPanel 根节点为 fixed inset-0 z-50，
          横幅（普通静态流节点、无 z-index）被面板完全遮挡，按钮不可见不可点。
          按钮已移入面板内的 callee ringing 分支，此横幅仅保留可见的来电提示文案。 */}
      {voiceCall.state.status === "ringing" && (
        <div className="flex items-center justify-between gap-3 border-b border-line-soft bg-[#1a1a2e] px-5 py-2.5 text-white">
          <span className="text-[13px]">
            {voiceCall.state.role === "caller" ? "正在呼叫…" : "来电"}
          </span>
        </div>
      )}
      {/* 消息区：px-8 给头像列留出外边距（头像不贴屏幕边），py-5 让首行不顶边。
          上窄下宽的 py 差是刻意留的「呼吸位」——完全等距时第一条消息会顶着 header 底线，
          视觉上像被切掉一截。 */}
      <div
        ref={scrollRef}
        data-testid="message-list"
        onScroll={onMessageScroll}
        onDragOver={onMessagesDragOver}
        onDrop={onMessagesDrop}
        className="flex-1 overflow-y-auto px-8 pb-5 pt-6"
      >
        {/* 窗口之外还有历史时给一个显式入口：滚到顶会自动加载，
            但触控板/滚轮行为在部分设备上不可靠，按钮是兜底，也让人知道「上面还有」。 */}
        {visibleMessages.length > windowCount && (
          <div className="mb-3 flex justify-center">
            <button
              type="button"
              onClick={loadEarlierMessages}
              className="rounded-lg border border-line px-3 py-1.5 text-[12px] text-muted shadow-card hover:bg-[#fafafa]"
            >
              加载更早的消息（还有 {visibleMessages.length - windowCount} 条）
            </button>
          </div>
        )}
        {visibleMessages.length === 0 && streamEntries.length === 0 ? (
          messagesLoading || !historyLoaded[convId] ? (
            // A1 首屏骨架：历史还没回来时不能把「正在加载」画成空会话
            <div
              data-testid="messages-skeleton"
              aria-busy="true"
              aria-label="正在加载消息"
              className="space-y-3"
            >
              {[0, 1, 2].map((i) => (
                <div key={i} className={`flex ${i % 2 === 1 ? "justify-end" : ""}`}>
                  <div className="h-9 w-[46%] animate-pulse rounded-xl bg-[#f0f0f0]" />
                </div>
              ))}
            </div>
          ) : messagesError ? (
            // A1 失败态：失败与「真的没有消息」必须长得不一样
            <div className="flex h-full flex-col items-center justify-center text-center">
              <div role="alert" className="text-[13px] font-bold text-[#b42318]">
                加载失败：{messagesError}
              </div>
              <button
                type="button"
                className="mt-2 rounded-lg border border-line bg-white px-3 py-1.5 text-[12px] text-[#555] hover:bg-[#fafafa]"
                onClick={() => {
                  void useChatStore.getState().loadMessages(convId);
                }}
              >
                重试
              </button>
            </div>
          ) : (
            // A1 真空态：只有「加载成功且确实为空」才走到这里
            <div className="flex h-full flex-col items-center justify-center text-center">
              <div className="rounded-2xl border border-line-soft bg-white p-3 text-[#999]">
                <ChatIcon width={22} height={22} />
              </div>
              <div className="mt-3 text-[13px] font-bold text-[#555]">还没有消息</div>
              <div className="mt-1 text-[11px] text-muted">发送第一条消息，开始这段对话。</div>
            </div>
          )
        ) : null}
        {unreadDivider.overflow ? (
          <div className="mb-3 flex justify-center">
            <span className="rounded-full bg-[#fff7e6] px-2.5 py-0.5 text-[10px] text-[#b45309]">
              有更多未读消息在上方
            </span>
          </div>
        ) : null}
        {windowedMessages.map((m, index) => {
          const mine = m.senderId === me?.id;
          // A4：时间分隔——窗口首条也插（上方还有历史时它就是当前阅读段的起点）
          const windowStart = visibleMessages.length - windowedMessages.length;
          const prevMsg =
            index > 0
              ? windowedMessages[index - 1]
              : windowStart > 0
                ? visibleMessages[windowStart - 1]
                : undefined;
          const showSeparator = needsTimeSeparator(prevMsg?.createdAt, m.createdAt);
          // 已撤回：正文/附件/已读一律不渲染，只出一行灰字（头像与署名结构保留）
          const recalled = m.recalledAt != null;
          // 署名：自己「我」；direct 对方名；群内他人用挂载时拉到的成员映射名（缺失则不渲染署名行）
          const senderName = displaySenderName(m);
          // 左侧头像（Task 7）：direct 恒为 peer；群内他人仅当成员快照带 avatar 时出（无则不出）
          const senderAvatarUser = bubbleAvatar(m);
          // 仅 direct：对方读点 ≥ 本条时间 → 已读（逐条判断；群 M2 不显示；已撤回不显示）
          const readByPeer = mine && !recalled && !!peerReadAt && peerReadAt >= m.createdAt;
          // 引用卡：回复消息且原消息仍在本会话历史中才渲染；原消息已撤回则不渲染（对齐撤回不回显语义）
          const quoted = m.replyTo
            ? messages.find((x) => x.id === m.replyTo && x.recalledAt == null)
            : undefined;
          // 回应 chips（存量 payload.reactions + 解密出的 reaction 事件聚合，记忆化）
          const chips = chipsByMsgId.get(m.id) ?? NO_CHIPS;
          // 图表：正文里的 ```chart 围栏块。解析失败的块被跳过（不显示也不报错——
          // 模型偶尔会写出不合法的 JSON，那是它的问题，不该让整条消息看起来坏了）。
          const messageCharts = extractCharts(m.payload.text).map((c, i) => ({
            key: `${m.id}-chart-${i}`,
            spec: c.spec,
          }));
          return (
            <Fragment key={m.id}>
              {unreadDivider.id === m.id ? (
                <div
                  id="unread-divider"
                  role="separator"
                  aria-label="以下是新消息"
                  className="mb-3 flex items-center gap-2 text-[10px] text-[#b45309]"
                >
                  <span className="h-px flex-1 bg-[#f0d58c]" />
                  <span>以下是新消息</span>
                  <span className="h-px flex-1 bg-[#f0d58c]" />
                </div>
              ) : null}
              {/* A4：间隔 ≥5 分钟或跨天的消息之间插一条时间分隔（首条渲染的消息也带，定位阅读段起点） */}
              {showSeparator ? (
                <div className="mb-3 flex justify-center">
                  <span className="rounded-full bg-[#f3f3f3] px-2.5 py-0.5 text-[10px] text-muted">
                    {formatDayClock(m.createdAt)}
                  </span>
                </div>
              ) : null}
              {/* 消息行：气泡窄长条（max-w 收到 62%），行内 mb-5 留出消息间距。
                  对方头像用 mt-1「略低于气泡顶」而不是顶齐——顶齐时头像圆顶与气泡圆角顶边
                  平齐，看着像顶到了上边缘，很生硬；低一点更像气泡的「肩」。 */}
              <div
                id={`msg-${m.id}`}
                className={`mb-5 flex items-start gap-2.5 ${mine ? "justify-end" : ""}${
                  searchOpen && activeSearchId === m.id
                    ? " rounded-lg bg-[#fff9e6] ring-1 ring-[#f0d58c]"
                    : ""
                }`}
              >
              {/* 多选态：勾选列放在最左（含自己的消息），保证一列对齐、好连点 */}
              {selectMode && (
                <label
                  className="mt-1.5 flex shrink-0 cursor-pointer items-center justify-center"
                  title="选择这条消息"
                >
                  <input
                    type="checkbox"
                    aria-label={`选择这条消息（${senderName || (mine ? "我" : "对方")}）`}
                    checked={selectedIds.includes(m.id)}
                    onChange={() => toggleSelected(m.id)}
                    className="h-3.5 w-3.5 cursor-pointer accent-[#1a1a1a]"
                  />
                </label>
              )}
              {/* 对方消息：头像贴左缘但与气泡留 gap-2.5，mt-1 让它略低于气泡顶（见上方说明） */}
              {!mine && senderAvatarUser && (
                <Avatar user={senderAvatarUser} size={26} className="mt-1 shrink-0" />
              )}
              {/* 气泡：窄长条（62% 上限）+ 一侧大圆角一侧小圆角，
                  圆角朝头像那侧收拢，视觉上像从头像方向伸出去的一条。
                  含图表时放宽到 86%：图表需要横向空间，压在 62% 里会变形。 */}
              <div
                data-message-bubble=""
                className={`group relative max-w-[62%] rounded-xl rounded-bl-md px-3.5 py-2 text-[13px] leading-relaxed shadow-card ${
                  messageCharts.length > 0 ? "max-w-[86%]" : ""
                } ${
                  mine
                    ? "rounded-br-md bg-white"
                    : "rounded-tl-md border border-line bg-[#f7f7f7]"
                }`}
              >
                {senderName ? (
                  <div className="mb-0.5 flex items-baseline gap-2 text-[10px] text-muted">
                    <span>{senderName}</span>
                    <time dateTime={m.createdAt} className="ml-auto shrink-0 tabular-nums">
                      {formatClock(m.createdAt)}
                    </time>
                  </div>
                ) : (
                  <div className="mb-0.5 text-right text-[10px] text-muted">
                    <time dateTime={m.createdAt} className="tabular-nums">
                      {formatClock(m.createdAt)}
                    </time>
                  </div>
                )}
                {recalled ? (
                  <div className="text-muted">消息已撤回</div>
                ) : m.enc === "e2e" && !plainOf[m.id] ? (
                  // E2E Task 4 / 设计 §8：解不开的信封渲染占位（不吞不崩），且不进 LLM 提示词
                  <div className="text-muted">无法解密（密钥缺失）</div>
                ) : (
                  <>
                    {/* 转发来源行（Task 4）：有 forward 时置于正文/附件上方 */}
                    {m.payload.forward ? (
                      <div className="mb-0.5 text-[10px] text-muted">
                        来自 {m.payload.forward.from} · {m.payload.forward.source}
                      </div>
                    ) : null}
                    {quoted ? (
                      <button
                        type="button"
                        className="mb-1 flex w-full cursor-pointer items-baseline gap-1 truncate rounded border-l-2 border-[#e6e6e6] bg-[#fafafa] px-1.5 py-0.5 text-left text-[10px] text-muted"
                        onClick={() =>
                          document
                            .getElementById(`msg-${quoted.id}`)
                            ?.scrollIntoView({ behavior: "smooth", block: "center" })
                        }
                      >
                        <span className="shrink-0 font-medium">
                          {displaySenderName(quoted) ?? "未知"}
                        </span>
                        <span className="min-w-0 truncate">
                          {quoted.payload.text.slice(0, 60)}
                        </span>
                      </button>
                    ) : null}
                    {/* 正文：带 @提及 的消息走原渲染（高亮 @名字），
                        其余走 markdown。分两条路是刻意的——
                        mention 高亮是在纯文本上按名字切片实现的，
                        塞进 markdown 管线需要自定义 remark 插件，成本与收益不成比例；
                        而 mention 只出现在用户消息里（多为短句），
                        代码块/表格这些真正需要 markdown 的内容来自智能体回复。 */}
                    {m.payload.text
                      ? m.payload.mentions && m.payload.mentions.length > 0
                        ? renderTextWithMentions(stripChartFences(m.payload.text), m.payload.mentions)
                        : <MarkdownMessage text={stripChartFences(m.payload.text)} />
                      : null}
                    {/* 图表：正文里的 ```chart 围栏块渲染成卡片（正文已剥离围栏） */}
                    {messageCharts.map((c) => (
                      <ChatChart key={c.key} spec={c.spec} />
                    ))}
                    {/* 附件：audio/* 先于 image/文件卡路由到播放器气泡（Task 5） */}
                    {m.payload.file ? (
                      m.payload.file.mime.startsWith("audio/") ? (
                        <AudioBubble
                          fileId={m.payload.file.id}
                          fileKey={m.payload.file.key}
                          mime={m.payload.file.mime}
                        />
                      ) : (
                        <AttachmentPreview file={m.payload.file} />
                      )
                    ) : null}
                    {readByPeer ? (
                      <div className="mt-0.5 text-right text-[9px] text-muted">已读</div>
                    ) : null}
                    {/* 表情回应 chips（Task 6 → E2E 事件化）：存量 reactions + kind=reaction
                        事件聚合；自己参与的深底可点掉（发 op:remove 密文事件），
                        他人参与的仅展示（点击 no-op）。已撤回消息整块不渲染（外层 recalled 分支）。 */}
                    {chips.length ? (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {chips.map((r) => {
                          const involvesMe = me != null && r.userIds.includes(me.id);
                          return (
                            <button
                              key={r.emoji}
                              type="button"
                              aria-label={`表情回应 ${r.emoji} ${r.userIds.length}`}
                              className={`rounded-full border px-1.5 py-0.5 text-[11px] ${
                                involvesMe
                                  ? "border-ink bg-ink text-white"
                                  : "border-line bg-white text-[#555]"
                              }`}
                              onClick={() => {
                                if (!involvesMe) return; // 只有自己参与的才能点掉（他人 chip 仅展示）
                                // E2E Task 4：回应是密文事件消息（kind=reaction），不再发 react_message
                                void sealAndSend({
                                  kind: "reaction",
                                  reaction: { target: m.id, emoji: r.emoji, op: "remove" },
                                });
                              }}
                            >
                              {r.emoji} {r.userIds.length}
                            </button>
                          );
                        })}
                      </div>
                    ) : null}
                  </>
                )}
                {/* 撤回入口：仅自己的未撤回消息，hover 气泡时显出（测试按 aria-label 断言） */}
                {mine && !recalled && (
                  <button
                    type="button"
                    aria-label="撤回消息"
                    className="absolute -top-2 right-0 hidden rounded border border-line bg-white px-1.5 py-0.5 text-[10px] text-muted shadow-card hover:text-ink group-hover:block group-focus-within:block"
                    onClick={() =>
                      wsHandleRef.current?.send({
                        type: "recall_message",
                        conversationId: convId,
                        messageId: m.id,
                      })
                    }
                  >
                    撤回
                  </button>
                )}
                {/* 回复入口：自己/他人的未撤回消息皆可引用，hover 显出；与撤回钮同排错开位置 */}
                {!recalled && (
                  <button
                    type="button"
                    aria-label="回复此消息"
                    className={`absolute -top-2 ${
                      mine ? "right-10" : "right-0"
                    } hidden rounded border border-line bg-white px-1.5 py-0.5 text-[10px] text-muted shadow-card hover:text-ink group-hover:block group-focus-within:block`}
                    onClick={() => setReplyTarget(m)}
                  >
                    回复
                  </button>
                )}
                {/* 转发入口（Task 4）：所有未撤回消息（含他人）可转发，hover 显出；与撤回/回复钮同排继续错开 */}
                {!recalled && (
                  <button
                    type="button"
                    aria-label="转发消息"
                    className={`absolute -top-2 ${
                      mine ? "right-20" : "right-10"
                    } hidden rounded border border-line bg-white px-1.5 py-0.5 text-[10px] text-muted shadow-card hover:text-ink group-hover:block group-focus-within:block`}
                    onClick={() => setForwardMsg(m)}
                  >
                    转发
                  </button>
                )}
                {/* 表情回应入口（Task 6）：未撤回消息（含他人）皆可回应，hover 显出；与撤回/回复/转发同排继续错开 */}
                {!recalled && (
                  <button
                    type="button"
                    aria-label="添加表情回应"
                    className={`absolute -top-2 ${
                      mine ? "right-[120px]" : "right-[80px]"
                    } hidden rounded border border-line bg-white px-1.5 py-0.5 text-[10px] leading-none text-muted shadow-card hover:text-ink group-hover:block group-focus-within:block`}
                    onClick={() => setReactFor((v) => (v === m.id ? null : m.id))}
                  >
                    <SmileIcon width={12} height={12} />
                  </button>
                )}
                {/* A5 整条复制：未撤回且有文本才出（附件只有元信息，复制结果没意义） */}
                {!recalled && (m.payload.text?.length ?? 0) > 0 && (
                  <button
                    type="button"
                    aria-label="复制消息"
                    className={`absolute -top-2 ${
                      mine ? "right-[152px]" : "right-[112px]"
                    } hidden rounded border border-line bg-white px-1.5 py-0.5 text-[10px] text-muted shadow-card hover:text-ink group-hover:block group-focus-within:block`}
                    onClick={() => void copyMessage(m)}
                  >
                    {copiedMsgId === m.id ? "已复制" : "复制"}
                  </button>
                )}
                {/* 表情回应浮排：点选即 toggle 并关闭；Esc / 切会话关闭（会话级 state） */}
                {!recalled && reactFor === m.id && (
                  <div
                    className={`absolute -top-9 z-20 flex gap-0.5 rounded-lg border border-line bg-white p-1 shadow-card ${
                      mine ? "right-0" : "left-0"
                    }`}
                  >
                    {QUICK_EMOJIS.map((e) => (
                      <button
                        key={e}
                        type="button"
                        className="rounded px-0.5 text-[15px] leading-none hover:bg-[#f3f3f3]"
                        onClick={() => {
                          // E2E 事件化 toggle：已在 chips 里的自己 → op remove，否则 add
                          const involved =
                            me != null &&
                            (chips.find((c) => c.emoji === e)?.userIds.includes(me.id) ?? false);
                          void sealAndSend({
                            kind: "reaction",
                            reaction: { target: m.id, emoji: e, op: involved ? "remove" : "add" },
                          });
                          setReactFor(null);
                        }}
                      >
                        {e}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {/* 自己的消息：气泡在左、头像贴右缘，与对方左右镜像（同样 mt-1 低一点、gap-2.5 隔开） */}
              {mine && (
                <Avatar
                  user={{ displayName: me?.displayName ?? "我", avatar: me?.avatar }}
                  size={26}
                  className="mt-1 shrink-0"
                />
              )}
              </div>
            </Fragment>
          );
        })}
        {/* 流式打字机行（本机/他机）：渲染于消息列表尾部，finish 的 message_new 收口后移除 */}
        {streamEntries.map(([id, s]) => (
          <AgentStreamBubble
            key={id}
            name={nameOf(s.agentId)}
            text={s.text}
            reasoning={s.reasoning}
            tools={s.tools}
            status={s.status}
            errorMessage={s.errorMessage}
            onRetry={streamOwner[id] && s.status === "error" ? () => retryStream(id) : undefined}
          />
        ))}
        <div ref={bottomRef} />
      </div>
      {/* A3：用户上滑期间来了新内容 —— 不拽底，只亮一个回到底部的入口 */}
      {newBelow ? (
        <button
          type="button"
          aria-label="滚动到最新消息"
          className="absolute bottom-32 right-8 z-30 rounded-full border border-line bg-white px-3 py-1 text-[12px] text-[#555] shadow-card hover:bg-[#f7f7f7]"
          onClick={() => scrollToLatest()}
        >
          ↓ 新消息
        </button>
      ) : null}
      <form onSubmit={send} className="relative border-t border-line-soft">
        {/* E2E 常驻横幅（硬验收⑤ / 设计 §2.1）：无 subtle 环境红字提示 + 全发送路径拦截 */}
        {!subtleOk && (
          <p
            role="alert"
            className="mx-5 mt-2 border-l-2 border-[#b42318] bg-[#fef3f2] px-2 py-1.5 text-[12px] text-[#b42318]"
          >
            {NO_E2E_NOTICE}
          </p>
        )}
        {/* 提示行（复用同一位）：录音中占位（停止/取消入口），否则走发送提示 */}
        {recording ? (
          <div className="flex items-center gap-3 px-5 pt-2 text-[12px]">
            <span role="status">录音中…（最长 60 秒）</span>
            <button
              type="button"
              aria-label="停止录音"
              className="rounded border border-line px-2 py-0.5 hover:bg-[#f3f3f3]"
              onClick={stopRecording}
            >
              停止
            </button>
            <button
              type="button"
              aria-label="取消录音"
              className="rounded border border-line px-2 py-0.5 text-muted hover:bg-[#f3f3f3]"
              onClick={cancelRecording}
            >
              取消
            </button>
          </div>
        ) : uploading ? (
          // A8：上传进行中占住提示位，四个入口已禁用
          <p role="status" className="px-5 pt-2 text-[12px] text-muted">
            上传中…（≤6MB）
          </p>
        ) : sendNotice ? (
          // A9：error 红色 role=alert（纯文本发送失败带「重试」）；info 3 秒自动消失
          sendNotice.kind === "error" ? (
            <div
              role="alert"
              className="flex items-center gap-3 px-5 pt-2 text-[12px] text-[#b42318]"
            >
              <span>{sendNotice.text}</span>
              {sendNotice.retry ? (
                <button
                  type="button"
                  className="shrink-0 rounded border border-[#e6b3ae] px-2 py-0.5 hover:bg-[#fef3f2]"
                  onClick={() => sendNotice.retry?.()}
                >
                  重试
                </button>
              ) : null}
            </div>
          ) : (
            <p role="status" className="px-5 pt-2 text-[12px] text-[#b45309]">
              {sendNotice.text}
            </p>
          )
        ) : null}
        {/* 能力降级提示：与发送后的错误提示分开——这是「发之前就知道」的信息 */}
        {toolsNotice && (
          <p role="status" className="px-5 pt-2 text-[12px] text-[#b45309]">
            {toolsNotice}
          </p>
        )}
        {/* 引用预览条：回复目标署名 + 原文片段 + × 取消（会话切换/发送成功自动清） */}
        {replyTarget && (
          <div className="mx-5 mt-2 flex items-center gap-2 rounded-lg border-l-2 border-ink bg-[#f7f7f7] px-3 py-1.5 text-[11px]">
            <span className="text-muted">回复</span>
            <span className="shrink-0 font-medium">
              {displaySenderName(replyTarget) ?? "未知"}
            </span>
            <span className="min-w-0 flex-1 truncate text-muted">
              {replyTarget.payload.text.slice(0, 60) || "（无文本）"}
            </span>
            <button
              type="button"
              aria-label="取消回复"
              className="shrink-0 px-1 text-muted hover:text-ink"
              onClick={() => setReplyTarget(null)}
            >
              ×
            </button>
          </div>
        )}
        {/* @ 选择器：输入栏上方浮层（仅群会话；direct 无智能体可提及） */}
        {isGroup && picker && (
          <MentionPicker
            items={pickerItems}
            onPick={pickMention}
            activeIndex={Math.min(pickerIndex, pickerItems.length - 1)}
          />
        )}
        {/* 「生成中」提示行（输入栏上方）：本机流署名 + 中断入口 */}
        {activeLocal.length > 0 && (
          <div className="flex items-center gap-3 px-5 pt-2 text-[12px] text-muted">
            <span>生成中：{activeLocal.map(([, s]) => nameOf(s.agentId)).join("、")}</span>
            <button
              type="button"
              className="rounded border border-line px-2 py-0.5 hover:bg-[#f3f3f3]"
              onClick={abortRuns}
            >
              中断
            </button>
          </div>
        )}
        {/* 工具行：表情 / 图片 / 文件（左上角）；群会话保留 @ */}
        <div className="flex items-center gap-1 px-5 pt-2">
          <button
            type="button"
            aria-label="表情"
            className={`rounded-lg p-1.5 text-muted hover:bg-[#f3f3f3]${emojiOpen ? " bg-[#f3f3f3]" : ""}`}
            onClick={() => setEmojiOpen((v) => !v)}
          >
            <SmileIcon width={16} height={16} />
          </button>
          <button
            type="button"
            aria-label="图片"
            title="发送图片（≤6MB）"
            disabled={uploading}
            className="rounded-lg p-1.5 text-muted hover:bg-[#f3f3f3] disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() => pickFile("image/*")}
          >
            <ImageIcon width={16} height={16} />
          </button>
          <button
            type="button"
            aria-label="文件"
            title="发送文件（≤6MB）"
            disabled={uploading}
            className="rounded-lg p-1.5 text-muted hover:bg-[#f3f3f3] disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() => pickFile(undefined)}
          >
            <FileIcon width={16} height={16} />
          </button>
          {isGroup && (
            <button
              type="button"
              aria-label="提及智能体"
              className="ml-1 rounded-lg border border-line px-2 text-sm text-muted hover:bg-[#f3f3f3]"
              onClick={() => setPicker({ via: "button", query: "" })}
            >
              @
            </button>
          )}
        </div>
        {/* 拖动把手：上沿可拖，加高/压扁输入区（高度写 localStorage，下次进入沿用） */}
        <div
          role="separator"
          aria-label="调整输入栏高度"
          aria-orientation="horizontal"
          className="group -mt-1 flex h-2 cursor-row-resize items-center justify-center"
          onPointerDown={onComposerDragStart}
          onPointerMove={onComposerDragMove}
          onPointerUp={onComposerDragEnd}
          onPointerCancel={onComposerDragEnd}
        >
          <span className="h-[2px] w-10 rounded-full bg-[#e8e8e8] transition-colors group-hover:bg-[#c9c9c9]" />
        </div>
        <div className="relative flex items-end gap-2 px-5 pb-3" style={{ height: composerHeight }}>
          {emojiOpen && (
            <EmojiPicker
              onPick={(e) => {
                setDraft((d) => {
                  const next = d + e;
                  // 表情回填也要落盘（同语音回填的幂等约定）
                  scheduleDraftSave(convId, next);
                  return next;
                });
                setEmojiOpen(false);
              }}
            />
          )}
          <textarea
            aria-label="消息输入框"
            className="h-full w-full flex-1 resize-none rounded-lg border border-line px-3 py-2 text-sm leading-relaxed outline-none focus:border-[#bbb]"
            placeholder="输入消息…"
            value={draft}
            onChange={(e) => onDraftChange(e.target.value)}
            onKeyDown={onInputKeyDown}
            onPaste={onComposerPaste}
          />
          {/* 语音双选项浮层：转文字（原 STT）/ 录音（MediaRecorder）；无该 API 时录音项禁用 */}
          {voiceMenu && (
            <div className="absolute bottom-full right-0 z-40 mb-1 w-[160px] rounded-xl border border-[#ececec] bg-white p-1 shadow-card">
              <button
                type="button"
                className="w-full rounded-lg px-2 py-1.5 text-left text-[12px] hover:bg-[#f7f7f7]"
                onClick={() => {
                  setVoiceMenu(false);
                  toggleVoice();
                }}
              >
                语音输入（转文字）
              </button>
              <button
                type="button"
                disabled={!hasRecorder}
                className="w-full rounded-lg px-2 py-1.5 text-left text-[12px] hover:bg-[#f7f7f7] disabled:text-[#bbb] disabled:hover:bg-transparent"
                onClick={() => {
                  setVoiceMenu(false);
                  void startRecording();
                }}
              >
                语音消息（录音）
              </button>
              {!hasRecorder && (
                <p className="px-2 pb-1 pt-0.5 text-[10px] text-muted">当前环境不支持录音</p>
              )}
            </div>
          )}
          <button
            type="button"
            aria-label="语音输入"
            title="语音输入"
            disabled={uploading}
            className={`rounded-lg border px-2.5 disabled:cursor-not-allowed disabled:opacity-40 ${
              listening
                ? "border-ink bg-ink text-white"
                : "border-line text-muted hover:bg-[#f3f3f3]"
            }`}
            onClick={() => setVoiceMenu((v) => !v)}
          >
            <MicIcon width={16} height={16} />
          </button>
          <button
            type="submit"
            disabled={!draft.trim() || uploading}
            title="发送"
            className="rounded-lg bg-ink px-4 py-2 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            发送
          </button>
        </div>
        {/* 智能体一对一：明确告诉用户「发出去会自动 @ 这个 agent」，
            否则他看不到任何 @ 选择器，却会收到回复，很难不怀疑消息发错了人。 */}
        {conv?.type === "agent" && (
          <div className="px-5 pb-2 text-[11px] text-muted">
            与 <span className="font-medium text-[#555]">{conv.agent.name}</span>{" "}
            的对话 · 发送后自动 @
          </div>
        )}
        {/* 已选 mention chip（输入栏下方）：× 移除；文本保持原样不注入草稿 */}
        {selectedMentions.length > 0 && (
          <div className="flex flex-wrap gap-2 px-5 pb-3">
            {selectedMentions.map((m) => (
              <span
                key={m.agentId}
                className="inline-flex items-center gap-1 rounded-full border border-line bg-[#f3f3f3] py-0.5 pl-2 pr-1 text-[12px]"
              >
                @{m.name}
                <button
                  type="button"
                  aria-label={`移除 ${m.name}`}
                  className="rounded-full px-1 text-muted hover:text-ink"
                  onClick={() =>
                    setSelectedMentions((prev) => prev.filter((x) => x.agentId !== m.agentId))
                  }
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
      </form>
      {/* 转发浮层（Task 4）：全会话列表（群+直聊），点选经当前 WS 连接发送；点遮罩/Esc 关闭 */}
      {forwardMsg && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/20"
          onClick={() => setForwardMsg(null)}
        >
          <div
            ref={forwardPanelRef}
            role="dialog"
            aria-modal="true"
            aria-label="转发消息"
            className="w-[280px] rounded-xl border border-[#ececec] bg-white p-3 shadow-card"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-2 text-[12px] font-bold">转发到</div>
            <div className="max-h-[240px] overflow-y-auto">
              {/* 归档会话不作为转发目标：它已被用户收起，不该再出现在选择列表里 */}
              {activeConversationsOf(conversations).map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] hover:bg-[#f7f7f7]"
                  onClick={() => doForward(c)}
                >
                  <Avatar
                    user={{
                      displayName: convLabel(c).name,
                      avatar: convLabel(c).avatar,
                    }}
                    size={22}
                  />
                  <span className="truncate">{convLabel(c).name}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      {/* 语音通话全屏面板（ringing + active 状态）
          onAccept/onReject 仅在 callee ringing 分支内渲染为可见可点的接听/拒绝按钮
          （面板 fixed inset-0 z-50 覆盖全屏，横幅内的按钮会被遮挡） */}
      <VoiceCallPanel
        state={voiceCall.state}
        peerNames={voicePeerNames}
        onHangup={voiceCall.hangup}
        onToggleMute={voiceCall.toggleMute}
        onAccept={
          voiceCall.state.incoming
            ? () => void voiceCall.accept(voiceCall.state.incoming!.callId)
            : undefined
        }
        onReject={
          voiceCall.state.incoming
            ? () => voiceCall.reject(voiceCall.state.incoming!.callId, "decline")
            : undefined
        }
      />
      {/* HITL 工具确认弹窗（设计 §4.3）：
          智能体要调有副作用的工具时，先问用户同不同意。
          弹窗由 store 驱动（pending 单槽 + 队列），这里只负责渲染与回传裁决。 */}
      {pendingHitl && pendingHitl.kind === "tool-call" && (
        <ToolApprovalModal
          requestId={pendingHitl.requestId}
          calls={pendingHitl.calls}
          auto={pendingHitl.auto}
          agentName={pendingHitl.agentName}
          conversationLabel={pendingConvLabel}
          onOpenConversation={
            pendingElsewhere
              ? () => useUiStore.getState().openConversation(pendingHitl.conversationId)
              : undefined
          }
          onDecide={(verdicts) => {
            // 留痕、清通知、decide 都在同一个收口里（与超时路径共用）。
            resolveToolApproval(pendingHitl, verdicts);
          }}
        />
      )}
    </div>
  );
}
