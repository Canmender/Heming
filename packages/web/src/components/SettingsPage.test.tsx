import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SettingsPage, appVersionLabel } from "./SettingsPage.js";
import { useAuthStore } from "../store/auth.js";
import { useThemeStore } from "../store/theme.js";
import { DEFAULT_NAV_ORDER, useUiStore } from "../store/ui.js";
import { setToken } from "../lib/api.js";
import { resetSecureStorageState, secureGetItem, secureSetItem } from "../lib/secureStorage.js";

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
    // 文案与 d.36 一致：桌面端 Key 由系统安全存储加密保管，不再是「仅存浏览器」
    expect(screen.getByText(/桌面端经系统安全存储加密/)).toBeInTheDocument();
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

describe("设置区 密钥存储状态", () => {
  function stubSecrets(opts: { available?: boolean; failEncrypt?: boolean } = {}) {
    (window as unknown as { __heming_secrets?: unknown }).__heming_secrets = {
      available: opts.available !== false,
      encrypt: (plain: string) =>
        opts.failEncrypt ? null : `enc:${Buffer.from(plain, "utf8").toString("base64")}`,
      decrypt: (data: string) =>
        data.startsWith("enc:") ? Buffer.from(data.slice(4), "base64").toString("utf8") : null,
    };
  }

  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    delete (window as unknown as { __heming_secrets?: unknown }).__heming_secrets;
    resetSecureStorageState();
    setToken("t1");
    useAuthStore.setState({ token: "t1", user: { ...alice }, status: "authed", error: null });
  });

  afterEach(() => {
    delete window.__heming_secrets;
    resetSecureStorageState();
  });

  it("浏览器环境：如实说明不加密", () => {
    render(<SettingsPage />);
    goTab("模型");
    expect(screen.getByText(/浏览器端不落安全存储/)).toBeInTheDocument();
  });

  it("桌面桥可用：显示已加密与平台名", () => {
    stubSecrets();
    render(<SettingsPage />);
    goTab("模型");
    expect(screen.getByText(/密钥已用系统安全存储加密/)).toBeInTheDocument();
    // jsdom 没有 window.heming.platform → 默认分支「系统密钥环」
    expect(screen.getByText(/系统密钥环/)).toBeInTheDocument();
  });

  it("桌面桥在但加密失败：点名明文保存的键", () => {
    stubSecrets({ failEncrypt: true });
    secureSetItem("heming.llmConfigs", "{}");
    render(<SettingsPage />);
    goTab("模型");
    expect(screen.getByText(/以下密钥未能加密/)).toBeInTheDocument();
    expect(screen.getByText(/模型连接密钥/)).toBeInTheDocument();
  });

  it("系统安全存储不可用：说明新写入将明文，并点名已落明文的键", () => {
    stubSecrets({ available: false });
    secureSetItem("heming.mcp.servers.v1", "{}"); // 不可用 → 记入明文清单
    render(<SettingsPage />);
    goTab("模型");
    expect(screen.getByText(/本机安全存储不可用/)).toBeInTheDocument();
    expect(screen.getByText(/新写入的密钥将以明文保存/)).toBeInTheDocument();
    expect(screen.getByText(/MCP 服务请求头/)).toBeInTheDocument();
  });

  it("既有密文解不开时，与「新写入明文」的提示并存而不矛盾", () => {
    stubSecrets({ available: false });
    localStorage.setItem("heming.llmConfigs", JSON.stringify({ __hemingEnc: "v1", data: "x" }));
    secureSetItem("heming.mcp.servers.v1", "{}");
    // 模拟启动读取：真实应用启动时 store 初始化会读到这枚旧信封；
    // 本文件里 store 在 import 期已初始化（早于本用例写入），故在此显式触发同一条读取路径。
    secureGetItem("heming.llmConfigs");
    render(<SettingsPage />);
    goTab("模型");
    expect(screen.getByText(/新写入的密钥将以明文保存/)).toBeInTheDocument();
    expect(screen.getByText(/无法在本机解密/)).toBeInTheDocument();
    expect(screen.getByText(/模型连接密钥/)).toBeInTheDocument();
  });

  it("旧密文被备份后，卡片明确告知用户可以找回", () => {
    stubSecrets();
    (window as unknown as { __heming_secrets: { decrypt: () => null } }).__heming_secrets.decrypt = () => null;
    localStorage.setItem("heming.llmConfigs", JSON.stringify({ __hemingEnc: "v1", data: "x" }));
    secureGetItem("heming.llmConfigs"); // 标记解不开
    secureSetItem("heming.llmConfigs", "{}"); // 覆盖前备份
    render(<SettingsPage />);
    goTab("模型");
    expect(screen.getByText(/已在本机原样备份/)).toBeInTheDocument();
    expect(screen.getByText(/模型连接密钥/)).toBeInTheDocument();
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

  it("自定义颜色保存后输入框显示归一化后的新值，不回退旧值", () => {
    render(<SettingsPage />);
    goTab("外观");
    const input = screen.getByLabelText("自定义主题色") as HTMLInputElement;
    expect(input.value).toBe("#1a1a1a");

    fireEvent.change(input, { target: { value: "#abc" } });
    fireEvent.blur(input);

    // 受控输入：值跟随 store 归一化结果，而不是闭包里未更新的旧 accent
    expect(input.value).toBe("#aabbcc");
    expect(screen.getByText("已生效")).toBeInTheDocument();
  });

  it("恢复默认 → 回墨色、清掉 DOM 变量，并刷新输入框", () => {
    useThemeStore.getState().setAccent("#2f5bd7");
    render(<SettingsPage />);
    goTab("外观");
    const input = screen.getByLabelText("自定义主题色") as HTMLInputElement;
    expect(input.value).toBe("#2f5bd7");

    fireEvent.click(screen.getByRole("button", { name: "恢复默认颜色" }));
    expect(useThemeStore.getState().accent).toBe("#1a1a1a");
    expect(document.documentElement.style.getPropertyValue("--heming-accent")).toBe("");
    expect(input.value).toBe("#1a1a1a");
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
      "conversations",
      "infohub",
      "workspace",
      "skills",
      "tasks",
      "plugins",
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
