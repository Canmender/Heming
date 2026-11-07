import { useEffect, useRef, useState } from "react";
import { useAuthStore } from "../store/auth.js";
import { UserIcon } from "./icons.js";
import { LlmSettingsCard } from "./LlmSettingsCard.js";
import { KeyStorageCard } from "./KeyStorageCard.js";
import { ContextSettingsCard } from "./ContextSettingsCard.js";
import { FileEditCard } from "./FileEditCard.js";
import { HitlPolicyCard } from "./HitlPolicyCard.js";
import { StorageUsageCard } from "./StorageUsageCard.js";
import { PetSettingsCard } from "./PetSettingsCard.js";
import { ThemeModeCard } from "./settings/ThemeModeCard.js";
import { normalizeNavOrder, useUiStore, type NavPage } from "../store/ui.js";
import { useModuleStore } from "../lib/modules/store.js";
import { filterNavOrder } from "../lib/modules/nav.js";
import { useThemeStore, ACCENT_PRESETS } from "../store/theme.js";
import { setThemeMode, watchThemeMode } from "../lib/theme.js";
import { DEFAULT_NAV_MODE, type NavMode } from "../lib/navPrefs.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import {
  CHANGELOG,
  logOpenState,
  parseInline,
  stripInline,
  toggleLog,
  userNotesFor,
} from "../lib/changelog.js";
import { UpdateCard } from "./UpdateCard.js";
import {
  matchSettingsCards,
  sectionLabelOf,
  settingsCardById,
  type SettingsCardMeta,
} from "../lib/settings/registry.js";
import { FOCUS_RING } from "../lib/a11y/focus.js";
import { PageShell } from "./layout/PageShell.js";
import { PAGE_TABLIST, pageTabClass } from "../lib/ui/tabStyles.js";
import { NAV_GROUP_LABEL, navGroupOf } from "../lib/navGroups.js";

/**
 * 头像文件上限：449_000 字节 → base64 data URL 约 598_700 字符，
 * 低于服务端 UpdateProfileBodySchema.avatar 上限（600_000 字符）；
 * 若取 450_000 字节，base64 后恰为 600_000 字符再加 data: 前缀必超边界，
 * 449_000 留出安全窗（评审遗留修正）。
 */
const MAX_AVATAR_BYTES = 449_000;

const btnGhost =
  "ui-btn ui-btn-sm ui-btn-ghost";

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
  modelroute: "模型路由",
  plugins: "插件区",
  memory: "记忆区",
  settings: "设置区",
};

/**
 * 应用版本：桌面端由 preload 注入 5 段版本（d.特性.破坏性.修订.构建）。
 *
 * 拿不到注入值时回落到构建期注入的 `__APP_VERSION__`（同一份 hemingVersion）：
 * 云端网页与桌面端共用这份前端产物，浏览器里显示真实版本号比显示「桌面版」有用——
 * 用户能据此判断「看到的是哪一版」，也便于报障时对照。
 */
export function appVersionLabel(): string {
  const v = typeof window !== "undefined" ? window.__heming_version : undefined;
  if (v && v.trim()) return v.trim();
  return typeof __APP_VERSION__ === "string" && __APP_VERSION__.trim() ? __APP_VERSION__.trim() : "—";
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
      subtitle="改完立即生效，只影响本机，不用重启。"
      headerExtra={
        <div className="px-6 pb-3 pt-3 max-[1199px]:px-4">
          {/* d.72：标签栏与搜索框跟正文同列居中。之前正文固定 720px 贴左，
              宽屏（1600）右侧空出半屏，看起来像页面没铺满。 */}
          <div className="mx-auto w-full max-w-[760px]">
          {/* 横向标签栏：选中项白底、选中线压在下边框上（与内容区连成一体） */}
          <div className={PAGE_TABLIST} role="tablist" aria-label="设置分组">
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
                  className={pageTabClass(active)}
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
              onKeyDown={(e) => {
                // d.77（R10）：搜完直接回车打开第一项，不用再把鼠标挪到列表上。
                if (e.key === "Enter" && results.length > 0) {
                  e.preventDefault();
                  jumpToCard(results[0]);
                }
              }}
              className={`w-full max-w-[420px] ui-input ${FOCUS_RING}`}
            />
            <span className="ui-caption">
              {searching
                ? `${results.length} 项匹配 · Enter 打开${results.length > 0 ? "第一项" : ""} · Esc 关闭`
                : "按标题、关键词或分区名搜索"}
            </span>
          </div>
          </div>
        </div>
      }
    >
      {/* 内容区：一次只渲染当前分组，切换时不保留上一次的输入态（草稿本就一次性保存） */}
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 max-[1199px]:px-4">
        <div className="mx-auto w-full max-w-[760px]">
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
                {/* 候选链已搬到「模型路由」页（d.84 模块）：这里只留入口，
                    免得同一个编辑器在设置区与模块页各渲染一份、口径漂移。 */}
                <div
                  data-settings-id="route-groups"
                  className={anchorClass(highlightId === "route-groups")}
                >
                  <section className="mt-3 rounded-xl border border-line bg-white p-4 shadow-card">
                    <div className="text-[12px] font-bold text-muted">模型路由</div>
                    <p className="mt-1 ui-caption">
                      候选链与选路策略已移到导航里的「模型路由」页；连接（Key / Base URL / 模型）仍在这里管理。
                    </p>
                    <button
                      type="button"
                      className="ui-btn ui-btn-sm ui-btn-ghost mt-2"
                      onClick={() => useUiStore.getState().setPage("modelroute")}
                    >
                      打开模型路由
                    </button>
                  </section>
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
            {tab === "appearance" && <AppearanceTab highlightedId={highlightId} />}
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
        {error && <div role="alert" className="text-[12px] text-red-600">{error}</div>}
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

    </section>
  );
}

/**
 * 外观分组（d.68 顺序）：主题模式 → 主题色 → 导航栏 → 桌宠 + 恢复默认外观。
 *
 * 为什么顺序要改：主题模式决定「亮/暗」，是最粗的一层；主题色只改填充强调色；
 * 导航栏与桌宠是局部外观偏好。从粗到细看下来，用户不用来回跳。
 *
 * 「恢复默认外观」用既有 ConfirmDialog 二次确认：它一次改三处（主题模式/主题色/导航），
 * 误点的代价比单张卡片的「恢复默认」大，值得多问一句。
 */
function AppearanceTab({ highlightedId }: { highlightedId: string | null }) {
  const resetAccent = useThemeStore((t) => t.resetAccent);
  const [confirmReset, setConfirmReset] = useState(false);
  // 主题模式卡的模式是卡内 local state（外部重置后不会自己刷新），用 key 重挂载一次
  const [themeModeKey, setThemeModeKey] = useState(0);

  const resetAppearance = () => {
    resetAccent(); // 主题色 → 默认墨色
    setThemeMode("system"); // 主题模式 → 跟随系统
    watchThemeMode({ accent: useThemeStore.getState().accent }); // 立即应用（摘旧挂新系统监听）
    useUiStore.getState().setNavMode(DEFAULT_NAV_MODE); // 导航 → 固定常显
    setThemeModeKey((k) => k + 1);
    setConfirmReset(false);
  };

  return (
    <>
      {/* d.67 T3：主题模式（浅色/深色/跟随系统）排在最前，它决定整套配色 */}
      <div data-settings-id="theme-mode" className={anchorClass(highlightedId === "theme-mode")}>
        <ThemeModeCard key={themeModeKey} />
      </div>
      <div
        data-settings-id="accent-color"
        className={anchorClass(highlightedId === "accent-color")}
      >
        <AppearanceSection />
      </div>
      {/* d.68：导航栏显示方式（常显 / 自动隐藏），与导航轨底部 pin 按钮同源 */}
      <div data-settings-id="nav-mode" className={anchorClass(highlightedId === "nav-mode")}>
        <NavModeSection />
      </div>
      <div data-settings-id="pet" className={anchorClass(highlightedId === "pet")}>
        <PetSettingsCard />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line-soft bg-subtle px-4 py-3">
        <div className="min-w-0">
          <div className="ui-body-sm font-medium">恢复默认外观</div>
          <div className="ui-caption">主题模式跟随系统、主题色墨黑、导航栏常显</div>
        </div>
        <button
          type="button"
          onClick={() => setConfirmReset(true)}
          className={btnGhost}
        >
          恢复默认外观
        </button>
      </div>

      {confirmReset && (
        <ConfirmDialog
          title="恢复默认外观"
          onCancel={() => setConfirmReset(false)}
          footer={
            <>
              <button
                type="button"
                onClick={() => setConfirmReset(false)}
                className="ui-btn ui-btn-md ui-btn-ghost"
              >
                取消
              </button>
              <button
                type="button"
                onClick={resetAppearance}
                className="ui-btn ui-btn-md ui-btn-primary"
              >
                恢复默认
              </button>
            </>
          }
        >
          <p className="ui-body">
            将把主题模式改为「跟随系统」、主题色恢复墨黑、导航栏恢复常显。桌宠与其它设置不受影响。
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}

/** 导航栏显示方式的两档（文案与 lib/navPrefs 的语义一一对应）。 */
const NAV_MODE_OPTIONS: { id: NavMode; label: string; hint: string }[] = [
  { id: "pinned", label: "固定常显", hint: "导航栏一直显示（默认，推荐）" },
  { id: "auto", label: "自动隐藏", hint: "左缘悬停或 Ctrl+B 呼出，Esc 收回" },
];

/**
 * 导航栏卡（d.68）：两档 radio + 一句话说明 + 恢复默认。
 *
 * 与导航轨底部的 pin 按钮读写同一个 store（`useUiStore.navMode`），
 * 所以「在导航轨上 pin 过」再进设置页，选中项就是对的——不存在两份偏好。
 */
function NavModeSection() {
  const navMode = useUiStore((s) => s.navMode);
  const setNavMode = useUiStore((s) => s.setNavMode);

  // 单选组键盘语义：←/↑ 上一档，→/↓ 下一档（与主题模式卡一致）
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const index = NAV_MODE_OPTIONS.findIndex((m) => m.id === navMode);
    let next = index;
    if (event.key === "ArrowRight" || event.key === "ArrowDown")
      next = (index + 1) % NAV_MODE_OPTIONS.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp")
      next = (index - 1 + NAV_MODE_OPTIONS.length) % NAV_MODE_OPTIONS.length;
    else return;
    event.preventDefault();
    setNavMode(NAV_MODE_OPTIONS[next].id);
  };

  return (
    <section aria-label="导航栏" className="max-w-full ui-card p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="ui-section-title">导航栏</div>
        <button
          type="button"
          aria-label="恢复默认导航栏模式"
          onClick={() => setNavMode(DEFAULT_NAV_MODE)}
          className={btnGhost}
        >
          恢复默认
        </button>
      </div>
      <div className="mt-1 ui-caption">
        自动隐藏时导航不占内容宽度：鼠标移到窗口左缘或按 Ctrl+B 呼出；移开 0.3 秒后自动收回，Esc 立即收回。
      </div>
      <div
        role="radiogroup"
        aria-label="导航栏显示方式"
        className="mt-2 grid gap-2 sm:grid-cols-2"
        onKeyDown={onKeyDown}
      >
        {NAV_MODE_OPTIONS.map((item) => {
          const checked = navMode === item.id;
          return (
            <button
              key={item.id}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={`导航栏 ${item.label}`}
              tabIndex={checked ? 0 : -1}
              onClick={() => setNavMode(item.id)}
              className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                checked ? "border-ink bg-subtle-2" : "border-line bg-surface hover:bg-subtle"
              }`}
            >
              <span className="block ui-body-sm">{item.label}</span>
              <span className="mt-0.5 block ui-caption">{item.hint}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

/** 外观分组：主题色（预设色板 + 自定义十六进制；只驱动填充色，正文保持墨色）。 */
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
      aria-label="主题色"
      className="max-w-full rounded-xl border border-line bg-white p-4 shadow-card"
    >
      <div className="flex items-center gap-2">
        <span className="ui-section-title">主题色</span>
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
      {accentError && <div role="alert" className="mt-2 text-[12px] text-red-600">{accentError}</div>}
    </section>
  );
}

/** 导航分组：左侧导航显示顺序（上移/下移，不做拖拽——按钮在键盘与触屏下都可靠）。 */
function NavigationSection() {
  const fullOrder = normalizeNavOrder(useUiStore((u) => u.navOrder));
  const setNavOrder = useUiStore((u) => u.setNavOrder);
  const resetNavOrder = useUiStore((u) => u.resetNavOrder);
  const moduleEnabled = useModuleStore((u) => u.enabled);
  const moduleState = { enabled: moduleEnabled };
  // d.70：停用的内置模块页不在列表里出现；上下移动只在可见项之间交换，
  // 隐藏页占的位置不动（否则用户点一次「下移」看着没反应——实际是和隐藏页换了位）。
  const navOrder = filterNavOrder(fullOrder, moduleState);
  const move = (page: NavPage, dir: -1 | 1) => {
    const index = navOrder.indexOf(page);
    const target = index + dir;
    if (index < 0 || target < 0 || target >= navOrder.length) return;
    const nextVisible = [...navOrder];
    [nextVisible[index], nextVisible[target]] = [nextVisible[target], nextVisible[index]];
    let cursor = 0;
    const merged = fullOrder.map((item) =>
      navOrder.includes(item) ? nextVisible[cursor++] : item,
    );
    setNavOrder(merged);
  };

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
        只改左侧导航的显示顺序；数字快捷键仍对应原来的页面（Alt+1 / 2 / 5 / 6 / 8 / 0）。
        导航按「工作台 / 智能模块 / 资料与能力 / 系统」用细线分组，移动时细线跟着组变化走。
      </div>
      <ul className="mt-2 flex flex-col gap-1">
        {navOrder.map((page, index) => (
          <li
            key={page}
            className="flex items-center gap-2 rounded-lg border border-line-soft px-2 py-1.5"
          >
            <span className="w-[18px] ui-caption">{index + 1}</span>
            <span className="flex-1 text-[12px]">{NAV_LABELS[page]}</span>
            <span className="ui-micro shrink-0 text-muted">{NAV_GROUP_LABEL[navGroupOf(page)]}</span>
            <button
              type="button"
              aria-label={`上移 ${NAV_LABELS[page]}`}
              disabled={index === 0}
              onClick={() => move(page, -1)}
              className={`${btnGhost} px-2 py-0.5 disabled:opacity-35`}
            >
              上移
            </button>
            <button
              type="button"
              aria-label={`下移 ${NAV_LABELS[page]}`}
              disabled={index === navOrder.length - 1}
              onClick={() => move(page, 1)}
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

/** 更新日志默认只展开最近 N 个版本：111 条平铺是一面墙，用户只想看最近改了什么。 */
const RECENT_LOG_LIMIT = 20;

/** 关于分组：软件更新（仅安装版有桥；网页版给说明卡，不留空白高亮框）+ 更新日志。 */
function AboutSection({ highlightedId }: { highlightedId: string | null }) {
  const [logState, setLogState] = useState<Record<string, boolean>>({});
  const [showAllLogs, setShowAllLogs] = useState(false);
  // 桥在桌面安装版里由 preload 注入；网页版没有——按审计 P1-3，搜索命中后不能只剩空框
  const hasUpdateBridge =
    typeof window !== "undefined" && Boolean(window.__heming_update);

  return (
    <div className="flex max-w-full flex-col gap-3">
      <div data-settings-id="update" className={anchorClass(highlightedId === "update")}>
        {hasUpdateBridge ? (
          <UpdateCard currentVersion={appVersionLabel()} />
        ) : (
          <section aria-label="软件更新" className="ui-card p-4">
            <div className="ui-section-title">软件更新</div>
            <p className="mt-1 ui-caption leading-5">
              当前在网页里打开，更新由桌面安装版自动检查并提示；网页版会随服务端一起更新，不用手动升级。
            </p>
          </section>
        )}
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
        点击条目看这一版对用户的影响；工程记录（根因、验证口径）见仓库 CHANGELOG.md，不在这里展开。
      </div>
      <ul className="mt-2 flex flex-col gap-1">
        {CHANGELOG.slice(0, showAllLogs ? CHANGELOG.length : RECENT_LOG_LIMIT).map((entry) => {
          const isCurrent = entry.version === appVersionLabel();
          const open = logOpenState(logState, entry.version, isCurrent);
          const notes = userNotesFor(entry.version);
          return (
            <li key={entry.version} className="rounded-lg border border-line-soft">
              <button
                type="button"
                aria-expanded={open}
                aria-label={`更新日志 ${entry.version}`}
                onClick={() => setLogState((prev) => toggleLog(prev, entry.version, isCurrent))}
                className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-[var(--subtle)]"
              >
                <span className="text-[12px] font-bold">{entry.version}</span>
                {isCurrent && (
                  <span className="rounded-full border border-line px-1.5 text-[10px] text-muted">
                    当前
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate ui-caption">
                  {stripInline(notes?.title ?? entry.title) || entry.date}
                </span>
                <span className="shrink-0 ui-caption">{open ? "收起" : "展开"}</span>
              </button>
              {open && (
                <div className="border-t border-line-soft px-3 py-2">
                  <div className="ui-caption">{entry.date}</div>
                  {notes ? (
                    <>
                      <div className="mt-0.5 text-[12px] font-medium">
                        <InlineText text={notes.title} />
                      </div>
                      <ul className="mt-1.5 flex flex-col gap-1">
                        {(notes.bullets.length > 0 ? notes.bullets : notes.paragraphs).map((line, i) => (
                          <li key={i} className="flex gap-1.5 text-[12px] leading-relaxed">
                            <span className="text-muted">·</span>
                            <span className="min-w-0 flex-1">
                              <InlineText text={line} />
                            </span>
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : (
                    <p className="mt-1 text-[12px] leading-relaxed text-muted">
                      这一版还没有用户版说明；工程记录见仓库 CHANGELOG.md。
                    </p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {!showAllLogs && CHANGELOG.length > RECENT_LOG_LIMIT ? (
        <button
          type="button"
          className="ui-btn ui-btn-sm ui-btn-ghost mt-2"
          onClick={() => setShowAllLogs(true)}
        >
          显示更早的 {CHANGELOG.length - RECENT_LOG_LIMIT} 个版本
        </button>
      ) : null}
        </section>
      </div>
    </div>
  );
}
