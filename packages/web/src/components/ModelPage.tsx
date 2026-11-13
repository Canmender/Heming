import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PageShell } from "./layout/PageShell.js";
import { PAGE_TABLIST, pageTabClass } from "../lib/ui/tabStyles.js";
import {
  AlertIcon,
  AssistantIcon,
  CheckIcon,
  ChevronIcon,
  ModelIcon,
  PlugIcon,
  RefreshIcon,
  WorkflowIcon,
} from "./icons.js";
import { ModelTraceView } from "./ModelTraceView.js";
import { Button } from "./ui/Button.js";
import { Stat } from "./ui/Stat.js";
import { TextField } from "./ui/Field.js";
import { ModelUsageView } from "./ModelUsageView.js";
import { BackupPanel } from "./model/BackupPanel.js";
import { useLlmStore } from "../store/llm.js";
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
import { isModelId, parseAgents, type LocalAgent } from "../lib/magpieAgents.js";
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
 * 模型页（d.104）：三个分区，加来源 → 选模型 → 看它怎么跑。
 *
 * 设计参考（magpie 的路由/供应商页，以及与用户四轮反馈）：
 * - 只保留三个大分区：模型 / 来源 / 运行；其余能力都折进「运行」；
 * - 加来源用卡片：订阅点一下去登录，厂商点一下只填一个 Key；
 * - 模型与账号用行卡片（头像 + 名称 + 说明 + 状态），比表格更像「在选东西」；
 * - 不出现服务状态、地址、端口与启停按钮；也不出现第三方产品名；
 * - 动效克制：卡片 200ms 抬起、分区切换 300ms 淡入，尊重「减少动态效果」。
 */

type TabKey = "models" | "agents" | "sources" | "run";

/**
 * 四个分区：图标与全站同一套描边（icons.tsx），尺寸统一 14px；不再用文字代替图标。
 * 「来源」在浏览器端没有 CLI 时会被过滤掉，所以图标也只在可进入时渲染。
 */
const TABS: { key: TabKey; label: string; icon: ReactNode }[] = [
  { key: "models", label: "模型", icon: <ModelIcon width={14} height={14} /> },
  { key: "agents", label: "智能体", icon: <AssistantIcon width={14} height={14} /> },
  { key: "sources", label: "来源", icon: <PlugIcon width={14} height={14} /> },
  { key: "run", label: "运行", icon: <WorkflowIcon width={14} height={14} /> },
];

const SUBSCRIPTIONS = [
  { agent: "claude", label: "Claude", desc: "Pro / Max / Team" },
  { agent: "codex", label: "ChatGPT", desc: "Plus / Pro / Business" },
  { agent: "copilot", label: "Copilot", desc: "GitHub 账号" },
  { agent: "gemini", label: "Gemini", desc: "Code Assist" },
  { agent: "antigravity", label: "Antigravity", desc: "Google 账号" },
];

/** 来源行的计划徽标：普通地址保持灰，Coding Plan 用蓝（不用红：它不是错误）。 */
const PLAN_BADGE: Record<PlanKind, { label: string; className: string }> = {
  normal: { label: "普通地址", className: "bg-[var(--subtle-3)] text-muted" },
  coding: { label: "Coding Plan", className: "bg-[var(--info-soft)] text-[var(--info)]" },
};

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

/** 同步通道：webdav / s3 / github。 */
const SYNC_KIND_LABEL: Record<string, string> = {
  webdav: "WebDAV 网盘",
  s3: "S3 / 对象存储",
  github: "GitHub 仓库",
};

/** 同步动作：now / on / off / set。 */
const SYNC_COMMAND_LABEL: Record<string, string> = {
  now: "立即同步一次",
  on: "开启自动同步",
  off: "关闭自动同步",
  set: "写入配置项",
};

/** 请求协议：auto / chat / responses / anthropic / gemini。 */
const API_LABEL: Record<string, string> = {
  auto: "自动识别",
  chat: "Chat Completions",
  responses: "Responses",
  anthropic: "Anthropic Messages",
  gemini: "Gemini",
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

/**
 * 头像色板走 CSS 变量（d.124）：暗色下有一整套更亮的同色相版本，
 * 写死十六进制会让暗色头像发闷、与主题不搭。
 */
const AVATAR_COLORS = [
  "var(--avatar-1)",
  "var(--avatar-2)",
  "var(--avatar-3)",
  "var(--avatar-4)",
  "var(--avatar-5)",
  "var(--avatar-6)",
];

function avatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length]!;
}

function Avatar({ name }: { name: string }) {
  return (
    <span
      aria-hidden="true"
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-ui-sm font-bold text-white"
      style={{ backgroundColor: avatarColor(name) }}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function ModelPage() {
  const profiles = useLlmStore((s) => s.profiles);
  const refreshCatalog = useLlmStore((s) => s.refreshCatalog);

  const cli = useMemo<MagpieCliBridge | null>(() => getMagpieCliBridge(), []);
  const [tab, setTab] = useState<TabKey>("models");
  const [busy, setBusy] = useState<string | null>(null);
  const [output, setOutput] = useState<{ title: string; text: string; ok: boolean } | null>(null);
  /** 来源区的就地反馈：加完一个来源给一句话，用户还要继续加，所以不跳页。 */
  const [notice, setNotice] = useState<string | null>(null);
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  /** 本机智能体：ls 输出解析；改写会写入它们的配置文件，所以有二次确认。 */
  const [agents, setAgents] = useState<LocalAgent[]>([]);
  const [agentConfirm, setAgentConfirm] = useState<{ id: string; name: string; model: string } | null>(
    null,
  );
  /** 每行待应用的模型输入（按智能体展示名索引，不持久化）。 */
  /** 待确认的破坏性 CLI 操作（d.140 R4）：删分组/删密钥都是一下就没的操作，
   *  此前 onClick 直接执行、零确认。这里改成原地两步确认（与 agentConfirm 同一套就地提示习惯）。 */
  const [dangerConfirm, setDangerConfirm] = useState<{ label: string; args: string[] } | null>(null);
  const [agentModels, setAgentModels] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [modelQuery, setModelQuery] = useState("");
  /** 选中的厂商与地址类型（plan 是 planOptions 里的 id，普通地址默认）。 */
  const [presetKey, setPresetKey] = useState<{ id: string; plan: string; key: string } | null>(null);
  const [custom, setCustom] = useState({ open: false, id: "", url: "", key: "", models: "" });
  /** 自定义来源的保存前校验错误（就地显示，不弹窗、不清空已填内容）。 */
  const [customError, setCustomError] = useState<string | null>(null);
  /** 展开高级时按需读 `provider show` 的结果：chat 地址 + 普通/套餐。 */
  const [showCache, setShowCache] = useState<Record<string, { chat: string; plan: PlanKind }>>({});
  const [showLoading, setShowLoading] = useState<string | null>(null);
  const [live, setLive] = useState("");
  const liveRef = useRef("");
  const [runId, setRunId] = useState<string | null>(null);
  const [terminalInput, setTerminalInput] = useState("");
  const [groupForm, setGroupForm] = useState({ name: "", models: "", routing: "smart", target: "" });
  /** 来源高级设置（只在展开某个来源时显示）。 */
  const [advancedProvider, setAdvancedProvider] = useState<string | null>(null);
  const [providerForm, setProviderForm] = useState({
    key: "",
    routing: "",
    fallback: "",
    models: "",
    modelsUrl: "",
    headerName: "",
    headerValue: "",
    patience: "",
    errors: "",
  });
  /** 路由分组规则（可选）：把某一类请求先交给组里指定模型。 */
  const [ruleForm, setRuleForm] = useState({
    group: "",
    use: "",
    tokens: "",
    folders: "",
    time: "",
    intent: "",
  });
  /** 模型属性（显示名/思考档/协议）。 */
  const [modelForm, setModelForm] = useState({ model: "", name: "", efforts: "", api: "auto" });
  const [syncKind, setSyncKind] = useState("webdav");
  const [syncCommand, setSyncCommand] = useState("now");
  const [syncValues, setSyncValues] = useState("");
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
      setLive(tailText(stripAnsi(liveRef.current)));
    });
  }, [cli]);

  const loadProviders = useCallback(async () => {
    if (!cli) return;
    const result = await cli.cli(["providers"]);
    setProviders(parseProviders(result.stdout || ""));
  }, [cli]);

  const loadAccounts = useCallback(async () => {
    if (!cli) return;
    const result = await cli.cli(["accounts", "--json"]);
    setAccounts(parseAccounts(result.stdout || ""));
  }, [cli]);

  const loadAgents = useCallback(async () => {
    if (!cli) return;
    const result = await cli.cli(["ls"]);
    setAgents(parseAgents(result.stdout || ""));
  }, [cli]);

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
    [cli, refreshCatalog, loadProviders, loadAccounts],
  );

  const run = useCallback(
    async (title: string, args: string[], opts: { refresh?: boolean } = {}) =>
      (await runDetailed(title, args, opts)).ok,
    [runDetailed],
  );

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
  };

  useEffect(() => {
    if (!cli) return;
    let alive = true;
    void (async () => {
      await Promise.all([loadProviders(), loadAccounts(), loadAgents()]);
      if (alive) setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [cli, loadProviders, loadAccounts]);

  const visibleModels = profiles.filter((profile) => {
    const query = modelQuery.trim().toLowerCase();
    return !query || profile.model.toLowerCase().includes(query);
  });

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

  /** 展开某个来源的高级设置：顺带读一次详细地址，判断它是普通还是套餐地址。 */
  const toggleAdvanced = async (id: string) => {
    if (advancedProvider === id) {
      setAdvancedProvider(null);
      return;
    }
    setAdvancedProvider(id);
    if (showCache[id] || !cli) return;
    setShowLoading(id);
    try {
      const text = await readProviderShow(cli, id);
      const plan = detectPlanFromShow(text) ?? "normal";
      const chat = parseShowUrls(text).chat;
      setShowCache((current) => ({ ...current, [id]: { chat, plan } }));
    } finally {
      setShowLoading(null);
    }
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

  const providerOf = (model: string) => (model.includes("/") ? model.split("/")[0]! : "自定义");

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
      subtitle="所有模型在一个地方：加一个来源，智能体就能选它的模型。"
      width="full"
      actions={
        <Button
          type="button"
          size="md" variant="ghost"
          onClick={async () => {
            setBusy("refresh");
            try {
              await refreshCatalog();
              await loadProviders();
              await loadAccounts();
            } finally {
              setBusy(null);
            }
          }}
          disabled={busy === "refresh"}
        >
          <RefreshIcon width={14} height={14} />
          {busy === "refresh" ? "刷新中…" : "刷新模型"}
        </Button>
      }
      headerExtra={
        // 一级页签统一走 PAGE_TABLIST / pageTabClass（下划线式，与设置页、插件页、记忆页、团队页同一套视觉）。
        // 之前是贴着窗口左缘的 .ui-segment-group 药丸控件，与全站页面级切换栏不一致。
        // 左右内边距与页头/内容区同列（24 / 窄窗 16），选中项的 -mb-px 压住 PageShell.headerExtra 的外边框。
        <div
          role="tablist"
          aria-label="模型页分区"
          className={`${PAGE_TABLIST} px-6 max-[1199px]:px-4`}
        >
          {TABS.filter((item) => cli !== null || item.key !== "sources").map((item) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={tab === item.key}
              // 标准页签本身只给排版类名；这里保留 14px 图标，所以补 inline-flex + gap 让图标与文案对齐。
              className={`${pageTabClass(tab === item.key)} inline-flex items-center gap-1.5`}
              onClick={() => setTab(item.key)}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      }
    >
      {!cli && (
        <div role="status" className="ui-alert ui-alert-info mb-4">
          <AlertIcon width={14} height={14} className="mt-0.5 shrink-0" />
          <span>
            浏览器端只能查看可用模型。添加来源、登录账号与路由维护请打开和鸣桌面端——模型能力运行在你的电脑上。
          </span>
        </div>
      )}

      <div key={tab} className="rta-enter">
        {/* ── 模型 ───────────────────────────────────────────── */}
        {tab === "models" && (
          <section aria-label="可用模型" className="space-y-4">
            {/* d.138：三个 0 的统计条不再占首屏——空态本身已经说明「还没有」，
                再排一行 0/0/0 只会让页面显得像没加载完。有任意数据时才出现。 */}
            {profiles.length + providers.length + accounts.length > 0 && (
              <div className="grid gap-3 sm:grid-cols-3">
                <Stat label="可用模型" value={profiles.length} hint="智能体可选的模型" />
                <Stat label="已添加来源" value={providers.length} hint="订阅、厂商或自定义地址" />
                <Stat label="订阅账号" value={accounts.length} hint="登录后可用的额度" />
              </div>
            )}

            {loading ? (
              <div className="space-y-2" aria-label="读取模型">
                {[0, 1, 2].map((index) => (
                  <div key={index} className="h-14 animate-pulse rounded-2xl bg-[var(--subtle-3)]" />
                ))}
              </div>
            ) : profiles.length === 0 ? (
              <div className="ui-card border-dashed px-6 py-10 text-center">
                <span className="ui-icon-tile mx-auto mb-3">
                  <ModelIcon width={20} height={20} />
                </span>
                <div className="ui-section-title">还没有可用的模型</div>
                <p className="mx-auto mt-1 max-w-[420px] ui-caption">
                  添加一个来源：订阅一个账号，或填一个厂商的 API Key。加完模型会自动出现。
                </p>
                <Button className="mt-4" onClick={() => setTab("sources")}>
                  添加来源
                </Button>
              </div>
            ) : (
              <div className="ui-card p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="ui-section-title">可用模型</div>
                  <TextField
                    label="搜索模型"
                    className="w-56"
                    placeholder="搜索模型…"
                    value={modelQuery}
                    onChange={(event) => setModelQuery(event.target.value)}
                  />
                </div>
                <ul className="mt-2">
                  {visibleModels.map((profile) => (
                    <li
                      key={profile.model}
                      className="flex items-center gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-[var(--subtle)]"
                    >
                      <Avatar name={providerOf(profile.model)} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-ui-md font-bold" title={profile.model}>
                          {profile.model}
                        </span>
                        <span className="block ui-caption">来源 {providerOf(profile.model)}</span>
                      </span>
                      <span className="shrink-0 rounded-full bg-[var(--subtle-3)] px-2.5 py-0.5 text-ui-xs text-muted">
                        可用
                      </span>
                    </li>
                  ))}
                  {visibleModels.length === 0 && <li className="ui-caption px-2 py-2">没有匹配的模型。</li>}
                </ul>
                <p className="mt-2 ui-caption">
                  在智能体设置里选这里的模型。路由组与候选链在 magpie 内管理；本页只负责添加来源。
                </p>
              </div>
            )}

            <details className="ui-disclosure ui-card p-4">
              <summary className="cursor-pointer text-ui-md font-bold"><ChevronIcon width={14} height={14} className="ui-disclosure-chevron" />模型属性（可选）</summary>
              <p className="mt-1 ui-caption">改显示名、思考档或请求协议；留空的项不动。</p>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <TextField
                  label="属性模型 ID"
                  placeholder="provider/model"
                  value={modelForm.model}
                  onChange={(event) => setModelForm({ ...modelForm, model: event.target.value })}
                />
                <TextField
                  label="模型显示名"
                  placeholder="显示名"
                  value={modelForm.name}
                  onChange={(event) => setModelForm({ ...modelForm, name: event.target.value })}
                />
                <TextField
                  label="模型思考档"
                  placeholder="思考档，如 low,medium,high"
                  value={modelForm.efforts}
                  onChange={(event) => setModelForm({ ...modelForm, efforts: event.target.value })}
                />
                <label className="grid gap-1">
                  <span className="ui-caption">模型请求协议</span>
                  <select
                    className="ui-input"
                    value={modelForm.api}
                    onChange={(event) => setModelForm({ ...modelForm, api: event.target.value })}
                  >
                    {["auto", "chat", "responses", "anthropic", "gemini"].map((api) => (
                      <option key={api} value={api}>
                        {API_LABEL[api] ?? api}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <Button
                type="button"
                size="sm" variant="primary" className="mt-2"
                disabled={!cli || !modelForm.model.trim()}
                onClick={() => {
                  const model = modelForm.model.trim();
                  if (modelForm.name.trim()) void run("重命名模型", ["model", "name", model, modelForm.name.trim()], { refresh: true });
                  else if (modelForm.efforts.trim()) void run("设置思考档", ["model", "efforts", model, modelForm.efforts.trim()], { refresh: true });
                  else void run("设置协议", ["model", "api", model, modelForm.api], { refresh: true });
                }}
              >
                应用
              </Button>
            </details>
          </section>
        )}

        {/* ── 智能体 ─────────────────────────────────────────── */}
        {tab === "agents" && (
          <section aria-label="智能体" className="space-y-4">
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
                <div className="ui-section-title">本机智能体（{agents.length}）</div>
                <Button
                  type="button"
                  size="sm" variant="ghost"
                  disabled={!cli}
                  onClick={() => void loadAgents()}
                >
                  重新检测
                </Button>
              </div>
              <ul className="mt-2 divide-y divide-line">
                {agents.map((agent) => (
                  <li key={`${agent.name}-${agent.configPath}`} className="py-3">
                    <div className="flex flex-wrap items-center gap-3">
                      <Avatar name={agent.name} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-ui-md font-bold">{agent.name}</span>
                        <span className="block truncate ui-caption">
                          当前：{agent.model}
                          {agent.detail ? ` · ${agent.detail}` : ""} · {agent.configPath}
                        </span>
                      </span>
                      {agent.id ? (
                        <span className="flex shrink-0 flex-wrap items-center gap-1.5">
                          <TextField
                            label={`${agent.name} 模型`}
                            className="w-48"
                            placeholder="provider/model"
                            value={agentModelOf(agent)}
                            onChange={(event) => setAgentModelInput(agent.name, event.target.value)}
                          />
                          <Button
                            type="button"
                            size="sm" variant="primary"
                            disabled={!cli || !isModelId(agentModelOf(agent))}
                            onClick={() => {
                              const model = agentModelOf(agent).trim();
                              if (!agent.id || !model) return;
                              setAgentConfirm({ id: agent.id, name: agent.name, model });
                            }}
                          >
                            应用
                          </Button>
                          <Button
                            type="button"
                            size="sm" variant="ghost"
                            disabled={!cli}
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
                  </li>
                ))}
                {agents.length === 0 && (
                  <li className="py-2 ui-caption">
                    没有检测到本机智能体。装一个 Claude Code / Codex 之类的工具后点「重新检测」。
                  </li>
                )}
              </ul>

              {agentConfirm && (
                <div role="alert" className="ui-alert ui-alert-warn rta-enter mt-3 block">
                  <div className="flex items-start gap-2">
                    <AlertIcon width={14} height={14} className="mt-0.5 shrink-0" />
                    <div className="min-w-0">
                      <div className="text-ui-sm font-bold">
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
        )}

        {/* ── 来源 ───────────────────────────────────────────── */}
        {tab === "sources" && (
          <section aria-label="来源" className="space-y-4">
            {notice && (
              <div
                role="status"
                className="ui-alert ui-alert-success rta-enter items-center justify-between"
              >
                <span className="flex items-center gap-2 text-ui-sm">
                  <CheckIcon width={14} height={14} className="shrink-0" />
                  {notice}
                </span>
                <Button
                  type="button"
                  size="sm" variant="ghost"
                  onClick={() => setNotice(null)}
                >
                  关闭
                </Button>
              </div>
            )}

            {/* 主卡片：厂商 → 地址类型（普通 / Coding Plan）→ 一个 Key */}
            <div className="ui-card p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="ui-section-title">API Key 服务商</div>
                <span className="ui-caption">Coding Plan 请选套餐类型，否则会提示余额为 0</span>
              </div>
              {cli ? (
                <p className="mt-0.5 ui-caption">
                  点一个服务商 → 选地址类型 → 只填一个 Key；保存后模型会自动读出来。
                </p>
              ) : (
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
                {MAGPIE_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    aria-pressed={presetKey?.id === preset.id}
                    className={`ui-card ui-card-interactive px-3 py-2.5 text-left disabled:opacity-50 ${
                      presetKey?.id === preset.id
                        ? "border-ink bg-[var(--info-soft)]"
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
                        <span className="block truncate text-ui-md font-bold">{preset.name}</span>
                        <span className="block truncate ui-caption">{preset.desc}</span>
                      </span>
                    </span>
                  </button>
                ))}
              </div>
              )}

              {presetKey && activePreset && activePlan && (
                <div className="rta-enter mt-3 rounded-lg border border-line bg-[var(--subtle)] p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2 text-ui-sm font-bold">
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
                  <p className="mt-1.5 ui-caption">
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
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="ui-section-title">订阅账号</div>
                  <span className="ui-caption">多个账号自动分担</span>
                </div>
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
                        <span className="block text-ui-md font-bold">{item.label}</span>
                        <span className="block ui-caption">{item.desc}</span>
                      </span>
                      <span className="flex shrink-0 items-center gap-0.5 text-ui-xs text-muted">
                        登录
                        <ChevronIcon width={14} height={14} />
                      </span>
                    </button>
                  ))}
                </div>
                <ul className="mt-3 divide-y divide-line border-t border-line">
                  {accounts.map((row, index) => (
                    <li key={`${row.agent}-${row.label}-${index}`} className="flex items-center gap-3 py-2">
                      <Avatar name={row.agent} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-ui-md font-bold">{row.label}</span>
                        <span className="block ui-caption">{row.agent}</span>
                      </span>
                      <span className="shrink-0 ui-caption">{row.allowance ?? "额度未知"}</span>
                    </li>
                  ))}
                  {accounts.length === 0 && (
                    <li className="py-2 ui-caption">还没有账号，点一个服务登录。</li>
                  )}
                </ul>
              </div>

              <div className="ui-card p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="ui-section-title">其他地址</div>
                  <span className="ui-caption">中转、局域网或自建接口</span>
                </div>
                {!custom.open ? (
                  <button
                    type="button"
                    className="mt-2 flex w-full items-center justify-between gap-2 rounded-xl border border-dashed border-line px-3 py-2.5 text-left transition-colors hover:bg-[var(--subtle)] disabled:opacity-50"
                    disabled={!cli}
                    onClick={() => setCustom({ ...custom, open: true })}
                  >
                    <span className="min-w-0">
                      <span className="block text-ui-md font-bold">其他 OpenAI 兼容地址</span>
                      <span className="block ui-caption">填名称与地址即可，模型可留空自动读取</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-0.5 text-ui-sm text-muted">
                      展开
                      <ChevronIcon width={14} height={14} className="rotate-90" />
                    </span>
                  </button>
                ) : (
                  <div className="rta-enter mt-2 grid gap-2 sm:grid-cols-2">
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
                      <p role="alert" className="sm:col-span-2 ui-caption text-[var(--danger)]">
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
              </div>
            </div>
            )}

            <div className="ui-card p-4">
              <div className="ui-section-title">已添加的来源（{providers.length}）</div>
              {!cli && (
                <p className="mt-1 ui-caption">浏览器预览下只能查看：测试、换 Key 与删除来源请用桌面版。</p>
              )}
              <ul className="mt-2 divide-y divide-line">
                {providers.map((row) => {
                  const info = showCache[row.id];
                  const badge =
                    showLoading === row.id
                      ? { label: "读取地址…", className: "bg-[var(--subtle-3)] text-muted" }
                      : PLAN_BADGE[info?.plan ?? "normal"];
                  return (
                    <li key={row.id} className="py-2">
                      <div className="flex flex-wrap items-center gap-3">
                        <Avatar name={row.kind} />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5">
                            <span className="truncate text-ui-md font-bold">{row.id}</span>
                            <span
                              className={`shrink-0 rounded-full px-2 py-0.5 text-ui-xs ${badge.className}`}
                            >
                              {badge.label}
                            </span>
                          </span>
                          <span className="block truncate ui-caption">
                            {row.kind}
                            {row.host ? ` · ${row.host}` : ""}
                            {row.models !== null ? ` · ${row.models} 个模型` : ""}
                          </span>
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
                          onClick={() => void run("测试来源", ["provider", "test", row.id])}
                        >
                          测试
                        </Button>
                        <Button
                          type="button"
                          size="sm" variant="danger"
                          disabled={!cli}
                          onClick={() => void run("删除来源", ["provider", "rm", row.id], { refresh: true })}
                        >
                          删除
                        </Button>
                      </div>
                      {advancedProvider === row.id && (
                        <div className="rta-enter mt-2 rounded-lg border border-line bg-[var(--subtle)] p-3">
                          <div className="flex flex-wrap items-baseline justify-between gap-2">
                            <div className="text-ui-sm font-bold">{row.id} 的高级设置</div>
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
                            <div className="mt-1.5 flex flex-wrap items-start gap-2">
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
                            <div className="mt-1.5 grid gap-2 sm:grid-cols-2">
                              <TextField
                                label="来源模型列表"
                                placeholder="模型 id，逗号分隔（覆盖现有列表）"
                                value={providerForm.models}
                                onChange={(event) => setProviderForm({ ...providerForm, models: event.target.value })}
                              />
                              <TextField
                                label="模型目录地址"
                                placeholder="模型目录 URL（可选）"
                                value={providerForm.modelsUrl}
                                onChange={(event) => setProviderForm({ ...providerForm, modelsUrl: event.target.value })}
                              />
                              <TextField
                                label="备用模型"
                                className="sm:col-span-2"
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
                                ])
                              }
                            >
                              保存备用
                            </Button>
                          </div>

                          <details className="ui-disclosure mt-3 rounded-lg border border-line bg-[var(--subtle)] px-3 py-2">
                            <summary className="cursor-pointer ui-micro"><ChevronIcon width={14} height={14} className="ui-disclosure-chevron" />
                              请求（请求头 / 耐心 / 错误处理）
                            </summary>
                            <div className="mt-2 grid gap-2 sm:grid-cols-2">
                              <div className="flex gap-2">
                                <TextField
                                  label="请求头名称"
                                  placeholder="请求头名（如 X-Trace）"
                                  value={providerForm.headerName}
                                  onChange={(event) => setProviderForm({ ...providerForm, headerName: event.target.value })}
                                />
                                <TextField
                                  label="请求头值"
                                  placeholder="请求头值"
                                  value={providerForm.headerValue}
                                  onChange={(event) => setProviderForm({ ...providerForm, headerValue: event.target.value })}
                                />
                              </div>
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
                            </div>
                          </details>

                          <div className="mt-3 flex flex-wrap gap-2">
                            <Button
                              type="button"
                              size="sm" variant="primary"
                              disabled={!cli}
                              onClick={() => {
                                const pairs: string[] = [];
                                if (providerForm.routing) pairs.push(`routing=${providerForm.routing}`);
                                if (providerForm.models.trim()) pairs.push(`models=${providerForm.models.trim()}`);
                                if (providerForm.modelsUrl.trim()) pairs.push(`models.url=${providerForm.modelsUrl.trim()}`);
                                if (providerForm.patience.trim()) pairs.push(`patience=${providerForm.patience.trim()}`);
                                if (providerForm.errors) pairs.push(`errors=${providerForm.errors}`);
                                if (providerForm.headerName.trim() && providerForm.headerValue.trim()) {
                                  pairs.push(`header.${providerForm.headerName.trim()}=${providerForm.headerValue.trim()}`);
                                }
                                if (!pairs.length) return;
                                void run("保存来源设置", ["provider", "set", row.id, ...pairs], { refresh: true });
                              }}
                            >
                              保存设置
                            </Button>
                          </div>
                        </div>
                      )}
                    </li>
                  );
                })}
                {providers.length === 0 && (
                  // d.138：方位词（「从上面选」）在滚动后失效——直接说清下一步动作名。
                  <li className="py-2 ui-caption">
                    {cli
                      ? "还没有来源。点上方「API Key 服务商」里的一个服务商，或展开「其他地址」填服务地址和 Key。"
                      : "还没有来源。添加来源需要桌面版（浏览器里没有文件/密钥桥）。"}
                  </li>
                )}
              </ul>
            </div>
          </section>
        )}

        {/* ── 运行 ───────────────────────────────────────────── */}
        {tab === "run" && (
          <section aria-label="运行" className="space-y-4">
            <ModelTraceView />

            <div className="grid items-start gap-3 lg:grid-cols-2">
            <details className="ui-disclosure ui-card p-4 lg:col-span-2">
              <summary className="cursor-pointer text-ui-md font-bold"><ChevronIcon width={14} height={14} className="ui-disclosure-chevron" />路由分组（可选）</summary>
              <p className="mt-1 ui-caption">多个模型或账号合成一个名字，按策略分配。一般不需要手动建。</p>
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
                {dangerConfirm?.args[1] === "rm" ? (
                  <span className="flex items-center gap-1.5">
                    <Button
                      type="button"
                      size="sm" variant="danger"
                      onClick={() => {
                        const pending = dangerConfirm;
                        setDangerConfirm(null);
                        void run(pending.label, pending.args);
                      }}
                    >
                      确认删除
                    </Button>
                    <Button
                      type="button"
                      size="sm" variant="ghost"
                      onClick={() => setDangerConfirm(null)}
                    >
                      取消
                    </Button>
                  </span>
                ) : (
                  <Button
                    type="button"
                    size="sm" variant="danger"
                    disabled={!cli || !groupForm.target.trim()}
                    onClick={() =>
                      setDangerConfirm({
                        label: "删除分组",
                        args: ["group", "rm", groupForm.target.trim()],
                      })
                    }
                  >
                    删除
                  </Button>
                )}
              </div>

              <div className="mt-3 border-t border-line pt-3">
                <div className="text-ui-sm font-bold">规则（可选）：把某类请求先交给组里的指定模型</div>
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
            <ModelUsageView
              onExportCsv={(period) => void run("导出用量", ["usage", "--csv", period])}
            />

            <BackupPanel />

            <details className="ui-disclosure ui-card p-4">
              <summary className="cursor-pointer text-ui-md font-bold"><ChevronIcon width={14} height={14} className="ui-disclosure-chevron" />多机同步</summary>
              <div className="mt-2 grid gap-2 sm:grid-cols-3">
                <label className="grid gap-1">
                  <span className="ui-caption">同步类型</span>
                  <select className="ui-input" value={syncKind} onChange={(event) => setSyncKind(event.target.value)}>
                    {["webdav", "s3", "github"].map((kind) => (
                      <option key={kind} value={kind}>
                        {SYNC_KIND_LABEL[kind] ?? kind}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1">
                  <span className="ui-caption">同步动作</span>
                  <select className="ui-input" value={syncCommand} onChange={(event) => setSyncCommand(event.target.value)}>
                    {["now", "on", "off", "set"].map((command) => (
                      <option key={command} value={command}>
                        {SYNC_COMMAND_LABEL[command] ?? command}
                      </option>
                    ))}
                  </select>
                </label>
                <TextField
                  label="同步参数"
                  placeholder="写入配置时：key=value key2=value2"
                  value={syncValues}
                  onChange={(event) => setSyncValues(event.target.value)}
                />
              </div>
              <Button
                type="button"
                size="sm" variant="primary" className="mt-2"
                disabled={!cli}
                onClick={() =>
                  void run(`${syncKind} ${syncCommand}`, [
                    syncKind,
                    syncCommand,
                    ...syncValues.trim().split(/\s+/).filter(Boolean),
                  ])
                }
              >
                执行
              </Button>
            </details>

            <details className="ui-disclosure ui-card p-4">
              <summary className="cursor-pointer text-ui-md font-bold"><ChevronIcon width={14} height={14} className="ui-disclosure-chevron" />资源库与网页搜索</summary>
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
              <Button
                type="button"
                size="sm" variant="primary" className="mt-2"
                disabled={!cli}
                onClick={() => {
                  if (searchForm.api.trim()) {
                    void run("添加搜索来源", ["search", "add", searchForm.api.trim(), searchForm.key.trim()]);
                  } else if (searchForm.target.trim()) {
                    void run("删除搜索来源", ["search", "rm", searchForm.target.trim()]);
                  } else {
                    void run("搜索来源", ["search"]);
                  }
                }}
              >
                执行
              </Button>
            </details>

            <details className="ui-disclosure ui-card p-4">
              <summary className="cursor-pointer text-ui-md font-bold"><ChevronIcon width={14} height={14} className="ui-disclosure-chevron" />网关密钥</summary>
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
                {dangerConfirm?.args[1] === "remove" ? (
                  <span className="flex items-center gap-1.5">
                    <Button
                      type="button"
                      size="sm" variant="danger"
                      onClick={() => {
                        const pending = dangerConfirm;
                        setDangerConfirm(null);
                        void run(pending.label, pending.args);
                      }}
                    >
                      确认删除
                    </Button>
                    <Button
                      type="button"
                      size="sm" variant="ghost"
                      onClick={() => setDangerConfirm(null)}
                    >
                      取消
                    </Button>
                  </span>
                ) : (
                  <Button
                    type="button"
                    size="sm" variant="danger"
                    disabled={!cli || !gatewayKeyForm.target.trim()}
                    onClick={() =>
                      setDangerConfirm({
                        label: "删除密钥",
                        args: ["gateway-key", "remove", gatewayKeyForm.target.trim()],
                      })
                    }
                  >
                    删除
                  </Button>
                )}
              </div>
            </details>

            <details className="ui-disclosure ui-card p-4">
              <summary className="cursor-pointer text-ui-md font-bold"><ChevronIcon width={14} height={14} className="ui-disclosure-chevron" />会话与启动器</summary>
              <p className="mt-1 ui-caption">
                看各智能体最近的会话记录；启动器命令由模型服务提供（终端里 `claude-magpie` 之类），
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

            <details className="ui-disclosure ui-card p-4">
              <summary className="cursor-pointer text-ui-md font-bold"><ChevronIcon width={14} height={14} className="ui-disclosure-chevron" />高级命令</summary>
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
              <pre aria-label="命令输出" className="mt-2 h-56 overflow-auto rounded-xl bg-[var(--console-bg)] p-3 text-ui-sm text-[var(--console-ink)]">
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
            </div>
          </section>
        )}
      </div>

      {output && (
        <div
          role={output.ok ? "status" : "alert"}
          className={`rta-enter mt-4 block ${output.ok ? "ui-alert ui-alert-info" : "ui-alert ui-alert-danger"}`}
        >
          <div className="flex w-full items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-ui-sm font-bold">
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
