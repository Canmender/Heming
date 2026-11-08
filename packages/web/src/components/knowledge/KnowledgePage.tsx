import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SearchHit, VaultStoreApi } from "../../lib/vault/types.js";
import { useVaultStore } from "../../lib/vault/store.js";
import { runSearch } from "../../lib/vault/search.js";
import { resolveVaultBridge } from "../../lib/vault/bridge.js";
import { ConfirmDialog } from "../ConfirmDialog.js";
import { BacklinkPane } from "./BacklinkPane.js";
import { EditorPane, type EditorLoader } from "./EditorPane.js";
import { FileTree } from "./FileTree.js";
import { GraphPane } from "./GraphPane.js";
import { PreviewPane } from "./PreviewPane.js";
import { SearchPanel } from "./SearchPanel.js";
import { TagPanel } from "./TagPanel.js";
import { baseName, ensureMdExt, joinRel, parentOf } from "./model.js";

/**
 * 知识库页（vault）：三栏装配。
 *
 * - 左栏：库切换 + 文件树 / 搜索 / 标签（三个面板同一位置切换，窄栏放不下三块常驻内容）；
 * - 中栏：标签页（多文件）+ 编辑器三态（源码 / 分栏 / 阅读）+ 面包屑；图谱作为中栏视图；
 * - 右栏：反链 / 出链 / 未解析 / 大纲 / 属性，可折叠。
 *
 * 数据面只依赖 `VaultStoreApi`（契约在 `lib/vault/types.ts`）：真实实现是
 * `useVaultStore()`，测试注入假 store。组件不自己读文件、不自己解析链接，
 * 所有「索引 → 界面」的换算都在 store 与 `lib/vault` 里，界面只负责展示与编排。
 *
 * 三条产品约定（规格 §4 / §6）：
 * 1. **数据不出设备**：空库态明确写「文件留在本机，不上传」；
 * 2. **浏览器临时模式要显式提示**：没有桌面文件桥时数据只存在当前页面；
 * 3. **未保存拦截**：切文件 / 关标签 / 关页面前都要提示，绝不静默丢修改。
 */

/** 界面用到的 store 扩展面（`VaultStoreApi` 之外的可选能力，缺省时自动降级）。 */
export type KnowledgeStore = VaultStoreApi & {
  /** frontmatter 行号偏移：搜索/大纲跳转要还原成编辑器行号。 */
  lineOffsetOf?: (rel: string) => number;
  /** 直接读正文（嵌入笔记等异步路径用）。 */
  readText?: (rel: string) => Promise<string | null>;
};

export interface KnowledgePageProps {
  /** 测试注入；缺省时从 `lib/vault/store.js` 取真实 store。 */
  store?: KnowledgeStore;
  /** 测试注入编辑器加载器；缺省懒加载 CodeMirror 6。 */
  editorLoader?: EditorLoader;
}

type LeftTab = "files" | "search" | "tags";

/** 未保存拦截的待执行动作。 */
type PendingAction = { label: string; run: () => void | Promise<void> };

/* ------------------------------------------------------------------ 实时 store 外壳 */

/** 真实 store 版本：启动粘合层（幂等）+ 首屏视图。 */
function LiveKnowledgePage({ editorLoader }: { editorLoader?: EditorLoader }) {
  const store = useVaultStore() as KnowledgeStore;

  // 从导航直接进来时再调一次 bootVault（幂等；App 启动时已经调过一次）
  useEffect(() => {
    void import("../../lib/vault/boot.js")
      .then((m) => m.bootVault())
      .catch(() => {
        /* 启动失败只在页面里显示空库态，不影响其它页 */
      });
  }, []);

  return <KnowledgePageShell store={store} editorLoader={editorLoader} />;
}

/** 页面入口：有注入 store 走注入（测试 / 嵌入场景），否则走真实 store。 */
export function KnowledgePage({ store, editorLoader }: KnowledgePageProps = {}) {
  if (store) return <KnowledgePageShell store={store} editorLoader={editorLoader} />;
  return <LiveKnowledgePage editorLoader={editorLoader} />;
}

/* ------------------------------------------------------------------ 三栏外壳 */

function KnowledgePageShell({
  store,
  editorLoader,
}: {
  store: KnowledgeStore;
  editorLoader?: EditorLoader;
}) {
  const [leftTab, setLeftTab] = useState<LeftTab>("files");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [graphOpen, setGraphOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(true);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [removeConfirm, setRemoveConfirm] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [revealLine, setRevealLine] = useState<number | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activeRel = store.activeRel;
  const activeMeta = store.vaults.find((vault) => vault.id === store.activeVaultId) ?? null;
  const activePage = activeRel ? (store.index?.pages.get(activeRel) ?? null) : null;
  const activeDoc = activeRel ? (store.docs.get(activeRel) ?? null) : null;
  const activeDirty = activeRel ? store.dirty.has(activeRel) : false;

  const showNotice = useCallback((message: string) => {
    setNotice(message);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 4000);
  }, []);

  useEffect(
    () => () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    },
    [],
  );

  // 首次进入且还没加载过库：补一次（bootVault 失败或从导航直达时兜底）
  useEffect(() => {
    if (store.vaults.length === 0 && store.indexStatus !== "indexing") {
      void store.loadVaults();
    }
    // 只在挂载时兜底一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 关页面前的未保存拦截：浏览器/Electron 关闭窗口时提示
  useEffect(() => {
    if (store.dirty.size === 0) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [store.dirty]);

  /** 打开文件：有未保存修改时先问一句。 */
  const requestOpen = useCallback(
    (rel: string) => {
      if (rel === store.activeRel) return;
      const run = () => {
        setGraphOpen(false);
        void store.openFile(rel);
      };
      if (store.activeRel && store.dirty.has(store.activeRel)) {
        setPending({ label: "切到这个文件", run });
        return;
      }
      run();
    },
    [store],
  );

  /** 关闭标签：有未保存修改时先问一句。 */
  const requestClose = useCallback(
    (rel: string) => {
      const run = () => store.closeFile(rel);
      if (store.dirty.has(rel)) {
        setPending({ label: "关闭这个标签", run });
        return;
      }
      run();
    },
    [store],
  );

  /** 保存并继续 / 不保存继续 / 取消。 */
  const resolvePending = async (mode: "save" | "discard") => {
    const action = pending;
    setPending(null);
    if (!action) return;
    if (mode === "save" && activeRel) {
      const ok = await store.saveFile(activeRel);
      if (!ok) return; // 保存失败：store.error 已是中文原因，停在这里不继续
    }
    await action.run();
  };

  // 图片：走桌面桥读二进制转 data URL（浏览器内存桥同样实现）
  const resolveImage = useCallback(
    async (rel: string): Promise<string | null> => {
      const bridge = resolveVaultBridge();
      const vaultId = store.activeVaultId;
      if (!bridge || !vaultId) return null;
      const image = await bridge.readBinary(vaultId, rel);
      return image?.dataUrl ?? null;
    },
    [store.activeVaultId],
  );

  // 嵌入笔记：先查已打开的文档缓存；没有就按需读一次（异步，读不到就退回 chip）
  const resolveDoc = useCallback(
    (rel: string): { rel: string; text: string } | null => {
      const cached = store.docs.get(rel);
      if (cached) return { rel, text: cached.text };
      return null;
    },
    [store.docs],
  );

  /** 未解析链接 → 在当前文件同目录建页并打开。 */
  const createPage = useCallback(
    (target: string) => {
      const dir = activeRel ? parentOf(activeRel) : "";
      const rel = joinRel(dir, ensureMdExt(target));
      void (async () => {
        const ok = await store.createFile(rel);
        if (ok) await store.openFile(rel);
      })();
    },
    [store, activeRel],
  );

  /** 大纲/搜索结果跳行：行号已由 store 还原（搜索走 lineOffsetOf），这里只负责滚动。 */
  const jumpToLine = useCallback((line: number) => {
    setGraphOpen(false);
    setRevealLine(line);
    // 同一行连续点两次也要能重新触发（effect 依赖数值）
    setTimeout(() => setRevealLine(null), 1200);
  }, []);

  /** 新建笔记：库根或文件树右键目录。 */
  const createFile = useCallback(
    (dirRel: string, fileName: string) => {
      const rel = joinRel(dirRel, fileName);
      void (async () => {
        const ok = await store.createFile(rel);
        if (ok) await store.openFile(rel);
      })();
    },
    [store],
  );

  const revealInOs = useCallback(
    (rel: string) => {
      const bridge = resolveVaultBridge();
      const vaultId = store.activeVaultId;
      if (!bridge || !vaultId) {
        showNotice("浏览器临时模式没有系统文件管理器入口。");
        return;
      }
      void bridge
        .reveal(vaultId, rel)
        .catch(() => showNotice("无法在资源管理器中定位：路径可能已失效。"));
    },
    [store.activeVaultId, showNotice],
  );

  // 搜索结果：查询串变化就重算（索引就绪前 results 恒空）
  const hits = useMemo<SearchHit[]>(() => {
    if (!searchQuery.trim() || !store.index) return [];
    return runSearch(store.index, searchQuery, {
      lineOffsetOf: (rel) => store.lineOffsetOf?.(rel) ?? 0,
    });
  }, [store.index, store.lineOffsetOf, searchQuery]);

  // 标签过滤：给文件树换成「按标签筛过的页面列表」
  const tagFilteredRels = useMemo(() => {
    if (!activeTag || !store.index) return null;
    return [...(store.index.tags.get(activeTag) ?? [])].sort((a, b) => a.localeCompare(b));
  }, [store.index, activeTag]);

  const openFiles = store.openFiles;
  const showLibraryEmpty = store.vaults.length === 0;
  const dirtyCount = store.dirty.size;

  /* ── 空库态：整页只留一个明确的开始动作与隐私说明 ── */
  if (showLibraryEmpty) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <h1 className="ui-page-title">知识库</h1>
        <p className="ui-body max-w-[440px] text-muted">
          打开一个本地目录作为知识库：笔记就是普通的 .md 文件，双链、标签、反链、搜索与图谱都在本机计算。
          <span className="mt-1 block font-medium text-ink">文件留在你的设备上，不会上传。</span>
        </p>
        <div className="mt-1 flex items-center gap-2">
          <button
            type="button"
            className="ui-btn ui-btn-md ui-btn-primary"
            onClick={() => void store.pickVault()}
          >
            打开本地库
          </button>
          <button
            type="button"
            className="ui-btn ui-btn-md ui-btn-ghost"
            onClick={() => void store.loadVaults()}
          >
            重新读取库列表
          </button>
        </div>
        {store.ephemeral ? (
          <p className="ui-caption mt-2 max-w-[440px] text-muted">
            当前是浏览器临时模式：没有桌面文件桥，打开的库只存在内存里，刷新即丢。
          </p>
        ) : null}
        {store.error ? (
          <p role="alert" className="ui-alert ui-alert-danger mt-2">
            {store.error}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 顶栏：库切换 + 索引状态 + 全局入口 */}
      <header className="flex shrink-0 items-center gap-2 border-b border-line-soft px-3 py-1.5">
        <span className="ui-section-title">知识库</span>
        <select
          aria-label="切换知识库"
          className="ui-input h-7 w-[168px] text-[12px]"
          value={store.activeVaultId ?? ""}
          onChange={(e) => void store.setActiveVault(e.target.value)}
        >
          {store.vaults.map((vault) => (
            <option key={vault.id} value={vault.id}>
              {vault.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="ui-btn ui-btn-sm ui-btn-ghost"
          onClick={() => void store.pickVault()}
        >
          打开其它库
        </button>
        {activeMeta ? (
          <button
            type="button"
            className="ui-link"
            aria-label={`移除知识库 ${activeMeta.name}（不删除文件）`}
            onClick={() => setRemoveConfirm(true)}
          >
            移除
          </button>
        ) : null}

        {store.indexStatus === "indexing" ? (
          <span className="ui-caption" aria-live="polite">
            正在建索引 {Math.round(store.indexProgress * 100)}%
          </span>
        ) : store.indexStatus === "ready" ? (
          <span className="ui-caption">{store.index ? store.index.pages.size : 0} 篇笔记</span>
        ) : null}

        <span className="ml-auto flex items-center gap-1">
          <button
            type="button"
            aria-pressed={graphOpen}
            className={`ui-btn ui-btn-sm ${graphOpen ? "ui-btn-primary" : "ui-btn-ghost"}`}
            onClick={() => setGraphOpen((prev) => !prev)}
          >
            图谱
          </button>
          <button
            type="button"
            aria-pressed={rightOpen}
            className="ui-btn ui-btn-sm ui-btn-ghost"
            aria-label={rightOpen ? "折叠右侧面板" : "展开右侧面板"}
            onClick={() => setRightOpen((prev) => !prev)}
          >
            {rightOpen ? "收起右栏" : "展开右栏"}
          </button>
        </span>
      </header>

      {store.ephemeral ? (
        <p className="ui-alert ui-alert-muted mx-3 mt-2" role="status">
          浏览器临时模式：没有桌面文件桥，笔记只存在当前页面，刷新即丢；要保存请用桌面版打开本地库。
        </p>
      ) : null}

      {store.error ? (
        <p className="ui-alert ui-alert-danger mx-3 mt-2" role="alert">
          {store.error}
        </p>
      ) : null}
      {notice ? (
        <p className="ui-alert ui-alert-muted mx-3 mt-2" role="status">
          {notice}
        </p>
      ) : null}

      <div className="flex min-h-0 flex-1">
        {/* ── 左栏 ── */}
        <aside
          data-testid="knowledge-left"
          className="flex w-[248px] shrink-0 flex-col border-r border-line-soft bg-panel"
        >
          <div className="flex shrink-0 items-center gap-0.5 border-b border-line-soft px-1.5 py-1">
            {(["files", "search", "tags"] as LeftTab[]).map((tab) => (
              <button
                key={tab}
                type="button"
                aria-pressed={leftTab === tab}
                onClick={() => setLeftTab(tab)}
                className={`flex-1 rounded-sm px-1.5 py-1 text-[11px] transition-colors ${
                  leftTab === tab
                    ? "bg-subtle-3 font-medium text-ink"
                    : "text-muted hover:bg-subtle-2 hover:text-ink"
                }`}
              >
                {tab === "files" ? "文件" : tab === "search" ? "搜索" : "标签"}
              </button>
            ))}
          </div>

          <div className="min-h-0 flex-1 overflow-hidden">
            {leftTab === "files" ? (
              tagFilteredRels ? (
                <div className="flex h-full flex-col">
                  <p className="ui-caption flex items-center justify-between px-2 py-1">
                    <span>标签 #{activeTag}</span>
                    <button
                      type="button"
                      className="ui-link h-5"
                      onClick={() => setActiveTag(null)}
                    >
                      清除
                    </button>
                  </p>
                  <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
                    {tagFilteredRels.length === 0 ? (
                      <p className="px-2 py-3 text-[12px] text-muted">这个标签下还没有笔记。</p>
                    ) : (
                      tagFilteredRels.map((rel) => (
                        <button
                          key={rel}
                          type="button"
                          aria-current={rel === activeRel ? "page" : undefined}
                          onClick={() => requestOpen(rel)}
                          className={`block w-full truncate rounded-sm px-2 py-[3px] text-left text-[12px] ${
                            rel === activeRel
                              ? "bg-subtle-2 font-medium text-ink"
                              : "text-body hover:bg-subtle-3 hover:text-ink"
                          }`}
                        >
                          {rel}
                        </button>
                      ))
                    )}
                  </div>
                </div>
              ) : (
                <FileTree
                  tree={store.tree}
                  activeRel={activeRel}
                  dirty={store.dirty}
                  onOpen={requestOpen}
                  onCreateFile={createFile}
                  onRename={(from, to) => void store.renameFile(from, to)}
                  onDelete={(rel) => void store.deleteFile(rel)}
                  onReveal={revealInOs}
                  onExpandDir={(rel) => {
                    // 目录按需加载：桥的 tree() 单次最多返回 20000 节点，大树靠展开时补拉
                    void store.refreshTree();
                    void rel;
                  }}
                />
              )
            ) : leftTab === "search" ? (
              <SearchPanel
                query={searchQuery}
                onQueryChange={setSearchQuery}
                hits={hits}
                searched={Boolean(searchQuery.trim())}
                disabled={!store.index}
                onOpenHit={(hit) => {
                  requestOpen(hit.rel);
                  jumpToLine(hit.line);
                }}
                onClear={() => setSearchQuery("")}
              />
            ) : (
              <TagPanel
                tags={store.index?.tags ?? new Map<string, string[]>()}
                activeTag={activeTag}
                onSelectTag={(tag) => {
                  setActiveTag(tag);
                  setLeftTab("files");
                }}
              />
            )}
          </div>
        </aside>

        {/* ── 中栏 ── */}
        <main data-testid="knowledge-center" className="flex min-w-0 flex-1 flex-col">
          {/* 标签页 */}
          <div
            role="tablist"
            aria-label="打开的文件"
            className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-line-soft px-1.5 py-1"
          >
            {openFiles.length === 0 ? (
              <span className="ui-caption px-1">还没有打开的文件</span>
            ) : (
              openFiles.map((rel) => {
                const active = rel === activeRel;
                return (
                  <span
                    key={rel}
                    className={`flex shrink-0 items-center rounded-sm ${
                      active ? "bg-subtle-3" : "hover:bg-subtle-2"
                    }`}
                  >
                    <button
                      type="button"
                      role="tab"
                      aria-selected={active}
                      onClick={() => requestOpen(rel)}
                      title={rel}
                      className={`max-w-[180px] truncate px-2 py-1 text-[12px] ${
                        active ? "font-medium text-ink" : "text-muted"
                      }`}
                    >
                      {store.dirty.has(rel) ? (
                        <span aria-label="未保存" className="mr-1 text-warn">
                          ●
                        </span>
                      ) : null}
                      {baseName(rel)}
                    </button>
                    <button
                      type="button"
                      aria-label={`关闭标签 ${baseName(rel)}`}
                      onClick={() => requestClose(rel)}
                      className="flex h-6 w-5 items-center justify-center rounded-sm text-muted hover:bg-subtle-4 hover:text-ink"
                    >
                      ×
                    </button>
                  </span>
                );
              })
            )}
          </div>

          {graphOpen ? (
            <div className="min-h-0 flex-1">
              <GraphPane index={store.index} activeRel={activeRel} onOpen={requestOpen} />
            </div>
          ) : activeRel ? (
            <>
              {/* 面包屑 + 三态切换 */}
              <div className="flex shrink-0 items-center gap-2 border-b border-line-soft px-3 py-1.5">
                <span className="min-w-0 flex-1 truncate text-[11px] text-muted" title={activeRel}>
                  {parentOf(activeRel) ? `${parentOf(activeRel)} / ` : ""}
                  <span className="text-ink">{baseName(activeRel)}</span>
                </span>
                <span role="group" aria-label="编辑模式" className="flex items-center gap-0.5">
                  {(
                    [
                      ["source", "源码"],
                      ["split", "分栏"],
                      ["read", "阅读"],
                    ] as const
                  ).map(([mode, label]) => (
                    <button
                      key={mode}
                      type="button"
                      aria-pressed={store.mode === mode}
                      onClick={() => store.setMode(mode)}
                      className={`ui-btn ui-btn-sm ${
                        store.mode === mode ? "ui-btn-primary" : "ui-btn-ghost"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </span>
              </div>

              <div className="min-h-0 flex-1">
                <EditorPane
                  rel={activeRel}
                  text={activeDoc?.text ?? activePage?.body ?? ""}
                  mode={store.mode}
                  dirty={activeDirty}
                  loader={editorLoader}
                  onChange={(text) => store.editFile(activeRel, text)}
                  onSave={() => void store.saveFile(activeRel)}
                  revealLine={revealLine}
                  renderPreview={() => (
                    <PreviewPane
                      rel={activeRel}
                      text={activeDoc?.text ?? activePage?.body ?? ""}
                      index={store.index}
                      onOpenLink={requestOpen}
                      onCreatePage={createPage}
                      resolveImage={resolveImage}
                      resolveDoc={resolveDoc}
                    />
                  )}
                />
              </div>
            </>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
              <p className="ui-body text-muted">
                从左侧文件树打开一篇笔记；也可以直接新建。
              </p>
              <p className="ui-caption">
                写 <code className="rounded-sm bg-subtle-3 px-1">[[页面名]]</code> 建立双链，
                写 <code className="rounded-sm bg-subtle-3 px-1">#标签</code> 归类。
              </p>
              <button
                type="button"
                className="ui-btn ui-btn-sm ui-btn-primary mt-1"
                onClick={() => createFile("", "新建笔记.md")}
              >
                新建笔记
              </button>
            </div>
          )}
        </main>

        {/* ── 右栏 ── */}
        {rightOpen ? (
          <aside
            data-testid="knowledge-right"
            className="flex w-[264px] shrink-0 flex-col border-l border-line-soft bg-panel"
          >
            {activeRel ? (
              <BacklinkPane
                rel={activeRel}
                backlinks={store.backlinksOf(activeRel)}
                outlinks={store.outlinksOf(activeRel)}
                unresolved={store.unresolvedOf(activeRel)}
                headings={activePage?.headings ?? []}
                frontmatter={activePage?.frontmatter ?? {}}
                onOpen={requestOpen}
                onCreatePage={createPage}
                onJumpToLine={(line) =>
                  jumpToLine(line + (store.lineOffsetOf?.(activeRel) ?? 0))
                }
              />
            ) : (
              <div className="p-3 text-[12px] leading-5 text-muted">
                打开一篇笔记后，这里会显示它的反链、出链、未解析链接、大纲与属性。
              </div>
            )}
          </aside>
        ) : null}
      </div>

      {/* 状态栏：脏文件计数 + 快捷键提示 */}
      <footer className="flex shrink-0 items-center gap-3 border-t border-line-soft px-3 py-1 text-[10px] text-muted">
        <span>{dirtyCount > 0 ? `${dirtyCount} 个文件未保存` : "全部已保存"}</span>
        <span>Ctrl+S 保存 · Ctrl+F 编辑器内搜索</span>
        <span className="ml-auto">{activeMeta?.root ?? ""}</span>
      </footer>

      {pending ? (
        <ConfirmDialog
          title="有未保存的修改"
          onCancel={() => setPending(null)}
          footer={
            <>
              <button type="button" className="ui-btn ui-btn-md ui-btn-ghost" onClick={() => setPending(null)}>
                取消
              </button>
              <button
                type="button"
                className="ui-btn ui-btn-md ui-btn-ghost"
                onClick={() => void resolvePending("discard")}
              >
                不保存
              </button>
              <button
                type="button"
                className="ui-btn ui-btn-md ui-btn-primary"
                onClick={() => void resolvePending("save")}
              >
                保存并{pending.label === "关闭这个标签" ? "关闭" : "切换"}
              </button>
            </>
          }
        >
          <p className="ui-body-sm">
            当前文件有未保存的修改，{pending.label}前要保存吗？
          </p>
          <p className="ui-caption mt-1">不保存会丢弃这次编辑的内容。</p>
        </ConfirmDialog>
      ) : null}

      {removeConfirm && activeMeta ? (
        <ConfirmDialog
          title={`移除知识库 ${activeMeta.name}`}
          onCancel={() => setRemoveConfirm(false)}
          footer={
            <>
              <button
                type="button"
                className="ui-btn ui-btn-md ui-btn-ghost"
                onClick={() => setRemoveConfirm(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="ui-btn ui-btn-md ui-btn-danger"
                onClick={() => {
                  const id = activeMeta.id;
                  setRemoveConfirm(false);
                  void store.removeVault(id);
                }}
              >
                移除
              </button>
            </>
          }
        >
          <p className="ui-body-sm">
            只从和鸣的库列表里移除，<span className="font-medium">不会删除磁盘上的任何文件</span>。
          </p>
          <p className="ui-caption mt-1">之后仍可以用「打开本地库」重新加回来。</p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
