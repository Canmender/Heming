import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PageShell } from "./layout/PageShell.js";
import { useLlmStore } from "../store/llm.js";
import { useUiStore } from "../store/ui.js";
import { ensureDesktopGateway, getMagpieBridge, type MagpieHostStatus } from "../lib/magpieHost.js";
import {
  formatCommand,
  getMagpieCliBridge,
  parseAccounts,
  parseProviders,
  stripAnsi,
  tailText,
  type AccountRow,
  type MagpieCliBridge,
  type MagpieCliEvent,
  type ProviderRow,
} from "../lib/magpieCli.js";

/**
 * 模型页（d.99）：把 magpie 的管理能力做成和鸣导航栏上的一等页面。
 *
 * 为什么是「调用内核 CLI」而不是在 JS 里重写：
 * - 供应商、订阅账号、分组路由、用量、库、备份、WebDAV/S3/GitHub 同步……这些能力的
 *   唯一实现就是内核（我们 vendored 的 magpie 源码）；重写一遍必然两套口径；
 * - 页面通过主进程的白名单命令桥调用**我们自己的内核**（不经过 shell），
 *   升级上游源码即自动获得新命令；
 * - 交互式命令（OAuth 登录、备份口令）在真终端里跑，避免把密码/验证码搬进网页。
 *
 * 边界：
 * - 浏览器端没有命令桥 → 页面只读网关状态与模型目录，写操作提示「仅桌面端可用」；
 * - 危险命令（uninstall / serve / agent 改写）不在白名单内，页面也不提供入口。
 */

type TabKey =
  | "overview"
  | "providers"
  | "accounts"
  | "groups"
  | "models"
  | "usage"
  | "backup"
  | "library"
  | "terminal";

const TABS: { key: TabKey; label: string }[] = [
  { key: "overview", label: "概览" },
  { key: "providers", label: "供应商" },
  { key: "accounts", label: "订阅账号" },
  { key: "groups", label: "分组路由" },
  { key: "models", label: "模型" },
  { key: "usage", label: "用量" },
  { key: "backup", label: "备份与同步" },
  { key: "library", label: "库与搜索" },
  { key: "terminal", label: "终端" },
];

/** 打开真终端的登录目标（OAuth 必须由用户在本机浏览器完成）。 */
const ACCOUNT_TARGETS = [
  { agent: "claude", label: "Claude Code" },
  { agent: "codex", label: "ChatGPT / Codex" },
  { agent: "gemini", label: "Gemini CLI" },
  { agent: "antigravity", label: "Antigravity" },
  { agent: "copilot", label: "Copilot" },
];

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
  const refreshCatalog = useLlmStore((s) => s.refreshCatalog);
  const gateway = useLlmStore((s) => s.gateway);
  const openSettings = useUiStore((s) => s.openSettings);

  const cli = useMemo<MagpieCliBridge | null>(() => getMagpieCliBridge(), []);
  const hostBridge = useMemo(() => getMagpieBridge(), []);
  const [host, setHost] = useState<MagpieHostStatus | null>(null);
  const [tab, setTab] = useState<TabKey>("overview");
  const [busy, setBusy] = useState<string | null>(null);
  const [output, setOutput] = useState<{ title: string; text: string; ok: boolean } | null>(null);
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [providersRaw, setProvidersRaw] = useState("");
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [accountsRaw, setAccountsRaw] = useState("");
  const [live, setLive] = useState("");
  const liveRef = useRef("");
  const [runId, setRunId] = useState<string | null>(null);

  useEffect(() => {
    if (!hostBridge) return;
    let alive = true;
    void hostBridge
      .status()
      .then((status) => alive && setHost(status))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [hostBridge]);

  useEffect(() => {
    if (!cli) return;
    const off = cli.onCli((event: MagpieCliEvent) => {
      if (event.type === "start") {
        setRunId(event.runId);
        return;
      }
      if (event.type !== "stdout" && event.type !== "stderr") return;
      liveRef.current += event.text ?? "";
      setLive(tailText(stripAnsi(liveRef.current)));
    });
    return off;
  }, [cli]);

  const run = useCallback(
    async (title: string, args: string[]) => {
      if (!cli) {
        setOutput({ title, text: "仅桌面端可用：命令桥只在和鸣桌面端提供。", ok: false });
        return;
      }
      setBusy(title);
      try {
        const result = await cli.cli(args);
        const text =
          [result.stdout, result.stderr, result.error].filter((part) => part && part.trim()).join("\n").trim() ||
          "(无输出)";
        setOutput({ title, text: stripAnsi(text), ok: result.ok });
      } catch (err) {
        setOutput({ title, text: err instanceof Error ? err.message : String(err), ok: false });
      } finally {
        setBusy(null);
      }
    },
    [cli],
  );

  const runTerminal = async (title: string, args: string[]) => {
    if (!cli) {
      setOutput({ title, text: "仅桌面端可用：命令桥只在和鸣桌面端提供。", ok: false });
      return;
    }
    const result = await cli.openTerminal(args);
    setOutput({
      title,
      text: result.ok
        ? `已在新终端窗口执行：${formatCommand(args)}\n按窗口里的提示完成登录/口令，完成后回本页刷新。`
        : result.error || "无法打开终端",
      ok: result.ok,
    });
  };

  const loadProviders = useCallback(async () => {
    if (!cli) return;
    const result = await cli.cli(["providers"]);
    setProvidersRaw(stripAnsi(result.stdout || result.stderr || ""));
    setProviders(parseProviders(result.stdout || ""));
  }, [cli]);

  const loadAccounts = useCallback(async () => {
    if (!cli) return;
    const result = await cli.cli(["accounts", "--json"]);
    setAccountsRaw(stripAnsi(result.stdout || result.stderr || ""));
    setAccounts(parseAccounts(result.stdout || ""));
  }, [cli]);

  useEffect(() => {
    if (tab === "providers") void loadProviders();
    if (tab === "accounts") void loadAccounts();
  }, [tab, loadProviders, loadAccounts]);

  const [providerForm, setProviderForm] = useState({
    preset: "deepseek",
    presetKey: "",
    id: "",
    url: "",
    key: "",
    models: "",
    target: "",
  });
  const [accountBusy, setAccountBusy] = useState<string | null>(null);
  const [groupForm, setGroupForm] = useState({ name: "", models: "", routing: "smart", target: "" });
  const [modelForm, setModelForm] = useState({ model: "", name: "", efforts: "", api: "auto" });
  const [syncForm, setSyncForm] = useState({ kind: "webdav", command: "now", values: "" });
  const [searchForm, setSearchForm] = useState({ api: "", key: "", target: "" });
  const [usagePeriod, setUsagePeriod] = useState("30d");
  const [termForm, setTermForm] = useState({ command: "", input: "" });

  const startTerminalRun = async () => {
    const args = termForm.command.trim().split(/\s+/).filter(Boolean);
    if (!args.length || !cli) return;
    liveRef.current = "";
    setLive("");
    const started = await cli.cliStart(args);
    if (!started.ok) setOutput({ title: "终端", text: started.error || "启动失败", ok: false });
  };

  return (
    <PageShell
      title="模型"
      subtitle="和鸣内置的模型网关管理：供应商与订阅账号、分组路由、模型、用量、备份与同步。能力由内核直接提供，不复制第二套实现。"
      width="wide"
      actions={
        <div className="flex items-center gap-2">
          <span className="ui-caption">
            {host?.running ? `网关运行中${host.version ? ` · ${host.version}` : ""}` : "网关未运行"}
          </span>
          <button type="button" className="ui-btn ui-btn-md ui-btn-ghost" onClick={() => openSettings("model")}>
            网关设置
          </button>
          <button
            type="button"
            className="ui-btn ui-btn-md ui-btn-primary"
            onClick={async () => {
              setBusy("refresh");
              try {
                await refreshCatalog();
                if (hostBridge) setHost(await hostBridge.status());
              } catch (err) {
                setOutput({ title: "刷新模型目录", text: err instanceof Error ? err.message : String(err), ok: false });
              } finally {
                setBusy(null);
              }
            }}
            disabled={busy === "refresh"}
          >
            {busy === "refresh" ? "刷新中…" : "刷新模型目录"}
          </button>
        </div>
      }
      headerExtra={
        <div role="tablist" aria-label="模型页分区" className="flex flex-wrap gap-1">
          {TABS.map((item) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={tab === item.key}
              className={`ui-btn ui-btn-sm ${tab === item.key ? "ui-btn-primary" : "ui-btn-ghost"}`}
              onClick={() => setTab(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>
      }
    >
      {!cli && (
        <div role="status" className="mb-4 rounded-lg border border-line bg-[#fafafa] p-3 ui-body-sm">
          浏览器端只能查看网关状态与模型目录；供应商、账号、分组、备份等管理命令仅和鸣桌面端可用。
        </div>
      )}

      {tab === "overview" && (
        <section aria-label="模型概览" className="grid gap-4 md:grid-cols-2">
          <div className="rounded-xl border border-line p-4">
            <div className="text-[12px] font-bold text-muted">网关</div>
            <dl className="mt-2 space-y-1 text-[13px]">
              <div className="flex justify-between gap-3">
                <dt className="text-muted">地址</dt>
                <dd className="truncate font-mono text-[12px]">{gateway.baseUrl}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted">状态</dt>
                <dd>{host?.running ? `运行中${host.external ? "（本机已有实例）" : ""}` : "未运行"}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted">版本</dt>
                <dd>{host?.version ?? "—"}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted">模型目录</dt>
                <dd>{profiles.length} 个模型</dd>
              </div>
            </dl>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                className="ui-btn ui-btn-sm ui-btn-primary"
                onClick={async () => {
                  if (!hostBridge) return;
                  setBusy("ensure");
                  try {
                    const result = await ensureDesktopGateway();
                    if (result.error) setOutput({ title: "启动网关", text: result.error, ok: false });
                    setHost(await hostBridge.status());
                  } finally {
                    setBusy(null);
                  }
                }}
                disabled={!hostBridge || busy === "ensure"}
              >
                {host?.running ? "重新连接网关" : "启动网关"}
              </button>
              <button
                type="button"
                className="ui-btn ui-btn-sm ui-btn-ghost"
                onClick={() => void run("供应商列表", ["providers"])}
                disabled={!cli || busy === "供应商列表"}
              >
                查看供应商
              </button>
              <button
                type="button"
                className="ui-btn ui-btn-sm ui-btn-ghost"
                onClick={() => void run("订阅账号", ["accounts", "--json"])}
                disabled={!cli || busy === "订阅账号"}
              >
                查看订阅账号
              </button>
            </div>
          </div>
          <div className="rounded-xl border border-line p-4">
            <div className="text-[12px] font-bold text-muted">这个页面管什么</div>
            <ul className="mt-2 space-y-1 ui-body-sm text-muted">
              <li>供应商：加 Key、测连通、看模型、删掉不再用的；</li>
              <li>订阅账号：Claude / ChatGPT / Gemini / Copilot 的登录与额度；</li>
              <li>分组路由：把多个模型当一个用，选路、失败回退；</li>
              <li>用量与库：token/费用账本、指令/技能/MCP 库；</li>
              <li>备份与同步：一份加密备份，WebDAV / S3 / GitHub 同步。</li>
            </ul>
          </div>
        </section>
      )}

      {tab === "providers" && (
        <section aria-label="供应商" className="space-y-4">
          <div className="rounded-xl border border-line p-4">
            <div className="flex items-center justify-between">
              <div className="text-[12px] font-bold text-muted">已添加的供应商</div>
              <button type="button" className="ui-btn ui-btn-sm ui-btn-ghost" onClick={() => void loadProviders()}>
                重新读取
              </button>
            </div>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-left text-[13px]">
                <thead className="ui-caption">
                  <tr>
                    <th className="py-1 pr-3">ID</th>
                    <th className="py-1 pr-3">类型</th>
                    <th className="py-1 pr-3">主机</th>
                    <th className="py-1 pr-3">模型</th>
                  </tr>
                </thead>
                <tbody>
                  {providers.map((row) => (
                    <tr key={row.id} className="border-t border-line">
                      <td className="py-1 pr-3 font-mono text-[12px]">{row.id}</td>
                      <td className="py-1 pr-3">{row.kind}</td>
                      <td className="py-1 pr-3 font-mono text-[12px]">{row.host || "—"}</td>
                      <td className="py-1 pr-3">{row.models ?? "—"}</td>
                    </tr>
                  ))}
                  {providers.length === 0 && (
                    <tr>
                      <td colSpan={4} className="py-2 text-muted">
                        还没有供应商。用下面的「加预置」或「加自定义」开始。
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {providersRaw && <pre className="mt-2 max-h-40 overflow-auto rounded bg-[#fafafa] p-2 text-[11px]">{providersRaw}</pre>}
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <form
              className="rounded-xl border border-line p-4"
              onSubmit={(event) => {
                event.preventDefault();
                void run("加预置供应商", ["provider", "add", providerForm.preset, providerForm.presetKey.trim()]);
              }}
            >
              <div className="text-[12px] font-bold text-muted">加预置供应商（只要 Key）</div>
              <p className="mt-1 ui-caption">预置清单由内核维护：deepseek / openai / anthropic / moonshot …</p>
              <label className="ui-caption mt-2 block">
                预置 ID
                <input
                  aria-label="预置 ID"
                  className="ui-input mt-1 w-full"
                  value={providerForm.preset}
                  onChange={(e) => setProviderForm({ ...providerForm, preset: e.target.value })}
                />
              </label>
              <label className="ui-caption mt-2 block">
                API Key
                <input
                  aria-label="预置 API Key"
                  className="ui-input mt-1 w-full"
                  type="password"
                  value={providerForm.presetKey}
                  onChange={(e) => setProviderForm({ ...providerForm, presetKey: e.target.value })}
                />
              </label>
              <button type="submit" className="ui-btn ui-btn-sm ui-btn-primary mt-3" disabled={!cli || !providerForm.presetKey.trim()}>
                添加预置
              </button>
            </form>

            <form
              className="rounded-xl border border-line p-4"
              onSubmit={(event) => {
                event.preventDefault();
                const args = ["provider", "add", providerForm.id.trim()];
                if (providerForm.url.trim()) args.push(`url=${providerForm.url.trim()}`);
                if (providerForm.key.trim()) args.push(`key=${providerForm.key.trim()}`);
                if (providerForm.models.trim()) args.push(`models=${providerForm.models.trim()}`);
                void run("加自定义供应商", args);
              }}
            >
              <div className="text-[12px] font-bold text-muted">加自定义供应商（OpenAI 兼容端点）</div>
              <div className="mt-2 grid gap-2">
                <input
                  aria-label="自定义供应商 ID"
                  className="ui-input"
                  placeholder="ID（如 relay）"
                  value={providerForm.id}
                  onChange={(e) => setProviderForm({ ...providerForm, id: e.target.value })}
                />
                <input
                  aria-label="自定义供应商地址"
                  className="ui-input"
                  placeholder="https://host/v1"
                  value={providerForm.url}
                  onChange={(e) => setProviderForm({ ...providerForm, url: e.target.value })}
                />
                <input
                  aria-label="自定义供应商 Key"
                  className="ui-input"
                  type="password"
                  placeholder="API Key"
                  value={providerForm.key}
                  onChange={(e) => setProviderForm({ ...providerForm, key: e.target.value })}
                />
                <input
                  aria-label="自定义供应商模型"
                  className="ui-input"
                  placeholder="模型 id，逗号分隔"
                  value={providerForm.models}
                  onChange={(e) => setProviderForm({ ...providerForm, models: e.target.value })}
                />
              </div>
              <button type="submit" className="ui-btn ui-btn-sm ui-btn-primary mt-3" disabled={!cli || !providerForm.id.trim()}>
                添加自定义
              </button>
            </form>
          </div>

          <div className="rounded-xl border border-line p-4">
            <div className="text-[12px] font-bold text-muted">对已有供应商操作</div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                aria-label="供应商 ID"
                className="ui-input"
                placeholder="供应商 ID"
                value={providerForm.target}
                onChange={(e) => setProviderForm({ ...providerForm, target: e.target.value })}
              />
              <button
                type="button"
                className="ui-btn ui-btn-sm ui-btn-ghost"
                disabled={!cli || !providerForm.target.trim()}
                onClick={() => void run("供应商详情", ["provider", providerForm.target.trim()])}
              >
                详情
              </button>
              <button
                type="button"
                className="ui-btn ui-btn-sm ui-btn-ghost"
                disabled={!cli || !providerForm.target.trim()}
                onClick={() => void run("供应商模型", ["provider", "models", providerForm.target.trim()])}
              >
                模型
              </button>
              <button
                type="button"
                className="ui-btn ui-btn-sm ui-btn-ghost"
                disabled={!cli || !providerForm.target.trim()}
                onClick={() => void run("测试供应商", ["provider", "test", providerForm.target.trim()])}
              >
                测试连通
              </button>
              <button
                type="button"
                className="ui-btn ui-btn-sm ui-btn-danger"
                disabled={!cli || !providerForm.target.trim()}
                onClick={() => void run("删除供应商", ["provider", "rm", providerForm.target.trim()])}
              >
                删除
              </button>
            </div>
          </div>
        </section>
      )}

      {tab === "accounts" && (
        <section aria-label="订阅账号" className="space-y-4">
          <div className="rounded-xl border border-line p-4">
            <div className="flex items-center justify-between">
              <div className="text-[12px] font-bold text-muted">已登录的订阅（{accounts.length}）</div>
              <button type="button" className="ui-btn ui-btn-sm ui-btn-ghost" onClick={() => void loadAccounts()}>
                重新读取
              </button>
            </div>
            <table className="mt-2 w-full text-left text-[13px]">
              <thead className="ui-caption">
                <tr>
                  <th className="py-1 pr-3">类别</th>
                  <th className="py-1 pr-3">账号</th>
                  <th className="py-1 pr-3">额度</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((row, index) => (
                  <tr key={`${row.agent}-${row.label}-${index}`} className="border-t border-line">
                    <td className="py-1 pr-3">{row.agent}</td>
                    <td className="py-1 pr-3">{row.label}</td>
                    <td className="py-1 pr-3">{row.allowance ?? "—"}</td>
                  </tr>
                ))}
                {accounts.length === 0 && (
                  <tr>
                    <td colSpan={3} className="py-2 text-muted">
                      还没有订阅账号。登录会在新终端窗口里打开浏览器完成，凭据只落在本机。
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            {accountsRaw && (
              <pre className="mt-2 max-h-40 overflow-auto rounded bg-[#fafafa] p-2 text-[11px]">{accountsRaw}</pre>
            )}
          </div>
          <div className="rounded-xl border border-line p-4">
            <div className="text-[12px] font-bold text-muted">登录一个订阅</div>
            <p className="mt-1 ui-caption">
              点击后在本机终端窗口执行 `magpie accounts add …`，按提示在浏览器里登录；完成后回本页刷新。
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {ACCOUNT_TARGETS.map((item) => (
                <button
                  key={item.agent}
                  type="button"
                  className="ui-btn ui-btn-sm ui-btn-primary"
                  disabled={!cli || accountBusy !== null}
                  onClick={async () => {
                    setAccountBusy(item.agent);
                    try {
                      await runTerminal(`登录 ${item.label}`, ["accounts", "add", item.agent]);
                    } finally {
                      setAccountBusy(null);
                    }
                  }}
                >
                  {accountBusy === item.agent ? "打开中…" : `登录 ${item.label}`}
                </button>
              ))}
            </div>
          </div>
        </section>
      )}

      {tab === "groups" && (
        <section aria-label="分组路由" className="space-y-4">
          <div className="rounded-xl border border-line p-4">
            <div className="flex items-center justify-between">
              <div className="text-[12px] font-bold text-muted">路由分组</div>
              <button type="button" className="ui-btn ui-btn-sm ui-btn-ghost" onClick={() => void run("路由分组", ["groups"])}>
                查看 / 刷新
              </button>
            </div>
            <p className="mt-1 ui-caption">
              分组把多个模型合成一个 id（`group/&lt;名字&gt;`），按选路策略把请求分给其中一个。
            </p>
          </div>
          <form
            className="rounded-xl border border-line p-4"
            onSubmit={(event) => {
              event.preventDefault();
              void run("新建分组", [
                "group",
                "add",
                groupForm.name.trim(),
                `models=${groupForm.models.trim()}`,
                `routing=${groupForm.routing}`,
              ]);
            }}
          >
            <div className="text-[12px] font-bold text-muted">新建 / 修改分组</div>
            <div className="mt-2 grid gap-2 md:grid-cols-3">
              <input
                aria-label="分组名称"
                className="ui-input"
                placeholder="分组名"
                value={groupForm.name}
                onChange={(e) => setGroupForm({ ...groupForm, name: e.target.value })}
              />
              <input
                aria-label="分组模型列表"
                className="ui-input"
                placeholder="provider/model,provider/model2"
                value={groupForm.models}
                onChange={(e) => setGroupForm({ ...groupForm, models: e.target.value })}
              />
              <select
                aria-label="分组选路策略"
                className="ui-input"
                value={groupForm.routing}
                onChange={(e) => setGroupForm({ ...groupForm, routing: e.target.value })}
              >
                {GROUP_ROUTING.map((routing) => (
                  <option key={routing} value={routing}>
                    {routing}
                  </option>
                ))}
              </select>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <button type="submit" className="ui-btn ui-btn-sm ui-btn-primary" disabled={!cli || !groupForm.name.trim() || !groupForm.models.trim()}>
                保存分组
              </button>
              <input
                aria-label="分组 ID"
                className="ui-input"
                placeholder="分组名（删除/查看用）"
                value={groupForm.target}
                onChange={(e) => setGroupForm({ ...groupForm, target: e.target.value })}
              />
              <button
                type="button"
                className="ui-btn ui-btn-sm ui-btn-ghost"
                disabled={!cli || !groupForm.target.trim()}
                onClick={() => void run("分组详情", ["group", groupForm.target.trim()])}
              >
                详情
              </button>
              <button
                type="button"
                className="ui-btn ui-btn-sm ui-btn-danger"
                disabled={!cli || !groupForm.target.trim()}
                onClick={() => void run("删除分组", ["group", "rm", groupForm.target.trim()])}
              >
                删除
              </button>
            </div>
          </form>
        </section>
      )}

      {tab === "models" && (
        <section aria-label="模型" className="space-y-4">
          <div className="rounded-xl border border-line p-4">
            <div className="flex items-center justify-between">
              <div className="text-[12px] font-bold text-muted">内核里的模型</div>
              <button type="button" className="ui-btn ui-btn-sm ui-btn-ghost" onClick={() => void run("模型列表", ["models"])}>
                查看 / 刷新
              </button>
            </div>
            <p className="mt-1 ui-caption">
              和鸣侧可用模型见上方「刷新模型目录」；这里管理内核的模型元数据（名字、思考档、协议）。
            </p>
          </div>
          <form
            className="rounded-xl border border-line p-4"
            onSubmit={(event) => {
              event.preventDefault();
              const model = modelForm.model.trim();
              if (!model) return;
              if (modelForm.name.trim()) void run("重命名模型", ["model", "name", model, modelForm.name.trim()]);
              else if (modelForm.efforts.trim()) void run("设置思考档", ["model", "efforts", model, modelForm.efforts.trim()]);
              else void run("设置协议", ["model", "api", model, modelForm.api]);
            }}
          >
            <div className="text-[12px] font-bold text-muted">模型属性</div>
            <div className="mt-2 grid gap-2 md:grid-cols-2">
              <input
                aria-label="模型 ID"
                className="ui-input"
                placeholder="provider/model"
                value={modelForm.model}
                onChange={(e) => setModelForm({ ...modelForm, model: e.target.value })}
              />
              <input
                aria-label="模型显示名"
                className="ui-input"
                placeholder="显示名（留空则不改）"
                value={modelForm.name}
                onChange={(e) => setModelForm({ ...modelForm, name: e.target.value })}
              />
              <input
                aria-label="模型思考档"
                className="ui-input"
                placeholder="思考档，如 low,medium,high（留空则不改）"
                value={modelForm.efforts}
                onChange={(e) => setModelForm({ ...modelForm, efforts: e.target.value })}
              />
              <select
                aria-label="模型协议"
                className="ui-input"
                value={modelForm.api}
                onChange={(e) => setModelForm({ ...modelForm, api: e.target.value })}
              >
                {["auto", "chat", "responses", "anthropic", "gemini"].map((api) => (
                  <option key={api} value={api}>
                    {api}
                  </option>
                ))}
              </select>
            </div>
            <button type="submit" className="ui-btn ui-btn-sm ui-btn-primary mt-2" disabled={!cli || !modelForm.model.trim()}>
              应用
            </button>
          </form>
        </section>
      )}

      {tab === "usage" && (
        <section aria-label="用量" className="space-y-4">
          <div className="rounded-xl border border-line p-4">
            <div className="text-[12px] font-bold text-muted">内核的 token 与费用账本</div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <select
                aria-label="用量时间范围"
                className="ui-input"
                value={usagePeriod}
                onChange={(e) => setUsagePeriod(e.target.value)}
              >
                {["today", "7d", "30d", "all"].map((period) => (
                  <option key={period} value={period}>
                    {period}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="ui-btn ui-btn-sm ui-btn-primary"
                disabled={!cli}
                onClick={() => void run(`用量 ${usagePeriod}`, ["usage", usagePeriod])}
              >
                查看用量
              </button>
              <button
                type="button"
                className="ui-btn ui-btn-sm ui-btn-ghost"
                disabled={!cli}
                onClick={() => void run("用量 CSV", ["usage", "--csv", usagePeriod])}
              >
                导出 CSV
              </button>
            </div>
            <p className="mt-2 ui-caption">账本在本机，由内核记录；和鸣不复制这份数据。</p>
          </div>
        </section>
      )}

      {tab === "backup" && (
        <section aria-label="备份与同步" className="space-y-4">
          <div className="rounded-xl border border-line p-4">
            <div className="text-[12px] font-bold text-muted">加密备份</div>
            <p className="mt-1 ui-caption">
              备份包含供应商、Key、设置、档案、agent 模型与库，用口令加密。命令在新终端里执行（口令不经过页面）。
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" className="ui-btn ui-btn-sm ui-btn-primary" disabled={!cli} onClick={() => void runTerminal("备份", ["backup"])}>
                新建备份
              </button>
              <button type="button" className="ui-btn ui-btn-sm ui-btn-ghost" disabled={!cli} onClick={() => void runTerminal("恢复备份", ["restore"])}>
                恢复备份
              </button>
            </div>
          </div>
          <form
            className="rounded-xl border border-line p-4"
            onSubmit={(event) => {
              event.preventDefault();
              const values = syncForm.values.trim().split(/\s+/).filter(Boolean);
              void run(`${syncForm.kind} ${syncForm.command}`, [syncForm.kind, syncForm.command, ...values]);
            }}
          >
            <div className="text-[12px] font-bold text-muted">多机同步（WebDAV / S3 / GitHub）</div>
            <div className="mt-2 grid gap-2 md:grid-cols-3">
              <select
                aria-label="同步类型"
                className="ui-input"
                value={syncForm.kind}
                onChange={(e) => setSyncForm({ ...syncForm, kind: e.target.value })}
              >
                {["webdav", "s3", "github"].map((kind) => (
                  <option key={kind} value={kind}>
                    {kind}
                  </option>
                ))}
              </select>
              <select
                aria-label="同步动作"
                className="ui-input"
                value={syncForm.command}
                onChange={(e) => setSyncForm({ ...syncForm, command: e.target.value })}
              >
                {["now", "on", "off", "set"].map((command) => (
                  <option key={command} value={command}>
                    {command}
                  </option>
                ))}
              </select>
              <input
                aria-label="同步参数"
                className="ui-input"
                placeholder="set 的参数，如 key=value key2=value2"
                value={syncForm.values}
                onChange={(e) => setSyncForm({ ...syncForm, values: e.target.value })}
              />
            </div>
            <button type="submit" className="ui-btn ui-btn-sm ui-btn-primary mt-2" disabled={!cli}>
              执行
            </button>
          </form>
        </section>
      )}

      {tab === "library" && (
        <section aria-label="库与搜索" className="space-y-4">
          <div className="rounded-xl border border-line p-4">
            <div className="text-[12px] font-bold text-muted">库（指令 / MCP / 技能）</div>
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" className="ui-btn ui-btn-sm ui-btn-ghost" disabled={!cli} onClick={() => void run("库状态", ["library"])}>
                查看库
              </button>
              <button type="button" className="ui-btn ui-btn-sm ui-btn-ghost" disabled={!cli} onClick={() => void run("同步库", ["library", "sync"])}>
                同步到各 agent
              </button>
              <button type="button" className="ui-btn ui-btn-sm ui-btn-ghost" disabled={!cli} onClick={() => void run("库指令", ["library", "instructions"])}>
                指令
              </button>
              <button type="button" className="ui-btn ui-btn-sm ui-btn-ghost" disabled={!cli} onClick={() => void run("库 MCP", ["library", "mcp"])}>
                MCP
              </button>
              <button type="button" className="ui-btn ui-btn-sm ui-btn-ghost" disabled={!cli} onClick={() => void run("库技能", ["library", "skill"])}>
                技能
              </button>
            </div>
          </div>
          <form
            className="rounded-xl border border-line p-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (searchForm.api.trim()) {
                void run("加搜索源", ["search", "add", searchForm.api.trim(), searchForm.key.trim()]);
              } else if (searchForm.target.trim()) {
                void run("删搜索源", ["search", "rm", searchForm.target.trim()]);
              } else {
                void run("搜索源", ["search"]);
              }
            }}
          >
            <div className="text-[12px] font-bold text-muted">网页搜索源</div>
            <div className="mt-2 grid gap-2 md:grid-cols-3">
              <input
                aria-label="搜索源 API"
                className="ui-input"
                placeholder="API 名称（如 tavily）"
                value={searchForm.api}
                onChange={(e) => setSearchForm({ ...searchForm, api: e.target.value })}
              />
              <input
                aria-label="搜索源 Key"
                className="ui-input"
                type="password"
                placeholder="Key"
                value={searchForm.key}
                onChange={(e) => setSearchForm({ ...searchForm, key: e.target.value })}
              />
              <input
                aria-label="删除搜索源"
                className="ui-input"
                placeholder="要删除的 API 名称"
                value={searchForm.target}
                onChange={(e) => setSearchForm({ ...searchForm, target: e.target.value })}
              />
            </div>
            <div className="mt-2 flex gap-2">
              <button type="submit" className="ui-btn ui-btn-sm ui-btn-primary" disabled={!cli}>
                执行
              </button>
              <button type="button" className="ui-btn ui-btn-sm ui-btn-ghost" disabled={!cli} onClick={() => void run("搜索源", ["search"])}>
                查看现有
              </button>
            </div>
          </form>
        </section>
      )}

      {tab === "terminal" && (
        <section aria-label="终端" className="space-y-3">
          <div className="rounded-xl border border-line p-4">
            <div className="text-[12px] font-bold text-muted">内核终端（白名单命令）</div>
            <p className="mt-1 ui-caption">
              这里直接跑内核命令（`magpie providers`、`magpie accounts` …）。危险命令（卸载/服务/agent 改写）被主进程拒绝。
            </p>
            <div className="mt-2 flex gap-2">
              <input
                aria-label="内核命令"
                className="ui-input flex-1 font-mono text-[12px]"
                placeholder="providers"
                value={termForm.command}
                onChange={(e) => setTermForm({ ...termForm, command: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void startTerminalRun();
                }}
              />
              <button type="button" className="ui-btn ui-btn-sm ui-btn-primary" disabled={!cli || !termForm.command.trim()} onClick={() => void startTerminalRun()}>
                运行
              </button>
              <button
                type="button"
                className="ui-btn ui-btn-sm ui-btn-ghost"
                disabled={!cli || !runId}
                onClick={() => {
                  if (runId) void cli?.cliKill(runId);
                  setRunId(null);
                }}
              >
                取消
              </button>
            </div>
            <pre aria-label="终端输出" className="mt-2 h-64 overflow-auto rounded bg-[#111] p-3 text-[12px] text-[#e8e8e8]">
              {live || "（输出会出现在这里；交互式命令可在下面输入）"}
            </pre>
            <div className="mt-2 flex gap-2">
              <input
                aria-label="终端输入"
                className="ui-input flex-1 font-mono text-[12px]"
                placeholder="回车发送给正在运行的命令"
                value={termForm.input}
                onChange={(e) => setTermForm({ ...termForm, input: e.target.value })}
                onKeyDown={async (e) => {
                  if (e.key !== "Enter" || !runId || !cli) return;
                  const text = `${termForm.input}\n`;
                  setTermForm({ ...termForm, input: "" });
                  await cli.cliInput(runId, text);
                }}
              />
            </div>
          </div>
        </section>
      )}

      {output && (
        <div
          role={output.ok ? "status" : "alert"}
          className={`mt-4 rounded-lg border p-3 ${output.ok ? "border-line bg-[#fafafa]" : "border-[#f3c9c9] bg-[#fff6f6]"}`}
        >
          <div className="flex items-center justify-between gap-2">
            <div className="text-[12px] font-bold text-muted">{output.title}</div>
            <button type="button" className="ui-btn ui-btn-sm ui-btn-ghost" onClick={() => setOutput(null)}>
              关闭
            </button>
          </div>
          <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap text-[12px]">{output.text}</pre>
        </div>
      )}
    </PageShell>
  );
}
