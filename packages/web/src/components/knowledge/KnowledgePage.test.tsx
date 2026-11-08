import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { VaultDoc, VaultEntry, VaultMeta } from "../../lib/vault/types.js";
import { KnowledgePage, type KnowledgeStore } from "./KnowledgePage.js";
import type { EditorLoader } from "./EditorPane.js";
import { makeIndex, pageInfo, wikiLink } from "./testFixtures.js";

const MTIME = "2026-11-08T08:00:00.000Z";

const vault: VaultMeta = {
  id: "v1",
  name: "我的库",
  root: "D:/Notes",
  writeDirs: ["inbox"],
  addedAt: MTIME,
};

const tree: VaultEntry[] = [
  {
    rel: "notes",
    name: "notes",
    kind: "dir",
    size: 0,
    mtime: MTIME,
    children: [
      { rel: "notes/source.md", name: "source.md", kind: "md", size: 20, mtime: MTIME },
      { rel: "notes/other.md", name: "other.md", kind: "md", size: 10, mtime: MTIME },
    ],
  },
  { rel: "root.md", name: "root.md", kind: "md", size: 5, mtime: MTIME },
];

const doc: VaultDoc = {
  vaultId: "v1",
  rel: "notes/source.md",
  text: "# 来源\n\n预算与结论",
  mtime: MTIME,
  size: 20,
};

function sampleIndex() {
  return makeIndex(
    [
      pageInfo({
        rel: "notes/source.md",
        tags: ["项目"],
        headings: [{ level: 1, text: "来源", line: 1 }],
        frontmatter: { title: "来源页" },
        body: "# 来源\n\n预算与结论",
      }),
      pageInfo({ rel: "notes/other.md", body: "预算另一处提及" }),
      pageInfo({ rel: "notes/a.md", body: "链接到 [[source]]" }),
    ],
    [wikiLink({ target: "source", from: "notes/a.md", resolved: "notes/source.md" })],
  );
}

/** 假 store：只实现界面用到的那部分，状态字段真实、动作是 spy。 */
function fakeStore(over: Partial<KnowledgeStore> = {}): KnowledgeStore {
  const base: KnowledgeStore = {
    vaults: [vault],
    activeVaultId: "v1",
    tree,
    index: sampleIndex(),
    indexStatus: "ready",
    indexProgress: 1,
    openFiles: ["notes/source.md"],
    activeRel: "notes/source.md",
    mode: "split",
    docs: new Map([["notes/source.md", doc]]),
    dirty: new Set<string>(),
    error: null,
    ephemeral: false,
    loadVaults: vi.fn(async () => {}),
    pickVault: vi.fn(async () => {}),
    removeVault: vi.fn(async () => {}),
    setActiveVault: vi.fn(async () => {}),
    refreshTree: vi.fn(async () => {}),
    openFile: vi.fn(async () => {}),
    closeFile: vi.fn(),
    setActiveRel: vi.fn(),
    setMode: vi.fn(),
    editFile: vi.fn(),
    saveFile: vi.fn(async () => true),
    createFile: vi.fn(async () => true),
    renameFile: vi.fn(async () => true),
    deleteFile: vi.fn(async () => true),
    buildIndexNow: vi.fn(async () => {}),
    reindexPaths: vi.fn(async () => {}),
    subscribeWatch: vi.fn(() => () => {}),
    backlinksOf: vi.fn((rel: string) =>
      rel === "notes/source.md"
        ? [wikiLink({ target: "source", from: "notes/a.md", line: 3, resolved: "notes/source.md" })]
        : [],
    ),
    outlinksOf: vi.fn(() => []),
    unresolvedOf: vi.fn(() => []),
    tagsOf: vi.fn(() => []),
    snapshotDocs: vi.fn(() => []),
    lineOffsetOf: vi.fn(() => 0),
    readText: vi.fn(async () => null),
    ...over,
  };
  return base;
}

/** 假编辑器：jsdom 不加载真 CodeMirror。 */
const fakeLoader: EditorLoader = vi.fn(async (_host: HTMLElement, options) => ({
  getValue: () => options.doc,
  setValue: vi.fn(),
  focus: vi.fn(),
  destroy: vi.fn(),
}));

function renderPage(over: Partial<KnowledgeStore> = {}) {
  const store = fakeStore(over);
  const view = render(<KnowledgePage store={store} editorLoader={fakeLoader} />);
  return { store, view };
}

describe("知识库页 · 空库与降级", () => {
  it("空库态：给「打开本地库」与「数据不出设备」说明", () => {
    const { store } = renderPage({ vaults: [], activeVaultId: null, index: null, openFiles: [], activeRel: null, docs: new Map() });
    expect(screen.getByRole("heading", { name: "知识库" })).toBeInTheDocument();
    expect(screen.getByText(/不会上传/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "打开本地库" }));
    expect(store.pickVault).toHaveBeenCalled();
  });

  it("浏览器临时模式：页面顶部显式提示数据只在当前页面", () => {
    renderPage({ ephemeral: true });
    expect(screen.getAllByText(/浏览器临时模式/).length).toBeGreaterThan(0);
  });

  it("store 错误原样显示（不自己编文案）", () => {
    renderPage({ error: "文件已被外部修改，请先对比再保存" });
    expect(screen.getByRole("alert")).toHaveTextContent("文件已被外部修改，请先对比再保存");
  });
});

describe("知识库页 · 三栏装配", () => {
  it("左/中/右三栏都在，标签页显示已打开文件", async () => {
    renderPage();
    expect(screen.getByTestId("knowledge-left")).toBeInTheDocument();
    expect(screen.getByTestId("knowledge-center")).toBeInTheDocument();
    expect(screen.getByTestId("knowledge-right")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /source\.md/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("vault-editor-host")).toBeInTheDocument());
  });

  it("文件树点其它文件 → 打开", async () => {
    const { store } = renderPage();
    fireEvent.click(screen.getByRole("treeitem", { name: /other\.md/ }));
    await waitFor(() => expect(store.openFile).toHaveBeenCalledWith("notes/other.md"));
  });

  it("三态切换按钮写入 store.mode", () => {
    const { store } = renderPage();
    fireEvent.click(screen.getByRole("button", { name: "源码" }));
    expect(store.setMode).toHaveBeenCalledWith("source");
    fireEvent.click(screen.getByRole("button", { name: "阅读" }));
    expect(store.setMode).toHaveBeenCalledWith("read");
  });

  it("右栏反链来自 store，点反链来源打开来源页", () => {
    const { store } = renderPage();
    expect(screen.getByText("notes/a.md")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /打开反链来源 notes\/a\.md/ }));
    expect(store.openFile).toHaveBeenCalledWith("notes/a.md");
  });

  it("收起右栏后右栏消失，再展开回来", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "折叠右侧面板" }));
    expect(screen.queryByTestId("knowledge-right")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "展开右侧面板" }));
    expect(screen.getByTestId("knowledge-right")).toBeInTheDocument();
  });

  it("图谱视图：点「图谱」切到图谱面板", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "图谱" }));
    expect(screen.getByText(/节点大小按全库度数/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "图谱" }));
    expect(screen.queryByText(/节点大小按全库度数/)).not.toBeInTheDocument();
  });

  it("库切换与打开其它库/移除库入口", () => {
    const { store } = renderPage();
    expect(screen.getByLabelText("切换知识库")).toHaveValue("v1");
    fireEvent.click(screen.getByRole("button", { name: "打开其它库" }));
    expect(store.pickVault).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /移除知识库 我的库/ }));
    expect(screen.getByRole("dialog", { name: "移除知识库 我的库" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "移除" }));
    expect(store.removeVault).toHaveBeenCalledWith("v1");
  });
});

describe("知识库页 · 搜索与标签", () => {
  it("搜索页签：输入关键词出结果，点结果打开对应文件", async () => {
    const { store } = renderPage();
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    fireEvent.change(screen.getByLabelText("搜索知识库"), { target: { value: "预算" } });
    const hitButton = await screen.findByRole("button", { name: /打开 notes\/other\.md 第/ });
    fireEvent.click(hitButton);
    expect(store.openFile).toHaveBeenCalledWith("notes/other.md");
  });

  it("标签页签：点标签后切回文件列表并按标签过滤", () => {
    const { store } = renderPage();
    fireEvent.click(screen.getByRole("button", { name: "标签" }));
    fireEvent.click(screen.getByRole("button", { name: "按标签 项目 过滤（1 篇）" }));
    // 切回文件页签后是过滤结果
    expect(screen.getByText(/标签 #项目/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "notes/source.md" })).toBeInTheDocument();
    expect(store.index).not.toBeNull();
  });
});

describe("知识库页 · 未保存拦截", () => {
  it("切文件时提示：保存并切换 → 先 saveFile 再 openFile", async () => {
    const { store } = renderPage({ dirty: new Set(["notes/source.md"]) });
    fireEvent.click(screen.getByRole("treeitem", { name: /other\.md/ }));
    expect(screen.getByRole("dialog", { name: "有未保存的修改" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "保存并切换" }));
    await waitFor(() => expect(store.saveFile).toHaveBeenCalledWith("notes/source.md"));
    await waitFor(() => expect(store.openFile).toHaveBeenCalledWith("notes/other.md"));
  });

  it("切文件时提示：不保存 → 直接切换", async () => {
    const { store } = renderPage({ dirty: new Set(["notes/source.md"]) });
    fireEvent.click(screen.getByRole("treeitem", { name: /other\.md/ }));
    fireEvent.click(screen.getByRole("button", { name: "不保存" }));
    await waitFor(() => expect(store.openFile).toHaveBeenCalledWith("notes/other.md"));
    expect(store.saveFile).not.toHaveBeenCalled();
  });

  it("关标签时提示：保存失败就停住（不关闭）", async () => {
    const { store } = renderPage({
      dirty: new Set(["notes/source.md"]),
      saveFile: vi.fn(async () => false),
    });
    fireEvent.click(screen.getByRole("button", { name: "关闭标签 source.md" }));
    fireEvent.click(screen.getByRole("button", { name: "保存并关闭" }));
    await waitFor(() => expect(store.saveFile).toHaveBeenCalledWith("notes/source.md"));
    expect(store.closeFile).not.toHaveBeenCalled();
  });
});
