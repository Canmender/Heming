import { useEffect, useMemo, useRef, useState } from "react";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { EmptyState } from "./ui/EmptyState.js";
import { useModalA11y } from "./useModalA11y.js";
import {
  skillPool,
  type SkillDefinition,
  type SkillPool,
} from "../lib/skills/index.js";
import { PageShell } from "./layout/PageShell.js";
import { describeSystemPlugin, pluginStore, type PluginStore } from "../lib/plugins/index.js";
import { useUiStore } from "../store/ui.js";
import { useSessionTab } from "../lib/sessionState.js";
import { SkillHubPanel } from "./skills/SkillHubPanel.js";
import { Dialog } from "./ui/Dialog.js";
import { Switch } from "./ui/Switch.js";
import { Button } from "../components/ui/Button.js";
import { useRovingTabs } from "../lib/ui/tabs.js";

/** 技能视图的两个页签（顺序即键盘 ←/→ 顺序）。 */
type SkillTab = "local" | "hub";
const SKILL_TAB_ORDER: readonly SkillTab[] = ["local", "hub"];

/**
 * 技能区：本机技能（四类分组）与社区两个视图。
 *
 * d.148.4.95：产品只有唯一内置智能体，技能不再「分配给某个智能体」——
 * 启用即对对话生效（路由层把全部已启用技能都纳入匹配），页面删掉分配/移除、
 * 技能池表格、使用统计与自我优化卡，只留「有哪些技能 + 开关 + 详情/删除」。
 * 数据只来自本机 lib/skills 的单例（测试注入独立实例），不重写存储。
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

/** 来源的中文标签（卡片与抽屉共用）。 */
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
    empty: "暂无内置技能：预置技能删除后不再自动恢复。",
  },
  {
    key: "installed",
    title: "已装技能",
    hint: "由 SKILL.md、JSON 或社区安装",
    empty: "暂无已装技能：点「导入 SKILL.md」，或去社区装一个。",
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
    empty: "暂无自定义技能：点「新建技能」直接建一个。",
  },
];

/* ------------------------------------------------------------------ 样式 */

const cardCls = "ui-card p-4";
const cardInnerCls = "rounded-lg border border-line p-3";
const chipCls = "ui-chip";
const badgeCls = "ui-chip";
const inputSmCls = "ui-input";
const hintCls = "ui-caption";
const errorCls = "ui-body-sm text-danger";
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
      "你在帮我润色中文文稿。\\n1. 先通读全文，保留作者原意与事实，不新增观点。\\n2. 只改病句、重复和口语化表达，语气跟随原文。\\n3. 先给改后全文，再用 3 条以内说明主要改动。",
  },
  {
    key: "review",
    label: "代码审查",
    name: "代码审查",
    description: "找出改动里的 bug、风险与遗漏",
    instructions:
      "你在审查一段代码改动。\\n1. 先读上下文与调用方，确认改动意图。\\n2. 按「会出错 > 有风险 > 可读性」的顺序列问题，标出文件与行号。\\n3. 每个问题都给出具体改法；没问题就直说，不要凑数。",
  },
  {
    key: "minutes",
    label: "会议纪要",
    name: "会议纪要",
    description: "把讨论整理成结论、待办与负责人",
    instructions:
      "你在整理会议纪要。\\n1. 输出三块：结论、待办（负责人 + 期限）、待定问题。\\n2. 只写会上真实说过的内容，不补充推测。\\n3. 待办要能直接执行；信息缺失时标注「待确认」。",
  },
];

/* ------------------------------------------------------------ 新建技能弹窗 */

/**
 * 新建技能弹窗（d.68 简化）：
 * - 必填只有「名称」与「技能内容」，其余可空；
 * - 3 个模板只填空字段；
 * - 创建后立即启用，对话时按需自动匹配（不再需要「分配给谁」这一步）。
 */
function SkillCreateDialog({
  open,
  skills,
  onClose,
  onCreated,
}: {
  open: boolean;
  skills: SkillPool;
  onClose: () => void;
  onCreated: (skill: SkillDefinition) => void;
}) {
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [applied, setApplied] = useState<string | null>(null);
  const [errors, setErrors] = useState<{ name?: string; instructions?: string }>({});

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
    onCreated(created);
    onClose();
  };

  const activeTemplate = SKILL_TEMPLATES.find((item) => item.key === applied);

  // R17：改走 ui/Dialog——底栏在 <form> 之外，提交按钮用 form= 指回表单。
  return (
    <Dialog
      ariaLabel="新建技能"
      title="新建技能"
      description="只需名称和内容，其余可空"
      size="sm"
      maxHeightVh={90}
      onClose={onClose}
      closeLabel="关闭新建技能"
      initialFocusRef={nameRef}
      footer={
        <>
          <Button type="button" onClick={onClose} size="sm" variant="ghost">
            取消
          </Button>
          <Button type="submit" form="skill-create-form" size="sm" variant="primary">
            创建技能
          </Button>
        </>
      }
    >
      <form id="skill-create-form" onSubmit={submit}>
        <div className="mb-3 rounded-lg border border-line-soft bg-subtle-2 p-2.5">
          <div className={hintCls}>从模板开始（可选）</div>
          <div className="mt-1.5 flex flex-wrap gap-1.5" role="group" aria-label="技能模板">
            {SKILL_TEMPLATES.map((template) => (
              <Button
                key={template.key}
                type="button"
                aria-label={`使用模板 ${template.label}`}
                aria-pressed={applied === template.key}
                onClick={() => applyTemplate(template)}
                size="sm" variant="ghost"
              >
                {template.label}
              </Button>
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
              "写清「什么时候用它 + 按什么步骤做」。例如：\\n你在帮我润色周报。\\n1. 先删掉套话与重复。\\n2. 保留数字与结论，语气跟随原文。\\n3. 先给改后全文，再说明主要改动。"
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
          创建后立即启用，对话时会按需自动匹配；想暂时不用，可在列表里关掉开关。
        </p>
      </form>
    </Dialog>
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
        className="absolute inset-0 bg-scrim"
      />
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={`技能详情 ${skill.name}`}
        className="relative flex h-full w-[380px] max-w-[92vw] flex-col border-l border-line bg-surface ui-overlay-shadow"
      >
        <div className="flex items-start justify-between gap-3 border-b border-line-soft px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-ui-base font-semibold">{skill.name}</h2>
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
          <Button type="button" onClick={onClose} size="sm" variant="ghost">
            关闭
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <div className="text-ui-sm font-semibold text-muted">描述</div>
          <p className="mt-1 break-words text-ui-sm text-body">
            {skill.description || "暂无描述"}
          </p>

          <div className="mt-3 text-ui-sm font-semibold text-muted">触发词</div>
          <div className="mt-1">
            <TagList items={skill.triggers} empty="暂无触发词" />
          </div>

          <div className="mt-3 text-ui-sm font-semibold text-muted">标签</div>
          <div className="mt-1">
            <TagList items={skill.tags} empty="暂无标签" />
          </div>

          <div className="mt-3 text-ui-sm font-semibold text-muted">指令</div>
          <pre className="mt-1 whitespace-pre-wrap break-words rounded-lg border border-line bg-subtle-2 p-2 font-sans text-ui-xs leading-5 text-body">
            {skill.instructions || "暂无指令"}
          </pre>
        </div>
        <div className="flex items-center gap-2 border-t border-line-soft px-4 py-3">
          <Button type="button" onClick={onClose} size="sm" variant="primary">
            完成
          </Button>
          {skill.source !== "builtin" && (
            <Button
              type="button"
              aria-label={`详情内删除 ${skill.name}`}
              onClick={onDelete}
              size="sm"
              variant="ghost"
              className="ml-auto text-danger"
            >
              删除
            </Button>
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
   * 技能池发生变更（新建/导入/启停/删除）后通知宿主。
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
 * 可嵌入的技能视图（d.67 导航合并；d.148.4.95 去分配）。
 *
 * 为什么把技能区从「页」降级成「视图」：导航里技能区与插件区各有一个入口，
 * 但插件技能本来就会物化进技能池、分配与启停是同一份数据——两个入口只是
 * 把同一个能力面拆成两处。合并后插件区（能力中心）承载一个「技能」Tab。
 */
export function SkillsView({
  skills = skillPool,
  plugins = pluginStore,
  onOpenPlugin,
  className = "",
  onChanged,
}: SkillsViewProps = {}) {
  // v2：旧的 groups/pool 两个页签已合并成单一列表，读到旧值时回落到「本机技能」。
  const [tab, setTab] = useSessionTab<SkillTab>("heming.tab.skills.v2", "local", SKILL_TAB_ORDER);
  // 页签键盘行为（③-1）：整组一个 Tab 停靠点，←/→/Home/End 切换并移动焦点。
  const skillTabs = useRovingTabs({
    count: SKILL_TAB_ORDER.length,
    activeIndex: SKILL_TAB_ORDER.indexOf(tab),
    onChange: (index) => setTab(SKILL_TAB_ORDER[index]),
  });
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

  const bump = () => {
    setTick((n) => n + 1);
    // 宿主统计/能力快照同源刷新（不传则保持独立页行为不变）。
    onChanged?.();
  };

  // tick 只用于在 store 变更后强制重读快照（store 非响应式）。
  const list = useMemo(() => skills.list(), [skills, tick]);

  const keyword = query.trim().toLowerCase();
  /** 搜索词命中名称 / 描述 / 标签（全部技能共用一个口径）。 */
  const matchesKeyword = (skill: SkillDefinition): boolean =>
    !keyword ||
    [skill.name, skill.description, ...skill.tags].some((text) =>
      text.toLowerCase().includes(keyword),
    );

  const byCategory = (key: SkillCategory): SkillDefinition[] =>
    list.filter((skill) => categorizeSkill(skill) === key && matchesKeyword(skill));

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

  /** 导入面板（工具栏与空态共用；抽出来避免两份文案漂移）。 */
  const importPanel = importOpen ? (
    <div className="mt-3 border-t border-line-soft pt-3">
      <label className="block text-ui-sm text-muted">
        导入技能内容
        <textarea
          aria-label="导入技能内容"
          value={importText}
          onChange={(e) => setImportText(e.target.value)}
          placeholder="粘贴 SKILL.md（以 --- 开头）或技能 JSON；同名/同 id 走更新"
          className="mt-1 block min-h-[110px] w-full resize-y rounded-lg border border-line-strong px-3 py-2 font-mono text-ui-xs outline-hidden focus:border-ink"
        />
      </label>
      <div className="mt-2 flex items-center gap-2">
        <Button
          type="button"
          onClick={onImport}
          disabled={!importText.trim()}
          size="sm" variant="primary"
        >
          确认导入
        </Button>
        <span className={hintCls}>支持 SKILL.md、单技能 JSON、整池 JSON</span>
      </div>
    </div>
  ) : null;

  const toolbar = (
    <section className={`${cardCls} mt-3`}>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          onClick={() => {
            setMsg(null);
            setCreateOpen(true);
          }}
          size="sm" variant="primary"
        >
          新建技能
        </Button>
        <Button
          type="button"
          onClick={() => {
            setImportOpen((open) => !open);
            setMsg(null);
          }}
          size="md" variant="ghost"
        >
          导入 SKILL.md
        </Button>
        <Button type="button" onClick={onExportAll} size="md" variant="ghost">
          导出全部
        </Button>
        <span className={`ml-auto ${hintCls}`}>
          共 {list.length} 个 · 已启用 {enabledCount} 个
        </span>
      </div>
      {importPanel}
    </section>
  );

  const groupsPanel = (
    <>
      {GROUPS.map((group) => {
        const items = byCategory(group.key);
        return (
          <section key={group.key} className={`${cardCls} mt-3`} role="region" aria-label={group.title}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-ui-sm font-semibold text-muted">{group.title}</span>
              <span className={badgeCls}>{items.length}</span>
              <span className={`ml-auto ${hintCls}`}>{group.hint}</span>
            </div>
            {items.length === 0 ? (
              <div className={`mt-2 ${hintCls}`}>
                {keyword ? `没有匹配「${query.trim()}」的技能` : group.empty}
              </div>
            ) : (
              <div className="mt-3 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {items.map((skill) => (
                  <div
                    key={skill.id}
                    role="group"
                    aria-label={`技能卡 ${skill.name}`}
                    className={`group flex flex-col ${cardInnerCls} transition-colors duration-fast hover:bg-subtle-2`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-ui-md font-semibold">{skill.name}</div>
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

                    <p className="mt-2 line-clamp-2 min-h-[32px] break-words text-ui-sm text-muted">
                      {skill.description || "暂无描述"}
                    </p>

                    <div className="mt-2 min-h-[20px]">
                      <TagList items={skill.tags} empty="暂无标签" />
                    </div>

                    <div className="mt-3 flex items-center gap-1.5 border-t border-line-soft pt-2 opacity-70 transition-opacity duration-fast hover:opacity-100 focus-within:opacity-100">
                      <Button
                        type="button"
                        aria-label={`详情 ${skill.name}`}
                        onClick={() => setDetailId(skill.id)}
                        size="sm" variant="ghost"
                      >
                        详情
                      </Button>
                      {skill.source === "builtin" ? (
                        <span className={`ml-auto ${hintCls}`}>内置不可删</span>
                      ) : (
                        <Button
                          type="button"
                          aria-label={`删除 ${skill.name}`}
                          onClick={() => removeSkill(skill)}
                          size="sm"
                          variant="ghost"
                          className="ml-auto text-danger"
                        >
                          删除
                        </Button>
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

  const localPanel =
    list.length === 0 ? (
      <section className={`${cardCls} mt-3`}>
        <EmptyState
          title="还没有任何技能"
          desc="新建一个技能，或粘贴 SKILL.md 导入；社区里也能装现成的。启用后对话时会按需自动匹配。"
          actions={
            <>
              <Button
                type="button"
                onClick={() => {
                  setMsg(null);
                  setCreateOpen(true);
                }}
                size="sm" variant="primary"
              >
                新建技能
              </Button>
              <Button
                type="button"
                onClick={() => {
                  setImportOpen(true);
                  setMsg(null);
                }}
                size="md" variant="ghost"
              >
                导入 SKILL.md
              </Button>
            </>
          }
        />
        {importPanel}
      </section>
    ) : (
      <>
        {toolbar}
        {filtered.length === 0 ? (
          <section className={`${cardCls} mt-3`}>
            <div className={hintCls}>没有匹配「{query.trim()}」的技能</div>
          </section>
        ) : (
          groupsPanel
        )}
      </>
    );

  return (
    <div className={className}>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {tab !== "hub" && (
            <span className={hintCls}>
              技能启用后即在对话里生效；共 {list.length} 个 · 已启用 {enabledCount} 个
            </span>
          )}
        </div>
        <div
          role="tablist"
          aria-label="技能视图"
          className="flex items-center gap-1"
          onKeyDown={skillTabs.onKeyDown}
        >
          <Button
            type="button"
            role="tab"
            id="skill-local-tab"
            ref={skillTabs.getTabRef(0)}
            tabIndex={skillTabs.tabIndexFor(0)}
            aria-controls={tab === "local" ? "skill-local-panel" : undefined}
            aria-selected={tab === "local"}
            onClick={() => setTab("local")}
            size="sm" variant={tab === "local" ? "primary" : "ghost"} className={tab === "local" ? undefined : "text-muted"}
          >
            本机技能
          </Button>
          <Button
            type="button"
            role="tab"
            id="skill-hub-tab"
            ref={skillTabs.getTabRef(1)}
            tabIndex={skillTabs.tabIndexFor(1)}
            aria-controls={tab === "hub" ? "skill-hub-panel" : undefined}
            aria-selected={tab === "hub"}
            onClick={() => setTab("hub")}
            size="sm" variant={tab === "hub" ? "primary" : "ghost"} className={tab === "hub" ? undefined : "text-muted"}
          >
            社区
          </Button>
        </div>
      </div>

      {/* 搜索只作用于本机技能列表；社区 Tab 有自己的服务端检索框。 */}
      {tab === "local" && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            aria-label="搜索技能"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="按名称、描述或标签搜索"
            className={`${inputSmCls} min-w-[180px] max-w-[320px] flex-1`}
          />
          <span className={hintCls}>
            {keyword ? `匹配 ${filtered.length} 个` : "搜索同时作用于名称、描述与标签"}
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
        id={tab === "local" ? "skill-local-panel" : "skill-hub-panel"}
        aria-labelledby={tab === "local" ? "skill-local-tab" : "skill-hub-tab"}
      >
        {tab === "local" ? (
          localPanel
        ) : (
          <SkillHubPanel
            skills={skills}
            onInstalled={() => {
              setTick((n) => n + 1);
              onChanged?.();
            }}
            onGoSkills={() => setTab("local")}
          />
        )}
      </div>

      <SkillCreateDialog
        open={createOpen}
        skills={skills}
        onClose={() => setCreateOpen(false)}
        onCreated={(skill) => {
          bump();
          setMsg({ kind: "ok", text: `已新建技能「${skill.name}」；对话时就会按需匹配。` });
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
              <Button
                type="button"
                onClick={() => setRemoveTarget(null)}
                size="md" variant="ghost" className="text-muted"
              >
                取消
              </Button>
              <Button
                type="button"
                onClick={confirmRemoveSkill}
                size="md" variant="danger"
              >
                删除
              </Button>
            </>
          }
        >
          <p className="text-ui-sm leading-6">
            删除技能「{removeTarget.name}」？技能定义和使用统计都会被移除，
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
