/**
 * 一次把多个工具设成同一个模型（d.331）。
 *
 * 内核没有通配符：`<agent> <model>` 一次只写一个工具自己的配置文件，所以页面上只能逐个发。
 * 这里只负责两件小事：挑出「能被写的」工具，以及把逐个的结果说成一句话——
 * 成功几个、哪个没成、内核的原话是什么。
 */

export interface BulkModelOutcome {
  /** 写成功了的工具名。 */
  done: string[];
  /** 没写成的工具名与内核的原话（可能为空串）。 */
  failed: { name: string; why: string }[];
}

export interface BulkModelText {
  text: string;
  failed: boolean;
}

/**
 * 能被改写的工具：`id` 为空的是「只读」（没有对应的模型命令），排掉它们，
 * 否则一次「统一应用」会把它算进「没成」的名单里，看着像失败。
 */
export function bulkModelTargets<T extends { id: string | null }>(agents: readonly T[]): T[] {
  return agents.filter((agent) => Boolean(agent.id));
}

export function bulkModelText(model: string, outcome: BulkModelOutcome): BulkModelText {
  const done = outcome.done.length;
  const failed = outcome.failed;
  if (failed.length === 0) {
    return { text: `已把 ${done} 个工具都设成 ${model}，下次启动它们时生效。`, failed: false };
  }
  const names = failed.map((item) => item.name).join("、");
  const why = failed[0]?.why ? `：${failed[0].why}` : "";
  if (done === 0) {
    return { text: `没能写入 ${names}${why}`, failed: true };
  }
  return { text: `${done} 个设好了，${failed.length} 个没成（${names}）${why}`, failed: true };
}