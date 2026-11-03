import { useEffect, useRef, useState } from "react";
import { useAuthStore } from "../store/auth.js";
import { UserIcon } from "./icons.js";
import { LlmSettingsCard } from "./LlmSettingsCard.js";
import { RouteGroupsCard } from "./RouteGroupsCard.js";
import { KeyStorageCard } from "./KeyStorageCard.js";
import { ContextSettingsCard } from "./ContextSettingsCard.js";
import { FileEditCard } from "./FileEditCard.js";
import { HitlPolicyCard } from "./HitlPolicyCard.js";
import { StorageUsageCard } from "./StorageUsageCard.js";
import { PetSettingsCard } from "./PetSettingsCard.js";
import { ThemeModeCard } from "./settings/ThemeModeCard.js";
import { useUiStore, type NavPage } from "../store/ui.js";
import { useThemeStore, ACCENT_PRESETS } from "../store/theme.js";
import { CHANGELOG, logOpenState, parseInline, stripInline, toggleLog } from "../lib/changelog.js";
import { UpdateCard } from "./UpdateCard.js";
import {
  matchSettingsCards,
  sectionLabelOf,
  settingsCardById,
  type SettingsCardMeta,
} from "../lib/settings/registry.js";
import { FOCUS_RING } from "../lib/a11y/focus.js";
import { PageShell } from "./layout/PageShell.js";

/**
 * 头像文件上限：449_000 字节 → base64 data URL 约 598_700 字符，
 * 低于服务端 UpdateProfileBodySchema.avatar 上限（600_000 字符）；
 * 若取 450_000 字节，base64 后恰为 600_000 字符再加 data: 前缀必超边界，
 * 449_000 留出安全窗（评审遗留修正）。
 */
const MAX_AVATAR_BYTES = 449_000;

const btnGhost =
  "ui-btn ui-btn-sm ui-btn-ghost";

/** 设置卡统一的生效说明：与 LLM 连接卡、工具调用确认卡同一句。 */
const EFFECT_NOTE = "改动即时生效，仅作用于本机，无需重启。";

/** 行内标记渲染：`**粗体**` 加粗、`` `代码` `` 等宽（无 markdown 依赖）。 */
function InlineText({ text }: { text: string }) {
  return (
    <>
      {parseInline(text).map((seg, i) =>
        seg.kind === "bold" ? (
          <strong key={i} className="font-bold text-ink">
            {seg.text}
          </strong>
        ) : seg.kind === "code" ? (
          <code key={i} className="rounded-sm bg-[#f2f2f2] px-1 font-mono text-[11px]">
            {seg.text}
          </code>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </>
  );
}

/** 导航页中文名（排序卡片与校验共用，与 NavRail 的 aria-label 保持一致）。 */
const NAV_LABELS: Record<NavPage, string> = {
  home: "主页",
  team: "团队",
  chat: "智能体",
  staff: "幕僚",
  infohub: "信息中枢",
  automations: "自动化",
  plugins: "插件区",
  memory: "记忆区",
  settings: "设置区",
};

/**
 * 应用版本：桌面端由 preload 注入 5 段版本（d.特性.破坏性.修订.构建）。
 *
 * 拿不到时显示「桌面版」而不是「网页版」：和鸣只面向桌面安装版，
 * 浏览器环境属于异常情况（web 界面只作为安装包内的前端被加载），
 * 不该在这里暗示用户还能用网页版。
 */
export function appVersionLabel(): string {
  const v = typeof window !== "undefined" ? window.__heming_version : undefined;
  return v && v.trim() ? v.trim() : "桌面版";
}

/** 设置区分组标签（用户要求：改为上侧横向标签页，点击切换）。 */
const SETTINGS_TABS = [
  { id: "profile", label: "个人资料" },
  { id: "model", label: "模型" },
  { id: "appearance", label: "外观" },
  { id: "navigation", label: "导航" },
  { id: "about", label: "关于" },
] as const;

type SettingsTabId = (typeof SETTINGS_TABS)[number]["id"];

/** 搜索命中后的高亮时长（规格 §2.E：2 秒淡出；用既有 ink 描边，不新增配色）。 */
export const SETTINGS_HIGHLIGHT_MS = 2_000;

/** 卡片锚点的通用样式：高亮时给一圈 ink 描边，2 秒后自动消失。 */
function anchorClass(highlighted: boolean): string {
  return `rounded-xl transition-shadow ${
    highlighted ? "outline outline-2 outline-offset-2 outline-ink" : ""
  }`;
}

/** 只认已知分组：外部投递来的字符串可能是旧版本残留或拼错，不能直接喂给 setTab。 */
function isSettingsTabId(value: unknown): value is SettingsTabId {
  return typeof value === "string" && SETTINGS_TABS.some((t) => t.id === value);
}

/** 设置区 · 个人资料：头像（data URL）与昵称，保存走 PUT /api/me。 */
export function SettingsPage() {
  const settingsTab = useUiStore((s) => s.settingsTab);
  const consumeSettingsTab = useUiStore((s) => s.consumeSettingsTab);
  const [tab, setTab] = useState<SettingsTabId>(
    isSettingsTabId(settingsTab) ? settingsTab : "profile",
  );
  /** 卡片内搜索（UX-E）：空查询 = 普通分区视图；有内容 = 跨分区结果面板。 */
  const [query, setQuery] = useState("");
  /** 命中后要滚动/高亮的卡片 id（滚动完立刻消费，避免下次进设置页又被拽走）。 */
  const [focusTarget, setFocusTarget] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const highlightTimer = useRef<number | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const results = matchSettingsCards(query);

  // 外部请求直达某个分组（桌宠未配置模型时点「去设置」）：消费后立刻清空，
  // 否则下次手动进设置页会被这个残留值拽回同一个分组。
  useEffect(() => {
    if (!settingsTab) return;
    if (isSettingsTabId(settingsTab)) setTab(settingsTab);
    consumeSettingsTab();
  }, [settingsTab, consumeSettingsTab]);

  // 点搜索结果：切分组 → 等那一帧渲染完 → 滚动到卡片 + 高亮 2 秒。
  useEffect(() => {
    if (!focusTarget) return;
    let cancelled = false;
    const raf = window.requestAnimationFrame(() => {
      if (cancelled) return;
      const el = document.querySelector<HTMLElement>(`[data-settings-id="${focusTarget}"]`);
      // jsdom 没有 scrollIntoView：可选调用，测试里由用例自己打桩断言
      el?.scrollIntoView?.({ block: "center", behavior: "smooth" });
      setHighlightId(focusTarget);
      if (highlightTimer.current !== null) window.clearTimeout(highlightTimer.current);
      highlightTimer.current = window.setTimeout(() => {
        highlightTimer.current = null;
        setHighlightId(null);
      }, SETTINGS_HIGHLIGHT_MS);
      setFocusTarget(null); // 消费掉，防重放
    });
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(raf);
    };
  }, [focusTarget]);

  // Esc：关掉结果面板并清空输入（只在搜索态监听，普通视图不抢 Esc）
  useEffect(() => {
    if (!query.trim()) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setQuery("");
      searchRef.current?.focus();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [query]);

  useEffect(
    () => () => {
      if (highlightTimer.current !== null) window.clearTimeout(highlightTimer.current);
    },
    [],
  );

  /** 跳到某张卡片：清空查询、切分组、把滚动/高亮交给上面的 effect。 */
  const jumpToCard = (card: SettingsCardMeta) => {
    setQuery("");
    setTab(card.section);
    setFocusTarget(card.id);
  };

  const searching = query.trim().length > 0;

  return (
    <PageShell
      scroll={false}
      title="设置区"
      subtitle="改动即时生效，仅作用于本机，无需重启。"
      headerExtra={
        <div className="px-6 pb-3 pt-3">
          {/* 横向标签栏：选中项白底、选中线压在下边框上（与内容区连成一体） */}
          <div className="flex gap-1" role="tablist" aria-label="设置分组">
            {SETTINGS_TABS.map((t) => {
              const active = t.id === tab;
              return (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => {
                    setTab(t.id);
                    // 手动切分组 = 结束这次搜索（回到普通分区视图）
                    setQuery("");
                  }}
                  className={`-mb-px border-b-2 px-3.5 py-2 text-[13px] transition-colors ${
                    active
                      ? "border-b-ink font-semibold text-ink"
                      : "border-b-transparent text-muted hover:text-ink"
                  }`}
                >
                  {t.label}
                </button>
              );
            })}
          </div>
          {/* 卡片内搜索：跨 5 个分区按「标题 + 关键词 + 分区名」匹配 */}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input
              ref={searchRef}
              type="search"
              aria-label="搜索设置项"
              placeholder="搜索设置项…（如 主题色 / 免问下限 / 桌宠）"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className={`w-full max-w-[420px] ui-input ${FOCUS_RING}`}
            />
            <span className="ui-caption">
              {searching ? `${results.length} 项匹配 · Esc 关闭` : "按标题、关键词或分区名搜索"}
            </span>
          </div>
        </div>
      }
    >
      {/* 内容区：一次只渲染当前分组，切换时不保留上一次的输入态（草稿本就一次性保存） */}
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="w-full max-w-[720px]">
          {searching ? (
            <section aria-label="设置搜索结果">
              {results.length === 0 ? (
                <p className="ui-body-sm text-muted">
                  没有匹配的设置项。换个说法试试（如「主题色」「免问」「桌宠」「更新」）。
                </p>
              ) : (
                <>
                  <p role="status" className="ui-caption">
                    找到 {results.length} 项，点击定位到卡片
                  </p>
                  <ul className="mt-2 flex flex-col gap-2">
                    {results.map((card) => (
                      <li key={card.id}>
                        <button
                          type="button"
                          onClick={() => jumpToCard(card)}
                          className={`flex w-full items-center gap-2 rounded-lg border border-line-soft bg-white px-3 py-2 text-left ui-body-sm hover:border-line hover:bg-[#fafafa] ${FOCUS_RING}`}
                        >
                          <span className="min-w-0 flex-1 truncate">
                            {settingsCardById(card.id)?.title ?? card.title}
                          </span>
                          <span className="shrink-0 ui-caption">
                            · {sectionLabelOf(card.section)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>
          ) : (
          <>
            {tab === "profile" && (
              <div data-settings-id="profile" className={anchorClass(highlightId === "profile")}>
                <ProfileSection />
              </div>
            )}
            {tab === "model" && (
              <>
                <div
                  data-settings-id="llm-connection"
                  className={anchorClass(highlightId === "llm-connection")}
                >
                  <LlmSettingsCard />
                </div>
                {/* 候选链紧跟连接列表：先有连接，才谈得上把它们串成一条 failover 链 */}
                <div
                  data-settings-id="route-groups"
                  className={anchorClass(highlightId === "route-groups")}
                >
                  <RouteGroupsCard />
                </div>
                <div
                  data-settings-id="key-storage"
                  className={anchorClass(highlightId === "key-storage")}
                >
                  <KeyStorageCard />
                </div>
                <div
                  data-settings-id="context-budget"
                  className={anchorClass(highlightId === "context-budget")}
                >
                  <ContextSettingsCard />
                </div>
                {/* 工具调用确认（安全设置）：与模型设置同组——两者都是「生成行为」的边界 */}
                <div
                  data-settings-id="hitl-policy"
                  className={anchorClass(highlightId === "hitl-policy")}
                >
                  <HitlPolicyCard />
                </div>
                {/* 文件编辑：可写根是「智能体能改哪些文件」的唯一开关，
                    紧跟在工具调用确认之后——两者一起构成本机的写操作边界。 */}
                <div
                  data-settings-id="file-edit"
                  className={anchorClass(highlightId === "file-edit")}
                >
                  <FileEditCard />
                </div>
                {/* 本机存储水位：紧跟在安全设置之后——两者都是「本机的边界」，
                    一条管「智能体会做什么」，一条管「本机还剩多少空间」。 */}
                <div
                  data-settings-id="storage-usage"
                  className={anchorClass(highlightId === "storage-usage")}
                >
                  <StorageUsageCard />
                </div>
              </>
            )}
            {tab === "appearance" && (
              <>
                <div
                  data-settings-id="accent-color"
                  className={anchorClass(highlightId === "accent-color")}
                >
                  <AppearanceSection />
                </div>
                {/* d.67 T3：主题模式（浅色/深色/跟随系统）与主题色并列，互不影响。 */}
                <div data-settings-id="theme-mode" className={anchorClass(highlightId === "theme-mode")}>
                  <ThemeModeCard />
                </div>
                <div data-settings-id="pet" className={anchorClass(highlightId === "pet")}>
                  <PetSettingsCard />
                </div>
              </>
            )}
            {tab === "navigation" && (
              <div data-settings-id="nav-order" className={anchorClass(highlightId === "nav-order")}>
                <NavigationSection />
              </div>
            )}
            {tab === "about" && <AboutSection highlightedId={highlightId} />}
            <p className="pt-1 ui-caption">和鸣 {appVersionLabel()}</p>
          </>
        )}
        </div>
      </div>
    </PageShell>
  );
}

/** 个人资料分组：头像 + 昵称 + 保存。 */
function ProfileSection() {
  const user = useAuthStore((s) => s.user);
  const updateProfile = useAuthStore((s) => s.updateProfile);

  const [displayName, setDisplayName] = useState(user?.displayName ?? "");
  const [avatar, setAvatar] = useState<string | undefined>(user?.avatar);
  const [fileError, setFileError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const onPickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setSaved(false); // 选文件视为编辑，复位「已保存」（与昵称 onChange 行为一致）
    setFileError(null);
    if (!file.type.startsWith("image/")) {
      setFileError("请选择图片文件");
      return;
    }
    if (file.size > MAX_AVATAR_BYTES) {
      setFileError("头像不能超过约 449KB");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setAvatar(String(reader.result));
    reader.onerror = () => setFileError("读取图片失败，请重试");
    reader.readAsDataURL(file);
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaved(false);
    setError(null);
    setSaving(true);
    try {
      await updateProfile(displayName, avatar);
      setSaved(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="max-w-full rounded-xl border border-line bg-white p-4 shadow-card">
      <div className="ui-section-title">个人资料</div>

      <div className="mt-3 flex items-center gap-4">
        <span className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[#f0f0f0] text-muted">
          {avatar ? (
            <img src={avatar} alt="当前头像" className="h-full w-full object-cover" />
          ) : (
            <UserIcon width={22} height={22} />
          )}
        </span>
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
        {fileError && <span className="text-[12px] text-red-600">{fileError}</span>}
      </div>

      {avatar && (
        <button
          type="button"
          aria-label="恢复默认头像"
          onClick={() => {
            setAvatar(undefined);
            setSaved(false);
          }}
          className="mt-2 rounded-lg border border-line px-3 py-1 text-[12px] shadow-card hover:bg-[#fafafa]"
        >
          恢复默认头像
        </button>
      )}

      <form onSubmit={save} className="mt-4 flex flex-col gap-3">
        <label className="ui-caption">
          昵称
          <input
            value={displayName}
            maxLength={64}
            onChange={(e) => {
              setDisplayName(e.target.value);
              setSaved(false);
            }}
            className="mt-1 block w-full ui-input"
          />
        </label>
        {error && <div className="text-[12px] text-red-600">{error}</div>}
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={saving}
            className="ui-btn ui-btn-md ui-btn-primary"
          >
            {saving ? "保存中…" : "保存"}
          </button>
          {saved && (
            <span role="status" className="ui-caption">
              已保存
            </span>
          )}
        </div>
      </form>

      <div className="mt-3 border-t border-line-soft pt-2 ui-caption">
        {EFFECT_NOTE}
      </div>
    </section>
  );
}

/** 外观分组：页面颜色（预设色板 + 自定义十六进制；只驱动填充色，正文保持墨色）。 */
function AppearanceSection() {
  const accent = useThemeStore((t) => t.accent);
  const setAccent = useThemeStore((t) => t.setAccent);
  const resetAccent = useThemeStore((t) => t.resetAccent);
  const [accentError, setAccentError] = useState<string | null>(null);
  // 受控输入：值以 store 为准做本地镜像。此前用 defaultValue + 受控外写，
  // 保存后输入框会回退到旧值（闭包里的 accent 还没更新），恢复默认也不刷新。
  const [custom, setCustom] = useState(accent);
  const [applied, setApplied] = useState(false);

  useEffect(() => {
    setCustom(accent);
  }, [accent]);

  const applyCustom = (raw: string) => {
    const value = raw.trim();
    if (!value) {
      setCustom(accent);
      return;
    }
    if (!setAccent(value)) {
      setAccentError("请输入十六进制色，如 #2f5bd7");
      return;
    }
    setAccentError(null);
    setApplied(true);
  };

  return (
    <section
      aria-label="页面颜色"
      className="max-w-full rounded-xl border border-line bg-white p-4 shadow-card"
    >
      <div className="flex items-center gap-2">
        <span className="ui-section-title">页面颜色</span>
        {applied && (
          <span role="status" className="ui-caption">
            已生效
          </span>
        )}
      </div>
      <div className="mt-1 ui-caption">
        作用于选中项、主按钮等填充色；文字颜色不变，保证长文可读
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {ACCENT_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            aria-label={`主题色 ${p.name}`}
            aria-pressed={accent === p.color}
            title={p.name}
            onClick={() => {
              setAccent(p.color);
              setAccentError(null);
              setApplied(true);
            }}
            className={`h-6 w-6 rounded-full border border-black/10 shadow-card ${
              accent === p.color ? "ring-2 ring-offset-2 ring-[#1a1a1a]" : ""
            }`}
            style={{ backgroundColor: p.color }}
          />
        ))}
        <label className="flex items-center gap-1 ui-caption">
          自定义
          <input
            aria-label="自定义主题色"
            value={custom}
            placeholder="#2f5bd7"
            onChange={(e) => {
              setCustom(e.target.value);
              setAccentError(null);
            }}
            onBlur={(e) => applyCustom(e.target.value)}
            className="w-[92px] ui-input"
          />
        </label>
        <button
          type="button"
          aria-label="恢复默认颜色"
          onClick={() => {
            resetAccent();
            setAccentError(null);
            setApplied(true);
          }}
          className={btnGhost}
        >
          恢复默认
        </button>
      </div>
      {accentError && <div className="mt-2 text-[12px] text-red-600">{accentError}</div>}
      <div className="mt-3 border-t border-line-soft pt-2 ui-caption">
        {EFFECT_NOTE}
      </div>
    </section>
  );
}

/** 导航分组：左侧导航显示顺序（上移/下移，不做拖拽——按钮在键盘与触屏下都可靠）。 */
function NavigationSection() {
  const navOrder = useUiStore((u) => u.navOrder);
  const moveNav = useUiStore((u) => u.moveNav);
  const resetNavOrder = useUiStore((u) => u.resetNavOrder);

  return (
    <section
      aria-label="导航顺序"
      className="max-w-full rounded-xl border border-line bg-white p-4 shadow-card"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="ui-section-title">导航顺序</div>
        <button type="button" aria-label="恢复默认导航顺序" onClick={resetNavOrder} className={btnGhost}>
          恢复默认
        </button>
      </div>
      <div className="mt-1 ui-caption">
        只改左侧导航的显示顺序，Alt+1–9 快捷键保持原位
      </div>
      <ul className="mt-2 flex flex-col gap-1">
        {navOrder.map((page, index) => (
          <li
            key={page}
            className="flex items-center gap-2 rounded-lg border border-line-soft px-2 py-1.5"
          >
            <span className="w-[18px] ui-caption">{index + 1}</span>
            <span className="flex-1 text-[12px]">{NAV_LABELS[page]}</span>
            <button
              type="button"
              aria-label={`上移 ${NAV_LABELS[page]}`}
              disabled={index === 0}
              onClick={() => moveNav(page, -1)}
              className={`${btnGhost} px-2 py-0.5 disabled:opacity-35`}
            >
              上移
            </button>
            <button
              type="button"
              aria-label={`下移 ${NAV_LABELS[page]}`}
              disabled={index === navOrder.length - 1}
              onClick={() => moveNav(page, 1)}
              className={`${btnGhost} px-2 py-0.5 disabled:opacity-35`}
            >
              下移
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** 关于分组：软件更新（仅安装版有桥，桥缺失时整卡不渲染）+ 更新日志。 */
function AboutSection({ highlightedId }: { highlightedId: string | null }) {
  const [logState, setLogState] = useState<Record<string, boolean>>({});

  return (
    <div className="flex max-w-full flex-col gap-3">
      <div data-settings-id="update" className={anchorClass(highlightedId === "update")}>
        <UpdateCard currentVersion={appVersionLabel()} />
      </div>

      <div data-settings-id="changelog" className={anchorClass(highlightedId === "changelog")}>
        <section
          aria-label="更新日志"
          className="max-w-full rounded-xl border border-line bg-white p-4 shadow-card"
        >
      <div className="flex items-center justify-between gap-3">
        <div className="ui-section-title">更新日志</div>
        <span className="ui-caption">当前 {appVersionLabel()}</span>
      </div>
      <div className="mt-1 ui-caption">
        来自仓库 CHANGELOG.md，随版本自动生成；点击任一条目展开/收起
      </div>
      <ul className="mt-2 flex flex-col gap-1">
        {CHANGELOG.map((entry) => {
          const isCurrent = entry.version === appVersionLabel();
          const open = logOpenState(logState, entry.version, isCurrent);
          return (
            <li key={entry.version} className="rounded-lg border border-line-soft">
              <button
                type="button"
                aria-expanded={open}
                aria-label={`更新日志 ${entry.version}`}
                onClick={() => setLogState((prev) => toggleLog(prev, entry.version, isCurrent))}
                className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-[#fafafa]"
              >
                <span className="text-[12px] font-bold">{entry.version}</span>
                {isCurrent && (
                  <span className="rounded-full border border-line px-1.5 text-[10px] text-muted">
                    当前
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate ui-caption">
                  {stripInline(entry.title) || entry.date}
                </span>
                <span className="shrink-0 ui-caption">{open ? "收起" : "展开"}</span>
              </button>
              {open && (
                <div className="border-t border-line-soft px-3 py-2">
                  <div className="ui-caption">{entry.date}</div>
                  {entry.title && (
                    <div className="mt-0.5 text-[12px] font-medium">
                      <InlineText text={entry.title} />
                    </div>
                  )}
                  {entry.paragraphs.map((line, i) => (
                    <p key={i} className="mt-1 text-[12px] leading-relaxed text-muted">
                      <InlineText text={line} />
                    </p>
                  ))}
                  {entry.bullets.length > 0 && (
                    <ul className="mt-1.5 flex flex-col gap-1">
                      {entry.bullets.map((line, i) => (
                        <li key={i} className="flex gap-1.5 text-[12px] leading-relaxed">
                          <span className="text-muted">·</span>
                          <span className="min-w-0 flex-1">
                            <InlineText text={line} />
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
        </section>
      </div>
    </div>
  );
}
