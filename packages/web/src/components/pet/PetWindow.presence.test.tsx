/**
 * 桌宠消费端（PetWindow）· 在场感渲染测试。
 *
 * 只测「事件 → 气泡/姿态/点击」这一层：Live2D 与对话 hook 都换成可控桩，
 * 不启动 pixi，也不碰网络。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent, cleanup } from "@testing-library/react";

const live2d = vi.hoisted(() => ({
  playMotion: vi.fn(),
  setMouthOpen: vi.fn(),
  focus: vi.fn(),
  focusCenter: vi.fn(),
  setPaused: vi.fn(),
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
    hitBox: null,
    ...live2d,
  }),
}));

vi.mock("./usePetChat.js", () => ({
  usePetChat: () => chat,
}));

import { PetWindow } from "./PetWindow.js";
import { PET_PRESENCE_KEY, PRESENCE_BUBBLE_MS } from "../../lib/petEvent.js";

interface BridgeHandle {
  push: (payload: unknown) => void;
  openSettings: ReturnType<typeof vi.fn>;
}

function installBridge(): BridgeHandle {
  const handlers: Array<(payload: unknown) => void> = [];
  const openSettings = vi.fn();
  (window as unknown as { __heming_pet?: unknown }).__heming_pet = {
    emit: vi.fn(),
    openSettings,
    onEvent: (cb: (payload: unknown) => void) => {
      handlers.push(cb);
      return () => {
        const index = handlers.indexOf(cb);
        if (index >= 0) handlers.splice(index, 1);
      };
    },
  };
  return {
    push: (payload) => handlers.forEach((cb) => cb(payload)),
    openSettings,
  };
}

function setIntensity(value: "quiet" | "normal" | "eager"): void {
  localStorage.setItem(PET_PRESENCE_KEY, JSON.stringify({ intensity: value }));
}

beforeEach(() => {
  localStorage.clear();
  live2d.playMotion.mockClear();
  chat.streaming = false;
  chat.reply = "";
  chat.error = null;
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { __heming_pet?: unknown }).__heming_pet;
  vi.useRealTimers();
});

describe("PetWindow · 在场感气泡", () => {
  it("正常档（默认）：任务收尾冒泡 4 秒后收回，点击气泡直达任务区", () => {
    vi.useFakeTimers();
    const bridge = installBridge();
    render(<PetWindow />);

    act(() => {
      bridge.push({ kind: "task", title: "周报", ok: true, route: "tasks" });
    });
    const bubble = screen.getByText(/完成了：周报/);
    expect(bubble).toBeInTheDocument();
    expect(bubble.textContent).toContain("完成了：周报");

    act(() => {
      vi.advanceTimersByTime(PRESENCE_BUBBLE_MS + 50);
    });
    expect(screen.queryByText(/完成了：周报/)).not.toBeInTheDocument();

    // 再来一条并点击：复用 pet:open-settings 通道，带上 page
    act(() => {
      bridge.push({ kind: "schedule", title: "晚自习", at: "19:00", route: "infohub" });
    });
    act(() => {
      fireEvent.click(screen.getByText("19:00 晚自习"));
    });
    expect(bridge.openSettings).toHaveBeenCalledWith("infohub");
  });

  it("安静档：只换姿态、不冒泡（但会播一次开心动作）", () => {
    setIntensity("quiet");
    const bridge = installBridge();
    render(<PetWindow />);

    act(() => {
      bridge.push({ kind: "task", title: "周报", ok: true, route: "tasks" });
    });

    expect(screen.queryByText(/完成了：周报/)).not.toBeInTheDocument();
    expect(live2d.playMotion).toHaveBeenCalledWith("TapBody"); // happy 姿态的动作映射
  });

  it("积极档：气泡 + 姿态动作（与安静/正常行为不同）", () => {
    setIntensity("eager");
    const bridge = installBridge();
    render(<PetWindow />);

    act(() => {
      bridge.push({ kind: "task", title: "周报", ok: true, route: "tasks" });
    });

    expect(screen.getByText("完成了：周报")).toBeInTheDocument();
    expect(live2d.playMotion).toHaveBeenCalledWith("TapBody");
  });

  it("畸形事件：无任何反应、不抛（桌宠没有控制台）", () => {
    const bridge = installBridge();
    render(<PetWindow />);

    expect(() => {
      act(() => {
        for (const bad of [null, { kind: "speak", text: "" }, { kind: "pose", pose: "dancing" }, 42]) {
          bridge.push(bad);
        }
      });
    }).not.toThrow();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("三档强度即时生效：用户改完设置，桌宠下一次事件就按新档位（不必重开桌宠）", () => {
    setIntensity("normal");
    const bridge = installBridge();
    render(<PetWindow />);

    act(() => {
      bridge.push({ kind: "task", title: "周报", ok: true, route: "tasks" });
    });
    expect(screen.getByText("完成了：周报")).toBeInTheDocument();
    expect(live2d.playMotion).not.toHaveBeenCalled(); // 正常档不动姿态

    // 模拟用户此刻在设置区改成「安静」：只写 localStorage，不重载窗口
    setIntensity("quiet");
    act(() => {
      bridge.push({ kind: "task", title: "部署", ok: true, route: "tasks" });
    });

    // 下一条事件立刻按安静档：不冒泡、只换姿态（happy → 播一次 TapBody）
    expect(screen.queryByText(/完成了：/)).not.toBeInTheDocument();
    expect(live2d.playMotion).toHaveBeenCalledWith("TapBody");
  });
});
