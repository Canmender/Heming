import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { SettingsPage, SETTINGS_HIGHLIGHT_MS, appVersionLabel } from "./SettingsPage.js";
import { useAuthStore } from "../store/auth.js";
import { useThemeStore } from "../store/theme.js";
import { DEFAULT_NAV_ORDER, useUiStore } from "../store/ui.js";
import { setToken } from "../lib/api.js";
import { CHANGELOG } from "../generated/changelog.js";
import { RELEASE_NOTES } from "../generated/releaseNotes.js";
import { getThemeMode, setThemeMode } from "../lib/theme.js";
import { resetSecureStorageState, secureGetItem, secureSetItem } from "../lib/secureStorage.js";

declare const __APP_VERSION__: string;

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

    // 读屏要能立刻播报：错误必须是 alert，而不是一段静态红字
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
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

  it("「模型」分组挂 magpie 网关卡（原生组件）与上下文预算卡", () => {
    render(<SettingsPage />);
    // 设置区已标签化：默认停在「个人资料」，切到「模型」才渲染这两张卡
    expect(screen.queryByRole("region", { name: "模型" })).not.toBeInTheDocument();
    goTab("模型");
    expect(screen.getByRole("region", { name: "模型" })).toBeInTheDocument();
    expect(screen.getByLabelText("magpie 网关地址")).toHaveValue("http://127.0.0.1:3425/v1");
    expect(screen.getByLabelText("magpie 网关 Key")).toHaveValue("magpie-heming");
    expect(screen.getByText(/由本机 magpie 网关提供/)).toBeInTheDocument();
    expect(screen.getByText("上下文预算")).toBeInTheDocument();
    // 切回「个人资料」后模型卡卸载（一次只渲染当前分组）
    goTab("个人资料");
    expect(screen.queryByRole("region", { name: "模型" })).not.toBeInTheDocument();
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
    expect(screen.getByText(/密钥与本地数据已用系统安全存储加密/)).toBeInTheDocument();
    // jsdom 没有 window.heming.platform → 默认分支「系统密钥环」
    expect(screen.getByText(/系统密钥环/)).toBeInTheDocument();
  });

  it("桌面桥在但加密失败：点名明文保存的键", () => {
    stubSecrets({ failEncrypt: true });
    secureSetItem("heming.llmConfigs", "{}");
    render(<SettingsPage />);
    goTab("模型");
    expect(screen.getByText(/以下内容未能加密/)).toBeInTheDocument();
    expect(screen.getByText(/旧模型连接/)).toBeInTheDocument();
  });

  it("系统安全存储不可用：说明新写入将明文，并点名已落明文的键", () => {
    stubSecrets({ available: false });
    secureSetItem("heming.mcp.servers.v1", "{}"); // 不可用 → 记入明文清单
    render(<SettingsPage />);
    goTab("模型");
    expect(screen.getByText(/本机安全存储不可用/)).toBeInTheDocument();
    expect(screen.getByText(/新写入的密钥与本地数据将以明文保存/)).toBeInTheDocument();
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
    expect(screen.getByText(/新写入的密钥与本地数据将以明文保存/)).toBeInTheDocument();
    expect(screen.getByText(/无法在本机解密/)).toBeInTheDocument();
    expect(screen.getByText(/旧模型连接/)).toBeInTheDocument();
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
    expect(screen.getByText(/旧模型连接/)).toBeInTheDocument();
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

  it("拿不到注入版本时回落到构建版本（浏览器/网页端也显示真实版本号，而不是「桌面版」）", () => {
    // 云端网页与桌面端共用同一份前端产物；浏览器里显示构建版本便于报障对照。
    // 断言与 __APP_VERSION__ 相等而不是写死版本串——每轮 bump 后这个用例仍然成立。
    expect(appVersionLabel()).toBe(__APP_VERSION__);
    window.__heming_version = "   ";
    expect(appVersionLabel()).toBe(__APP_VERSION__);
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
    fireEvent.click(screen.getByRole("button", { name: "上移 插件区" }));
    expect(useUiStore.getState().navOrder).toEqual([
      "home",
      "chat",
      "team",
      "staff",
      "infohub",
      "automations",
      "modelroute",
      "plugins",
      "model",
      "memory",
      "settings",
    ]);
    expect(JSON.parse(localStorage.getItem("heming.navOrder.v1") as string)).toEqual(
      useUiStore.getState().navOrder,
    );
    expect(screen.getByRole("button", { name: "上移 主页" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "下移 设置区" })).toBeDisabled();
  });

  it("恢复默认导航顺序", () => {
    useUiStore.getState().setNavOrder(["settings", "memory", "home", "team", "plugins"]);
    render(<SettingsPage />);
    goTab("导航");
    fireEvent.click(screen.getByRole("button", { name: "恢复默认导航顺序" }));
    expect(useUiStore.getState().navOrder).toEqual([...DEFAULT_NAV_ORDER]);
  });
});

describe("设置区 · 模型（magpie 原生组件）", () => {
  it("不再有服务商预设与手填供应商 Key；只配网关地址与网关 Key", () => {
    render(<SettingsPage />);
    goTab("模型");
    expect(screen.queryByRole("button", { name: /套用预设/ })).toBeNull();
    expect(screen.queryByLabelText("服务商")).toBeNull();
    expect(screen.queryByLabelText("API Key")).toBeNull();
    expect(screen.getByRole("button", { name: "读取模型" })).toBeInTheDocument();
    expect(screen.getByText(/订阅账号、API Key、多账号轮换与额度选路都在 magpie 里管理/)).toBeInTheDocument();
  });

  it("网关地址可改并「仅保存」落盘（不联网）", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    render(<SettingsPage />);
    goTab("模型");
    fireEvent.change(screen.getByLabelText("magpie 网关地址"), {
      target: { value: "http://127.0.0.1:3999/v1/" },
    });
    fireEvent.click(screen.getByRole("button", { name: "仅保存" }));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem("heming.magpie.v1")!)).toEqual({
      baseUrl: "http://127.0.0.1:3999/v1",
      key: "magpie-heming",
      source: "manual",
    });
    vi.unstubAllGlobals();
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

  it("默认只列最近 20 条并可展开更早；版本对不上时不认「当前」，全部收起", () => {
    window.__heming_version = "d.0.0.9.9";
    render(<SettingsPage />);
    goTab("关于");
    expect(screen.getByRole("region", { name: "更新日志" })).toBeInTheDocument();
    // 111 条平铺是一面墙（审计 P1-4）：默认只渲染最近 20 条
    expect(screen.getAllByRole("button", { name: /^更新日志 d\./ })).toHaveLength(20);
    for (const b of screen.getAllByRole("button", { name: /^更新日志 d\./ })) {
      expect(b).toHaveAttribute("aria-expanded", "false");
    }
    // 更早的版本在「显示更早的 N 个版本」之后才出现（数据本身在 lib/changelog.test.ts 校验）
    fireEvent.click(
      screen.getByRole("button", { name: new RegExp(`^显示更早的 ${CHANGELOG.length - 20} 个版本$`) }),
    );
    expect(screen.getByRole("button", { name: "更新日志 d.3.0.3.0" })).toBeInTheDocument();
  });

  it("点条目展开/收起：展开显示用户版发布说明，不展示工程细节", () => {
    // 最新一条必须有用户版说明（docs/RELEASE-NOTES.md 与 CHANGELOG 同版本维护）
    const latestNotes = RELEASE_NOTES.find((n) => n.version === CHANGELOG[0].version);
    expect(latestNotes).toBeTruthy();
    window.__heming_version = CHANGELOG[0].version;
    render(<SettingsPage />);
    goTab("关于");
    const btn = screen.getByRole("button", { name: `更新日志 ${CHANGELOG[0].version}` });
    // 当前版本默认展开
    expect(btn).toHaveAttribute("aria-expanded", "true");
    // 用户版说明的要点可见；工程细节（如测试统计/文件名）不出现
    const card = screen.getByRole("region", { name: "更新日志" });
    expect(card).toHaveTextContent(latestNotes!.bullets[0]);
    expect(card).not.toHaveTextContent(/web \d+ 文件/);

    fireEvent.click(btn);
    expect(btn).toHaveAttribute("aria-expanded", "false");
  });

  it("没有用户版说明的版本：展开只给「工程记录见 CHANGELOG.md」，不端出根因", () => {
    // 找一个未收录进 RELEASE-NOTES 的版本（历史版本）
    const missing = CHANGELOG.find((e) => !RELEASE_NOTES.some((n) => n.version === e.version));
    expect(missing).toBeTruthy();
    // 当前版本用最新一条（默认展开的是它），missing 版本保持收起，点开看展开内容
    window.__heming_version = CHANGELOG[0].version;
    render(<SettingsPage />);
    goTab("关于");
    // 默认只列最近 20 条，先把完整的日志展开
    fireEvent.click(
      screen.getByRole("button", { name: new RegExp(`^显示更早的 ${CHANGELOG.length - 20} 个版本$`) }),
    );
    const btn = screen.getByRole("button", { name: `更新日志 ${missing!.version}` });
    // 历史版本默认收起，点开看展开内容
    fireEvent.click(btn);
    const card = screen.getByRole("region", { name: "更新日志" });
    expect(card).toHaveTextContent("这一版还没有用户版说明");
  });

  it("给当前版本打「当前」徽标", () => {
    window.__heming_version = CHANGELOG[0].version;
    render(<SettingsPage />);
    goTab("关于");
    const card = screen.getByRole("region", { name: "更新日志" });
    const current = card.querySelector(`button[aria-label='更新日志 ${CHANGELOG[0].version}']`);
    expect(current?.textContent).toContain("当前");
  });
});

/** 挂 scrollIntoView stubs 并清掉（jsdom 原生没有该方法）。 */
function stubScrollIntoView(): ReturnType<typeof vi.fn> {
  const spy = vi.fn();
  (Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = spy;
  return spy;
}

describe("设置区 · 卡片搜索与定位（UX-E）", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    useThemeStore.setState({ accent: "#1a1a1a" });
    document.documentElement.removeAttribute("style");
    setToken("t1");
    useAuthStore.setState({ token: "t1", user: { ...alice }, status: "authed", error: null });
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it("空查询回到普通分区视图（搜索框常驻，不显示结果面板）", () => {
    render(<SettingsPage />);
    expect(screen.getByLabelText("搜索设置项")).toHaveValue("");
    expect(screen.queryByRole("region", { name: "设置搜索结果" })).toBeNull();
    // 普通视图仍在：个人资料卡
    expect(screen.getByLabelText("昵称")).toBeInTheDocument();
  });

  it("关键词跨分区命中：结果面板列出「卡片标题 · 分区」", () => {
    render(<SettingsPage />);
    fireEvent.change(screen.getByLabelText("搜索设置项"), { target: { value: "主题色" } });

    const panel = screen.getByRole("region", { name: "设置搜索结果" });
    expect(panel).toHaveTextContent("主题色");
    expect(panel).toHaveTextContent("· 外观");
    // 普通分区视图让位给结果面板
    expect(screen.queryByLabelText("昵称")).toBeNull();
  });

  it("输入后直接回车打开第一项（不用把鼠标挪到结果上）", () => {
    render(<SettingsPage />);
    const input = screen.getByLabelText("搜索设置项");
    fireEvent.change(input, { target: { value: "桌宠" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.getByRole("tab", { name: "外观" })).toHaveAttribute("aria-selected", "true");
    expect(input).toHaveValue("");
    expect(document.querySelector('[data-settings-id="widgets"]')).not.toBeNull();
  });

  it("点结果：切到对应分区、滚动到卡片、高亮 2 秒后消失", async () => {
    const scrollSpy = stubScrollIntoView();
    render(<SettingsPage />);

    // 用假 setTimeout 只为验证 2 秒淡出；rAF 保持真实（高亮在下一帧挂上）
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.change(screen.getByLabelText("搜索设置项"), { target: { value: "桌宠" } });
    fireEvent.click(screen.getByRole("button", { name: /桌面小组件/ }));

    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });

    // 切到「外观」分区且锚点存在、带 ink 描边高亮
    expect(screen.getByRole("tab", { name: "外观" })).toHaveAttribute("aria-selected", "true");
    const anchor = document.querySelector<HTMLElement>('[data-settings-id="widgets"]')!;
    expect(anchor).not.toBeNull();
    expect(anchor.className).toContain("outline-ink");
    expect(scrollSpy).toHaveBeenCalled();
    // 查询已清空（回到普通视图）
    expect(screen.getByLabelText("搜索设置项")).toHaveValue("");

    // 2 秒后自动消失
    act(() => {
      vi.advanceTimersByTime(SETTINGS_HIGHLIGHT_MS + 50);
    });
    expect(
      document.querySelector<HTMLElement>('[data-settings-id="widgets"]')!.className,
    ).not.toContain("outline-ink");
  });

  it("Esc：关闭结果面板并清空输入，回到普通分区视图", () => {
    render(<SettingsPage />);
    const input = screen.getByLabelText("搜索设置项");
    fireEvent.change(input, { target: { value: "更新" } });
    expect(screen.getByRole("region", { name: "设置搜索结果" })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(input).toHaveValue("");
    expect(screen.queryByRole("region", { name: "设置搜索结果" })).toBeNull();
    expect(screen.getByLabelText("昵称")).toBeInTheDocument();
  });

  it("没有匹配时给可行动的提示（不静默空白）", () => {
    render(<SettingsPage />);
    fireEvent.change(screen.getByLabelText("搜索设置项"), { target: { value: "zzz不存在" } });
    expect(screen.getByRole("region", { name: "设置搜索结果" })).toHaveTextContent(
      "没有匹配的设置项",
    );
  });

  it("点结果后再次输入会重新打开面板（状态不残留）", () => {
    stubScrollIntoView();
    render(<SettingsPage />);
    const input = screen.getByLabelText("搜索设置项");
    fireEvent.change(input, { target: { value: "桌宠" } });
    fireEvent.click(screen.getByRole("button", { name: /桌面小组件/ }));
    expect(screen.queryByRole("region", { name: "设置搜索结果" })).toBeNull();

    fireEvent.change(input, { target: { value: "导航" } });
    expect(screen.getByRole("region", { name: "设置搜索结果" })).toHaveTextContent("导航顺序");
  });
});

/**
 * d.68 外观页新增「导航栏」卡：
 * - 顺序 主题模式 → 主题色 → 导航栏 → 桌面小组件（d.94 起原桌宠卡改成通用小组件卡）；
 * - 两档 radio 与导航轨底部 pin 按钮同源（useUiStore.navMode）；
 * - 「恢复默认外观」二次确认后一次改三处（主题模式/主题色/导航模式）。
 */
describe("设置区 · 导航栏与恢复默认外观（d.68）", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("style");
    document.documentElement.removeAttribute("data-theme");
    useThemeStore.setState({ accent: "#1a1a1a" });
    useUiStore.setState({ navMode: "pinned", navOpen: false });
    setThemeMode("system");
  });

  it("外观页顺序：主题模式 → 主题色 → 导航栏 → 桌面小组件", () => {
    const { container } = render(<SettingsPage />);
    goTab("外观");
    const ids = Array.from(container.querySelectorAll<HTMLElement>("[data-settings-id]")).map(
      (el) => el.dataset.settingsId,
    );
    expect(ids).toEqual(["theme-mode", "accent-color", "nav-mode", "widgets"]);
    // 卡片标题与锚点都在
    expect(screen.getByText("导航栏")).toBeInTheDocument();
    expect(container.querySelector('[data-settings-id="nav-mode"]')).not.toBeNull();
  });

  it("导航栏卡：默认选中「固定常显」；点「自动隐藏」写 store 并落盘", () => {
    render(<SettingsPage />);
    goTab("外观");

    const pinned = screen.getByRole("radio", { name: "导航栏 固定常显" });
    expect(pinned).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "导航栏 自动隐藏" })).toHaveAttribute(
      "aria-checked",
      "false",
    );

    fireEvent.click(screen.getByRole("radio", { name: "导航栏 自动隐藏" }));
    expect(useUiStore.getState().navMode).toBe("auto");
    expect(localStorage.getItem("heming.nav.mode.v1")).toBe("auto");
    expect(screen.getByRole("radio", { name: "导航栏 自动隐藏" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    // 自动隐藏说明里写清呼出方式（用户不需要再猜）
    expect(screen.getByText(/左缘或按 Ctrl\+B 呼出/)).toBeInTheDocument();
  });

  it("「恢复默认」（卡内）把导航栏改回常显，不影响主题色", () => {
    useThemeStore.getState().setAccent("#2f5bd7");
    useUiStore.setState({ navMode: "auto" });
    render(<SettingsPage />);
    goTab("外观");

    fireEvent.click(screen.getByRole("button", { name: "恢复默认导航栏模式" }));
    expect(useUiStore.getState().navMode).toBe("pinned");
    expect(useThemeStore.getState().accent).toBe("#2f5bd7");
  });

  it("「恢复默认外观」二次确认：取消不动，确认后主题模式/主题色/导航一起复位", () => {
    useThemeStore.getState().setAccent("#2f5bd7");
    useUiStore.setState({ navMode: "auto" });
    setThemeMode("dark");

    render(<SettingsPage />);
    goTab("外观");

    // 取消：什么都不改
    fireEvent.click(screen.getByRole("button", { name: "恢复默认外观" }));
    const dialog = screen.getByRole("dialog", { name: "恢复默认外观" });
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(useThemeStore.getState().accent).toBe("#2f5bd7");
    expect(useUiStore.getState().navMode).toBe("auto");
    expect(getThemeMode()).toBe("dark");

    // 确认：三处一起复位
    fireEvent.click(screen.getByRole("button", { name: "恢复默认外观" }));
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "恢复默认外观" })).getByRole("button", {
        name: "恢复默认",
      }),
    );
    expect(useThemeStore.getState().accent).toBe("#1a1a1a");
    expect(useUiStore.getState().navMode).toBe("pinned");
    expect(getThemeMode()).toBe("system");
    // 主题模式卡跟着重置（key 重挂载后选中项回到「跟随系统」）
    expect(screen.getByRole("radio", { name: "主题模式 跟随系统" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });
});

/** d.62-B 布局迁移守卫：页头走 PageShell、内容列收口并居中（d.73 起 760）。 */
describe("设置区布局（d.62-B）", () => {
  it("页头由 PageShell 提供（唯一 h1 + 副标题），内容列 760 居中", () => {
    render(<SettingsPage />);
    const headings = screen.getAllByRole("heading", { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveClass("ui-page-title");
    expect(headings[0]).toHaveTextContent("设置区");
    expect(document.querySelector(".ui-page-sub")?.textContent).toContain("不用重启");
    // 内容列 760 且水平居中：宽屏下不再贴左留出半屏空白
    const column = document.querySelector('[class*="max-w-[760px]"]');
    expect(column).not.toBeNull();
    expect(column?.className).toContain("mx-auto");
  });
});
