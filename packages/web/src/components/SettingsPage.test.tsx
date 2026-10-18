import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SettingsPage } from "./SettingsPage.js";
import { useAuthStore } from "../store/auth.js";
import { setToken } from "../lib/api.js";

const alice = { id: "u1", username: "alice", displayName: "爱丽丝" };

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("SettingsPage 个人资料", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    setToken("t1");
    useAuthStore.setState({
      token: "t1",
      user: { ...alice },
      status: "authed",
      error: null,
    });
  });

  it("渲染个人资料卡片：默认头像图标、昵称回填且 maxLength 64、上传与保存控件", () => {
    render(<SettingsPage />);
    expect(screen.getByText("个人资料")).toBeInTheDocument();
    const nameInput = screen.getByLabelText("昵称");
    expect(nameInput).toHaveValue("爱丽丝");
    expect(nameInput).toHaveAttribute("maxlength", "64");
    const fileInput = screen.getByLabelText("上传头像");
    expect(fileInput).toHaveAttribute("accept", "image/*");
    expect(screen.getByRole("button", { name: "保存" })).toBeInTheDocument();
    // 无头像 → 默认人形图标（不渲染 img）
    expect(screen.queryByAltText("当前头像")).not.toBeInTheDocument();
  });

  it("保存昵称调用 PUT /api/me，成功后 store user 更新并显示「已保存」", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonRes({ ...alice, displayName: "新昵称" }));

    render(<SettingsPage />);
    fireEvent.change(screen.getByLabelText("昵称"), { target: { value: "新昵称" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(screen.getByText("已保存")).toBeInTheDocument());
    expect(useAuthStore.getState().user?.displayName).toBe("新昵称");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/me");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({ displayName: "新昵称" });
  });

  it("保存失败显示错误文案，不显示「已保存」且 store user 不变", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonRes({ error: "boom" }, 500));

    render(<SettingsPage />);
    fireEvent.change(screen.getByLabelText("昵称"), { target: { value: "新昵称" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByText("boom")).toBeInTheDocument();
    expect(screen.queryByText("已保存")).not.toBeInTheDocument();
    expect(useAuthStore.getState().user?.displayName).toBe("爱丽丝");
  });

  it("选择小图上传：预览 <img> data URL，保存 body 携带头像", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = String(input);
      if (url === "/api/me" && init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as { displayName: string; avatar?: string };
        return Promise.resolve(jsonRes({ ...alice, ...body }));
      }
      return Promise.resolve(jsonRes({ error: "not found" }, 404));
    });

    render(<SettingsPage />);
    const png = new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("上传头像"), { target: { files: [png] } });

    const img = await screen.findByAltText("当前头像");
    expect(img.getAttribute("src")).toMatch(/^data:image\/png;base64,/);

    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(screen.getByText("已保存")).toBeInTheDocument());

    const put = fetchMock.mock.calls.find(
      (c) => String(c[0]) === "/api/me" && (c[1] as RequestInit)?.method === "PUT",
    );
    expect(put).toBeTruthy();
    const body = JSON.parse(String((put![1] as RequestInit).body)) as { avatar?: string };
    expect(body.avatar).toMatch(/^data:image\/png;base64,/);
    expect(useAuthStore.getState().user?.avatar).toMatch(/^data:image\/png;base64,/);
  });

  it("超 449KB（449_001 字节）头像拒绝并提示，未生成预览", async () => {
    vi.spyOn(globalThis, "fetch");
    render(<SettingsPage />);
    const big = new File([new Uint8Array(449_001)], "big.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("上传头像"), { target: { files: [big] } });

    expect(await screen.findByText(/不能超过约 449KB/)).toBeInTheDocument();
    expect(screen.queryByAltText("当前头像")).not.toBeInTheDocument();
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it("449_000 字节头像放行（上限边界内，不再报错）", async () => {
    render(<SettingsPage />);
    const ok = new File([new Uint8Array(449_000)], "ok.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("上传头像"), { target: { files: [ok] } });

    await waitFor(() => expect(screen.getByAltText("当前头像")).toBeInTheDocument());
    expect(screen.queryByText(/不能超过约 449KB/)).not.toBeInTheDocument();
  });

  it("保存成功后再选头像文件：复位「已保存」状态（与昵称 onChange 一致）", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = String(input);
      if (url === "/api/me" && init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as { displayName: string };
        return Promise.resolve(jsonRes({ ...alice, ...body }));
      }
      return Promise.resolve(jsonRes({ error: "not found" }, 404));
    });

    render(<SettingsPage />);
    fireEvent.change(screen.getByLabelText("昵称"), { target: { value: "新昵称" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(screen.getByText("已保存")).toBeInTheDocument());

    // 选文件后 saved 复位（昵称 onChange 已是此行为，头像选择保持一致）
    const png = new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("上传头像"), { target: { files: [png] } });
    await waitFor(() => expect(screen.queryByText("已保存")).not.toBeInTheDocument());
  });

  it("非图片文件拒绝并提示", async () => {
    render(<SettingsPage />);
    const txt = new File(["x"], "a.txt", { type: "text/plain" });
    fireEvent.change(screen.getByLabelText("上传头像"), { target: { files: [txt] } });

    expect(await screen.findByText(/请选择图片文件/)).toBeInTheDocument();
    expect(screen.queryByAltText("当前头像")).not.toBeInTheDocument();
  });

  it("个人资料卡下方挂载 LLM 连接卡（空态）", () => {
    render(<SettingsPage />);
    expect(screen.getByText("个人资料")).toBeInTheDocument();
    expect(screen.getByText("LLM 连接")).toBeInTheDocument();
    expect(screen.getByText(/还没有 LLM 连接/)).toBeInTheDocument();
    // 三卡次序：个人资料 → LLM 连接 → 上下文预算
    const sections = document.querySelectorAll("section");
    expect(sections).toHaveLength(3);
    expect(sections[0].textContent).toContain("个人资料");
    expect(sections[1].textContent).toContain("LLM 连接");
    expect(sections[2].textContent).toContain("上下文预算");
  });

  it("LLM 连接卡之后挂载上下文预算卡：默认值回填、改动即时落盘", () => {
    render(<SettingsPage />);
    expect(screen.getByText("上下文预算")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "启用上下文预算" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByLabelText("预算")).toHaveValue("6000");

    fireEvent.click(screen.getByRole("switch", { name: "用模型生成早期摘要" }));
    expect(JSON.parse(localStorage.getItem("heming.context.v1") as string).llmSummary).toBe(false);
  });
});
