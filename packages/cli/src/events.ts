/**
 * `--output-format stream-json` 的事件契约：stdout 每行一个 JSON 对象。
 *
 * 为什么单独成模块：这类输出是**给程序读的**（CI、别的 agent、上游编排器）。形状一旦漂移，
 * 调用方的解析会悄悄坏掉，而 stdout 里又没有类型。所以这里只做一件事——定义事件与
 * 一行化序列化；什么时候发哪个事件由调用处显式决定，不在字符串里拼。
 *
 * 与 `exec --json` 的分工：那个是「跑完给一份结果」（一个对象），这个是「边跑边说」
 * （一行一条）。CI 想知道「工具在干什么、有没有被拒」就用这个；只要最终答案就用那个。
 *
 * 约定：
 * - 所有事件都是一行（`JSON.stringify` 会把换行转义），消费方可以按行读；
 * - 进度行仍然走 stderr，**不混进 stdout**；
 * - `final` 一定会在正常收尾时发（即使失败），让消费方不必靠退出码猜。
 */

import type { ExecJson } from "./run.js";

export type CliEvent =
  /** 开始跑：先发这个，消费方据此知道后面的事件属于哪次运行。 */
  | { type: "start"; command: "run" | "exec"; cwd: string; maxRounds: number; allowDanger: boolean }
  /** 进入第 N 轮（`tool` 表示这一轮正在调用的工具名）。 */
  | { type: "round"; round: number; tool?: string }
  /** 最终回答的增量文本（与 `run` 的 stdout 同一份内容）。 */
  | { type: "delta"; text: string }
  /** 工具开始执行。`args` 是**摘要**（路径/命令/模式），不是完整参数（写文件时是整份正文）。 */
  | { type: "tool_start"; name: string; args: string }
  /** 工具结束：`ok` 为假或被拒都算没成功；`denied` 单独标出「策略拒绝，而非工具坏了」。 */
  | { type: "tool_end"; name: string; ok: boolean; denied: boolean }
  /** 上游瞬时错误，正在退避重试。 */
  | { type: "retry"; attempt: number; max: number; delayMs: number; reason: string }
  /** 运行收尾（正常与失败都发），`result` 与 `exec --json` 的对象同构。 */
  | { type: "final"; result: ExecJson }
  /** 运行前的用法/配置错误（此时还没有运行，只有一句话）。 */
  | { type: "error"; message: string };

/** 单条事件序列化为一行。换行与引号由 `JSON.stringify` 负责转义。 */
export function jsonLine(event: CliEvent): string {
  return `${JSON.stringify(event)}\n`;
}

export interface EventSink {
  emit: (event: CliEvent) => void;
}

/** 把事件写到 `write`（生产是 stdout，测试里是数组收集）。 */
export function createEventSink(write: (chunk: string) => void): EventSink {
  return {
    emit: (event) => write(jsonLine(event)),
  };
}
