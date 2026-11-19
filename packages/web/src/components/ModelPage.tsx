import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PageShell } from "./layout/PageShell.js";
import { PageTabs } from "./layout/PageTabs.js";
import {
  AlertIcon,
  AssistantIcon,
  CheckIcon,
  ChevronIcon,
  ModelIcon,
  PlugIcon,
  RefreshIcon,
  TrashIcon,
  WorkflowIcon,
} from "./icons.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { ModelTraceView } from "./ModelTraceView.js";
import { Button } from "./ui/Button.js";
import { EmptyState } from "./ui/EmptyState.js";
import { IconButton } from "./ui/IconButton.js";
import { SkeletonCard } from "./ui/Skeleton.js";
import { Stat } from "./ui/Stat.js";
import { TextAreaField, TextField } from "./ui/Field.js";
import { ModelUsageView } from "./ModelUsageView.js";
import { BackupPanel } from "./model/BackupPanel.js";
import { CloudSyncCard } from "./model/CloudSyncCard.js";
import { Avatar } from "./model/Avatar.js";
import { ModelCatalogPanel } from "./model/ModelCatalogPanel.js";
import { SubscriptionRow } from "./model/SubscriptionRow.js";
import { AccountFilterRow } from "./model/AccountFilterRow.js";
import {
  accountFilterEmptyText,
  filterAccounts,
  type AccountFilter,
} from "../lib/accountFilter.js";
import { QUOTA_BADGE } from "./model/quotaBadge.js";
import { DomesticCard } from "./model/DomesticCard.js";
import { QuotaReminder } from "./model/QuotaReminder.js";
import { swapArgs, swapSuggestions, swapText, type SwapSuggestion } from "../lib/swapAccount.js";
import { rankText } from "../lib/quotaRank.js";
import {
  autoResetArgs,
  autoResetLevelText,
  parseAutoReset,
  parseResetLead,
  resetLeadArgs,
  resetLeadLabel,
  spendsExpiringResets,
  type AutoResetLevel,
} from "../lib/autoReset.js";
import { capArgs, parseAccountCaps } from "../lib/accountCap.js";
import { WarmupCard } from "./model/WarmupCard.js";
import { QuotaCards } from "./model/QuotaCards.js";
import { QuotaTrendCard } from "./model/QuotaTrendCard.js";
import { drawableRows, parseQuotaHistory, type QuotaHistoryRow } from "../lib/quotaHistory.js";
import {
  cardSummary,
  cardTone,
  nonSubscriptionCards,
  parseQuotaCards,
  quotaKindLabel,
  type QuotaCard,
} from "../lib/magpieQuotaCards.js";
import {
  discoveryArgs,
  discoveryText,
  parseDiscovery,
  type DiscoveryState,
} from "../lib/discovery.js";
import { readCache, writeCache } from "../lib/pageCache.js";
import { readFailureDetail, readFailureText, readFailuresText, setReadError, type ReadErrors, type ReadSection } from "../lib/readErrors.js";
import { bulkModelTargets, bulkModelText, bulkWriteText, siblingTargets, type BulkModelOutcome } from "../lib/bulkModel.js";
import { useLlmStore } from "../store/llm.js";
import { fetchGatewayImageModels } from "../lib/magpieClient.js";
import { useUiStore } from "../store/ui.js";
import { ensureDesktopGateway } from "../lib/magpieHost.js";
import {
  getMagpieCliBridge,
  parseAccounts,
  parseProviders,
  readProviderShow,
  stripAnsi,
  tailText,
  type AccountRow,
  type MagpieCliBridge,
  type MagpieCliEvent,
  type ProviderRow,
} from "../lib/magpieCli.js";
import { agentSummary } from "../lib/agentSummary.js";
import { isModelId, parseAgents, type LocalAgent } from "../lib/magpieAgents.js";
import { engineText } from "../lib/engineText.js";
import {
  buildModelRows,
  groupModelRows,
  isModelDisabled,
  parseDisabledModels,
  rowsForAgent,
  type DisabledPattern,
} from "../lib/modelCatalog.js";
import { parseModelSpec } from "../lib/modelSpec.js";
import {
  parseAgentVisibility,
  pickedOnlyArgs,
  visibilityOf,
  visibilitySummary,
  visibleArgs,
  sameVisibleRange,
  type AgentVisibility,
} from "../lib/magpieVisible.js";
import { agentName, formatResetIn, latestReadAt } from "../lib/magpieQuota.js";
import { agentQuotaMap, type AgentQuota } from "../lib/agentQuota.js";
import { mergeAccounts } from "../lib/mergedQuota.js";
import { MergedQuotaStrip } from "./model/MergedQuotaStrip.js";
import {
  balanceAlertText,
  reminderArgs,
  resetReminderText,
  usageAlertText,
} from "../lib/magpieReminder.js";
import { warmupArgs, warmupTimesArgs, type WarmupLevel } from "../lib/warmup.js";
import { parseHeaderLines } from "../lib/magpieSourceHeaders.js";
import {
  describeShowFlags,
  headersToText,
  parseSourceShow,
  type SourceShowFlags,
} from "../lib/magpieSourceShow.js";
import {
  GROUP_SETTING_FIELDS,
  GROUP_TEMPLATES,
  groupSetArgs,
  groupTemplateArgs,
} from "../lib/magpieGroups.js";
import {
  SOURCE_TUNE_FIELDS,
  sourceTuneCommands,
  sourceTuneRejected,
  type SourceTuneKey,
} from "../lib/magpieSourceTune.js";
import {
  SOURCE_MODELS_FIELDS,
  sourceModelsCommands,
  sourceModelsSummary,
  type SourceModelsKey,
} from "../lib/magpieSourceModels.js";
import {
  SOURCE_PROFILE_FIELDS,
  sourceProfileCommand,
  sourceProfileRejected,
  type SourceProfileKey,
} from "../lib/magpieSourceProfile.js";
import {
  SOURCE_WIRE_FIELDS,
  sourceWireCommand,
  type SourceWireKey,
} from "../lib/magpieSourceWire.js";
import { describeProxy, parseProxy, proxyArgs, proxyProblem, type ProxyMode } from "../lib/magpieProxy.js";
import { parseSearchRoute, type SearchRoute } from "../lib/magpieSearch.js";
import { HEADER_PRESETS, applyHeaderPreset } from "../lib/magpieHeaderPresets.js";
import {
  CHECKIN_SWITCHES,
  CHECKIN_VENDORS,
  checkinFailed,
  checkinSummary,
  checkinSwitchArgs,
  checkinSwitchState,
  DOMESTIC_AGENTS,
  DOMESTIC_GROUPS,
  DOMESTIC_KEY_NOTE,
  parseCheckin,
  parsePluginProviders,
  parseSettingValues,
  type DomesticAgent,
} from "../lib/magpieDomestic.js";
import {
  parseCompact,
  parseContextCap,
  parseSuffix,
  supportsContextCap,
  type CompactState,
  type ContextCapState,
  type SuffixState,
} from "../lib/modelGlobals.js";
import { GlobalModelSettings } from "./model/GlobalModelSettings.js";
import { ImageModelSettings } from "./model/ImageModelSettings.js";
import { SearchProviderSettings } from "./model/SearchProviderSettings.js";
import { textSetting } from "../lib/modelSettings.js";
import { supportsModelTier } from "../lib/modelTier.js";
import {
  PROVIDER_MODELS_CHOICE_HINT,
  PROVIDER_MODELS_CHOICE_LABEL,
  addProviderModelArgs,
  parseProviderModels,
  providerModelLabel,
  providerModelsChoiceArgs,
  refreshProviderModelsArgs,
  removeProviderModelArgs,
  type ProviderModel,
} from "../lib/providerModels.js";
import {
  checkApiKey,
  normalizeProviderUrl,
  providerTestVerdict,
} from "../lib/settings/providerForm.js";
import {
  MAGPIE_PRESETS,
  defaultPlanOption,
  detectPlanFromShow,
  findPreset,
  parseShowUrls,
  planOptionOf,
  presetAddArgs,
  type PlanKind,
} from "../lib/magpiePresets.js";

/**
 * 模型页（d.104，d.357 收成两个分区）：加来源 → 选模型 → 看它怎么跑。
 *
 * 设计参考（magpie 的路由/供应商页，以及与用户几轮反馈）：
 * - 只保留两个大分区：来源（模型从哪来）/ 运行（模型怎么跑）；其余能力都折进这两处；
 * - 加来源用卡片：订阅点一下去登录，厂商点一下只填一个 Key；
 * - 模型与账号用行卡片（头像 + 名称 + 说明 + 状态），比表格更像「在选东西」；
 * - 不出现服务状态、地址、端口与启停按钮；也不出现第三方产品名；
 * - 动效克制：卡片 200ms 抬起、分区切换 300ms 淡入，尊重「减少动态效果」。
 */

type TabKey = "sources" | "run";

/**
 * 两个分区（d.357）：来源（模型从哪来）与运行（模型怎么跑）。
 * 原来单独的「模型」「智能体」两个页签并了进来——同一件事别分在四个地方找：
 * 可用模型回到「来源」末尾，本机智能体回到「运行」里。
 * 图标与全站同一套描边（icons.tsx），尺寸统一 14px；「来源」在浏览器端没有 CLI 时会被过滤掉。
 */
const TABS: { key: TabKey; label: string; icon: ReactNode }[] = [
  { key: "sources", label: "来源", icon: <PlugIcon width={14} height={14} /> },
  { key: "run", label: "运行", icon: <WorkflowIcon width={14} height={14} /> },
];

/**
 * 运行页上那排「跳到哪一块」（d.398）：轨迹、智能体、路由分组、用量、备份与同步、更多。
 *
 * 只做「滚到那儿」，不做筛选——每块本来就在页上，这排只是省得一路滚。
 * id 由下面各块的容器提供（`run-trace` / `run-agents` / …），改 id 时两边一起改。
 */
/**
 * 来源页顶上那排「跳到哪一块」：这一页比运行页还长（两排卡片 + 两张清单 + 模型清单 + 两个折叠）。
 * 标签刻意用短词（订阅 / 国产端 / 已添加 / 模型清单）：全称与页内标题同字，
 * getByText 会撞成「Found multiple elements」，既有用例会挂。
 */
const SOURCE_ANCHORS: { id: string; label: string }[] = [
  { id: "source-presets", label: "服务商" },
  { id: "source-subs", label: "订阅" },
  { id: "source-domestic", label: "国产端" },
  { id: "source-added", label: "已添加" },
  { id: "source-models", label: "模型清单" },
];

const RUN_ANCHORS = [
  { id: "run-trace", label: "轨迹" },
  { id: "run-agents", label: "智能体" },
  { id: "run-groups", label: "路由分组" },
  { id: "run-usage", label: "用量" },
  { id: "run-backup", label: "备份与同步" },
  { id: "run-more", label: "更多" },
] as const;

/** 滚到运行页的某一块；被测环境没有 scrollIntoView 时静默跳过，不让点击抛错。 */
function jumpTo(id: string): void {
  const target = document.getElementById(id);
  if (target && typeof target.scrollIntoView === "function") {
    target.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

/**
 * 智能体模型下拉的「自定义…」值：给不在网关目录里的模型留一个出口，
 * 不让下拉把「模型列表没刷新」变成「无法选」。
 */
const AGENT_CUSTOM = "__custom__";

const SUBSCRIPTIONS = [
  { agent: "claude", label: "Claude", desc: "Pro / Max / Team" },
  { agent: "codex", label: "ChatGPT", desc: "Plus / Pro / Business" },
  { agent: "copilot", label: "Copilot", desc: "GitHub 账号" },
  { agent: "gemini", label: "Gemini", desc: "Code Assist" },
  { agent: "antigravity", label: "Antigravity", desc: "Google 账号" },
];

/** 来源行的计划徽标：普通地址保持灰，Coding Plan 用蓝（不用红：它不是错误）。 */
const PLAN_BADGE: Record<PlanKind, { label: string; className: string }> = {
  normal: { label: "普通地址", className: "bg-subtle-3 text-muted" },
  coding: { label: "Coding Plan", className: "bg-info-soft text-info" },
};

/**
 * 智能体名字旁边那一小枚「剩 18%」（d.282）：这里只说「还剩多少」，不说订的是哪家——
 * 悬停里才展开每个账号、每个窗口。读不到额度时不贴，免得每行都挂一个问号。
 * 配色在 model/quotaBadge.ts，和国内端卡片共用。
 */
function AgentQuotaChip({ quota }: { quota: AgentQuota | undefined }) {
  if (!quota) return null;
  return (
    <span className={`ui-chip shrink-0 ${QUOTA_BADGE[quota.tone]}`} title={quota.detail}>
      {quota.label}
    </span>
  );
}

/**
 * 选路策略的界面文案（d.140 · 审计 S1-9）。
 *
 * CLI 里是 smart/order/rotate… 这类短值，直接当 <option> 文案等于把命令行摊给用户；
 * 选项显示中文、提交仍走原值，命令输出与后端协议完全不变。
 */
const ROUTING_LABEL: Record<string, string> = {
  smart: "智能分配",
  order: "按列表顺序",
  rotate: "轮询",
  usage: "优先低用量",
  pace: "按额度节奏",
  weight: "按权重随机",
  free: "优先免费",
  fast: "优先快",
  cheap: "优先便宜",
  drain: "先耗完再切换",
  expiring: "先到期先用",
};

/** 账号排名那句的色调：最紧的已经见底就红，偏紧就黄，都还宽裕就不额外强调。 */
const RANK_TONE: Record<"danger" | "warn" | "muted", string> = {
  danger: "text-danger",
  warn: "text-warn",
  muted: "",
};

const GROUP_ROUTING = [
  "smart",
  "order",
  "rotate",
  "usage",
  "pace",
  "weight",
  "free",
  "fast",
  "cheap",
  "drain",
  "expiring",
];

export function ModelPage() {
  const profiles = useLlmStore((s) => s.profiles);
  /** 网关目录：显示名、思考档、窗口、图片输入都来自这里（模型页以前忽略了它们）。 */
  const catalogModels = useLlmStore((s) => s.models);
  const refreshCatalog = useLlmStore((s) => s.refreshCatalog);
  const gatewayConfig = useLlmStore((s) => s.gateway);

  const cli = useMemo<MagpieCliBridge | null>(() => getMagpieCliBridge(), []);
  const [tab, setTab] = useState<TabKey>("sources");

  // 命令面板的二级视图入口（d.142）：见 store/ui.ts 的 `focus-tab`。
  const paletteIntent = useUiStore((s) => s.paletteIntent);
  const consumePaletteIntent = useUiStore((s) => s.consumePaletteIntent);
  useEffect(() => {
    if (paletteIntent?.kind !== "focus-tab") return;
    const { page, tab: want } = paletteIntent.data ?? {};
    if (page !== "model" || !want) return;
    if (!TABS.some((t) => t.key === want)) return;
    setTab(want as TabKey);
    consumePaletteIntent();
  }, [paletteIntent, consumePaletteIntent]);
  const [busy, setBusy] = useState<string | null>(null);
  const [output, setOutput] = useState<{ title: string; text: string; ok: boolean } | null>(null);
  /** 来源区的就地反馈：加完一个来源给一句话，用户还要继续加，所以不跳页。 */
  const [notice, setNoticeState] = useState<{ text: string; failed: boolean } | null>(null);
  /**
   * 提示条：普通消息与失败用两种颜色，别让「签到失败」长成完成的样子。
   * 保留 setNotice(字符串) 的老签名，新增的两步动作才传第二个参数。
   */
  const setNotice = useCallback((text: string, failed = false) => {
    setNoticeState({ text: engineText(text), failed });
  }, []);
  /**
   * 先用上一次读到的原话画一版。
   *
   * `providers` 要 600ms 上下、`accounts` 400ms 上下，每次打开都空等这半秒不划算；
   * 有缓存就先画出来，真正的读取一回来就把它替换掉。缓存里存的是内核原话，
   * 解析规则变了它会跟着失效，不会出现「旧形状 + 新逻辑」。
   */
  const [providers, setProviders] = useState<ProviderRow[]>(() =>
    parseProviders(readCache("providers") || ""),
  );
  const [accounts, setAccounts] = useState<AccountRow[]>(() =>
    parseAccounts(readCache("accounts") || ""),
  );
  /**
   * 订阅以外的额度（Key、套餐、钱包余额，内核 `quota --json`）。
   *
   * `accounts --json` 只讲订阅账号；按量付费的 Key 花到哪儿去了、还剩多少，
   * 原先页面上完全看不到，只能开终端敲命令。
   */
  const [quotaCards, setQuotaCards] = useState<QuotaCard[]>(() =>
    parseQuotaCards(readCache("quotas") || ""),
  );
  /**
   * 哪一段这次没读到、内核怎么说的。
   *
   * 读失败（内核没起来、缺运行文件、超时）与「真的没有」在界面上必须分开：
   * 前者要说「没读到」并给一句原因，否则用户会按「去登录一个账号」去修一个服务问题。
   */
  const [readErrors, setReadErrors] = useState<ReadErrors>({});
  /** 自动收取本机登录的开关状态；空 = 这次没读到。 */
  const [discovery, setDiscovery] = useState<DiscoveryState | null>(null);
  /** 额度走向：内核记下的历史读数（只在真有两条以上读数的窗口上画）。 */
  const [history, setHistory] = useState<QuotaHistoryRow[]>([]);
  /** 额度走向看几天（内核 `quota history --days n`，默认一周）。 */
  const [historyDays, setHistoryDays] = useState(7);
  /**
   * Codex 账号「重置谁花」（账号 → 档位）。
   *
   * 内核把这个开关存在 settings 里，但 `settings list --json` 与 `accounts --json` 都不报它，
   * 只能读 `quota auto-reset` 的散文输出：没读过就当作关闭，绝不替用户猜一个「开着」。
   */
  const [autoResetLevels, setAutoResetLevels] = useState<Map<string, AutoResetLevel>>(() => new Map());
  /**
   * 每个账号「用到百分之几就换下一个」（`provider account-cap`）：键是小写账号名。
   * 内核按 provider 报一遍所有账号的档位，所以读的时候按 agent 去重、合并成一张表。
   */
  const [accountCaps, setAccountCaps] = useState<Map<string, number>>(() => new Map());
  /** 同一家有几个人：只有这一家有第二份额度时，「用到多少换下一个」才有意义。 */
  const agentAccountCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of accounts) counts.set(row.agent, (counts.get(row.agent) ?? 0) + 1);
    return counts;
  }, [accounts]);
  /** 「快过期时提前多久花」（分钟，`quota auto-reset lead`）；null = 这次没读到。 */
  const [resetLead, setResetLead] = useState<number | null>(null);
  /** 订阅账号上正在跑的动作（`agent:user`；刷新全量时是 `refresh`）：只忙那一处。 */
  const [accountBusy, setAccountBusy] = useState<string | null>(null);
  /**
   * 已经接进来的国内端 agent id。WorkBuddy、Qoder 这些端的登录与额度由接入组件
   * 供给，内核自己的登录流只认 Claude/ChatGPT/Copilot/Gemini/Antigravity；
   * 这张表决定点下去是「直接登录」还是「先接进来再登录」，页面上不区分这两种情况。
   */
  const [pluginProviders, setPluginProviders] = useState<Set<string>>(() => new Set());
  /**
   * settings 的现值（key → value）：国内端的「每天自动签到」是四个厂商开关，
   * 读一次 `settings list --json` 就有全部，不必逐个 get。
   */
  const [settingValues, setSettingValues] = useState<Map<string, unknown>>(() => new Map());
  /**
   * 重置倒计时与「读数几分钟前」都要跟着时间走。集中一个时钟：
   * 每分钟跳一次，没有账号就不开定时器（不白跑）。
   */
  const [now, setNow] = useState(() => Date.now());
  /**
   * 「运行 → 本机智能体」每行贴的额度徽标（d.282）：和「来源 → 订阅账号」是同一份数据，
   * 这样选模型时就能看见「这个智能体的免费额度还剩多少」。
   */
  const agentQuotas = useMemo(() => agentQuotaMap(accounts, now), [accounts, now]);
  /** 同一家两三个账号的窗口合计：一个账号自己的已经在下面那行。 */
  const mergedAccounts = useMemo(() => mergeAccounts(accounts, now), [accounts, now]);
  /** 有账号用完、同门还有余量的：问一句要不要换过去（内核只替 Claude / Codex 换号）。 */
  const swapHints = useMemo(() => swapSuggestions(accounts), [accounts]);
  /** 哪个账号最宽裕、哪个最紧：账号多时不必自己一行行扫进度条。 */
  const accountRank = useMemo(() => rankText(accounts), [accounts]);
  /**
   * 一个账号的「用到多少换下一个」：内核报的是账号本身的名字，有些人给账号起了别名，
   * 所以先按账号名找、再按别名找；两处都没有就是不设上限。
   */
  const capOf = (row: AccountRow): number => {
    const direct = accountCaps.get((row.user ?? "").toLowerCase());
    if (direct !== undefined) return direct;
    return (row.alias ? accountCaps.get(row.alias.toLowerCase()) : undefined) ?? 0;
  };
  /** 订阅以外（Key / 套餐 / 余额）的额度：订阅已经在「订阅账号」卡里按账号列过。 */
  const keyQuotas = useMemo(() => nonSubscriptionCards(quotaCards), [quotaCards]);
  /**
   * provider id → 这份额度（d.340）。
   *
   * 「已添加的来源」每一行本来就是那个 provider 的操作位（测试、换 Key、删除），
   * 额度写在那儿才挨着能动手的地方；所以额度卡只留没有来源行的那些（钱包余额、
   * 没有 Key 的套餐），同一个 provider 不再在两张卡里各说一遍。
   */
  const quotaByProvider = useMemo(() => {
    const map = new Map<string, QuotaCard>();
    for (const card of keyQuotas) map.set(card.provider, card);
    return map;
  }, [keyQuotas]);
  /** 没有对应来源行的额度卡（钱包余额、没有 Key 的套餐）。 */
  const orphanQuotas = useMemo(
    () => keyQuotas.filter((card) => !providers.some((provider) => provider.id === card.provider)),
    [keyQuotas, providers],
  );
  /**
   * 账号列表的筛选项（`all` = 不筛）。
   *
   * 账号一多，真正要看的往往是「哪个快用完了」「哪个要重新登录」；筛完再刷新或
   * 切号时也留在这一档上，方便连续处理同一类账号。
   */
  const [accountFilter, setAccountFilter] = useState<AccountFilter>("all");
  /**
   * 「再加一个账号」那段（登录网格与国产智能体）：有账号时默认收起——进来是看额度
   * 的，不是来登录的；一个账号都没有时默认摊开，那才是这会儿唯一的下一步。
   */
  const [addAccountOpen, setAddAccountOpen] = useState(() => accounts.length === 0);
  /** 账号从「一个都没有」变成「有了」时自动收起那段，反之摊开。 */
  const noAccounts = accounts.length === 0;
  useEffect(() => {
    setAddAccountOpen(noAccounts);
  }, [noAccounts]);
  const visibleAccounts = useMemo(
    () => filterAccounts(accounts, accountFilter),
    [accounts, accountFilter],
  );
  /** 本机智能体：ls 输出解析；改写会写入它们的配置文件，所以有二次确认。 */
  const [agents, setAgents] = useState<LocalAgent[]>(() =>
    parseAgents(readCache("agents") || ""),
  );
  const [agentConfirm, setAgentConfirm] = useState<{ id: string; name: string; model: string } | null>(
    null,
  );
  /** 每行待应用的模型输入（按智能体展示名索引，不持久化）。 */
  /**
   * 待确认的动作（审计 F4）：来源与搜索来源以前点一下就执行，而同一页的分组/密钥
   * 删除却是两步确认——同一件不可恢复的事有两套语言。现在统一走 ConfirmDialog。
   *
   * 不只有删除：订阅账号的「切到这个」会改写别的工具的登录状态，同样先问一句，
   * 但那不是破坏性操作，所以按钮用 `tone: "primary"` 而不是红的。
   */
  const [confirmAction, setConfirmAction] = useState<{
    title: string;
    desc: string;
    confirmLabel: string;
    tone?: "danger" | "primary";
    action: () => void;
  } | null>(null);
  const [agentModels, setAgentModels] = useState<Record<string, string>>({});
  /** 智能体模型选「自定义…」后手填的 provider/model。 */
  const [agentCustom, setAgentCustom] = useState<Record<string, string>>({});
  /** 「一次给多个工具设同一个模型」里挑的那个模型。 */
  const [bulkModel, setBulkModel] = useState("");
  const [loading, setLoading] = useState(true);
  /** 被 `model disable` 关掉的模型（glob 模式 + 当前命中）。 */
  const [disabledModels, setDisabledModels] = useState<DisabledPattern[]>([]);
  /** 全局模型设置（名字后缀 / 压缩窗口 / 窗口上限）。 */
  const [suffix, setSuffix] = useState<SuffixState>({ mode: "" });
  const [compact, setCompact] = useState<CompactState>({ fullContext: false });
  const [contextCap, setContextCap] = useState<ContextCapState>({});
  /** 内核认不认识 `model context-cap`：不认识就整块不摆，免得保存必报错。 */
  const [capSupported, setCapSupported] = useState(false);
  /** 看图模型 / 画图模型（`magpie settings` 的 vision、imageGen；空 = 自动或关掉）。 */
  const [visionModel, setVisionModel] = useState("");
  /** 看图模型描述图片时的思考档（`settings visionEffort`；空 = 用它自己的默认）。 */
  const [visionEffort, setVisionEffort] = useState("");
  const [imageGenModel, setImageGenModel] = useState("");
  /** 内核认不认识 `model tier`：不认识就不摆速度档，免得保存必报错。 */
  const [tierSupported, setTierSupported] = useState(false);
  /** 网关单独列出的画图模型（`/v1/models?kind=image`），给「画图模型」下拉用。 */
  const [drawerModels, setDrawerModels] = useState<{ id: string; name: string }[]>([]);
  /** 每个智能体被收窄到的来源（`magpie visible`；没出现的能看到全部）。 */
  const [visibility, setVisibility] = useState<AgentVisibility[]>([]);
  /** 展开「可见模型」的智能体 id。 */
  const [visibleOpen, setVisibleOpen] = useState<string | null>(null);
  /** 可见模型编辑中的勾选（agent id → 来源 id 列表）。 */
  const [visibleDraft, setVisibleDraft] = useState<Record<string, string[]>>({});
  /** 选中的厂商与地址类型（plan 是 planOptions 里的 id，普通地址默认）。 */
  const [presetKey, setPresetKey] = useState<{ id: string; plan: string; key: string } | null>(null);
  const [custom, setCustom] = useState({ open: false, id: "", url: "", key: "", models: "" });
  /** 自定义来源的保存前校验错误（就地显示，不弹窗、不清空已填内容）。 */
  const [customError, setCustomError] = useState<string | null>(null);
  /** 展开高级时按需读 `provider show` 的结果：chat 地址 + 普通/套餐。 */
  const [showCache, setShowCache] = useState<
    Record<
      string,
      { chat: string; plan: PlanKind; models: ProviderModel[]; note: string; flags: SourceShowFlags }
    >
  >({});
  const [showLoading, setShowLoading] = useState<string | null>(null);
  /** 来源的连通性测试结论，按来源 id 记：行上直接写「通过 · 1.2 秒」或「连不上」。 */
  const [testState, setTestState] = useState<
    Record<string, { state: "running" | "ok" | "bad"; label: string; detail: string }>
  >({});
  /** 正在一家一家测（「全部测一遍」按着的时候）：按钮要变成进行中，也不能重复点。 */
  const [testingEvery, setTestingEvery] = useState(false);
  /**
   * 来源区的搜索词：只筛「API Key 服务商」与「国产智能体」这两排卡片。
   * 已添加的来源、订阅账号都不动——那是每天要点的，藏起来会让人以为被删了。
   */
  const [sourceFilter, setSourceFilter] = useState("");
  // 网络代理（d.402）：三选一 + 一个地址。值来自设置里那份表，改完立刻重读。
  const [proxyMode, setProxyMode] = useState<ProxyMode>("system");
  const [proxyAddress, setProxyAddress] = useState("");
  /** 网页搜索交给谁、先问谁、想多深（`settings` 的三项）。 */
  const [searchRoute, setSearchRoute] = useState<SearchRoute>({ searcher: "", effort: "", first: "" });
  /** 名字 / 说明 / id 里任一处含这个词就算匹配（不区分大小写）；空搜索词一律算匹配。 */
  const matchesSourceFilter = (id: string, name: string, desc: string) => {
    const query = sourceFilter.trim().toLowerCase();
    if (query === "") return true;
    return [id, name, desc].some((text) => text.toLowerCase().includes(query));
  };
  const [live, setLive] = useState("");
  const liveRef = useRef("");
  const [runId, setRunId] = useState<string | null>(null);
  const [terminalInput, setTerminalInput] = useState("");
  const [groupForm, setGroupForm] = useState({ name: "", models: "", routing: "smart", target: "" });
  /** 组的设置项（会话亲和 / 是否列出 / 推理档 / 上下文 / 族），空字符串＝不改。 */
  const [groupSettings, setGroupSettings] = useState<Record<string, string>>({});
  /** 来源高级设置（只在展开某个来源时显示）。 */
  const [advancedProvider, setAdvancedProvider] = useState<string | null>(null);
  const [providerForm, setProviderForm] = useState({
    key: "",
    routing: "",
    fallback: "",
    modelsUrl: "",
    headerText: "",
    patience: "",
    errors: "",
    atOnce: "",
    rpm: "",
    queue: "",
    quotaRest: "",
    restCap: "",
    listed: "",
    refreshEvery: "",
    autoInclude: "",
    free: "",
    context: "",
    family: "",
    unmasked: "",
    userAgent: "",
    search: "",
    compaction: "",
  });
  /** 调流那几格各写各的：留空就是「这次不改」，不是「改回默认」。 */
  const tuneSetters: Record<SourceTuneKey, (value: string) => void> = {
    atOnce: (value) => setProviderForm({ ...providerForm, atOnce: value }),
    rpm: (value) => setProviderForm({ ...providerForm, rpm: value }),
    queue: (value) => setProviderForm({ ...providerForm, queue: value }),
    quotaRest: (value) => setProviderForm({ ...providerForm, quotaRest: value }),
    restCap: (value) => setProviderForm({ ...providerForm, restCap: value }),
  };
  /** 模型清单那几格同理：不选就是这次不改。 */
  const modelsSetters: Record<SourceModelsKey, (value: string) => void> = {
    listed: (value) => setProviderForm({ ...providerForm, listed: value }),
    refreshEvery: (value) => setProviderForm({ ...providerForm, refreshEvery: value }),
    autoInclude: (value) => setProviderForm({ ...providerForm, autoInclude: value }),
  };
  /** 「它是什么」那几格：算不算免费、上下文多大、族标签、原文发不发。 */
  const profileSetters: Record<SourceProfileKey, (value: string) => void> = {
    free: (value) => setProviderForm({ ...providerForm, free: value }),
    context: (value) => setProviderForm({ ...providerForm, context: value }),
    family: (value) => setProviderForm({ ...providerForm, family: value }),
    unmasked: (value) => setProviderForm({ ...providerForm, unmasked: value }),
  };
  /** 端的小开关：搜索、压缩、User-Agent，同样是「不选就不改」。 */
  const wireSetters: Record<SourceWireKey, (value: string) => void> = {
    userAgent: (value) => setProviderForm({ ...providerForm, userAgent: value }),
    search: (value) => setProviderForm({ ...providerForm, search: value }),
    compaction: (value) => setProviderForm({ ...providerForm, compaction: value }),
  };
  /** 每个来源「添加模型」输入框里的内容。 */
  const [modelAdd, setModelAdd] = useState<Record<string, string>>({});
  /** 路由分组规则（可选）：把某一类请求先交给组里指定模型。 */
  const [ruleForm, setRuleForm] = useState({
    group: "",
    use: "",
    tokens: "",
    folders: "",
    time: "",
    intent: "",
  });
  const [searchForm, setSearchForm] = useState({ api: "", key: "", target: "" });
  const [termCommand, setTermCommand] = useState("");
  /** 网关密钥（共享给其他设备/CI 用）的输入。 */
  const [gatewayKeyForm, setGatewayKeyForm] = useState({ name: "", readOnly: false, target: "" });

  useEffect(() => {
    void ensureDesktopGateway();
  }, []);

  useEffect(() => {
    if (!cli) {
      setLoading(false);
      return;
    }
    return cli.onCli((event: MagpieCliEvent) => {
      if (event.type === "start") {
        setRunId(event.runId);
        return;
      }
      if (event.type !== "stdout" && event.type !== "stderr") return;
      liveRef.current += event.text ?? "";
      setLive(engineText(tailText(stripAnsi(liveRef.current))));
    });
  }, [cli]);

  /**
   * 同一个加载器同时只跑一份。
   *
   * 每次加载都要起一个内核进程（实测 `providers` 629ms、`accounts` 425ms、
   * 其余 280–430ms），首屏与「刷新」撞在一起时重复起进程既慢又会让旧读数
   * 覆盖新读数。同键的并发请求直接复用前一份。
   */
  const inflight = useRef(new Map<string, Promise<void>>());
  const once = useCallback((key: string, run: () => Promise<void>): Promise<void> => {
    const pending = inflight.current.get(key);
    if (pending) return pending;
    const task = run().finally(() => inflight.current.delete(key));
    inflight.current.set(key, task);
    return task;
  }, []);

  /**
   * 记下这一段读失败的原因；读成功时把它抹掉。
   *
   * state 之外再留一份 ref：一批读完之后要立刻总结「哪几段没读到」，
   * 而那时 state 还没重新渲染，闭包里读到的是旧值。
   */
  const readErrorsRef = useRef<ReadErrors>({});
  const reportRead = useCallback((section: ReadSection, result: { ok: boolean; stderr?: string; error?: string }) => {
    const next = setReadError(
      readErrorsRef.current,
      section,
      result.ok ? null : readFailureDetail(result.stderr || "", result.error),
    );
    readErrorsRef.current = next;
    setReadErrors(next);
  }, []);

  const loadProviders = useCallback(
    () =>
      once("providers", async () => {
        if (!cli) return;
        const result = await cli.cli(["providers"]);
        reportRead("providers", result);
        // 读失败时留住上一次的读数：一次超时不该把已经看到的列表抹成空。
        if (!result.ok) return;
        setProviders(parseProviders(result.stdout || ""));
        // 留一份原话给下一次打开先画：读取本身要半秒多，页面不必空等。
        writeCache("providers", result.stdout || "");
      }),
    [cli, once, reportRead],
  );

  const loadAccounts = useCallback(
    () =>
      once("accounts", async () => {
        if (!cli) return;
        const result = await cli.cli(["accounts", "--json"]);
        reportRead("accounts", result);
        // 读失败时留住上一次的读数：一次超时不该把已经看到的列表抹成空。
        if (!result.ok) return;
        setAccounts(parseAccounts(result.stdout || ""));
        writeCache("accounts", result.stdout || "");
      }),
    [cli, once, reportRead],
  );

  const loadAgents = useCallback(
    () =>
      once("agents", async () => {
        if (!cli) return;
        const result = await cli.cli(["ls"]);
        reportRead("agents", result);
        // 读失败时留住上一次的读数：一次超时不该把已经看到的列表抹成空。
        if (!result.ok) return;
        writeCache("agents", result.stdout || "");
        setAgents(parseAgents(result.stdout || ""));
      }),
    [cli, once, reportRead],
  );

  const loadPlugins = useCallback(
    () =>
      once("plugins", async () => {
        if (!cli) return;
        const result = await cli.cli(["plugin", "list", "--json"]);
        setPluginProviders(parsePluginProviders(result.stdout || ""));
      }),
    [cli, once],
  );

  const loadSettings = useCallback(
    () =>
      once("settings", async () => {
        if (!cli) return;
        const result = await cli.cli(["settings", "list", "--json"]);
        const values = parseSettingValues(result.stdout || "");
        setSettingValues(values);
        // 看图/画图这三项本来各发一条 `settings get`，其实就在这份表里：
        // 一次读全，省下三个进程；值原样是字符串，取不到就是没设置。
        setVisionModel(textSetting(values, "vision"));
        setVisionEffort(textSetting(values, "visionEffort"));
        setImageGenModel(textSetting(values, "imageGen"));
        const proxy = parseProxy(textSetting(values, "proxy"));
        setProxyMode(proxy.mode);
        setProxyAddress(proxy.address);
        // 搜索交给谁这三项也在这份表里，一次读全。
        setSearchRoute(parseSearchRoute(values));
      }),
    [cli, once],
  );

  const loadDisabledModels = useCallback(
    () =>
      once("disabled", async () => {
        if (!cli) return;
        const result = await cli.cli(["model", "disabled"]);
        setDisabledModels(parseDisabledModels(result.stdout || ""));
      }),
    [cli, once],
  );

  const loadVisibility = useCallback(
    () =>
      once("visibility", async () => {
        if (!cli) return;
        const result = await cli.cli(["visible"]);
        setVisibility(parseAgentVisibility(result.stdout || ""));
      }),
    [cli, once],
  );

  /** 其余来源（Key/套餐/钱包）的额度：`accounts` 只讲订阅，这些只在这里出现。 */
  const loadQuotas = useCallback(
    () =>
      once("quotas", async () => {
        if (!cli) return;
        const result = await cli.cli(["quota", "--json"]);
        reportRead("quotas", result);
        // 读失败时留住上一次的读数：一次超时不该把已经看到的列表抹成空。
        if (!result.ok) return;
        setQuotaCards(parseQuotaCards(result.stdout || ""));
        writeCache("quotas", result.stdout || "");
      }),
    [cli, once, reportRead],
  );

  /**
   * 自动收取开关的状态。它是「订阅账号从哪来」的前提：关掉之后下拉里一个账号都不会出现，
   * 页面得说清这件事，否则用户只会以为账号丢了。
   */
  const loadDiscovery = useCallback(
    () =>
      once("discovery", async () => {
        if (!cli) return;
        const result = await cli.cli(["accounts", "discovery"]);
        setDiscovery(parseDiscovery(`${result.stdout || ""}${result.stderr || ""}`));
      }),
    [cli, once],
  );

  /**
   * 额度走向：内核记下的历史读数（`quota history --days n --json`，默认最近 7 天）。
   *
   * 与 `quota --json` 分开取：历史读的是本地记录，不必等厂商；
   * 它又只在真有历史时才画，所以放第二波、失败也不吵。
   * 天数由用户选（7/14/30），所以去重键里带上天数：同一档并发只发一条，换档照常重读。
   */
  const loadHistory = useCallback(
    (days: number = historyDays) =>
      once(`history:${days}`, async () => {
        if (!cli) return;
        const result = await cli.cli(["quota", "history", "--days", String(days), "--json"]);
        setHistory(drawableRows(parseQuotaHistory(result.stdout || "")));
      }),
    [cli, once, historyDays],
  );

  /**
   * Codex 的「重置谁花」：内核只以散文报告（见 `lib/autoReset.ts`），读一次很便宜，放第二波。
   */
  const loadAutoReset = useCallback(
    () =>
      once("autoReset", async () => {
        if (!cli) return;
        const [levels, lead] = await Promise.all([
          cli.cli(["quota", "auto-reset"]),
          cli.cli(["quota", "auto-reset", "lead"]),
        ]);
        setAutoResetLevels(parseAutoReset(`${levels.stdout || ""}${levels.stderr || ""}`));
        setResetLead(parseResetLead(`${lead.stdout || ""}${lead.stderr || ""}`));
      }),
    [cli, once],
  );

  /**
   * 每个账号「用到百分之几就换下一个」：内核按 provider 报告（带账号名与档位），
   * 所以按账号里的 agent 去重后各问一次，合并成一张表。
   */
  const capAgents = useMemo(
    () => [...new Set(accounts.map((row) => row.agent))].filter(Boolean).sort(),
    [accounts],
  );
  // 档位是按来源存的：同一批来源下多一个账号，答案不会变，不必再问一遍。
  // 这个键记的就是「上回问过的来源集合」，未变时 loadCaps 直接返回。
  const capAgentsKey = capAgents.join(",");
  const capsLoaded = useRef<string | null>(null);
  const loadCaps = useCallback(
    (force = false) => {
      if (cli && !force && capsLoaded.current === capAgentsKey) return Promise.resolve();
      return once("caps", async () => {
        if (!cli) return;
        if (capAgents.length === 0) {
          capsLoaded.current = capAgentsKey;
          setAccountCaps(new Map());
          return;
        }
        const results = await Promise.all(
          capAgents.map((agent) => cli.cli(["provider", "account-cap", agent])),
        );
        const merged = new Map<string, number>();
        for (const result of results) {
          for (const [key, value] of parseAccountCaps(`${result.stdout || ""}${result.stderr || ""}`)) {
            merged.set(key, value);
          }
        }
        capsLoaded.current = capAgentsKey;
        setAccountCaps(merged);
      });
    },
    [capAgents, capAgentsKey, cli, once],
  );

  const loadGlobals = useCallback(async () => {
    if (!cli) return;
    // 三条固定命令；窗口上限能不能设，先由 `model` 的 usage 说了算（内核不认识就别发）。
    const [suffix, compact, modelUsage] = await Promise.all([
      cli.cli(["model", "suffix"]),
      cli.cli(["model", "compact"]),
      cli.cli(["model"]),
    ]);
    setSuffix(parseSuffix(suffix.stdout || ""));
    setCompact(parseCompact(compact.stdout || ""));
    const usage = `${modelUsage.stdout || ""}${modelUsage.stderr || ""}`;
    setTierSupported(supportsModelTier(usage));
    const capSupported = supportsContextCap(usage);
    setCapSupported(capSupported);
    if (!capSupported) {
      setContextCap({});
      return;
    }
    const cap = await cli.cli(["model", "context-cap"]);
    setContextCap(parseContextCap(cap.stdout || ""));
  }, [cli]);

  /** 画图模型不在默认目录里：单独问一次网关的 `?kind=image`，问不到就当没有。 */
  const loadDrawers = useCallback(async () => {
    const list = await fetchGatewayImageModels(gatewayConfig).catch(() => []);
    setDrawerModels(list.map((model) => ({ id: model.id, name: model.name })));
  }, [gatewayConfig]);

  /**
   * 「来源」页专用的那几路（其余额度、额度走向、重置开关、接入组件表、自动收取）
   * 是否已经读过。首屏不读它们，进到「来源」再读一次（见下面的 effect）。
   */
  const sourcesWarm = useRef(false);

  /**
   * 把整页重读一遍。
   *
   * 页头那个按钮早先只重读「模型目录 + 来源 + 账号 + 禁用 + 可见 + 全局」，
   * 额度、走向、插件、设置都不在列表里：改完 Key 之后余额还是旧的，
   * 签到之后走向图也不动。既然有一个「刷新」，就不该只刷半页。
   *
   * 内核读用量有 1 分钟缓存，所以先让它现在就去问一遍厂商
   * （`quota refresh <provider>`），否则「重读全部」拿回的可能还是刚才那份；
   * 某个厂商问不到不影响别的，失败原因由各自的读取结果写进提示条。
   */
  const reloadAll = useCallback(async () => {
    if (!cli) return;
    const vendors = [
      ...new Set([...accounts.map((row) => row.agent), ...providers.map((row) => row.id)]),
    ].filter(Boolean);
    await Promise.all(
      vendors.map((vendor) => cli.cli(["quota", "refresh", vendor]).catch(() => undefined)),
    );
    await refreshCatalog().catch(() => {});
    // 整页重读把「来源」那几路也读了：进「来源」时不必再补一次。
    sourcesWarm.current = true;
    await Promise.all([
      loadProviders(),
      loadAccounts(),
      loadQuotas(),
      loadHistory(),
      loadAutoReset(),
      // 重读全部是显式动作：档位也重新问一遍，不受「来源集合没变」的跳过影响。
      loadCaps(true),
      loadAgents(),
      loadPlugins(),
      loadSettings(),
      loadDiscovery(),
      loadDisabledModels(),
      loadVisibility(),
      loadGlobals(),
      loadDrawers(),
    ]);
    setNow(Date.now());
    const failed = readFailuresText(readErrorsRef.current);
    setNotice(failed === "" ? "已重读全部：来源、账号、额度、走向与设置都按现在的样子更新了。" : `已重读，但${failed}`);
  }, [
    cli,
    accounts,
    providers,
    refreshCatalog,
    loadProviders,
    loadAccounts,
    loadQuotas,
    loadHistory,
    loadAutoReset,
    loadCaps,
    loadAgents,
    loadPlugins,
    loadSettings,
    loadDiscovery,
    loadDisabledModels,
    loadVisibility,
    loadGlobals,
    loadDrawers,
    setNotice,
  ]);

  /**
   * 执行一条内核命令并保留文本结果（可达性结论要用它说人话）。
   * 与 run 共用同一条 setBusy / output 通道，避免两套「正在运行」状态。
   */
  const runDetailed = useCallback(
    async (
      title: string,
      args: string[],
      opts: { refresh?: boolean } = {},
    ): Promise<{ ok: boolean; text: string }> => {
      if (!cli) {
        const text = "这个操作只在和鸣桌面端可用。";
        setOutput({ title, text, ok: false });
        return { ok: false, text };
      }
      setBusy(title);
      try {
        const result = await cli.cli(args);
        const text =
          [result.stdout, result.stderr, result.error]
            .filter((part) => part && part.trim())
            .join("\n")
            .trim() || "完成";
        setOutput({ title, text: stripAnsi(text), ok: result.ok });
        if (result.ok && opts.refresh) {
          await refreshCatalog().catch(() => {});
          await loadProviders();
          await loadAccounts();
          // 一条写命令也可能动到 Key、限额或登录态：余额卡与走向图跟着重读，不然它们是旧的。
          await Promise.all([loadQuotas(), loadHistory()]);
        }
        return { ok: result.ok, text };
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        setOutput({ title, text, ok: false });
        return { ok: false, text };
      } finally {
        setBusy(null);
      }
    },
    [cli, refreshCatalog, loadProviders, loadAccounts, loadQuotas, loadHistory],
  );

  const run = useCallback(
    async (title: string, args: string[], opts: { refresh?: boolean } = {}) =>
      (await runDetailed(title, args, opts)).ok,
    [runDetailed],
  );

  /**
   * 模型目录面板的写入口：与 runDetailed 同一条忙碌/输出通道，
   * 成功后顺手刷新被禁用清单（禁用/启用/改名都会影响它）。
   */
  const runModelCommand = useCallback(
    async (title: string, args: string[], opts: { refresh?: boolean } = {}) => {
      const result = await runDetailed(title, args, opts);
      if (result.ok && opts.refresh) await loadDisabledModels();
      return result;
    },
    [runDetailed, loadDisabledModels],
  );

  /**
   * 可勾的来源：已添加的来源 + 当前收窄里出现但没在来源列表里的名字（家族 / 路由组），
   * 这样界面上不会把智能体已经收窄到的家族弄丢。
   */
  const visibleOptionsOf = useCallback(
    (agent: LocalAgent): string[] => {
      const current = visibilityOf(visibility, agent.id ?? "");
      const ids = providers.map((provider) => provider.id);
      const extras = (current?.names ?? []).filter((name) => !ids.includes(name));
      return [...ids, ...extras];
    },
    [providers, visibility],
  );

  /** 正在编辑就用手上的勾选，否则用服务端现状；不受限 = 全勾。 */
  const visibleSelectionOf = useCallback(
    (agent: LocalAgent): string[] => {
      const agentId = agent.id ?? "";
      return (
        visibleDraft[agentId] ??
        visibilityOf(visibility, agentId)?.names ??
        providers.map((provider) => provider.id)
      );
    },
    [visibleDraft, visibility, providers],
  );

  /** 这个智能体被收窄到的名字；空 = 全部模型都看得到。 */
  const agentVisibleNames = useCallback(
    (agent: LocalAgent): string[] => visibilityOf(visibility, agent.id ?? "")?.names ?? [],
    [visibility],
  );

  /**
   * 勾选改过了还没保存？
   *
   * 勾选框是本地的草稿（`visibleDraft`），不点「保存可见范围」不会写进别人的配置。
   * 所以没改动时那个按钮就该是灰的：白发一条命令、还顺手把人家配置重写一遍，
   * 是这一页最容易让人误会的地方。
   */
  const visibleDirtyOf = useCallback(
    (agent: LocalAgent): boolean => {
      const agentId = agent.id ?? "";
      if (!(agentId in visibleDraft)) return false;
      const allIds = providers.map((provider) => provider.id);
      return !sameVisibleRange(agentVisibleNames(agent), visibleSelectionOf(agent), allIds);
    },
    [agentVisibleNames, providers, visibleDraft, visibleSelectionOf],
  );

  /** `magpie visible <agent> <names…|all>`：写完刷新可见范围（它也会改写智能体自己的配置）。 */
  const runVisibleCommand = async (agent: LocalAgent, args: string[]) => {
    if (!cli || !agent.id) return;
    const agentId = agent.id;
    const result = await runDetailed(`保存 ${agent.name} 的可见模型`, args);
    if (!result.ok) return;
    setVisibleDraft((current) => {
      const next = { ...current };
      delete next[agentId];
      return next;
    });
    await loadVisibility();
    await loadAgents();
  };

  const saveVisible = async (agent: LocalAgent) => {
    if (!cli || !agent.id) return;
    const { names } = visibleArgsOf(agent);
    await runVisibleCommand(agent, visibleArgs(agent.id, names));
  };

  /** 这一行勾选对应的 `visible` 参数：全勾时名字为空（内核写作 `all`）。 */
  const visibleArgsOf = (agent: LocalAgent): { names: string[]; everything: boolean } => {
    const all = providers.map((provider) => provider.id);
    const picked = visibleSelectionOf(agent);
    const everything =
      all.length > 0 && all.every((id) => picked.includes(id)) && picked.length === all.length;
    return { names: everything ? [] : picked, everything };
  };

  /**
   * 把这一行的勾选同样写给别的工具。
   *
   * 逐个发（内核一次只改一个工具自己的配置），一个失败不打断后面的；
   * 写完把那几行的草稿丢掉，让界面回到内核的真值上。
   */
  const applyVisibleToSiblings = async (agent: LocalAgent) => {
    if (!cli || !agent.id) return;
    const { names } = visibleArgsOf(agent);
    const others = siblingTargets(agent, agents);
    setBusy("统一可见范围");
    const outcome: BulkModelOutcome = { done: [], failed: [] };
    try {
      for (const other of others) {
        const otherId = other.id ?? "";
        if (!otherId) continue;
        const result = await cli.cli(visibleArgs(otherId, names));
        if (result.ok) {
          outcome.done.push(other.name);
        } else {
          outcome.failed.push({
            name: other.name,
            why: readFailureDetail(result.stderr || result.error || ""),
          });
        }
      }
      setVisibleDraft((current) => {
        const next = { ...current };
        for (const other of others) {
          if (other.id) delete next[other.id];
        }
        return next;
      });
      await loadVisibility();
      await loadAgents();
      const said = bulkWriteText(`已把这份可见范围写给 ${outcome.done.length} 个工具。`, outcome);
      setNotice(said.text, said.failed);
    } finally {
      setBusy(null);
    }
  };

  /** 改写别人的配置之前先确认，并点名会写到哪些工具。 */
  const confirmShareVisible = (agent: LocalAgent) => {
    const others = siblingTargets(agent, agents);
    setConfirmAction({
      title: `把 ${agent.name} 的这份勾选同样写给其它 ${others.length} 个工具？`,
      desc: `会覆盖 ${others.map((other) => other.name).join("、")} 自己的可见范围；想撤回就在各自的「可见模型」里点「恢复全部」。`,
      confirmLabel: "一起写",
      tone: "primary",
      action: () => void applyVisibleToSiblings(agent),
    });
  };

  const runTerminal = async (title: string, args: string[]) => {
    if (!cli) {
      setOutput({ title, text: "这个操作只在和鸣桌面端可用。", ok: false });
      return;
    }
    const result = await cli.openTerminal(args);
    setOutput({
      title,
      text: result.ok
        ? "已打开登录窗口：按提示在浏览器完成登录，完成后回到这里刷新即可。"
        : result.error || "无法打开登录窗口",
      ok: result.ok,
    });
    // 登录成功后账号列表会多一行（额度也要重读）：直接刷一次，不用用户再点。
    if (result.ok) await loadAccounts();
  };

  /** 失效的账号重新登录：与登录卡片同一条命令，只是从这一行发起。 */
  const reloginAccount = (row: AccountRow) => {
    void runTerminal(`登录 ${agentName(row.agent)}`, ["accounts", "add", row.agent]);
  };

  /**
   * 切换智能体自己的登录账号（`accounts switch <agent> <email>`）。
   *
   * 这会改写那个工具自己的登录状态，所以走二次确认；确认文案里说明「不切也能用上」，
   * 因为和鸣走网关时本来就按各账号剩余额度自动挑，别让人以为不切就白登录了。
   */
  const switchAccount = async (row: AccountRow) => {
    if (!cli || !row.user) return;
    setAccountBusy(`${row.agent}:${row.user}`);
    try {
      const result = await cli.cli(["accounts", "switch", row.agent, row.user]);
      await loadAccounts();
      setNow(Date.now());
      setNotice(
        result.ok
          ? `已把 ${agentName(row.agent)} 切到 ${row.label}。`
          : `切换失败：${(result.error || result.stderr || "").trim() || "没有说明原因"}`,
        !result.ok,
      );
    } catch (err) {
      setNotice(`切换失败：${err instanceof Error ? err.message : String(err)}`, true);
    } finally {
      setAccountBusy(null);
    }
  };

  /**
   * 花掉这个账号持有的一次额度重置（`quota reset`）。
   *
   * Codex 偶尔给账号几次「手动重置」：窗口用光了不必等到自然重置，用一次就让当前窗口从头开始。
   * 这个动作撤不回来，所以先确认，并且把「还剩几次、什么时候到期」写进确认框。
   */
  const spendReset = async (row: AccountRow) => {
    if (!cli) return;
    setAccountBusy(`${row.agent}:${row.user ?? ""}`);
    try {
      const args = ["quota", "reset", ...(row.user ? [row.user] : []), "--yes"];
      const result = await cli.cli(args);
      await Promise.all([loadAccounts(), loadQuotas()]);
      setNow(Date.now());
      setNotice(
        result.ok
          ? `${row.label} 的窗口已经重新开始，可以接着用了。`
          : `没能用掉这次重置：${engineText(tailText(stripAnsi(result.stderr || result.error || ""))) || "没有说明原因"}`,
        !result.ok,
      );
    } catch (err) {
      setNotice(`没能用掉这次重置：${err instanceof Error ? err.message : String(err)}`, true);
    } finally {
      setAccountBusy(null);
    }
  };

  /**
   * 打开 / 关掉「自动收取本机登录」。
   *
   * 关掉之后订阅账号会一起消失（内核不再把别家的登录当订阅供给），所以这里重读账号与额度，
   * 并在提示条里说清发生了什么——否则用户只会看到列表空了。
   */
  const toggleDiscovery = async () => {
    if (!cli) return;
    const next: DiscoveryState = discovery === "off" ? "on" : "off";
    setAccountBusy("discovery");
    try {
      const result = await cli.cli(discoveryArgs(next));
      setDiscovery(parseDiscovery(`${result.stdout || ""}${result.stderr || ""}`) ?? next);
      await Promise.all([loadAccounts(), loadQuotas()]);
      setNow(Date.now());
      setNotice(
        result.ok
          ? next === "on"
            ? "已打开自动收取：本机软件里登录的账号会重新出现。"
            : "已关掉自动收取：订阅账号不再自动出现，需要在这里手动登录。"
          : `没能改这个开关：${engineText(tailText(stripAnsi(result.stderr || result.error || ""))) || "没有说明原因"}`,
        !result.ok,
      );
    } catch (err) {
      setNotice(`没能改这个开关：${err instanceof Error ? err.message : String(err)}`, true);
    } finally {
      setAccountBusy(null);
    }
  };

  const confirmSpendReset = (row: AccountRow) => {
    const left = row.resets?.count ?? 0;
    const due = row.resets?.until ? formatResetIn(row.resets.until, now) : "";
    setConfirmAction({
      title: `用掉 ${row.label} 的一次重置？`,
      desc: `会把 ${agentName(row.agent)} 这个账号当前的额度窗口从头开始，换一次可用的量。这个动作撤不回来${
        left > 1 ? `；这个账号还剩 ${left} 次` : "；这个账号只剩这一次"
      }${due ? `，${due.replace("后重置", "后到期")}` : ""}。`,
      confirmLabel: "用掉一次",
      tone: "primary",
      action: () => void spendReset(row),
    });
  };

  /**
   * 改一个 Codex 账号的「重置谁花」（`quota auto-reset`）。
   *
   * 内核的重置次数会过期作废：周窗口用完、又没有别的账号能接时用掉一次，或者快过期时提前用掉，
   * 都比让它白白到期划算。只发档位命令、不碰窗口本身；改完重读一次，用内核的回答当准。
   */
  const changeAutoReset = async (row: AccountRow, level: AutoResetLevel) => {
    if (!cli || !row.user) return;
    setAccountBusy(`${row.agent}:${row.user}`);
    try {
      for (const args of autoResetArgs(row.user, level)) {
        const result = await cli.cli(args);
        if (!result.ok) {
          const why = tailText(stripAnsi((result.stderr || result.stdout || result.error || "").trim()));
          setNotice(`没能改这个设置：${why || "没有说明原因"}`, true);
          await loadAutoReset();
          return;
        }
      }
      await loadAutoReset();
      setNotice(
        level === "off"
          ? `${row.label} 的重置不再自己花，要用时点「用掉一次重置」。`
          : `已让 ${row.label} 自己花掉重置：${autoResetLevelText(level)}。`,
      );
    } catch (err) {
      setNotice(`没能改这个设置：${err instanceof Error ? err.message : String(err)}`, true);
    } finally {
      setAccountBusy(null);
    }
  };

  /**
   * 改「用到多少换下一个」（`provider account-cap`）：内核按账号存百分比，`off` 是不设上限。
   * 只在同一家还别的账号时才有入口——一份额度设了上限会提前退出，没人接就等于是停用。
   */
  const changeCap = async (row: AccountRow, cap: number) => {
    if (!cli || !row.user) return;
    setAccountBusy(`${row.agent}:${row.user}`);
    try {
      const result = await cli.cli(capArgs(row.agent, row.user, cap));
      // 刚写过档位，来源集合没变也得重读，否则下拉还显示旧值。
      await loadCaps(true);
      setNotice(
        result.ok
          ? cap > 0
            ? `已记下：${row.label} 用到 ${cap}% 就换下一个账号。`
            : `已取消上限：${row.label} 会一直用到用光。`
          : `没能改上限：${engineText(tailText(stripAnsi((result.stderr || result.stdout || "").trim()))) || "没有说明原因"}`,
        !result.ok,
      );
    } catch (err) {
      setNotice(`没能改上限：${err instanceof Error ? err.message : String(err)}`, true);
    } finally {
      setAccountBusy(null);
    }
  };

  /**
   * 改「快过期时提前多久花」（`quota auto-reset lead`）。全局一项，只影响会「快过期就花」的账号。
   */
  const changeResetLead = async (minutes: number) => {
    if (!cli) return;
    setAccountBusy("reset-lead");
    try {
      const result = await cli.cli(resetLeadArgs(minutes));
      await loadAutoReset();
      setNotice(
        result.ok
          ? `已记下：一份重置在到期前 ${resetLeadLabel(minutes)}还没用上，就替你花掉。`
          : `没能改这个提前量：${engineText(tailText(stripAnsi(result.stderr || result.stdout || result.error || ""))) || "没有说明原因"}`,
        !result.ok,
      );
    } catch (err) {
      setNotice(`没能改这个提前量：${err instanceof Error ? err.message : String(err)}`, true);
    } finally {
      setAccountBusy(null);
    }
  };

  const confirmSwitchAccount = (row: AccountRow) => {
    if (!row.user) return;
    setConfirmAction({
      title: `把 ${agentName(row.agent)} 切到 ${row.label}？`,
      desc: "切换会改写这个智能体自己的登录状态：之后它直接花这个账号的额度。只是换一个账号，随时可以再切回来。",
      confirmLabel: "切换",
      tone: "primary",
      action: () => void switchAccount(row),
    });
  };

  /**
   * 换到还有额度的那个账号（`accounts switch <agent> next`）。
   *
   * 只在 Claude / Codex 上出现：内核只替「登录态存得下来」的智能体换号。
   * 换号会改写这个工具自己的登录，所以先问一句，和「切到这个」同一套确认。
   */
  const swapAccount = async (agent: string) => {
    if (!cli) return;
    setAccountBusy(`swap:${agent}`);
    try {
      const result = await cli.cli(swapArgs(agent));
      if (!result.ok) {
        const why = tailText(stripAnsi((result.stderr || result.stdout || result.error || "").trim()));
        setNotice(`没能换过去：${why}`, true);
        return;
      }
      await Promise.all([loadAccounts(), loadQuotas(), loadHistory()]);
      setNow(Date.now());
      setNotice(`已把 ${agentName(agent)} 换到还有额度的那个账号。`);
    } catch (err) {
      setNotice(`没能换过去：${err instanceof Error ? err.message : String(err)}`, true);
    } finally {
      setAccountBusy(null);
    }
  };

  const confirmSwapAccount = (hint: SwapSuggestion) => {
    setConfirmAction({
      title: `把 ${agentName(hint.agent)} 换到还有额度的那个？`,
      desc: `${swapText(hint, agentName)}。换过去会改写这个智能体自己的登录状态：之后它直接花那个账号的额度，随时可以再切回来。`,
      confirmLabel: "换过去",
      tone: "primary",
      action: () => void swapAccount(hint.agent),
    });
  };

  /**
   * 给账号起名字（`accounts alias <agent> <email> <name>`；空名字 = `--clear`）。
   *
   * 同一个人常在两三个软件里各登录一次，列表里全是邮箱时分不清「哪个是工作号」，
   * 起个名字只改和鸣这边显示的那一行，不动任何登录状态。
   */
  const renameAccount = async (row: AccountRow, name: string) => {
    if (!cli || !row.user) return;
    setAccountBusy(`${row.agent}:${row.user}`);
    try {
      const args = name
        ? ["accounts", "alias", row.agent, row.user, name]
        : ["accounts", "alias", row.agent, row.user, "--clear"];
      const result = await cli.cli(args);
      await loadAccounts();
      setNotice(
        result.ok
          ? name
            ? `已把它叫作「${name}」。`
            : "已清掉这个名字，改回显示账号本身。"
          : `没能改名：${(result.error || result.stderr || "").trim() || "没有说明原因"}`,
        !result.ok,
      );
    } catch (err) {
      setNotice(`没能改名：${err instanceof Error ? err.message : String(err)}`, true);
    } finally {
      setAccountBusy(null);
    }
  };

  /**
   * 从列表里移除一个账号（`accounts forget <agent> <email>`）。
   *
   * 内核的行为要说清楚：它删掉的是「和鸣记住的这份登录」，如果那个软件此刻正登录在
   * 这个账号上，它会被退出登录（内核会先把它切到别的账号）。所以走二次确认、文案直说。
   */
  const forgetAccount = async (row: AccountRow) => {
    if (!cli || !row.user) return;
    setAccountBusy(`${row.agent}:${row.user}`);
    try {
      const result = await cli.cli(["accounts", "forget", row.agent, row.user]);
      await Promise.all([loadAccounts(), loadQuotas()]);
      setNotice(
        result.ok
          ? `已移除 ${row.label}，它不再占额度。`
          : `没能移除：${(result.error || result.stderr || "").trim() || "没有说明原因"}`,
        !result.ok,
      );
    } catch (err) {
      setNotice(`没能移除：${err instanceof Error ? err.message : String(err)}`, true);
    } finally {
      setAccountBusy(null);
    }
  };

  const confirmForgetAccount = (row: AccountRow) => {
    if (!row.user) return;
    setConfirmAction({
      title: `移除 ${row.label}？`,
      desc: `只会去掉和鸣记住的这份登录。${agentName(row.agent)} 如果此刻正登录在这个账号上，它会被退出登录（有别的账号时先切过去）。之后想用可以再登录一次。`,
      confirmLabel: "移除",
      tone: "danger",
      action: () => void forgetAccount(row),
    });
  };

  /**
   * 「今日签到」：WorkBuddy、Qoder、Trae CN、MiniMax Code 的每日免费额度要点一下才到账。
   * 内核按账号挨个点（`accounts checkin --json`），结果只有「领到 / 今天签过 /
   * 不能参加 / 要验证码」几种，翻成一句话写进提示条；签完顺手重读额度。
   */
  const checkinNow = async () => {
    if (!cli) return;
    setAccountBusy("checkin");
    try {
      const result = await cli.cli(["accounts", "checkin", "--json"]);
      const entries = parseCheckin(result.stdout || "");
      if (!result.ok && entries.length === 0) {
        const why = tailText(stripAnsi((result.stderr || result.error || "").trim()));
        setNotice(`签到失败：${why || "没有说明原因"}`, true);
        return;
      }
      setNotice(checkinSummary(entries), checkinFailed(entries));
      await loadAccounts();
      setNow(Date.now());
    } catch (err) {
      setNotice(`签到失败：${err instanceof Error ? err.message : String(err)}`, true);
    } finally {
      setAccountBusy(null);
    }
  };

  /**
   * 「每天自动签到」：把四个厂商开关写进 settings，内核按北京时间每天自己领一次。
   *
   * 每日免费额度只在当天有效，靠人记得点按钮拿不全；这四个开关就是内核给
   * 这件事留的常开状态（`workbuddyCheckin`/`qoderCheckin`/`traeCheckin`/
   * `minimaxCheckin`）。逐个写、谁失败就停下来说清楚，不谎报全部打开。
   */
  const toggleAutoCheckin = async () => {
    if (!cli) return;
    const enable = checkinSwitchState(settingValues) !== "on";
    setAccountBusy("checkin-switch");
    try {
      let why = "";
      for (const args of checkinSwitchArgs(enable)) {
        const result = await cli.cli(args);
        if (!result.ok) {
          why = tailText(stripAnsi((result.stderr || result.stdout || result.error || "").trim()));
          break;
        }
      }
      await loadSettings();
      if (why) {
        setNotice(`没能改自动签到：${why}`, true);
        return;
      }
      setNotice(
        enable
          ? `已开启每天自动签到：${CHECKIN_VENDORS} 到点自己领，不用再点。`
          : "已关掉每天自动签到；每日额度要手动点「今日签到」。",
      );
    } catch (err) {
      setNotice(`没能改自动签到：${err instanceof Error ? err.message : String(err)}`, true);
    } finally {
      setAccountBusy(null);
    }
  };

  /**
   * 额度提醒（d.283）：写的是内核 settings 的 `usageAlert` / `resetReminder`，
   * 值就是数字本身；成功后重读一次设置，失败把内核原话放进提示条。
   */
  const setReminder = async (
    key: "usageAlert" | "resetReminder" | "balanceAlert",
    value: number,
  ) => {    if (!cli) return;
    setAccountBusy(`reminder:${key}`);
    try {
      const result = await cli.cli(reminderArgs(key, value));
      if (!result.ok) {
        const why = tailText(stripAnsi((result.stderr || result.stdout || result.error || "").trim()));
        setNotice(`没能改提醒：${why}`, true);
        return;
      }
      await loadSettings();
      if (value <= 0) {
        setNotice("已关掉这条提醒。");
        return;
      }
      setNotice(
        key === "balanceAlert"
          ? `已记下：${balanceAlertText(value)}。`
          : `已记下：额度${key === "usageAlert" ? usageAlertText(value) : resetReminderText(value)}。`,
      );
    } catch (err) {
      setNotice(`没能改提醒：${err instanceof Error ? err.message : String(err)}`, true);
    } finally {
      setAccountBusy(null);
    }
  };

  /**
   * 预热档位：内核只认 ""/"week"/"all"，空值是「重置回默认」，
   * 所以「不预热」发的是 reset，不是 set 空串。
   */
  const setWarmupLevel = async (levelKey: string, level: WarmupLevel) => {
    if (!cli) return;
    setAccountBusy(`warmup:${levelKey}`);
    try {
      const result = await cli.cli(warmupArgs(levelKey, level));
      if (!result.ok) {
        const why = tailText(stripAnsi((result.stderr || result.stdout || result.error || "").trim()));
        setNotice(`没能改预热：${why}`, true);
        return;
      }
      await loadSettings();
      setNotice(level === "off" ? "已关掉这家厂商的预热。" : "已打开预热：窗口一重置就先替你开一次。");
    } catch (err) {
      setNotice(`没能改预热：${err instanceof Error ? err.message : String(err)}`, true);
    } finally {
      setAccountBusy(null);
    }
  };

  /** 每天固定开 5 小时窗口的时间点：一条都没有时把这一项重置回空列表。 */
  const setWarmupTimes = async (timesKey: string, times: string[]) => {
    if (!cli) return;
    setAccountBusy(`warmup:${timesKey}`);
    try {
      const result = await cli.cli(warmupTimesArgs(timesKey, times));
      if (!result.ok) {
        const why = tailText(stripAnsi((result.stderr || result.stdout || result.error || "").trim()));
        setNotice(`没能改时间：${why}`, true);
        return;
      }
      await loadSettings();
      setNotice(times.length > 0 ? `已记下：每天 ${times.join("、")} 各开一次。` : "已清掉固定时间。");
    } catch (err) {
      setNotice(`没能改时间：${err instanceof Error ? err.message : String(err)}`, true);
    } finally {
      setAccountBusy(null);
    }
  };

  /**
   * 国内端的两步走：先装社区插件，再登录。
   *
   * 内核自己的登录流只认 Claude/ChatGPT/Copilot/Gemini/Antigravity（国内端是
   * 搬到插件上的内置端），所以没装插件时 `accounts add workbuddy` 只会答
   * 「magpie can't sign in to …」——那不是一个用户能自己解开的错，先把插件装上。
   * 装插件失败就把内核的原话写进提示条，不假装已经装好。
   */
  const prepareDomestic = async (item: DomesticAgent) => {
    if (!cli) return;
    const key = `domestic:${item.agent}`;
    setAccountBusy(key);
    try {
      if (!pluginProviders.has(item.agent)) {
        const result = await cli.cli(["plugin", "add", item.pkg]);
        if (!result.ok) {
          const why = tailText(stripAnsi((result.stderr || result.stdout || result.error || "").trim()));
          setNotice(`没能接入 ${item.label}：${why || "没有说明原因"}`, true);
          return;
        }
        await loadPlugins();
        setNotice(`已把 ${item.label} 接进和鸣，接着登录一次就好。`);
      }
    } finally {
      setAccountBusy(null);
    }
    await runTerminal(`登录 ${item.label}`, ["accounts", "add", item.agent]);
    // 刚登录完，额度缓存可能还是空的：现在就问一次厂商，卡片上立刻有数。
    try {
      await cli.cli(["quota", "refresh", item.agent]);
      await loadAccounts();
    } catch {
      // 刷新失败不影响登录本身，下一次「重读全部」会补上。
    }
  };

  useEffect(() => {
    if (!cli) return;
    let alive = true;
    void (async () => {
      // 第一波：两个分区都要用的四样（来源名、本机智能体、禁用名单、可见范围）。齐了就撤骨架，
      // 不让「额度」「画图模型」「插件表」这些慢一步的东西把整页拖住。
      await Promise.all([loadProviders(), loadAgents(), loadDisabledModels(), loadVisibility()]);
      if (alive) setLoading(false);
      // 第二波：账号与全局设置，边显示边补。
      await Promise.all([
        loadAccounts(),
        loadGlobals(),
        loadDrawers(),
        loadSettings(),
      ]);
    })();
    return () => {
      alive = false;
    };
  }, [
    cli,
    loadProviders,
    loadAccounts,
    loadAgents,
    loadDisabledModels,
    loadVisibility,
    loadGlobals,
    loadSettings,
    loadDrawers,
  ]);

  /**
   * 来源那几路（额度、走向、插件、账号发现）进页面就读——d.357 之后「来源」就是落地页，
   * 不再有「先落在别处、点进来才读」这一段。读过只标记一次，重渲染与切页签都不再打一遍；
   * 要重读走页头的「重读全部」。读之前先按上次缓存画，不闪空。
   */
  useEffect(() => {
    if (!cli || tab !== "sources" || sourcesWarm.current) return;
    sourcesWarm.current = true;
    void Promise.all([
      loadQuotas(),
      loadHistory(),
      loadAutoReset(),
      loadCaps(),
      loadPlugins(),
      loadDiscovery(),
    ]);
  }, [cli, tab, loadQuotas, loadHistory, loadAutoReset, loadCaps, loadPlugins, loadDiscovery]);

  // 换了天数就重读：内核按天数现查，不重读等于选择器没生效。
  useEffect(() => {
    if (!cli || !sourcesWarm.current) return;
    void loadHistory(historyDays);
  }, [cli, historyDays, loadHistory]);

  // 账号变了（登录完、自动收取到新账号）也要重读档位：它是按账号存的。
  // 来源集合没变时 loadCaps 自己会跳过——同一批来源多一个账号，答案是一样的。
  useEffect(() => {
    if (!cli || !sourcesWarm.current) return;
    void loadCaps();
  }, [cli, loadCaps]);

  useEffect(() => {
    if (accounts.length === 0) return;
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [accounts.length]);

  /** 目录行：以网关给的模型为准，目录补全显示名/思考档/窗口/图片输入。 */
  const modelRows = useMemo(
    () => buildModelRows(profiles, catalogModels),
    [profiles, catalogModels],
  );
  const modelGroups = useMemo(() => groupModelRows(modelRows), [modelRows]);

  const addPreset = async () => {
    if (!presetKey || !presetKey.key.trim()) return;
    // 保存前先做格式校验：把「地址当 Key」「带 Bearer 前缀」这类错挡在发请求之前。
    if (checkApiKey(presetKey.key).error) return;
    const preset = findPreset(presetKey.id);
    const option = planOptionOf(preset, presetKey.plan);
    const added = await runDetailed(
      "添加来源",
      presetAddArgs(presetKey.id, presetKey.plan, presetKey.key),
      { refresh: true },
    );
    if (!added.ok) return;
    const id = presetKey.id;
    setPresetKey(null);
    const base = `已添加 ${preset?.name ?? id}${option && option.kind === "coding" ? `（${option.label}）` : ""}。`;
    // 保存成功不等于能用：紧接着测一次连通性，把结论写在同一句提示里（d.138）。
    setNotice(`${base}正在测试连通性…`);
    const tested = await runDetailed("测试来源", ["provider", "test", id]);
    setNotice(
      `${base}${providerTestVerdict(tested.ok, tested.text)}可以接着添加其他来源，或去「模型」看新出现的模型。`,
    );
  };

  const addCustom = async () => {
    const id = custom.id.trim();
    if (!id) return;
    // 地址自动补 scheme / 去尾斜杠；补不了才报错，且只报在表单里，不清空已填内容。
    const urlCheck = normalizeProviderUrl(custom.url);
    if (urlCheck.error) {
      setCustomError(urlCheck.error);
      return;
    }
    const keyCheck = custom.key.trim() ? checkApiKey(custom.key) : null;
    if (keyCheck?.error) {
      setCustomError(keyCheck.error);
      return;
    }
    setCustomError(null);
    const args = ["provider", "add", id, `url=${urlCheck.url}`];
    if (custom.key.trim()) args.push(`key=${custom.key.trim()}`);
    if (custom.models.trim()) args.push(`models=${custom.models.trim()}`);
    const added = await runDetailed("添加自定义来源", args, { refresh: true });
    if (!added.ok) return;
    setCustom({ open: false, id: "", url: "", key: "", models: "" });
    const base = `已添加 ${id}。`;
    setNotice(`${base}正在测试连通性…`);
    const tested = await runDetailed("测试来源", ["provider", "test", id]);
    setNotice(
      `${base}${providerTestVerdict(tested.ok, tested.text)}可以接着添加其他来源，或去「模型」看新出现的模型。`,
    );
  };

  /** 已经为「收起时也看得出改过」读过 show 的来源：每家读一次就够。 */
  const flagsWarm = useRef(new Set<string>());

  /** 读一次来源详情，写进 showCache：地址、普通/套餐、以及它的模型清单。 */
  const readShowIntoCache = useCallback(
    async (id: string) => {
      if (!cli) return;
      const text = await readProviderShow(cli, id);
      const plan = detectPlanFromShow(text) ?? "normal";
      const chat = parseShowUrls(text).chat;
      const { models, note } = parseProviderModels(text);
      const flags = parseSourceShow(text);
      setShowCache((current) => ({ ...current, [id]: { chat, plan, models, note, flags } }));
    },
    [cli],
  );

  /**
   * 首屏把每个来源的现状读一遍：收起时也要看得出「这家改过」。
   *
   * 请求头、算免费、原文照发这些只写在 `provider show` 里；以前要点开「高级」才读，
   * 于是收起的行上永远看不出这家跟默认有什么不同。一家读一次（`flagsWarm` 记着），
   * 一条一条来，不跟首屏那几路抢。
   */
  useEffect(() => {
    if (!cli || providers.length === 0) return;
    let cancelled = false;
    void (async () => {
      for (const row of providers) {
        if (cancelled) return;
        if (flagsWarm.current.has(row.id)) continue;
        flagsWarm.current.add(row.id);
        await readShowIntoCache(row.id).catch(() => {});
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cli, providers, readShowIntoCache]);

  /** 展开某个来源的高级设置：顺带读一次详细地址，判断它是普通还是套餐地址。 */
  const toggleAdvanced = async (id: string) => {
    if (advancedProvider === id) {
      setAdvancedProvider(null);
      return;
    }
    setAdvancedProvider(id);
    // 备用链现在就在行上看得见，把已有的值填进输入框：改一处比重打一串省事。
    const chain = providers.find((row) => row.id === id)?.fallback ?? [];
    setProviderForm((current) => ({ ...current, fallback: chain.join(", ") }));
    if (showCache[id] || !cli) return;
    setShowLoading(id);
    try {
      await readShowIntoCache(id);
    } finally {
      setShowLoading(null);
    }
  };

  /** 改来源的模型清单之后重读一次：清单、地址与套餐徽标都跟着变。 */
  const runProviderModels = async (id: string, title: string, args: string[]) => {
    const result = await runDetailed(title, args);
    if (result.ok) {
      await readShowIntoCache(id).catch(() => {});
      await loadProviders();
    }
    return result;
  };

  /**
   * 点一下「测试」就在这里给结论，不用去下面翻输出。
   *
   * 原来点完只是把内核输出塞进页面底部的终端面板：想知道「通不通」得自己找那句话，
   * 测三个来源就要来回看三次。结论写回行上，失败时把原因挂在悬停里。
   */
  const testProvider = async (id: string) => {
    const startedAt = Date.now();
    setTestState((current) => ({ ...current, [id]: { state: "running", label: "正在测…", detail: "正在向这个来源发一个很小的请求。" } }));
    const result = await runDetailed(`测试 ${id}`, ["provider", "test", id]);
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    setTestState((current) => ({
      ...current,
      [id]: {
        state: result.ok ? "ok" : "bad",
        label: result.ok ? `通过 · ${seconds} 秒` : "连不上",
        detail: providerTestVerdict(result.ok, result.text),
      },
    }));
    return result;
  };

  /**
   * 全部测一遍：一家一家测，结论照旧写在各自的行上，最后报个数。
   *
   * 换机器、换网络之后，「到底哪几家还能用」是常问的；一家一家点要来回找按钮。
   * 串行发——内核的 `provider test` 会真的发一个小请求，几路同时打出去既慢又容易
   * 被对端限流，反而看不出真实结论。
   */
  const testEveryProvider = async () => {
    if (!cli || testingEvery || providers.length === 0) return;
    setTestingEvery(true);
    let ok = 0;
    try {
      for (const row of providers) {
        const result = await testProvider(row.id);
        if (result.ok) ok += 1;
      }
    } finally {
      setTestingEvery(false);
    }
    const failed = providers.length - ok;
    setNotice(
      failed === 0
        ? `全部测过：${ok} 家都通。`
        : `全部测过：${ok} 家通，${failed} 家连不上（原因在各自那行上）。`,
    );
  };

  const startTerminalRun = async () => {
    const args = termCommand.trim().split(/\s+/).filter(Boolean);
    if (!args.length || !cli) return;
    liveRef.current = "";
    setLive("");
    const started = await cli.cliStart(args);
    if (!started.ok) setOutput({ title: "命令", text: started.error || "执行失败", ok: false });
  };

  const agentModelOf = (agent: LocalAgent) => agentModels[agent.name] ?? "";
  const setAgentModelInput = (name: string, value: string) =>
    setAgentModels((current) => ({ ...current, [name]: value }));
  /** 智能体实际要写入的模型：选「自定义…」时取手填值。 */
  const agentEffectiveModel = (agent: LocalAgent) => {
    const value = agentModelOf(agent);
    return value === AGENT_CUSTOM ? (agentCustom[agent.name] ?? "").trim() : value;
  };
  /**
   * 选中的模型和它现在用的不是同一个、才需要写（d.339）。
   * 顺着「可见模型」那条规矩：没改动就不亮按钮，省掉一次没有意义的二次确认。
   * 注意 `agent.model` 来自 `magpie ls`，它写的是这个工具此刻真正在用的模型。
   */
  const agentDirtyOf = (agent: LocalAgent) => {
    const pending = agentEffectiveModel(agent).trim();
    if (!pending) return false;
    return pending !== agent.model.trim();
  };
  /**
   * 它现在是不是「没被模型服务写过」（d.345）。
   *
   * `magpie ls` 对没配过模型的工具报 `—`，空的也算。这种情况下「恢复默认」什么都不会改变，
   * 按下去只是把「本来就没有」再确认一遍，所以按钮该灰着。
   */
  const agentIsDefault = (agent: LocalAgent) => {
    const current = agent.model.trim();
    return !current || current === "—";
  };
  /**
   * 下拉里显示什么：挑过就用挑的，没挑过就显示它现在用的那个模型（d.339）。
   *
   * 以前没挑过一律显示「选择模型…」，看上去像这个工具还没配模型；
   * 但当前模型其实写在下面那行小字里——同一个事实不该分两处看。
   * 只在当前模型确实在可选项里时才回填：被「可见模型」挡在外面的那种不回填，
   * 否则下拉里会多出一个它其实选不了的选项。
   */
  const agentSelectValue = (agent: LocalAgent) => {
    const draft = agentModelOf(agent);
    if (draft) return draft;
    const current = agent.model.trim();
    if (!current) return "";
    const options = rowsForAgent(modelRows, agentVisibleNames(agent));
    return options.some((row) => row.id === current) ? current : "";
  };
  /**
   * 「智能体」顶部那句待办汇总（d.343）。
   *
   * 只数能改写的工具（有 id 的）：改了没写进配置的下次启动不生效，
   * 还没配模型的仍在用它自己的默认。两类都为 0 时 `agentSummary` 给空串，页面不多一行。
   */
  const agentCounts = (() => {
    const writable = agents.filter((agent) => agent.id);
    return {
      total: writable.length,
      dirty: writable.filter((agent) => agentDirtyOf(agent)).length,
      unset: writable.filter((agent) => !agentModelOf(agent) && !isModelId(agent.model.trim())).length,
    };
  })();
  const agentSummaryText = agentSummary(agentCounts);

  /** 能被改写的工具（有 id 的），「一次性设成同一个模型」只对它们生效。 */
  const bulkAgents = useMemo(() => bulkModelTargets(agents), [agents]);

  /**
   * 逐个写：内核没有通配符，`<agent> <model>` 一次只动一个工具自己的配置。
   * 一个失败不打断后面的，最后用一句话说清成败。
   */
  const applyBulkModel = async (model: string) => {
    if (!cli) return;
    setBusy("统一设置模型");
    const outcome: BulkModelOutcome = { done: [], failed: [] };
    try {
      for (const agent of bulkAgents) {
        const agentId = agent.id ?? "";
        if (!agentId) continue;
        const result = await cli.cli([agentId, model]);
        if (result.ok) {
          outcome.done.push(agent.name);
        } else {
          outcome.failed.push({
            name: agent.name,
            why: readFailureDetail(result.stderr || result.error || ""),
          });
        }
      }
      await loadAgents();
      const said = bulkModelText(model, outcome);
      setNotice(said.text, said.failed);
      if (said.failed) setBulkModel("");
    } finally {
      setBusy(null);
    }
  };

  /** 写 N 个配置文件之前先确认一次，并点名会写到哪些工具。 */
  const confirmBulkModel = (model: string) => {
    const names = bulkAgents.map((agent) => agent.name);
    setConfirmAction({
      title: `把 ${names.length} 个工具都设成 ${model}？`,
      desc: `会依次写入 ${names.join("、")} 自己的配置文件（下一次启动生效）。想撤回就逐个点「恢复默认」。`,
      confirmLabel: "全部写入",
      tone: "primary",
      action: () => void applyBulkModel(model),
    });
  };

  /** 当前选中的厂商与地址类型（普通/套餐），添加前要问清楚。 */
  const activePreset = presetKey ? findPreset(presetKey.id) : undefined;
  const activePlan = presetKey ? planOptionOf(activePreset, presetKey.plan) : undefined;
  /** 粘贴 Key 的即时校验结果：明确错用就地报错，可疑格式只提示。 */
  const presetKeyCheck = presetKey ? checkApiKey(presetKey.key) : null;
  /** 自定义地址的即时规范化结果：能补 scheme 就补，补不了就地报错。 */
  const customUrlCheck = custom.url.trim() ? normalizeProviderUrl(custom.url) : null;
  const customKeyCheck = custom.key.trim() ? checkApiKey(custom.key) : null;

  return (
    <PageShell
      title="模型"
      subtitle="所有模型在一个地方：在「来源」里加，在「运行」里看它怎么跑。"
      width="full"
      actions={
        <Button
          type="button"
          size="md" variant="ghost"
          onClick={async () => {
            setBusy("refresh");
            try {
              await reloadAll();
            } finally {
              setBusy(null);
            }
          }}
          busy={busy === "refresh"}
          disabled={busy === "refresh"}
          title="来源、订阅账号、其余额度、额度走向、插件与设置都按现在的情况重读一遍"
        >
          <RefreshIcon width={14} height={14} />
          {busy === "refresh" ? "重读中…" : "重读全部"}
        </Button>
      }
      // 一级页签走 PageShell.tabs + PageTabs（下划线式，与插件页、团队页同一套结构与位置）。
      // 位置由 PageShell 统一给（紧贴页头、与页头同左基线），页面不再自己摆。
      tabs={
        <PageTabs
          label="模型页分区"
          idPrefix="model"
          // 浏览器端没有 CLI 时「来源」进不去，页签与图标一起隐藏（不然点进去是空页）。
          items={TABS.filter((item) => cli !== null || item.key !== "sources")}
          active={tab}
          onChange={(key) => setTab(key as TabKey)}
        />
      }
    >
      {!cli && (
        <div role="status" className="ui-alert ui-alert-info mb-4">
          <AlertIcon width={14} height={14} className="mt-0.5 shrink-0" />
          {/* 12px 文本要求 ≥4.5:1，原先 --muted 在 --subtle 底上只有 4.02；这里用 --body 提到达标。 */}
          <span className="text-body">
            浏览器端只能查看可用模型。添加来源、登录账号与路由维护请打开和鸣桌面端——模型能力运行在你的电脑上。
          </span>
        </div>
      )}

      {/* 提示条放在分区之外：页头的「重读全部」、签到底部的开关都会写它，
          只在「来源」里显示会让在别的分区操作的人什么都看不到。 */}
      {notice && (
        <div
          role="status"
          className={`ui-alert ${notice.failed ? "ui-alert-danger" : "ui-alert-success"} rta-enter mb-4 items-center justify-between`}
        >
          <span className="flex items-center gap-2 text-ui-sm">
            {notice.failed ? (
              <AlertIcon width={14} height={14} className="shrink-0" />
            ) : (
              <CheckIcon width={14} height={14} className="shrink-0" />
            )}
            {notice.text}
          </span>
          <Button type="button" size="sm" variant="ghost" onClick={() => setNoticeState(null)}>
            关闭
          </Button>
        </div>
      )}

      {/* 页签面板：id / aria-labelledby 与 PageTabs 的 `model-*` 约定对齐（tab↔panel 双向可达）。 */}
      <div
        key={tab}
        role="tabpanel"
        id={`model-${tab}-panel`}
        aria-labelledby={`model-${tab}-tab`}
        className="rta-enter"
      >

        {/* ── 来源 ───────────────────────────────────────────── */}
        {tab === "sources" && (
          <section aria-label="来源" className="space-y-4">
            {/* 找预设：服务商与国产端都是「一排卡片挑一个」，多了以后扫一遍很费眼。 */}
            <div className="ui-card p-3">
              <TextField
                label="找服务商"
                hint="只筛「API Key 服务商」与「国产智能体」这两排卡片；已经添加的来源不受影响。"
                placeholder="qwen / 通义 / 智谱 / trae"
                value={sourceFilter}
                onChange={(event) => setSourceFilter(event.target.value)}
              />
            </div>
            {/* 主卡片：厂商 → 地址类型（普通 / Coding Plan）→ 一个 Key */}
            <div className="ui-card p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <nav aria-label="跳到来源页的某一块" className="flex flex-wrap items-center gap-2">
            {SOURCE_ANCHORS.map((anchor) => (
              <Button
                key={anchor.id}
                type="button"
                size="sm"
                variant="ghost"
                className="transition-colors"
                onClick={() => jumpTo(anchor.id)}
              >
                {anchor.label}
              </Button>
            ))}
          </nav>

          <h2 id="source-presets" className="ui-section-title">API Key 服务商</h2>
                <span className="ui-caption">Coding Plan 请选套餐类型，否则会提示余额为 0</span>
              </div>
              {!cli && (
                // 无桌面桥时下面所有入口都点不动：先说明「为什么」，不摆一排灰按钮让人反复点（F-03）。
                <div role="note" className="ui-alert ui-alert-muted mt-2">
                  <AlertIcon width={14} height={14} className="mt-0.5 shrink-0" />
                  <span>
                    浏览器预览下不能添加来源：保存 Key、登录订阅账号与维护自定义地址，都需要桌面版的文件/密钥桥。
                  </span>
                </div>
              )}
              {cli && (
              <div className="mt-3 grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
                {MAGPIE_PRESETS.filter((preset) => matchesSourceFilter(preset.id, preset.name, preset.desc)).map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    aria-pressed={presetKey?.id === preset.id}
                    className={`ui-card ui-card-interactive px-3 py-2.5 text-left disabled:opacity-50 ${
                      presetKey?.id === preset.id
                        ? "border-ink bg-info-soft"
                        : ""
                    }`}
                    disabled={!cli}
                    onClick={() =>
                      setPresetKey({ id: preset.id, plan: defaultPlanOption(preset).id, key: "" })
                    }
                  >
                    <span className="flex items-center gap-2">
                      <Avatar name={preset.name} />
                      <span className="min-w-0">
                        <span className="block truncate text-ui-md font-semibold">{preset.name}</span>
                        <span className="block truncate ui-caption">{preset.desc}</span>
                      </span>
                    </span>
                  </button>
                ))}
              </div>
              )}
              {MAGPIE_PRESETS.every((preset) => !matchesSourceFilter(preset.id, preset.name, preset.desc)) && (
                <p className="mt-3 ui-caption">服务商里没有对得上「{sourceFilter.trim()}」的；清掉搜索词就都回来。</p>
              )}

              {presetKey && activePreset && activePlan && (
                <div className="rta-enter mt-3 rounded-lg border border-line bg-subtle p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2 text-ui-sm font-semibold">
                      添加 {activePreset.name}
                      <span
                        className={`rounded-full px-2 py-0.5 text-ui-xs ${PLAN_BADGE[activePlan.kind].className}`}
                      >
                        {activePlan.label}
                      </span>
                    </div>
                    <Button
                      type="button"
                      size="sm" variant="ghost"
                      onClick={() => setPresetKey(null)}
                    >
                      取消
                    </Button>
                  </div>

                  {activePreset.planOptions.length > 1 && (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <span className="ui-caption">地址类型</span>
                      <div role="group" aria-label="地址类型" className="ui-segment-group">
                        {activePreset.planOptions.map((option) => (
                          <button
                            key={option.id}
                            type="button"
                            aria-pressed={activePlan.id === option.id}
                            className="ui-segment"
                            onClick={() =>
                              setPresetKey((current) =>
                                current ? { ...current, plan: option.id } : current,
                              )
                            }
                          >
                            {option.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="mt-2 flex flex-wrap items-start gap-2">
                    <TextField
                      label="API Key"
                      type="password"
                      className="flex-1"
                      placeholder={
                        activePlan.kind === "coding"
                          ? `粘贴 ${activePlan.label} 的 Key`
                          : "粘贴 API Key"
                      }
                      value={presetKey.key}
                      error={presetKeyCheck?.error ?? null}
                      hint={
                        !presetKeyCheck?.error && presetKeyCheck?.warning
                          ? presetKeyCheck.warning
                          : undefined
                      }
                      onChange={(event) => {
                        const key = event.target.value;
                        setPresetKey((current) => (current ? { ...current, key } : current));
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void addPreset();
                      }}
                    />
                    <Button
                      type="button"
                      size="md" variant="primary"
                      className="mt-5"
                      disabled={!presetKey.key.trim() || Boolean(presetKeyCheck?.error)}
                      onClick={() => void addPreset()}
                    >
                      保存
                    </Button>
                  </div>
                  <p className="mt-2 ui-caption">
                    {activePlan.hint ?? "保存后会自动读取这个 Key 能用的模型。"}
                  </p>
                  {activePlan.kind === "coding" && (
                    <div role="note" className="ui-alert ui-alert-info mt-2">
                      <AlertIcon width={14} height={14} className="mt-0.5 shrink-0" />
                      <span>
                        {activePlan.notice ??
                          "该地址只接受 Coding Plan 的 Key；普通按量 Key 会报「余额为 0」。"}
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>

            {cli && (
            <div className="grid items-start gap-4 lg:grid-cols-2">
              <div className="ui-card p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 id="source-subs" className="ui-section-title">订阅账号</h2>
                  <div className="flex items-center gap-2">
                    <span className={`ui-caption ${readErrors.accounts ? "text-danger" : ""}`}>
                      {readErrors.accounts
                        ? "这次没读到，下面是上次的读数"
                        : latestReadAt(accounts, now) ||
                          (accounts.length > 1 ? "多个账号自动分担" : "每分钟自动重读")}
                    </span>
                    {accounts.length > 0 && (
                      <Button
                        type="button"
                        size="sm" variant="ghost"
                        leadingIcon={<CheckIcon width={14} height={14} />}
                        busy={accountBusy === "checkin"}
                        onClick={() => void checkinNow()}
                        title="WorkBuddy、Qoder、Trae CN、MiniMax Code 的每日免费额度要点一下才到账"
                      >
                        今日签到
                      </Button>
                    )}
                  </div>
                </div>
                <MergedQuotaStrip groups={mergedAccounts} now={now} />

                {accountRank && (
                  <p className={`mt-2 ui-caption ${RANK_TONE[accountRank.tone]}`}>{accountRank.text}</p>
                )}

                {swapHints.length > 0 && (
                  <ul className="mt-2 space-y-1.5" aria-label="换到还有额度的账号">
                    {swapHints.map((hint) => (
                      <li
                        key={hint.agent}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-subtle px-3 py-2"
                      >
                        <span className="ui-caption">{swapText(hint, agentName)}</span>
                        <Button
                          size="sm"
                          variant="ghost"
                          busy={accountBusy === `swap:${hint.agent}`}
                          onClick={() => confirmSwapAccount(hint)}
                        >
                          换过去
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}

                <AccountFilterRow rows={accounts} value={accountFilter} onChange={setAccountFilter} />
                <ul className="mt-3 space-y-2" aria-label="订阅账号列表">
                  {visibleAccounts.map((row, index) => (
                    <SubscriptionRow
                      key={`${row.agent}-${row.user ?? ""}-${index}`}
                      row={row}
                      now={now}
                      busy={accountBusy === `${row.agent}:${row.user}`}
                      onSwitch={confirmSwitchAccount}
                      onRelogin={reloginAccount}
                      onRename={renameAccount}
                      onForget={confirmForgetAccount}
                      onSpendReset={confirmSpendReset}
                      autoReset={autoResetLevels.get((row.user ?? "").toLowerCase()) ?? "off"}
                      onAutoReset={changeAutoReset}
                      cap={capOf(row)}
                      onCapChange={
                        (agentAccountCounts.get(row.agent) ?? 0) > 1 ? changeCap : undefined
                      }
                    />
                  ))}
                  {accounts.length === 0 && (
                    <li className="rounded-xl border border-dashed border-line px-3 py-2.5 ui-caption">
                      {readErrors.accounts ? (
                        <span className="flex flex-wrap items-center justify-between gap-2">
                          <span className="min-w-0 text-danger">
                            {readFailureText("accounts", readErrors.accounts)}
                          </span>
                          <button
                            type="button"
                            className="ui-link shrink-0"
                            disabled={!cli}
                            onClick={() => void loadAccounts()}
                          >
                            重新读一次
                          </button>
                        </span>
                      ) : (
                        <>
                          还没有账号。下面这些软件里已经登录的订阅可以直接借给和鸣用：点一个登录，
                          它的额度、重置时间与余额会显示在这里。
                        </>
                      )}
                    </li>
                  )}
                  {accounts.length > 0 && visibleAccounts.length === 0 && (
                    <li className="rounded-xl border border-dashed border-line px-3 py-2.5 ui-caption">
                      <span className="flex flex-wrap items-center justify-between gap-2">
                        <span className="min-w-0">{accountFilterEmptyText(accountFilter)}</span>
                        <button
                          type="button"
                          className="ui-link shrink-0"
                          onClick={() => setAccountFilter("all")}
                        >
                          看全部
                        </button>
                      </span>
                    </li>
                  )}
                </ul>
                <details
                  className="ui-disclosure mt-3 rounded-xl border border-line bg-subtle px-3 py-2.5"
                  open={addAccountOpen}
                  onToggle={(event) => setAddAccountOpen(event.currentTarget.open)}
                >
                  <summary className="text-ui-md font-semibold">
                    <ChevronIcon width={14} height={14} className="ui-disclosure-chevron" />
                    {accounts.length === 0 ? "登录一个账号" : "再加一个账号"}
                  </summary>
                  <p className="mt-1 ui-caption">
                    这些软件里已经登录的订阅可以直接借给和鸣用：选一个登录，额度、重置时间与余额就会出现在上面。
                  </p>
                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    {SUBSCRIPTIONS.map((item) => (
                      <button
                        key={item.agent}
                        type="button"
                        className="ui-card ui-card-interactive flex items-center gap-2 px-3 py-2 text-left disabled:opacity-50"
                        disabled={!cli}
                        onClick={() =>
                          void runTerminal(`登录 ${item.label}`, ["accounts", "add", item.agent])
                        }
                      >
                        <Avatar name={item.label} />
                        <span className="min-w-0 flex-1">
                          <span className="block text-ui-md font-semibold">{item.label}</span>
                          <span className="block ui-caption">{item.desc}</span>
                        </span>
                        <span className="flex shrink-0 items-center gap-0.5 text-ui-xs text-muted">
                          登录
                          <ChevronIcon width={14} height={14} />
                        </span>
                      </button>
                    ))}
                  </div>

                  <div className="mt-4">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <h3 id="source-domestic" className="text-ui-md font-semibold">国产智能体</h3>
                      <span className="ui-caption">接上这些软件里已经登录的账号，额度就写在卡片上</span>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-subtle px-3 py-2.5">
                      <span className="min-w-0 flex-1">
                        <span className="block text-ui-md font-semibold">每天自动签到</span>
                        <span className="block ui-caption">
                          {checkinSwitchState(settingValues) === "on"
                            ? `${CHECKIN_VENDORS} 到点自己领，不用再点。`
                            : `打开后和鸣每天自动领 ${CHECKIN_VENDORS} 的免费额度。`}
                        </span>
                      </span>
                      <Button
                        size="sm"
                        variant={checkinSwitchState(settingValues) === "on" ? "ghost" : "primary"}
                        busy={accountBusy === "checkin-switch"}
                        onClick={() => void toggleAutoCheckin()}
                      >
                        {checkinSwitchState(settingValues) === "on"
                          ? "关掉自动签到"
                          : checkinSwitchState(settingValues) === "mixed"
                            ? "补齐自动签到"
                            : "开启自动签到"}
                      </Button>
                    </div>
                    <div className="mt-2 grid gap-3">
                      {DOMESTIC_GROUPS.map((group) => ({
                        ...group,
                        items: group.items.filter((item) =>
                          matchesSourceFilter(item.agent, item.label, item.desc),
                        ),
                      }))
                        .filter((group) => group.items.length > 0)
                        .map((group) => (
                        <div key={group.site} className="grid gap-2">
                          <div className="ui-micro">{group.title}</div>
                          {group.items.map((item) => (
                            <DomesticCard
                              key={item.agent}
                              item={item}
                              signedIn={accounts.filter((row) => row.agent === item.agent).length}
                              lapsed={accounts.filter((row) => row.agent === item.agent && row.lapsed).length}
                              quota={agentQuotas.get(item.agent) ?? null}
                              local={agents.some((agent) => agent.id === item.agent)}
                              busy={accountBusy === `domestic:${item.agent}`}
                              onPress={prepareDomestic}
                            />
                          ))}
                        </div>
                      ))}
                      {sourceFilter.trim() !== "" &&
                        DOMESTIC_GROUPS.every((group) =>
                          group.items.every((item) => !matchesSourceFilter(item.agent, item.label, item.desc)),
                        ) && (
                        <p className="ui-caption">
                          国产智能体里没有对得上「{sourceFilter.trim()}」的；清掉搜索词就都回来。
                        </p>
                      )}
                    </div>
                    <p className="mt-2 ui-caption">
                      {DOMESTIC_KEY_NOTE}
                      {DOMESTIC_AGENTS.filter((item) => item.risk).map((item) => (
                        <span key={item.agent} className="mt-1 block">
                          {item.label}：{item.risk}
                        </span>
                      ))}
                    </p>
                  </div>
                </details>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-2.5">
                  <span className="ui-caption">{discoveryText(discovery)}</span>
                  <button
                    type="button"
                    className="ui-link"
                    disabled={!cli || accountBusy !== null}
                    onClick={() => void toggleDiscovery()}
                  >
                    {discovery === "off" ? "打开自动收取" : "关掉自动收取"}
                  </button>
                </div>
                {accounts.length > 0 && (
                  <QuotaReminder
                    values={settingValues}
                    disabled={!cli || busy !== null || accountBusy !== null}
                    onChange={(key, value) => void setReminder(key, value)}
                    lead={spendsExpiringResets(autoResetLevels) ? resetLead : null}
                    onLeadChange={(minutes) => void changeResetLead(minutes)}
                  />
                )}
              </div>

              {(orphanQuotas.length > 0 || readErrors.quotas) && (
                <div className="ui-card p-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h2 className="ui-section-title">其余来源的额度</h2>
                    <span className="ui-caption">没有对应来源行的 Key、套餐与钱包余额</span>
                  </div>
                  {orphanQuotas.length > 0 ? (
                    <QuotaCards cards={orphanQuotas} now={now} />
                  ) : (
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                      <span className="ui-caption text-danger">
                        {readFailureText("quotas", readErrors.quotas ?? "")}
                      </span>
                      <button
                        type="button"
                        className="ui-link shrink-0"
                        disabled={!cli}
                        onClick={() => void loadQuotas()}
                      >
                        重新读一次
                      </button>
                    </div>
                  )}
                </div>
              )}

              {history.length > 0 && (
                <QuotaTrendCard
                  rows={history}
                  now={now}
                  days={historyDays}
                  onDaysChange={setHistoryDays}
                />
              )}

              <WarmupCard
                values={settingValues}
                busy={!cli || busy !== null || accountBusy !== null}
                onLevel={(levelKey, level) => void setWarmupLevel(levelKey, level)}
                onTimes={(timesKey, times) => void setWarmupTimes(timesKey, times)}
              />

            </div>
            )}

            <div className="ui-card p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 id="source-added" className="ui-section-title">已添加的来源（{providers.length}）</h2>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    size="sm" variant="ghost"
                    disabled={!cli || testingEvery || providers.length === 0}
                    title="一家一家真的发一个小请求；结论写在各自那行上，最后报个数。"
                    onClick={() => void testEveryProvider()}
                  >
                    {testingEvery ? "正在一家家测…" : "全部测一遍"}
                  </Button>
                  <Button
                    type="button"
                    size="sm" variant="ghost"
                    disabled={!cli}
                    aria-expanded={custom.open}
                    onClick={() => setCustom({ ...custom, open: !custom.open })}
                  >
                    {custom.open ? "收起这一栏" : "加一个其他地址"}
                  </Button>
                </div>
              </div>
              <p className="mt-1 ui-caption">
                现成的服务商用上面「API Key 服务商」；中转、局域网或自建接口加在这里。
              </p>
              {custom.open && (
                <div className="rta-enter mt-3 grid gap-2 rounded-xl border border-line bg-subtle p-3 sm:grid-cols-2">
                  <TextField
                    label="来源名称"
                    placeholder="名称（如 relay）"
                    value={custom.id}
                    onChange={(event) => setCustom({ ...custom, id: event.target.value })}
                  />
                  <TextField
                    label="接口地址"
                    placeholder="https://host/v1"
                    value={custom.url}
                    error={customUrlCheck?.error ?? null}
                    hint={
                      customUrlCheck && !customUrlCheck.error
                        ? customUrlCheck.hint ?? undefined
                        : undefined
                    }
                    onChange={(event) => setCustom({ ...custom, url: event.target.value })}
                    onBlur={() => {
                      // 能识别的地址就地规范成最终会保存的样子（补 http(s)、去尾斜杠）。
                      if (customUrlCheck && !customUrlCheck.error && customUrlCheck.url) {
                        setCustom((current) => ({ ...current, url: customUrlCheck.url }));
                      }
                    }}
                  />
                  <TextField
                    label="自定义 Key"
                    type="password"
                    placeholder="API Key（可留空：有些中转不校验 Key）"
                    value={custom.key}
                    error={customKeyCheck?.error ?? null}
                    hint={
                      !customKeyCheck?.error && customKeyCheck?.warning
                        ? customKeyCheck.warning
                        : undefined
                    }
                    onChange={(event) => setCustom({ ...custom, key: event.target.value })}
                  />
                  <TextField
                    label="模型列表"
                    className="sm:col-span-2"
                    placeholder="模型 id，逗号分隔（可留空自动读取）"
                    value={custom.models}
                    onChange={(event) => setCustom({ ...custom, models: event.target.value })}
                  />
                  {customError && (
                    <p role="alert" className="sm:col-span-2 ui-caption text-danger">
                      {customError}
                    </p>
                  )}
                  <div className="flex gap-2 sm:col-span-2">
                    <Button
                      type="button"
                      size="md" variant="primary"
                      disabled={!custom.id.trim()}
                      onClick={() => void addCustom()}
                    >
                      保存
                    </Button>
                    <Button
                      type="button"
                      size="md" variant="ghost"
                      onClick={() => setCustom({ open: false, id: "", url: "", key: "", models: "" })}
                    >
                      取消
                    </Button>
                  </div>
                </div>
              )}
              {!cli && (
                <p className="mt-1 ui-caption">浏览器预览下只能查看：测试、换 Key 与删除来源请用桌面版。</p>
              )}
              <ul className="mt-2">
                {providers.map((row) => {
                  const info = showCache[row.id];
                  const quota = quotaByProvider.get(row.id);
                  const badge =
                    showLoading === row.id
                      ? { label: "读取地址…", className: "bg-subtle-3 text-muted" }
                      : PLAN_BADGE[info?.plan ?? "normal"];
                  const tuneValues = {
                    atOnce: providerForm.atOnce,
                    rpm: providerForm.rpm,
                    queue: providerForm.queue,
                    quotaRest: providerForm.quotaRest,
                    restCap: providerForm.restCap,
                  };
                  const tuneCommands = sourceTuneCommands(row.id, tuneValues);
                  const tuneRejected = sourceTuneRejected(tuneValues);
                  const modelsValues = {
                    listed: providerForm.listed,
                    refreshEvery: providerForm.refreshEvery,
                    autoInclude: providerForm.autoInclude,
                  };
                  const modelsCommands = sourceModelsCommands(row.id, modelsValues);
                  const profileValues = {
                    free: providerForm.free,
                    context: providerForm.context,
                    family: providerForm.family,
                    unmasked: providerForm.unmasked,
                  };
                  const profileCommand = sourceProfileCommand(row.id, profileValues);
                  const profileRejected = sourceProfileRejected(profileValues);
                  const requestHeaders = parseHeaderLines(providerForm.headerText);
                  const wireValues = {
                    userAgent: providerForm.userAgent,
                    search: providerForm.search,
                    compaction: providerForm.compaction,
                  };
                  const wireCommand = sourceWireCommand(row.id, wireValues);
                  // show 里只写着「这家跟默认不一样」的地方：收起时也要说得出来，
                  // 不然想问「这家改过什么」只能逐条展开点一遍。
                  const tunedSummary = info?.flags ? describeShowFlags(info.flags) : "";
                  return (
                    <li key={row.id} className="-mx-4 ui-list-row flex-wrap gap-3">
                      <div className="flex w-full flex-wrap items-center gap-3">
                        <Avatar name={row.kind} />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5">
                            <span className="truncate ui-body-sm font-semibold">{row.id}</span>
                            <span
                              className={`shrink-0 rounded-full px-2 py-0.5 text-ui-xs ${badge.className}`}
                            >
                              {badge.label}
                            </span>
                            {row.off && (
                              // 用户自己停的：不是坏了，Key 与记录都在，只是智能体拿不到它的模型。
                              <span
                                className="shrink-0 rounded-full bg-subtle-3 px-2 py-0.5 text-ui-xs text-muted"
                                title="已停用：Key 与记录都留着，只是智能体拿不到它的模型、请求也不会走它"
                              >
                                已停用
                              </span>
                            )}
                            {tunedSummary && (
                              // 这家设过点什么：一句话挂在悬停里，行上只占两个字的位。
                              <span
                                className="shrink-0 rounded-full bg-subtle-3 px-2 py-0.5 text-ui-xs text-muted"
                                title={`这家跟默认不一样：${tunedSummary}`}
                              >
                                改过
                              </span>
                            )}
                            {quota && (
                              // 额度就写在这一行：测试、换 Key、删除都在这儿，不用去另一张卡里对。
                              <span
                                className={`shrink-0 rounded-full px-2 py-0.5 text-ui-xs ${QUOTA_BADGE[cardTone(quota)]}`}
                                title={`${quotaKindLabel(quota.kind)}${quota.plan ? ` · ${quota.plan}` : ""}${
                                  quota.error ? `：${engineText(quota.error)}` : ""
                                }`}
                              >
                                {engineText(cardSummary(quota, now)) || "额度未知"}
                              </span>
                            )}
                          </span>
                          <span className="block truncate ui-caption">
                            {row.kind}
                            {row.host ? ` · ${row.host}` : ""}
                            {row.models !== null ? ` · ${row.models} 个模型` : ""}
                          </span>
                          {row.fallback.length > 0 && (
                            // 额度用完 / 被限流 / 连不上时，请求按这串顺序往下去。
                            <span
                              className="block truncate ui-caption"
                              title={`没额度、被限流或连不上时，请求依次改用 ${row.fallback.join(" → ")}`}
                            >
                              备用 {row.fallback.join(" → ")}
                            </span>
                          )}
                          {row.usedBy.length > 0 && (
                            // 谁在用这一家：删之前先看这一句，别把正在用的来源删了。
                            <span
                              className="block truncate ui-caption"
                              title={`这些智能体现在用它：${row.usedBy.join("、")}`}
                            >
                              ← {row.usedBy.join("、")}
                            </span>
                          )}
                          {testState[row.id] && (
                            // 测试结论就写在行上：通过带耗时，失败写「连不上」，原因在悬停里。
                            <span
                              role="status"
                              className={`block truncate ui-caption ${
                                testState[row.id].state === "ok"
                                  ? "text-success"
                                  : testState[row.id].state === "bad"
                                    ? "text-danger"
                                    : "text-muted"
                              }`}
                              title={testState[row.id].detail}
                            >
                              {testState[row.id].label}
                            </span>
                          )}
                        </span>
                        <Button
                          type="button"
                          size="sm" variant="ghost"
                          disabled={!cli}
                          aria-expanded={advancedProvider === row.id}
                          onClick={() => void toggleAdvanced(row.id)}
                        >
                          高级
                        </Button>
                        <Button
                          type="button"
                          size="sm" variant="ghost"
                          disabled={!cli}
                          busy={testState[row.id]?.state === "running"}
                          onClick={() => void testProvider(row.id)}
                        >
                          测试
                        </Button>
                        <Button
                          type="button"
                          size="sm" variant="ghost"
                          disabled={!cli}
                          // 停用只是关掉开关：Key、模型记录、额度都还在，随时能开回来。
                          onClick={() =>
                            void run(row.off ? "启用来源" : "停用来源", ["provider", row.off ? "on" : "off", row.id], {
                              refresh: true,
                            })
                          }
                        >
                          {row.off ? "启用" : "停用"}
                        </Button>
                        <IconButton
                          label={`删除来源 ${row.id}`}
                          disabled={!cli}
                          icon={<TrashIcon width={16} height={16} />}
                          onClick={() =>
                            setConfirmAction({
                              title: "删除来源？",
                              desc: `来源「${row.id}」删除后不可恢复（地址、Key 与模型记录一并移除）。`,
                              confirmLabel: "删除",
                              action: () =>
                                void run("删除来源", ["provider", "rm", row.id], { refresh: true }),
                            })
                          }
                        />
                      </div>
                      {advancedProvider === row.id && (
                        <div className="rta-enter mt-2 rounded-lg border border-line bg-subtle p-3">
                          <div className="flex flex-wrap items-baseline justify-between gap-2">
                            <div className="text-ui-sm font-semibold">{row.id} 的高级设置</div>
                            {showCache[row.id]?.chat && (
                              <span
                                className="max-w-full truncate font-mono text-ui-xs text-muted"
                                title={showCache[row.id]?.chat}
                              >
                                {showCache[row.id]?.chat}
                              </span>
                            )}
                          </div>

                          <div className="mt-3">
                            <div className="ui-micro">连接</div>
                            <div className="mt-2 flex flex-wrap items-start gap-2">
                              <TextField
                                label="更新 Key"
                                type="password"
                                className="flex-1"
                                placeholder="换成新的 API Key（留空不改）"
                                value={providerForm.key}
                                error={
                                  providerForm.key.trim() ? checkApiKey(providerForm.key).error : null
                                }
                                hint={
                                  providerForm.key.trim() && !checkApiKey(providerForm.key).error
                                    ? checkApiKey(providerForm.key).warning ?? undefined
                                    : undefined
                                }
                                onChange={(event) => setProviderForm({ ...providerForm, key: event.target.value })}
                              />
                              <Button
                                type="button"
                                size="sm" variant="primary" className="mt-5"
                                disabled={
                                  !cli ||
                                  !providerForm.key.trim() ||
                                  Boolean(providerForm.key.trim() && checkApiKey(providerForm.key).error)
                                }
                                onClick={() => void run("更新 Key", ["provider", "key", row.id, providerForm.key.trim()])}
                              >
                                更新 Key
                              </Button>
                            </div>
                            <label className="grid gap-1">
                              <span className="ui-caption">来源分发策略</span>
                              <select
                                className="ui-input mt-2"
                                value={providerForm.routing}
                                onChange={(event) => setProviderForm({ ...providerForm, routing: event.target.value })}
                              >
                                <option value="">分发策略（保持默认）</option>
                                {GROUP_ROUTING.map((routing) => (
                                  <option key={routing} value={routing}>
                                    {ROUTING_LABEL[routing] ?? routing}
                                  </option>
                                ))}
                              </select>
                            </label>
                          </div>

                          <div className="mt-3">
                            <div className="ui-micro">模型</div>
                            <div className="mt-1 flex flex-wrap items-baseline justify-between gap-2">
                              <span className="ui-caption">
                                {info?.note
                                  ? info.note
                                  : showLoading === row.id
                                    ? "读取模型清单…"
                                    : "展开后读取这个来源现在暴露的模型。"}
                              </span>
                              <span className="flex gap-1">
                                {(["all", "best", "none"] as const).map((choice) => (
                                  <Button
                                    key={choice}
                                    type="button"
                                    size="sm" variant="ghost"
                                    disabled={!cli}
                                    title={PROVIDER_MODELS_CHOICE_HINT[choice]}
                                    onClick={() =>
                                      void runProviderModels(
                                        row.id,
                                        `设置 ${row.id} 的模型`,
                                        providerModelsChoiceArgs(row.id, choice),
                                      )
                                    }
                                  >
                                    {PROVIDER_MODELS_CHOICE_LABEL[choice]}
                                  </Button>
                                ))}
                                <Button
                                  type="button"
                                  size="sm" variant="ghost"
                                  disabled={!cli}
                                  title="重新问厂商要一次模型目录"
                                  onClick={() =>
                                    void runProviderModels(
                                      row.id,
                                      "重新读取模型目录",
                                      refreshProviderModelsArgs(row.id),
                                    )
                                  }
                                >
                                  重新读取
                                </Button>
                              </span>
                            </div>
                            {info && info.models.length > 0 && (
                              <ul className="mt-2 flex flex-wrap gap-1.5" aria-label={`${row.id} 的模型`}>
                                {info.models.map((model) => (
                                  <li
                                    key={model.id}
                                    className="flex items-center gap-1 rounded-full border border-line bg-surface px-2 py-0.5 text-ui-xs"
                                  >
                                    <span className="font-mono" title={model.id}>
                                      {providerModelLabel(model)}
                                    </span>
                                    <button
                                      type="button"
                                      className="text-muted hover:text-danger disabled:opacity-40"
                                      aria-label={`移除模型 ${model.id}`}
                                      disabled={!cli}
                                      onClick={() =>
                                        void runProviderModels(
                                          row.id,
                                          "移除模型",
                                          removeProviderModelArgs(row.id, model.id),
                                        )
                                      }
                                    >
                                      ×
                                    </button>
                                  </li>
                                ))}
                              </ul>
                            )}
                            {info && info.models.length === 0 && (
                              <p className="mt-2 ui-caption">这个来源现在一个模型都没暴露。</p>
                            )}
                            <div className="mt-2 flex flex-wrap items-start gap-2">
                              <TextField
                                label="添加模型"
                                className="flex-1"
                                placeholder="模型 id（如 deepseek/deepseek-chat）"
                                value={modelAdd[row.id] ?? ""}
                                onChange={(event) =>
                                  setModelAdd((current) => ({ ...current, [row.id]: event.target.value }))
                                }
                              />
                              <Button
                                type="button"
                                size="sm" variant="ghost" className="mt-5"
                                disabled={!cli || !(modelAdd[row.id] ?? "").trim()}
                                onClick={() =>
                                  void runProviderModels(
                                    row.id,
                                    "添加模型",
                                    addProviderModelArgs(row.id, modelAdd[row.id] ?? ""),
                                  ).then((result) => {
                                    if (result.ok) {
                                      setModelAdd((current) => ({ ...current, [row.id]: "" }));
                                    }
                                  })
                                }
                              >
                                添加模型
                              </Button>
                            </div>
                            <div className="mt-2 grid gap-2 sm:grid-cols-2">
                              <TextField
                                label="模型目录地址"
                                placeholder="模型目录 URL（可选）"
                                value={providerForm.modelsUrl}
                                onChange={(event) => setProviderForm({ ...providerForm, modelsUrl: event.target.value })}
                              />
                              <TextField
                                label="备用模型"
                                placeholder="额度用完/故障时改用：provider/model1,provider/model2"
                                value={providerForm.fallback}
                                onChange={(event) => setProviderForm({ ...providerForm, fallback: event.target.value })}
                              />
                            </div>
                            <Button
                              type="button"
                              size="sm" variant="ghost" className="mt-2"
                              disabled={!cli || !providerForm.fallback.trim()}
                              onClick={() =>
                                void run("设置备用", [
                                  "provider",
                                  "fallback",
                                  row.id,
                                  ...providerForm.fallback
                                    .split(/[,\s]+/)
                                    .map((item) => item.trim())
                                    .filter(Boolean),
                                ], { refresh: true })
                              }
                            >
                              保存备用
                            </Button>
                            {row.fallback.length > 0 && (
                              <Button
                                type="button"
                                size="sm" variant="ghost" className="mt-2"
                                disabled={!cli}
                                onClick={() =>
                                  void run("清掉备用", ["provider", "fallback", row.id, "none"], {
                                    refresh: true,
                                  })
                                }
                              >
                                清掉备用
                              </Button>
                            )}
                          </div>

                          <details className="ui-disclosure mt-3 rounded-lg border border-line bg-subtle px-3 py-2">
                            <summary className="cursor-pointer ui-micro"><ChevronIcon width={14} height={14} className="ui-disclosure-chevron" />
                              更多设置（可选）：请求、调流、清单、它是什么、端的小开关
                            </summary>
                            <p className="mt-1 ui-caption">
                              这几块都是可选的，展开需要的那一项就行：每块自带按钮，只发你改过的那几项，这里不保存任何东西。
                            </p>
                            {info?.flags && describeShowFlags(info.flags) && (
                              <p className="mt-1 ui-caption">现在设着：{describeShowFlags(info.flags)}</p>
                            )}

                            <details className="ui-disclosure mt-2">
                            <summary className="cursor-pointer ui-micro"><ChevronIcon width={14} height={14} className="ui-disclosure-chevron" />
                              请求（请求头 / 耐心 / 错误处理）
                            </summary>
                            <div className="mt-2 grid gap-2 sm:grid-cols-2">
                              <TextAreaField
                                label="自定义请求头"
                                hint="一行一个，写成「名称: 值」；值留空就是删掉这个头。"
                                placeholder={"X-Trace: 一批一批来\nX-Team: data"}
                                className="sm:col-span-2"
                                value={providerForm.headerText}
                                onChange={(event) => setProviderForm({ ...providerForm, headerText: event.target.value })}
                              />
                              <label className="grid gap-1 sm:col-span-2">
                                <span className="ui-caption">从常见客户端抄一份请求头</span>
                                <select
                                  className="ui-input"
                                  aria-label="抄一份常见客户端的请求头"
                                  defaultValue=""
                                  onChange={(event) => {
                                    const preset = HEADER_PRESETS.find((item) => item.name === event.target.value);
                                    event.currentTarget.value = "";
                                    if (preset) {
                                      setProviderForm({
                                        ...providerForm,
                                        headerText: applyHeaderPreset(providerForm.headerText, preset),
                                      });
                                    }
                                  }}
                                >
                                  <option value="">选一个客户端，把它的请求头填进上面（你在上面写过的值不会被盖掉）</option>
                                  {HEADER_PRESETS.map((preset) => (
                                    <option key={preset.name} value={preset.name}>
                                      {preset.name}
                                    </option>
                                  ))}
                                </select>
                                <span className="ui-caption">
                                  有些中转按客户端名字认人，抄对一份才有对应待遇。这几行只是草稿，点「保存请求设置」才真的发出去。
                                </span>
                              </label>
                              {requestHeaders.rejected.length > 0 && (
                                <p className="ui-caption text-danger sm:col-span-2">
                                  这几行看不懂，先不发：{requestHeaders.rejected.join("、")}
                                </p>
                              )}
                              {info?.flags && info.flags.headers.length > 0 && (
                                <div className="flex flex-wrap items-center justify-between gap-2 sm:col-span-2">
                                  <p className="ui-caption">
                                    现在设着：{info.flags.headers.map((item) => item.name).join("、")}
                                  </p>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    onClick={() =>
                                      setProviderForm({
                                        ...providerForm,
                                        headerText: headersToText(info.flags?.headers ?? []),
                                      })
                                    }
                                  >
                                    拉下来改
                                  </Button>
                                </div>
                              )}
                              <div className="flex gap-2">
                                <TextField
                                  label="请求耐心"
                                  placeholder="耐心（如 2m / off）"
                                  value={providerForm.patience}
                                  onChange={(event) => setProviderForm({ ...providerForm, patience: event.target.value })}
                                />
                                <label className="grid gap-1">
                                  <span className="ui-caption">错误处理</span>
                                  <select
                                    className="ui-input"
                                    value={providerForm.errors}
                                    onChange={(event) => setProviderForm({ ...providerForm, errors: event.target.value })}
                                  >
                                    <option value="">错误处理（默认）</option>
                                    <option value="magpie">统一处理</option>
                                    <option value="pass">原样透传</option>
                                  </select>
                                </label>
                              </div>
                              <div className="mt-2">
                                <Button
                                  type="button"
                                  size="sm" variant="primary"
                                  disabled={!cli}
                                  onClick={() => {
                                    const pairs: string[] = [];
                                    if (providerForm.routing) pairs.push(`routing=${providerForm.routing}`);
                                    if (providerForm.modelsUrl.trim()) pairs.push(`models.url=${providerForm.modelsUrl.trim()}`);
                                    if (providerForm.patience.trim()) pairs.push(`patience=${providerForm.patience.trim()}`);
                                    if (providerForm.errors) pairs.push(`errors=${providerForm.errors}`);
                                    pairs.push(...requestHeaders.pairs);
                                    if (!pairs.length) return;
                                    void run("保存请求设置", ["provider", "set", row.id, ...pairs], { refresh: true });
                                  }}
                                >
                                  保存请求设置
                                </Button>
                              </div>
                            </div>
                          </details>

                            <details className="ui-disclosure mt-2">
                            <summary className="cursor-pointer ui-micro"><ChevronIcon width={14} height={14} className="ui-disclosure-chevron" />
                              调流（可选）：并发、排队、休息
                            </summary>
                            <p className="mt-1 ui-caption">
                              一个来源被打爆之前先自己踩刹车：多账号轮着上、限制每分钟请求、排个队，
                              额度用完和连续失败时歇一会儿。留空就是这次不改。
                            </p>
                            <div className="mt-2 grid gap-2 sm:grid-cols-2">
                              {SOURCE_TUNE_FIELDS.map((field) =>
                                field.options ? (
                                  <label key={field.key} className="grid gap-1">
                                    <span className="ui-caption">{field.label}</span>
                                    <select
                                      className="ui-input"
                                      aria-label={field.label}
                                      value={providerForm[field.key]}
                                      onChange={(event) => tuneSetters[field.key](event.target.value)}
                                    >
                                      <option value="">不改</option>
                                      {field.options.map((option) => (
                                        <option key={option.value} value={option.value}>
                                          {option.label}
                                        </option>
                                      ))}
                                    </select>
                                    <span className="ui-caption">{field.hint}</span>
                                  </label>
                                ) : (
                                  <TextField
                                    key={field.key}
                                    label={field.label}
                                    hint={field.hint}
                                    placeholder={field.placeholder}
                                    value={providerForm[field.key]}
                                    onChange={(event) => tuneSetters[field.key](event.target.value)}
                                  />
                                ),
                              )}
                            </div>
                            {tuneRejected.length > 0 && (
                              <p className="mt-2 ui-caption text-danger">
                                这几格看不懂，先不发：{tuneRejected.join("、")}
                              </p>
                            )}
                            <Button
                              type="button"
                              size="sm" variant="ghost" className="mt-2"
                              disabled={!cli || tuneCommands.length === 0}
                              onClick={() => {
                                void (async () => {
                                  for (const command of tuneCommands) {
                                    // 一条一条发：内核每个键各自校验，前一条失败不该挡住后面几条。
                                    await run(`调流 ${row.id}`, command, { refresh: true });
                                  }
                                })();
                              }}
                            >
                              保存调流{tuneCommands.length > 1 ? `（${tuneCommands.length} 项）` : ""}
                            </Button>
                          </details>

                            <details className="ui-disclosure mt-2">
                            <summary className="cursor-pointer ui-micro"><ChevronIcon width={14} height={14} className="ui-disclosure-chevron" />
                              模型清单（可选）：列不列、什么时候刷、新模型怎么收
                            </summary>
                            <p className="mt-1 ui-caption">
                              厂商后加的模型默认不会自己进来。这里定三件事：它的模型要不要出现在智能体的可选清单里、
                              清单多久自己去拉一次、新模型 id 命中哪些规则就自动收。不选就是这次不改。
                            </p>
                            <div className="mt-2 grid gap-2 sm:grid-cols-2">
                              {SOURCE_MODELS_FIELDS.map((field) =>
                                field.options ? (
                                  <label key={field.key} className="grid gap-1">
                                    <span className="ui-caption">{field.label}</span>
                                    <select
                                      className="ui-input"
                                      aria-label={field.label}
                                      value={providerForm[field.key]}
                                      onChange={(event) => modelsSetters[field.key](event.target.value)}
                                    >
                                      <option value="">不改</option>
                                      {field.options.map((option) => (
                                        <option key={option.value} value={option.value}>
                                          {option.label}
                                        </option>
                                      ))}
                                    </select>
                                    <span className="ui-caption">{field.hint}</span>
                                  </label>
                                ) : (
                                  <TextField
                                    key={field.key}
                                    label={field.label}
                                    hint={field.hint}
                                    placeholder={field.placeholder}
                                    value={providerForm[field.key]}
                                    onChange={(event) => modelsSetters[field.key](event.target.value)}
                                  />
                                ),
                              )}
                            </div>
                            <Button
                              type="button"
                              size="sm" variant="ghost" className="mt-2"
                              disabled={!cli || modelsCommands.length === 0}
                              onClick={() => {
                                void (async () => {
                                  for (const command of modelsCommands) {
                                    // 一样一条一条发：前一条被内核拒了，后面的照样发得出去。
                                    await run(`清单规矩 ${row.id}`, command, { refresh: true });
                                  }
                                })();
                              }}
                            >
                              {sourceModelsSummary(modelsCommands)}
                            </Button>
                          </details>

                            <details className="ui-disclosure mt-2">
                            <summary className="cursor-pointer ui-micro"><ChevronIcon width={14} height={14} className="ui-disclosure-chevron" />
                              它是什么（可选）：算不算免费、上下文多大、原文发不发
                            </summary>
                            <p className="mt-1 ui-caption">
                              有些来源的免费额度不走价目表，有些厂商报的窗口比自己实际能给的小，
                              还有些地址值得原样发过去。留空就是这次不改。
                            </p>
                            <div className="mt-2 grid gap-2 sm:grid-cols-2">
                              {SOURCE_PROFILE_FIELDS.map((field) =>
                                field.options ? (
                                  <label key={field.key} className="grid gap-1">
                                    <span className="ui-caption">{field.label}</span>
                                    <select
                                      className="ui-input"
                                      aria-label={field.label}
                                      value={providerForm[field.key]}
                                      onChange={(event) => profileSetters[field.key](event.target.value)}
                                    >
                                      <option value="">不改</option>
                                      {field.options.map((option) => (
                                        <option key={option.value} value={option.value}>
                                          {option.label}
                                        </option>
                                      ))}
                                    </select>
                                    <span className="ui-caption">{field.hint}</span>
                                  </label>
                                ) : (
                                  <TextField
                                    key={field.key}
                                    label={field.label}
                                    hint={field.hint}
                                    placeholder={field.placeholder}
                                    value={providerForm[field.key]}
                                    onChange={(event) => profileSetters[field.key](event.target.value)}
                                  />
                                ),
                              )}
                            </div>
                            {profileRejected.length > 0 && (
                              <p className="mt-2 ui-caption text-danger">
                                这几格看不懂，先不发：{profileRejected.join("、")}
                              </p>
                            )}
                            <Button
                              type="button"
                              size="sm" variant="ghost" className="mt-2"
                              disabled={!cli || profileCommand === null}
                              onClick={() => {
                                if (!profileCommand) return;
                                void run(`来源画像 ${row.id}`, profileCommand, { refresh: true });
                              }}
                            >
                              保存这些设置
                            </Button>
                          </details>

                          <details className="ui-disclosure mt-2">
                            <summary className="cursor-pointer ui-micro"><ChevronIcon width={14} height={14} className="ui-disclosure-chevron" />
                              端的小开关（可选）：搜索、压缩、User-Agent
                            </summary>
                            <p className="mt-1 ui-caption">
                              只在某个端或某个中转上有区别时才动：设过的话，下面写着现在是什么。
                            </p>
                            <div className="mt-2 grid gap-2 sm:grid-cols-3">
                              {SOURCE_WIRE_FIELDS.map((field) => (
                                <label key={field.key} className="grid gap-1">
                                  <span className="ui-caption">{field.label}</span>
                                  <select
                                    className="ui-input"
                                    aria-label={field.label}
                                    value={providerForm[field.key]}
                                    onChange={(event) => wireSetters[field.key](event.target.value)}
                                  >
                                    <option value="">不改</option>
                                    {field.options.map((option) => (
                                      <option key={option.value} value={option.value}>
                                        {option.label}
                                      </option>
                                    ))}
                                  </select>
                                  <span className="ui-caption">{field.hint}</span>
                                </label>
                              ))}
                            </div>
                            {info?.flags && (
                              <p className="mt-2 ui-caption">
                                现在：{info.flags.magpieUserAgent ? "和鸣自己的 UA" : "智能体自己的 UA"}
                                {info.flags.searches ? " · 搜索由来源做" : ""}
                                {info.flags.nativeCompaction ? " · 压缩交给来源" : ""}
                              </p>
                            )}
                            <Button
                              type="button"
                              size="sm" variant="ghost" className="mt-2"
                              disabled={!cli || wireCommand === null}
                              onClick={() => {
                                if (!wireCommand) return;
                                void run(`端开关 ${row.id}`, wireCommand, { refresh: true });
                              }}
                            >
                              保存这几项
                            </Button>
                          </details>
                          </details>

                        </div>
                      )}
                    </li>
                  );
                })}
                {providers.length === 0 && (
                  // d.138：方位词（「从上面选」）在滚动后失效——直接说清下一步动作名。
                  <li className="py-2 ui-caption">
                    {readErrors.providers ? (
                      <span className="flex flex-wrap items-center justify-between gap-2">
                        <span className="min-w-0 text-danger">
                          {readFailureText("providers", readErrors.providers)}
                        </span>
                        <button
                          type="button"
                          className="ui-link shrink-0"
                          disabled={!cli}
                          onClick={() => void loadProviders()}
                        >
                          重新读一次
                        </button>
                      </span>
                    ) : cli ? (
                      "还没有来源。点上面「API Key 服务商」里的一个服务商，或点「加一个其他地址」填服务地址和 Key。"
                    ) : (
                      "还没有来源。添加来源需要桌面版（浏览器里没有文件/密钥桥）。"
                    )}
                  </li>
                )}
              </ul>
            </div>
            <section id="source-models" aria-label="可用模型" className="space-y-4">
              {loading && modelRows.length === 0 ? (
                <div className="space-y-2" role="status" aria-busy="true" aria-label="正在读取模型">
                  {[0, 1].map((index) => (
                    // 骨架与真实内容同形同尺寸：一块 ui-card（rounded-xl）里三行列表，
                    // 不再是三条 h-14/rounded-2xl 的色块（审计 F2「骨架与内容形状不符」）。
                    <SkeletonCard key={index} lines={3} />
                  ))}
                </div>
              ) : profiles.length === 0 ? (
                <>
                  {/* 浏览器端最常见的就是这一屏：整页只有 h1，读屏拿不到「可用模型」这一段的大纲，
                      运行时审计也会判成「只有一级标题」。EmptyState 的标题是 <p>（基元不在这里改），
                      所以补一个只给辅助技术的 h2——视觉上不重复，语义上这段有名字。 */}
                  <h2 className="sr-only">可用模型</h2>
                  <EmptyState
                    icon={<ModelIcon width={20} height={20} />}
                    title="还没有可用的模型"
                    desc="在上面「API Key 服务商」「订阅账号」或「国产智能体」里加一个，它的模型会自动出现在这里。"
                    framed
                  />
                </>
              ) : (
                <ModelCatalogPanel
                  rows={modelRows}
                  disabled={disabledModels}
                  cliReady={cli !== null}
                  onRun={runModelCommand}
                  onReadSpec={async (id) => {
                    if (!cli) return null;
                    const result = await cli.cli(["model", "spec", id]);
                    return result.ok ? parseModelSpec(result.stdout) : null;
                  }}
                  tierSupported={tierSupported}
                />
              )}
              {profiles.length > 0 && (
                <GlobalModelSettings
                  suffix={suffix}
                  compact={compact}
                  contextCap={contextCap}
                  capSupported={capSupported}
                  cliReady={cli !== null}
                  onRun={async (title, args) => {
                    const result = await runDetailed(title, args);
                    if (result.ok) await Promise.all([loadGlobals(), loadSettings()]);
                    return result.ok;
                  }}
                />
              )}
              {profiles.length > 0 && (
                <ImageModelSettings
                  rows={modelRows}
                  drawers={drawerModels}
                  vision={visionModel}
                  visionEffort={visionEffort}
                  imageGen={imageGenModel}
                  cliReady={cli !== null}
                  onRun={async (title, args) => {
                    const result = await runDetailed(title, args);
                    if (result.ok) await Promise.all([loadGlobals(), loadSettings()]);
                    return result.ok;
                  }}
                />
              )}
            </section>

          </section>
        )}

        {/* ── 运行 ───────────────────────────────────────────── */}
        {tab === "run" && (
          <section aria-label="运行" className="space-y-4">
            {/* 运行页已经把轨迹、智能体、路由分组、用量、备份与同步都放在一页上（d.398）：
                内容够长之后，先给一排「跳到哪一块」，省得一路滚。 */}
            <nav aria-label="跳到运行页的某一块" className="flex flex-wrap items-center gap-2">
              {RUN_ANCHORS.map((anchor) => (
                <button
                  key={anchor.id}
                  type="button"
                  className="rounded-full border border-line px-2 py-0.5 text-ui-xs text-muted transition-colors hover:text-ink"
                  onClick={() => jumpTo(anchor.id)}
                >
                  {anchor.label}
                </button>
              ))}
            </nav>

            <div id="run-trace">
              <ModelTraceView />
            </div>

            <section id="run-agents" aria-label="智能体" className="space-y-4">
              <div className="ui-alert ui-alert-warn block p-4">
                <div className="flex items-start gap-2">
                  <AlertIcon width={14} height={14} className="mt-0.5 shrink-0" />
                  <div className="min-w-0">
                    <div className="ui-section-title">改模型会写入本机其他工具的配置</div>
                    <p className="mt-1 ui-caption">
                      这里给本机安装的 Claude Code、Codex 等选模型；模型服务会把网关地址与模型写进它们自己的配置文件。
                      已打开的会话保持原模型，下次启动生效；「恢复默认」会撤掉模型服务写入的内容。
                    </p>
                  </div>
                </div>
              </div>

              <div className="ui-card p-4">
                <div className="flex items-center justify-between">
                  <h2 className="ui-section-title">本机智能体（{agents.length}）</h2>
                  <Button
                    type="button"
                    size="sm" variant="ghost"
                    disabled={!cli}
                    onClick={() => void loadAgents()}
                  >
                    重新检测
                  </Button>
                </div>
                {agentSummaryText && (
                  <p
                    role="status"
                    className={`mt-1 ui-caption ${agentCounts.dirty > 0 ? "text-warn" : ""}`}
                  >
                    {agentSummaryText}
                  </p>
                )}
                {bulkAgents.length > 1 && (
                  <div className="mt-2 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-subtle px-3 py-2.5">
                    <span className="ui-caption">一次给这 {bulkAgents.length} 个工具设同一个模型</span>
                    <select
                      className="ui-input w-52"
                      aria-label="统一设置的模型"
                      value={bulkModel}
                      disabled={!cli || busy !== null}
                      onChange={(event) => setBulkModel(event.target.value)}
                    >
                      <option value="">选择模型…</option>
                      {groupModelRows(modelRows).map((group) => (
                        <optgroup key={group.provider} label={group.provider}>
                          {group.rows.map((row) => (
                            <option
                              key={row.id}
                              value={row.id}
                              disabled={isModelDisabled(row, disabledModels)}
                            >
                              {row.name ? `${row.name}（${row.id}）` : row.id}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                    <Button
                      type="button"
                      size="sm" variant="ghost"
                      disabled={!cli || busy !== null || !isModelId(bulkModel)}
                      onClick={() => confirmBulkModel(bulkModel.trim())}
                    >
                      统一应用
                    </Button>
                  </div>
                )}
                <ul className="mt-2 divide-y divide-line">
                  {agents.map((agent) => (
                    <li key={`${agent.name}-${agent.configPath}`} className="py-3">
                      <div className="flex flex-wrap items-center gap-3">
                        <Avatar name={agent.name} />
                        <span className="min-w-0 flex-1">
                          <span className="flex min-w-0 items-center gap-1.5">
                            <span className="truncate text-ui-md font-semibold">{agent.name}</span>
                            <AgentQuotaChip quota={agent.id ? agentQuotas.get(agent.id) : undefined} />
                          </span>
                          <span className="block truncate ui-caption" title={agent.configPath}>
                            {agent.model}
                            {agent.detail ? ` · ${agent.detail}` : ""}
                            {agentVisibleNames(agent).length > 0
                              ? ` · 下拉只列它看得到的 ${rowsForAgent(modelRows, agentVisibleNames(agent)).length} 个模型`
                              : ""}
                          </span>
                        </span>
                        {agent.id ? (
                          <span className="flex shrink-0 flex-wrap items-center gap-1.5">
                            <select
                              className="ui-input w-52"
                              aria-label={`${agent.name} 模型`}
                              value={agentSelectValue(agent)}
                              onChange={(event) => setAgentModelInput(agent.name, event.target.value)}
                            >
                              <option value="">选择模型…</option>
                              {groupModelRows(rowsForAgent(modelRows, agentVisibleNames(agent))).map(
                                (group) => (
                                  <optgroup key={group.provider} label={group.provider}>
                                    {group.rows.map((row) => (
                                      <option
                                        key={row.id}
                                        value={row.id}
                                        disabled={isModelDisabled(row, disabledModels)}
                                      >
                                        {row.name ? `${row.name}（${row.id}）` : row.id}
                                      </option>
                                    ))}
                                  </optgroup>
                                ),
                              )}
                              <option value={AGENT_CUSTOM}>自定义…</option>
                            </select>
                            {agentModelOf(agent) === AGENT_CUSTOM && (
                              <TextField
                                label={`${agent.name} 自定义模型`}
                                className="w-48"
                                placeholder="provider/model"
                                value={agentCustom[agent.name] ?? ""}
                                onChange={(event) =>
                                  setAgentCustom((current) => ({ ...current, [agent.name]: event.target.value }))
                                }
                              />
                            )}
                            <Button
                              type="button"
                              size="sm" variant="primary"
                              disabled={!cli || !isModelId(agentEffectiveModel(agent)) || !agentDirtyOf(agent)}
                              title={agentDirtyOf(agent) ? "把这次选的模型写进它自己的配置，下次启动生效" : "和它现在用的模型一样，不用再写一次"}
                              onClick={() => {
                                const model = agentEffectiveModel(agent).trim();
                                if (!agent.id || !model) return;
                                setAgentConfirm({ id: agent.id, name: agent.name, model });
                              }}
                            >
                              应用
                            </Button>
                            <Button
                              type="button"
                              size="sm" variant="ghost"
                              disabled={!cli || agentIsDefault(agent)}
                              title={agentIsDefault(agent) ? "它现在没有用模型服务写入的模型，不用恢复" : "撤掉模型服务写进它配置里的模型，回到它自己的默认"}
                              onClick={() => {
                                if (!agent.id) return;
                                setAgentConfirm({ id: agent.id, name: agent.name, model: "default" });
                              }}
                            >
                              恢复默认
                            </Button>
                          </span>
                        ) : (
                          <span className="shrink-0 ui-caption">只读（没有对应的模型命令）</span>
                        )}
                      </div>
                      {agent.id && (
                        <details className="ui-disclosure mt-2">
                          <summary className="cursor-pointer ui-caption">
                            <ChevronIcon width={12} height={12} className="ui-disclosure-chevron" />
                            可见模型 · {visibilitySummary(visibilityOf(visibility, agent.id))}
                            {visibleDirtyOf(agent) && (
                              <span className="text-warn"> · 改过没保存</span>
                            )}
                          </summary>
                          <div className="mt-2 rounded-lg border border-line bg-subtle px-3 py-2">
                            <p className="ui-caption">
                              只勾选要让 {agent.name} 看到的来源；全勾或不勾都等于「全部模型」。
                            </p>
                            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
                              {visibleOptionsOf(agent).map((option) => (
                                <label key={option} className="flex items-center gap-2 ui-caption">
                                  <input
                                    type="checkbox"
                                    className="accent-brand"
                                    aria-label={`${agent.name} 可见 ${option}`}
                                    checked={visibleSelectionOf(agent).includes(option)}
                                    disabled={!cli}
                                    onChange={(event) =>
                                      setVisibleDraft((current) => {
                                        const agentId = agent.id ?? "";
                                        const base = current[agentId] ?? visibleSelectionOf(agent);
                                        const next = event.target.checked
                                          ? [...new Set([...base, option])]
                                          : base.filter((item) => item !== option);
                                        return { ...current, [agentId]: next };
                                      })
                                    }
                                  />
                                  {option}
                                </label>
                              ))}
                            </div>
                            <div className="mt-2 flex flex-wrap items-center gap-2">
                              <label className="flex items-center gap-2 ui-caption">
                                <input
                                  type="checkbox"
                                  className="accent-brand"
                                  aria-label={`${agent.name} 只显示挑过的模型`}
                                  checked={visibilityOf(visibility, agent.id)?.pickedOnly ?? false}
                                  disabled={!cli || busy !== null}
                                  onChange={(event) =>
                                    void runVisibleCommand(
                                      agent,
                                      pickedOnlyArgs(agent.id ?? "", event.target.checked),
                                    )
                                  }
                                />
                                只显示逐个挑过的模型（以后新出现的模型不自动露出来）
                              </label>
                            </div>
                            <div className="mt-2 flex flex-wrap items-center gap-2">
                              <Button
                                type="button"
                                size="sm" variant="primary"
                                disabled={!cli || busy !== null || !visibleDirtyOf(agent)}
                                title={
                                  visibleDirtyOf(agent)
                                    ? "把这次勾选写进这个工具自己的配置"
                                    : "还没有改动"
                                }
                                onClick={() => void saveVisible(agent)}
                              >
                                保存可见范围
                              </Button>
                              <Button
                                type="button"
                                size="sm" variant="ghost"
                                disabled={!cli || busy !== null}
                                onClick={() =>
                                  void runVisibleCommand(agent, ["visible", agent.id ?? "", "all"])
                                }
                              >
                                恢复全部
                              </Button>
                              {visibleDirtyOf(agent) && siblingTargets(agent, agents).length > 0 && (
                                <Button
                                  type="button"
                                  size="sm" variant="ghost"
                                  disabled={!cli || busy !== null}
                                  title="把这行勾选同样写进其它已经接好的工具，只是也写一遍"
                                  onClick={() => confirmShareVisible(agent)}
                                >
                                  同样写给其它 {siblingTargets(agent, agents).length} 个
                                </Button>
                              )}
                              {visibleDirtyOf(agent) && (
                                <span className="ui-caption text-warn">改过了，点「保存可见范围」才生效</span>
                              )}
                            </div>
                          </div>
                        </details>
                      )}
                    </li>
                  ))}
                  {agents.length === 0 && (
                    <li className="py-2 ui-caption">
                      {readErrors.agents ? (
                        <span className="flex flex-wrap items-center justify-between gap-2">
                          <span className="min-w-0 text-danger">
                            {readFailureText("agents", readErrors.agents)}
                          </span>
                          <button
                            type="button"
                            className="ui-link shrink-0"
                            disabled={!cli}
                            onClick={() => void loadAgents()}
                          >
                            重新检测
                          </button>
                        </span>
                      ) : (
                        "没有检测到本机智能体。装一个 Claude Code / Codex 之类的工具后点「重新检测」。"
                      )}
                    </li>
                  )}
                </ul>

                {agentConfirm && (
                  <div role="alert" className="ui-alert ui-alert-warn rta-enter mt-3 block">
                    <div className="flex items-start gap-2">
                      <AlertIcon width={14} height={14} className="mt-0.5 shrink-0" />
                      <div className="min-w-0">
                        <div className="text-ui-sm font-semibold">
                          {agentConfirm.model === "default"
                            ? `恢复 ${agentConfirm.name} 原来的模型？`
                            : `把 ${agentConfirm.name} 的模型改成 ${agentConfirm.model}？`}
                        </div>
                        <p className="mt-1 ui-caption">
                          会写入该工具自己的配置文件（下一次启动生效）。确认前请先关掉正在运行的会话。
                        </p>
                        <div className="mt-2 flex gap-2">
                          <Button
                            type="button"
                            size="sm" variant="primary"
                            onClick={() => {
                              const target = agentConfirm;
                              setAgentConfirm(null);
                              void run(
                                target.model === "default" ? "恢复默认" : "设置模型",
                                [target.id, target.model],
                              ).then(() => void loadAgents());
                            }}
                          >
                            确认写入
                          </Button>
                          <Button
                            type="button"
                            size="sm" variant="ghost"
                            onClick={() => setAgentConfirm(null)}
                          >
                            取消
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </section>

            <div className="grid items-start gap-3 lg:grid-cols-2">
            <details id="run-groups" className="ui-disclosure ui-card p-4 lg:col-span-2">
              <summary className="cursor-pointer text-ui-md font-semibold"><ChevronIcon width={14} height={14} className="ui-disclosure-chevron" />路由分组（可选）</summary>
              <div className="mt-2 grid gap-2 sm:grid-cols-3">
                <TextField
                  label="分组名称"
                  placeholder="分组名"
                  value={groupForm.name}
                  onChange={(event) => setGroupForm({ ...groupForm, name: event.target.value })}
                />
                <TextField
                  label="分组模型列表"
                  placeholder="provider/model,provider/model2"
                  value={groupForm.models}
                  onChange={(event) => setGroupForm({ ...groupForm, models: event.target.value })}
                />
                <label className="grid gap-1">
                  <span className="ui-caption">分组选路策略</span>
                  <select
                    className="ui-input"
                    value={groupForm.routing}
                    onChange={(event) => setGroupForm({ ...groupForm, routing: event.target.value })}
                  >
                    {GROUP_ROUTING.map((routing) => (
                      <option key={routing} value={routing}>
                        {ROUTING_LABEL[routing] ?? routing}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="sm" variant="primary"
                  disabled={!cli || !groupForm.name.trim() || !groupForm.models.trim()}
                  onClick={() =>
                    void run("保存分组", [
                      "group",
                      "add",
                      groupForm.name.trim(),
                      `models=${groupForm.models.trim()}`,
                      `routing=${groupForm.routing}`,
                    ])
                  }
                >
                  保存分组
                </Button>
                <Button
                  type="button"
                  size="sm" variant="ghost"
                  disabled={!cli}
                  onClick={() => void run("分组清单", ["groups"])}
                >
                  看分组清单
                </Button>
                <TextField
                  label="分组 ID"
                  placeholder="分组名（查看/删除用）"
                  value={groupForm.target}
                  onChange={(event) => setGroupForm({ ...groupForm, target: event.target.value })}
                />
                <Button
                  type="button"
                  size="sm" variant="ghost"
                  disabled={!cli || !groupForm.target.trim()}
                  onClick={() => void run("分组详情", ["group", groupForm.target.trim()])}
                >
                  详情
                </Button>
                <Button
                  type="button"
                  size="sm" variant="danger"
                  disabled={!cli || !groupForm.target.trim()}
                  onClick={() =>
                    setConfirmAction({
                      title: "删除分组？",
                      desc: `分组「${groupForm.target.trim()}」删除后不可恢复。`,
                      confirmLabel: "删除",
                      action: () => void run("删除分组", ["group", "rm", groupForm.target.trim()]),
                    })
                  }
                >
                  删除
                </Button>
              </div>
              <p className="ui-caption mt-1">
                「看分组清单」会把你自己建的组和 magpie 自己找到的组一起列出来（结果在页面底部）。
              </p>

              <div className="mt-3 border-t border-line pt-3">
                <div className="text-ui-sm font-semibold">按模板建组（可选）：不必自己想填哪些模型</div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {GROUP_TEMPLATES.map((template) => (
                    <Button
                      key={template.kind}
                      type="button"
                      size="sm" variant="ghost"
                      disabled={!cli}
                      onClick={() =>
                        void run(
                          `按模板建组 ${template.label}`,
                          groupTemplateArgs(template.kind, groupForm.name),
                        )
                      }
                    >
                      {template.label}
                    </Button>
                  ))}
                </div>
                <p className="ui-caption mt-1">
                  {GROUP_TEMPLATES.map((template) => `${template.label}：${template.desc}`).join("；")}。
                  建出来的组 id 是 {GROUP_TEMPLATES.map((template) => template.id).join(" / ")}
                  ，名字被占用时内核会自己编号，不会替换现有分组；用的都是你已经接上的模型。
                </p>
              </div>

              <div className="mt-3 border-t border-line pt-3">
                <div className="text-ui-sm font-semibold">
                  组的设置（可选）：改的是上面「分组 ID」填的那个组
                </div>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {GROUP_SETTING_FIELDS.map((field) =>
                    field.options ? (
                      <label key={field.key} className="grid gap-1">
                        <span className="ui-caption">{field.label}</span>
                        <select
                          className="ui-input"
                          aria-label={field.label}
                          value={groupSettings[field.key] ?? ""}
                          onChange={(event) =>
                            setGroupSettings({ ...groupSettings, [field.key]: event.target.value })
                          }
                        >
                          <option value="">不改（{field.hint}）</option>
                          {field.options.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : (
                      <TextField
                        key={field.key}
                        label={field.label}
                        hint={field.hint}
                        placeholder={field.placeholder}
                        value={groupSettings[field.key] ?? ""}
                        onChange={(event) =>
                          setGroupSettings({ ...groupSettings, [field.key]: event.target.value })
                        }
                      />
                    ),
                  )}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    size="sm" variant="primary"
                    disabled={!cli || groupSetArgs(groupForm.target, groupSettings) === null}
                    onClick={() => {
                      const args = groupSetArgs(groupForm.target, groupSettings);
                      if (args) void run("改分组设置", args);
                    }}
                  >
                    应用设置
                  </Button>
                  <Button
                    type="button"
                    size="sm" variant="ghost"
                    disabled={Object.keys(groupSettings).length === 0}
                    onClick={() => setGroupSettings({})}
                  >
                    清空选择
                  </Button>
                  <span className="ui-caption">
                    只发你改过的那几项，留「不改」的不会发给内核——空值等于把设置清回默认，那是另一件事。
                  </span>
                </div>
              </div>

              <div className="mt-3 border-t border-line pt-3">
                <div className="text-ui-sm font-semibold">规则（可选）：把某类请求先交给组里的指定模型</div>
                <div className="mt-2 grid gap-2 sm:grid-cols-3">
                  <TextField
                    label="规则分组"
                    placeholder="分组名"
                    value={ruleForm.group}
                    onChange={(event) => setRuleForm({ ...ruleForm, group: event.target.value })}
                  />
                  <TextField
                    label="规则模型"
                    placeholder="先交给：provider/model"
                    value={ruleForm.use}
                    onChange={(event) => setRuleForm({ ...ruleForm, use: event.target.value })}
                  />
                  <TextField
                    label="规则 token 阈值"
                    placeholder="够长才用：如 150k（可留空）"
                    value={ruleForm.tokens}
                    onChange={(event) => setRuleForm({ ...ruleForm, tokens: event.target.value })}
                  />
                  <TextField
                    label="规则文件夹"
                    placeholder="项目文件夹（逗号分隔，可留空）"
                    value={ruleForm.folders}
                    onChange={(event) => setRuleForm({ ...ruleForm, folders: event.target.value })}
                  />
                  <TextField
                    label="规则时段"
                    placeholder="时段（如 14:00-18:00，可留空）"
                    value={ruleForm.time}
                    onChange={(event) => setRuleForm({ ...ruleForm, time: event.target.value })}
                  />
                  <TextField
                    label="规则意图"
                    placeholder="意图（如 一个简单问题，可留空）"
                    value={ruleForm.intent}
                    onChange={(event) => setRuleForm({ ...ruleForm, intent: event.target.value })}
                  />
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm" variant="primary"
                    disabled={!cli || !ruleForm.group.trim() || !ruleForm.use.trim()}
                    onClick={() => {
                      const args = ["group", "rule", "add", ruleForm.group.trim(), `use=${ruleForm.use.trim()}`];
                      if (ruleForm.tokens.trim()) args.push(`tokens=${ruleForm.tokens.trim()}`);
                      if (ruleForm.folders.trim()) args.push(`folders=${ruleForm.folders.trim()}`);
                      if (ruleForm.time.trim()) args.push(`time=${ruleForm.time.trim()}`);
                      if (ruleForm.intent.trim()) args.push(`intent=${ruleForm.intent.trim()}`);
                      void run("保存规则", args);
                    }}
                  >
                    保存规则
                  </Button>
                  <Button
                    type="button"
                    size="sm" variant="ghost"
                    disabled={!cli || !ruleForm.group.trim()}
                    onClick={() => void run("查看规则", ["group", "rule", ruleForm.group.trim()])}
                  >
                    查看规则
                  </Button>
                </div>
              </div>
            </details>

            {/* 用量不再包一层卡片：它自身就是「标题行 + 指标卡 + 图表卡」的区块，
                再套一张 .ui-card 会形成卡中卡（d.124 视觉审计） */}
            <div id="run-usage">
              <ModelUsageView
                onExportCsv={(period) => void run("导出用量", ["usage", "--csv", period])}
              />
            </div>

            <div id="run-backup" className="space-y-4">
              <BackupPanel />

              <CloudSyncCard />
            </div>

            <details id="run-more" className="ui-disclosure ui-card p-4">
              <summary className="cursor-pointer text-ui-md font-semibold"><ChevronIcon width={14} height={14} className="ui-disclosure-chevron" />更多设置（可选）：资源库与搜索、网关密钥、会话与启动器、高级命令</summary>
              <p className="mt-1 ui-caption">这四块都不常用：要用哪块就展开哪块，每块里的按钮自己发命令，这里什么都不保存。</p>
              <details className="ui-disclosure mt-2">
                <summary className="cursor-pointer text-ui-md font-semibold"><ChevronIcon width={14} height={14} className="ui-disclosure-chevron" />资源库与网页搜索</summary>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button type="button" size="sm" variant="ghost" disabled={!cli} onClick={() => void run("库状态", ["library"])}>
                    查看库
                  </Button>
                  <Button type="button" size="sm" variant="ghost" disabled={!cli} onClick={() => void run("同步库", ["library", "sync"])}>
                    同步到智能体
                  </Button>
                  <Button type="button" size="sm" variant="ghost" disabled={!cli} onClick={() => void run("库指令", ["library", "instructions"])}>
                    查看共享指令
                  </Button>
                </div>
                <div className="mt-3 grid gap-2 sm:grid-cols-3">
                  <TextField
                    label="搜索 API"
                    placeholder="搜索 API（如 tavily）"
                    value={searchForm.api}
                    onChange={(event) => setSearchForm({ ...searchForm, api: event.target.value })}
                  />
                  <TextField
                    label="搜索 Key"
                    type="password"
                    placeholder="Key"
                    value={searchForm.key}
                    onChange={(event) => setSearchForm({ ...searchForm, key: event.target.value })}
                  />
                  <TextField
                    label="删除搜索 API"
                    placeholder="要删除的 API 名称"
                    value={searchForm.target}
                    onChange={(event) => setSearchForm({ ...searchForm, target: event.target.value })}
                  />
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {/* 以前是一个「执行」按钮按填了哪个字段猜动作：既藏了三种语义，也让删除和
                      添加共用同一颗主按钮。拆成三个显式动作，删除单独走确认。 */}
                  <Button
                    type="button"
                    size="sm" variant="primary"
                    disabled={!cli || !searchForm.api.trim()}
                    onClick={() =>
                      void run("添加搜索来源", ["search", "add", searchForm.api.trim(), searchForm.key.trim()])
                    }
                  >
                    添加来源
                  </Button>
                  <Button
                    type="button"
                    size="sm" variant="ghost"
                    disabled={!cli}
                    onClick={() => void run("搜索来源", ["search"])}
                  >
                    查看已有
                  </Button>
                  <Button
                    type="button"
                    size="sm" variant="ghost"
                    disabled={!cli || !searchForm.target.trim()}
                    onClick={() => {
                      const target = searchForm.target.trim();
                      setConfirmAction({
                        title: "删除搜索来源？",
                        desc: `搜索来源「${target}」删除后不可恢复（地址与 Key 一并移除）。`,
                        confirmLabel: "删除",
                        action: () => void run("删除搜索来源", ["search", "rm", target]),
                      });
                    }}
                  >
                    删除来源
                  </Button>
                </div>
              </details>

              <details className="ui-disclosure mt-2">
                <summary className="cursor-pointer text-ui-md font-semibold"><ChevronIcon width={14} height={14} className="ui-disclosure-chevron" />网关密钥</summary>
                <p className="mt-1 ui-caption">
                  给其他设备、CI 或局域网内的工具发一条调用密钥；只读密钥只能查用量与配额。
                </p>
                <div className="mt-2 grid gap-2 sm:grid-cols-3">
                  <TextField
                    label="新密钥名称"
                    placeholder="名称（如 我的笔记本）"
                    value={gatewayKeyForm.name}
                    onChange={(event) => setGatewayKeyForm({ ...gatewayKeyForm, name: event.target.value })}
                  />
                  <label className="ui-caption flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={gatewayKeyForm.readOnly}
                      onChange={(event) => setGatewayKeyForm({ ...gatewayKeyForm, readOnly: event.target.checked })}
                    />
                    只读
                  </label>
                  <Button
                    type="button"
                    size="sm" variant="primary"
                    disabled={!cli || !gatewayKeyForm.name.trim()}
                    onClick={() => {
                      const args = ["gateway-key", "add", gatewayKeyForm.name.trim()];
                      if (gatewayKeyForm.readOnly) args.push("--read-only");
                      void run("新建网关密钥", args);
                    }}
                  >
                    新建密钥
                  </Button>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    size="sm" variant="ghost"
                    disabled={!cli}
                    onClick={() => void run("网关密钥", ["gateway-key", "list"])}
                  >
                    列出密钥
                  </Button>
                  <TextField
                    label="密钥 ID"
                    placeholder="密钥 ID（轮换/删除用）"
                    value={gatewayKeyForm.target}
                    onChange={(event) => setGatewayKeyForm({ ...gatewayKeyForm, target: event.target.value })}
                  />
                  <Button
                    type="button"
                    size="sm" variant="ghost"
                    disabled={!cli || !gatewayKeyForm.target.trim()}
                    onClick={() => void run("轮换密钥", ["gateway-key", "rotate", gatewayKeyForm.target.trim()])}
                  >
                    轮换
                  </Button>
                  <Button
                    type="button"
                    size="sm" variant="danger"
                    disabled={!cli || !gatewayKeyForm.target.trim()}
                    onClick={() =>
                      setConfirmAction({
                        title: "删除密钥？",
                        desc: `密钥「${gatewayKeyForm.target.trim()}」删除后不可恢复。`,
                        confirmLabel: "删除",
                        action: () =>
                          void run("删除密钥", ["gateway-key", "remove", gatewayKeyForm.target.trim()]),
                      })
                    }
                  >
                    删除
                  </Button>
                </div>
              </details>

              <details className="ui-disclosure mt-2">
                <summary className="cursor-pointer text-ui-md font-semibold"><ChevronIcon width={14} height={14} className="ui-disclosure-chevron" />会话与启动器</summary>
                <p className="mt-1 ui-caption">
                  看各智能体最近的会话记录；启动器命令由模型服务提供（在终端里直接运行它给出的那条），
                  只影响那一次会话，不改配置。
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm" variant="ghost"
                    disabled={!cli}
                    onClick={() => void run("最近会话", ["sessions", "--limit", "10"])}
                  >
                    查看最近会话
                  </Button>
                  <Button
                    type="button"
                    size="sm" variant="ghost"
                    disabled={!cli}
                    onClick={() => void run("会话（7 天）", ["sessions", "--days", "7", "--limit", "20"])}
                  >
                    近 7 天
                  </Button>
                </div>
              </details>

              <details className="ui-disclosure mt-2">
                <summary className="cursor-pointer text-ui-md font-semibold"><ChevronIcon width={14} height={14} className="ui-disclosure-chevron" />高级命令</summary>
                <div className="mt-2 flex flex-wrap items-start gap-2">
                  <TextField
                    label="命令"
                    className="flex-1"
                    placeholder="providers"
                    value={termCommand}
                    onChange={(event) => setTermCommand(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void startTerminalRun();
                    }}
                  />
                  <Button
                    type="button"
                    size="sm" variant="primary" className="mt-5"
                    disabled={!cli || !termCommand.trim()}
                    onClick={() => void startTerminalRun()}
                  >
                    运行
                  </Button>
                  <Button
                    type="button"
                    size="sm" variant="ghost"
                    disabled={!runId}
                    onClick={() => {
                      if (runId) void cli?.cliKill(runId);
                      setRunId(null);
                    }}
                  >
                    取消
                  </Button>
                </div>
                <pre aria-label="命令输出" className="mt-2 h-56 overflow-auto rounded-xl bg-console-bg p-3 text-ui-sm text-console-ink">
                  {live || "（输出会出现在这里）"}
                </pre>
                <TextField
                  label="命令输入"
                  className="mt-2"
                  placeholder="回车把这一行发给正在运行的命令"
                  value={terminalInput}
                  onChange={(event) => setTerminalInput(event.target.value)}
                  onKeyDown={async (event) => {
                    if (event.key !== "Enter" || !runId || !cli) return;
                    const text = `${terminalInput}\n`;
                    setTerminalInput("");
                    await cli.cliInput(runId, text);
                  }}
                />
              </details>

              <details className="ui-disclosure mt-2">
                <summary className="cursor-pointer text-ui-md font-semibold"><ChevronIcon width={14} height={14} className="ui-disclosure-chevron" />网络代理（可选）</summary>
                <p className="mt-1 ui-caption">
                  和鸣自己去问模型服务时走哪条线。空着是跟着系统的环境变量走，直连是不走代理，
                  也可以指定一个地址（http:// / socks5://，只写 host:port 时当 http 用）。
                  只影响和鸣自己发出的请求，不动别的程序。
                </p>
                <div className="mt-2 flex flex-wrap items-end gap-2">
                  <label className="grid gap-1">
                    <span className="ui-caption">怎么走</span>
                    <select
                      className="ui-input mt-2"
                      aria-label="代理怎么走"
                      value={proxyMode}
                      disabled={!cli}
                      onChange={(event) => setProxyMode(event.target.value as ProxyMode)}
                    >
                      <option value="system">跟随系统环境变量</option>
                      <option value="direct">直连，不走代理</option>
                      <option value="custom">自己指定地址</option>
                    </select>
                  </label>
                  {proxyMode === "custom" && (
                    <TextField
                      label="代理地址"
                      hint="如 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080"
                      className="min-w-64"
                      value={proxyAddress}
                      disabled={!cli}
                      onChange={(event) => setProxyAddress(event.target.value)}
                    />
                  )}
                  <Button
                    type="button"
                    size="sm" variant="ghost"
                    disabled={!cli || proxyArgs(proxyMode, proxyAddress) === null}
                    onClick={() => {
                      const args = proxyArgs(proxyMode, proxyAddress);
                      if (args) void run("设置网络代理", args, { refresh: true });
                    }}
                  >
                    保存代理设置
                  </Button>
                </div>
                <p className="mt-1 ui-caption">
                  现在：{describeProxy(proxyMode, proxyAddress)}
                  {proxyMode === "custom" && proxyProblem(proxyAddress) !== "" && (
                    <span className="text-danger">（{proxyProblem(proxyAddress)}）</span>
                  )}
                  。
                </p>
              </details>
              <SearchProviderSettings
                rows={modelRows}
                route={searchRoute}
                cliReady={cli !== null}
                onRun={async (title, args) => {
                  const result = await runDetailed(title, args);
                  if (result.ok) await Promise.all([loadGlobals(), loadSettings()]);
                  return result.ok;
                }}
              />
            </details>
            </div>
          </section>
        )}
      </div>

      {confirmAction && (
        <ConfirmDialog
          title={confirmAction.title}
          onCancel={() => setConfirmAction(null)}
          footer={
            <>
              <Button
                type="button"
                size="md" variant="ghost" className="text-muted"
                onClick={() => setConfirmAction(null)}
              >
                取消
              </Button>
              <Button
                type="button"
                size="md" variant={confirmAction.tone === "primary" ? "primary" : "danger"}
                onClick={() => {
                  const pending = confirmAction;
                  setConfirmAction(null);
                  pending.action();
                }}
              >
                {confirmAction.confirmLabel}
              </Button>
            </>
          }
        >
          <p className="ui-body-sm text-muted">{confirmAction.desc}</p>
        </ConfirmDialog>
      )}

      {output && (
        <div
          role={output.ok ? "status" : "alert"}
          className={`rta-enter mt-4 block ${output.ok ? "ui-alert ui-alert-info" : "ui-alert ui-alert-danger"}`}
        >
          <div className="flex w-full items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-ui-sm font-semibold">
              {output.ok ? (
                <CheckIcon width={14} height={14} className="shrink-0" />
              ) : (
                <AlertIcon width={14} height={14} className="shrink-0" />
              )}
              {output.title}
            </div>
            <Button type="button" size="sm" variant="ghost" onClick={() => setOutput(null)}>
              关闭
            </Button>
          </div>
          <pre className="mt-1 max-h-64 w-full overflow-auto whitespace-pre-wrap text-ui-sm">{output.text}</pre>
        </div>
      )}
    </PageShell>
  );
}

/* 统计卡已抽到 ui/Stat.tsx（d.138）：此前这里的数字是 26px/p-4，首页同名卡片是
   20px/p-3，同一套「数字卡」两个页面不一样大。 */
