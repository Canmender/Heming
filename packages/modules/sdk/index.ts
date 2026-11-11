/** 由 `scripts/generate-module-sdk.mjs` 生成，请勿手改。模块包从宿主同一实例取导出。 */
interface ModuleHostSdk {
  files?: Record<string, Record<string, unknown>>;
}
function hostFiles(): Record<string, Record<string, unknown>> {
  const host = (globalThis as { __hemingHost?: ModuleHostSdk }).__hemingHost;
  if (!host?.files) throw new Error("模块包 SDK 未初始化：宿主应先 installHostSdk()");
  return host.files;
}

export const AGENDA_DAYS = (hostFiles()["lib/infohub/store"] as Record<string, unknown>)["AGENDA_DAYS"] as never;
export const AGENDA_LOOKAHEAD_MS = (hostFiles()["lib/agendaBucket"] as Record<string, unknown>)["AGENDA_LOOKAHEAD_MS"] as never;
export const AGENDA_OVERDUE = (hostFiles()["lib/infohub/store"] as Record<string, unknown>)["AGENDA_OVERDUE"] as never;
export const AgendaBucket = (hostFiles()["lib/agendaBucket"] as Record<string, unknown>)["AgendaBucket"] as never;
export const AutomationIcon = (hostFiles()["components/icons"] as Record<string, unknown>)["AutomationIcon"] as never;
export const ChatMessage = (hostFiles()["lib/llmClient"] as Record<string, unknown>)["ChatMessage"] as never;
export const ConfirmDialog = (hostFiles()["components/ConfirmDialog"] as Record<string, unknown>)["ConfirmDialog"] as never;
export const DownloadIcon = (hostFiles()["components/icons"] as Record<string, unknown>)["DownloadIcon"] as never;
export const EmptyState = (hostFiles()["components/ui/EmptyState"] as Record<string, unknown>)["EmptyState"] as never;
export const InfohubAgendaResult = (hostFiles()["lib/infohub/client"] as Record<string, unknown>)["InfohubAgendaResult"] as never;
export const InfohubConfig = (hostFiles()["lib/infohub/client"] as Record<string, unknown>)["InfohubConfig"] as never;
export const InfohubDetectedSources = (hostFiles()["lib/infohub/client"] as Record<string, unknown>)["InfohubDetectedSources"] as never;
export const InfohubIntent = (hostFiles()["store/ui"] as Record<string, unknown>)["InfohubIntent"] as never;
export const InfohubProgressEvent = (hostFiles()["lib/infohub/client"] as Record<string, unknown>)["InfohubProgressEvent"] as never;
export const InfohubSearchHit = (hostFiles()["lib/infohub/client"] as Record<string, unknown>)["InfohubSearchHit"] as never;
export const InfohubSearchResult = (hostFiles()["lib/infohub/client"] as Record<string, unknown>)["InfohubSearchResult"] as never;
export const InfohubStatus = (hostFiles()["lib/infohub/client"] as Record<string, unknown>)["InfohubStatus"] as never;
export const InfohubSyncResult = (hostFiles()["lib/infohub/client"] as Record<string, unknown>)["InfohubSyncResult"] as never;
export const PageShell = (hostFiles()["components/layout/PageShell"] as Record<string, unknown>)["PageShell"] as never;
export const PlusIcon = (hostFiles()["components/icons"] as Record<string, unknown>)["PlusIcon"] as never;
export const SearchIcon = (hostFiles()["components/icons"] as Record<string, unknown>)["SearchIcon"] as never;
export const StaffIcon = (hostFiles()["components/icons"] as Record<string, unknown>)["StaffIcon"] as never;
export const Switch = (hostFiles()["components/plugins/shared"] as Record<string, unknown>)["Switch"] as never;
export const TrashIcon = (hostFiles()["components/icons"] as Record<string, unknown>)["TrashIcon"] as never;
export const UsageTotals = (hostFiles()["lib/llmClient"] as Record<string, unknown>)["UsageTotals"] as never;
export const WorkflowIcon = (hostFiles()["components/icons"] as Record<string, unknown>)["WorkflowIcon"] as never;
export const XIcon = (hostFiles()["components/icons"] as Record<string, unknown>)["XIcon"] as never;
export const agendaBucket = (hostFiles()["lib/agendaBucket"] as Record<string, unknown>)["agendaBucket"] as never;
export const callInfohub = (hostFiles()["lib/infohub/client"] as Record<string, unknown>)["callInfohub"] as never;
export const canUseInfohub = (hostFiles()["lib/infohub/store"] as Record<string, unknown>)["canUseInfohub"] as never;
export const createDefaultStorage = (hostFiles()["lib/memory/storage"] as Record<string, unknown>)["createDefaultStorage"] as never;
export const describeInfohubError = (hostFiles()["lib/infohub/client"] as Record<string, unknown>)["describeInfohubError"] as never;
export const detectedSourcesFromSummary = (hostFiles()["lib/infohub/client"] as Record<string, unknown>)["detectedSourcesFromSummary"] as never;
export const formatInfohubBytes = (hostFiles()["lib/infohub/client"] as Record<string, unknown>)["formatInfohubBytes"] as never;
export const formatInfohubTime = (hostFiles()["lib/infohub/client"] as Record<string, unknown>)["formatInfohubTime"] as never;
export const isInfohubAvailable = (hostFiles()["lib/infohub/client"] as Record<string, unknown>)["isInfohubAvailable"] as never;
export const isModuleEffective = (hostFiles()["lib/modules/store"] as Record<string, unknown>)["isModuleEffective"] as never;
export const isPlainObject = (hostFiles()["lib/memory/storage"] as Record<string, unknown>)["isPlainObject"] as never;
export const notifyDesktop = (hostFiles()["lib/desktopNotify"] as Record<string, unknown>)["notifyDesktop"] as never;
export const onInfohubEvent = (hostFiles()["lib/infohub/client"] as Record<string, unknown>)["onInfohubEvent"] as never;
export const readInfohubConfig = (hostFiles()["lib/infohub/client"] as Record<string, unknown>)["readInfohubConfig"] as never;
export const readJson = (hostFiles()["lib/memory/storage"] as Record<string, unknown>)["readJson"] as never;
export const readSecureValueAsync = (hostFiles()["lib/secureStorage"] as Record<string, unknown>)["readSecureValueAsync"] as never;
export const secureGetItem = (hostFiles()["lib/secureStorage"] as Record<string, unknown>)["secureGetItem"] as never;
export const secureRemoveItem = (hostFiles()["lib/secureStorage"] as Record<string, unknown>)["secureRemoveItem"] as never;
export const secureSetItem = (hostFiles()["lib/secureStorage"] as Record<string, unknown>)["secureSetItem"] as never;
export const secureStorageStatus = (hostFiles()["lib/secureStorage"] as Record<string, unknown>)["secureStorageStatus"] as never;
export const streamChat = (hostFiles()["lib/llmClient"] as Record<string, unknown>)["streamChat"] as never;
export const useInfohubStore = (hostFiles()["lib/infohub/store"] as Record<string, unknown>)["useInfohubStore"] as never;
export const useLlmStore = (hostFiles()["store/llm"] as Record<string, unknown>)["useLlmStore"] as never;
export const useModalA11y = (hostFiles()["components/useModalA11y"] as Record<string, unknown>)["useModalA11y"] as never;
export const useModuleStore = (hostFiles()["lib/modules/store"] as Record<string, unknown>)["useModuleStore"] as never;
export const useNotificationStore = (hostFiles()["store/notifications"] as Record<string, unknown>)["useNotificationStore"] as never;
export const useTaskStore = (hostFiles()["lib/tasks/store"] as Record<string, unknown>)["useTaskStore"] as never;
export const useTokenUsageStore = (hostFiles()["store/tokenUsage"] as Record<string, unknown>)["useTokenUsageStore"] as never;
export const useUiStore = (hostFiles()["store/ui"] as Record<string, unknown>)["useUiStore"] as never;
export const utf8Length = (hostFiles()["lib/memory/storage"] as Record<string, unknown>)["utf8Length"] as never;
export const writeJson = (hostFiles()["lib/memory/storage"] as Record<string, unknown>)["writeJson"] as never;
