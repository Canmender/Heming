import type { LlmProfile } from "../store/llm.js";
import { resolveCapability } from "./modelCaps.js";

/**
 * 能力降级的当场提示。
 *
 * 为什么要在发送前说而不是等模型回复：模型不支持函数调用时，编排层会**静默丢掉**
 * tools 参数——用户看到的答案像是「智能体偷懒没查资料」，实际是根本没得查。
 * 提示的作用是把这次降级显式化，用户才知道要换连接或换模型。
 */
export type CapabilityKind = "tools" | "vision";

/**
 * 判定「这个连接能不能用某项能力」——**唯一**的判据源（判定与丢弃同源）。
 *
 * d.93 起只剩 OpenAI 兼容协议（协议翻译在 magpie 网关侧），判据交回能力表：
 * 用户在模型能力矩阵里的显式改判仍然优先（`resolveCapability` 读覆盖层）。
 */
export function supportsKind(profile: LlmProfile | undefined, kind: CapabilityKind): boolean {
  if (!profile) return false;
  const caps = resolveCapability(profile);
  return kind === "tools" ? caps.supportsTools : caps.supportsVision;
}

/** 名字列表 → 一句人话（无降级时返回 null，避免界面挂一条空提示）。 */
export function capabilityNotice(
  kind: CapabilityKind,
  targets: { name: string; profile: LlmProfile | undefined }[],
  enabled = true,
): string | null {
  if (!enabled) return null;
  // 未绑定连接的智能体不参与提示：发送前会被「未绑定模型」拦住，这里再念一遍只是噪音。
  const missing = targets
    .filter((t) => t.profile !== undefined && !supportsKind(t.profile, kind))
    .map((t) => t.name);
  if (missing.length === 0) return null;
  const who = missing.join("、");
  return kind === "tools"
    ? `绑定的模型不支持工具调用（${who}），本次不会使用 MCP、图表、知识库与自我修改工具；需要工具请改绑支持的模型连接。`
    : `绑定的模型不支持图片输入（${who}），图片只作为附件保存，模型读不到内容。`;
}
