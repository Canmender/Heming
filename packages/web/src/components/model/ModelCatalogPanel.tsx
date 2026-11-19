import { useMemo, useState } from "react";
import { Button } from "../ui/Button.js";
import { TextField } from "../ui/Field.js";
import { ConfirmDialog } from "../ConfirmDialog.js";
import { ChevronIcon } from "../icons.js";
import { Avatar } from "./Avatar.js";
import {
  canTestModel,
  filterModelRows,
  formatTokenCount,
  groupModelRows,
  isModelDisabled,
  modelCapabilityLine,
  modelPriceLine,
  modelShortId,
  priceEditValue,
  type DisabledPattern,
  type ModelRow,
} from "../../lib/modelCatalog.js";
import { specDraft, specFieldsOfYours, type ModelSpec } from "../../lib/modelSpec.js";

/**
 * 模型目录面板（对齐原版 magpie 的模型管理体验）。
 *
 * 原版 magpie 的模型不只是一行 `provider/model`：它有显示名、思考档、上下文窗口、
 * 最大输出、图片输入，还有逐个模型的测试与禁用（`model name/spec/disable`）。
 * 这里按来源分组把它们摆出来，并把「改一个模型」收进行内编辑器——
 * 编辑的永远是用户点的那个模型，不再要求他先把 ID 抄进另一个表单。
 */

/** 请求协议：auto / chat / responses / anthropic / gemini（与 `model api` 同值）。 */
const API_LABEL: Record<string, string> = {
  auto: "自动识别",
  chat: "Chat Completions",
  responses: "Responses",
  anthropic: "Anthropic Messages",
  gemini: "Gemini",
};

interface ModelDraft {
  name: string;
  efforts: string;
  context: string;
  output: string;
  api: string;
  vision: boolean;
  price: string;
  /** 速度档：空 = 不改；fast / ultrafast / usual 走 `model tier`。 */
  tier: string;
}

/** magpie 的模型速度档（`model tier`）：厂商的快速模式，或恢复常规。 */
const TIER_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "保持现在的速度" },
  { value: "fast", label: "快速（厂商的 fast 模式）" },
  { value: "ultrafast", label: "超快（账号支持时用 Ultrafast）" },
  { value: "usual", label: "常规速度" },
];

type ConfirmNeed =
  | { kind: "disable"; row: ModelRow }
  | { kind: "enable"; pattern: string; hits: string[] };

export interface ModelCatalogPanelProps {
  rows: ModelRow[];
  disabled: DisabledPattern[];
  cliReady: boolean;
  onRun: (
    title: string,
    args: string[],
    opts?: { refresh?: boolean },
  ) => Promise<{ ok: boolean; text: string }>;
  /** 读 `model spec <id>`：编辑器打开后可以先看「现在到底是什么值、哪些是你设的」。 */
  onReadSpec?: (id: string) => Promise<ModelSpec | null>;
  /** 内核是否认识 `model tier`；不认识时不给速度档，免得保存必报错。 */
  tierSupported?: boolean;
}

function draftOf(row: ModelRow): ModelDraft {
  return {
    name: row.name,
    efforts: row.efforts.join(","),
    context: formatTokenCount(row.contextWindow),
    output: formatTokenCount(row.maxOutputTokens),
    api: "",
    vision: row.vision,
    price: priceEditValue(row),
    tier: "",
  };
}

/** 价格框的内容：空 = 不改；否则要 4 或 5 个数（入,出,缓存读,缓存写[,1 小时缓存写]）。 */
function priceProblem(text: string): string | null {
  const value = text.trim();
  if (!value) return null;
  const parts = value.split(/[,，\s/]+/).filter(Boolean);
  if (parts.length !== 4 && parts.length !== 5) return "价格要写 4 个数：入,出,缓存读,缓存写";
  if (parts.some((part) => !Number.isFinite(Number(part)) || Number(part) < 0)) {
    return "价格是每 100 万 token 的美元数，例如 0.15,0.6,0.003,0";
  }
  return null;
}

/** 与当前值不同的规格项；一项都没改时返回空数组（不发命令）。 */
function specArgsOf(row: ModelRow, draft: ModelDraft): string[] {
  const args: string[] = [];
  const context = draft.context.trim();
  if (context && context !== formatTokenCount(row.contextWindow)) args.push("--context", context);
  const output = draft.output.trim();
  if (output && output !== formatTokenCount(row.maxOutputTokens)) args.push("--output", output);
  const efforts = draft.efforts.trim();
  // 清空思考档 = 交回上游（auto），不是「一个档都不要」。
  if (efforts !== row.efforts.join(",")) args.push("--reasoning", efforts || "auto");
  if (draft.vision !== row.vision) args.push("--vision", draft.vision ? "on" : "off");
  return args;
}

export function ModelCatalogPanel({
  rows,
  disabled,
  cliReady,
  onRun,
  onReadSpec,
  tierSupported = false,
}: ModelCatalogPanelProps) {
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<ModelDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [reading, setReading] = useState(false);
  const [ownFields, setOwnFields] = useState<string[]>([]);
  const [testing, setTesting] = useState<string | null>(null);
  const [testingAs, setTestingAs] = useState<string | null>(null);
  const [bulkAsking, setBulkAsking] = useState(false);
  const [bulk, setBulk] = useState<{ done: number; total: number; passed: number } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [priceError, setPriceError] = useState("");
  const [confirm, setConfirm] = useState<ConfirmNeed | null>(null);

  const providers = useMemo(() => groupModelRows(rows).map((group) => group.provider), [rows]);
  const groups = useMemo(
    () => groupModelRows(filterModelRows(rows, query, provider)),
    [rows, query, provider],
  );

  const openEditor = (row: ModelRow) => {
    setEditing(row.id);
    setDraft(draftOf(row));
    setPriceError("");
    setOwnFields([]);
  };

  const closeEditor = () => {
    setEditing(null);
    setDraft(null);
    setPriceError("");
    setOwnFields([]);
  };

  /** 读 `model spec`：把「现在生效的值」填进草稿，并标出哪些是用户自己设的。 */
  const readSpec = async () => {
    if (!onReadSpec || !editing || reading) return;
    setReading(true);
    try {
      const spec = await onReadSpec(editing);
      const next = spec ? specDraft(spec) : null;
      if (spec) setOwnFields(specFieldsOfYours(spec));
      if (next) {
        setDraft((current) => (current ? { ...current, ...next } : current));
      }
    } finally {
      setReading(false);
    }
  };

  const save = async (row: ModelRow) => {
    if (!draft || saving) return;
    const problem = priceProblem(draft.price);
    if (problem) {
      setPriceError(problem);
      return;
    }
    const tasks: { title: string; args: string[] }[] = [];
    const name = draft.name.trim();
    if (name !== row.name) {
      tasks.push({
        title: name ? "重命名模型" : "恢复模型原名",
        args: ["model", "name", row.id, ...(name ? [name] : ["--reset"])],
      });
    }
    const spec = specArgsOf(row, draft);
    if (spec.length) tasks.push({ title: "设置模型规格", args: ["model", "spec", row.id, ...spec] });
    const price = draft.price.trim();
    if (price && price !== priceEditValue(row)) {
      tasks.push({ title: "设置模型价格", args: ["model", "price", row.id, price] });
    }
    if (draft.api) tasks.push({ title: "设置请求协议", args: ["model", "api", row.id, draft.api] });
    if (draft.tier) tasks.push({ title: "设置模型速度", args: ["model", "tier", row.id, draft.tier] });
    if (!tasks.length) return;
    setSaving(true);
    let ok = true;
    try {
      // 一条失败就停：后面的命令依赖前面的状态，接着发只会把失败叠加成噪音。
      for (const task of tasks) {
        const result = await onRun(task.title, task.args, { refresh: true });
        if (!result.ok) {
          ok = false;
          break;
        }
      }
    } finally {
      setSaving(false);
    }
    if (ok) closeEditor();
  };

  const testModel = async (row: ModelRow) => {
    setTesting(row.id);
    try {
      // provider test 只认来源 + 模型短名；路由组/自动路由的成员不能单独测。
      const providerId = row.id.split("/")[0]!;
      await onRun("测试模型", ["provider", "test", providerId, modelShortId(row.id)], {
        refresh: false,
      });
    } finally {
      setTesting(null);
    }
  };

  /** 像一个智能体那样问这个模型（magpie 的「Test as Codex / Claude Code」）。 */
  const testModelAs = async (row: ModelRow, as: "codex" | "claude-code") => {
    const providerId = row.id.split("/")[0]!;
    const key = `${row.id}:${as}`;
    setTestingAs(key);
    try {
      await onRun(
        as === "codex" ? "按 Codex 测试模型" : "按 Claude Code 测试模型",
        ["provider", "test", providerId, "--as", as, modelShortId(row.id)],
        { refresh: false },
      );
    } finally {
      setTestingAs(null);
    }
  };

  /**
   * magpie 的 Quick check「Test all」：每个模型真的发一次请求，按厂商价格计费。
   * 逐个串行跑，中途不再刷新目录（重读会把进度冲掉）。
   */
  const testAll = async () => {
    setBulkAsking(false);
    const testable = rows.filter((row) => canTestModel(row.id));
    if (!testable.length) return;
    let passed = 0;
    setBulk({ done: 0, total: testable.length, passed: 0 });
    for (const [index, row] of testable.entries()) {
      const providerId = row.id.split("/")[0]!;
      const result = await onRun("测试全部模型", ["provider", "test", providerId, modelShortId(row.id)], {
        refresh: false,
      });
      if (result.ok) passed += 1;
      setBulk({ done: index + 1, total: testable.length, passed });
    }
  };

  const copyId = async (row: ModelRow) => {    try {
      await navigator.clipboard?.writeText(row.id);
      setCopied(row.id);
      window.setTimeout(() => setCopied((current) => (current === row.id ? null : current)), 1500);
    } catch {
      // 剪贴板不可用时不假装复制成功：命令输出里还有模型 id 可以手抄。
      setCopied(null);
    }
  };

  const dirty =
    draft !== null &&
    (() => {
      const row = rows.find((item) => item.id === editing);
      if (!row) return false;
      return (
        draft.name.trim() !== row.name ||
        draft.api !== "" ||
        draft.tier !== "" ||
        draft.price.trim() !== priceEditValue(row) ||
        specArgsOf(row, draft).length > 0
      );
    })();

  return (
    <div className="space-y-4">
      <div className="ui-card p-4">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div className="min-w-0">
            <h2 className="ui-section-title">可用模型</h2>
            <p className="ui-caption mt-0.5">
              {rows.length} 个模型 · {providers.length} 个来源
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <button
              type="button"
              className="ui-btn ui-btn-ghost"
              disabled={!cliReady || bulk !== null}
              onClick={() => setBulkAsking(true)}
            >
              测试全部模型
            </button>
            <TextField
              label="搜索模型"
              className="w-48"
              placeholder="搜索模型…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <label className="grid gap-1">
              <span className="ui-caption">按来源</span>
              <select
                className="ui-input w-36"
                value={provider}
                aria-label="按来源筛选"
                onChange={(event) => setProvider(event.target.value)}
              >
                <option value="">全部来源</option>
                {providers.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        {bulk ? (
          <p className="ui-caption mt-2" role="status" aria-live="polite">
            {bulk.done < bulk.total
              ? `正在测试 ${bulk.done + 1}/${bulk.total}：每个模型都会真的发一次请求，按厂商的价格计费。`
              : `测试完 ${bulk.total} 个模型：${bulk.passed} 个通过${
                  bulk.total - bulk.passed > 0 ? `，${bulk.total - bulk.passed} 个失败` : ""
                }。`}
          </p>
        ) : null}

        {groups.length === 0 ? (
          <p className="ui-caption mt-3">
            没有匹配的模型。
            <button
              type="button"
              className="ml-1 underline underline-offset-2"
              onClick={() => {
                setQuery("");
                setProvider("");
              }}
            >
              清除筛选
            </button>
          </p>
        ) : (
          groups.map((group) => (
            <div key={group.provider} className="mt-3">
              <div className="flex items-center gap-2">
                <Avatar name={group.provider} />
                <h3 className="text-ui-sm font-semibold">{group.provider}</h3>
                <span className="ui-caption">{group.rows.length} 个</span>
              </div>
              <ul className="mt-1">
                {group.rows.map((row) => {
                  const disabledHit = isModelDisabled(row, disabled);
                  const capability = modelCapabilityLine(row);
                  const priceLine = modelPriceLine(row);
                  const open = editing === row.id && draft !== null;
                  return (
                    <li
                      key={row.id}
                      className="-mx-4 flex flex-wrap items-start gap-3 ui-list-row"
                    >
                      <span className="min-w-0 flex-1">
                        <span
                          className="block truncate ui-body-sm font-semibold"
                          title={row.id}
                        >
                          {row.name || row.id}
                        </span>
                        {row.name && (
                          <span className="block truncate ui-caption" title={row.id}>
                            {row.id}
                          </span>
                        )}
                        {capability && <span className="mt-0.5 block ui-caption">{capability}</span>}
                        {priceLine && (
                          <span className="mt-0.5 block ui-caption tabular-nums">{priceLine}</span>
                        )}
                      </span>
                      <span className="flex shrink-0 flex-wrap items-center gap-1.5">
                        {disabledHit && (
                          <span className="rounded-full bg-warn-soft px-2 py-0.5 text-ui-xs font-medium text-warn">
                            已禁用
                          </span>
                        )}
                        {!row.inCatalog && (
                          <span className="rounded-full bg-subtle-3 px-2 py-0.5 text-ui-xs text-muted">
                            未在网关目录
                          </span>
                        )}
                        {canTestModel(row.id) && (
                          <Button
                            type="button"
                            size="sm" variant="ghost"
                            disabled={!cliReady || testing === row.id}
                            aria-label={`测试模型 ${row.id}`}
                            onClick={() => void testModel(row)}
                          >
                            {testing === row.id ? "测试中…" : "测试"}
                          </Button>
                        )}
                        <Button
                          type="button"
                          size="sm" variant="ghost"
                          aria-label={`复制模型 ID ${row.id}`}
                          onClick={() => void copyId(row)}
                        >
                          {copied === row.id ? "已复制" : "复制 ID"}
                        </Button>
                        <Button
                          type="button"
                          size="sm" variant="ghost"
                          aria-label={`编辑模型 ${row.id}`}
                          disabled={!cliReady}
                          onClick={() => (open ? closeEditor() : openEditor(row))}
                        >
                          {open ? "收起" : "编辑"}
                        </Button>
                      </span>

                      {open && draft && (
                        <div className="mt-2 grid w-full gap-2 rounded-lg border border-line bg-subtle-2 p-3 sm:grid-cols-2">
                          <div className="flex flex-wrap items-center justify-between gap-2 sm:col-span-2">
                            <p className="ui-caption">
                              {ownFields.length
                                ? `你自己设过：${ownFields.join("、")}`
                                : "现在的值来自厂商清单和 models.dev"}
                            </p>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              disabled={!onReadSpec || reading}
                              onClick={() => void readSpec()}
                            >
                              {reading ? "读取中…" : "读取现在的设置"}
                            </Button>
                          </div>
                          <TextField
                            label="模型显示名"
                            placeholder="显示名"
                            hint="留空恢复上游的显示名"
                            value={draft.name}
                            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                          />
                          <TextField
                            label="思考档"
                            placeholder="low,high 或 low-high"
                            hint="留空恢复上游的思考档"
                            value={draft.efforts}
                            onChange={(event) => setDraft({ ...draft, efforts: event.target.value })}
                          />
                          <TextField
                            label="上下文窗口"
                            placeholder="128K 或 200000"
                            hint="token 数，可写 1m / 128k"
                            value={draft.context}
                            onChange={(event) => setDraft({ ...draft, context: event.target.value })}
                          />
                          <TextField
                            label="最大输出"
                            placeholder="8K 或 8192"
                            hint="单个回复的上限"
                            value={draft.output}
                            onChange={(event) => setDraft({ ...draft, output: event.target.value })}
                          />
                          <TextField
                            label="价格（入,出,缓存读,缓存写）"
                            placeholder="0.15,0.6,0.003,0"
                            hint="USD / 每 100 万 token；留空不改"
                            error={priceError}
                            value={draft.price}
                            onChange={(event) => {
                              setPriceError("");
                              setDraft({ ...draft, price: event.target.value });
                            }}
                          />
                          <label className="grid gap-1">
                            <span className="ui-caption">请求协议</span>
                            <select
                              className="ui-input"
                              value={draft.api}
                              aria-label="模型请求协议"
                              onChange={(event) => setDraft({ ...draft, api: event.target.value })}
                            >
                              <option value="">保持现在的协议</option>
                              {Object.keys(API_LABEL).map((api) => (
                                <option key={api} value={api}>
                                  {API_LABEL[api]}
                                </option>
                              ))}
                            </select>
                          </label>
                          {tierSupported ? (
                            <label className="grid gap-1">
                              <span className="ui-caption">速度档</span>
                              <select
                                className="ui-input"
                                value={draft.tier}
                                aria-label="模型速度档"
                                onChange={(event) =>
                                  setDraft({ ...draft, tier: event.target.value })
                                }
                              >
                                {TIER_OPTIONS.map((option) => (
                                  <option key={option.value} value={option.value}>
                                    {option.label}
                                  </option>
                                ))}
                              </select>
                            </label>
                          ) : null}
                          <label className="flex items-center gap-2 self-end pb-1">
                            <input
                              type="checkbox"
                              checked={draft.vision}
                              aria-label="接受图片输入"
                              onChange={(event) =>
                                setDraft({ ...draft, vision: event.target.checked })
                              }
                            />
                            <span className="text-ui-sm">接受图片输入</span>
                          </label>
                          <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
                            <Button
                              type="button"
                              size="sm" variant="primary"
                              busy={saving}
                              disabled={!cliReady || !dirty}
                              onClick={() => void save(row)}
                            >
                              {saving ? "保存中…" : "保存"}
                            </Button>
                            {canTestModel(row.id) && (
                              <>
                                <Button
                                  type="button"
                                  size="sm" variant="ghost"
                                  disabled={!cliReady || testingAs !== null}
                                  aria-label={`按 Codex 测试 ${row.id}`}
                                  onClick={() => void testModelAs(row, "codex")}
                                >
                                  {testingAs === `${row.id}:codex` ? "测试中…" : "按 Codex 测试"}
                                </Button>
                                <Button
                                  type="button"
                                  size="sm" variant="ghost"
                                  disabled={!cliReady || testingAs !== null}
                                  aria-label={`按 Claude Code 测试 ${row.id}`}
                                  onClick={() => void testModelAs(row, "claude-code")}
                                >
                                  {testingAs === `${row.id}:claude-code`
                                    ? "测试中…"
                                    : "按 Claude Code 测试"}
                                </Button>
                              </>
                            )}
                            <Button
                              type="button"
                              size="sm" variant="danger"
                              disabled={!cliReady || saving}
                              onClick={() => setConfirm({ kind: "disable", row })}
                            >
                              禁用模型
                            </Button>
                            <Button
                              type="button"
                              size="sm" variant="ghost"
                              onClick={closeEditor}
                            >
                              取消
                            </Button>
                          </div>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))
        )}
      </div>

      <details className="ui-disclosure ui-card p-4">
        <summary className="cursor-pointer text-ui-md font-semibold">
          <ChevronIcon width={14} height={14} className="ui-disclosure-chevron" />
          已禁用的模型（{disabled.length}）
        </summary>
        <p className="mt-2 ui-caption">
          被禁用的模型不会接到请求：请求经过和鸣网关时，它不在可选范围内。随时可以启用。
        </p>
        {disabled.length === 0 ? (
          <p className="mt-2 ui-caption">
            没有禁用任何模型。每个模型右边的「禁用模型」可以关掉一个。
          </p>
        ) : (
          <ul className="mt-1 divide-y divide-line">
            {disabled.map((item) => (
              <li key={item.pattern} className="flex flex-wrap items-center gap-2 py-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-ui-sm">{item.pattern}</span>
                  <span className="block truncate ui-caption">
                    {item.hits.length
                      ? `现在关掉：${item.hits.join("、")}`
                      : "现在没有模型命中这个规则"}
                  </span>
                </span>
                <Button
                  type="button"
                  size="sm" variant="ghost"
                  disabled={!cliReady}
                  aria-label={`启用模型 ${item.pattern}`}
                  onClick={() => setConfirm({ kind: "enable", pattern: item.pattern, hits: item.hits })}
                >
                  启用
                </Button>
              </li>
            ))}
          </ul>
        )}
      </details>

      {confirm && (
        <ConfirmDialog
          title={confirm.kind === "disable" ? "禁用模型？" : "启用模型？"}
          onCancel={() => setConfirm(null)}
          footer={
            <>
              <Button type="button" size="sm" variant="ghost" onClick={() => setConfirm(null)}>
                取消
              </Button>
              <Button
                type="button"
                size="sm"
                variant={confirm.kind === "disable" ? "danger" : "primary"}
                onClick={() => {
                  const pending = confirm;
                  setConfirm(null);
                  if (pending.kind === "disable") {
                    void (async () => {
                      await onRun("禁用模型", ["model", "disable", pending.row.id], {
                        refresh: true,
                      });
                      closeEditor();
                    })();
                  } else {
                    void onRun("启用模型", ["model", "enable", pending.pattern], { refresh: true });
                  }
                }}
              >
                {confirm.kind === "disable" ? "禁用" : "启用"}
              </Button>
            </>
          }
        >
          <p>
            {confirm.kind === "disable"
              ? `禁用后，请求经过和鸣网关时不再交给 ${confirm.row.name || confirm.row.id}（${confirm.row.id}）。随时可以再启用。`
              : `启用后，${confirm.pattern} 关掉的模型会重新可选${
                  confirm.hits.length ? `（${confirm.hits.join("、")}）` : ""
                }。`}
          </p>
        </ConfirmDialog>
      )}

      {bulkAsking && (
        <ConfirmDialog
          title="测试全部模型？"
          onCancel={() => setBulkAsking(false)}
          footer={
            <>
              <Button type="button" size="sm" variant="ghost" onClick={() => setBulkAsking(false)}>
                取消
              </Button>
              <Button type="button" size="sm" variant="primary" onClick={() => void testAll()}>
                开始测试
              </Button>
            </>
          }
        >
          <p>
            每个模型都会真的发一次请求，按厂商的价格计费，可能要等一会儿。名字后面写着「路由组」「自动路由」
            的模型由网关挑成员，不在这里单独测。
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
