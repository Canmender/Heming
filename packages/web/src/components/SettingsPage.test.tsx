import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SettingsPage, appVersionLabel } from "./SettingsPage.js";
import { useAuthStore } from "../store/auth.js";
import { useThemeStore } from "../store/theme.js";
import { DEFAULT_NAV_ORDER, useUiStore } from "../store/ui.js";
import { setToken } from "../lib/api.js";

const alice = { id: "u1", username: "alice", displayName: "爱丽丝" };

/**
 * 切到设置区的某个分组标签。
 * 设置区已改为上侧横向标签页、一次只渲染一个分组，
 * 所以测「外观/导航/关于/模型」里的东西前必须先切过去。
 */
function goTab(name: "个人资料" | "模型" | "外观" | "导航" | "关于"): void {
  fireEvent.click(screen.getByRole("tab", { name }));
}

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
    // 标签名与卡片标题同名，用 role 精确取卡片内的标题（避免匹配到标签按钮）
    expect(screen.getByText("个人资料", { selector: "div" })).toBeInTheDocument();
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

  it("「模型」分组挂 LLM 连接卡（空态）与上下文预算卡", () => {
    render(<SettingsPage />);
    // 设置区已标签化：默认停在「个人资料」，切到「模型」才渲染这两张卡
    expect(screen.queryByText("LLM 连接")).not.toBeInTheDocument();
    goTab("模型");
    expect(screen.getByText("LLM 连接")).toBeInTheDocument();
    expect(screen.getByText(/还没有 LLM 连接/)).toBeInTheDocument();
    expect(screen.getByText("上下文预算")).toBeInTheDocument();
    // 切回「个人资料」后模型卡卸载（一次只渲染当前分组）
    goTab("个人资料");
    expect(screen.queryByText("LLM 连接")).not.toBeInTheDocument();
  });

  it("LLM 连接卡之后挂载上下文预算卡：默认值回填、改动即时落盘", () => {
    render(<SettingsPage />);
    goTab("模型");
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

describe("设置区版本展示", () => {
  afterEach(() => {
    delete window.__heming_version;
  });

  it("桌面端展示 preload 注入的 5 段版本", () => {
    window.__heming_version = "d.0.1.0.0";
    expect(appVersionLabel()).toBe("d.0.1.0.0");
  });

  it("拿不到注入版本时显示「桌面版」，不伪造版本号，也不提网页版", () => {
    // 和鸣只面向桌面安装版，浏览器环境属异常情况；
    // 这里刻意不再显示「网页版」——那会暗示用户还能用网页访问。
    expect(appVersionLabel()).toBe("桌面版");
    window.__heming_version = "   ";
    expect(appVersionLabel()).toBe("桌面版");
  });
});

describe("设置区 · 页面颜色", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("style");
    useThemeStore.setState({ accent: "#1a1a1a" });
  });

  it("点预设色板即写入 CSS 变量并落盘", () => {
    render(<SettingsPage />);
    goTab("外观");
    fireEvent.click(screen.getByRole("button", { name: "主题色 靛蓝" }));
    expect(useThemeStore.getState().accent).toBe("#2f5bd7");
    expect(document.documentElement.style.getPropertyValue("--heming-accent")).toBe("#2f5bd7");
    expect(document.documentElement.style.getPropertyValue("--heming-on-accent")).toBe("#ffffff");
    expect(JSON.parse(localStorage.getItem("heming.theme.v1") as string).accent).toBe("#2f5bd7");
  });

  it("自定义十六进制：合法即生效，非法给出可见提示且不改色", () => {
    render(<SettingsPage />);
    goTab("外观");
    const input = screen.getByLabelText("自定义主题色");
    fireEvent.change(input, { target: { value: "#abc" } });
    fireEvent.blur(input);
    expect(useThemeStore.getState().accent).toBe("#aabbcc");

    fireEvent.change(input, { target: { value: "红色" } });
    fireEvent.blur(input);
    expect(useThemeStore.getState().accent).toBe("#aabbcc");
    expect(screen.getByText(/请输入十六进制色/)).toBeInTheDocument();
  });

  it("恢复默认 → 回墨色并清掉 DOM 变量", () => {
    useThemeStore.getState().setAccent("#2f5bd7");
    render(<SettingsPage />);
    goTab("外观");
    fireEvent.click(screen.getByRole("button", { name: "恢复默认颜色" }));
    expect(useThemeStore.getState().accent).toBe("#1a1a1a");
    expect(document.documentElement.style.getPropertyValue("--heming-accent")).toBe("");
  });
});

describe("设置区 · 导航顺序", () => {
  beforeEach(() => {
    localStorage.clear();
    useUiStore.setState({ navOrder: [...DEFAULT_NAV_ORDER] });
  });

  it("上移/下移改变顺序并落盘，首项上移与末项下移禁用", () => {
    render(<SettingsPage />);
    goTab("导航");
    fireEvent.click(screen.getByRole("button", { name: "上移 技能区" }));
    expect(useUiStore.getState().navOrder).toEqual([
      "home",
      "workspace",
      "skills",
      "tasks",
      "interfaces",
      "memory",
      "archive",
      "settings",
    ]);
    expect(JSON.parse(localStorage.getItem("heming.navOrder.v1") as string)).toEqual(
      useUiStore.getState().navOrder,
    );
    expect(screen.getByRole("button", { name: "上移 主页" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "下移 设置区" })).toBeDisabled();
  });

  it("恢复默认导航顺序", () => {
    useUiStore.getState().setNavOrder(["settings", "memory", "home", "workspace", "skills", "interfaces"]);
    render(<SettingsPage />);
    goTab("导航");
    fireEvent.click(screen.getByRole("button", { name: "恢复默认导航顺序" }));
    expect(useUiStore.getState().navOrder).toEqual([...DEFAULT_NAV_ORDER]);
  });
});

describe("设置区 · 常用服务商预设", () => {
  it("点预设自动填好协议、Base URL 与模型，并展开表单", () => {
    render(<SettingsPage />);
    goTab("模型");
    fireEvent.click(screen.getByRole("button", { name: "套用预设 DeepSeek" }));
    expect(screen.getByLabelText("Base URL")).toHaveValue("https://api.deepseek.com/v1");
    expect(screen.getByLabelText("模型")).toHaveValue("deepseek-chat");
    expect((screen.getByLabelText("服务商") as HTMLSelectElement).value).toBe("openai");
  });

  it("Anthropic 预设切到 anthropic 协议", () => {
    render(<SettingsPage />);
    goTab("模型");
    fireEvent.click(screen.getByRole("button", { name: "套用预设 Anthropic" }));
    expect((screen.getByLabelText("服务商") as HTMLSelectElement).value).toBe("anthropic");
    expect(screen.getByLabelText("Base URL")).toHaveValue("https://api.anthropic.com");
  });
});

describe("设置区 · 头像恢复默认", () => {
  it("有头像时显示恢复按钮，点击后清空待保存的头像", () => {
    useAuthStore.setState({
      user: { ...alice, avatar: "data:image/png;base64,AAA" },
    });
    render(<SettingsPage />);
    goTab("个人资料");
    fireEvent.click(screen.getByRole("button", { name: "恢复默认头像" }));
    expect(screen.queryByRole("button", { name: "恢复默认头像" })).not.toBeInTheDocument();
    useAuthStore.setState({ user: alice });
  });
});

describe("设置区 · 更新日志卡", () => {
  afterEach(() => {
    delete window.__heming_version;
  });

  it("列出 CHANGELOG 全部条目；版本对不上时不认「当前」，全部收起", () => {
    window.__heming_version = "d.0.0.9.9";
    render(<SettingsPage />);
    goTab("关于");
    expect(screen.getByRole("region", { name: "更新日志" })).toBeInTheDocument();
    // 条目来自生成的 CHANGELOG（数据本身在 lib/changelog.test.ts 里校验）
    expect(screen.getByRole("button", { name: "更新日志 d.3.0.3.0" })).toBeInTheDocument();
    for (const b of screen.getAllByRole("button", { name: /^更新日志 d\./ })) {
      expect(b).toHaveAttribute("aria-expanded", "false");
    }
  });

  it("点条目展开/收起，并渲染粗体与行内代码", () => {
    window.__heming_version = "d.3.0.3.0";
    render(<SettingsPage />);
    goTab("关于");
    const btn = screen.getByRole("button", { name: "更新日志 d.3.0.3.0" });
    // 当前版本默认展开
    expect(btn).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/单一解析点/)).toBeInTheDocument();

    fireEvent.click(btn);
    expect(btn).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(btn);
    expect(btn).toHaveAttribute("aria-expanded", "true");
    // 行内代码被渲染成 <code>
    expect(document.querySelector("code")).toBeTruthy();
  });

  it("给当前版本打「当前」徽标", () => {
    window.__heming_version = "d.3.0.3.0";
    render(<SettingsPage />);
    goTab("关于");
    const card = screen.getByRole("region", { name: "更新日志" });
    const current = card.querySelector("button[aria-label='更新日志 d.3.0.3.0']");
    expect(current?.textContent).toContain("当前");
  });
});
