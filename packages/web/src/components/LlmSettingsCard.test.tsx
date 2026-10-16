import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { LlmSettingsCard } from "./LlmSettingsCard.js";
import { useLlmStore } from "../store/llm.js";

describe("LlmSettingsCard", () => {
  beforeEach(() => {
    localStorage.clear();
    useLlmStore.setState({ profiles: [], bindings: {}, prompts: {} });
    vi.restoreAllMocks();
  });

  it("空态提示 + 打开表单提交后列表出现连接", async () => {
    render(<LlmSettingsCard />);
    expect(screen.getByText(/还没有 LLM 连接/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("＋ 新建连接"));
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "我的模型" } });
    fireEvent.change(screen.getByLabelText("模型"), { target: { value: "deepseek-chat" } });
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "sk-test" } });
    fireEvent.click(screen.getByText("保存"));
    await waitFor(() => expect(screen.getByText("我的模型")).toBeInTheDocument());
    expect(useLlmStore.getState().profiles[0].provider).toBe("openai"); // 默认值
    // 落盘：Key 只进本机 localStorage
    expect(JSON.parse(localStorage.getItem("heming.llmConfigs")!).profiles[0].apiKey).toBe("sk-test");
  });

  it("连通性测试失败展示原因", async () => {
    useLlmStore.getState().addProfile({ id: "p1", label: "断的", provider: "openai", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", model: "m" });
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
    render(<LlmSettingsCard />);
    fireEvent.click(screen.getByText("测试"));
    await waitFor(() => expect(screen.getByText(/测试失败/)).toBeInTheDocument());
    expect(screen.getByText(/fetch failed/)).toBeInTheDocument();
  });

  // Interfaces 契约补充：baseUrl placeholder 随 provider 切换；列表展示 key 末 4 位；删除提示绑定失联
  it("provider 切换时 baseUrl placeholder 跟随官方端点", () => {
    render(<LlmSettingsCard />);
    fireEvent.click(screen.getByText("＋ 新建连接"));
    const baseUrl = screen.getByLabelText("Base URL");
    expect(baseUrl).toHaveAttribute("placeholder", "https://api.openai.com/v1");
    fireEvent.change(screen.getByLabelText("服务商"), { target: { value: "anthropic" } });
    expect(screen.getByLabelText("Base URL")).toHaveAttribute("placeholder", "https://api.anthropic.com");
  });

  // F1 红线：缺 scheme 的 baseUrl 保存被拦在表单层（不写 store、不发请求）
  it("baseUrl 缺 http(s):// 时保存被拦截并提示", async () => {
    render(<LlmSettingsCard />);
    fireEvent.click(screen.getByText("＋ 新建连接"));
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "deepseek" } });
    fireEvent.change(screen.getByLabelText("模型"), { target: { value: "deepseek-chat" } });
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "sk-test" } });
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "api.deepseek.com/v1" } });
    fireEvent.click(screen.getByText("保存"));
    await waitFor(() => expect(screen.getByText(/需以 http:\/\/ 或 https:\/\//)).toBeInTheDocument());
    expect(useLlmStore.getState().profiles).toHaveLength(0);
    expect(localStorage.getItem("heming.llmConfigs")).toBeNull();
    expect(screen.getByLabelText("名称")).toHaveValue("deepseek"); // 表单未关、可改后重交
  });

  it("列表展示 provider/model 与 key 末 4 位；删除提示已绑定智能体失联并清绑定", async () => {
    useLlmStore.getState().addProfile({ id: "p1", label: "长连接", provider: "anthropic", apiKey: "sk-ant-secret9", model: "claude-sonnet-5" });
    useLlmStore.getState().setBinding("agent-1", "p1");
    render(<LlmSettingsCard />);
    expect(screen.getByText("长连接")).toBeInTheDocument();
    expect(screen.getByText(/anthropic · claude-sonnet-5 · ••••ret9/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("删除"));
    expect(screen.getByText(/将失联并清绑定/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("确认删除"));
    await waitFor(() => expect(screen.queryByText("长连接")).not.toBeInTheDocument());
    expect(useLlmStore.getState().bindings["agent-1"]).toBeUndefined();
    expect(JSON.parse(localStorage.getItem("heming.agentLlm")!)).not.toHaveProperty("agent-1");
  });
});
