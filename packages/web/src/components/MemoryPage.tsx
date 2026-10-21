import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Agent, SharedFileMeta } from "@heming/shared";
import { WikiPanel } from "./WikiPanel.js";
import {
  MEMORY_CHAR_BUDGET,
  WORKING_TTL_MS,
  agentPrefsStore,
  extractExplicitMemory,
  formatMemorySection,
  knowledgeBase,
  memoryStore,
  normalizeKey,
  recallMemory,
  type AgentMemoryPrefs,
  type AgentPrefsStore,
  type EpisodicEntry,
  type KnowledgeBase,
  type KnowledgeEntry,
  type MemoryData,
  type MemoryStore,
  type SemanticEntry,
  type WorkingTurn,
} from "../lib/memory/index.js";
import { listAgents } from "../lib/agentsApi.js";
import { useLlmStore } from "../store/llm.js";
import {
  getLastReviewReport,
  getReviewSettings,
  reviewCapacity,
  runReviewNow,
  setReviewSettings,
} from "../lib/memory/reviewRunner.js";
import { fetchFiles } from "../lib/api.js";
import { PlusIcon, TrashIcon } from "./icons.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { useModalA11y } from "./useModalA11y.js";

/**
 * 记忆区：短期记忆 / 数据库记忆 / 个人知识库三个分区，外加智能体记忆开关。
 * - 短期记忆 = WorkingTurn（会话级缓冲，按会话分组，可清空）；
 * - 数据库记忆 = EpisodicEntry + SemanticEntry（长期沉淀，可检索/置顶/删除/导入导出）；
 * - 个人知识库 = 本机 `heming.kb.v1` 条目 + 云端共享文件（只读，可收进本机）；
 * - 智能体偏好 = `heming.memory.agentPrefs.v1`（短期/长期默认关，个人数据库默认允许）。
 * 一切失败都内联中文提示，不用 window.alert（与设置区同风格）。
 */

export interface MemoryPageProps {
  memory?: MemoryStore;
  kb?: KnowledgeBase;
  prefs?: AgentPrefsStore;
  fetchSharedFiles?: () => Promise<SharedFileMeta[]>;
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
  "rounded-lg border border-line px-2 py-1 text-[11px] text-[#555] shadow-card transition-colors duration-150 hover:bg-[#fafafa] disabled:opacity-40";
const btnDangerSm =
  "rounded-lg border border-line p-1.5 text-[#b42318] shadow-card transition-colors duration-150 hover:bg-[#fafafa]";
const btnPrimary = "rounded-lg bg-ink px-4 py-1.5 text-sm font-bold text-white disabled:opacity-40";
const btnPrimarySm =
  "rounded-lg bg-ink px-3 py-1.5 text-[12px] font-bold text-white disabled:opacity-40";
const hintCls = "text-[11px] text-muted";
const errorCls = "text-[12px] text-red-600";
const okCls = "text-[12px] text-muted";
const badgeCls =
  "rounded border border-line-soft bg-[#fafafa] px-1.5 py-0.5 text-[10px] text-muted";

/* ---------------------------------------------------------------- 纯工具 */

interface Message {
  kind: "ok" | "error";
  text: string;
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
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
  // 查「已知 key」必须查全局桶：下面的 upsertSemantic 不传 bucket，默认也落全局。
  // 若这里查的是 agentId 桶（只含私有条目），每次整理都会把已有条目又算成 added。
  const known = new Set(memory.semanticGlobal().map((entry) => entry.key));
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
  /** 该智能体实际会召回的语义记忆全集（全局共用 + 自己的）。 */
  semantic: SemanticEntry[];
  /** 仅全局共用桶——「数据库」标签展示用，恒与选了哪个智能体无关。 */
  globalSemantic: SemanticEntry[];
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

/**
 * 三层视图数据：选定智能体走 store 的按层读口（含过期过滤与既有排序），否则做跨智能体汇总。
 *
 * `globalSemantic` 恒为全局共用桶（用户要求「长期记忆所有智能体公用」）——
 * 「数据库」标签展示的就是它：不管上面选了哪个智能体，看到的公用长期记忆都一样。
 * `semantic` 则是该智能体实际会召回的全集（全局 + 自己的），两者不是一回事。
 */
function loadLayers(memory: MemoryStore, agentId: string): Layers {
  const data = snapshot(memory);
  const now = memory.nowMs();
  const globalSemantic = memory.semanticGlobal();
  const working = Object.values(data?.working ?? {})
    .flat()
    .filter((turn) => !agentId || turn.agentId === agentId)
    .filter((turn) => {
      const at = Date.parse(turn.at);
      return Number.isFinite(at) && at >= now - WORKING_TTL_MS;
    })
    .sort(byRecent);
  if (agentId) {
    return {
      working,
      episodic: memory.episodic(agentId),
      semantic: memory.semantic(agentId),
      globalSemantic,
    };
  }
  return {
    working,
    episodic: Object.values(data?.episodic ?? {}).flat().sort(byRecent),
    semantic: Object.values(data?.semantic ?? {})
      .flat()
      .sort((a, b) =>
        a.pinned === b.pinned ? byRecent({ at: a.updatedAt }, { at: b.updatedAt }) : a.pinned ? -1 : 1,
      ),
    globalSemantic,
  };
}

interface WorkingGroup {
  conversationId: string;
  agentIds: string[];
  turns: WorkingTurn[];
  latestAt: string;
}

/** 短期记忆按会话分组：组内按时间正序（对话顺序），组间按最近活动倒序。 */
function groupWorking(turns: WorkingTurn[]): WorkingGroup[] {
  const map = new Map<string, WorkingTurn[]>();
  for (const turn of turns) {
    const key = turn.conversationId || "未命名会话";
    const list = map.get(key);
    if (list) list.push(turn);
    else map.set(key, [turn]);
  }
  const groups: WorkingGroup[] = [];
  for (const [conversationId, list] of map) {
    const sorted = [...list].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    groups.push({
      conversationId,
      agentIds: [...new Set(sorted.map((turn) => turn.agentId))],
      turns: sorted,
      latestAt: sorted[sorted.length - 1].at,
    });
  }
  return groups.sort((a, b) => Date.parse(b.latestAt) - Date.parse(a.latestAt));
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

const SOURCE_LABEL: Record<SemanticEntry["source"], string> = {
  manual: "手动添加",
  explicit: "对话识别",
  consolidate: "整理提炼",
  review: "复盘沉淀",
};

const KB_SOURCE_LABEL: Record<KnowledgeEntry["source"], string> = {
  manual: "手动添加",
  cloud: "云端共享",
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
  const panelRef = useRef<HTMLDivElement>(null);
  useModalA11y(panelRef, onClose);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/20"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onClick={(e) => e.stopPropagation()}
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

function KnowledgeModal({
  open,
  onClose,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (title: string, content: string, tags: string[]) => void;
}) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [tags, setTags] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setTitle("");
    setContent("");
    setTags("");
    setError("");
  }, [open]);

  if (!open) return null;

  return (
    <Modal label="添加知识条目" title="添加知识条目" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!title.trim() || !content.trim()) {
            setError("请填写标题与内容");
            return;
          }
          onSubmit(title.trim(), content.trim(), splitList(tags));
        }}
      >
        <label className={labelCls}>
          标题
          <input
            aria-label="知识标题"
            className={inputCls}
            value={title}
            maxLength={120}
            placeholder="如：发布流程"
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label className={`${labelCls} mt-3`}>
          内容
          <textarea
            aria-label="知识内容"
            className={`${inputCls} min-h-[96px] resize-y`}
            value={content}
            maxLength={2000}
            placeholder="写清可复用的事实、步骤或约定"
            onChange={(e) => setContent(e.target.value)}
          />
        </label>
        <label className={`${labelCls} mt-3`}>
          标签
          <input
            aria-label="知识标签"
            className={inputCls}
            value={tags}
            placeholder="逗号分隔，如：发布, 流程"
            onChange={(e) => setTags(e.target.value)}
          />
        </label>
        <div className="mt-1 text-[11px] text-muted">条目只存本机，智能体默认允许读取个人知识库</div>
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

/**
 * 三个标签（用户 2026-10-20 重新划分）：
 * - agents 智能体：这个智能体的记忆相关设置与短期记忆（原「短期记忆」+ 原页面下方的偏好/复盘卡）
 * - database 数据库：长期记忆，**所有智能体公用**，是给智能体看的
 * - wiki 个人知识库：给人看的知识库，按卡帕西 LLM Wiki 标准，真实 markdown + 图谱视图
 */
type TabKey = "agents" | "database" | "wiki";

const TAB_LABELS: Record<TabKey, string> = {
  agents: "智能体",
  database: "数据库",
  wiki: "个人知识库",
};

interface CloudState {
  status: "idle" | "loading" | "ready" | "error";
  files: SharedFileMeta[];
  error?: string;
}

export function MemoryPage({
  memory = memoryStore,
  kb = knowledgeBase,
  prefs = agentPrefsStore,
  fetchSharedFiles = fetchFiles,
}: MemoryPageProps = {}) {
  const [tab, setTab] = useState<TabKey>("agents");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [manualAgents, setManualAgents] = useState<Agent[]>([]);
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
        // 名册失败只降级选择器与开关表，记忆页本身照常可用
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
    (id: string) => {
      const found = agents.find((a) => a.id === id) ?? manualAgents.find((a) => a.id === id);
      return found?.name ?? id;
    },
    [agents, manualAgents],
  );

  // 短期记忆
  const groups = useMemo(() => groupWorking(layers.working), [layers.working]);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [shortMsg, setShortMsg] = useState("");

  const toggleGroup = (key: string) => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // 数据库记忆
  const [query, setQuery] = useState("");
  const [memoryMsg, setMemoryMsg] = useState<Message | null>(null);
  const [manualCopy, setManualCopy] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importConfirm, setImportConfirm] = useState(false);
  const [clearTarget, setClearTarget] = useState<{
    conversationId: string;
    label: string;
  } | null>(null);
  const [pendingSemantic, setPendingSemantic] = useState<SemanticEntry | null>(null);
  const [pendingEpisodic, setPendingEpisodic] = useState<EpisodicEntry | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<{
    id: string;
    agentId: string;
    key: string;
    value: string;
  } | null>(null);
  const [retentionDraft, setRetentionDraft] = useState(String(settings.retentionDays));
  const [retentionMsg, setRetentionMsg] = useState("");
  const [recallQuery, setRecallQuery] = useState("");
  const [recall, setRecall] = useState<{
    semantic: SemanticEntry[];
    episodic: EpisodicEntry[];
    working: WorkingTurn[];
    text: string;
  } | null>(null);

  useEffect(() => {
    setRetentionDraft(String(settings.retentionDays));
  }, [settings.retentionDays]);

  // 「数据库」标签展示全局公用桶（所有智能体看到的长期记忆就是这一份），
  // 而非当前选中智能体的召回全集——后者含私有条目，在「公用」的语境下会误导。
  const semanticShown = layers.globalSemantic.filter((entry) =>
    hit(`${entry.key} ${entry.value}`, query),
  );
  const episodicShown = layers.episodic.filter((entry) =>
    hit(`${entry.summary} ${entry.keywords.join(" ")}`, query),
  );
  const totalEntries = layers.globalSemantic.length + layers.episodic.length;
  const totalChars = layers.globalSemantic.reduce((sum, entry) => sum + entry.key.length + entry.value.length, 0)
    + layers.episodic.reduce((sum, entry) => sum + entry.summary.length, 0);
  const retentionDays = Number(retentionDraft);
  const retentionValid =
    Number.isFinite(retentionDays) && retentionDays >= 1 && retentionDays <= 3650;
  const retentionDirty = retentionValid && Math.round(retentionDays) !== settings.retentionDays;

  // 个人知识库
  const [kbAddOpen, setKbAddOpen] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);


  const kbEntries = kb.list();

  // 智能体记忆开关
  const [pendingDbOff, setPendingDbOff] = useState("");
  const [manualAgentId, setManualAgentId] = useState("");
  const [manualAgentName, setManualAgentName] = useState("");
  const [manualMsg, setManualMsg] = useState("");

  const displayAgents = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const agent of agents) map.set(agent.id, agent);
    for (const agent of manualAgents) if (!map.has(agent.id)) map.set(agent.id, agent);
    for (const id of Object.keys(prefs.all())) {
      if (!map.has(id)) map.set(id, { id, owner_id: "", name: id, avatar: null, description: "" });
    }
    return [...map.values()];
  }, [agents, manualAgents, prefs, tick]);

  const onClearConversation = (conversationId: string, label: string) => {
    setClearTarget({ conversationId, label: conversationId || label || "未命名会话" });
  };

  const confirmClearConversation = () => {
    if (!clearTarget) return;
    memory.clearConversation(clearTarget.conversationId);
    const label = clearTarget.label;
    setClearTarget(null);
    bump();
    setShortMsg(`已清空会话 ${label} 的短期记忆`);
  };

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
    if (!importText.trim()) return;
    setImportConfirm(true);
  };

  const confirmImportMemory = () => {
    setImportConfirm(false);
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

  const onSaveRetention = () => {
    if (!retentionValid) {
      setRetentionMsg("保留天数需为 1–3650 之间的整数");
      return;
    }
    const days = Math.round(retentionDays);
    memory.updateSettings({ retentionDays: days });
    setRetentionMsg(`已保存：情景记忆保留 ${days} 天`);
    bump();
  };

  const onRecall = () => {
    // 工作记忆按会话召回：取当前选中智能体最近一轮所在会话
    const conversationId =
      layers.working.find((turn) => !agentId || turn.agentId === agentId)?.conversationId ?? "";
    const recalled = recallMemory(memory, { agentId, conversationId, query: recallQuery });
    setRecall({ ...recalled, text: formatMemorySection(recalled) });
  };


  const onAddManualAgent = () => {
    const id = manualAgentId.trim();
    const name = manualAgentName.trim() || id;
    if (!id) {
      setManualMsg("请填写智能体 ID");
      return;
    }
    if (displayAgents.some((agent) => agent.id === id)) {
      setManualMsg("该智能体已在列表中");
      return;
    }
    setManualAgents((list) => [...list, { id, owner_id: "", name, avatar: null, description: "" }]);
    setManualAgentId("");
    setManualAgentName("");
    setManualMsg(`已添加：${name}`);
  };

  const setPref = (id: string, patch: Partial<AgentMemoryPrefs>) => {
    prefs.set(id, patch);
    bump();
  };

  const onPersonalDbToggle = (id: string, next: boolean) => {
    if (!next) {
      // 个人知识库默认允许使用：关闭必须二次确认
      setPendingDbOff(id);
      return;
    }
    setPendingDbOff("");
    setPref(id, { personalDb: true });
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

  /* ------------------------------------------------------------ 短期记忆 */

  const shortPanel = (
    <section aria-label="短期记忆" className={cardCls}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="text-[12px] font-bold text-[#777]">短期记忆</div>
          <div className={`mt-1 ${hintCls}`}>
            会话级缓冲：当前会话最近若干轮上下文，约 2 小时未活动或满 40 轮后过期，仅存本机
          </div>
        </div>
        <span className={hintCls}>
          共 {layers.working.length} 轮 · {groups.length} 个会话
        </span>
      </div>
      {shortMsg && (
        <div role="status" className={`mt-2 ${okCls}`}>
          {shortMsg}
        </div>
      )}
      {groups.length === 0 ? (
        <div className={`mt-3 ${hintCls}`}>当前没有未过期的短期记忆</div>
      ) : (
        groups.map((group) => {
          const key = group.conversationId || "未命名会话";
          const open = !collapsedGroups.has(key);
          return (
            <div
              key={key}
              role="group"
              aria-label={`会话 ${key}`}
              className="mt-3 rounded-lg border border-line"
            >
              <div className="flex flex-wrap items-center gap-2 border-b border-line-soft px-3 py-2">
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => toggleGroup(key)}
                  className="flex min-w-0 items-center gap-1.5 text-left text-[12px] font-bold"
                >
                  <span aria-hidden="true" className="text-[10px] text-muted">
                    {open ? "▾" : "▸"}
                  </span>
                  <span className="truncate">会话 {clip(key, 24)}</span>
                </button>
                <span className="text-[11px] text-muted">
                  {group.agentIds.map((id) => agentName(id)).join("、")} · {group.turns.length} 轮
                </span>
                <span className="ml-auto text-[11px] text-muted">
                  最近 {group.latestAt.slice(5, 16).replace("T", " ")}
                </span>
                <button
                  type="button"
                  aria-label={`清空会话 ${key}`}
                  onClick={() => onClearConversation(group.conversationId, key)}
                  className={btnGhostSm}
                >
                  清空
                </button>
              </div>
              {open && (
                <div className="space-y-2 p-2.5">
                  {group.turns.map((turn) => (
                    <div
                      key={turn.id}
                      className="rounded-lg border border-line-soft bg-[#fafafa] px-2.5 py-2"
                    >
                      <div className="text-[10px] text-muted">
                        {turn.at.slice(11, 16)}
                        {turn.partial && " · 中断"}
                        {!agentId && ` · ${agentName(turn.agentId)}`}
                      </div>
                      <div className="mt-0.5 whitespace-pre-wrap break-words text-[12px] text-[#555]">
                        用户：{turn.userText}
                      </div>
                      <div className="mt-0.5 whitespace-pre-wrap break-words text-[12px] text-[#555]">
                        助手：{turn.assistantText}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })
      )}
    </section>
  );

  /* ---------------------------------------------------------- 数据库记忆 */

  const databasePanel = (
    <>
      <section aria-label="数据库记忆概览" className={cardCls}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="text-[12px] font-bold text-[#777]">数据库 · 长期记忆</div>
            <div className={`mt-1 ${hintCls}`}>
              这是<strong className="font-medium text-[#666]">所有智能体共用</strong>的长期记忆，
              智能体对话时会读到这里的语义记忆。情景记忆仍按智能体分开（它记的是某次对话的过程）。
            </div>
          </div>
          <div className="flex flex-wrap items-start gap-5">
            <div>
              <div className="text-[11px] text-muted">公用语义记忆</div>
              <div className="text-[18px] font-extrabold">{layers.globalSemantic.length}</div>
            </div>
            <div>
              <div className="text-[11px] text-muted">情景记忆</div>
              <div className="text-[18px] font-extrabold">{layers.episodic.length}</div>
            </div>
            <div>
              <div className="text-[11px] text-muted">总量</div>
              <div className="mt-1 text-[12px] font-bold">
                {totalEntries} 条 · {totalChars} 字符
              </div>
            </div>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-line-soft pt-3">
          <label className={`${labelCls} w-[110px]`}>
            保留天数
            <input
              aria-label="保留天数"
              type="number"
              min={1}
              max={3650}
              value={retentionDraft}
              onChange={(e) => {
                setRetentionDraft(e.target.value);
                setRetentionMsg("");
              }}
              className={inputSmCls}
            />
          </label>
          <button
            type="button"
            onClick={onSaveRetention}
            disabled={!retentionDirty}
            className={btnGhost}
          >
            保存
          </button>
          <span className={`${hintCls} pb-1.5`}>
            情景记忆超过保留天数后不再参与召回；语义记忆长期保留
          </span>
          {retentionMsg && (
            <span role="status" className={`${okCls} pb-1.5`}>
              {retentionMsg}
            </span>
          )}
        </div>
      </section>

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
            自动记忆关闭后不再自动沉淀情景与语义（短期记忆仍记录），手动添加不受影响
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
                        {entry.pinned && <span className={badgeCls}>置顶</span>}
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
                        onClick={() => setPendingSemantic(entry)}
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
                  onClick={() => setPendingEpisodic(entry)}
                  className={btnDangerSm}
                >
                  <TrashIcon width={13} height={13} />
                </button>
              </div>
            ))
          )}
        </div>
      </section>

      <section className={`${cardCls} mt-3`}>
        <div className="text-[12px] font-bold text-[#777]">召回预览</div>
        <div className={`mt-1 ${hintCls}`}>
          输入一句话，看这次触发会召回哪些记忆：语义（置顶必带 + top5）、情景（top3）、短期（最近 6
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
              <RecallGroup title="短期" lines={workingPreviewLines(recall.working)} />
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

      {pendingSemantic && (
        <ConfirmDialog
          title="删除记忆"
          onCancel={() => setPendingSemantic(null)}
          footer={
            <>
              <button
                type="button"
                onClick={() => setPendingSemantic(null)}
                className="rounded-lg border border-line px-3 py-1.5 text-[12px] text-muted hover:bg-[#f7f7f7]"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => {
                  memory.removeSemantic(pendingSemantic.agentId, pendingSemantic.id);
                  setPendingSemantic(null);
                  bump();
                  setMemoryMsg({ kind: "ok", text: `已删除记忆：${pendingSemantic.key}` });
                }}
                className="rounded-lg bg-[#b42318] px-3 py-1.5 text-[12px] font-medium text-white"
              >
                删除
              </button>
            </>
          }
        >
          <p className="text-[12px] leading-6">
            删除记忆「{pendingSemantic.key}」？删除后智能体不会再召回这条，操作不可撤销。
          </p>
          <p className="mt-1 break-words text-[12px] text-muted">{pendingSemantic.value}</p>
        </ConfirmDialog>
      )}

      {pendingEpisodic && (
        <ConfirmDialog
          title="删除情景记忆"
          onCancel={() => setPendingEpisodic(null)}
          footer={
            <>
              <button
                type="button"
                onClick={() => setPendingEpisodic(null)}
                className="rounded-lg border border-line px-3 py-1.5 text-[12px] text-muted hover:bg-[#f7f7f7]"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => {
                  memory.removeEpisodic(pendingEpisodic.agentId, pendingEpisodic.id);
                  setPendingEpisodic(null);
                  bump();
                  setMemoryMsg({ kind: "ok", text: "已删除一条情景记忆" });
                }}
                className="rounded-lg bg-[#b42318] px-3 py-1.5 text-[12px] font-medium text-white"
              >
                删除
              </button>
            </>
          }
        >
          <p className="text-[12px] leading-6">删除这条情景记忆？删除后不会参与召回。</p>
          <p className="mt-1 break-words text-[12px] text-muted">{pendingEpisodic.summary}</p>
        </ConfirmDialog>
      )}

      {importConfirm && (
        <ConfirmDialog
          title="导入记忆"
          onCancel={() => setImportConfirm(false)}
          footer={
            <>
              <button
                type="button"
                onClick={() => setImportConfirm(false)}
                className="rounded-lg border border-line px-3 py-1.5 text-[12px] text-muted hover:bg-[#f7f7f7]"
              >
                取消
              </button>
              <button
                type="button"
                onClick={confirmImportMemory}
                className="rounded-lg bg-[#b42318] px-3 py-1.5 text-[12px] font-medium text-white"
              >
                替换并导入
              </button>
            </>
          }
        >
          <p className="text-[12px] leading-6">
            导入会整体替换本机三层记忆与设置，当前记忆不会保留。建议先导出备份，操作不可撤销。
          </p>
        </ConfirmDialog>
      )}

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

  /* ---------------------------------------------------------- 个人知识库 */

  /* -------------------------------------------------------- 复盘（review fork） */

  const [reviewSettings, setReviewSettingsState] = useState(getReviewSettings());
  const [reviewReport, setReviewReport] = useState(getLastReviewReport());
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewMsg, setReviewMsg] = useState("");

  /** 容量条按「当前选中智能体」算；没选就显示全体上限说明。 */
  const reviewAgentId = agentId;
  const capacity = reviewAgentId ? reviewCapacity(reviewAgentId) : null;

  const patchReview = (patch: Partial<typeof reviewSettings>) => {
    const next = setReviewSettings(patch);
    setReviewSettingsState(next);
  };

  /** 手动复盘：拿该智能体最近一轮对话当素材；没有轮次就明确提示，不空跑模型。 */
  const doReviewNow = async () => {
    if (!reviewAgentId) {
      setReviewMsg("请先在上方选择一个智能体");
      return;
    }
    const turns = memory.working("", reviewAgentId);
    const window = turns.slice(-6);
    if (!window.length) {
      setReviewMsg("该智能体还没有可复盘的对话（记忆区「短期记忆」里能看到）");
      return;
    }
    setReviewBusy(true);
    setReviewMsg("复盘中…");
    try {
      const last = window[window.length - 1];
      const report = await runReviewNow({
        agentId: reviewAgentId,
        conversationId: last.conversationId,
        userText: last.userText,
        assistantText: last.assistantText,
        recentTurns: window.map((t) => ({ userText: t.userText, assistantText: t.assistantText })),
        toolCallCount: 0,
        profile: useLlmStore.getState().bindings[reviewAgentId]
          ? useLlmStore.getState().getProfile(useLlmStore.getState().bindings[reviewAgentId]!)
          : undefined,
      });
      setReviewReport(report);
      setReviewMsg(
        `已写入 ${report.memoryWritten} 条记忆${report.skillWritten ? `，沉淀技能「${report.skillWritten}」` : ""}`,
      );
    } catch (err) {
      setReviewMsg(`复盘失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setReviewBusy(false);
    }
  };

  const reviewCard = (
    <section aria-label="复盘沉淀" className={`${cardCls} mt-3`}>
      <div className="flex items-center justify-between gap-3">
        <div className="text-[12px] font-bold text-[#777]">复盘沉淀（任务结束后自评）</div>
        <button
          type="button"
          aria-label="立即复盘一次"
          disabled={reviewBusy}
          onClick={() => void doReviewNow()}
          className={`${btnGhost} disabled:opacity-50`}
        >
          {reviewBusy ? "复盘中…" : "立即复盘一次"}
        </button>
      </div>
      <div className={`mt-1 ${hintCls}`}>
        每轮结束后后台起一次轻量复盘：自问「有什么值得长期记住」，把事实写进语义记忆、
        把可复用流程沉淀成技能。密钥与口令一律不落盘，失败不影响对话。
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="text-[11px] text-muted">频率</span>
        {(
          [
            ["never", "关闭"],
            ["after_complex_tasks", "仅复杂任务"],
            ["always", "每轮都复盘"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-label={`复盘频率 ${label}`}
            aria-pressed={reviewSettings.frequency === value}
            onClick={() => patchReview({ frequency: value })}
            className={`rounded-lg border px-2 py-1 text-[11px] ${
              reviewSettings.frequency === value
                ? "border-[#1a1a1a] bg-ink text-white"
                : "border-line hover:bg-[#fafafa]"
            }`}
          >
            {label}
          </button>
        ))}
        <label className="flex items-center gap-1 text-[11px] text-muted">
          间隔轮次
          <input
            aria-label="复盘间隔轮次"
            type="number"
            min={1}
            max={50}
            value={reviewSettings.turnsThreshold}
            onChange={(e) => patchReview({ turnsThreshold: Number(e.target.value) })}
            className="w-[56px] rounded-lg border border-line px-2 py-1 text-[12px]"
          />
        </label>
      </div>

      {capacity && (
        <div className="mt-3">
          <div className="flex items-center justify-between text-[11px] text-muted">
            <span>语义记忆容量（该智能体）</span>
            <span>
              {capacity.used} / {capacity.limit} 字符
            </span>
          </div>
          <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-[#eee]">
            <div
              className="h-full rounded-full bg-ink"
              style={{
                width: `${Math.min(100, Math.round((capacity.used / capacity.limit) * 100))}%`,
              }}
            />
          </div>
          <div className={`mt-1 ${hintCls}`}>写满后复盘会拒绝新增并提示先整理，不会静默截断。</div>
        </div>
      )}

      {reviewMsg && (
        <div role="status" className="mt-2 text-[12px] text-muted">
          {reviewMsg}
        </div>
      )}
      {reviewReport && (
        <div className="mt-2 text-[11px] text-muted">
          最近一次：{reviewReport.reason}
          {reviewReport.memoryWritten > 0 && ` · 写入 ${reviewReport.memoryWritten} 条记忆`}
          {reviewReport.skillWritten && ` · 沉淀技能「${reviewReport.skillWritten}」`}
          {reviewReport.rejected.length > 0 &&
            ` · 拒绝 ${reviewReport.rejected.length} 条（${reviewReport.rejected[0].reason}）`}
        </div>
      )}
    </section>
  );

  /* -------------------------------------------------------- 智能体开关 */

  const agentPrefsCard = (
    <section aria-label="智能体记忆开关" className={`${cardCls} mt-3`}>
      <div className="text-[12px] font-bold text-[#777]">智能体记忆开关</div>
      <div className={`mt-1 ${hintCls}`}>
        短期记忆与长期记忆默认关闭，需要为每个智能体手动开启；个人数据库默认允许使用（个人知识库默认允许）。
      </div>
      {displayAgents.length === 0 && (
        <div className={`mt-3 ${hintCls}`}>名册为空：可在下方手动登记智能体 ID</div>
      )}
      {displayAgents.length > 0 && (
        <table className="mt-3 w-full text-left">
          <thead>
            <tr className="border-b border-line-soft text-[11px] text-muted">
              <th className="py-1.5 font-normal">智能体</th>
              <th className="py-1.5 text-center font-normal">短期记忆</th>
              <th className="py-1.5 text-center font-normal">长期记忆</th>
              <th className="py-1.5 text-center font-normal">个人数据库</th>
            </tr>
          </thead>
          <tbody>
            {displayAgents.map((agent) => {
              const pref = prefs.get(agent.id);
              return (
                <Fragment key={agent.id}>
                  <tr className="border-b border-line-soft align-middle">
                    <td className="py-2 pr-2">
                      <div className="text-[12px] font-bold">{agent.name}</div>
                      <div className="text-[10px] text-muted">{agent.id}</div>
                    </td>
                    <td className="py-2 text-center">
                      <Switch
                        label={`${agent.name} 短期记忆`}
                        checked={pref.shortTerm}
                        onChange={(next) => setPref(agent.id, { shortTerm: next })}
                      />
                    </td>
                    <td className="py-2 text-center">
                      <Switch
                        label={`${agent.name} 长期记忆`}
                        checked={pref.longTerm}
                        onChange={(next) => setPref(agent.id, { longTerm: next })}
                      />
                    </td>
                    <td className="py-2 text-center">
                      <Switch
                        label={`${agent.name} 个人数据库`}
                        checked={pref.personalDb}
                        onChange={(next) => onPersonalDbToggle(agent.id, next)}
                      />
                    </td>
                  </tr>
                  {pendingDbOff === agent.id && (
                    <tr className="border-b border-line-soft bg-[#fafafa]">
                      <td colSpan={4} className="px-2 py-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[11px] text-[#b45309]">
                            关闭后该智能体将不能读取个人知识库。个人知识库默认允许使用，确认关闭？
                          </span>
                          <button
                            type="button"
                            aria-label={`确认关闭 ${agent.name} 个人数据库`}
                            onClick={() => {
                              setPref(agent.id, { personalDb: false });
                              setPendingDbOff("");
                            }}
                            className={btnGhostSm}
                          >
                            确认关闭
                          </button>
                          <button
                            type="button"
                            onClick={() => setPendingDbOff("")}
                            className={btnGhostSm}
                          >
                            取消
                          </button>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
      <div className="mt-3 border-t border-line-soft pt-3">
        <div className={hintCls}>名册里没有的智能体，可手动登记 ID 与名称（偏好仍按 ID 持久化）</div>
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <label className={`${labelCls} w-[150px]`}>
            智能体 ID
            <input
              aria-label="智能体 ID"
              className={inputSmCls}
              value={manualAgentId}
              maxLength={64}
              onChange={(e) => {
                setManualAgentId(e.target.value);
                setManualMsg("");
              }}
            />
          </label>
          <label className={`${labelCls} w-[150px]`}>
            名称
            <input
              aria-label="智能体名称"
              className={inputSmCls}
              value={manualAgentName}
              maxLength={32}
              onChange={(e) => {
                setManualAgentName(e.target.value);
                setManualMsg("");
              }}
            />
          </label>
          <button type="button" onClick={onAddManualAgent} className={btnGhost}>
            添加
          </button>
          {manualMsg && (
            <span role="status" className={`${hintCls} pb-1.5`}>
              {manualMsg}
            </span>
          )}
        </div>
      </div>
    </section>
  );

  const tabCounts: Record<TabKey, number> = {
    // 智能体：短期记忆条数（设置与复盘卡是表单，不计入）
    agents: layers.working.length,
    // 数据库：全局语义记忆 + 情景记忆（这是所有智能体真正会读到的长期记忆）
    database: layers.globalSemantic.length + layers.episodic.length,
    wiki: 0, // wiki 页数由 WikiPanel 自管（走文件层，不在本页统计）
  };
  const tabOrder: TabKey[] = ["agents", "database", "wiki"];

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="shrink-0 px-6 pt-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-[17px] font-extrabold">记忆区</h1>
            <div className={`mt-1 ${hintCls}`}>
              智能体管自己的记忆设置，数据库是所有智能体公用的长期记忆，个人知识库给你自己看
            </div>
          </div>
          {/* 选择器不做可见文字标签：页面已经有一个名为「智能体」的标签页，
              再放一个同名文字会让读屏与测试都命中多处。可见性由 aria-label 承担。 */}
          <label className="flex shrink-0 items-center gap-2 whitespace-nowrap text-[12px] text-muted">
            <span className="text-[#aaa]">当前</span>
            <select
              aria-label="选择智能体"
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              className="rounded-lg border border-line px-2 py-1.5 text-[12px] outline-none focus:border-[#bbb]"
            >
              <option value="">全部智能体</option>
              {[...agents, ...manualAgents].map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        {rosterError && (
          <div role="status" className="mt-2 text-[12px] text-[#b45309]">
            {rosterError}
          </div>
        )}

        {/* 上侧横向标签页：选中项白底、下边框与内容区连成一体（与设置页同一视觉语言） */}
        <div
          role="tablist"
          aria-label="记忆分区"
          className="mt-3 flex gap-1 border-b border-line-soft"
        >
          {tabOrder.map((key) => {
            const active = tab === key;
            return (
              <button
                key={key}
                type="button"
                role="tab"
                id={`memory-${key}-tab`}
                aria-controls={`memory-${key}-panel`}
                aria-selected={active}
                aria-label={TAB_LABELS[key]}
                onClick={() => setTab(key)}
                className={`-mb-px border-b-2 px-3.5 py-2 text-[12.5px] transition-colors ${
                  active
                    ? "border-b-ink font-bold text-ink"
                    : "border-b-transparent text-muted hover:text-ink"
                }`}
              >
                {TAB_LABELS[key]}
                <span className="ml-1.5 text-[11px] text-[#aaa]">{tabCounts[key]}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div
        role="tabpanel"
        id={`memory-${tab}-panel`}
        aria-labelledby={`memory-${tab}-tab`}
        className="min-h-0 flex-1 overflow-y-auto px-6 py-4"
      >
        {tab === "agents" && (
          <div className="flex flex-col gap-3">
            {shortPanel}
            {agentPrefsCard}
            {reviewCard}
          </div>
        )}
        {tab === "database" && databasePanel}
        {tab === "wiki" && <WikiPanel />}
      </div>

      {clearTarget && (
        <ConfirmDialog
          title="清空短期记忆"
          onCancel={() => setClearTarget(null)}
          footer={
            <>
              <button
                type="button"
                onClick={() => setClearTarget(null)}
                className="rounded-lg border border-line px-3 py-1.5 text-[12px] text-muted hover:bg-[#f7f7f7]"
              >
                取消
              </button>
              <button
                type="button"
                onClick={confirmClearConversation}
                className="rounded-lg bg-[#b42318] px-3 py-1.5 text-[12px] font-medium text-white"
              >
                清空
              </button>
            </>
          }
        >
          <p className="text-[12px] leading-6">
            清空会话「{clearTarget.label}」的短期记忆？长期记忆与已发送的聊天记录不受影响，但这段短期上下文清空后无法恢复。
          </p>
        </ConfirmDialog>
      )}

    </div>
  );
}
