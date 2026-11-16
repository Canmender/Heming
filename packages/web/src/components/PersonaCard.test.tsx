import { beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { SYSTEM_AGENT_ID } from "@heming/shared";
import { PersonaCard } from "./PersonaCard.js";
import { useLlmStore } from "../store/llm.js";
import { DEFAULT_SYSTEM_PROMPT } from "../lib/agentRuntime/defaultPrompt.js";

const PROMPTS_KEY = "heming.agentPrompts";

/** 每个用例从「没写过提示词」开始（= 首次安装）。 */
function reset() {
  localStorage.clear();
  useLlmStore.setState({ prompts: {} });
}

function textarea(): HTMLTextAreaElement {
  return screen.getByLabelText("智能体人设提示词") as HTMLTextAreaElement;
}

describe("智能体人设卡（d.156）", () => {
  beforeEach(reset);

  it("没写过时：空输入框、显示当前生效=内置人设", () => {
    render(<PersonaCard />);
    expect(textarea().value).toBe("");
    expect(screen.getByText(/当前生效：内置人设/)).toBeTruthy();
    expect(screen.getByText("当前没有自定义内容，用的就是内置人设。")).toBeTruthy();
  });

  it("保存自定义提示词：落盘 + 当前生效变为自定义", () => {
    render(<PersonaCard />);
    fireEvent.change(textarea(), { target: { value: "你是我的写作助理，先给结论。" } });
    expect(screen.getByText(/有未保存的修改/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(useLlmStore.getState().prompts[SYSTEM_AGENT_ID]).toBe("你是我的写作助理，先给结论。");
    expect(JSON.parse(localStorage.getItem(PROMPTS_KEY)!)[SYSTEM_AGENT_ID]).toBe(
      "你是我的写作助理，先给结论。",
    );
    expect(screen.getByText(/当前生效：自定义（/)).toBeTruthy();
    expect(screen.getByText(/已保存，下一轮对话生效/)).toBeTruthy();
  });

  it("保存时会去掉首尾空白（与 resolveBasePrompt 同口径）", () => {
    render(<PersonaCard />);
    fireEvent.change(textarea(), { target: { value: "  \n  只用一句话回答。 \n " } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(useLlmStore.getState().prompts[SYSTEM_AGENT_ID]).toBe("只用一句话回答。");
  });

  it("恢复内置人设：删掉键、输入框清空、回到内置", () => {
    useLlmStore.setState({ prompts: { [SYSTEM_AGENT_ID]: "自定义内容" } });
    render(<PersonaCard />);
    expect(textarea().value).toBe("自定义内容");
    fireEvent.click(screen.getByRole("button", { name: "恢复内置人设" }));

    expect(useLlmStore.getState().prompts).not.toHaveProperty(SYSTEM_AGENT_ID);
    expect(JSON.parse(localStorage.getItem(PROMPTS_KEY) ?? "{}")).not.toHaveProperty(SYSTEM_AGENT_ID);
    expect(screen.getByText(/当前生效：内置人设/)).toBeTruthy();
  });

  it("空白内容保存 = 回到内置人设（不会把空白串当自定义）", () => {
    useLlmStore.setState({ prompts: { [SYSTEM_AGENT_ID]: "自定义内容" } });
    render(<PersonaCard />);
    fireEvent.change(textarea(), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(useLlmStore.getState().prompts).not.toHaveProperty(SYSTEM_AGENT_ID);
    expect(screen.getByText(/当前生效：内置人设/)).toBeTruthy();
  });

  it("「填入内置人设（可改）」把默认内容填进输入框但不算已保存", () => {
    render(<PersonaCard />);
    fireEvent.click(screen.getByRole("button", { name: "填入内置人设（可改）" }));
    expect(textarea().value).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(useLlmStore.getState().prompts).not.toHaveProperty(SYSTEM_AGENT_ID);
    expect(screen.getByText(/有未保存的修改/)).toBeTruthy();
  });

  it("外部改动了同一份提示词时，输入框跟着同步（界面与实际生效不分叉）", () => {
    useLlmStore.setState({ prompts: { [SYSTEM_AGENT_ID]: "第一版" } });
    render(<PersonaCard />);
    expect(textarea().value).toBe("第一版");
    act(() => {
      useLlmStore.getState().setPrompt(SYSTEM_AGENT_ID, "第二版");
    });
    expect(textarea().value).toBe("第二版");
  });

  it("历史脏值（空串）不会被当成自定义", () => {
    useLlmStore.setState({ prompts: { [SYSTEM_AGENT_ID]: "" } });
    render(<PersonaCard />);
    expect(textarea().value).toBe("");
    expect(screen.getByText(/当前生效：内置人设/)).toBeTruthy();
  });
});
