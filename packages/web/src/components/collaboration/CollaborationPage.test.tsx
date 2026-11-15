import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SYSTEM_AGENT_ID } from "@heming/shared";
import { CollaborationPage } from "./CollaborationPage.js";
import { useLlmStore, type LlmProfile } from "../../store/llm.js";
import { resolveBoundProfile, streamChatRouted } from "../../lib/llmRoute.js";
import { getMagpieCliBridge } from "../../lib/magpieCli.js";
import { COLLAB_HISTORY_KEY, saveLastRun } from "../../lib/collaboration/history.js";
import type { CollaborationRun } from "../../lib/collaboration/types.js";

/**
 * 协作页：参与者默认值 / 本机智能体并入 / 模型映射缺失 / 配置与运行 / 历史恢复。
 *
 * 只 mock 两个边界：
 *   - `magpieCli` 的桥（本机智能体检测，绝不真跑 `magpie ls`）；
 *   - `llmRoute` 的解析与流式调用（绝不真发网络请求）。
 * 编排器（lib/collaboration）与历史逻辑用真实实现，这样「点开始 → 回合 → 落盘」
 * 是一条完整链路，而不是把要验证的东西也 mock 掉。
 */

vi.mock("../../lib/llmRoute.js", () => ({
  resolveBoundProfile: vi.fn(),
  streamChatRouted: vi.fn(),
}));

vi.mock("../../lib/magpieCli.js", () => ({
  getMagpieCliBridge: vi.fn(),
}));

const HEMING_PROFILE: LlmProfile = {
  id: "mp:heming",
  label: "和鸣的档案",
  provider: "openai",
  apiKey: "sk-heming",
  model: "deepseek/deepseek-chat",
};

const CLAUDE_PROFILE: LlmProfile = {
  id: "mp:claude",
  label: "Claude Code 同名档案",
  provider: "openai",
  apiKey: "sk-claude",
  model: "claude-sonnet-4-5",
};

/** `magpie ls` 的人类可读输出（与 ModelPage.test 同格式）。Codex 故意没有同名档案。 */
const LS_OUTPUT =
  "  Claude Code       claude-sonnet-4-5  ·  effort —            ~/.claude/settings.json\n" +
  "  Codex             gpt-5.1-codex      ·  effort high         ~/.codex/config.toml\n";

function installBridge(stdout = LS_OUTPUT) {
  const cli = vi.fn(async () => ({ ok: true, stdout, stderr: "" }));
  vi.mocked(getMagpieCliBridge).mockReturnValue({ cli } as never);
  return cli;
}

function renderPage() {
  return render(<CollaborationPage />);
}

/** 等本机智能体检测完成后返回（本机列表出现即就绪）。 */
async function renderReady() {
  const view = renderPage();
  await screen.findByRole("checkbox", { name: "加入协作：Claude Code" });
  return view;
}

function fillTask(value = "写一份本地笔记应用的 PRD") {
  fireEvent.change(screen.getByLabelText("任务描述（必填）"), { target: { value } });
}

function addClaude() {
  fireEvent.click(screen.getByRole("checkbox", { name: "加入协作：Claude Code" }));
}

beforeEach(() => {
  window.localStorage.clear();
  vi.mocked(getMagpieCliBridge).mockReset();
  vi.mocked(resolveBoundProfile).mockReset();
  vi.mocked(streamChatRouted).mockReset();

  useLlmStore.setState({
    profiles: [HEMING_PROFILE, CLAUDE_PROFILE],
    bindings: { [SYSTEM_AGENT_ID]: HEMING_PROFILE.id },
    prompts: {},
    routes: [],
  });

  vi.mocked(resolveBoundProfile).mockImplementation((agentId: string) =>
    agentId === SYSTEM_AGENT_ID ? (HEMING_PROFILE as never) : undefined,
  );
  vi.mocked(streamChatRouted).mockImplementation(async (_profile, _messages, opts) => {
    opts.onDelta?.("产出正文");
    return "产出正文";
  });

  installBridge();
});

describe("协作页 · 页面骨架与默认参与者", () => {
  it("渲染「协作」页头与三个分区标题（h1 + 多个 h2）", async () => {
    await renderReady();
    expect(screen.getByRole("heading", { level: 1, name: "协作" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "协作任务" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "参与者" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "协作过程" })).toBeInTheDocument();
  });

  it("默认固定包含且只包含「和鸣」：勾选、禁用、显示绑定模型", async () => {
    await renderReady();
    const heming = screen.getByRole("checkbox", {
      name: "「和鸣」（内置，固定参与）",
    });
    expect(heming).toBeChecked();
    expect(heming).toBeDisabled();
    const list = screen.getByRole("list", { name: "协作参与者" });
    expect(within(list).getByText("内置智能体")).toBeInTheDocument();
    expect(within(list).getByText("模型：deepseek/deepseek-chat")).toBeInTheDocument();
  });

  it("检测到本机智能体后，有同名档案的可用、没有的禁用并说明", async () => {
    await renderReady();
    expect(screen.getByRole("checkbox", { name: "加入协作：Claude Code" })).toBeEnabled();
    const codex = screen.getByRole("checkbox", { name: "加入协作：Codex" });
    expect(codex).toBeDisabled();
    expect(
      screen.getByText("本机没有该模型的可用档案（gpt-5.1-codex）。"),
    ).toBeInTheDocument();
    // 浏览器/桌面端都不用真的跑 CLI
    expect(vi.mocked(getMagpieCliBridge).mock.results[0]?.value?.cli).toHaveBeenCalledWith(["ls"]);
  });

  it("只有 1 位参与者时开始按钮禁用，并列出可见原因", async () => {
    await renderReady();
    expect(screen.getByRole("button", { name: "开始协作" })).toBeDisabled();
    expect(screen.getByText("至少需要 2 位参与者（当前 1 位）。")).toBeInTheDocument();
    expect(screen.getByText("先填写任务描述。")).toBeInTheDocument();
  });

  it("选入本机智能体并填写任务后可以开始", async () => {
    await renderReady();
    fillTask();
    addClaude();
    expect(screen.getByRole("checkbox", { name: "加入协作：Claude Code" })).toBeChecked();
    expect(screen.getByRole("button", { name: "开始协作" })).toBeEnabled();
    expect(screen.queryByText("至少需要 2 位参与者（当前 1 位）。")).not.toBeInTheDocument();
  });

  it("浏览器预览（无桌面桥）如实说明无法检测本机智能体", async () => {
    vi.mocked(getMagpieCliBridge).mockReturnValue(null);
    renderPage();
    expect(
      await screen.findByText("浏览器预览里无法检测本机智能体；桌面端会自动列出。"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始协作" })).toBeDisabled();
  });
});

describe("协作页 · 配置", () => {
  it("三种模式可切换，选中态反映 aria-checked", async () => {
    await renderReady();
    expect(screen.getByRole("radio", { name: "协作模式：流水线" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    fireEvent.click(screen.getByRole("radio", { name: "协作模式：评审团" }));
    expect(screen.getByRole("radio", { name: "协作模式：评审团" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("radio", { name: "协作模式：流水线" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("轮数可在 1–3 之间选择", async () => {
    await renderReady();
    const select = screen.getByLabelText("协作轮数") as HTMLSelectElement;
    expect(select.value).toBe("1");
    fireEvent.change(select, { target: { value: "3" } });
    expect(select.value).toBe("3");
  });

  it("「和鸣」未绑定模型时给出可读错误，不能开始", async () => {
    vi.mocked(resolveBoundProfile).mockReturnValue(undefined);
    await renderReady();
    fillTask();
    addClaude();
    expect(screen.getByRole("button", { name: "开始协作" })).toBeDisabled();
    expect(
      screen.getAllByText("「和鸣」还没有绑定模型，请先在模型页为它绑定连接。").length,
    ).toBeGreaterThan(0);
  });
});

describe("协作页 · 运行与历史", () => {
  it("跑完一轮流水线：真实编排两回合、系统提示词含协作纪律/本机身份、写入历史", async () => {
    await renderReady();
    fillTask("写一份本地笔记应用的 PRD");
    addClaude();

    const seenModels: string[] = [];
    vi.mocked(streamChatRouted).mockImplementation(async (profile, _messages, opts) => {
      seenModels.push(profile.model);
      const text = `来自 ${profile.model} 的产出`;
      opts.onDelta?.(text);
      return text;
    });

    fireEvent.click(screen.getByRole("button", { name: "开始协作" }));

    await screen.findByText(/已完成 · 流水线 · 共 2 个回合/);
    expect(await screen.findByLabelText("第 1 个回合：和鸣，方案")).toBeInTheDocument();
    expect(await screen.findByLabelText("第 2 个回合：Claude Code，评审与定稿")).toBeInTheDocument();

    expect(seenModels).toEqual(["deepseek/deepseek-chat", "claude-sonnet-4-5"]);
    const hemingCall = vi
      .mocked(streamChatRouted)
      .mock.calls.find(([profile]) => profile.model === "deepseek/deepseek-chat");
    expect(hemingCall?.[1][0].content).toContain("多人协作");
    expect(hemingCall?.[1][0].content).toContain("你以「和鸣」的身份参与");
    const localCall = vi
      .mocked(streamChatRouted)
      .mock.calls.find(([profile]) => profile.model === "claude-sonnet-4-5");
    expect(localCall?.[1][0].content).toContain("多人协作");
    expect(localCall?.[1][0].content).toContain("你以「Claude Code」的身份参与");

    const saved = JSON.parse(window.localStorage.getItem(COLLAB_HISTORY_KEY) || "null") as
      | CollaborationRun
      | null;
    expect(saved?.task).toBe("写一份本地笔记应用的 PRD");
    expect(saved?.turns).toHaveLength(2);
    expect(saved?.turns.map((turn) => turn.agentName)).toEqual(["和鸣", "Claude Code"]);
  });

  it("刷新后恢复最近一次协作（标记「上次协作」，回填任务与回合）", async () => {
    const lastRun: CollaborationRun = {
      id: "run-old",
      mode: "debate",
      task: "上一次的任务",
      participants: [{ agentId: SYSTEM_AGENT_ID, name: "和鸣" }],
      rounds: 1,
      turns: [
        {
          id: "t1",
          agentId: SYSTEM_AGENT_ID,
          agentName: "和鸣",
          role: "方案",
          round: 1,
          text: "上一次的产出内容",
          startedAt: 1,
          endedAt: 2,
        },
      ],
      status: "done",
      startedAt: 0,
      endedAt: 3,
    };
    saveLastRun(lastRun);

    await renderReady();
    expect(screen.getByText("上次协作")).toBeInTheDocument();
    expect(screen.getByText(/上一次的产出内容/)).toBeInTheDocument();
    expect((screen.getByLabelText("任务描述（必填）") as HTMLTextAreaElement).value).toBe(
      "上一次的任务",
    );
    expect(screen.getByRole("radio", { name: "协作模式：评审团" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("清空会移除最近一次协作与 localStorage", async () => {
    const lastRun: CollaborationRun = {
      id: "run-old",
      mode: "sequential",
      task: "旧任务",
      participants: [{ agentId: SYSTEM_AGENT_ID, name: "和鸣" }],
      rounds: 1,
      turns: [],
      status: "done",
      startedAt: 0,
      endedAt: 1,
    };
    saveLastRun(lastRun);
    await renderReady();

    fireEvent.click(screen.getByRole("button", { name: "清空" }));
    expect(screen.getByText("还没有协作记录")).toBeInTheDocument();
    expect(window.localStorage.getItem(COLLAB_HISTORY_KEY)).toBeNull();
  });

  it("停止协作会中止请求并保留已产生的回合", async () => {
    await renderReady();
    fillTask();
    addClaude();
    vi.mocked(streamChatRouted).mockImplementation(
      (_profile, _messages, opts) =>
        new Promise((_resolve, reject) => {
          opts.signal?.addEventListener("abort", () => {
            reject(new DOMException("AbortError", "AbortError"));
          });
        }),
    );

    fireEvent.click(screen.getByRole("button", { name: "开始协作" }));
    expect(screen.getByRole("button", { name: "停止协作" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "停止协作" }));

    await screen.findByText(/已中止 · 保留 1 个已产生回合/);
    expect(screen.getByLabelText("第 1 个回合：和鸣，方案")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "停止协作" })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "开始协作" })).toBeInTheDocument(),
    );
  });
});