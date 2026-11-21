import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConsolePanel } from "./ConsolePanel.js";

/** 交互式命令面板：口令只写自己那次 begin 的进程（全局 onCli 总线会广播所有命令）。 */

function installBridge(beginImpl?: () => Promise<{ ok: boolean; runId?: string; error?: string }>) {
  const listeners: ((event: Record<string, unknown>) => void)[] = [];
  const begin = vi.fn(beginImpl ?? (async () => ({ ok: true, runId: "cli-REAL" })));
  const cliInput = vi.fn(async (_runId: string, _text: string) => true);
  const bridge = {
    status: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    gateway: vi.fn(),
    cli: vi.fn(),
    cliStart: vi.fn(),
    cliBegin: begin,
    cliInput,
    cliKill: vi.fn(async () => true),
    openTerminal: vi.fn(),
    backupInfo: vi.fn(),
    backupPick: vi.fn(),
    onCli: vi.fn((callback: (event: Record<string, unknown>) => void) => {
      listeners.push(callback);
      return () => {
        const at = listeners.indexOf(callback);
        if (at >= 0) listeners.splice(at, 1);
      };
    }),
  };
  (window as unknown as { __heming_magpie?: unknown }).__heming_magpie = bridge;
  const emit = (event: Record<string, unknown>) => listeners.forEach((fn) => fn(event));
  return { bridge, begin, cliInput, emit };
}

beforeEach(() => {
  delete (window as unknown as { __heming_magpie?: unknown }).__heming_magpie;
});
afterEach(() => {
  delete (window as unknown as { __heming_magpie?: unknown }).__heming_magpie;
  vi.unstubAllGlobals();
});

describe("ConsolePanel", () => {
  it("只认自己那次 begin 的 runId：别人的 start/stdout/exit 都被忽略（d.412 回归）", async () => {
    const { begin, cliInput, emit } = installBridge();
    render(<ConsolePanel title="恢复备份" args={["restore"]} onClose={vi.fn()} />);
    await waitFor(() => expect(begin).toHaveBeenCalled());

    // 别人的 start 不能覆盖 runId
    emit({ runId: "cli-OTHER", type: "start", args: [] });
    // 别人的输出不能冒充成本命令输出
    emit({ runId: "cli-OTHER", type: "stdout", text: "SECRET-FROM-OTHER" });
    const onDone = vi.fn();

    const input = screen.getByLabelText("命令输入");
    fireEvent.change(input, { target: { value: "password123" } });
    const send = screen.getByRole("button", { name: "发送" });
    fireEvent.click(send);
    await waitFor(() => expect(cliInput).toHaveBeenCalledTimes(1));
    // 口令必须写给自己那次 begin 的进程，不是别人的 runId
    expect(cliInput.mock.calls[0]![0]).toBe("cli-REAL");
    // 别人的输出没进本面板
    expect(screen.queryByText(/SECRET-FROM-OTHER/)).toBeNull();
    void onDone;
  });

  it("begin 失败时显示错误、不卡在「进行中」，并回调 onDone（d.412 回归）", async () => {
    const onDone = vi.fn();
    installBridge(async () => ({ ok: false, error: "IPC 炸了" }));
    render(<ConsolePanel title="恢复备份" args={["restore"]} onClose={vi.fn()} onDone={onDone} />);
    expect(await screen.findByText("IPC 炸了")).toBeInTheDocument();
    expect(screen.queryByText(/进行中/)).toBeNull();
    expect(onDone).toHaveBeenCalledWith({ ok: false, error: "IPC 炸了" });
  });

  it("begin 抛异常时显示错误、不产生未处理拒绝（d.412 回归）", async () => {
    installBridge(async () => {
      throw new Error("boom");
    });
    render(<ConsolePanel title="恢复备份" args={["restore"]} onClose={vi.fn()} />);
    expect(await screen.findByText("boom")).toBeInTheDocument();
    expect(screen.queryByText(/进行中/)).toBeNull();
  });
});
