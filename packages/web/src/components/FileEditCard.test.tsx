import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { FileEditCard } from "./FileEditCard.js";
import { FILE_ROOTS_KEY, FileRootsStore, setActiveWorkspace } from "../lib/fileEdit/roots.js";
import type { FileFsBridge } from "../lib/fileEdit/bridge.js";
import { HitlPolicyStore } from "../lib/hitl/policy.js";
import type { StorageLike } from "../lib/memory/types.js";
import { useChatStore } from "../store/chat.js";
import { useUiStore } from "../store/ui.js";

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
function setup(bridge: FileFsBridge | null = fakeBridge(), workspace?: string) {
  const rootsStore = new FileRootsStore(memoryStorage());
  const policyStore = new HitlPolicyStore(memoryStorage());
  render(
    <FileEditCard
      rootsStore={rootsStore}
      policyStore={policyStore}
      bridge={bridge}
      {...(workspace !== undefined ? { workspace } : {})}
    />,
  );
  return { rootsStore, policyStore };
}

afterEach(() => {
  // 全局 store 是单例：不清掉会把「活动会话工作区」漏给后面的用例。
  // 用 act 包住，避免触发仍在挂载中的组件更新（否则每个用例都会刷 act 警告）。
  act(() => {
    useChatStore.setState({ conversations: [] });
    useUiStore.setState({ activeConversationId: null });
  });
});

describe("设置区 · 文件编辑卡", () => {
  it("浏览器端（没有文件桥）显示「仅桌面端可用」，不给假入口、也不宣称工作区自动可写", () => {
    setup(null, "D:/项目/和鸣");
    expect(screen.getByText(/仅桌面端可用/)).toBeTruthy();
    expect(screen.queryByLabelText("可写根路径")).toBeNull();
    expect(screen.queryByText(/工作区（自动）/)).toBeNull();
    // 无桥时保持原文案：不能在没有文件能力的环境里说「会话工作区自动可写」
    expect(screen.getByText(/添加后 `file_read` 才会出现在智能体工具里/)).toBeTruthy();
  });

  it("有桥时说明「会话工作区会自动成为可写根」", () => {
    setup();
    expect(screen.getByText(/会话工作区会自动成为可写根/)).toBeTruthy();
  });

  it("有工作区时显示只读说明行，且不写进 localStorage", () => {
    setup(fakeBridge(), "D:/项目/和鸣");
    expect(screen.getByText(/工作区（自动）/)).toBeTruthy();
    expect(screen.getByText("D:/项目/和鸣")).toBeTruthy();
    expect(screen.getByText("· 无需手动添加")).toBeTruthy();
    // 自动根只派生、不落盘：设置区的根列表依旧是空的
    expect(window.localStorage.getItem(FILE_ROOTS_KEY)).toBeNull();
  });

  it("没有传 workspace 时从「当前活动会话」读取工作区", () => {
    useChatStore.setState({
      conversations: [{ id: "c1", workspace: "D:/项目/另一个" } as never],
    });
    useUiStore.setState({ activeConversationId: "c1" });
    setup();
    expect(screen.getByText("D:/项目/另一个")).toBeTruthy();
  });

  it("无活动会话时回退到 activeWorkspace()，不误报「没有工作区」（d.412 回归）", () => {
    // 设置页清空了 activeConversationId：conversationWorkspace 是空串，
    // 旧写法用 ?? 不会继续降级到 activeWorkspace()，会把工作区显示成「没有」。
    setActiveWorkspace("D:/来自活动工作区");
    act(() => {
      useChatStore.setState({ conversations: [] });
      useUiStore.setState({ activeConversationId: null });
    });
    setup();
    expect(screen.getByText("D:/来自活动工作区")).toBeTruthy();
    setActiveWorkspace(undefined);
  });

  it("未配置额外根时说明工作区已可读写，并指出这里管的是工作区之外", () => {
    setup();
    expect(screen.getByText(/还没有额外配置的可写根/)).toBeTruthy();
    expect(screen.getByText(/会话工作区里的文件智能体已经可以读写/)).toBeTruthy();
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

  it("逐条撤销目录授权：只删那一条，其它仍在，并提示会重新逐次询问", () => {
    const policyStore = new HitlPolicyStore(memoryStorage());
    policyStore.rememberRules("file_patch", ["D:/Obsidian/学院事务/"], "allow");
    policyStore.rememberRules("file_patch", ["D:/另一个项目/"], "allow");
    const rootsStore = new FileRootsStore(memoryStorage());
    render(<FileEditCard rootsStore={rootsStore} policyStore={policyStore} bridge={fakeBridge()} />);
    expect(screen.getByText("已记住的目录授权（2 条）")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("撤销 允许规则：file_patch D:/Obsidian/学院事务/"));

    // 列表与计数同步刷新（撤销后必须重渲染，否则用户会以为没生效再点一次）
    expect(screen.getByText("已记住的目录授权（1 条）")).toBeTruthy();
    expect(screen.queryByText("D:/Obsidian/学院事务/")).toBeNull();
    expect(screen.getByText("D:/另一个项目/")).toBeTruthy();
    expect(screen.getByText(/之后该目录内的改动会重新逐次询问/)).toBeTruthy();
    // 落盘也真的少了一条（不是只改了界面）
    expect(policyStore.rules()).toHaveLength(1);
  });

  it("「全部清空」要点两次：第一次只进入确认态，第二次才真的清空", () => {
    const policyStore = new HitlPolicyStore(memoryStorage());
    policyStore.rememberRules("file_patch", ["D:/Obsidian/学院事务/"], "allow");
    policyStore.rememberRules("file_patch", ["D:/另一个项目/"], "allow");
    const rootsStore = new FileRootsStore(memoryStorage());
    render(<FileEditCard rootsStore={rootsStore} policyStore={policyStore} bridge={fakeBridge()} />);

    fireEvent.click(screen.getByLabelText("清空全部记住的目录授权"));
    // 一次点击不该把授权清空——误触一次就全没，用户得重新一条条点回来
    expect(policyStore.rules()).toHaveLength(2);
    expect(screen.getByLabelText("确认清空全部记住的目录授权")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("确认清空全部记住的目录授权"));
    expect(policyStore.rules()).toHaveLength(0);
    expect(screen.getByText("已记住的目录授权")).toBeTruthy();
    expect(screen.getByText(/还没有。在确认弹窗里勾选「记住本次选择」/)).toBeTruthy();
    expect(screen.getByText("已清空全部记住的规则")).toBeTruthy();
  });

  it("拒绝规则也能撤销，撤销按钮的可读名称带「拒绝」", () => {
    const policyStore = new HitlPolicyStore(memoryStorage());
    policyStore.rememberRules("file_write", ["D:/只读区/"], "deny");
    const rootsStore = new FileRootsStore(memoryStorage());
    render(<FileEditCard rootsStore={rootsStore} policyStore={policyStore} bridge={fakeBridge()} />);

    fireEvent.click(screen.getByLabelText("撤销 拒绝规则：file_write D:/只读区/"));
    expect(policyStore.rules()).toHaveLength(0);
    expect(screen.queryByText("D:/只读区/")).toBeNull();
  });});
