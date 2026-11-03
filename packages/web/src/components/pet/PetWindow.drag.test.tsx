/**
 * 桌宠拖拽（PetWindow）· 交互测试。
 *
 * 这里钉住三类回归：
 * 1. **移动按 rAF 合并**：原生 mousemove 逐次 IPC + 主进程逐次 setPosition 是
 *    「拖动残影/边缘闪烁」的根因，所以同一帧最多一次 dragMove，抬起补终值；
 * 2. **拖拽期间冻结**：不追视、不判命中、不报穿透、暂停 Live2D，抬起后恢复；
 * 3. **tap 之后不残留拖拽**：鼠标抬起后继续移动（buttons=0）不该把桌宠带着跑。
 *
 * Live2D 与对话 hook 全部换成可控桩：不起 pixi、不联网，只验交互状态机。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent, cleanup } from "@testing-library/react";

const live2d = vi.hoisted(() => ({
  playMotion: vi.fn(),
  setMouthOpen: vi.fn(),
  focus: vi.fn(),
  focusCenter: vi.fn(),
  setPaused: vi.fn(),
  resizeTo: vi.fn(),
  /** useLive2D 收到的视口尺寸：用来断言「拖拽期间 viewport 冻结」 */
  lastViewport: { width: 0, height: 0 },
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
  useLive2D: (opts: { width: number; height: number }) => {
    live2d.lastViewport = { width: opts.width, height: opts.height };
    return {
      status: "ready",
      error: null,
      // 覆盖整个窗口：光标在任何位置都算「在角色上」，用来观察穿透上报
      hitBox: { x: 0, y: 0, width: 300, height: 420 },
      ...live2d,
    };
  },
}));

vi.mock("./usePetChat.js", () => ({
  usePetChat: () => chat,
}));

import { PetWindow } from "./PetWindow.js";

interface BridgeHandle {
  dragStart: ReturnType<typeof vi.fn>;
  dragMove: ReturnType<typeof vi.fn>;
  dragEnd: ReturnType<typeof vi.fn>;
  setInteractive: ReturnType<typeof vi.fn>;
}

function installBridge(): BridgeHandle {
  const bridge: BridgeHandle = {
    dragStart: vi.fn(),
    dragMove: vi.fn(),
    dragEnd: vi.fn(),
    setInteractive: vi.fn(),
  };
  (window as unknown as { __heming_pet?: unknown }).__heming_pet = {
    ...bridge,
    onEvent: () => () => {},
    openSettings: vi.fn(),
    emit: vi.fn(),
  };
  return bridge;
}

beforeEach(() => {
  localStorage.clear();
  for (const [key, value] of Object.entries(live2d)) {
    if (key !== "lastViewport") (value as ReturnType<typeof vi.fn>).mockClear();
  }
  live2d.lastViewport = { width: 0, height: 0 };
  chat.streaming = false;
  chat.reply = "";
  chat.error = null;
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { __heming_pet?: unknown }).__heming_pet;
  vi.useRealTimers();
});

/** 越过 4px 拖拽阈值的按下 + 移动（在 window 的冒泡阶段处理，所以派发到 body 上）。 */
function startDrag(bridge: BridgeHandle, from = { x: 50, y: 50 }): void {
  act(() => {
    fireEvent.mouseDown(document.body, { button: 0, clientX: from.x, clientY: from.y, buttons: 1 });
    fireEvent.mouseMove(document.body, {
      clientX: from.x + 40,
      clientY: from.y + 40,
      buttons: 1,
    });
  });
  expect(bridge.dragStart).toHaveBeenCalledTimes(1);
}

describe("PetWindow · 拖拽期间冻结", () => {
  it("拖拽期间不再追视/报穿透，并暂停 Live2D；抬起后恢复并渲染一帧", () => {
    const bridge = installBridge();
    render(<PetWindow />);

    // 拖拽前：一次窗口内移动会追视并上报「可交互」
    act(() => {
      fireEvent.mouseMove(document.body, { clientX: 50, clientY: 50, buttons: 0 });
    });
    expect(live2d.focus).toHaveBeenCalledTimes(1);
    expect(bridge.setInteractive).toHaveBeenCalledWith(true);

    startDrag(bridge);
    expect(live2d.setPaused).toHaveBeenCalledWith(true);
    expect(document.body.style.cursor).toBe("grabbing");

    live2d.focus.mockClear();
    bridge.setInteractive.mockClear();

    // 拖拽中继续移动：不追视、不再做命中判定与穿透上报
    act(() => {
      fireEvent.mouseMove(document.body, { clientX: 150, clientY: 150, buttons: 1 });
    });
    expect(live2d.focus).not.toHaveBeenCalled();
    expect(bridge.setInteractive).not.toHaveBeenCalled();

    // 抬起：恢复舞台（渲染一帧）、还原光标、按当前指针重新对焦点、通知主进程收尾
    act(() => {
      fireEvent.mouseUp(document.body, { button: 0, clientX: 150, clientY: 150, buttons: 0 });
    });
    expect(bridge.dragEnd).toHaveBeenCalledTimes(1);
    expect(live2d.setPaused).toHaveBeenLastCalledWith(false);
    expect(live2d.focus).toHaveBeenLastCalledWith(150, 150);
    expect(document.body.style.cursor).toBe("");
  });
});

describe("PetWindow · tap 之后不残留拖拽", () => {
  it("抬起后光标继续移动（buttons=0）不会开始拖拽，单击照常呼出输入框", () => {
    const bridge = installBridge();
    render(<PetWindow />);

    act(() => {
      fireEvent.mouseDown(document.body, { button: 0, clientX: 10, clientY: 10, buttons: 1 });
      fireEvent.mouseUp(document.body, { button: 0, clientX: 10, clientY: 10, buttons: 0 });
    });
    expect(bridge.dragStart).not.toHaveBeenCalled();

    // 浏览器在抬起后仍会派发 mousemove；修复前这里会被当成"继续拖"并触发 dragStart
    act(() => {
      fireEvent.mouseMove(document.body, { clientX: 200, clientY: 200, buttons: 0 });
    });
    expect(bridge.dragStart).not.toHaveBeenCalled();
    expect(bridge.dragMove).not.toHaveBeenCalled();
    expect(bridge.dragEnd).not.toHaveBeenCalled();

    // tap 本身仍然生效
    expect(screen.getByLabelText("和桌宠说话")).toBeInTheDocument();
  });

  it("按下后没松开就移出阈值才算拖拽（buttons=1 才进入拖拽）", () => {
    const bridge = installBridge();
    render(<PetWindow />);

    act(() => {
      fireEvent.mouseDown(document.body, { button: 0, clientX: 10, clientY: 10, buttons: 1 });
      // 阈值内：还是点击候选
      fireEvent.mouseMove(document.body, { clientX: 12, clientY: 12, buttons: 1 });
    });
    expect(bridge.dragStart).not.toHaveBeenCalled();

    act(() => {
      fireEvent.mouseMove(document.body, { clientX: 60, clientY: 60, buttons: 1 });
    });
    expect(bridge.dragStart).toHaveBeenCalledTimes(1);
  });

  it("拖拽中丢失 mouseup（在窗口外松开）时，下一次 buttons=0 的移动会收尾", () => {
    const bridge = installBridge();
    render(<PetWindow />);
    startDrag(bridge);

    act(() => {
      // 没收到 mouseup，但后续移动已显示左键抬起 → 收尾，不能一直卡在拖拽中
      fireEvent.mouseMove(document.body, { clientX: 200, clientY: 200, buttons: 0 });
    });
    expect(bridge.dragEnd).toHaveBeenCalledTimes(1);
    expect(live2d.setPaused).toHaveBeenLastCalledWith(false);
    expect(document.body.style.cursor).toBe("");
  });

  it("窗口失焦（Alt+Tab）时拖拽状态复位，不留幽灵拖拽", () => {
    const bridge = installBridge();
    render(<PetWindow />);
    startDrag(bridge);

    act(() => {
      fireEvent.blur(window);
    });
    expect(bridge.dragEnd).toHaveBeenCalledTimes(1);
    expect(live2d.setPaused).toHaveBeenLastCalledWith(false);
    expect(document.body.style.cursor).toBe("");

    // 之后左键按着再移动，也不该沿用到失焦前的那次拖拽
    bridge.dragStart.mockClear();
    act(() => {
      fireEvent.mouseMove(document.body, { clientX: 250, clientY: 250, buttons: 1 });
    });
    expect(bridge.dragStart).not.toHaveBeenCalled();
  });
});

describe("PetWindow · 拖拽期间冻结窗口尺寸（d.68 局部放大/裁切）", () => {
  /** jsdom 的 innerWidth 是只读的：临时改写来模拟「拖动中客户区尺寸变化」。 */
  function setInnerSize(width: number, height: number): () => void {
    const original = {
      width: Object.getOwnPropertyDescriptor(window, "innerWidth"),
      height: Object.getOwnPropertyDescriptor(window, "innerHeight"),
    };
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
    return () => {
      for (const [key, descriptor] of Object.entries(original)) {
        if (descriptor) Object.defineProperty(window, key, descriptor);
      }
    };
  }

  it("拖拽中的 resize 被忽略，抬起后重测客户区尺寸并重拟合", () => {
    const bridge = installBridge();
    render(<PetWindow />);
    const beforeDrag = { ...live2d.lastViewport };
    // 首次挂载会同步一次尺寸（挂载时 viewport 初值）
    live2d.resizeTo.mockClear();

    startDrag(bridge);

    // 拖动中 Chromium 会因跨屏 DPI / 像素取整派发 resize：此时不能重排
    const restore = setInnerSize(360, 520);
    act(() => {
      window.dispatchEvent(new Event("resize"));
      window.dispatchEvent(new Event("resize"));
    });
    try {
      expect(live2d.resizeTo).not.toHaveBeenCalled();
      // viewport 也冻结在拖拽前的尺寸上：拖动中画面不跳
      expect(live2d.lastViewport).toEqual(beforeDrag);
    } finally {
      // 抬起时仍按「落点后的真实尺寸」重测（360×520）
      act(() => {
        fireEvent.mouseUp(document.body, { button: 0, clientX: 150, clientY: 150, buttons: 0 });
      });
      expect(live2d.resizeTo).toHaveBeenCalledWith(360, 520);
      restore();
    }
  });

  it("非拖拽状态的 resize 照常同步（缩放档位切换要立即重排）", () => {
    const bridge = installBridge();
    render(<PetWindow />);
    const restore = setInnerSize(320, 448);
    try {
      act(() => {
        window.dispatchEvent(new Event("resize"));
      });
      // 视口更新交给 useLive2D 的 resize effect（真实实现里会重设分辨率并重拟合）
      expect(live2d.lastViewport).toEqual({ width: 320, height: 448 });
      expect(bridge.dragStart).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});

describe("PetWindow · 移动上报按帧合并", () => {
  it("同一帧内多次 mousemove 只发一次 dragMove", () => {
    vi.useFakeTimers();
    const bridge = installBridge();
    render(<PetWindow />);

    act(() => {
      fireEvent.mouseDown(document.body, { button: 0, clientX: 10, clientY: 10, buttons: 1 });
      fireEvent.mouseMove(document.body, { clientX: 60, clientY: 60, buttons: 1 }); // 开始拖拽
      fireEvent.mouseMove(document.body, { clientX: 70, clientY: 70, buttons: 1 });
      fireEvent.mouseMove(document.body, { clientX: 80, clientY: 80, buttons: 1 });
    });
    // 还没到下一帧：一次 IPC 都没发
    expect(bridge.dragMove).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(20);
    });
    expect(bridge.dragMove).toHaveBeenCalledTimes(1);
  });

  it("抬起时补一次终值（最后一帧 rAF 还没执行也不丢最后一段位移）", () => {
    vi.useFakeTimers();
    const bridge = installBridge();
    render(<PetWindow />);

    act(() => {
      fireEvent.mouseDown(document.body, { button: 0, clientX: 10, clientY: 10, buttons: 1 });
      fireEvent.mouseMove(document.body, { clientX: 60, clientY: 60, buttons: 1 });
      fireEvent.mouseMove(document.body, { clientX: 90, clientY: 90, buttons: 1 });
    });
    expect(bridge.dragMove).not.toHaveBeenCalled();

    // 帧还没跑就松手 → flush 补一次终值，然后才是 dragEnd
    act(() => {
      fireEvent.mouseUp(document.body, { button: 0, clientX: 90, clientY: 90, buttons: 0 });
    });
    expect(bridge.dragMove).toHaveBeenCalledTimes(1);
    expect(bridge.dragEnd).toHaveBeenCalledTimes(1);

    // 已补发过，到没到帧都不该再重复上报
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(bridge.dragMove).toHaveBeenCalledTimes(1);
  });

  it("帧已执行后安静松手不重复发移动", () => {
    vi.useFakeTimers();
    const bridge = installBridge();
    render(<PetWindow />);

    act(() => {
      fireEvent.mouseDown(document.body, { button: 0, clientX: 10, clientY: 10, buttons: 1 });
      fireEvent.mouseMove(document.body, { clientX: 60, clientY: 60, buttons: 1 });
      vi.advanceTimersByTime(20);
    });
    expect(bridge.dragMove).toHaveBeenCalledTimes(1);

    act(() => {
      fireEvent.mouseUp(document.body, { button: 0, clientX: 60, clientY: 60, buttons: 0 });
    });
    expect(bridge.dragMove).toHaveBeenCalledTimes(1);
    expect(bridge.dragEnd).toHaveBeenCalledTimes(1);
  });
});
