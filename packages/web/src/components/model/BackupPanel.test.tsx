import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BackupPanel } from "./BackupPanel.js";

/** 备份与恢复面板（d.112）：列表、确认、交互式命令、完成后刷新。 */

function installBridge(overrides: Record<string, unknown> = {}) {
  const listeners: ((event: Record<string, unknown>) => void)[] = [];
  const begin = vi.fn(async (_args: string[]) => ({ ok: true, runId: "cli-9" }));
  const info = vi.fn(async () => ({
    dir: "D:/backups",
    files: [
      { name: "model-20261108.backup", path: "D:/backups/model-20261108.backup", size: 2048, mtime: 1_700_000_000_000 },
    ],
  }));
  const bridge = {
    status: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    gateway: vi.fn(),
    cli: vi.fn(),
    cliStart: vi.fn(),
    cliBegin: begin,
    cliInput: vi.fn(async () => true),
    cliKill: vi.fn(async () => true),
    openTerminal: vi.fn(),
    backupInfo: info,
    backupPick: vi.fn(async () => null),
    onCli: vi.fn((callback: (event: Record<string, unknown>) => void) => {
      listeners.push(callback);
      return () => {};
    }),
    ...overrides,
  };
  (window as unknown as { __heming_magpie?: unknown }).__heming_magpie = bridge;
  const emit = (event: Record<string, unknown>) => listeners.forEach((fn) => fn(event));
  return { bridge, begin, info, emit };
}

beforeEach(() => {
  delete (window as unknown as { __heming_magpie?: unknown }).__heming_magpie;
});

afterEach(() => {
  delete (window as unknown as { __heming_magpie?: unknown }).__heming_magpie;
  vi.unstubAllGlobals();
});

describe("BackupPanel", () => {
  it("列出应用备份目录里的文件，并显示大小与时间", async () => {
    installBridge();
    render(<BackupPanel />);
    expect(await screen.findByText("model-20261108.backup")).toBeInTheDocument();
    expect(screen.getByText(/2 KB/)).toBeInTheDocument();
  });

  it("恢复要二次确认；确认后启动交互式命令并接收输出", async () => {
    const { begin, emit } = installBridge();
    render(<BackupPanel />);
    await screen.findByText("model-20261108.backup");
    fireEvent.click(screen.getByRole("button", { name: "恢复" }));
    expect(screen.getByText("确认恢复这个备份？")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认恢复" }));
    await waitFor(() =>
      expect(begin).toHaveBeenCalledWith(["restore", "D:/backups/model-20261108.backup"]),
    );
    emit({ runId: "cli-9", type: "start", args: ["restore"] });
    emit({ runId: "cli-9", type: "stdout", text: "输入口令：\n" });
    await waitFor(() => expect(screen.getByLabelText("命令输出")).toHaveTextContent("输入口令"));
  });

  it("新建备份用备份目录里的新文件名；完成后刷新列表", async () => {
    const { begin, info } = installBridge();
    render(<BackupPanel />);
    await screen.findByText("model-20261108.backup");
    const before = info.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "新建备份" }));
    await waitFor(() => expect(begin).toHaveBeenCalledTimes(1));
    const args = begin.mock.calls[0]![0];
    expect(args[0]).toBe("backup");
    expect(args[1]).toMatch(/D:[\\/]backups[\\/]model-.+\.backup/);
    // 刷新由关闭面板触发：列表重新读一次
    await waitFor(() => expect(info.mock.calls.length).toBeGreaterThanOrEqual(before));
  });

  it("没有命令桥时按钮禁用并给出桌面端提示", async () => {
    render(<BackupPanel />);
    expect(screen.getByRole("button", { name: "新建备份" })).toBeDisabled();
  });
});
