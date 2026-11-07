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
 * - d.68「简化自建智能体」：顶部 4 个模板一键填空白字段；表单分「基础」与
 *   「进阶（默认收起）」两段，新建只填名称即可创建。提交 payload 与旧版逐字一致
 *   （name/description/avatar），不新增字段、不改存储键。
 * open=false 时所有 hooks 已先执行完毕再早返回（hooks 规则，同 GroupCreateModal）。
 */

const inputCls =
  "mt-1 block w-full rounded-lg border border-line px-3 py-2 text-sm outline-hidden focus:border-[#bbb]";
const labelCls = "block ui-caption";
/** 进阶字段区的锚点 id：折叠按钮用 aria-controls 指向它（渐进披露的入口要能被读屏关联）。 */
const advancedId = "agent-advanced-fields";

export interface AgentTemplate {
  key: string;
  label: string;
  name: string;
  description: string;
  prompt: string;
}

/**
 * 「从模板开始」的 4 个预设：只用来填名称/一句话描述/系统提示词这三个**空字段**，
 * 不覆盖用户已经输入的内容，也不碰头像与模型绑定（它们本来就都是可选的）。
 */
export const AGENT_TEMPLATES: readonly AgentTemplate[] = [
  {
    key: "general",
    label: "通用助手",
    name: "通用助手",
    description: "什么都能聊一点：问答、整理、出主意",
    prompt:
      "你是「和鸣」里的通用助手。先给结论再解释，用简洁的中文；不确定时直接说不确定，不要编造。",
  },
  {
    key: "writing",
    label: "写作润色",
    name: "写作润色",
    description: "把草稿改顺、改清楚，保留原意",
    prompt:
      "你是中文写作编辑。保留作者原意与事实，不新增观点；先改病句与重复，再调语气；输出改后全文，并用 3 条以内说明主要改动。",
  },
  {
    key: "coding",
    label: "代码助手",
    name: "代码助手",
    description: "读代码、改 bug、解释实现思路",
    prompt:
      "你是严谨的编程助手。先读上下文再动手；改动尽量小，说明改了什么和为什么；给出可直接运行或粘贴的代码与命令。",
  },
  {
    key: "data",
    label: "数据分析",
    name: "数据分析",
    description: "看表格、找规律、写出有依据的结论",
    prompt:
      "你是数据分析助手。先确认字段含义与统计口径再算指标；结论必须附数据依据，区分相关与因果；数据不够时直说缺什么。",
  },
];

export function AgentFormModal({
  open,
  mode,
  agent,
  startAt = "name",
  onCreated,
  onClose,
}: {
  open: boolean;
  mode: "create" | "edit";
  agent?: Agent;
  /** 打开时把焦点放在哪：名册「＋ 新建」落在名称，「从模板创建」落在第一个模板。 */
  startAt?: "name" | "templates";
  /** 创建成功后回调（智能体页据此直接开始对话，不新增页面/路由）。 */
  onCreated?: (created: Agent) => void;
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
  // 提交中不允许 Esc 关闭：请求已发出，关掉弹窗只会让用户以为「没提交」而重复提交。
  // 遮罩点击在下面的事件里同样按 pendingRef 拦截（ref 与 state 同帧口径）。
  useModalA11y(panelRef, onClose, {
    active: open,
    closeOnEscape: !pending,
    initialFocusRef: startAt === "templates" ? firstTemplateRef : nameRef,
  });

  // 打开（或换 agent/mode 复用挂载实例）时从 props 重置表单；
  // prompts/bindings 用 getState() 取初值，不进 deps——避免打字期间被外部刷新覆盖。
  useEffect(() => {
    if (!open) return;
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
  }, [open, mode, agent?.id, agent?.name, agent?.description, agent?.avatar]);

  if (!open) return null;

  const isOwner = !!agent && !!me && agent.owner_id === me.id;

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
    setPage("settings");
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
    setErrorField("");
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

  const activeTemplate = AGENT_TEMPLATES.find((item) => item.key === appliedTemplate);

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
        className="max-h-[90vh] w-[380px] overflow-y-auto rounded-xl border border-line bg-white p-5 shadow-card"
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
            <span role="status" className="ui-caption">
              提交中…
            </span>
          )}
        </div>

        {/* 从模板开始：只填空字段，不想用模板就直接往下填 */}
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

        {/* 基础：名称必填，头像与描述可选 */}
        <div className="ui-caption mb-2 font-bold">基础信息</div>

        <label className={`${labelCls} mb-3`}>
          名称（必填）
          <input
            ref={nameRef}
            aria-label="名称"
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
            <span id="agent-name-error" role="alert" className="mt-1 block text-[12px] text-red-600">
              {error}
            </span>
          )}
        </label>

        <div className="mb-3">
          <div className="ui-caption">头像（可选）</div>
          <div className="mt-1 flex items-center gap-2">
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
          </div>
          {fileError && <div className="mt-1 text-[12px] text-red-600">{fileError}</div>}
        </div>

        <label className={`${labelCls} mb-3`}>
          一句话描述（可选）
          <textarea
            aria-label="一句话描述"
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
            <span className="ui-caption">系统提示词、模型连接；不填也能直接用</span>
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
              <div className="ui-caption">模型连接（可选）</div>
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
          <div role="alert" className="mb-2 text-[12px] text-red-600">
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
              className="mr-auto rounded-lg border border-[#e3b6b2] px-3 py-1.5 text-[13px] text-[#b42318] disabled:opacity-60"
            >
              删除智能体
            </button>
          )}
          <button
            type="submit"
            disabled={pending}
            className="ui-btn ui-btn-sm ui-btn-primary"
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
      )}
    </div>
  );
}
