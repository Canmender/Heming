/**
 * 文件编辑原语（`file_patch` / `file_read`）的对外出口。
 *
 * 分层（自下而上，依赖单向）：
 * - `types` / `limits` / `paths`：纯类型与路径口径
 * - `parse` / `match`：补丁协议与三级匹配（纯函数）
 * - `resolve` / `apply`：目标解析与干跑（唯一读盘处，IO 注入）
 * - `safety` / `roots`：三态安全判定与可写根存储
 * - `bridge` / `tools`：桌面桥与工具定义
 * - `ruleTargets` / `remember`：给 HITL 的路径目标与前缀规则
 * - `patchPreview`：确认卡的行级 diff
 */

export * from "./types.js";
export * from "./limits.js";
export {
  toPosixPath,
  isAbsolutePath,
  segmentsOf,
  foldSegments,
  compareKey,
  isPrefixResource,
  normalizeRuleResource,
  resourceCovers,
  resolveInsideRoot,
  isInsideRoot,
  relFromRoot,
  commonDirPrefix,
  utf8Bytes,
  MAX_PATH_CHARS,
  type FileRoot,
} from "./paths.js";
export { parsePatch, countTargets, sourcePaths, allPaths, hasDeleteIntent } from "./parse.js";
export { splitText, joinText, applyHunks, buildAddedText, findHunk } from "./match.js";
export { pickRoot, resolvePatchPath, isPatchError, writeRootNames, type ResolvedTarget } from "./resolve.js";
export { planPatch, sumKinds, kindsSummary, type PatchIo, type PlanContext, type PlanResult, type ReadResult } from "./apply.js";
export {
  assessPatchSafety,
  OUT_OF_ROOT_HINT,
  type PatchSafetyVerdict,
  type PatchSafetyResult,
} from "./safety.js";
export {
  FILE_ROOTS_KEY,
  MAX_FILE_ROOTS,
  FileRootsStore,
  fileRootsStore,
  normalizeRootsConfig,
  isAcceptableRootPath,
  defaultRootName,
  type FileRootsConfig,
} from "./roots.js";
export { getFileBridge, hasFileBridge, type FileFsBridge, type FileWriteOp } from "./bridge.js";
export {
  FILE_TOOLS,
  buildFileToolBridge,
  buildFileToolBridgeIfAvailable,
  visibleFileTools,
  formatPatchError,
  type FileToolDeps,
  type FileToolSpec,
} from "./tools.js";
export {
  FILE_PATCH_TOOL,
  FILE_READ_TOOL,
  isFileEditTool,
  parseToolArgs,
  targetsOfCall,
  dirPrefixesOfTargets,
  prefixRulesOfCall,
  type CallPathTargets,
} from "./ruleTargets.js";
export { rememberDecision, canRememberCall, prefixesOfCall, type RememberOutcome } from "./remember.js";
export {
  buildPatchPreview,
  PATCH_PREVIEW_MAX_LINES,
  type PatchPreview,
  type PatchFilePreview,
} from "./patchPreview.js";
