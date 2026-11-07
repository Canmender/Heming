import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { TaskAreaPage } from "./TaskAreaPage.js";
import { useTaskStore, setTaskStorage } from "../lib/tasks/store.js";
import {
  MAX_TEMPLATES,
  setTemplateStorage,
  useTemplateStore,
} from "../lib/tasks/templates.js";
import { createMemoryStorage } from "../lib/memory/storage.js";
import { useUiStore } from "../store/ui.js";
import { useChatStore } from "../store/chat.js";
import { useLlmStore } from "../store/llm.js";
import { setOverride } from "../lib/modelCaps.js";
import { rolloutLog } from "../lib/rollout/index.js";
import { registerConversationAbort, resetConversationAbortsForTests } from "../lib/runAbort.js";

// 通用智能体页只负责「运行视图」：嵌入式 ChatPage 的消息/E2E/工具链路另有专门测试，
// 这里替换成一个探针，验证传参（embedded）与选中后的挂载。
vi.mock("./ChatPage.js", () => ({
  ChatPage: ({ embedded }: { embedded?: boolean }) => (
    <div data-testid="chat-embed">{embedded ? "embedded" : "standalone"}</div>
  ),
}));

const profile = { id: "p1", label: "本地", provider: "openai" as const, apiKey: "k", model: "m" };
const agent = {
  id: "a1",
  owner_id: "u1",
  name: "和小鸣",
  avatar: null,
  description: "",
};

function seedTask(overrides: Partial<Parameters<ReturnType<typeof useTaskStore.getState>["create"]>[0]> = {}) {
  return useTaskStore.getState().create({
    conversationId: "c1",
    agentId: "a1",
    agentName: "和小鸣",
    prompt: "梳理模块依赖",
    ...overrides,
  });
}

beforeEach(() => {
  localStorage.clear();
  setTaskStorage(createMemoryStorage());
  setTemplateStorage(createMemoryStorage());
  useTaskStore.setState({ tasks: [] });
  useTemplateStore.setState({ templates: [] });
  useUiStore.setState({
    // d.67：任务区不再是独立页，宿主是智能体页（page="chat"）；
    // 这里只验证「任务区不改宿主页」，所以初值给宿主页名即可。
    page: "chat",
    activeConversationId: null,
    taskDraft: null,
    settingsTab: null,
  });
  useChatStore.setState({
    conversations: [
      {
        id: "c1",
        type: "agent",
        agent: { id: "a1", name: "和小鸣" },
        unreadCount: 0,
      } as never,
    ],
    agentsRoster: [agent as never],
    loadWorkspace: vi.fn(async () => undefined),
    loadAgentsRoster: vi.fn(async () => undefined),
    openAgent: vi.fn(async () => "c1"),
  });
  useLlmStore.setState({ profiles: [profile], bindings: { a1: "p1" } });
});

describe("通用智能体页面", () => {
  it("绑定的模型不支持工具时，启动前就当场说明", async () => {
    // 能力表 + 用户覆盖层是判定唯一来源：这里用覆盖层模拟「模型不会调工具」
    setOverride("openai", "m", { supportsTools: false });
    render(<TaskAreaPage />);

    const notice = await screen.findByRole("status");
    expect(notice).toHaveTextContent(/不支持工具调用（和小鸣）/);
  });

  it("模型支持工具时不出现降级提示", async () => {
    render(<TaskAreaPage />);
    await waitFor(() =>
      expect(screen.getByLabelText("选择智能体")).toHaveValue("a1"),
    );
    expect(screen.queryByText(/不支持工具调用/)).not.toBeInTheDocument();
  });

  it("空态直接给出启动面板；运行后建档、聚焦会话并投递自动执行", async () => {
    render(<TaskAreaPage />);
    expect(screen.getByText(/还没有运行记录/)).toBeInTheDocument();
    expect(screen.getByRole("form", { name: "运行智能体" })).toBeInTheDocument();

    // 打开时自动选中唯一已绑定智能体（不用用户再点一次）
    await waitFor(() => {
      expect(screen.getByLabelText("选择智能体")).toHaveValue("a1");
    });
    fireEvent.change(screen.getByLabelText("运行目标"), {
      target: { value: "查一下构建失败的原因" },
    });
    fireEvent.click(screen.getByRole("button", { name: "开始运行" }));

    await waitFor(() => expect(useTaskStore.getState().tasks).toHaveLength(1));
    const task = useTaskStore.getState().tasks[0];
    expect(task).toMatchObject({
      conversationId: "c1",
      agentId: "a1",
      agentName: "和小鸣",
      title: "查一下构建失败的原因",
      status: "running",
    });
    expect(useChatStore.getState().openAgent).toHaveBeenCalledWith("a1");
    // 页面不被切走，且运行创建后立刻选中并挂载嵌入式 ChatPage 消费自动执行
    expect(useUiStore.getState().page).toBe("chat");
    expect(useUiStore.getState().activeConversationId).toBe("c1");
    expect(useUiStore.getState().taskDraft).toMatchObject({
      taskId: task.id,
      conversationId: "c1",
      text: "查一下构建失败的原因",
      mentions: [{ agentId: "a1", name: "和小鸣" }],
    });
    expect(screen.getByTestId("chat-embed")).toHaveTextContent("embedded");
  });

  it("没有绑定 LLM 时给出统一提示（与对话页同源组件），启动按钮禁用", async () => {
    useLlmStore.setState({ profiles: [], bindings: {} });
    render(<TaskAreaPage />);

    const notice = screen.getByText(/还没有智能体绑定 LLM 连接/);
    expect(notice).toBeInTheDocument();
    // 同源组件：带固定 id（不是随手写的一段文字）+「去设置」直达
    expect(notice.closest("#unbound-model-notice")).not.toBeNull();
    fireEvent.change(screen.getByLabelText("运行目标"), { target: { value: "要做的事" } });
    expect(screen.getByRole("button", { name: "开始运行" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "去设置" }));
    expect(useUiStore.getState().page).toBe("settings");
    // P1-2：直达「模型」页签，而不是停在「个人资料」
    expect(useUiStore.getState().settingsTab).toBe("model");
  });

  it("未绑定提示不重复：中栏渲染 ChatPage 时右栏不再重复同一句", async () => {
    const id = seedTask({ prompt: "查知识库" });
    useLlmStore.setState({ profiles: [], bindings: {} });
    useTaskStore.getState().settle(id, { status: "done", result: "结论" });
    render(<TaskAreaPage />);

    fireEvent.click(screen.getByRole("button", { name: "运行 查知识库" }));
    // 中栏嵌入式 ChatPage（探针）已挂载；右栏不再重复同一句（审计 P2-5）
    expect(screen.getByTestId("chat-embed")).toBeInTheDocument();
    expect(screen.queryByText(/当前智能体还没有绑定模型连接/)).toBeNull();
  });

  it("中栏没有 ChatPage 时，右栏给未绑定提示且「去设置」直达模型页签", async () => {
    const id = seedTask({ prompt: "查知识库" });
    useLlmStore.setState({ profiles: [], bindings: {} });
    useTaskStore.getState().settle(id, { status: "done", result: "结论" });
    // 选中记录从会话快照恢复，但不聚焦会话 → 中栏是「正在打开运行…」，右栏承担提示
    sessionStorage.setItem("heming.task.selected.v1", JSON.stringify(id));
    render(<TaskAreaPage />);

    expect(await screen.findByText(/当前智能体还没有绑定模型连接/)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "去设置" })[0]);
    expect(useUiStore.getState().page).toBe("settings");
    expect(useUiStore.getState().settingsTab).toBe("model");
  });

  it("选中运行记录 → 聚焦其会话并渲染嵌入式 ChatPage", () => {
    seedTask();
    render(<TaskAreaPage />);
    fireEvent.click(screen.getByRole("button", { name: "运行 梳理模块依赖" }));
    expect(useUiStore.getState().activeConversationId).toBe("c1");
    expect(screen.getByTestId("chat-embed")).toHaveTextContent("embedded");
    // 选中后可回到启动面板
    fireEvent.click(screen.getByRole("button", { name: "新建运行" }));
    expect(screen.getByRole("form", { name: "运行智能体" })).toBeInTheDocument();
  });

  it("汇总展示结果、步骤、拒绝原因与来源；复制确定性报告", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const id = seedTask({ prompt: "查知识库" });
    useTaskStore.getState().stepStart(id, { id: "t1", name: "wiki__search", args: '{"q":"mcp"}' });
    useTaskStore.getState().stepEnd(id, "t1", {
      status: "ok",
      result: "命中 2 页",
      sources: [{ id: "wiki/mcp", title: "MCP 说明" }],
    });
    useTaskStore.getState().stepStart(id, { id: "t2", name: "srv__write", args: "{}" });
    useTaskStore.getState().stepEnd(id, "t2", { status: "denied", denyCause: "user" });
    useTaskStore.getState().settle(id, { status: "done", result: "结论：先拆 mcp 桥" });

    render(<TaskAreaPage />);
    fireEvent.click(screen.getByRole("button", { name: "运行 查知识库" }));

    expect(screen.getAllByText("已完成").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/结论：先拆 mcp 桥/)).toBeInTheDocument();
    expect(screen.getByText("wiki__search")).toBeInTheDocument();
    expect(screen.getByText(/用户当场拒绝/)).toBeInTheDocument();
    expect(screen.getByText("MCP 说明")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "复制 Markdown 报告" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copied = (writeText.mock.calls[0] as unknown[])[0] as string;
    expect(copied).toContain("# 任务：查知识库");
    expect(copied).toContain("## 执行步骤");
    await waitFor(() => expect(screen.getByText("已复制")).toBeInTheDocument());

    // 同一份记录也能导出结构化 JSON；两种格式的「已复制」状态互不串台
    fireEvent.click(screen.getByRole("button", { name: "复制运行 JSON" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    const asJson = JSON.parse((writeText.mock.calls[1] as unknown[])[0] as string);
    expect(asJson).toMatchObject({ format: "heming-task", version: 1 });
    expect(asJson.task.title).toBe("查知识库");
    expect(asJson.task.steps).toHaveLength(2);
    expect(asJson.sources).toEqual([{ id: "wiki/mcp", title: "MCP 说明" }]);
    expect(screen.getByRole("button", { name: "复制运行 JSON" })).toHaveTextContent("已复制");
    expect(screen.getByRole("button", { name: "复制 Markdown 报告" })).toBeInTheDocument();
  });

  it("复制失败不静默：给出可执行的替代做法", async () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    // execCommand 不可用 → copyText 的兜底也失败
    Object.defineProperty(document, "execCommand", {
      value: () => {
        throw new Error("blocked");
      },
      configurable: true,
    });
    const id = seedTask({ prompt: "查知识库" });
    useTaskStore.getState().settle(id, { status: "done", result: "结论" });
    render(<TaskAreaPage />);
    fireEvent.click(screen.getByRole("button", { name: "运行 查知识库" }));
    fireEvent.click(screen.getByRole("button", { name: "复制 Markdown 报告" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/复制失败/);
    expect(alert).toHaveTextContent(/手动选择文本复制/);
  });

  it("重跑：确认文案讲清副作用，确认后新建任务且原任务一字不变", () => {
    const id = seedTask({ prompt: "重跑我" });
    useTaskStore.getState().settle(id, { status: "failed", error: "断线" });
    const before = JSON.stringify(useTaskStore.getState().tasks.find((t) => t.id === id));

    render(<TaskAreaPage />);
    fireEvent.click(screen.getByRole("button", { name: "运行 重跑我" }));
    fireEvent.click(screen.getByRole("button", { name: "重跑" }));

    // 确认框必须出现那两句：会重新执行一遍 / 之前的写操作可能重复
    const dialog = screen.getByRole("dialog", { name: "重跑这次运行" });
    expect(within(dialog).getByText(/会重新执行一遍/)).toBeInTheDocument();
    expect(within(dialog).getByText(/之前的写操作可能重复/)).toBeInTheDocument();
    expect(within(dialog).getByText(/原任务的记录、日志与状态保持不变/)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "确认重跑" }));

    const tasks = useTaskStore.getState().tasks;
    expect(tasks).toHaveLength(2);
    const created = tasks.find((t) => t.id !== id)!;
    expect(created).toMatchObject({
      status: "running",
      prompt: "重跑我",
      conversationId: "c1",
      agentId: "a1",
    });
    expect(created.forkedFrom).toBeUndefined();
    // ★ 原任务不被重跑改动（不 reopen、不追加步骤、不覆盖结果）
    expect(JSON.stringify(tasks.find((t) => t.id === id))).toBe(before);
    expect(useUiStore.getState().taskDraft).toMatchObject({
      taskId: created.id,
      text: "重跑我",
      conversationId: "c1",
    });
  });

  it("分叉：先看 P3 复用/丢弃清单，确认后新建任务且原任务不变", () => {
    const id = seedTask({ prompt: "梳理模块依赖" });
    useTaskStore.getState().bindStream(id, "s-fork");
    useTaskStore.getState().settle(id, { status: "cancelled" });
    // 本机日志：开始 → 读文件（有结果）→ 中断收尾；可分的点就是那条工具结果（seq=2）
    rolloutLog.append({ type: "turn_start", conversationId: "c1", streamId: "s-fork", agentId: "a1", userText: "梳理模块依赖" });
    rolloutLog.append({ type: "tool_call", streamId: "s-fork", id: "t1", name: "srv__read", args: '{"path":"a.md"}' });
    rolloutLog.append({ type: "tool_result", streamId: "s-fork", id: "t1", name: "srv__read", ok: true, text: "a.md 内容" });
    rolloutLog.append({ type: "turn_end", streamId: "s-fork", status: "aborted" });
    const before = JSON.stringify(useTaskStore.getState().tasks.find((t) => t.id === id));

    render(<TaskAreaPage />);
    fireEvent.click(screen.getByRole("button", { name: "运行 梳理模块依赖" }));
    fireEvent.click(screen.getByRole("button", { name: /从此处分叉/ }));

    const dialog = screen.getByRole("dialog", { name: "从这一步之后分叉" });
    // P3：点之前就看清复用哪几条、丢弃哪些
    expect(within(dialog).getByText(/将沿用 1 条工具结果/)).toBeInTheDocument();
    expect(within(dialog).getByText(/srv · read/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/srv__read/)).not.toBeInTheDocument();
    expect(within(dialog).getByText(/将丢弃 1 条记录/)).toBeInTheDocument();
    // 诚实提示：前缀是重建的、可能被截断
    expect(within(dialog).getByText(/前缀由本机日志重建/)).toBeInTheDocument();
    expect(within(dialog).getByText(/写操作/)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "确认分叉" }));

    const tasks = useTaskStore.getState().tasks;
    expect(tasks).toHaveLength(2);
    const created = tasks.find((t) => t.id !== id)!;
    expect(created).toMatchObject({
      status: "running",
      prompt: "梳理模块依赖",
      conversationId: "c1",
      agentId: "a1",
      forkedFrom: { streamId: "s-fork", seq: 2 },
    });
    // 原任务日志/汇总/状态一律不动
    expect(JSON.stringify(tasks.find((t) => t.id === id))).toBe(before);
    expect(useUiStore.getState().taskDraft).toMatchObject({ taskId: created.id, text: "梳理模块依赖" });
  });

  it("分叉任务的任务卡如实标注来源与截断代价", () => {
    const id = seedTask({
      prompt: "分叉出来的任务",
      forkedFrom: { streamId: "s1", seq: 4, truncatedResults: 1 },
    });
    render(<TaskAreaPage />);
    fireEvent.click(screen.getByRole("button", { name: "运行 分叉出来的任务" }));

    expect(screen.getByText(/回合 s1 · 第 4 条之后/)).toBeInTheDocument();
    const notice = screen.getByText(/前缀由本机日志重建/);
    expect(notice).toHaveTextContent(/结果不完整/);
    expect(notice).toHaveTextContent(/有 1 条工具/);
    expect(id).toBeTruthy();
  });

  it("搜索与状态筛选只影响列表，不丢数据", () => {
    const a = seedTask({ prompt: "旧运行" });
    seedTask({ prompt: "新运行" });
    useTaskStore.getState().settle(a, { status: "done" });

    render(<TaskAreaPage />);
    expect(screen.getByRole("button", { name: "运行 旧运行" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "运行 新运行" })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("搜索运行记录"), { target: { value: "新" } });
    expect(screen.queryByRole("button", { name: "运行 旧运行" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "运行 新运行" })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("搜索运行记录"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /已完成 1/ }));
    expect(screen.getByRole("button", { name: "运行 旧运行" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "运行 新运行" })).not.toBeInTheDocument();
    expect(useTaskStore.getState().tasks).toHaveLength(2);
  });

  it("删除运行记录只删本机记录（应用内确认，不弹系统框）", () => {
    seedTask({ prompt: "要删的" });
    const confirmSpy = vi.spyOn(window, "confirm");
    render(<TaskAreaPage />);
    fireEvent.click(screen.getByRole("button", { name: "运行 要删的" }));
    fireEvent.click(screen.getByRole("button", { name: "删除运行记录" }));
    expect(confirmSpy).not.toHaveBeenCalled();

    const dialog = screen.getByRole("dialog", { name: "删除运行记录" });
    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));
    expect(useTaskStore.getState().tasks).toHaveLength(0);
  });

  it("目标存成模板：写进本机存储，模板下拉里选得到", () => {
    render(<TaskAreaPage />);
    fireEvent.change(screen.getByLabelText("运行目标"), {
      target: { value: "每周汇总本周改动并列出风险" },
    });
    // 名称留空 → 用首行做默认名
    fireEvent.click(screen.getByRole("button", { name: "存为模板" }));

    expect(useTemplateStore.getState().templates.map((t) => t.name)).toEqual([
      "每周汇总本周改动并列出风险",
    ]);
    expect(screen.getByText(/已存为模板「每周汇总本周改动并列出风险」/)).toBeInTheDocument();
    expect(screen.getByLabelText("目标模板")).toHaveValue(useTemplateStore.getState().templates[0].id);
  });

  it("选中模板把目标填回输入框，仍可继续编辑后发起运行", async () => {
    useTemplateStore.getState().save({ name: "依赖梳理", prompt: "列出耦合最重的三处模块" });
    render(<TaskAreaPage />);
    fireEvent.change(screen.getByLabelText("目标模板"), {
      target: { value: useTemplateStore.getState().templates[0].id },
    });
    expect(screen.getByLabelText("运行目标")).toHaveValue("列出耦合最重的三处模块");

    fireEvent.change(screen.getByLabelText("运行目标"), {
      target: { value: "列出耦合最重的三处模块，并给出改法" },
    });
    fireEvent.click(screen.getByRole("button", { name: "开始运行" }));
    await waitFor(() => expect(useTaskStore.getState().tasks).toHaveLength(1));
    expect(useTaskStore.getState().tasks[0].prompt).toBe("列出耦合最重的三处模块，并给出改法");
    // 模板本体不受这次编辑影响
    expect(useTemplateStore.getState().templates[0].prompt).toBe("列出耦合最重的三处模块");
  });

  it("重名保存给出原因；删除模板走应用内确认", () => {
    useTemplateStore.getState().save({ name: "周报", prompt: "汇总本周改动" });
    render(<TaskAreaPage />);

    fireEvent.change(screen.getByLabelText("模板名称"), { target: { value: "周报" } });
    fireEvent.change(screen.getByLabelText("运行目标"), { target: { value: "另一段正文" } });
    fireEvent.click(screen.getByRole("button", { name: "存为模板" }));
    expect(screen.getByText(/已有同名模板「周报」/)).toBeInTheDocument();
    expect(useTemplateStore.getState().templates).toHaveLength(1);

    fireEvent.change(screen.getByLabelText("目标模板"), {
      target: { value: useTemplateStore.getState().templates[0].id },
    });
    const confirmSpy = vi.spyOn(window, "confirm");
    fireEvent.click(screen.getByRole("button", { name: "删除模板" }));
    expect(confirmSpy).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: "删除目标模板" });
    // 取消不动数据，确认才删
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(useTemplateStore.getState().templates).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "删除模板" }));
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "删除目标模板" })).getByRole("button", {
        name: "删除",
      }),
    );
    expect(useTemplateStore.getState().templates).toHaveLength(0);
    expect(screen.getByLabelText("目标模板")).toHaveValue("");
  });

  it(`模板满 ${MAX_TEMPLATES} 条后禁止继续保存并说明原因`, () => {
    useTemplateStore.setState({
      templates: Array.from({ length: MAX_TEMPLATES }, (_, i) => ({
        id: `t${i}`,
        name: `模板${i}`,
        prompt: `正文${i}`,
        createdAt: 1000 + i,
        updatedAt: 1000 + i,
      })),
    });
    render(<TaskAreaPage />);
    fireEvent.change(screen.getByLabelText("运行目标"), { target: { value: "再存一条" } });
    expect(screen.getByRole("button", { name: "存为模板" })).toBeDisabled();
    expect(screen.getByText(/模板已达 12 条上限/)).toBeInTheDocument();
  });
});

/**
 * d.67 导航合并：任务区并入智能体页的「任务」Tab。
 * 嵌入态只藏本页自己的页头标题（否则宿主页 h1 + 本页标题会叠成两个），
 * 列表/筛选/启动面板/详情这些真正的内容一律保留。
 */
describe("任务区稳定化（d.86）", () => {
  beforeEach(() => resetConversationAbortsForTests());

  it("选中运行记录后卸载再挂载（等价切 Tab）仍停在原记录上", async () => {
    const id = seedTask();
    const { unmount } = render(<TaskAreaPage />);
    fireEvent.click(await screen.findByRole("button", { name: /运行 梳理模块依赖/ }));
    // 选中后右栏是汇总（出现「目标」段）
    await waitFor(() => expect(screen.getByText("目标")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /运行 梳理模块依赖/ })).toHaveAttribute(
      "aria-current",
      "true",
    );
    unmount();

    // 「切到对话 Tab 再切回来」= 组件卸载重建；选中应从会话级快照恢复
    render(<TaskAreaPage />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /运行 梳理模块依赖/ })).toHaveAttribute(
        "aria-current",
        "true",
      ),
    );
    expect(screen.getByText("目标")).toBeInTheDocument();
    expect(sessionStorage.getItem("heming.task.selected.v1")).toContain(id);
  });

  it("运行中的任务在汇总卡有「停止运行」；执行者不在当前页面时如实说明", async () => {
    const id = seedTask();
    useTaskStore.setState({
      tasks: useTaskStore.getState().tasks.map((t) =>
        t.id === id ? { ...t, status: "running" as const } : t,
      ),
    });
    render(<TaskAreaPage />);
    fireEvent.click(await screen.findByRole("button", { name: /运行 梳理模块依赖/ }));

    const stop = await screen.findByRole("button", { name: "停止运行" });
    fireEvent.click(stop);
    expect(
      await screen.findByText(/这条运行不在当前页面里，先打开运行会话再停止/),
    ).toBeInTheDocument();
  });

  it("有执行者登记时，「停止运行」会请求中断该会话", async () => {
    const id = seedTask();
    useTaskStore.setState({
      tasks: useTaskStore.getState().tasks.map((t) =>
        t.id === id ? { ...t, status: "running" as const } : t,
      ),
    });
    const abort = vi.fn();
    const off = registerConversationAbort("c1", abort);
    render(<TaskAreaPage />);
    fireEvent.click(await screen.findByRole("button", { name: /运行 梳理模块依赖/ }));
    fireEvent.click(await screen.findByRole("button", { name: "停止运行" }));

    expect(abort).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/已请求停止/)).toBeInTheDocument();
    off();
  });
});

describe("任务区嵌入态（d.67）", () => {
  it("embedded：不画自己的页头标题，但搜索、状态筛选与启动面板都在", () => {
    render(<TaskAreaPage embedded />);

    expect(screen.queryByText("通用智能体")).not.toBeInTheDocument();
    expect(document.querySelector(".ui-page-title")).toBeNull();
    // 页头标题去掉，功能控件不能跟着丢
    expect(screen.getByLabelText("搜索运行记录")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "按状态筛选" })).toBeInTheDocument();
    expect(screen.getByRole("form", { name: "运行智能体" })).toBeInTheDocument();
  });

  it("独立态（旧路由过渡期）：仍保留页面标题与运行统计", () => {
    render(<TaskAreaPage />);
    expect(screen.getByText("通用智能体")).toBeInTheDocument();
    expect(document.querySelector(".ui-page-title")).not.toBeNull();
  });
});
