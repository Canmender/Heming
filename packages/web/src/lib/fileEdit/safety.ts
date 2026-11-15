/**
 * 补丁安全判定（三态，与 HITL 同源）。
 *
 * 判据只有一条（规格 §6）：
 * **补丁里所有目标路径都在某个 `mode=write` 的根内 → AutoApprove；否则按策略问人或拒绝。**
 *
 * 三条补充（与 Codex `core/src/safety.rs` 的 `assess_patch_safety` 同口径）：
 * 1. 落在只读根内的目标 → **Reject**（mode=read 就是「不许写」，问一次没有意义）；
 * 2. 含删除语义（Delete File 或改名）→ 即使全在写根内也 **AskUser**：
 *    删除不可逆，不该因为「在根内」就免问；
 * 3. 越界 → 默认 AskUser；配置 `outOfRoot:"reject"` 时 Reject。
 *
 * 再加一条硬排除（ADR-3 / P2-T13）：**可执行脚本扩展名**与 **`package.json`**
 * 即使全在写根内也 **AskUser**——前者写成就能被系统执行，后者能改掉构建/测试
 * 脚本（agent 给自己开后门），都属于「不该因为路径合法就免问」的类别。
 * 硬排除只把 `auto` 降级为 `ask`，**不放松任何一条已有判定**。
 *
 * ★ 这里只是**HITL 层的判定**。真正的写盘闸在桌面端 `file-fs.js`：
 * 无论 HITL 批不批，只读根与根外路径都写不进去。两层防线是刻意的。
 */

import { isInsideRoot, type FileRoot } from "./paths.js";

/** 三态判定结果。 */
export type PatchSafetyVerdict = "auto" | "ask" | "reject";

/**
 * 越界/无法写入时给用户的「出路」。
 *
 * 抽成常量而不是散在文案里：工具结果、确认卡与审计都要出现同一句，
 * 三处各写一遍迟早有一处变成「无法写入」这种没有下一步的废话。
 */
export const OUT_OF_ROOT_HINT =
  "目标不在可写根内；如需写入，请先在「设置 → 文件编辑」添加该目录为写根。";

/**
 * 硬排除：可执行脚本扩展名（ADR-3）。
 *
 * 这些文件写成就能被双击/计划任务执行，等于把「写文件」变成「拿到本机执行」。
 * 只在路径合法时把 `auto` 降级为 `ask`，不额外拒绝（用户仍可逐次确认）。
 */
export const EXECUTABLE_EXTENSIONS = [".exe", ".bat", ".ps1", ".cmd", ".vbs", ".msi", ".scr"] as const;

/** 硬排除：改这些文件要显式确认（`package.json` 的 scripts 能改掉构建/测试/发版链路）。 */
export const SENSITIVE_FILE_NAMES = ["package.json", "package-lock.json", "pnpm-lock.yaml"] as const;

/** 目标文件是不是硬排除对象；是则返回原因（确认卡与日志共用同一句话）。 */
export function hardExclusionOf(target: string): string | null {
  const name = target.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";
  if ((EXECUTABLE_EXTENSIONS as readonly string[]).includes(ext)) {
    return `目标 ${target} 是可执行脚本（${ext}），写入后可直接在本机执行，需要你确认。`;
  }
  if ((SENSITIVE_FILE_NAMES as readonly string[]).includes(name)) {
    return `目标 ${target} 是 ${name}，改动会影响依赖/构建/测试链路，需要你确认。`;
  }
  return null;
}

export interface PatchSafetyInput {
  /** 目标绝对路径（含改名目标）。 */
  targets: string[];
  /** 删除语义的变更数（Delete File + 改名）。 */
  deletions: number;
  roots: FileRoot[];
  /** 越界策略，缺省 `ask`。 */
  outOfRoot?: "ask" | "reject";
}

export interface PatchSafetyResult {
  verdict: PatchSafetyVerdict;
  /** 给人看的一句话原因（确认卡与拒绝文案共用）。 */
  reason: string;
}

/**
 * 判定一次补丁的安全等级。
 *
 * 顺序很重要：先判「只读根」（明确拒绝），再判「根外」，最后判「含删除」。
 * 这样用户看到的原因总是最具体的那一条。
 */
export function assessPatchSafety(input: PatchSafetyInput): PatchSafetyResult {
  const targets = (input.targets ?? []).filter((t) => typeof t === "string" && t);
  const roots = input.roots ?? [];
  if (targets.length === 0) {
    return { verdict: "reject", reason: "补丁没有可解析的目标文件，已拒绝。" };
  }
  if (roots.length === 0) {
    return { verdict: "reject", reason: `尚未配置任何根目录，文件编辑不可用。${OUT_OF_ROOT_HINT}` };
  }

  const readonlyRoots = roots.filter((r) => r.mode === "read");
  const writeRoots = roots.filter((r) => r.mode === "write");

  // 1. 只读根：mode=read 的含义就是「可以读、不许写」，不存在「问一下就能写」。
  for (const target of targets) {
    const hit = readonlyRoots.find((r) => isInsideRoot(r.path, target));
    if (hit) {
      return {
        verdict: "reject",
        reason: `目标 ${target} 位于只读根「${hit.name}」（${hit.path}），不允许写入。`,
      };
    }
  }

  // 2. 根外：默认问用户（他可能想临时授权一个目录），配置成 reject 时直接拒绝。
  const outside = targets.filter((t) => !writeRoots.some((r) => isInsideRoot(r.path, t)));
  if (outside.length > 0) {
    const sample = outside.slice(0, 3).join("、");
    if (input.outOfRoot === "reject") {
      return {
        verdict: "reject",
        reason: `有 ${outside.length} 个目标不在可写根内（${sample}），已按设置拒绝。${OUT_OF_ROOT_HINT}`,
      };
    }
    return {
      verdict: "ask",
      reason: `有 ${outside.length} 个目标不在可写根内（${sample}），需要你确认。${OUT_OF_ROOT_HINT}`,
    };
  }

  // 3. 硬排除：可执行脚本 / package.json 等（ADR-3）：路径再合法也不免问。
  //    放在删除之前判，用户看到的原因是「为什么这个文件特殊」，而不是泛泛的「要确认」。
  for (const target of targets) {
    const reason = hardExclusionOf(target);
    if (reason) return { verdict: "ask", reason };
  }

  // 4. 删除不可逆：即使全在写根内也问一句。
  if (input.deletions > 0) {
    return {
      verdict: "ask",
      reason: `补丁会删除或改名 ${input.deletions} 个文件，删除不可撤销，需要你确认。`,
    };
  }

  return { verdict: "auto", reason: "所有目标都在可写根内。" };
}
