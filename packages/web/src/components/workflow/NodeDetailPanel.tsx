/**
 * 节点详情面板：参数表单 + 节点级设置 + 输入/输出数据 + 「执行此节点」。
 *
 * 为什么把「节点级设置」和「参数」分两块：参数是**节点的业务配置**（URL、字段映射），
 * 节点级设置是**引擎行为**（重试、失败分流、禁用、固定数据）。混在一起用户会
 * 在「这个开关到底影响哪一步」上困惑。分区标题让两者一眼可分。
 *
 * 输入/输出数据来自最近一次包含该节点的执行记录（引擎的 runData 只存输出，
 * 输入由上游节点输出推导）。没有执行记录时明确说「先运行一次」而不是显示空白。
 */

import { useEffect, useMemo, useState } from "react";
import { nodeProperties } from "../../lib/workflow/model.js";
import type {
  Item,
  NodeRunData,
  Workflow,
  WorkflowExecution,
  WorkflowNode,
} from "../../lib/workflow/types.js";
import { useWorkflowCredentialsStore } from "../../lib/workflow/credentials.js";
import { getNodeType } from "../../lib/workflow/registry.js";
import { Switch } from "../plugins/shared.js";
import { XIcon } from "../icons.js";
import { DataPreview } from "./DataPreview.js";
import { ParameterForm, parameterErrors } from "./ParameterForm.js";
import { collectRunInputItems } from "./ExecutionsPanel.js";

export interface NodeDetailPanelProps {
  workflow: Workflow;
  node: WorkflowNode;
  /** 该节点最近一次执行里的运行记录（可能多次）。 */
  runData?: NodeRunData[];
  /** 最近一次包含该节点的执行（取输入数据用）。 */
  execution?: WorkflowExecution | null;
  onChange: (patch: Partial<WorkflowNode>) => void;
  onClose: () => void;
  /** 部分执行：只跑这个节点（上游输入沿用最近一次执行）。 */
  onRunNode?: () => void;
  running?: boolean;
  disabled?: boolean;
}

type IoView = "input" | "output";

export function NodeDetailPanel({
  workflow,
  node,
  runData = [],
  execution,
  onChange,
  onClose,
  onRunNode,
  running = false,
  disabled = false,
}: NodeDetailPanelProps) {
  const description = getNodeType(node.type)?.description;
  const credentials = useWorkflowCredentialsStore((state) => state.credentials);
  const [ioView, setIoView] = useState<IoView>("output");
  const [pinText, setPinText] = useState("");
  const [pinError, setPinError] = useState("");
  const [credentialToAdd, setCredentialToAdd] = useState("");

  // 切换节点时重置本地编辑态（固定数据/凭据选择不该跟着上一个节点走）
  useEffect(() => {
    setPinText(node.pinData ? JSON.stringify(node.pinData, null, 2) : "");
    setPinError("");
    setCredentialToAdd("");
    setIoView("output");
    // 只依赖节点 id：同一节点参数变化不该覆盖用户正在编辑的固定数据
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id]);

  const inputItems = useMemo(() => collectRunInputItems(execution, node.id), [execution, node.id]);
  const latestRun = runData[runData.length - 1];
  const outputItems: Item[] = useMemo(() => {
    const main = latestRun?.data?.main ?? [];
    const merged: Item[] = [];
    for (const list of main) merged.push(...(list ?? []));
    return merged;
  }, [latestRun]);
  const requiredErrors = parameterErrors(node);
  const credentialEntries = Object.entries(node.credentials ?? {});

  function applyPin(): void {
    if (!pinText.trim()) {
      onChange({ pinData: undefined });
      setPinError("");
      return;
    }
    try {
      const parsed: unknown = JSON.parse(pinText);
      if (!Array.isArray(parsed)) {
        setPinError("固定数据必须是 JSON 数组，例如 [{ \"json\": { \"字段\": \"值\" } }]");
        return;
      }
      const items: Item[] = parsed.map((entry) =>
        typeof entry === "object" && entry !== null && "json" in entry
          ? (entry as Item)
          : { json: (entry ?? {}) as Record<string, unknown> },
      );
      onChange({ pinData: items });
      setPinError("");
    } catch {
      setPinError("JSON 格式有误，请检查括号、引号与逗号");
    }
  }

  return (
    <aside
      aria-label={`节点详情：${node.name}`}
      className="flex h-full w-[340px] shrink-0 flex-col border-l border-line-soft bg-white"
    >
      <div className="flex shrink-0 items-start justify-between gap-2 border-b border-line-soft px-3 py-2">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-medium">{node.name}</p>
          <p className="ui-caption">
            {description?.displayName ?? node.type} · {node.type}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭节点详情"
          className="shrink-0 rounded-sm p-1 text-muted hover:bg-[#f0f0f0] hover:text-ink"
        >
          <XIcon width={16} height={16} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <div className="flex flex-col gap-4">
          <section aria-label="节点名称">
            <label htmlFor={`wf-node-name-${node.id}`} className="ui-caption mb-1 block font-medium text-ink">
              节点名称
            </label>
            <input
              id={`wf-node-name-${node.id}`}
              value={node.name}
              disabled={disabled}
              onChange={(event) => onChange({ name: event.target.value })}
              className="ui-input w-full text-[12px]"
            />
            <p className="ui-caption mt-1">同一工作流内不能重名；表达式里用这个名字引用节点。</p>
          </section>

          {description?.description ? (
            <p className="rounded-lg border border-line-soft bg-[color:var(--panel)] px-2 py-1.5 ui-caption">
              {description.description}
            </p>
          ) : null}

          <section aria-label="参数">
            <h3 className="ui-section-title mb-2">参数</h3>
            <ParameterForm
              node={node}
              parameters={node.parameters ?? {}}
              onChange={(parameters) => onChange({ parameters })}
              disabled={disabled}
              errors={requiredErrors}
            />
          </section>

          <section aria-label="节点设置">
            <h3 className="ui-section-title mb-2">节点设置</h3>
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <span className="ui-caption">禁用（运行时跳过本节点）</span>
                <Switch
                  label="禁用节点"
                  checked={node.disabled === true}
                  disabled={disabled}
                  onChange={(next) => onChange({ disabled: next })}
                />
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="ui-caption">失败时重试</span>
                <Switch
                  label="失败时重试"
                  checked={node.retryOnFail === true}
                  disabled={disabled}
                  onChange={(next) => onChange({ retryOnFail: next })}
                />
              </div>
              {node.retryOnFail ? (
                <div className="grid grid-cols-2 gap-2">
                  <label className="ui-caption">
                    最多尝试
                    <input
                      type="number"
                      min={2}
                      max={5}
                      value={node.maxTries ?? 3}
                      disabled={disabled}
                      onChange={(event) =>
                        onChange({ maxTries: Math.min(5, Math.max(2, Number(event.target.value) || 3)) })
                      }
                      className="ui-input mt-1 w-full"
                    />
                  </label>
                  <label className="ui-caption">
                    间隔（毫秒）
                    <input
                      type="number"
                      min={0}
                      max={5000}
                      step={100}
                      value={node.waitBetweenTries ?? 1000}
                      disabled={disabled}
                      onChange={(event) =>
                        onChange({
                          waitBetweenTries: Math.min(5000, Math.max(0, Number(event.target.value) || 0)),
                        })
                      }
                      className="ui-input mt-1 w-full"
                    />
                  </label>
                </div>
              ) : null}
              <label className="ui-caption">
                失败处理
                <select
                  value={node.onError ?? "stopWorkflow"}
                  disabled={disabled}
                  onChange={(event) =>
                    onChange({
                      onError: event.target.value as WorkflowNode["onError"],
                    })
                  }
                  className="ui-input mt-1 w-full"
                >
                  <option value="stopWorkflow">停止工作流（默认）</option>
                  <option value="continueRegularOutput">继续，按正常输出透传</option>
                  <option value="continueErrorOutput">继续，错误项走错误输出</option>
                </select>
              </label>
              <div className="flex items-center justify-between gap-2">
                <span className="ui-caption">只运行一次（把全部输入一次交给节点）</span>
                <Switch
                  label="只运行一次"
                  checked={node.executeOnce === true}
                  disabled={disabled}
                  onChange={(next) => onChange({ executeOnce: next })}
                />
              </div>
              <label className="ui-caption">
                备注（画布上可查看）
                <textarea
                  value={node.notes ?? ""}
                  rows={2}
                  disabled={disabled}
                  onChange={(event) => onChange({ notes: event.target.value })}
                  className="ui-input mt-1 w-full text-[12px]"
                />
              </label>
            </div>
          </section>

          <section aria-label="凭据">
            <h3 className="ui-section-title mb-2">凭据</h3>
            {credentialEntries.length === 0 ? (
              <p className="ui-caption">没有绑定凭据。需要认证的节点请在「凭据」页新建后在这里选择。</p>
            ) : (
              <ul className="mb-2 flex flex-col gap-1">
                {credentialEntries.map(([type, id]) => {
                  const record = credentials.find((item) => item.id === id);
                  return (
                    <li key={type} className="flex items-center justify-between gap-2 rounded-sm border border-line-soft px-2 py-1 text-[12px]">
                      <span className="min-w-0 truncate">
                        {type} → {record?.name ?? id}
                      </span>
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => {
                          const next = { ...(node.credentials ?? {}) };
                          delete next[type];
                          onChange({ credentials: Object.keys(next).length > 0 ? next : undefined });
                        }}
                        className="shrink-0 text-[11px] text-[#b42318] hover:underline"
                      >
                        移除
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="flex gap-1">
              <select
                aria-label="选择要绑定的凭据"
                value={credentialToAdd}
                disabled={disabled || credentials.length === 0}
                onChange={(event) => setCredentialToAdd(event.target.value)}
                className="ui-input min-w-0 flex-1 text-[12px]"
              >
                <option value="">{credentials.length === 0 ? "还没有凭据" : "选择凭据"}</option>
                {credentials.map((record) => (
                  <option key={record.id} value={record.id}>
                    {record.name}（{record.type}）
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={disabled || !credentialToAdd}
                onClick={() => {
                  const record = credentials.find((item) => item.id === credentialToAdd);
                  if (!record) return;
                  onChange({
                    credentials: { ...(node.credentials ?? {}), [record.type]: record.id },
                  });
                  setCredentialToAdd("");
                }}
                className="ui-btn ui-btn-sm ui-btn-ghost"
              >
                绑定
              </button>
            </div>
          </section>

          <section aria-label="固定数据">
            <h3 className="ui-section-title mb-2">固定数据（pinData）</h3>
            <p className="ui-caption mb-1">
              有固定数据时本节点不执行、直接输出这里的内容，用于调试下游节点。
            </p>
            <textarea
              value={pinText}
              rows={5}
              disabled={disabled}
              placeholder={'[{ "json": { "字段": "值" } }]'}
              aria-label="固定数据 JSON"
              onChange={(event) => setPinText(event.target.value)}
              className="ui-input w-full font-mono text-[11px] leading-5"
            />
            {pinError ? (
              <p role="alert" className="mt-1 ui-body-sm text-[#b42318]">
                {pinError}
              </p>
            ) : null}
            <div className="mt-1 flex gap-1">
              <button type="button" disabled={disabled} onClick={applyPin} className="ui-btn ui-btn-sm ui-btn-ghost">
                应用固定数据
              </button>
              <button
                type="button"
                disabled={disabled || !node.pinData}
                onClick={() => {
                  setPinText("");
                  onChange({ pinData: undefined });
                }}
                className="ui-btn ui-btn-sm ui-btn-ghost"
              >
                清除
              </button>
              {node.pinData ? <span className="ui-chip self-center">已固定 {node.pinData.length} 条</span> : null}
            </div>
          </section>

          <section aria-label="输入输出数据">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="ui-section-title">数据</h3>
              <div role="group" aria-label="输入或输出" className="flex gap-1">
                {(
                  [
                    ["input", `输入（${inputItems.length}）`],
                    ["output", `输出（${outputItems.length}）`],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={ioView === key}
                    onClick={() => setIoView(key)}
                    className={`rounded-sm border px-1.5 py-0.5 text-[11px] ${
                      ioView === key
                        ? "border-[color:var(--line)] bg-[color:var(--panel)] font-medium"
                        : "border-transparent text-muted hover:bg-[#f5f5f5]"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            {!execution ? (
              <p className="ui-caption">还没有执行记录。运行一次工作流后，这里会显示每个节点的输入输出。</p>
            ) : ioView === "input" ? (
              <DataPreview data={inputItems} compact emptyText="没有上游输入（可能是触发节点）。" />
            ) : (
              <DataPreview
                data={outputItems}
                compact
                emptyText="这个节点最近一次运行没有输出，或工作流设置成不保存执行数据。"
              />
            )}
          </section>

          <div className="flex items-center justify-between gap-2 border-t border-line-soft pt-2">
            <button
              type="button"
              onClick={onRunNode}
              disabled={disabled || running || !onRunNode}
              className="ui-btn ui-btn-sm ui-btn-primary"
            >
              {running ? "正在执行…" : "执行此节点"}
            </button>
            <span className="ui-caption">
              {latestRun ? `最近一次：${latestRun.status === "error" ? "失败" : "成功"}` : "尚未运行"}
            </span>
          </div>
        </div>
      </div>
      <p className="shrink-0 border-t border-line-soft px-3 py-1 ui-caption">
        工作流：{workflow.name} · 共 {nodeProperties(node).length} 个参数
      </p>
    </aside>
  );
}
