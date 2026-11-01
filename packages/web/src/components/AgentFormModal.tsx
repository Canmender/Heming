import { useEffect, useRef, useState } from "react";
import type { Agent } from "@heming/shared";
import { useChatStore } from "../store/chat.js";
import { routeRef, useLlmStore } from "../store/llm.js";
import { useAuthStore } from "../store/auth.js";
import { useUiStore } from "../store/ui.js";
import { createAgent, updateAgent, deleteAgent } from "../lib/agentsApi.js";
import { Avatar } from "./Avatar.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { useModalA11y } from "./useModalA11y.js";

/**
 * 智能体创建/编辑弹窗：
 * - 名册字段（名称/头像/简介）走云端 REST（agentsApi）；
 * - 本地字段（系统提示词、绑定连接）只写本机 localStorage（store/llm.ts），
 *   系统提示词绝不经云端 API（响应也永不含 system_prompt）；
 * - 删除仅 owner 可见（roster.owner_id === me.id），应用内确认后 DELETE。
 * open=false 时所有 hooks 已先执行完毕再早返回（hooks 规则，同 GroupCreateModal）。
 */

const inputCls =
  "mt-1 block w-full rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-[#bbb]";
const labelCls = "block text-[12px] text-muted";

export function AgentFormModal({
  open,
  mode,
  agent,
  onClose,
}: {
  open: boolean;
  mode: "create" | "edit";
  agent?: Agent;
  onClose: () => void;
}) {
  const me = useAuthStore((s) => s.user);
  const profiles = useLlmStore((s) => s.profiles);
  const routes = useLlmStore((s) => s.routes);
  const setPrompt = useLlmStore((s) => s.setPrompt);
  const setBinding = useLlmStore((s) => s.setBinding);
  const setPage = useUiStore((s) => s.setPage);
  const loadAgentsRoster = useChatStore((s) => s.loadAgentsRoster);

  const [name, setName] = useState(agent?.name ?? "");
  const [description, setDescription] = useState(agent?.description ?? "");
  const [avatar, setAvatar] = useState<string | null>(agent?.avatar ?? null);
  const [promptText, setPromptText] = useState("");
  const [profileId, setProfileId] = useState("");
  const [error, setError] = useState("");
  const [fileError, setFileError] = useState("");
  const [pending, setPending] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // 同步提交互斥：state 闭包在同帧双击下仍是旧值（与 GroupCreateModal 同模式）
  const pendingRef = useRef(false);
  const panelRef = useRef<HTMLFormElement>(null);
  // 提交中不允许 Esc 关闭：请求已发出，关掉弹窗只会让用户以为「没提交」而重复提交。
  // 遮罩点击在下面的事件里同样按 pendingRef 拦截（ref 与 state 同帧口径）。
  useModalA11y(panelRef, onClose, { active: open, closeOnEscape: !pending });

  // 打开（或换 agent/mode 复用挂载实例）时从 props 重置表单；
  // prompts/bindings 用 getState() 取初值，不进 deps——避免打字期间被外部刷新覆盖
  useEffect(() => {
    if (!open) return;
    setName(agent?.name ?? "");
    setDescription(agent?.description ?? "");
    setAvatar(agent?.avatar ?? null);
    setError("");
    setFileError("");
    setPending(false);
    setConfirmDelete(false);
    pendingRef.current = false;
    const { prompts, bindings } = useLlmStore.getState();
    setPromptText(agent ? (prompts[agent.id] ?? "") : "");
    setProfileId(agent ? (bindings[agent.id] ?? "") : "");
  }, [open, mode, agent?.id, agent?.name, agent?.description, agent?.avatar]);

  if (!open) return null;

  const isOwner = !!agent && !!me && agent.owner_id === me.id;

  const onPickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setFileError("");
    if (!file.type.startsWith("image/")) {
      setFileError("请选择图片文件");
      return;
    }
    if (file.size > 449_000) {
      setFileError("头像不能超过约 449KB");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setAvatar(String(reader.result));
    reader.onerror = () => setFileError("读取图片失败，请重试");
    reader.readAsDataURL(file);
  };

  const gotoSettings = () => {
    onClose();
    setPage("settings");
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pendingRef.current) return;
    if (!name.trim()) {
      setError("请输入名称");
      return;
    }
    pendingRef.current = true;
    setPending(true);
    setError("");
    try {
      const body = { name: name.trim(), description: description.trim(), avatar };
      if (mode === "create") {
        const created = await createAgent(body);
        // 本地字段仅写本机（提示词非空才落；绑定在有连接时才写）
        if (promptText.trim()) setPrompt(created.id, promptText.trim());
        if (profileId) setBinding(created.id, profileId);
      } else if (agent) {
        await updateAgent(agent.id, body);
        setPrompt(agent.id, promptText.trim()); // 编辑允许清空（写空串）
        setBinding(agent.id, profileId || null);
      }
      void loadAgentsRoster().catch(() => {
        // 名册刷新失败不阻塞关闭（下次挂载雷达会重拉）
      });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  const onDelete = async () => {
    if (!agent || pendingRef.current) return;
    setConfirmDelete(false);
    pendingRef.current = true;
    setPending(true);
    setError("");
    try {
      await deleteAgent(agent.id);
      // 本机随删：绑定解掉、提示词清空（避免孤儿键占位）
      setBinding(agent.id, null);
      setPrompt(agent.id, "");
      void loadAgentsRoster().catch(() => {});
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/20"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !pendingRef.current) onClose();
      }}
    >
      <form
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={mode === "create" ? "新建智能体" : "编辑智能体"}
        onSubmit={submit}
        className="max-h-[90vh] w-[360px] overflow-y-auto rounded-xl border border-line bg-white p-5 shadow-card"
      >
        <div className="mb-3 flex items-center gap-3">
          <Avatar
            user={{ displayName: name || "智", avatar: avatar ?? undefined }}
            size={38}
            className="border border-line"
          />
          <h3 className="text-[14px] font-bold">
            {mode === "create" ? "新建智能体" : "编辑智能体"}
          </h3>
          {pending && (
            <span role="status" className="text-[11px] text-muted">
              提交中…
            </span>
          )}
        </div>

        <label className={`${labelCls} mb-3`}>
          名称
          <input
            className={inputCls}
            value={name}
            maxLength={32}
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <label className={`${labelCls} mb-3`}>
          简介
          <textarea
            className={`${inputCls} min-h-[54px] resize-y`}
            value={description}
            maxLength={500}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>

        <div className="mb-3">
          <div className="text-[12px] text-muted">头像</div>
          <label className="mt-1 inline-flex cursor-pointer items-center rounded-lg border border-line px-3 py-1.5 text-[12px] shadow-card transition-colors duration-150 hover:bg-[#fafafa]">
            上传头像
            <input
              type="file"
              accept="image/*"
              aria-label="上传头像"
              className="sr-only"
              onChange={onPickFile}
            />
          </label>
          {fileError && <div className="mt-1 text-[12px] text-red-600">{fileError}</div>}
        </div>

        <label className={`${labelCls} mb-3`}>
          系统提示词（仅本机）
          <textarea
            className={`${inputCls} min-h-[72px] resize-y`}
            value={promptText}
            maxLength={8000}
            placeholder="该智能体的角色设定；只保存在本机，不会上传服务端"
            onChange={(e) => setPromptText(e.target.value)}
          />
        </label>

        <div className="mb-3">
          <div className="text-[12px] text-muted">绑定连接</div>
          {profiles.length === 0 ? (
            <button
              type="button"
              onClick={gotoSettings}
              className="mt-1 rounded-lg border border-line px-3 py-1.5 text-[12px] shadow-card transition-colors duration-150 hover:bg-[#fafafa]"
            >
              去设置页添加
            </button>
          ) : (
            <select
              aria-label="绑定连接"
              className={inputCls}
              value={profileId}
              onChange={(e) => setProfileId(e.target.value)}
            >
              <option value="">未绑定</option>
              {/* 候选链排在单连接之前：绑定它=这个智能体自动获得失败换候选 */}
              {routes.map((g) => (
                <option key={g.id} value={routeRef(g.id)}>
                  候选链 · {g.label}（{g.members.length} 个候选）
                </option>
              ))}
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label} · {p.model}
                </option>
              ))}
            </select>
          )}
        </div>

        {error && <div className="mb-2 text-[12px] text-red-600">{error}</div>}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            className="rounded-lg border border-line px-3 py-1.5 text-[13px] disabled:opacity-60"
          >
            取消
          </button>
          {mode === "edit" && isOwner && (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              disabled={pending}
              className="mr-auto rounded-lg border border-[#e3b6b2] px-3 py-1.5 text-[13px] text-[#b42318] disabled:opacity-60"
            >
              删除智能体
            </button>
          )}
          <button
            type="submit"
            disabled={pending}
            className="rounded-lg bg-ink px-3 py-1.5 text-[13px] font-bold text-white disabled:opacity-60"
          >
            {mode === "create" ? "创建" : "保存"}
          </button>
        </div>
      </form>
      {confirmDelete && agent && (
        <ConfirmDialog
          title="删除智能体"
          onCancel={() => setConfirmDelete(false)}
          footer={
            <>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="rounded-lg border border-line px-3 py-1.5 text-[12px] text-muted hover:bg-[#f7f7f7]"
              >
                取消
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() => void onDelete()}
                className="rounded-lg bg-[#b42318] px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-60"
              >
                删除
              </button>
            </>
          }
        >
          <p className="text-[12px] leading-6">
            删除智能体「{agent.name}」？此操作不可恢复；已发送的聊天记录不受影响。
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
