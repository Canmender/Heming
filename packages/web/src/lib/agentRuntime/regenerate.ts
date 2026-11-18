/**
 * 单条消息重答（d.294）：把「这一轮」从对话里摘掉，再用同一句提问重跑一次。
 *
 * 为什么需要它：模型偶尔答偏、答一半被停、或者只是在错的前提上给了个像样的结论。
 * 以前的出路只有两条——自己往上翻着删、或者开一个新会话把上下文重讲一遍。
 * ChatGPT / Codex 这类工具的答案是第三条：**就在原地重答**。
 *
 * 这里只做「决定删哪些、重发什么」这件纯逻辑，不碰网络也不碰 store：
 * - 删的范围是**成对的**：那条提问 + 它之后的全部消息（含这条回答）。
 *   只删回答会留下一句「我问过但没人答」的提问，再把这句重新发一遍就重复了。
 * - 删的是**消息 id**而不是序号（与 `/rewind` 的对话那一半同一个理由：客户端可能只加载了
 *   最近一段，序号会删错别人）。
 * - 越靠后的消息删得越多，所以 `later` 交给界面去提示「这会一起删掉 N 条」——
 *   删除是不可撤销的（服务端没有软删除），不能默默做。
 *
 * 明确不支持的两种情况，宁可拒绝也不假装能重答：
 * - 提问带着附件：附件是单回合输入，重发只有文字会把文件丢掉，用户会以为「文件还在」；
 * - 这一轮之前没有用户提问（开场白 / 系统占位）。
 */

/** 判断只需要这几个字段，不绑死 Message 的完整形状（测试里手搓对象更省事）。 */
export interface RegenerateMessage {
  id: string;
  senderType: "user" | "agent";
  payload: { text?: string; file?: { id: string; name: string } };
}

export interface RegeneratePlan {
  /** 要重新发出去的那句提问（已 trim）。 */
  prompt: string;
  /** 要删掉的消息 id，从那条提问到会话末尾，按原顺序。 */
  ids: string[];
  /** 其中有几条排在这条回答之后（界面提示「会一起删掉 N 条」）。 */
  later: number;
}

export type RegenerateResult =
  | { ok: true; plan: RegeneratePlan }
  | { ok: false; reason: string };

/**
 * 给一条回答算出重答方案。`messages` 必须是这个会话当前的完整本地镜像（按时间顺序）。
 */
export function planRegenerate(
  messages: readonly RegenerateMessage[],
  messageId: string,
): RegenerateResult {
  const index = messages.findIndex((m) => m.id === messageId);
  if (index < 0) {
    return { ok: false, reason: "这条消息已经不在本地了（可能刚被删掉），刷新一下再试。" };
  }
  const target = messages[index]!;
  if (target.senderType === "user") {
    return { ok: false, reason: "重答只对它的回答用：选它下面那条。" };
  }
  // 往回找最近的一条提问。中间夹着别的消息（工具轨迹、另一条回答）也照退——
  // 这一轮真正开始的地方就是最近那句用户提问。
  let userIndex = -1;
  for (let i = index - 1; i >= 0; i -= 1) {
    if (messages[i]!.senderType === "user") {
      userIndex = i;
      break;
    }
  }
  if (userIndex < 0) {
    return { ok: false, reason: "这条前面没有你的提问（开场白或系统消息），没法重答。" };
  }
  const asked = messages[userIndex]!;
  if (asked.payload.file) {
    return {
      ok: false,
      reason: "那一轮带着附件：重答只重发文字，会把附件丢掉。把附件重新发一次更稳妥。",
    };
  }
  const prompt = (asked.payload.text ?? "").trim();
  if (!prompt) {
    return { ok: false, reason: "那一轮的提问是空的，没有可以重发的内容。" };
  }
  const ids = messages.slice(userIndex).map((m) => m.id);
  const later = Math.max(0, messages.length - 1 - index);
  return { ok: true, plan: { prompt, ids, later } };
}

/** 确认条上的文案：把「会删掉多少」说具体，别让用户点完才发现后面几轮没了。 */
export function describeRegenerateConfirm(plan: RegeneratePlan): string {
  if (plan.later === 0) return "把这个回答撤掉，用同一句提问重新答一次？";
  return `这条回答后面还有 ${plan.later} 条消息，会和它一起删掉，再用同一句提问重新答一次。继续？`;
}
