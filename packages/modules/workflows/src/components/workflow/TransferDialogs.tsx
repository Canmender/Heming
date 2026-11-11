/**
 * 导入 / 导出 / 新建（模板）三个弹窗。
 *
 * 为什么都做成「先给预览/校验、再落库」：工作流是用户可能花很久搭出来的资产，
 * 导入坏 JSON 直接覆盖或静默丢节点，比报错难受得多。这里统一：
 * - 导入先解析，错误与警告逐条列出来，用户确认后才插入仓库；
 * - 导出给只读文本 + 复制/下载两种拿法（不直接触发下载，方便先看一眼）；
 * - 新建给「空白」与起手模板，模板构建失败时明确说「节点库未就绪」。
 */

import { useEffect, useState } from "react";
import { useWorkflowStore } from "../../lib/workflow/store";
import { exportWorkflowJson } from "../../lib/workflow/transfer";
import { WORKFLOW_TEMPLATES, type WorkflowTemplate } from "../../lib/workflow/nodes/templates";
import type { Workflow } from "../../lib/workflow/types";
import { ConfirmDialog } from "@heming/sdk";
import { WorkflowIcon } from "@heming/sdk";

async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 交给调用方显示失败状态 */
  }
  return false;
}

/** 触发浏览器下载（jsdom 下由 test-setup 补的 createObjectURL 兜住）。 */
export function downloadJson(filename: string, text: string): void {
  try {
    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  } catch {
    /* 下载失败不致命：用户仍可复制文本 */
  }
}

// ---------------------------------------------------------------------------
// 新建（空白 / 模板）
// ---------------------------------------------------------------------------

export interface NewWorkflowDialogProps {
  open: boolean;
  onClose: () => void;
  /** 选中后的工作流实例（空白或模板构建结果）；由调用方插入仓库。 */
  onPick: (workflow: Workflow) => void;
}

export function NewWorkflowDialog({ open, onClose, onPick }: NewWorkflowDialogProps) {
  const [error, setError] = useState("");
  if (!open) return null;

  function pickTemplate(template: WorkflowTemplate): void {
    setError("");
    try {
      onPick(template.build());
    } catch (err) {
      setError(
        `模板暂时不可用：${err instanceof Error ? err.message : String(err)}（节点库可能还没加载完）`,
      );
    }
  }

  return (
    <ConfirmDialog
      title="新建工作流"
      onCancel={onClose}
      footer={
        <button type="button" onClick={onClose} className="ui-btn ui-btn-md ui-btn-ghost">
          取消
        </button>
      }
    >
      <div className="flex flex-col gap-3">
        <button
          type="button"
          onClick={() => {
            setError("");
            onPick({ ...emptyWorkflowTemplate() });
          }}
          className="ui-card flex items-start gap-3 px-3 py-3 text-left hover:bg-[#fafafa]"
        >
          <WorkflowIcon width={20} height={20} aria-hidden="true" />
          <span>
            <span className="block text-[13px] font-medium">空白工作流</span>
            <span className="ui-caption block">从画布开始，自己拖节点、连线。</span>
          </span>
        </button>
        <p className="ui-section-title">起手模板</p>
        <div className="flex flex-col gap-2">
          {WORKFLOW_TEMPLATES.map((template) => (
            <button
              key={template.id}
              type="button"
              onClick={() => pickTemplate(template)}
              className="ui-card px-3 py-2 text-left hover:bg-[#fafafa]"
            >
              <span className="block text-[13px] font-medium">{template.name}</span>
              <span className="ui-caption block">{template.description}</span>
            </button>
          ))}
        </div>
        {error ? (
          <p role="alert" className="ui-alert ui-alert-danger">
            {error}
          </p>
        ) : null}
      </div>
    </ConfirmDialog>
  );
}

/**
 * 空白工作流的形状（不依赖注册表，节点库未就绪时也能建）。
 * 不用 `createWorkflow` 是为了让「新建」在节点库加载失败时仍可用。
 */
function emptyWorkflowTemplate(): Workflow {
  const now = Date.now();
  const suffix = Math.random().toString(36).slice(2, 6);
  return {
    id: `wf-${now.toString(36)}-${suffix}`,
    name: "未命名工作流",
    tags: [],
    nodes: [],
    connections: {},
    settings: {
      timezone: "local",
      saveDataSuccessExecution: "all",
      saveDataErrorExecution: "all",
      saveManualExecutions: true,
      callerPolicy: "any",
    },
    active: false,
    versionId: `ver-${now.toString(36)}-${suffix}`,
    createdAt: now,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// 导入
// ---------------------------------------------------------------------------

export interface ImportDialogProps {
  open: boolean;
  onClose: () => void;
  /** 成功导入后的回调（页面据此选中/进入编辑器）。 */
  onImported: (workflow: Workflow) => void;
}

export function ImportDialog({ open, onClose, onImported }: ImportDialogProps) {
  const [text, setText] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (!open) {
      setText("");
      setErrors([]);
      setWarnings([]);
      setNotice("");
    }
  }, [open]);

  if (!open) return null;

  async function readFile(file: File): Promise<void> {
    try {
      setText(await file.text());
      setErrors([]);
      setWarnings([]);
      setNotice("");
    } catch (err) {
      setErrors([`读取文件失败：${err instanceof Error ? err.message : String(err)}`]);
    }
  }

  function submit(): void {
    const result = useWorkflowStore.getState().importWorkflow(text);
    setErrors(result.errors);
    setWarnings(result.warnings);
    if (!result.ok) {
      setNotice("");
      return;
    }
    setNotice(`已导入「${result.workflow.name}」，共 ${result.workflow.nodes.length} 个节点。`);
    onImported(result.workflow);
  }

  return (
    <ConfirmDialog
      title="导入工作流"
      onCancel={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} className="ui-btn ui-btn-md ui-btn-ghost">
            取消
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!text.trim()}
            className="ui-btn ui-btn-md ui-btn-primary"
          >
            导入
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="ui-caption">
          支持本仓导出的 JSON，以及 n8n 导出的工作流 JSON。连接会按节点名重新建立；
          不认识的节点类型会被跳过并逐条列出。
        </p>
        <div>
          <label htmlFor="wf-import-file" className="ui-caption mb-1 block font-medium text-ink">
            选择文件
          </label>
          <input
            id="wf-import-file"
            type="file"
            accept=".json,application/json"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void readFile(file);
            }}
            className="block w-full text-[12px]"
          />
        </div>
        <div>
          <label htmlFor="wf-import-text" className="ui-caption mb-1 block font-medium text-ink">
            或者直接粘贴 JSON
          </label>
          <textarea
            id="wf-import-text"
            value={text}
            rows={8}
            onChange={(event) => setText(event.target.value)}
            placeholder="{ &quot;name&quot;: &quot;工作流&quot;, &quot;nodes&quot;: [], &quot;connections&quot;: {} }"
            className="ui-input w-full font-mono text-[11px] leading-5"
          />
        </div>
        {notice ? <p className="ui-alert ui-alert-muted">{notice}</p> : null}
        {errors.length > 0 ? (
          <div role="alert" className="ui-alert ui-alert-danger flex-col items-start">
            {errors.map((message, index) => (
              <p key={index}>{message}</p>
            ))}
          </div>
        ) : null}
        {warnings.length > 0 ? (
          <div className="ui-alert ui-alert-muted flex-col items-start">
            <p className="font-medium">已跳过以下内容：</p>
            {warnings.map((message, index) => (
              <p key={index}>{message}</p>
            ))}
          </div>
        ) : null}
      </div>
    </ConfirmDialog>
  );
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

export interface ExportDialogProps {
  /** 要导出的工作流；null 表示弹窗关闭。 */
  workflow: Workflow | null;
  onClose: () => void;
}

export function ExportDialog({ workflow, onClose }: ExportDialogProps) {
  const [copyState, setCopyState] = useState<"idle" | "done" | "failed">("idle");
  if (!workflow) return null;
  const text = exportWorkflowJson(workflow);
  const filename = `${workflow.name.replace(/[\\/:*?"<>|]/g, "_") || "工作流"}.json`;

  return (
    <ConfirmDialog
      title="导出工作流"
      onCancel={onClose}
      footer={
        <>
          <button
            type="button"
            onClick={() => {
              void copyText(text).then((ok) => {
                setCopyState(ok ? "done" : "failed");
                window.setTimeout(() => setCopyState("idle"), 1500);
              });
            }}
            className="ui-btn ui-btn-md ui-btn-ghost"
          >
            {copyState === "done" ? "已复制" : copyState === "failed" ? "复制失败" : "复制 JSON"}
          </button>
          <button
            type="button"
            onClick={() => downloadJson(filename, text)}
            className="ui-btn ui-btn-md ui-btn-primary"
          >
            下载 JSON
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <p className="ui-caption">
          导出的是类 n8n 的 JSON（连接按节点名）。凭据只导出 id 引用，不包含任何密码或令牌；
          执行记录与全局变量也不在导出范围内。
        </p>
        <textarea
          readOnly
          value={text}
          rows={14}
          aria-label="导出的工作流 JSON"
          className="ui-input w-full font-mono text-[11px] leading-5"
        />
      </div>
    </ConfirmDialog>
  );
}
