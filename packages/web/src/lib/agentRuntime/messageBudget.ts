/**
 * 超长消息的提醒（d.233）：一条消息塞进一整份日志，比「发不出去」更难查。
 *
 * 为什么需要这一层：
 * 输入框对长度没有任何上限，粘贴一份 300 KB 的日志也能直接发出去。后果分三种，
 * 而且都不报错：
 * 1. **上下文被一条消息吃掉**：估算下来十几万 tokens，历史压缩会把之前的对话
 *    整段折成摘要，模型「突然忘了刚才的要求」——用户不知道是自己那条消息挤的；
 * 2. **服务端直接拒绝**：供应商那侧有请求体上限，回来的 400 与「网络错误」长得像，
 *    用户只会觉得「这软件又坏了」；
 * 3. **钱**：一次十几万 tokens 的输入按时长计费，用户往往事后才发现。
 *
 * 所以这里不做静默截断（截断会让模型看到半份日志却不知道缺了后半段，比不发更糟），
 * 而是**先拦一道、给可执行建议，允许第二次点击强制发**。判据用 token 估算而不是字节数：
 * 同样 20000 个字符，中文约占 2 万 tokens、英文代码只有约 5 千，风险差三倍。
 */
import { estimateTokens } from "../agentContext/tokens.js";

/**
 * 超过这个估算 token 数就提醒一次。
 *
 * 取 12000：普通提问（哪怕带几百行代码）通常在几百到几千 tokens；到这个量级已经
 * 相当于把历史里好几轮对话挤出去，而对 64K 窗口的模型更是直接过半。
 */
export const MESSAGE_WARN_TOKENS = 12_000;

/** 一次出站文本的体检结果。 */
export interface OutgoingTextInspection {
  /** 字符数（按码点算，emoji 不会被当两个）。 */
  chars: number;
  /** 估算 token 数（与上下文预算同一套口径）。 */
  tokens: number;
  /** 是否大到值得先提醒一次。 */
  tooLarge: boolean;
}

export function inspectOutgoingText(text: string): OutgoingTextInspection {
  const chars = [...text].length;
  const tokens = estimateTokens(text);
  return { chars, tokens, tooLarge: tokens >= MESSAGE_WARN_TOKENS };
}

/**
 * 提醒文案。
 *
 * 三条要求：说清**多大**（字 + tokens，用户对 token 无感那就两个都给）、
 * 说清**会发生什么**（挤上下文 / 可能被拒绝）、给出**更好的做法**（存成文件后引用），
 * 最后明确「再点一次就照发」——拦一道但不能把人拦死。
 */
export function largeMessageNotice(inspection: OutgoingTextInspection): string {
  const chars = inspection.chars.toLocaleString("en-US");
  const tokens = inspection.tokens.toLocaleString("en-US");
  return `这条消息约 ${chars} 字（估算 ${tokens} tokens），比一般消息大得多：发出去会挤掉前面的对话，也可能被服务端直接拒绝。更好的做法是把它存成文件放进工作区，再用「引用工作区文件」让它按需读；确实要整段发，就再点一次发送。`;
}
