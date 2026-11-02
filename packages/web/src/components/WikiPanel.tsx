import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DEFAULT_SCHEMA,
  KIND_LABEL,
  WIKI_KINDS,
  buildGraph,
  isWikiEphemeral,
  pagePath,
  parseFrontmatter,
  parsePagePath,
  renderIndex,
  renderPage,
  resolveWikiBridge,
  slugify,
  type WikiKind,
  type WikiPage,
  type WikiBridge,
} from "../lib/wiki/index.js";
import { WikiGraphView } from "./WikiGraphView.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { PlusIcon } from "./icons.js";

/**
 * 个人知识库面板（卡帕西 LLM Wiki 标准的落地界面）。
 *
 * 三个视图对应标准里的三种使用方式：
 * - **图谱**：看形状——谁是枢纽、谁是孤儿（Lint 的第一入口）；
 * - **目录**：全库清单与检索，回答问题前先在这里定位（等价于标准里的 index.md）；
 * - **页面**：读与写单个页面，正文里的 [[双链]] 可点，跨页跳转靠它。
 *
 * 与旧版「本机条目列表」的根本差别：旧版是一堆互不相干的文本块，
 * 新版是**互相链接的 markdown 页面**——知识的价值在关联，不在条目本身。
 */

type View = "graph" | "index" | "page";

const VIEW_LABEL: Record<View, string> = {
  graph: "图谱",
  index: "目录",
  page: "页面",
};

interface Msg {
  kind: "error" | "ok";
  text: string;
}

export function WikiPanel({ bridge: injected }: { bridge?: WikiBridge } = {}) {
  const bridge = useMemo(() => injected ?? resolveWikiBridge(), [injected]);
  const ephemeral = isWikiEphemeral() && !injected;

  const [root, setRoot] = useState("");
  const [pages, setPages] = useState<WikiPage[]>([]);
  const [view, setView] = useState<View>("graph");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ title: string; kind: WikiKind; body: string } | null>(null);
  const [msg, setMsg] = useState<Msg | null>(null);
  const [busy, setBusy] = useState(false);

  /** 从磁盘/内存读回全部页面。index.md 与 log.md 不算页面（它们是索引与流水）。 */
  const reload = useCallback(async () => {
    try {
      const files = await bridge.list();
      const pageFiles = files.filter((f) => f.startsWith("wiki/"));
      const loaded: WikiPage[] = [];
      for (const path of pageFiles) {
        const raw = await bridge.read(path);
        if (raw == null) continue;
        const { meta, body } = parseFrontmatter(raw);
        const info = parsePagePath(path);
        loaded.push({
          path,
          title: String(meta.title ?? info?.slug ?? "未命名"),
          kind: info?.kind ?? "notes",
          tags: Array.isArray(meta.tags) ? meta.tags : [],
          body,
          updatedAt: String(meta.updated ?? ""),
        });
      }
      loaded.sort((a, b) => a.title.localeCompare(b.title));
      setPages(loaded);
    } catch (e) {
      setMsg({ kind: "error", text: `读取知识库失败：${(e as Error).message}` });
    }
  }, [bridge]);

  useEffect(() => {
    void (async () => {
      try {
        const info = await bridge.info();
        setRoot(info.root);
      } catch {
        /* 取不到根目录就只显示默认文案 */
      }
      await reload();
    })();
  }, [bridge, reload]);

  const graph = useMemo(() => buildGraph(pages), [pages]);

  const shown = useMemo(
    () => (query ? pages.filter((p) => `${p.title} ${p.tags.join(" ")} ${p.body}`.includes(query)) : pages),
    [pages, query],
  );

  const openPage = useCallback(
    (path: string) => {
      const page = pages.find((p) => p.path === path);
      if (!page) return;
      setSelected(path);
      setDraft({ title: page.title, kind: page.kind, body: page.body });
      setView("page");
    },
    [pages],
  );

  /** 保存当前页面 → 同时刷新 index.md 与 log.md（标准的 Ingest 流程后两步）。 */
  const save = useCallback(async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const path = pagePath(draft.kind, slugify(draft.title));
      await bridge.write(path, renderPage(draft));
      // index.md：内容目录，每次写入都要跟着更新
      await bridge.write("index.md", renderIndex(pages));
      // log.md：时间流水，追加一条便于 grep
      await bridge.log("edit", draft.title);
      await reload();
      setSelected(path);
      setMsg({ kind: "ok", text: `已保存 ${path}` });
    } catch (e) {
      setMsg({ kind: "error", text: `保存失败：${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  }, [draft, bridge, pages, reload]);

  /** 新建页面：填标题与类别，正文从空白开始。 */
  const createPage = useCallback(
    (kind: WikiKind) => {
      setDraft({ title: "", kind, body: "" });
      setSelected(null);
      setView("page");
      setMsg(null);
    },
    [],
  );

  const [removeTarget, setRemoveTarget] = useState<string | null>(null);

  const removePage = useCallback((path: string) => {
    setRemoveTarget(path);
  }, []);

  const confirmRemovePage = useCallback(
    async (path: string) => {
      setRemoveTarget(null);
      setBusy(true);
      try {
        await bridge.remove(path);
        await bridge.log("delete", path);
        await reload();
        setSelected(null);
        setDraft(null);
        setView("index");
        setMsg({ kind: "ok", text: `已删除 ${path}` });
      } catch (e) {
        setMsg({ kind: "error", text: `删除失败：${(e as Error).message}` });
      } finally {
        setBusy(false);
      }
    },
    [bridge, reload],
  );

  /** 首次使用：写入 schema.md（已存在则不覆盖——它是人与 LLM 共同演进的文件）。 */
  const initSchema = useCallback(async () => {
    try {
      const existing = await bridge.read("schema.md");
      if (existing == null) {
        await bridge.write("schema.md", DEFAULT_SCHEMA);
        await bridge.log("init", "初始化知识库规约");
        await reload();
      }
      setMsg({ kind: "ok", text: "规约已就绪" });
    } catch (e) {
      setMsg({ kind: "error", text: `初始化失败：${(e as Error).message}` });
    }
  }, [bridge, reload]);

  const current = pages.find((p) => p.path === selected) ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 顶栏：视图切换 + 根目录 + 新建 */}
      <div className="flex flex-wrap items-center gap-2 pb-3">
        <div role="tablist" aria-label="知识库视图" className="flex overflow-hidden rounded-lg border border-line">
          {(Object.keys(VIEW_LABEL) as View[]).map((v, i) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={view === v}
              onClick={() => setView(v)}
              className={`${i > 0 ? "border-l border-line" : ""} px-3 py-1.5 text-[12px] ${
                view === v ? "bg-ink font-bold text-white" : "text-muted hover:bg-[#fafafa]"
              }`}
            >
              {VIEW_LABEL[v]}
            </button>
          ))}
        </div>
        <span className="text-[11px] text-muted">
          {pages.length} 页 · {graph.edges.length} 链接
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <button type="button" onClick={initSchema} className={btnGhost}>
            规约
          </button>
          {WIKI_KINDS.map((k) => (
            <button
              key={k}
              type="button"
              aria-label={`新建${KIND_LABEL[k]}`}
              onClick={() => createPage(k)}
              className={`inline-flex items-center gap-1 ${btnGhost}`}
            >
              <PlusIcon width={11} height={11} aria-hidden="true" />
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>
      </div>

      {ephemeral && (
        <div role="status" className="mb-2 rounded-lg bg-[#fffbeb] px-2.5 py-1.5 text-[11px] text-[#92400e]">
          浏览器临时模式：知识库只存在于当前页面，关掉就没了。桌面端会落成真实 markdown
          文件，可直接用 Obsidian 打开。
        </div>
      )}
      {root && !ephemeral && (
        <div className="mb-2 truncate text-[11px] text-[#aaa]" title={root}>
          目录：{root}
        </div>
      )}
      {msg && (
        <div role="status" className={`mb-2 text-[12px] ${msg.kind === "error" ? "text-red-600" : "text-muted"}`}>
          {msg.text}
        </div>
      )}

      {/* 内容区 */}
      <div className="min-h-0 flex-1">
        {view === "graph" && (
          <WikiGraphView graph={graph} pages={pages} selected={selected} onSelect={openPage} />
        )}

        {view === "index" && (
          <div className="flex h-full flex-col">
            <input
              aria-label="检索知识库"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="按标题、标签或正文过滤"
              className="mb-2 w-full rounded-lg border border-line px-2.5 py-1.5 text-[12px] outline-hidden focus:border-[#bbb]"
            />
            {shown.length === 0 ? (
              <div className="text-[12px] text-muted">
                {query ? "无匹配页面" : "还没有页面。用右上角「新建」新建一页。"}
              </div>
            ) : (
              <ul className="min-h-0 flex-1 overflow-y-auto">
                {shown.map((page) => {
                  const degree = graph.nodes.find((n) => n.id === page.path)?.degree ?? 0;
                  return (
                    <li key={page.path}>
                      <button
                        type="button"
                        onClick={() => openPage(page.path)}
                        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-[#f7f7f7]"
                      >
                        <span className="min-w-0 flex-1 truncate text-[12px] font-medium">
                          {page.title}
                        </span>
                        {page.tags.map((t) => (
                          <span key={t} className="shrink-0 rounded-sm border border-line px-1 text-[10px] text-muted">
                            {t}
                          </span>
                        ))}
                        <span className="shrink-0 text-[10px] text-[#aaa]">
                          {KIND_LABEL[page.kind]} · {degree} 链接
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}

        {view === "page" && (
          <div className="flex h-full min-h-0 flex-col gap-2">
            {draft ? (
              <>
                <div className="flex items-center gap-2">
                  <input
                    aria-label="页面标题"
                    value={draft.title}
                    placeholder="页面标题"
                    onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                    className="min-w-0 flex-1 rounded-lg border border-line px-2.5 py-1.5 text-[13px] font-bold outline-hidden focus:border-[#bbb]"
                  />
                  <select
                    aria-label="页面类别"
                    value={draft.kind}
                    onChange={(e) => setDraft({ ...draft, kind: e.target.value as WikiKind })}
                    className="rounded-lg border border-line px-2 py-1.5 text-[12px] outline-hidden"
                  >
                    {WIKI_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {KIND_LABEL[k]}
                      </option>
                    ))}
                  </select>
                  <button type="button" disabled={busy} onClick={() => void save()} className={btnPrimary}>
                    保存
                  </button>
                  {current && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void removePage(current.path)}
                      className={btnGhost}
                    >
                      删除
                    </button>
                  )}
                </div>
                <div className="text-[11px] text-muted">
                  正文中写 <code className="rounded-sm bg-[#f3f3f3] px-1">[[页面名]]</code> 建立双向链接，
                  保存后可在图谱里看到连接。
                </div>
                <textarea
                  aria-label="页面正文"
                  value={draft.body}
                  placeholder="在这里写内容。用 [[其他页面]] 交叉引用。"
                  onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                  className="min-h-0 flex-1 resize-none rounded-lg border border-line px-2.5 py-2 font-mono text-[12px] leading-relaxed outline-hidden focus:border-[#bbb]"
                />
              </>
            ) : (
              <div className="flex items-center justify-center text-[12px] text-muted">
                从图谱或目录里选一个页面，或用右上角「新建」新建。
              </div>
            )}
          </div>
        )}
      </div>

      {removeTarget && (
        <ConfirmDialog
          title="删除页面"
          onCancel={() => setRemoveTarget(null)}
          footer={
            <>
              <button
                type="button"
                onClick={() => setRemoveTarget(null)}
                className={btnGhost}
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void confirmRemovePage(removeTarget)}
                className="rounded-lg bg-[#b42318] px-3 py-1.5 text-[11px] font-medium text-white"
              >
                删除
              </button>
            </>
          }
        >
          <p className="text-[12px] leading-6">
            删除页面「{removeTarget}」？文件会从本机知识库移除，指向它的 [[双链]] 将变成悬空链接，操作不可撤销。
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}

const btnPrimary = "rounded-lg bg-ink px-3 py-1.5 text-[12px] font-bold text-white disabled:opacity-40";
const btnGhost =
  "rounded-lg border border-line px-2 py-1 text-[11px] text-muted shadow-card hover:bg-[#fafafa]";