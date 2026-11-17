import { contextMeter } from "../lib/agentContext/contextMeter.js";

/**
 * 上下文用量（d.187）：
 *
 * 一行小字，「现在这轮大概会用掉多少上下文」。它回答的是长任务里最容易失控的一个问题——
 * 「它为什么突然忘了前面」。数字是**估算**（与压缩链同一个 `estimateRowsTokens`），
 * 不冒充计费值；安静档（对话还很短）整个不渲染，避免每轮都打扰。
 *
 * d.215 起，估算会按**本机实测**（供应商上报的提示 token）校准一个倍率：
 * 校准过就把话说明白（「已按实测校准」），否则用户会把一个被修正过的数字当成朴素估算，
 * 反而不信它——两种情况的差别必须写在这里，而不是藏进代码。
 *
 * 为什么不做进度条：一行字已经能表达「快到上限了」，进度条会额外抢走输入区的注意力，
 * 而用户真正需要的动作只有「要不要 `/compact`」。
 */
export function ContextMeter({
  used,
  budget,
  calibrated = false,
}: {
  used: number;
  budget: number;
  calibrated?: boolean;
}) {
  const meter = contextMeter(used, budget);
  if (meter.level === "quiet") return null;
  const tone =
    meter.level === "full" ? "text-danger" : meter.level === "warn" ? "text-warn" : "text-muted";
  const title = calibrated
    ? "按当前模型窗口估算，并已用供应商上报的真实提示 token 校准（偏差过大时以实测为准）"
    : "按当前模型窗口估算；超过预算时下一轮会自动压缩早期对话";
  return (
    <p
      role="status"
      aria-label="上下文用量"
      title={title}
      className={`px-4 pb-1 text-right text-ui-sm ${tone}`}
    >
      {meter.text}
    </p>
  );
}
