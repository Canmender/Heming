/**
 * 「记住本次选择」的落地：文件工具按**目录前缀**记，其它工具沿用老口径。
 *
 * 为什么文件工具不能按「工具 + 参数摘要」记：
 * `file_patch` 天然是多文件写，参数摘要要么是 `*`（等于把整个工具放行，
 * 与「没有全放行档」的红线冲突），要么是一段补丁文本（根本没法匹配）。
 * 规格 §7 定的形状是**路径前缀规则**（`D:/Obsidian/学院事务/`）：
 * 用户授权「这个目录以后不用问」，而不是「这个工具以后随便写」。
 *
 * 闸门（`lib/hitl/gate.ts`）只调 `rememberDecision` 这一个入口，
 * 于是「哪些工具能记成什么样」只有一处实现，测试也只需要打这一处。
 */

import { ruleResource } from "../hitl/classify.js";
import type { HitlPolicyStore } from "../hitl/policy.js";
import type { HitlCall, RuleEffect } from "../hitl/types.js";
import type { FileRoot } from "./paths.js";
import { fileRootsStore } from "./roots.js";
import { isFileEditTool, prefixRulesOfCall } from "./ruleTargets.js";

/** 记忆依赖（测试可注入固定根清单）。 */
export interface RememberDeps {
  roots?: FileRoot[];
}

/** 记忆结果：`remembered=false` 表示这次调用不适合记忆（例如目标在可写根之外）。 */
export interface RememberOutcome {
  remembered: boolean;
  /** 实际落库的目录前缀（文件工具才有，用于界面回显）。 */
  prefixes?: string[];
}

/**
 * 记住一次裁决。
 *
 * - `file_patch` / `file_read`：按目标文件所在目录归纳前缀，一条一条写；
 *   归纳不出来（目标不在允许的根内）就**不记**，并返回 `remembered:false`，
 *   绝不会退化成 `*`；
 * - 其它工具：与改前完全一致（`rememberRule(tool, ruleResource(args), effect)`）。
 */
export function rememberDecision(
  policy: HitlPolicyStore,
  call: HitlCall,
  effect: RuleEffect,
  agent?: { id: string; name?: string },
  deps?: RememberDeps,
): RememberOutcome {
  if (!isFileEditTool(call.name)) {
    policy.rememberRule(call.name, ruleResource(call.argsJson), effect, agent);
    return { remembered: true };
  }

  let roots: FileRoot[] = [];
  try {
    roots = deps?.roots ?? fileRootsStore.roots();
  } catch {
    roots = [];
  }
  const prefixes = prefixRulesOfCall({ name: call.name, argsJson: call.argsJson }, roots);
  if (!prefixes || prefixes.length === 0) return { remembered: false };
  policy.rememberRules(call.name, prefixes, effect, agent);
  return { remembered: true, prefixes };
}

/**
 * 该调用能否被「记住」——供确认卡决定是否显示复选框。
 *
 * 与 `rememberDecision` 用同一套判定：能推导出前缀才显示，
 * 否则用户勾了也不会生效，那种「勾了没反应」比不显示更糟。
 */
export function canRememberCall(call: { name: string; argsJson: string }, deps?: RememberDeps): boolean {
  if (!isFileEditTool(call.name)) return true;
  let roots: FileRoot[] = [];
  try {
    roots = deps?.roots ?? fileRootsStore.roots();
  } catch {
    roots = [];
  }
  const prefixes = prefixRulesOfCall(call, roots);
  return Boolean(prefixes && prefixes.length);
}

/** 该调用会被记成哪些前缀（确认卡上直接告诉用户「将记住 D:/x/」）。 */
export function prefixesOfCall(call: { name: string; argsJson: string }, deps?: RememberDeps): string[] {
  let roots: FileRoot[] = [];
  try {
    roots = deps?.roots ?? fileRootsStore.roots();
  } catch {
    roots = [];
  }
  return prefixRulesOfCall(call, roots) ?? [];
}
