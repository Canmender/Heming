/**
 * MCP 官方 Registry 接入的对外出口。
 *
 * 与 `lib/mcp/index.ts` 同一风格：把散在几个文件里的东西收成一个入口，
 * 让上层（`store/registry.ts` 与 `components/RegistryPage.tsx`）只 import 一处。
 *
 * 纯逻辑层：**零 React、零 store、零新依赖**。UI 相关的部分在 T08。
 */

export {
  REGISTRY_BASE,
  REGISTRY_PAGE_SIZE,
  ENTRY_PAGE_SIZE,
  FETCH_TIMEOUT_MS,
  dedupeItems,
  toEntries,
  fetchPage,
  search,
  type FetchLike,
} from "./api.js";

export {
  validatePackage,
  runnerFor,
  pinnedSpec,
  buildOption,
  buildRemoteOptions,
  isInstallable,
  registryServerId,
  toServerConfig,
  toEntry,
  type RejectReason,
} from "./map.js";

export {
  runtimeBridge,
  probeLocalRuntime,
  runtimeRequirementFor,
  missingRuntimeReason,
  blockedReason,
  installableWithRuntime,
  RUNTIME_LABEL,
  type LocalRuntimeStatus,
  type RuntimeBridgeApi,
  type RuntimeKey,
} from "./runtime.js";

export {
  rateInstall,
  riskOfTool,
  selfClaimNote,
  isDeprecated,
  hostOf,
  registryDomain,
  repoLooksMismatched,
  type InstallRisk,
  type InstallVerdict,
} from "./risk.js";

export {
  titleOf,
  type RegistryEntry,
  type RegistryItem,
  type RegistryOfficialMeta,
  type RegistryPackage,
  type RegistryPage,
  type RegistryRemote,
  type RegistryServer,
  type InstallOption,
  type InstallTransport,
  type FetchResult,
} from "./types.js";

export {
  buildInstallPreview,
  sanitizeHeaders,
  type InstallDecision,
  type InstallPreviewRow,
  type RegistryInstallPreview,
} from "./preview.js";
