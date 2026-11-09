/**
 * 凭据面板：列出/新建/编辑/删除 HTTP 认证凭据。
 *
 * 为什么把「值只存本机」写在面板顶部：用户把 API Key 填进来时最关心两件事——
 * 会不会被上传、别人能不能看到。桌面端值由系统安全存储加密（信封），
 * 浏览器端那个 origin 没有系统安全存储，只能明文存本机——这两种情况都要说清楚，
 * 不能含糊成一句「已加密」。
 */

import { useState } from "react";
import {
  CREDENTIAL_TYPES,
  getCredentialType,
  useWorkflowCredentialsStore,
  type WorkflowCredentialRecord,
  type WorkflowCredentialType,
} from "../../lib/workflow/credentials.js";
import { secureStorageStatus } from "../../lib/secureStorage.js";
import { ConfirmDialog } from "../ConfirmDialog.js";
import { EmptyState } from "../ui/EmptyState.js";
import { PlusIcon, TrashIcon } from "../icons.js";

interface CredentialDraft {
  id?: string;
  name: string;
  type: WorkflowCredentialType;
  data: Record<string, string>;
}

export interface CredentialsPanelProps {
  className?: string;
}

function emptyDraft(type: WorkflowCredentialType = "httpHeader"): CredentialDraft {
  return { name: "", type, data: {} };
}

function draftFromRecord(record: WorkflowCredentialRecord): CredentialDraft {
  // 编辑时不回填已保存的值：凭据值读出来就多在内存里暴露一份，
  // 留空表示「不改」，填写了才会覆盖。
  return { id: record.id, name: record.name, type: record.type, data: {} };
}

export function CredentialsPanel({ className = "" }: CredentialsPanelProps) {
  const credentials = useWorkflowCredentialsStore((state) => state.credentials);
  const save = useWorkflowCredentialsStore((state) => state.save);
  const remove = useWorkflowCredentialsStore((state) => state.remove);
  const [draft, setDraft] = useState<CredentialDraft | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WorkflowCredentialRecord | null>(null);
  const [error, setError] = useState("");

  const status = secureStorageStatus();
  const editingExisting = Boolean(draft?.id);
  const typeDescription = draft ? getCredentialType(draft.type) : undefined;

  function openCreate(): void {
    setError("");
    setDraft(emptyDraft());
  }

  function openEdit(record: WorkflowCredentialRecord): void {
    setError("");
    setDraft(draftFromRecord(record));
  }

  function submit(): void {
    if (!draft) return;
    const result = save({ id: draft.id, name: draft.name, type: draft.type, data: draft.data });
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setDraft(null);
    setError("");
  }

  return (
    <div className={className}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="ui-caption">
          凭据只保存在本机：
          {status.desktop
            ? status.available
              ? "桌面端由系统安全存储加密后落盘。"
              : "桌面端系统安全存储不可用，当前为明文保存。"
            : "浏览器端没有系统安全存储，值为本机明文。"}
          工作流导出时只带凭据 id，不包含值。
        </p>
        <button type="button" onClick={openCreate} className="ui-btn ui-btn-sm ui-btn-primary">
          <PlusIcon width={13} height={13} />
          新建凭据
        </button>
      </div>

      {error ? (
        <p role="alert" className="ui-alert ui-alert-danger mb-3">
          {error}
        </p>
      ) : null}

      {credentials.length === 0 ? (
        <EmptyState
          title="还没有凭据"
          desc="需要认证的 HTTP 请求可以在这里保存账号、请求头或令牌；值不会离开本机。"
          actions={
            <button type="button" onClick={openCreate} className="ui-btn ui-btn-md ui-btn-primary">
              新建凭据
            </button>
          }
        />
      ) : (
        <ul className="flex flex-col gap-2" aria-label="凭据列表">
          {credentials.map((record) => {
            const description = getCredentialType(record.type);
            return (
              <li
                key={record.id}
                className="ui-card flex flex-wrap items-center justify-between gap-2 px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-medium">{record.name}</p>
                  <p className="ui-caption">
                    {description?.displayName ?? record.type} · 更新于{" "}
                    {new Date(record.updatedAt).toLocaleString("zh-CN", { hour12: false })}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <button
                    type="button"
                    onClick={() => openEdit(record)}
                    className="ui-btn ui-btn-sm ui-btn-ghost"
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    onClick={() => setDeleteTarget(record)}
                    className="ui-btn ui-btn-sm ui-btn-ghost text-[#b42318]"
                    aria-label={`删除凭据 ${record.name}`}
                  >
                    <TrashIcon width={13} height={13} />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {draft ? (
        <ConfirmDialog
          title={editingExisting ? "编辑凭据" : "新建凭据"}
          onCancel={() => setDraft(null)}
          footer={
            <>
              <button
                type="button"
                onClick={() => setDraft(null)}
                className="ui-btn ui-btn-md ui-btn-ghost"
              >
                取消
              </button>
              <button type="button" onClick={submit} className="ui-btn ui-btn-md ui-btn-primary">
                保存
              </button>
            </>
          }
        >
          <div className="flex flex-col gap-3">
            <div>
              <label htmlFor="wf-cred-name" className="ui-caption mb-1 block font-medium text-ink">
                名称
              </label>
              <input
                id="wf-cred-name"
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                placeholder="例如：示例接口（只用在测试环境）"
                className="ui-input w-full"
              />
            </div>
            <div>
              <label htmlFor="wf-cred-type" className="ui-caption mb-1 block font-medium text-ink">
                类型
              </label>
              <select
                id="wf-cred-type"
                value={draft.type}
                disabled={editingExisting}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    type: event.target.value as WorkflowCredentialType,
                    data: {},
                  })
                }
                className="ui-input w-full"
              >
                {CREDENTIAL_TYPES.map((type) => (
                  <option key={type.type} value={type.type}>
                    {type.displayName}
                  </option>
                ))}
              </select>
              {typeDescription ? (
                <p className="ui-caption mt-1">{typeDescription.description}</p>
              ) : null}
            </div>
            {typeDescription?.fields.map((field) => (
              <div key={field.name}>
                <label
                  htmlFor={`wf-cred-${field.name}`}
                  className="ui-caption mb-1 block font-medium text-ink"
                >
                  {field.displayName}
                  {field.required ? (
                    <span className="ml-0.5 text-[#b42318]" aria-hidden="true">
                      *
                    </span>
                  ) : null}
                </label>
                <input
                  id={`wf-cred-${field.name}`}
                  type={field.type === "password" ? "password" : "text"}
                  autoComplete="off"
                  value={draft.data[field.name] ?? ""}
                  placeholder={
                    field.placeholder ??
                    (editingExisting ? "编辑时请重新填写这一项的值" : undefined)
                  }
                  onChange={(event) =>
                    setDraft({ ...draft, data: { ...draft.data, [field.name]: event.target.value } })
                  }
                  className="ui-input w-full"
                />
                {field.description ? <p className="ui-caption mt-1">{field.description}</p> : null}
              </div>
            ))}
            <p className="ui-caption">
              编辑已保存的凭据时，值需要重新填写（不会回显已保存的密钥）。
            </p>
          </div>
        </ConfirmDialog>
      ) : null}

      {deleteTarget ? (
        <ConfirmDialog
          title="删除凭据"
          onCancel={() => setDeleteTarget(null)}
          footer={
            <>
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                className="ui-btn ui-btn-md ui-btn-ghost"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => {
                  remove(deleteTarget.id);
                  setDeleteTarget(null);
                }}
                className="ui-btn ui-btn-md ui-btn-danger"
              >
                删除
              </button>
            </>
          }
        >
          <p>
            确定删除凭据「{deleteTarget.name}」吗？使用它的节点会拿不到认证信息，直到你重新配置。
          </p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
