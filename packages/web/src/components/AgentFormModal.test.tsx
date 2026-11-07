import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { AgentFormModal, AGENT_TEMPLATES } from "./AgentFormModal.js";
import { useLlmStore } from "../store/llm.js";
import { useAuthStore } from "../store/auth.js";
import { useUiStore } from "../store/ui.js";

describe("AgentFormModal", () => {
  beforeEach(() => {
    localStorage.clear();
    useLlmStore.setState({ profiles: [], bindings: {}, prompts: {} });
    useAuthStore.setState({ user: { id: "u1", username: "alice", displayName: "爱丽丝" }, status: "authed" });
    useUiStore.setState({ page: "chat" });
    vi.restoreAllMocks();
  });

  it("无 LLM 连接时提示去设置页；有连接时可选并保存", async () => {
    const { rerender } = render(<AgentFormModal open mode="create" onClose={() => {}} />);
    // 进阶区默认收起：先展开才看得到模型连接
    fireEvent.click(screen.getByRole("button", { name: "进阶设置（可选）" }));
    expect(screen.getByText(/去设置页添加/)).toBeInTheDocument();

    useLlmStore.getState().addProfile({ id: "p1", label: "主模型", provider: "openai", apiKey: "k", model: "m" });
    rerender(<AgentFormModal open mode="create" onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "架构师" } });
    fireEvent.change(screen.getByLabelText("系统提示词（仅本机）"), { target: { value: "你是架构师" } });
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "a1", owner_id: "u1", name: "架构师", avatar: null, description: "" }), {
        status: 201, headers: { "content-type": "application/json" },
      }),
    );
    fireEvent.click(screen.getByText("创建"));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(JSON.parse(localStorage.getItem("heming.agentPrompts")!)["a1"]).toBe("你是架构师");
  });

  it("「去设置页添加」点击后切到设置页「模型」并关闭弹窗", () => {
    const onClose = vi.fn();
    render(<AgentFormModal open mode="create" onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "进阶设置（可选）" }));
    fireEvent.click(screen.getByText(/去设置页添加/));
    expect(useUiStore.getState().page).toBe("settings");
    expect(useUiStore.getState().settingsTab).toBe("model");
    expect(onClose).toHaveBeenCalled();
  });

  it("内置智能体：名称/简介禁用，模型绑定仍可保存且不走服务端", async () => {
    useLlmStore.setState({
      profiles: [{ id: "p1", label: "DeepSeek", provider: "openai", apiKey: "k", model: "deepseek-chat" }],
      bindings: {},
      prompts: {},
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const onClose = vi.fn();
    render(
      <AgentFormModal
        open
        mode="edit"
        agent={{ id: "system-assistant", owner_id: null, name: "和小鸣", avatar: null, description: "系统预置" }}
        onClose={onClose}
      />,
    );

    expect(screen.getByLabelText("名称")).toBeDisabled();
    expect(screen.getByLabelText("一句话描述")).toBeDisabled();
    expect(screen.getByText(/内置智能体/)).toBeInTheDocument();
    // 系统智能体不走服务端 PUT，也不该显示删除
    expect(screen.queryByText("删除智能体")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "进阶设置（可选）" }));
    fireEvent.change(screen.getByLabelText("绑定连接"), { target: { value: "p1" } });
    fireEvent.click(screen.getByText("保存"));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(useLlmStore.getState().bindings["system-assistant"]).toBe("p1");
    // 只允许名册刷新（GET）；系统智能体不发 PUT
    const puts = fetchSpy.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "PUT");
    expect(puts).toHaveLength(0);
  });

  it("编辑系统 owner 时显示删除，非 owner 不显示", () => {
    render(<AgentFormModal open mode="edit" agent={{ id: "a1", owner_id: "someone", name: "别人的", avatar: null, description: "" }} onClose={() => {}} />);
    expect(screen.queryByText("删除智能体")).not.toBeInTheDocument();
  });

  it("owner 编辑：预填名称/提示词，删除走应用内确认后调 deleteAgent", async () => {
    useLlmStore.setState({
      prompts: { a1: "旧提示" },
      bindings: {},
      profiles: [],
    });
    const confirmSpy = vi.spyOn(window, "confirm");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 204 }),
    );
    const onClose = vi.fn();
    render(
      <AgentFormModal
        open
        mode="edit"
        agent={{ id: "a1", owner_id: "u1", name: "架构师", avatar: null, description: "d" }}
        onClose={onClose}
      />,
    );
    expect(screen.getByLabelText("名称")).toHaveValue("架构师");
    expect(screen.getByLabelText("系统提示词（仅本机）")).toHaveValue("旧提示");

    fireEvent.click(screen.getByText("删除智能体"));
    // 不弹系统框；确认之前不发请求
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: "删除智能体" });
    expect(within(dialog).getByText(/此操作不可恢复/)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain("/api/agents/a1");
    expect(init?.method).toBe("DELETE");
    expect(onClose).toHaveBeenCalled();
  });

  it("应用内确认点「取消」：弹窗关闭，不删除", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    render(
      <AgentFormModal
        open
        mode="edit"
        agent={{ id: "a1", owner_id: "u1", name: "架构师", avatar: null, description: "" }}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByText("删除智能体"));
    fireEvent.click(within(screen.getByRole("dialog", { name: "删除智能体" })).getByRole("button", { name: "取消" }));

    expect(screen.queryByRole("dialog", { name: "删除智能体" })).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("名称为空不提交", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    render(<AgentFormModal open mode="create" onClose={() => {}} />);
    fireEvent.click(screen.getByText("创建"));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.getByText(/请输入名称/)).toBeInTheDocument();
  });

  it("提交中：标题旁显示「提交中…」，Esc 与点遮罩都不关闭", async () => {
    // 请求挂着不返回：模拟真实网络里的 pending 窗口
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
    const onClose = vi.fn();
    render(<AgentFormModal open mode="create" onClose={onClose} />);
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "架构师" } });
    fireEvent.click(screen.getByText("创建"));

    expect(await screen.findByText("提交中…")).toBeInTheDocument();
    const dialog = screen.getByRole("dialog", { name: "新建智能体" });
    const overlay = dialog.parentElement as HTMLElement;

    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.mouseDown(overlay);

    expect(onClose).not.toHaveBeenCalled();
    // 取消按钮同样不可用：此刻关掉只会让用户以为没提交
    expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
  });

  it("从模板开始：4 个预设只填空字段，不覆盖已输入，再次点击不重复追加", () => {
    render(<AgentFormModal open mode="create" onClose={() => {}} />);
    expect(screen.getAllByRole("button", { name: /^使用模板 / })).toHaveLength(4);

    // 用户已写的名称不被覆盖；空的描述/提示词被模板填上
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "我的手" } });
    fireEvent.click(screen.getByRole("button", { name: "使用模板 写作润色" }));
    const writing = AGENT_TEMPLATES.find((tpl) => tpl.key === "writing")!;
    expect(screen.getByLabelText("名称")).toHaveValue("我的手");
    expect(screen.getByLabelText("一句话描述")).toHaveValue(writing.description);

    // 同一模板再点一次：不追加、不改变
    fireEvent.click(screen.getByRole("button", { name: "使用模板 写作润色" }));
    // 换一个模板：已填的描述不被覆盖
    fireEvent.click(screen.getByRole("button", { name: "使用模板 代码助手" }));
    expect(screen.getByLabelText("一句话描述")).toHaveValue(writing.description);

    // 提示词在进阶区：展开后是模板内容，且没有被追加两遍
    fireEvent.click(screen.getByRole("button", { name: "进阶设置（可选）" }));
    expect(screen.getByLabelText("系统提示词（仅本机）")).toHaveValue(writing.prompt);
    // 模板按钮有「已套用」状态（aria-pressed），供读屏与视觉同时识别
    expect(screen.getByRole("button", { name: "使用模板 写作润色" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("空表单点模板：名称/描述/提示词都按预设填好", () => {
    render(<AgentFormModal open mode="create" onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "使用模板 数据分析" }));
    const data = AGENT_TEMPLATES.find((tpl) => tpl.key === "data")!;
    expect(screen.getByLabelText("名称")).toHaveValue(data.name);
    expect(screen.getByLabelText("一句话描述")).toHaveValue(data.description);
    fireEvent.click(screen.getByRole("button", { name: "进阶设置（可选）" }));
    expect(screen.getByLabelText("系统提示词（仅本机）")).toHaveValue(data.prompt);
  });

  it("新建时进阶默认收起；编辑且进阶字段非空时默认展开", () => {
    const create = render(<AgentFormModal open mode="create" onClose={() => {}} />);
    expect(screen.queryByLabelText("系统提示词（仅本机）")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "进阶设置（可选）" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    create.unmount();

    // 编辑：提示词非空 → 默认展开，避免「已有配置看不见」
    useLlmStore.setState({ prompts: { a1: "旧提示" }, bindings: {} });
    const edit = render(
      <AgentFormModal
        open
        mode="edit"
        agent={{ id: "a1", owner_id: "u1", name: "架构师", avatar: null, description: "" }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByLabelText("系统提示词（仅本机）")).toHaveValue("旧提示");
    expect(screen.getByRole("button", { name: "收起进阶设置" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    edit.unmount();

    // 编辑但进阶字段都为空 → 仍默认收起
    useLlmStore.setState({ prompts: {}, bindings: {} });
    render(
      <AgentFormModal
        open
        mode="edit"
        agent={{ id: "a1", owner_id: "u1", name: "架构师", avatar: null, description: "" }}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByLabelText("系统提示词（仅本机）")).not.toBeInTheDocument();
  });

  it("提交 payload 与旧版一致：只有 name/description/avatar 三个字段", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ id: "a2", owner_id: "u1", name: "架构师", avatar: null, description: "写代码" }),
        { status: 201, headers: { "content-type": "application/json" } },
      ),
    );
    render(<AgentFormModal open mode="create" onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "架构师" } });
    fireEvent.change(screen.getByLabelText("一句话描述"), { target: { value: "写代码" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain("/api/agents");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      name: "架构师",
      description: "写代码",
      avatar: null,
    });
  });

  it("创建成功回调 onCreated（智能体页据此直接开始对话）", async () => {
    const created = { id: "a3", owner_id: "u1", name: "新助手", avatar: null, description: "" };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(created), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
    const onCreated = vi.fn();
    const onClose = vi.fn();
    render(
      <AgentFormModal open mode="create" onCreated={onCreated} onClose={onClose} />,
    );
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "新助手" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(() =>
      expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: "a3" })),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it("startAt=templates 时焦点落在第一个模板上；默认落在名称", () => {
    const templates = render(
      <AgentFormModal open mode="create" startAt="templates" onClose={() => {}} />,
    );
    expect(screen.getByRole("button", { name: "使用模板 通用助手" })).toHaveFocus();
    templates.unmount();

    render(<AgentFormModal open mode="create" onClose={() => {}} />);
    expect(screen.getByLabelText("名称")).toHaveFocus();
  });
});
