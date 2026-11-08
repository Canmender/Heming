import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ModelPage } from "./ModelPage.js";
import { useLlmStore, DEFAULT_GATEWAY, type LlmProfile } from "../store/llm.js";

/**
 * 模型页（d.99）：把内核管理面搬进导航。
 *
 * 测试只钉「页面是否把该调的命令调对、输出是否落到页面」——
 * 命令本身的语义由内核（vendored 源码）负责，不在前端重复验证。
 */

type CliCall = string[];
function installBridge(overrides: Record<string, unknown> = {}) {
  const calls: CliCall[] = [];
  const listeners: ((event: Record<string, unknown>) => void)[] = [];
  const cli = vi.fn(async (args: string[]) => {
    calls.push(args);
    if (args[0] === "providers") {
      return { ok: true, stdout: "  mock custom  mock  127.0.0.1:39001  ● •••••••  1 models  ", stderr: "" };
    }
    if (args[0] === "accounts") {
      return { ok: true, stdout: JSON.stringify([{ agent: "claude", name: "工作号", allowance: "82% used" }]), stderr: "" };
    }
    return { ok: true, stdout: "ok", stderr: "" };
  });
  const bridge = {
    status: vi.fn(async () => ({ available: true, running: true, version: "0.1.3246-heming.test", port: 3425, proxyPort: 40123 })),
    start: vi.fn(),
    stop: vi.fn(),
    gateway: vi.fn(),
    cli,
    cliStart: vi.fn(async (args: string[]) => {
      calls.push(args);
      return { ok: true };
    }),
    cliInput: vi.fn(async () => true),
    cliKill: vi.fn(async () => true),
    openTerminal: vi.fn(async () => ({ ok: true })),
    onCli: vi.fn((callback: (event: Record<string, unknown>) => void) => {
      listeners.push(callback);
      return () => {};
    }),
    ...overrides,
  };
  (window as unknown as { __heming_magpie?: unknown }).__heming_magpie = bridge;
  const emit = (event: Record<string, unknown>) => listeners.forEach((fn) => fn(event));
  return { bridge, calls, emit };
}

const profile = (id: string): LlmProfile => ({
  id,
  label: id,
  provider: "openai",
  baseUrl: DEFAULT_GATEWAY.baseUrl,
  apiKey: DEFAULT_GATEWAY.key,
  model: id,
});

beforeEach(() => {
  localStorage.clear();
  useLlmStore.setState({
    gateway: { ...DEFAULT_GATEWAY, source: "desktop" },
    models: [],
    profiles: [profile("mock/mock-model")],
    bindings: {},
    prompts: {},
    routes: [],
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })),
  );
});

afterEach(() => {
  delete (window as unknown as { __heming_magpie?: unknown }).__heming_magpie;
  vi.unstubAllGlobals();
});

describe("ModelPage · 结构", () => {
  it("渲染标题与九个分区，默认概览显示网关状态与模型数", async () => {
    installBridge();
    render(<ModelPage />);
    expect(screen.getByRole("heading", { name: "模型" })).toBeInTheDocument();
    for (const label of ["概览", "供应商", "订阅账号", "分组路由", "模型", "用量", "备份与同步", "库与搜索", "终端"]) {
      expect(screen.getByRole("tab", { name: label })).toBeInTheDocument();
    }
    expect(await screen.findByText(/网关运行中/)).toBeInTheDocument();
    expect(screen.getByText("1 个模型")).toBeInTheDocument();
  });

  it("浏览器没有命令桥：提示仅桌面端可用，但仍可看目录", () => {
    render(<ModelPage />);
    expect(screen.getByRole("status")).toHaveTextContent(/仅和鸣桌面端可用/);
    expect(screen.getByRole("heading", { name: "模型" })).toBeInTheDocument();
  });
});

describe("ModelPage · 供应商", () => {
  it("切到供应商会读取列表；加预置/删除都调用内核命令", async () => {
    const { calls } = installBridge();
    render(<ModelPage />);
    fireEvent.click(screen.getByRole("tab", { name: "供应商" }));
    expect(await screen.findByRole("cell", { name: "mock" })).toBeInTheDocument();
    expect(calls).toContainEqual(["providers"]);

    fireEvent.change(screen.getByLabelText("预置 API Key"), { target: { value: "sk-x" } });
    fireEvent.click(screen.getByRole("button", { name: "添加预置" }));
    await waitFor(() => expect(calls).toContainEqual(["provider", "add", "deepseek", "sk-x"]));

    fireEvent.change(screen.getByLabelText("供应商 ID"), { target: { value: "mock" } });
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    await waitFor(() => expect(calls).toContainEqual(["provider", "rm", "mock"]));
  });
});

describe("ModelPage · 订阅账号", () => {
  it("读取 accounts --json 并渲染表格；登录按钮走真终端", async () => {
    const { bridge, calls } = installBridge();
    render(<ModelPage />);
    fireEvent.click(screen.getByRole("tab", { name: "订阅账号" }));
    expect(await screen.findByText("工作号")).toBeInTheDocument();
    expect(screen.getByText("82% used")).toBeInTheDocument();
    expect(calls).toContainEqual(["accounts", "--json"]);

    fireEvent.click(screen.getByRole("button", { name: "登录 Claude Code" }));
    await waitFor(() => expect(bridge.openTerminal).toHaveBeenCalledWith(["accounts", "add", "claude"]));
    expect(await screen.findByText(/已在新终端窗口执行/)).toBeInTheDocument();
  });
});

describe("ModelPage · 终端", () => {
  it("输入命令 → cliStart；stdout 事件逐块写进输出面板", async () => {
    const { bridge, calls, emit } = installBridge();
    render(<ModelPage />);
    fireEvent.click(screen.getByRole("tab", { name: "终端" }));
    fireEvent.change(screen.getByLabelText("内核命令"), { target: { value: "providers" } });
    fireEvent.click(screen.getByRole("button", { name: "运行" }));

    await waitFor(() => expect(bridge.cliStart).toHaveBeenCalledWith(["providers"]));
    emit({ runId: "cli-1", type: "start", args: ["providers"] });
    emit({ runId: "cli-1", type: "stdout", text: "line one\n" });
    emit({ runId: "cli-1", type: "stdout", text: "line two\n" });
    await waitFor(() => expect(screen.getByLabelText("终端输出")).toHaveTextContent("line two"));

    // 白名单由主进程兜底；页面不做第二套判断，只保证把命令原样送去
    expect(calls).toContainEqual(["providers"]);
  });
});
