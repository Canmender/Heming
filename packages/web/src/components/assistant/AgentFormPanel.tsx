import { useEffect, useRef, useState } from "react";
import type { Agent } from "@heming/shared";
import { useChatStore } from "../../store/chat.js";
import { routeRef, useLlmStore } from "../../store/llm.js";
import { useAuthStore } from "../../store/auth.js";
import { useUiStore } from "../../store/ui.js";
import { createAgent, updateAgent, deleteAgent } from "../../lib/agentsApi.js";
import { Avatar } from "../Avatar.js";
import { ConfirmDialog } from "../ConfirmDialog.js";
import { useModalA11y } from "../useModalA11y.js";
import { AGENT_TEMPLATES, type AgentTemplate } from "./agentTemplates.js";

/**
 * 智能体表单（创建/编辑）的**唯一实现**（d.126 阶段 B）：
 *
 * - `variant="modal"`：老弹窗形态（遮罩 + role=dialog + Esc/焦点陷阱），
 *   由 `AgentFormModal` 这层薄包装使用，行为/文案与 d.125 逐字一致；
 * - `variant="page"`：页内编辑视图（无遮罩、不占模态栈、无弹窗语义），
 *   由智能体页的 `AgentEditorView` 使用——「编辑智能体」不再弹窗。
 *
 * 表单内容本身两类形态完全一致，所以只抽这一份：
 * - 名册字段（名称/头像/简介）走云端 REST（agentsApi）；
 * - 本地字段（系统提示词、绑定连接）只写本机 localStorage（store/llm.ts），
 *   系统提示词绝不经云端 API（响应也永不含 system_prompt）；
 * - 删除仅 owner 可见（roster.owner_id === me.id），应用内确认后 DELETE。
 *
 * 焦点策略：模态态由 `useModalA11y` 负责（Esc、Tab 循环、打开落点）；
 * 页内态不注册模态栈，但打开时同样把焦点放到名称/第一个模板，键盘用户不用先摸 Tab。
 */

const inputCls =
  "mt-1 block w-full rounded-lg border border-line px-3 py-2 text-sm outline-hidden focus:border-[#bbb]";
const labelCls = "block ui-caption";
/** 进阶字段区的锚点 id：折叠按钮用 aria-controls 指向它（渐进披露的入口要能被读屏关联）。 */
const advancedId = "agent-advanced-fields";

export type AgentFormVariant = "modal" | "page";

export interface AgentFormPanelProps {
  mode: "create" | "edit";
  agent?: Agent;
  /** 打开时把焦点放在哪：名册「＋ 新建」落在名称，「从模板创建」落在第一个模板。 */
  startAt?: "name" | "templates";
  /** 创建成功后回调（智能体页据此直接开始对话，不新增页面/路由）。 */
  onCreated?: (created: Agent) => void;
  /** 关闭 = 取消 / 保存成功 / 删除成功后的统一出口（页内态即「回名册」）。 */
  onClose: () => void;
  variant?: AgentFormVariant;
}

export function AgentFormPanel({
  mode,
  agent,
  startAt = "name",
  onCreated,
  onClose,
  variant = "modal",
}: AgentFormPanelProps) {
  const me = useAuthStore((s) => s.user);
  const profiles = useLlmStore((s) => s.profiles);
  const routes = useLlmStore((s) => s.routes);
  const setPrompt = useLlmStore((s) => s.setPrompt);
  const setBinding = useLlmStore((s) => s.setBinding);
  const openSettings = useUiStore((s) => s.openSettings);
  const loadAgentsRoster = useChatStore((s) => s.loadAgentsRoster);

  const [name, setName] = useState(agent?.name ?? "");
  const [description, setDescription] = useState(agent?.description ?? "");
  const [avatar, setAvatar] = useState<string | null>(agent?.avatar ?? null);
  const [promptText, setPromptText] = useState("");
  const [profileId, setProfileId] = useState("");
  /** 进阶段（系统提示词 + 模型绑定）默认收起：新建只填名称就能用。 */
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [appliedTemplate, setAppliedTemplate] = useState<string | null>(null);
  const [error, setError] = useState("");
  /** 错误归属字段：把提示放在出错的那个输入框下面，而不是只在弹窗底部。 */
  const [errorField, setErrorField] = useState<"" | "name">("");
  const [fileError, setFileError] = useState("");
  const [pending, setPending] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // 同步提交互斥：state 闭包在同帧双击下仍是旧值（与 GroupCreateModal 同模式）
  const pendingRef = useRef(false);
  const panelRef = useRef<HTMLFormElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const firstTemplateRef = useRef<HTMLButtonElement>(null);
  const modal = variant === "modal";
  // 提交中不允许 Esc 关闭 / 点遮罩关闭：请求已发出，关掉只会让用户以为「没提交」而重复提交。
  // 页内态不注册模态：没有遮罩可点，Esc 也不该偷偷丢掉正在填的表单。
  useModalA11y(panelRef, onClose, {
    active: modal,
    closeOnEscape: !pending,
    initialFocusRef: startAt === "templates" ? firstTemplateRef : nameRef,
  });

  // 打开（或换 agent/mode 复用挂载实例）时从 props 重置表单；
  // prompts/bindings 用 getState() 取初值，不进 deps——避免打字期间被外部刷新覆盖。
  useEffect(() => {
    setName(agent?.name ?? "");
    setDescription(agent?.description ?? "");
    setAvatar(agent?.avatar ?? null);
    setAppliedTemplate(null);
    setError("");
    setErrorField("");
    setFileError("");
    setPending(false);
    setConfirmDelete(false);
    pendingRef.current = false;
    const { prompts, bindings } = useLlmStore.getState();
    const nextPrompt = agent ? (prompts[agent.id] ?? "") : "";
    const nextBinding = agent ? (bindings[agent.id] ?? "") : "";
    setPromptText(nextPrompt);
    setProfileId(nextBinding);
    // 编辑已配置过的智能体：进阶字段非空就默认展开，避免「看不见已有提示词」。
    setAdvancedOpen(mode === "edit" && (nextPrompt.trim() !== "" || nextBinding !== ""));
  }, [mode, agent?.id, agent?.name, agent?.description, agent?.avatar]);

  // 页内态没有 useModalA11y 的落点逻辑：手动把焦点放进表单（新建落在名称/模板）。
  useEffect(() => {
    if (modal) return;
    const target =
      startAt === "templates" && mode === "create"
        ? firstTemplateRef.current
        : nameRef.current;
    target?.focus();
    // 只在进入编辑页时做一次：之后用户自己在页内移动焦点不该被抢回。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modal, mode, agent?.id]);

  const isOwner = !!agent && !!me && agent.owner_id === me.id;
  /** 系统预置智能体（owner_id=null）：服务端 PUT/DELETE 一律 403，只能改本机字段。 */
  const systemAgent = mode === "edit" && agent?.owner_id === null;

  const applyTemplate = (template: AgentTemplate) => {
    // 只填空字段：用户已经写下的名称/描述/提示词一律不覆盖（再次点击同一模板也不会追加）。
    let filled = false;
    if (!name.trim()) {
      setName(template.name);
      filled = true;
    }
    if (!description.trim()) {
      setDescription(template.description);
      filled = true;
    }
    if (!promptText.trim()) {
      setPromptText(template.prompt);
      filled = true;
    }
    setAppliedTemplate(filled ? template.key : appliedTemplate);
    setError("");
    setErrorField("");
  };

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
    // 「绑定模型」去的是设置区「模型」页签，别让用户先在个人资料里找
    useUiStore.getState().setPage("model");
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pendingRef.current) return;
    if (!name.trim()) {
      setError("请输入名称");
      setErrorField("name");
      return;
    }
    pendingRef.current = true;
    setPending(true);
    setError("");
    setErrorField("");
    try {
      const body = { name: name.trim(), description: description.trim(), avatar };
      if (mode === "create") {
        const created = await createAgent(body);
        // 本地字段仅写本机（提示词非空才落；绑定在有连接时才写）
        if (promptText.trim()) setPrompt(created.id, promptText.trim());
        if (profileId) setBinding(created.id, profileId);
        onCreated?.(created);
      } else if (agent) {
        // 系统预置智能体的名称/简介由应用维护，服务端会 403；但「模型 + 系统提示词」
        // 本来就只存本机，必须照常写入，否则用户永远配不上模型。
        if (!systemAgent) await updateAgent(agent.id, body);
        setPrompt(agent.id, promptText.trim()); // 编辑允许清空（写空串）
        setBinding(agent.id, profileId || null);
      }
      void loadAgentsRoster().catch(() => {
        // 名册刷新失败不阻塞关闭（下次挂载雷达会重拉）
      });
      onClose();
    } catch (err) {
      const message = (err as Error).message;
      setError(
        message === "forbidden"
          ? "这个智能体不能改名称或简介（系统预置）；模型与提示词只存本机，可在「进阶设置」里配置"
          : message,
      );
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
    setErrorField("");
    try {
      await deleteAgent(agent.id);
      // 本机随删：绑定解掉、提示词清空（避免孤儿键占位）
      setBinding(agent.id, null);
      setPrompt(agent.id, "");
      void loadAgentsRoster().catch(() => {});
      onClose();
    } catch (err) {
      const message = (err as Error).message;
      setError(
        message === "forbidden"
          ? "这个智能体不能改名称或简介（系统预置）；模型与提示词只存本机，可在「进阶设置」里配置"
          : message,
      );
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  const activeTemplate = AGENT_TEMPLATES.find((item) => item.key === appliedTemplate);
  const title = mode === "create" ? "新建智能体" : "编辑智能体";

  const form = (
    <form
      ref={panelRef}
      role={modal ? "dialog" : undefined}
      aria-modal={modal ? true : undefined}
      aria-label={modal ? title : undefined}
      onSubmit={submit}
      className={
        modal
          ? "max-h-[90vh] w-[380px] overflow-y-auto rounded-xl border border-line bg-white p-5 shadow-card"
          : "ui-card w-full p-5"
      }
    >
      <div className="mb-3 flex items-center gap-3">
        <Avatar
          user={{ displayName: name || "智", avatar: avatar ?? undefined }}
          size={38}
          className="border border-line"
        />
        {modal ? (
          <h3 className="text-[14px] font-bold">{title}</h3>
        ) : (
          <h2 className="ui-section-title">{title}</h2>
        )}
        {pending && (
          <span role="status" className="ui-caption">
            提交中…
          </span>
        )}
      </div>

      {/* 从模板开始：只填空字段，不想用模板就直接往下填（编辑时不显示，避免误覆盖已有信息） */}
      {mode === "create" && (
        <div className="mb-3 rounded-lg border border-line-soft bg-[#fafafa] p-2.5">
          <div className="ui-caption">从模板开始（可选）</div>
          <div className="mt-1.5 grid grid-cols-2 gap-1.5" role="group" aria-label="智能体模板">
            {AGENT_TEMPLATES.map((template, index) => (
              <button
                key={template.key}
                type="button"
                ref={index === 0 ? firstTemplateRef : undefined}
                aria-label={`使用模板 ${template.label}`}
                aria-pressed={appliedTemplate === template.key}
                onClick={() => applyTemplate(template)}
                className="ui-btn ui-btn-sm ui-btn-ghost justify-start"
              >
                {template.label}
              </button>
            ))}
          </div>
          <p className="mt-1.5 ui-caption">
            {activeTemplate
              ? `已套用「${activeTemplate.label}」：只填了空字段，已输入的内容不会被覆盖。`
              : "点一个预设，自动填好名称、描述和提示词；也可以直接往下填。"}
          </p>
        </div>
      )}

      {/* 基础：名称必填，头像与描述可选 */}
      <div className="ui-caption mb-2 font-bold">基础信息</div>

      {systemAgent && (
        <p
          role="status"
          className="mb-2 rounded-lg border border-line-soft bg-panel px-2.5 py-1.5 ui-caption"
        >
          内置智能体：名称、头像和简介由应用维护，不能改；下方的「模型」和「系统提示词」只存本机，可以改。
        </p>
      )}

      <label className={`${labelCls} mb-3`}>
        名称（必填）
        <input
          ref={nameRef}
          aria-label="名称"
          disabled={systemAgent}
          aria-invalid={errorField === "name" ? true : undefined}
          aria-describedby={errorField === "name" ? "agent-name-error" : undefined}
          className={inputCls}
          value={name}
          maxLength={32}
          placeholder="例如：周报助手"
          onChange={(e) => {
            setName(e.target.value);
            if (errorField === "name") {
              setError("");
              setErrorField("");
            }
          }}
        />
        {errorField === "name" && error && (
          <span id="agent-name-error" role="alert" className="mt-1 block ui-caption text-[var(--danger)]">
            {error}
          </span>
        )}
      </label>

      <div className="mb-3">
        <div className="ui-caption">头像（可选）</div>
        <div className="mt-1 flex items-center gap-2">
          {systemAgent ? (
            <span className="ui-caption">系统预置头像，不可更换</span>
          ) : (
            <>
              <label className="inline-flex cursor-pointer items-center ui-btn ui-btn-sm ui-btn-ghost">
                上传头像
                <input
                  type="file"
                  accept="image/*"
                  aria-label="上传头像"
                  className="sr-only"
                  onChange={onPickFile}
                />
              </label>
              <span className="ui-caption">不传就用名称首字，之后也能换</span>
            </>
          )}
        </div>
        {fileError && (
          <div role="alert" className="mt-1 ui-caption text-[var(--danger)]">
            {fileError}
          </div>
        )}
      </div>

      <label className={`${labelCls} mb-3`}>
        一句话描述（可选）
        <textarea
          aria-label="一句话描述"
          disabled={systemAgent}
          className={`${inputCls} min-h-[54px] resize-y`}
          value={description}
          maxLength={500}
          placeholder="例如：帮我把邮件改得更短、更客气"
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>

      {/* 进阶：默认收起，新建只填名称即可创建 */}
      <div className="mb-3 border-t border-line-soft pt-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            aria-expanded={advancedOpen}
            aria-controls={advancedId}
            onClick={() => setAdvancedOpen((open) => !open)}
            className="ui-btn ui-btn-sm ui-btn-ghost"
          >
            {advancedOpen ? "收起进阶设置" : "进阶设置（可选）"}
          </button>
          <span className="ui-caption">系统提示词、模型；不填也能直接用</span>
        </div>
      </div>

      {advancedOpen && (
        <div id={advancedId}>
          <label className={`${labelCls} mb-3`}>
            系统提示词（仅本机）
            <textarea
              className={`${inputCls} min-h-[72px] resize-y`}
              value={promptText}
              maxLength={8000}
              placeholder={
                "例如：你是我的写作编辑，改稿时保留原意，只改病句和重复。\n不填也能用：不写就按默认助手方式回答。"
              }
              onChange={(e) => setPromptText(e.target.value)}
            />
          </label>
          <p className="mb-3 -mt-2 ui-caption">只保存在本机，不会上传服务端。</p>

          <div className="mb-3">
            <div className="ui-caption">模型（可选）</div>
            <p className="mt-0.5 ui-caption">不绑定 = 用默认连接。</p>
            {profiles.length === 0 ? (
              <button
                type="button"
                onClick={gotoSettings}
                className="mt-1 ui-btn ui-btn-sm ui-btn-ghost"
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
                <option value="">不绑定（用默认连接）</option>
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
        </div>
      )}

      {error && errorField !== "name" && (
        <div role="alert" className="mb-2 ui-caption text-[var(--danger)]">
          {error}
        </div>
      )}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          disabled={pending}
          className="ui-btn ui-btn-md ui-btn-ghost text-[13px] disabled:opacity-60"
        >
          取消
        </button>
        {mode === "edit" && isOwner && (
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            disabled={pending}
            className="mr-auto rounded-lg border border-[var(--danger-line)] px-3 py-1.5 text-[13px] text-[var(--danger)] disabled:opacity-60"
          >
            删除智能体
          </button>
        )}
        <button type="submit" disabled={pending} className="ui-btn ui-btn-sm ui-btn-primary">
          {mode === "create" ? "创建" : "保存"}
        </button>
      </div>
    </form>
  );

  const confirm =
    confirmDelete && agent ? (
      <ConfirmDialog
        title="删除智能体"
        onCancel={() => setConfirmDelete(false)}
        footer={
          <>
            <button
              type="button"
              onClick={() => setConfirmDelete(false)}
              className="ui-btn ui-btn-md ui-btn-ghost ui-caption"
            >
              取消
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => void onDelete()}
              className="ui-btn ui-btn-sm ui-btn-danger"
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
    ) : null;

  if (modal) {
    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/20"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget && !pendingRef.current) onClose();
        }}
      >
        {form}
        {confirm}
      </div>
    );
  }

  return (
    <div className="relative">
      {form}
      {confirm}
    </div>
  );
}
