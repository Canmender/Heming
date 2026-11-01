import type { ToolBridge } from "../agentStream.js";
import { listsName, mergeToolBridges } from "../selfEdit/merge.js";
import type { CapabilityContext, CapabilityProvider } from "./types.js";

/**
 * 能力注册表：把「工具从哪来」收成一张可枚举的清单。
 *
 * 合并仍走 `mergeToolBridges`——执行按工具名路由到**声明它的那个提供者**，
 * 下游编排、轨迹、HITL 看到的还是一个 `ToolBridge`，零改动。
 */
export class CapabilityRegistry {
  private readonly items: CapabilityProvider[] = [];

  /** 注册一个提供者；id 重复直接抛错，不静默覆盖。 */
  register(provider: CapabilityProvider): this {
    if (this.items.some((p) => p.id === provider.id)) {
      throw new Error(`能力提供者 id 重复：${provider.id}`);
    }
    this.items.push(provider);
    return this;
  }

  /** 只读快照（注册顺序即优先级）。 */
  providers(): readonly CapabilityProvider[] {
    return [...this.items];
  }

  /**
   * 构建本轮工具桥。
   *
   * 注册顺序即优先级：工具名重复时前者胜出，与历史
   * `mergeToolBridges(mcp, chart, tone, wiki, self)` 的顺序一致。
   * `meta` 在提供者自述风险之外统一补 `origin` / `providerId`；
   * 风险缺省口径不变（未声明 → 编排层按 `write` 问人）。
   */
  build(ctx: CapabilityContext): ToolBridge | null {
    const entries: { provider: CapabilityProvider; bridge: ToolBridge }[] = [];
    for (const provider of this.items) {
      const bridge = provider.build(ctx);
      if (!bridge || !Array.isArray(bridge.tools) || bridge.tools.length === 0) continue;
      entries.push({ provider, bridge });
    }
    if (entries.length === 0) return null;

    const merged = mergeToolBridges(...entries.map((e) => e.bridge));
    if (!merged) return null;

    return {
      tools: merged.tools,
      execute: merged.execute,
      meta: (name) => {
        const owner = entries.find((e) => listsName(e.bridge, name));
        if (!owner) return undefined;
        return {
          ...owner.bridge.meta?.(name),
          origin: owner.provider.origin,
          providerId: owner.provider.id,
        };
      },
    };
  }
}
