import { useCallback, useEffect, useMemo, useState } from "react";
import type { Agent } from "@heming/shared";
import {
  MEMORY_CHAR_BUDGET,
  WORKING_TTL_MS,
  extractExplicitMemory,
  formatMemorySection,
  memoryStore,
  normalizeKey,
  recallMemory,
  type EpisodicEntry,
  type MemoryData,
  type MemoryStore,
  type SemanticEntry,
  type WorkingTurn,
} from "../lib/memory/index.js";
import {
  DEFAULT_ROUTE_BUDGET,
  formatSkillSection,
  skillPool,
  type SkillDefinition,
  type SkillMatch,
  type SkillPool,
} from "../lib/skills/index.js";
import { listAgents } from "../lib/agentsApi.js";
import { DownloadIcon, PlusIcon, TrashIcon } from "./icons.js";

/**
 * 记忆区（设计 §7）：三层记忆总览 + 技能池。
 * - 数据只来自本机 lib/memory、lib/skills（默认取模块单例，测试注入独立实例）；
 * - 记忆按智能体隔离：写入口（添加/整理/绑定）需先选具体智能体，「全部智能体」只做只读汇总；
 * - 一切失败都内联中文提示，不用 window.alert（与设置区同风格）。
 */

export interface MemoryPageProps {
  memory?: MemoryStore;
  skills?: SkillPool;
}

/* ------------------------------------------------------------------ 样式 */

const cardCls = "rounded-xl border border-line bg-white p-4 shadow-card";
const inputCls =
  "mt-1 block w-full rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-[#bbb]";
const inputSmCls =
  "mt-1 block w-full rounded-lg border border-line px-2.5 py-1.5 text-[12px] outline-none focus:border-[#bbb]";
const labelCls = "block text-[12px] text-muted";
const btnGhost =
  "rounded-lg border border-line px-3 py-1.5 text-[12px] shadow-card transition-colors duration-150 hover:bg-[#fafafa] disabled:opacity-40";
const btnGhostSm =
  "rounded-lg border border-line px-2 py-1 text-[11px] text-[#555] shadow-card transition-colors duration-150 hover:bg-[#fafafa]";
const btnDangerSm =
  "rounded-lg border border-line p-1.5 text-[#b42318] shadow-card transition-colors duration-150 hover:bg-[#fafafa]";
const btnPrimary = "rounded-lg bg-ink px-4 py-1.5 text-sm font-bold text-white disabled:opacity-40";
const btnPrimarySm =
  "rounded-lg bg-ink px-3 py-1.5 text-[12px] font-bold text-white disabled:opacity-40";
const hintCls = "text-[11px] text-muted";
const errorCls = "text-[12px] text-red-600";
const okCls = "text-[12px] text-muted";

/* ---------------------------------------------------------------- 纯工具 */

interface Message {
  kind: "ok" | "error";
  text: string;
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** 情景摘要里「用户：…」片段（deterministicSummary 的固定格式）。 */
function summaryUserPart(summary: string): string {
  const part = summary.split("｜").find((seg) => seg.startsWith("用户："));
  return part ? part.slice("用户：".length).trim() : "";
}

/**
 * 「立即整理」（设计 §2.3）：把选中智能体的情景条目按确定性规则提炼为语义候选——
 * 命中显式指令的取其键值，其余以用户问句前 16 字为主题键、整条摘要为内容。
 * 零 LLM 成本；同键走 upsert（更新而非追加）。
 */
export function consolidateEpisodic(
  memory: MemoryStore,
  agentId: string,
): { added: number; updated: number } {
  const known = new Set(memory.semantic(agentId).map((entry) => entry.key));
  let added = 0;
  let updated = 0;
  for (const entry of memory.episodic(agentId)) {
    const asked = summaryUserPart(entry.summary);
    const fact = asked ? extractExplicitMemory(asked) : null;
    const key = fact?.key ?? (normalizeKey(clip(asked, 16)) || `情景-${entry.at.slice(0, 10)}`);
    if (known.has(key)) updated += 1;
    else {
      known.add(key);
      added += 1;
    }
    memory.upsertSemantic({
      agentId,
      key,
      value: fact?.value ?? entry.summary,
      source: "consolidate",
      confidence: 0.7,
    });
  }
  return { added, updated };
}

/** 复制到剪贴板：无 API 或被拒（隐私模式）返回 false，由调用方给手动复制兜底。 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 权限被拒 → 走手动复制 */
  }
  return false;
}

interface Layers {
  working: WorkingTurn[];
  episodic: EpisodicEntry[];
  semantic: SemanticEntry[];
}

/**
 * 只读快照：`exportAll` 是「跨智能体」唯一的公开读口——
 * MemoryStore 没有「列出全部智能体的语义/情景」的 API，工作记忆更只有按会话读取的口。
 */
function snapshot(memory: MemoryStore): MemoryData | null {
  try {
    const parsed = JSON.parse(memory.exportAll()) as { data?: MemoryData };
    return parsed?.data ?? null;
  } catch {
    return null;
  }
}

function byRecent<T extends { at: string }>(a: T, b: T): number {
  return Date.parse(b.at) - Date.parse(a.at);
}

/** 三层视图数据：选定智能体走 store 的按层读口（含过期过滤与既有排序），否则做跨智能体汇总。 */
function loadLayers(memory: MemoryStore, agentId: string): Layers {
  const data = snapshot(memory);
  const now = memory.nowMs();
  const working = Object.values(data?.working ?? {})
    .flat()
    .filter((turn) => !agentId || turn.agentId === agentId)
    .filter((turn) => {
      const at = Date.parse(turn.at);
      return Number.isFinite(at) && at >= now - WORKING_TTL_MS;
    })
    .sort(byRecent);
  if (agentId) {
    return { working, episodic: memory.episodic(agentId), semantic: memory.semantic(agentId) };
  }
  return {
    working,
    episodic: Object.values(data?.episodic ?? {}).flat().sort(byRecent),
    semantic: Object.values(data?.semantic ?? {})
      .flat()
      .sort((a, b) =>
        a.pinned === b.pinned ? byRecent({ at: a.updatedAt }, { at: b.updatedAt }) : a.pinned ? -1 : 1,
      ),
  };
}

/** 召回预览的工作层行：与 format.ts 的「焦点 + 逐轮」口径一致。 */
function workingPreviewLines(turns: WorkingTurn[]): string[] {
  if (!turns.length) return [];
  const asked = turns.map((turn) => turn.userText).filter(Boolean);
  const lines = asked.length ? [`焦点：${asked.slice(-2).join("；")}`] : [];
  for (const turn of turns) {
    if (turn.userText) lines.push(`用户：${turn.userText}`);
    if (turn.assistantText) lines.push(`助手：${turn.assistantText}`);
  }
  return lines;
}

function hit(text: string, query: string): boolean {
  if (!query) return true;
  return text.toLowerCase().includes(query.toLowerCase());
}

/** 工作记忆列表一次最多展示的轮次（其余仅计数）。 */
const WORKING_ROWS = 10;

const SOURCE_LABEL: Record<SemanticEntry["source"], string> = {
  manual: "手动添加",
  explicit: "对话识别",
  consolidate: "整理提炼",
};

const SKILL_SOURCE_LABEL: Record<SkillDefinition["source"], string> = {
  builtin: "内置",
  user: "自建",
  imported: "导入",
};

function splitList(raw: string): string[] {
  return raw
    .split(/[,，、]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

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

function Modal({
  label,
  title,
  onClose,
  children,
}: {
  label: string;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20">
      <div
        role="dialog"
        aria-label={label}
        className="max-h-[86vh] w-[min(460px,92vw)] overflow-y-auto rounded-xl border border-line bg-white p-5 shadow-card"
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-[14px] font-bold">{title}</h3>
          <button
            type="button"
            aria-label="关闭"
            onClick={onClose}
            className="shrink-0 rounded p-1 text-[15px] leading-none text-muted hover:bg-[#f0f0f0] hover:text-ink"
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function AddMemoryModal({
  open,
  onClose,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (key: string, value: string) => void;
}) {
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setKey("");
    setValue("");
    setError("");
  }, [open]);

  if (!open) return null;

  return (
    <Modal label="添加记忆" title="添加记忆" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!key.trim() || !value.trim()) {
            setError("请填写主题与内容");
            return;
          }
          onSubmit(key.trim(), value.trim());
        }}
      >
        <label className={labelCls}>
          主题
          <input
            aria-label="主题"
            className={inputCls}
            value={key}
            maxLength={24}
            placeholder="如：偏好-语言"
            onChange={(e) => setKey(e.target.value)}
          />
        </label>
        <label className={`${labelCls} mt-3`}>
          内容
          <textarea
            aria-label="内容"
            className={`${inputCls} min-h-[72px] resize-y`}
            value={value}
            maxLength={500}
            placeholder="如：默认使用简体中文"
            onChange={(e) => setValue(e.target.value)}
          />
        </label>
        <div className="mt-1 text-[11px] text-muted">
          同一主题键再次保存会覆盖旧内容（记忆按智能体 + 主题去重）
        </div>
        {error && <div className={`mt-2 ${errorCls}`}>{error}</div>}
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" onClick={onClose} className={btnGhost}>
            取消
          </button>
          <button type="submit" className={btnPrimary}>
            保存
          </button>
        </div>
      </form>
    </Modal>
  );
}

interface SkillDraft {
  name: string;
  description: string;
  instructions: string;
  triggers: string[];
  tags: string[];
}

function SkillFormModal({
  open,
  skill,
  onClose,
  onSubmit,
}: {
  open: boolean;
  skill?: SkillDefinition;
  onClose: () => void;
  onSubmit: (draft: SkillDraft) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [triggers, setTriggers] = useState("");
  const [tags, setTags] = useState("");
  const [instructions, setInstructions] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setName(skill?.name ?? "");
    setDescription(skill?.description ?? "");
    setTriggers((skill?.triggers ?? []).join(", "));
    setTags((skill?.tags ?? []).join(", "));
    setInstructions(skill?.instructions ?? "");
    setError("");
  }, [open, skill]);

  if (!open) return null;

  return (
    <Modal
      label={skill ? `编辑技能 ${skill.name}` : "新建技能"}
      title={skill ? "编辑技能" : "新建技能"}
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) {
            setError("请填写技能名称");
            return;
          }
          if (!instructions.trim()) {
            setError("请填写指令正文");
            return;
          }
          onSubmit({
            name: name.trim(),
            description: description.trim(),
            instructions: instructions.trim(),
            triggers: splitList(triggers),
            tags: splitList(tags),
          });
        }}
      >
        <label className={labelCls}>
          名称
          <input
            aria-label="名称"
            className={inputCls}
            value={name}
            maxLength={32}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className={`${labelCls} mt-3`}>
          描述
          <textarea
            aria-label="描述"
            className={`${inputCls} min-h-[54px] resize-y`}
            value={description}
            maxLength={200}
            placeholder="路由依据：写清什么场景该用它"
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <label className={`${labelCls} mt-3`}>
          触发词
          <input
            aria-label="触发词"
            className={inputCls}
            value={triggers}
            placeholder="逗号分隔，如：周报, 总结"
            onChange={(e) => setTriggers(e.target.value)}
          />
        </label>
        <label className={`${labelCls} mt-3`}>
          标签
          <input
            aria-label="标签"
            className={inputCls}
            value={tags}
            placeholder="逗号分隔，如：写作, 文本"
            onChange={(e) => setTags(e.target.value)}
          />
        </label>
        <label className={`${labelCls} mt-3`}>
          指令正文
          <textarea
            aria-label="指令正文"
            className={`${inputCls} min-h-[120px] resize-y`}
            value={instructions}
            maxLength={8000}
            placeholder="命中后注入系统提示词的正文"
            onChange={(e) => setInstructions(e.target.value)}
          />
        </label>
        {error && <div className={`mt-2 ${errorCls}`}>{error}</div>}
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" onClick={onClose} className={btnGhost}>
            取消
          </button>
          <button type="submit" className={btnPrimarySm}>
            {skill ? "保存" : "创建"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function RecallGroup({ title, lines }: { title: string; lines: string[] }) {
  return (
    <div>
      <div className="text-[11px] font-bold text-[#777]">
        {title}（{lines.length}）
      </div>
      {lines.length === 0 ? (
        <div className="mt-0.5 text-[11px] text-muted">无命中</div>
      ) : (
        <ul className="mt-0.5 space-y-0.5">
          {lines.map((line, i) => (
            <li key={i} className="break-words text-[11px] text-[#555]">
              {line}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ 页面 */

export function MemoryPage({ memory = memoryStore, skills = skillPool }: MemoryPageProps = {}) {
  const [tab, setTab] = useState<"memory" | "skills">("memory");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [rosterError, setRosterError] = useState("");
  const [agentId, setAgentId] = useState("");
  /** 本机存储是可变单例：每次写操作后自增，驱动视图重算。 */
  const [tick, setTick] = useState(0);
  const bump = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    listAgents()
      .then((list) => {
        if (!cancelled) setAgents(list);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // 名册失败只降级选择器，记忆页本身照常可用
        setRosterError(
          `智能体名册加载失败，已降级为「全部智能体」：${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const layers = useMemo(() => loadLayers(memory, agentId), [memory, agentId, tick]);
  const settings = memory.getSettings();
  const agentName = useCallback(
    (id: string) => agents.find((a) => a.id === id)?.name ?? id,
    [agents],
  );

  // 记忆页本地态
  const [query, setQuery] = useState("");
  const [memoryMsg, setMemoryMsg] = useState<Message | null>(null);
  const [manualCopy, setManualCopy] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<{ id: string; agentId: string; key: string; value: string } | null>(
    null,
  );
  const [recallQuery, setRecallQuery] = useState("");
  const [recall, setRecall] = useState<{
    semantic: SemanticEntry[];
    episodic: EpisodicEntry[];
    working: WorkingTurn[];
    text: string;
  } | null>(null);

  // 技能池本地态
  const [skillMsg, setSkillMsg] = useState<Message | null>(null);
  const [skillManualCopy, setSkillManualCopy] = useState("");
  const [skillForm, setSkillForm] = useState<{ open: boolean; skill?: SkillDefinition }>({
    open: false,
  });
  const [skillImportOpen, setSkillImportOpen] = useState(false);
  const [skillImportText, setSkillImportText] = useState("");
  const [routeQuery, setRouteQuery] = useState("");
  const [route, setRoute] = useState<{ matches: SkillMatch[]; text: string } | null>(null);

  const semanticShown = layers.semantic.filter((entry) =>
    hit(`${entry.key} ${entry.value}`, query),
  );
  const episodicShown = layers.episodic.filter((entry) =>
    hit(`${entry.summary} ${entry.keywords.join(" ")}`, query),
  );
  const workingShown = layers.working.filter((turn) =>
    hit(`${turn.userText} ${turn.assistantText}`, query),
  );
  const skillList = useMemo(() => skills.list(), [skills, tick]);
  const binding = agentId ? skills.bindings(agentId) : null;

  const onExportMemory = async () => {
    const json = memory.exportAll();
    if (await copyText(json)) {
      setManualCopy("");
      setMemoryMsg({ kind: "ok", text: `已复制 记忆 JSON（${json.length} 字符）` });
    } else {
      setManualCopy(json);
      setMemoryMsg({ kind: "error", text: "复制失败，请手动复制下方内容" });
    }
  };

  const onImportMemory = () => {
    const result = memory.importAll(importText);
    if (!result.ok) {
      setMemoryMsg({ kind: "error", text: `导入失败：${result.error}` });
      return;
    }
    setImportText("");
    setImportOpen(false);
    bump();
    setMemoryMsg({ kind: "ok", text: "导入成功：本机记忆已按导入内容替换" });
  };

  const onConsolidate = () => {
    try {
      const { added, updated } = consolidateEpisodic(memory, agentId);
      bump();
      setMemoryMsg({
        kind: "ok",
        text: `已提炼 ${added + updated} 条语义候选（新增 ${added} / 更新 ${updated}）`,
      });
    } catch (err) {
      // 整理失败不影响页面其余部分
      setMemoryMsg({
        kind: "error",
        text: `整理失败：${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  const onRecall = () => {
    // 工作记忆按会话召回：取当前选中智能体最近一轮所在会话
    const conversationId =
      layers.working.find((turn) => !agentId || turn.agentId === agentId)?.conversationId ?? "";
    const recalled = recallMemory(memory, { agentId, conversationId, query: recallQuery });
    setRecall({ ...recalled, text: formatMemorySection(recalled) });
  };

  const onExportSkills = async (text: string, label: string) => {
    if (await copyText(text)) {
      setSkillManualCopy("");
      setSkillMsg({ kind: "ok", text: `已复制 ${label}（${text.length} 字符）` });
    } else {
      setSkillManualCopy(text);
      setSkillMsg({ kind: "error", text: "复制失败，请手动复制下方内容" });
    }
  };

  const onImportSkills = () => {
    try {
      const { added, updated } = skills.importText(skillImportText);
      setSkillImportText("");
      setSkillImportOpen(false);
      bump();
      setSkillMsg({ kind: "ok", text: `导入完成：新增 ${added} 个，更新 ${updated} 个` });
    } catch (err) {
      setSkillMsg({
        kind: "error",
        text: `导入失败：${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  const onRoute = () => {
    const matches = skills.route({ query: routeQuery, agentId: agentId || undefined });
    setRoute({ matches, text: formatSkillSection(matches) });
  };

  const toggleBinding = (id: string, field: "pinned" | "disabled") => {
    if (!agentId) return;
    const current = skills.bindings(agentId);
    const list = current[field];
    const next = list.includes(id) ? list.filter((item) => item !== id) : [...list, id];
    skills.setBinding(
      agentId,
      field === "pinned"
        ? { pinned: next, disabled: current.disabled }
        : { pinned: current.pinned, disabled: next },
    );
    bump();
  };

  /** 写入口统一门控：需选定具体智能体，且记忆总开关（enabled）为开。 */
  const writeReady = !!agentId && settings.enabled;

  const writeHint = (
    <>
      {!settings.enabled && (
        <div className={`mt-2 ${hintCls}`}>
          关闭后不再记录，也不向智能体注入记忆；已有记忆仍可查看、导出与删除
        </div>
      )}
      {!agentId && (
        <div className={`mt-2 ${hintCls}`}>
          添加记忆与立即整理需要先选择一个具体智能体（记忆按智能体隔离）
        </div>
      )}
    </>
  );

  const memoryTab = (
    <>
      <div className="mt-3 grid gap-3 md:grid-cols-3">
        <section aria-label="工作记忆" className={cardCls}>
          <div className="text-[12px] font-bold text-[#777]">工作记忆</div>
          <div className="mt-1 text-[20px] font-extrabold">{layers.working.length}</div>
          <div className={`mt-1 ${hintCls}`}>当前会话最近若干轮，2 小时未活动即过期，只读</div>
        </section>
        <section aria-label="情景记忆" className={cardCls}>
          <div className="text-[12px] font-bold text-[#777]">情景记忆</div>
          <div className="mt-1 text-[20px] font-extrabold">{layers.episodic.length}</div>
          <div className={`mt-1 ${hintCls}`}>每若干轮沉淀一条「那次聊了什么」，可按时间淘汰</div>
        </section>
        <section aria-label="语义记忆" className={cardCls}>
          <div className="text-[12px] font-bold text-[#777]">语义记忆</div>
          <div className="mt-1 text-[20px] font-extrabold">{layers.semantic.length}</div>
          <div className={`mt-1 ${hintCls}`}>长期成立的事实与偏好，按主题去重，置顶必带</div>
        </section>
      </div>

      <section className={`${cardCls} mt-3`}>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <Switch
              label="记忆总开关"
              checked={settings.enabled}
              onChange={(next) => {
                memory.updateSettings({ enabled: next });
                bump();
              }}
            />
            <span className="text-[12px] font-bold text-[#777]">记忆总开关</span>
          </div>
          <span aria-hidden="true" className="h-4 w-px bg-line-soft" />
          <div className="flex items-center gap-2">
            <Switch
              label="自动记忆"
              checked={settings.autoCapture}
              onChange={(next) => {
                memory.updateSettings({ autoCapture: next });
                bump();
              }}
            />
            <span className="text-[12px] font-bold text-[#777]">自动记忆</span>
          </div>
          <span className={hintCls}>
            自动记忆关闭后不再自动沉淀情景与语义（工作记忆仍记录），手动添加不受影响
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => void onExportMemory()} className={btnGhost}>
              导出
            </button>
            <button
              type="button"
              onClick={() => {
                setImportOpen((open) => !open);
                setMemoryMsg(null);
              }}
              className={btnGhost}
            >
              导入
            </button>
            <button
              type="button"
              onClick={() => setAddOpen(true)}
              disabled={!writeReady}
              className={`${btnGhost} inline-flex items-center gap-1.5`}
            >
              <PlusIcon width={13} height={13} />
              添加记忆
            </button>
            <button
              type="button"
              onClick={onConsolidate}
              disabled={!writeReady}
              className={btnGhost}
            >
              立即整理
            </button>
          </div>
        </div>
        {writeHint}
        {memoryMsg && (
          <div role="status" className={`mt-2 ${memoryMsg.kind === "error" ? errorCls : okCls}`}>
            {memoryMsg.text}
          </div>
        )}
        {manualCopy && (
          <textarea
            readOnly
            aria-label="手动复制记忆 JSON"
            value={manualCopy}
            className="mt-2 h-[120px] w-full rounded-lg border border-line bg-[#fafafa] p-2 text-[11px]"
          />
        )}
        {importOpen && (
          <div className="mt-3 border-t border-line-soft pt-3">
            <label className={labelCls}>
              导入记忆 JSON
              <textarea
                aria-label="导入记忆 JSON"
                className={`${inputCls} min-h-[96px] resize-y font-mono text-[11px]`}
                value={importText}
                placeholder="粘贴「导出」得到的 JSON；导入会整体替换本机记忆"
                onChange={(e) => setImportText(e.target.value)}
              />
            </label>
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                onClick={onImportMemory}
                disabled={!importText.trim()}
                className={btnPrimarySm}
              >
                确认导入
              </button>
              <span className={hintCls}>导入会整体替换三层记忆与设置，操作不可撤销</span>
            </div>
          </div>
        )}
      </section>

      <section className={`${cardCls} mt-3`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-[12px] font-bold text-[#777]">记忆条目</div>
          <input
            aria-label="检索记忆"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="按关键词过滤条目"
            className="w-[200px] rounded-lg border border-line px-2.5 py-1.5 text-[12px] outline-none focus:border-[#bbb]"
          />
        </div>

        <div role="group" aria-label="语义记忆条目" className="mt-3">
          <div className="text-[12px] font-bold text-[#777]">语义记忆（{semanticShown.length}）</div>
          {semanticShown.length === 0 ? (
            <div className={`mt-1 ${hintCls}`}>{query ? "无匹配条目" : "暂无条目"}</div>
          ) : (
            semanticShown.map((entry) => (
              <div key={entry.id} className="mt-2 rounded-lg border border-line p-2.5">
                {editing?.id === entry.id ? (
                  <div>
                    <label className="block text-[11px] text-muted">
                      主题
                      <input
                        aria-label={`编辑主题 ${entry.key}`}
                        className={inputSmCls}
                        value={editing.key}
                        maxLength={24}
                        onChange={(e) => setEditing({ ...editing, key: e.target.value })}
                      />
                    </label>
                    <label className="mt-2 block text-[11px] text-muted">
                      内容
                      <textarea
                        aria-label={`编辑内容 ${entry.key}`}
                        className={`${inputSmCls} min-h-[60px] resize-y`}
                        value={editing.value}
                        maxLength={500}
                        onChange={(e) => setEditing({ ...editing, value: e.target.value })}
                      />
                    </label>
                    <div className="mt-2 flex gap-2">
                      <button
                        type="button"
                        className={btnPrimarySm}
                        onClick={() => {
                          memory.updateSemantic(editing.agentId, editing.id, {
                            key: editing.key,
                            value: editing.value,
                          });
                          setEditing(null);
                          bump();
                        }}
                      >
                        保存
                      </button>
                      <button
                        type="button"
                        className={btnGhostSm}
                        onClick={() => setEditing(null)}
                      >
                        取消
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-[13px] font-bold">{entry.key}</span>
                        {entry.pinned && (
                          <span className="rounded border border-line-soft bg-[#fafafa] px-1.5 py-0.5 text-[10px] text-muted">
                            置顶
                          </span>
                        )}
                        {!agentId && (
                          <span className="text-[10px] text-muted">{agentName(entry.agentId)}</span>
                        )}
                      </div>
                      <div className="mt-0.5 whitespace-pre-wrap break-words text-[12px] text-[#555]">
                        {entry.value}
                      </div>
                      <div className="mt-1 text-[10px] text-muted">
                        {SOURCE_LABEL[entry.source]} · 置信度 {entry.confidence.toFixed(2)}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <button
                        type="button"
                        aria-label={`${entry.pinned ? "取消置顶" : "置顶"} ${entry.key}`}
                        onClick={() => {
                          memory.updateSemantic(entry.agentId, entry.id, { pinned: !entry.pinned });
                          bump();
                        }}
                        className={btnGhostSm}
                      >
                        {entry.pinned ? "取消置顶" : "置顶"}
                      </button>
                      <button
                        type="button"
                        aria-label={`编辑记忆 ${entry.key}`}
                        onClick={() =>
                          setEditing({
                            id: entry.id,
                            agentId: entry.agentId,
                            key: entry.key,
                            value: entry.value,
                          })
                        }
                        className={btnGhostSm}
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        aria-label={`删除记忆 ${entry.key}`}
                        onClick={() => {
                          memory.removeSemantic(entry.agentId, entry.id);
                          bump();
                        }}
                        className={btnDangerSm}
                      >
                        <TrashIcon width={13} height={13} />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        <div role="group" aria-label="情景记忆条目" className="mt-4 border-t border-line-soft pt-3">
          <div className="text-[12px] font-bold text-[#777]">情景记忆（{episodicShown.length}）</div>
          {episodicShown.length === 0 ? (
            <div className={`mt-1 ${hintCls}`}>{query ? "无匹配条目" : "暂无条目"}</div>
          ) : (
            episodicShown.map((entry) => (
              <div
                key={entry.id}
                className="mt-2 flex items-start justify-between gap-2 rounded-lg border border-line p-2.5"
              >
                <div className="min-w-0">
                  <div className="text-[10px] text-muted">
                    {entry.at.slice(0, 10)}
                    {!agentId && ` · ${agentName(entry.agentId)}`} · {entry.sourceTurns} 轮
                  </div>
                  <div className="mt-0.5 break-words text-[12px] text-[#555]">{entry.summary}</div>
                </div>
                <button
                  type="button"
                  aria-label={`删除情景 ${entry.summary.slice(0, 12)}`}
                  onClick={() => {
                    memory.removeEpisodic(entry.agentId, entry.id);
                    bump();
                  }}
                  className={btnDangerSm}
                >
                  <TrashIcon width={13} height={13} />
                </button>
              </div>
            ))
          )}
        </div>

        <div role="group" aria-label="工作记忆条目" className="mt-4 border-t border-line-soft pt-3">
          <div className="text-[12px] font-bold text-[#777]">
            工作记忆（只读，{workingShown.length} 轮）
          </div>
          {workingShown.length === 0 ? (
            <div className={`mt-1 ${hintCls}`}>{query ? "无匹配条目" : "暂无条目"}</div>
          ) : (
            <>
              {workingShown.slice(0, WORKING_ROWS).map((turn) => (
                <div key={turn.id} className="mt-2 rounded-lg border border-line p-2.5">
                  <div className="text-[10px] text-muted">
                    {turn.at.slice(11, 16)}
                    {turn.partial && " · 中断"}
                    {!agentId && ` · ${agentName(turn.agentId)}`}
                  </div>
                  <div className="mt-0.5 break-words text-[12px] text-[#555]">用户：{turn.userText}</div>
                  <div className="mt-0.5 break-words text-[12px] text-[#555]">
                    助手：{turn.assistantText}
                  </div>
                </div>
              ))}
              {workingShown.length > WORKING_ROWS && (
                <div className={`mt-1 ${hintCls}`}>仅显示最近 {WORKING_ROWS} 轮</div>
              )}
            </>
          )}
        </div>
      </section>

      <section className={`${cardCls} mt-3`}>
        <div className="text-[12px] font-bold text-[#777]">召回预览</div>
        <div className={`mt-1 ${hintCls}`}>
          输入一句话，看这次触发会召回哪些记忆：语义（置顶必带 + top5）、情景（top3）、工作（最近 6
          轮），总量受 1200 字符预算约束
        </div>
        {!settings.enabled && (
          <div className={`mt-1 ${hintCls}`}>
            记忆总开关已关闭：本次召回为空，不会注入任何记忆
          </div>
        )}
        <div className="mt-2 flex gap-2">
          <input
            aria-label="召回预览输入"
            value={recallQuery}
            onChange={(e) => setRecallQuery(e.target.value)}
            placeholder="如：帮我把发布计划整理一下"
            className="min-w-0 flex-1 rounded-lg border border-line px-3 py-1.5 text-[12px] outline-none focus:border-[#bbb]"
          />
          <button
            type="button"
            onClick={onRecall}
            disabled={!recallQuery.trim()}
            className={btnPrimarySm}
          >
            预览召回
          </button>
        </div>
        {recall && (
          <div
            role="group"
            aria-label="召回预览结果"
            className="mt-3 rounded-lg border border-line p-3"
          >
            <div className={hintCls}>
              预算占用 {recall.text.length} / {MEMORY_CHAR_BUDGET} 字符
            </div>
            <div className="mt-2 grid gap-3 md:grid-cols-3">
              <RecallGroup
                title="语义"
                lines={recall.semantic.map((entry) => `${entry.key}：${entry.value}`)}
              />
              <RecallGroup
                title="情景"
                lines={recall.episodic.map((entry) => `${entry.at.slice(0, 10)}：${entry.summary}`)}
              />
              <RecallGroup title="工作" lines={workingPreviewLines(recall.working)} />
            </div>
            {recall.text ? (
              <textarea
                readOnly
                aria-label="将被注入的记忆段"
                value={recall.text}
                className="mt-3 h-[140px] w-full rounded-lg border border-line bg-[#fafafa] p-2 text-[11px]"
              />
            ) : (
              <div className={`mt-3 ${hintCls}`}>三层皆无命中：不会注入任何记忆段</div>
            )}
          </div>
        )}
      </section>

      <AddMemoryModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onSubmit={(key, value) => {
          memory.upsertSemantic({ agentId, key, value, source: "manual" });
          setAddOpen(false);
          bump();
          setMemoryMsg({ kind: "ok", text: `已保存记忆：${key}` });
        }}
      />
    </>
  );

  const skillsTab = (
    <>
      <section className={`${cardCls} mt-3`}>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setSkillForm({ open: true })}
            className={`${btnGhost} inline-flex items-center gap-1.5`}
          >
            <PlusIcon width={13} height={13} />
            新建技能
          </button>
          <button
            type="button"
            onClick={() => {
              setSkillImportOpen((open) => !open);
              setSkillMsg(null);
            }}
            className={btnGhost}
          >
            导入
          </button>
          <button
            type="button"
            onClick={() => void onExportSkills(skills.exportAll(), "整池 JSON")}
            className={btnGhost}
          >
            导出全部
          </button>
          <span className={`ml-auto ${hintCls}`}>共 {skillList.length} 个技能</span>
        </div>
        <div className={`mt-1 ${hintCls}`}>
          技能按命中度路由（名称 ×3 / 触发词 ×2.5 / 标签 ×1.5 / 描述 ×1），命中后注入系统提示词
        </div>
        {skillMsg && (
          <div role="status" className={`mt-2 ${skillMsg.kind === "error" ? errorCls : okCls}`}>
            {skillMsg.text}
          </div>
        )}
        {skillManualCopy && (
          <textarea
            readOnly
            aria-label="手动复制技能内容"
            value={skillManualCopy}
            className="mt-2 h-[120px] w-full rounded-lg border border-line bg-[#fafafa] p-2 text-[11px]"
          />
        )}
        {skillImportOpen && (
          <div className="mt-3 border-t border-line-soft pt-3">
            <label className={labelCls}>
              导入技能内容
              <textarea
                aria-label="导入技能内容"
                className={`${inputCls} min-h-[120px] resize-y font-mono text-[11px]`}
                value={skillImportText}
                placeholder="粘贴 SKILL.md（以 --- 开头）或技能 JSON；同名/同 id 走更新"
                onChange={(e) => setSkillImportText(e.target.value)}
              />
            </label>
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                onClick={onImportSkills}
                disabled={!skillImportText.trim()}
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
        <div className="text-[12px] font-bold text-[#777]">技能列表</div>
        {skillList.map((skill) => (
          <div
            key={skill.id}
            role="group"
            aria-label={`技能 ${skill.name}`}
            className="mt-3 rounded-lg border border-line p-3"
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-[13px] font-bold">{skill.name}</span>
                  <span className="rounded border border-line-soft bg-[#fafafa] px-1.5 py-0.5 text-[10px] text-muted">
                    {SKILL_SOURCE_LABEL[skill.source]}
                  </span>
                  <span className="text-[10px] text-muted">v{skill.version}</span>
                </div>
                {skill.description && (
                  <div className="mt-0.5 break-words text-[12px] text-muted">
                    {skill.description}
                  </div>
                )}
                {skill.triggers.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {skill.triggers.map((trigger) => (
                      <span
                        key={trigger}
                        className="rounded bg-[#f4f4f4] px-1.5 py-0.5 text-[10px] text-[#666]"
                      >
                        {trigger}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Switch
                  label={`启用 ${skill.name}`}
                  checked={skill.enabled}
                  onChange={(next) => {
                    skills.setEnabled(skill.id, next);
                    bump();
                  }}
                />
                <button
                  type="button"
                  aria-label={`导出 ${skill.name}`}
                  onClick={() => void onExportSkills(skills.exportOne(skill.id), "SKILL.md")}
                  className={`${btnGhostSm} inline-flex items-center gap-1`}
                >
                  <DownloadIcon width={12} height={12} />
                  导出
                </button>
                <button
                  type="button"
                  aria-label={`编辑 ${skill.name}`}
                  onClick={() => setSkillForm({ open: true, skill })}
                  className={btnGhostSm}
                >
                  编辑
                </button>
                <button
                  type="button"
                  aria-label={`删除 ${skill.name}`}
                  onClick={() => {
                    skills.remove(skill.id);
                    bump();
                  }}
                  className={btnDangerSm}
                >
                  <TrashIcon width={13} height={13} />
                </button>
              </div>
            </div>
            {binding && (
              <div className="mt-2 flex flex-wrap items-center gap-3 border-t border-line-soft pt-2">
                <label className="flex items-center gap-1.5 text-[11px] text-[#555]">
                  <input
                    type="checkbox"
                    aria-label={`置顶 ${skill.name}`}
                    checked={binding.pinned.includes(skill.id)}
                    onChange={() => toggleBinding(skill.id, "pinned")}
                  />
                  置顶（该智能体每次必带）
                </label>
                <label className="flex items-center gap-1.5 text-[11px] text-[#555]">
                  <input
                    type="checkbox"
                    aria-label={`本智能体禁用 ${skill.name}`}
                    checked={binding.disabled.includes(skill.id)}
                    onChange={() => toggleBinding(skill.id, "disabled")}
                  />
                  本智能体禁用
                </label>
              </div>
            )}
          </div>
        ))}
        {skillList.length === 0 && <div className={`mt-2 ${hintCls}`}>技能池为空，可新建或导入</div>}
      </section>

      <section className={`${cardCls} mt-3`}>
        <div className="text-[12px] font-bold text-[#777]">路由预览</div>
        <div className={`mt-1 ${hintCls}`}>
          输入一句话，看这次会命中哪些技能（top3 + 置顶必带），总量受 1600 字符预算约束
        </div>
        <div className="mt-2 flex gap-2">
          <input
            aria-label="路由预览输入"
            value={routeQuery}
            onChange={(e) => setRouteQuery(e.target.value)}
            placeholder="如：帮我审查这段代码"
            className="min-w-0 flex-1 rounded-lg border border-line px-3 py-1.5 text-[12px] outline-none focus:border-[#bbb]"
          />
          <button
            type="button"
            onClick={onRoute}
            disabled={!routeQuery.trim()}
            className={btnPrimarySm}
          >
            预览路由
          </button>
        </div>
        {route && (
          <div role="group" aria-label="路由预览结果" className="mt-3 rounded-lg border border-line p-3">
            <div className={hintCls}>
              预算占用 {route.text.length} / {DEFAULT_ROUTE_BUDGET} 字符
            </div>
            {route.matches.length === 0 ? (
              <div className={`mt-1 ${hintCls}`}>无命中技能：本次不注入技能段</div>
            ) : (
              <ul className="mt-1 space-y-1">
                {route.matches.map((match) => (
                  <li key={match.skill.id} className="break-words text-[12px] text-[#555]">
                    <span className="font-bold text-ink">{match.skill.name}</span>
                    <span className="ml-2 text-[11px] text-muted">
                      {match.reason} · 得分 {match.score}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      <SkillFormModal
        open={skillForm.open}
        skill={skillForm.skill}
        onClose={() => setSkillForm({ open: false })}
        onSubmit={(draft) => {
          if (skillForm.skill) skills.update(skillForm.skill.id, draft);
          else skills.create({ ...draft, enabled: true, version: "1.0.0" });
          setSkillForm({ open: false });
          bump();
        }}
      />
    </>
  );

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-[17px] font-extrabold">记忆</h1>
        <div className="flex flex-wrap items-center gap-3">
          <div
            role="tablist"
            aria-label="记忆区视图"
            className="inline-flex overflow-hidden rounded-lg border border-line shadow-card"
          >
            <button
              type="button"
              role="tab"
              id="memory-tab"
              aria-controls="memory-panel"
              aria-selected={tab === "memory"}
              onClick={() => setTab("memory")}
              className={`px-3 py-1.5 text-[12px] transition-colors duration-150 ${
                tab === "memory" ? "bg-ink font-bold text-white" : "text-muted hover:bg-[#fafafa]"
              }`}
            >
              记忆
            </button>
            <button
              type="button"
              role="tab"
              id="skills-tab"
              aria-controls="skills-panel"
              aria-selected={tab === "skills"}
              onClick={() => setTab("skills")}
              className={`border-l border-line px-3 py-1.5 text-[12px] transition-colors duration-150 ${
                tab === "skills" ? "bg-ink font-bold text-white" : "text-muted hover:bg-[#fafafa]"
              }`}
            >
              技能池
            </button>
          </div>
          <label className="flex shrink-0 items-center gap-2 whitespace-nowrap text-[12px] text-muted">
            智能体
            <select
              aria-label="智能体"
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              className="rounded-lg border border-line px-2 py-1.5 text-[12px] outline-none focus:border-[#bbb]"
            >
              <option value="">全部智能体</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
      {rosterError && (
        <div role="status" className="mt-2 text-[12px] text-[#b45309]">
          {rosterError}
        </div>
      )}
      <div
        role="tabpanel"
        id={tab === "memory" ? "memory-panel" : "skills-panel"}
        aria-labelledby={tab === "memory" ? "memory-tab" : "skills-tab"}
      >
        {tab === "memory" ? memoryTab : skillsTab}
      </div>
    </div>
  );
}
