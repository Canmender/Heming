/**
 * 知识库的共享运行态（zustand）：多库、目录树、打开的文件页、编辑态、索引。
 *
 * 为什么状态要放 store 而不是页面 useState：左栏文件树、中间编辑器、右栏反链/标签、
 * 图谱页、智能体工具、记忆层都要读同一份索引与同一份文档缓存；页面级状态会让
 * 任一处改动都要靠 prop 传递，且「索引好了没有」没法跨页共享。
 *
 * 索引策略（规格 §10 风险表）：
 * - 首屏先读目录树，索引在后台**分片**跑（每批 32 个文件，批间让出主线程），
 *   `indexProgress` 可见；
 * - watch 事件走增量：只重读变化的文件并重算链接表；一次超过 200 个变化改全量重建；
 * - 大于 2MB 的文件跳过并记进 `skipped`；
 * - 浏览器无桌面桥时走内存桥，界面按 `ephemeral` 显示「临时模式」。
 *
 * 确定性：索引与派生查询都是纯函数；store 自己不用随机、不用时间参与排序
 * （mtime 只来自文件本身）。
 */

import { create } from "zustand";
import { describeVaultError, isVaultEphemeral, resolveVaultBridge, toVaultBridgeError } from "./bridge.js";
import {
  buildVaultIndexFromParsed,
  isMarkdownRel,
  normalizeRel,
  parseDocWithOffset,
  tagRefsOf,
  type ParsedVaultDoc,
} from "./index.js";
import { extractInlineTags, frontmatterTags, parseFrontmatter } from "./parse.js";
import {
  MAX_TEXT_BYTES,
  type EditorMode,
  type TagRef,
  type VaultBridge,
  type VaultDoc,
  type VaultEntry,
  type VaultId,
  type VaultIndex,
  type VaultMeta,
  type VaultStoreApi,
  type WikiLink,
} from "./types.js";

/** 一次 watch 批量里超过这个文件数就改全量重建（规格 §10：单次最多重算 200 个）。 */
export const REINDEX_INCREMENTAL_MAX = 200;

/** 索引分片的批大小：太大首屏会卡，太小 IO 次数太多。 */
export const INDEX_BATCH_SIZE = 32;

/** 目录树读取深度：足够覆盖个人库的常见层级（懒加载由界面按目录再做）。 */
const TREE_DEPTH = 64;

/** store 公开面：契约（VaultStoreApi）+ 本实现额外暴露的状态/派生。 */
export interface VaultState extends VaultStoreApi {
  /** 索引时跳过的文件（超过 2MB 或读失败），界面可提示。 */
  skipped: string[];
  /** 索引覆盖的文档数（`index.pages.size` 的镜像，避免界面为它重算）。 */
  indexedCount: number;
  /** 某个页面 frontmatter 占用的行数（搜索命中行号还原用）。 */
  lineOffsetOf(rel: string): number;
  /** 读文件正文（优先文档缓存，其次桥；不存在返回 null）。工具层与预览用。 */
  readText(rel: string): Promise<string | null>;
  /** 智能体写通道：走 `vault:apply`（仅 writeDirs 内），写后增量重算。 */
  applyWrite(rel: string, text: string, mode?: "overwrite" | "append"): Promise<boolean>;
}

/* ------------------------------------------------------------------ 模块级内部状态 */

let bridgeOverride: VaultBridge | undefined;
let resolvedBridge: VaultBridge | null = null;
/** 已解析文档（含 frontmatter 偏移）：增量重算只更新变化的条目。 */
let parsedPages = new Map<string, ParsedVaultDoc>();
/** rel → 文档缓存（打开的文件 + 索引覆盖的 md 都在这里，记忆层/工具层取快照用）。 */
let docsCache = new Map<string, VaultDoc>();
let unsubWatch: (() => void) | null = null;
/** 索引代数：新构建开始后，旧的异步批直接放弃，避免互相覆盖。 */
let indexGeneration = 0;

function getBridge(): VaultBridge {
  if (bridgeOverride) return bridgeOverride;
  resolvedBridge ??= resolveVaultBridge();
  return resolvedBridge;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** 批间让出主线程：有 requestIdleCallback 就用它，否则退到 setTimeout。 */
function yieldToIdle(): Promise<void> {
  return new Promise((resolve) => {
    const idle = (
      globalThis as {
        requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
      }
    ).requestIdleCallback;
    if (typeof idle === "function") idle(() => resolve(), { timeout: 50 });
    else setTimeout(resolve, 0);
  });
}

/** 把目录树拍平成条目列表（深度优先，顺序由树本身决定）。 */
function flattenTree(entries: VaultEntry[]): VaultEntry[] {
  const out: VaultEntry[] = [];
  const walk = (list: VaultEntry[]): void => {
    for (const entry of list) {
      out.push(entry);
      if (entry.children) walk(entry.children);
    }
  };
  walk(entries);
  return out;
}

/** 清空与当前库绑定的内部缓存（切库/重置时用）。 */
function clearVaultCaches(): void {
  parsedPages = new Map();
  docsCache = new Map();
  if (unsubWatch) {
    unsubWatch();
    unsubWatch = null;
  }
}

/** 测试/嵌入钩子：注入桥（null = 恢复自动解析）。 */
export function setVaultBridge(bridge: VaultBridge | null): void {
  bridgeOverride = bridge ?? undefined;
  resolvedBridge = null;
}

/** 重置 store 与内部缓存（用例之间隔离；界面不会调用）。 */
export function resetVaultStore(): void {
  indexGeneration += 1;
  clearVaultCaches();
  bridgeOverride = undefined;
  resolvedBridge = null;
  useVaultStore.setState({
    vaults: [],
    activeVaultId: null,
    tree: [],
    index: null,
    indexStatus: "idle",
    indexProgress: 0,
    openFiles: [],
    activeRel: null,
    mode: "split",
    docs: new Map(),
    dirty: new Set(),
    error: null,
    ephemeral: isVaultEphemeral(),
    skipped: [],
    indexedCount: 0,
  });
}

/* ------------------------------------------------------------------ store */

export const useVaultStore = create<VaultState>((set, get) => {
  /** 读一个文档；超过 2MB 记进 skipped 并返回 null。 */
  const readDoc = async (
    vaultId: VaultId,
    rel: string,
    skipped: string[],
  ): Promise<VaultDoc | null> => {
    const dirty = get().dirty;
    if (dirty.has(rel)) {
      const cached = docsCache.get(rel);
      if (cached) return cached; // 保留用户未保存的正文
    }
    try {
      return await getBridge().read(vaultId, rel);
    } catch (err) {
      const normalized = toVaultBridgeError(err);
      if (normalized.code === "too-large") {
        skipped.push(rel);
        return null;
      }
      if (normalized.code === "not-found" || normalized.code === "forbidden-ext") return null;
      throw normalized;
    }
  };

  return {
    /* 状态 */
    vaults: [],
    activeVaultId: null,
    tree: [],
    index: null,
    indexStatus: "idle",
    indexProgress: 0,
    openFiles: [],
    activeRel: null,
    mode: "split",
    docs: new Map(),
    dirty: new Set(),
    error: null,
    ephemeral: isVaultEphemeral(),
    skipped: [],
    indexedCount: 0,

    /* 库 */
    loadVaults: async () => {
      try {
        const vaults = await getBridge().list();
        set({ vaults, ephemeral: isVaultEphemeral(), error: null });
        const { activeVaultId } = get();
        const stillThere = vaults.some((vault) => vault.id === activeVaultId);
        if ((!activeVaultId || !stillThere) && vaults.length) {
          await get().setActiveVault(vaults[0].id);
        }
      } catch (err) {
        set({ error: describeVaultError(err) });
      }
    },

    pickVault: async () => {
      try {
        const meta = await getBridge().pick();
        if (!meta) return; // 用户取消
        await get().loadVaults();
        await get().setActiveVault(meta.id);
      } catch (err) {
        set({ error: describeVaultError(err) });
      }
    },

    removeVault: async (id) => {
      try {
        await getBridge().remove(id);
        await get().loadVaults();
        if (get().activeVaultId !== id) return;
        const rest = get().vaults;
        if (rest.length) {
          await get().setActiveVault(rest[0].id);
          return;
        }
        clearVaultCaches();
        set({
          activeVaultId: null,
          tree: [],
          index: null,
          indexStatus: "idle",
          indexProgress: 0,
          openFiles: [],
          activeRel: null,
          docs: new Map(),
          dirty: new Set(),
          skipped: [],
          indexedCount: 0,
          error: null,
        });
      } catch (err) {
        set({ error: describeVaultError(err) });
      }
    },

    setActiveVault: async (id) => {
      const vault = get().vaults.find((item) => item.id === id);
      if (!vault) {
        set({ error: "知识库不存在或已被移除。" });
        return;
      }
      clearVaultCaches();
      indexGeneration += 1;
      set({
        activeVaultId: id,
        tree: [],
        index: null,
        indexStatus: "idle",
        indexProgress: 0,
        openFiles: [],
        activeRel: null,
        docs: new Map(),
        dirty: new Set(),
        skipped: [],
        indexedCount: 0,
        error: null,
      });
      await get().buildIndexNow();
      get().subscribeWatch();
    },

    /* 文件 */
    refreshTree: async () => {
      const { activeVaultId } = get();
      if (!activeVaultId) {
        set({ tree: [] });
        return;
      }
      try {
        const tree = await getBridge().tree(activeVaultId, { depth: TREE_DEPTH });
        set({ tree, error: null });
      } catch (err) {
        set({ error: describeVaultError(err) });
      }
    },

    openFile: async (rel) => {
      const key = normalizeRel(rel);
      const { activeVaultId } = get();
      if (!activeVaultId || !key) return;
      try {
        if (!docsCache.has(key)) {
          const doc = await getBridge().read(activeVaultId, key);
          if (!doc) {
            set({ error: `找不到文件：${key}。` });
            return;
          }
          docsCache.set(key, doc);
        }
        const openFiles = get().openFiles.includes(key)
          ? get().openFiles
          : [...get().openFiles, key];
        set({ openFiles, activeRel: key, docs: new Map(docsCache), error: null });
      } catch (err) {
        set({ error: describeVaultError(err) });
      }
    },

    closeFile: (rel, opts) => {
      const key = normalizeRel(rel);
      if (get().dirty.has(key) && !opts?.force) {
        set({ error: "这个文件有未保存的修改，先保存或强制关闭。" });
        return;
      }
      const openFiles = get().openFiles.filter((item) => item !== key);
      const activeRel =
        get().activeRel === key ? (openFiles[openFiles.length - 1] ?? null) : get().activeRel;
      set({ openFiles, activeRel, error: null });
    },

    setActiveRel: (rel) => {
      set({ activeRel: normalizeRel(rel) });
    },

    setMode: (mode) => {
      set({ mode });
    },

    editFile: (rel, text) => {
      const key = normalizeRel(rel);
      const prev = docsCache.get(key);
      const doc: VaultDoc = {
        vaultId: prev?.vaultId ?? get().activeVaultId ?? "",
        rel: key,
        text,
        mtime: prev?.mtime ?? "",
        size: byteLength(text),
      };
      docsCache.set(key, doc);
      const dirty = new Set(get().dirty);
      dirty.add(key);
      set({ docs: new Map(docsCache), dirty });
    },

    saveFile: async (rel) => {
      const key = normalizeRel(rel);
      const { activeVaultId } = get();
      const doc = docsCache.get(key);
      if (!activeVaultId || !doc) {
        set({ error: "文件还没加载，无法保存。" });
        return false;
      }
      try {
        const result = await getBridge().write(
          activeVaultId,
          key,
          doc.text,
          doc.mtime ? { expectMtime: doc.mtime } : undefined,
        );
        const next: VaultDoc = { ...doc, mtime: result.mtime, size: result.bytes };
        docsCache.set(key, next);
        const dirty = new Set(get().dirty);
        dirty.delete(key);
        set({ docs: new Map(docsCache), dirty, error: null });
        await get().reindexPaths([key]);
        return true;
      } catch (err) {
        set({ error: describeVaultError(err) });
        return false;
      }
    },

    createFile: async (rel, text) => {
      const key = normalizeRel(rel);
      const { activeVaultId } = get();
      if (!activeVaultId) {
        set({ error: "还没有打开知识库。" });
        return false;
      }
      try {
        await getBridge().create(activeVaultId, key, text ?? "");
        await get().refreshTree();
        await get().reindexPaths([key]);
        await get().openFile(key);
        return true;
      } catch (err) {
        set({ error: describeVaultError(err) });
        return false;
      }
    },

    renameFile: async (from, to) => {
      const source = normalizeRel(from);
      const target = normalizeRel(to);
      const { activeVaultId } = get();
      if (!activeVaultId) {
        set({ error: "还没有打开知识库。" });
        return false;
      }
      try {
        const moved = await getBridge().move(activeVaultId, source, target);
        if (!moved) {
          set({ error: `重命名失败：${source} → ${target}（目标已存在或源文件不存在）。` });
          return false;
        }
        const doc = docsCache.get(source);
        docsCache.delete(source);
        if (doc) docsCache.set(target, { ...doc, rel: target });
        parsedPages.delete(source);
        const dirty = new Set(get().dirty);
        if (dirty.delete(source)) dirty.add(target);
        const openFiles = get().openFiles.map((item) => (item === source ? target : item));
        const activeRel = get().activeRel === source ? target : get().activeRel;
        set({ openFiles, activeRel, docs: new Map(docsCache), dirty, error: null });
        await get().refreshTree();
        await get().reindexPaths([source, target]);
        return true;
      } catch (err) {
        set({ error: describeVaultError(err) });
        return false;
      }
    },

    deleteFile: async (rel) => {
      const key = normalizeRel(rel);
      const { activeVaultId } = get();
      if (!activeVaultId) {
        set({ error: "还没有打开知识库。" });
        return false;
      }
      try {
        const removed = await getBridge().delete(activeVaultId, key);
        if (!removed) {
          set({ error: `删除失败：${key}（只支持删除单个文件，不支持目录）。` });
          return false;
        }
        docsCache.delete(key);
        parsedPages.delete(key);
        const dirty = new Set(get().dirty);
        dirty.delete(key);
        const openFiles = get().openFiles.filter((item) => item !== key);
        const activeRel =
          get().activeRel === key ? (openFiles[openFiles.length - 1] ?? null) : get().activeRel;
        set({ openFiles, activeRel, docs: new Map(docsCache), dirty, error: null });
        await get().refreshTree();
        await get().reindexPaths([key]);
        return true;
      } catch (err) {
        set({ error: describeVaultError(err) });
        return false;
      }
    },

    /* 索引 */
    buildIndexNow: async () => {
      const { activeVaultId } = get();
      if (!activeVaultId) {
        set({ indexStatus: "idle", indexProgress: 0, index: null });
        return;
      }
      const generation = ++indexGeneration;
      parsedPages = new Map();
      set({ indexStatus: "indexing", indexProgress: 0, index: null, error: null, skipped: [] });
      try {
        await get().refreshTree();
        if (generation !== indexGeneration) return;

        const entries = flattenTree(get().tree);
        const sizes = new Map<string, number>();
        for (const entry of entries) if (entry.kind !== "dir") sizes.set(entry.rel, entry.size);
        const rels = entries
          .filter((entry) => entry.kind !== "dir" && isMarkdownRel(entry.rel))
          .map((entry) => entry.rel)
          .sort(compareText);

        const skipped: string[] = [];
        for (let start = 0; start < rels.length; start += INDEX_BATCH_SIZE) {
          const batch = rels.slice(start, start + INDEX_BATCH_SIZE);
          for (const rel of batch) {
            if (generation !== indexGeneration) return;
            const knownSize = sizes.get(rel);
            if (knownSize !== undefined && knownSize > MAX_TEXT_BYTES) {
              skipped.push(rel);
              continue;
            }
            const doc = await readDoc(activeVaultId, rel, skipped);
            if (!doc) continue;
            parsedPages.set(
              doc.rel,
              parseDocWithOffset({ rel: doc.rel, text: doc.text, mtime: doc.mtime }),
            );
            docsCache.set(doc.rel, doc);
          }
          await yieldToIdle();
          if (generation !== indexGeneration) return;
          set({
            indexProgress: rels.length
              ? Math.min(0.99, (start + batch.length) / rels.length)
              : 0.99,
            skipped: [...skipped].sort(compareText),
          });
        }
        if (generation !== indexGeneration) return;
        const index = buildVaultIndexFromParsed([...parsedPages.values()]);
        // 清理「已不在库里的 markdown」缓存：否则被外部删掉的笔记会通过
        // snapshotDocs 继续喂给记忆层，等于把死文件当活笔记。
        const dirty = get().dirty;
        for (const rel of [...docsCache.keys()]) {
          if (!isMarkdownRel(rel)) continue;
          if (parsedPages.has(rel) || dirty.has(rel)) continue;
          docsCache.delete(rel);
        }
        set({
          index,
          indexStatus: "ready",
          indexProgress: 1,
          skipped: [...skipped].sort(compareText),
          indexedCount: index.pages.size,
          docs: new Map(docsCache),
          error: null,
        });
      } catch (err) {
        if (generation !== indexGeneration) return;
        set({ indexStatus: "error", error: describeVaultError(err) });
      }
    },

    reindexPaths: async (rels) => {
      const { activeVaultId, index } = get();
      if (!activeVaultId) return;
      const unique = [...new Set(rels.map((rel) => normalizeRel(rel)).filter(Boolean))].sort(
        compareText,
      );
      if (!unique.length) return;
      // 一次改太多（git 切换、同步盘）就全量重建，别让增量逻辑变慢
      if (!index || unique.length > REINDEX_INCREMENTAL_MAX) {
        await get().buildIndexNow();
        return;
      }

      const skipped = new Set(get().skipped);
      for (const rel of unique) {
        if (!isMarkdownRel(rel)) continue;
        if (get().dirty.has(rel) && docsCache.has(rel)) {
          const cached = docsCache.get(rel)!;
          parsedPages.set(
            rel,
            parseDocWithOffset({ rel, text: cached.text, mtime: cached.mtime }),
          );
          continue;
        }
        try {
          const doc = await getBridge().read(activeVaultId, rel);
          if (!doc) {
            parsedPages.delete(rel);
            docsCache.delete(rel);
            skipped.delete(rel);
            continue;
          }
          parsedPages.set(
            doc.rel,
            parseDocWithOffset({ rel: doc.rel, text: doc.text, mtime: doc.mtime }),
          );
          docsCache.set(doc.rel, doc);
          skipped.delete(rel);
        } catch (err) {
          const normalized = toVaultBridgeError(err);
          if (normalized.code === "not-found") {
            parsedPages.delete(rel);
            docsCache.delete(rel);
            skipped.delete(rel);
          } else if (normalized.code === "too-large") {
            parsedPages.delete(rel);
            skipped.add(rel);
          } else if (normalized.code !== "forbidden-ext") {
            skipped.add(rel);
            set({ error: describeVaultError(normalized) });
          }
        }
      }

      const next = buildVaultIndexFromParsed([...parsedPages.values()]);
      set({
        index: next,
        indexStatus: "ready",
        indexProgress: 1,
        skipped: [...skipped].sort(compareText),
        indexedCount: next.pages.size,
        docs: new Map(docsCache),
      });
      await get().refreshTree();
    },

    subscribeWatch: () => {
      if (unsubWatch) {
        unsubWatch();
        unsubWatch = null;
      }
      const { activeVaultId } = get();
      if (!activeVaultId) return () => {};
      const off = getBridge().watch(activeVaultId, (rels) => {
        void get().reindexPaths(rels);
      });
      unsubWatch = off;
      return () => {
        off();
        if (unsubWatch === off) unsubWatch = null;
      };
    },

    /* 派生查询 */
    backlinksOf: (rel) => get().index?.backlinks.get(normalizeRel(rel)) ?? [],

    outlinksOf: (rel) => {
      const key = normalizeRel(rel);
      return (get().index?.links ?? []).filter((link) => link.from === key && link.resolved !== null);
    },

    unresolvedOf: (rel) => {
      const key = normalizeRel(rel);
      return (get().index?.unresolved ?? []).filter((link) => link.from === key);
    },

    tagsOf: (rel) => {
      const key = normalizeRel(rel);
      const parsed = parsedPages.get(key);
      if (parsed) return tagRefsOf(parsed.page, parsed.lineOffset);
      const doc = docsCache.get(key);
      if (!doc) return [];
      const { meta, body, lineOffset } = parseFrontmatter(doc.text);
      const refs: TagRef[] = frontmatterTags(meta).map((tag) => ({
        tag: tag.replace(/^#+/, ""),
        from: key,
        line: 0,
        source: "frontmatter" as const,
      }));
      for (const item of extractInlineTags(body, { lineOffset })) {
        refs.push({ tag: item.tag, from: key, line: item.line, source: "inline" });
      }
      return refs;
    },

    snapshotDocs: () =>
      [...docsCache.values()]
        .map((doc) => ({ rel: doc.rel, text: doc.text, mtime: doc.mtime }))
        .sort((a, b) => compareText(a.rel, b.rel)),

    lineOffsetOf: (rel) => parsedPages.get(normalizeRel(rel))?.lineOffset ?? 0,

    readText: async (rel) => {
      const key = normalizeRel(rel);
      const cached = docsCache.get(key);
      if (cached) return cached.text;
      const { activeVaultId } = get();
      if (!activeVaultId) return null;
      const doc = await getBridge().read(activeVaultId, key);
      if (!doc) return null;
      docsCache.set(key, doc);
      set({ docs: new Map(docsCache) });
      return doc.text;
    },

    applyWrite: async (rel, text, mode) => {
      const key = normalizeRel(rel);
      const { activeVaultId } = get();
      if (!activeVaultId) {
        set({ error: "还没有打开知识库。" });
        return false;
      }
      try {
        await getBridge().apply({
          vaultId: activeVaultId,
          rel: key,
          text,
          ...(mode ? { mode } : {}),
        });
        docsCache.delete(key);
        await get().reindexPaths([key]);
        return true;
      } catch (err) {
        set({ error: describeVaultError(err) });
        return false;
      }
    },
  };
});

/** 供非 React 调用方（工具层、记忆适配）直接取当前快照。 */
export function vaultStoreSnapshot(): VaultState {
  return useVaultStore.getState();
}

/** 当前活动库（没有就返回 null）。 */
export function activeVaultMeta(state: VaultState = useVaultStore.getState()): VaultMeta | null {
  return state.vaults.find((vault) => vault.id === state.activeVaultId) ?? null;
}

/** 当前活动库的索引（没有就返回 null）。 */
export function activeVaultIndex(): VaultIndex | null {
  return useVaultStore.getState().index;
}

/** 某个页面的出链（已解析）——工具层做「相关页」提示用。 */
export function resolvedOutlinksOf(index: VaultIndex | null, rel: string): WikiLink[] {
  const key = normalizeRel(rel);
  return (index?.links ?? []).filter((link) => link.from === key && link.resolved !== null);
}

/** 编辑器态默认值（界面初始化用）。 */
export const DEFAULT_EDITOR_MODE: EditorMode = "split";
