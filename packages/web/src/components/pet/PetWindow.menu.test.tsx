/**
 * 桌宠右键菜单（PetWindow）· 交互测试。
 *
 * 用户 2026-11-03 报告「右键菜单里的 说点什么/放大/缩小/设置/隐藏 点了没反应」。
 * 根因有两处叠加，本文件各钉一条：
 *
 * 1. **命中区漏了菜单**：默认鼠标穿透时菜单区域不挡鼠标，点击直接落到桌面，
 *    窗口收不到 mousedown/click（→ 菜单打开后必须立刻上报可交互）；
 * 2. **click-away 在 mousedown 阶段卸载菜单**：点在菜单项上时菜单先被关掉，
 *    click 永远派发不到按钮（→ 菜单项 mousedown 不能关菜单）。
 *
 * Live2D 与对话 hook 全部换成可控桩：不起 pixi、不联网，只验交互状态机。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent, cleanup, waitFor } from "@testing-library/react";

const live2d = vi.hoisted(() => ({
  playMotion: vi.fn(),
  setMouthOpen: vi.fn(),
  focus: vi.fn(),
  focusCenter: vi.fn(),
  setPaused: vi.fn(),
  resizeTo: vi.fn(),
}));

const chat = vi.hoisted(() => ({
  hasConnection: true,
  streaming: false,
  reply: "",
  error: null as string | null,
  send: vi.fn(async () => {}),
  stop: vi.fn(),
}));

vi.mock("./useLive2D.js", () => ({
  useLive2D: () => ({
    status: "ready",
    error: null,
    // 模型还没加载 / 窗口内没有命中区：用来证明「浮层打开时必须主动上报可交互」
    hitBox: null,
    ...live2d,
  }),
}));

vi.mock("./usePetChat.js", () => ({
  usePetChat: () => chat,
}));

import { PetWindow } from "./PetWindow.js";

interface BridgeHandle {
  setInteractive: ReturnType<typeof vi.fn>;
  setScale: ReturnType<typeof vi.fn>;
  openSettings: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn>;
  resetPosition: ReturnType<typeof vi.fn>;
  setClickThrough: ReturnType<typeof vi.fn>;
  state: ReturnType<typeof vi.fn>;
}

function installBridge(opts: { clickThrough?: boolean; withReset?: boolean } = {}): BridgeHandle {
  const bridge: BridgeHandle = {
    setInteractive: vi.fn(),
    setScale: vi.fn(),
    openSettings: vi.fn(),
    hide: vi.fn(),
    resetPosition: vi.fn(),
    setClickThrough: vi.fn(),
    state: vi.fn(async () => ({
      visible: true,
      scale: 1,
      clickThrough: opts.clickThrough ?? true,
      bounds: { x: 100, y: 100, width: 300, height: 420 },
    })),
  };
  const exposed: Record<string, unknown> = {
    setInteractive: bridge.setInteractive,
    setScale: bridge.setScale,
    openSettings: bridge.openSettings,
    hide: bridge.hide,
    setClickThrough: bridge.setClickThrough,
    state: bridge.state,
    onEvent: () => () => {},
    emit: vi.fn(),
  };
  // 模拟旧版 preload：没有 resetPosition 时菜单不该出现这个死按钮
  if (opts.withReset !== false) exposed.resetPosition = bridge.resetPosition;
  (window as unknown as { __heming_pet?: unknown }).__heming_pet = exposed;
  return bridge;
}

beforeEach(() => {
  localStorage.clear();
  for (const mock of Object.values(live2d)) mock.mockClear();
  chat.streaming = false;
  chat.reply = "";
  chat.error = null;
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { __heming_pet?: unknown }).__heming_pet;
});

/** 右键角色（窗口空白处也算，本用例只关心菜单状态机）。 */
function openMenu(x = 120, y = 140): void {
  act(() => {
    fireEvent.contextMenu(document.body, { clientX: x, clientY: y });
  });
}

describe("PetWindow · 右键菜单打开（命中区单一来源）", () => {
  it("菜单打开后立刻上报「可交互」，不等下一次 mousemove；关闭后恢复穿透", () => {
    const bridge = installBridge();
    render(<PetWindow />);
    // 挂载时没有任何命中区，也没收到 mousemove → 不该上报
    expect(bridge.setInteractive).not.toHaveBeenCalledWith(true);

    openMenu();
    expect(screen.getByRole("menu")).toBeInTheDocument();
    // ★ 这条是「菜单点了没反应」的第一根因修复：菜单区域必须立刻拦截鼠标
    expect(bridge.setInteractive).toHaveBeenCalledWith(true);

    act(() => {
      // 点在窗口空白处（不在任何 data-pet-ui 里）→ 关菜单
      fireEvent.mouseDown(document.body, { clientX: 5, clientY: 380 });
    });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(bridge.setInteractive).toHaveBeenLastCalledWith(false);
  });

  it("菜单是 role=menu，项是 role=menuitem 且高度 ≥ 28px", () => {
    installBridge();
    render(<PetWindow />);
    openMenu();
    expect(screen.getByRole("menu")).toHaveAttribute("aria-label", "桌宠菜单");
    const items = screen.getAllByRole("menuitem");
    expect(items.length).toBeGreaterThanOrEqual(6);
    for (const item of items) {
      expect(item.style.minHeight).toBe("28px");
    }
  });
});

describe("PetWindow · 菜单项点击（click-away 不能抢跑）", () => {
  it("在菜单项上 mousedown 不会关菜单，click 能派发到按钮", () => {
    const bridge = installBridge();
    render(<PetWindow />);
    openMenu();

    const item = screen.getByRole("menuitem", { name: "放大一档" });
    act(() => {
      fireEvent.mouseDown(item, { button: 0, buttons: 1 });
    });
    // ★ 旧实现：全局 mousedown 无条件 setMenu(null)，菜单在这里就被卸载了
    expect(screen.getByRole("menu")).toBeInTheDocument();

    act(() => {
      fireEvent.click(item);
    });
    expect(bridge.setScale).toHaveBeenCalledWith({ dir: 1 });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("「说点什么」打开输入框并把焦点给输入框", async () => {
    installBridge();
    render(<PetWindow />);
    openMenu();
    act(() => {
      fireEvent.click(screen.getByRole("menuitem", { name: "说点什么" }));
    });
    await waitFor(() => expect(screen.getByLabelText("和桌宠说话")).toBeInTheDocument());
    expect(document.activeElement).toBe(screen.getByLabelText("和桌宠说话"));
  });

  it("「设置」「隐藏」都走既有桥方法", () => {
    const bridge = installBridge();
    render(<PetWindow />);

    openMenu();
    act(() => {
      fireEvent.click(screen.getByRole("menuitem", { name: "设置" }));
    });
    expect(bridge.openSettings).toHaveBeenCalledTimes(1);

    openMenu();
    act(() => {
      fireEvent.click(screen.getByRole("menuitem", { name: "隐藏" }));
    });
    expect(bridge.hide).toHaveBeenCalledTimes(1);
  });
});

describe("PetWindow · 键盘可达", () => {
  it("打开后聚焦第一项，方向键在项间移动", async () => {
    installBridge();
    render(<PetWindow />);
    openMenu();

    const items = screen.getAllByRole("menuitem");
    await waitFor(() => expect(document.activeElement).toBe(items[0]));

    act(() => {
      fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
    });
    expect(document.activeElement).toBe(items[1]);

    act(() => {
      fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowUp" });
    });
    expect(document.activeElement).toBe(items[0]);

    act(() => {
      fireEvent.keyDown(screen.getByRole("menu"), { key: "End" });
    });
    expect(document.activeElement).toBe(items[items.length - 1]);
  });

  it("Esc 关闭菜单并把焦点还给画布容器", async () => {
    installBridge();
    render(<PetWindow />);
    openMenu();
    await waitFor(() => expect(document.activeElement).toBe(screen.getAllByRole("menuitem")[0]));

    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    const canvas = document.querySelector("canvas");
    const root = canvas?.parentElement as HTMLElement | null;
    await waitFor(() => expect(document.activeElement).toBe(root));
  });
});

describe("PetWindow · 菜单能力项（重置位置 / 鼠标穿透）", () => {
  it("鼠标穿透项显示当前状态，点击后用既有 setClickThrough 切换", async () => {
    const bridge = installBridge({ clickThrough: true });
    render(<PetWindow />);
    openMenu();

    const item = await screen.findByRole("menuitem", { name: /鼠标穿透/ });
    await waitFor(() => expect(item.textContent).toContain("已开"));
    act(() => {
      fireEvent.click(item);
    });
    expect(bridge.setClickThrough).toHaveBeenCalledWith(false);
  });

  it("preload 暴露 resetPosition 时菜单出现「重置位置」并调用它", () => {
    const bridge = installBridge();
    render(<PetWindow />);
    openMenu();
    const item = screen.getByRole("menuitem", { name: "重置位置" });
    act(() => {
      fireEvent.click(item);
    });
    expect(bridge.resetPosition).toHaveBeenCalledTimes(1);
  });

  it("旧 preload 没有 resetPosition 时不渲染该死按钮（点了没反应不如不显示）", () => {
    installBridge({ withReset: false });
    render(<PetWindow />);
    openMenu();
    expect(screen.queryByRole("menuitem", { name: "重置位置" })).not.toBeInTheDocument();
    // 基础项仍然齐全
    expect(screen.getByRole("menuitem", { name: "说点什么" })).toBeInTheDocument();
  });
});
