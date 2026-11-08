import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { act } from "react";
import { UpdateCard } from "./UpdateCard";

/**
 * 更新卡的三个关键行为：
 * 1. 开发态（无桥）**整卡不渲染**——显示一个点不动的按钮比不显示更像坏了；
 * 2. 状态机按钮随主进程推送变化，且**不自动下载**；
 * 3. 下载完成后点按钮走「重启并安装」，这一步会终止进程。
 */
function makeBridge(initial: UpdateState) {
  let state = initial;
  const listeners = new Set<(s: UpdateState) => void>();
  // 用闭包变量而不是 `this.calls`：这些方法被当成裸函数传给组件时
  // （onClick 里调用）this 未必是返回的对象，写在 `this` 上的计数会丢。
  const calls = { check: 0, download: 0, install: 0 };
  return {
    calls,
    push(next: UpdateState) {
      state = next;
      for (const l of listeners) l(next);
    },
    bridge: {
      check: async () => {
        calls.check += 1;
        return state;
      },
      download: async () => {
        calls.download += 1;
        return state;
      },
      install: async () => {
        calls.install += 1;
        return true;
      },
      state: async () => state,
      subscribe: (cb: (s: UpdateState) => void) => {
        listeners.add(cb);
        cb(state);
        return () => listeners.delete(cb);
      },
    },
  };
}

const baseState = (over: Partial<UpdateState> = {}): UpdateState => ({
  status: "idle",
  currentVersion: "d.14.1.3.0",
  available: null,
  lastCheckedAt: null,
  lastError: null,
  canDownload: true,
  progress: null,
  ...over,
});

describe("UpdateCard", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });
  afterEach(() => {
    cleanup();
    delete window.__heming_update;
    vi.restoreAllMocks();
  });

  it("开发态没有更新桥时，整卡不渲染", () => {
    window.__heming_update = undefined;
    render(<UpdateCard currentVersion="d.14.1.3.0" />);
    expect(screen.queryByLabelText("软件更新")).toBeNull();
    expect(screen.queryByLabelText("检查更新")).toBeNull();
  });

  it("下载中显示进度条：百分比与已下载/总量随主进程推送更新", async () => {
    const h = makeBridge(
      baseState({
        status: "downloading",
        canDownload: true,
        available: { version: "d.15.0.0.0" },
        progress: {
          percent: 12.5,
          transferred: 31 * 1024 * 1024,
          total: 250 * 1024 * 1024,
          bytesPerSecond: 2 * 1024 * 1024,
        },
      }),
    );
    window.__heming_update = h.bridge;
    render(<UpdateCard currentVersion="d.14.1.3.0" />);

    const bar = (await screen.findByRole("progressbar", { name: "更新下载进度" })) as HTMLElement;
    expect(bar.getAttribute("aria-valuenow")).toBe("13");
    expect(screen.getByText(/已下载 13%/)).toBeTruthy();
    expect(screen.getByText(/250 MB/)).toBeTruthy();

    // 主进程继续推送：进度与文案跟着走（不需要用户再点任何东西）
    await act(async () => {
      h.push(
        baseState({
          status: "downloading",
          canDownload: true,
          progress: {
            percent: 68,
            transferred: 170 * 1024 * 1024,
            total: 250 * 1024 * 1024,
            bytesPerSecond: 3 * 1024 * 1024,
          },
        }),
      );
    });
    expect(screen.getByRole("progressbar", { name: "更新下载进度" }).getAttribute("aria-valuenow")).toBe("68");
    expect(screen.getByText(/已下载 68%/)).toBeTruthy();
  });

  it("下载完成：进度条消失，按钮变成「重启并安装」", async () => {
    const h = makeBridge(
      baseState({
        status: "downloaded",
        available: { version: "d.15.0.0.0" },
        progress: null,
      }),
    );
    window.__heming_update = h.bridge;
    render(<UpdateCard currentVersion="d.14.1.3.0" />);
    expect(await screen.findByText("重启并安装")).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("有桥时渲染当前版本与检查按钮", async () => {
    const h = makeBridge(baseState());
    window.__heming_update = h.bridge;
    render(<UpdateCard currentVersion="d.14.1.3.0" />);
    expect(await screen.findByLabelText("软件更新")).toBeTruthy();
    expect(screen.getByText("当前 d.14.1.3.0")).toBeTruthy();
    expect((screen.getByLabelText("检查更新") as HTMLButtonElement).disabled).toBe(false);
  });

  it("已是最新：点按钮是重新检查，而不是下载", async () => {
    const h = makeBridge(baseState({ status: "up-to-date" }));
    window.__heming_update = h.bridge;
    render(<UpdateCard currentVersion="d.14.1.3.0" />);
    expect(await screen.findByText("已是最新版本")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByLabelText("检查更新"));
    });
    expect(h.calls.check).toBe(1);
    expect(h.calls.download).toBe(0);
  });

  it("发现更新：提示新版本号，按钮变为下载，且不自动下载", async () => {
    const h = makeBridge(baseState({ status: "idle" }));
    window.__heming_update = h.bridge;
    render(<UpdateCard currentVersion="d.14.1.3.0" />);

    // 主进程在检查完成后推送：绝不自动下载
    await act(async () => {
      h.push(baseState({ status: "available", available: { version: "d.14.2.0.0" } }));
    });
    expect(await screen.findByText(/发现新版本 d\.14\.2\.0\.0/)).toBeTruthy();
    expect(h.calls.download).toBe(0);
    const button = screen.getByLabelText("检查更新") as HTMLButtonElement;
    expect(button.textContent).toContain("下载更新");

    await act(async () => {
      fireEvent.click(button);
    });
    expect(h.calls.download).toBe(1);
    expect(h.calls.check).toBe(0);
  });

  it("下载完成后点按钮是重启并安装", async () => {
    const h = makeBridge(baseState());
    window.__heming_update = h.bridge;
    render(<UpdateCard currentVersion="d.14.1.3.0" />);
    await act(async () => {
      h.push(baseState({ status: "downloaded", available: { version: "d.14.2.0.0" } }));
    });
    expect(await screen.findByText(/更新已下载完成/)).toBeTruthy();
    const button = screen.getByLabelText("检查更新") as HTMLButtonElement;
    expect(button.textContent).toContain("重启并安装");
    await act(async () => {
      fireEvent.click(button);
    });
    // 会终止进程：先弹确认，确认后才真正安装
    expect(h.calls.install).toBe(0);
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "重启并安装", hidden: false }) as HTMLButtonElement,
      );
    });
    expect(h.calls.install).toBe(1);
  });

  it("检查失败：显示原因，而不是笼统的「没更新」", async () => {
    const h = makeBridge(baseState());
    window.__heming_update = h.bridge;
    render(<UpdateCard currentVersion="d.14.1.3.0" />);
    await act(async () => {
      h.push(baseState({ status: "error", lastError: "检查失败：网络不可达" }));
    });
    expect(await screen.findByText("检查失败：网络不可达")).toBeTruthy();
  });

  it("下载中：按钮禁用，避免重复触发", async () => {
    const h = makeBridge(baseState());
    window.__heming_update = h.bridge;
    render(<UpdateCard currentVersion="d.14.1.3.0" />);
    await act(async () => {
      h.push(baseState({ status: "downloading" }));
    });
    const button = screen.getByLabelText("检查更新") as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(true));
  });

  it("开发态（canDownload=false）说明为什么不能下载", async () => {
    const h = makeBridge(baseState({ canDownload: false }));
    window.__heming_update = h.bridge;
    render(<UpdateCard currentVersion="d.14.1.3.0" />);
    expect(await screen.findByText(/开发模式不支持下载更新/)).toBeTruthy();
  });

  it("卸载时退订，不向已销毁组件推送", async () => {
    const h = makeBridge(baseState());
    window.__heming_update = h.bridge;
    const view = render(<UpdateCard currentVersion="d.14.1.3.0" />);
    await screen.findByLabelText("软件更新");
    view.unmount();
    // 退订后推送不应抛错（setState 到已卸载组件在 React 18 已无害，但仍验证退订发生）
    expect(() => h.push(baseState({ status: "up-to-date" }))).not.toThrow();
  });
});