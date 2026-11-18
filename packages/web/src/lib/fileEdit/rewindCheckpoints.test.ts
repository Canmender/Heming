/**
 * 轮次检查点（d.290）单测。
 *
 * 覆盖三层：
 * 1. 纯存储/计划（localStorage 读写、去重、上限、回滚计划）；
 * 2. 抓取（写之前读原文，各类失败码的归类）；
 * 3. 桥包装（顺序、只抓写工具、读失败不影响执行）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FileRoot } from "./paths.js";
import type { ToolBridge } from "../agentStream.js";
import {
  REWIND_CHECKPOINTS_KEY,
  REWIND_MAX_FILE_CHARS,
  REWIND_MAX_TURNS,
  beginRewindTurn,
  captureFileBefore,
  closeRewindTurn,
  describeTurnCheckpoints,
  dropTurnCheckpoints,
  getTurnCheckpoints,
  noteRewindFile,
  planRewind,
  recordTurnCheckpoint,
  resetRewindCheckpoints,
  withRewindCapture,
} from "./rewindCheckpoints.js";

const ROOTS: FileRoot[] = [{ name: "评测区", path: "D:/评测区", mode: "write" }];

function turn(at: number, files: { path: string; before: string | null; skipped?: "too-large" | "binary" | "encoding" | "unreadable" }[]) {
  return { at, files };
}

beforeEach(() => {
  resetRewindCheckpoints();
  localStorage.clear();
});

afterEach(() => {
  resetRewindCheckpoints();
  delete (window as unknown as { __heming_files?: unknown }).__heming_files;
  localStorage.clear();
});

describe("captureFileBefore", () => {
  const readOf = (response: unknown) => ({ read: vi.fn(async () => response) });

  it("读到内容就记下原文", async () => {
    const file = await captureFileBefore(readOf({ ok: true, content: "旧内容", bytes: 3 }), ROOTS, "D:/评测区/a.ts");
    expect(file).toEqual({ path: "D:/评测区/a.ts", before: "旧内容" });
  });

  it("not-found = 这一轮新建（回滚时删除），不是跳过", async () => {
    const file = await captureFileBefore(readOf({ ok: false, code: "not-found", error: "没有这个文件" }), ROOTS, "D:/评测区/new.ts");
    expect(file).toEqual({ path: "D:/评测区/new.ts", before: null });
    expect(file?.skipped).toBeUndefined();
  });

  it("二进制 / 太大 / GBK 都记成跳过，不硬还原", async () => {
    await expect(captureFileBefore(readOf({ ok: false, code: "binary", error: "二进制" }), ROOTS, "D:/评测区/x.bin")).resolves.toEqual({
      path: "D:/评测区/x.bin",
      before: null,
      skipped: "binary",
    });
    await expect(captureFileBefore(readOf({ ok: false, code: "too-large", error: "太大" }), ROOTS, "D:/评测区/big.ts")).resolves.toEqual({
      path: "D:/评测区/big.ts",
      before: null,
      skipped: "too-large",
    });
    await expect(captureFileBefore(readOf({ ok: true, content: "甲", bytes: 2, encoding: "gbk" }), ROOTS, "D:/评测区/gbk.ts")).resolves.toEqual({
      path: "D:/评测区/gbk.ts",
      before: null,
      skipped: "encoding",
    });
  });

  it("路径本身不合法返回 null（这个目标不值得记）", async () => {
    await expect(
      captureFileBefore(readOf({ ok: false, code: "outside-roots", error: "越界" }), ROOTS, "D:/别处/a.ts"),
    ).resolves.toBeNull();
  });

  it("读抛错 / 返回怪形状都降级成「跳过」，不抛", async () => {
    const throwing = { read: vi.fn(async () => Promise.reject(new Error("通道断了"))) };
    await expect(captureFileBefore(throwing, ROOTS, "D:/评测区/a.ts")).resolves.toEqual({
      path: "D:/评测区/a.ts",
      before: null,
      skipped: "unreadable",
    });
    await expect(captureFileBefore(readOf(null), ROOTS, "D:/评测区/a.ts")).resolves.toEqual({
      path: "D:/评测区/a.ts",
      before: null,
      skipped: "unreadable",
    });
  });

  it("内容超过单文件上限时记 too-large（存了也写不回去）", async () => {
    const huge = "x".repeat(REWIND_MAX_FILE_CHARS + 1);
    const file = await captureFileBefore(readOf({ ok: true, content: huge, bytes: huge.length }), ROOTS, "D:/评测区/huge.ts");
    expect(file).toEqual({ path: "D:/评测区/huge.ts", before: null, skipped: "too-large" });
  });
});

describe("recordTurnCheckpoint / getTurnCheckpoints", () => {
  it("最近的排最前，坏数据不进来", () => {
    recordTurnCheckpoint("c1", turn(1_000, [{ path: "D:/评测区/a.ts", before: "a0" }]));
    recordTurnCheckpoint("c1", turn(2_000, [{ path: "D:/评测区/b.ts", before: "b0" }]));
    const list = getTurnCheckpoints("c1");
    expect(list.map((item) => item.at)).toEqual([2_000, 1_000]);
    expect(list[0]?.files[0]?.path).toBe("D:/评测区/b.ts");
    expect(list[0]?.id).toBeTruthy();
  });

  it("文件列表为空的轮次不落库（不留空轮）", () => {
    expect(recordTurnCheckpoint("c1", turn(1_000, []))).toBe(0);
    expect(getTurnCheckpoints("c1")).toHaveLength(0);
  });

  it("超过上限时淘汰最老的轮次", () => {
    for (let index = 0; index < REWIND_MAX_TURNS + 3; index += 1) {
      recordTurnCheckpoint("c1", turn(1_000 + index, [{ path: `D:/评测区/f${index}.ts`, before: "old" }]));
    }
    const list = getTurnCheckpoints("c1");
    expect(list).toHaveLength(REWIND_MAX_TURNS);
    expect(list[0]?.at).toBe(1_000 + REWIND_MAX_TURNS + 2);
    expect(list[list.length - 1]?.at).toBe(1_000 + 3);
  });

  it("同一 id 重复落是替换，不叠加", () => {
    recordTurnCheckpoint("c1", { id: "same", at: 1_000, files: [{ path: "D:/评测区/a.ts", before: "one" }] });
    recordTurnCheckpoint("c1", { id: "same", at: 1_000, files: [{ path: "D:/评测区/a.ts", before: "two" }] });
    const list = getTurnCheckpoints("c1");
    expect(list).toHaveLength(1);
    expect(list[0]?.files[0]?.before).toBe("two");
  });

  it("能扛住坏掉的 localStorage 内容", () => {
    localStorage.setItem(REWIND_CHECKPOINTS_KEY, "{不是 JSON");
    resetRewindCheckpoints();
    localStorage.setItem(REWIND_CHECKPOINTS_KEY, JSON.stringify({ c1: [{ id: "x" }, "坏"] }));
    expect(() => getTurnCheckpoints("c1")).not.toThrow();
    expect(getTurnCheckpoints("c1")).toHaveLength(0);
  });
});

describe("planRewind", () => {
  it("单轮：还原旧内容、删掉新建的文件、跳过抓不到的", () => {
    recordTurnCheckpoint("c1", turn(1_000, [
      { path: "D:/评测区/a.ts", before: "旧 a" },
      { path: "D:/评测区/new.ts", before: null },
      { path: "D:/评测区/bin.dat", before: null, skipped: "binary" },
    ]));
    const plan = planRewind("c1", 1);
    expect(plan).not.toBeNull();
    expect(plan!.turns).toBe(1);
    expect(plan!.restore).toEqual([{ path: "D:/评测区/a.ts", content: "旧 a" }]);
    expect(plan!.remove).toEqual(["D:/评测区/new.ts"]);
    expect(plan!.skipped).toEqual([{ path: "D:/评测区/bin.dat", reason: "binary" }]);
  });

  it("同一文件在两轮里都改过：取窗口最早那份，不是中间态", () => {
    recordTurnCheckpoint("c1", turn(1_000, [{ path: "D:/评测区/a.ts", before: "第零版" }]));
    recordTurnCheckpoint("c1", turn(2_000, [{ path: "D:/评测区/a.ts", before: "第一版" }]));
    expect(planRewind("c1", 1)!.restore).toEqual([{ path: "D:/评测区/a.ts", content: "第一版" }]);
    expect(planRewind("c1", 2)!.restore).toEqual([{ path: "D:/评测区/a.ts", content: "第零版" }]);
  });

  it("没有那么多轮 / 参数不合法返回 null", () => {
    recordTurnCheckpoint("c1", turn(1_000, [{ path: "D:/评测区/a.ts", before: "x" }]));
    expect(planRewind("c1", 2)).toBeNull();
    expect(planRewind("c1", 0)).toBeNull();
    expect(planRewind("c1", -1)).toBeNull();
    expect(planRewind("别的会话", 1)).toBeNull();
  });

  it("dropTurnCheckpoints 只丢最近的几轮", () => {
    recordTurnCheckpoint("c1", turn(1_000, [{ path: "D:/评测区/a.ts", before: "x" }]));
    recordTurnCheckpoint("c1", turn(2_000, [{ path: "D:/评测区/b.ts", before: "y" }]));
    expect(dropTurnCheckpoints("c1", 1)).toBe(1);
    expect(getTurnCheckpoints("c1").map((item) => item.at)).toEqual([1_000]);
    expect(dropTurnCheckpoints("c1", 5)).toBe(0);
  });
});

describe("describeTurnCheckpoints", () => {
  it("没有检查点时给出下一步怎么做", () => {
    const text = describeTurnCheckpoints("c1");
    expect(text).toContain("还没有可回滚的检查点");
    expect(text).toContain("run_command");
  });

  it("列出最近几轮、几个文件、以及怎么退", () => {
    const now = 10 * 60_000;
    recordTurnCheckpoint("c1", turn(now - 5 * 60_000, [
      { path: "D:/评测区/src/a.ts", before: "a" },
      { path: "D:/评测区/src/b.ts", before: "b" },
    ]));
    const text = describeTurnCheckpoints("c1", now);
    expect(text).toContain("可回滚的检查点（共 1 轮）");
    expect(text).toContain("5 分钟前");
    expect(text).toContain("2 个文件（a.ts、b.ts）");
    expect(text).toContain("/rewind 1");
    expect(text).toContain("对话历史不会一起退");
  });

  it("抓不到原文的文件会在列表里标出来", () => {
    recordTurnCheckpoint("c1", turn(1_000, [
      { path: "D:/评测区/a.ts", before: "a" },
      { path: "D:/评测区/bin.dat", before: null, skipped: "binary" },
    ]));
    expect(describeTurnCheckpoints("c1", 2_000)).toContain("其中 1 个抓不到原文");
  });
});

describe("一轮的抓取缓冲", () => {
  it("同路径只留最早那份，收口后落成检查点", () => {
    beginRewindTurn("c1", 1_000);
    expect(noteRewindFile("c1", { path: "D:/评测区/a.ts", before: "最早" })).toBe(true);
    expect(noteRewindFile("c1", { path: "D:/评测区/a.ts", before: "后来的" })).toBe(false);
    const closed = closeRewindTurn("c1", 2_000);
    expect(closed?.files).toEqual([{ path: "D:/评测区/a.ts", before: "最早" }]);
    expect(getTurnCheckpoints("c1")).toHaveLength(1);
    // 缓冲已清空：再收一次不会再落一轮
    expect(closeRewindTurn("c1", 3_000)).toBeNull();
    expect(getTurnCheckpoints("c1")).toHaveLength(1);
  });

  it("这一轮没抓到东西就不留空检查点", () => {
    beginRewindTurn("c1", 1_000);
    expect(closeRewindTurn("c1", 2_000)).toBeNull();
    expect(getTurnCheckpoints("c1")).toHaveLength(0);
  });

  it("单轮预算：超出后不再继续抓", () => {
    beginRewindTurn("c1", 1_000);
    const big = "x".repeat(REWIND_MAX_FILE_CHARS);
    for (let index = 0; index < 8; index += 1) {
      noteRewindFile("c1", { path: `D:/评测区/f${index}.ts`, before: big });
    }
    const closed = closeRewindTurn("c1", 2_000);
    expect(closed).not.toBeNull();
    expect(closed!.files.length).toBeLessThan(8);
  });
});

describe("withRewindCapture", () => {
  function bridgeOf(handler: (call: { name: string; arguments: string }) => unknown): ToolBridge {
    return {
      tools: [{ type: "function" }],
      execute: vi.fn(async (call: { name: string; arguments: string }) => {
        const result = handler(call);
        return result as { text: string; ok: boolean };
      }),
    } as unknown as ToolBridge;
  }

  it("写工具执行前先读原文，读到的内容进检查点", async () => {
    const read = vi.fn(async () => ({ ok: true as const, content: "改之前", bytes: 9 }));
    (window as unknown as { __heming_files?: unknown }).__heming_files = { read, write: vi.fn(async () => ({ ok: true })) };
    const order: string[] = [];
    const inner = bridgeOf(() => {
      order.push("execute");
      return { text: "知道了", ok: true };
    });
    const wrapped = withRewindCapture(inner, { conversationId: () => "c1", roots: () => ROOTS, now: () => 1_000 });
    await wrapped.execute({ name: "file_write", arguments: JSON.stringify({ path: "a.ts", content: "新的" }) });
    expect(order).toEqual(["execute"]);
    expect(read).toHaveBeenCalledTimes(1);
    const closed = closeRewindTurn("c1", 2_000);
    expect(closed?.files).toEqual([{ path: "D:/评测区/a.ts", before: "改之前" }]);
  });

  it("读工具不抓（只抓真正会写盘的三个）", async () => {
    const read = vi.fn(async () => ({ ok: true as const, content: "x", bytes: 1 }));
    (window as unknown as { __heming_files?: unknown }).__heming_files = { read, write: vi.fn(async () => ({ ok: true })) };
    const wrapped = withRewindCapture(bridgeOf(() => ({ text: "ok", ok: true })), {
      conversationId: () => "c1",
      roots: () => ROOTS,
    });
    await wrapped.execute({ name: "file_read", arguments: JSON.stringify({ path: "a.ts" }) });
    await wrapped.execute({ name: "todo_write", arguments: "{}" });
    expect(read).not.toHaveBeenCalled();
    expect(closeRewindTurn("c1")).toBeNull();
  });

  it("没有文件桥 / 读抛错都不影响工具执行结果", async () => {
    const inner = bridgeOf(() => ({ text: "照常执行", ok: true }));
    const wrappedNoBridge = withRewindCapture(inner, { conversationId: () => "c1", roots: () => ROOTS });
    await expect(
      wrappedNoBridge.execute({ name: "file_write", arguments: JSON.stringify({ path: "a.ts", content: "x" }) }),
    ).resolves.toEqual({ text: "照常执行", ok: true });

    (window as unknown as { __heming_files?: unknown }).__heming_files = {
      read: vi.fn(async () => Promise.reject(new Error("通道断了"))),
      write: vi.fn(async () => ({ ok: true })),
    };
    const wrapped = withRewindCapture(inner, { conversationId: () => "c1", roots: () => ROOTS });
    await expect(
      wrapped.execute({ name: "file_write", arguments: JSON.stringify({ path: "a.ts", content: "x" }) }),
    ).resolves.toEqual({ text: "照常执行", ok: true });
    // 读失败的文件仍会记成「跳过」——回滚时要如实说它没被还原
    expect(closeRewindTurn("c1")?.files[0]?.skipped).toBe("unreadable");
  });

  it("保留 meta 与 tools（外层包装仍能判风险）", () => {
    const meta = () => ({ risk: "write" as const });
    const inner = { ...bridgeOf(() => ({ text: "", ok: true })), meta };
    const wrapped = withRewindCapture(inner, { conversationId: () => "c1", roots: () => ROOTS });
    expect(wrapped.tools).toBe(inner.tools);
    expect(wrapped.meta?.("file_write")).toEqual({ risk: "write" });
  });
});
