import { describe, it, expect } from "vitest";
import { MemoryStore } from "./store.js";
import { MEMORY_KEYS } from "./storage.js";
import { DEFAULT_SETTINGS } from "./store.js";
import { GLOBAL_AGENT_ID, type StorageLike } from "./types.js";
import {
  VAULT_INJECT_MAX_CHARS,
  VAULT_INJECT_PER_NOTE_CHARS,
  VAULT_MEMORY_MAX,
} from "../vault/types.js";
import {
  clipText,
  getVaultDocSource,
  hashVaultText,
  isVaultSourceAvailable,
  isVaultMemoryEnabled,
  lastVaultSync,
  resetVaultSyncState,
  resolveExcerpt,
  resolveExcerpts,
  setVaultDocSource,
  stripFrontmatter,
  summarizeVaultDoc,
  syncVault,
  type VaultDocSource,
} from "./vaultMemory.js";

/**
 * 知识库 ↔ 语义记忆（d.114）用例：全部走内存假实现，绝不碰真实文件系统。
 * 重点验证确定性（同一输入两次结果相同）、增量语义（跳过/新增/更新/删除/截断）
 * 与「不存正文只存指针」这条硬约束。
 */

const NOW = new Date("2026-11-08T08:00:00.000Z").getTime();
const T0 = new Date("2026-11-08T07:00:00.000Z").toISOString();

class FakeStorage implements StorageLike {
  readonly map = new Map<string, string>();
  failWrites = false;
  getItem(key: string): string | null {
    const value = this.map.get(key);
    return value === undefined ? null : value;
  }
  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error("QuotaExceededError");
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  write(key: string, value: unknown): void {
    this.map.set(key, JSON.stringify(value));
  }
}

interface Doc {
  text: string;
  mtime?: string;
  hash?: string;
  vaultId?: string;
}

interface FakeSource extends VaultDocSource {
  /** 写通道收到的请求（断言写回用）。 */
  writes: { vaultId: string; rel: string; text: string; mode?: "overwrite" | "append" }[];
  files: Map<string, Doc>;
  setFile(rel: string, doc: Doc): void;
  removeFile(rel: string): void;
}

/**
 * 内存知识库源：`files` 是唯一事实来源，写通道直接改它。
 * `hash` 缺省用与生产同一套纯函数，避免测试自己发明 hash 口径。
 */
function fakeSource(initial: Record<string, Doc> = {}): FakeSource {
  const files = new Map<string, Doc>(Object.entries(initial));
  const writes: FakeSource["writes"] = [];
  const source: FakeSource = {
    files,
    writes,
    setFile(rel, doc) {
      files.set(rel, doc);
    },
    removeFile(rel) {
      files.delete(rel);
    },
    docs: async () =>
      [...files.entries()].map(([rel, doc]) => ({
        vaultId: doc.vaultId ?? "v1",
        rel,
        mtime: doc.mtime ?? T0,
        hash: doc.hash ?? hashVaultText(doc.text),
        text: doc.text,
      })),
    read: async (rel) => {
      const doc = files.get(rel);
      return doc ? doc.text : null;
    },
    write: async (req) => {
      writes.push(req);
      const prev = files.get(req.rel)?.text ?? "";
      files.set(req.rel, {
        text: req.mode === "append" && prev ? `${prev}\n\n${req.text}` : req.text,
        mtime: T0,
      });
    },
    allowedWriteDirs: () => ["inbox"],
  };
  return source;
}

function makeStore(storage = new FakeStorage()): MemoryStore {
  return new MemoryStore(storage, () => NOW);
}

describe("summarizeVaultDoc（摘要口径）", () => {
  it("去 frontmatter，取首个标题 + 首段，用「：」连接", () => {
    const text = ["---", "tags: [发布]", "---", "", "# 发布计划", "", "周五前完成回归。", "第二行也属于首段。", "", "## 细节", "正文"].join("\n");
    expect(summarizeVaultDoc(text)).toBe("发布计划：周五前完成回归。 第二行也属于首段。");
  });

  it("代码块里的 # 不算标题；没有标题时直接取首段", () => {
    const text = ["```sh", "# 这是注释不是标题", "```", "", "纯正文段落。"].join("\n");
    expect(summarizeVaultDoc(text)).toBe("纯正文段落。");
  });

  it("摘要 ≤ 500 字且确定性（同一输入两次相等）", () => {
    const text = `# 长文\n\n${"很长的正文。".repeat(200)}`;
    const first = summarizeVaultDoc(text);
    expect(first.length).toBeLessThanOrEqual(500);
    expect(summarizeVaultDoc(text)).toBe(first);
  });

  it("只有图片/表格时退回去掉空白的正文，不给空摘要", () => {
    expect(summarizeVaultDoc("![图片](a.png)")).toBe("![图片](a.png)");
  });

  it("stripFrontmatter / clipText 的边界", () => {
    expect(stripFrontmatter("没有 frontmatter 的正文")).toBe("没有 frontmatter 的正文");
    expect(stripFrontmatter("---\nkey: v\n---\n正文")).toBe("正文");
    // 只有开头没有结尾：按无 frontmatter 处理，不吞正文
    expect(stripFrontmatter("---\n正文")).toBe("---\n正文");
    expect(clipText("一二三四五", 3)).toBe("一二…");
    expect(clipText("abc", 3)).toBe("abc");
  });
});

describe("syncVault（增量同步）", () => {
  it("首次同步：新增全部、条目是指针型（key=rel、全局桶、source=vault）", async () => {
    const store = makeStore();
    const source = fakeSource({
      "notes/发布计划.md": { text: "# 发布计划\n\n周五前完成回归。" },
      "notes/端口.md": { text: "# 端口\n\n线上监听 8787。" },
    });
    const result = await syncVault(source, { store, now: () => NOW });

    expect(result.ok).toBe(true);
    expect(result.scanned).toBe(2);
    expect(result.added).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.total).toBe(2);
    expect(result.truncated).toBe(0);
    expect(result.truncatedReason).toBe("");

    const entries = store.vaultEntries();
    expect(entries.map((e) => e.key)).toEqual(["notes/发布计划.md", "notes/端口.md"]);
    for (const entry of entries) {
      expect(entry.source).toBe("vault");
      expect(entry.agentId).toBe(GLOBAL_AGENT_ID);
      expect(entry.vault?.vaultId).toBe("v1");
      expect(entry.vault?.rel).toBe(entry.key);
      expect(entry.vault?.mtime).toBe(T0);
      expect(entry.value.length).toBeLessThanOrEqual(500);
    }
    // 不存正文：摘要里不该出现首段之后的正文
    const plan = entries.find((e) => e.key === "notes/发布计划.md")!;
    expect(plan.value).toContain("发布计划");
    expect(plan.value).not.toContain("## ");
  });

  it("第二次同步：hash 与 mtime 都没变 → 全部跳过，不重写", async () => {
    const store = makeStore();
    const source = fakeSource({ "a.md": { text: "# A\n\n正文" } });
    await syncVault(source, { store, now: () => NOW });

    const again = await syncVault(source, { store, now: () => NOW });
    expect(again.added).toBe(0);
    expect(again.updated).toBe(0);
    expect(again.skipped).toBe(1);
    expect(again.total).toBe(1);
  });

  it("内容/mtime 变化 → 原地更新（id 稳定、数量不增）", async () => {
    const store = makeStore();
    const source = fakeSource({ "a.md": { text: "# A\n\n旧内容", mtime: "2026-11-01T00:00:00.000Z" } });
    await syncVault(source, { store, now: () => NOW });
    const before = store.vaultEntries()[0];

    source.setFile("a.md", { text: "# A\n\n新内容", mtime: "2026-11-07T00:00:00.000Z" });
    const result = await syncVault(source, { store, now: () => NOW });
    expect(result.updated).toBe(1);
    expect(result.added).toBe(0);
    const after = store.vaultEntries();
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(before.id); // 权重账本按 id 记，更新不能换 id
    expect(after[0].value).toContain("新内容");
    expect(after[0].vault?.mtime).toBe("2026-11-07T00:00:00.000Z");
  });

  it("文件从库里消失 → 对应条目删除，其它来源的语义记忆不动", async () => {
    const store = makeStore();
    store.upsertSemantic({ agentId: "a1", key: "称呼", value: "阿和", source: "manual" });
    const source = fakeSource({ "a.md": { text: "# A\n\n甲" }, "b.md": { text: "# B\n\n乙" } });
    await syncVault(source, { store, now: () => NOW });

    source.removeFile("a.md");
    const result = await syncVault(source, { store, now: () => NOW });
    expect(result.removed).toBe(1);
    expect(store.vaultEntries().map((e) => e.key)).toEqual(["b.md"]);
    expect(store.semanticGlobal().some((e) => e.key === "称呼")).toBe(true);
  });

  it("超过上限：按 mtime 降序截断并回报条数与原因", async () => {
    const store = makeStore();
    const source = fakeSource({
      "old.md": { text: "# 旧\n\n旧", mtime: "2026-01-01T00:00:00.000Z" },
      "mid.md": { text: "# 中\n\n中", mtime: "2026-06-01T00:00:00.000Z" },
      "new.md": { text: "# 新\n\n新", mtime: "2026-11-01T00:00:00.000Z" },
    });
    const result = await syncVault(source, { store, now: () => NOW, max: 2 });

    expect(result.scanned).toBe(3);
    expect(result.truncated).toBe(1);
    expect(result.truncatedReason).toContain("超过纳入上限（2 篇）");
    expect(result.truncatedReason).toContain("1 篇未纳入");
    expect(store.vaultEntries().map((e) => e.key)).toEqual(["mid.md", "new.md"]);
    expect(store.vaultEntries().some((e) => e.key === "old.md")).toBe(false);
  });

  it("上限收紧：先前纳入的条目会被删掉（不是只换新）", async () => {
    const store = makeStore();
    const source = fakeSource({
      "a.md": { text: "# A\n\n甲", mtime: "2026-01-01T00:00:00.000Z" },
      "b.md": { text: "# B\n\n乙", mtime: "2026-11-01T00:00:00.000Z" },
    });
    await syncVault(source, { store, now: () => NOW });
    expect(store.vaultEntries()).toHaveLength(2);
    const result = await syncVault(source, { store, now: () => NOW, max: 1 });
    expect(result.removed).toBe(1);
    expect(store.vaultEntries().map((e) => e.key)).toEqual(["b.md"]);
  });

  it("缺省上限是 VAULT_MEMORY_MAX；设置里的 vaultMemoryMax 优先", async () => {
    const store = makeStore();
    expect(store.vaultMemoryLimit()).toBe(VAULT_MEMORY_MAX);
    store.updateSettings({ vaultMemoryMax: 7 });
    expect(store.vaultMemoryLimit()).toBe(7);
  });

  it("本机配额写失败 → 如实返回 ok:false（不吞、不抛）", async () => {
    const storage = new FakeStorage();
    const store = makeStore(storage);
    storage.failWrites = true;
    const source = fakeSource({ "a.md": { text: "# A\n\n正文" } });
    const result = await syncVault(source, { store, now: () => NOW });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("配额");
    // 内存态仍可用（与既有「写入异常静默」口径一致：不炸主链路）
    expect(store.vaultEntries()).toHaveLength(1);
  });

  it("源抛错 → 返回 ok:false 且不抛", async () => {
    const store = makeStore();
    const broken: VaultDocSource = {
      docs: async () => {
        throw new Error("桥不可用");
      },
      read: async () => null,
      write: async () => undefined,
      allowedWriteDirs: () => ["inbox"],
    };
    const result = await syncVault(broken, { store, now: () => NOW });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("桥不可用");
    expect(lastVaultSync()).toBe(result);
  });

  it("同一批输入两次同步结果确定（新增数/条目内容一致）", async () => {
    const run = async () => {
      const store = makeStore();
      const source = fakeSource({
        "x.md": { text: "# X\n\n内容", mtime: "2026-11-03T00:00:00.000Z" },
        "y.md": { text: "# Y\n\n内容", mtime: "2026-11-02T00:00:00.000Z" },
      });
      const result = await syncVault(source, { store, now: () => NOW });
      return { result, entries: store.vaultEntries().map((e) => ({ key: e.key, value: e.value, id: e.id })) };
    };
    const a = await run();
    const b = await run();
    expect(a.result.added).toBe(b.result.added);
    expect(a.entries).toEqual(b.entries);
  });
});

describe("resolveExcerpt / resolveExcerpts（正文片段预算）", () => {
  it("按指针读正文；缺失文件返回 null", async () => {
    const source = fakeSource({ "a.md": { text: "# 标题\n\n正文第一段。" } });
    const excerpt = await resolveExcerpt(source, { key: "a.md", vault: { vaultId: "v1", rel: "a.md", mtime: T0, hash: "h" } });
    expect(excerpt?.rel).toBe("a.md");
    // 片段保留标题（给人看的预览要有上下文），但不再含 frontmatter
    expect(excerpt?.text).toContain("正文第一段。");
    expect(excerpt?.text.startsWith("---")).toBe(false);
    expect(excerpt?.truncated).toBe(false);

    expect(await resolveExcerpt(source, { key: "missing.md" })).toBeNull();
  });

  it("单条超过预算 → 截断并以「…」收尾", async () => {
    const source = fakeSource({ "a.md": { text: "字".repeat(1000) } });
    const excerpt = await resolveExcerpt(source, { key: "a.md" });
    expect(excerpt?.chars).toBe(VAULT_INJECT_PER_NOTE_CHARS);
    expect(excerpt?.truncated).toBe(true);
    expect(excerpt?.text.endsWith("…")).toBe(true);
  });

  it("整轮 ≤ 1200 且逐条 ≤ 400；预算用尽后的条目标记原因", async () => {
    const source = fakeSource({
      "a.md": { text: "甲".repeat(400) },
      "b.md": { text: "乙".repeat(400) },
      "c.md": { text: "丙".repeat(400) },
      "d.md": { text: "丁".repeat(400) },
    });
    const entries = ["a.md", "b.md", "c.md", "d.md"].map((rel) => ({ key: rel }));
    const { excerpts, skipped, chars } = await resolveExcerpts(source, entries);
    expect(chars).toBeLessThanOrEqual(VAULT_INJECT_MAX_CHARS);
    expect(excerpts.length).toBe(3);
    for (const excerpt of excerpts) expect(excerpt.chars).toBeLessThanOrEqual(VAULT_INJECT_PER_NOTE_CHARS);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toContain("预算");
  });

  it("读失败进 skipped（可观测），不抛", async () => {
    const broken: VaultDocSource = {
      docs: async () => [],
      read: async () => {
        throw new Error("io");
      },
      write: async () => undefined,
      allowedWriteDirs: () => ["inbox"],
    };
    const { excerpts, skipped } = await resolveExcerpts(broken, [{ key: "a.md" }]);
    expect(excerpts).toEqual([]);
    expect(skipped[0].reason).toContain("读取失败");
  });
});

describe("store 的知识库批量接口（只碰 source=vault）", () => {
  it("upsertVaultEntries 不碰其它来源；removeVaultEntries 只删 vault", () => {
    const store = makeStore();
    store.upsertSemantic({ agentId: "a1", key: "称呼", value: "阿和", source: "manual" });
    const result = store.upsertVaultEntries([
      { rel: "notes/a.md", vaultId: "v1", mtime: T0, hash: "h1", value: "摘要 A" },
    ]);
    expect(result).toEqual({ ok: true, written: 1, dropped: 0 });
    expect(store.semanticGlobal().filter((e) => e.source === "vault")).toHaveLength(1);
    expect(store.semanticGlobal().filter((e) => e.source === "manual")).toHaveLength(1);

    expect(store.removeVaultEntries(["notes/a.md", "nope.md"])).toBe(1);
    expect(store.vaultEntries()).toEqual([]);
    expect(store.semanticGlobal().filter((e) => e.source === "manual")).toHaveLength(1);
  });

  it("rel 不归一化：不同目录的同名文件是两条不同条目", () => {
    const store = makeStore();
    store.upsertVaultEntries([
      { rel: "notes/方案.md", vaultId: "v1", mtime: T0, hash: "h1", value: "甲" },
      { rel: "archive/方案.md", vaultId: "v1", mtime: T0, hash: "h2", value: "乙" },
    ]);
    expect(store.vaultEntries().map((e) => e.key)).toEqual(["archive/方案.md", "notes/方案.md"]);
  });

  it("配额失败如实返回 ok:false 且 dropped/error 可见", () => {
    const storage = new FakeStorage();
    const store = makeStore(storage);
    storage.failWrites = true;
    const result = store.upsertVaultEntries([
      { rel: "a.md", vaultId: "v1", mtime: T0, hash: "h", value: "摘要" },
    ]);
    expect(result.ok).toBe(false);
    expect(result.written).toBe(0);
    expect(result.error).toContain("配额");
  });

  it("刷新后水合：vault 条目保留指针与长 key；老设置缺 vaultMemory → 默认 true", () => {
    const storage = new FakeStorage();
    const store = makeStore(storage);
    store.upsertVaultEntries([
      {
        rel: "很长的目录/很长的文件名-2026-11-08-发布计划与回归安排.md",
        vaultId: "v1",
        mtime: T0,
        hash: "h",
        value: "摘要",
      },
    ]);
    // 模拟老版本设置：没有 vaultMemory 键
    storage.map.set(MEMORY_KEYS.settings, JSON.stringify({ enabled: true, autoCapture: true, retentionDays: 90 }));

    const fresh = makeStore(storage);
    const entries = fresh.vaultEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].key).toBe("很长的目录/很长的文件名-2026-11-08-发布计划与回归安排.md");
    expect(entries[0].vault).toEqual({ vaultId: "v1", rel: entries[0].key, mtime: T0, hash: "h" });
    expect(fresh.getSettings().vaultMemory).toBe(true);
    expect(fresh.getSettings()).toEqual({ ...DEFAULT_SETTINGS });
  });

  it("导出/导入往返：版本号不变（1），知识库指针条目原样保留", () => {
    const store = makeStore();
    store.upsertVaultEntries([
      { rel: "notes/a.md", vaultId: "v1", mtime: T0, hash: "h1", value: "摘要 A" },
    ]);
    const json = store.exportAll();
    expect((JSON.parse(json) as { version: number }).version).toBe(1);

    const target = makeStore();
    expect(target.importAll(json)).toEqual({ ok: true });
    const [entry] = target.vaultEntries();
    expect(entry.key).toBe("notes/a.md");
    expect(entry.source).toBe("vault");
    expect(entry.vault).toEqual({ vaultId: "v1", rel: "notes/a.md", mtime: T0, hash: "h1" });
    expect(target.getSettings().vaultMemory).toBe(true);
  });

  it("坏 JSON / 坏指针：回退不报错，坏指针降级成普通条目", () => {
    const storage = new FakeStorage();
    storage.map.set(MEMORY_KEYS.semantic, "{oops");
    storage.map.set(MEMORY_KEYS.settings, "[]");
    const store = makeStore(storage);
    expect(store.vaultEntries()).toEqual([]);
    expect(store.getSettings().vaultMemory).toBe(true);

    const storage2 = new FakeStorage();
    storage2.write(MEMORY_KEYS.semantic, {
      [GLOBAL_AGENT_ID]: [
        {
          id: "s1",
          agentId: GLOBAL_AGENT_ID,
          key: "a.md",
          value: "只有摘要没有指针",
          scope: "user",
          confidence: 0.6,
          pinned: false,
          source: "vault",
          createdAt: T0,
          updatedAt: T0,
          vault: { rel: 123 },
        },
      ],
    });
    const store2 = makeStore(storage2);
    const [entry] = store2.semanticGlobal();
    expect(entry.source).toBe("manual"); // 没有合法指针 → 不当知识库条目
    expect(entry.value).toBe("只有摘要没有指针");
    expect(entry.vault).toBeUndefined();
    expect(store2.vaultEntries()).toEqual([]);
  });
});

describe("注册中心与设置开关", () => {
  it("setVaultDocSource 注册/注销；未注册时 available=false", () => {
    resetVaultSyncState();
    expect(isVaultSourceAvailable()).toBe(false);
    expect(getVaultDocSource()).toBeNull();
    const source = fakeSource();
    setVaultDocSource(source);
    expect(isVaultSourceAvailable()).toBe(true);
    expect(getVaultDocSource()).toBe(source);
    setVaultDocSource(null);
    expect(isVaultSourceAvailable()).toBe(false);
    expect(lastVaultSync()).toBeNull();
  });

  it("isVaultMemoryEnabled 读设置单一真源；读取抛错按开启处理", () => {
    const store = makeStore();
    expect(isVaultMemoryEnabled(store)).toBe(true);
    store.updateSettings({ vaultMemory: false });
    expect(isVaultMemoryEnabled(store)).toBe(false);
    const broken = {
      getSettings: () => {
        throw new Error("boom");
      },
    } as unknown as MemoryStore;
    expect(isVaultMemoryEnabled(broken)).toBe(true);
  });
});
