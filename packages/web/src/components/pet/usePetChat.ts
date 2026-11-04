import { useCallback, useRef, useState } from "react";
import { humanizeProviderError } from "../../lib/llmFailure.js";
import { streamChat, type ChatMessage } from "../../lib/llmClient.js";
import { useLlmStore, type LlmProfile } from "../../store/llm.js";

/**
 * 桌宠的对话（d.46）。
 *
 * 为什么在渲染层直连供应商而不是走主窗口：
 * - 红线是「Key 只进供应商请求头」，Key 由 `heming.llmConfigs`（d.36 起走 safeStorage）持有。
 *   要让主窗口中转，就得把 Key 或整段对话搬过 IPC——那是新增的暴露面，而不是省钱。
 * - 桌宠窗口与主窗口同源，localStorage 天然共享，直接复用同一个 `streamChat` 即可。
 *
 * ★ 不写会话、不进消息列表、不落 msgCache：这是一次性对话。让「随手问一句」
 *   污染会话列表，比没有桌宠更烦人。
 */

/** 桌宠人设：短、口语、别端着。写死在这里而不是让用户配——它是"宠物的说话方式"，不是智能体设定。 */
const PET_SYSTEM_PROMPT =
  "你是「和鸣」的桌面宠物。用简短自然的口语回应，通常一到三句话，不要用列表和标题。" +
  "你随时在用户桌面上，说话可以带一点陪伴感，但不要卖萌过头，也不要反复追问。";

/** 保留的历史轮数（一来一回算一轮）：桌宠对话是短促的，不需要长上下文。 */
const MAX_HISTORY_TURNS = 6;

export interface PetChatState {
  /** 当前正在流式输出的回复（结束后并入历史并清空） */
  reply: string;
  streaming: boolean;
  error: string | null;
  /** 错误的原始文本（provider_error…）：只用于排障 title/日志，不直接上屏 */
  errorDetail: string | null;
  /** 是否已配置可用的模型连接 */
  hasConnection: boolean;
  /** 当前使用的连接名（用于气泡角标） */
  connectionLabel: string | null;
  send: (text: string) => Promise<void>;
  stop: () => void;
  clearError: () => void;
}

/** 选一个可用连接：优先智能体绑定，其次第一个。都没有则视为未配置。 */
export function resolvePetProfile(
  profiles: LlmProfile[],
  bindings: Record<string, string>,
  agentId: string | null,
): LlmProfile | null {
  if (!Array.isArray(profiles) || profiles.length === 0) return null;
  const boundId = agentId ? bindings[agentId] : undefined;
  if (boundId) {
    const bound = profiles.find((p) => p.id === boundId);
    if (bound) return bound;
  }
  return profiles[0] ?? null;
}

/** 拼出发给供应商的消息序列：人设 + 智能体提示词 + 最近若干轮 + 本轮。 */
export function buildPetMessages(
  history: ChatMessage[],
  userText: string,
  agentPrompt?: string,
): ChatMessage[] {
  const system = [PET_SYSTEM_PROMPT, agentPrompt?.trim()].filter(Boolean).join("\n\n");
  const trimmed = history.slice(-MAX_HISTORY_TURNS * 2);
  return [
    { role: "system", content: system },
    ...trimmed,
    { role: "user", content: userText },
  ];
}

export function usePetChat(agentId: string | null): PetChatState {
  const profiles = useLlmStore((s) => s.profiles);
  const bindings = useLlmStore((s) => s.bindings);
  const prompts = useLlmStore((s) => s.prompts);

  const [reply, setReply] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);

  const historyRef = useRef<ChatMessage[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  /** 本轮累积文本：onDelta 是高频的，用 ref 累积、结束后一次并入历史。 */
  const bufferRef = useRef("");

  const profile = resolvePetProfile(profiles, bindings, agentId);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const send = useCallback(
    async (text: string) => {
      const content = text.trim();
      if (!content || streaming) return;
      if (!profile) {
        setError("还没有可用的模型连接");
        setErrorDetail(null);
        return;
      }

      setError(null);
      setErrorDetail(null);
      setReply("");
      bufferRef.current = "";
      setStreaming(true);

      const controller = new AbortController();
      abortRef.current = controller;

      const messages = buildPetMessages(
        historyRef.current,
        content,
        agentId ? prompts[agentId] : undefined,
      );

      try {
        await streamChat(profile, messages, {
          signal: controller.signal,
          maxTokens: 512,
          onDelta: (delta) => {
            bufferRef.current += delta;
            setReply(bufferRef.current);
          },
        });
        // 成功后并入历史（失败/中止不入历史：下一轮不该基于一段残缺对话继续）
        historyRef.current = [
          ...historyRef.current,
          { role: "user" as const, content },
          { role: "assistant" as const, content: bufferRef.current },
        ].slice(-MAX_HISTORY_TURNS * 2);
      } catch (err) {
        // 用户主动停止：不算错误，也不弹提示（streamChat 以 DOMException("AbortError") 中止）
        const aborted = err instanceof Error && err.name === "AbortError";
        if (!aborted) {
          const msg = err instanceof Error ? err.message : String(err);

          // 供应商原文（provider_error: HTTP 429 {...}）对用户没意义：翻成人话再用；
          // 原文留在 errorDetail（气泡 title + 控制台），排障时仍能看到状态码与响应体。
          console.warn("[pet] 模型请求失败：", msg);
          setError(humanizeProviderError(msg));
          setErrorDetail(msg);
        }
      } finally {
        abortRef.current = null;
        setStreaming(false);
      }
    },
    [agentId, profile, prompts, streaming],
  );

  const clearError = useCallback(() => {
    setError(null);
    setErrorDetail(null);
  }, []);

  return {
    reply,
    streaming,
    error,
    errorDetail,
    hasConnection: profile !== null,
    connectionLabel: profile?.label ?? profile?.model ?? null,
    send,
    stop,
    clearError,
  };
}
