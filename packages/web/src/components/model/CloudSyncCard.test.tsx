import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CloudSyncCard } from "./CloudSyncCard.js";

/** 云同步（d.392）：读现状、现在同步一次、改间隔；开的那一步交给终端。 */

const ON = `WebDAV sync  https://dav.jianguoyun.com/dav/  me@example.com · password saved
  syncs providers with their API keys, settings, profiles, agents' models, library
 ✓ synced 3 minutes ago
  Syncs by itself every 15 minutes (magpie webdav auto changes it)`;

const OFF = `WebDAV sync is off
magpie webdav on <address> keeps providers, settings, profiles, agents' models and the library the same on every computer (magpie webdav help)`;

function installBridge(stdout: string, overrides: Record<string, unknown> = {}) {
  const cli = vi.fn(async (args: string[]) =>
    args.length === 1 && args[0] === "webdav"
      ? { ok: true, stdout, stderr: "" }
      : { ok: true, stdout: "ok", stderr: "" },
  );
  const openTerminal = vi.fn(async () => ({ ok: true }));
  const bridge = {
    status: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    gateway: vi.fn(),
    cli,
    cliStart: vi.fn(),
    cliBegin: vi.fn(),
    cliInput: vi.fn(),
    cliKill: vi.fn(),
    openTerminal,
    backupInfo: vi.fn(async () => ({ dir: "", files: [] })),
    backupPick: vi.fn(async () => null),
    onCli: vi.fn(() => () => {}),
    ...overrides,
  };
  (window as unknown as { __heming_magpie?: unknown }).__heming_magpie = bridge;
  return { bridge, cli, openTerminal };
}

beforeEach(() => {
  delete (window as unknown as { __heming_magpie?: unknown }).__heming_magpie;
});

afterEach(() => {
  delete (window as unknown as { __heming_magpie?: unknown }).__heming_magpie;
  vi.unstubAllGlobals();
});

describe("CloudSyncCard", () => {
  it("开着的时候：说清连到哪儿、同步什么、上次怎么样，并能立刻同步一次", async () => {
    const { cli } = installBridge(ON);
    render(<CloudSyncCard />);
    expect(
      await screen.findByText(/WebDAV → https:\/\/dav\.jianguoyun\.com\/dav\//),
    ).toBeInTheDocument();
    expect(screen.getByText(/上次同步 3 minutes ago/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "现在同步一次" }));
    await waitFor(() => expect(cli).toHaveBeenCalledWith(["webdav", "now"]));
  });

  it("开着的时候：改「多久同步一次」，只发内核认的那一档", async () => {
    const { cli } = installBridge(ON);
    render(<CloudSyncCard />);
    const select = await screen.findByLabelText("自动同步间隔");
    fireEvent.change(select, { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "应用" }));
    await waitFor(() => expect(cli).toHaveBeenCalledWith(["webdav", "auto", "30"]));
  });

  it("没开的时候：给个地址，点「开云同步…」交给终端问密码", async () => {
    const { openTerminal, cli } = installBridge(OFF);
    render(<CloudSyncCard />);
    expect(await screen.findByText("云同步没开：这台电脑的设置只在本地。")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("地址"), {
      target: { value: "https://dav.jianguoyun.com/dav/" },
    });
    fireEvent.change(screen.getByLabelText("账号（可选）"), { target: { value: "me@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "开云同步…" }));

    await waitFor(() =>
      expect(openTerminal).toHaveBeenCalledWith([
        "webdav",
        "on",
        "https://dav.jianguoyun.com/dav/",
        "user=me@example.com",
      ]),
    );
    expect(cli).not.toHaveBeenCalledWith(["webdav", "on"]);
  });

  it("没开的时候不给空地址：先填地址，别把空命令发出去", async () => {
    const { openTerminal } = installBridge(OFF);
    render(<CloudSyncCard />);
    await screen.findByText("云同步没开：这台电脑的设置只在本地。");
    fireEvent.click(screen.getByRole("button", { name: "开云同步…" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("先填地址");
    expect(openTerminal).not.toHaveBeenCalled();
  });
});
