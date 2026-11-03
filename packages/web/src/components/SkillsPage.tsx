import { useEffect, useMemo, useRef, useState } from "react";
import { listAgents } from "../lib/agentsApi.js";
import { SelfEditCard } from "./SelfEditCard.js";
import { ToneCard } from "./ToneCard.js";
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
    empty: "暂无自定义技能：可在记忆区新建，或把导入的技能转为沉淀。",
  },
];

/* ------------------------------------------------------------------ 样式 */

const cardCls = "rounded-xl border border-line bg-white p-4 shadow-card";
const cardInnerCls = "rounded-lg border border-line p-3";
const chipCls = "ui-chip";
const badgeCls = "ui-chip";
const btnGhost = "ui-btn ui-btn-md ui-btn-ghost";
const btnGhostSm = "ui-btn ui-btn-sm ui-btn-ghost";
const btnDangerSm = "ui-btn ui-btn-sm ui-btn-ghost text-[#b42318]";
const btnPrimarySm = "ui-btn ui-btn-sm ui-btn-primary";
const inputSmCls = "ui-input";
const hintCls = "ui-caption";
const errorCls = "ui-body-sm text-[#b42318]";
const okCls = "ui-body-sm text-muted";

/* ---------------------------------------------------------------- 基础件 */

function Switch({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-[18px] w-[32px] shrink-0 rounded-full transition-colors duration-150 ${
        checked ? "bg-ink" : "bg-[#d8d8d8]"
      }`}
    >
      <span
        className={`absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white transition-all duration-150 ${
          checked ? "left-[16px]" : "left-[2px]"
        }`}
      />
    </button>
  );
}

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

/* ------------------------------------------------------------------ 详情 */

function SkillDetailDrawer({
  skill,
  onClose,
  onDelete,
}: {
  skill: SkillDefinition;
  onClose: () => void;
  onDelete: () => void;
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
        className="relative flex h-full w-[380px] max-w-[92vw] flex-col border-l border-line bg-white shadow-card"
      >
        <div className="flex items-start justify-between gap-3 border-b border-line-soft px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-[14px] font-extrabold">{skill.name}</h2>
            <div className={`mt-0.5 ${hintCls}`}>
              {SOURCE_LABEL[skill.source]} · v{skill.version}
              {skill.pluginId ? ` · 插件 ${skill.pluginId}` : ""} ·{" "}
              {skill.enabled ? "已启用" : "未启用"}
            </div>
          </div>
          <button type="button" onClick={onClose} className={btnGhostSm}>
            关闭
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <div className="text-[12px] font-bold text-muted">描述</div>
          <p className="mt-1 break-words text-[12px] text-[#555]">
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
          <pre className="mt-1 whitespace-pre-wrap break-words rounded-lg border border-line bg-[#fafafa] p-2 font-sans text-[11px] leading-5 text-[#333]">
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

/* ------------------------------------------------------------------ 页面 */

export interface SkillsPageProps {
  skills?: SkillPool;
}

export function SkillsPage({ skills = skillPool }: SkillsPageProps = {}) {
  const [tab, setTab] = useState<"groups" | "pool">("groups");
  const [tick, setTick] = useState(0);
  const [query, setQuery] = useState("");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<SkillDefinition | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
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

  const bump = () => setTick((n) => n + 1);

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
                className="flex h-5 w-5 items-center justify-center rounded-sm border border-line text-muted hover:bg-[#f3f3f3] disabled:opacity-40"
              >
                <PlusIcon width={12} height={12} />
              </button>
              <span className={`ml-auto ${hintCls}`}>{group.hint}</span>
            </div>
            {items.length === 0 ? (
              <div className={`mt-2 ${hintCls}`}>
                {keyword
                  ? `没有匹配「${query.trim()}」的技能`
                  : agentId
                    ? `「${agentName}」还没有这类技能，点上方 ＋ 添加。`
                    : group.empty}
              </div>
            ) : (
              <div className="mt-3 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {items.map((skill) => (
                  <div
                    key={skill.id}
                    role="group"
                    aria-label={`技能卡 ${skill.name}`}
                    className={`group flex flex-col ${cardInnerCls} transition-colors duration-150 hover:bg-[#fcfcfc]`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-[13px] font-bold">{skill.name}</div>
                        <div className={`mt-0.5 ${hintCls}`}>
                          {SOURCE_LABEL[skill.source]} · v{skill.version}
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

  const poolPanel = (
    <>
      <section className={`${cardCls} mt-3`}>
        <div className="flex flex-wrap items-center gap-2">
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

        {importOpen && (
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
        )}
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
                      <span className={badgeCls}>{SOURCE_LABEL[skill.source]}</span>
                    </td>
                    <td>
                      <Switch
                        label={`启用 ${skill.name}`}
                        checked={skill.enabled}
                        onChange={(next) => toggleEnabled(skill, next)}
                      />
                    </td>
                    <td className="ui-numeric text-right text-[#555]">
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
        技能池 = 所有可用技能的集合，按需启用；被启用的技能才会参与路由。
      </p>
    </>
  );

  return (
    <PageShell
      title="技能区"
      subtitle="选择智能体后，可把技能分配给它在会话里使用；技能池展示全部技能。"
      width="wide"
    >
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="skill-agent-select" className="ui-caption">
            分配对象
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
              已分配 {assignedIds.size} 个技能 · 未分配的请到「技能池」查看
            </span>
          </div>
        <div
          role="tablist"
          aria-label="技能区视图"
          className="inline-flex overflow-hidden rounded-lg border border-line shadow-card"
        >
          <button
            type="button"
            role="tab"
            id="skill-groups-tab"
            aria-controls="skill-groups-panel"
            aria-selected={tab === "groups"}
            onClick={() => setTab("groups")}
            className={`px-3 py-1.5 text-[12px] transition-colors duration-150 ${
              tab === "groups" ? "bg-ink font-bold text-white" : "text-muted hover:bg-[#fafafa]"
            }`}
          >
            技能
          </button>
          <button
            type="button"
            role="tab"
            id="skill-pool-tab"
            aria-controls="skill-pool-panel"
            aria-selected={tab === "pool"}
            onClick={() => setTab("pool")}
            className={`border-l border-line px-3 py-1.5 text-[12px] transition-colors duration-150 ${
              tab === "pool" ? "bg-ink font-bold text-white" : "text-muted hover:bg-[#fafafa]"
            }`}
          >
            技能池
          </button>
        </div>
      </div>

      {/* 搜索提到页头：分组视图与技能池共用同一个搜索词（此前分组视图完全忽略它）。 */}
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

      {msg && (
        <div role="status" className={`mt-2 ${msg.kind === "error" ? errorCls : okCls}`}>
          {msg.text}
        </div>
      )}

      <div
        role="tabpanel"
        id={tab === "groups" ? "skill-groups-panel" : "skill-pool-panel"}
        aria-labelledby={tab === "groups" ? "skill-groups-tab" : "skill-pool-tab"}
      >
        {tab === "groups" ? groupsPanel : poolPanel}
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
            className="w-[440px] max-w-full rounded-xl border border-line bg-white p-4 shadow-card"
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
                className="ml-auto rounded-sm p-1 text-muted hover:bg-[#f3f3f3] hover:text-ink"
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

      {/* 写作能力：去 AI 味的规则集与即时检测。与「技能」同属能力配置，故放这里 */}
      <ToneCard />

      {/* 自我优化：让智能体改自己的记忆/技能/MCP。与「技能」同属能力配置，故放这里 */}
      <SelfEditCard
        agents={agents}
        agentId={agentId}
        targets={{ memory: memoryStore, skills, mcp: mcpRegistry }}
      />

      {detail && (
        <SkillDetailDrawer
          skill={detail}
          onClose={() => setDetailId(null)}
          onDelete={() => removeSkill(detail)}
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
                className="rounded-lg border border-line px-3 py-1.5 text-[12px] text-muted hover:bg-[#f7f7f7]"
              >
                取消
              </button>
              <button
                type="button"
                onClick={confirmRemoveSkill}
                className="rounded-lg bg-[#b42318] px-3 py-1.5 text-[12px] font-medium text-white"
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
    </PageShell>
  );
}
