import { describe, it, expect, beforeEach } from "vitest";
import { MemoryStore } from "./store.js";
import { MEMORY_KEYS } from "./storage.js";
import type { StorageLike } from "./types.js";
import {
  MEMORY_INBOX_DIR,
  buildMemoryNote,
  enqueueMemoryWrite,
  flushMemoryWriteBack,
  memoryFileKey,
  pendingMemoryWriteCount,
  resetMemoryWriteBack,
  setMemoryWriteErrorHandler,
  writeBackMemory,
  type MemoryWriteRequest,
  type MemoryWriteResult,
} from "./memoryWriteBack.js";
import { setVaultDocSource, type VaultDocSource } from "./vaultMemory.js";

/**
 * 记忆 → 知识库写回（d.114）用例：全部走内存假文件系统。
 * 重点验证「文件名/去重/只写 allowedWriteDirs/失败如实上报」四条契约。
 */

const NOW = new Date("2026-11-08T08:00:00.000Z").getTime();

class FakeStorage implements StorageLike {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    const value = this.map.get(key);
    return value === undefined ? null : value;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  write(key: string, value: unknown): void {
    this.map.set(key, JSON.stringify(value));
  }
}

interface FakeSource extends VaultDocSource {
  files: Map<string, string>;
  writes: { vaultId: string; rel: string; text: string; mode?: "overwrite" | "append" }[];
  failNext: string | null;
  dirs: string[];
}

function fakeSource(initial: Record<string, string> = {}, dirs = ["inbox"]): FakeSource {
  const files = new Map<string, string>(Object.entries(initial));
  const writes: FakeSource["writes"] = [];
  const source: FakeSource = {
    files,
    writes,
    failNext: null,
    dirs,
    docs: async () =>
      [...files.entries()].map(([rel, text]) => ({
        vaultId: "v1",
        rel,
        mtime: "2026-11-08T07:00:00.000Z",
        hash: `h-${rel}`,
        text,
      })),
    read: async (rel) => files.get(rel) ?? null,
    write: async (req) => {
      if (source.failNext) throw new Error(source.failNext);
      writes.push(req);
      const prev = files.get(req.rel) ?? "";
      files.set(req.rel, req.mode === "append" && prev ? `${prev}\n\n${req.text}` : req.text);
    },
    allowedWriteDirs: () => source.dirs,
  };
  return source;
}

const request = (overrides: Partial<MemoryWriteRequest> = {}): MemoryWriteRequest => ({
  kind: "explicit",
  key: "称呼",
  value: "用户希望被称为「阿和」",
  agentId: "a1",
  at: "2026-11-08T08:00:00.000Z",
  ...overrides,
});

beforeEach(() => {
  resetMemoryWriteBack();
  setVaultDocSource(null);
});

describe("memoryFileKey（文件名安全化）", () => {
  it("去掉路径分隔符/保留字符，空 key 有兜底", () => {
    expect(memoryFileKey("偏好/语言")).toBe("偏好-语言");
    expect(memoryFileKey('a:b*c?"d"')).toBe("a-b-c-d");
    expect(memoryFileKey("   ")).toBe("未命名");
    expect(memoryFileKey("很长的键".repeat(20)).length).toBeLessThanOrEqual(40);
  });
});

describe("writeBackMemory（单条写回）", () => {
  it("新建：inbox/memory-<key>-<yyyymmdd>.md，frontmatter 带 source/key/agentId/createdAt", async () => {
    const source = fakeSource({ "README.md": "库说明" });
    const result = await writeBackMemory(source, request());

    expect(result.ok).toBe(true);
    expect(result.rel).toBe("inbox/memory-称呼-20261108.md");
    expect(result.appended).toBe(false);
    expect(source.writes[0]).toMatchObject({ vaultId: "v1", rel: result.rel, mode: "overwrite" });
    const text = source.files.get(result.rel)!;
    expect(text).toContain("source: heming-memory");
    expect(text).toContain('key: "称呼"');
    expect(text).toContain('agentId: "a1"');
    expect(text).toContain('createdAt: "2026-11-08T08:00:00.000Z"');
    expect(text).toContain("kind: explicit");
    expect(text).toContain("用户希望被称为「阿和」");
  });

  it("同 key 已有文件（跨日期）→ 追加「## 更新」小节，不再新建", async () => {
    const source = fakeSource({
      "inbox/memory-称呼-20261101.md": "---\nsource: heming-memory\n---\n\n旧内容\n",
    });
    const result = await writeBackMemory(source, request({ value: "改叫阿禾" }));

    expect(result.ok).toBe(true);
    expect(result.appended).toBe(true);
    expect(result.rel).toBe("inbox/memory-称呼-20261101.md");
    expect(source.writes[0]).toMatchObject({ rel: "inbox/memory-称呼-20261101.md", mode: "append" });
    expect(source.writes[0].text).toBe("## 更新 2026-11-08\n\n改叫阿禾\n");
    expect(source.files.size).toBe(1);
  });

  it("同 key 同一天已有文件 → 也是追加（不覆盖当天内容）", async () => {
    const source = fakeSource({ "inbox/memory-称呼-20261108.md": "已有一版" });
    const result = await writeBackMemory(source, request({ value: "第二版" }));
    expect(result.appended).toBe(true);
    expect(source.files.get("inbox/memory-称呼-20261108.md")).toContain("第二版");
    expect(source.files.get("inbox/memory-称呼-20261108.md")).toContain("已有一版");
  });

  it("只写 inbox/：可写目录为空 → 失败并说明（不是笼统失败）", async () => {
    const source = fakeSource({}, []);
    const result = await writeBackMemory(source, request());
    expect(result.ok).toBe(false);
    expect(result.error).toContain("只读");
    expect(source.writes).toEqual([]);
  });

  it("可写目录不含 inbox → 失败并列出当前可写目录", async () => {
    const source = fakeSource({}, ["notes"]);
    const result = await writeBackMemory(source, request());
    expect(result.ok).toBe(false);
    expect(result.error).toContain(MEMORY_INBOX_DIR);
    expect(result.error).toContain("notes");
    expect(source.writes).toEqual([]);
  });

  it("库为空（没有任何文档）→ 无法确定目标库，失败", async () => {
    const source = fakeSource();
    const result = await writeBackMemory(source, request());
    expect(result.ok).toBe(false);
    expect(result.error).toContain("知识库为空");
  });

  it("写入抛错 → ok:false 且 error 带原因，不抛", async () => {
    const source = fakeSource({ "README.md": "x" });
    source.failNext = "磁盘只读";
    const result = await writeBackMemory(source, request());
    expect(result.ok).toBe(false);
    expect(result.error).toContain("磁盘只读");
  });

  it("buildMemoryNote / 结果形状可被 memorize", () => {
    const note = buildMemoryNote({
      key: "偏好-语言",
      value: "简体中文",
      agentId: "a1",
      kind: "review",
      createdAt: "2026-11-08T00:00:00.000Z",
    });
    expect(note.startsWith("---\n")).toBe(true);
    expect(note).toContain("kind: review");
    expect(note).toContain("简体中文");
  });
});

describe("写回队列（enqueue → flush）", () => {
  it("入队按 (kind, agentId, key) 去重，flush 后清空", async () => {
    const source = fakeSource({ "README.md": "x" });
    // 刻意先入队再手动 flush：不依赖「注册即自动 flush」的时序，断言才稳定。
    enqueueMemoryWrite(request({ value: "第一版" }));
    enqueueMemoryWrite(request({ value: "第二版" }));
    expect(pendingMemoryWriteCount()).toBe(1);

    const flushed = await flushMemoryWriteBack({ source, now: () => NOW });
    expect(flushed.written).toBe(1);
    expect(flushed.failed).toBe(0);
    expect(pendingMemoryWriteCount()).toBe(0);
    expect(source.files.get("inbox/memory-称呼-20261108.md")).toContain("第二版");
  });

  it("未接入知识库 → 整体跳过并给原因（队列保留，接入后补写）", async () => {
    enqueueMemoryWrite(request());
    const skipped = await flushMemoryWriteBack();
    expect(skipped.written).toBe(0);
    expect(skipped.skippedReason).toContain("未接入");
    expect(pendingMemoryWriteCount()).toBe(1);

    const source = fakeSource({ "README.md": "x" });
    const flushed = await flushMemoryWriteBack({ source, now: () => NOW });
    expect(flushed.written).toBe(1);
  });

  it("失败：返回值 + 上报器都拿到原因（记忆条目本身照常保存的旁证）", async () => {
    const source = fakeSource({ "README.md": "x" }, ["notes"]);
    const seen: { result: MemoryWriteResult; request: MemoryWriteRequest }[] = [];
    setMemoryWriteErrorHandler((info) => seen.push(info));
    enqueueMemoryWrite(request());
    const flushed = await flushMemoryWriteBack({ source, now: () => NOW });
    expect(flushed.failed).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0].result.error).toContain(MEMORY_INBOX_DIR);
  });

  it("recordTurn 的显式记忆会自动入队（写回是附加动作，不阻塞书写）", () => {
    const store = new MemoryStore(new FakeStorage(), () => NOW);
    store.recordTurn("a1", "c1", "记住：我的称呼是阿和", "好的");
    expect(pendingMemoryWriteCount()).toBe(1);
    // 记忆条目本身已保存（写回队列与记忆保存互不为前提）
    expect(store.semanticGlobal().some((e) => e.key === "称呼")).toBe(true);
    expect(() => store.exportAll()).not.toThrow();
  });

  it("三类来源都入队（explicit / consolidate / review 各一条，互不覆盖）", () => {
    enqueueMemoryWrite(request({ kind: "explicit", key: "称呼" }));
    enqueueMemoryWrite(request({ kind: "consolidate", key: "称呼", value: "整理版" }));
    enqueueMemoryWrite(request({ kind: "review", key: "称呼", value: "复盘版" }));
    expect(pendingMemoryWriteCount()).toBe(3);
  });
});
