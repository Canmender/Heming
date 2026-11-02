import { useEffect, useRef, useState } from "react";
import type { HitlCall, HitlVerdict } from "../lib/hitl/types.js";
import { buildChangePreview, changeCountLabel } from "../lib/hitl/preview.js";
import {
  PATCH_PREVIEW_MAX_LINES,
  buildPatchPreview,
  type PatchPreview,
} from "../lib/fileEdit/patchPreview.js";
import { canRememberCall, prefixesOfCall } from "../lib/fileEdit/remember.js";
import { ConfirmDialog } from "./ConfirmDialog.js";

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
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  // 「记住」默认关闭：它会把一次决定变成长期规则。
  const [remember, setRemember] = useState(false);
  const denyRef = useRef<HTMLButtonElement>(null);

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
   * 本批里有 file_patch 时不提供「本会话内允许此工具」：
   * 那是**整个工具**的授权，而文件编辑只接受按目录前缀的授权（规格 §7）。
   * 留着这个按钮就是「点了没反应」——比不显示更糟。
   */
  const hasPatch = calls.some((call) => call.name === "file_patch");

  const toggle = (id: string) =>
    setChecked((prev) => ({ ...prev, [id]: !prev[id] }));

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

  const footer = (
    <>
      <button
        type="button"
        ref={denyRef}
        onClick={denyAll}
        className="rounded-lg border border-line px-3 py-1.5 text-[12px] text-red-600 shadow-card hover:bg-[#fafafa]"
      >
        拒绝
      </button>
      {!hasPatch && (
        <button
          type="button"
          onClick={() => allowChecked("allow-session")}
          className="rounded-lg border border-line px-3 py-1.5 text-[12px] shadow-card hover:bg-[#fafafa]"
        >
          本会话内允许此工具
        </button>
      )}
      <button
        type="button"
        onClick={() => allowChecked("allow")}
        className="rounded-lg bg-ink px-3 py-1.5 text-[12px] font-bold text-white"
      >
        仅本次允许
      </button>
    </>
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
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line-soft bg-[#fafafa] px-2.5 py-1.5 text-[11px] text-muted">
            <span className="min-w-0 flex-1">请求来自会话「{conversationLabel}」</span>
            {onOpenConversation && (
              <button
                type="button"
                onClick={onOpenConversation}
                className="rounded-sm border border-line bg-white px-2 py-0.5 text-[10px] text-[#555] hover:bg-[#f5f5f5]"
              >
                回到该会话
              </button>
            )}
          </div>
        )}
        {calls.length === 0 && <div className="text-[13px] text-muted">没有待确认的调用。</div>}
        {calls.map((call) => {
          const isPatch = call.name === "file_patch";
          const preview = isPatch ? null : buildChangePreview(call.name, call.argsJson);
          return (
            <div
              key={call.id}
              className={`rounded-lg border px-2.5 py-2 ${
                call.risk === "danger" ? "border-[#f3c2bd] bg-[#fdf6f6]" : "border-line"
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
                    <span className="text-[13px] font-bold">{call.displayName}</span>
                    <span
                      className={`rounded-sm px-1 text-[10px] ${
                        call.risk === "danger"
                          ? "bg-[#b42318] text-white"
                          : call.risk === "write"
                            ? "bg-[#f3f0e6] text-[#8a6d1f]"
                            : "bg-[#f0f0f0] text-muted"
                      }`}
                    >
                      {RISK_LABEL[call.risk]}
                    </span>
                    <span className="font-mono text-[10px] text-muted">{call.name}</span>
                  </label>
                  {call.summary ? (
                    <div className="mt-0.5 break-all text-[11px] text-muted">{call.summary}</div>
                  ) : null}
                  {isPatch ? (
                    <FilePatchPreviewPanel argsJson={call.argsJson} previewer={patchPreviewer} />
                  ) : preview ? (
                    <details className="mt-1 rounded-md border border-line-soft bg-white">
                      <summary
                        className="cursor-pointer px-2 py-1 text-[10px] text-muted"
                        title={preview.path}
                      >
                        查看变更（{changeCountLabel(preview)}）
                        {preview.path ? ` · ${preview.path}` : ""}
                      </summary>
                      <pre className="max-h-56 overflow-auto border-t border-line-soft px-2 py-1.5 font-mono text-[10px] leading-4">
                        {preview.lines.map((line, i) => (
                          <div
                            key={i}
                            className={
                              line.kind === "add"
                                ? "bg-[#f2fbf4] text-[#1d6b3a]"
                                : line.kind === "del"
                                  ? "bg-[#fdf4f3] text-[#b42318]"
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
                        <div className="border-t border-line-soft px-2 py-1 text-[10px] text-[#b45309]">
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
            <summary className="cursor-pointer list-none text-[12px] text-muted">
              只读工具（已自动放行，{auto.length} 项）
            </summary>
            <ul className="mt-1.5 flex flex-col gap-1">
              {auto.map((call) => (
                <li key={call.id} className="text-[11px] text-muted">
                  <span className="font-mono">{call.name}</span>
                  {call.summary ? ` · ${call.summary}` : ""}
                </li>
              ))}
            </ul>
          </details>
        )}

        {/*
          「记住本次选择」：
          - 普通工具按「工具 + 资源」记；
          - file_patch / file_read 只能按**目录前缀**记（整工具放行是红线），
            且目标不在可写根内时**不显示**这个复选框——勾了也不会生效。
        */}
        {rememberable ? (
          <label className="mt-1 flex cursor-pointer items-start gap-2 text-[11px] text-muted">
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
                <span className="block font-mono text-[10px] text-muted">
                  将记住目录：{rememberPrefixes.join("、")}
                </span>
              )}
              <span className="block text-[10px] text-muted">
                文件编辑只按目录前缀授权，不会放行整个工具；危险操作不受记住的允许影响，
                仍会每次询问；可在设置区一键清空。
              </span>
            </span>
          </label>
        ) : (
          <div className="mt-1 rounded-lg border border-line-soft bg-[#fafafa] px-2.5 py-1.5 text-[10px] text-muted">
            这次改动无法按目录记住（目标不在可写根内），本次不会落任何授权规则。
            想让某个目录以后都免问，请先到设置区「文件编辑」把它加成可写根。
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
    return <div className="mt-1 text-[10px] text-muted">正在生成变更预览…</div>;
  }
  if (preview === null) return null;
  if (preview.error) {
    return (
      <div className="mt-1 rounded-md border border-[#f3c2bd] bg-[#fdf6f6] px-2 py-1 text-[10px] text-[#b42318]">
        {preview.error}
      </div>
    );
  }

  return (
    <details className="mt-1 rounded-md border border-line-soft bg-white" open>
      <summary className="cursor-pointer px-2 py-1 text-[10px] text-muted">
        查看变更（{preview.summary}）
      </summary>
      <div className="max-h-56 overflow-auto border-t border-line-soft px-2 py-1.5 font-mono text-[10px] leading-4">
        {preview.files.map((file) => (
          <div key={file.rel} className="mb-1 last:mb-0">
            <div className="text-[#555]">
              <span className="font-bold">{file.kind}</span> {file.rel}
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
                    ? "bg-[#f2fbf4] text-[#1d6b3a]"
                    : line.kind === "del"
                      ? "bg-[#fdf4f3] text-[#b42318]"
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
