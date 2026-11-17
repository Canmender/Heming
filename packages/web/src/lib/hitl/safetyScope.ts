/**
 * 「安全范围」——聊天框左下角那一档用户语言。
 *
 * 内部仍有三个 HITL 档位（`strict` / `guarded` / `trusted`，见 `types.ts`），
 * 但对用户来说「严格/受控/信任」不好懂，而且他们真正关心的是
 * 「它会不会每条都来问我」。所以对外只暴露三档：
 *
 * - 手动（`manual`）：每个工具调用都先问；
 * - 自动（`auto`）：只读自动放行；写与危险仍要问（默认）；
 * - 完全（`full`）：**连危险操作也不再逐条问**。
 *
 * ★ 「完全」为什么是一枚**本会话内有效**的开关，而不是第四个 HitlMode：
 *
 * `types.ts` 里明确写过「曾经有过 `auto` 档，被否掉了」——全放行与自我修改
 * 工具组合后是致命的（装一个 MCP → 启用它 → 它带来的所有工具静默执行）。
 * 但用户需要这个能力（批量重构、跑构建、在自己的机器上做敢做的事）。
 * 折中办法是把「全放行」从**持久档位**降级成**一次显式、可随时撤销、重启即失效**的开关：
 *
 * 1. 不写 localStorage：重启应用就回到「自动」，不会有人第二天发现自己一直在全放行；
 * 2. 需要点两次：第一次只说清代价，第二次才真的开；
 * 3. 开着时输入区常驻一条黄色提示，随时可一键改回；
 * 4. `/status` 如实写出当前档位；
 * 5. 工作区的 `permissions.json` deny 规则仍然先行——它挡的是「这个仓库不许这么干」，
 *    比「这一轮我想少被打扰」更高。
 */

import type { HitlMode } from "./types.js";
import type { HitlPolicy } from "./policy.js";

/** 用户能选的三档安全范围。 */
export type SafetyScope = "manual" | "auto" | "full";

/** 选择器里的顺序（也是「宽松程度」递增的顺序）。 */
export const SAFETY_SCOPES: readonly SafetyScope[] = ["manual", "auto", "full"];

/** 每一档的按钮短名与一句说明（界面与 `/status` 共用，避免两处漂移）。 */
export const SAFETY_SCOPE_TEXT: Record<SafetyScope, { label: string; hint: string }> = {
  manual: {
    label: "手动",
    hint: "每个工具调用都先问你——看得最细，也最打扰。",
  },
  auto: {
    label: "自动",
    hint: "可写根内的文件改动与只读操作直接做；跑命令、改自己的执行环境这类危险操作仍会问你。",
  },
  full: {
    label: "完全",
    hint: "连危险操作也不再逐条问（删文件、跑命令、改自己的执行环境）。只在本机本次运行内有效，重启回到「自动」。",
  },
};

/** 由内部档位 + 全放行开关反推用户看到的那一档。 */
export function scopeOfPolicy(policy: HitlPolicy, dangerAuto: boolean): SafetyScope {
  if (policy.mode === "strict") return "manual";
  if (dangerAuto) return "full";
  return "auto";
}

/** 选中某一档时应该落成的内部状态。 */
export function policyForScope(scope: SafetyScope): { mode: HitlMode; dangerAuto: boolean } {
  switch (scope) {
    case "manual":
      return { mode: "strict", dangerAuto: false };
    case "full":
      return { mode: "trusted", dangerAuto: true };
    case "auto":
    default:
      return { mode: "guarded", dangerAuto: false };
  }
}

/** `/status` 里的那一行（不带前缀，由 statusReport 拼）。 */
export function describeSafetyScope(scope: SafetyScope): string {
  const { label, hint } = SAFETY_SCOPE_TEXT[scope];
  if (scope === "full") {
    return `安全范围：${label}——${hint}`;
  }
  return `安全范围：${label}（${hint}）`;
}

/* -------------------------------------------------------------------------- */
/* 「完全」的全放行开关：进程内内存，故意不落盘                                  */
/* -------------------------------------------------------------------------- */

let dangerAuto = false;
const listeners = new Set<() => void>();

/** 现在是不是「完全」档的全放行状态。 */
export function isDangerAuto(): boolean {
  return dangerAuto;
}

/** 打开/关闭全放行。开关本身不会改变 HITL 档位——档位由调用方一起设。 */
export function setDangerAuto(next: boolean): void {
  if (dangerAuto === next) return;
  dangerAuto = next;
  for (const listener of listeners) listener();
}

/** 订阅（供 `useSyncExternalStore`）。 */
export function subscribeDangerAuto(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 测试用：把开关复位到「关闭」。 */
export function resetDangerAuto(): void {
  setDangerAuto(false);
}
