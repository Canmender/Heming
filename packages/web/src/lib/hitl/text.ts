/**
 * 回灌给模型的文案（拒绝 / 放行）。
 *
 * 这是**整个 HITL 层里最要紧的一段**。Cline 已经踩过的坑：
 * 模型不知道自己的调用被拒了，会当成「工具失败但也许已经部分生效」，
 * 于是基于**从未落盘**的内容继续构造编辑参数，越改越偏。
 *
 * 所以拒绝文案必须**显式声明「文件与系统状态未被修改」**，
 * 并把正确行为直接告诉模型（不要重试、不要假设已完成）。
 */

import type { Decision, HitlCall } from "./types.js";

/**
 * 「未修改」硬声明。
 *
 * 单独抽成常量：它要被 `text.test.ts` 逐条断言，也被 `deniedText` 复用，
 * 两处不允许各写一份（改了一处忘了另一处，防幻觉就失效了）。
 */
export const GIT_UNCHANGED = "【该操作未执行，文件与系统状态未被修改】";

/**
 * 拒绝文案必须包含的四个短语（`text.test.ts` 逐条断言）。
 *
 * 抽成数组而不是散落在模板字符串里，是为了让「必含」这件事**可断言**：
 * 少一条就是模型可能继续幻觉。
 */
export const MUST_CONTAIN: readonly string[] = [
  "用户拒绝了本次工具调用",
  GIT_UNCHANGED,
  "不存在部分写入或中间状态",
  "不要基于该操作",
];

/**
 * 拒绝后回给 tool 消息的内容。
 *
 * @param call 被拒的调用（用于展示中文动作名与参数摘要）
 * @param reason 拒绝理由（可选，如「用户中断」）
 */
export function deniedText(call: HitlCall, reason?: string): string {
  const lines = [
    `用户拒绝了本次工具调用：${call.displayName}`,
    GIT_UNCHANGED,
    "不存在部分写入或中间状态，该调用没有产生任何副作用。",
    "不要基于该操作“已完成”的假设继续构造后续参数或重试同一调用。",
  ];
  if (call.summary) lines.push(`本次调用参数：${call.summary}`);
  if (reason) lines.push(`拒绝原因：${reason}`);
  return lines.join("\n");
}

/**
 * 放行后回给 tool 消息的内容。
 *
 * 仅在「本会话内允许」时追加授权提示——让模型知道用户已经授权，
 * 免得对同一类操作反复改参数试探。
 */
export function allowedText(call: HitlCall, decision: Decision): string {
  const lines = [`用户已允许本次工具调用：${call.displayName}`];
  if (decision === "allow-session") {
    lines.push(
      "用户已授权本次调用，可以继续；但不要把授权扩大到本次参数之外的操作。",
    );
  }
  return lines.join("\n");
}
