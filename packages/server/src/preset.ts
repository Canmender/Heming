import type { Store } from "./store.js";
import { SYSTEM_AGENTS } from "./store.js";

export const PRESET_GROUP_NAME = "和鸣交流群";
export const SYSTEM_AGENT_ID = "system-assistant";
/** 从单一真源派生，避免与 store 的 SYSTEM_AGENTS 字面量漂移。 */
export const SYSTEM_AGENT_NAME = SYSTEM_AGENTS[SYSTEM_AGENT_ID].name;

/**
 * M2 预设播种：系统 agent（和小鸣）+ 预设混合群（和鸣交流群）。
 * 幂等——重复调用返回同一 groupId；无任何用户时返回 null（不建空群）。
 *
 * M2 语义：@和小鸣 不会自动回复（回复由 M3 接 LLM），此处仅建立结构：
 * agent 登记、群成员、conversation_agents 关联。ws.send_message 群广播行为不变。
 */
export function seedPreset(store: Store): { agentId: string; groupId: string } | null {
  const ids = store.listUserIds();
  if (ids.length === 0) return null;
  const groupId = store.ensurePresetGroup(PRESET_GROUP_NAME, ids, SYSTEM_AGENT_ID);
  return { agentId: SYSTEM_AGENT_ID, groupId };
}
