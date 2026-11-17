/**
 * 成员的待办负载（d.264）。
 *
 * 为什么需要：d.256 已经把「每个成员有几项未完成」放进了团队简报（给组长的智能体每轮看），
 * 但那只覆盖「整体进度」这一问；真正在派活的那一刻，模型手里只有 `team_get` 的快照，
 * 里面成员只有名字、用户名和角色——**看不到这个人手上已经压了多少活**。
 * 于是常见的结果是「逮着同一个人一直派」，另一个人闲着；等被派的人回一句「我手上还有四件」，已经晚了。
 *
 * 口径：
 * - 只数未完成的（`status !== "done"`）——已完成的任务不构成压力；
 * - 逾期单独说：`dueAt` 能解析且早于现在才算，解析不出来的坏时间不冤枉任何人；
 * - 纯函数、不读时钟（`now` 由调用方传入），方便单测与「同一轮里口径一致」。
 */

export interface MemberLoad {
  /** 名下未完成的任务数。 */
  open: number;
  /** 其中已经过了截止时间的条数。 */
  overdue: number;
}

const EMPTY_LOAD: MemberLoad = { open: 0, overdue: 0 };

/** 只依赖任务的最小形状：id/负责人/状态/截止时间。 */
export interface LoadTask {
  assigneeId: string | null;
  status: string;
  dueAt?: string | null;
}

/** 按负责人汇总未完成与逾期条数（没有任务的人不出现在结果里）。 */
export function memberLoads(
  tasks: readonly LoadTask[],
  now: number = Date.now(),
): Map<string, MemberLoad> {
  const out = new Map<string, MemberLoad>();
  for (const task of tasks) {
    if (task.assigneeId === null || task.status === "done") continue;
    const current = out.get(task.assigneeId) ?? { open: 0, overdue: 0 };
    current.open += 1;
    if (typeof task.dueAt === "string" && task.dueAt !== "") {
      const at = Date.parse(task.dueAt);
      if (Number.isFinite(at) && at < now) current.overdue += 1;
    }
    out.set(task.assigneeId, current);
  }
  return out;
}

/** 取某人的负载（没有记录 = 0）。 */
export function loadOf(loads: Map<string, MemberLoad>, userId: string | null): MemberLoad {
  if (userId === null) return EMPTY_LOAD;
  return loads.get(userId) ?? EMPTY_LOAD;
}

/** 一句话描述负载：`3 项未完成（1 项已逾期）` / `没有未完成的任务`。 */
export function describeLoad(load: MemberLoad): string {
  if (load.open <= 0) return "没有未完成的任务";
  const base = `${load.open} 项未完成`;
  return load.overdue > 0 ? `${base}（${load.overdue} 项已逾期）` : base;
}

/**
 * 派活之后给模型的一句附注：这个人手上现在有多少活。
 *
 * 为什么要说：派活是个不可逆的分配动作，模型往往只看「谁合适」不看「谁还有空」；
 * 把事实摆在结果里（而不是塞进另一轮提示词），它下一次派活时才知道要分散。
 * 超过 {@link BUSY_OPEN} 项时额外提醒一次——这时候不是「顺带一提」，而是该考虑换人。
 */
export const BUSY_OPEN = 5;

export function describeAssigneeLoad(name: string, load: MemberLoad): string {
  const text = describeLoad(load);
  if (load.open > BUSY_OPEN) {
    return `${name}手上${text}，已经比较满了：可以先把手上最急的那件收尾，或者考虑换一个人做。`;
  }
  return `${name}手上${text}。`;
}
