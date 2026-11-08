/**
 * 桌宠消费端（PetWindow）· 在场感渲染测试。
 *
 * 只测「宿主事件 → 气泡/姿态/点击」这一层：Live2D 与对话 hook 都换成可控桩，
 * 不启动 pixi，也不碰网络。
 *
 * d.98 差异：事件与偏好都来自宿主 widget 桥（`window.__heming_widget`），
 * 不再是 `__heming_pet` + localStorage。
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
import { PRESENCE_BUBBLE_MS } from "../../lib/petEvent.js";

interface BridgeHandle {
  push: (payload: unknown) => void;
  /** 模拟用户在宿主设置表单里改值：宿主会把新 settings 推给 widget */
  changeSettings: (settings: Record<string, unknown>) => void;
  openPage: ReturnType<typeof vi.fn>;
  openSettings: ReturnType<typeof vi.fn>;
}

function installBridge(initialSettings: Record<string, unknown> = {}): BridgeHandle {
  const handlers: Array<(payload: unknown) => void> = [];
  const settingsHandlers: Array<(settings: Record<string, unknown>) => void> = [];
  let current = { modelPath: "pet/Hiyori/Hiyori.model3.json", presence: "normal", ...initialSettings };
  const openPage = vi.fn();
  const openSettings = vi.fn();

  (window as unknown as { __heming_widget?: unknown }).__heming_widget = {
    settings: async () => current,
    setSetting: async (key: string, value: unknown) => {
      current = { ...current, [key]: value };
      settingsHandlers.forEach((cb) => cb(current));
      return current;
    },
    onSettings: (cb: (settings: Record<string, unknown>) => void) => {
      settingsHandlers.push(cb);
      return () => {
        const index = settingsHandlers.indexOf(cb);
        if (index >= 0) settingsHandlers.splice(index, 1);
      };
    },
    onEvent: (cb: (payload: unknown) => void) => {
      handlers.push(cb);
      return () => {
        const index = handlers.indexOf(cb);
        if (index >= 0) handlers.splice(index, 1);
      };
    },
    openPage,
    openSettings,
    chatConfig: async () => null,
    info: async () => ({ theme: "light" }),
  };

  return {
    push: (payload) => handlers.forEach((cb) => cb(payload)),
    changeSettings: (patch) => {
      current = { ...current, ...patch };
      settingsHandlers.forEach((cb) => cb(current));
    },
    openPage,
    openSettings,
  };
}

beforeEach(() => {
  live2d.playMotion.mockClear();
  chat.streaming = false;
  chat.reply = "";
  chat.error = null;
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { __heming_widget?: unknown }).__heming_widget;
  vi.useRealTimers();
});

describe("PetWindow · 在场感气泡", () => {
  it("正常档（默认）：事件冒泡 4 秒后收回，点击气泡直达对应页面", () => {
    vi.useFakeTimers();
    const bridge = installBridge();
    render(<PetWindow />);

    act(() => {
      bridge.push({ kind: "schedule", title: "晚自习", at: "19:00", route: "infohub" });
    });
    const bubble = screen.getByText("19:00 晚自习");
    expect(bubble).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(PRESENCE_BUBBLE_MS + 50);
    });
    expect(screen.queryByText("19:00 晚自习")).not.toBeInTheDocument();

    act(() => {
      bridge.push({ kind: "task", title: "周报", ok: true, route: "tasks" });
    });
    act(() => {
      fireEvent.click(screen.getByText("完成了：周报"));
    });
    expect(bridge.openPage).toHaveBeenCalledWith("tasks");
  });

  it("宿主转发的 notify 事件：summary 优先、带 at 时按日程", () => {
    const bridge = installBridge();
    render(<PetWindow />);

    act(() => {
      bridge.push({ kind: "notify", title: "幕僚简报", summary: "今天 3 个任务待处理" });
    });
    expect(screen.getByText("今天 3 个任务待处理")).toBeInTheDocument();
  });

  it("安静档：只换姿态、不冒泡（但会播一次开心动作）", async () => {
    const bridge = installBridge({ presence: "quiet" });
    render(<PetWindow />);
    // 等宿主 settings() 落地（默认值是「正常」，不能拿它当真实档位）
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      bridge.push({ kind: "task", title: "周报", ok: true, route: "tasks" });
    });

    expect(screen.queryByText(/完成了：周报/)).not.toBeInTheDocument();
    expect(live2d.playMotion).toHaveBeenCalledWith("TapBody"); // happy 姿态的动作映射
  });

  it("积极档：气泡 + 姿态动作（与安静/正常行为不同）", async () => {
    const bridge = installBridge({ presence: "eager" });
    render(<PetWindow />);
    await act(async () => {
      await Promise.resolve();
    });

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

  it("三档强度即时生效：宿主改完设置，下一条事件就按新档位（不必重开窗口）", async () => {
    const bridge = installBridge({ presence: "normal" });
    render(<PetWindow />);
    // 等首帧 settings() 落地
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      bridge.push({ kind: "task", title: "周报", ok: true, route: "tasks" });
    });
    expect(screen.getByText("完成了：周报")).toBeInTheDocument();
    expect(live2d.playMotion).not.toHaveBeenCalled(); // 正常档不动姿态

    // 模拟用户在宿主设置表单里改成「安静」：宿主经 onSettings 推给 widget
    act(() => {
      bridge.changeSettings({ presence: "quiet" });
    });
    act(() => {
      bridge.push({ kind: "task", title: "部署", ok: true, route: "tasks" });
    });

    // 下一条事件立刻按安静档：不冒泡、只换姿态（happy → 播一次 TapBody）
    expect(screen.queryByText(/完成了：/)).not.toBeInTheDocument();
    expect(live2d.playMotion).toHaveBeenCalledWith("TapBody");
  });
});
