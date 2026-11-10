import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { BackgroundModelCard } from "./BackgroundModelCard.js";
import { useLlmStore } from "../store/llm.js";

const KEY = "heming.backgroundModel.v1";

/** 网关模型的最小合法形状（其余字段测试不关心）。 */
function model(id: string, name: string) {
  return { id, name, ownedBy: "test", reasoningLevels: [] as string[], vision: false };
}

describe("BackgroundModelCard 后台任务模型", () => {
  beforeEach(() => {
    localStorage.clear();
    useLlmStore.setState({ models: [], backgroundModel: null });
  });

  it("没有模型目录：说明先连网关，不渲染可选模型", () => {
    render(<BackgroundModelCard />);
    expect(screen.getByText("后台任务模型")).toBeInTheDocument();
    expect(screen.getByText(/还没有模型目录/)).toBeInTheDocument();
    expect(screen.getByLabelText("后台任务模型")).toHaveValue("");
  });

  it("选择模型：写 store 与本机存储（只存 id，不存 Key）", () => {
    useLlmStore.setState({
      models: [model("cheap/model", "便宜模型"), model("big/model", "大模型")],
    });
    render(<BackgroundModelCard />);
    fireEvent.change(screen.getByLabelText("后台任务模型"), { target: { value: "cheap/model" } });
    expect(useLlmStore.getState().backgroundModel).toBe("cheap/model");
    expect(localStorage.getItem(KEY)).toContain("cheap/model");
  });

  it("目录里已经没有的旧选择：照实显示并给可执行提示，不静默改写", () => {
    useLlmStore.setState({
      models: [model("other/model", "别的模型")],
      backgroundModel: "gone/model",
    });
    render(<BackgroundModelCard />);
    expect(screen.getByRole("option", { name: /gone\/model（不在当前模型目录）/ })).toBeInTheDocument();
    expect(screen.getByText(/所选模型已不在当前目录/)).toBeInTheDocument();
    // 不静默换成别的模型
    expect(useLlmStore.getState().backgroundModel).toBe("gone/model");
  });
});
