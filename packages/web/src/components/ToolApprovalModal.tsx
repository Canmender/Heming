import { useEffect, useRef, useState } from "react";
import type { HitlCall, HitlVerdict } from "../lib/hitl/types.js";
import { buildChangePreview, changeCountLabel } from "../lib/hitl/preview.js";
import {
  PATCH_PREVIEW_MAX_LINES,
  buildPatchPreview,
  type PatchPreview,
} from "../lib/fileEdit/patchPreview.js";
import { canRememberCall, prefixesOfCall } from "../lib/fileEdit/remember.js";
import { isFileWriteTool } from "../lib/fileEdit/ruleTargets.js";
import { toolNameLabel } from "../lib/toolName.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { Button } from "./ui/Button.js";

/**
 * 工具调用确认弹窗（内容区）。
 *
 * 骨架（遮罩/Esc/焦点）在 `ConfirmDialog` 里；这里只管「这次调用要不要做」。
 *
 * 设计口径：
 * - 打开时焦点落在**拒绝**上（安全默认：误放行的代价远大于误拒绝）；
 * - 只读项（已自动放行）折叠在单独一区，**不可勾选**——它们已经放行了，
 *   摆在那里只是让用户知道「这一轮还干了这些」；
 * - 写操作默认**不勾**：默认动作是「什么都不做」；
 * - 危险操作红色高亮并显示参数摘要（用户得看清要动什么）。
 */
export interface ToolApprovalModalProps {
  requestId: string;
  /** 需要用户裁决的调用。 */
  calls: HitlCall[];
  /** 已自动放行的只读调用（折叠展示）。 */
  auto?: HitlCall[];
  /** 智能体名（标题里说明是谁要调）。 */
  agentName?: string;
  /**
   * 请求来自其他会话时的会话名。
   *
   * 后台会话的流可能在本会话界面里弹确认；不标归属，用户会把 A 会话的
   * 工具调用当成 B 会话的动作。
   */
  conversationLabel?: string;
  /** 跳到发起请求的会话（仅跨会话时提供）。 */
  onOpenConversation?: () => void;
  /** 给出裁决。 */
  onDecide: (verdicts: HitlVerdict[]) => void;
  /**
   * 补丁预览器（缺省读桌面文件桥）。
   *
   * 抽成可注入的：确认卡的「行级 diff」要读用户的真实文件，
   * 单测里用假实现就能覆盖渲染分支，不必在 jsdom 里搭一个假文件系统。
   */
  patchPreviewer?: (argsJson: string) => Promise<PatchPreview | null>;
}

const RISK_LABEL: Record<HitlCall["risk"], string> = {
  read: "只读",
  write: "写入",
  danger: "危险",
};

export function ToolApprovalModal({
  requestId,
  calls,
  auto = [],
  agentName,
  conversationLabel,
  onOpenConversation,
  onDecide,
  patchPreviewer,
}: ToolApprovalModalProps) {
  // 默认不勾任何一项：默认动作是「什么都不做」。
  // 用无原型对象：call id 来自工具/模型，可能是 "toString"/"constructor" 之类 Object.prototype
  // 上的键名；普通 {} 的 `checked[id]` 会读到继承的函数而误判为「已勾选」，绕开默认拒绝。
  const [checked, setChecked] = useState<Record<string, boolean>>(() => Object.create(null));
  // 「记住」默认关闭：它会把一次决定变成长期规则。
  const [remember, setRemember] = useState(false);
  const denyRef = useRef<HTMLButtonElement>(null);

  // 确认弹窗在排队批次之间被 React 复用（hitl store 同步换 pending、调用方没给 key）：
  // 新一批请求必须重新开始——上一批勾的选项和「记住」不能带到下一批，否则一次勾的
  // 「记住」会变成下一批的长期规则。按 requestId 变化重置，局限在本文件内（调用方是脏文件）。
  useEffect(() => {
    setChecked(Object.create(null));
    setRemember(false);
  }, [requestId]);

  /*
   * 「记住本次选择」只对**能归纳出路径前缀**的文件补丁显示：
   * 目标在可写根之外时记不了（也不该记成 `*`），此时藏掉复选框——
   * 勾了没反应比不显示更糟。
   */
  const rememberable = calls.every((call) => canRememberCall(call));
  /** 将要记住的目录前缀（文件工具），在复选框下面明确告诉用户。 */
  const rememberPrefixes = rememberable
    ? [...new Set(calls.flatMap((call) => prefixesOfCall(call)))]
    : [];
  /*
   * 本批里有文件写工具（file_patch / file_write / file_edit）时不提供
   * 「本会话内允许此工具」：那是**整个工具**的授权，而文件编辑只接受按目录前缀的
   * 授权（规格 §7）。留着这个按钮就是「点了没反应」——比不显示更糟。
   * 用 isFileWriteTool 而不是逐个工具名：新增写工具时不会漏掉这条红线。
   */
  const hasPathWrite = calls.some((call) => isFileWriteTool(call.name));

  const toggle = (id: string) =>
    setChecked((prev) => {
      // 保持无原型：{...prev} 会落回 Object.prototype， prototype 键名又会误判为已勾选。
      const next: Record<string, boolean> = Object.assign(Object.create(null), prev);
      next[id] = !prev[id];
      return next;
    });

  /** 拒绝全部：逐项给出 deny，闸门据此不执行它们。 */
  const denyAll = () => {
    onDecide(
      calls.map((c) => ({
        callId: c.id,
        decision: "deny" as const,
        reason: "用户拒绝",
        ...(remember ? { remember: true } : {}),
      })),
    );
  };

  /**
   * 允许选中项：只给**勾上的**项放行，没勾的一律按拒绝——
   * 「允许」必须指明允许的是哪几项，剩下的是没被允许的。
   *
   * 「记住」只跟随**主动裁决**：勾上的允许项，以及「拒绝」按钮给出的拒绝项。
   * 「仅本次允许」里没勾的项只是「没选」，不该被记成拒绝规则。
   */
  const allowChecked = (decision: "allow" | "allow-session") => {
    onDecide(
      calls.map((c) =>
        checked[c.id]
          ? { callId: c.id, decision, ...(remember ? { remember: true } : {}) }
          : { callId: c.id, decision: "deny" as const, reason: "未勾选" },
      ),
    );
  };

  /*
   * 2026-11-14 审计 E2（⚠️ 误操作风险）：
   *
   * 旧版默认一项不勾、主按钮却写「仅本次允许」——0 项勾选时点它 = 全部拒绝，
   * 用户以为放行了、实际被拒，唯一的解释是按钮上方那行 11px 灰字。现在：
   *   · 主按钮文案带实时勾选数「允许选中（N）」，N=0 时**禁用**（禁用比拒绝更诚实：
   *     它明确表示「现在这个动作还做不了」，而不是点下去变成一次拒绝）；
   *   · 「本会话内允许所选」同样按所选生效，0 项时一并禁用；
   *   · 拒绝按钮独立成「全部拒绝」，语义与 decision 一致（它确实拒绝全部）。
   * 勾选数同时进被测文案，单测可以直接断言「默认 0 项 → 主按钮不可用」。
   */
  const checkedCount = calls.reduce((n, c) => (checked[c.id] ? n + 1 : n), 0);

  const footer = (
    <div className="flex w-full flex-col gap-1.5">
      {/*
        勾选语义放在按钮正上方（footer 固定、不随内容区滚动）：调用多时提示不会被滚出视野。
        写操作默认不勾、允许只放行勾选项——这条规则不说出来，用户会以为「点了允许却被拒绝」。
      */}
      {calls.length > 0 && (
        <p className="text-ui-sm text-body" role="status" aria-live="polite">
          先勾选要放行的调用；没勾的会按拒绝处理。已勾选 {checkedCount} / {calls.length} 项。
        </p>
      )}
      <div className="flex w-full flex-wrap items-center justify-end gap-2">
        {/* d.138 危险语义归位：此前「拒绝」是 md 红字（全页最显眼的按钮），
            「仅本次允许」反而是 sm 次级——安全动作看起来比放行更危险，主次是反的。
            现在两者同尺寸：放行是 primary，拒绝是 ghost（不再染红——拒绝不是破坏性操作）。 */}
        <Button ref={denyRef} variant="ghost" onClick={denyAll}>
          全部拒绝
        </Button>
        {!hasPathWrite && (
          <Button
            variant="ghost"
            disabled={checkedCount === 0}
            title={checkedCount === 0 ? "先勾选要放行的调用" : undefined}
            onClick={() => allowChecked("allow-session")}
          >
            本会话内允许所选
          </Button>
        )}
        <Button
          variant="primary"
          disabled={checkedCount === 0}
          title={checkedCount === 0 ? "先勾选要放行的调用" : undefined}
          onClick={() => allowChecked("allow")}
        >
          允许选中（{checkedCount}）
        </Button>
      </div>
    </div>
  );

  return (
    <ConfirmDialog
      title={`${agentName ? `${agentName} ` : ""}请求调用工具`}
      onCancel={denyAll}
      initialFocusRef={denyRef}
      footer={footer}
    >
      <div className="flex flex-col gap-2">
        {conversationLabel && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line-soft bg-subtle-2 px-2.5 py-1.5 ui-caption">
            <span className="min-w-0 flex-1">请求来自会话「{conversationLabel}」</span>
            {onOpenConversation && (
              <button
                type="button"
                onClick={onOpenConversation}
                className="rounded-sm border border-line bg-surface px-2 py-0.5 text-ui-xs text-body hover:bg-subtle-2"
              >
                回到该会话
              </button>
            )}
          </div>
        )}
        {calls.length === 0 && <div className="text-ui-md text-muted">没有待确认的调用。</div>}
        {calls.map((call) => {
          // file_patch 的补丁要读多份真实文件，走异步预览面板；
          // file_write / file_edit 的参数里已带新内容/替换点，同步预览就够（不读盘）。
          const isPatch = call.name === "file_patch";
          const preview = isPatch ? null : buildChangePreview(call.name, call.argsJson);
          return (
            <div
              key={call.id}
              className={`rounded-lg border px-2.5 py-2 ${
                call.risk === "danger" ? "border-danger-line bg-danger-soft" : "border-line"
              }`}
            >
              <div className="flex items-start gap-2">
                <input
                  id={`hitl-allow-${call.id}`}
                  type="checkbox"
                  aria-label={`允许 ${call.displayName}`}
                  checked={Boolean(checked[call.id])}
                  onChange={() => toggle(call.id)}
                  className="mt-0.5"
                />
                <div className="min-w-0 flex-1">
                  <label
                    htmlFor={`hitl-allow-${call.id}`}
                    className="flex cursor-pointer flex-wrap items-center gap-1.5"
                  >
                    <span className="ui-section-title">{call.displayName}</span>
                    <span
                      className={`rounded-sm px-1 text-ui-xs ${
                        call.risk === "danger"
                          ? "bg-danger text-danger-on"
                          : call.risk === "write"
                            ? "bg-warn-soft text-warn"
                            : "bg-subtle-3 text-muted"
                      }`}
                    >
                      {RISK_LABEL[call.risk]}
                    </span>
                    <span className="font-mono text-ui-xs text-muted" title={call.name}>
                      {/* MCP 工具名是 `服务__工具` 的内部命名：展示成「服务 · 工具」，
                          原文留在 title 供排障 */}
                      {toolNameLabel(call.name)}
                    </span>
                  </label>
                  {call.summary ? (
                    <div className="mt-0.5 break-all ui-caption">{call.summary}</div>
                  ) : null}
                  {isPatch ? (
                    <FilePatchPreviewPanel argsJson={call.argsJson} previewer={patchPreviewer} />
                  ) : preview ? (
                    <details className="mt-1 rounded-md border border-line-soft bg-surface">
                      <summary
                        className="cursor-pointer px-2 py-1 text-ui-xs text-muted"
                        title={preview.path}
                      >
                        查看变更（{changeCountLabel(preview)}）
                        {preview.path ? ` · ${preview.path}` : ""}
                      </summary>
                      <pre className="max-h-56 overflow-auto border-t border-line-soft px-2 py-1.5 font-mono text-ui-xs leading-4">
                        {preview.lines.map((line, i) => (
                          <div
                            key={i}
                            className={
                              line.kind === "add"
                                ? "bg-success-soft text-success"
                                : line.kind === "del"
                                  ? "bg-danger-soft text-danger"
                                  : "text-muted"
                            }
                          >
                            {line.kind === "add" ? "+ " : line.kind === "del" ? "− " : "  "}
                            {line.text || " "}
                          </div>
                        ))}
                        {preview.truncated && (
                          <div className="pt-1 text-muted">…（预览已截断）</div>
                        )}
                      </pre>
                      {preview.kind === "delete" && (
                        <div className="border-t border-line-soft px-2 py-1 text-ui-xs text-warn">
                          删除不可撤销；这里只显示目标路径，不读取文件内容。
                        </div>
                      )}
                    </details>
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}

        {auto.length > 0 && (
          <details className="rounded-lg border border-line-soft px-2.5 py-2">
            <summary className="cursor-pointer list-none ui-caption">
              只读工具（已自动放行，{auto.length} 项）
            </summary>
            <ul className="mt-1.5 flex flex-col gap-1">
              {auto.map((call) => (
                <li key={call.id} className="ui-caption">
                  <span className="font-mono" title={call.name}>{toolNameLabel(call.name)}</span>
                  {call.summary ? ` · ${call.summary}` : ""}
                </li>
              ))}
            </ul>
          </details>
        )}

        {/*
          「记住本次选择」：
          - 普通工具按「工具 + 资源」记；
          - 文件工具（file_patch / file_write / file_edit / file_read / file_glob / file_grep）
            只能按**目录前缀**记（整工具放行是红线），
            且目标不在可写根内时**不显示**这个复选框——勾了也不会生效。
        */}
        {rememberable ? (
          <label className="mt-1 flex cursor-pointer items-start gap-2 ui-caption">
            <input
              type="checkbox"
              aria-label="记住本次选择"
              checked={remember}
              onChange={() => setRemember((v) => !v)}
              className="mt-0.5"
            />
            <span>
              记住本次选择（按工具与资源）
              {rememberPrefixes.length > 0 && (
                <span className="block font-mono text-ui-xs text-muted">
                  将记住目录：{rememberPrefixes.join("、")}
                </span>
              )}
              <span className="block text-ui-xs text-muted">
                文件编辑只按目录前缀授权，不会放行整个工具；危险操作不受记住的允许影响，
                仍会每次询问；可在设置区一键清空。
              </span>
            </span>
          </label>
        ) : (
          <div className="mt-1 rounded-lg border border-line-soft bg-subtle-2 px-2.5 py-1.5 text-ui-xs text-muted">
            这次改动无法按目录记住（目标不在已配置的可写根内），本次不会落任何授权规则。
            「会话工作区」里的文件默认仍可读写；若想在这个目录以后都免问，请到设置区「文件编辑」
            把它加成可写根。
          </div>
        )}
      </div>
    </ConfirmDialog>
  );
}

/**
 * 补丁预览面板：异步读盘 + 干跑，把「将修改 N 个文件（A/M/D）」与行级 diff 摆出来。
 *
 * 为什么异步：确认卡出现在**工具执行之前**，而 diff 需要文件当前内容。
 * 读盘是只读操作，且失败只影响预览（用 error 行提示），不该阻塞审批。
 *
 * 脱敏与截断在 `buildPatchPreview` 里做（那边是纯逻辑，可单测）；
 * 这里只负责渲染，不打印任何内容到控制台。
 */
function FilePatchPreviewPanel({
  argsJson,
  previewer,
}: {
  argsJson: string;
  previewer?: (argsJson: string) => Promise<PatchPreview | null>;
}) {
  const [preview, setPreview] = useState<PatchPreview | null | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    setPreview(undefined);
    const run = previewer ?? ((args: string) => buildPatchPreview(args));
    run(argsJson)
      .then((result) => {
        if (alive) setPreview(result);
      })
      .catch(() => {
        if (alive) setPreview(null);
      });
    return () => {
      alive = false;
    };
  }, [argsJson, previewer]);

  if (preview === undefined) {
    return <div className="mt-1 text-ui-xs text-muted">正在生成变更预览…</div>;
  }
  if (preview === null) return null;
  if (preview.error) {
    return (
      <div className="mt-1 rounded-md border border-danger-line bg-danger-soft px-2 py-1 text-ui-xs text-danger">
        {preview.error}
      </div>
    );
  }

  return (
    <details className="mt-1 rounded-md border border-line-soft bg-surface" open>
      <summary className="cursor-pointer px-2 py-1 text-ui-xs text-muted">
        查看变更（{preview.summary}）
      </summary>
      <div className="max-h-56 overflow-auto border-t border-line-soft px-2 py-1.5 font-mono text-ui-xs leading-4">
        {preview.files.map((file) => (
          <div key={file.rel} className="mb-1 last:mb-0">
            <div className="text-body">
              <span className="font-semibold">{file.kind}</span> {file.rel}
              {file.movedFrom ? `（由 ${file.movedFrom} 改名）` : ""}
              <span className="ml-1 text-muted">
                +{file.added} −{file.removed}
              </span>
            </div>
            {file.lines.map((line, i) => (
              <div
                key={i}
                className={
                  line.kind === "add"
                    ? "bg-success-soft text-success"
                    : line.kind === "del"
                      ? "bg-danger-soft text-danger"
                      : "text-muted"
                }
              >
                {line.kind === "add" ? "+ " : line.kind === "del" ? "− " : "  "}
                {line.text || " "}
              </div>
            ))}
            {file.truncated && <div className="pt-0.5 text-muted">…（该文件预览已截断）</div>}
          </div>
        ))}
        {preview.truncated && (
          <div className="pt-1 text-muted">
            …（预览超过 {PATCH_PREVIEW_MAX_LINES} 行，已截断；确认前可在设置区缩小改动范围）
          </div>
        )}
      </div>
    </details>
  );
}
