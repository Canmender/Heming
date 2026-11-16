/**
 * 子代理写盘授权（d.202）。
 *
 * 为什么单独一份状态、而且只能由用户打开：
 * `agent_task` 的子代理跑在工具调用闭包里，没有 HITL 通道——它调工具时没有人能
 * 弹窗问「这个写要不要允许」。所以 d.162 起子代理被锁成只读：宁可它查完回来让
 * 主对话去写，也不给它一条无人看守的写路径。
 *
 * 但长任务里确实有「三个文件各改一处」这种活：串行交给主对话要吃掉三轮对话，
 * 而它们互不相关、正适合并行。所以 d.202 开一个**用户显式授权**的缺口：
 * - 默认关闭，模型不能自己开（只读这行判断只认本模块的存储值）；
 * - 打开后子代理也只多拿 `file_write` / `file_edit`，仍走主桥的工作区根校验；
 * - 每次落盘都记进「本轮可撤回」，用户能一键整体回滚；
 * - 授权按会话记，换会话不会顺延。
 *
 * 存储用 localStorage（与计划模式同款），读失败静默降级为「关」——安全默认。
 */

/** 存储键：按会话记「是否允许子代理写盘」。 */
export const SUBAGENT_WRITE_KEY = "heming.subagentWrite.v1";

type WriteMap = Record<string, true>;

function readStorage(): WriteMap {
  const out: WriteMap = {};
  try {
    const raw = localStorage.getItem(SUBAGENT_WRITE_KEY);
    if (!raw) return out;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;
    for (const [id, value] of Object.entries(parsed)) {
      if (typeof id === "string" && id && value === true) out[id] = true;
    }
    return out;
  } catch {
    return out;
  }
}

function writeStorage(map: WriteMap): void {
  try {
    const keys = Object.keys(map);
    if (keys.length === 0) localStorage.removeItem(SUBAGENT_WRITE_KEY);
    else localStorage.setItem(SUBAGENT_WRITE_KEY, JSON.stringify(map));
  } catch {
    // 存储写不进去就算了：授权是即时生效的开关，重启后回到「关」也不会造成危险。
  }
}

/** 这个会话是否允许子代理写盘；缺省 false（只读）。 */
export function isSubagentWriteEnabled(conversationId: string): boolean {
  if (!conversationId) return false;
  return readStorage()[conversationId] === true;
}

/** 打开/关闭某个会话的子代理写盘授权；返回设置后的值。 */
export function setSubagentWriteEnabled(conversationId: string, enabled: boolean): boolean {
  if (!conversationId) return false;
  const map = readStorage();
  if (enabled) map[conversationId] = true;
  else delete map[conversationId];
  writeStorage(map);
  return enabled && map[conversationId] === true;
}

/** 切换并返回新值（给 `/subagent write` 用）。 */
export function toggleSubagentWrite(conversationId: string): boolean {
  return setSubagentWriteEnabled(conversationId, !isSubagentWriteEnabled(conversationId));
}

/** 清空全部授权（测试与「重置」用）。 */
export function resetSubagentWriteStore(): void {
  try {
    localStorage.removeItem(SUBAGENT_WRITE_KEY);
  } catch {
    // 同 writeStorage：清不掉不影响正确性。
  }
}

/** 当前被授权的会话 id 列表（`/status` 之外暂时没人用，留着方便排查）。 */
export function listSubagentWriteConversations(): string[] {
  return Object.keys(readStorage()).sort();
}
