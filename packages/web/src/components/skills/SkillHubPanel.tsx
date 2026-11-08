import { useEffect, useMemo, useRef, useState } from "react";
import {
  type SkillCommunityMeta,
  type SkillHubDetail,
  type SkillHubDownload,
  type SkillHubSkill,
  type SkillHubStatus,
} from "@heming/shared";
import type { ParsedSkill } from "../../lib/skills/markdown.js";
import { parseImportText } from "../../lib/skills/markdown.js";
import type { SkillDefinition, SkillPool } from "../../lib/skills/index.js";
import {
  SkillHubError,
  clearHubKey,
  downloadHubSkill,
  fetchHubDetail,
  fetchHubSkills,
  fetchHubStatus,
  readHubKeyState,
  registerHubAccount,
  safeExternalUrl,
  saveHubKey,
  type HubKeyState,
  type SkillHubClientDeps,
  type SkillHubSort,
} from "../../lib/skills/hubClient.js";
import { MarkdownMessage } from "../MarkdownMessage.js";
import { useModalA11y } from "../useModalA11y.js";
import { XIcon } from "../icons.js";
import { BTN_GHOST, BTN_GHOST_SM, BTN_PRIMARY, CHIP, ERROR_TEXT, HINT } from "../plugins/shared.js";
import { EmptyState } from "../ui/EmptyState.js";
import { useUiStore } from "../../store/ui.js";

/**
 * 技能社区（虾评）面板（d.109）。
 *
 * 结构：状态 → 搜索/分类/排序 → 卡片列表 → 详情弹窗（安全标记/报告 + 安装）→
 * Key 引导弹窗（粘贴 / 用名字创建账号 / 清除）→ 安装预览（确认后写入技能池）。
 *
 * 安装语义（与既有导入一致，另记社区归属）：
 * - 技能内容只有 SKILL.md 文本，交给 `parseImportText` 解析；**不执行随包代码**；
 * - 写入走 `skills.update`（同社区 skillId 或同名）或 `skills.create`，`source: "imported"`；
 * - `community` 记来源/上游 id/版本/作者/主页，用于「已安装 / 有新版本」徽标；
 * - **默认不分配给任何智能体**（沿用导入语义）。
 */

export const HUB_SEARCH_DEBOUNCE_MS = 250;

const DEFAULT_SOURCE = { id: "xiaping", name: "虾评", homepage: "https://xiaping.coze.com", docsUrl: "" };

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatCount(value: number): string {
  return value >= 10_000 ? `${(value / 10_000).toFixed(1)} 万` : String(value);
}

function formatDate(value: string | undefined): string {
  if (!value) return "—";
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : "—";
}

type SortKey = SkillHubSort;

interface ListState {
  items: SkillHubSkill[];
  total: number;
  hasMore: boolean;
  loading: boolean;
  error: string | null;
}

interface InstallTarget {
  id: string;
  name: string;
  version: string;
  author: string;
  homepage?: string;
}

interface InstallPreview {
  target: InstallTarget;
  download: SkillHubDownload;
  parsed: ParsedSkill;
  sameName?: SkillDefinition;
}

/** 一条「社区有新版」的已装技能（d.110 聚合 + 批量更新）。 */
interface CommunityUpdateRow {
  skill: SkillDefinition;
  localVersion: string;
  remoteVersion: string;
  author: string;
}

/** 批量更新的逐条结果（成功/跳过/失败，失败不中断后续）。 */
export interface BulkUpdateOutcome {
  kind: "ok" | "skipped" | "failed";
  name: string;
  detail?: string;
}

export interface SkillHubPanelProps {
  skills: SkillPool;
  deps?: SkillHubClientDeps;
  /** 安装/更新后通知宿主刷新技能列表。 */
  onInstalled?: () => void;
  /** 「去技能区分配」：由宿主把技能视图切到技能池 Tab（不新增全局状态）。 */
  onGoAssign?: () => void;
}

/* ─────────────────────────────── Key 弹窗 ─────────────────────────────── */

function KeyDialog({
  status,
  keyInfo,
  deps,
  onClose,
  onSaved,
}: {
  status: SkillHubStatus;
  keyInfo: HubKeyState | null;
  deps?: SkillHubClientDeps;
  onClose: () => void;
  onSaved: (info: { encrypted: boolean }) => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useModalA11y(panelRef, onClose, { active: true });
  const [draft, setDraft] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedEncrypted, setSavedEncrypted] = useState<boolean | null>(
    keyInfo?.kind === "encrypted" ? true : keyInfo?.kind === "plain" ? false : null,
  );
  const source = status.source ?? DEFAULT_SOURCE;
  const sourceHomepage = safeExternalUrl(source.homepage);
  const sourceDocs = safeExternalUrl(source.docsUrl);
  const hasKey = keyInfo?.kind === "encrypted" || keyInfo?.kind === "plain";

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await saveHubKey(draft);
      setSavedEncrypted(result.encrypted);
      setNote(result.encrypted ? "已加密保存到本机。" : "当前环境无系统安全存储，Key 以明文保存在本机。");
      setDraft("");
      onSaved({ encrypted: result.encrypted });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const register = async () => {
    if (!name.trim()) {
      setError("先填一个昵称再创建账号");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await registerHubAccount(name.trim(), deps);
      const stored = await saveHubKey(result.apiKey);
      setSavedEncrypted(stored.encrypted);
      setNote(
        `已在虾评创建账号${result.name ? `「${result.name}」` : ""}；Key ${
          stored.encrypted ? "已加密保存" : "已明文保存在本机"
        }。`,
      );
      onSaved({ encrypted: stored.encrypted });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const clear = () => {
    clearHubKey();
    setSavedEncrypted(null);
    setNote("已清除本机保存的社区 Key。");
    setError(null);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" role="presentation">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="社区 Key"
        className="w-[min(520px,94vw)] rounded-xl border border-line bg-white p-4 shadow-card"
      >
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-bold">社区 Key（{source.name}）</span>
          <button
            type="button"
            aria-label="关闭社区 Key"
            className="ml-auto rounded-sm p-1 text-muted hover:bg-[#f0f0f0]"
            onClick={onClose}
          >
            <XIcon width={14} height={14} />
          </button>
        </div>
        <p className={`mt-1 ${HINT}`}>
          下载需要你自己的社区 API Key；和鸣不代扣、不共享，Key 只保存在本机。
        </p>
        {hasKey && (
          <p className={`mt-1 ${HINT}`}>
            {keyInfo?.kind === "encrypted"
              ? "已保存加密 Key。"
              : keyInfo?.kind === "plain"
                ? "已保存明文 Key（当前环境无系统安全存储）。"
                : "本机有加密 Key，但当前环境解不开（请在桌面端使用）。"}
          </p>
        )}
        {keyInfo?.kind === "locked" && (
          <p role="alert" className={`mt-1 ${ERROR_TEXT}`}>
            本机保存的 Key 是密文，但当前环境没有解密桥；请到桌面端使用，或清除后重新粘贴。
          </p>
        )}

        <label className="mt-3 block ui-caption">
          粘贴 API Key
          <input
            aria-label="社区 API Key"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="粘贴虾评 API Key"
            className="mt-1 ui-input w-full"
          />
        </label>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="ui-btn ui-btn-sm ui-btn-primary"
            disabled={busy || !draft.trim()}
            onClick={() => void save()}
          >
            保存 Key
          </button>
          {sourceHomepage && (
            <a
              className="ui-link"
              href={sourceHomepage}
              target="_blank"
              rel="noreferrer noopener"
            >
              去{source.name}注册 / 获取 Key
            </a>
          )}
          {sourceDocs && (
            <a className="ui-link" href={sourceDocs} target="_blank" rel="noreferrer noopener">
              接入说明
            </a>
          )}
        </div>

        <div className="mt-4 border-t border-line-soft pt-3">
          <p className="ui-body-sm font-medium">没有 Key？用这个名字创建账号</p>
          <p className={`mt-1 ${HINT}`}>点击下面的按钮将在{source.name}创建一个新账号，并消耗一次注册额度。</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              aria-label="注册用户名"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="昵称（可留空让上游生成）"
              className="ui-input min-w-[180px] flex-1"
            />
            <button
              type="button"
              className="ui-btn ui-btn-sm ui-btn-ghost"
              disabled={busy}
              onClick={() => void register()}
            >
              用这个名字创建账号（将在{source.name}创建账号）
            </button>
          </div>
        </div>

        {note && <p className={`mt-2 ${HINT}`}>{note}</p>}
        {error && (
          <p role="alert" className={`mt-2 ${ERROR_TEXT}`}>
            {error}
          </p>
        )}

        <div className="mt-3 flex items-center gap-2">
          {hasKey && (
            <button type="button" className="ui-btn ui-btn-sm ui-btn-ghost text-[#b42318]" onClick={clear}>
              清除 Key
            </button>
          )}
          <button type="button" className={`ml-auto ${BTN_GHOST_SM}`} onClick={onClose}>
            关闭
          </button>
        </div>
        {savedEncrypted === false && (
          <p className={`mt-1 ${HINT}`}>提示：本机没有系统安全存储，Key 以明文保存；可在桌面端重新保存以获得加密。</p>
        )}
      </div>
    </div>
  );
}

/* ─────────────────────────────── 详情弹窗 ─────────────────────────────── */

function HubDetailDialog({
  skill,
  deps,
  installed,
  onClose,
  onInstall,
}: {
  skill: SkillHubSkill;
  deps?: SkillHubClientDeps;
  installed: SkillDefinition | undefined;
  onClose: () => void;
  onInstall: (detail: SkillHubDetail) => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useModalA11y(panelRef, onClose, { active: true });
  const [state, setState] = useState<{ loading: boolean; detail: SkillHubDetail | null; error: string | null }>(
    { loading: true, detail: null, error: null },
  );
  const [retryTick, setRetryTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, detail: null, error: null });
    void fetchHubDetail(skill.id, deps)
      .then((detail) => {
        if (!cancelled) setState({ loading: false, detail, error: null });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ loading: false, detail: null, error: errorText(err) });
      });
    return () => {
      cancelled = true;
    };
    // deps 拆成原始值，避免父级内联对象导致重复请求
  }, [skill.id, deps?.fetchImpl, deps?.baseUrl, retryTick]);

  const detail = state.detail;
  const detailHomepage = safeExternalUrl(detail?.homepage);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" role="presentation">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={`社区技能 ${skill.name}`}
        className="flex max-h-[88vh] w-[min(720px,94vw)] flex-col overflow-hidden rounded-xl bg-white shadow-xl"
      >
        <div className="flex items-start gap-2 border-b border-line-soft px-4 py-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[15px] font-extrabold">{skill.name}</span>
              <span className={CHIP}>v{skill.version || "—"}</span>
              {skill.status === "official" && <span className={CHIP}>官方</span>}
              {skill.status === "trial" && <span className={CHIP}>试用</span>}
              {installed && <span className={CHIP}>已安装</span>}
            </div>
            <p className={`mt-0.5 ${HINT}`}>
              {skill.ownerName || "未知作者"} · 更新于 {formatDate(skill.updatedAt)}
            </p>
          </div>
          <button
            type="button"
            aria-label="关闭社区技能详情"
            className="ml-auto rounded-sm p-1 text-muted hover:bg-[#f0f0f0]"
            onClick={onClose}
          >
            <XIcon width={14} height={14} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <p className="ui-body-sm text-muted">{detail?.description || skill.description || "暂无描述"}</p>

          <section aria-label="技能信息" className="mt-3 rounded-lg border border-line-soft p-3">
            <h3 className="ui-body-sm font-bold">技能信息</h3>
            <div className="mt-1 flex flex-wrap items-center gap-1.5 ui-caption">
              {(detail?.categories ?? skill.categories).map((item) => (
                <span key={`cat:${item}`} className={CHIP}>
                  分类 · {item}
                </span>
              ))}
              {(detail?.tags ?? skill.tags).map((item) => (
                <span key={`tag:${item}`} className={CHIP}>
                  标签 · {item}
                </span>
              ))}
              <span className={CHIP}>下载 {formatCount(detail?.downloads ?? skill.downloads)}</span>
              <span className={CHIP}>收藏 {formatCount(detail?.stars ?? skill.stars)}</span>
              {detail?.versionCount !== undefined && (
                <span className={CHIP}>版本数 {detail.versionCount}</span>
              )}
            </div>
            <div className="mt-2">
              <span className={HINT}>触发词：</span>
              {(detail?.triggers ?? skill.triggers).length > 0 ? (
                (detail?.triggers ?? skill.triggers).map((item) => (
                  <span key={`trigger:${item}`} className={`${CHIP} mr-1`}>
                    {item}
                  </span>
                ))
              ) : (
                <span className={HINT}>上游没有提供触发词</span>
              )}
            </div>
            {detailHomepage && (
              <a
                className="ui-link mt-2 inline-block"
                href={detailHomepage}
                target="_blank"
                rel="noreferrer noopener"
              >
                在社区查看原文
              </a>
            )}
          </section>

          <section aria-label="安全信息" className="mt-3 rounded-lg border border-line-soft p-3">
            <h3 className="ui-body-sm font-bold">安全信息</h3>
            {state.loading ? (
              <p className={`mt-1 ${HINT}`}>正在读取安全信息…</p>
            ) : state.error ? (
              <div className="mt-1">
                <p role="alert" className={ERROR_TEXT}>
                  详情加载失败：{state.error}
                </p>
                <button type="button" className="ui-link mt-1" onClick={() => setRetryTick((n) => n + 1)}>
                  重试
                </button>
              </div>
            ) : detail?.securityStatus ? (
              <p className="mt-1 ui-body-sm">
                上游安全结论：<span className={CHIP}>{detail.securityStatus}</span>
              </p>
            ) : (
              <p className={`mt-1 ${HINT}`}>上游未提供安全检测结论，请自行判断内容是否可信。</p>
            )}
            {detail?.securityReport && (
              <details className="mt-2">
                <summary className="cursor-pointer ui-caption">查看安全报告</summary>
                <div className="mt-1 ui-body-sm leading-6">
                  <MarkdownMessage text={detail.securityReport} />
                </div>
              </details>
            )}
          </section>

          <p className={`mt-3 ${HINT}`}>
            社区技能是第三方提供的**指令文本**；和鸣不会执行随技能下发的代码，安装后默认不分配给任何智能体。
          </p>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-line-soft px-4 py-2.5">
          {skill.requiresApiKey && <span className={`mr-auto ${HINT}`}>该技能需要自备社区 Key</span>}
          <button type="button" className={BTN_GHOST} onClick={onClose}>
            关闭
          </button>
          <button
            type="button"
            className={BTN_PRIMARY}
            onClick={() => {
              if (detail) onInstall(detail);
            }}
            disabled={state.loading || Boolean(state.error)}
          >
            安装
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────── 安装预览弹窗 ─────────────────────────── */

function InstallPreviewDialog({
  preview,
  onConfirm,
  onCancel,
}: {
  preview: InstallPreview;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useModalA11y(panelRef, onCancel, { active: true });
  const { parsed, target, download, sameName } = preview;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" role="presentation">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="安装社区技能"
        className="w-[min(560px,94vw)] rounded-xl border border-line bg-white p-4 shadow-card"
      >
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-bold">安装社区技能</span>
          <button
            type="button"
            aria-label="关闭安装预览"
            className="ml-auto rounded-sm p-1 text-muted hover:bg-[#f0f0f0]"
            onClick={onCancel}
          >
            <XIcon width={14} height={14} />
          </button>
        </div>
        <dl className="mt-2 grid gap-1 ui-body-sm">
          <div>
            <dt className="inline text-muted">技能名：</dt>
            <dd className="inline font-medium">{parsed.name}</dd>
          </div>
          <div>
            <dt className="inline text-muted">来源：</dt>
            <dd className="inline">
              虾评 · {target.author || "未知作者"} · v{download.version || target.version || "—"}
            </dd>
          </div>
          <div>
            <dt className="inline text-muted">触发词：</dt>
            <dd className="inline">
              {(parsed.triggers ?? []).length > 0 ? (parsed.triggers ?? []).join("、") : "无"}
            </dd>
          </div>
          <div>
            <dt className="inline text-muted">标签：</dt>
            <dd className="inline">{(parsed.tags ?? []).length > 0 ? (parsed.tags ?? []).join("、") : "无"}</dd>
          </div>
          <div>
            <dt className="inline text-muted">指令字数：</dt>
            <dd className="inline">{parsed.instructions.trim().length} 字</dd>
          </div>
          <div>
            <dt className="inline text-muted">随包文件：</dt>
            <dd className="inline">
              {download.files.length === 0
                ? "仅 SKILL.md"
                : `SKILL.md + ${download.files.length} 个文件（只记录路径，不执行）`}
            </dd>
          </div>
        </dl>
        {sameName && (
          <p role="alert" className={`mt-2 ${ERROR_TEXT}`}>
            本机已有同名技能「{sameName.name}」，确认安装将更新它的内容（保留原启用/分配状态）。
          </p>
        )}
        <p className={`mt-2 ${HINT}`}>
          以上内容来自第三方社区；安装后写入技能池并标记为「已装」，默认不分配给任何智能体。
        </p>
        <div className="mt-3 flex items-center justify-end gap-2">
          <button type="button" className={BTN_GHOST} onClick={onCancel}>
            取消
          </button>
          <button type="button" className={BTN_PRIMARY} onClick={onConfirm}>
            确认安装
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────── 批量更新确认弹窗 ─────────────────────────── */

function BulkUpdateDialog({
  rows,
  running,
  results,
  done,
  onConfirm,
  onClose,
  onGoAssign,
}: {
  rows: CommunityUpdateRow[];
  running: boolean;
  results: BulkUpdateOutcome[];
  done: boolean;
  onConfirm: () => void;
  onClose: () => void;
  onGoAssign: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useModalA11y(panelRef, onClose, { active: !running });
  const ok = results.filter((item) => item.kind === "ok").length;
  const failed = results.filter((item) => item.kind === "failed").length;
  const skipped = results.filter((item) => item.kind === "skipped").length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" role="presentation">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="批量更新社区技能"
        className="flex max-h-[86vh] w-[min(620px,94vw)] flex-col overflow-hidden rounded-xl border border-line bg-white shadow-xl"
      >
        <div className="flex items-center gap-2 border-b border-line-soft px-4 py-3">
          <span className="text-[13px] font-bold">批量更新社区技能</span>
          <button
            type="button"
            aria-label="关闭批量更新"
            className="ml-auto rounded-sm p-1 text-muted hover:bg-[#f0f0f0]"
            onClick={onClose}
          >
            <XIcon width={14} height={14} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <p className="ui-body-sm">
            将按顺序更新 {rows.length} 个社区技能；同名手工技能会跳过、不会被覆盖。
          </p>
          <ul className="mt-2 divide-y divide-line-soft">
            {rows.map((row) => (
              <li key={row.skill.id} className="flex flex-wrap items-center gap-2 py-1.5 ui-body-sm">
                <span className="font-medium">{row.skill.name}</span>
                <span className={HINT}>
                  v{row.localVersion} → v{row.remoteVersion}
                </span>
                <span className={`ml-auto ${HINT}`}>{row.author || "未知作者"}</span>
              </li>
            ))}
          </ul>

          {(running || results.length > 0) && (
            <div className="mt-3 border-t border-line-soft pt-2">
              <p className="ui-body-sm font-medium">
                {running
                  ? `正在更新…（已完成 ${results.length} / ${rows.length}）`
                  : `更新完成：成功 ${ok} / 失败 ${failed}${skipped > 0 ? ` / 跳过 ${skipped}` : ""}`}
              </p>
              <ul className="mt-1 grid gap-1 ui-caption">
                {results.map((item, index) => (
                  <li key={`${item.name}:${index}`} className="flex flex-wrap items-baseline gap-1.5">
                    <span className="rounded-sm border border-line px-1.5 py-0.5 text-[10px]">
                      {item.kind === "ok" ? "成功" : item.kind === "skipped" ? "跳过" : "失败"}
                    </span>
                    <span>{item.name}</span>
                    {item.detail && <span className="text-muted">{item.detail}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-line-soft px-4 py-2.5">
          <button type="button" className={BTN_GHOST} onClick={onClose}>
            {done ? "完成" : "取消"}
          </button>
          {!done && (
            <button
              type="button"
              className={BTN_PRIMARY}
              disabled={running || rows.length === 0}
              onClick={onConfirm}
            >
              {running ? "更新中…" : "确认更新"}
            </button>
          )}
          {done && ok > 0 && (
            <button type="button" className={BTN_PRIMARY} onClick={onGoAssign}>
              去技能区分配
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────── 主面板 ─────────────────────────────── */

export function SkillHubPanel({ skills, deps, onInstalled, onGoAssign }: SkillHubPanelProps) {
  const fetchImpl = deps?.fetchImpl;
  const baseUrl = deps?.baseUrl;

  const [status, setStatus] = useState<SkillHubStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [reloadStatusTick, setReloadStatusTick] = useState(0);

  const [keyInfo, setKeyInfo] = useState<HubKeyState | null>(null);
  const [keyOpen, setKeyOpen] = useState(false);

  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [category, setCategory] = useState("");
  const [sort, setSort] = useState<SortKey>("downloads");
  const [page, setPage] = useState(1);
  const [listRetryTick, setListRetryTick] = useState(0);
  const [list, setList] = useState<ListState>({ items: [], total: 0, hasMore: false, loading: false, error: null });

  const [detailSkill, setDetailSkill] = useState<SkillHubSkill | null>(null);
  const [pending, setPending] = useState<{ target: InstallTarget; key: string } | null>(null);
  const [preview, setPreview] = useState<InstallPreview | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [tick, setTick] = useState(0);
  /** d.110：社区技能的远程版本（列表条目 + 对已装但不在当前页的 id 单独拉详情）。 */
  const [remoteVersions, setRemoteVersions] = useState<Record<string, string>>({});
  /** d.110：批量更新确认/执行状态。 */
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkResults, setBulkResults] = useState<BulkUpdateOutcome[]>([]);
  const [bulkDone, setBulkDone] = useState(false);
  const [pendingBulk, setPendingBulk] = useState(false);
  /** 冻结的批量更新清单：执行中本地版本会变，弹窗列表不能跟着缩水。 */
  const [bulkRows, setBulkRows] = useState<CommunityUpdateRow[]>([]);
  /** 安装/更新成功后提供「去技能区分配」出口。 */
  const [showGoAssign, setShowGoAssign] = useState(false);

  /** 状态：挂载与手动重试时拉。 */
  useEffect(() => {
    let cancelled = false;
    setStatusLoading(true);
    void fetchHubStatus({ fetchImpl, baseUrl })
      .then((value) => {
        if (!cancelled) {
          setStatus(value);
          setStatusError(null);
          setStatusLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setStatus(null);
          setStatusError(errorText(err));
          setStatusLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [fetchImpl, baseUrl, reloadStatusTick]);

  /** Key：挂载时读一次，保存/清除后刷新。 */
  const refreshKey = () => {
    void readHubKeyState().then((value) => setKeyInfo(value));
  };
  useEffect(() => {
    refreshKey();
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query), HUB_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    setPage(1);
  }, [debounced, category, sort]);

  const enabled = status?.enabled === true;
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setList((prev) => ({ ...prev, loading: true, error: null }));
    void fetchHubSkills({
      page,
      limit: 24,
      search: debounced || undefined,
      category: category || undefined,
      sort,
      fetchImpl,
      baseUrl,
    })
      .then((result) => {
        if (cancelled) return;
        setList((prev) => ({
          items: page === 1 ? result.skills : [...prev.items, ...result.skills],
          total: result.total,
          hasMore: result.hasMore,
          loading: false,
          error: null,
        }));
      })
      .catch((err: unknown) => {
        if (!cancelled) setList((prev) => ({ ...prev, loading: false, error: errorText(err) }));
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, page, debounced, category, sort, fetchImpl, baseUrl, listRetryTick]);

  /** 本机已装（按社区 skillId 匹配）：用于「已安装 / 有新版本」。 */
  const installedByHubId = useMemo(() => {
    const sourceId = status?.source.id ?? "xiaping";
    const map = new Map<string, SkillDefinition>();
    for (const skill of skills.list()) {
      if (skill.community?.source === sourceId) map.set(skill.community.skillId, skill);
    }
    return map;
    // tick：安装后强制重算
  }, [skills, status, tick]);

  /* ─────────── d.110：已装社区技能聚合 + 可更新判定 + 全部更新 ─────────── */

  const sourceId = status?.source.id ?? "xiaping";
  const installedCommunity = useMemo(
    () => skills.list().filter((skill) => skill.community?.source === sourceId),
    [skills, sourceId, tick],
  );

  /** 列表条目已知的远程版本直接合并；减少对详情接口的额外请求。 */
  useEffect(() => {
    if (list.items.length === 0) return;
    setRemoteVersions((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const item of list.items) {
        if (next[item.id] !== item.version) {
          next[item.id] = item.version;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [list.items]);

  /** 已装但不在当前列表页的 id：单独拉详情补远程版本（失败只记一次，避免无限重试）。 */
  const remoteProbed = useRef(new Set<string>());
  useEffect(() => {
    if (!enabled) return;
    const missing = installedCommunity
      .map((skill) => skill.community?.skillId ?? "")
      .filter((id) => id && remoteVersions[id] === undefined && !remoteProbed.current.has(id));
    if (missing.length === 0) return;
    for (const id of missing) remoteProbed.current.add(id);
    let cancelled = false;
    void Promise.all(
      missing.map((id) =>
        fetchHubDetail(id, { fetchImpl, baseUrl })
          .then((detail) => ({ id, version: detail.version }))
          .catch(() => null),
      ),
    ).then((rows) => {
      if (cancelled) return;
      const found = rows.filter((row): row is { id: string; version: string } => row !== null);
      if (found.length === 0) return;
      setRemoteVersions((prev) => {
        const next = { ...prev };
        for (const row of found) next[row.id] = row.version;
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, installedCommunity, remoteVersions, fetchImpl, baseUrl]);

  /** 有远程新版本的已装技能（按 community.skillId 对齐）。 */
  const communityUpdates = useMemo<CommunityUpdateRow[]>(() => {
    const rows: CommunityUpdateRow[] = [];
    for (const skill of installedCommunity) {
      const hubId = skill.community?.skillId ?? "";
      const remote = hubId ? remoteVersions[hubId] : undefined;
      const local = skill.community?.version ?? "";
      if (!remote || remote === local) continue;
      rows.push({
        skill,
        localVersion: local || "—",
        remoteVersion: remote,
        author: skill.community?.author ?? "",
      });
    }
    return rows;
  }, [installedCommunity, remoteVersions]);

  const startInstall = async (target: InstallTarget) => {
    setBusyId(target.id);
    setMsg(null);
    try {
      let state = keyInfo;
      if (!state) {
        state = await readHubKeyState();
        setKeyInfo(state);
      }
      if (state.kind !== "encrypted" && state.kind !== "plain") {
        setPending({ target, key: "" });
        setKeyOpen(true);
        return;
      }
      await runDownload(target, state.key);
    } catch (err) {
      setMsg({ kind: "error", text: errorText(err) });
    } finally {
      setBusyId(null);
    }
  };

  const runDownload = async (target: InstallTarget, key: string) => {
    const download = await downloadHubSkill(target.id, key, { fetchImpl, baseUrl });
    const parsedList = parseImportText(download.skillMd);
    if (parsedList.length !== 1) {
      throw new SkillHubError("下载包里的 SKILL.md 不是单个技能，已拒绝安装");
    }
    const parsed = parsedList[0]!;
    if (!parsed.instructions.trim()) {
      throw new SkillHubError("下载的技能内容为空，已拒绝安装");
    }
    const sameName = skills.list().find((item) => item.name === parsed.name);
    setPreview({ target, download, parsed, ...(sameName ? { sameName } : {}) });
    setDetailSkill(null);
  };

  const confirmInstall = () => {
    if (!preview) return;
    const { target, download, parsed, sameName } = preview;
    const sourceId = status?.source.id ?? "xiaping";
    const community: SkillCommunityMeta = {
      source: sourceId,
      skillId: target.id,
      name: target.name,
      author: target.author,
      version: download.version || target.version,
      ...(safeExternalUrl(target.homepage) ? { homepage: safeExternalUrl(target.homepage) as string } : {}),
      installedAt: new Date().toISOString(),
    };
    const content = {
      name: parsed.name,
      description: parsed.description ?? "",
      instructions: parsed.instructions,
      triggers: parsed.triggers ?? [],
      tags: parsed.tags ?? [],
      version: download.version || parsed.version || target.version || "1.0.0",
      source: "imported" as const,
      community,
    };
    try {
      const existing =
        skills.list().find((item) => item.community?.source === sourceId && item.community.skillId === target.id) ??
        sameName;
      if (existing) {
        skills.update(existing.id, content);
      } else {
        skills.create({ ...content, enabled: true });
      }
      setPreview(null);
      setTick((n) => n + 1);
      setShowGoAssign(true);
      setMsg({ kind: "ok", text: `已安装「${parsed.name}」；默认未分配给任何智能体。` });
      onInstalled?.();
    } catch (err) {
      setMsg({ kind: "error", text: `安装失败：${errorText(err)}` });
    }
  };

  /** 「去技能区分配」：切到技能区 → 技能池 Tab（宿主回调负责页内 Tab，不新增全局状态）。 */
  const goAssign = () => {
    useUiStore.getState().setPage("skills");
    onGoAssign?.();
  };

  /**
   * 批量更新：逐个下载/解析/覆盖（失败不中断），同名手工技能跳过不覆盖。
   * 先确认 Key；无 Key 时交给 Key 弹窗，保存后继续（pendingBulk）。
   */
  const openBulkUpdate = async () => {
    setMsg(null);
    let state = keyInfo;
    if (!state) {
      state = await readHubKeyState();
      setKeyInfo(state);
    }
    if (state.kind !== "encrypted" && state.kind !== "plain") {
      setPendingBulk(true);
      setKeyOpen(true);
      return;
    }
    setBulkRows([...communityUpdates]);
    setBulkResults([]);
    setBulkDone(false);
    setBulkOpen(true);
  };

  const runBulkUpdate = async (key: string, rows: CommunityUpdateRow[] = communityUpdates) => {
    setBulkRunning(true);
    setBulkDone(false);
    setBulkResults([]);
    const results: BulkUpdateOutcome[] = [];
    for (const row of rows) {
      const hubId = row.skill.community?.skillId ?? "";
      try {
        const download = await downloadHubSkill(hubId, key, { fetchImpl, baseUrl });
        const parsedList = parseImportText(download.skillMd);
        const parsed = parsedList[0];
        if (parsedList.length !== 1 || !parsed || !parsed.instructions.trim()) {
          throw new SkillHubError("下载内容不是单个有效技能");
        }
        const target = skills
          .list()
          .find(
            (item) => item.community?.source === sourceId && item.community.skillId === hubId,
          );
        if (!target) {
          results.push({ kind: "skipped", name: row.skill.name, detail: "找不到对应的已装技能" });
          setBulkResults([...results]);
          continue;
        }
        // 不静默覆盖手工技能：同名但没有社区归属的，跳过并说明。
        const nameOwner = skills.list().find((item) => item.name === parsed.name);
        if (nameOwner && nameOwner.id !== target.id && !nameOwner.community) {
          results.push({ kind: "skipped", name: parsed.name, detail: "同名手工技能，未覆盖" });
          setBulkResults([...results]);
          continue;
        }
        const version = download.version || parsed.version || row.remoteVersion;
        skills.update(target.id, {
          name: parsed.name,
          description: parsed.description ?? "",
          instructions: parsed.instructions,
          triggers: parsed.triggers ?? [],
          tags: parsed.tags ?? [],
          version,
          source: "imported",
          community: {
            source: sourceId,
            skillId: hubId,
            name: row.skill.community?.name ?? parsed.name,
            author: row.skill.community?.author ?? "",
            version,
            ...(safeExternalUrl(row.skill.community?.homepage)
              ? { homepage: safeExternalUrl(row.skill.community?.homepage) as string }
              : {}),
            installedAt: row.skill.community?.installedAt ?? new Date().toISOString(),
          },
        });
        results.push({ kind: "ok", name: parsed.name, detail: `v${row.localVersion} → v${version}` });
      } catch (err) {
        results.push({ kind: "failed", name: row.skill.name, detail: errorText(err) });
      }
      setBulkResults([...results]);
      setTick((n) => n + 1);
    }
    setBulkRunning(false);
    setBulkDone(true);
    const ok = results.filter((item) => item.kind === "ok").length;
    const failed = results.filter((item) => item.kind === "failed").length;
    const skipped = results.filter((item) => item.kind === "skipped").length;
    setMsg({
      kind: failed > 0 ? "error" : "ok",
      text: `社区技能更新完成：成功 ${ok} / 失败 ${failed}${skipped > 0 ? ` / 跳过 ${skipped}` : ""}`,
    });
    if (ok > 0) {
      setShowGoAssign(true);
      onInstalled?.();
    }
  };

  /* ── 渲染 ── */

  if (statusLoading) {
    return (
      <section aria-label="技能社区" className="mt-3">
        <p role="status" className={HINT}>正在连接技能社区…</p>
      </section>
    );
  }

  if (statusError) {
    return (
      <section aria-label="技能社区" className="mt-3 rounded-lg border border-[var(--danger-line)] bg-[var(--danger-soft)] p-3">
        <p role="alert" className={ERROR_TEXT}>技能社区不可用：{statusError}</p>
        <button type="button" className="ui-link mt-1" onClick={() => setReloadStatusTick((n) => n + 1)}>
          重试
        </button>
      </section>
    );
  }

  if (!enabled) {
    return (
      <section aria-label="技能社区" className="mt-3">
        <EmptyState
          title="社区未启用"
          desc="服务端没有开启技能社区（或未配置上游），可联系管理员；技能池与导入功能不受影响。"
          actions={
            <button type="button" className={BTN_GHOST_SM} onClick={() => setReloadStatusTick((n) => n + 1)}>
              重试
            </button>
          }
        />
      </section>
    );
  }

  const source = status!.source ?? DEFAULT_SOURCE;
  const categories = status!.categories ?? [];
  const filterActive = query.trim().length > 0 || category !== "";

  return (
    <section aria-label="技能社区" className="mt-3">
      <div className="mb-2 rounded-lg border border-line bg-[#fafafa] p-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="ui-body-sm font-bold">技能社区 · {source.name}</span>
          <span className={CHIP}>{status!.reachable ? "已连接" : "上游暂不可达"}</span>
          <button type="button" className={`ml-auto ${BTN_GHOST_SM}`} onClick={() => setKeyOpen(true)}>
            社区 Key
          </button>
          <button type="button" className={BTN_GHOST_SM} onClick={() => setReloadStatusTick((n) => n + 1)}>
            刷新
          </button>
        </div>
        <p className={`mt-1 ${HINT}`}>
          技能来自第三方社区，内容是指令文本；和鸣不执行随技能下发的代码，安装后默认不分配给任何智能体。
          {!status!.reachable ? " 上游暂不可达，列表可能来自缓存。" : ""}
        </p>
      </div>

      {/* d.110：已装社区技能聚合 + 全部更新（只更新社区来源的同 id 技能） */}
      <div className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-white p-2.5">
        <span role="status" className="ui-body-sm">
          已装 {installedCommunity.length} 个社区技能 · {communityUpdates.length} 个可更新
        </span>
        {communityUpdates.length > 0 && (
          <button type="button" className={BTN_GHOST_SM} onClick={() => void openBulkUpdate()}>
            全部更新
          </button>
        )}
        {showGoAssign && (
          <button type="button" className={BTN_GHOST_SM} onClick={goAssign}>
            去技能区分配
          </button>
        )}
      </div>

      <div className="mb-2 flex flex-wrap items-center gap-2">
        <input
          aria-label="搜索社区技能"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜名称 / 描述 / 标签…"
          className="ui-input min-w-[200px] max-w-[320px] flex-1"
        />
        <label className={`flex items-center gap-1 ${HINT}`}>
          排序
          <select
            aria-label="社区排序"
            value={sort}
            onChange={(event) => setSort(event.target.value as SortKey)}
            className="ui-input h-7 text-[12px]"
          >
            <option value="downloads">下载量</option>
            <option value="stars">收藏</option>
            <option value="updated">最近更新</option>
          </select>
        </label>
        <span className="ui-caption">
          {filterActive ? `匹配 ${list.items.length} / 共 ${list.total} 个` : `共 ${list.total} 个技能`}
        </span>
      </div>

      {categories.length > 0 && (
        <div role="group" aria-label="社区分类" className="mb-2 flex flex-wrap gap-1">
          <button
            type="button"
            aria-pressed={category === ""}
            onClick={() => setCategory("")}
            className={`ui-btn ui-btn-sm ${category === "" ? "ui-btn-primary" : "ui-btn-ghost text-muted"}`}
          >
            全部分类
          </button>
          {categories.map((item) => (
            <button
              key={item}
              type="button"
              aria-pressed={category === item}
              onClick={() => setCategory(category === item ? "" : item)}
              className={`ui-btn ui-btn-sm ${category === item ? "ui-btn-primary" : "ui-btn-ghost text-muted"}`}
            >
              {item}
            </button>
          ))}
        </div>
      )}

      {msg && (
        <p role="status" className={`mb-2 ${msg.kind === "error" ? ERROR_TEXT : HINT}`}>
          {msg.text}
        </p>
      )}

      {list.error ? (
        <div className="rounded-lg border border-[var(--danger-line)] bg-[var(--danger-soft)] p-3">
          <p role="alert" className={ERROR_TEXT}>社区技能列表加载失败：{list.error}</p>
          <button type="button" className="ui-link mt-1" onClick={() => setListRetryTick((n) => n + 1)}>
            重试
          </button>
        </div>
      ) : list.loading && list.items.length === 0 ? (
        <p role="status" className={HINT}>正在读取社区技能…</p>
      ) : list.items.length === 0 ? (
        <EmptyState
          title={filterActive ? "没有匹配的社区技能" : "社区里还没有技能"}
          desc={filterActive ? "换个关键词或分类试试。" : "等社区发布技能后再来看看。"}
          actions={
            filterActive ? (
              <button
                type="button"
                className={BTN_GHOST_SM}
                onClick={() => {
                  setQuery("");
                  setCategory("");
                }}
              >
                清除筛选
              </button>
            ) : undefined
          }
        />
      ) : (
        <>
          <ul className="grid gap-3 sm:grid-cols-2">
            {list.items.map((item) => {
              const installed = installedByHubId.get(item.id);
              const hasUpdate = Boolean(installed && item.version && installed.community?.version !== item.version);
              return (
                <li key={item.id} className="ui-card flex min-w-0 flex-col gap-2 p-3">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate text-[13px] font-bold">{item.name}</span>
                    <span className={CHIP}>v{item.version || "—"}</span>
                    {item.status === "official" && <span className={CHIP}>官方</span>}
                    {item.status === "trial" && <span className={CHIP}>试用</span>}
                    {installed && <span className={CHIP}>已安装</span>}
                    {hasUpdate && <span className={CHIP}>有新版本</span>}
                    {item.requiresApiKey && <span className={CHIP}>需自备 Key</span>}
                  </div>
                  <div className={`${HINT}`}>
                    {item.ownerName || "未知作者"} · 更新于 {formatDate(item.updatedAt)}
                  </div>
                  <p className="line-clamp-2 text-[12px] leading-5 text-muted">
                    {item.description || "暂无描述"}
                  </p>
                  <div className="flex flex-wrap items-center gap-1 ui-micro">
                    {item.categories.map((cat) => (
                      <span key={`cat:${cat}`} className={CHIP}>{cat}</span>
                    ))}
                    <span className={CHIP}>下载 {formatCount(item.downloads)}</span>
                    <span className={CHIP}>收藏 {formatCount(item.stars)}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      className={`ml-auto ${BTN_GHOST_SM}`}
                      aria-label={`查看 ${item.name} 详情`}
                      onClick={() => setDetailSkill(item)}
                    >
                      详情
                    </button>
                    <button
                      type="button"
                      className="ui-btn ui-btn-sm ui-btn-primary"
                      disabled={busyId === item.id}
                      onClick={() =>
                        void startInstall({
                          id: item.id,
                          name: item.name,
                          version: item.version,
                          author: item.ownerName,
                        })
                      }
                    >
                      {busyId === item.id ? "处理中…" : installed ? "重新安装" : "安装"}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
          {list.hasMore && (
            <div className="mt-3 flex justify-center">
              <button type="button" className={BTN_GHOST_SM} disabled={list.loading} onClick={() => setPage((n) => n + 1)}>
                {list.loading ? "加载中…" : "加载更多"}
              </button>
            </div>
          )}
        </>
      )}

      {detailSkill && (
        <HubDetailDialog
          skill={detailSkill}
          deps={deps}
          installed={installedByHubId.get(detailSkill.id)}
          onClose={() => setDetailSkill(null)}
          onInstall={(detail) => {
            void startInstall({
              id: detail.id,
              name: detail.name,
              version: detail.version,
              author: detail.ownerName,
              ...(safeExternalUrl(detail.homepage) ? { homepage: safeExternalUrl(detail.homepage) as string } : {}),
            });
          }}
        />
      )}

      {keyOpen && status && (
        <KeyDialog
          status={status}
          keyInfo={keyInfo}
          deps={deps}
          onClose={() => {
            setKeyOpen(false);
            setPending(null);
            setPendingBulk(false);
          }}
          onSaved={() => {
            refreshKey();
            const wantsBulk = pendingBulk;
            const wantedInstall = pending;
            setPending(null);
            setPendingBulk(false);
            if (wantsBulk || wantedInstall) setKeyOpen(false);
            void readHubKeyState().then((state) => {
              if (state.kind !== "encrypted" && state.kind !== "plain") return;
              if (wantsBulk) {
                setBulkOpen(true);
                void runBulkUpdate(state.key, bulkRows);
              } else if (wantedInstall) {
                runDownload(wantedInstall.target, state.key).catch((err: unknown) =>
                  setMsg({ kind: "error", text: errorText(err) }),
                );
              }
            });
          }}
        />
      )}

      {preview && (
        <InstallPreviewDialog preview={preview} onConfirm={confirmInstall} onCancel={() => setPreview(null)} />
      )}

      {bulkOpen && (
        <BulkUpdateDialog
          rows={bulkRows}
          running={bulkRunning}
          results={bulkResults}
          done={bulkDone}
          onConfirm={() => {
            void (async () => {
              const state = keyInfo ?? (await readHubKeyState());
              setKeyInfo(state);
              if (state.kind !== "encrypted" && state.kind !== "plain") {
                setBulkOpen(false);
                setPendingBulk(true);
                setKeyOpen(true);
                return;
              }
              await runBulkUpdate(state.key, bulkRows);
            })();
          }}
          onClose={() => {
            setBulkOpen(false);
            setBulkDone(false);
            setBulkResults([]);
            setBulkRows([]);
          }}
          onGoAssign={goAssign}
        />
      )}
    </section>
  );
}
