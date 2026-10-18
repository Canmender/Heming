import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { Conversation, Message } from "@heming/shared";
import { useChatStore, type E2eOpenHandler, type E2eOpenOutcome } from "../store/chat.js";
import { useUiStore } from "../store/ui.js";
import { useAuthStore } from "../store/auth.js";
import { useLlmStore } from "../store/llm.js";
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
import { streamChat } from "../lib/llmClient.js";
import { runAgentMentions, type TriggerDeps } from "../lib/agentStream.js";
import { buildAgentContext } from "../lib/agentRuntime/context.js";
import {
  loadContextSettings,
  prepareHistory as prepareAgentHistory,
  summaryCache,
} from "../lib/agentContext/index.js";
import { memoryStore } from "../lib/memory/index.js";
import { skillPool } from "../lib/skills/index.js";
import { connectWs, type WsHandle } from "../lib/ws.js";
import { ChevronIcon, MenuIcon, SmileIcon, ImageIcon, FileIcon, MicIcon, PhoneIcon } from "./icons.js";
import { Avatar } from "./Avatar.js";
import { MentionPicker, type MentionItem } from "./MentionPicker.js";
import { AgentStreamBubble } from "./AgentStreamBubble.js";
import { ChatInfoCard } from "./ChatInfoCard.js";
import { EmojiPicker } from "./EmojiPicker.js";
import { VoiceCallPanel } from "./VoiceCallPanel.js";
import { useVoiceCall } from "../lib/voiceCall.js";

/** 无 subtle 环境的常驻提示（横幅 + 发送拦截共用文案，设计 §2.1：拒绝发送不降级明文）。 */
export const NO_E2E_NOTICE = "当前环境不支持端到端加密，请使用桌面端或 HTTPS";

/** chips 空表的稳定引用（selector 兜底，防每次渲染新建 {} 触发多余重渲染）。 */
const NO_PLAIN: Record<string, PlainEnvelope> = {};

/** 单条消息的回应 chip（emoji + 参与 userIds）。 */
export type ReactionChip = { emoji: string; userIds: string[] };

/** aggregateChips 结果里「无 chips」的稳定空表。 */
const NO_CHIPS: ReactionChip[] = [];

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
const QUICK_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🙏", "🎉", "🔥", "✅", "👀", "🤔", "👏"];

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
    <img src={url} alt={file.name} className="mt-1 max-h-40 rounded-md object-cover" />
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

export function ChatPage() {
  const convId = useUiStore((s) => s.activeConversationId)!;
  const leave = useUiStore((s) => s.leaveConversation);
  const conversations = useChatStore((s) => s.conversations);
  const messages = useChatStore((s) => s.messages[convId] ?? []);
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
  const [sendNotice, setSendNotice] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
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
  /** 触发句柄（convId → 集合）：「中断」只 abort 当前会话的流；卸载时全部中止（关页不空烧 token）。 */
  const runsRef = useRef<Record<string, Set<{ abortAll(): void }>>>({});
  /** 本机流元数据（streamId → 触发上下文）：onLocalDelta 回填 agentId、重试取原触发文本。 */
  const streamMeta = useRef<Record<string, { agentId: string; name: string; text: string }>>({});
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
      setSendNotice(`发送失败：${(err as Error).message}`);
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
      : `${conv.name}（${conv.memberCount} 人）`
    : "会话";
  const isGroup = conv?.type === "group";

  // —— 语音通话（Task 4/5）：useVoiceCall 状态机；信令复用当前 WS 通道 ——
  // 仅 Electron 桌面端支持通话：以 preload 暴露的桥接 API 是否存在为判定依据。
  const isElectron =
    typeof window !== "undefined" &&
    (window as unknown as { __heming_voice_call?: unknown }).__heming_voice_call !== undefined;
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

  /** 消息署名（气泡/引用卡/引用预览共用）：自己「我」；direct 对方名；群内成员映射名（缺失回退 undefined 由调用方处理）。 */
  const displaySenderName = (m: Message) =>
    m.senderId === me?.id
      ? "我"
      : conv?.type === "direct"
        ? peer?.displayName
        : memberInfoById?.[m.senderId]?.name;
  /**
   * 他人气泡左侧头像数据（Task 7）：direct 恒为 peer（无 avatar 走首字回退，保持既有行为）；
   * group 仅当该 sender 在成员快照中带 avatar 时给出（无则不出头像元素，群内无头像不多占位）。
   */
  const bubbleAvatar = (m: Message): { displayName: string; avatar?: string } | undefined => {
    if (m.senderId === me?.id) return undefined;
    if (conv?.type === "direct") return peer;
    const info = memberInfoById?.[m.senderId];
    return info?.avatar ? { displayName: info.name, avatar: info.avatar } : undefined;
  };
  /** 选择器条目：剔除已选（防重复 chip）+ 按 token query 过滤（空串=全量）。 */
  const pickerItems = mentionCandidates.filter(
    (a) =>
      !selectedMentions.some((m) => m.agentId === a.id) &&
      a.name.toLowerCase().includes((picker?.query ?? "").toLowerCase()),
  );

  /** agentId → LLM 连接（绑定表解析）：无绑定/连接已删都归为 undefined（发送前拦截与触发共用）。 */
  const resolveProfile = (agentId: string) => {
    const llm = useLlmStore.getState();
    const pid = llm.bindings[agentId];
    return pid ? llm.getProfile(pid) : undefined;
  };

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
  const visibleMessages = messages.filter(
    (m) => !(m.enc === "e2e" && plainOf[m.id]?.kind === "reaction"),
  );
  // 回应 chips 聚合（fix I4）：useMemo 按 messages/plainOf 引用单次聚合——
  // 原实现每渲染对每条消息全量扫 reaction 事件（O(n²)）
  const chipsByMsgId = useMemo(() => aggregateChips(messages, plainOf), [messages, plainOf]);

  /**
   * 启动一次 mention 触发（发送成功 / 错误行重试共用）：
   * deps 全部从 stores + WS 句柄组装；fetchHistory 映射 role 并剔掉刚发出的这条
   * （服务端很可能已入库，否则当前 user 轮会在提示词里出现两遍）。
   */
  const startRun = (mentions: { agentId: string; name: string }[], text: string) => {
    // 无 subtle：触发端无法封 chunk/finish——拦截不启动（硬验收⑤：不降级明文回复）
    if (!hasSubtle()) {
      setSendNotice(NO_E2E_NOTICE);
      return;
    }
    const deps: TriggerDeps = {
      getProfile: resolveProfile,
      getPrompt: (agentId) => useLlmStore.getState().prompts[agentId] ?? "",
      fetchHistory: async () => {
        // spec §3：提示词只带近 30 条历史；已撤回跳过；E2E 信封经 loadMessages 合并
        // （缓存优先 → handler 解密 → 占位）——**解不开的不进提示词**（硬验收⑤），
        // reaction/chaindist 控制消息同样不进。
        const msgs = (await useChatStore.getState().loadMessages(convId)).slice(-30);
        const plainOf = useChatStore.getState().plainById[convId] ?? {};
        const rows = msgs
          .filter((m) => {
            if (m.recalledAt != null) return false;
            if (m.enc === "e2e") {
              const p = plainOf[m.id];
              if (!p) return false; // 占位（无法解密）→ 不外发模型供应商
              if (p.kind !== "text" && p.kind !== "file" && p.kind !== "forward") return false;
            }
            return true;
          })
          .map((m) => ({
            role: m.senderType === "user" ? ("user" as const) : ("assistant" as const),
            content: m.payload.text,
          }));
        const last = rows[rows.length - 1];
        if (last && last.role === "user" && last.content === text) rows.pop();
        return rows;
      },
      send: (e) => wsHandleRef.current?.send(e),
      streamChat,
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
        streamMeta.current[streamId] = { ...mention, text };
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
          return buildAgentContext({
            agentId,
            conversationId: convId,
            userText: text,
            basePrompt,
            memory: memoryStore,
            skills: skillPool,
          }).systemPrompt;
        } catch {
          return basePrompt;
        }
      },
      // 轮次收尾写记忆（设计 §3）：成功轮次走 recordTurn（Working + 显式抽取 + 6 轮沉淀）；
      // 中断/失败只记 Working 并标 partial，不沉淀长期记忆。全程静默，绝不影响发送与流式渲染。
      // appendTurn 本身不判总开关，故这里先看 settings.enabled（关闭=不记录也不召回）。
      onTurnComplete: (agentId, userText, assistantText, status) => {
        try {
          if (!memoryStore.getSettings().enabled) return;
          if (status === "ok") memoryStore.recordTurn(agentId, convId, userText, assistantText);
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
        setSendNotice("智能体生成启动失败，请稍后重试");
      },
    );
  };

  /** 中断当前会话全部进行中流：abort → 各流 catch 走 finish-partial + agent_error(aborted)。 */
  const abortRuns = () => {
    for (const h of runsRef.current[convId] ?? []) h.abortAll();
  };

  /** 错误行重试：清掉旧项，按原触发文本重新跑该单个 mention（新 streamId 重新登记）。 */
  const retryStream = (streamId: string) => {
    const meta = streamMeta.current[streamId];
    if (!meta) return;
    removeStream(streamId);
    delete streamMeta.current[streamId];
    startRun([{ agentId: meta.agentId, name: meta.name }], meta.text);
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
  // 解不开的留占位（渲染无法解密、不进提示词）；alive 挡卸载/切会话后的晚到写入
  useEffect(() => {
    let alive = true;
    void useChatStore.getState().loadMessages(convId, () => alive);
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
        } else if (e.type === "read_update" && e.conversationId === convId) {
          // 事件只带 userId/at：整表重拉（读数很小），direct 气泡「已读」随动；他会话忽略
          void loadReads(convId).catch(() => {
            /* 同挂载期降级：拉取失败保留旧读态 */
          });
        } else if (e.type === "error") {
          console.warn(`[${e.code}] ${e.message}`);
        }
      },
      onOpen: () => {
        setConnected(true);
        // 断线重连成功：补拉断档消息（合并去重语义，幂等；信封同走解密合并）
        void useChatStore.getState().loadMessages(convId, () => alive);
        // Task 7：重连成功补齐「断线期间的已读」——仍有未读则补发 mark_read
        // （与挂载逻辑同款读法；handle 取本 effect 闭包里的，非 ref，防重连期间句柄已换）
        const unread =
          useChatStore.getState().conversations.find((c) => c.id === convId)?.unreadCount ?? 0;
        if (unread > 0) handle?.send({ type: "mark_read", conversationId: convId });
      },
      onClose: () => setConnected(false),
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

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

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
      recRef.current?.stop();
      voiceRecCancelRef.current?.();
    },
    [],
  );

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
  const onDraftChange = (value: string) => {
    setDraft(value);
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

  /** Esc 关转发浮层（文档级，与信息卡同口径）。 */
  useEffect(() => {
    if (!forwardMsg) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setForwardMsg(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [forwardMsg]);

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

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape" && picker) {
      e.preventDefault();
      setPicker(null);
      setTokenLock(false); // Esc 关闭同步解锁：后续键入可重开（否则旧锁卡住 token 路径）
    }
  };

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    // 硬验收⑤：无 subtle 先拦（保留草稿与已选 mention），绝不降级明文发送
    if (!hasSubtle()) {
      setSendNotice(NO_E2E_NOTICE);
      return;
    }
    // 发送前拦截：@ 到的智能体没绑 LLM 连接 → 不发消息，本地提示去设置页配置（草稿/chip 保留）
    const unbound = selectedMentions.find((m) => !resolveProfile(m.agentId));
    if (unbound) {
      setSendNotice(`${unbound.name} 未绑定 LLM 连接，请先在设置页配置`);
      return;
    }
    const handle = wsHandleRef.current;
    if (!handle) {
      // 保留草稿与已选 mention，给出可见提示（不静默丢弃）
      setSendNotice("连接未就绪，消息未发送");
      return;
    }
    const mentions = selectedMentions;
    // 正文/mentions/replyTo 全进密文（§3.3），事件 payload 只留 {text:""} 占位
    const plain: PlainEnvelope = {
      kind: "text",
      text,
      ...(mentions.length ? { mentions } : {}),
      ...(replyTarget ? { replyTo: replyTarget.id } : {}),
    };
    if (!(await sealAndSend(plain))) return; // 拦截/封失败：草稿与浮层状态原样保留
    setDraft("");
    setSelectedMentions([]);
    setPicker(null);
    setTokenLock(false);
    setSendNotice(null);
    setReplyTarget(null);
    // 发送成功即触发各 mention 的本机流式生成（失败/中断由 WS 三事件回声收口）
    if (mentions.length) startRun(mentions, text);
  };

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
        source: src ? (src.type === "direct" ? src.peer.displayName : src.name) : "未知会话",
      },
    };
    if (!(await sealAndSend(plain, target.id))) return;
    setForwardMsg(null);
    setSendNotice(
      target.id === convId
        ? null
        : `已转发到 ${target.type === "direct" ? target.peer.displayName : target.name}`,
    );
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

  /** 附件发送：先传共享库拿 meta，再封 file 信封经 WS 发（text 空串，气泡只渲染附件段）。
   *  无 subtle 在上传前拦截——不白跑一次上传（硬验收⑤：附件/语音全路径不降级）。 */
  const sendFile = async (f: File) => {
    if (!hasSubtle()) {
      setSendNotice(NO_E2E_NOTICE);
      return;
    }
    const handle = wsHandleRef.current;
    if (!handle) {
      setSendNotice("连接未就绪，消息未发送");
      return;
    }
    if (f.size > MAX_UPLOAD) {
      setSendNotice("文件需小于 6MB");
      return;
    }
    try {
      const meta = await uploadEncryptedFile(f);
      // await 后闭包已旧：切了会话或 socket 已换/已关则丢弃，防发错会话/向已关句柄静默发送
      const live = wsHandleRef.current;
      if (live !== handle || useUiStore.getState().activeConversationId !== convId) {
        setSendNotice("已切换会话，文件未发送");
        return;
      }
      const ok = await sealAndSend({
        kind: "file",
        text: "",
        // 消息侧保留原名/原 mime/原大小（气泡按它路由与展示），fileKey 随消息进密文；
        // meta 是服务端密文形态（.enc 名 + octet-stream），仅取 id
        file: { id: meta.id, name: f.name, mime: f.type || "application/octet-stream", size: f.size, key: meta.key },
      });
      if (ok) setSendNotice(null);
    } catch (err) {
      setSendNotice(`上传失败：${(err as Error).message}`);
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
      setDraft((d) => (d ? `${d}${t}` : t));
    };
    rec.onend = () => {
      if (recRef.current !== rec) return;
      setListening(false);
    };
    rec.onerror = () => {
      if (recRef.current !== rec) return;
      setListening(false);
      setSendNotice("语音识别不可用");
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
          setSendNotice("录音太短，未发送");
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
      if (!cancelled) setSendNotice("无法访问麦克风"); // 取消/切会话后的授权失败保持静默
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

  return (
    <div className="flex h-full flex-col">
      <header className="relative flex items-center gap-2.5 border-b border-line-soft px-5 py-3">
        <button
          type="button"
          aria-label="返回"
          className="rounded p-1 text-muted hover:bg-[#f3f3f3]"
          onClick={leave}
        >
          <ChevronIcon width={15} height={15} className="rotate-180" />
        </button>
        {conv && (
          <Avatar
            user={conv.type === "direct" ? conv.peer : { displayName: conv.name }}
            size={28}
          />
        )}
        <span className="text-[14px] font-bold">{headerTitle}</span>
        <span className="text-[12px] text-muted">{connected ? "已连接" : "连接中…"}</span>
        {conv?.type === "direct" && voiceCall.state.status === "idle" && (
          <button
            type="button"
            aria-label="发起通话"
            className="ml-auto rounded-lg p-1.5 hover:bg-[#f3f3f3]"
            onClick={() => {
              if (conv?.type === "direct") {
                void voiceCall.call(conv.id, [conv.peer.id]);
              }
            }}
          >
            <PhoneIcon width={17} height={17} />
          </button>
        )}
        <button
          type="button"
          aria-label="会话信息"
          className={`rounded-lg p-1.5 hover:bg-[#f3f3f3]${infoOpen ? " bg-[#f3f3f3]" : ""}${conv?.type === "direct" && voiceCall.state.status === "idle" ? "" : " ml-auto"}`}
          onClick={() => setInfoOpen((v) => !v)}
        >
          <MenuIcon width={17} height={17} />
        </button>
        {infoOpen && conv && <ChatInfoCard conv={conv} onClose={() => setInfoOpen(false)} />}
      </header>
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
      <div className="flex-1 overflow-y-auto px-5 py-4">
        {visibleMessages.map((m) => {
          const mine = m.senderId === me?.id;
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
          return (
            <div
              key={m.id}
              id={`msg-${m.id}`}
              className={`mb-3 flex ${mine ? "justify-end" : "items-start gap-2"}`}
            >
              {/* 对方消息：左侧头像（direct 恒有、群内他人有 avatar 时；无 avatar 首字回退）；自己的消息不显示头像 */}
              {senderAvatarUser && (
                <Avatar user={senderAvatarUser} size={22} className="mt-0.5" />
              )}
              <div
                className={`group relative max-w-[70%] rounded-lg border border-line px-3 py-2 text-[13px] shadow-card ${
                  mine ? "bg-white" : "bg-[#f7f7f7]"
                }`}
              >
                {senderName ? (
                  <div className="mb-0.5 text-[10px] text-muted">{senderName}</div>
                ) : null}
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
                    {m.payload.text
                      ? renderTextWithMentions(m.payload.text, m.payload.mentions)
                      : null}
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
                    className="absolute -top-2 right-0 hidden rounded border border-line bg-white px-1.5 py-0.5 text-[10px] text-muted shadow-card hover:text-ink group-hover:block"
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
                    } hidden rounded border border-line bg-white px-1.5 py-0.5 text-[10px] text-muted shadow-card hover:text-ink group-hover:block`}
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
                    } hidden rounded border border-line bg-white px-1.5 py-0.5 text-[10px] text-muted shadow-card hover:text-ink group-hover:block`}
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
                    } hidden rounded border border-line bg-white px-1.5 py-0.5 text-[10px] leading-none text-muted shadow-card hover:text-ink group-hover:block`}
                    onClick={() => setReactFor((v) => (v === m.id ? null : m.id))}
                  >
                    <SmileIcon width={12} height={12} />
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
            </div>
          );
        })}
        {/* 流式打字机行（本机/他机）：渲染于消息列表尾部，finish 的 message_new 收口后移除 */}
        {streamEntries.map(([id, s]) => (
          <AgentStreamBubble
            key={id}
            name={nameOf(s.agentId)}
            text={s.text}
            status={s.status}
            errorMessage={s.errorMessage}
            onRetry={streamOwner[id] && s.status === "error" ? () => retryStream(id) : undefined}
          />
        ))}
        <div ref={bottomRef} />
      </div>
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
        ) : (
          sendNotice && (
            <p role="status" className="px-5 pt-2 text-[12px] text-[#b45309]">
              {sendNotice}
            </p>
          )
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
        {isGroup && picker && <MentionPicker items={pickerItems} onPick={pickMention} />}
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
            className="rounded-lg p-1.5 text-muted hover:bg-[#f3f3f3]"
            onClick={() => pickFile("image/*")}
          >
            <ImageIcon width={16} height={16} />
          </button>
          <button
            type="button"
            aria-label="文件"
            className="rounded-lg p-1.5 text-muted hover:bg-[#f3f3f3]"
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
        <div className="relative flex gap-2 px-5 py-3">
          {emojiOpen && (
            <EmojiPicker
              onPick={(e) => {
                setDraft((d) => d + e);
                setEmojiOpen(false);
              }}
            />
          )}
          <input
            className="flex-1 rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-[#bbb]"
            placeholder="输入消息…"
            value={draft}
            onChange={(e) => onDraftChange(e.target.value)}
            onKeyDown={onInputKeyDown}
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
            className={`rounded-lg border px-2.5 ${
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
            className="rounded-lg bg-ink px-4 py-2 text-sm font-bold text-white"
          >
            发送
          </button>
        </div>
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
            className="w-[280px] rounded-xl border border-[#ececec] bg-white p-3 shadow-card"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-2 text-[12px] font-bold">转发到</div>
            <div className="max-h-[240px] overflow-y-auto">
              {conversations.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] hover:bg-[#f7f7f7]"
                  onClick={() => doForward(c)}
                >
                  <Avatar
                    user={c.type === "direct" ? c.peer : { displayName: c.name }}
                    size={22}
                  />
                  <span className="truncate">
                    {c.type === "direct" ? c.peer.displayName : c.name}
                  </span>
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
    </div>
  );
}
