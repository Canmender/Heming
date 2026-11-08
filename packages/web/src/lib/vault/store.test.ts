import { describe, expect, it } from "vitest";
import { createMemoryVaultBridge } from "./bridge.js";
import { resetVaultStore, setVaultBridge, useVaultStore } from "./store.js";
import { MAX_TEXT_BYTES, type VaultBridge, type VaultEntry } from "./types.js";

/**
 * vault store：库/文件/索引/编辑动作 + 分片索引 + watch 增量 + 大文件跳过。
 *
 * 用内存桥注入（`setVaultBridge`）跑真实动作链：同一套 store 代码在桌面端换成
 * preload 桥即可，用例不需要 mock 文件系统。
 */

const FILES: Record<string, string> = {
  "index.md": "# 索引\n",
  "a.md": "---\ntags: [甲]\n---\n# A\n[[b]]\n",
  "b.md": "# B\n正文\n",
  "dir/c.md": "无链接 #乙\n",
};

function flush(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function boot(files: Record<string, string> = FILES): Promise<VaultBridge> {
  resetVaultStore();
  const bridge = createMemoryVaultBridge({ files, now: () => 1000 });
  setVaultBridge(bridge);
  await useVaultStore.getState().loadVaults();
  return bridge;
}

describe("store 初始化与索引", () => {
  it("loadVaults 后自动打开第一个库并建好索引", async () => {
    await boot();
    const state = useVaultStore.getState();
    expect(state.vaults).toHaveLength(1);
    expect(state.activeVaultId).toBe("memory");
    expect(state.ephemeral).toBe(true);
    expect(state.indexStatus).toBe("ready");
    expect(state.indexProgress).toBe(1);
    expect(state.indexedCount).toBe(4);
    expect([...(state.index?.pages.keys() ?? [])]).toEqual([
      "a.md",
      "b.md",
      "dir/c.md",
      "index.md",
    ]);
    expect(state.tree.map((entry) => entry.rel)).toContain("dir");
  });

  it("索引分片：构建期间状态是 indexing，结束后进度 1", async () => {
    await boot();
    const store = useVaultStore.getState();
    const building = store.buildIndexNow();
    // buildIndexNow 同步进入 indexing 态
    expect(useVaultStore.getState().indexStatus).toBe("indexing");
    expect(useVaultStore.getState().indexProgress).toBeLessThan(1);
    await building;
    expect(useVaultStore.getState().indexStatus).toBe("ready");
    expect(useVaultStore.getState().indexProgress).toBe(1);
  });

  it("超过 2MB 的 markdown 跳过并计入 skipped", async () => {
    await boot({
      "big.md": "x".repeat(MAX_TEXT_BYTES + 1),
      "small.md": "正文\n",
    });
    const state = useVaultStore.getState();
    expect(state.skipped).toEqual(["big.md"]);
    expect(state.index?.pages.has("big.md")).toBe(false);
    expect(state.index?.pages.has("small.md")).toBe(true);
  });

  it("snapshotDocs 返回全部已读文档（按 rel 排序），记忆层可直接用", async () => {
    await boot();
    const docs = useVaultStore.getState().snapshotDocs();
    expect(docs.map((doc) => doc.rel)).toEqual(["a.md", "b.md", "dir/c.md", "index.md"]);
    expect(docs[0]).toEqual({
      rel: "a.md",
      text: FILES["a.md"],
      mtime: "1970-01-01T00:00:00.000Z",
    });
  });
});

describe("派生查询", () => {
  it("反链 / 出链 / 未解析 / 标签 / 行偏移", async () => {
    await boot();
    const store = useVaultStore.getState();
    expect(store.backlinksOf("b.md").map((link) => link.from)).toEqual(["a.md"]);
    expect(store.outlinksOf("a.md").map((link) => link.resolved)).toEqual(["b.md"]);
    expect(store.unresolvedOf("a.md")).toEqual([]);
    expect(store.tagsOf("a.md")).toEqual([
      { tag: "甲", from: "a.md", line: 0, source: "frontmatter" },
    ]);
    expect(store.tagsOf("dir/c.md")).toEqual([
      { tag: "乙", from: "dir/c.md", line: 1, source: "inline" },
    ]);
    expect(store.lineOffsetOf("a.md")).toBe(3);
    expect(store.lineOffsetOf("b.md")).toBe(0);
  });
});

describe("文件动作", () => {
  it("openFile / editFile / saveFile：脏标记与落盘后索引同步", async () => {
    const bridge = await boot();
    const store = useVaultStore.getState();
    await store.openFile("a.md");
    expect(useVaultStore.getState().activeRel).toBe("a.md");
    expect(useVaultStore.getState().docs.get("a.md")?.text).toBe(FILES["a.md"]);

    store.editFile("a.md", "---\ntags: [甲]\n---\n# A\n[[dir/c]]\n");
    expect(useVaultStore.getState().dirty.has("a.md")).toBe(true);

    expect(await store.saveFile("a.md")).toBe(true);
    const saved = useVaultStore.getState();
    expect(saved.dirty.has("a.md")).toBe(false);
    expect((await bridge.read("memory", "a.md"))?.text).toContain("[[dir/c]]");
    expect(saved.index?.links.find((link) => link.from === "a.md")?.resolved).toBe("dir/c.md");
  });

  it("saveFile 遇到外部修改返回失败并给出中文提示", async () => {
    const bridge = await boot();
    const store = useVaultStore.getState();
    await store.openFile("a.md");
    store.editFile("a.md", "本地修改\n");
    await bridge.write("memory", "a.md", "外部修改\n");
    await flush();

    expect(await store.saveFile("a.md")).toBe(false);
    expect(useVaultStore.getState().error).toContain("外部修改");
    // 未保存的正文没有被外部版本覆盖
    expect(useVaultStore.getState().docs.get("a.md")?.text).toBe("本地修改\n");
  });

  it("closeFile 有脏标记时拒绝，force 才关；activeRel 回退到上一个 tab", async () => {
    await boot();
    const store = useVaultStore.getState();
    await store.openFile("a.md");
    await store.openFile("b.md");
    store.editFile("b.md", "改过\n");
    store.closeFile("b.md");
    expect(useVaultStore.getState().error).toContain("未保存");
    expect(useVaultStore.getState().openFiles).toEqual(["a.md", "b.md"]);

    useVaultStore.getState().closeFile("b.md", { force: true });
    expect(useVaultStore.getState().openFiles).toEqual(["a.md"]);
    expect(useVaultStore.getState().activeRel).toBe("a.md");
  });

  it("createFile / renameFile / deleteFile 同步树、索引与打开页", async () => {
    const bridge = await boot();
    const store = useVaultStore.getState();

    expect(await store.createFile("inbox/新笔记.md", "# 新\n")).toBe(true);
    let state = useVaultStore.getState();
    expect(state.openFiles).toContain("inbox/新笔记.md");
    expect(state.activeRel).toBe("inbox/新笔记.md");
    expect(state.index?.pages.has("inbox/新笔记.md")).toBe(true);
    expect(state.tree.map((entry) => entry.rel)).toContain("inbox");

    expect(await store.renameFile("inbox/新笔记.md", "inbox/改名.md")).toBe(true);
    state = useVaultStore.getState();
    expect(state.openFiles).toContain("inbox/改名.md");
    expect(state.index?.pages.has("inbox/新笔记.md")).toBe(false);
    expect(state.index?.pages.has("inbox/改名.md")).toBe(true);
    expect((await bridge.read("memory", "inbox/改名.md"))?.text).toBe("# 新\n");

    expect(await store.deleteFile("inbox/改名.md")).toBe(true);
    state = useVaultStore.getState();
    expect(state.openFiles).not.toContain("inbox/改名.md");
    expect(state.index?.pages.has("inbox/改名.md")).toBe(false);
    expect(state.activeRel).toBeNull();
  });

  it("createFile 重名失败，deleteFile 不删目录", async () => {
    await boot();
    const store = useVaultStore.getState();
    expect(await store.createFile("a.md", "x")).toBe(false);
    expect(useVaultStore.getState().error).toContain("已存在");
    expect(await store.deleteFile("dir")).toBe(false);
  });

  it("setMode / setActiveRel", async () => {
    await boot();
    const store = useVaultStore.getState();
    store.setMode("read");
    store.setActiveRel("./b.md");
    expect(useVaultStore.getState().mode).toBe("read");
    expect(useVaultStore.getState().activeRel).toBe("b.md");
  });
});

describe("watch 增量与全量重建", () => {
  it("watch 事件触发增量重算（新双链立刻可解析）", async () => {
    const bridge = await boot();
    await bridge.write("memory", "a.md", "# A\n[[dir/c]]\n");
    await flush();

    const state = useVaultStore.getState();
    expect(state.indexStatus).toBe("ready");
    expect(state.index?.links.find((link) => link.from === "a.md")?.resolved).toBe("dir/c.md");
  });

  it("一次超过 200 个变化改全量重建", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 205; i += 1) files[`n${i}.md`] = `第 ${i} 篇\n`;
    await boot(files);
    const before = useVaultStore.getState().index;
    expect(before?.pages.size).toBe(205);

    await useVaultStore.getState().reindexPaths(Object.keys(files));
    const after = useVaultStore.getState();
    expect(after.indexStatus).toBe("ready");
    expect(after.indexedCount).toBe(205);
    expect(after.index).not.toBe(before);
  });

  it("reindexPaths 支持文件被删除（从索引里移除）", async () => {
    const bridge = await boot();
    await bridge.delete("memory", "b.md");
    await useVaultStore.getState().reindexPaths(["b.md"]);
    const state = useVaultStore.getState();
    expect(state.index?.pages.has("b.md")).toBe(false);
    expect(state.backlinksOf("b.md")).toEqual([]);
  });
});

describe("分片与缓存清理", () => {
  it("分片索引：构建期间进度多次推进，最终到 1", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 300; i += 1) {
      files[`bulk/n${i}.md`] = `# 第 ${i} 篇\n[[bulk/n${(i + 1) % 300}]]\n`;
    }
    await boot(files);
    const progress: number[] = [];
    const unsubscribe = useVaultStore.subscribe((state) => {
      if (state.indexStatus === "indexing") progress.push(state.indexProgress);
    });
    await useVaultStore.getState().buildIndexNow();
    unsubscribe();
    expect(useVaultStore.getState().indexedCount).toBe(300);
    // 300 / 32 ≈ 10 批：进度至少推进两次，说明确实分片而不是一次性算完
    expect(progress.length).toBeGreaterThan(1);
    expect(progress[progress.length - 1]).toBeLessThanOrEqual(0.99);
    expect(useVaultStore.getState().indexProgress).toBe(1);
  });

  it("全量重建清理已删除文件的文档缓存（记忆层不会拿到幽灵笔记）", async () => {
    const bridge = await boot();
    await bridge.delete("memory", "b.md");
    await useVaultStore.getState().buildIndexNow();
    const state = useVaultStore.getState();
    expect(state.index?.pages.has("b.md")).toBe(false);
    expect(state.snapshotDocs().map((doc) => doc.rel)).not.toContain("b.md");
  });
});

describe("多库", () => {
  it("pickVault 切到新库，setActiveVault 切回原库", async () => {
    await boot();
    const store = useVaultStore.getState();
    await store.pickVault();
    let state = useVaultStore.getState();
    expect(state.vaults).toHaveLength(2);
    expect(state.activeVaultId).toBe("memory-2");
    expect(state.indexedCount).toBe(0);

    await state.setActiveVault("memory");
    state = useVaultStore.getState();
    expect(state.activeVaultId).toBe("memory");
    expect(state.indexedCount).toBe(4);
  });

  it("removeVault 移除最后一个库后清空状态", async () => {
    await boot();
    await useVaultStore.getState().removeVault("memory");
    const state = useVaultStore.getState();
    expect(state.vaults).toEqual([]);
    expect(state.activeVaultId).toBeNull();
    expect(state.tree).toEqual([]);
    expect(state.index).toBeNull();
    expect(state.indexStatus).toBe("idle");
  });

  it("浏览器降级：无注入桥时 resolveVaultBridge 的内存库可用", async () => {
    resetVaultStore();
    await useVaultStore.getState().loadVaults();
    const state = useVaultStore.getState();
    expect(state.ephemeral).toBe(true);
    expect(state.activeVaultId).toBe("memory");
    expect(state.indexStatus).toBe("ready");
  });
});

describe("树懒加载与新建目录", () => {
  const NESTED: Record<string, string> = {
    "a.md": "A\n",
    "dir/b.md": "B\n",
    "dir/deep/c.md": "C\n",
    "dir/deep/deeper/d.md": "D\n",
  };

  function shallowDir(rel: string): VaultEntry {
    return { rel, name: rel.slice(rel.lastIndexOf("/") + 1), kind: "dir", size: 0, mtime: "" };
  }

  it("loadTreeDir 只合并目标目录一层，并保留已加载的更深层 children", async () => {
    await boot(NESTED);
    // 模拟界面还没展开：树里只有 dir 节点、没有 children
    useVaultStore.setState({ tree: [shallowDir("dir")] });
    await useVaultStore.getState().loadTreeDir("dir");

    let tree = useVaultStore.getState().tree;
    expect(tree.map((entry) => entry.rel)).toEqual(["dir"]);
    expect(tree[0].children?.map((entry) => entry.rel)).toEqual(["dir/deep", "dir/b.md"]);

    // 再展开 deep：父层已加载的条目不能丢
    await useVaultStore.getState().loadTreeDir("dir/deep");
    tree = useVaultStore.getState().tree;
    expect(tree[0].children?.map((entry) => entry.rel)).toEqual(["dir/deep", "dir/b.md"]);
    expect(tree[0].children?.[0].children?.map((entry) => entry.rel)).toEqual([
      "dir/deep/deeper",
      "dir/deep/c.md",
    ]);

    // 重新展开父目录（重新拉一层）时，deep 已加载的 children 必须保留
    await useVaultStore.getState().loadTreeDir("dir");
    tree = useVaultStore.getState().tree;
    expect(tree[0].children?.[0].children?.map((entry) => entry.rel)).toEqual([
      "dir/deep/deeper",
      "dir/deep/c.md",
    ]);
  });

  it("loadTreeDir('') 合并根层；树里没有的目录回退整树刷新", async () => {
    await boot(NESTED);
    useVaultStore.setState({ tree: [] });
    await useVaultStore.getState().loadTreeDir("");
    expect(useVaultStore.getState().tree.map((entry) => entry.rel)).toEqual(["dir", "a.md"]);

    useVaultStore.setState({ tree: [] });
    await useVaultStore.getState().loadTreeDir("dir");
    expect(useVaultStore.getState().tree.length).toBeGreaterThan(0);
    expect(useVaultStore.getState().error).toBeNull();
  });

  it("createDir 多级建目录并合并进现有树（父目录已加载时不整树刷新）", async () => {
    const bridge = await boot(NESTED);
    useVaultStore.setState({ tree: [shallowDir("dir")] });

    expect(await useVaultStore.getState().createDir("dir/新目录")).toBe(true);
    const tree = useVaultStore.getState().tree;
    // 目录优先 + 名称码点序：deep 在 新目录 之前
    expect(tree[0].children?.map((entry) => entry.rel)).toEqual([
      "dir/deep",
      "dir/新目录",
      "dir/b.md",
    ]);
    // 空目录在内存桥里也能读到
    expect((await bridge.tree("memory", { rel: "dir/新目录", depth: 1 }))).toEqual([]);

    // 幂等：再建一次仍成功，树里不出现重复节点
    expect(await useVaultStore.getState().createDir("dir/新目录")).toBe(true);
    expect(
      useVaultStore.getState().tree[0].children?.filter((entry) => entry.rel === "dir/新目录"),
    ).toHaveLength(1);
  });

  it("createDir 根层目录与非法路径", async () => {
    await boot(NESTED);
    useVaultStore.setState({ tree: [] });
    expect(await useVaultStore.getState().createDir("新目录/子目录")).toBe(true);
    expect(useVaultStore.getState().tree.map((entry) => entry.rel)).toContain("新目录");

    expect(await useVaultStore.getState().createDir("../越界")).toBe(false);
    expect(useVaultStore.getState().error).toContain("..");
    expect(await useVaultStore.getState().createDir("")).toBe(false);
    expect(useVaultStore.getState().error).toContain("不能为空");
  });
});
