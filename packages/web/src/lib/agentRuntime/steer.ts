/**
 * 运行中插话队列（d.199）。
 *
 * 为什么需要：这一轮在跑（模型正在调工具、等命令返回）时，用户往往还想补一句
 * 「先跑测试别改文件」「那个目录别碰」。以前这里直接拒绝发送（提示「先点停止，或等
 * 这一轮结束再发」）——可点停止会丢掉这一轮已经做好的部分，等结束又太晚。
 *
 * 语义刻意简单，只做三件事：
 * 1. `push`：消息照常落库（用户看得见自己的话），同时进队列；
 * 2. `take`：编排层在每个工具轮开始前取走全部正文，追加进本轮上下文末尾——
 *    模型在**下一步**就能看到，而不是等这一轮彻底结束；
 * 3. `shift`：如果这一轮在取走前就收尾了（走到答案那轮、被用户停掉、报错），
 *    队列里剩下的由触发端在收口后另起一轮处理——绝不静默丢弃。
 *
 * 队列只在内存里：它属于「这一轮还没被模型看到的输入」，不是长期状态；
 * 消息本身已经落库，刷新后仍然在会话里。
 */

export interface SteerMentions {
  agentId: string;
  name: string;
}

export interface SteerItem {
  /** 用户原话（已 trim，可能含 @ 文本）。 */
  text: string;
  /** 这句 @ 了谁：收尾后另起一轮时要用同一条路径（绑定校验、流归属）。 */
  mentions: SteerMentions[];
  /**
   * 这条插话从哪来（d.358）：
   * - `"user"`（默认）＝用户自己发的，正文已经作为用户消息落库；
   * - `"job"`＝后台子代理交回的结论，**没有**落库副本。
   *
   * 收口时要区别对待：用户那条丢了还能从历史里捞回来，job 那条丢了就是真丢了。
   */
  source?: "user" | "job";
}

export interface SteerQueue {
  /** 入队，返回当前队内条数（用于提示「还有 N 条」）。 */
  push: (item: SteerItem) => number;
  /** 取走全部正文（顺序保持），队列清空。给编排层注入用。 */
  take: () => string[];
  /** 取走一条（先进先出），用于收口后另起一轮。 */
  shift: () => SteerItem | undefined;
  /**
   * 取走全部条目（保留来源与 @ 信息），队列清空。
   *
   * 收口时用它而不是 `clear()`：用户插话丢了还能从历史里捞回来，
   * 后台子代理的结论没有落库副本，得挑出来留着（d.358）。
   */
  takeItems: () => SteerItem[];
  /** 队内条数。 */
  size: () => number;
  /** 队内快照（只读，测试与提示用）。 */
  pending: () => SteerItem[];
  /** 清空（切会话、卸载时用）。 */
  clear: () => void;
}

export function createSteerQueue(): SteerQueue {
  let items: SteerItem[] = [];
  return {
    push: (item) => {
      const text = item.text.trim();
      // 空白不排队：调用方已 trim 过，这里再兜一次，避免把空行喂给模型。
      if (!text) return items.length;
      items = [
        ...items,
        {
          text,
          mentions: [...item.mentions],
          ...(item.source ? { source: item.source } : {}),
        },
      ];
      return items.length;
    },
    take: () => {
      const texts = items.map((item) => item.text);
      items = [];
      return texts;
    },
    shift: () => {
      if (items.length === 0) return undefined;
      const [first, ...rest] = items;
      items = rest;
      return first;
    },
    takeItems: () => {
      const taken = items.map((item) => ({
        text: item.text,
        mentions: [...item.mentions],
        ...(item.source ? { source: item.source } : {}),
      }));
      items = [];
      return taken;
    },
    size: () => items.length,
    pending: () =>
      items.map((item) => ({
        text: item.text,
        mentions: [...item.mentions],
        ...(item.source ? { source: item.source } : {}),
      })),
    clear: () => {
      items = [];
    },
  };
}
