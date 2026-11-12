import { useEffect, useMemo, useRef, useState } from "react";
import { listAgents } from "../lib/agentsApi.js";
import { SelfEditCard } from "./SelfEditCard.js";
import { PlusIcon, XIcon } from "./icons.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { useModalA11y } from "./useModalA11y.js";
import {
  skillPool,
  type SkillDefinition,
  type SkillPool,
} from "../lib/skills/index.js";
import { memoryStore } from "../lib/memory/index.js";
import { mcpRegistry } from "../lib/mcp/index.js";
import { PageShell } from "./layout/PageShell.js";
import { describeSystemPlugin, pluginStore, type PluginStore } from "../lib/plugins/index.js";
import { useUiStore } from "../store/ui.js";
import { useSessionTab } from "../lib/sessionState.js";
import { SkillHubPanel } from "./skills/SkillHubPanel.js";
import { Switch } from "./ui/Switch.js";

/**
 * 技能区：技能（四类分组）/ 技能池（全量表格）两个视图。
 * 数据只来自本机 lib/skills 的单例（测试注入独立实例），不重写存储：
 * 启用、删除、导入、沉淀全部走 SkillPool 的既有 API。
 */

export type SkillCategory = "builtin" | "installed" | "distilled" | "custom";

const CATEGORY_BY_SOURCE: Record<SkillDefinition["source"], SkillCategory> = {
  builtin: "builtin",
  imported: "installed",
  distilled: "distilled",
  user: "custom",
};

/** 来源 → 四类分组（纯函数，供渲染与测试共用）。 */
export function categorizeSkill(skill: Pick<SkillDefinition, "source">): SkillCategory {
  return CATEGORY_BY_SOURCE[skill.source];
}

/** 来源的中文标签（技能池表格与抽屉共用）。 */
export const SOURCE_LABEL: Record<SkillDefinition["source"], string> = {
  builtin: "内置",
  imported: "已装",
  distilled: "沉淀",
  user: "自定义",
};

interface GroupMeta {
  key: SkillCategory;
  title: string;
  hint: string;
  empty: string;
}

const GROUPS: readonly GroupMeta[] = [
  {
    key: "builtin",
    title: "内置技能",
    hint: "随应用预置，删除后不会自动恢复",
    empty: "暂无内置技能：预置技能删除后不再自动恢复，可从技能池导入。",
  },
  {
    key: "installed",
    title: "已装技能",
    hint: "由 SKILL.md 或 JSON 导入",
    empty: "暂无已装技能：在技能池「导入 SKILL.md」后出现在这里。",
  },
  {
    key: "distilled",
    title: "沉淀技能",
    hint: "从已验证的技能复制而来，内容已冻结",
    empty: "暂无沉淀技能：在会话里让智能体积累经验后再沉淀。",
  },
  {
    key: "custom",
    title: "自定义技能",
    hint: "本机新建的技能",
    empty: "暂无自定义技能：点「新建技能」直接建一个，或把导入的技能转为沉淀。",
  },
];

/* ------------------------------------------------------------------ 样式 */

const cardCls = "ui-card p-4";
const cardInnerCls = "rounded-lg border border-line p-3";
const chipCls = "ui-chip";
const badgeCls = "ui-chip";
const btnGhost = "ui-btn ui-btn-md ui-btn-ghost";
const btnGhostSm = "ui-btn ui-btn-sm ui-btn-ghost";
const btnDangerSm = "ui-btn ui-btn-sm ui-btn-ghost text-[var(--danger)]";
const btnPrimarySm = "ui-btn ui-btn-sm ui-btn-primary";
const inputSmCls = "ui-input";
const hintCls = "ui-caption";
const errorCls = "ui-body-sm text-[var(--danger)]";
const okCls = "ui-body-sm text-muted";
/** 技能内容的输入框：与「导入 SKILL.md」的 textarea 同款（既有样式，不新增档位）。 */
const contentTextareaCls =
  "mt-1 block min-h-[110px] w-full resize-y rounded-lg border border-line-strong px-3 py-2 ui-body-sm outline-hidden focus:border-ink";

/* ---------------------------------------------------------------- 技能模板 */

export interface SkillTemplate {
  key: string;
  label: string;
  name: string;
  description: string;
  instructions: string;
}

/**
 * 「新建技能」的 3 个模板（d.68）：点一下只填**空着的**名称/描述/内容，
 * 不覆盖用户已经写下的部分；不想用模板也可以只填名称与内容直接建。
 */
export const SKILL_TEMPLATES: readonly SkillTemplate[] = [
  {
    key: "writing",
    label: "写作润色",
    name: "写作润色",
    description: "把草稿改顺、改清楚，保留原意",
    instructions:
      "你在帮我润色中文文稿。\n1. 先通读全文，保留作者原意与事实，不新增观点。\n2. 只改病句、重复和口语化表达，语气跟随原文。\n3. 先给改后全文，再用 3 条以内说明主要改动。",
  },
  {
    key: "review",
    label: "代码审查",
    name: "代码审查",
    description: "找出改动里的 bug、风险与遗漏",
    instructions:
      "你在审查一段代码改动。\n1. 先读上下文与调用方，确认改动意图。\n2. 按「会出错 > 有风险 > 可读性」的顺序列问题，标出文件与行号。\n3. 每个问题都给出具体改法；没问题就直说，不要凑数。",
  },
  {
    key: "minutes",
    label: "会议纪要",
    name: "会议纪要",
    description: "把讨论整理成结论、待办与负责人",
    instructions:
      "你在整理会议纪要。\n1. 输出三块：结论、待办（负责人 + 期限）、待定问题。\n2. 只写会上真实说过的内容，不补充推测。\n3. 待办要能直接执行；信息缺失时标注「待确认」。",
  },
];

/* ------------------------------------------------------------ 新建技能弹窗 */

/**
 * 新建技能弹窗（d.68 简化）：
 * - 必填只有「名称」与「技能内容」，其余可空；
 * - 3 个模板只填空字段；
 * - 创建后若当前已选智能体，自动分配给它（否则技能建了却「不会用于对话」，新手最容易踩）。
 */
function SkillCreateDialog({
  open,
  skills,
  agentId,
  agentName,
  onClose,
  onCreated,
}: {
  open: boolean;
  skills: SkillPool;
  agentId: string;
  agentName: string;
  onClose: () => void;
  onCreated: (skill: SkillDefinition, assigned: boolean) => void;
}) {
  const panelRef = useRef<HTMLFormElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [applied, setApplied] = useState<string | null>(null);
  const [errors, setErrors] = useState<{ name?: string; instructions?: string }>({});
  useModalA11y(panelRef, onClose, { active: open, initialFocusRef: nameRef });

  useEffect(() => {
    if (!open) return;
    setName("");
    setDescription("");
    setInstructions("");
    setApplied(null);
    setErrors({});
  }, [open]);

  if (!open) return null;

  const applyTemplate = (template: SkillTemplate) => {
    setName((cur) => (cur.trim() ? cur : template.name));
    setDescription((cur) => (cur.trim() ? cur : template.description));
    setInstructions((cur) => (cur.trim() ? cur : template.instructions));
    setApplied(template.key);
    setErrors({});
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const next: { name?: string; instructions?: string } = {};
    if (!name.trim()) next.name = "请给技能起个名字";
    if (!instructions.trim())
      next.instructions = "技能内容不能为空：写清什么时候用它、按什么步骤做";
    setErrors(next);
    if (next.name || next.instructions) return;
    const created = skills.create({
      name: name.trim(),
      description: description.trim(),
      instructions: instructions.trim(),
      triggers: [],
      tags: [],
      enabled: true,
      version: "1.0.0",
    });
    // 自动分配给当前智能体：否则「建好了却不会用于对话」是新手最容易踩的坑。
    if (agentId) skills.assign(agentId, created.id);
    onCreated(created, Boolean(agentId));
    onClose();
  };

  const activeTemplate = SKILL_TEMPLATES.find((item) => item.key === applied);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-4">
      <form
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="新建技能"
        onSubmit={submit}
        className="max-h-[90vh] w-[440px] max-w-full overflow-y-auto ui-card p-4"
      >
        <div className="mb-3 flex items-center gap-2">
          <h2 className="text-[13px] font-bold">新建技能</h2>
          <span className={hintCls}>只需名称和内容，其余可空</span>
          <button
            type="button"
            aria-label="关闭新建技能"
            onClick={onClose}
            className="ml-auto rounded-sm p-1 text-muted hover:bg-[var(--subtle-3)] hover:text-ink"
          >
            <XIcon width={14} height={14} aria-hidden="true" />
          </button>
        </div>

        <div className="mb-3 rounded-lg border border-line-soft bg-[var(--subtle-2)] p-2.5">
          <div className={hintCls}>从模板开始（可选）</div>
          <div className="mt-1.5 flex flex-wrap gap-1.5" role="group" aria-label="技能模板">
            {SKILL_TEMPLATES.map((template) => (
              <button
                key={template.key}
                type="button"
                aria-label={`使用模板 ${template.label}`}
                aria-pressed={applied === template.key}
                onClick={() => applyTemplate(template)}
                className={btnGhostSm}
              >
                {template.label}
              </button>
            ))}
          </div>
          <p className={`mt-1.5 ${hintCls}`}>
            {activeTemplate
              ? `已套用「${activeTemplate.label}」：只填了空着的字段。`
              : "点一个预设自动填好，也可以直接往下写。"}
          </p>
        </div>

        <label htmlFor="skill-create-name" className="mb-3 block ui-caption">
          名称（必填）
          <input
            id="skill-create-name"
            ref={nameRef}
            aria-label="技能名称"
            value={name}
            maxLength={32}
            placeholder="例如：周报润色"
            onChange={(e) => {
              setName(e.target.value);
              if (errors.name) setErrors((cur) => ({ ...cur, name: undefined }));
            }}
            className={`${inputSmCls} mt-1`}
          />
          {errors.name && (
            <span role="alert" className={`mt-1 block ${errorCls}`}>
              {errors.name}
            </span>
          )}
        </label>

        <label htmlFor="skill-create-desc" className="mb-3 block ui-caption">
          一句话描述（可选）
          <input
            id="skill-create-desc"
            aria-label="技能描述"
            value={description}
            maxLength={200}
            placeholder="例如：把周报改得更短、更像人写的"
            onChange={(e) => setDescription(e.target.value)}
            className={`${inputSmCls} mt-1`}
          />
          <span className={`mt-1 block ${hintCls}`}>写清用途，路由时会参考它。</span>
        </label>

        <label htmlFor="skill-create-content" className="block ui-caption">
          技能内容（必填）
          <textarea
            id="skill-create-content"
            aria-label="技能内容"
            value={instructions}
            maxLength={8000}
            placeholder={
              "写清「什么时候用它 + 按什么步骤做」。例如：\n你在帮我润色周报。\n1. 先删掉套话与重复。\n2. 保留数字与结论，语气跟随原文。\n3. 先给改后全文，再说明主要改动。"
            }
            onChange={(e) => {
              setInstructions(e.target.value);
              if (errors.instructions) setErrors((cur) => ({ ...cur, instructions: undefined }));
            }}
            className={contentTextareaCls}
          />
          {errors.instructions && (
            <span role="alert" className={`mt-1 block ${errorCls}`}>
              {errors.instructions}
            </span>
          )}
        </label>

        <p className={`mt-2 ${hintCls}`}>
          {agentId
            ? `创建后会自动分配给「${agentName}」，对话时就能用。`
            : "还没有选择智能体：先建在技能池，选中智能体后再分配即可用于对话。"}
        </p>

        <div className="mt-3 flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className={btnGhostSm}>
            取消
          </button>
          <button type="submit" className={btnPrimarySm}>
            创建技能
          </button>
        </div>
      </form>
    </div>
  );
}


/* ---------------------------------------------------------------- 基础件 */

/* 开关已抽到 ui/Switch.tsx（d.138）：与上下文设置卡、记忆页的三份逐字节相同拷贝合并。 */

function TagList({ items, empty }: { items: string[]; empty: string }) {
  if (items.length === 0) return <span className={hintCls}>{empty}</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((item) => (
        <span key={item} className={chipCls}>
          {item}
        </span>
      ))}
    </div>
  );
}

/** ISO 时间 → 本地「YYYY-MM-DD HH:mm」；缺失或非法返回「—」。 */
function formatAt(at: string | undefined): string {
  if (!at) return "—";
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) return "—";
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/* ------------------------------------------------------------------ 插件来源 */

/**
 * 「插件：<名>」来源徽标（d.64 T3a）。
 *
 * 为什么拆成两个文本节点：既有接口区用例用 getByText("插件") 锚定来源徽标，
 * 直接写成一整个「插件：名称」会让旧锚点失配；拆开后旧锚点与新文案同时成立。
 * 点击 = 切到插件区并打开该插件详情（复用 d.60 的 open-plugin 内存意图，不新增 IPC）。
 */
function PluginSourceChip({
  pluginName,
  onOpen,
}: {
  pluginName: string;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={`打开插件 ${pluginName}`}
      title="随插件安装；点开看插件详情"
      onClick={onOpen}
      className="ui-chip hover:text-ink"
    >
      <span>插件</span>
      <span>：{pluginName}</span>
    </button>
  );
}

/* ------------------------------------------------------------------ 系统来源 */

/**
 * 「内置：<系统能力名>」来源徽标（d.65 T3）。
 *
 * 前缀用「内置」而不是「系统」：系统插件名就叫「系统能力」，写成「系统：系统能力」
 * 在列表里连续多行会自我重复；来源类别说「内置」、归属说「系统能力」，读起来不绕。
 *
 * 与插件徽标的关键区别：**不是按钮、不可点** —— 系统插件随应用内置，没有插件详情页可跳。
 * 名字取自 describeSystemPlugin().name（页面里不硬编码「系统能力」）。
 */
function SystemSourceChip({ systemName }: { systemName: string }) {
  return (
    <span className="ui-chip" title="随应用内置；不可停用或卸载">
      <span>内置</span>
      <span>：{systemName}</span>
    </span>
  );
}

/* ------------------------------------------------------------------ 详情 */

function SkillDetailDrawer({
  skill,
  onClose,
  onDelete,
  systemName,
  pluginName,
  onOpenPlugin,
}: {
  skill: SkillDefinition;
  onClose: () => void;
  onDelete: () => void;
  /** 插件来源技能：所属插件显示名（undefined = 不是插件来源）。 */
  pluginName?: string;
  onOpenPlugin?: () => void;
  /** 系统插件的显示名（内置技能来源徽标用）。 */
  systemName: string;
}) {
  const panelRef = useRef<HTMLElement>(null);
  useModalA11y(panelRef, onClose);

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button
        type="button"
        aria-label="关闭技能详情"
        onClick={onClose}
        className="absolute inset-0 bg-black/10"
      />
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={`技能详情 ${skill.name}`}
        className="relative flex h-full w-[380px] max-w-[92vw] flex-col border-l border-line bg-[var(--surface)] shadow-card"
      >
        <div className="flex items-start justify-between gap-3 border-b border-line-soft px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-[14px] font-extrabold">{skill.name}</h2>
            <div className={`mt-0.5 ${hintCls}`}>
              {skill.source === "builtin" ? (
                <SystemSourceChip systemName={systemName} />
              ) : (
                SOURCE_LABEL[skill.source]
              )} · v{skill.version} ·{" "}
              {skill.enabled ? "已启用" : "未启用"}
              {pluginName && onOpenPlugin ? (
                <span className="ml-1 inline-flex align-middle">
                  <PluginSourceChip pluginName={pluginName} onOpen={onOpenPlugin} />
                </span>
              ) : null}
            </div>
          </div>
          <button type="button" onClick={onClose} className={btnGhostSm}>
            关闭
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <div className="text-[12px] font-bold text-muted">描述</div>
          <p className="mt-1 break-words text-[12px] text-[var(--body)]">
            {skill.description || "暂无描述"}
          </p>

          <div className="mt-3 text-[12px] font-bold text-muted">触发词</div>
          <div className="mt-1">
            <TagList items={skill.triggers} empty="暂无触发词" />
          </div>

          <div className="mt-3 text-[12px] font-bold text-muted">标签</div>
          <div className="mt-1">
            <TagList items={skill.tags} empty="暂无标签" />
          </div>

          <div className="mt-3 text-[12px] font-bold text-muted">指令</div>
          <pre className="mt-1 whitespace-pre-wrap break-words rounded-lg border border-line bg-[var(--subtle-2)] p-2 font-sans text-[11px] leading-5 text-[var(--body)]">
            {skill.instructions || "暂无指令"}
          </pre>
        </div>
        <div className="flex items-center gap-2 border-t border-line-soft px-4 py-3">
          <button type="button" onClick={onClose} className={btnPrimarySm}>
            完成
          </button>
          {skill.source !== "builtin" && (
            <button
              type="button"
              aria-label={`详情内删除 ${skill.name}`}
              onClick={onDelete}
              className={`ml-auto ${btnDangerSm}`}
            >
              删除
            </button>
          )}
        </div>
      </aside>
    </div>
  );
}

/* ------------------------------------------------------------------ 视图 */

export interface SkillsViewProps {
  skills?: SkillPool;
  /** 插件 store（取「插件：<名>」来源徽标要用的显示名；测试可注入）。 */
  plugins?: PluginStore;
  /**
   * 「插件：<名>」徽标被点时做什么。
   * 嵌入插件区时由宿主打开插件详情（同页弹窗）；不传则退回旧行为（投意图 + 切插件区），
   * 这样独立页/旧用例的跨页语义仍在，而宿主页内不再发生「自己跳自己」。
   */
  onOpenPlugin?: (pluginId: string) => void;
  /** 额外容器类（宿主控制高度/内边距用；视图本身不自带 PageShell）。 */
  className?: string;
  /**
   * 技能池发生变更（新建/导入/启停/分配/删除）后通知宿主。
   *
   * 为什么需要：宿主（插件区）的统计卡与能力快照来自 `describeCapabilities`，
   * 只在宿主自己的 `tick` 变化时重算。此前在「技能」Tab 里新建一个技能后，
   * 技能池已经 +1，但插件区统计仍显示旧数字（d.68 自检实测 7 → 仍 7）。
   * 这里把视图内部的变更信号透给宿主，让统计与列表同帧刷新。
   */
  onChanged?: () => void;
}

export type SkillsPageProps = SkillsViewProps;

/**
 * 可嵌入的技能视图（d.67 导航合并）。
 *
 * 为什么把技能区从「页」降级成「视图」：导航里技能区与插件区各有一个入口，
 * 但插件技能本来就会物化进技能池、分配与启停是同一份数据——两个入口只是
 * 把同一个能力面拆成两处。合并后插件区（能力中心）承载一个「技能」Tab，
 * 本视图保留技能池、按智能体分配、导入/沉淀/删除、搜索与分组，只去掉页面外壳。
 */
export function SkillsView({
  skills = skillPool,
  plugins = pluginStore,
  onOpenPlugin,
  className = "",
  onChanged,
}: SkillsViewProps = {}) {
  const [tab, setTab] = useSessionTab<"groups" | "pool" | "hub">(
    "heming.tab.skills.v1",
    "groups",
    ["groups", "pool", "hub"],
  );
  const [tick, setTick] = useState(0);
  const [query, setQuery] = useState("");
  /** 插件 id → 显示名（「插件：<名>」来源徽标用；插件店可注入便于单测）。 */
  const pluginNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of plugins.list()) map.set(item.manifest.id, item.manifest.name);
    return map;
    // tick：本页内的安装/导入动作后刷新名字（插件店是可变单例）
  }, [plugins, tick]);

  /** 系统插件的显示名（内置技能来源徽标用；不硬编码文案）。 */
  const systemName = useMemo(() => describeSystemPlugin({ skills }).name, [skills]);

  /**
   * 「插件：<名>」徽标的动作：
   * - 嵌入式（宿主传 onOpenPlugin）→ 宿主打开插件详情，留在插件区内；
   * - 独立渲染（旧外壳/旧用例）→ 仍投既有 open-plugin 内存意图再切插件区。
   */
  const openPlugin =
    onOpenPlugin ??
    ((pluginId: string) => {
      useUiStore.getState().setPaletteIntent("open-plugin", { id: pluginId });
      useUiStore.getState().setPage("plugins");
    });
  const [detailId, setDetailId] = useState<string | null>(null);
  // d.64 T3b：命令面板「插件命令」（target=skill）的定位意图。
  // 找不到该技能时只停在技能区：不报错、不弹空抽屉（页面已经切过来了）。
  const paletteIntent = useUiStore((s) => s.paletteIntent);
  const consumePaletteIntent = useUiStore((s) => s.consumePaletteIntent);
  useEffect(() => {
    if (paletteIntent?.kind !== "focus-skill") return;
    const id = paletteIntent.data?.id;
    const skill = id ? skills.list().find((item) => item.id === id) : undefined;
    if (skill) setDetailId(skill.id);
    consumePaletteIntent();
  }, [paletteIntent, consumePaletteIntent, skills]);
  const [removeTarget, setRemoveTarget] = useState<SkillDefinition | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  /** 新建技能弹窗（d.68：名称 + 内容即可创建，模板只填空字段）。 */
  const [createOpen, setCreateOpen] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  /** 智能体名册（技能按智能体分配；名册拉不到时退化为「未选择」）。 */
  const [agents, setAgents] = useState<{ id: string; name: string }[]>([]);
  const [agentId, setAgentId] = useState<string>("");
  /** 「＋ 添加技能」浮层：当前要往哪个分类里加（null = 关闭）。 */
  const [addFor, setAddFor] = useState<SkillCategory | null>(null);
  const addPanelRef = useRef<HTMLDivElement>(null);
  const closeAddPanel = () => setAddFor(null);
  useModalA11y(addPanelRef, closeAddPanel, { active: !!addFor });

  useEffect(() => {
    let cancelled = false;
    listAgents()
      .then((list) => {
        if (cancelled) return;
        setAgents(list.map((a) => ({ id: a.id, name: a.name })));
        setAgentId((cur) => cur || list[0]?.id || "");
      })
      .catch(() => {
        /* 名册失败：不阻塞技能池浏览，只是无法按智能体分配 */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const bump = () => {
    setTick((n) => n + 1);
    // 宿主统计/能力快照同源刷新（不传则保持独立页行为不变）。
    onChanged?.();
  };

  const agentName = agents.find((a) => a.id === agentId)?.name ?? "未选择智能体";

  // tick 只用于在 store 变更后强制重读快照（store 非响应式）。
  const list = useMemo(() => skills.list(), [skills, tick]);
  const usages = useMemo(() => skills.usages(), [skills, tick]);

  /** 当前智能体已分配的技能 id 集合（未选智能体时为空）。 */
  const assignedIds = useMemo(
    () => new Set(agentId ? skills.assigned(agentId) : []),
    // tick 让 store 变更后重算
    [skills, agentId, tick],
  );

  /** 「技能」页只列已分配给当前智能体的技能；「技能池」才是全量。 */
  const keyword = query.trim().toLowerCase();
  /** 搜索词命中名称 / 描述 / 标签（分组与技能池共用同一口径）。 */
  const matchesKeyword = (skill: SkillDefinition): boolean =>
    !keyword ||
    [skill.name, skill.description, ...skill.tags].some((text) =>
      text.toLowerCase().includes(keyword),
    );

  const byCategory = (key: SkillCategory): SkillDefinition[] =>
    list.filter(
      (skill) =>
        categorizeSkill(skill) === key && assignedIds.has(skill.id) && matchesKeyword(skill),
    );

  /** 某分类下「还没分配给当前智能体」的技能（＋ 面板用）。 */
  const addableIn = (key: SkillCategory): SkillDefinition[] =>
    list.filter((skill) => categorizeSkill(skill) === key && !assignedIds.has(skill.id));

  const assignSkill = (skill: SkillDefinition) => {
    if (!agentId) return;
    skills.assign(agentId, skill.id);
    bump();
    setMsg({ kind: "ok", text: `已为「${agentName}」添加技能：${skill.name}` });
  };

  const unassignSkill = (skill: SkillDefinition) => {
    if (!agentId) return;
    skills.unassign(agentId, skill.id);
    bump();
    setMsg({ kind: "ok", text: `已从「${agentName}」移除技能：${skill.name}` });
  };

  const enabledCount = list.filter((skill) => skill.enabled).length;
  const filtered = list.filter(matchesKeyword);

  const detail = detailId ? list.find((skill) => skill.id === detailId) : undefined;

  const toggleEnabled = (skill: SkillDefinition, next: boolean) => {
    skills.setEnabled(skill.id, next);
    bump();
  };

  const removeSkill = (skill: SkillDefinition) => {
    setRemoveTarget(skill);
  };

  const confirmRemoveSkill = () => {
    if (!removeTarget) return;
    const skill = removeTarget;
    skills.remove(skill.id);
    if (detailId === skill.id) setDetailId(null);
    setRemoveTarget(null);
    bump();
    setMsg({ kind: "ok", text: `已删除技能：${skill.name}` });
  };

  const distillSkill = (skill: SkillDefinition) => {
    try {
      const copy = skills.distill(skill.id);
      // 沉淀 = 已验证可用：直接分配给当前智能体，避免「沉淀完却看不见」
      if (agentId) skills.assign(agentId, copy.id);
      bump();
      setMsg({ kind: "ok", text: `已沉淀为「${copy.name}」` });
    } catch (err) {
      setMsg({
        kind: "error",
        text: `沉淀失败：${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  const onImport = () => {
    try {
      const { added, updated } = skills.importText(importText);
      setImportText("");
      setImportOpen(false);
      bump();
      setMsg({ kind: "ok", text: `导入完成：新增 ${added} 个，更新 ${updated} 个` });
    } catch (err) {
      setMsg({
        kind: "error",
        text: `导入失败：${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  const onExportAll = () => {
    const text = skills.exportAll();
    try {
      const blob = new Blob([text], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "heming-skills.json";
      link.click();
      URL.revokeObjectURL(url);
      setMsg({ kind: "ok", text: `已导出 ${list.length} 个技能（JSON）` });
    } catch {
      setMsg({
        kind: "error",
        text: "导出失败：当前环境不支持下载，可在记忆区复制整池 JSON",
      });
    }
  };

  const groupsPanel = (
    <>
      {GROUPS.map((group) => {
        const items = byCategory(group.key);
        return (
          <section key={group.key} className={`${cardCls} mt-3`} role="region" aria-label={group.title}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[12px] font-bold text-muted">{group.title}</span>
              <span className={badgeCls}>{items.length}</span>
              <button
                type="button"
                aria-label={`为${group.title}添加技能`}
                title={`为${group.title}添加技能`}
                disabled={!agentId}
                onClick={() => {
                  setMsg(null);
                  setAddFor(group.key);
                }}
                className="flex h-5 w-5 items-center justify-center rounded-sm border border-line text-muted hover:bg-[var(--subtle-3)] disabled:opacity-40"
              >
                <PlusIcon width={12} height={12} />
              </button>
              <span className={`ml-auto ${hintCls}`}>{group.hint}</span>
            </div>
            {items.length === 0 ? (
              <div className="mt-2">
                <div className={hintCls}>
                  {keyword
                    ? `没有匹配「${query.trim()}」的技能`
                    : agentId
                      ? `「${agentName}」还没有这类技能，点上方 ＋ 添加。`
                      : group.empty}
                </div>
                {!keyword && (
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {group.key === "custom" && (
                      <button
                        type="button"
                        onClick={() => {
                          setMsg(null);
                          setCreateOpen(true);
                        }}
                        className={btnPrimarySm}
                      >
                        新建技能
                      </button>
                    )}
                    {group.key === "installed" && (
                      <button
                        type="button"
                        onClick={() => {
                          setTab("pool");
                          setImportOpen(true);
                          setMsg(null);
                        }}
                        className={btnGhostSm}
                      >
                        导入 SKILL.md
                      </button>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div className="mt-3 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {items.map((skill) => (
                  <div
                    key={skill.id}
                    role="group"
                    aria-label={`技能卡 ${skill.name}`}
                    className={`group flex flex-col ${cardInnerCls} transition-colors duration-150 hover:bg-[var(--subtle-2)]`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-[13px] font-bold">{skill.name}</div>
                        <div className={`mt-0.5 ${hintCls}`}>
                          {skill.source === "builtin" ? (
                            <SystemSourceChip systemName={systemName} />
                          ) : (
                            SOURCE_LABEL[skill.source]
                          )}
                          {" "}· v{skill.version}
                          {skill.pluginId && pluginNames.get(skill.pluginId) ? (
                            <span className="ml-1.5 inline-flex align-middle">
                              <PluginSourceChip
                                pluginName={pluginNames.get(skill.pluginId)!}
                                onOpen={() => openPlugin(skill.pluginId!)}
                              />
                            </span>
                          ) : null}
                        </div>
                      </div>
                      <Switch
                        label={`启用 ${skill.name}`}
                        checked={skill.enabled}
                        onChange={(next) => toggleEnabled(skill, next)}
                      />
                    </div>

                    <p className="mt-2 line-clamp-2 min-h-[32px] break-words text-[12px] text-muted">
                      {skill.description || "暂无描述"}
                    </p>

                    <div className="mt-2 min-h-[20px]">
                      <TagList items={skill.tags} empty="暂无标签" />
                    </div>

                    <div className="mt-3 flex items-center gap-1.5 border-t border-line-soft pt-2 opacity-70 transition-opacity duration-150 hover:opacity-100 focus-within:opacity-100">
                      <button
                        type="button"
                        aria-label={`详情 ${skill.name}`}
                        onClick={() => setDetailId(skill.id)}
                        className={btnGhostSm}
                      >
                        详情
                      </button>
                      <button
                        type="button"
                        aria-label={`移除 ${skill.name}`}
                        onClick={() => unassignSkill(skill)}
                        className={btnGhostSm}
                      >
                        移除
                      </button>
                      {skill.source === "builtin" ? (
                        <span className={`ml-auto ${hintCls}`}>内置不可删</span>
                      ) : (
                        <button
                          type="button"
                          aria-label={`删除 ${skill.name}`}
                          onClick={() => removeSkill(skill)}
                          className={`ml-auto ${btnDangerSm}`}
                        >
                          删除
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        );
      })}
    </>
  );

  /** 导入面板（技能池动作区与空态共用；抽出来避免两份文案漂移）。 */
  const importPanel = importOpen ? (
    <div className="mt-3 border-t border-line-soft pt-3">
      <label className="block text-[12px] text-muted">
        导入技能内容
        <textarea
          aria-label="导入技能内容"
          value={importText}
          onChange={(e) => setImportText(e.target.value)}
          placeholder="粘贴 SKILL.md（以 --- 开头）或技能 JSON；同名/同 id 走更新"
          className="mt-1 block min-h-[110px] w-full resize-y rounded-lg border border-line-strong px-3 py-2 font-mono text-[11px] outline-hidden focus:border-ink"
        />
      </label>
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={onImport}
          disabled={!importText.trim()}
          className={btnPrimarySm}
        >
          确认导入
        </button>
        <span className={hintCls}>支持 SKILL.md、单技能 JSON、整池 JSON</span>
      </div>
    </div>
  ) : null;

  const poolPanel = (
    <>
      {list.length === 0 ? (
        <section className={`${cardCls} mt-3`}>
          <div className="ui-empty">
            <p className="ui-empty-title">技能池还是空的</p>
            <p className="ui-empty-desc">
              新建一个技能，或粘贴 SKILL.md 导入。技能要「启用 + 分配给智能体」才会用于对话。
            </p>
            <div className="ui-empty-actions">
              <button
                type="button"
                onClick={() => {
                  setMsg(null);
                  setCreateOpen(true);
                }}
                className={btnPrimarySm}
              >
                新建技能
              </button>
              <button
                type="button"
                onClick={() => {
                  setImportOpen(true);
                  setMsg(null);
                }}
                className={btnGhost}
              >
                导入 SKILL.md
              </button>
            </div>
          </div>
          {importPanel}
        </section>
      ) : (
        <>
          <section className={`${cardCls} mt-3`}>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setMsg(null);
                  setCreateOpen(true);
                }}
                className={btnPrimarySm}
              >
                新建技能
              </button>
              <button
                type="button"
                onClick={() => {
                  setImportOpen((open) => !open);
                  setMsg(null);
                }}
                className={btnGhost}
              >
                导入 SKILL.md
              </button>
              <button type="button" onClick={onExportAll} className={btnGhost}>
                导出全部
              </button>
              <span className={`ml-auto ${hintCls}`}>
                共 {list.length} 个 · 已启用 {enabledCount} 个
              </span>
            </div>
            {importPanel}
          </section>

          <section className={`${cardCls} mt-3`}>
            <div className="flex items-center gap-2">
              <span className="text-[12px] font-bold text-muted">全部技能</span>
              <span className={badgeCls}>{filtered.length}</span>
            </div>

            {filtered.length === 0 ? (
              <div className={`mt-2 ${hintCls}`}>
                {list.length === 0
                  ? "技能池为空：可导入 SKILL.md 或新建技能"
                  : `没有匹配「${query.trim()}」的技能`}
              </div>
            ) : (
              <div className="mt-2 overflow-x-auto">
                <table className="ui-table min-w-[760px]">
                  <thead>
                    <tr>
                      <th>名称</th>
                      <th>来源</th>
                      <th>启用</th>
                      <th className="text-right">使用次数</th>
                      <th>最近使用</th>
                      <th>标签</th>
                      <th className="text-right">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((skill) => (
                      <tr key={skill.id} className="align-top">
                        <td>
                          <div className="truncate font-semibold text-ink">{skill.name}</div>
                          <div className="mt-0.5 line-clamp-2 break-words ui-caption">
                            {skill.description || "暂无描述"}
                          </div>
                        </td>
                        <td>
                          {skill.source === "builtin" ? (
                            <SystemSourceChip systemName={systemName} />
                          ) : (
                            <span className={badgeCls}>{SOURCE_LABEL[skill.source]}</span>
                          )}
                          {skill.pluginId && pluginNames.get(skill.pluginId) ? (
                            <span className="ml-1.5 inline-flex align-middle">
                              <PluginSourceChip
                                pluginName={pluginNames.get(skill.pluginId)!}
                                onOpen={() => openPlugin(skill.pluginId!)}
                              />
                            </span>
                          ) : null}
                        </td>
                        <td>
                          <Switch
                            label={`启用 ${skill.name}`}
                            checked={skill.enabled}
                            onChange={(next) => toggleEnabled(skill, next)}
                          />
                        </td>
                        <td className="ui-numeric text-right text-[var(--body)]">
                          {usages[skill.id]?.count ?? 0}
                        </td>
                        <td className="ui-caption">{formatAt(usages[skill.id]?.at)}</td>
                        <td>
                          <TagList items={skill.tags} empty="—" />
                        </td>
                        <td className="text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            <button
                              type="button"
                              aria-label={`池中详情 ${skill.name}`}
                              onClick={() => setDetailId(skill.id)}
                              className={btnGhostSm}
                            >
                              详情
                            </button>
                            {skill.source !== "builtin" && skill.source !== "distilled" && (
                              <button
                                type="button"
                                aria-label={`沉淀 ${skill.name}`}
                                onClick={() => distillSkill(skill)}
                                className={btnGhostSm}
                              >
                                转为沉淀
                              </button>
                            )}
                            {skill.source !== "builtin" && (
                              <button
                                type="button"
                                aria-label={`池中删除 ${skill.name}`}
                                onClick={() => removeSkill(skill)}
                                className={btnDangerSm}
                              >
                                删除
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <p className={`mt-2 ${hintCls}`}>
            技能池 = 所有可用技能的集合。要用于对话，需要「启用」并「分配给对应智能体」。
          </p>
        </>
      )}
    </>
  );

  return (
    <div className={className}>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {tab !== "hub" && (
            <>
              <label htmlFor="skill-agent-select" className="ui-caption">
                给哪个智能体用
              </label>
              <select
                id="skill-agent-select"
                aria-label="选择智能体"
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
                className={`${inputSmCls} min-w-[160px]`}
              >
                {agents.length === 0 && <option value="">（名册加载中…）</option>}
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
              <span className={hintCls}>
                {agentId
                  ? `已分配 ${assignedIds.size} 个技能；只有已分配的技能才会用于「${agentName}」的对话`
                  : "先选择智能体，才能把技能分配给它使用"}
              </span>
            </>
          )}
          </div>
        <div role="tablist" aria-label="技能视图" className="flex items-center gap-1">
          <button
            type="button"
            role="tab"
            id="skill-groups-tab"
            aria-controls="skill-groups-panel"
            aria-selected={tab === "groups"}
            onClick={() => setTab("groups")}
            className={`ui-btn ui-btn-sm ${tab === "groups" ? "ui-btn-primary" : "ui-btn-ghost text-muted"}`}
          >
            按智能体
          </button>
          <button
            type="button"
            role="tab"
            id="skill-pool-tab"
            aria-controls="skill-pool-panel"
            aria-selected={tab === "pool"}
            onClick={() => setTab("pool")}
            className={`ui-btn ui-btn-sm ${tab === "pool" ? "ui-btn-primary" : "ui-btn-ghost text-muted"}`}
          >
            技能池
          </button>
          <button
            type="button"
            role="tab"
            id="skill-hub-tab"
            aria-controls="skill-hub-panel"
            aria-selected={tab === "hub"}
            onClick={() => setTab("hub")}
            className={`ui-btn ui-btn-sm ${tab === "hub" ? "ui-btn-primary" : "ui-btn-ghost text-muted"}`}
          >
            社区
          </button>
        </div>
      </div>

      {/* 搜索提到页头：分组视图与技能池共用同一个搜索词（此前分组视图完全忽略它）。
          社区 Tab 用自己的搜索框（服务端检索 + 防抖），不复用本机技能搜索。 */}
      {tab !== "hub" && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            aria-label="搜索技能"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="按名称、描述或标签搜索"
            className={`${inputSmCls} min-w-[180px] max-w-[320px] flex-1`}
          />
          <span className={hintCls}>
            {keyword
              ? tab === "groups"
                ? `分组内匹配 ${GROUPS.reduce((n, g) => n + byCategory(g.key).length, 0)} 个`
                : `匹配 ${filtered.length} 个`
              : "搜索同时作用于分组与技能池"}
          </span>
        </div>
      )}

      {msg && (
        <div role="status" className={`mt-2 ${msg.kind === "error" ? errorCls : okCls}`}>
          {msg.text}
        </div>
      )}

      <div
        role="tabpanel"
        id={tab === "groups" ? "skill-groups-panel" : tab === "pool" ? "skill-pool-panel" : "skill-hub-panel"}
        aria-labelledby={tab === "groups" ? "skill-groups-tab" : tab === "pool" ? "skill-pool-tab" : "skill-hub-tab"}
      >
        {tab === "groups" ? (
          groupsPanel
        ) : tab === "pool" ? (
          poolPanel
        ) : (
          <SkillHubPanel
            skills={skills}
            onInstalled={() => {
              setTick((n) => n + 1);
              onChanged?.();
            }}
            onGoAssign={() => setTab("pool")}
          />
        )}
      </div>

      {addFor && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-4"
          onClick={() => setAddFor(null)}
        >
          <div
            ref={addPanelRef}
            role="dialog"
            aria-modal="true"
            aria-label="添加技能"
            className="w-[440px] max-w-full ui-card p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-bold">
                为「{agentName}」添加{GROUPS.find((g) => g.key === addFor)?.title}
              </span>
              <button
                type="button"
                aria-label="关闭添加面板"
                onClick={() => setAddFor(null)}
                className="ml-auto rounded-sm p-1 text-muted hover:bg-[var(--subtle-3)] hover:text-ink"
              >
                <XIcon width={14} height={14} aria-hidden="true" />
              </button>
            </div>
            <div className="mt-2 max-h-[320px] overflow-y-auto">
              {addableIn(addFor).length === 0 ? (
                <p className={hintCls}>该分类下没有可添加的技能；可先去技能池导入或沉淀。</p>
              ) : (
                <ul className="divide-y divide-[#f1f1f1]">
                  {addableIn(addFor).map((skill) => (
                    <li key={skill.id}>
                      <button
                        type="button"
                        aria-label={`添加 ${skill.name}`}
                        onClick={() => {
                          assignSkill(skill);
                          setAddFor(null);
                        }}
                        className="ui-list-row w-full text-left"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[12px] font-medium">{skill.name}</span>
                          <span className={`block truncate ${hintCls}`}>
                            {skill.description || "暂无描述"}
                          </span>
                        </span>
                        <span className="shrink-0 text-[11px] text-muted">
                          {SOURCE_LABEL[skill.source]}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 写作能力（去 AI 味）不再单独占卡片：规则已并入内置「写作润色」技能的默认流程，
          技能池里的「去 AI 味」技能与 tone_detect 工具仍可直接使用（d.126）。 */}

      {/* 自我优化：让智能体改自己的记忆/技能/MCP。与「技能」同属能力配置，故放这里 */}
      <SelfEditCard
        agents={agents}
        agentId={agentId}
        targets={{ memory: memoryStore, skills, mcp: mcpRegistry }}
      />

      <SkillCreateDialog
        open={createOpen}
        skills={skills}
        agentId={agentId}
        agentName={agentName}
        onClose={() => setCreateOpen(false)}
        onCreated={(skill, assigned) => {
          bump();
          setMsg({
            kind: "ok",
            text: assigned
              ? `已新建技能「${skill.name}」，并分配给「${agentName}」；对话时就会用上。`
              : `已新建技能「${skill.name}」；选中智能体后到「技能池」分配，才会用于对话。`,
          });
        }}
      />

      {detail && (
        <SkillDetailDrawer
          skill={detail}
          onClose={() => setDetailId(null)}
          onDelete={() => removeSkill(detail)}
          systemName={systemName}
          pluginName={detail.pluginId ? pluginNames.get(detail.pluginId) : undefined}
          onOpenPlugin={detail.pluginId ? () => openPlugin(detail.pluginId!) : undefined}
        />
      )}

      {removeTarget && (
        <ConfirmDialog
          title="删除技能"
          onCancel={() => setRemoveTarget(null)}
          footer={
            <>
              <button
                type="button"
                onClick={() => setRemoveTarget(null)}
                className="ui-btn ui-btn-md ui-btn-ghost text-muted"
              >
                取消
              </button>
              <button
                type="button"
                onClick={confirmRemoveSkill}
                className="ui-btn ui-btn-md ui-btn-danger"
              >
                删除
              </button>
            </>
          }
        >
          <p className="text-[12px] leading-6">
            删除技能「{removeTarget.name}」？技能定义、使用统计和所有智能体上的分配都会被移除，
            此操作不可恢复。
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}

/**
 * 旧独立入口的过渡外壳（d.67 导航合并）。
 *
 * `skills` 路由已不存在——旧链接会被 `store/ui.ts` 折叠成「插件区 + 技能视图」；
 * App 侧已不再引用本组件。保留一个带 PageShell 的导出，只是让旧引用/旧用例
 * 在这段时间里不会把构建打挂；新代码请用 `SkillsView`。
 */
export function SkillsPage({ skills, plugins, onChanged }: SkillsPageProps = {}) {
  return (
    <PageShell
      title="技能区"
      subtitle="技能区已并入插件区的「技能」视图；此独立入口仅作旧链接兼容。"
      width="wide"
    >
      <SkillsView skills={skills} plugins={plugins} onChanged={onChanged} />
    </PageShell>
  );
}
