import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MagpieGatewayCard } from "./MagpieGatewayCard.js";
import { DEFAULT_GATEWAY, useLlmStore } from "../store/llm.js";

/**
 * 设置区 · 模型（magpie 原生组件，d.89）。
 *
 * 关注点：默认就是本机网关、保存不联网、读取模型走网关目录、失败说人话、
 * 模型表把「窗口/视觉/推理」这些用户选型要看的字段摆出来。
 */

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  useLlmStore.setState({
    gateway: { ...DEFAULT_GATEWAY },
    models: [],
    gatewayVersion: undefined,
    profiles: [],
    bindings: {},
    prompts: {},
    routes: [],
  });
});

function stubGateway(models: unknown[], version = "0.1.3246") {
  const fetchMock = vi.fn(async (input: string) => {
    if (String(input).endsWith("/api/hello")) {
      return new Response(JSON.stringify({ name: "magpie", version }), { status: 200 });
    }
    return new Response(JSON.stringify({ object: "list", data: models }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("MagpieGatewayCard", () => {
  it("默认值就是本机 magpie 网关；没有模型时说明下一步", () => {
    render(<MagpieGatewayCard />);
    expect(screen.getByLabelText("magpie 网关地址")).toHaveValue(DEFAULT_GATEWAY.baseUrl);
    expect(screen.getByLabelText("magpie 网关 Key")).toHaveValue(DEFAULT_GATEWAY.key);
    expect(screen.getByText(/还没有读到模型/)).toBeInTheDocument();
    expect(screen.getByText(/订阅账号、API Key、多账号轮换与额度选路都在 magpie 里管理/)).toBeInTheDocument();
  });

  it("「仅保存」不联网，只把网关配置落盘", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<MagpieGatewayCard />);
    fireEvent.change(screen.getByLabelText("magpie 网关地址"), {
      target: { value: "http://127.0.0.1:3999/v1/" },
    });
    fireEvent.click(screen.getByRole("button", { name: "仅保存" }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(useLlmStore.getState().gateway.baseUrl).toBe("http://127.0.0.1:3999/v1");
    expect(screen.getByText(/已保存网关配置/)).toBeInTheDocument();
  });

  it("「读取模型」读目录并把模型表渲染出来（窗口/视觉/推理）", async () => {
    stubGateway([
      {
        id: "anthropic/claude-sonnet-5",
        display_name: "Claude Sonnet 5",
        owned_by: "anthropic",
        context_window: 200000,
        modalities: ["text", "image"],
        supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
      },
      { id: "deepseek/deepseek-chat", display_name: "DeepSeek Chat", owned_by: "deepseek" },
    ]);
    render(<MagpieGatewayCard />);
    fireEvent.click(screen.getByRole("button", { name: "读取模型" }));

    await waitFor(() => expect(screen.getByText(/读到 2 个模型/)).toBeInTheDocument());
    expect(screen.getByRole("table", { name: "可用模型" })).toBeInTheDocument();
    expect(screen.getByText("Claude Sonnet 5")).toBeInTheDocument();
    expect(screen.getByText("anthropic/claude-sonnet-5")).toBeInTheDocument();
    expect(screen.getByText("200K")).toBeInTheDocument();
    expect(screen.getByText(/看图 · 推理 low\/high/)).toBeInTheDocument();
    // 版本来自 /api/hello
    expect(screen.getByText("magpie 0.1.3246")).toBeInTheDocument();
  });

  it("连接失败/网关拒绝 Key：给可执行的中文提示", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
      ),
    );
    render(<MagpieGatewayCard />);
    fireEvent.click(screen.getByRole("button", { name: "读取模型" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent(/网关拒绝了这个 Key/);
  });
});
