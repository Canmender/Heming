import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ModelRoutePage } from "./ModelRoutePage.js";
import { llmHealth } from "../lib/llmHealth.js";
import { useLlmStore, type LlmProfile } from "../store/llm.js";
import { useTokenUsageStore } from "../store/tokenUsage.js";

/**
 * 模型路由页（d.84 · magpie 语义移植的内置模块页）。
 *
 * 这里只钉「页面口径」：概览数字来自真实 store、候选链编辑器就在页内、
 * 策略与边界说明说人话；路由算法本身在 llmRoute.test.ts 里覆盖。
 */

const p = (id: string, model: string): LlmProfile => ({
  id,
  label: id,
  provider: "openai",
  apiKey: "k",
  model,
});

beforeEach(() => {
  localStorage.clear();
  llmHealth.reset();
  useLlmStore.setState({
    profiles: [p("主 Key", "deepseek-chat"), p("备 Key", "moonshot-v1-8k")],
    routes: [
      {
        id: "r1",
        label: "主备链",
        members: [{ profileId: "主 Key", model: "deepseek-chat" }, { profileId: "备 Key" }],
      },
    ],
    bindings: {},
    prompts: {},
  } as never);
  useTokenUsageStore.getState().reset();
});

describe("ModelRoutePage", () => {
  it("概览数字来自本机 store（连接 / 候选链 / 候选数）", () => {
    render(<ModelRoutePage />);
    expect(screen.getByRole("heading", { name: "模型路由" })).toBeInTheDocument();
    expect(screen.getByLabelText("统计 可用模型")).toHaveTextContent("2");
    expect(screen.getByLabelText("统计 候选链")).toHaveTextContent("1");
    expect(screen.getByLabelText("统计 候选链")).toHaveTextContent("2 个候选");
    expect(screen.getByLabelText("统计 休息中")).toHaveTextContent("0");
  });

  it("候选链编辑器就在页内（与设置区同一份实现）", () => {
    render(<ModelRoutePage />);
    expect(screen.getByLabelText("新建候选链")).toBeInTheDocument();
    expect(screen.getByText("主备链")).toBeInTheDocument();
  });

  it("策略与边界说清楚：每档一句人话 + 明确不读供应商配额", () => {
    render(<ModelRoutePage />);
    expect(screen.getByRole("heading", { name: "每档策略在选谁" })).toBeInTheDocument();
    for (const name of [
      "按声明顺序",
      "智能",
      "用得最少优先",
      "按节奏优先",
      "按权重",
      "按速度优先",
      "轮流",
    ]) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
    expect(screen.getByRole("heading", { name: "边界" })).toBeInTheDocument();
    expect(screen.getByText(/不读供应商的配额、并发与限流/)).toBeInTheDocument();
    expect(screen.getByText(/选路语义与业界通行的候选链做法一致/)).toBeInTheDocument();
  });

  it("没有连接时给出去设置区添加的提示", () => {
    useLlmStore.setState({ profiles: [], routes: [] } as never);
    render(<ModelRoutePage />);
    expect(screen.getByText(/还没有模型连接/)).toBeInTheDocument();
  });
});
