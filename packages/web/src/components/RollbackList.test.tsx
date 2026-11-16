import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RollbackList } from "./RollbackList.js";
import { fileRootsStore } from "../lib/fileEdit/roots.js";
import type { FileBackupItem, FileFsBridge } from "../lib/fileEdit/bridge.js";

const ROOT = { name: "库", path: "D:/库", mode: "write" as const };

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

/** 用全局单例 store 装上一条写根：列表要按根显示相对路径。 */
function withRoot() {
  fileRootsStore.set({ roots: [ROOT], outOfRoot: "ask" } as never);
}

function item(path: string, at = "2026-11-16T05:00:00.000Z", bytes = 32): FileBackupItem {
  return { path, at, bytes };
}

function fakeBridge(overrides: Partial<FileFsBridge> = {}, items: FileBackupItem[] = []): FileFsBridge {
  return {
    read: async () => ({ ok: false, code: "not-found", error: "文件不存在" }),
    write: async () => ({ ok: false, error: "不该写入" }),
    pickRoot: async () => null,
    backups: async () => ({ ok: true, items }),
    undo: async ({ path }) => ({ ok: true, path, restoredFrom: "2026-11-16T05:00:00.000Z", bytes: 32 }),
    ...overrides,
  };
}

afterEach(() => {
  act(() => {
    fileRootsStore.set({ roots: [], outOfRoot: "ask" } as never);
  });
  vi.restoreAllMocks();
  // 全局单例的存储是 localStorage：清掉，避免跨用例串根
  localStorage.removeItem("heming.fileEdit.roots.v1");
  void memoryStorage;
});

describe("设置区 · 最近改动（可回滚）", () => {
  it("桥不支持 backups 时整块不渲染（老安装包不给出点不动的列表）", () => {
    const { container } = render(
      <RollbackList bridge={{ read: async () => ({ ok: false, error: "x" }), write: async () => ({ ok: false, error: "x" }), pickRoot: async () => null }} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("列出最新一份改动：相对路径 + 时间 + 大小，并按根内相对路径显示", async () => {
    withRoot();
    render(<RollbackList bridge={fakeBridge({}, [item("D:/库/notes/a.md")])} />);
    expect(await screen.findByText("notes/a.md")).toBeTruthy();
    expect(screen.getByText("11-16 13:00")).toBeTruthy(); // 05:00Z → 本地 +8
    expect(screen.getByText("32 B")).toBeTruthy();
    expect(screen.getByRole("button", { name: /回滚 notes\/a\.md/ })).toBeTruthy();
  });

  it("点「回滚」调用 file:undo，成功后提示并重新拉列表（那一行消失）", async () => {
    withRoot();
    const undo = vi.fn(async ({ path }: { path: string }) => ({
      ok: true as const,
      path,
      restoredFrom: "2026-11-16T05:00:00.000Z",
      bytes: 32,
    }));
    const backups = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, items: [item("D:/库/notes/a.md")] })
      .mockResolvedValue({ ok: true, items: [] });
    render(<RollbackList bridge={fakeBridge({ undo, backups })} />);

    fireEvent.click(await screen.findByRole("button", { name: /回滚 notes\/a\.md/ }));

    await waitFor(() => expect(undo).toHaveBeenCalledWith({ roots: expect.any(Array), path: "D:/库/notes/a.md" }));
    expect(await screen.findByText(/已把 notes\/a\.md 回滚到/)).toBeTruthy();
    await waitFor(() => expect(screen.getByText("还没有可回滚的改动。")).toBeTruthy());
    expect(backups).toHaveBeenCalledTimes(2);
  });

  it("撤销失败（备份已被用掉）时显示错误，不假装成功", async () => {
    withRoot();
    const undo = vi.fn(async () => ({ ok: false as const, code: "no-backup" as const, error: "没有可回滚的备份" }));
    render(<RollbackList bridge={fakeBridge({ undo }, [item("D:/库/notes/a.md")])} />);
    fireEvent.click(await screen.findByRole("button", { name: /回滚 notes\/a\.md/ }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("回滚失败");
    expect(alert.textContent).toContain("没有可回滚的备份");
  });

  it("空列表给出「还没有可回滚的改动」，不显示无意义的空框", async () => {
    withRoot();
    render(<RollbackList bridge={fakeBridge({}, [])} />);
    expect(await screen.findByText("还没有可回滚的改动。")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /回滚 D:/ })).toBeNull();
  });
});
