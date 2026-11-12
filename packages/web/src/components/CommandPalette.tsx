import { useEffect, useMemo, useRef, useState } from "react";
import type { TeamMember } from "@heming/shared";
import { fetchTeam } from "../lib/api.js";
import { useUiStore } from "../store/ui.js";
import {
  callInfohub,
  readInfohubConfig,
  type InfohubSearchHit,
  type InfohubSearchResult,
} from "../lib/infohub/client.js";
import { useInfohubStore } from "../lib/infohub/store.js";
import { readLocalSnapshot, type LocalSnapshot } from "../lib/palette/local.js";
import { PALETTE_PAGES, shortcutLabel } from "../lib/palette/pages.js";
import { runPluginCommandTarget } from "../lib/palette/pluginCommands.js";
import { pluginStore } from "../lib/plugins/index.js";
import { skillPool } from "../lib/skills/index.js";
import { refreshWidgets, useWidgetsStore, widgetsAvailable } from "../lib/widgets/store.js";
import { widgetCommands } from "../lib/widgets/commands.js";

import { loadRecent, recordRecent, type RecentEntry } from "../lib/palette/recent.js";
import {
  buildEmptyGroups,
  flattenGroups,
  searchPalette,
  type PaletteGroup,
  type PaletteItem,
} from "../lib/palette/search.js";
import type { VaultIndex } from "../lib/vault/types.js";
import { rankQuickOpenNotes } from "./knowledge/quickOpenModel.js";
import { Avatar } from "./Avatar.js";
import {
  ArchiveIcon,
  BookIcon,
  GearIcon,
  HomeIcon,
  MemoryIcon,
  PlugIcon,
  SkillsIcon,
  SparkIcon,
  TaskIcon,
} from "./icons.js";
import { useModalA11y } from "./useModalA11y.js";

// 旧版导出保持不变：`searchAll`/`searchAllDetailed` 是纯函数、有独立用例覆盖，
// 命令面板只是把「怎么展示」换成新版分组，检索口径原样复用。
export { searchAll, searchAllDetailed } from "../lib/palette/search.js";
export type { SearchOutcome, SearchResult } from "../lib/palette/search.js";

/**
 * 命令面板（Ctrl/⌘+K）· v2（d.60）。
 *
 * ## 空查询：三组「目的地」
 * 最近使用（本机 ≤5）→ 页面跳转（9 个宿主页，带 Alt 快捷键）→ 常用动作（5 个）。
 * 打开面板就能「去哪里」，不必先想关键词。
 *
 * ## 输入：同屏分组检索，组间不混排
 * 页面名 + 描述、设置分区（含关键词，如「主题」「版本」）、动作名、成员、技能、
 * 归档（仅桌面端连接信息中枢时，防抖 FTS）。组内有命中才出现。
 *
 * ## 键盘与 a11y
 * ↑↓ 移动（`preventDefault`，不滚动页面）、Enter 执行、Esc 关闭；结果容器
 * `role="listbox"`、每项 `role="option"` + `aria-selected`，输入框用
 * `aria-activedescendant` 指向当前项。执行后统一关闭面板——行为可预期。
 *
 * ## 执行边界
 * 只走既有 store：`setPage` / `openSettings` / `focusTeamMember` / `openInfohub` /
 * 意图槽 `setPaletteIntent`。不新增 IPC、不引依赖、不直接调接口。
 * 最近使用只存本机 localStorage（`heming.palette.recent.v1`）。
 */

/** 归档检索防抖与条数：命令面板是快速找东西，不要每敲一个字就打一次 FTS。 */
const ARCHIVE_DEBOUNCE_MS = 250;
const ARCHIVE_LIMIT = 5;

const LISTBOX_ID = "palette-listbox";
const optionId = (index: number) => `palette-option-${index}`;
const itemKey = (item: PaletteItem) => `${item.kind}:${item.id}`;

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const setPage = useUiStore((s) => s.setPage);
  const focusTeamMember = useUiStore((s) => s.focusTeamMember);
  const openInfohub = useUiStore((s) => s.openInfohub);
  const openSettings = useUiStore((s) => s.openSettings);
  const openModuleManager = useUiStore((s) => s.openModuleManager);
  const openVault = useUiStore((s) => s.openVault);
  const setPaletteIntent = useUiStore((s) => s.setPaletteIntent);
  const focusTask = useUiStore((s) => s.focusTask);
  const infohubRunning = useInfohubStore((s) => s.running);
  /** 页面跳转目录固定 8 个宿主页；带页面的插件由插件命令/注册表走另一条路径。 */
  const pages = PALETTE_PAGES;

  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [archiveHits, setArchiveHits] = useState<InfohubSearchHit[]>([]);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [recent, setRecent] = useState<RecentEntry[]>(() => loadRecent());
  const inputRef = useRef<HTMLInputElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // 名册一次拉全：成员数量级很小，打开面板时取一次即可，不随击键重复请求。
  useEffect(() => {
    let alive = true;
    fetchTeam()
      .then((roster) => {
        if (alive) setMembers(roster.members);
      })
      .catch(() => {
        if (alive) setMembers([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  // 归档全文检索：仅在桌面端已连接时启用；防抖 250ms，旧的词立刻清掉避免错配。
  useEffect(() => {
    const q = query.trim();
    if (!q || !infohubRunning) {
      setArchiveHits([]);
      setArchiveBusy(false);
      return;
    }
    let alive = true;
    setArchiveHits([]);
    const timer = window.setTimeout(() => {
      setArchiveBusy(true);
      callInfohub<InfohubSearchResult>("search", { query: q, limit: ARCHIVE_LIMIT }, readInfohubConfig())
        .then((data) => {
          if (alive) setArchiveHits(Array.isArray(data.items) ? data.items : []);
        })
        .catch(() => {
          if (alive) setArchiveHits([]);
        })
        .finally(() => {
          if (alive) setArchiveBusy(false);
        });
    }, ARCHIVE_DEBOUNCE_MS);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [query, infohubRunning]);

  // 本机三组（任务/记忆/插件）：打开面板时读一次内存快照，之后的检索全在内存里做。
  // 只读本机、不发请求、不写日志（隐私边界见 lib/palette/local.ts 顶部）。
  const [local] = useState<LocalSnapshot>(() => readLocalSnapshot());

  /**
   * 知识库索引：**动态 import** vault store，避免把整条 vault 引擎（索引/解析/store）
   * 打进命令面板所在的主 chunk——知识库不是首屏能力，只有面板真的打开时才付这份成本。
   * 拉不到（浏览器老版本 / 引擎未就绪）就只是少一组「知识库笔记」，不报错。
   */
  const [vaultIndex, setVaultIndex] = useState<VaultIndex | null>(null);
  useEffect(() => {
    let alive = true;
    let unsubscribe: (() => void) | null = null;
    void import("../lib/vault/store.js")
      .then((mod) => {
        if (!alive) return;
        setVaultIndex(mod.useVaultStore.getState().index);
        // 索引重建时同步刷新：面板开着也能搜到刚建好的索引
        unsubscribe = mod.useVaultStore.subscribe((state) => setVaultIndex(state.index));
      })
      .catch(() => {
        /* 没有知识库引擎时少一组结果，不影响其它检索 */
      });
    return () => {
      alive = false;
      unsubscribe?.();
    };
  }, []);
  /** 知识库笔记命中：排序复用 W2 `rankQuickOpen`（当前由 quickOpen.ts 适配层兜底）。 */
  const vaultNotes = useMemo(
    () => (query.trim() ? rankQuickOpenNotes(vaultIndex, query.trim(), 8) : []),
    [vaultIndex, query],
  );
  /**
   * 插件命令：声明式插件（每次打开面板现读 store，停用后自然消失）+ 已装插件
   * （d.109：主进程注册表经 `widgets:list()` 同步到 zustand，本文件只做投影，不执行插件代码）。
   *
   * 浏览器端没有桌面桥 → `widgetsAvailable()` 为 false，列表恒为空；只是少一组命令，不报错。
   */
  const widgetRecords = useWidgetsStore((s) => s.records);
  const commands = useMemo(
    () => [...pluginStore.commands(), ...widgetCommands(widgetRecords)],
    [widgetRecords],
  );
  useEffect(() => {
    if (!widgetsAvailable()) return;
    // 面板可能在插件区之外打开：主动拉一次注册表，失败只影响「界面插件命令」这一组
    void refreshWidgets();
  }, []);

  const groups = useMemo<PaletteGroup[]>(
    () =>
      query.trim()
        ? searchPalette(query, { members, archiveHits, local, commands, pages, vaultNotes })
        : buildEmptyGroups(recent, pages),
    [query, members, archiveHits, local, commands, recent, pages, vaultNotes],
  );
  const items = useMemo(() => flattenGroups(groups), [groups]);
  const indexByKey = useMemo(() => {
    const map = new Map<string, number>();
    items.forEach((item, i) => map.set(itemKey(item), i));
    return map;
  }, [items]);

  // 唤起即聚焦 + Tab 困在面板内：命令面板的整个意义就是「键盘打字开始找」
  useModalA11y(panelRef, onClose, { closeOnEscape: false, initialFocusRef: inputRef });

  // 每次打开都是「重新开始」：显式聚焦 + 全选输入框内容。
  // 现在面板是「关闭即卸载」，query 天然是空的；这里仍显式 select() 一次——
  // 让「打开就能直接打字」不依赖 focus 的实现细节；将来若面板改成常驻挂载
  // （不再卸载），这一行也能保证上次的查询词被整体选中、一打字就覆盖。
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  // 结果集变化时把光标收回第一项，避免停在一个已经不存在的位置
  useEffect(() => {
    setCursor(0);
  }, [query, members, archiveHits, recent, vaultNotes]);

  // 光标移动时把当前项滚进视野（长列表里键盘走到屏外会看不见选中项）
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`#${optionId(cursor)}`);
    el?.scrollIntoView?.({ block: "nearest" });
  }, [cursor]);

  /** 记一条最近使用（只记可离线复原的页面 / 设置 / 动作）。 */
  const remember = (entry: RecentEntry) => {
    setRecent(recordRecent(entry));
  };

  /** 四个动作的执行点：全部走既有 store，不新增 IPC。 */
  const runAction = (id: PaletteItem["actionId"]) => {
    switch (id) {
      case "new-task":
        // 任务区已是「常驻启动面板」，直接填写目标即可运行，不需要先建任务。
        setPage("tasks");
        break;
      case "new-agent":
        // 先投意图再切页：AssistantPage 是懒加载页，挂载后才消费意图并打开新建弹窗。
        setPaletteIntent("agent-create");
        setPage("chat");
        break;
      case "notifications":
        // 通知中心常驻在导航栏，投意图即可由它自己打开。
        setPaletteIntent("notifications");
        break;
      case "settings":
        openSettings();
        break;
      case "plugins":
        // 直达插件页的「插件」Tab（安装/启停都在这页），旧链接与通知也落到同一入口。
        openModuleManager();
        break;
      // d.113 第二轮：知识库四个动作统一「切页 + 投意图」，由知识库页执行；
      // 面板不直接读写文件（存盘路径、模板、日记设置都在页面/引擎侧）。
      case "vault-new-note":
        openVault({ kind: "new" });
        break;
      case "vault-daily":
        openVault({ kind: "daily" });
        break;
      case "vault-new-canvas":
        openVault({ kind: "canvas" });
        break;
      case "vault-settings":
        openVault({ kind: "settings" });
        break;
      default:
        break;
    }
  };

  const execute = (item: PaletteItem | undefined) => {
    if (!item) return;
    switch (item.kind) {
      case "page":
        if (item.page) {
          setPage(item.page);
          remember({ kind: "page", id: item.page });
        }
        break;
      case "setting":
        if (item.tab) {
          openSettings(item.tab);
          remember({ kind: "setting", id: item.tab });
        }
        break;
      case "action":
        if (item.actionId) {
          runAction(item.actionId);
          remember({ kind: "action", id: item.actionId });
        }
        break;
      case "member":
        if (item.userId) focusTeamMember(item.userId);
        break;
      case "skill":
        // 技能没有详情路由，跳到技能区即可——到了列表里一眼能认出来
        setPage("skills");
        break;
      case "vault":
        // 知识库笔记：切到知识库页并投递「打开这篇」意图，由页面消费后 openFile。
        if (item.vaultRel) openVault({ kind: "open", rel: item.vaultRel });
        break;
      case "archive":
        // 归档页自己会跑同词检索；这里只投递意图，不复制结果页
        openInfohub({ tab: "search", query: query.trim() });
        break;
      case "plugin-command": {
        // 只走既有能力：page → 切页；skill → 技能区定位意图；plugin → 插件详情意图；
        // settings → 设置页定位卡片意图（d.108）；unit → 统一单元列表定位（复用 open-plugin 槽）。
        // d.124：分发抽到 `runPluginCommandTarget`，声明式插件页的 `actions` 块共用同一套落点，
        // 避免两处各写一遍 target → 页面/意图的映射。
        const command = item.command;
        if (!command) break;
        runPluginCommandTarget(command.target, {
          pluginId: command.pluginId,
          // 页面白名单不在这里复制：用已按「插件安装/启用」过滤过的面板页面目录。
          canOpenPage: (page) => pages.some((p) => p.page === page),
          skillIdOf: (name) => skillPool.list().find((s) => s.name === name)?.id ?? null,
          setPage,
          setPaletteIntent,
        });
        break;
      }
      case "task":
        // 复用既有 focusTask：切任务区 + taskFocusId，任务区自己选中该记录并消费。
        if (item.taskId) focusTask(item.taskId, item.conversationId);
        break;
      case "memory":
        // 记忆页是懒加载页：先投定位意图再切页，挂载后由它消费并高亮该条。
        if (item.memoryId) {
          setPaletteIntent("focus-memory", { memoryId: item.memoryId, layer: item.memoryLayer });
          setPage("memory");
        }
        break;
      case "plugin":
        // 插件页同理：投插件 id，挂载后打开该插件详情并高亮卡片。
        if (item.pluginId) {
          setPaletteIntent("open-plugin", { id: item.pluginId });
          setPage("plugins");
        }
        break;
      default:
        break;
    }
    // 统一关闭：动作执行完还留着面板，用户不知道到底生效没有。
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      // preventDefault 是必须的：不然光标在输入框里，浏览器会把它当成「滚动页面」，
      // 长列表里表现为「按 ↓ 页面在动、选中项没动」。
      e.preventDefault();
      setCursor((c) => (items.length === 0 ? 0 : (c + 1) % items.length));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => (items.length === 0 ? 0 : (c - 1 + items.length) % items.length));
      return;
    }
    if (e.key === "Home") {
      e.preventDefault();
      setCursor(0);
      return;
    }
    if (e.key === "End") {
      e.preventDefault();
      setCursor(items.length === 0 ? 0 : items.length - 1);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      execute(items[cursor]);
    }
  };

  const activeItem = items[cursor];
  const hasResults = items.length > 0;
  // 被每组上限截掉的条数（旧行为：命中很多时给一句「还有 N 条」，不让用户以为只有这些）
  const hiddenCount = groups.reduce(
    (sum, g) => sum + Math.max(0, (g.total ?? g.items.length) - g.items.length),
    0,
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/20 pt-[12vh]"
      onMouseDown={onClose}
      role="presentation"
    >
      <div
        ref={panelRef}
        /*
         * 焦点环由面板统一提供：输入框贴在面板顶边，它的 :focus-visible 环会被
         * overflow-hidden 裁成一条线（键盘用户等于看不到焦点）。
         * 用 `has-[:focus-visible]` 让环只在**键盘**聚焦时出现：鼠标打开面板不出环，
         * 与全站「鼠标不加噪音」的口径一致；也不再用 JS 状态跟踪焦点。
         */
        className="w-[560px] max-w-[92vw] overflow-hidden rounded-xl border border-line bg-[var(--surface)] shadow-[0_12px_40px_rgba(0,0,0,0.18)] has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ink"
        onMouseDown={(e) => e.stopPropagation()}
        // 键盘约定挂在面板容器上而不是输入框：焦点移到结果项后（Tab/方向键），
        // Esc 与上下选择仍然生效，不需要先把焦点移回输入框。
        onKeyDown={onKeyDown}
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
      >
        <input
          ref={inputRef}
          aria-label="搜索页面、动作与成员"
          aria-autocomplete="list"
          aria-controls={LISTBOX_ID}
          aria-expanded
          aria-activedescendant={activeItem ? optionId(cursor) : undefined}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索页面、动作、设置、成员、技能…"
          /*
           * 焦点环由面板容器画（见上），输入框自己的环必须让位：它贴着面板顶边，
           * 环会被 overflow-hidden 裁成一条黑线。`GlobalFocusRing` 的 `:focus-visible`
           * 是未分层作者样式、优先级高于 @layer utilities 的类，所以只能用内联样式；
           * 但**不能写 none**——v4 的 `outline-hidden` 语义是「2px 透明」，保留它在
           * Windows 高对比模式下的可见性（2.4.7/1.4.11），这里保持一致。
           */
          style={{ outline: "2px solid transparent" }}
          className="w-full border-b border-line-strong px-3.5 py-2.5 text-[13px] outline-hidden placeholder:text-muted"
        />

        <div
          ref={listRef}
          id={LISTBOX_ID}
          role="listbox"
          aria-label="命令面板结果"
          className="max-h-[46vh] overflow-y-auto py-1"
        >
          {groups.map((group) => (
            <div key={group.id} role="group" aria-label={group.label}>
              <div className="px-3.5 pb-0.5 pt-1.5 text-[10px] font-bold uppercase tracking-wider text-muted">
                {group.label}
              </div>
              {group.items.map((item) => {
                const index = indexByKey.get(itemKey(item)) ?? -1;
                const selected = index === cursor;
                return (
                  <div
                    key={itemKey(item)}
                    id={optionId(index)}
                    role="option"
                    aria-selected={selected}
                    aria-label={item.name}
                    // tabIndex=-1：结果项不参与 Tab 序列（焦点本该留在输入框、用
                    // aria-activedescendant 指示），但要能被程序化 focus——面板的
                    // 键盘约定挂在容器上，焦点落在结果项时 Esc/↑↓ 才接得住。
                    tabIndex={-1}
                    onMouseEnter={() => setCursor(index)}
                    onClick={() => execute(item)}
                    className={`flex cursor-pointer items-center gap-2.5 px-3 py-1.5 text-[12px] ${
                      selected ? "bg-[var(--subtle-3)]" : ""
                    }`}
                  >
                    {item.kind === "member" ? (
                      <Avatar user={{ displayName: item.name, avatar: item.avatar }} size={22} />
                    ) : (
                      <span
                        aria-hidden="true"
                        className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-sm bg-[var(--subtle-3)] text-muted"
                      >
                        {kindIcon(item.kind)}
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{item.name}</span>
                      <span className="block truncate text-[10px] text-muted">{item.detail}</span>
                    </span>
                    {item.kind === "page" && shortcutLabel(item.digit) ? (
                      <kbd className="shrink-0 rounded-sm border border-line px-1 text-[10px] text-muted">
                        {shortcutLabel(item.digit)}
                      </kbd>
                    ) : item.kind === "member" ? (
                      <span className="shrink-0 rounded-sm border border-line px-1 text-[10px] text-muted">
                        团队
                      </span>
                    ) : item.kind === "archive" ? (
                      <span className="shrink-0 rounded-sm border border-line px-1 text-[10px] text-muted">
                        本机
                      </span>
                    ) : item.kind === "vault" ? (
                      <span className="shrink-0 rounded-sm border border-line px-1 text-[10px] text-muted">
                        知识库
                      </span>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ))}

          {/* 输入了却没有任何命中：给一句明确的话，不要留白 */}
          {query.trim() !== "" && !hasResults ? (
            <div className="px-3.5 py-3 text-[12px] text-muted">
              {archiveBusy ? `正在检索本机归档「${query.trim()}」…` : `没有匹配「${query}」的结果。`}
            </div>
          ) : null}
          {archiveBusy && hasResults ? (
            <div className="px-3.5 py-1 text-[10px] text-muted">正在检索本机归档…</div>
          ) : null}
          {hiddenCount > 0 ? (
            <div className="border-t border-line-soft px-3.5 py-1.5 text-[11px] text-muted">
              还有 {hiddenCount} 条
            </div>
          ) : null}
        </div>

        {/* d.138：三段快捷键提示原本是三个裸 <span>，读屏会把它们连成
            「↑↓ 选择Enter 打开Esc 关闭」；键名改用 <kbd>（与右侧 Alt+N 同一样式），
            段间补分隔点，视觉与朗读都断得开。 */}
        <div className="flex items-center gap-2 border-t border-line-soft px-3.5 py-1.5 text-[10px] text-muted">
          <span className="inline-flex items-center gap-1">
            <kbd className="rounded-sm border border-line px-1">↑↓</kbd> 选择
          </span>
          <span> · </span>
          <span className="inline-flex items-center gap-1">
            <kbd className="rounded-sm border border-line px-1">Enter</kbd> 打开
          </span>
          <span> · </span>
          <span className="inline-flex items-center gap-1">
            <kbd className="rounded-sm border border-line px-1">Esc</kbd> 关闭
          </span>
          {!infohubRunning ? (
            // 归档能力的说明常驻在这里：未连接时也告诉用户「连上就能搜本机消息」，
            // 但不产生任何请求（避免每次敲键都撞到不存在的桥）。
            // 前缀补一个分隔点：这一句和左边的「Esc 关闭」在无障碍树里原本粘成
            // 「关闭连接信息中枢后…」，读起来像同一个句子。
            <span className="ml-auto truncate">· 连接信息中枢后，可在这里搜本机 QQ/微信历史消息</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * 结果项左侧的类型图标。
 *
 * d.138 换掉原来的「汉字方块」（页/动/设…）：一个字当图标在视觉上读作未完成的占位符，
 * 而且这些字会被拼进无障碍名（读屏念「动新建任务去任务区…」）。图标统一 aria-hidden，
 * 语义交给 role=option 的 aria-label。
 */
function kindIcon(kind: PaletteItem["kind"]) {
  const p = { width: 13, height: 13 } as const;
  switch (kind) {
    case "page":
      return <HomeIcon {...p} />;
    case "vault":
      return <BookIcon {...p} />;
    case "setting":
      return <GearIcon {...p} />;
    case "action":
      return <SparkIcon {...p} />;
    case "plugin-command":
    case "plugin":
      return <PlugIcon {...p} />;
    case "task":
      return <TaskIcon {...p} />;
    case "memory":
      return <MemoryIcon {...p} />;
    case "skill":
      return <SkillsIcon {...p} />;
    case "archive":
      return <ArchiveIcon {...p} />;
    default:
      return <SparkIcon {...p} />;
  }
}
