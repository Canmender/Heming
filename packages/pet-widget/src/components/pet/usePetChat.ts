import { useCallback, useRef, useState } from "react";
import {
  humanizeGatewayError,
  streamGatewayChat,
  type ChatMessage,
} from "../../lib/gatewayChat.js";
import type { ChatConfig } from "../../lib/widgetBridge.js";

/**
 * 桌宠的对话（d.46 起；d.97 拆插件后改走宿主给的 `chatConfig()`）。
 *
 * ★ 为什么不是复用宿主的 `lib/llmClient.ts`：
 * - 那个模块牵着宿主的 store / 脱敏 / 路由 / 工具链，import 过来会把宿主模块拖进
 *   插件包；而插件跑在 `widget://heming.pet` 独立 origin，读不到宿主 localStorage，
 *   拖进来也初始化不了。
 * - 插件只需要「一句话短回复」：走本机 magpie 网关的 OpenAI 兼容 `/chat/completions`。
 *
 * 红线不变：拿到的是**网关地址 + 网关 Key**（`chatConfig()`），不是用户供应商 Key；
 * 且**不写会话、不进消息列表、不落明文缓存**——这是一次性对话。
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
  /** 当前使用的智能体名（用于气泡角标）；没有绑定就是 null */
  connectionLabel: string | null;
  send: (text: string) => Promise<void>;
  stop: () => void;
  clearError: () => void;
}

/** 当前绑定智能体的人设提示词（`chatConfig().binding.agentId` → `agents[]`）。 */
export function resolveAgentPrompt(config: ChatConfig | null): string | undefined {
  if (!config) return undefined;
  const agentId = config.binding?.agentId;
  if (!agentId) return undefined;
  const agent = config.agents?.find((item) => item.id === agentId);
  const prompt = agent?.prompt?.trim();
  return prompt || undefined;
}

/** 气泡角标用：绑定智能体的名字。 */
export function resolveConnectionLabel(config: ChatConfig | null): string | null {
  if (!config) return null;
  const agentId = config.binding?.agentId;
  if (!agentId) return null;
  const agent = config.agents?.find((item) => item.id === agentId);
  return agent?.name?.trim() || null;
}

/** 拼出发给网关的消息序列：人设 + 智能体提示词 + 最近若干轮 + 本轮。 */
export function buildPetMessages(
  history: ChatMessage[],
  userText: string,
  agentPrompt?: string,
): ChatMessage[] {
  const system = [PET_SYSTEM_PROMPT, agentPrompt?.trim()].filter(Boolean).join("\n\n");
  const trimmed = history.slice(-MAX_HISTORY_TURNS * 2);
  return [{ role: "system", content: system }, ...trimmed, { role: "user", content: userText }];
}

export function usePetChat(config: ChatConfig | null): PetChatState {
  const [reply, setReply] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);

  const historyRef = useRef<ChatMessage[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  /** 本轮累积文本：onDelta 是高频的，用 ref 累积、结束后一次并入历史。 */
  const bufferRef = useRef("");

  const hasConnection = Boolean(config && config.gateway && config.gateway.baseUrl);
  const connectionLabel = resolveConnectionLabel(config);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const send = useCallback(
    async (text: string) => {
      const content = text.trim();
      if (!content || streaming) return;
      if (!config || !config.gateway?.baseUrl) {
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
        resolveAgentPrompt(config),
      );

      try {
        await streamGatewayChat(config, messages, {
          signal: controller.signal,
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
        // 用户主动停止：不算错误，也不弹提示
        const aborted = err instanceof Error && err.name === "AbortError";
        if (!aborted) {
          const msg = err instanceof Error ? err.message : String(err);
          // 供应商/网关原文对用户没意义：翻成人话再用；原文留在 errorDetail 排障
          console.warn("[pet] 网关请求失败：", msg);
          setError(humanizeGatewayError(msg));
          setErrorDetail(msg);
        }
      } finally {
        abortRef.current = null;
        setStreaming(false);
      }
    },
    [config, streaming],
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
    hasConnection,
    connectionLabel,
    send,
    stop,
    clearError,
  };
}
