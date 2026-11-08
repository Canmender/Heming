import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ModelPage } from "./ModelPage.js";
import { useLlmStore, DEFAULT_GATEWAY, type LlmProfile } from "../store/llm.js";

/**
 * 模型页（d.103）：加来源 → 看模型，五个分区。
 *
 * 页面只负责「把该调的调对、把结果说清楚」；来源/账号/路由的语义由模型服务负责，
 * 不在前端重复验证。
 */

type CliCall = string[];
function installBridge(overrides: Record<string, unknown> = {}) {
  const calls: CliCall[] = [];
  const listeners: ((event: Record<string, unknown>) => void)[] = [];
  const cli = vi.fn(async (args: string[]) => {
    calls.push(args);
    if (args[0] === "providers") {
      return {
        ok: true,
        stdout: "  mock custom  mock  127.0.0.1:39001  ● •••••••  1 models  ",
        stderr: "",
      };
    }
    if (args[0] === "accounts") {
      return {
        ok: true,
        stdout: JSON.stringify([{ agent: "claude", name: "工作号", allowance: "82% used" }]),
        stderr: "",
      };
    }
    return { ok: true, stdout: "ok", stderr: "" };
  });
  const bridge = {
    status: vi.fn(async () => ({ available: true, running: true, version: "test", port: 3425 })),
    start: vi.fn(),
    stop: vi.fn(),
    gateway: vi.fn(),
    cli,
    cliStart: vi.fn(async (args: string[]) => {
      calls.push(args);
      return { ok: true };
    }),
    cliBegin: vi.fn(async (args: string[]) => {
      calls.push(args);
      return { ok: true, runId: "cli-1" };
    }),
    backupInfo: vi.fn(async () => ({
      dir: "D:/backups",
      files: [
        { name: "model-20261108.backup", path: "D:/backups/model-20261108.backup", size: 2048, mtime: Date.now() },
      ],
    })),
    backupPick: vi.fn(async () => null),
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

const profile = (model: string): LlmProfile => ({
  id: model,
  label: model,
  provider: "openai",
  baseUrl: DEFAULT_GATEWAY.baseUrl,
  apiKey: DEFAULT_GATEWAY.key,
  model,
});

beforeEach(() => {
  localStorage.clear();
  useLlmStore.setState({
    gateway: { ...DEFAULT_GATEWAY, source: "desktop" },
    models: [],
    profiles: [profile("deepseek/deepseek-chat"), profile("openai/gpt-4o")],
    bindings: {},
    prompts: {},
    routes: [],
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      if (String(input).endsWith("/api/hello")) {
        return new Response(JSON.stringify({ name: "gateway", version: "1" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ data: [{ id: "deepseek/deepseek-chat" }, { id: "openai/gpt-4o" }] }),
        { status: 200 },
      );
    }),
  );
});

afterEach(() => {
  delete (window as unknown as { __heming_magpie?: unknown }).__heming_magpie;
  vi.unstubAllGlobals();
});

describe("ModelPage · 结构与主路径", () => {
  it("五个分区；默认显示可用模型与统计，不出现服务启停或第三方名称", async () => {
    installBridge();
    render(<ModelPage />);
    expect(screen.getByRole("heading", { name: "模型" })).toBeInTheDocument();
    for (const label of ["模型", "来源", "运行"]) {
      expect(screen.getByRole("tab", { name: label })).toBeInTheDocument();
    }
    expect(await screen.findByText("deepseek/deepseek-chat")).toBeInTheDocument();
    expect(screen.getByText("openai/gpt-4o")).toBeInTheDocument();
    // 内置能力：不提供启停/地址/第三方品牌
    expect(screen.queryByRole("button", { name: /启动|停止|重启/ })).toBeNull();
    expect(screen.queryByText(/magpie/i)).toBeNull();
    expect(screen.queryByText(/网关地址/)).toBeNull();
  });

  it("搜索只留下匹配的模型", async () => {
    installBridge();
    render(<ModelPage />);
    const search = await screen.findByLabelText("搜索模型");
    fireEvent.change(search, { target: { value: "gpt" } });
    expect(screen.getByText("openai/gpt-4o")).toBeInTheDocument();
    expect(screen.queryByText("deepseek/deepseek-chat")).toBeNull();
  });

  it("浏览器没有命令桥：提示只能在桌面端添加，但仍可看模型", () => {
    render(<ModelPage />);
    expect(screen.getByRole("status")).toHaveTextContent(/请打开和鸣桌面端/);
    expect(screen.getByText("deepseek/deepseek-chat")).toBeInTheDocument();
  });
});

describe("ModelPage · 添加来源", () => {
  it("点服务商卡片只填一个 Key 就能保存，并刷新模型目录", async () => {
    const { calls } = installBridge();
    render(<ModelPage />);
    fireEvent.click(screen.getByRole("tab", { name: "来源" }));
    fireEvent.click(screen.getByRole("button", { name: /DeepSeek/ }));
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "sk-x" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(calls).toContainEqual(["provider", "add", "deepseek", "sk-x"]));
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "模型" })).toHaveAttribute("aria-selected", "true"),
    );
  });

  it("订阅卡片走登录窗口", async () => {
    const { bridge } = installBridge();
    render(<ModelPage />);
    fireEvent.click(screen.getByRole("tab", { name: "来源" }));
    fireEvent.click(screen.getByRole("button", { name: /Claude/ }));
    await waitFor(() =>
      expect(bridge.openTerminal).toHaveBeenCalledWith(["accounts", "add", "claude"]),
    );
  });

  it("已添加来源可删除", async () => {
    const { calls } = installBridge();
    render(<ModelPage />);
    fireEvent.click(screen.getByRole("tab", { name: "来源" }));
    expect(await screen.findByText("mock")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    await waitFor(() => expect(calls).toContainEqual(["provider", "rm", "mock"]));
  });
});

describe("ModelPage · 账号与更多", () => {
  it("来源页同时展示已登录账号与额度", async () => {
    installBridge();
    render(<ModelPage />);
    fireEvent.click(screen.getByRole("tab", { name: "来源" }));
    expect(await screen.findByText("工作号")).toBeInTheDocument();
    expect(screen.getByText("82% used")).toBeInTheDocument();
  });

  it("高级命令在「运行」里：流式输出写进面板", async () => {
    const { bridge, calls, emit } = installBridge();
    render(<ModelPage />);
    fireEvent.click(screen.getByRole("tab", { name: "运行" }));
    fireEvent.click(screen.getByText("高级命令"));
    fireEvent.change(screen.getByLabelText("命令"), { target: { value: "providers" } });
    fireEvent.click(screen.getByRole("button", { name: "运行" }));
    await waitFor(() => expect(bridge.cliStart).toHaveBeenCalledWith(["providers"]));
    emit({ runId: "cli-1", type: "start", args: ["providers"] });
    emit({ runId: "cli-1", type: "stdout", text: "line one\n" });
    await waitFor(() => expect(screen.getByLabelText("命令输出")).toHaveTextContent("line one"));
    expect(calls).toContainEqual(["providers"]);
  });
});

describe("ModelPage · 高级表单（来源 / 分组规则 / 模型属性）", () => {
  it("来源高级：更新 Key 与保存设置都走对应命令", async () => {
    const { calls } = installBridge();
    render(<ModelPage />);
    fireEvent.click(screen.getByRole("tab", { name: "来源" }));
    await screen.findByText("mock");
    fireEvent.click(screen.getByRole("button", { name: "高级" }));
    fireEvent.change(screen.getByLabelText("更新 Key"), { target: { value: "sk-new" } });
    fireEvent.click(screen.getByRole("button", { name: "更新 Key" }));
    await waitFor(() => expect(calls).toContainEqual(["provider", "key", "mock", "sk-new"]));

    fireEvent.change(screen.getByLabelText("来源分发策略"), { target: { value: "rotate" } });
    fireEvent.change(screen.getByLabelText("错误处理"), { target: { value: "pass" } });
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    await waitFor(() =>
      expect(calls).toContainEqual(["provider", "set", "mock", "routing=rotate", "errors=pass"]),
    );
  });

  it("分组规则：把「够长的请求」先交给指定模型", async () => {
    const { calls } = installBridge();
    render(<ModelPage />);
    fireEvent.click(screen.getByRole("tab", { name: "运行" }));
    fireEvent.click(screen.getByText("路由分组（可选）"));
    fireEvent.change(screen.getByLabelText("规则分组"), { target: { value: "daily" } });
    fireEvent.change(screen.getByLabelText("规则模型"), { target: { value: "mock/mock-model" } });
    fireEvent.change(screen.getByLabelText("规则 token 阈值"), { target: { value: "150k" } });
    fireEvent.click(screen.getByRole("button", { name: "保存规则" }));
    await waitFor(() =>
      expect(calls).toContainEqual([
        "group",
        "rule",
        "add",
        "daily",
        "use=mock/mock-model",
        "tokens=150k",
      ]),
    );
  });

  it("模型属性：改了显示名就走 model name", async () => {
    const { calls } = installBridge();
    render(<ModelPage />);
    fireEvent.click(screen.getByText("模型属性（可选）"));
    fireEvent.change(screen.getByLabelText("属性模型 ID"), { target: { value: "mock/mock-model" } });
    fireEvent.change(screen.getByLabelText("模型显示名"), { target: { value: "Mock 一号" } });
    fireEvent.click(screen.getByRole("button", { name: "应用" }));
    await waitFor(() => expect(calls).toContainEqual(["model", "name", "mock/mock-model", "Mock 一号"]));
  });
});
