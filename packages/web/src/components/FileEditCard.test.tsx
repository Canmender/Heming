import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { FileEditCard } from "./FileEditCard.js";
import { FileRootsStore } from "../lib/fileEdit/roots.js";
import type { FileFsBridge } from "../lib/fileEdit/bridge.js";
import { HitlPolicyStore } from "../lib/hitl/policy.js";
import type { StorageLike } from "../lib/memory/types.js";

/** 内存存储（与 localStorage 同接口）。 */
function memoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
}

const fakeBridge = (picked: string | null = null): FileFsBridge => ({
  read: async () => ({ ok: false, code: "not-found", error: "文件不存在" }),
  write: async () => ({ ok: false, error: "不该走到写入" }),
  pickRoot: async () => picked,
});

/** 每个用例独立 store，避免相互影响。 */
function setup(bridge: FileFsBridge | null = fakeBridge()) {
  const rootsStore = new FileRootsStore(memoryStorage());
  const policyStore = new HitlPolicyStore(memoryStorage());
  render(<FileEditCard rootsStore={rootsStore} policyStore={policyStore} bridge={bridge} />);
  return { rootsStore, policyStore };
}

describe("设置区 · 文件编辑卡", () => {
  it("浏览器端（没有文件桥）显示「仅桌面端可用」，不给假入口", () => {
    setup(null);
    expect(screen.getByText(/仅桌面端可用/)).toBeTruthy();
    expect(screen.queryByLabelText("可写根路径")).toBeNull();
  });

  it("未配置时说明「智能体不能改任何文件」并指出只读根只能读", () => {
    setup();
    expect(screen.getByText(/还没有可写根/)).toBeTruthy();
    expect(screen.getByText(/不能改任何文件/)).toBeTruthy();
    expect(screen.getByText(/只读根/)).toBeTruthy();
  });

  it("添加可写根后出现在列表里，并提示已添加", () => {
    const { rootsStore } = setup();
    fireEvent.change(screen.getByLabelText("可写根路径"), {
      target: { value: "D:/Obsidian/学院事务" },
    });
    fireEvent.click(screen.getByText("添加"));
    expect(rootsStore.writeRoots()).toHaveLength(1);
    expect(screen.getByText("学院事务")).toBeTruthy();
    expect(screen.getByText(/已添加可写根/)).toBeTruthy();
  });

  it("非法路径给出可行动的错误文案，且不落库", () => {
    const { rootsStore } = setup();
    fireEvent.change(screen.getByLabelText("可写根路径"), { target: { value: "D:/" } });
    fireEvent.click(screen.getByText("添加"));
    expect(rootsStore.roots()).toHaveLength(0);
    expect(screen.getByText(/不能是盘符根/)).toBeTruthy();
  });

  it("切换根模式：可写 → 只读", () => {
    const { rootsStore } = setup();
    fireEvent.change(screen.getByLabelText("可写根路径"), { target: { value: "D:/库" } });
    fireEvent.click(screen.getByText("添加"));
    fireEvent.change(screen.getByLabelText("库 读写模式"), { target: { value: "read" } });
    expect(rootsStore.roots()[0].mode).toBe("read");
  });

  it("删除根", () => {
    const { rootsStore } = setup();
    fireEvent.change(screen.getByLabelText("可写根路径"), { target: { value: "D:/库" } });
    fireEvent.click(screen.getByText("添加"));
    expect(rootsStore.roots()).toHaveLength(1);
    fireEvent.click(screen.getByLabelText("删除根 库"));
    expect(rootsStore.roots()).toHaveLength(0);
  });

  it("越界处理方式可切换", () => {
    const { rootsStore } = setup();
    fireEvent.change(screen.getByLabelText("越界处理方式"), { target: { value: "reject" } });
    expect(rootsStore.get().outOfRoot).toBe("reject");
  });

  it("「选择目录」把系统选择器的结果填进路径框", async () => {
    setup(fakeBridge("D:/从选择器来的"));
    fireEvent.click(screen.getByText("选择目录"));
    const input = screen.getByLabelText("可写根路径") as HTMLInputElement;
    await vi.waitFor(() => expect(input.value).toBe("D:/从选择器来的"));
  });

  it("展示已记住的目录授权规则（可读口径）", () => {
    const policyStore = new HitlPolicyStore(memoryStorage());
    policyStore.rememberRules("file_patch", ["D:/Obsidian/学院事务/"], "allow");
    const rootsStore = new FileRootsStore(memoryStorage());
    render(<FileEditCard rootsStore={rootsStore} policyStore={policyStore} bridge={fakeBridge()} />);
    expect(screen.getByText("已记住的目录授权（1 条）")).toBeTruthy();
    expect(screen.getByText("D:/Obsidian/学院事务/")).toBeTruthy();
  });
});
