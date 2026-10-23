import { describe, expect, it } from "vitest";
import { AUX_NOTE, buildMemoryExport, type MemoryExportSource } from "./exportBundle.js";
import { MemoryStore } from "./store.js";
import type { StorageLike } from "./types.js";
import type { RecallRun } from "./recallLog.js";

const T0 = new Date("2026-10-17T08:00:00.000Z").getTime();

function makeStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (key) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

/** 固定 JSON：逐字节断言不依赖 MemoryStore 的内部实现。 */
const BASE = JSON.stringify(
  {
    version: 1,
    exportedAt: "2026-10-17T08:00:00.000Z",
    data: {
      working: {},
      episodic: {},
      semantic: { __global__: [] },
      settings: { enabled: true, autoCapture: true, retentionDays: 90 },
    },
  },
  null,
  2,
);

const RUN: RecallRun = {
  id: "rr-1",
  at: "2026-10-17T07:59:00.000Z",
  agentId: "a1",
  conversationId: "c1",
  query: "部署端口",
  recalled: { semantic: 1, episodic: 0, working: 0 },
  injected: [
    { id: "s1", layer: "semantic", content: "部署端口：8787", truncated: false },
  ],
  dropped: [],
  used: ["s1"],
};

function source(overrides: Partial<MemoryExportSource> = {}): MemoryExportSource {
  return {
    exportAll: () => BASE,
    usageSnapshot: () => ({ s1: { injected: 2, used: 1, lastAt: "2026-10-17T07:59:00.000Z" } }),
    recallRuns: () => [RUN],
    ...overrides,
  };
}

describe("buildMemoryExport", () => {
  it("不勾附块：与 exportAll() 逐字节一致", () => {
    expect(buildMemoryExport(source())).toBe(BASE);
    expect(buildMemoryExport(source(), { includeAux: false })).toBe(BASE);
  });

  it("勾选附块：顶层多出 aux（note/usage/recallLog），data 不变", () => {
    const json = buildMemoryExport(source(), { includeAux: true });
    expect(json.endsWith("\n")).toBe(false);
    const doc = JSON.parse(json) as {
      version: number;
      exportedAt: string;
      data: unknown;
      aux: { note: string; usage: unknown; recallLog: unknown };
    };
    expect(doc.version).toBe(1);
    expect(doc.exportedAt).toBe("2026-10-17T08:00:00.000Z");
    expect(doc.data).toEqual(JSON.parse(BASE).data);
    expect(doc.aux.note).toBe(AUX_NOTE);
    expect(doc.aux.note).toContain("可再生数据");
    expect(doc.aux.note).toContain("不参与导入");
    expect(doc.aux.usage).toEqual({ s1: { injected: 2, used: 1, lastAt: "2026-10-17T07:59:00.000Z" } });
    expect(doc.aux.recallLog).toEqual([RUN]);
  });

  it("真实 MemoryStore：不勾选时与 exportAll() 完全一致", () => {
    const store = new MemoryStore(makeStorage(), () => T0);
    store.upsertSemantic({ agentId: "a1", key: "称呼", value: "阿和", source: "manual" });
    const src: MemoryExportSource = {
      exportAll: () => store.exportAll(),
      usageSnapshot: () => ({}),
      recallRuns: () => [],
    };
    expect(buildMemoryExport(src)).toBe(store.exportAll());
  });

  it("带 aux 的导出仍可被 importAll 导入（导入端只认 data，忽略 aux）", () => {
    const store = new MemoryStore(makeStorage(), () => T0);
    store.upsertSemantic({ agentId: "a1", key: "称呼", value: "阿和", source: "manual" });
    const json = buildMemoryExport({
      exportAll: () => store.exportAll(),
      usageSnapshot: () => ({ s1: { injected: 1, used: 0, lastAt: "2026-10-17T08:00:00.000Z" } }),
      recallRuns: () => [RUN],
    }, { includeAux: true });

    const target = new MemoryStore(makeStorage(), () => T0);
    expect(target.importAll(json)).toEqual({ ok: true });
    expect(target.semanticGlobal().map((entry) => entry.key)).toContain("称呼");
  });
});
