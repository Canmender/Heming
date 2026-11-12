/**
 * 工具桥合并：把外部 MCP 工具与自我修改工具拼成一个 `ToolBridge`。
 *
 * 为什么不让 agentStream 直接吃两个桥：它的工具循环、轨迹记录、流式渲染都只认
 * 一个 `ToolBridge`。在这里合并一次，下游零改动。
 *
 * 分流方式：self.* 的工具名带 `self_` 前缀，执行时据此判断归属。
 * 前缀同时是给人看的——工具轨迹里一眼能认出「这次调用改的是自己」而非外部系统。
 */

import type { ToolBridge } from "../agentStream.js";

/** 自我修改工具的命名前缀（分流与展示共用）。 */
export const SELF_TOOL_PREFIX = "self_";

/**
 * 合并多个工具桥。全空返回 null（编排层据此走无工具的原路径，零行为变化）。
 *
 * execute 直接按「谁声明了这个名字」来路由——self.* 只会在 self 桥里声明，
 * MCP 工具名形如 `服务__工具` 不会撞前缀，所以先 self 后 MCP 的顺序天然正确；
 * 都不声明时给模型一句清楚的话，而不是抛异常。
 *
 * meta 用**同一套查找**路由：命中哪个桥就问哪个桥要风险标注，
 * 否则闸门拿到的风险与实际执行者对不上（问错了桥 = 问错人）。
 */
export function mergeToolBridges(...bridges: (ToolBridge | null)[]): ToolBridge | null {
  const usable = bridges.filter(
    (b): b is ToolBridge => b != null && Array.isArray(b.tools) && b.tools.length > 0,
  );
  if (usable.length === 0) return null;
  if (usable.length === 1) return usable[0];

  const tools = usable.flatMap((b) => b.tools);
  return {
    tools,
    execute: (call, opts) => {
      const owner = usable.find((b) => listsName(b, call.name));
      // opts 必须透传：里面是本轮的 AbortSignal，漏传等于「用户点了中断、
      // 合并后的桥还在跑工具」——多提供者合并是缺省状态（MCP + 内置常常同时在）。
      if (owner) return owner.execute(call, opts);
      return Promise.resolve({ text: `未知工具 ${call.name}`, ok: false });
    },
    meta: (name) => {
      const owner = usable.find((b) => listsName(b, name));
      return owner?.meta?.(name);
    },
  };
}

/** 该桥的 tools 列表里是否含这个名字（能力注册表复用同一判据）。 */
export function listsName(bridge: ToolBridge, name: string): boolean {
  return bridge.tools.some((t) => {
    const fn = (t as { function?: { name?: string } }).function;
    return fn?.name === name;
  });
}
