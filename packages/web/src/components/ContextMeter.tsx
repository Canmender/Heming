import { contextMeter } from "../lib/agentContext/contextMeter.js";

/**
 * 上下文用量（d.187）：
 *
 * 一行小字，「现在这轮大概会用掉多少上下文」。它回答的是长任务里最容易失控的一个问题——
 * 「它为什么突然忘了前面」。数字是**估算**（与压缩链同一个 `estimateRowsTokens`），
 * 不冒充计费值；安静档（对话还很短）整个不渲染，避免每轮都打扰。
 *
 * 为什么不做进度条：一行字已经能表达「快到上限了」，进度条会额外抢走输入区的注意力，
 * 而用户真正需要的动作只有「要不要 `/compact`」。
 */
export function ContextMeter({ used, budget }: { used: number; budget: number }) {
  const meter = contextMeter(used, budget);
  if (meter.level === "quiet") return null;
  const tone =
    meter.level === "full" ? "text-danger" : meter.level === "warn" ? "text-warn" : "text-muted";
  return (
    <p
      role="status"
      aria-label="上下文用量"
      title="按当前模型窗口估算；超过预算时下一轮会自动压缩早期对话"
      className={`px-4 pb-1 text-right text-ui-sm ${tone}`}
    >
      {meter.text}
    </p>
  );
}
