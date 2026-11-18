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

/**
 * 「把这一份设置同样写给别的工具」的目标：有 id 的、且不是来源自己。
 *
 * 与 `bulkModelTargets` 分开是因为这里要以某一行为基准——同一份 id 出现两次
 * （`ls` 偶尔会把同一个工具列两行）时不该自己写自己。
 */
export function siblingTargets<T extends { id: string | null }>(
  source: T,
  agents: readonly T[],
): T[] {
  return agents.filter((agent) => Boolean(agent.id) && agent.id !== source.id);
}

/** 一句话说清一次批量写的成败；`successText` 用不上时（有失败）由这里另写。 */
export function bulkWriteText(successText: string, outcome: BulkModelOutcome): BulkModelText {
  const done = outcome.done.length;
  const failed = outcome.failed;
  if (failed.length === 0) return { text: successText, failed: false };
  const names = failed.map((item) => item.name).join("、");
  const why = failed[0]?.why ? `：${failed[0].why}` : "";
  if (done === 0) return { text: `没能写入 ${names}${why}`, failed: true };
  return { text: `${done} 个设好了，${failed.length} 个没成（${names}）${why}`, failed: true };
}

export function bulkModelText(model: string, outcome: BulkModelOutcome): BulkModelText {
  return bulkWriteText(`已把 ${outcome.done.length} 个工具都设成 ${model}，下次启动它们时生效。`, outcome);
}