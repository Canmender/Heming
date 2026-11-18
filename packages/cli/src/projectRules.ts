/**
 * 工作区约定文件（AGENTS.md 一族）在 CLI 里的接入（d.310）。
 *
 * ## 为什么要有这一层
 *
 * d.174 起桌面端每一轮都会读工作区里的 `AGENTS.md` / `HEMING.md` / `.heming/AGENTS.md` /
 * `.heming/rules.md` 并塞进系统提示词——「这个仓库改完要跑哪套测试、注释里能不能写『为什么』、
 * 有没有生成文件不许手改」这类规矩，桌面端知道，终端里的 `heming run` 一直不知道。
 * 同一份仓库规矩，两条路行为不一样，是比措辞不准更实际的偏差。
 *
 * ## 这层只做三件事
 *
 * 1. 决定**读哪几个文件**：完全复用桌面端那份 `collectProjectRules`，不另立一套口径
 *    （只认固定文件名、只读工作区根及其 `.heming/`、单文件 4000 字 / 总量 6000 字封顶）；
 * 2. 把工作区换算成 CLI 的根：CLI 只有一个可写根，就是 `--cwd`；
 * 3. 给 stderr 一行摘要：读了哪几份、各多少字、有没有截断、还有谁没展开——
 *    用户得看得见「这一轮到底读了什么」，否则「它为什么不按我们的规矩来」无从查起。
 *
 * 读不到（没这份文件、没权限、不是文本）就是「这一轮没有约定」，不阻断运行。
 */

import { collectProjectRules, type CollectedProjectRules } from "../../../packages/web/src/lib/agentRuntime/projectRules.js";
import type { FileFsBridge } from "../../../packages/web/src/lib/fileEdit/bridge.js";
import type { FileRoot } from "../../../packages/web/src/lib/fileEdit/paths.js";
import { createNodeFsBridge } from "../../../evals/runner/fsBridge.js";

/** CLI 的唯一根名（与 `tooling.ts` 里保持一致）。 */
export const CLI_ROOT_NAME = "work";

/** CLI 的根：`--cwd` 一个可写根。 */
export function cliProjectRuleRoots(cwd: string): FileRoot[] {
  return [{ path: cwd.replace(/\\/g, "/"), mode: "write", name: CLI_ROOT_NAME }];
}

/**
 * 读工作区约定文件。
 *
 * `bridge` 只为测试留口子（要测「桥抛错也不影响运行」）；生产路径自己建一个 Node 桥，
 * 它与工具桥读写的是同一批文件，但不需要共享状态。
 */
export async function collectCliProjectRules(input: {
  cwd: string;
  bridge?: FileFsBridge | null;
}): Promise<CollectedProjectRules> {
  const roots = cliProjectRuleRoots(input.cwd);
  const bridge = input.bridge ?? createNodeFsBridge();
  return collectProjectRules({ bridge, roots, workspace: input.cwd });
}

/**
 * stderr 那一行摘要。没有约定时返回空串（调用方就不打印，避免每次运行都多一行噪声）。
 *
 * 形如：
 * - `项目约定：AGENTS.md（1234 字）、.heming/rules.md（400 字，已截断）`
 * - 结尾按需追加：`；另有 HEMING.md、.heming/AGENTS.md 没展开`
 */
export function describeCliProjectRules(collected: CollectedProjectRules): string {
  if (collected.files.length === 0 && collected.omitted.length === 0) return "";
  const parts = collected.files.map((file) => `${file.rel}（${file.text.length} 字${file.truncated ? "，已截断" : ""}）`);
  const head = parts.length > 0 ? `项目约定：${parts.join("、")}` : "项目约定：一份都没读到";
  if (collected.omitted.length === 0) return head;
  return `${head}；另有 ${collected.omitted.join("、")} 没展开`;
}
