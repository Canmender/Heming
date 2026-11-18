import {
  Fragment,
  // React 19 的类型里全局 JSX 命名空间已移除，改为从 react 导出；
  // 这里只引类型，运行时不产生任何导入。
  type JSX,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { Conversation, Message, MessagePayload } from "@heming/shared";
import {
  STREAM_STALE_MS,
  useChatStore,
  transcriptOf,
  withTranscript,
  type E2eOpenHandler,
  type E2eOpenOutcome,
  type MessageTranscript,
  type ToolTrace,
} from "../store/chat.js";
import { useUiStore, type TaskDraft } from "../store/ui.js";
import { useNotificationStore } from "../store/notifications.js";
import { clearDraft, getDraft, setDraft as saveDraft } from "../lib/drafts.js";
import {
  DEFAULT_WINDOW,
  countToInclude,
  expandCount,
  shouldLoadMore,
} from "../lib/messageWindow.js";
import { readChatScroll, writeChatScroll } from "../lib/chatScroll.js";
import { registerConversationAbort } from "../lib/runAbort.js";
import { useTaskStore } from "../lib/tasks/store.js";
import { resolveForkRun } from "../lib/tasks/forkTask.js";
import { FOCUS_RING, FOCUS_RING_TIGHT } from "../lib/a11y/focus.js";
import { formatBytes } from "../lib/export/conversation.js";
import { useAuthStore } from "../store/auth.js";
import { useLlmStore } from "../store/llm.js";
import { recordsForConversation, totalsOf, useTokenUsageStore } from "../store/tokenUsage.js";
import {
  uploadEncryptedFile,
  fetchFileBlobUrl,
  downloadEncryptedFile,
  fetchE2eKeys,
  putE2eKeys,
  NO_E2E_MESSAGE,
  fetchMyTeamBriefs,
  fetchMyTeamTasks,
  deleteMessages,
} from "../lib/api.js";
import { hasSubtle } from "../lib/e2eCrypto.js";
import {
  initSession,
  sealMessage,
  openMessage,
  openOwnMessage,
  msgCache,
  migrateMsgCache,
  isForMe,
  sweepDeferred,
  recvChainOwners,
  chunkAad,
  errorAad,
  exportOwnDeviceKeys,
  type E2eDeps,
  type PlainEnvelope,
  type SealedEnvelope,
} from "../lib/e2eSession.js";
import { type ChatMessage, type RouteAttempt } from "../lib/llmClient.js";
import { resolveBoundProfile, streamChatRouted } from "../lib/llmRoute.js";
import { resolveCapability } from "../lib/modelCaps.js";
import {
  attachImageParts,
  isVisionImage,
  visionImageDataUrl,
  type HistoryRow,
  type VisionImageSlot,
} from "../lib/vision/history.js";
import { MAX_TOOL_ROUNDS, MAX_VISIBLE_TOOLS, TOOL_SEARCH_THRESHOLD, runAgentMentions, type TriggerDeps } from "../lib/agentStream.js";
import { recordRollout, rolloutLog } from "../lib/rollout/index.js";
import { buildAgentContext } from "../lib/agentRuntime/context.js";
import {
  COMPACT_COMMAND,
  applyModelBudget,
  calibrateEstimate,
  compactNow,
  contextCalibrationRatio,
  countFoldedMessages,
  foldNoticeText,
  getContextFold,
  recordContextFold,
  estimateRowsTokens,
  loadContextSettings,
  prepareHistory as prepareAgentHistory,
  recordContextSample,
  summaryCache,
} from "../lib/agentContext/index.js";
import { agentPrefsStore, memoryStore } from "../lib/memory/index.js";
import { recallRecorder } from "../lib/memory/runRecorder.js";
import { maybeRunReview } from "../lib/memory/reviewRunner.js";
import { skillPool } from "../lib/skills/index.js";
import { connectWs, type WsHandle } from "../lib/ws.js";
import { registerChatSocket } from "../lib/chatSocketPresence.js";
import { VideoIcon, ChevronIcon, MenuIcon, SmileIcon, ImageIcon, FileIcon, MicIcon, PlusIcon, PhoneIcon, SearchIcon, XIcon, AlertIcon, WorkflowIcon, TaskIcon } from "./icons.js";
import { buildSearchRows, findMessageHits, hitPosition, stepHit } from "../lib/chat/search.js";
import {
  AgentStreamBubble,
  ReasoningBlock,
  ToolTraceGroup,
} from "./AgentStreamBubble.js";
import { conversationTitle } from "./assistant/conversationTitle.js";
// 右侧「会话进度」栏（d.147.4.88）：Codex / ChatGPT 式的按钮呼出侧栏。
import { ProgressPanel } from "./ProgressPanel.js";
import { OrchestrationBar, type ChatView } from "./chat/OrchestrationBar.js";
import { TrajectoryView } from "./chat/TrajectoryView.js";
import { ContextView } from "./chat/ContextView.js";
import { useConversationProgress } from "../lib/progress/useConversationProgress.js";
import { EmojiPicker } from "./EmojiPicker.js";
import { capabilityRegistry } from "../lib/capability/index.js";
import { fileRootsFor, setActiveWorkspace } from "../lib/fileEdit/roots.js";
import { getFileBridge, hasBackupPreviewBridge, hasFileBridge, hasRevealBridge } from "../lib/fileEdit/bridge.js";
import { getShellBridge, hasJobChannels, hasJobPreview, hasJobRuntime } from "../lib/shell/bridge.js";
import {
  buildRuntimeSection,
  describePlatform,
  runtimeToolsFromSpecs,
} from "../lib/agentRuntime/runtimePrompt.js";
import { resolveBasePrompt } from "../lib/agentRuntime/defaultPrompt.js";
import { collectProjectRules, summarizeProjectRules, type ProjectRulesSummary } from "../lib/agentRuntime/projectRules.js";
import { describeAssignedTasks, describeClaimableTasks } from "../lib/team/assignedTasks.js";
import {
  MY_TASK_BADGE_MAX,
  myTaskBadgeText,
  myTaskButtonLabel,
  summarizeMyTasks,
  type MyTaskBadge,
} from "../lib/team/myTaskBadge.js";
import { describeTeamBriefLines } from "../lib/team/teamBrief.js";
import { peekPluginInstallNotices, takePluginInstallNotices } from "../lib/plugins/installedNotice.js";
import { collectFileRefs, describeFileRefIssues, fileRefIssues, type FileRefIssues } from "../lib/fileEdit/fileRefs.js";
import { FileRefPicker } from "./FileRefPicker.js";
import { ModelSwitcher } from "./ModelSwitcher.js";
import { TurnUndoBar } from "./TurnUndoBar.js";
import { ChangeDiffDialog, type ChangeDiffState } from "./ChangeDiffDialog.js";
import { MyTasksDialog } from "./MyTasksDialog.js";
import { SessionChangesBar } from "./SessionChangesBar.js";
import {
  getSessionChanges,
  recordSessionChanges,
  subscribeSessionChanges,
} from "../lib/fileEdit/sessionChanges.js";
import {
  beginRewindTurn,
  closeRewindTurn,
  describeShellCommandsNote,
  describeTurnCheckpoints,
  dropTurnCheckpoints,
  planRewind,
  withRewindCapture,
} from "../lib/fileEdit/rewindCheckpoints.js";
import { JobReadyBar } from "./JobReadyBar.js";
import { ContextMeter } from "./ContextMeter.js";
import { ResumeBar, type ResumeReason } from "./ResumeBar.js";
import { SubagentRuns } from "./SubagentRuns.js";
import { TurnProgressLine } from "./TurnProgressLine.js";
import { JobPanel } from "./JobPanel.js";
import {
  clearTurnRunning,
  loadResumePoint,
  markTurnRunning,
} from "../lib/agentRuntime/resumePoint.js";
import { jobContinuePrompt, watchJobs, type WatchedJob } from "../lib/shell/jobWatch.js";
import {
  JOB_PANEL_POLL_MS,
  hasRunningPanelJobs,
  killPanelJob,
  listPanelJobs,
  pollPanelJobs,
  previewPanelJob,
  subscribePanelJobs,
} from "../lib/shell/jobPanel.js";
import { withSubagentTool } from "../lib/agentRuntime/subagent.js";
import { decidePanelAutoOpen } from "../lib/agentRuntime/panelAuto.js";
import { withPanelTool } from "../lib/agentRuntime/panelTool.js";
import { withWorkflowTool } from "../lib/agentRuntime/workflow.js";
import { withTeamTool } from "../lib/agentRuntime/team.js";
import {
  applySubagentProgress,
  listSubagentRuns,
  resetSubagentRuns,
  subscribeSubagentRuns,
} from "../lib/agentRuntime/subagentRuns.js";
import {
  applyTeamProgress,
  beginTeamRun,
  finishTeamRun,
  resetTeamRuns,
  teamRunMembersOf,
} from "../lib/agentRuntime/teamRuns.js";
import {
  clearTurnProgress,
  getTurnProgress,
  recordTurnProgress,
  settleTurnProgress,
  subscribeTurnProgress,
} from "../lib/agentRuntime/turnProgress.js";
import { createSteerQueueRegistry } from "../lib/agentRuntime/steerQueues.js";
import { PLAN_EXECUTE_PROMPT, loadPlanMode, savePlanMode, withPlanMode } from "../lib/agentRuntime/planMode.js";
import { autoConnectAll } from "../lib/mcp/runtime.js";
import { SelfEditBudget, SelfEditStore } from "../lib/selfEdit/index.js";
import { createHitlGate, toHitlBatch } from "../lib/hitl/gate.js";
import { createToolHookRunner, describeToolHooksState, setToolHooksEnabled, type ToolHookRunner } from "../lib/hitl/hookRunner.js";
import { HitlPolicyStore } from "../lib/hitl/policy.js";
import {
  SAFETY_SCOPES,
  SAFETY_SCOPE_TEXT,
  describeSafetyScope,
  isDangerAuto,
  policyForScope,
  scopeOfPolicy,
  setDangerAuto,
  type SafetyScope,
} from "../lib/hitl/safetyScope.js";
import { useHitlStore, type PendingConfirm } from "../store/hitl.js";
import { ToolApprovalModal } from "./ToolApprovalModal.js";
import { appendToolAudit } from "../lib/hitl/audit.js";
import { toolNameLabel } from "../lib/toolName.js";
import type { HitlVerdict } from "../lib/hitl/types.js";
import type { StorageLike } from "../lib/memory/types.js";
import { extractCharts, stripChartFences } from "../lib/charts/spec.js";
import { docFileBlock, isDocumentLike, parseDocument } from "../lib/docs/parse.js";
import { ChatChart } from "./ChatChart.js";
import { MarkdownMessage } from "./MarkdownMessage.js";
import { mcpRegistry } from "../lib/mcp/store.js";
import { useModalA11y } from "./useModalA11y.js";
import { capabilityNotice } from "../lib/capabilityNotice.js";
import { formatClock, formatDayClock, needsTimeSeparator } from "../lib/formatTime.js";
import { ChatEmptyState } from "./ux/ChatEmptyState.js";
import { ErrorState } from "./ui/ErrorState.js";
import { ComposerHints } from "./ux/ComposerHints.js";
// d.158：任务清单渲染（`todo_write` 的可见落点），放在输入栏上方
import { TodoPanel } from "./TodoPanel.js";
import { getTodos } from "../lib/todo/store.js";
// d.167.4.103：轮次打满后的「继续」入口（不再让用户自己打「继续」）
import { RoundLimitHint, type ContinueReason } from "./RoundLimitHint.js";
import { PlanReadyBar } from "./PlanReadyBar.js";
import { GoalBar } from "./GoalBar.js";
import { SlashCommandMenu } from "./SlashCommandMenu.js";
import { GOAL_COMMAND, HOOKS_COMMAND, SUBAGENT_COMMAND, NOTIFY_COMMAND, PLAN_COMMAND, REWIND_COMMAND, STATUS_COMMAND, HELP_COMMAND, matchSlashCommands, SLASH_COMMANDS } from "../lib/agentRuntime/slashCommands.js";
import { collectCustomCommands, commandsToSlash, expandCustomCommand, type CustomCommand } from "../lib/agentRuntime/customCommands.js";
import { collectSubagentDefs, type SubagentDef } from "../lib/agentRuntime/subagentDefs.js";
import { expandInitCommand } from "../lib/agentRuntime/initPrompt.js";
import {
  describeRegenerateConfirm,
  planRegenerate,
  type RegeneratePlan,
} from "../lib/agentRuntime/regenerate.js";
import { clearGoal, getGoal, goalForPrompt, setGoal } from "../lib/agentRuntime/goal.js";
import { notifyApprovalWait, notifyTurnEnd, resetTurnNotifyThrottle } from "../lib/agentRuntime/turnNotify.js";
import { isDesktopNotifyEnabled, onDesktopNotifyOpen, setDesktopNotifyEnabled } from "../lib/desktopNotify.js";
import { useGoal } from "../lib/agentRuntime/useGoal.js";
import {
  isSubagentWriteEnabled,
  setSubagentWriteEnabled,
} from "../lib/agentRuntime/subagentWrite.js";
import { buildSlashHelp, buildStatusReport } from "../lib/agentRuntime/statusReport.js";
import { getToolFailureStats, recordToolFailure } from "../lib/agentRuntime/toolFailureStats.js";
import { historyFrom, stepHistory } from "../lib/agentRuntime/inputHistory.js";
import { coreToolNames } from "../lib/agentRuntime/coreTools.js";
import {
  FINISH_GATE_MAX_NUDGES,
  finishGatePrompt,
  finishGateVerdict,
  unfinishedTodos,
} from "../lib/agentRuntime/finishGate.js";
import { inspectOutgoingText, largeMessageNotice } from "../lib/agentRuntime/messageBudget.js";
import { summarizeMcpStatus } from "../lib/mcp/summary.js";
import { getNetPolicy } from "../lib/webtools/netPolicy.js";
import { UNBOUND_NOTICE_ID, UnboundModelNotice, unboundNoticeText } from "./ux/UnboundModelNotice.js";
import { chatExamplesFor } from "../lib/onboarding.js";
import { Button } from "../components/ui/Button.js";
import { IconButton } from "../components/ui/IconButton.js";

/**
 * 空消息列表的**稳定引用**。
 *
 * zustand 5 不再记忆化 selector 的返回值（v4 的 useSyncExternalStoreWithSelector 会缓存
 * 上一次结果），所以 selector 里写 `?? []` 会在每次 getSnapshot 调用时造一个新数组，
 * React 判定快照一直在变，报 “The result of getSnapshot should be cached” 并无限重渲染
 * （实测：ChatPage 挂载即 Maximum update depth exceeded，103 个用例连坐）。
 * 换成模块级常量后引用恒等，语义不变（下游只读不写）。
 */
const EMPTY_MESSAGES: Message[] = [];

/** 无 subtle 环境的常驻提示（横幅 + 发送拦截共用文案，设计 §2.1：拒绝发送不降级明文）。 */
export const NO_E2E_NOTICE = NO_E2E_MESSAGE;

/** 与正文同发的本轮附件：图片转内容片、文档拼正文，重试时按它复原同一轮。 */
type TurnAttachment = NonNullable<MessagePayload["file"]>;

/**
 * HITL 闸门（工具执行前人工确认）的**模块级单例**。
 *
 * 为什么必须在组件外创建：闸门持有「本会话内允许此工具」的授权表
 * （`HitlPolicyStore` 里的内存 Map）。若每次渲染新建一份，
 * 用户刚点下的「本会话内允许」会立刻失效——授权就等于没给。
 */
const hitlPolicy = new HitlPolicyStore();

/** 工具确认留痕的存储（与策略同在本机 localStorage）。 */
const hitlAuditStorage: StorageLike = {
  getItem: (k) => {
    try {
      return window.localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  setItem: (k, v) => {
    try {
      window.localStorage.setItem(k, v);
    } catch {
      /* 隐私模式：留痕失败不影响确认本身 */
    }
  },
  removeItem: (k) => {
    try {
      window.localStorage.removeItem(k);
    } catch {
      /* 同上 */
    }
  },
};

/**
 * 待确认的超时时长（d.34）：60 分钟。
 *
 * 从请求**成为当前待定项**开始计时（排队中的请求等排到再计）。
 * 短了会把「用户去开个会」变成误拒；长了会让一轮对话无限挂起。
 * 超时按拒绝收口，并在审计里写明原因——与用户手动拒绝可区分。
 */
export const HITL_APPROVAL_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * 闸门本体。
 *
 * `ask` 注入的是 store 的 enqueue：闸门把待确认项交给它，
 * 它在 UI 侧排队，用户决定后 resolve 回裁决。
 */
const hitlGate = createHitlGate({
  policy: hitlPolicy,
  // d.242：「完全」档的全放行开关（每次裁决现读，不缓存——用户随时可能改回来）
  dangerAuto: isDangerAuto,
  ask: (batch) =>
    useHitlStore.getState().enqueue(
      { kind: "tool-call", payload: batch.calls, auto: batch.auto },
      {
        agentId: batch.agentId,
        conversationId: batch.conversationId,
        streamId: batch.streamId,
        agentName: batch.agentName,
      },
    ),
});

/**
 * 智能体会话 → 显示名与头像（侧栏会话列表与标题栏共用）。
 * d.54 起会话只剩「用户 ↔ 智能体」一种，三态联合已成历史。
 */
export function convLabel(c: Conversation): { name: string; avatar?: string; group: boolean } {
  return { name: c.agent.name, avatar: c.agent.avatar ?? undefined, group: false };
}

/** chips 空表的稳定引用（selector 兜底，防每次渲染新建 {} 触发多余重渲染）。 */
const NO_PLAIN: Record<string, PlainEnvelope> = {};

/** 他机流 watchdog 清扫周期（Task 7）：15s 一次扫全局 streaming 的过期项（阈值在 store 内 60s）。 */
const STREAM_SWEEP_INTERVAL_MS = 15_000;

/** 输入栏（文本行）高度：默认比单行大一些，用户可拖动上沿调整，写 localStorage 持久化。 */

/**
 * E2E 公钥短缓存：seal 内逐成员调 fetchPeerKeys，不缓存会让一次 seal 打 N 次
 * GET /api/e2e/keys（多接收方风暴）。3s TTL——新设备上云后最迟下次 seal 可见。
 */
let peerKeysCache: { at: number; data: Awaited<ReturnType<typeof fetchE2eKeys>> } | null = null;
async function fetchPeerKeysCached(userId: string) {
  if (!peerKeysCache || Date.now() - peerKeysCache.at > 3000) {
    peerKeysCache = { at: Date.now(), data: await fetchE2eKeys() };
  }
  return peerKeysCache.data[userId] ?? null;
}

const COMPOSER_HEIGHT_KEY = "heming.chat.composerHeight.v1";
// d.346：默认与上下限一起加高——96px 只够两行，长提问一进来就要滚；
// 聊天页的高频动作是「写长一点」，所以给它四行左右的默认高度。
const DEFAULT_COMPOSER_HEIGHT = 144;
const MIN_COMPOSER_HEIGHT = 96;
const MAX_COMPOSER_HEIGHT = 480;

/** 夹住输入栏高度（拖拽与读存储共用；非法值回落默认）。 */
export function clampComposerHeight(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_COMPOSER_HEIGHT;
  return Math.min(MAX_COMPOSER_HEIGHT, Math.max(MIN_COMPOSER_HEIGHT, Math.round(n)));
}

/**
 * 「贴底」判定阈值（A3）：距底小于该值即视为正在看最新消息。
 * 留 80px 余量是因为滚动条末端的 1~2px 抖动不该被当成「用户上滑了」。
 */
const STICK_BOTTOM_PX = 80;

/**
 * d.198：从左栏搜索跳过来的那条消息高亮多久（毫秒）。
 *
 * 2.4 秒：够眼睛跟过去、认出是哪一句；再长就会让人以为这条消息「被选中了」。
 */
const JUMP_HIGHLIGHT_MS = 2400;

/**
 * 「继续生成」发出去的续写指令（不是重发原提问）。
 *
 * 重发原提问会在历史里留下第二条同样的用户消息，并把已执行过的工具再跑一遍；
 * 只让模型接着写，历史里已有原提问与被中断的部分回答，它知道从哪接。
 */
const CONTINUE_PROMPT =
  "继续（接着上一轮往下写，不要重复已经写过的内容；如果上一轮被中断，请先把没说完的结论补完）";

/**
 * 历史里最多回放的轮数。
 *
 * ★ 以前是 `slice(-30)`：第 31 条以前的消息**在进摘要之前就被丢掉**了，
 * 用户翻旧账时模型对更早的约定毫无印象（而且摘要也救不回来——它根本没看到）。
 * 放宽到 120，超出的部分由 `prepareHistory` 压缩成摘要，而不是在这里静默消失。
 */
const HISTORY_MESSAGE_WINDOW = 120;

/** 单轮最多回放多少次工具调用（历史只做参考，别把整轮工具流水搬进提示词）。 */
const HISTORY_TOOLS_PER_TURN = 8;

/** 单条工具结果进历史时的字符上限。 */
const HISTORY_TOOL_TEXT_MAX = 1200;

/**
 * 单条工具**参数**进历史时的字符上限。
 *
 * `arguments` 可以是几万字符（写文件、批量改代码），而预算估算要按它算 token；
 * 超长的不截断就等于让一条历史把整轮预算吃掉。截断后**仍是合法 JSON**：
 * 部分供应商（Anthropic 风格）会校验历史 tool_use 的 input，塞半截 JSON 会整轮 400。
 */
const HISTORY_TOOL_ARGS_MAX = 4000;

/** 把工具参数压进历史长度上限：短的照原样，长的换成一句合法 JSON 说明。 */
function historyToolArgs(args: string): string {
  const raw = args.trim() || "{}";
  if (raw.length <= HISTORY_TOOL_ARGS_MAX) return raw;
  return JSON.stringify({ note: "（这次调用的参数过长，历史里已省略原文；它做了什么见下面那条工具结果。）" });
}

/**
 * 把一次工具调用还原成「给模型看的历史文本」。
 *
 * 关键在于**别丢**：模型不知道上一轮查过什么，就会重复查、或者把已核实的事实重新猜
 * （用户看到的「逻辑链断了」）。拒绝/中断也要留下痕迹，否则模型会以为那次调用成功了。
 */
function historyToolText(trace: ToolTrace): string {
  if (trace.status === "denied") {
    // 被拒的不是只有「用户拒绝」：hooks / 记住的规则 / 闸门异常对模型的含义完全不同，
    // 一律写成用户拒绝会让它去劝用户，而不是改参数或看检查结果。
    if (trace.denyCause === "hook") return "（工作区 hooks 拒绝了这次调用，工具未执行。）";
    if (trace.denyCause === "rule") return "（命中记住的拒绝规则，工具未执行。）";
    if (trace.denyCause === "gate") return "（确认流程异常，工具未执行。）";
    return "（用户拒绝了这次调用，工具未执行。）";
  }
  if (trace.status === "running") return "（这次调用被中断，没有拿到结果。）";
  const raw = trace.result ?? "";
  if (!raw) return trace.status === "error" ? "（工具执行失败，没有返回内容。）" : "（工具执行完成，没有返回内容。）";
  const clipped =
    raw.length > HISTORY_TOOL_TEXT_MAX
      ? `${raw.slice(0, HISTORY_TOOL_TEXT_MAX)}\n…（结果过长，已截断）`
      : raw;
  return trace.status === "error" ? `（工具执行失败）\n${clipped}` : clipped;
}

/**
 * 输入区提示行（A9）：info 3 秒自动消失；error 用红色 + role="alert"，
 * 纯文本发送失败时附带「重试」（附件场景不提供，避免重放一次上传）。
 */
type SendNotice = { kind: "info" | "error"; text: string; retry?: () => void };

/**
 * 输入区提示位的一条（B 轨 E3）：此前「分叉降级 / 能力降级 / 发送提示 / 生成中」
 * 各自占一行，最多能堆到 4–6 行、且 warn 三处同形同色分不出轻重。
 * 现在统一成数据，由渲染处限高 2 行 + 「还有 N 条」展开。
 */
type NoticeTone = "error" | "warn" | "muted";
type NoticeItem = {
  key: string;
  tone: NoticeTone;
  text: string;
  retry?: () => void;
  action?: { label: string; onClick: () => void };
};

/** 提示位只展开两行：再多就把输入区顶得看不见消息。 */
const NOTICE_VISIBLE_ROWS = 2;

/**
 * 待发附件（B 轨 E1）：选中文件后先入列表，用户可核对、移除、先写字再发。
 * 此前四个入口（工具行 / 粘贴 / 拖拽 / 录音）都是「选中即上传即发送」，
 * 选错文件无法取消，也做不出「先附图再补正文」的顺序。
 */
type PendingFile = { key: string; file: File };

/** 一次最多带几个附件：每个附件是一条独立 file 消息，多了刷屏也拖慢串行上传。 */
const MAX_PENDING_FILES = 5;

/** 待发附件的 key 序号（只用于 React key 与移除定位，不进消息）。 */
let pendingFileSeq = 0;

/**
 * 附件气泡（图片缩略图 / 文件卡）：content 路由 authOnly，裸 src/href 会 401 →
 * 挂载时走鉴权 blob 拿 objectURL，卸载或换附件时 revoke（含「fetch 还没回来就已卸载」的
 * 竞态：取到即弃），防 objectURL 内存泄漏。加载失败（401/网络/解密失败）给可见占位，
 * 不渲染断链的 <img>/<a>。
 * E2E Task 5：payload.file.key 存在（消息附件已加密）→ downloadEncryptedFile 鉴权取密文
 * 并解密成 Blob 再建 objectURL；无 key（legacy 明文附件 / 右栏投递）→ fetchFileBlobUrl
 * 明文直通（规格 §2.4：无 key 照旧显示）。
 */
function AttachmentPreview({
  file,
}: {
  file: { id: string; name: string; mime: string; size: number; key?: string };
}): JSX.Element | null {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  /** 失败后的重试计数：+1 让下面 effect 重新拉取（附件下载失败必须能重试）。 */
  const [reloadKey, setReloadKey] = useState(0);
  /** 图片放大（A6）：气泡内是受限缩略图，点击看原图；Esc/点遮罩关闭。 */
  const [zoomOpen, setZoomOpen] = useState(false);
  const zoomPanelRef = useRef<HTMLDivElement | null>(null);
  useModalA11y(zoomPanelRef, () => setZoomOpen(false), { active: zoomOpen, autoFocus: false });

  useEffect(() => {
    let alive = true;
    let owned: string | null = null; // 本 effect 实例持有的 objectURL（闭包内跨 then/cleanup 可见）
    setUrl(null);
    setFailed(false);
    const load: Promise<string> = file.key
      ? downloadEncryptedFile(file.id, file.key, file.mime).then((b) => URL.createObjectURL(b))
      : fetchFileBlobUrl(file.id);
    load
      .then((u) => {
        if (!alive) {
          URL.revokeObjectURL(u); // 晚到的结果：无人再用，直接销
          return;
        }
        owned = u;
        setUrl(u);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
      if (owned) URL.revokeObjectURL(owned);
    };
  }, [file.id, file.key, file.mime, reloadKey]);

  if (failed) {
    return (
      <div
        role="alert"
        className="mt-1 flex items-center gap-2 rounded-md border border-line bg-surface px-2 py-1.5 text-ui-sm text-muted"
      >
        <FileIcon width={16} height={16} />
        <span className="min-w-0 truncate">{file.name}</span>
        <span className="shrink-0 text-ui-xs text-muted">加载失败</span>
        <button
          type="button"
          onClick={() => setReloadKey((k) => k + 1)}
          className={`shrink-0 rounded-sm border border-line px-1.5 py-0.5 text-ui-xs text-body hover:bg-subtle-2 ${FOCUS_RING_TIGHT}`}
        >
          重试
        </button>
      </div>
    );
  }
  if (!url) return null; // 取 blob 期间不渲染，避免闪出断链
  return file.mime.startsWith("image/") ? (
    <>
      <button
        type="button"
        aria-label={`查看图片 ${file.name}`}
        className="mt-1 block max-w-full cursor-zoom-in overflow-hidden rounded-md"
        onClick={() => setZoomOpen(true)}
      >
        <img src={url} alt={file.name} className="max-h-40 rounded-md object-cover" />
      </button>
      {zoomOpen ? (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 p-6"
          onClick={() => setZoomOpen(false)}
        >
          <div
            ref={zoomPanelRef}
            role="dialog"
            aria-modal="true"
            aria-label="查看图片"
            className="flex max-h-full max-w-full items-center justify-center"
            onClick={(e) => e.stopPropagation()}
          >
            <img
              src={url}
              alt={file.name}
              className="max-h-[88vh] max-w-[88vw] rounded-sm object-contain"
              data-testid="image-lightbox"
            />
          </div>
        </div>
      ) : null}
    </>
  ) : (
    <a
      href={url}
      download={file.name}
      className="mt-1 flex items-center gap-2 rounded-md border border-line bg-surface px-2 py-1.5 text-ui-sm hover:bg-subtle-2"
    >
      <FileIcon width={16} height={16} />
      <span className="min-w-0 truncate">{file.name}</span>
      <span className="shrink-0 text-ui-xs text-muted">
        {(file.size / 1024).toFixed(1)} KB
      </span>
    </a>
  );
}

/**
 * 音频气泡（Task 5）：audio/* 附件在 image 分支之前路由到此——鉴权取 blob 后渲染
 * `<audio controls>` 播放器，替代通用文件卡。blob 生命周期与 AttachmentPreview 同款：
 * 晚到即销 + cleanup revoke（防 objectURL 泄漏），加载失败给可见占位不出断链播放器。
 * E2E Task 5：fileKey 存在 → 解密后渲染（下载面同 key 判别；无 key 走明文 blob）。
 */
function AudioBubble({
  fileId,
  fileKey,
  mime = "audio/webm",
}: {
  fileId: string;
  fileKey?: string;
  mime?: string;
}): JSX.Element | null {
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let revoked: string | null = null; // 本 effect 实例持有的 objectURL（闭包内跨 then/cleanup 可见）
    let alive = true;
    setUrl(null);
    setErr("");
    const load: Promise<string> = fileKey
      ? downloadEncryptedFile(fileId, fileKey, mime).then((b) => URL.createObjectURL(b))
      : fetchFileBlobUrl(fileId);
    void load
      .then((u) => {
        if (!alive) {
          URL.revokeObjectURL(u); // 晚到的结果：无人再用，直接销
          return;
        }
        revoked = u;
        setUrl(u);
      })
      .catch((e) => {
        if (alive) setErr((e as Error).message);
      });
    return () => {
      alive = false;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [fileId, fileKey, mime]);

  if (err) return <div role="alert" className="mt-1 ui-body-sm text-danger">音频加载失败：{err}</div>;
  return url ? (
    <audio
      controls
      src={url}
      aria-label="语音消息"
      className="mt-1 w-full max-w-[260px]"
      data-testid="audio-bubble"
    />
  ) : null;
}

/**
 * 消息 → 上下文行（d.187）：`/compact` 与上下文用量指示必须用同一口径。
 *
 * 为什么抽成函数：两处都要「e2e 解不开的不算（与提示词同口径）、文档正文拼进同一条、
 * 空内容不算」。任何一处单独改口径，用户看到的用量数字就会与真正发出去的内容对不上。
 */
function contextRowsOf(msgs: Message[], plainOf: Record<string, unknown>): ChatMessage[] {
  const rows: ChatMessage[] = [];
  for (const m of msgs) {
    if (m.enc === "e2e" && !plainOf[m.id]) continue;
    const docText = m.payload.file?.text;
    const content = docText
      ? `${m.payload.text}\n\n${docFileBlock(m.payload.file!.name, docText)}`
      : m.payload.text;
    if (!String(content ?? "").trim()) continue;
    rows.push({ role: m.senderType === "user" ? "user" : "assistant", content });
  }
  return rows;
}

/**
 * 极简对话页。
 *
 * d.147 外壳重构后它只被 `AssistantPage` 以「整页」形态挂载：顶部一条细栏里
 * 是返回（清空当前会话）与对话标题（h2，喂给读屏与设计审计的第二级标题），
 * 右侧是通道状态、会话进度开关与搜索入口（导出与「选择消息」已随 d.147.4.89.11 移除）。
 */
export function ChatPage({
  // 待确认超时可注入：生产用 60 分钟，测试用它把「超时 → 拒绝 + 留痕」跑到，
  // 不必依赖 fake timers（那会与流式/等待逻辑互相打架）。
  hitlTimeoutMs = HITL_APPROVAL_TIMEOUT_MS,
}: { hitlTimeoutMs?: number } = {}) {
  const convId = useUiStore((s) => s.activeConversationId)!;
  const leave = useUiStore((s) => s.leaveConversation);
  const taskDraft = useUiStore((s) => s.taskDraft);
  const consumeTaskDraft = useUiStore((s) => s.consumeTaskDraft);
  /** d.198：左栏搜索命中投递的「跳到某条消息」意图（null=无）。 */
  const messageJump = useUiStore((s) => s.messageJump);
  const consumeMessageJump = useUiStore((s) => s.consumeMessageJump);
  const conversations = useChatStore((s) => s.conversations);
  const messages = useChatStore((s) => s.messages[convId] ?? EMPTY_MESSAGES);
  /** A1：历史三态（加载中 / 失败 / 加载成功且为空）按会话分桶读。 */
  const messagesLoading = useChatStore((s) => s.messagesLoading[convId] ?? false);
  const messagesError = useChatStore((s) => s.messagesError[convId] ?? null);
  // 编排条数据：会话级轨迹进度 + 本会话进行中的后台任务数（T32）。
  const progress = useConversationProgress(convId);
  const tasks = useTaskStore((s) => s.tasks);
  const runningTaskCount = tasks.filter((t) => t.conversationId === convId && t.status === "running").length;
  /** 本会话是否已经完成过一次历史拉取（含失败）：首帧骨架与「真空态」的区分依据。 */
  const [historyLoaded, setHistoryLoaded] = useState<Record<string, boolean>>({});
  const plainById = useChatStore((s) => s.plainById);
  const appendMessage = useChatStore((s) => s.appendMessage);
  const renameConversation = useChatStore((s) => s.renameConversation);
  const streaming = useChatStore((s) => s.streaming);
  const streamOwner = useChatStore((s) => s.streamOwner);
  const upsertStream = useChatStore((s) => s.upsertStream);
  const removeStream = useChatStore((s) => s.removeStream);
  const markStreamOwner = useChatStore((s) => s.markStreamOwner);
  // d.244：不再「挂载即清本会话残留流」——离开页面不再中止流，挂载时可能正有一条在跑。
  // 过期孤儿项交给 `sweepStaleStreams`（60s 无刷新才判死）。
  const sweepStaleStreams = useChatStore((s) => s.sweepStaleStreams);
  const agentsRoster = useChatStore((s) => s.agentsRoster);
  const me = useAuthStore((s) => s.user);
  const [draft, setDraft] = useState("");  /** 最新草稿的只读镜像：重试成功后判断「用户有没有在这期间改过字」。 */
  const draftRef = useRef(draft);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);
  /**
   * 草稿持久化（d.31 · P2-1）：`ChatPage` 常驻（切会话不卸载），草稿却是组件态 ⇒
   * 上一个会话写一半的字会串进下一个会话，刷新还全丢。按会话存盘后各归各位。
   *
   * 写盘做 300ms 节流（每敲一个字写一次 localStorage 没必要），
   * 但切会话 / 发送成功 / 卸载时**立即落盘或清除**，不丢最后几百毫秒的输入。
   */
  const draftSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftSavePending = useRef<{ convId: string; text: string } | null>(null);
  /** 把待写草稿立刻落盘（并清掉定时器）。 */
  const flushDraftSave = useCallback(() => {
    if (draftSaveTimer.current) {
      clearTimeout(draftSaveTimer.current);
      draftSaveTimer.current = null;
    }
    const pending = draftSavePending.current;
    draftSavePending.current = null;
    if (pending) saveDraft(pending.convId, pending.text);
  }, []);
  /** 安排一次节流写盘（同一会话连续输入只写最后一次）。 */
  const scheduleDraftSave = useCallback(
    (cid: string, text: string) => {
      draftSavePending.current = { convId: cid, text };
      if (draftSaveTimer.current) clearTimeout(draftSaveTimer.current);
      draftSaveTimer.current = setTimeout(() => {
        draftSaveTimer.current = null;
        flushDraftSave();
      }, 300);
    },
    [flushDraftSave],
  );
  /** 丢弃待写草稿（发送成功后用：否则几百毫秒前的旧文本会被重新写回去）。 */
  const cancelDraftSave = useCallback(() => {
    if (draftSaveTimer.current) {
      clearTimeout(draftSaveTimer.current);
      draftSaveTimer.current = null;
    }
    draftSavePending.current = null;
  }, []);
  // 切会话：先把**上一个会话**还没落盘的草稿写掉（pending 里记的是旧 convId），
  // 再读当前会话的。★ 不能靠卸载重置——ChatPage 常驻是刻意的（保持 WS 与流式状态）。
  useEffect(() => {
    flushDraftSave();
    setDraft(getDraft(convId));
    // 换会话时退出回溯：上一条会话的历史不该在这里被调出来（d.194）。
    setHistoryIndex(-1);
    return () => {
      // 切走/卸载时把最后几百毫秒的输入补上，别丢字
      flushDraftSave();
    };
  }, [convId, flushDraftSave]);
  const [sendNotice, setSendNoticeState] = useState<SendNotice | null>(null);
  /**
   * 轮次打满的那条流（d.167.4.103）：有值 = 输入区上方显示「这一轮用满了 36 轮」+ 继续。
   * 存 streamId 而不是布尔：点「继续」要复用 `retryStream(streamId)`（清旧流、带原 agent 续写）。
   */
  const [roundLimitStreamId, setRoundLimitStreamId] = useState<string | null>(null);
  /** 命令面板（d.184）当前高亮的行；面板项变化时按长度收口，不越界。 */
  const [slashIndex, setSlashIndex] = useState(0);
  /**
   * 工作区自定义命令（d.240）：`.heming/commands/*.md` 解析来的 `/名字`。
   *
   * ref 与 state 同时维护：面板要跟着 state 重渲染，而 `submitMessage` 在事件回调里
   * 执行、闭包可能落后一拍，展开命令必须读 ref 才不会「刚写完文件就点发送却用了旧列表」。
   */
  const [customCommands, setCustomCommands] = useState<CustomCommand[]>([]);
  const customCommandsRef = useRef<CustomCommand[]>([]);
  /** 是否真读过一次（区分「读到 0 条」与「还没读」：`/status` 不能把没读过说成没有）。 */
  const customCommandsLoadedRef = useRef(false);
  /**
   * 工作区自定义子代理（d.287）：`.heming/agents/*.md` 定义的角色，派 `agent_task` 时点名用。
   *
   * 只用 ref 不用 state：定义不进界面、只进工具 spec 与 `/status`，没必要为它多一轮渲染。
   * 定义变化时必须清掉工具桥缓存，否则 `agent_task` 的 spec 里还是旧的那几个名字。
   */
  const subagentDefsRef = useRef<SubagentDef[]>([]);
  const subagentDefsLoadedRef = useRef(false);
  /**
   * 输入框历史回溯位置（d.194）：`-1` = 不在回溯里（框里是用户自己的草稿）。
   * `draftStashRef` 存进入回溯前的那半句草稿，一路按 ↓ 走到头要原样放回去。
   */
  const [historyIndex, setHistoryIndex] = useState(-1);
  /** 模型切换弹窗（d.195）：点输入区右下角的模型名打开。 */
  const [modelSwitcherOpen, setModelSwitcherOpen] = useState(false);
  const draftStashRef = useRef("");
  /*
   * 为什么给「继续」（d.176.4.105）：轮次到顶和预算到顶都会让答案停在半路，
   * 但说明不同——前者是「工具调用次数用完」，后者是「这一轮上下文塞满了」。
   */
  const [continueReason, setContinueReason] = useState<ContinueReason>("rounds");
  /** 计划模式下这一轮「只给方案」结束了：给一次「接受计划，开始执行」（d.173）。 */
  const [planReadyStreamId, setPlanReadyStreamId] = useState<string | null>(null);
  /**
   * 后台作业盯梢（d.182）：作业不会被 await，这一轮收口后由这里接着盯。
   *
   * - `watchedJobs` 只是**投影**：状态来自主进程，界面不自己推断「大概跑完了」；
   * - `jobWatchRef` 持有当前轮询的 AbortController：切会话/下一轮开始要停掉，
   *   否则旧会话的作业条会盖在新会话上；
   * - `jobMetaRef` 记住「是哪条流的作业」，点「继续」时要用同一个 agent 发续写口令。
   */
  const [watchedJobs, setWatchedJobs] = useState<WatchedJob[]>([]);
  const jobWatchRef = useRef<AbortController | null>(null);
  const jobMetaRef = useRef<{ agentId: string; name: string; taskId?: string } | null>(null);
  /**
   * 计划模式（d.173）：本轮只读、先出方案。
   *
   * 存在会话上而不是全局：同一个用户可能「这个会话只想让它在旁边看」，另一个会话
   * 又要它直接改。切换会话时重新读一次；脏数据当作关闭（它不是安全边界，只是意图开关）。
   */
  const [planMode, setPlanMode] = useState<boolean>(() => loadPlanMode(convId));
  /**
   * 安全范围（d.242）：聊天框左下角那一档，用户语言是「手动 / 自动 / 完全」。
   *
   * 内部落到 HITL 档位（`hitlPolicy`）+ 「完全」时的全放行开关（`safetyScope.ts` 的
   * 进程内标志）。这里再存一份 state 只是为了按钮文案与菜单勾选能立刻刷新——
   * 真正的判定始终读 `hitlPolicy` 与 `isDangerAuto()`（设置页改过档位也不会漂移）。
   */
  const [safetyScope, setSafetyScope] = useState<SafetyScope>(() =>
    scopeOfPolicy(hitlPolicy.get(), isDangerAuto()),
  );
  /** 安全范围菜单是否展开。 */
  const [safetyOpen, setSafetyOpen] = useState(false);
  /**
   * 「完全」的二次确认（d.242）：`true` 表示已经提醒过一次、下次点击才真开。
   * 用 ref 而不是 state——它不需要触发渲染，只是「上一次点的是不是同一个选项」。
   */
  const safetyConfirmRef = useRef(false);
  /**
   * 分叉降级提示（d.56）：来源日志重建不出前缀时，本次按普通重跑执行。
   *
   * 为什么单独占一行、不并进 `sendNotice`：输入区提示会在发送成功后被清空，
   * 而「这次其实没复用前缀」必须在整轮运行期间都看得见——否则用户会以为分叉生效了。
   */
  const [forkNotice, setForkNotice] = useState<string | null>(null);
  /** info 提示 3 秒自动消失的定时器（新提示/切换会话/卸载时清）。 */
  const sendNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * 写提示行：text=null 清除；kind=info 3 秒后自动消失，error 保留到下一次操作。
   * 与旧 setSendNotice(string) 调用面兼容（缺省 info）。
   */
  const setSendNotice = useCallback(
    (text: string | null, kind: "info" | "error" = "info", retry?: () => void) => {
      if (sendNoticeTimer.current) {
        clearTimeout(sendNoticeTimer.current);
        sendNoticeTimer.current = null;
      }
      if (text === null) {
        setSendNoticeState(null);
        return;
      }
      setSendNoticeState(retry ? { kind, text, retry } : { kind, text });
      if (kind === "info") {
        sendNoticeTimer.current = setTimeout(() => {
          sendNoticeTimer.current = null;
          setSendNoticeState(null);
        }, 3000);
      }
    },
    [],
  );
  useEffect(
    () => () => {
      if (sendNoticeTimer.current) clearTimeout(sendNoticeTimer.current);
    },
    [],
  );
  /** 附件上传进行中（A8）：四个入口禁用 + 提示行占位；ref 兜底防同帧连点。 */
  const [uploading, setUploading] = useState(false);
  const uploadingRef = useRef(false);
  /** 待发附件列表（E1）：选完不立即发送，可核对/移除，发送时随正文一起提交。 */
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  /**
   * 并行子代理的进度（d.200）：只渲染「有子代理在跑」时的状态条。
   *
   * 进度来自 `subagentRuns` 内存表（`onProgress` 推入），面板据此显示真实轮次与
   * 正在调的只读工具——不给百分比。`subagentStopsRef` 是界面上的「停止」：它**只**
   * 中断子代理，不中断主对话（两个信号在 `withSubagentTool` 里取或）。
   *
   * 按会话存（d.226）：两个会话可以各跑各的，界面上的「停止」只能停眼前这个会话的
   * 子代理。以前是一个共享的 ref——A 会话的子代理在跑、用户切到 B 会话点停止，
   * 停掉的是 A 那一批（而 B 的还在跑），两边都说不上对。
   */
  const subagentRuns = useSyncExternalStore(subscribeSubagentRuns, listSubagentRuns);
  const subagentStopsRef = useRef<Record<string, AbortController | null>>({});
  /**
   * 主对话进度（d.214）：第几轮、正在执行哪个工具、已经跑了多久。
   *
   * 只报事实：轮次与工具名都是模型真的做过的事，不编百分比（没人知道还差几轮）。
   * 收口/停止/切会话都清掉，免得上一轮的数字留在屏幕上被当成「现在还在跑」。
   */
  const turnProgress = useSyncExternalStore(subscribeTurnProgress, () => getTurnProgress(convId));
  /** 让「已跑 X 秒」自己往前走：只有真的在跑时才开秒表；收口后（小结）不需要再 tick。 */
  const [progressNow, setProgressNow] = useState(0);
  useEffect(() => {
    if (!turnProgress || turnProgress.done) {
      setProgressNow(0);
      return;
    }
    setProgressNow(Date.now());
    const timer = window.setInterval(() => setProgressNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [turnProgress]);
  /**
   * 右侧「会话进度」栏的开合（Codex 式：header 右上角一颗按钮呼出，再点或点关闭收起）。
   *
   * 状态放在 ChatPage 本地而不是 ui store/shell：这条栏只属于「当前会话」，
   * 换会话或切页面时组件卸载，开合自然回到默认隐藏——不需要额外的清理 effect。
   */
  const [progressOpen, setProgressOpen] = useState(false);
  /**
   * 「我的任务」面板（d.259）：把派到名下的团队任务变成一键可做的东西。
   * 只是开合，任务列表由面板自己打开时去拉（不轮询、不开页面不请求）。
   */
  const [myTasksOpen, setMyTasksOpen] = useState(false);
  /**
   * 「我的任务」角标（d.263）：派到我名下的活有多少、队里有多少可以接。
   *
   * 拉取时机：挂载时一次 + 窗口重新获得焦点时一次 + 每轮对话开始时复用
   * my-tasks 那份（每轮本来就要拉给提示词用，不额外请求）。不做定时轮询——
   * 团队任务的时效性是「分钟级」而不是「秒级」，为它多一条常驻轮询不值。
   */
  const [myTaskBadge, setMyTaskBadge] = useState<MyTaskBadge | null>(null);
  /**
   * 智能体自己打开进度栏时给的一句理由（d.245）：显示在栏内顶部，
   * 让用户知道「这一栏不是自己弹出来捣乱的，是它觉得这里值得看」。
   */
  const [panelAgentReason, setPanelAgentReason] = useState<string | null>(null);
  /** 这一轮是否已经自动开过栏（d.245）：一轮最多抢一次镜。 */
  const panelAutoOpenedRef = useRef(false);
  /** 用户手动关栏的时间（d.245）：关掉就是关掉，安静期内不再自动打开。 */
  const panelManualClosedAtRef = useRef<number | null>(null);
  /** 已经处理过哪一轮的自动开栏判定（按 turnProgress.startedAt 归零 autoOpened）。 */
  const panelRunStartedAtRef = useRef(0);
  /**
   * 进度栏「关键时刻自动打开」（d.245）。
   *
   * 判据在 `lib/agentRuntime/panelAuto.ts` 里（纯函数、可单测），这里只负责把事实喂进去：
   * 一轮跑多久、调了几次工具、用户是不是刚把栏关掉。
   *
   * 为什么**只**看「跑得久 + 多步」：等你确认时对话里已经顶着确认卡（那就是入口），
   * 再自动摊开一栏属于重复打扰；需要中途展示时由模型显式调 `panel_show`。
   */
  useEffect(() => {
    // 新一轮重新给一次自动打开机会：startedAt 变了就当上一轮的「已开过」失效。
    if (turnProgress && !turnProgress.done && turnProgress.startedAt !== panelRunStartedAtRef.current) {
      panelRunStartedAtRef.current = turnProgress.startedAt;
      panelAutoOpenedRef.current = false;
    }
    const runningMs =
      turnProgress && !turnProgress.done
        ? Math.max(0, (progressNow || Date.now()) - turnProgress.startedAt)
        : 0;
    const decision = decidePanelAutoOpen({
      open: progressOpen,
      autoOpenedThisRun: panelAutoOpenedRef.current,
      manualClosedAt: panelManualClosedAtRef.current,
      now: Date.now(),
      runningMs,
      tools: turnProgress?.tools ?? 0,
    });
    if (!decision.open) return;
    panelAutoOpenedRef.current = true;
    setProgressOpen(true);
    setPanelAgentReason("这一轮跑得比较久。");
    if (decision.notice !== null) setSendNotice(decision.notice, "info");
  }, [progressOpen, progressNow, turnProgress]);
  /*
   * 「我的任务」角标拉取（d.263）：挂载一次 + 窗口重新获得焦点一次。
   *
   * 为什么不做轮询：团队任务的时效性是分钟级，不是秒级；而且每轮对话开始时
   * my-tasks 那份请求本来就会打（给提示词用），复用它刷新角标不增加请求量。
   * 读失败保持原状——宁可暂时不显示，也不把「服务端读不到」渲染成「你没有活」。
   */
  useEffect(() => {
    let alive = true;
    const load = () => {
      void fetchMyTeamTasks()
        .then((res) => {
          if (!alive) return;
          setMyTaskBadge(summarizeMyTasks(res.tasks ?? [], res.claimable ?? []));
        })
        .catch(() => {
          /* 读不到不更新：角标是提示，不是事实断言 */
        });
    };
    load();
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => {
      alive = false;
      window.removeEventListener("focus", onFocus);
    };
  }, []);
  /**
   * 当前会话的目标（d.201）：有目标才渲染 GoalBar；提示词里也只在有目标时写这段。
   *
   * 与清单同源的理由：目标存在 localStorage，`/goal` 命令改它，组件必须订阅才看得到。
   */
  const sessionGoal = useGoal(convId);
  /**
   * 子代理写盘授权（d.202）：默认关，只有用户发 `/subagent write on` 才打开。
   *
   * 为什么不用模型参数开：子代理跑在工具调用闭包里，没有人能弹窗问「这个写要不要
   * 允许」——若让模型自己开，等于给了一条无人看守的写路径。授权只看这个用户开关，
   * 打开后子代理也只多拿 file_write / file_edit，且落盘都记进「本轮可撤回」。
   */
  const [subagentWrite, setSubagentWrite] = useState(() => isSubagentWriteEnabled(convId));

  /**
   * 后台作业面板（d.203）：把 d.180 的作业表搬到界面上。
   *
   * 为什么需要：模型说「我在跑构建」之后，用户界面上没有任何迹象——以为卡死就点停止，
   * 把跑了几分钟的活掐断。面板只报事实（状态/耗时/退出码/日志），不编进度。
   *
   * 数据来自主进程的作业表（轮询 shell:jobs），不区分「谁起的」：用户自己起的、
   * 模型起的，都是这个应用里在跑的进程，界面都该看得见。
   */
  const shellJobs = useSyncExternalStore(subscribePanelJobs, listPanelJobs);
  /** 面板操作（看日志/停止）失败时的提示；成功时清空。 */
  const [jobNotice, setJobNotice] = useState<string | null>(null);
  /**
   * 运行中插话（d.199）：这一轮还在跑时用户补的话。
   *
   * 消息照常落库（用户看得见自己的话）；正文进这个队列，编排层每开一个工具轮
   * 取走一次——模型下一步就能看到，而不是等这一轮彻底结束。这一轮先收尾的，
   * 由 `onRunSettled` 里另起一轮接着处理，绝不静默丢。
   *
   * 只在内存里：它属于「还没被模型看到的那几句」，刷新后消息本身仍在会话里。
   *
   * 按会话存（d.226）：两个会话可以同时各跑一轮，排队的话只能喂给**说这话的那个
   * 会话**。以前是一个共享队列——A 会话在跑时用户切到 B 会话插一句，B 的下一轮
   * 会先看到 A 的那句（谁都没报错，但上下文串了）。隔离逻辑在 `steerQueues.ts`，
   * 有独立单测盯着「两个会话取不走对方的话」。
   */
  const steerQueuesRef = useRef(createSteerQueueRegistry());
  const steerQueueOf = (conversationId: string) => steerQueuesRef.current.of(conversationId);
  /**
   * 收尾自检（d.232）：这次用户输入已经催过几次。
   *
   * 按会话记而不是只记一个布尔：两个会话可能在差不多的时刻各跑一轮，互相不该影响。
   * 计数在 `submitMessage`（用户亲自开口）里归零——「一次用户输入最多催一次」的边界是
   * 用户的消息，不是轮次：催完之后仍不动手就如实停，把判断权交回用户
   * （无限催会让界面变成停不下来的自动循环）。
   */
  const finishGateNudgesRef = useRef<Record<string, number>>({});
  /**
   * 超长消息（d.233）：这一次点击是否已经提醒过。
   *
   * 语义是「第一次拦、第二次放」：不静默截断（模型看到半份日志却不知道缺了后半段，
   * 比不发更糟），但也绝不替用户决定「这条不许发」——他要发就再点一次。
   * 草稿一改就复位：换了内容，之前那次「确认」不该继续生效。
   */
  const largeSendConfirmedRef = useRef(false);
  /**
   * 排队中的插话条数（d.227）：让用户看得见「我补的那几句还没被取走」。
   *
   * 以前排队是纯内存里的黑盒：连发两句插话，界面上只有一句「已插话」，谁也说不清
   * 还有几条在等、能不能收回。这里只报条数（取走即减），并给一个「取消」入口。
   */
  const [steerPendingCount, setSteerPendingCount] = useState(0);
  /**
   * 上一轮读到的项目约定（d.219）。
   *
   * d.174 起每轮都会读 `AGENTS.md` 一族并注入提示词，但那是**静默**的：用户既不知道
   * 读没读到，也不知道被截断了没有——`/status` 里把这三个事实说出来，才谈得上「可核对」。
   * 用 ref 而不是 state：它只在 `/status` 被调用的那一刻读一次，不需要触发重渲染。
   */
  const projectRulesRef = useRef<ProjectRulesSummary | null>(null);
  /**
   * 工作区工具 hooks（PreToolUse）的运行器。
   *
   * 放在组件实例上而不是模块级：缓存按工作区根失效，换会话/换工作区必须是另一份；
   * 组件卸载（切页）后配置缓存也应当丢掉，不要让旧工作区的规则跟着新会话走。
   * 桥用 getter 延迟取（桌面端注入时机早于首轮，但测试里可能是后挂的）。
   */
  const toolHooksRef = useRef<ToolHookRunner | null>(null);
  if (!toolHooksRef.current) {
    toolHooksRef.current = createToolHookRunner({
      getFileBridge,
      getShellBridge,
      getRoots: fileRootsFor,
    });
  }
  // 切会话即清：待发附件属于当前会话的输入上下文，跟到别的会话里发出去是错的
  useEffect(() => {
    setPendingFiles([]);
    // 插话队列按会话存（d.226），换会话时不必清：那个会话的队列只归它自己；
    // 这里只把「上一个会话的停止信号」放下，免得切回来时按钮还指着旧控制器。
    resetSubagentRuns();
    resetTeamRuns();
    subagentStopsRef.current[convId] = null;
    // 子代理写盘授权按会话记：换会话要看那个会话自己的开关，不能顺延过来
    setSubagentWrite(isSubagentWriteEnabled(convId));
    // 改动对照属于上一个会话那一轮的文件，留在屏幕上会让人以为改的是眼前这个会话
    setChangeDiff(null);
    setSessionChangesOpen(false);
    // 通知去重按会话/标题记：不重置会让上一个会话刚弹过的同类通知挡住这个会话的
    resetTurnNotifyThrottle();
    // 主对话进度属于上一段对话：切过去再看时不该还写着「第 3 轮 · 正在执行 X」。
    // 但已经收口的那条小结（d.218）留着——切回来还能看到「上一次干了多少」，与侧栏徽标同口径。
    if (getTurnProgress(convId)?.done !== true) clearTurnProgress(convId);
    /*
     * 引用的工作区文件同理（d.222 顺手补齐）：那是上一个会话里挑的文件。
     * 带过去要么因为根不同而读不到（现在会明说没读进来），要么把 A 会话的文件悄悄塞进 B 会话的请求里。
     */
    fileRefsRef.current = [];
    setFileRefs([]);
    setFileRefIssue(null);
    // 排队的插话按会话存（d.226）：切过去要显示那个会话自己的排队条数，不是上一个会话的
    setSteerPendingCount(steerQueuesRef.current.of(convId).size());
  }, [convId]);
  /**
   * 点系统通知回到那个会话（d.208）。
   *
   * 桌面端在通知被点时会把窗口拉回前台并回传会话 id（`notify:open`）。不接这条线，
   * 「点通知跳转」就只是一句空话——用户点了没反应，比不弹更糟。
   */
  useEffect(
    () =>
      onDesktopNotifyOpen((conversationId) => {
        if (!conversationId) return;
        const state = useUiStore.getState();
        if (state.activeConversationId !== conversationId) state.openConversation(conversationId);
      }),
    [],
  );
  /**
   * 后台作业轮询（d.203）：只在「还有作业在跑」时每 2 秒拉一次。
   *
   * 为什么用递归 setTimeout 而不是 setInterval：拉一次要等 IPC 回来再排下一次，
   * 否则慢桥下会堆叠请求。为什么跑完就停：作业表是全局的，不需要为已完成的作业
   * 一直发请求；用户点「日志」时再按需预览。
   */
  useEffect(() => {
    const bridge = getShellBridge();
    if (!bridge || !hasJobChannels(bridge)) return;
    let timer: number | null = null;
    let cancelled = false;
    const tick = async () => {
      const ok = await pollPanelJobs(bridge);
      if (cancelled || !ok) return;
      if (hasRunningPanelJobs()) timer = window.setTimeout(() => void tick(), JOB_PANEL_POLL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, []);
  // 会话视图（T32）：对话 / 轨迹 / 上下文三块同页切换，不新开路由。
  const [view, setView] = useState<ChatView>("chat");
  /** 提示位「还有 N 条」的展开状态；提示数量变化时复位（见下方 effect）。 */
  const [noticeExpanded, setNoticeExpanded] = useState(false);
  /** 会话内搜索：只在打开时占用 header 下方一条，不常驻挤压消息区。 */
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchHitId, setSearchHitId] = useState<string | null>(null);
  /** Ctrl+F 唤起后要聚焦的输入框（面板是条件渲染，靠 ref 拿节点）。 */
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  /**
   * d.198：从左栏搜索命中跳过来时要落位的消息 id（落位后短暂高亮，再自动熄灭）。
   * 与 `activeSearchId` 分开：那个是「本会话内搜索」的当前命中，两者互不覆盖。
   */
  const [jumpedMessageId, setJumpedMessageId] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  /** WS 三态：首次连接 / 通道已连接 / 通道断开（用于标题与横幅，不用 connected 二元冒充）。 */
  const [connState, setConnState] = useState<"connecting" | "open" | "closed">("connecting");
  /**
   * 当前会话 id 的同步镜像：WS 回调闭包里的 `convId` 是建立连接时的旧值，
   * 切会话后旧 socket 晚到的事件仍会匹配旧闭包——用它判「是不是眼前这个会话」。
   */
  const convIdRef = useRef(convId);
  /** 断线后恢复的短暂提示（3 秒）。 */
  const [recovered, setRecovered] = useState(false);
  const recoveredTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 卸载时清掉「通道已恢复」的 3 秒定时器，防对已卸载组件 setState
  useEffect(
    () => () => {
      if (recoveredTimer.current) clearTimeout(recoveredTimer.current);
    },
    [],
  );
  /** 表情选择器开关（输入区工具行左上角）。 */
  const [emojiOpen, setEmojiOpen] = useState(false);
  /** 「更多操作」浮层开关（d.147.4.90：左下角圆形 + 号把表情/图片/文件/语音收进一个菜单）。 */
  const [attachOpen, setAttachOpen] = useState(false);
  /*
   * 引用工作区文件（d.175）：用户点选的文件路径（绝对、正斜杠）。
   *
   * 用 ref 同步一份给 `buildSystemPrompt` 读：那个回调是 useCallback 闭包，
   * 点选后立刻发送时 state 还没落到闭包里，读 ref 才不会把「刚选的文件」漏掉。
   * 一回合结束（onRunSettled）清空——引用是「这一轮」的输入，不是长期订阅。
   */
  const [fileRefs, setFileRefs] = useState<string[]>([]);
  const fileRefsRef = useRef<string[]>([]);
  /*
   * 引用里没进来的部分（d.222）。
   *
   * `collectFileRefs` 一直把「读到 / 没读到 / 只给了前 N 字」分开算，但以前只有拼好的段落
   * 进了提示词：用户勾了三个文件、其中一个被删了，模型这一轮就是没看到，而界面上一个字都不说，
   * 于是「它怎么像没看过那份文件」被归因成模型不行。这里把事实摊到引用芯片下面。
   */
  const [fileRefIssue, setFileRefIssue] = useState<FileRefIssues | null>(null);
  const [refPickerOpen, setRefPickerOpen] = useState(false);
  /*
   * 本轮落盘的文件（d.176）：来自 `onRunSettled` 的 `writes`，由工具桥显式返回。
   *
   * 不解析工具结果文案——文案会为了可读性调整，反推出错就是撤错文件。
   */
  const [turnWrites, setTurnWrites] = useState<string[]>([]);
  /**
   * 本会话改动台账（d.210）：只存「哪个文件改过几次」，内容对照仍按需读备份。
   *
   * `getSnapshot` 依赖 `sessionChanges.ts` 的引用稳定性：内容没变时必须返回同一个数组，
   * 否则 `useSyncExternalStore` 会无限重渲染（数据层为此做了按会话快照缓存）。
   */
  const sessionChanges = useSyncExternalStore(subscribeSessionChanges, () => getSessionChanges(convId));
  const [undoing, setUndoing] = useState(false);
  /**
   * 上下文用量（d.187）：`{used, budget}`，按当前模型窗口估算。
   *
   * 只在这里存一份快照，渲染交给 `ContextMeter`（安静档自己隐掉）。
   * 为什么不每帧算：`loadMessages` 是异步的，且用户打字时不需要重算。
   */
  const [contextUsage, setContextUsage] = useState<{ used: number; budget: number; calibrated: boolean }>({
    used: 0,
    budget: 0,
    calibrated: false,
  });
  /** 正在单独撤回的那个文件（d.185；与「全部撤回」互斥的进度显示）。 */
  const [undoingPath, setUndoingPath] = useState<string | null>(null);
  /**
   * 「这一个文件改成了什么」（d.207.4.110）。
   *
   * 数据来自两处真实磁盘内容：改动前 = 主进程写入备份（只读预览），改动后 = 当前文件。
   * 不用工具参数拼——`file_edit` 只给片段，拼出来的对照会漏掉文件其余部分。
   */
  const [changeDiff, setChangeDiff] = useState<ChangeDiffState | null>(null);
  /**
   * 会话级改动回顾（d.210）：这个会话到现在动过哪些文件。
   *
   * `TurnUndoBar` 只看当前这一轮，下一轮就被覆盖；长任务改了十几轮之后，
   * 「一共动了哪些文件」只能靠台账回答（`lib/fileEdit/sessionChanges.ts`）。
   */
  const [sessionChangesOpen, setSessionChangesOpen] = useState(false);
  /**
   * 「这一轮没跑完」的续跑入口（d.189）。
   *
   * 两个来源：用户点了停止（`aborted`，带 streamId，能复用 retryStream），
   * 以及应用重启/关窗后发现上一轮的标记还在（`interrupted`，只能重发续写口令）。
   */
  const [resumeState, setResumeState] = useState<{
    reason: ResumeReason;
    streamId?: string;
    agentId: string;
    agentName: string;
  } | null>(null);
  /** 语音输入进行中（Web Speech API 可用时；不可用时 toggleVoice 给可见提示）。 */
  const [listening, setListening] = useState(false);
  /** 语音双选项浮层（mic 按钮弹出：转文字 / 录音），会话级清理。 */
  const [voiceMenu, setVoiceMenu] = useState(false);
  /** MediaRecorder 录音进行中（录音态提示行与中止收尾共用）。 */
  const [recording, setRecording] = useState(false);
  const wsHandleRef = useRef<WsHandle | null>(null);
  /**
   * d.244：整页卸载标记（切到别的页面 / 关掉会话视图）。
   *
   * 与「切会话」区分开：切会话要中止那一轮的流（用户视线已经移走），
   * 而离开聊天页**不中止**——用户去设置里改个东西再回来，理应还在跑、还在实时输出。
   * 由 `useLayoutEffect` 的 cleanup 置真（layout 清理先于普通 effect 清理，
   * 所以下面 WS effect 的 cleanup 一定能读到它）。
   */
  const unmountingRef = useRef(false);
  /** 语音识别器实例：切会话/卸载时 stop，避免后台继续识别回填草稿。 */
  const recRef = useRef<{ start(): void; stop(): void } | null>(null);
  /** MediaRecorder 录音实例（与 STT 的 recRef 区分）：停录/中止收口都在 onstop。 */
  const voiceRecRef = useRef<MediaRecorder | null>(null);
  /** 录音起点毫秒（Date.now）：<1s 拒发与 60s 上限后的时长判定依据。 */
  const voiceRecStartRef = useRef(0);
  /** 60s 上限定时器 id：onstop 即清，防悬空回调作用于已结束的录音。 */
  const voiceRecTimerRef = useRef<number | null>(null);
  /**
   * 当前录音的「取消」闭包（置取消位 + stop）：切会话/卸载/取消钮共用——
   * 取消位放闭包而非共享 ref，防前一实例的晚到 onstop 误清后一实例的标志。
   */
  const voiceRecCancelRef = useRef<(() => void) | null>(null);
  /**
   * 授权 `await getUserMedia` 挂起期的 pending 占位（身份 token 对象）：voiceRecRef 要到
   * `recorder.start()` 后才有值，此窗口内录音态仍 false、浮层未禁用，不挡住会并发开第二条并
   * 覆写 cancelRef → 首实例取消链断裂（麦克风轨无人停、60s 也管不到、且无「录音中」指示）。
   * finally 只在「仍是本实例占位」时清，不误清后一实例。
   */
  const voiceRecPendingRef = useRef<object | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  /** A3：最近一次滚动是否贴底（距底 <80px）。贴底才跟随新消息/流式文本。 */
  const atBottomRef = useRef(true);
  /** A3：用户上滑期间来了新内容 → 右下角浮动「↓ 新消息」。 */
  const [newBelow, setNewBelow] = useState(false);
  /** A5：刚复制过的消息 id（短暂显示「已复制」）。 */
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * d.294 单条消息重答：待确认的重答（消息 id + 方案），以及正在跑的那条（按钮转「重答中」）。
   *
   * 确认态放在这里而不是每个按钮内部：一次只可能确认一条（用户点了这条就会盖掉上一条），
   * 放消息级 state 反而要处理「取消时清哪一条」。方案随确认态一起存，避免确认期间
   * 目录里的消息变了、点确认时删掉另一批。
   */
  const [regenConfirm, setRegenConfirm] = useState<{ id: string; plan: RegeneratePlan } | null>(null);
  const [regenBusyId, setRegenBusyId] = useState<string | null>(null);
  /** 触发句柄（convId → 集合）：「中断」只 abort 当前会话的流；卸载时全部中止（关页不空烧 token）。 */
  const runsRef = useRef<Record<string, Set<{ abortAll(): void }>>>({});
  /**
   * 本机流元数据（streamId → 触发上下文）：onLocalDelta 回填 agentId、续写沿用同一智能体。
   */
  const streamMeta = useRef<
    Record<string, { agentId: string; name: string; text: string; attachment?: TurnAttachment }>
  >({});
  /** 任务区的流归属（streamId → taskId）：工具步骤与终态写进对应任务记录。 */
  const streamTaskRef = useRef<Record<string, string>>({});
  /** 从任务区投递进来、等连接就绪后自动发送的任务（一次消费一条）。 */
  const [autoTask, setAutoTask] = useState<TaskDraft | null>(null);
  /** 存量自迁移已尝试集（组件生命周期内）：跨 messages.length 变化的 effect 批次去重。 */
  const migratedRef = useRef<Set<string>>(new Set());
  /**
   * 发送侧出站箱（`${chainKid}:${n}` → 明文）：自发消息的 echo 没有对应 recv 链（发送链
   * 只有对方持有），openMessage 解不开——send 时把明文暂存这里，echo 到达时按链索引取回
   * 并落 msgCache（§6 缓存优先，重载后走缓存自解）。上限 200 条溢出丢最旧（Map 插入序）。
   */
  const outboxRef = useRef(new Map<string, PlainEnvelope>());
  /**
   * 链键明文键（d.346）：`chain:<chainKid>:<n>`。msgCache 本按消息 id 存，
   * 但封条那一刻服务端 id 还没回来；同一 (chainKid,n) 在历史里是稳定的，
   * 所以用它做「自己封的那封信」的副键，刷新后也能取回。
   */
  const chainPlainKey = (chainKid: string, n: number) => `chain:${chainKid}:${n}`;
  /**
   * 出站信件的两处落点（d.346）：内存出站箱 + msgCache 的链键副条目。
   *
   * 只记内存会漏一种很常见的场景：消息已经上行、回声（echo）还没回来时刷新/崩溃/断线。
   * 重载后 `plainById` 是空的、msgCache 里也没有这条 id，而服务端只有密文、发送链只在对方
   * 手里——于是一条自己刚发出去的消息永远显示「本机解不开」。链键副条目把明文（仍按
   * msgCache 的 v2 容器加密落盘）存在本机，检查顺序见 `makeOpenHandler`。
   */
  const rememberOutbound = (chainKid: string | undefined, n: number | undefined, plain: PlainEnvelope) => {
    if (chainKid === undefined || n === undefined) return;
    const key = `${chainKid}:${n}`;
    const ob = outboxRef.current;
    ob.set(key, plain);
    if (ob.size > 200) {
      const oldest = ob.keys().next().value;
      if (oldest !== undefined) ob.delete(oldest);
    }
    // 错误是流式瞬态（不入历史、不渲染消息列表）：只留内存，不占缓存额度。
    if (plain.kind === "error") return;
    msgCache.append(convId, {
      id: chainPlainKey(chainKid, n),
      senderId: me?.id ?? "me",
      at: Date.now(),
      plain,
    });
  };
  /** subtle 可用性（每渲染实测）：横幅常驻与全发送路径拦截的统一开关。 */
  const subtleOk = hasSubtle();

  // —— E2E Task 4：会话接线（deps 组装 / 解密 handler / 公钥上云）——

  /** seal 用 deps：sendRaw 走当前 WS 句柄（chaindist 与正文同一连接有序上行）。 */
  const e2eDeps = (): E2eDeps => ({
    fetchPeerKeys: fetchPeerKeysCached,
    sendRaw: (e) => wsHandleRef.current?.send(e),
    now: Date.now,
  });

  /**
   * 解密 handler（注入 chat store）：isForMe 先滤非本机定向 chaindist（硬验收②——
   * 群聊他设备的分发静默忽略不抛错）→ openMessage（chaindist 内自动落链）→
   * chaindist 结果 await sweepDeferred 完成暂挂重扫（store 随即重试占位）→
   * "duplicate"（硬验收③）查明文缓存补齐渲染、缓存无则忽略 → 异常映射
   * e2e_not_for_device=skip、其余=failed 占位。
   */
  const makeOpenHandler = (conv: string): E2eOpenHandler => {
    return async (env, ctx): Promise<E2eOpenOutcome> => {
      const sealed: SealedEnvelope = {
        id: env.id,
        ...(env.senderId !== undefined ? { senderId: env.senderId } : {}),
        ...(env.chainKid !== undefined ? { chainKid: env.chainKid } : {}),
        ...(env.n !== undefined ? { n: env.n } : {}),
        cipher: env.cipher,
        ...(env.createdAt !== undefined ? { createdAt: env.createdAt } : {}),
      };
      if (!isForMe(sealed)) return { status: "skip" };
      // 缓存优先（§6）：已解密过的（含重加密自发消息/本会话已开过的）直接取——
      // 也是 (chainKid,n) 重放/并发 sweep 抢先解开时的补齐路径（硬验收③）。
      // P0-5b：定点取一条（内部同样 touch LRU），不再全量 list + find。
      const cached = msgCache.get(conv, env.id);
      if (cached) {
        // 真实 id 已在：链键副条目没用了（同一段明文存两份会挤占 500 条额度）。
        if (env.chainKid !== undefined && env.n !== undefined) {
          msgCache.remove(conv, chainPlainKey(env.chainKid, env.n));
        }
        return { status: "ok", plain: cached.plain };
      }
      // 链键明文回查（d.346）：封条成功时就以 `chain:<kid>:<n>` 落了副条目，
      // 所以「消息已上行、回声没等到」（刷新/崩溃/断线）也能自己解开，不再落到
      // 「本机解不开这条消息」的占位。命中后用真实 id 再落一条，并删掉副条目。
      const outKey =
        env.chainKid !== undefined && env.n !== undefined ? `${env.chainKid}:${env.n}` : "";
      if (outKey && env.chainKid !== undefined && env.n !== undefined) {
        const chainKey = chainPlainKey(env.chainKid, env.n);
        const sealedBefore = msgCache.get(conv, chainKey);
        if (sealedBefore) {
          msgCache.append(conv, {
            id: env.id,
            senderId: env.senderId ?? sealedBefore.senderId,
            at: env.createdAt ? Date.parse(env.createdAt) || sealedBefore.at : sealedBefore.at,
            plain: sealedBefore.plain,
          });
          msgCache.remove(conv, chainKey);
          return { status: "ok", plain: sealedBefore.plain };
        }
      }
      // 出站箱：自己的 echo 按链索引取回明文（对方能开、自己开不了），落缓存后返回
      const outPlain = outKey ? outboxRef.current.get(outKey) : undefined;
      if (outPlain) {
        outboxRef.current.delete(outKey);
        // 错误是流式瞬态（不入历史/不渲染消息列表）：不落明文缓存，其余（含自发正文）落
        if (outPlain.kind !== "error") {
          msgCache.append(conv, {
            id: env.id,
            senderId: env.senderId ?? "unknown",
            at: env.createdAt ? Date.parse(env.createdAt) || Date.now() : Date.now(),
            plain: outPlain,
          });
          // 封条时写的链键副条目已经用不上了：删掉，别让一条消息占两份额度。
          if (env.chainKid !== undefined && env.n !== undefined) {
            msgCache.remove(conv, chainPlainKey(env.chainKid, env.n));
          }
        }
        return { status: "ok", plain: outPlain };
      }
      // 发送链自解（d.346）：明文缓存按 500 条淘汰后，上面两条都落空——但发送链的
      // 起始键留在本机，可以按 n 重新派生 msgKey，把服务端那份密文再解一遍。
      // 这样「聊得久了，翻回旧消息只剩一句本机解不开」就不会再出现。
      const ctxAad = ctx
        ? ctx.kind === "error"
          ? errorAad(conv, ctx.streamId) // fix I2：错误信封独立 AAD 命名空间
          : chunkAad(conv, ctx.streamId, ctx.index ?? 0)
        : undefined;
      const own = await openOwnMessage(conv, sealed, ctxAad ? { aad: ctxAad } : undefined);
      if (own) {
        msgCache.append(conv, {
          id: env.id,
          senderId: env.senderId ?? "unknown",
          at: env.createdAt ? Date.parse(env.createdAt) || Date.now() : Date.now(),
          plain: own,
        });
        if (env.chainKid !== undefined && env.n !== undefined) {
          msgCache.remove(conv, chainPlainKey(env.chainKid, env.n));
        }
        return { status: "ok", plain: own };
      }
      try {
        const opts = ctx
          ? {
              aad: ctxAad!,
              noDefer: true,
            }
          : undefined;
        const r = await openMessage(
          { id: conv, memberIdOf: (kid) => recvChainOwners(conv)[kid] },
          sealed,
          msgCache,
          opts,
        );
        if (r === "defer") return { status: "defer" };
        if (r === "duplicate") {
          // P0-5b：补齐路径同样走定点 get（全量 list 只留给显式迁移/调试入口）。
          const cached = msgCache.get(conv, env.id);
          return cached ? { status: "ok", plain: cached.plain } : { status: "skip" };
        }
        if (r.kind === "chaindist") {
          await sweepDeferred(conv); // 等重扫完成：store 的 pending 重试直接命中明文缓存
          return { status: "ok", plain: r };
        }
        return { status: "ok", plain: r };
      } catch (e) {
        if ((e as Error).message === "e2e_not_for_device") return { status: "skip" };
        return { status: "failed" };
      }
    };
  };

  /**
   * seal 分发对象（硬验收①的对端集合）：d.54 起只剩「用户 ↔ 智能体」会话，
   * 智能体没有设备公钥，分发对象只有用户自己的设备（多设备自同步）。
   */
  const resolveMembers = async (): Promise<string[]> => (me ? [me.id] : []);

  /**
   * E2E 统一封发：无 subtle 一律拦截给提示且不发送（硬验收⑤——绝不降级明文）；
   * sealMessage 内部先分发 chaindist 再封正文，事件自带 enc/cipher/chainKid/n。
   */
  const sealAndSend = async (plain: PlainEnvelope): Promise<boolean> => {
    if (!hasSubtle()) {
      setSendNotice(NO_E2E_NOTICE);
      return false;
    }
    try {
      const members = await resolveMembers();
      const ev = await sealMessage({ id: convId, members }, plain, e2eDeps());
      if (ev.type === "send_message" && ev.cipher && ev.chainKid !== undefined && ev.n !== undefined) {
        // 出站箱 + 链键明文落缓存（echo 自解用，刷新后也能解）
        rememberOutbound(ev.chainKid, ev.n, plain);
      }
      wsHandleRef.current?.send(ev);
      return true;
    } catch (err) {
      setSendNotice(`发送失败：${(err as Error).message}`, "error");
      return false;
    }
  };

  // d.54：会话只剩「用户 ↔ 智能体」一种，标题恒为智能体名。
  const conv = conversations.find((c) => c.id === convId);

  /*
   * 会话工作区 = 本会话智能体的可写根（d.153.4.95.11）。
   *
   * 文件工具（capability/providers）、HITL 闸门（policy 的 roots 口径）、确认卡预览
   * （patchPreview / preview）都通过 `currentFileRoots()` 读这一份状态。这里不写，
   * 只设了工作区的会话就会出现「工具能写、闸门以为越界」的分裂。
   *
   * 依赖写成 `conv?.workspace`：切到未分组会话（undefined）时也要把状态清空，
   * 否则上一个项目的工作区会继续被当成当前会话的写根。
   */
  useEffect(() => {
    setActiveWorkspace(conv?.workspace);
  }, [conv?.workspace]);
  // 计划模式是「按会话」的意图开关（d.173）：切会话要跟着换，别把上一个会话的只读带过来。
  useEffect(() => {
    setPlanMode(loadPlanMode(convId));
  }, [convId]);
  /*
   * d.189：打开会话时看一眼「有没有一轮没跑完」。
   *
   * 正常收口会清掉标记，所以这里读到东西基本只有两种可能：应用被关掉/崩掉过，
   * 或者那一轮还在跑（同一窗口内的重挂载）。两种情况都值得给一次「继续」——
   * 但**不自动发**，续跑会产生真实请求和工具调用，用户可能只是想回来看看。
   */
  useEffect(() => {
    const point = loadResumePoint(convId);
    if (!point) return;
    setResumeState({
      reason: "interrupted",
      streamId: point.streamId,
      agentId: point.agentId,
      agentName: point.agentName,
    });
  }, [convId]);

  /** 本机流 → 工具调用轨迹（只用于 UI 展示，不进消息、不上行）。 */
  const toolTraceRef = useRef<Record<string, ToolTrace[]>>({});
  /** 已经尝试写过标题的会话 id：防止首条消息连发时重复 PATCH（失败会移除，下次再试）。 */
  const titleSetRef = useRef<Set<string>>(new Set());
  /** 本机流 → 候选链留痕（d.48 路由组）：同样只用于 UI 展示，不进消息、不上行。 */
  const routeTraceRef = useRef<Record<string, RouteAttempt[]>>({});
  /**
   * 自我修改工具桥（self.*）的依赖与预算。
   *
   * 预算跨轮复用：一轮里改了 N 次就到上限，换一轮重新计数——
   * 上限防的是「单轮内自我膨胀」，不是永久限制。
   */
  const selfEditRef = useRef<{ budget: SelfEditBudget; policy: SelfEditStore } | null>(null);
  selfEditRef.current ??= { budget: new SelfEditBudget(), policy: new SelfEditStore() };

  /**
   * MCP 懒预检（用户要求：工具要自动识别并加载）。
   *
   * 应用启动时 App 已自动连过一次，但那次可能失败（uvx 首次下载依赖要一两分钟、
   * 命令不在 PATH、服务当时没起来）。不补这一步，这次对话就会静默地少一批工具——
   * 模型不知道自己本可以用它，用户也看不出发生了什么。
   *
   * **不在挂载时判断**：挂载 effect 里读 registry 会让组件多一个副作用来源，
   * 且 ChatPage 是常驻的，改一次配置就会触发一轮不可预期的重连。
   * 改成发送时现查现判——条件不满足就是一次 Map 查找，成本可忽略。
   */
  const mcpPrefetched = useRef(false);
  /** 补连冷却时间戳：连续失败时不要每发一条消息都去重连（会很吵、也很慢）。 */
  const mcpRetryAtRef = useRef(0);

  /**
   * 是否还有需要补连的服务。异常时返回 false，不拦发送。
   *
   * 判据除了「没发现过工具」，还包括「最近一次连接失败」——
   * 工具快照是落盘的，服务第二天起不来时快照还在，只看 `hasDiscovered`
   * 就会一直显示已连接、也永远不会重连，模型拿着死目录反复失败（MCP 审计 D3）。
   */
  const mcpNeedsConnect = () => {
    try {
      return mcpRegistry.servers().some((s) => {
        if (!s.enabled) return false;
        if (!mcpRegistry.hasDiscovered(s.id)) return true;
        const status = mcpRegistry.status(s.id);
        return status ? status.state !== "connected" : false;
      });
    } catch {
      return false;
    }
  };
  /** 新一轮开始时清掉旧轨迹。 */
  const resetToolTrace = (streamId: string) => {
    toolTraceRef.current[streamId] = [];
  };
  /** 消息署名：自己「我」；智能体会话为智能体名。 */
  const displaySenderName = (m: Message) =>
    m.senderId === me?.id ? "我" : conv?.agent.name;
  /**
   * 流式收口时把「思考 + 工具轨迹」快照成消息转录（d.126-C）。
   *
   * 收口时机很关键：`message_new{streamId}` 一到，store 的 onWsEvent 会立刻移除
   * `streaming[streamId]`，之后就拿不到 reasoning 了——所以必须在转发事件**之前**取。
   * `toolTraceRef` 是本机流的完整轨迹；他机流没有（store 不累积 tools），自然返回 undefined。
   *
   * 中断/异常收口时仍可能是 `running`（没等到 tool_end）：历史里不该显示「调用中」，
   * 统一按「已中断、未拿到结果」的失败态落下，用户回看时不会以为工具还在跑。
   */
  const collectStreamTranscript = (streamId: string): MessageTranscript | undefined => {
    const reasoning = useChatStore.getState().streaming[streamId]?.reasoning;
    const tools = (toolTraceRef.current[streamId] ?? []).map((t) =>
      t.status === "running"
        ? {
            ...t,
            status: "error" as const,
            result: t.result ?? "（生成已中断，未拿到工具结果）",
            endedAt: t.endedAt ?? Date.now(),
          }
        : t,
    );
    if (!reasoning?.trim() && tools.length === 0) return undefined;
    return {
      ...(reasoning?.trim() ? { thinking: reasoning } : {}),
      ...(tools.length > 0 ? { tools } : {}),
    };
  };
  /** 通知：任务收尾进通知中心（用户常在发起任务后切去别处）。 */
  const notifyTaskSettled = (
    taskId: string,
    status: "done" | "failed" | "cancelled",
    detail: string,
  ) => {
    const task = useTaskStore.getState().tasks.find((t) => t.id === taskId);
    const label =
      status === "done" ? "已完成" : status === "failed" ? "执行失败" : "已中断";
    useNotificationStore.getState().push({
      kind: "task",
      key: `task:${taskId}:${status}`,
      title: `${task?.title ?? "任务"}${label}`,
      ...(detail ? { body: detail } : {}),
      taskId,
      ...(task ? { conversationId: task.conversationId } : {}),
    });
  };

  /**
   * 本次要触发的智能体：一对一里「跟谁说话」已由会话本身确定，固定为会话的 agent。
   */
  const effectiveMentions = useMemo(
    () => (conv ? [{ agentId: conv.agent.id, name: conv.agent.name }] : []),
    [conv],
  );

  /**
   * 能力降级的当场提示（工具）：模型不支持函数调用时编排层会静默丢掉 tools，
   * 用户只会觉得「智能体没去查资料」。这里把降级说破，附带该改绑模型的指引。
   * 只提示**已经授权给模型的工具存在**的情况——一个工具都没开时不谈降级。
   */
  const llmProfiles = useLlmStore((s) => s.profiles);
  const llmBindings = useLlmStore((s) => s.bindings);
  /** 「未绑定」提示条里的就地绑定：写本机 agentLlm，与智能体编辑弹窗同一条路径。 */
  const setAgentBinding = useLlmStore((s) => s.setBinding);
  const toolsNotice = useMemo(() => {
    if (mcpRegistry.enabledTools().length === 0) return null;
    return capabilityNotice(
      "tools",
      effectiveMentions.map((m) => ({
        name: m.name,
        profile: (() => {
          const pid = llmBindings[m.agentId];
          return pid ? llmProfiles.find((x) => x.id === pid) : undefined;
        })(),
      })),
    );
  }, [effectiveMentions, llmBindings, llmProfiles]);

  /** agentId → LLM 连接（绑定表解析）：无绑定/连接已删都归为 undefined（发送前拦截与触发共用）。 */
  /**
   * 智能体 → profile：绑定值既可以是连接 id，也可以是 `route.<组id>`
   * （后者由路由层展开成候选链，见 lib/llmRoute.ts）。
   */
  const resolveProfile = resolveBoundProfile;

  /**
   * UX-A：当前会话的智能体是否**未绑定模型**。
   *
   * 与发送前拦截（submitMessage）共用同一个解析器，所以提示出现时发送必然也该被禁用；
   * 提示条与禁用按钮都由这一个判定驱动，不会出现「按钮能点但一说就报错」。
   */
  const unboundAgent = useMemo(
    () => effectiveMentions.find((m) => !resolveProfile(m.agentId)) ?? null,
    // resolveProfile 读的是 store 快照；llmBindings/llmProfiles 变化时这里必须重算
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [effectiveMentions, llmBindings, llmProfiles],
  );

  /** 输入框动作行显示的模型名：与发送前拦截共用同一个 resolveProfile，未绑定就明说。 */
  const composerModelLabel = conv
    ? (resolveProfile(conv.agent.id)?.label ?? "未绑定模型")
    : "未绑定模型";

  /** 空对话示例按当前绑定模型的能力挑选（不支持工具就别给「帮我查一下」这种）。 */
  const emptyExamples = useMemo(() => {
    const profile = conv ? resolveProfile(conv.agent.id) : undefined;
    const caps = profile ? resolveCapability(profile) : null;
    return chatExamplesFor({ tools: caps?.supportsTools, vision: caps?.supportsVision });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conv, llmBindings, llmProfiles]);

  /** 输入框引用：点示例后把焦点交回来，用户可以接着改。 */
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  /** 点空态示例：**只填入**（并落草稿），不提交表单、不发请求。 */
  const applyExample = (text: string) => {
    setDraft(text);
    scheduleDraftSave(convId, text);
    composerRef.current?.focus();
  };

  /**
   * 构造某个智能体这一轮的工具桥。
   *
   * 抽成函数而不是内联在 deps 里：HITL 闸门也要按工具名查风险元数据，
   * 桥必须**是同一个**——查的不是实际执行者的桥 = 问错了人。
   */
  /**
   * 一次 run（一轮对话）内复用同一个工具桥。
   *
   * 每次 `capabilityRegistry.build()` 都是一份新目录：`getTools` 用 A 去执行、HITL
   * 用 B 去查风险，等于问错了人（同名工具在两次构建之间可能已消失/换代）。
   * 缓存到 onStart 清一次：新的一轮必须看到最新的 MCP 目录。
   */
  const toolBridgeRef = useRef(
    new Map<string, ReturnType<typeof capabilityRegistry.build>>(),
  );
  const buildToolsFor = (agentId: string) => {
    const cached = toolBridgeRef.current.get(agentId);
    if (cached !== undefined) return cached;
    // 会话工作区参与文件权限（d.153）：文件提供者会把它派生出一条隐式写根。
    // 直接读 store 而不是用上面那个 `conv`（它可能还没刷新），缓存到 onStart 清空。
    const workspace = useChatStore.getState().conversations.find((c) => c.id === convId)?.workspace;
    const bridge = capabilityRegistry.build({
      agentId,
      conversationId: convId,
      selfEdit: selfEditRef.current!,
      ...(workspace ? { workspace } : {}),
    });
    // 轮次检查点（d.290）：在所有包装**之前**套一层——写盘前把目标文件的原内容读下来，
    // 这样主模型、子代理、工作流的写都会经过它。包在最外层会漏掉子代理（它自己持有内层桥）。
    const capturing = bridge
      ? withRewindCapture(bridge, {
          conversationId: () => convId,
          roots: () => fileRootsFor(useChatStore.getState().conversations.find((c) => c.id === convId)?.workspace ?? null),
        })
      : null;
    // 只读子代理（d.162）：在缓存桥外面包一层 `agent_task`。包在这里而不是做成
    // provider，是因为子代理要「用当前这个智能体绑定的模型」跑子会话，而模型绑定
    // 是按 agentId 查的——provider 拿不到 agentId 对应的路由，也不知道会话工作区。
    // 没有桥（这一轮零工具）时不包：凭空多一个能派子代理的工具会让模型以为有检索能力。
    const withAgents = capturing
      ? withSubagentTool(capturing, {
          agentId,
          conversationId: convId,
          // 进度推给界面（d.200）：谁在跑、第几轮、正在调哪个只读工具；跑在哪一步就报哪一步。
          onProgress: applySubagentProgress,
          // 界面「停止」只管子代理（d.200）：主对话的停止信号仍走 `execOpts.signal`，
          // 两者在 `withSubagentTool` 里取或，任一触发都算中断。
          createSignal: () => {
            const controller = new AbortController();
            subagentStopsRef.current[convId] = controller;
            return controller.signal;
          },
          // 写盘授权（d.202）：只认用户开关，不认模型参数。打开后子代理多拿 file_write /
          // file_edit，落盘路径立刻记进「本轮可撤回」——子代理改的东西也要能整体回滚。
          ...(subagentWrite ? { writable: true } : {}),
          // 自定义子代理（d.287）：`.heming/agents/*.md` 里的角色，点名后只追加一段要求。
          agents: subagentDefsRef.current,
          onWrite: (path: string) => {
            setTurnWrites((current) => (current.includes(path) ? current : [...current, path]));
          },
        })
      : null;
    const wrapped = withAgents
      ? withWorkflowTool(withAgents, {
          agentId,
          conversationId: convId,
          // 工作流的每一步都是一个只读子代理：沿用同一份进度与停止信号，
          // 界面因此既看得见「第几步在跑」，也能一键停掉整条流程。
          onProgress: applySubagentProgress,
          createSignal: () => {
            const controller = new AbortController();
            subagentStopsRef.current[convId] = controller;
            return controller.signal;
          },
        })
      : null;
    // 团队任务（d.347）：带角色、依赖与可写成员的长任务编排。放在工作流之外，
    // 复用同一份进度表与停止信号——界面上「哪位成员在跑」和「第几步在跑」是同一种事实。
    const withTeam = wrapped
      ? withTeamTool(wrapped, {
          agentId,
          conversationId: convId,
          onProgress: (event) => {
            applySubagentProgress(event);
            applyTeamProgress(event);
          },
          onStart: (plan) => {
            beginTeamRun({
              conversationId: convId,
              goal: plan.goal,
              members: teamRunMembersOf(plan, subagentDefsRef.current),
            });
          },
          onFinish: (result) => {
            finishTeamRun(result);
          },
          createSignal: () => {
            const controller = new AbortController();
            subagentStopsRef.current[convId] = controller;
            return controller.signal;
          },
          ...(subagentWrite ? { writable: true } : {}),
          agents: subagentDefsRef.current,
          onWrite: (path: string) => {
            setTurnWrites((current) => (current.includes(path) ? current : [...current, path]));
          },
        })
      : null;
    // 计划模式（d.173）：只留只读工具，执行层再拦一次。
    // 这是**产品意图**不是安全边界——真正的写权限仍由可写根与 HITL 决定。
    // 以**存储**为准，不用渲染闭包里的 `planMode`：`executePlan` 在同一个 tick 里
    // 先写存储再发消息，state 还没落下去；读闭包会拿上一轮的 true，把这一轮的写工具又摘掉。
    // 面板工具（d.245）：模型觉得「该让用户看进度」时自己打开右侧栏（只读、免确认）。
    // 包在这里而不是做成 provider：面板是当前组件实例的状态，provider 拿不到组件。
    const withPanel = withTeam
      ? withPanelTool(withTeam, {
          onOpen: (reason: string) => {
            setProgressOpen(true);
            setPanelAgentReason(reason === "" ? null : reason);
          },
        })
      : null;
    const planOn = loadPlanMode(convId);
    const finalBridge = withPanel && planOn ? withPlanMode(withPanel) : withPanel;
    toolBridgeRef.current.set(agentId, finalBridge);
    return finalBridge;
  };

  /**
   * 开关计划模式（d.173）。
   *
   * 三个动作缺一不可：改 state（提示词与本轮工具立刻变）、落存储（切回来还在）、
   * 清桥缓存（不复用上一轮的写工具桥——缓存是按 agentId 存的，不清理会出现
   * 「界面显示只读、模型手里还是写桥」）。
   */
  const togglePlanMode = () => {
    const next = !planMode;
    setPlanMode(next);
    savePlanMode(convId, next);
    toolBridgeRef.current.clear();
  };

  /**
   * 切换安全范围（d.242）：手动 / 自动 / 完全。
   *
   * 「完全」要点两次：第一次只提醒代价（连删文件、跑命令、改自己的执行环境都不再问），
   * 第二次才真的开。全放行只在**本次运行内**有效（`safetyScope.ts` 故意不落盘），
   * 所以误触最多影响这一次运行，重启即回到默认的「自动」。
   *
   * 判定以存储为准（`hitlPolicy.get()` + `isDangerAuto()`），不看闭包里的 state：
   * 设置页也改同一份策略，闭包可能已经过期。
   */
  const chooseSafetyScope = (scope: SafetyScope) => {
    const currentScope = scopeOfPolicy(hitlPolicy.get(), isDangerAuto());
    if (scope === currentScope) {
      safetyConfirmRef.current = false;
      setSafetyOpen(false);
      return;
    }
    if (scope === "full" && !safetyConfirmRef.current) {
      safetyConfirmRef.current = true;
      setSendNotice(
        "完全权限：连危险操作也不再逐条问（删文件、跑命令、改自己的执行环境都在内），工作区 rules 里的 deny 仍然有效。只在本机本次运行内有效，重启即回到「自动」。要真的开，再点一次「完全」。",
        "info",
      );
      return;
    }
    safetyConfirmRef.current = false;
    const next = policyForScope(scope);
    hitlPolicy.set({ ...hitlPolicy.get(), mode: next.mode });
    setDangerAuto(next.dangerAuto);
    setSafetyScope(scope);
    setSafetyOpen(false);
    setSendNotice(
      scope === "full"
        ? "安全范围已设为「完全」：这一轮起不再逐条确认（含危险操作）。输入区会一直显示提醒，随时点回去就能改回「自动」。"
        : `安全范围已设为「${SAFETY_SCOPE_TEXT[scope].label}」：${SAFETY_SCOPE_TEXT[scope].hint}`,
      "info",
    );
  };

  /**
   * 接受计划、开始执行（d.173）。
   *
   * 两件事必须一起做，缺一件都会让用户觉得「点了没反应」：
   * 1. 关掉计划模式（改 state + 落存储 + 清桥缓存，见 togglePlanMode 的注释）；
   * 2. 发一条用户消息让它照刚才的计划动手——不重发原提问（同 retryStream 的理由：
   *    重发会让模型看到同一问题被问两次、已执行的工具再跑一遍）。
   *
   * 顺序上先落状态再发消息：发送路径会重建工具桥，晚一步就会带着只读桥跑这一轮。
   */
  /**
   * 撤回本轮改动（d.176）：逐个文件走 `file_undo`。
   *
   * 为什么逐个而不是批量：主进程的撤销通道是「一个路径一份备份」，批量要么新增 IPC，
   * 要么在渲染层循环——后者失败时能准确说出「哪几个没撤回」，用户才知道要手工处理什么。
   */
  const undoTurnWrites = async () => {
    const bridge = getFileBridge();
    if (!bridge?.undo) {
      setSendNotice("当前桌面端版本不支持撤回（没有 file:undo 通道）。", "info");
      return;
    }
    const workspace = useChatStore.getState().conversations.find((c) => c.id === convId)?.workspace;
    const roots = fileRootsFor(workspace);
    const targets = [...turnWrites];
    setUndoing(true);
    let ok = 0;
    const failed: string[] = [];
    for (const path of targets) {
      try {
        const res = await bridge.undo({ roots, path });
        if (res.ok) ok += 1;
        else failed.push(path.split("/").pop() ?? path);
      } catch {
        failed.push(path.split("/").pop() ?? path);
      }
    }
    setUndoing(false);
    setTurnWrites([]);
    // 撤回之后对照就没有意义了（旧内容已经回到文件里），弹窗跟着关掉
    setChangeDiff(null);
    setSessionChangesOpen(false);
    if (failed.length === 0) {
      setSendNotice(`已撤回本轮改动的 ${ok} 个文件，已回到改动前的样子。`, "info");
    } else {
      setSendNotice(
        `已撤回 ${ok} 个文件；${failed.join("、")} 没有可用的旧版本（可能之前已撤销过，或这轮是新建）。`,
        "info",
      );
    }
  };

  /**
   * 只撤回这一轮里的某一个文件（d.185）。
   *
   * 为什么需要它：一轮改了五个文件、只有两个不对时，「全部撤回」等于把对的也扔了。
   * 口径与 `undoTurnWrites` 完全一致（同一个 `file_undo` 通道、同一份备份只能用一次），
   * 只是撤成功后把它从清单里去掉，其余保留。
   */
  const undoTurnFile = async (path: string) => {
    const bridge = getFileBridge();
    if (!bridge?.undo) {
      setSendNotice("当前桌面端版本不支持撤回（没有 file:undo 通道）。", "info");
      return;
    }
    const workspace = useChatStore.getState().conversations.find((c) => c.id === convId)?.workspace;
    const name = path.split("/").pop() ?? path;
    setUndoingPath(path);
    try {
      const res = await bridge.undo({ roots: fileRootsFor(workspace), path });
      if (res.ok) {
        setTurnWrites((current) => current.filter((item) => item !== path));
        setSendNotice(`已撤回 ${name}，本轮其它改动保留。`, "info");
      } else {
        const code = "code" in res ? res.code : undefined;
        setSendNotice(
          code === "no-backup" || code === "no-backup-dir"
            ? `撤回 ${name} 失败：没有可用的旧版本（可能之前已撤销过，或这轮是新建）。`
            : `撤回 ${name} 失败：${"error" in res ? res.error : "未知原因"}`,
          "info",
        );
      }
    } catch {
      setSendNotice(`撤回 ${name} 失败：桌面端没有响应。`, "info");
    } finally {
      setUndoingPath(null);
    }
  };

  /**
   * 看某个文件「这一轮改成了什么」（d.207.4.110）。
   *
   * 顺序刻意是「先读备份再读当前」：备份读不出来（新建文件、已被撤销用过）就不必再读当前文件，
   * 而且弹窗能立刻说清为什么看不了。两边都拿到才画对照——只拿到一半的对照是错的。
   */
  const previewTurnChange = async (path: string) => {
    const bridge = getFileBridge();
    if (!bridge?.backupPreview) {
      setSendNotice("当前桌面端版本不支持查看改动（没有 file:backup-preview 通道）。", "info");
      return;
    }
    const workspace = useChatStore.getState().conversations.find((c) => c.id === convId)?.workspace;
    const roots = fileRootsFor(workspace);
    setChangeDiff({ path, loading: true, error: null, before: null, after: null });
    try {
      const before = await bridge.backupPreview({ roots, path });
      if (!before.ok) {
        setChangeDiff({ path, loading: false, error: before.error, before: null, after: null });
        return;
      }
      if (before.binary) {
        setChangeDiff({
          path,
          loading: false,
          error: "改动前的内容是二进制文件，没法画成文字对照（可以看文件大小或用编辑器）。",
          before: null,
          after: null,
        });
        return;
      }
      const after = await bridge.read({ roots, path });
      setChangeDiff({
        path,
        loading: false,
        error: null,
        before: before.text,
        // 读不到当前文件（已被删掉）时按空内容算：对照就全是删除，这是事实
        after: after.ok ? after.content : "",
        ...(before.truncated ? { beforeTruncated: true } : {}),
      });
    } catch {
      setChangeDiff({ path, loading: false, error: "读改动失败：桌面端没有响应。", before: null, after: null });
    }
  };

  /**
   * 在系统文件管理器里定位本轮改动的一个文件（d.234）。
   *
   * 为什么放在这条清单上：落盘之后第一个真问题是「它改的东西在哪儿」。不给入口就得
   * 让人从工作区路径一层层点进去；桌面端只允许已授权根里的路径（越界会结构化失败）。
   */
  const revealTurnChange = async (path: string) => {
    const bridge = getFileBridge();
    if (!bridge?.reveal) {
      setSendNotice("当前桌面端版本不支持在文件夹里显示（没有 file:reveal 通道）。", "info");
      return;
    }
    const workspace = useChatStore.getState().conversations.find((c) => c.id === convId)?.workspace;
    const roots = fileRootsFor(workspace);
    try {
      const res = await bridge.reveal({ roots, path });
      if (!res.ok) {
        setSendNotice(res.error, "error");
        return;
      }
      setSendNotice(res.kind === "directory" ? "已在资源管理器里打开那个目录。" : "已在资源管理器里定位这个文件。", "info");
    } catch {
      setSendNotice("定位失败：桌面端没有响应。", "error");
    }
  };

  /**
   * 打开会话级改动回顾（d.210）。
   *
   * 先挑最近改的那个文件读对照：弹窗一开就有内容，用户再点左边换。
   * 没有 `file:backup-preview`（老安装包）时如实说明——台账还在，但没有内容可对照。
   */
  const openSessionChanges = () => {
    const latest = sessionChanges[0];
    if (!latest) return;
    if (!hasBackupPreviewBridge(getFileBridge())) {
      setSendNotice("当前桌面端版本不支持查看改动内容（只有台账：这个会话改过哪些文件）。", "info");
      return;
    }
    setSessionChangesOpen(true);
    void previewTurnChange(latest.path);
  };

  /**
   * 开始盯后台作业（d.182）。
   *
   * 只在**收口时**接管：作业还在跑就继续轮询，跑完停下并把状态交给 `JobReadyBar`。
   * 读失败/超时都不写「已结束」——作业条宁可显示「还在跑」，也不能让用户以为完成了。
   */
  const startJobWatch = (
    jobIds: string[],
    meta: { agentId: string; name: string; taskId?: string },
  ) => {
    const bridge = getShellBridge();
    const jobOutput = bridge?.jobOutput;
    if (!bridge || typeof jobOutput !== "function" || jobIds.length === 0) {
      setWatchedJobs([]);
      return;
    }
    jobWatchRef.current?.abort();
    const controller = new AbortController();
    jobWatchRef.current = controller;
    jobMetaRef.current = meta;
    setWatchedJobs(jobIds.map((jobId) => ({ jobId, running: true, exitCode: null, stdout: "", stderr: "" })));
    void watchJobs({
      bridge: { jobOutput },
      jobIds,
      signal: controller.signal,
      onTick: (states) => setWatchedJobs(states),
    }).then((result) => {
      if (controller.signal.aborted) return;
      setWatchedJobs(result.jobs);
    });
  };

  /** 点「继续」：作业结束后发一条续写口令，不重发原提问（同 `retryStream` 口径）。 */
  const continueAfterJobs = () => {
    const meta = jobMetaRef.current;
    const jobs = watchedJobs;
    jobWatchRef.current?.abort();
    jobWatchRef.current = null;
    setWatchedJobs([]);
    if (!meta || jobs.length === 0) return;
    void submitMessage(jobContinuePrompt(jobs), [{ agentId: meta.agentId, name: meta.name }], meta.taskId).then(
      (result) => {
        if (!result.ok) setSendNotice(result.error, "error");
      },
    );
  };

  const executePlan = () => {
    const streamId = planReadyStreamId;
    setPlanReadyStreamId(null);
    if (!streamId) return;
    const meta = streamMeta.current[streamId];
    if (planMode) togglePlanMode();
    if (!meta) return;
    // 必须等 React 把 planMode=false 落下去再发：系统提示词是在发送路径里即时拼的，
    // 同一 tick 里发出去，这一轮还会带着「## 计划模式」——界面关了、模型以为还只读。
    window.setTimeout(() => {
      void submitMessage(PLAN_EXECUTE_PROMPT, [{ agentId: meta.agentId, name: meta.name }]).then(
        (result) => {
          if (!result.ok) setSendNotice(result.error, "error");
        },
      );
    }, 0);
  };

  /**
   * 按工具名取风险元数据（闸门分类用）。
   *
   * 只认**我们自己写的桥**的显式声明（self.* 的 riskHint、chart.* / tone.* 的只读）；
   * MCP 桥不提供——它的 `annotations` 是 untrusted hint，服务端自述不算数。
   */
  const toolMetaOf = (name: string, agentId: string) => {
    // 与执行走同一个缓存桥（见 toolBridgeRef 注释）
    return buildToolsFor(agentId)?.meta?.(name);
  };

  /** HITL 待确认请求（工具调用确认弹窗的数据源）。 */
  const pendingHitl = useHitlStore((s) => s.pending);
  /**
   * 跨会话的待确认请求：后台会话的流仍可能在跑，弹窗出现在当前会话里时
   * 必须标出归属，否则用户会把 A 会话的工具调用当成 B 会话的动作。
   */
  const pendingElsewhere = Boolean(pendingHitl && pendingHitl.conversationId !== convId);
  const pendingConv = pendingElsewhere
    ? conversations.find((c) => c.id === pendingHitl!.conversationId)
    : undefined;
  const pendingConvLabel = pendingElsewhere
    ? pendingConv
      ? pendingConv.agent.name
      : pendingHitl!.conversationId
    : undefined;

  /**
   * 收口一次工具确认的**唯一路径**（d.34）：写审计 → 按 key 清通知 → decide。
   *
   * 用户点击与超时都走这里——两条路径各自写一遍审计，迟早会分叉（超时那条忘记留痕）。
   * 审计口径不变：批准与拒绝都记一笔。
   */
  const resolveToolApproval = useCallback(
    (
      pending: PendingConfirm,
      verdicts: HitlVerdict[],
      timeoutNotice?: { title: string; body?: string },
    ) => {
      for (const v of verdicts) {
        const call = pending.calls.find((c) => c.id === v.callId);
        if (!call) continue;
        appendToolAudit(hitlAuditStorage, {
          agentId: pending.agentId,
          action: v.decision,
          // 与确认弹窗同一口径：MCP 工具名是 `服务__工具` 内部命名，留痕里也展示成「服务 · 工具」
          target: `${call.displayName}（${toolNameLabel(call.name)}）`,
          ...(v.decision === "deny" ? { rejected: v.reason ?? "用户拒绝" } : {}),
        });
      }
      // 处理完的那条「待确认」通知要摘掉，否则用户会点开一个已经结束的请求。
      useNotificationStore.getState().removeByKey(`approval:${pending.requestId}`);
      if (timeoutNotice) {
        // 超时也是一次「替他做了决定」，必须让人知道（否则工具悄悄没执行）。
        useNotificationStore.getState().push({
          kind: "approval",
          key: `approval-timeout:${pending.requestId}`,
          title: timeoutNotice.title,
          body: timeoutNotice.body ?? "",
          conversationId: pending.conversationId,
        });
      }
      useHitlStore.getState().decide({ requestId: pending.requestId, verdicts });
    },
    [],
  );

  // 待确认**属于其他会话**时进通知中心（d.34）：用户可能正在别的页面，弹窗未必在视野里。
  // 当前会话的请求不推——弹窗就在眼前，再来一条只是噪音。
  useEffect(() => {
    if (!pendingHitl || pendingHitl.kind !== "tool-call") return;
    if (pendingHitl.conversationId === convId) return;
    useNotificationStore.getState().push({
      kind: "approval",
      key: `approval:${pendingHitl.requestId}`,
      title: `${pendingHitl.agentName} 请求调用工具`,
      body: `${pendingHitl.calls.map((c) => c.displayName).join("、")}（等待确认）`,
      conversationId: pendingHitl.conversationId,
    });
    // 去重键兜底：切回再切走时重复触发也不会重复推。
  }, [pendingHitl?.requestId, pendingHitl?.conversationId, pendingHitl?.agentName, convId]);

  /**
   * 工具确认在等用户时也弹系统通知（d.208）。
   *
   * 应用内通知中心只覆盖「用户还看着这个窗口」的情况；切去别的应用干活时，
   * 那条待确认会一直挂着直到超时按拒绝处理——用户回来发现「它自己拒了」。
   * 同一个 requestId 只提醒一次（`notifyApprovalWait` 内按 requestId 去重）。
   */
  useEffect(() => {
    if (!pendingHitl || pendingHitl.kind !== "tool-call") return;
    notifyApprovalWait(
      pendingHitl.requestId,
      pendingHitl.calls,
      pendingHitl.agentName,
      pendingHitl.conversationId,
    );
  }, [pendingHitl?.requestId, pendingHitl?.kind]);

  // 超时按拒绝收口（d.34）：60 分钟没人裁决，逐项 deny 并留痕。
  useEffect(() => {
    if (!pendingHitl || pendingHitl.kind !== "tool-call") return;
    const requestId = pendingHitl.requestId;
    const timer = setTimeout(() => {
      // 读**当前** pending：排队顶上的可能是另一个请求，requestId 对不上就跳过。
      const current = useHitlStore.getState().pending;
      if (!current || current.kind !== "tool-call" || current.requestId !== requestId) return;
      resolveToolApproval(
        current,
        current.calls.map((c) => ({
          callId: c.id,
          decision: "deny" as const,
          reason: "超时未确认",
        })),
        {
          title: "工具确认已超时（已按拒绝处理）",
          body: current.calls.map((c) => c.displayName).join("、"),
        },
      );
    }, hitlTimeoutMs);
    return () => clearTimeout(timer);
  }, [pendingHitl?.requestId, pendingHitl?.kind, resolveToolApproval, hitlTimeoutMs]);

  /** 流气泡署名：名册优先，兜底「智能体」。 */
  const nameOf = (agentId: string) =>
    (conv && conv.agent.id === agentId ? conv.agent.name : undefined) ??
    agentsRoster.find((a) => a.id === agentId)?.name ??
    "智能体";

  /** 本会话的打字机项（含他机流）：渲染在消息列表尾部。 */
  const streamEntries = Object.entries(streaming).filter(([, s]) => s.conversationId === convId);
  /** 「生成中」提示行只报本机流（他机流错误行短暂停留，不占中断入口）。 */
  const activeLocal = streamEntries.filter(([id, s]) => streamOwner[id] && s.status === "streaming");

  /** 本会话已解密明文（占位判定；未解密消息无记录）。 */
  const plainOf = plainById[convId] ?? NO_PLAIN;
  /**
   * 可渲染消息 = 本会话的消息。保留一层 useMemo 是为了让引用稳定：
   * 窗口化与搜索跳转的 effect 都拿它当依赖，每次渲染都新建数组会让那些
   * effect 反复触发（尤其是 scrollIntoView）。
   *
   * d.248：多一道会话归属闸。`messages` 本已按会话分桶，但「新建会话后看到上一段的记录」
   * 这类症状哪怕只来自一次写错桶（WS 晚到、合并竞态），代价也是用户直接怀疑「串会话了」——
   * 渲染前再按 `conversationId` 过滤一遍，代价是一次 scan（脏数据时才建新数组）。
   */
  const visibleMessages = useMemo(() => {
    const clean = messages.every((m) => m.conversationId === convId);
    return clean ? messages : messages.filter((m) => m.conversationId === convId);
  }, [messages, convId]);
  /**
   * 输入框 ↑ 回溯用的历史（d.194）：只取本会话用户发过的文本。
   *
   * 不新开存储——会话就是历史；另存一份会与「删消息 / 清空会话」漂移。
   * 本地命令（`/compact` 等）由 `historyFrom` 过滤掉，调出来再发一次没有意义。
   */
  const inputHistory = useMemo(
    () => historyFrom(messages.filter((m) => m.senderType === "user").map((m) => m.payload.text)),
    [messages],
  );
  /**
   * 消息列表窗口化（d.33 · P2-2）：只渲染最近 `windowCount` 条。
   *
   * 数据仍全量加载（服务端一次给全、E2E 解密也在数据层），这里只限制同时挂多少
   * DOM 节点——800 条消息 × 每条带引用卡/chips/图表的开销是线性增长的首屏成本。
   * 窗口**只增不减**：往上翻过的历史不因新消息到达被收回（收回去会让阅读位置跳走）。
   */
  const [windowCount, setWindowCount] = useState(DEFAULT_WINDOW);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /**
   * 只滚消息容器本身，绝不调用 `scrollIntoView`。
   *
   * `scrollIntoView` 会把**所有可滚动祖先**一起滚动——包括 App 里
   * `overflow-hidden` 的内容包裹层（overflow:hidden 仍然能被程序滚动）。
   * 流式回答每来一段文本就调用一次时，整个页面会被往上顶几百像素，
   * 表现就是「智能体一回答，页面异常抬高」。直接改本容器的 scrollTop
   * 只影响消息列表，页面其它部分纹丝不动。
   */
  const scrollListToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const el = scrollRef.current;
    if (!el) return;
    if (behavior === "smooth" && typeof el.scrollTo === "function") {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    } else {
      el.scrollTop = el.scrollHeight;
    }
  }, []);
  /** 追加历史前的 scrollHeight：渲染完成后据它补偿 scrollTop，避免内容整体下移一屏。 */
  const prevScrollHeightRef = useRef<number | null>(null);
  const windowedMessages = useMemo(
    () => visibleMessages.slice(-windowCount),
    [visibleMessages, windowCount],
  );
  /** 向更早的方向追加一窗（滚到顶或点「加载更早的消息」）。 */
  const loadEarlierMessages = useCallback(() => {
    const el = scrollRef.current;
    if (!el || windowCount >= visibleMessages.length) return;
    prevScrollHeightRef.current = el.scrollHeight;
    setWindowCount((count) => expandCount(count, visibleMessages.length));
  }, [windowCount, visibleMessages.length]);
  /**
   * 切会话：优先恢复这个会话上次的阅读位置（d.83）。
   *
   * - 没有记录 / 上次本来就贴着最新 → 从最新看起（保持原行为）；
   * - 上次停在历史里 → 记下目标位置，等消息渲染出足够高度后落位（见下一个 effect），
   *   窗口化只增不减，所以恢复时要先把窗口展开到上次那一窗，深历史才回得去。
   */
  const pendingScrollRestore = useRef<{ top: number; windowCount: number } | null>(null);
  useEffect(() => {
    const saved = readChatScroll(convId);
    prevScrollHeightRef.current = null;
    setNewBelow(false);
    if (saved && !saved.atBottom) {
      atBottomRef.current = false;
      setWindowCount((count) => Math.max(count, DEFAULT_WINDOW, saved.windowCount));
      pendingScrollRestore.current = { top: saved.top, windowCount: saved.windowCount };
      return;
    }
    atBottomRef.current = true;
    setWindowCount(DEFAULT_WINDOW);
    scrollListToBottom("auto");
  }, [convId, scrollListToBottom]);

  /**
   * 落位：消息到齐、DOM 高度足够后再设 scrollTop。
   *
   * 高度不够（窗口化把深历史切掉了）就再放一窗，下一轮再试；已经加载全部仍不够时
   * 只能停在能滚到的最深处——不为了对齐数字无限加载历史。
   * 首帧量不出高度（布局未完成 / jsdom）时挂一帧 rAF 重试，最多 30 帧，避免空转。
   */
  const restoreRaf = useRef<number | null>(null);
  const restoreAttempts = useRef(0);
  const applyPendingScrollRestore = useCallback(() => {
    const pending = pendingScrollRestore.current;
    if (!pending) return;
    const el = scrollRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    if (max <= 0) {
      if (restoreAttempts.current >= 30 || restoreRaf.current !== null) return;
      restoreAttempts.current += 1;
      restoreRaf.current = window.requestAnimationFrame(() => {
        restoreRaf.current = null;
        applyPendingScrollRestore();
      });
      return;
    }
    if (pending.top > max + 24 && windowCount < visibleMessages.length) {
      setWindowCount((count) => expandCount(count, visibleMessages.length));
      return;
    }
    pendingScrollRestore.current = null;
    restoreAttempts.current = 0;
    el.scrollTop = Math.max(0, Math.min(pending.top, max));
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    atBottomRef.current = distance < STICK_BOTTOM_PX;
  }, [windowCount, visibleMessages.length]);
  useLayoutEffect(() => {
    applyPendingScrollRestore();
  }, [applyPendingScrollRestore, messagesLoading, convId]);
  useEffect(
    () => () => {
      if (restoreRaf.current !== null) window.cancelAnimationFrame(restoreRaf.current);
    },
    [],
  );
  // 追加后补偿滚动位置：上方长出来的高度要加回 scrollTop，否则正在看的内容会跳走。
  // 用 useLayoutEffect 是为了在绘制前完成补偿，避免看到一帧跳动。
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const prev = prevScrollHeightRef.current;
    if (!el || prev === null) return;
    prevScrollHeightRef.current = null;
    el.scrollTop += el.scrollHeight - prev;
  }, [windowCount]);
  /**
   * 会话内搜索的数据源：只取本机明文。未解开的信封不参与——
   * 搜索需要展示/跳转原文，而密文既搜不到也不该被当成空消息。
   */
  const SEARCH_TOOL_TRACES = 8;
  const SEARCH_TOOL_TEXT_MAX = 4_000;
  /**
   * 工具轨迹也参与搜索（d.236）。
   *
   * 以前只搜消息正文，「那次 grep 到底搜到了什么」「它读的是哪个文件」这类问题在搜索里
   * 一律搜不到，只能一层层展开工具行去翻。这里把工具名、参数与结果一并塞进被搜文本。
   * 代价是同步搜索要处理更多字符，所以：每条消息只收最近 SEARCH_TOOL_TRACES 次调用、
   * 每次调用最多 SEARCH_TOOL_TEXT_MAX 字——长任务里单条命令输出可以到几十万字，不截断会卡住输入。
   */
  const searchableMessages = useMemo(() => {
    const out: { id: string; text: string }[] = [];
    for (const m of visibleMessages) {
      const payload = m.enc === "e2e" ? plainOf[m.id] : m.payload;
      const text = payload && typeof payload.text === "string" ? payload.text : "";
      const toolText = (transcriptOf(m)?.tools ?? [])
        .filter((t) => t.id && t.name)
        .slice(-SEARCH_TOOL_TRACES)
        .map((t) => `${t.name} ${t.args ?? ""} ${t.result ?? ""}`.slice(0, SEARCH_TOOL_TEXT_MAX))
        .join("\n");
      const combined = toolText ? (text ? `${text}\n${toolText}` : toolText) : text;
      if (combined) out.push({ id: m.id, text: combined });
    }
    return out;
  }, [visibleMessages, plainOf]);
  const searchHits = useMemo(
    () => findMessageHits(searchableMessages, searchQuery),
    [searchableMessages, searchQuery],
  );
  // d.235：结果面板的行——每条命中给一句「命中处附近」的摘要，点哪条跳哪条。
  // 以前只有「2/5」这个计数，要找到想看的那一条只能一路按回车。
  const searchRows = useMemo(
    () => buildSearchRows(searchableMessages, searchHits, searchQuery),
    [searchableMessages, searchHits, searchQuery],
  );
  /** 行 → 消息：只为了拿署名（我 / 智能体名），命中列表本身只有 id 与文本。 */
  const searchMessageById = useMemo(
    () => new Map(visibleMessages.map((m) => [m.id, m])),
    [visibleMessages],
  );
  const searchIndex = hitPosition(searchHits, searchHitId);
  const activeSearchHit = searchHits[searchIndex >= 0 ? searchIndex : 0] ?? null;
  const activeSearchId = activeSearchHit?.id ?? null;

  useEffect(() => {
    if (!searchOpen || !activeSearchId) return;
    // 命中可能在窗口之外（那条消息没渲染）——先把窗口扩到包含它（留两条上下文），
    // 扩窗后本 effect 会因 windowCount 变化再跑一次，那时节点已在 DOM 里。
    const index = visibleMessages.findIndex((m) => m.id === activeSearchId);
    if (index >= 0) {
      const needed = countToInclude(index, visibleMessages.length, windowCount);
      if (needed > windowCount) {
        setWindowCount(needed);
        return;
      }
    }
    // 同样不用 scrollIntoView：它会把祖先的 overflow-hidden 包裹层也滚起来，
    // 命中一条历史消息就整页抬高。这里按两个元素的相对位置只调消息列表的 scrollTop。
    const list = scrollRef.current;
    const node = document.getElementById(`msg-${activeSearchId}`);
    if (!list || !node) return;
    const listRect = list.getBoundingClientRect();
    const nodeRect = node.getBoundingClientRect();
    const centered =
      list.scrollTop +
      (nodeRect.top - listRect.top) -
      Math.max(0, (list.clientHeight - nodeRect.height) / 2);
    const max = Math.max(0, list.scrollHeight - list.clientHeight);
    list.scrollTop = Math.max(0, Math.min(centered, max));
  }, [searchOpen, activeSearchId, visibleMessages, windowCount]);

  /**
   * d.198：左栏搜索命中 → 落到那条消息。
   *
   * 按顺序做三件事：①消息还在加载就等；加载完仍找不到这条，说明它已被删除或被清理，
   * 如实说一句再消费掉意图（不静默跳个空）；②它在窗口之外就先把窗口扩到包含它（并留上下文），
   * 扩窗后本 effect 会因 `windowCount` 变化再跑一次；③只滚消息容器（理由同本会话内搜索，
   * 绝不用 `scrollIntoView`），落位后高亮 2.4 秒再熄灭。
   */
  useEffect(() => {
    if (!messageJump || messageJump.conversationId !== convId) return;
    if (messagesLoading) return;
    const index = visibleMessages.findIndex((m) => m.id === messageJump.messageId);
    if (index < 0) {
      consumeMessageJump();
      setSendNotice("那条消息已经不在这个会话里了（可能被删除或被清理）。", "error");
      return;
    }
    const needed = countToInclude(index, visibleMessages.length, windowCount);
    if (needed > windowCount) {
      setWindowCount(needed);
      return;
    }
    const list = scrollRef.current;
    const node = document.getElementById(`msg-${messageJump.messageId}`);
    if (!list || !node) return;
    const listRect = list.getBoundingClientRect();
    const nodeRect = node.getBoundingClientRect();
    const centered =
      list.scrollTop +
      (nodeRect.top - listRect.top) -
      Math.max(0, (list.clientHeight - nodeRect.height) / 2);
    const max = Math.max(0, list.scrollHeight - list.clientHeight);
    list.scrollTop = Math.max(0, Math.min(centered, max));
    setJumpedMessageId(messageJump.messageId);
    consumeMessageJump();
  }, [
    messageJump,
    convId,
    messagesLoading,
    visibleMessages,
    windowCount,
    consumeMessageJump,
    setSendNotice,
  ]);

  // 高亮自灭：只用来回答「落到了哪一条」，看到就够了，久留反而看不清正文。
  useEffect(() => {
    if (!jumpedMessageId) return;
    const timer = setTimeout(() => setJumpedMessageId(null), JUMP_HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [jumpedMessageId]);

  // 切会话时清掉高亮：跳转是「这一眼」的事，不该跟着换到另一段对话里。
  useEffect(() => {
    setJumpedMessageId(null);
  }, [convId]);

  const closeSearch = () => {
    setSearchOpen(false);
    setSearchQuery("");
    setSearchHitId(null);
  };

  const goSearch = (delta: 1 | -1) => {
    // 用「当前高亮」而不是 searchHitId：首次输入时还没有显式选中，
    // 高亮的是第一条，按「下一个」应当去第二条而不是原地不动。
    const next = stepHit(searchHits, activeSearchId, delta);
    if (next) setSearchHitId(next.id);
  };
  /**
   * 启动一次 mention 触发（发送成功 / 错误行重试共用）：
   * deps 全部从 stores + WS 句柄组装；fetchHistory 映射 role 并剔掉刚发出的这条
   * （服务端很可能已入库，否则当前 user 轮会在提示词里出现两遍）。
   * `attachment`：与正文同发的本轮附件——它不进历史，而是直接拼进当前 user 轮
   * （图片内容片 / 文档文本），否则刚上传的附件要等下一轮才进模型。
   */
  const startRun = (
    mentions: { agentId: string; name: string }[],
    text: string,
    taskId?: string,
    attachment?: TurnAttachment,
  ) => {
    // 无 subtle：触发端无法封 chunk/finish——拦截不启动（硬验收⑤：不降级明文回复）
    if (!hasSubtle()) {
      setSendNotice(NO_E2E_NOTICE);
      return;
    }
    /**
     * 分叉（d.56）：任务记录里的 `forkedFrom` 指向来源回合；这里从本机日志重建前缀
     * （assistant.tool_calls + 等长同序 tool 结果），由 agentStream 接在真实历史之后。
     *
     * 三种情况**显式降级为普通重跑**（日志读不到 / 来源版本不兼容 / 前缀重建失败）：
     * 不传 `forkPrefix`（不伪造复用），但仍传 `forkedFrom` 保留来源，并显示原因——
     * 静默变成重跑会让用户以为前缀被复用了。
     */
    const forkTask = taskId
      ? useTaskStore.getState().tasks.find((t) => t.id === taskId)
      : undefined;
    let forkView: ReturnType<typeof rolloutLog.readStream> | null = null;
    if (forkTask?.forkedFrom) {
      try {
        forkView = rolloutLog.readStream(forkTask.forkedFrom.streamId);
      } catch {
        forkView = null;
      }
    }
    const forkRun = resolveForkRun(forkTask, forkView);
    setForkNotice(forkRun.notice ?? null);
    /**
     * 这一轮的流 → 工具调用次数（复盘判「复杂任务」用，d.226）。
     *
     * 放在 `startRun` 的作用域里：一次调用一份计数，两个会话各跑各的不会互相读走。
     * 以前是组件级共享 ref，先收口的那个会话会把后收口那轮的次数读成自己的。
     */
    let turnToolCount = 0;
    const deps: TriggerDeps = {
      getProfile: resolveProfile,
      getPrompt: (agentId) => resolveBasePrompt(useLlmStore.getState().prompts[agentId]),
      fetchHistory: async (historyProfile) => {
        // spec §3：提示词只带近 30 条历史；E2E 信封经 loadMessages 合并
        // （缓存优先 → handler 解密 → 占位）——**解不开的不进提示词**（硬验收⑤）。
        const msgs = (await useChatStore.getState().loadMessages(convId)).slice(
          -HISTORY_MESSAGE_WINDOW,
        );
        const plainOf = useChatStore.getState().plainById[convId] ?? {};
        // 视觉能力按**本智能体绑定的模型**判定。
        const vision = resolveCapability(historyProfile).supportsVision;
        const rows: HistoryRow[] = [];
        const images: VisionImageSlot[] = [];
        // 去重要看「正文」，不是 content：带文档附件时 content 里拼了文件块，
        // 直接比 content 会漏判，当前这轮就会在提示词里出现两遍（history + buildUserTurn）。
        let lastUserRow = -1;
        let lastUserPlain: string | null = null;
        for (const m of msgs) {
          // 本轮同发的附件不进历史：它由 buildUserTurn 拼在当前 user 轮上，
          // 回声若已入库会在这里出现第二份（同一张图发两遍）。
          if (attachment && m.payload.file?.id === attachment.id) continue;
          if (m.enc === "e2e") {
            const p = plainOf[m.id];
            if (!p) continue; // 占位（无法解密）→ 不外发模型供应商
            if (p.kind !== "text" && p.kind !== "file") continue;
          }
          // 附件文本要拼进 content，否则模型看不到文件内容——
          // 此前 `content: m.payload.text` 把附件完全忽略了，
          // 用户传了文件、模型却只能说「我看不到文件」。
          //
          // 拼在正文之后：先让用户的话完整呈现，再跟上文件内容，
          // 模型更容易把「问题」和「参考资料」区分开。
          const docText = m.payload.file?.text;
          const content = docText
            ? `${m.payload.text}\n\n${docFileBlock(m.payload.file!.name, docText)}`
            : m.payload.text;
          // 图片不进正文文本，而是作为内容片（供应商各要各的形状）。
          // 只挂 user 行：assistant 行一旦带 tool_calls，content 必须是字符串，
          // 塞数组内容片会被供应商当非法请求拒掉。
          if (vision && m.senderType === "user" && isVisionImage(m.payload.file)) {
            images.push({ rowIndex: rows.length, file: m.payload.file });
          }
          // 历史里的工具链：assistant 的 tool_calls + 对应的 role:"tool" 结果。
          // 只用当前这轮的转录（`transcriptOf`），且与 assistant 行严格配对——
          // 供应商对「声明了 tool_call 却没有 tool 消息」会直接 400。
          const tools =
            m.senderType === "user"
              ? []
              : (transcriptOf(m)?.tools ?? []).filter((t) => t.id && t.name).slice(-HISTORY_TOOLS_PER_TURN);
          if (tools.length) {
            rows.push({
              role: "assistant",
              content,
              tool_calls: tools.map((t) => ({
                id: t.id,
                type: "function" as const,
                function: { name: t.name, arguments: historyToolArgs(t.args) },
              })),
            });
            for (const t of tools) {
              rows.push({
                role: "tool",
                tool_call_id: t.id,
                name: t.name,
                content: historyToolText(t),
              });
            }
          } else {
            const role = m.senderType === "user" ? "user" : "assistant";
            if (role === "user") {
              lastUserRow = rows.length;
              lastUserPlain = m.payload.text;
            }
            rows.push({ role, content });
          }
        }
        if (lastUserRow >= 0 && lastUserRow === rows.length - 1 && lastUserPlain === text) rows.pop();
        return attachImageParts(rows, images, visionImageDataUrl);
      },
      // 本轮附件拼进当前 user 轮（与历史行的口径一致：文档文本跟在正文后、图片走内容片）。
      // 附件此刻多半还没进历史（WS 回声未到），走历史就得等下一轮才让模型看到图。
      buildUserTurn: async (turnText, profile) => {
        if (!attachment) return { role: "user", content: turnText };
        const docText = attachment.text;
        const content = docText
          ? `${turnText}\n\n${docFileBlock(attachment.name, docText)}`
          : turnText;
        const row: ChatMessage = { role: "user", content };
        // 与历史同一条能力闸：非视觉模型不解密读图（判定与丢弃同源）。
        if (resolveCapability(profile).supportsVision && isVisionImage(attachment)) {
          const data = await visionImageDataUrl(attachment);
          if (data)
            row.contentParts = [
              { type: "text", text: content },
              { type: "image", mime: attachment.mime, data },
            ];
        }
        return row;
      },
      send: (e) => wsHandleRef.current?.send(e),
      // 路由层（d.48）：编排层不理解候选链，只在装配处换成 routed 版本；
      // 智能体绑的是单连接时链长为 1，与旧的 streamChat 逐字等价。
      streamChat: streamChatRouted,
      // Token 用量记账（d.32）：编排层在成功收口前调用一次；
      // null = 供应商一次都没上报 → 记「未上报」，而不是写 0 冒充真实用量。
      // d.148（P0-T2）：served 里带 conversationId/streamId，记账同时可归因到
      // 「哪个会话的哪一回合」——用量面板才答得了「这句话为什么这么贵」。
      recordUsage: (model, tokens, served) =>
        tokens === null
          ? useTokenUsageStore.getState().recordUnreported(model, undefined, served)
          : useTokenUsageStore.getState().record(model, tokens, undefined, served),
      // 候选链留痕（d.48）：换候选这件事要在气泡上看得见，否则用户只看到「突然变慢」。
      // 连接名是本机口径，只进 streaming 状态，绝不进消息体、绝不上行。
      onAttempt: (streamId, attempt) => {
        const meta = streamMeta.current[streamId];
        if (!meta) return;
        const list = (routeTraceRef.current[streamId] ??= []);
        list.push(attempt);
        upsertStream(streamId, {
          agentId: meta.agentId,
          conversationId: convId,
          attempts: [...list],
          status: "streaming",
          lastAt: Date.now(),
        });
      },
      // E2E 流式（硬验收④）：chunk 走 chunkAad（convId+streamId+index）信封、
      // finish 全文进信封——由 agentStream 统一串行上行，加密失败跳过/报错不发明文。
      sealChunk: async (streamId, index, delta) => {
        const members = await resolveMembers();
        const ev = await sealMessage(
          { id: convId, members },
          { kind: "chunk", text: delta },
          e2eDeps(),
          { aad: chunkAad(convId, streamId, index) },
        );
        if (ev.type !== "send_message" || !ev.cipher) return null;
        return { cipher: ev.cipher, chainKid: ev.chainKid, n: ev.n };
      },
      sealFinish: async (full) => {
        const members = await resolveMembers();
        const plain: PlainEnvelope = { kind: "text", text: full };
        const ev = await sealMessage({ id: convId, members }, plain, e2eDeps());
        if (ev.type !== "send_message" || !ev.cipher) return null;
        // finish 的入库 echo 也是自发信封：出站箱 + 链键明文落缓存（同 sealAndSend）
        rememberOutbound(ev.chainKid, ev.n, plain);
        return { cipher: ev.cipher, chainKid: ev.chainKid, n: ev.n };
      },
      // E2E 错误封条（fix I2）：错误正文（可回显供应商请求片段）同款信封上行。
      // fix round 2：登记出站箱——本机触发的错误经 WS 回声没有 recv 链可解，
      // 只能按链索引取回明文；不登记则回声恒降级为通用文案（丢失真实错误原因）。
      sealError: async (streamId, message) => {
        const members = await resolveMembers();
        const plain: PlainEnvelope = { kind: "error", text: message };
        const ev = await sealMessage(
          { id: convId, members },
          plain,
          e2eDeps(),
          { aad: errorAad(convId, streamId) },
        );
        if (ev.type !== "send_message" || !ev.cipher) return null;
        rememberOutbound(ev.chainKid, ev.n, plain);
        return { cipher: ev.cipher, chainKid: ev.chainKid, n: ev.n };
      },
      onLocalDelta: (streamId, acc) => {
        const meta = streamMeta.current[streamId];
        if (!meta) return;
        // 本机流文本已本地累积（不等 WS 回声），回声由 onWsEvent 按 streamOwner 跳过
        upsertStream(streamId, {
          agentId: meta.agentId,
          conversationId: convId,
          text: acc,
          status: "streaming",
          lastAt: Date.now(), // Task 7 watchdog：累积即刷新
          errorMessage: undefined, // 清掉可能残留的 watchdog 误报（恢复即自愈）
        });
      },
      onStart: (streamId, mention) => {
        streamMeta.current[streamId] = { ...mention, text, attachment };
        /*
         * d.189：把「这一轮开始了」记到本机。收口时会清掉，所以只有**真中断**
         * （关窗、崩溃、机器睡死）才会留下这条标记，下次打开才知道要提示「接着做」。
         * 写失败不影响发送——它只是个提示位。
         */
        markTurnRunning({
          conversationId: convId,
          streamId,
          agentId: mention.agentId,
          agentName: mention.name,
          startedAt: Date.now(),
        });
        setResumeState(null);
        // 新一轮开始：上一条「轮次打满」提示已完成使命（继续/改主意都算），清掉；
        // 「计划就绪」同理——新一轮要么在计划里接着聊，要么已经动手了。
        setRoundLimitStreamId(null);
        setTurnWrites([]);
        // d.290：新一轮开始记检查点缓冲——写工具执行前会把原内容抓进来，
        // 收口时（closeRewindTurn）落成一轮 `/rewind` 能退回去的记录。
        // d.292：顺带记下「对话边界」（这一轮之前最后一条消息）与这一轮的提问，
        // 回退时把边界之后的消息删掉、把提问放回输入框。
        const localMessages = useChatStore.getState().messages[convId] ?? [];
        const boundary = localMessages.length > 0 ? localMessages[localMessages.length - 1]!.id : null;
        beginRewindTurn(convId, Date.now(), streamId, boundary, text.trim() ? text : undefined);
        // 上一轮的对照窗口不该跨到新一轮（那时的文件状态已经不是现在这个）
        setChangeDiff(null);
        setSessionChangesOpen(false);
        setPlanReadyStreamId(null);
        if (taskId) {
          streamTaskRef.current[streamId] = taskId;
          useTaskStore.getState().bindStream(taskId, streamId);
        }
        resetToolTrace(streamId);
        // 新的一轮从最新的工具目录起步（上轮缓存的桥可能已过期）
        toolBridgeRef.current.clear();
        routeTraceRef.current[streamId] = [];
        turnToolCount = 0;
        // 新一轮开始：重置自我修改的单轮预算（上轮用掉的次数不该拖累这一轮）
        selfEditRef.current!.budget.reset(mention.agentId, convId);
        markStreamOwner(streamId);
        upsertStream(streamId, {
          agentId: mention.agentId,
          conversationId: convId,
          text: "",
          status: "streaming",
          lastAt: Date.now(),
        });
      },
      // 系统提示词：原提示词 + 运行环境 + 三层记忆 + 命中技能（本机拼装，不出设备）。
      // 组装失败（记忆/技能读写异常）回落原提示词，绝不阻断生成。
      buildSystemPrompt: async (agentId, text) => {
        // d.156：用户没写自定义提示词时用内置人设兜底（只兜底、不拼接；写了就全按用户的）。
        const basePrompt = resolveBasePrompt(useLlmStore.getState().prompts[agentId]);
        /*
         * 运行环境段（d.154）：内置智能体默认没有系统提示词，工具又是单独下发的，
         * 模型因此不知道自己在桌面端、几点、工作区在哪、这轮有几件工具、轮次有上限。
         * 这一段只写**这一轮确认过的物理事实**：桥在哪、根有哪些、工具清单来自同一份
         * capability 桥（与 HITL 判风险的那份同源，提示词和闸门不会各说一套）。
         *
         * 失败只丢这一段（`runtimeSection` 留空），不拖累记忆/技能与生成。
         */
        /*
         * 项目约定段（d.174）：工作区里的 `AGENTS.md` 一族。
         *
         * 模型知道「有哪些工具」不等于知道「这个仓库怎么做」——命令用 pnpm 还是 npm、
         * 改完跑哪套测试、哪些文件是生成的。DSH / Claude Code / opencode 都读这份文件，
         * 这是「像团队里的人」和「像通用聊天机器人」的分界。
         *
         * 失败只丢这一段：读不到就是这一轮没有约定，绝不阻断生成、也不留半句残话。
         */
        let rulesSection = "";
        try {
          const rulesWorkspace = useChatStore
            .getState()
            .conversations.find((c) => c.id === convId)?.workspace;
          const collected = await collectProjectRules({
            bridge: getFileBridge(),
            roots: fileRootsFor(rulesWorkspace),
            workspace: rulesWorkspace,
          });
          rulesSection = collected.section;
          // 顺手留一份只读摘要给 `/status`（d.219）：读没读到、被截断了没有，用户要能核对。
          projectRulesRef.current = summarizeProjectRules(collected);
        } catch {
          rulesSection = "";
          // 读失败 ≠ 工作区里没有约定：保持「尚未统计」，别把读不到说成「没有」。
          projectRulesRef.current = null;
        }

        /*
         * 团队派到我名下的任务（d.248）：让它一开口就知道「团队里有什么活儿在我这儿」。
         *
         * 为什么每轮都拉：任务可能刚被组长改派/改截止；一次请求拿全部团队（`/api/team/my-tasks`），
         * 失败就当没有（不阻断这一轮，也不谎报「没有任务」给模型——这一段干脆不写）。
         */
        let teamTaskLines: string[] = [];
        let teamClaimLines: string[] = [];
        let teamBriefLines: string[] = [];
        try {
          /*
           * 两份一起拉（d.253）：
           * - my-tasks：派到我名下、还没完成的活；
           * - my-teams：我在哪些团队、我是组长还是成员、队友的 id（派活认人用）。
           * 各自失败互不影响——团队功能挂了不该把整轮对话也拖垮。
           */
          const [mine, briefs] = await Promise.all([
            fetchMyTeamTasks().catch(() => null),
            fetchMyTeamBriefs().catch(() => null),
          ]);
          teamTaskLines = mine === null ? [] : describeAssignedTasks(mine.tasks);
          // d.260：队里还没人认领的活（留空的派活）——只作为「可以接」的提示，不混进「派到我名下的」。
          teamClaimLines = mine === null ? [] : describeClaimableTasks(mine.claimable ?? []);
          // d.263：同一份结果顺手刷新角标——派到我名下的活，界面上也要看得见。
          setMyTaskBadge(
            mine === null ? null : summarizeMyTasks(mine.tasks ?? [], mine.claimable ?? []),
          );
          teamBriefLines = briefs === null ? [] : describeTeamBriefLines(briefs.teams);
        } catch {
          teamTaskLines = [];
          teamBriefLines = [];
        }

        /*
         * 本轮引用文件段（d.175）：用户点选的工作区文件内容。
         *
         * 为什么放在提示词里而不是让模型自己读：用户说「就针对这几个文件」时，
         * 让它去猜路径等于多一轮工具调用，猜错还要再来一轮。内容随这一轮给出，
         * 它第一句就能针对文件回答。
         *
         * 读失败只丢这一段：引用不等于授权，根外/读不到的文件由 `fileRefs.ts`
         * 写进「没读到」清单，绝不阻断这一轮。
         */
        let filesSection = "";
        try {
          const refs = fileRefsRef.current;
          if (refs.length > 0) {
            const refsWorkspace = useChatStore
              .getState()
              .conversations.find((c) => c.id === convId)?.workspace;
            const collected = await collectFileRefs({
              bridge: getFileBridge(),
              roots: fileRootsFor(refsWorkspace),
              paths: refs,
            });
            filesSection = collected.section;
            // d.222：读不到 / 被截断都摊到界面上；一句话说清「模型这一轮看不到这些」。
            const issues = fileRefIssues(collected);
            setFileRefIssue(issues);
            if (issues !== null) {
              setSendNotice(describeFileRefIssues(issues), issues.missing.length > 0 ? "error" : "info");
            }
          } else {
            setFileRefIssue(null);
          }
        } catch {
          filesSection = "";
          setFileRefIssue(null);
        }

        let runtimeSection = "";
        try {
          const workspace = useChatStore
            .getState()
            .conversations.find((c) => c.id === convId)?.workspace;
          const bridge = buildToolsFor(agentId);
          const tools = bridge?.tools ?? [];
          // 能力配合（d.241）：按本轮真实注入的工具名分组，让模型知道「知识库 / 团队 / 插件市场」该什么时候用；
          // 刚装过的插件也从安装记录里带过来（下一轮说一次，之后不再重复）。
          const toolNames = tools
            .map((spec) => (spec as { function?: { name?: string } }).function?.name)
            .filter((name): name is string => typeof name === "string" && name.length > 0);
          const newPlugins = peekPluginInstallNotices().map((notice) => ({
            name: notice.name,
            version: notice.version,
            updated: notice.updated,
            servers: notice.servers,
            skills: notice.skills,
          }));
          const capabilities = {
            ...(toolNames.some((name) => name.startsWith("vault_") || name.startsWith("wiki_"))
              ? {
                  knowledgeBaseTools: toolNames.filter(
                    (name) => name.startsWith("vault_") || name.startsWith("wiki_"),
                  ),
                }
              : {}),
            ...(newPlugins.length > 0 ? { newPlugins } : {}),
            ...(toolNames.some((name) => name.startsWith("team_"))
              ? { teamTools: toolNames.filter((name) => name.startsWith("team_")) }
              : {}),
            ...(toolNames.some((name) => name.startsWith("plugin_market_"))
              ? {
                  pluginMarketTools: toolNames.filter((name) => name.startsWith("plugin_market_")),
                }
              : {}),
          };
          // 目标（d.201）：从存储读一次，既写进提示词也给下面的分支判断用。
          const goalText = goalForPrompt(convId);
          let timeZone: string | undefined;
          try {
            timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
          } catch {
            timeZone = undefined; // 老渲染层拿不到时区就只写本地时间，不编一个。
          }
          runtimeSection = buildRuntimeSection({
            desktop: hasFileBridge(),
            platform: describePlatform(
              typeof navigator === "undefined" ? "" : navigator.userAgent,
            ),
            now: new Date(),
            ...(timeZone ? { timeZone } : {}),
            workspace,
            roots: fileRootsFor(workspace).map((root) => ({
              name: root.name,
              path: root.path,
              mode: root.mode,
            })),
            tools: runtimeToolsFromSpecs(tools, (name) => toolMetaOf(name, agentId)),
            toolSearchAvailable: tools.length > TOOL_SEARCH_THRESHOLD,
            maxToolRounds: MAX_TOOL_ROUNDS,
            // 后台作业（d.180）：老安装包没有作业通道时不承诺「能后台跑」。
            hasBackgroundJobs: hasJobRuntime(getShellBridge()),
            // 同理读存储：界面 state 可能还没落，提示词不能说错这一轮是不是只读。
            planMode: loadPlanMode(convId),
            // 任务清单（d.192）：从存储读，界面的 `useTodos` 只是投影，压缩/重启后模型要靠这条基线。
            todos: getTodos(convId),
            // 目标（d.201）：同样从存储读——它是「这一切为了什么」，比清单更该跨轮保持。
            ...(goalText ? { goal: goalText } : {}),
            // 能力配合（d.241）：知识库 / 团队 / 插件市场 / 刚装的插件——让模型知道什么时候该用哪一组。
            ...(Object.keys(capabilities).length > 0 ? { capabilities } : {}),
            ...(teamBriefLines.length > 0 ? { teamBrief: teamBriefLines } : {}),
            ...(teamTaskLines.length > 0 ? { teamTasks: teamTaskLines } : {}),
            ...(teamClaimLines.length > 0 ? { claimableTeamTasks: teamClaimLines } : {}),
          });
        } catch {
          runtimeSection = "";
        }
        try {
          const built = buildAgentContext({
            agentId,
            conversationId: convId,
            userText: text,
            basePrompt,
            rules: rulesSection,
            runtime: runtimeSection,
            files: filesSection,
            memory: memoryStore,
            skills: skillPool,
            // 个性化加权（d.28）：被疑似引用过的记忆在同等相关度下排前面；读不到账本就退化成不加权。
            usage: recallRecorder.usageView,
            // 智能体级记忆偏好（读侧同样生效）：长期/短期/个人数据库关掉就不读那一层。
            // 以前只有写侧（复盘）看这个开关，读侧照旧注入——用户在记忆页关掉后
            // 提示词里还能看到旧记忆，等于开关是摆设。
            agentPrefs: agentPrefsStore.get(agentId),
          });
          // 登记本次注入旁路，供轮次收尾时写召回日志（可观测性；零注入不留档）。
          recallRecorder.capture(agentId, convId, text, built.recallTrace);
          // 记忆/技能层降级时必须说一声：用户看到「它不记得我」时，要能区分
          // 「你没开记忆」/「记忆库读坏了」/「这轮压根没检索」，否则只能瞎猜。
          const degraded: string[] = [];
          if (built.recallTrace?.error) degraded.push(`记忆读取失败（${built.recallTrace.error}）`);
          if (built.skillsError) degraded.push(`技能匹配失败（${built.skillsError}）`);
          if (degraded.length) {
            setSendNotice(`本轮上下文降级：${degraded.join("；")}。这一轮只能凭对话本身回答。`, "info");
          }
          return built.systemPrompt;
        } catch (err) {
          setSendNotice(
            `本轮上下文组装失败：${(err as Error).message}。这一轮只能凭对话本身回答。`,
            "info",
          );
          return basePrompt;
        }
      },
      // 思考过程（reasoning/thinking）：本机展示用，不参与最终消息文本。
      onReasoning: (streamId, text) => {
        const meta = streamMeta.current[streamId];
        if (!meta) return;
        upsertStream(streamId, {
          agentId: meta.agentId,
          conversationId: convId,
          reasoning: text,
          status: "streaming",
          lastAt: Date.now(),
        });
      },
      // 工具调用轨迹：start 立刻出「调用中」，end 补结果与成败。
      onToolTrace: (streamId, e) => {
        const meta = streamMeta.current[streamId];
        if (!meta) return;
        const taskId = streamTaskRef.current[streamId];
        const list = (toolTraceRef.current[streamId] ??= []);
        const idx = list.findIndex((t) => t.id === e.id);
        if (e.phase === "start") {
          turnToolCount += 1;
          const entry: ToolTrace = {
            id: e.id,
            name: e.name,
            args: e.args,
            status: "running",
            startedAt: Date.now(),
          };
          if (idx >= 0) list[idx] = entry;
          else list.push(entry);
          if (taskId) {
            useTaskStore.getState().stepStart(taskId, { id: e.id, name: e.name, args: e.args });
          }
        } else if (idx >= 0) {
          const status = e.denied ? "denied" : e.ok ? "ok" : "error";
          // d.221：失败按稳定错误码记账（被拒的记 denied，绝不和「工具失败」混成一件）。
          // 归到**这条流所属的会话**：切会话后迟到的 end 事件不该记到当前会话头上。
          if (status === "error" || status === "denied") {
            const streamConv = useChatStore.getState().streaming[streamId]?.conversationId ?? convId;
            recordToolFailure(streamConv, {
              tool: e.name,
              ...(e.denied ? { denied: true } : {}),
              ...(e.errorCode === undefined ? {} : { errorCode: e.errorCode }),
              ...(e.result === undefined ? {} : { result: e.result }),
            });
          }
          list[idx] = {
            ...list[idx],
            // 「已拒绝」与「失败」分开：被拒的工具**根本没执行**，
            // 混成失败用户会以为「我拒了，但它还是跑了」。
            status,
            result: e.result,
            // 拒绝来源随轨迹落本机（会话重开后历史回放才能区分 hooks 与用户拒绝）。
            ...(e.denyCause ? { denyCause: e.denyCause } : {}),
            endedAt: Date.now(),
          };
          if (taskId) {
            useTaskStore.getState().stepEnd(taskId, e.id, {
              status,
              ...(e.result === undefined ? {} : { result: e.result }),
              ...(e.sources?.length ? { sources: e.sources } : {}),
              ...(e.denyCause ? { denyCause: e.denyCause } : {}),
            });
          }
        }
        upsertStream(streamId, {
          agentId: meta.agentId,
          conversationId: convId,
          tools: [...list],
          status: "streaming",
          lastAt: Date.now(),
        });
      },
      // 工具调用：MCP 外部工具 + 图表工具（chart.*）+ 自我修改工具（self.*）合并成一个桥。
      // 三者形状一致（OpenAI tools + {name, arguments}），模型不需要分别学几套协议；
      // 执行时按工具名分流到各自的桥，失败都带 ok=false 回给模型而不是抛。
      // getTools 带 agentId 参数（群聊 @ 多个 agent 时逐个构造，self.* 的上下文才准确）。
      //
      // 【默认开启】self.* 一共 13 个工具、描述不算短，但自我优化默认可用、不再提供页面开关
      // （d.148.4.95：产品只有唯一内置智能体，页面不暴露该配置；旧版本里显式关掉过的仍按存储生效）。
      //
      // chart.* 只有 2 个工具、描述短，且不写任何存储、无副作用（只是把数据变成图），
      // 所以默认注入——用户随时可能让智能体画图，不该先去设置里开开关。
      getTools: (agentId: string) => buildToolsFor(agentId),
      // HITL 闸门（设计 §4.3）：工具执行**之前**问用户同不同意。
      //
      // 这是整个 HITL 层的**唯一接线点**：agentStream 在拿到 tool_calls 之后、
      // 调 bridge.execute 之前调它一次。被拒的项不会被执行——
      // 闸门把结果原样带回来，编排层据此改回「未执行」的文案。
      //
      // ★ 闸门异常一律按**拒绝**处理。
      //
      // 「闸门异常不得让整轮对话失败」= 模型总能收到一条 tool 消息，
      // **不是「工具总能执行」**——工具不执行时模型照样收到「未执行」的消息，对话继续。
      // 反过来若这里放行，闸门一坏就等于所有危险工具静默执行，
      // 而那恰恰是最不该放行的时刻。
      //
      // 兜底方向的选择比索引正确性更关键：兜底是 deny 时出错只会「误拒」
      //（用户立刻发现并报告）；兜底是 allow 时出错就是「误放行」，**静默且不可见**。
      confirmToolCalls: async (calls, ctx) => {
        try {
          return await hitlGate.review(
            toHitlBatch(calls, ctx, (name) => toolMetaOf(name, ctx.agentId)),
          );
        } catch (e) {
          console.warn("HITL 闸门异常，按拒绝处理", e);
          return calls.map((call) => ({
            kind: "deny" as const,
            call: {
              id: call.id,
              name: call.function.name,
              argsJson: call.function.arguments,
              displayName: call.function.name,
              risk: "write" as const,
              summary: "",
              source: "unknown" as const,
            },
            reason: "确认流程异常，本次调用未执行",
            cause: "gate" as const,
          }));
        }
      },
      /**
       * 工具执行前的确定性 hooks（PreToolUse）：读工作区 `.heming/hooks.json`，
       * 命中就写 payload → 用命令桥跑 → 解释退出码。
       *
       * 放在 deps 里而不是塞进 HITL 闸门：两者的裁决来源不同（人 vs 仓库规矩），
       * 轨迹与统计要靠 `denyCause` 分开说。运行器内部已做了 fail-closed 与配置错误处理。
       */
      preToolUse: async (call, ctx) => {
        const workspace =
          useChatStore.getState().conversations.find((c) => c.id === convId)?.workspace ?? "";
        return toolHooksRef.current!.run(call, {
          workspace,
          agentId: ctx.agentId,
          streamId: ctx.streamId,
        });
      },
      /**
       * 工具执行后的确定性 hooks（PostToolUse，d.345）：`hooks.json` 里 `on: "post"` 的规则。
       *
       * 只把说明附在结果后面，不改变结果（工具已经真的跑过了）。运行器内部保证不抛错、
       * 未启用时一条也不跑，所以这里不需要再包 try/catch。
       */
      postToolUse: async (call, result, ctx) => {
        const workspace =
          useChatStore.getState().conversations.find((c) => c.id === convId)?.workspace ?? "";
        return toolHooksRef.current!.runPost(call, result, {
          workspace,
          agentId: ctx.agentId,
          streamId: ctx.streamId,
        });
      },
      // 轮次收尾写记忆（设计 §3）：成功轮次走 recordTurn（Working + 显式抽取 + 6 轮沉淀）；
      // 中断/失败只记 Working 并标 partial，不沉淀长期记忆。全程静默，绝不影响发送与流式渲染。
      // appendTurn 本身不判总开关，故这里先看 settings.enabled（关闭=不记录也不召回）。
      onTurnComplete: (agentId, userText, assistantText, status) => {
        try {
          if (!memoryStore.getSettings().enabled) return;
          if (status === "ok") {
            memoryStore.recordTurn(agentId, convId, userText, assistantText);
            // 召回日志：本轮真注入了记忆才留档（判据与写入见 memory/runRecorder.ts）。
            recallRecorder.settle({ agentId, conversationId: convId, userText, assistantText });
            // 复盘分身：任务结束后后台自评「有什么值得长期记住」，即发即忘、不阻塞流式。
            // 三道闸门（记忆总开关 / 长期记忆开关 / 有绑定的 LLM 连接）都在 runner 内判断。
            maybeRunReview({
              agentId,
              conversationId: convId,
              userText,
              assistantText,
              recentTurns: memoryStore.working(convId, agentId).slice(-6),
              toolCallCount: turnToolCount,
              profile: resolveProfile(agentId),
            });
          }
          else {
            memoryStore.appendTurn({
              conversationId: convId,
              agentId,
              userText,
              assistantText,
              partial: true,
            });
          }
        } catch {
          /* 记忆失败静默降级 */
        }
      },
      // 回合事件日志（G6）：本机逐条记「开始/工具调用/结果/答案/终态」，
      // 崩溃或刷新后还能回看过程。只落本机、有上限、失败静默（记录器内部保证）。
      onRollout: recordRollout,
      // 心跳：等工具/等审批时定期刷新 lastAt，别让 60 秒看门狗把「在跑」写成「可能已中断」。
      onHeartbeat: (streamId) => useChatStore.getState().touchStream(streamId),
      // 分叉（d.56）：来源始终带上（任务卡/日志能看出这是一次分叉）；
      // 只有前缀重建成功才额外传 forkPrefix，降级时由上面的提示行说明原因。
      ...(forkRun.forkedFrom ? { forkedFrom: forkRun.forkedFrom } : {}),
      ...(forkRun.forkPrefix ? { forkPrefix: forkRun.forkPrefix } : {}),
      // 任务区终态：每个流恰好一次。只有从任务区发起的流带 taskId；
      // 普通聊天流不建档，任务区列表也不会被日常对话刷屏。
      onRunSettled: (streamId, result) => {
        // d.189：这一轮收口了（成功/失败/用户停止都算），清掉「没跑完」的标记。
        // 注意必须在下面「aborted 分支」之前清——标记的语义是「应用没机会收口」，
        // 而不是「这一轮结果不好」。
        // d.196：只清当前会话——别的会话里没跑完的活不该被顺手抹掉（侧栏徽标要用）。
        clearTurnRunning(convId);
        // 主对话进度（d.214）：这一轮已经收口，不能再显示「正在执行 X」——留着等于告诉用户
        // 「还在跑」，而实际上它已经停了（用户会一直等一个不存在的下一轮）。
        // d.218：也不直接抹掉，换成一行小结（几轮 / 几次工具 / 用时多少），
        // 免得跑完那一刻用户不在屏幕前，回头只能翻消息猜「刚才那一下干了多少」。
        settleTurnProgress(convId);
        // 引用只对这一轮有效（d.175）：回合收尾就清掉，避免下一次无意的发送带上旧文件。
        fileRefsRef.current = [];
        setFileRefs([]);
        setFileRefIssue(null);
        /*
         * 系统通知（d.208）：窗口不在前台时提醒「跑完了 / 出错了 / 撞上限了」。
         *
         * 是否真弹由 `notifyDesktop` 判断（前台不弹、用户关了开关不弹），这里只负责
         * 把状态翻成人话并带上会话 id——点通知能直接回到这个会话。
         */
        {
          const settledMeta = streamMeta.current[streamId] ?? { agentId: "system-assistant", name: "和小鸣" };
          notifyTurnEnd(result, settledMeta.name, convId);
        }
        // 轮次打满（d.167.4.103）：成功收口但被上限截断 → 输入区上方给一次「继续」。
        // 放在任务区判断之前：普通聊天流不建档，同样需要这个入口。
        if (result.maxRounds) setRoundLimitStreamId(streamId);
        // 计划模式（d.173）：这一轮只给了方案。入口留给用户点，而不是让它自作主张开写。
        if (planMode) setPlanReadyStreamId(streamId);
        // 预算收口（d.176.4.105）：与轮次到顶共用「继续」入口，但说明不同。
        if (!result.maxRounds && result.budgetStop) {
          setContinueReason("budget");
          setRoundLimitStreamId(streamId);
        } else {
          setContinueReason("rounds");
        }
        // 这一轮改过文件就给一次点击的「撤回」（d.176），没改就清掉上一条。
        setTurnWrites(result.writes ?? []);
        // 会话级台账（d.210）：撤回条会被下一轮覆盖，这里的记录留到会话结束，
        // 用户随时能回看「这个会话一共动过哪些文件、各改了几次」。
        if (result.writes && result.writes.length > 0) recordSessionChanges(convId, result.writes);
        // 轮次检查点（d.290）：这一轮抓到的「改之前」落成一条，`/rewind N` 靠它还原。
        // 放在会话台账之后、与 turnWrites 同源收口：两处看到的是同一份 result.writes。
        closeRewindTurn(convId);
        // 回合收尾刷新上下文用量（d.187）：刚发出去的那一轮才是真实占用。
        refreshContextUsage();
        // 后台作业（d.182）：作业不会被 await，收口后由界面接着盯，跑完给一次「继续」。
        const watchMeta = streamMeta.current[streamId] ?? { agentId: "system-assistant", name: "和小鸣" };
        /*
         * 用户点了停止（d.189）：以前停止之后这一轮就彻底断了，只能自己重新打一遍。
         * 这里给一次「接着做」——用同一个 streamId，走 retryStream 的续写路径
         * （不重发原提问，历史里也不会多一条重复的用户消息）。
         */
        setResumeState(
          result.status === "aborted"
            ? {
                reason: "aborted",
                streamId,
                agentId: watchMeta.agentId,
                agentName: watchMeta.name,
              }
            : null,
        );
        if (result.jobs?.length) {
          startJobWatch(result.jobs, {
            agentId: watchMeta.agentId,
            name: watchMeta.name,
            ...(streamTaskRef.current[streamId] ? { taskId: streamTaskRef.current[streamId] } : {}),
          });
        } else {
          jobWatchRef.current?.abort();
          jobWatchRef.current = null;
          setWatchedJobs([]);
        }
        /*
         * 运行中插话（d.199，d.225 修「停不下来」）：只有这一轮**正常做完**时才自动接着处理排队的那条。
         *
         * 以前不管收口原因都会 `shift()` 后立刻开新轮：用户点了停止（aborted）或这一轮报错（error），
         * 界面会自己又跑起来——「停止」按了没停住，而且错误之上再叠一次大概率仍失败的请求。
         * 现在这两种情况只把「没发出去」说清楚并清空队列：插话内容早已作为用户消息落库，
         * 下一次继续/重试时模型在历史里就看到它了，不需要靠内存队列再送一遍
         * （留着反而危险：三轮之后某个工具轮会突然把旧的一句话塞进上下文）。
         */
        if (result.status === "ok") {
          /*
           * 刚装/刚升级插件的告知（d.241）：这一轮提示词里已经写过一次，正常收口后就清掉。
           * 只在 `ok` 清——这一轮如果被停止或报错，模型可能根本没看到那段，留着下一轮再说一次；
           * 而「每轮都重复说」会让提示词里的 plugin 段变成噪声，也是对前缀缓存的浪费。
           */
          takePluginInstallNotices();
          const queued = steerQueueOf(convId).shift();
          if (queued) {
            setSendNotice("这一轮已经收尾，正接着处理你插的那条（下一轮就是它）。", "info");
            startRun(queued.mentions, queued.text);
          }
        } else if (steerQueueOf(convId).size() > 0) {
          const missed = steerQueueOf(convId).size();
          steerQueueOf(convId).clear();
          setSendNotice(
            result.status === "aborted"
              ? `你点了停止：排队里的 ${missed} 条插话这次没有发出去（它们已经在会话里，点「接着做」或重新发送时模型会看到）。`
              : `这一轮出错了：排队里的 ${missed} 条插话没有发出去（内容留在会话里，重试时会一起看到）。`,
            "info",
          );
        }
        // 排队条跟着真实队列走（d.227）：收口后要么被取走一条（继续跑）、要么被清空
        setSteerPendingCount(steerQueueOf(convId).size());
        /*
         * 收尾自检（d.232）：它说这一轮做完了，但任务清单里还有没打勾的项。
         *
         * 长任务最典型的塌方就是「提前宣布完成」：最后一句写「都改好了」，清单里还挂着
         * 两三行 `[ ]`，用户去验收才发现一半没做。这里不替用户判断完成度（那是它自己的
         * 清单），只把矛盾摆到台面上，并且**一次用户输入只问一次**——催完还不动手就停，
         * 接着问只会变成停不下来的自动循环。
         *
         * 只看 `ok`：用户点停止、或这一轮出错，那是另一种情境（并且刚好是用户已经介入）。
         * 有排队插话时先让插话——用户的即时意图优先于系统自检。
         */
        if (result.status === "ok") {
          const openTodos = unfinishedTodos(convId);
          const verdict = finishGateVerdict({
            status: result.status,
            open: openTodos.length,
            nudges: finishGateNudgesRef.current[convId] ?? 0,
            steerQueued: steerQueueOf(convId).size() > 0,
          });
          if (verdict.nudge) {
            finishGateNudgesRef.current[convId] = (finishGateNudgesRef.current[convId] ?? 0) + 1;
            const gateMeta = streamMeta.current[streamId] ?? { agentId: "system-assistant", name: "和小鸣" };
            const listed = openTodos
              .slice(0, 3)
              .map((item) => item.content)
              .join("、");
            setSendNotice(
              `清单里还有 ${openTodos.length} 项没打勾（${listed}${openTodos.length > 3 ? "…" : ""}）：我让它自己核一遍，别一句话带过。`,
              "info",
            );
            startRun([{ agentId: gateMeta.agentId, name: gateMeta.name }], finishGatePrompt(openTodos));
          } else if (verdict.reason === "already-nudged") {
            // 已经催过一次还这样：如实收尾，把「还剩几项」留在屏幕上，别再自动跑。
            // `FINISH_GATE_MAX_NUDGES` 就是这条线的位置（改它之前先想清楚会不会变成死循环）。
            if (openTodos.length > 0 && finishGateNudgesRef.current[convId] !== undefined) {
              setSendNotice(
                `这一轮又收尾了，清单里仍有 ${openTodos.length} 项没打勾（已提醒过一次，不再自动追问）。可以说「继续」或直接指出先做哪项。`,
                "info",
              );
            }
          }
        }
        const taskId = streamTaskRef.current[streamId];
        if (!taskId) return;
        delete streamTaskRef.current[streamId];
        const status =
          result.status === "ok" ? "done" : result.status === "aborted" ? "cancelled" : "failed";
        useTaskStore.getState().settle(taskId, {
          status,
          ...(result.finalText === undefined ? {} : { result: result.finalText }),
          ...(result.error === undefined ? {} : { error: result.error }),
          // 完成即证据（P3/T15）：任务卡与报告据此显示「改了什么/跑了什么」。
          ...(result.evidence === undefined ? {} : { evidence: result.evidence }),
        });
        notifyTaskSettled(taskId, status, result.error ?? result.finalText ?? "");
      },
      // 上下文预算（设计 §4）：agentStream 在 fetchHistory 之后调用——按本机设置做 token
      // 预算切分与早期对话压缩（摘要置于历史之前）；溢出重试带 aggressive 重新调用。
      // LLM 摘要用该 agent 绑定的 profile 走路由层（非 event-stream 分支整段返回），
      // 不落库、不上行 WS、失败返回 null（回落确定性摘要）；异常一律返回原 rows。
      prepareHistory: async (rows, agentId, opts) => {
        try {
          const profile = resolveProfile(agentId);
          // d.160：预算按**这个模型真实的上下文窗口**算（见 agentContext/modelBudget.ts）。
          // 之前固定 6000，64K/128K/200K 的模型也在第 8 轮就把前面压成摘要——
          // 长任务做到一半就「失忆」，这是用户说「像网页端」的一部分。
          const settings = applyModelBudget(
            loadContextSettings(),
            profile ? resolveCapability(profile) : null,
          );
          const prepared = await prepareAgentHistory(rows, {
            settings,
            cache: summaryCache,
            conversationId: convId,
            aggressive: opts?.aggressive,
            summarize: profile
              ? async (messages) => {
                  if (!messages.length) return null;
                  try {
                    let collected = "";
                    // 摘要请求独立于本次生成的中断（生成尚未开始）；只读不改：不落库
                    const text = await streamChatRouted(profile, messages, {
                      signal: new AbortController().signal,
                      onDelta: (d) => {
                        collected += d;
                      },
                    });
                    return text || collected || null;
                  } catch {
                    return null; // 摘要失败 → 回落零成本的确定性摘要
                  }
                }
              : undefined,
          });
          // d.217：折了就当面说一次——否则用户只看到「它忘了我刚说的规矩」。
          const foldedCount = countFoldedMessages(rows, prepared);
          if (foldedCount > 0) {
            recordContextFold(convId, foldedCount);
            setSendNotice(foldNoticeText(foldedCount), "info");
          }
          return prepared;
        } catch {
          return rows; // 压缩失败不阻断生成：按原样发送
        }
      },
      /**
       * 运行中插话（d.199）：每开一个工具轮取走队列里的正文，追加到本轮上下文末尾。
       * 队列只在内存、只属于这一轮；取走后如果这一轮收尾，剩下的由 onRunSettled 另起一轮。
       */
      drainSteer: () => {
        const queue = steerQueueOf(convId);
        const texts = queue.take();
        // 取走即减（d.227）：排队条要跟着真实队列走，不能只加不减
        if (texts.length > 0) setSteerPendingCount(queue.size());
        return texts;
      },
      /**
       * 主对话进度（d.214）：把「第几轮 / 正在执行哪个工具」写到内存表，输入区上方那行据此渲染。
       *
       * 只在本机展示，不上行；收口时（`onRunSettled`）统一清掉。
       */
      onProgress: (event) => recordTurnProgress(convId, event),
      /**
       * 上下文估算校准采样（d.215）：供应商报了提示 token 就记一条，
       * 再用新倍率刷新输入区那行用量——用户看到的是校准后的数字，
       * 不必自己去猜「估算偏了多少」。
       */
      onContextSample: (sample) => {
        recordContextSample(sample);
        refreshContextUsage();
      },
      /**
       * 上游瞬时错误自动重试（d.203.4.108）：把「正在自动重试」说给用户听。
       * 不说的话界面会像卡住，用户会点停止，把本来能自己缓过来的一轮掐掉。
       * 提示只发一次（下一次重试覆盖同一句），收口时的正常文案会把提示位覆盖掉。
       */
      onUpstreamRetry: ({ attempt, max, delayMs, reason }) => {
        const seconds = Math.max(1, Math.round(delayMs / 100) / 10);
        setSendNotice(
          `${reason}，${seconds} 秒后自动重试（第 ${attempt}/${max} 次）；不想等可以直接点停止。`,
          "info",
        );
      },
    };
    // 同步拿句柄（挂在 promise 上）：中断按钮不必等 fetchHistory/流完成
    const run = runAgentMentions(convId, mentions, text, deps);
    const runs = (runsRef.current[convId] ??= new Set());
    runs.add(run);
    // 完成即摘除：卸载时 WS cleanup 据此判断是否还有「进行中流」需延迟 close（F1）
    run.then(
      () => {
        runs.delete(run);
        // d.244：离开聊天页时保留的这条连接，等全部流真收口后关掉——
        // 延后一个宏任务，让收尾帧（finish/agent_error）先落到发送队列上。
        if (unmountingRef.current && !Object.values(runsRef.current).some((s) => s.size > 0)) {
          setTimeout(() => {
            wsHandleRef.current?.close();
            wsHandleRef.current = null;
          }, 0);
        }
      },
      (e) => {
        runs.delete(run);
        // fetchHistory 失败等启动期错误：生成未开始，可见提示而非静默
        console.warn("智能体生成启动失败", e);
        setSendNotice("智能体生成启动失败，请稍后重试", "error");
      },
    );
  };

  /** 中断当前会话全部进行中流：abort → 各流 catch 走 finish-partial + agent_error(aborted)。 */
  const abortRuns = () => {
    for (const h of runsRef.current[convId] ?? []) h.abortAll();
    // 确认弹窗也要收掉：否则用户按了停止，弹窗还杵在屏幕上，
    // 闸门的 await 永不 resolve → 整轮挂死（设计 §4.4）。
    useHitlStore.getState().cancelAll("用户中断");
    // d.230：「停止」只停这一轮对话，后台作业不受影响。不说清的话，
    // 用户会以为全停了，回头发现构建还在跑、或者以为被杀了。
    if (hasRunningPanelJobs()) {
      setSendNotice(
        "已停止这一轮。后台还有作业在跑（点停止不会停它们）：在「后台作业」面板里可以逐条停，或者让它跑完。",
        "info",
      );
    }
  };
  /**
   * 把「中断本会话」登记给跨组件登记表（d.86）：任务区右栏的汇总卡据此停止运行，
   * 不必把 ChatPage 的 runsRef 上提成全局状态。用 ref 包一层，避免每次渲染都重登记。
   */
  const abortRunsRef = useRef(abortRuns);
  abortRunsRef.current = abortRuns;
  useEffect(
    () => registerConversationAbort(convId, () => abortRunsRef.current()),
    [convId],
  );

  /** 错误行重试：清掉旧项，按原触发文本重新跑该单个 mention（新 streamId 重新登记）。 */
  /**
   * 「接着做」入口（d.189）：用户点了停止、或者应用重启后发现上一轮没跑完。
   *
   * 两种情况走不同的路：
   * - `aborted`：流对象还在（同一窗口内），复用 `retryStream`——它会清掉旧流、按续写
   *   口令重跑，且任务区的记录会回到「进行中」；
   * - `interrupted`：进程已经重启过，`streamMeta` 是空的、`retryStream` 无从下手，
   *   只能直接发续写口令（历史里那一轮的半截回答还在，模型据此接得上）。
   *
   * 两条路都**不重发原提问**：重发会让历史里出现两条一样的用户消息、并把已跑过的
   * 工具再跑一遍。
   */
  const continueResume = () => {
    const state = resumeState;
    if (!state) return;
    setResumeState(null);
    if (state.reason === "aborted" && state.streamId && streamMeta.current[state.streamId]) {
      retryStream(state.streamId);
      return;
    }
    void submitMessage(CONTINUE_PROMPT, [
      { agentId: state.agentId, name: state.agentName },
    ]).then((result) => {
      if (!result.ok) setSendNotice(result.error, "error");
    });
  };

  /**
   * 「继续生成」：接着上一轮往下写，**不重发原提问**。
   *
   * 以前这里用 `meta.text` 整轮重跑，带来两个真实问题：
   * 1. 历史里会再出现一条同样的用户消息——模型看到问题被问了两次，回答开始自我重复；
   * 2. 已经执行过的工具会再跑一遍（同一次读文件、同一次写盘都重复落地）。
   *
   * 续写指令只说「接着写」，原提问与被中断的部分回答都已在历史里，模型自然知道从哪接。
   */
  const retryStream = (streamId: string) => {
    const meta = streamMeta.current[streamId];
    if (!meta) return;
    // 任务区的流重试：任务记录跟着回到「进行中」，否则重试成功也不会更新汇总
    const taskId =
      streamTaskRef.current[streamId] ??
      useTaskStore.getState().tasks.find((t) => t.streamId === streamId)?.id;
    if (taskId) useTaskStore.getState().reopen(taskId);
    removeStream(streamId);
    delete streamMeta.current[streamId];
    delete streamTaskRef.current[streamId];
    // 走正常发送路径（不是 startRun）：续写指令也要作为一条用户消息落库、上行，
    // 否则别的设备/成员看不到这一轮是被接着生成的，重启后历史里也断在中断处。
    void submitMessage(CONTINUE_PROMPT, [{ agentId: meta.agentId, name: meta.name }], taskId).then(
      (result) => {
        if (!result.ok) setSendNotice(result.error, "error");
      },
    );
  };

  // 切会话清输入区浮层：表情/语音都是会话级（ChatPage 常驻不重挂）。
  // 语音必须真正 stop 旧识别器并清实例——只复位 listening 标志的话，旧实例仍在后台
  // 识别：onresult 回填新会话草稿、晚到的 onend 误清新指示。
  useEffect(() => {
    recRef.current?.stop();
    recRef.current = null;
    setEmojiOpen(false);
    setVoiceMenu(false);
    // 录音同为会话级：中止旧会话录音（置取消位 → stop，onstop 停轨且跳过发送），录音态即时退出
    setRecording(false);
    voiceRecCancelRef.current?.();
    setListening(false);
    // 发送提示也是会话级：A 会话的「上传失败/不支持语音」不得带进 B 会话
    setSendNotice(null);
    // 轮次打满提示同为会话级：A 会话的「继续」按钮不能出现在 B 会话的输入区
    setRoundLimitStreamId(null);
    // 计划就绪提示也是会话级：A 会话的方案提示不能出现在 B 会话
    setPlanReadyStreamId(null);
    // 上下文用量也是会话级（d.187）：按新会话重算，别把上一个会话的用量带过来。
    refreshContextUsage();
    convIdRef.current = convId;
    // 视图也是会话级：换会话回到「对话」，不要停在上一个会话的轨迹页。
    setView("chat");
  }, [convId]);

  // 消息/模型绑定变了就重算上下文用量（d.187）：换模型会换预算，来新消息会换用量。
  useEffect(() => {
    refreshContextUsage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, llmBindings, llmProfiles]);

  // E2E Task 4：会话初始化 + 解密 handler 注入 + 身份公钥上云（硬验收①——不上云则
  // 对端 fetchPeerKeys 恒 null：chaindist 永不发出、消息全 defer）。声明位置在 WS 效果
  // 之前：effects 按声明序执行，首帧网络事件到达时 handler 必已就位。
  useEffect(() => {
    if (!hasSubtle()) return; // 无 subtle：横幅 + 拦截，不建链不注入
    void initSession(convId, e2eDeps());
    useChatStore.getState().setOpenHandler(makeOpenHandler(convId));
    void exportOwnDeviceKeys()
      .then((keys) => putE2eKeys(keys))
      .catch((e) => console.warn("E2E 公钥上云失败", e));
    return () => {
      useChatStore.getState().setOpenHandler(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convId]);

  // 历史拉取走 store.loadMessages：plain 直通、信封经 handler 解密合并（§6 缓存优先），
  // 解不开的留占位（渲染无法解密、不进提示词）；alive 挡卸载/切会话后的晚到写入。
  // A1：loadMessages 自己吞掉失败（落 messagesError），这里只记「本会话已完成过一次拉取」，
  // 用于区分首帧骨架 / 真空态（成功且为空才是「还没有消息」）。
  useEffect(() => {
    let alive = true;
    void useChatStore
      .getState()
      .loadMessages(convId, () => alive)
      .finally(() => {
        if (alive) setHistoryLoaded((prev) => ({ ...prev, [convId]: true }));
        if (!alive) return;
        /**
         * 存量明文缓存迁移（P0-5b）：加密轨把「明文条目迁成密文」挂在全量读 `list()` 上，
         * 而本页两处缓存读取已改成定点 `get()`——不补这一下，磁盘上的旧明文要等到
         * 下一阶段全量清理才会迁。打开会话时补一批（每批 ≤50 条），失败静默：
         * 迁移只影响存储形态，绝不能影响消息渲染与发送。
         */
        try {
          migrateMsgCache(convId);
        } catch {
          /* 静默：下次打开会话再试 */
        }
      });
    return () => {
      alive = false;
    };
  }, [convId]);

  // 存量自迁移（设计 §7）：挂载后后台把本会话自己发的 plain 消息重封为 e2e 信封，
  // store 内 20/s 节流逐条 PUT；attempted ref 跨批次去重（成功后 enc 变 e2e 自然出局）
  useEffect(() => {
    if (!hasSubtle() || !me) return;
    const list = useChatStore.getState().messages[convId] ?? [];
    if (!list.some((m) => m.enc === "plain" && m.senderId === me.id)) return;
    let alive = true;
    void (async () => {
      const members = await resolveMembers();
      if (!alive) return;
      await useChatStore
        .getState()
        .migrateOwnPlain(convId, members, e2eDeps(), migratedRef.current, me.id, () => alive);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convId, messages.length, me?.id]);

  // 有 ChatPage 实例时 App 壳不再开后台连接（任务区嵌入式 ChatPage 同理）：
  // 页面名判断不了「任务区里也挂着一个 ChatPage」，必须按实例注册/注销。
  useEffect(() => registerChatSocket(), []);

  /**
   * d.244：整页卸载标记。layout effect 的 cleanup **先于**普通 effect 的 cleanup 执行，
   * 所以下面 WS effect 的 cleanup 一定能读到 `unmountingRef.current === true`——
   * 靠它把「离开聊天页」与「切会话」分开：「离开」保留在飞的流与连接，「切会话」照旧中止。
   */
  useLayoutEffect(
    () => () => {
      unmountingRef.current = true;
    },
    [],
  );

  useEffect(() => {
    let alive = true; // 挡卸载后晚到的补拉写入（同 loadMessages effect 口径）
    /**
     * 本连接的「断过再连」标记：必须放在 effect 内（每次切会话重建归零）。
     * 放组件级 ref 会跨会话黏住——A 会话恢复过，B 会话首次 open 会误报「已恢复连接」。
     */
    let hadClosed = false;
    // 新连接从「连接中…」起步：切会话时旧连接已关、新连接未 open，
    // 不能沿用上一会话的「已断开」或恢复提示。
    setConnected(false);
    setConnState("connecting");
    setRecovered(false);
    const handle = connectWs({
      onEvent: (e) => {
        // d.126-C：流式收口前把思考/工具轨迹快照下来。onWsEvent 会移除 streaming 项，
        // 之后再取就只剩正文了（转录要随消息落盘，会话结束后仍可展开）。
        const finishedTranscript =
          e.type === "message_new" && e.streamId ? collectStreamTranscript(e.streamId) : undefined;
        // 流式三事件收口（chunk 累积/message_new{streamId} 移除/agent_error 分态）在 store 统一处理
        useChatStore.getState().onWsEvent(e);
        /**
         * 轨迹只在收口前有用：留着就是按 streamId 只增不删的表（长会话累积几条无关紧要，
         * 但一个页面开一整天、每个流都留一份工具结果副本，就没有理由了）。
         * 没有在飞的流时整表清空，比逐个猜哪条该删安全。
         */
        if (!Object.keys(useChatStore.getState().streaming).length) toolTraceRef.current = {};
        if (e.type === "message_new" && e.message.conversationId === convId) {
          if (finishedTranscript) {
            // 先落盘再入列：切会话/刷新后拉历史能按消息 id 贴回这两个字段
            useChatStore.getState().recordTranscript(convId, e.message.id, finishedTranscript);
          }
          appendMessage(withTranscript(e.message, finishedTranscript));
        } else if (e.type === "error") {
          console.warn(`[${e.code}] ${e.message}`);
        }
      },
      onOpen: () => {
        if (!alive) return; // 旧连接的晚到回调：新连接已接手，别拿旧状态覆盖
        setConnected(true);
        setConnState("open");
        if (hadClosed) {
          setRecovered(true);
          if (recoveredTimer.current) clearTimeout(recoveredTimer.current);
          recoveredTimer.current = setTimeout(() => setRecovered(false), 3000);
        } else {
          setRecovered(false);
        }
        // 断线重连成功（d.300）：以服务端为准对一次齐——断线期间别处可能删过消息
        //（`/rewind`、重答），那些 `messages_deleted` 广播是收不到的，只合并会一直留着。
        if (hadClosed) {
          void useChatStore
            .getState()
            .resyncMessages(convId, () => alive)
            .then((res) => {
              if (!res.ok || res.removed === 0) return;
              setSendNotice(`断线期间别处删掉了 ${res.removed} 条消息，已经对齐。`, "info");
            });
          // 会话列表同样补一次（未读数、别处新建的会话）
          void useChatStore.getState().loadWorkspace().catch(() => undefined);
          return;
        }
        // 首次连上：拉历史（合并语义，信封同走解密合并）
        void useChatStore.getState().loadMessages(convId, () => alive);
      },
      onClose: () => {
        // 本端主动断开（切会话/卸载）不是「断线」：effect 已重连，别闪一条断线横幅。
        if (!alive) return;
        hadClosed = true;
        setConnected(false);
        setConnState("closed");
        // 意外掉线时把进行中的流也收口：否则要等 60s 看门狗才收尾，
        // 这轮回复既不落库、也不报错；HITL 弹窗还杵在屏幕上，闸门 await 永不 resolve。
        // 帧发不出去没关系（连接已经断了），至少本地气泡能收口、任务区能标失败。
        for (const runs of Object.values(runsRef.current)) {
          for (const handle of runs) handle.abortAll();
        }
        useHitlStore.getState().cancelAll("连接断开");
        // 恢复提示与断线横幅互斥：断开时立刻收起恢复提示并停掉它的计时。
        setRecovered(false);
        if (recoveredTimer.current) {
          clearTimeout(recoveredTimer.current);
          recoveredTimer.current = null;
        }
      },
      // d.30 · P1-8：离线队列溢出/无 token 发送失败 → 复用既有 setSendNotice 提示，
      // 不新造组件（规格 §5）。静默丢帧的话用户永远不知道有东西没发出去。
      onSendError: (reason) => setSendNotice(`发送失败：${reason}`, "error"),
    });
    wsHandleRef.current = handle;
    return () => {
      alive = false;
      const hasInFlight = Object.values(runsRef.current).some((s) => s.size > 0);
      if (hasInFlight && handle && unmountingRef.current) {
        // d.244：离开聊天页不掐断这一轮——连接必须留着，`agent_finish` / `agent_error`
        // 都靠它上行（关了就「完了也没人收尾」，答案既不落库、回来也看不到）。
        // 关闭交给卸载 effect 里的轮询：全部收口后自会 close。
        wsHandleRef.current = handle;
      } else if (hasInFlight && handle) {
        // F1 回归：切会话时进行中流被中止，catch 要经此连接补发 finish(partial)+agent_error
        // （服务端入库 partial、他机端收 error 收口）。立即 close + 清 ref 会把两帧静默丢弃——
        // catch 在微任务里跑，故把 close 延后一个宏任务（微任务必先排空），ref 同步清空也一并延后。
        setTimeout(() => {
          handle.close();
          if (wsHandleRef.current === handle) wsHandleRef.current = null;
        }, 0);
      } else {
        handle?.close();
        wsHandleRef.current = null;
      }
    };
  }, [convId, appendMessage]);

  /**
   * A3 滚动贴底跟随：贴底时才跟着新消息与流式文本走；用户上滑后不再强行拽底，
   * 改为在右下角亮起「↓ 新消息」。切会话由上面的 convId effect 强制回到底部。
   *
   * 用 `streamTick`（各流文本/思考长度之和）当依赖：流式每帧文本变化都会推进它，
   * 而对象引用本身每次都变、不能直接进依赖。
   */
  const streamTick = streamEntries
    .map(([, s]) => (s.text?.length ?? 0) + (s.reasoning?.length ?? 0))
    .join(",");
  useEffect(() => {
    if (atBottomRef.current) {
      // 跟随新内容：直接贴底，不用 scrollIntoView（见 scrollListToBottom 注释）。
      scrollListToBottom("auto");
    } else {
      setNewBelow(true);
    }
  }, [messages.length, streamTick, scrollListToBottom]);

  // 挂载清扫（d.244 起只清「真过期」的残留）：离开聊天页不再中止在飞的流，所以新挂载时
  // store 里的 streaming 项**可能有一个正在跑**——那是本机上一实例仍在推进的流，清掉就等于
  // 又看不到实时输出了。只把超过 STREAM_STALE_MS（60s 没刷新）的孤儿项置 error（`sweepStaleStreams`
  // 既有口径），真正在跑的、以及他机正在写的条目一律不动。
  // 空依赖 = 只在挂载执行；切会话（convId 变化）不清——那时别的会话/他机流条目仍有效。
  useEffect(() => {
    // 只有真存在「超时没刷新」的 streaming 项时才扫——正常挂载（store 干净、
    // 或只有 error 残留）不该有任何清扫动作，watchdog 门控用例也依赖这一点。
    const hasStale = Object.values(useChatStore.getState().streaming).some(
      (s) => s.status === "streaming" && Date.now() - (s.lastAt ?? 0) > STREAM_STALE_MS,
    );
    if (hasStale) sweepStaleStreams(Date.now());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * 回来时接上实时输出：挂载那一刻若本会话已有在飞的流（离开页面时它没被掐断），
   * 明确告诉用户「它还在跑、这里看到的是实时的」，别让人以为又从头开始了。
   * 只在每个实例里提示一次（下面 fork/恢复提示已有各自的位，这里不共用）。
   */
  const liveResumeNotedRef = useRef(false);
  useEffect(() => {
    if (liveResumeNotedRef.current) return;
    if (!streamEntries.some(([, s]) => s.status === "streaming")) return;
    liveResumeNotedRef.current = true;
    setSendNotice("这一轮在你离开页面时还在跑，这里接的是实时输出。", "info");
  }, [streamEntries]);

  // 他机流 watchdog（Task 7）：存在 status==="streaming" 的在飞项时，每 15s 扫一次全局 streaming，
  // 把长时间无响应（>60s 未刷新）的打字机项置 error 行（阈值在 store；本机流不自动重试，error 行有手动重试）。
  // 门取「存在 streaming 项」而非「streaming 非空」——纯 error 残留（本机 retry 行 / 他机流 6s 自清窗口）
  // 不再挂表：既不空转、也不让假时钟测试的 runAllTimers 无法收敛。有在飞流即起、全部收口即卸。
  const hasLiveStream = Object.values(streaming).some((s) => s.status === "streaming");
  useEffect(() => {
    if (!hasLiveStream) return;
    const timer = window.setInterval(
      () => sweepStaleStreams(Date.now()),
      STREAM_SWEEP_INTERVAL_MS,
    );
    return () => window.clearInterval(timer);
  }, [hasLiveStream, sweepStaleStreams]);

  // 卸载（离开聊天页）：**不再中止**进行中的流（d.244）。
  //
  // 以前这里 `abortAll()` + `cancelAll("页面离开")`，理由是「不再空烧供应商 token」；
  // 但代价是「去设置里改个东西再回来」这一轮直接没了——正是用户报的「切页后返回看不到
  // 实时流式输出」。现在改成：流继续跑、连接保留（见 WS cleanup 与 `startRun` 里的收口关闭），
  // 本页只做本机清理。显式中止只有两处：用户点「停止」、以及真正关窗/刷新（由页面销毁兜底）。
  //
  // 待确认请求也不再「替用户拒绝」：闸门在裁决前不执行工具（兜底方向是「不执行」），
  // 回来还能裁决——否则用户只是去改个设置，工具就被记成了「用户拒绝」。
  useEffect(
    () => () => {
      recRef.current?.stop();
      voiceRecCancelRef.current?.();
    },
    [],
  );

  // 切走会话**不再**替用户拒绝（d.34）：待确认请求保持待定，弹窗标注来源会话，
  // 用户切回来还能裁决。闸门在裁决到达前不会执行工具（兜底方向是「不执行」），
  // 所以「保持待定」是安全的；反过来「用户没同意却被记成拒绝」才是不对的。

  /** 右栏目录「发送到会话」投递：单槽命中本会话即封 e2e 信封经 WS 发送并清槽。 */
  const pendingAttachment = useUiStore((s) => s.pendingAttachment);
  useEffect(() => {
    if (!pendingAttachment || pendingAttachment.conversationId !== convId) return;
    if (!hasSubtle()) {
      // 硬验收⑤：附件路径同样拦截不降级；清槽防切会话后再次触发
      setSendNotice(NO_E2E_NOTICE);
      useUiStore.getState().consumePendingAttachment();
      return;
    }
    void sealAndSend({
      kind: "file",
      text: "",
      file: pendingAttachment.file,
    });
    useUiStore.getState().consumePendingAttachment();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAttachment, convId]);

  /** 键入触发：草稿尾随 @token（空格一断 token 即结束）→ 过滤弹选择器；direct 不触发。 */
  /**
   * 输入栏高度（可拖动）：只作用于「文本行」这一块，不挤压上方的提示/引用/工具行。
   * 初次读 localStorage（用户上次拖的高度），无记录用默认值。
   */
  const [composerHeight, setComposerHeight] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(COMPOSER_HEIGHT_KEY);
      if (raw !== null) return clampComposerHeight(Number(raw));
    } catch {
      /* 存储不可用：用默认值 */
    }
    return DEFAULT_COMPOSER_HEIGHT;
  });
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);

  const onComposerDragStart = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    dragRef.current = { startY: e.clientY, startH: composerHeight };
  };
  const onComposerDragMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    // 向上拖（clientY 变小）= 加高
    setComposerHeight(clampComposerHeight(d.startH - (e.clientY - d.startY)));
  };
  const onComposerDragEnd = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    try {
      localStorage.setItem(COMPOSER_HEIGHT_KEY, String(composerHeight));
    } catch {
      /* 配额/隐私模式异常：高度只在本次会话生效 */
    }
  };

  const onDraftChange = (value: string) => {
    // 手打就退出回溯（d.194）：改过的文字不该再被 ↑ 覆盖，除非重新从空框开始。
    if (historyIndex >= 0) setHistoryIndex(-1);
    // 换了内容，「这条很长，确认再发」的那次确认作废（d.233）。
    largeSendConfirmedRef.current = false;
    setDraft(value);
    scheduleDraftSave(convId, value);
  };

  /** Esc 关语音双选项浮层（文档级）。 */
  useEffect(() => {
    if (!voiceMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setVoiceMenu(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [voiceMenu]);

  /**
   * A10：无浮层、无草稿时 Esc 停止生成。
   * 挂在文档级而不是输入框上：用户可能正把光标放在消息区/刚点过别处，
   * 但只要没有正在编辑的内容、也没有任何浮层在等 Esc，Esc 的语义就是「停」。
   */
  useEffect(() => {
    if (activeLocal.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (draft.trim() !== "") return;
      if (emojiOpen || voiceMenu || searchOpen || attachOpen) {
        return;
      }
      abortRuns();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // abortRuns 每帧重建；本 effect 只关心「是否该接 Esc」的门槛状态
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeLocal.length, draft, emojiOpen, voiceMenu, searchOpen, attachOpen]);

  /**
   * Ctrl+F / Cmd+F 唤起本会话搜索（d.236）。
   *
   * 之前只能点顶部那个放大镜；长任务里想找「刚才那句结论」要先把鼠标挪过去。
   * 浏览器自己的「页内查找」在这里意义不大（消息在虚拟滚动容器里），所以接管。
   * 顺带补一件事：搜索开着时 Esc 现在会关掉搜索（以前 A10 只是「不去停生成」，什么都不做，
   * 用户按 Esc 会以为没反应）。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSearchOpen(true);
        // 面板是下一拍才挂上的，等它渲染完再聚焦并全选旧关键词（连按可以直接改写）。
        requestAnimationFrame(() => {
          const node = searchInputRef.current;
          if (!node) return;
          node.focus();
          node.select();
        });
        return;
      }
      if (e.key === "Escape" && searchOpen) {
        e.preventDefault();
        setSearchOpen(false);
        setSearchQuery("");
        setSearchHitId(null);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [searchOpen]);

  /**
   * 工作区根的指纹（d.240）：可写根存在 localStorage 里，加根/换根不会引起 state 变化，
   * 自定义命令又要「根一变就重读」，所以把根拼成一个字符串当 effect 依赖。
   */
  const customCommandRootKey = fileRootsFor(conv?.workspace ?? null)
    .map((root) => `${root.mode}:${root.path}`)
    .join("|");

  /**
   * 工作区自定义命令（d.240）：`.heming/commands/*.md` → `/名字`。
   *
   * 什么时候读：切会话、换工作区时读一次（命令文件是仓库里的静态配置，不跟着每轮变）。
   * 读不到就保持空列表——自定义命令是锦上添花，任何失败都不该影响到正常对话。
   * 同时写进 ref：`submitMessage` 在事件回调里执行，那里拿不到最新的 state 闭包。
   */
  useEffect(() => {
    let cancelled = false;
    const bridge = getFileBridge();
    // 用「根的指纹」当依赖：手动加/换可写根时也要重读（根存在 localStorage 里，靠 state 变化触发不到）。
    const list = fileRootsFor(conv?.workspace ?? null);
    if (!bridge || list.length === 0) {
      customCommandsLoadedRef.current = false;
      setCustomCommands([]);
      customCommandsRef.current = [];
      return;
    }
    void collectCustomCommands({ bridge, roots: list }).then((commands) => {
      if (cancelled) return;
      customCommandsLoadedRef.current = true;
      setCustomCommands(commands);
      customCommandsRef.current = commands;
    });
    return () => {
      cancelled = true;
    };
  }, [convId, conv?.workspace, customCommandRootKey]);

  /**
   * 工作区自定义子代理（d.287）：`.heming/agents/*.md` → `agent_task` 的 `agent` 参数。
   *
   * 与自定义命令同一时机读（切会话、换工作区、根的指纹变化）：定义文件同样是仓库里的静态配置。
   * 读到后清掉工具桥缓存——`agent_task` 的 spec 里列着可用名字，缓存不清就还是旧的那几份。
   * 读不到就保持空列表：自定义子代理是可选项，任何失败都不该影响正常对话。
   */
  useEffect(() => {
    let cancelled = false;
    const bridge = getFileBridge();
    const list = fileRootsFor(conv?.workspace ?? null);
    if (!bridge || list.length === 0) {
      subagentDefsLoadedRef.current = false;
      subagentDefsRef.current = [];
      toolBridgeRef.current.clear();
      return;
    }
    void collectSubagentDefs({ bridge, roots: list }).then((defs) => {
      if (cancelled) return;
      subagentDefsLoadedRef.current = true;
      subagentDefsRef.current = defs;
      toolBridgeRef.current.clear();
    });
    return () => {
      cancelled = true;
    };
  }, [convId, conv?.workspace, customCommandRootKey]);

  // 命令面板（d.184）：只在「以 / 开头、单行」时出现——正常消息里的斜杠（路径、日期）不弹。
  const slashItems = matchSlashCommands(draft, [...SLASH_COMMANDS, ...commandsToSlash(customCommands)]);
  const slashOpen = slashItems.length > 0;
  const pickSlashCommand = (command: string) => {
    setDraft(command);
    setSlashIndex(0);
    composerRef.current?.focus();
  };

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashOpen && !e.nativeEvent.isComposing) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const delta = e.key === "ArrowDown" ? 1 : -1;
        setSlashIndex((prev) => (prev + delta + slashItems.length) % slashItems.length);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const picked = slashItems[Math.min(slashIndex, slashItems.length - 1)];
        if (!picked) return;
        // 已经打完整命令时，再按一次 Enter 就直接执行（面板不再弹）；否则先补全。
        if (draft.trim() === picked.command) {
          e.currentTarget.form?.requestSubmit();
          return;
        }
        pickSlashCommand(picked.command);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDraft("");
        setSlashIndex(0);
        return;
      }
    }
    // 多行输入框：Enter 发送、Shift+Enter 换行（输入法组词中不拦，否则中文选词会被当成发送）
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      e.currentTarget.form?.requestSubmit();
      return;
    }
    /**
     * ↑/↓ 调出本会话发过的消息（d.194）。
     *
     * 只在「空输入框按 ↑」或「已经在回溯里」时接管——否则多行草稿里的光标上下移动会被劫持。
     * 命令面板打开时由上面的分支处理，走不到这里。
     */
    if (!e.nativeEvent.isComposing && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      const navigating = historyIndex >= 0;
      if (!navigating && !(e.key === "ArrowUp" && draft.trim() === "")) return;
      const stash = navigating ? draftStashRef.current : draft;
      const step = stepHistory(inputHistory, historyIndex, e.key === "ArrowUp" ? "up" : "down", stash);
      if (step.index === historyIndex && step.text === draft) return;
      e.preventDefault();
      if (!navigating) draftStashRef.current = draft;
      setHistoryIndex(step.index);
      setDraft(step.text);
      return;
    }
  };

  /** A7：粘贴截图/文件 → 进待发附件列表（E1），发送时才上传；校验（6MB、E2E）在列表入口。 */
  const onComposerPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length === 0) return; // 纯文本粘贴不拦
    e.preventDefault();
    enqueueFiles(files);
  };

  /**
   * 刷新上下文用量（d.187）。
   *
   * 估算口径必须与真正发出去的内容一致，所以复用 `contextRowsOf`（与 `/compact` 同一条路）。
   * 预算取 `applyModelBudget` 的结果：自动档按模型窗口算、手动档按用户填的值算——
   * 界面上写的预算必须就是运行时用的预算，否则这行数字会骗人。
   *
   * 读的是**已加载的消息**（`messages`），不再触发 `loadMessages`：历史上那会多打一次
   * 请求，把「历史加载失败 → 重试」这类状态机的时序打乱（A1 用例实测被带红）。
   */
  function refreshContextUsage(): void {
    try {
      const plainOf = useChatStore.getState().plainById[convId] ?? {};
      const rows = contextRowsOf(messages.slice(-HISTORY_MESSAGE_WINDOW), plainOf);
      const profile = resolveProfile(conv?.agent.id ?? "system-assistant");
      const settings = applyModelBudget(
        loadContextSettings(),
        profile ? resolveCapability(profile) : null,
      );
      // 校准（d.215）：真实上报的提示 token 与估算差多少，按模型记住倍率；
      // 只修正显示与提醒，压缩决策仍用未校准的估算（避免一次异常样本让整段历史被误压）。
      const raw = estimateRowsTokens(rows);
      const model = profile?.model ?? "";
      const ratio = contextCalibrationRatio(model);
      setContextUsage({
        used: calibrateEstimate(raw, model),
        budget: settings.budgetTokens,
        calibrated: ratio !== 1,
      });
    } catch {
      /* 指标失败静默：它是提示，不是功能；拿不到就不显示，别影响发送 */
    }
  }

  /**
   * 手动压缩（d.183）：输入 `/compact` 时立刻把这段历史压成摘要。
   *
   * 为什么要有它：自动压缩只在**预算撞墙**时发生，用户在此之前没有办法主动让上下文
   * 变轻；而且压缩之后看不到发生了什么（省了多少、摘要说了什么），长任务里
   * 「它怎么突然忘了前面」就成了不可解释的现象。这里把动作和结果都摆到面前。
   *
   * 走的是 `compactNow`（force 分支）：即使历史本来放得下也折——这是用户明确要求，
   * 不是猜预算；但压缩后不比原来省就如实回「不划算」，不拿摘要换掉真实内容。
   */
  async function runCompactCommand(
    mentions: { agentId: string; name: string }[],
  ): Promise<{ ok: true; notice?: string } | { ok: false; error: string }> {
    const agentId = mentions[0]?.agentId ?? "system-assistant";
    const profile = resolveBoundProfile(agentId);
    let rows: ChatMessage[] = [];
    try {
      const msgs = (await useChatStore.getState().loadMessages(convId)).slice(-HISTORY_MESSAGE_WINDOW);
      const plainOf = useChatStore.getState().plainById[convId] ?? {};
      rows = contextRowsOf(msgs, plainOf);
    } catch (err) {
      return { ok: false, error: `读取历史失败：${(err as Error).message}` };
    }
    if (rows.length < 4) {
      // 提示由 send() 在 resetComposer 之后落位：这里直接设会被清掉（d.183 实测）。
      return { ok: true, notice: "这段对话还太短，没有可以压缩的早期内容。" };
    }
    const settings = applyModelBudget(
      loadContextSettings(),
      profile ? resolveCapability(profile) : null,
    );
    const result = await compactNow(rows, {
      settings,
      cache: summaryCache,
      conversationId: convId,
      summarize: profile
        ? async (messages) => {
            if (!messages.length) return null;
            try {
              let collected = "";
              // 摘要请求独立于生成的中断（此时没有在跑的流）；失败回落确定性摘要。
              const text = await streamChatRouted(profile, messages, {
                signal: new AbortController().signal,
                onDelta: (d) => {
                  collected += d;
                },
              });
              return text || collected || null;
            } catch {
              return null;
            }
          }
        : undefined,
    });
    if (!result.compacted) {
      return { ok: true, notice: `压缩没有更省（现在约 ${result.beforeTokens} tokens），保持原样。` };
    }
    return {
      ok: true,
      notice: `已压缩 ${result.foldedCount} 条早期消息（约 ${result.beforeTokens} → ${result.afterTokens} tokens），下一轮对话起生效。`,
    };
  }

  /**
   * `/status` 的快照（d.193）：只读——从已有 state 与 store 取，不发请求、不改状态。
   *
   * 取数口径刻意与各处一致而不是另算一套：根走 `fileRootsFor(workspace)`（与工具注入同源）、
   * 计划模式走 `loadPlanMode(convId)`（与按钮同源）、清单走 `getTodos`（与提示词同源）。
   * 工具数取「本轮真的注入的那批」，不是目录里全部——用户问的是「这一轮它能用什么」。
   */
  function buildSelfStatus(): string {
    const profile = conv ? resolveProfile(conv.agent.id) : undefined;
    const caps = profile ? resolveCapability(profile) : null;
    const roots = fileRootsFor(conv?.workspace);
    const bridge = conv ? toolBridgeRef.current.get(conv.agent.id) : undefined;
    const specs = (bridge?.tools ?? []) as { type?: string; function?: { name?: string } }[];
    const names = specs
      .map((spec) => spec.function?.name)
      .filter((name): name is string => typeof name === "string" && name.length > 0);
    const jobsRunning = watchedJobs.filter((job) => job.running).length;
    return buildStatusReport({
      version: typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "",
      model: profile?.label ?? "",
      modelWindow: caps?.contextWindow,
      vision: caps?.supportsVision,
      workspace: conv?.workspace ?? "",
      projectRules: projectRulesRef.current,
      // d.240：读过才报数字，没读过就省略（`/status` 里会写「尚未统计」，而不是「无」）。
      customCommands: customCommandsLoadedRef.current ? customCommands.length : undefined,
      // d.287：自定义子代理只报「读过几次」，没读过就不写（`/status` 里那行本就不出现）
      subagentDefs: subagentDefsLoadedRef.current ? subagentDefsRef.current.length : undefined,
      // d.221：这个会话失败了几次、卡在哪些错误码上（只在真失败过时才有这一行）
      toolFailures: getToolFailureStats(convId),
      roots: roots.map((root) => ({ name: root.name, path: root.path, mode: root.mode })),
      planMode: loadPlanMode(convId),
      // d.242：安全范围这一行读存储/开关本身，不读 state——设置页改过档位也能如实反映
      safety: describeSafetyScope(scopeOfPolicy(hitlPolicy.get(), isDangerAuto())),
      subagentWritable: isSubagentWriteEnabled(convId),
      notifyEnabled: isDesktopNotifyEnabled(),
      sessionChanges: getSessionChanges(convId).length,
      context: contextUsage,
      // d.217：这个会话最近一次被折了多少条——只读存储，不改状态
      contextFold: (() => {
        const fold = getContextFold(convId);
        if (!fold) return null;
        return { foldedCount: fold.foldedCount, ageMinutes: Math.max(0, Math.floor((Date.now() - fold.at) / 60_000)) };
      })(),
      todos: getTodos(convId),
      // d.230：这个会话累计花了多少——只读用量账本，不写一行
      usage: totalsOf(recordsForConversation(useTokenUsageStore.getState().records, convId)),
      // 面板有数据就以面板为准（它含用户自己起的作业）；没有才退回「这一轮盯过的那几个」
      jobs:
        shellJobs.length > 0
          ? { running: shellJobs.filter((job) => job.running).length, total: shellJobs.length }
          : { running: jobsRunning, total: watchedJobs.length },
      writes: turnWrites.length,
      resumePending: loadResumePoint(convId) !== null,
      busy: activeLocal.length > 0,
      // 常驻工具数以桥的声明为准（d.207），旧名单只兜底——与 `agentStream` 的钉选同一口径
      tools: {
        count: names.length,
        core: coreToolNames(names, (name) => bridge?.meta?.(name)).length,
        // d.224：工具一多就切「按需发现」，界面上得说清「它为什么有时要先检索一次」
        discovery: names.length > TOOL_SEARCH_THRESHOLD,
        visible: MAX_VISIBLE_TOOLS,
        threshold: TOOL_SEARCH_THRESHOLD,
      },
      // d.223：MCP 工具在清单里 ≠ 服务连得上；把「谁没连上、为什么」摊开
      mcp: summarizeMcpStatus(
        mcpRegistry.servers(),
        (id) => mcpRegistry.status(id),
        mcpRegistry.enabledTools().length,
      ),
      // d.238：网络访问边界（开放 / 仅允许 N 个域名）——被挡时用户要知道在哪儿改
      net: getNetPolicy(),
      desktop: hasFileBridge() || getShellBridge() !== null,
    });
  }

  /**
   * 就地换模型（d.195）：写回 llm store 的绑定，下一轮生效；历史与本机文件不受影响。
   * 找不到标签时仍照实说「已切换」，不编一个模型名。
   */
  function pickModel(profileId: string): void {
    if (!conv) return;
    const label = llmProfiles.find((item) => item.id === profileId)?.label ?? "该模型";
    setAgentBinding(conv.agent.id, profileId);
    setModelSwitcherOpen(false);
    setSendNotice(`已切换到 ${label}，下一轮对话生效。`, "info");
  }

  /**
   * 发送一条消息（聊天输入栏与任务区自动执行共用；附件入口带 attachment 走同一条）。
   *
   * 返回失败原因而不是只设提示：任务区自动执行失败时要把任务收口成「失败」，
   * 光靠 sendNotice 的异步 state 拿不到。
   */
  const submitMessage = async (
    rawText: string,
    mentions: { agentId: string; name: string }[],
    taskId?: string,
    attachment?: TurnAttachment,
    /** d.199：这一轮还在跑时发的纯文本 = 插话（入队，不另起流）。 */
    options?: { steer?: boolean },
  /**
   * `restoreDraft`：本地命令处理完要放回输入框的文字（d.292 的 `/rewind`）。
   *
   * 为什么不在命令里直接 `setDraft`：`send()` 拿到结果后会调 `resetComposer()` 清输入区，
   * 命令里设的值当场就被抹掉。所以文字跟着结果回到 `send()`，在清空之后落位。
   */
  ): Promise<{ ok: true; notice?: string; restoreDraft?: string } | { ok: false; error: string }> => {
    const text = rawText.trim();
    if (!text) return { ok: false, error: "消息为空" };
    // d.232：用户亲自开口 → 收尾自检的「这次已经催过几次」重新起算（`retryStream` 也走这里，
    // 「继续/接着做」自然算一次新的开始）。放在这里而不是 `startRun`：催收尾本身也调 `startRun`，
    // 在那儿清零会把刚记下的次数抹掉，导致每轮都催、变成自动循环。
    finishGateNudgesRef.current[convId] = 0;
    /**
     * `/init`（d.219）：把命令换成一段任务描述，**继续走正常发送路径**。
     *
     * 与其它 `/` 命令的区别：约定文件必须由模型真去读代码才写得准，所以这里不能
     * 本地拼一段文本了事——它是一次真正的任务（会落库、会调工具、会走写盘确认）。
     * 递归调用而不是就地改 `text`：下面的分支都基于 `text`，改局部变量容易漏。
     */
    const initPrompt = expandInitCommand(text);
    if (initPrompt !== null) return submitMessage(initPrompt, mentions, taskId, attachment, options);
    /**
     * 工作区自定义命令（d.240）：`.heming/commands/<名字>.md` → `/名字`。
     *
     * 放在内置本地命令**之后**展开：自定义命令与内置同名时（例如仓库里放了个 `plan.md`），
     * 内置语义优先——用户不会因为克隆了别人的仓库就丢掉「/plan 是计划模式」这件事。
     * 与 `/init` 一样递归回 `submitMessage` 走正常发送路径（会落库、会调工具）。
     */
    const customPrompt = expandCustomCommand(text, customCommandsRef.current);
    if (customPrompt !== null) return submitMessage(customPrompt, mentions, taskId, attachment, options);
    // 只对用户手打的单条命令生效：`/compact` 不落库、不发给模型，本地压缩完给结果。
    if (text === COMPACT_COMMAND) return await runCompactCommand(mentions);
    if (text === PLAN_COMMAND) {
      const next = !loadPlanMode(convId);
      togglePlanMode();
      return {
        ok: true,
        notice: next
          ? "已开启计划模式：这一轮只给只读工具，会先把方案给你看。"
          : "已退出计划模式：接下来可以改文件了。",
      };
    }
    // 自检与帮助同样本地完成：没有模型绑定也要能问「为什么它不动手」。
    if (text === STATUS_COMMAND) return { ok: true, notice: buildSelfStatus() };
    if (text === HELP_COMMAND) return { ok: true, notice: buildSlashHelp() };
    /**
     * 工作区工具 hooks（PreToolUse）：`/hooks` 看状态与规则、`/hooks on` 启用、`/hooks off` 关闭。
     *
     * 默认**不启用**：`.heming/hooks.json` 是仓库内容，克隆一个恶意仓库不能让它
     * 在你打开智能体时自动执行命令。启用按工作区根记（localStorage），
     * 开关文案必须明说「允许本工区脚本在本机执行」，不能让用户以为是“打开一个检查开关”。
     */
    if (text === HOOKS_COMMAND || text.startsWith(`${HOOKS_COMMAND} `)) {
      const rest = text.slice(HOOKS_COMMAND.length).trim().toLowerCase();
      const workspace =
        useChatStore.getState().conversations.find((c) => c.id === convId)?.workspace ?? "";
      if (rest === "on" || rest === "开") {
        if (!workspace.trim()) {
          return {
            ok: false,
            error: "未分组会话没有工作区：hooks 只认工作区里的 .heming/hooks.json，先把会话放进一个工作区。",
          };
        }
        if (!setToolHooksEnabled(workspace, true)) {
          return {
            ok: false,
            error: "没能保存启用状态（本机存储不可用）。为避免“看起来开了、其实没生效”，hooks 保持未启用。",
          };
        }
        const state = await toolHooksRef.current!.load(workspace, { force: true });
        return {
          ok: true,
          notice:
            `已启用本工区的 hooks。这会允许本工区的钩子脚本在你的机器上执行：规则来自工作区里的 .heming/hooks.json，脚本以你当前的用户身份运行；只在你信任这个仓库时开启。\n\n` +
            describeToolHooksState(state),
        };
      }
      if (rest === "off" || rest === "关") {
        if (workspace.trim()) setToolHooksEnabled(workspace, false);
        return {
          ok: true,
          notice:
            "已关闭本工区的 hooks：之后只加载并展示规则，不执行任何脚本，也不拦截工具（工具照常走人工确认）。",
        };
      }
      if (rest && rest !== "status" && rest !== "状态") {
        return {
          ok: true,
          notice:
            "用法：`/hooks` 看状态与规则、`/hooks on` 启用（允许本工区脚本在本机执行）、`/hooks off` 关闭。",
        };
      }
      const state = await toolHooksRef.current!.load(workspace, { force: true });
      return { ok: true, notice: describeToolHooksState(state) };
    }
    /**
     * 会话目标（d.201）：`/goal <一句话>` 设定、`/goal done` 完成、`/goal off` 清除、`/goal` 查看。
     *
     * 全本地：不发请求、不落库——目标存 localStorage（`lib/agentRuntime/goal.ts`），
     * 只影响之后每一轮的系统提示词与上面那条 GoalBar。
     */
    if (text === GOAL_COMMAND || text.startsWith(`${GOAL_COMMAND} `)) {
      const rest = text.slice(GOAL_COMMAND.length).trim();
      if (!rest) {
        const current = getGoal(convId);
        return {
          ok: true,
          notice: current
            ? `当前目标：${current.text}（会跨轮写进提示词；/goal done 标记完成、/goal off 清除）`
            : "还没有目标：用 `/goal 一句话说清要达成什么` 设定（例如 `/goal 把登录改成扫码`）。",
        };
      }
      const keyword = rest.toLowerCase();
      if (keyword === "done" || keyword === "完成") {
        const current = getGoal(convId);
        if (!current) return { ok: true, notice: "现在没有目标要标记完成。" };
        clearGoal(convId);
        return { ok: true, notice: `目标已标记完成：${current.text}（已从提示词里摘掉）` };
      }
      if (keyword === "off" || keyword === "clear" || keyword === "清除") {
        if (!getGoal(convId)) return { ok: true, notice: "现在没有目标要清除。" };
        clearGoal(convId);
        return { ok: true, notice: "目标已清除。" };
      }
      const goal = setGoal(convId, rest);
      return {
        ok: true,
        notice: goal
          ? `已设为目标：${goal.text}（之后每一轮都会看到它；说「/goal done」表示完成）`
          : "目标文本是空的，没有设定。",
      };
    }
    /**
     * 子代理写盘授权（d.202）：`/subagent write on` 授权、`write off` 收回、不带参数看状态。
     *
     * 全本地。为什么是「用户显式授权」而不是「子代理自己判断」：子代理跑在工具调用
     * 闭包里，没有人能弹窗问它「这个写要不要允许」；让它自己开等于给一条无人看守的
     * 写路径。授权只按会话记，且打开后也只多给 file_write / file_edit。
     */
    if (text === SUBAGENT_COMMAND || text.startsWith(`${SUBAGENT_COMMAND} `)) {
      const rest = text.slice(SUBAGENT_COMMAND.length).trim().toLowerCase();
      const on = rest === "write on" || rest === "on" || rest === "开";
      const off = rest === "write off" || rest === "off" || rest === "关";
      if (on) {
        setSubagentWriteEnabled(convId, true);
        setSubagentWrite(true);
        resetSubagentRuns();
        // 桥按 agentId 缓存：不清理会继续用上一轮那份「只读」子代理包
        toolBridgeRef.current.clear();
        return {
          ok: true,
          notice:
            "已允许子代理改文件：它只能用 file_write / file_edit，且只能改工作区内；改动会记进「本轮可撤回」，可以整体回滚。发 `/subagent write off` 收回。",
        };
      }
      if (off) {
        setSubagentWriteEnabled(convId, false);
        setSubagentWrite(false);
        toolBridgeRef.current.clear();
        return { ok: true, notice: "已收回子代理写盘授权：之后派出的子代理恢复只读。" };
      }
      if (rest && rest !== "status" && rest !== "状态") {
        return {
          ok: true,
          notice: "用法：`/subagent write on` 允许子代理改文件、`/subagent write off` 收回、`/subagent` 看当前状态。",
        };
      }
      return {
        ok: true,
        notice: subagentWrite
          ? "子代理写盘：已授权（本次会话）。它只能用 file_write / file_edit，改动记进「本轮可撤回」；发 `/subagent write off` 收回。"
          : "子代理写盘：只读（默认）。需要它改文件时发 `/subagent write on`；它不会自己开这个开关。",
      };
    }
    /**
     * 轮次回滚（d.290）：`/rewind` 看检查点、`/rewind N` 把最近 N 轮退回去。
     *
     * 全本地，不发模型。d.292 起**文件与对话一起退**：每轮记了「这一轮之前的最后一条消息」，
     * 回退时把边界之后的消息删掉（服务端 `POST /api/conversations/:id/messages/delete`），
     * 并把这一轮的提问放回输入框——否则你退回去还得把说过的话再打一遍。
     */
    if (text === REWIND_COMMAND || text.startsWith(`${REWIND_COMMAND} `)) {
      const rest = text.slice(REWIND_COMMAND.length).trim();
      if (!rest) return { ok: true, notice: describeTurnCheckpoints(convId) };
      if (!/^\d+$/.test(rest) || Number(rest) < 1) {
        return {
          ok: true,
          notice: "用法：`/rewind` 看有哪些检查点、`/rewind 1` 退回最近一轮（数字越大退得越多）。",
        };
      }
      const turns = Number(rest);
      const rewindPlan = planRewind(convId, turns);
      if (!rewindPlan) {
        return {
          ok: true,
          notice: `没有 ${turns} 轮可退（要么还没跑过改文件的轮次，要么已经退过了）。发 \`/rewind\` 看现在有哪些检查点。`,
        };
      }
      /**
       * 退对话：把边界之后的消息删掉。
       *
       * 边界可能落在三种状态：`null`（那一轮之前会话是空的 → 全删）、
       * 消息 id（删它之后的）、`undefined`（老检查点没记边界 → 只退文件，如实说明）。
       * 服务端删不到（本地还没同步过去）也算成功：本地镜像照样摘掉，刷新后也不会回来。
       */
      let restoreDraft: string | undefined;
      const rewindDialogue = async (): Promise<string> => {
        const boundary = rewindPlan.afterMessageId;
        if (boundary === undefined) return "这几轮是老记录、没存对话边界，对话没有退。";
        const list = useChatStore.getState().messages[convId] ?? [];
        let ids: string[];
        if (boundary === null) {
          ids = list.map((item) => item.id);
        } else {
          const at = list.findIndex((item) => item.id === boundary);
          if (at === -1) return "本地找不到那一轮的分界消息，对话没有退（文件已退回）。";
          ids = list.slice(at + 1).map((item) => item.id);
        }
        if (ids.length === 0) return "对话本来就已经在这一轮之前了，没有要删的消息。";
        try {
          await deleteMessages(convId, ids);
        } catch (err) {
          return `对话没有退（${(err as Error).message}），文件已退回。`;
        } finally {
          // 服务端成功与否都把本地镜像摘掉：它是「服务端已删」的投影，留着会让人以为没退
          useChatStore.getState().removeMessages(convId, ids);
        }
        if (rewindPlan.prompt) {
          // 交给 send() 在 resetComposer 之后落位：在这设会被紧接着的清空抹掉
          restoreDraft = rewindPlan.prompt;
          return `对话退了 ${ids.length} 条，你那句提问已放回输入框。`;
        }
        return `对话退了 ${ids.length} 条。`;
      };

      const fileBridge = getFileBridge();
      if (!fileBridge) {
        return { ok: true, notice: "当前环境没有文件桥（浏览器里没有本地文件权限），回滚只能在桌面端用。" };
      }
      const workspace = useChatStore.getState().conversations.find((c) => c.id === convId)?.workspace;
      const roots = fileRootsFor(workspace ?? null);
      if (roots.length === 0) {
        return { ok: true, notice: "这个会话还没有可写目录，没法还原文件。" };
      }
      const ops = [
        ...rewindPlan.restore.map((item) => ({ kind: "write" as const, path: item.path, content: item.content })),
        ...rewindPlan.remove.map((path) => ({ kind: "delete" as const, path })),
      ];
      const skippedNote =
        rewindPlan.skipped.length > 0
          ? `；${rewindPlan.skipped.length} 个抓不到原文没动（${rewindPlan.skipped
              .slice(0, 3)
              .map((item) => item.path.split("/").pop() ?? item.path)
              .join("、")}）`
          : "";
      let fileNote: string;
      if (ops.length === 0) {
        // 全是跳过的轮次：文件没得退，但对话照样退——否则用户看到的那几轮会一直挂着。
        fileNote = `这些改动都抓不到原文，没有文件被还原${skippedNote}`;
      } else {
        const result = await fileBridge.write({ roots, ops });
        if (!result.ok) {
          return {
            ok: true,
            notice: `回滚没有完成：${result.error ?? "写盘失败"}（文件可能只还原了一部分，对话没有动）。`,
          };
        }
        const restored = result.written ?? rewindPlan.restore.length;
        const removed = result.deleted ?? rewindPlan.remove.length;
        const parts: string[] = [];
        if (restored > 0) parts.push(`还原 ${restored} 个文件`);
        if (removed > 0) parts.push(`删掉 ${removed} 个当时还不存在的文件`);
        fileNote = `${parts.join("、") || "没有文件需要改"}${skippedNote}`;
      }
      // 记账要在退对话之前：对话退失败也不该让这几轮一直显示成「还能退」
      dropTurnCheckpoints(convId, rewindPlan.turns);
      const dialogueNote = await rewindDialogue();
      // d.335：命令造成的改动没有原文可还原，必须明说，别让人以为整轮都退干净了
      const commandNote = describeShellCommandsNote(rewindPlan.commands);
      return {
        ok: true,
        notice: `已退回 ${rewindPlan.turns} 轮：${fileNote}；${dialogueNote}${commandNote ? `\n${commandNote}` : ""}`,
        ...(restoreDraft ? { restoreDraft } : {}),
      };
    }
    /**
     * 系统通知开关（d.208）：`/notify off` 关掉、`/notify on` 打开、不带参数看状态。
     *
     * 全本地。默认开：它只在「窗口不在前台」时才会真弹（桌面端两道判断），
     * 所以正常情况下不会打扰；给开关是因为总有人不想被系统弹窗打断。
     */
    if (text === NOTIFY_COMMAND || text.startsWith(`${NOTIFY_COMMAND} `)) {
      const rest = text.slice(NOTIFY_COMMAND.length).trim().toLowerCase();
      const on = rest === "on" || rest === "开";
      const off = rest === "off" || rest === "关";
      if (on) {
        setDesktopNotifyEnabled(true);
        return {
          ok: true,
          notice: "已打开系统通知：窗口不在前台时，一轮做完 / 出错 / 工具等你确认会弹一次；点通知回到那个会话。",
        };
      }
      if (off) {
        setDesktopNotifyEnabled(false);
        return { ok: true, notice: "已关闭系统通知：之后只在应用内提示，不再弹桌面通知。" };
      }
      if (rest && rest !== "status" && rest !== "状态") {
        return { ok: true, notice: "用法：`/notify off` 关闭系统通知、`/notify on` 打开、`/notify` 看当前状态。" };
      }
      return {
        ok: true,
        notice: isDesktopNotifyEnabled()
          ? "系统通知：开（窗口不在前台时，跑完 / 出错 / 等你确认会弹一次，点通知回到会话）。发 `/notify off` 关闭。"
          : "系统通知：关（只在应用内提示）。发 `/notify on` 打开。",
      };
    }
    /**
     * MCP 懒预检（用户要求：工具要自动识别并加载）。
     *
     * 应用启动时已经自动连过一次，但那次可能失败（uvx 首次下载依赖要一两分钟、
     * 命令不在 PATH、服务当时没起来）。若不补这一步，这次对话就会静默地
     * 少一批工具——模型不知道自己本可以用 PowerShell，用户也看不出发生了什么。
     *
     * 只在「有启用中的服务却还没发现过工具」时才连，正常路径零开销。
     * 永不阻塞发送：预检失败只是这轮没有 MCP 工具，聊天照常。
     * 已预检过（mcpPrefetched）就不再重复——一次会话里补连一次就够了。
     */
    if (!mcpPrefetched.current && Date.now() >= mcpRetryAtRef.current && mcpNeedsConnect()) {
      mcpPrefetched.current = true;
      void autoConnectAll()
        .then(() => {
          // 连完把标记复位：下次仍有缺工具的服务时还能再补
          mcpPrefetched.current = false;
          // 还是连不上 → 冷却一分钟，别让每条消息都卡在重连上
          if (mcpNeedsConnect()) mcpRetryAtRef.current = Date.now() + 60_000;
        })
        .catch(() => {
          /* 静默：这轮没有 MCP 工具，但不该挡住聊天 */
          mcpPrefetched.current = false;
          mcpRetryAtRef.current = Date.now() + 60_000;
        });
    }
    // 硬验收⑤：无 subtle 先拦（保留草稿与已选 mention），绝不降级明文发送
    if (!hasSubtle()) {
      return { ok: false, error: NO_E2E_NOTICE };
    }
    // 发送前拦截：@ 到的智能体没绑 LLM 连接 → 不发消息，本地提示去「模型」页绑定（草稿/chip 保留）
    const unbound = mentions.find((m) => !resolveProfile(m.agentId));
    if (unbound) {
      const error = `${unbound.name} 未绑定 LLM 连接，请先到「模型」页绑定`;
      return { ok: false, error };
    }
    if (!wsHandleRef.current) {
      // 保留草稿与已选 mention，给出可见提示（不静默丢弃）
      const error = "连接未就绪，消息未发送";
      return { ok: false, error };
    }
    // 正文/mentions 全进密文（§3.3），事件 payload 只留 {text:""} 占位
    const plain: PlainEnvelope = {
      kind: attachment ? "file" : "text",
      text,
      ...(attachment ? { file: attachment } : {}),
      ...(mentions.length ? { mentions } : {}),
    };
    // 拦截/封失败：草稿与浮层状态原样保留
    if (!(await sealAndSend(plain))) return { ok: false, error: "消息发送失败" };
    // 发送成功即触发智能体的本机流式生成（失败/中断由 WS 三事件回声收口）
    if (mentions.length) {
      if (options?.steer) {
        /*
         * 这一轮还在跑（d.199）：不另起第二条流——两条流会共用工具计数 /
         * 自改预算并互相重置，复盘判定与预算双双失真（这是以前直接拒绝发送的原因）。
         * 改成入队：编排层下一步取走，模型看到「工具结果 → 用户新指示」。
         */
        const size = steerQueueOf(convId).push({ text, mentions });
        setSteerPendingCount(size);
        return {
          ok: true,
          notice: `已插话（排队 ${size} 条）：这一轮下一步就能看到；如果它已经收尾，会接着处理。`,
        };
      }
      startRun(mentions, text, taskId, attachment);
    }
    return { ok: true };
  };

  /** 发送成功后清空输入区（草稿 / 旧提示）。 */
  const resetComposer = () => {
    setDraft("");
    cancelDraftSave();
    clearDraft(convId);
    setSendNotice(null);
  };

  /**
   * 取消排队的插话（d.227）。
   *
   * 为什么允许收回：插话是「还没被模型看到的那几句」，写完就发现说错了是常事。
   * 取消只清内存队列——那几条消息已经在会话里（发出去时就上行落库了），所以这一轮
   * 不会被插嘴，但文字本身没丢，后面的轮次仍能从历史里看到。
   */
  const cancelSteerQueue = () => {
    const queue = steerQueueOf(convId);
    const missed = queue.size();
    if (missed === 0) return;
    queue.clear();
    setSteerPendingCount(0);
    setSendNotice(`已取消排队的 ${missed} 条插话（内容还在会话里，这一轮照常跑完）。`, "info");
  };

  /**
   * A9：纯文本发送失败后的「重试」——重放失败时的那份内容（文本/mentions），
   * 不读当前草稿（用户可能已经改过字）；附件场景不提供重试（避免重放一次上传）。
   * 失败仍在 → 继续挂重试入口，用户可再点。
   */
  const retryTextSend = async (
    text: string,
    mentions: { agentId: string; name: string }[],
  ) => {
    const result = await submitMessage(text, mentions);
    if (!result.ok) {
      setSendNotice(result.error, "error", () => void retryTextSend(text, mentions));
      return;
    }
    // 失败后用户可能已经改了草稿：只在「还是原来那份」时清空输入区，
    // 否则保留他新写的字，只把提示换成成功态（避免重试把他刚输入的内容吞掉）。
    if (draftRef.current === text) {
      resetComposer();
      return;
    }
    setSendNotice("已重新发送", "info");
  };

  /**
   * d.294 单条消息重答：撤掉那一轮（提问 + 它之后的全部消息），再用同一句提问重跑。
   *
   * 顺序是有讲究的：**先删再发**。反过来的话 `fetchHistory` 读到的还是旧对话，
   * 模型会看见「同一句提问问了两遍」——这正是重答要避免的东西。
   * 删除失败就整件事不做：宁可没重答，也不要留下「删了一半」的会话。
   * 重答本身发不出去时把提问放回输入框，用户不至于连原文都找不回（消息已经删了）。
   */
  const regenerateFrom = async (plan: RegeneratePlan, messageId: string) => {
    if (activeLocal.length > 0) {
      setSendNotice("还在生成中：等这一轮结束再重答。", "info");
      return;
    }
    setRegenConfirm(null);
    setRegenBusyId(messageId);
    try {
      await deleteMessages(convId, plan.ids);
    } catch (err) {
      setRegenBusyId(null);
      setSendNotice(`没能删掉旧回答（${(err as Error).message}），这次没有重答。`, "error");
      return;
    }
    // 服务端已删：本地镜像同步摘掉，否则这一轮还会出现在列表里、也会被算进 fetchHistory。
    useChatStore.getState().removeMessages(convId, plan.ids);
    const result = await submitMessage(plan.prompt, effectiveMentions);
    setRegenBusyId(null);
    if (!result.ok) {
      setDraft(plan.prompt);
      saveDraft(convId, plan.prompt);
      setSendNotice(`旧回答已撤掉，但重答没发出去：${result.error}。提问已放回输入框。`, "error");
      return;
    }
    setSendNotice(
      plan.later > 0 ? `已撤掉这一轮和它后面的 ${plan.later} 条，正在重答。` : "正在重答。",
      "info",
    );
  };

  /** 点「重答」：能直接算清楚的先问一句（会删后面几条），最后一条则不用二次确认那么重。 */
  const askRegenerate = (messageId: string, plan: RegeneratePlan) => {
    if (activeLocal.length > 0) {
      setSendNotice("还在生成中：等这一轮结束再重答。", "info");
      return;
    }
    // 只有最后一条回答：删的就是这一问一答，不涉及「后面的消息也没了」，不值得再点一次确认。
    if (plan.later === 0) {
      void regenerateFrom(plan, messageId);
      return;
    }
    setRegenConfirm({ id: messageId, plan });
  };

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    // 空草稿：按钮已 disabled；回车/表单提交也要兜住，不把「消息为空」当成错误弹红。
    // 有待发附件时「空正文」是合法的（纯附件消息），不在这里拦。
    if (!draft.trim() && pendingFiles.length === 0) return;
    /*
     * 运行中插话（d.199）：这一轮还在跑时，纯文本照发。
     *
     * 以前这里是直接拒绝（「先点停止，或等这一轮结束再发」）。可点停止会丢掉这一轮
     * 已经做好的部分，等结束又太晚——用户真正想说的是「别改文件了，先跑测试」这种
     * 中途修正。现在改成入队：正文在下一个工具轮就被模型看到，这一轮若先收尾，
     * 再由收尾回调另起一轮接着处理（绝不静默丢）。
     *
     * 带附件的仍拦：附件是单回合输入，中途插进去没有上传时机、也没有回合可挂。
     */
    const running = activeLocal.length > 0;
    if (running && (pendingFiles.length > 0 || fileRefs.length > 0)) {
      setSendNotice("正在生成中：带附件的话请等这一轮结束再发", "info");
      return;
    }
    /*
     * 超长消息（d.233）：第一次点击只提醒，第二次才真发。
     *
     * 输入框没有长度上限，粘一份 300 KB 日志也能直接发出去——后果是上下文被这一条吃掉
     * （历史压缩把之前几轮折成摘要，模型「突然忘了要求」）、或者服务端直接 400（看起来
     * 像网络错误）、或者账单。这里不截断、不偷偷改内容，只把代价说清楚并给更好的做法。
     * 放在附件分支之前：正文 + 附件一起发时，正文同样吃预算。
     */
    {
      const inspection = inspectOutgoingText(draft);
      if (inspection.tooLarge && !largeSendConfirmedRef.current) {
        largeSendConfirmedRef.current = true;
        setSendNotice(largeMessageNotice(inspection), "info");
        return;
      }
    }
    // 附件走独立通道：正文 + 第一个附件同发，其余各发一条 file 消息
    if (pendingFiles.length > 0) {
      await sendPendingFiles(draft, effectiveMentions);
      return;
    }
    const text = draft;
    const mentions = effectiveMentions;
    const result = await submitMessage(
      text,
      mentions,
      undefined,
      undefined,
      running ? { steer: true } : undefined,
    );
    if (!result.ok) {
      // 纯文本发送失败：红色 role=alert + 「重试」（附件路径见 sendFile，不给重试）。
      // NO_E2E 例外：常驻横幅本身就是 role=alert，不再重复一条同样的红字。
      if (result.error !== NO_E2E_NOTICE) {
        setSendNotice(result.error, "error", () => void retryTextSend(text, mentions));
      }
      return;
    }
    // 会话名：首条消息后写一次服务端标题（换设备也能看到）；之后不再覆盖用户的意图。
    const titleText = text.replace(/\s+/g, " ").trim().slice(0, 24);
    const conv = conversations.find((c) => c.id === convId);
    if (titleText && !conv?.title && !titleSetRef.current.has(convId)) {
      titleSetRef.current.add(convId);
      void renameConversation(convId, titleText).catch(() => {
        // 写标题失败不影响发送；下次发消息再试（不把失败记成已写）
        titleSetRef.current.delete(convId);
      });
    }
    resetComposer();
    // 发出去之后复位「超长已确认」（d.233）：下一条消息重新从「先提醒一次」开始。
    largeSendConfirmedRef.current = false;
    // 本地命令（如 `/compact`）不产生消息，但它的结果要留在这条「提示位」上：
    // resetComposer 会清 sendNotice，所以在它之后再落位。
    if (result.notice) setSendNotice(result.notice, "info");
    // `/rewind` 把当时那句提问放回输入框（必须在 resetComposer 之后，否则当场被清掉）
    if (result.restoreDraft) {
      setDraft(result.restoreDraft);
      saveDraft(convId, result.restoreDraft);
    }
  };

  // 任务区投递：把目标写进输入区并排队自动发送（连接可能还没就绪，见下一个 effect）。
  // 命中会话才消费——投递槽是单条，别的会话的草稿不该在这里被吃掉。
  useEffect(() => {
    if (!taskDraft || taskDraft.conversationId !== convId) return;
    consumeTaskDraft();
    setDraft(taskDraft.text);
    // 投递来的目标也要落盘：否则刷新一下这段文本就没了
    saveDraft(convId, taskDraft.text);
    setSendNotice(null);
    setAutoTask(taskDraft);
  }, [taskDraft, convId, consumeTaskDraft]);

  // 自动执行：等 WS 连接就绪再发（首次打开会话时 connected 还是 false）。
  // 失败只收口任务记录并保留用户写的目标——不静默丢，也不误标成功。
  useEffect(() => {
    if (!autoTask || !connected) return;
    const pending = autoTask;
    setAutoTask(null);
    void (async () => {
      const result = await submitMessage(pending.text, pending.mentions, pending.taskId);
      if (!result.ok) {
        useTaskStore.getState().settle(pending.taskId, { status: "failed", error: result.error });
        notifyTaskSettled(pending.taskId, "failed", result.error);
        setSendNotice(result.error, "error");
        return;
      }
      setDraft("");
      cancelDraftSave();
      clearDraft(convId);
      setSendNotice(null);
    })();
    // submitMessage 每帧重建；本 effect 只该在「投递到达 / 连接就绪」时跑一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoTask, connected]);

  /** 附件上限：服务端 json 体上限 8MB，base64 膨胀约 4/3 → 6MB 留余量（超限给可见提示）。 */
  const MAX_UPLOAD = 6 * 1024 * 1024;

  /** 工具行「图片/文件」入口：临时 file input（不入 DOM），选中即进待发列表（E1）。 */
  const pickFile = (accept: string | undefined) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true; // E1：可一次选多个，进列表后逐个核对/移除
    if (accept) input.accept = accept;
    input.onchange = () => {
      const files = Array.from(input.files ?? []);
      if (files.length === 0) return;
      enqueueFiles(files);
    };
    input.click();
  };

  /**
   * 把文件收进「待发附件」列表（E1）：四个入口（工具行 / 粘贴 / 拖拽 / 录音）共用。
   * 只做本地校验（6MB、重复、数量上限），**不上传**——上传留到发送时，
   * 这样用户移除或改主意不白跑一次加密上传、不占服务端配额。
   */
  const enqueueFiles = (files: File[]) => {
    if (!hasSubtle()) {
      // 常驻横幅已说明原因（role=alert），这里不叠第二条相同提示
      return;
    }
    const accepted: PendingFile[] = [];
    for (const f of files) {
      if (f.size > MAX_UPLOAD) {
        setSendNotice(`文件需小于 6MB：${f.name}`, "error");
        continue;
      }
      const dup = [...pendingFiles, ...accepted].some(
        (p) =>
          p.file.name === f.name &&
          p.file.size === f.size &&
          p.file.lastModified === f.lastModified,
      );
      if (dup) continue;
      if (pendingFiles.length + accepted.length >= MAX_PENDING_FILES) {
        setSendNotice(`一次最多带 ${MAX_PENDING_FILES} 个附件`, "info");
        break;
      }
      pendingFileSeq += 1;
      accepted.push({ key: `pf-${pendingFileSeq}`, file: f });
    }
    if (accepted.length > 0) setPendingFiles((prev) => [...prev, ...accepted]);
  };

  /** 从待发列表移除一个附件（不发送）；键盘可达的移除按钮在 chip 上。 */
  const removePendingFile = (key: string) => {
    setPendingFiles((prev) => prev.filter((p) => p.key !== key));
  };

  /**
   * 上传一个待发附件并拼出 TurnAttachment（E1 的发送阶段）。
   *
   * 抽出来的原因：以前「上传 + 发送」焊在 sendFile 里，选中即发；现在上传发生在
   * 用户按发送的那一刻，而发送有两条路（正文同发 / 纯附件各发一条），
   * 只保留一次实现，错误文案与 6MB/能力/会话切换的收口才不会分叉。
   */
  const uploadAttachment = async (
    f: File,
    handle: WsHandle,
  ): Promise<
    | { ok: true; file: TurnAttachment; notice: string | null }
    | { ok: false; error: string }
  > => {
    try {
      // 解析不放"正在读取"这类提示：它通常几百毫秒就完，
      // 闪一下反而干扰；更要紧的是 status 那个位置要留给真正的错误
      //（上传失败 / 内容提取失败），被占住会让错误提示延后出现。
      const mime = f.type || "application/octet-stream";
      // 图片能被模型读到的前提是绑定的模型支持视觉（能力表）；不支持时照常发送，
      // 但要当场说明「模型看不到内容」，而不是让用户等一句「我看不到图片」。
      // 文案与工具降级共用 capabilityNotice，两处口径一致。
      const visionNotice = capabilityNotice(
        "vision",
        effectiveMentions.map((m) => ({ name: m.name, profile: resolveProfile(m.agentId) })),
      );
      const doc = isDocumentLike(f.name, mime) ? await parseDocument(f, f.name) : null;

      const meta = await uploadEncryptedFile(f);
      // await 后闭包已旧：切了会话或 socket 已换/已关则丢弃，防发错会话/向已关句柄静默发送
      const live = wsHandleRef.current;
      if (live !== handle || useUiStore.getState().activeConversationId !== convId) {
        // 由调用方统一转成可见提示（这里不再自己 setSendNotice，避免两处文案分叉）
        return { ok: false, error: "已切换会话，文件未发送" };
      }
      // 消息侧保留原名/原 mime/原大小（气泡按它路由与展示），fileKey 随消息进密文；
      // meta 是服务端密文形态（.enc 名 + octet-stream），仅取 id。
      // text：解析出的文档内容，随文件一起进密文——服务端始终拿不到明文。
      const file: TurnAttachment = {
        id: meta.id,
        name: f.name,
        mime,
        size: f.size,
        key: meta.key,
        ...(doc?.ok && doc.text ? { text: doc.text } : {}),
      };
      // 解析/能力提示与发送结果共用一条口径：图片没有文档文本，成功时保留
      // 「模型不支持视觉」的提示——这一条比「已发送」更有用，用户据此决定要不要换模型或改问法。
      const notice = !doc
        ? visionNotice
        : doc.ok
          ? doc.truncated
            ? `已发送；内容较长，模型只读到前 ${doc.chars} 字`
            : null
          : `已发送；内容未能提取：${doc.error ?? "未知原因"}`;
      return { ok: true, file, notice };
    } catch (err) {
      return { ok: false, error: `上传失败：${(err as Error).message}` };
    }
  };

  /**
   * 把没发出去的附件放回待发列表。
   * 已经切到别的会话时不再放回：旧会话的附件飘进新会话的输入区，
   * 用户会看见一张自己没选过、也不知道属于哪段对话的图（切会话本来就会清列表）。
   */
  const restorePending = (files: PendingFile[]) => {
    if (useUiStore.getState().activeConversationId !== convId) return;
    setPendingFiles(files);
  };

  /**
   * 提交待发附件（E1）：正文 + 第一个附件合成同一条 file 消息（模型当轮就能读到），
   * 其余附件各发一条 file 消息；串行，失败即停并**保留**没发出去的那几个。
   *
   * 为什么不改成「N 个附件合成一条」：消息协议里一条 file 消息只带一个 file，
   * 服务端与历史渲染都按这个形状走；拆成 N 条是既有语义（拖入 3 个文件本来就发 3 条）。
   */
  const sendPendingFiles = async (
    text: string,
    mentions: { agentId: string; name: string }[],
  ) => {
    // A8：上传中防重入（按钮已禁用，这里兜住回车/粘贴同帧连发）
    if (uploadingRef.current) return;
    if (!hasSubtle()) {
      // 常驻横幅已说明原因（role=alert）
      return;
    }
    const handle = wsHandleRef.current;
    if (!handle) {
      setSendNotice("连接未就绪，消息未发送", "error");
      return;
    }
    const wantsText = text.trim().length > 0;
    // 同发前先把「@ 了没绑模型的智能体」拦在上传之前：上传要几秒，
    // 传完才被 submitMessage 拦下等于白传一个占配额又发不出去的孤儿文件。
    if (wantsText) {
      const unbound = mentions.find((m) => !resolveProfile(m.agentId));
      if (unbound) {
        setSendNotice(`${unbound.name} 未绑定 LLM 连接，请先到「模型」页绑定`, "error");
        return;
      }
    }
    uploadingRef.current = true;
    setUploading(true);
    try {
      const queue = [...pendingFiles];
      if (wantsText) {
        const head = queue.shift();
        if (!head) return;
        const up = await uploadAttachment(head.file, handle);
        if (!up.ok) {
          // 未发出：附件与草稿都留着，用户可改完再按一次发送
          setSendNotice(up.error, "error");
          return;
        }
        const result = await submitMessage(text, mentions, undefined, up.file);
        if (!result.ok) {
          setSendNotice(result.error, "error");
          return;
        }
        restorePending(queue);
        setDraft("");
        cancelDraftSave();
        clearDraft(convId);
        // 成功/能力提示最后落（上面 clearDraft 不会动 sendNotice，但顺序更清楚）
        setSendNotice(up.notice);
      }
      for (let i = 0; i < queue.length; i += 1) {
        const p = queue[i];
        const up = await uploadAttachment(p.file, handle);
        if (!up.ok) {
          restorePending(queue.slice(i));
          setSendNotice(up.error, "error");
          return;
        }
        const ok = await sealAndSend({ kind: "file", text: "", file: up.file });
        if (!ok) {
          restorePending(queue.slice(i));
          setSendNotice("消息发送失败", "error");
          return;
        }
        // 每成功一条就把剩下的写回列表：中途失败时列表正好剩没发的部分
        restorePending(queue.slice(i + 1));
        setSendNotice(up.notice);
      }
    } finally {
      uploadingRef.current = false;
      setUploading(false);
    }
  };

  /**
   * 语音输入开关（Web Speech API）：环境缺构造器（Electron/无 Google 语音 key 属预期）
   * → 可见提示，不自造录音/转写；可用时识别结果直接追加进草稿。
   */
  const toggleVoice = () => {
    const SR =
      (window as unknown as {
        SpeechRecognition?: new () => never;
        webkitSpeechRecognition?: new () => never;
      }).SpeechRecognition ??
      (window as unknown as { webkitSpeechRecognition?: new () => never }).webkitSpeechRecognition;
    if (!SR) {
      setSendNotice("当前环境不支持语音输入");
      return;
    }
    if (listening) {
      recRef.current?.stop();
      return;
    }
    const rec = new (SR as unknown as new () => {
      lang: string;
      interimResults: boolean;
      continuous: boolean;
      onresult: (e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void;
      onend: () => void;
      onerror: () => void;
      start(): void;
      stop(): void;
    })();
    rec.lang = "zh-CN";
    rec.interimResults = true;
    rec.continuous = false;
    // 迟到回调守卫：切会话后 recRef 已置空/换新，旧实例的收尾回调不得作用于新会话
    // （onresult 回填新会话草稿、onend 误清新指示、onerror 弹无关的错误提示）
    rec.onresult = (e) => {
      if (recRef.current !== rec) return;
      let t = "";
      for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript;
      setDraft((d) => {
        const next = d ? `${d}${t}` : t;
        // 语音回填也要落盘（StrictMode 下 updater 可能被调两次，写入同一份文本，幂等）
        scheduleDraftSave(convId, next);
        return next;
      });
    };
    rec.onend = () => {
      if (recRef.current !== rec) return;
      setListening(false);
    };
    rec.onerror = () => {
      if (recRef.current !== rec) return;
      setListening(false);
      setSendNotice("语音识别不可用", "error");
    };
    recRef.current = rec;
    rec.start();
    setListening(true);
  };

  /** 特性检测：无 MediaRecorder 或缺 mediaDevices.getUserMedia 时录音选项禁用 + 小字提示（不自造降级）。 */
  const hasRecorder = typeof MediaRecorder !== "undefined" && !!navigator.mediaDevices?.getUserMedia;

  /**
   * 开始录音（语音消息选项）：getUserMedia → MediaRecorder 录 webm。
   * 结束（自然停 / 60s 上限 / 手动停）统一在 onstop：停轨 → 时长判定（<1s 拒发）
   * → 进待发附件列表（E1：6MB 上限与失败提示一并继承，上传留到发送时）。
   */
  const startRecording = async () => {
    // 录音中 或 授权 await 挂起中都挡重入：voiceRecRef 要到 recorder.start() 后才有值，
    // 授权窗口内再点一次会覆写 voiceRecCancelRef，首实例取消链断裂 → 麦克风轨无「录音中」指示且无人停
    if (voiceRecRef.current || voiceRecPendingRef.current) return;
    const pendingToken = {}; // 身份 token：resolve/失败路径只清「仍是本实例」的占位，不误清后一实例
    voiceRecPendingRef.current = pendingToken;
    let stream: MediaStream | null = null;
    let rec: MediaRecorder | null = null;
    let cancelled = false; // 本实例取消位（闭包）：取消/切会话/卸载 → 停止启动/跳过发送
    // 取消位必须在 await getUserMedia「之前」注册：首次授权弹窗可能挂起数秒~数分钟，
    // 该窗口内切会话/卸载调的 voiceRecCancelRef.current?.() 才不是 no-op。cancel 对尚未
    // 创建的 rec 判空——此时只置位，resolve 后由下面的校验停轨且不启动。
    const cancel = () => {
      cancelled = true;
      if (rec && rec.state === "recording") rec.stop();
    };
    voiceRecCancelRef.current = cancel;
    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream = mediaStream;
      // resolve 后先校验：授权等待期已被取消/切会话 → 立即停轨返回，不启动录音、不上传
      if (cancelled) {
        mediaStream.getTracks().forEach((t) => t.stop());
        return;
      }
      const recorder = new MediaRecorder(mediaStream);
      rec = recorder; // 供 cancel（await 前注册）与 finally 判空：闭包内改用窄化后的 recorder
      const chunks: BlobPart[] = [];
      recorder.ondataavailable = (e) => chunks.push(e.data);
      recorder.onstop = () => {
        mediaStream.getTracks().forEach((t) => t.stop()); // 无论发不发送都停麦克风轨（防占用/泄漏）
        if (voiceRecTimerRef.current != null) {
          clearTimeout(voiceRecTimerRef.current); // 60s 上限定时器随结束即清
          voiceRecTimerRef.current = null;
        }
        if (voiceRecRef.current === recorder) voiceRecRef.current = null;
        if (voiceRecCancelRef.current === cancel) voiceRecCancelRef.current = null;
        setRecording(false);
        if (cancelled) return; // 取消/切会话/卸载：静默放弃，不上传不发送
        const dur = Date.now() - voiceRecStartRef.current;
        const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
        if (dur < 1000) {
          setSendNotice("录音太短，未发送", "error");
          return;
        }
        const f = new File(
          [blob],
          `语音-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}.webm`,
          { type: blob.type },
        );
        enqueueFiles([f]); // E1：录音也进待发列表，发送时才上传（与图片/文件/粘贴一致）
      };
      recorder.start();
      voiceRecRef.current = recorder;
      voiceRecStartRef.current = Date.now();
      setRecording(true);
      setSendNotice(null);
      voiceRecTimerRef.current = window.setTimeout(() => {
        if (voiceRecRef.current === recorder && recorder.state === "recording") recorder.stop(); // 60s 上限自动停
      }, 60_000);
    } catch {
      if (stream) stream.getTracks().forEach((t) => t.stop()); // 半途失败（权限拒/无设备）不留活轨
      if (!cancelled) setSendNotice("无法访问麦克风", "error"); // 取消/切会话后的授权失败保持静默
    } finally {
      // 本次启动未接续到录音（授权等待期被取消 / getUserMedia 失败）：清掉可能残留的 cancel 注册。
      // rec 非空时交给 onstop 收口，且不误清后一实例已注册的 cancel。
      if (!rec && voiceRecCancelRef.current === cancel) voiceRecCancelRef.current = null;
      // pending 占位同样按身份清（成功启动时：占位仍为本实例，一并清；voiceRecRef 已接管重入防线）
      if (voiceRecPendingRef.current === pendingToken) voiceRecPendingRef.current = null;
    }
  };

  /** 正常停止：onstop 里按时长判定发送（<1s 拒发）。 */
  const stopRecording = () => {
    const rec = voiceRecRef.current;
    if (rec && rec.state === "recording") rec.stop();
  };

  /** 取消：置本实例取消位后 stop——onstop 停轨、跳过发送，静默退出录音态。 */
  const cancelRecording = () => {
    voiceRecCancelRef.current?.();
  };

  // —— A3：滚动贴底与「↓ 新消息」 ——

  /** 主动回到底部（浮动按钮/切会话用）：同时重置贴底状态，后续继续跟随。 */
  const scrollToLatest = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      atBottomRef.current = true;
      setNewBelow(false);
      scrollListToBottom(behavior);
    },
    [scrollListToBottom],
  );

  /**
   * 阅读位置写盘（d.83）：滚动时采样，节流 200ms 写一次；页面隐藏/卸载时补最后一次。
   * 只记 scrollTop / 是否贴底 / 当前窗口，不碰消息内容。
   */
  const pendingScrollSave = useRef<{
    convId: string;
    top: number;
    atBottom: boolean;
    windowCount: number;
  } | null>(null);
  const scrollSaveTimer = useRef<number | null>(null);
  const flushScrollSave = useCallback(() => {
    const v = pendingScrollSave.current;
    if (!v) return;
    pendingScrollSave.current = null;
    writeChatScroll(v.convId, { top: v.top, atBottom: v.atBottom, windowCount: v.windowCount });
  }, []);
  const scheduleScrollSave = useCallback(
    (top: number, atBottom: boolean) => {
      pendingScrollSave.current = { convId, top, atBottom, windowCount };
      if (scrollSaveTimer.current !== null) return;
      scrollSaveTimer.current = window.setTimeout(() => {
        scrollSaveTimer.current = null;
        flushScrollSave();
      }, 200);
    },
    [convId, windowCount, flushScrollSave],
  );
  useEffect(() => {
    const flush = () => flushScrollSave();
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
      if (scrollSaveTimer.current !== null) {
        window.clearTimeout(scrollSaveTimer.current);
        scrollSaveTimer.current = null;
      }
      flushScrollSave();
    };
  }, [flushScrollSave]);

  /** 消息区滚动：更新贴底判定（<80px 视为贴底），顺带触发「加载更早」。 */
  const onMessageScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distance < STICK_BOTTOM_PX;
    atBottomRef.current = atBottom;
    if (atBottom) setNewBelow(false); // 自己滚回底部即视为看过
    scheduleScrollSave(el.scrollTop, atBottom);
    if (shouldLoadMore(el.scrollTop, visibleMessages.length, windowCount)) {
      loadEarlierMessages();
    }
  };

  /** A7 + E1：拖拽文件到消息区 → 进待发附件列表（校验同粘贴，不再拖入即发）。 */
  const onMessagesDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (Array.from(e.dataTransfer?.types ?? []).includes("Files")) e.preventDefault();
  };
  const onMessagesDrop = (e: React.DragEvent<HTMLDivElement>) => {
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    e.preventDefault();
    enqueueFiles(files);
  };

  // —— A5：整条消息复制（clipboard + execCommand 兜底，短暂「已复制」） ——

  const copyMessage = async (m: Message) => {
    const text = m.payload.text ?? "";
    let ok = true;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(text);
    } catch {
      // 非安全上下文/权限缺失的退路：临时 textarea + execCommand（与代码块复制同款）
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      } finally {
        document.body.removeChild(area);
      }
    }
    if (!ok) return; // 两条路都失败就不装作成功
    setCopiedMsgId(m.id);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopiedMsgId(null), 1600);
  };
  // 卸载时清掉复制态定时器（避免对已卸载组件 setState）
  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    [],
  );

  // 提示位（B 轨 E3）：把并列的四五条提示收成一个列表，渲染处只放前 2 条 +「还有 N 条」。
  const notices = useMemo<NoticeItem[]>(() => {
    const list: NoticeItem[] = [];
    if (forkNotice) list.push({ key: "fork", tone: "warn", text: forkNotice });
    if (toolsNotice) list.push({ key: "tools", tone: "warn", text: toolsNotice });
    if (sendNotice) {
      list.push({
        key: "send",
        tone: sendNotice.kind === "error" ? "error" : "warn",
        text: sendNotice.text,
        retry: sendNotice.retry,
      });
    }
    return list;
  }, [forkNotice, toolsNotice, sendNotice]);
  // 提示变少时自动收起，避免「展开」状态挂着一个已经不存在的列表。
  useEffect(() => {
    setNoticeExpanded(false);
  }, [notices.length]);
  const visibleNotices = noticeExpanded ? notices : notices.slice(0, NOTICE_VISIBLE_ROWS);
  const hiddenNoticeCount = notices.length - visibleNotices.length;

  return (
    <div className="flex h-full">
      <div className="relative flex h-full min-w-0 flex-1 flex-col">
      {/* 会话头（T32 编排条）：第一行标题 + 编排事实 chips + 右侧既有动作，
          第二行「对话 / 轨迹 / 上下文」页签。返回、通道状态、会话进度、会话内搜索
          全部保留；进度栏仍在最右侧独立渲染，不随页签切换。 */}
      <OrchestrationBar
        title={conv ? conversationTitle(conv, messages) : "会话"}
        toolsCount={progress.counts.total}
        tasksCount={runningTaskCount}
        view={view}
        onViewChange={setView}
        onOpenCollab={() => useUiStore.getState().setPage("collab")}
        leading={
          <IconButton
            label="返回"
            className="-ml-1"
            icon={<ChevronIcon width={16} height={16} className="rotate-180" />}
            onClick={leave}
          />
        }
        right={
          <>
            {/* 这里只描述「实时通道」状态，不要和「智能体能否对话（模型绑定）」混为一谈：
                以前写「已连接」时，紧挨着的「当前智能体还没有绑定模型连接」提示条会自相矛盾。 */}
            <span className="flex items-center gap-1.5 text-ui-xs text-muted">
              <span
                aria-hidden="true"
                className={`h-1.5 w-1.5 rounded-full ${
                  connState === "open"
                    ? "bg-success"
                    : connState === "closed"
                      ? "bg-warn"
                      : "bg-line-strong"
                }`}
              />
              {connState === "open" ? "通道已连接" : connState === "closed" ? "通道断开" : "通道连接中…"}
            </span>
            {recovered && connState === "open" && (
              <span role="status" className="text-ui-xs text-success">
                通道已恢复
              </span>
            )}
            {/* 我的任务（d.259）：组长派到我名下的活，点一下就能让和鸣接着做。角标见 d.263。 */}
            <span className="relative inline-flex">
              <IconButton
                label={myTaskButtonLabel(myTaskBadge)}
                className={myTasksOpen ? "bg-subtle-3 text-ink" : ""}
                aria-expanded={myTasksOpen}
                icon={<TaskIcon width={18} height={18} />}
                onClick={() => setMyTasksOpen((open) => !open)}
              />
              {/* 角标是视觉提示，数量已写进按钮 label（读屏用户同样知情）。 */}
              {myTaskBadge !== null && myTaskBadge.total > 0 ? (
                <span
                  data-testid="my-task-badge"
                  aria-hidden="true"
                  className="pointer-events-none absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-danger px-1 text-center text-ui-xs font-semibold leading-4 text-white"
                >
                  {myTaskBadge.total > MY_TASK_BADGE_MAX
                    ? `${MY_TASK_BADGE_MAX}+`
                    : myTaskBadge.total}
                </span>
              ) : null}
            </span>
            {/* 会话进度栏开关（Codex 式）：默认收起。 */}
            <IconButton
              label="会话进度"
              className={progressOpen ? "bg-subtle-3 text-ink" : ""}
              aria-expanded={progressOpen}
              icon={<WorkflowIcon width={18} height={18} />}
              onClick={() => {
                // 手动开合（d.245）：主动关掉时记时间并清理由——关掉就是关掉，
                // 自动开栏在安静期内要让位于这个动作。
                if (progressOpen) {
                  panelManualClosedAtRef.current = Date.now();
                  setPanelAgentReason(null);
                  setProgressOpen(false);
                } else {
                  setProgressOpen(true);
                }
              }}
            />
            {/* 会话内搜索：在已解密明文里找关键词，跳转并高亮命中的消息。 */}
            <IconButton
              label="搜索会话"
              // 快捷键写在 title 上：Ctrl+F 是新加入口（d.236），不写出来没人会发现。
              title="搜索会话（Ctrl+F）"
              className={searchOpen ? "bg-subtle-3" : ""}
              aria-pressed={searchOpen}
              icon={<SearchIcon width={18} height={18} />}
              onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
            />
          </>
        }
      />
      {/* 主区（T32）：chat 面板始终挂载，切到轨迹/上下文时只用 hidden 隐藏——
          条件渲染会把输入框草稿、滚动位置、搜索态全丢掉。 */}
      <div
        id="chat-view-panel-chat"
        role="tabpanel"
        aria-labelledby="chat-view-tab-chat"
        className={view === "chat" ? "flex min-h-0 flex-1 flex-col" : "hidden"}
      >
      {connState === "closed" && (
        <div
          role="status"
          className="border-b border-warn-line bg-warn-soft px-chat-gutter py-1.5 ui-body-sm text-warn"
        >
          连接已断开，正在自动重连…消息会排队，恢复后自动补发
        </div>
      )}
      {searchOpen && (
        <div className="flex items-center gap-2 border-b border-line-soft bg-subtle-2 px-chat-gutter py-2">
          <SearchIcon width={14} height={14} className="shrink-0 text-muted" />
          <input
            autoFocus
            ref={searchInputRef}
            aria-label="搜索本会话"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setSearchHitId(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                goSearch(e.shiftKey ? -1 : 1);
              } else if (e.key === "Escape") {
                e.preventDefault();
                closeSearch();
              }
            }}
            placeholder="在本会话中搜索…"
            className="min-w-0 flex-1 bg-transparent text-ui-sm outline-hidden placeholder:text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          />
          <span role="status" aria-live="polite" className="shrink-0 text-ui-xs text-muted">
            {searchQuery.trim()
              ? searchHits.length
                ? `${(searchIndex >= 0 ? searchIndex : 0) + 1}/${searchHits.length}`
                : "无匹配"
              : ""}
          </span>
          <IconButton
            label="上一个匹配"
            disabled={searchHits.length === 0}
            icon={<ChevronIcon width={14} height={14} className="-rotate-90" aria-hidden="true" />}
            onClick={() => goSearch(-1)}
          />
          <IconButton
            label="下一个匹配"
            disabled={searchHits.length === 0}
            icon={<ChevronIcon width={14} height={14} className="rotate-90" aria-hidden="true" />}
            onClick={() => goSearch(1)}
          />
          <IconButton
            label="关闭搜索"
            icon={<XIcon width={14} height={14} aria-hidden="true" />}
            onClick={closeSearch}
          />
        </div>
      )}
      {/* d.235：命中列表——每条一行（序号 / 谁说的 / 命中附近的一句），点哪条跳哪条 */}
      {searchOpen && searchRows.length > 0 ? (
        <ul
          data-testid="search-hit-list"
          className="max-h-44 overflow-y-auto border-b border-line-soft bg-surface"
        >
          {searchRows.map((row, i) => {
            const message = searchMessageById.get(row.id);
            const active = row.id === activeSearchId;
            return (
              <li key={row.id}>
                <button
                  type="button"
                  aria-current={active ? "true" : undefined}
                  aria-label={`跳到第 ${i + 1} 个命中：${row.excerpt}`}
                  className={`flex w-full items-baseline gap-2 px-chat-gutter py-1 text-left text-ui-xs ${
                    active ? "bg-warn-soft text-ink" : "text-muted hover:bg-subtle-2"
                  }`}
                  onClick={() => setSearchHitId(row.id)}
                >
                  {/* 只给序号不给「1/2」：总条数已经在搜索栏那行，面板里重复一遍只是噪声 */}
                  <span className="w-7 shrink-0 tabular-nums">#{i + 1}</span>
                  <span className="shrink-0 text-body">
                    {message ? displaySenderName(message) : "消息"}
                  </span>
                  <span className="min-w-0 flex-1 truncate" title={row.excerpt}>
                    {row.excerpt || "（这条消息没有可显示的正文）"}
                  </span>
                  {row.count > 1 ? <span className="shrink-0">{row.count} 处</span> : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {/* 消息区：左右用 --chat-gutter（24px，窄屏 12px）与 composer 同一条竖线——
          d.126-C 删掉头像列后这里不再有额外内边距。py 上 24 / 下 20 的差是刻意留的
          「呼吸位」——完全等距时第一条消息会顶着 header 底线，视觉上像被切掉一截。 */}
      {/* d.246：消息区单独包一层 relative——「新消息」浮标必须相对**消息区**定位。
          以前它相对整个会话面板定位（bottom-32），输入区一长（附件、排队条、提示条、
          安全范围黄条）就会压到输入框上，这正是「界面元素重叠」的来源之一。 */}
      <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        data-testid="message-list"
        onScroll={onMessageScroll}
        onDragOver={onMessagesDragOver}
        onDrop={onMessagesDrop}
        className="flex-1 overflow-y-auto px-chat-gutter pb-5 pt-6"
      >
        {/* 消息列宽度自适应：宽屏最宽 1080，窄屏跟视口走（左右由 px-chat-gutter 兜底）；
            滚动容器保持在外层。输入区/工具栏用同一宽度档（视觉上是同一根竖线）。 */}
        <div className="mx-auto w-full max-w-[min(100%,1080px)]">
        {/* 窗口之外还有历史时给一个显式入口：滚到顶会自动加载，
            但触控板/滚轮行为在部分设备上不可靠，按钮是兜底，也让人知道「上面还有」。 */}
        {visibleMessages.length > windowCount && (
          <div className="mb-3 flex justify-center">
            <Button
              type="button"
              onClick={loadEarlierMessages}
              size="md" variant="ghost" className="text-muted"
            >
              加载更早的消息（还有 {visibleMessages.length - windowCount} 条）
            </Button>
          </div>
        )}
        {visibleMessages.length === 0 && streamEntries.length === 0 ? (
          messagesLoading || !historyLoaded[convId] ? (
            // A1 首屏骨架：历史还没回来时不能把「正在加载」画成空会话
            <div
              data-testid="messages-skeleton"
              role="status"
              aria-busy="true"
              aria-label="正在加载消息"
              className="space-y-3"
            >
              {[0, 1, 2].map((i) => (
                <div key={i} className={`flex ${i % 2 === 1 ? "justify-end" : ""}`}>
                  <div className="h-9 w-[46%] animate-pulse rounded-xl bg-subtle-3" />
                </div>
              ))}
            </div>
          ) : messagesError ? (
            // A1 失败态：失败与「真的没有消息」必须长得不一样
            <div className="flex h-full items-center justify-center">
              <ErrorState
                title={<>加载失败：{messagesError}</>}
                onRetry={() => {
                  void useChatStore.getState().loadMessages(convId);
                }}
              />
            </div>
          ) : (
            // A1 真空态 + UX-A：只有「加载成功且确实为空」才显示；示例只填入不发送
            <ChatEmptyState examples={emptyExamples} onPick={applyExample} />
          )
        ) : null}
        {windowedMessages.map((m, index) => {
          const mine = m.senderId === me?.id;
          // A4：时间分隔——窗口首条也插（上方还有历史时它就是当前阅读段的起点）
          const windowStart = visibleMessages.length - windowedMessages.length;
          const prevMsg =
            index > 0
              ? windowedMessages[index - 1]
              : windowStart > 0
                ? visibleMessages[windowStart - 1]
                : undefined;
          const showSeparator = needsTimeSeparator(prevMsg?.createdAt, m.createdAt);
          // 转录（d.126-C）：思考过程 + 工具调用轨迹。旧消息没有这两个字段 → undefined，不渲染。
          const transcript = mine ? undefined : transcriptOf(m);
          /**
           * d.294：这条回答能不能重答。方案在这里算好，点击时直接用它——
           * 确认期间列表若变了（别的窗口删了消息），至少删的仍是用户看到的那一批。
           */
          const regenPlan = (() => {
            if (mine) return null;
            const outcome = planRegenerate(visibleMessages, m.id);
            return outcome.ok ? outcome.plan : null;
          })();
          // 图表：正文里的 ```chart 围栏块。解析失败的块被跳过（不显示也不报错——
          // 模型偶尔会写出不合法的 JSON，那是它的问题，不该让整条消息看起来坏了）。
          const messageCharts = extractCharts(m.payload.text).map((c, i) => ({
            key: `${m.id}-chart-${i}`,
            spec: c.spec,
          }));
          /** 正文块：用户输入与助手输出共用（markdown + 图表 + 附件；e2e 解不开时是占位）。 */
          const messageBody =
            m.enc === "e2e" && !plainOf[m.id] ? (
              // E2E Task 4 / 设计 §8：解不开的信封渲染占位（不吞不崩），且不进 LLM 提示词。
              // 文案不写「密钥缺失」：设备钥匙通常还在，缺的是这条消息所属链的窗口钥匙。
              // 三类来源并列写全（换设备 / 本机清过缓存 / 生成中途退出），别只列其中一类。
              <div
                className="text-muted"
                title="本机没有这条消息对应的解密密钥：可能来自其他设备、本机缓存被清理过，或这条消息在生成时被中断。"
              >
                本机解不开这条消息
                <span className="ml-1">
                  （可能来自其他设备、本机缓存被清理，或消息在生成时被中断）
                </span>
              </div>
            ) : (
              <>
                <MarkdownMessage text={stripChartFences(m.payload.text)} />
                {/* 图表：正文里的 ```chart 围栏块渲染成卡片（正文已剥离围栏） */}
                {messageCharts.map((c) => (
                  <ChatChart key={c.key} spec={c.spec} />
                ))}
                {/* 附件：audio/* 先于 image/文件卡路由到播放器气泡（Task 5） */}
                {m.payload.file ? (
                  m.payload.file.mime.startsWith("audio/") ? (
                    <AudioBubble
                      fileId={m.payload.file.id}
                      fileKey={m.payload.file.key}
                      mime={m.payload.file.mime}
                    />
                  ) : (
                    <AttachmentPreview file={m.payload.file} />
                  )
                ) : null}
              </>
            );
          return (
            <Fragment key={m.id}>
              {/* A4：间隔 ≥5 分钟或跨天的消息之间插一条时间分隔（首条渲染的消息也带，定位阅读段起点） */}
              {showSeparator ? (
                <div className="mb-4 flex justify-center">
                  <span className="text-ui-xs text-muted">{formatDayClock(m.createdAt)}</span>
                </div>
              ) : null}
              {/* 消息行（d.126-C）：不展示头像、不用左右气泡；按「普通 agent 工具输出」排列——
                  用户输入是一块浅底提示，助手输出是「正文 + 思考块 + 工具调用块」顺次转录
                  （旧消息没有后两块 → 只渲染正文，不占位也不崩）。 */}
              <div
                id={`msg-${m.id}`}
                className={`group relative mb-6 flex items-start gap-2${mine ? " justify-end" : ""}${
                  (searchOpen && activeSearchId === m.id) || jumpedMessageId === m.id
                    ? " rounded-lg bg-warn-soft ring-1 ring-warn-line"
                    : ""
                }`}
              >
                <div
                  data-message-bubble=""
                  className={`min-w-0 text-ui-md leading-relaxed ${
                    mine ? "max-w-[80%]" : "flex-1"
                  }`}
                >
                  {mine ? (
                    // 用户输入：右对齐浅底气泡（无边框），署名/时间压到极小并弱化
                    <div className="rounded-3xl bg-subtle-3 px-4 py-2.5">
                      <div className="mb-1 flex items-baseline justify-end gap-2 text-ui-xs leading-4 text-muted">
                        <time dateTime={m.createdAt} className="shrink-0 tabular-nums">
                          {formatClock(m.createdAt)}
                        </time>
                      </div>
                      {messageBody}
                    </div>
                  ) : (
                    // 助手输出：全宽、无气泡；署名/时间极小弱化 + 思考块 + 工具轨迹 + 正文
                    <div>
                      <div className="mb-1 flex items-baseline gap-2 text-ui-xs leading-4 text-muted">
                        <time dateTime={m.createdAt} className="ml-auto shrink-0 tabular-nums">
                          {formatClock(m.createdAt)}
                        </time>
                      </div>
                      {transcript?.thinking ? (
                        <ReasoningBlock text={transcript.thinking} streaming={false} />
                      ) : null}
                      {transcript?.tools && transcript.tools.length > 0 ? (
                        <ToolTraceGroup tools={transcript.tools} />
                      ) : null}
                      <div className="mt-1.5 break-words text-ui-base leading-7">{messageBody}</div>
                    </div>
                  )}
                </div>
                {/* A5 整条复制：有文本才出（附件只有元信息，复制结果没意义）。
                    用 opacity 而不是 hidden：hidden 会把按钮移出键盘 Tab 序，键盘用户永远复制不了；
                    放在消息体右侧（self-end）而不是 absolute -top-2，避免 hover 时压住署名行的时间戳。
                    d.294：按钮竖排——「重答」放在「复制」上面，两者都用同一套 hover 显隐。 */}
                {regenPlan || (m.payload.text?.length ?? 0) > 0 ? (
                  <div className="flex shrink-0 flex-col items-end gap-1 self-end">
                    {regenPlan ? (
                      <button
                        type="button"
                        aria-label="重新回答这一轮"
                        title={
                          regenPlan.later > 0
                            ? `这条后面还有 ${regenPlan.later} 条消息，重答会一起删掉`
                            : "撤掉这个回答，用同一句提问重新答一次"
                        }
                        disabled={regenBusyId === m.id || activeLocal.length > 0}
                        className="ui-hit pointer-events-none shrink-0 rounded-sm border border-line bg-surface px-1.5 py-0.5 text-ui-xs text-muted opacity-0 transition-opacity duration-fast hover:text-ink disabled:cursor-not-allowed disabled:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 focus-visible:opacity-100 motion-reduce:transition-none"
                        onClick={() => askRegenerate(m.id, regenPlan)}
                      >
                        {regenBusyId === m.id ? "重答中…" : "重答"}
                      </button>
                    ) : null}
                    {(m.payload.text?.length ?? 0) > 0 ? (
                      <button
                        type="button"
                        aria-label="复制消息"
                        className="ui-hit pointer-events-none shrink-0 rounded-sm border border-line bg-surface px-1.5 py-0.5 text-ui-xs text-muted opacity-0 transition-opacity duration-fast hover:text-ink group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 focus-visible:opacity-100 motion-reduce:transition-none"
                        onClick={() => void copyMessage(m)}
                      >
                        {copiedMsgId === m.id ? "已复制" : "复制"}
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
              {/* d.294 重答确认：删掉后面几条是不可撤销的，所以中间那条要问一句再动手。 */}
              {regenConfirm?.id === m.id ? (
                <div
                  role="group"
                  aria-label="重答确认"
                  className="mb-4 flex flex-wrap items-center justify-end gap-2 text-ui-sm text-body"
                >
                  <span>{describeRegenerateConfirm(regenConfirm.plan)}</span>
                  <Button
                    type="button"
                    size="sm"
                    variant="primary"
                    onClick={() => void regenerateFrom(regenConfirm.plan, m.id)}
                  >
                    确认重答
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setRegenConfirm(null)}>
                    取消
                  </Button>
                </div>
              ) : null}
            </Fragment>
          );
        })}
        {/* 流式打字机行（本机/他机）：渲染于消息列表尾部，finish 的 message_new 收口后移除 */}
        {streamEntries.map(([id, s]) => (
          <AgentStreamBubble
            key={id}
            name={nameOf(s.agentId)}
            text={s.text}
            reasoning={s.reasoning}
            tools={s.tools}
            attempts={s.attempts}
            status={s.status}
            errorMessage={s.errorMessage}
            onRetry={streamOwner[id] && s.status === "error" ? () => retryStream(id) : undefined}
            {...(hasRevealBridge(getFileBridge())
              ? { onRevealPath: (path: string) => void revealTurnChange(path) }
              : {})}
          />
        ))}
        <div ref={bottomRef} />
        </div>
      </div>
      {/* A3：用户上滑期间来了新内容 —— 不拽底，只亮一个回到底部的入口。
          d.246：定位在消息区右下角（上面那层 relative），不再压到输入区。 */}
      {newBelow ? (
        <button
          type="button"
          aria-label="滚动到最新消息"
          className="absolute bottom-4 right-4 z-10 flex items-center gap-1 rounded-full border border-line bg-surface px-3 py-1 text-ui-sm text-body ui-overlay-shadow hover:bg-subtle-2"
          onClick={() => scrollToLatest()}
        >
          <ChevronIcon width={14} height={14} className="rotate-90" aria-hidden="true" />
          新消息
        </button>
      ) : null}
      </div>
      <form onSubmit={send} className="relative shrink-0 px-chat-gutter pb-4 pt-2">
        <SlashCommandMenu items={slashItems} activeIndex={slashIndex} onPick={pickSlashCommand} />
        {/* 输入区与消息列同宽（宽屏最宽 1080 自适应）：提示条、圆角输入容器、快捷键提示对齐同一列。 */}
        <div className="mx-auto w-full max-w-[min(100%,1080px)]">
        {/* E2E 常驻横幅（硬验收⑤ / 设计 §2.1）：无 subtle 环境红字提示 + 全发送路径拦截 */}
        {!subtleOk && (
          <p
            role="alert"
            className="mx-6 mt-2 border-l-2 border-danger bg-danger-soft px-2 py-1.5 text-ui-sm text-danger"
          >
            {NO_E2E_NOTICE}
          </p>
        )}
        {/* 运行中状态只留读屏播报：视觉上不再显示「生成中：…」（d.346），
            状态由气泡光标与输入框下方的进度行承担，「停止」在动作行右下。 */}
        {activeLocal.length > 0 ? (
          <p role="status" aria-live="polite" className="sr-only">
            {`生成中：${activeLocal.map(([, s]) => nameOf(s.agentId)).join("、")}`}
          </p>
        ) : null}
        {/* UX-A：未绑定模型前置提示（与任务区同源组件）；发送按钮同时置灰，
            不再等用户敲完一段话才在发送时被拦。 */}
        {unboundAgent && (
          <div className="mx-6 mt-2">
            <UnboundModelNotice
              id={UNBOUND_NOTICE_ID}
              variant="inline"
              agentName={unboundAgent.name}
              // 本机已有连接：提示条里直接选一个就绑上，不用再跳设置页绕一圈（d.82）
              connections={llmProfiles.map((p) => ({ id: p.id, label: p.label }))}
              onBind={(profileId) => setAgentBinding(unboundAgent.agentId, profileId)}
              onGoSettings={() => useUiStore.getState().setPage("model")}
            />
          </div>
        )}
        {/* 提示位（B 轨 E3）：录音/上传占住这一位（互斥），其余提示按列表渲染，
            最多 2 行 +「还有 N 条」——此前四五条各占一行，能把输入区顶出可视区。 */}
        {listening ? (
          // 独立 mic 按钮退场后，「识别中」需要一处可见落点（d.147.4.90）。
          <div className="flex items-center gap-3 px-chat-gutter pt-2 ui-body-sm">
            <span role="status">识别中…说完会自动填进输入框</span>
            <Button size="sm" variant="ghost" aria-label="停止语音输入" onClick={toggleVoice}>
              停止
            </Button>
          </div>
        ) : recording ? (
          <div className="flex items-center gap-3 px-chat-gutter pt-2 ui-body-sm">
            <span role="status">录音中…（最长 60 秒）</span>
            <Button size="sm" variant="ghost" aria-label="停止录音" onClick={stopRecording}>
              停止
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-muted"
              aria-label="取消录音"
              onClick={cancelRecording}
            >
              取消
            </Button>
          </div>
        ) : uploading ? (
          // A8：上传进行中占住提示位，四个入口已禁用
          <p role="status" className="px-chat-gutter pt-2 ui-body-sm text-muted">
            上传中…（≤6MB）
          </p>
        ) : visibleNotices.length > 0 ? (
          <div className="px-chat-gutter pt-2">
            <div className="flex flex-col gap-1">
              {visibleNotices.map((n) => (
                <div
                  key={n.key}
                  role={n.tone === "error" ? "alert" : "status"}
                  className={`flex items-center gap-2 border-l-2 pl-2 ui-body-sm ${
                    n.tone === "error"
                      ? "border-danger text-danger"
                      : n.tone === "warn"
                        ? "border-warn text-warn"
                        : "border-line-soft text-muted"
                  }`}
                >
                  {n.tone === "error" ? (
                    <AlertIcon width={14} height={14} className="shrink-0" aria-hidden="true" />
                  ) : null}
                  <span className="min-w-0 flex-1 break-words">{n.text}</span>
                  {n.retry ? (
                    <Button size="sm" variant="ghost" className="shrink-0" onClick={n.retry}>
                      重试
                    </Button>
                  ) : null}
                  {n.action ? (
                    <Button size="sm" variant="ghost" className="shrink-0" onClick={n.action.onClick}>
                      {n.action.label}
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
            {notices.length > NOTICE_VISIBLE_ROWS ? (
              <button
                type="button"
                className={`mt-1 ui-caption text-muted hover:text-ink ${FOCUS_RING_TIGHT}`}
                onClick={() => setNoticeExpanded((v) => !v)}
              >
                {noticeExpanded ? "收起提示" : `还有 ${hiddenNoticeCount} 条提示`}
              </button>
            ) : null}
          </div>
        ) : null}
        {/* 输入框上方的常驻信息（d.346）：任务清单、本轮改动与会话改动都放在框外——
            以前它们挤在圆角容器里，等于把正文区一段段吃掉。 */}
        <TodoPanel conversationId={convId} />
        <SessionChangesBar changes={sessionChanges} onOpen={openSessionChanges} />
        {turnWrites.length > 0 && !planMode ? (
          <TurnUndoBar
            paths={turnWrites}
            busy={undoing}
            busyPath={undoingPath}
            onUndo={() => void undoTurnWrites()}
            onUndoOne={(path) => void undoTurnFile(path)}
            {...(hasBackupPreviewBridge(getFileBridge()) ? { onPreview: (path: string) => void previewTurnChange(path) } : {})}
            {...(hasRevealBridge(getFileBridge()) ? { onReveal: (path: string) => void revealTurnChange(path) } : {})}
            onDismiss={() => setTurnWrites([])}
          />
        ) : null}
        {/* 圆角输入容器（d.147.4.90 起仿 Codex/ChatGPT 的单框样式）：正文在上，
            工具与发送收进下方动作行（左下圆形「+」、右下圆形发送），只保留一层 border。 */}
        <div className="rounded-[26px] border border-line bg-surface transition-colors focus-within:border-line-strong">
        {/* 待发附件（E1）：选中后先堆在这里，可逐个移除；发送时随正文一起提交 */}
        {pendingFiles.length > 0 ? (
          <ul
            aria-label="待发附件"
            className="flex flex-wrap items-center gap-2 px-2 pt-2"
          >
            {pendingFiles.map((p) => (
              <li
                key={p.key}
                className="flex max-w-full items-center gap-2 rounded-lg border border-line bg-subtle-2 py-1 pl-2 pr-1"
              >
                <FileIcon width={14} height={14} className="shrink-0 text-muted" aria-hidden="true" />
                <span
                  className="min-w-0 max-w-[220px] truncate text-ui-sm text-ink"
                  title={p.file.name}
                >
                  {p.file.name}
                </span>
                <span className="shrink-0 text-ui-xs tabular-nums text-muted">
                  {formatBytes(p.file.size)}
                </span>
                <button
                  type="button"
                  aria-label={`移除附件 ${p.file.name}`}
                  title="移除附件"
                  disabled={uploading}
                  className={`ui-hit flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted hover:bg-subtle-4 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS_RING_TIGHT}`}
                  onClick={() => removePendingFile(p.key)}
                >
                  <XIcon width={12} height={12} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {/* 数量变化读屏播报：列表本身是 <ul>，焦点不动时读屏不会主动念。
            只在有附件时渲染——空 role=status 会和「连接断开」等提示抢同一个角色查询。 */}
        {pendingFiles.length > 0 ? (
          <p role="status" className="sr-only">
            待发附件 {pendingFiles.length} 个
          </p>
        ) : null}
        {/* 上下文用量（d.187）：安静档自己隐掉；到 80% 提醒可以 /compact。 */}
        <ContextMeter used={contextUsage.used} budget={contextUsage.budget} calibrated={contextUsage.calibrated} />
        {/* 「接着做」（d.189）：用户点了停止、或应用重启后发现上一轮没收口。不自动发。 */}
        {resumeState ? (
          <ResumeBar
            reason={resumeState.reason}
            onContinue={continueResume}
            onDismiss={() => setResumeState(null)}
          />
        ) : null}
        {/* 引用的文件（d.175）：显示在输入区上方，可逐个删掉。 */}
        {fileRefs.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5 px-4 pt-1" aria-label="本轮引用的文件">
            <span className="text-ui-sm text-muted">引用：</span>
            {fileRefs.map((path) => (
              <span
                key={path}
                className="inline-flex max-w-[240px] items-center gap-1 rounded-md border border-line bg-subtle-2 px-2 py-0.5 text-ui-sm text-ink"
                title={path}
              >
                <span className="truncate">{path.split("/").pop()}</span>
                <button
                  type="button"
                  aria-label={`取消引用 ${path.split("/").pop()}`}
                  className="ui-hit rounded-sm text-muted hover:text-ink"
                  onClick={() => {
                    const next = fileRefs.filter((item) => item !== path);
                    fileRefsRef.current = next;
                    setFileRefs(next);
                    // 删掉文件后旧的「没读进来」提示就不再对应当前引用，直接收掉。
                    setFileRefIssue(null);
                  }}
                >
                  <XIcon width={12} height={12} aria-hidden="true" />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        {/* 引用没读进来的部分（d.222）：不静默——模型这一轮确实没看到它。 */}
        {fileRefIssue !== null ? (
          <p
            data-testid="file-ref-issue"
            role="status"
            className="px-4 pt-1 text-ui-xs text-warn"
          >
            {describeFileRefIssues(fileRefIssue)}
          </p>
        ) : null}
        {/* 排队中的插话（d.227）：连发几句时能看见还有几条没被取走，写错了也能收回。 */}
        {steerPendingCount > 0 ? (
          <div
            data-testid="steer-pending"
            role="status"
            className="mx-4 mb-1 flex items-center gap-2 rounded-md border border-line-soft bg-subtle px-3 py-1 text-ui-sm text-muted"
          >
            <span>已排队 {steerPendingCount} 条插话 · 这一轮下一步就会看到</span>
            <button
              type="button"
              className="ui-hit ml-auto rounded-sm text-ui-xs text-muted hover:text-ink"
              onClick={cancelSteerQueue}
            >
              取消
            </button>
          </div>
        ) : null}
        {refPickerOpen ? (
          <FileRefPicker
            bridge={getFileBridge()}
            roots={fileRootsFor(
              useChatStore.getState().conversations.find((c) => c.id === convId)?.workspace,
            )}
            selected={fileRefs}
            onClose={() => setRefPickerOpen(false)}
            onConfirm={(paths) => {
              fileRefsRef.current = paths;
              setFileRefs(paths);
              setRefPickerOpen(false);
            }}
          />
        ) : null}
        {/* 就地换模型（d.195）：点输入区右下角的模型名弹这个，不跳设置页。 */}
        <ModelSwitcher
          open={modelSwitcherOpen}
          agentName={conv?.agent.name ?? "内置智能体"}
          choices={llmProfiles.map((item) => ({
            id: item.id,
            label: item.label,
            hint: item.provider ? `${item.provider}${item.model ? ` · ${item.model}` : ""}` : item.model,
          }))}
          boundId={conv ? (llmBindings[conv.agent.id] ?? null) : null}
          onPick={pickModel}
          onClose={() => setModelSwitcherOpen(false)}
          onOpenSettings={() => {
            setModelSwitcherOpen(false);
            useUiStore.getState().setPage("model");
          }}
        />
        {/* 轮次打满（d.167.4.103）：这一轮被 36 轮上限截断时，给一次点击的「继续」。
            走 `retryStream`——续写指令作为一条用户消息落库，不重发原提问。 */}
        {/* 计划就绪（d.173）：计划模式下这一轮只给了方案，一键「接受并执行」。 */}
        {changeDiff ? (
          <ChangeDiffDialog
            state={changeDiff}
            onClose={() => {
              setChangeDiff(null);
              setSessionChangesOpen(false);
            }}
            {...(sessionChangesOpen && sessionChanges.length > 0
              ? {
                  files: sessionChanges,
                  onPick: (path: string) => void previewTurnChange(path),
                }
              : {})}
          />
        ) : null}
        {/* 我的任务（d.259）：读一次 /api/team/my-tasks，选中即把它变成一条用户消息。 */}
        {myTasksOpen ? (
          <MyTasksDialog
            onClose={() => setMyTasksOpen(false)}
            onPick={(item, prompt) => {
              setMyTasksOpen(false);
              setSendNotice(
                `已把团队任务「${item.task.title}」发给和鸣：做完它会写结论、把状态标成完成。`,
                "info",
              );
              void submitMessage(prompt, effectiveMentions);
            }}
          />
        ) : null}
        {/* 后台作业跑完（d.182）：作业不会被 await，收口后由这里接着盯，跑完给一次点击的「继续」。 */}
        {watchedJobs.length > 0 ? (
          <JobReadyBar
            jobs={watchedJobs}
            pending={watchedJobs.some((job) => job.running)}
            onContinue={continueAfterJobs}
            onDismiss={() => {
              jobWatchRef.current?.abort();
              jobWatchRef.current = null;
              setWatchedJobs([]);
            }}
          />
        ) : null}
        {planReadyStreamId && planMode ? (
          <PlanReadyBar onExecute={executePlan} onDismiss={() => setPlanReadyStreamId(null)} />
        ) : null}
        {/* 当前目标（d.201）：一条别忘终点的提醒；点「完成」就是从提示词里摘掉。 */}
        <GoalBar
          goal={sessionGoal}
          onDone={() => {
            clearGoal(convId);
            setSendNotice("目标已标记完成，之后不会再写进提示词了。", "info");
          }}
          onClear={() => {
            clearGoal(convId);
            setSendNotice("目标已清除。", "info");
          }}
        />
        {roundLimitStreamId ? (
          <RoundLimitHint
            reason={continueReason}
            onContinue={() => {
              const streamId = roundLimitStreamId;
              setRoundLimitStreamId(null);
              retryStream(streamId);
            }}
            onDismiss={() => setRoundLimitStreamId(null)}
          />
        ) : null}
        {/* 并行子代理在跑（d.200）：谁在跑、第几轮、在调什么；「停止」只中断子代理。 */}
        <SubagentRuns
          runs={subagentRuns}
          writable={subagentWrite}
          onStop={() => subagentStopsRef.current[convId]?.abort()}
        />
        {/* 后台作业（d.203）：哪几条在跑、跑了多久、结束成没成；「停止」只停那一条。 */}
        <JobPanel
          jobs={shellJobs}
          canPreview={hasJobPreview(getShellBridge())}
          onPreview={(jobId) => {
            setJobNotice(null);
            void previewPanelJob(getShellBridge(), jobId).then((problem) => {
              if (problem) setJobNotice(problem);
            });
          }}
          onStop={(jobId) => {
            setJobNotice(null);
            void killPanelJob(getShellBridge(), jobId).then((problem) => {
              if (problem) setJobNotice(problem);
            });
          }}
          notice={jobNotice}
        />
        {/* 拖动把手：上沿可拖，加高/压扁输入区（高度写 localStorage，下次进入沿用） */}
        <div
          role="separator"
          aria-label="调整输入栏高度"
          aria-orientation="horizontal"
          className="group flex h-2 cursor-row-resize items-center justify-center opacity-0 transition-opacity hover:opacity-100 focus-visible:opacity-100"
          onPointerDown={onComposerDragStart}
          onPointerMove={onComposerDragMove}
          onPointerUp={onComposerDragEnd}
          onPointerCancel={onComposerDragEnd}
        >
          <span className="h-[2px] w-10 rounded-full bg-line-soft transition-colors group-hover:bg-line-strong" />
        </div>
        <div className="relative px-4 pt-1" style={{ height: composerHeight }}>
          {emojiOpen && (
            <EmojiPicker
              onPick={(e) => {
                setDraft((d) => {
                  const next = d + e;
                  // 表情回填也要落盘（同语音回填的幂等约定）
                  scheduleDraftSave(convId, next);
                  return next;
                });
                setEmojiOpen(false);
              }}
            />
          )}
          <textarea
            ref={composerRef}
            aria-label="消息输入框"
            aria-describedby={unboundAgent ? UNBOUND_NOTICE_ID : undefined}
            className={`h-full w-full resize-none bg-transparent pb-1 pt-2 text-ui-base leading-6 outline-hidden placeholder:text-muted ${FOCUS_RING}`}
            placeholder="输入消息…"
            value={draft}
            onChange={(e) => onDraftChange(e.target.value)}
            onKeyDown={onInputKeyDown}
            onPaste={onComposerPaste}
          />
          {/* 语音双选项浮层：转文字（原 STT）/ 录音（MediaRecorder）；无该 API 时录音项禁用 */}
          {voiceMenu && (
            <div className="absolute bottom-full right-0 z-40 mb-1 w-[160px] rounded-xl border border-line-soft bg-surface p-1 ui-overlay-shadow">
              <button
                type="button"
                className="w-full rounded-lg px-2 py-1.5 text-left text-ui-sm hover:bg-subtle-2"
                onClick={() => {
                  setVoiceMenu(false);
                  toggleVoice();
                }}
              >
                语音输入（转文字）
              </button>
              <button
                type="button"
                disabled={!hasRecorder}
                className="w-full rounded-lg px-2 py-1.5 text-left text-ui-sm hover:bg-subtle-2 disabled:text-muted disabled:hover:bg-transparent"
                onClick={() => {
                  setVoiceMenu(false);
                  void startRecording();
                }}
              >
                语音消息（录音）
              </button>
              {!hasRecorder && (
                <p className="px-2 pb-1 pt-0.5 ui-body-sm text-muted">当前环境不支持录音</p>
              )}
            </div>
          )}
        </div>
        {/* 动作行（d.147.4.90，仿 Codex/ChatGPT）：左下圆形「+」把表情/图片/文件/语音
            收进一个菜单；右侧当前模型徽标 + 圆形发送。 */}
        {/* d.246：动作行允许换行——窄窗口下「安全范围 / 计划 / 模型」总宽会超过一行，
            以前不换行会把发送按钮挤出可视区（或压到别的元素上）。 */}
        <div data-testid="composer-actions" className="flex flex-wrap items-center gap-1.5 px-2.5 pb-2">
          <div className="relative">
            <button
              type="button"
              aria-label="更多操作"
              aria-haspopup="menu"
              aria-expanded={attachOpen}
              title="表情、图片、文件、语音"
              disabled={uploading}
              className={`inline-flex h-8 w-8 items-center justify-center rounded-full border border-line transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                attachOpen
                  ? "bg-subtle-3 text-ink"
                  : "text-muted hover:bg-subtle-2 hover:text-ink"
              } ${FOCUS_RING}`}
              onClick={() => setAttachOpen((v) => !v)}
            >
              <PlusIcon width={16} height={16} aria-hidden="true" />
            </button>
            {attachOpen && (
              <>
                <button
                  type="button"
                  aria-label="关闭更多操作"
                  className="fixed inset-0 z-30 cursor-default"
                  onClick={() => setAttachOpen(false)}
                />
                <div
                  role="menu"
                  aria-label="更多操作菜单"
                  className="absolute bottom-full left-0 z-40 mb-1 w-[176px] rounded-xl border border-line-soft bg-surface p-1 ui-overlay-shadow"
                >
                  <button
                    type="button"
                    role="menuitem"
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-ui-sm hover:bg-subtle-2"
                    onClick={() => {
                      setAttachOpen(false);
                      setEmojiOpen(true);
                    }}
                  >
                    <SmileIcon width={16} height={16} aria-hidden="true" />
                    表情
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={uploading}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-ui-sm hover:bg-subtle-2 disabled:cursor-not-allowed disabled:text-muted disabled:hover:bg-transparent"
                    onClick={() => {
                      setAttachOpen(false);
                      pickFile("image/*");
                    }}
                  >
                    <ImageIcon width={16} height={16} aria-hidden="true" />
                    图片（≤6MB）
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={uploading}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-ui-sm hover:bg-subtle-2 disabled:cursor-not-allowed disabled:text-muted disabled:hover:bg-transparent"
                    onClick={() => {
                      setAttachOpen(false);
                      pickFile(undefined);
                    }}
                  >
                    <FileIcon width={16} height={16} aria-hidden="true" />
                    文件（≤6MB）
                  </button>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={!hasFileBridge()}
                      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-ui-sm hover:bg-subtle-2 disabled:cursor-not-allowed disabled:text-muted disabled:hover:bg-transparent"
                      onClick={() => {
                        setAttachOpen(false);
                        setRefPickerOpen(true);
                      }}
                    >
                      <FileIcon width={16} height={16} aria-hidden="true" />
                      工作区文件（引用内容，不上传）
                    </button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={uploading}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-ui-sm hover:bg-subtle-2 disabled:cursor-not-allowed disabled:text-muted disabled:hover:bg-transparent"
                    onClick={() => {
                      setAttachOpen(false);
                      setVoiceMenu(true);
                    }}
                  >
                    <MicIcon width={16} height={16} aria-hidden="true" />
                    语音输入
                  </button>
                </div>
              </>
            )}
          </div>
          {/* 安全范围（d.242）：左下角一键切换「手动 / 自动 / 完全」。
              放在「+」右边、计划模式左边——三个都是「这一轮怎么干活」的开关，聚在一起。
              「完全」选项要先点两次，且开着时常驻黄条（见下面的 banner）。 */}
          <div className="relative">
            <button
              type="button"
              aria-label={`安全范围：${SAFETY_SCOPE_TEXT[safetyScope].label}`}
              aria-haspopup="menu"
              aria-expanded={safetyOpen}
              title={`安全范围：${SAFETY_SCOPE_TEXT[safetyScope].label}——${SAFETY_SCOPE_TEXT[safetyScope].hint}`}
              onClick={() => {
                safetyConfirmRef.current = false;
                setSafetyOpen((v) => !v);
              }}
              className={`ui-hit inline-flex h-8 shrink-0 items-center gap-1 rounded-full px-2 text-ui-sm transition-colors ${
                safetyScope === "full" ? "bg-warn-soft text-warn" : "text-muted hover:bg-subtle-2"
              } ${FOCUS_RING_TIGHT}`}
            >
              <span aria-hidden="true">{safetyScope === "full" ? "⚠" : "⛨"}</span>
              <span data-testid="safety-scope-label">{SAFETY_SCOPE_TEXT[safetyScope].label}</span>
              <span aria-hidden="true" className="text-ui-xs">
                ▾
              </span>
            </button>
            {safetyOpen && (
              <>
                <button
                  type="button"
                  aria-label="关闭安全范围菜单"
                  className="fixed inset-0 z-30 cursor-default"
                  onClick={() => {
                    safetyConfirmRef.current = false;
                    setSafetyOpen(false);
                  }}
                />
                <div
                  role="menu"
                  aria-label="安全范围"
                  data-testid="safety-scope-menu"
                  className="absolute bottom-full left-0 z-40 mb-1 w-[268px] rounded-xl border border-line-soft bg-surface p-1 ui-overlay-shadow"
                >
                  {SAFETY_SCOPES.map((scope) => (
                    <button
                      key={scope}
                      type="button"
                      role="menuitem"
                      aria-checked={safetyScope === scope}
                      data-testid={`safety-scope-${scope}`}
                      className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-subtle-2"
                      onClick={() => chooseSafetyScope(scope)}
                    >
                      <span aria-hidden="true" className="mt-0.5 w-3 shrink-0 text-ui-xs text-muted">
                        {safetyScope === scope ? "✓" : ""}
                      </span>
                      <span className="min-w-0">
                        <span className={`block text-ui-sm ${scope === "full" ? "text-warn" : "text-ink"}`}>
                          {SAFETY_SCOPE_TEXT[scope].label}
                        </span>
                        <span className="block text-ui-xs leading-snug text-muted">
                          {SAFETY_SCOPE_TEXT[scope].hint}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          {/* 计划模式（d.173）：本轮只读、先出方案。按钮常驻在输入区，
              开着时高亮并带 aria-pressed——读屏能听出「已按下」，颜色不是唯一信号。 */}
          <button
            type="button"
            aria-label="计划模式：本轮只读，先把方案给你看"
            aria-pressed={planMode}
            title={planMode ? "计划模式已开启：这一轮不会改文件" : "开启计划模式：先看方案，不改文件"}
            onClick={togglePlanMode}
            className={`ui-hit inline-flex h-8 shrink-0 items-center gap-1 rounded-full px-2 text-ui-sm transition-colors ${planMode ? "bg-subtle-3 text-heming-accent" : "text-muted hover:bg-subtle-2"} ${FOCUS_RING_TIGHT}`}
          >
            <span aria-hidden="true">{planMode ? "◉" : "○"}</span>
            <span>计划</span>
          </button>
          {/* 当前模型徽标：点它就地换模型（d.195），「更多设置…」仍可去模型页。 */}
          <button
            type="button"
            aria-label={`当前模型：${composerModelLabel}`}
            title={composerModelLabel}
            onClick={() => setModelSwitcherOpen(true)}
            className={`inline-flex h-8 min-w-0 items-center gap-1 rounded-full px-2 text-ui-sm transition-colors hover:bg-subtle-2 ${FOCUS_RING_TIGHT}`}
          >
            <span
              className={`max-w-[min(160px,38vw)] truncate ${unboundAgent ? "text-warn" : "text-muted"}`}
            >
              {composerModelLabel}
            </span>
            <span aria-hidden="true" className="text-ui-xs text-muted">
              ▾
            </span>
          </button>
          {/* 停止（d.346）：运行态不再有「生成中：…」提示条，停止改由这里一键完成。 */}
          {activeLocal.length > 0 ? (
            <button
              type="button"
              aria-label="停止生成"
              title="停止这一轮生成"
              onClick={abortRuns}
              className={`inline-flex h-8 shrink-0 items-center gap-1 rounded-full px-2 text-ui-sm text-muted transition-colors hover:bg-subtle-2 hover:text-ink ${FOCUS_RING_TIGHT}`}
            >
              <span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-[2px] bg-current" />
              停止
            </button>
          ) : null}
          {/* 圆形发送按钮：图标 + aria-label（读屏名与 hover 提示仍是「发送」）。 */}
          <button
            type="submit"
            aria-label="发送"
            disabled={
              (!draft.trim() && pendingFiles.length === 0) ||
              uploading ||
              // 未绑定模型只拦「要正文回答」的发送：纯附件消息照旧进历史，
              // 这条路径在 E1 之前就是通的（sendFile 从不查绑定），别在按钮上把它关掉。
              (Boolean(unboundAgent) && draft.trim().length > 0)
              // d.199：生成中不再禁用——纯文本会作为插话入队（带附件的由 send 里拦并说明原因）
            }
            title={
              activeLocal.length > 0
                ? "插话：这一轮下一步就能看到（带附件的话请等这一轮结束）"
                : unboundAgent
                  ? unboundNoticeText(unboundAgent.name)
                  : "发送"
            }
            className={`ml-auto inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ink text-surface transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS_RING}`}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden="true"
              focusable="false"
            >
              <path
                d="M8 12.5V3.5M8 3.5L4 7.5M8 3.5L12 7.5"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
        </div>
        {/* 主对话进度（d.346）：轮次/工具/用时放在输入框下方——用户在框里打字时
            最不该被这条挤占视线，收口后的「上一轮」总结留在原位。 */}
        <TurnProgressLine progress={turnProgress} now={progressNow || undefined} />
        {/* 底部只留快捷键提示（UX-A）：常驻但弱化，不占提示位。 */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 pb-0.5 pt-2">
          <span className="ml-auto">
            <ComposerHints streaming={activeLocal.length > 0} />
          </span>
        </div>
        </div>
      </form>
      </div>
      {view === "trail" ? (
        <div
          id="chat-view-panel-trail"
          role="tabpanel"
          aria-labelledby="chat-view-tab-trail"
          className="flex-1 overflow-y-auto px-chat-gutter py-6"
        >
          <div className="mx-auto w-full max-w-[min(100%,1080px)]">
            <TrajectoryView progress={progress} />
          </div>
        </div>
      ) : null}
      {view === "context" ? (
        <div
          id="chat-view-panel-context"
          role="tabpanel"
          aria-labelledby="chat-view-tab-context"
          className="flex-1 overflow-y-auto px-chat-gutter py-6"
        >
          <div className="mx-auto w-full max-w-[min(100%,1080px)]">
            <ContextView
              conversationId={convId}
              // 预算还没算出来（首次加载）就不传：让页签按本机设置回落，避免闪一下 0 / 0。
              usage={contextUsage.budget > 0 ? contextUsage : undefined}
            />
          </div>
        </div>
      ) : null}
      {/* HITL 工具确认弹窗（设计 §4.3）：
          智能体要调有副作用的工具时，先问用户同不同意。
          弹窗由 store 驱动（pending 单槽 + 队列），这里只负责渲染与回传裁决。 */}
      {pendingHitl && pendingHitl.kind === "tool-call" && (
        <ToolApprovalModal
          requestId={pendingHitl.requestId}
          calls={pendingHitl.calls}
          auto={pendingHitl.auto}
          agentName={pendingHitl.agentName}
          conversationLabel={pendingConvLabel}
          onOpenConversation={
            pendingElsewhere
              ? () => useUiStore.getState().openConversation(pendingHitl.conversationId)
              : undefined
          }
          onDecide={(verdicts) => {
            // 留痕、清通知、decide 都在同一个收口里（与超时路径共用）。
            resolveToolApproval(pendingHitl, verdicts);
          }}
        />
      )}
      </div>
      {/* 右侧栏与主区并列（Codex 式）：主区 min-w-0，被挤压时输入框正常收缩；
          栏自己带 border-l，关闭时整条不渲染、主区自然铺满。 */}
      {progressOpen ? (
        <ProgressPanel
          conversationId={convId}
          {...(panelAgentReason !== null ? { agentNote: panelAgentReason } : {})}
          onClose={() => {
            // 手动关栏（d.245）：记下时间——安静期内自动开栏要让位于这个动作，并把理由清掉。
            panelManualClosedAtRef.current = Date.now();
            setPanelAgentReason(null);
            setProgressOpen(false);
          }}
          {...(hasRevealBridge(getFileBridge())
            ? { onRevealPath: (path: string) => void revealTurnChange(path) }
            : {})}
        />
      ) : null}
    </div>
  );
}