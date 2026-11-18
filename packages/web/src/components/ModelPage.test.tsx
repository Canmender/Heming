import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ModelPage } from "./ModelPage.js";
import { useLlmStore, DEFAULT_GATEWAY, type LlmProfile } from "../store/llm.js";
import { DOMESTIC_AGENTS } from "../lib/magpieDomestic.js";

/**
 * 模型页（d.103）：加来源 → 看模型，五个分区。
 *
 * 页面只负责「把该调的调对、把结果说清楚」；来源/账号/路由的语义由模型服务负责，
 * 不在前端重复验证。
 */

type CliCall = string[];
function installBridge(
  overrides: Record<string, unknown> = {},
  replies: Record<string, { ok: boolean; stdout: string; stderr: string }> = {},
) {
  const calls: CliCall[] = [];
  const listeners: ((event: Record<string, unknown>) => void)[] = [];
  const cli = vi.fn(async (args: string[]) => {
    calls.push(args);
    const reply = replies[args.join(" ")];
    if (reply) return reply;
    // `settings get` 打的是 JSON：没设置过的键回 `""`，别让它变成 "ok"。
    if (args[0] === "settings" && args[1] === "get") {
      return { ok: true, stdout: '""', stderr: "" };
    }
    if (args[0] === "providers") {
      return {
        ok: true,
        stdout: "  mock custom  mock  127.0.0.1:39001  ● •••••••  1 models  ",
        stderr: "",
      };
    }
    if (args[0] === "ls") {
      return {
        ok: true,
        stdout:
          "  Claude Code       —  ·  effort —                         ~/.claude/settings.json\n" +
          "  Codex             space-bunny  ·  effort high            ~/.codex/config.toml\n",
        stderr: "",
      };
    }
    if (args[0] === "accounts") {
      return {
        ok: true,
        // 与内核 `accounts --json` 的真实字段一致：额度在 windows 里，没有 allowance
        stdout: JSON.stringify([
          {
            agent: "claude",
            user: "work@example.com",
            alias: "工作号",
            plan: "Max",
            active: true,
            on: true,
            windows: [{ name: "5 hours", used: 82, remaining: 18, display: "82% used" }],
            readAt: new Date().toISOString(),
          },
        ]),
        stderr: "",
      };
    }
    return { ok: true, stdout: "ok", stderr: "" };
  });
  const bridge = {
    status: vi.fn(async () => ({ available: true, running: true, version: "test", port: 3425 })),
    start: vi.fn(),
    stop: vi.fn(),
    gateway: vi.fn(),
    cli,
    cliStart: vi.fn(async (args: string[]) => {
      calls.push(args);
      return { ok: true };
    }),
    cliBegin: vi.fn(async (args: string[]) => {
      calls.push(args);
      return { ok: true, runId: "cli-1" };
    }),
    backupInfo: vi.fn(async () => ({
      dir: "D:/backups",
      files: [
        { name: "model-20261108.backup", path: "D:/backups/model-20261108.backup", size: 2048, mtime: Date.now() },
      ],
    })),
    backupPick: vi.fn(async () => null),
    cliInput: vi.fn(async () => true),
    cliKill: vi.fn(async () => true),
    openTerminal: vi.fn(async () => ({ ok: true })),
    onCli: vi.fn((callback: (event: Record<string, unknown>) => void) => {
      listeners.push(callback);
      return () => {};
    }),
    ...overrides,
  };
  (window as unknown as { __heming_magpie?: unknown }).__heming_magpie = bridge;
  const emit = (event: Record<string, unknown>) => listeners.forEach((fn) => fn(event));
  return { bridge, calls, emit };
}

const profile = (model: string): LlmProfile => ({
  id: model,
  label: model,
  provider: "openai",
  baseUrl: DEFAULT_GATEWAY.baseUrl,
  apiKey: DEFAULT_GATEWAY.key,
  model,
});

beforeEach(() => {
  localStorage.clear();
  useLlmStore.setState({
    gateway: { ...DEFAULT_GATEWAY, source: "desktop" },
    models: [],
    profiles: [profile("deepseek/deepseek-chat"), profile("openai/gpt-4o")],
    bindings: {},
    prompts: {},
    routes: [],
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      if (String(input).endsWith("/api/hello")) {
        return new Response(JSON.stringify({ name: "gateway", version: "1" }), { status: 200 });
      }
      // 画图模型要单独问 ?kind=image：默认没有，测试里需要时再覆盖 fetch。
      if (String(input).includes("kind=image")) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ data: [{ id: "deepseek/deepseek-chat" }, { id: "openai/gpt-4o" }] }),
        { status: 200 },
      );
    }),
  );
});

afterEach(() => {
  delete (window as unknown as { __heming_magpie?: unknown }).__heming_magpie;
  vi.unstubAllGlobals();
});

describe("ModelPage · 结构与主路径", () => {
  it("五个分区；默认显示可用模型与统计，不出现服务启停或第三方名称", async () => {
    installBridge();
    render(<ModelPage />);
    expect(screen.getByRole("heading", { name: "模型" })).toBeInTheDocument();
    for (const label of ["模型", "智能体", "来源", "运行"]) {
      expect(screen.getByRole("tab", { name: label })).toBeInTheDocument();
    }
    expect(await screen.findByText("deepseek/deepseek-chat")).toBeInTheDocument();
    expect(screen.getByText("openai/gpt-4o")).toBeInTheDocument();
    // 内置能力：不提供启停/地址/第三方品牌（magpie 是内置内核的名字，正文里可以出现）
    expect(screen.queryByRole("button", { name: /启动|停止|重启/ })).toBeNull();
    expect(screen.queryByText(/magpie-core/i)).toBeNull();
    expect(screen.queryByText(/网关地址/)).toBeNull();
  });

  it("搜索只留下匹配的模型", async () => {
    installBridge();
    render(<ModelPage />);
    const search = await screen.findByLabelText("搜索模型");
    fireEvent.change(search, { target: { value: "gpt" } });
    expect(screen.getByText("openai/gpt-4o")).toBeInTheDocument();
    expect(screen.queryByText("deepseek/deepseek-chat")).toBeNull();
  });

  it("视觉规范：Tab 统一带图标；折叠区用统一 Chevron（不再是浏览器原生三角）", async () => {
    installBridge();
    render(<ModelPage />);
    for (const label of ["模型", "智能体", "来源", "运行"]) {
      const tab = screen.getByRole("tab", { name: label });
      expect(tab.querySelector("svg"), `${label} tab 缺图标`).not.toBeNull();
    }
    // 折叠区的翻页箭头走 icons.tsx 的 ChevronIcon（带统一类名），CSS 负责展开旋转
    const summary = (await screen.findByText(/已禁用的模型/)).closest("summary");
    expect(summary?.querySelector("svg.ui-disclosure-chevron")).not.toBeNull();
    // 统计卡走统一卡片基元（阴影/圆角由 token 提供，不再各写 bg-surface + 任意 shadow）
    expect(screen.getAllByText("可用模型").some((el) => el.closest(".ui-card") !== null)).toBe(true);
  });

  it("视觉规范：分区切换走全站标准页签（下划线式），不再是贴左缘的药丸分段控件", () => {
    installBridge();
    const { container } = render(<ModelPage />);
    // 页签栏与设置页 / 插件页 / 记忆页 / 团队页共用 PAGE_TABLIST（role=tablist 也在同一处）
    const tablist = screen.getByRole("tablist", { name: "模型页分区" });
    expect(tablist.className).not.toContain("ui-segment-group");
    for (const label of ["模型", "智能体", "来源", "运行"]) {
      const tab = screen.getByRole("tab", { name: label });
      // pageTabClass 的下划线特征：-mb-px 让选中项的 2px 下划线压住内容区分隔线
      expect(tab.className, `${label} 页签缺标准页签下划线样式`).toContain("-mb-px");
      expect(tab.className, `${label} 页签缺标准页签下划线样式`).toContain("border-b-2");
      // 图标是既定设计（d.125），换样式不丢
      expect(tab.querySelector("svg"), `${label} 页签缺图标`).not.toBeNull();
    }
    // 一级切换栏不再使用药丸式分段控件（页内的二级筛选不在此断言内）
    expect(container.querySelector(".ui-segment-group")).toBeNull();
  });

  it("页签行落在页头正下方（PageShell.tabs 槽），与插件/团队页同一位置", () => {
    installBridge();
    render(<ModelPage />);
    const tablist = screen.getByRole("tablist", { name: "模型页分区" });
    const row = tablist.parentElement as HTMLElement;
    // PageShell 统一给的通栏行：与页头同左右内边距；页签的 -mb-px 压住本行底边
    expect(row.className).toContain("border-line-soft");
    expect(row.className).toContain("px-6");
    expect(row.className).toContain("max-[1199px]:px-4");
    // 内容面板与页签配对（同一套 tabpanel 契约，三页一致）
    const panel = screen.getByRole("tabpanel");
    const selected = screen.getByRole("tab", { name: "模型" });
    expect(selected).toHaveAttribute("aria-controls", panel.id);
    expect(panel).toHaveAttribute("aria-labelledby", selected.id);
  });

  it("浏览器没有命令桥：提示只能在桌面端添加，但仍可看模型", () => {
    render(<ModelPage />);
    expect(screen.getByRole("status")).toHaveTextContent(/请打开和鸣桌面端/);
    expect(screen.getByText("deepseek/deepseek-chat")).toBeInTheDocument();
  });
});

describe("ModelPage · 添加来源", () => {
  it("点服务商卡片只填一个 Key 就能保存，留在来源页并给出成功提示", async () => {
    const { calls } = installBridge();
    render(<ModelPage />);
    fireEvent.click(screen.getByRole("tab", { name: "来源" }));
    fireEvent.click(screen.getByRole("button", { name: /DeepSeek/ }));
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "sk-x" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(calls).toContainEqual(["provider", "add", "deepseek", "sk-x"]));
    // 用户还要接着加别的来源，所以不跳页，只在顶部说一句
    await waitFor(() => expect(screen.getByText(/已添加 DeepSeek/)).toBeInTheDocument());
    expect(screen.getByRole("tab", { name: "来源" })).toHaveAttribute("aria-selected", "true");
  });

  it("普通地址不传 region；选 Coding Plan 才传 region=coding 并给出提示条", async () => {
    const { calls } = installBridge();
    render(<ModelPage />);
    fireEvent.click(screen.getByRole("tab", { name: "来源" }));
    fireEvent.click(screen.getByRole("button", { name: /智谱 GLM/ }));
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "sk-glm" } });

    // 默认普通地址：没有地址类型提示条
    expect(screen.queryByText(/只接受 Coding Plan 的 Key/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Coding Plan" }));
    expect(screen.getByText(/只接受 Coding Plan 的 Key/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(calls).toContainEqual([
        "provider",
        "add",
        "zhipu",
        "sk-glm",
        "region=coding",
      ]),
    );
  });

  it("miniMax 的 Coding Plan 与普通地址同一个：不传 region", async () => {
    const { calls } = installBridge();
    render(<ModelPage />);
    fireEvent.click(screen.getByRole("tab", { name: "来源" }));
    fireEvent.click(screen.getByRole("button", { name: /MiniMax/ }));
    fireEvent.click(screen.getByRole("button", { name: "Coding Plan Key" }));
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "sk-cp-1" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(calls).toContainEqual(["provider", "add", "minimax", "sk-cp-1"]),
    );
  });

  it("订阅卡片走登录窗口", async () => {
    const { bridge } = installBridge();
    render(<ModelPage />);
    fireEvent.click(screen.getByRole("tab", { name: "来源" }));
    fireEvent.click(screen.getByRole("button", { name: /Claude/ }));
    await waitFor(() =>
      expect(bridge.openTerminal).toHaveBeenCalledWith(["accounts", "add", "claude"]),
    );
  });

  it("已添加来源可删除：先确认再执行（不可恢复）", async () => {
    const { calls } = installBridge();
    render(<ModelPage />);
    fireEvent.click(screen.getByRole("tab", { name: "来源" }));
    expect(await screen.findByText("mock")).toBeInTheDocument();
    // 审计 F4：行内删除不再是「点一下就删」的 danger 按钮，先出确认框。
    fireEvent.click(screen.getByRole("button", { name: "删除来源 mock" }));
    expect(calls).not.toContainEqual(["provider", "rm", "mock"]);
    const dialog = screen.getByRole("dialog", { name: "删除来源？" });
    expect(dialog.textContent).toContain("不可恢复");
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    await waitFor(() => expect(calls).toContainEqual(["provider", "rm", "mock"]));
  });

  it("展开高级时读详细地址：Coding Plan 来源显示套餐徽标", async () => {
    installBridge(
      {},
      {
        "provider show mock": {
          ok: true,
          stdout: "  chat       https://open.bigmodel.cn/api/coding/paas/v4\n",
          stderr: "",
        },
      },
    );
    render(<ModelPage />);
    fireEvent.click(screen.getByRole("tab", { name: "来源" }));
    expect(await screen.findByText("mock")).toBeInTheDocument();
    // 没读地址之前按普通地址展示
    expect(screen.getByText("普通地址")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "高级" }));
    await waitFor(() => expect(screen.getByText("Coding Plan")).toBeInTheDocument());
  });
});

describe("ModelPage · 账号与更多", () => {
  it("来源页按内核字段展示账号：计划、状态与窗口额度", async () => {
    installBridge();
    render(<ModelPage />);
    fireEvent.click(screen.getByRole("tab", { name: "来源" }));
    expect(await screen.findByText("工作号")).toBeInTheDocument();
    // 计划徽标 + 状态徽标（active && on = 在用）
    expect(screen.getByText("Max")).toBeInTheDocument();
    expect(screen.getByText("在用")).toBeInTheDocument();
    // 窗口名中文化，结论按剩余百分比；厂商原话留在右侧小字里
    expect(screen.getByText("5 小时")).toBeInTheDocument();
    expect(screen.getByText("剩 18%")).toBeInTheDocument();
    expect(screen.getByText("82% used")).toBeInTheDocument();
  });

  it("来源页列出国内智能体：没装插件就先装，再登录", async () => {
    const { bridge, calls } = installBridge();
    render(<ModelPage />);
    fireEvent.click(screen.getByRole("tab", { name: "来源" }));
    expect(await screen.findByText("国内智能体")).toBeInTheDocument();
    expect(screen.getByText("WorkBuddy")).toBeInTheDocument();
    expect(screen.getByText("Qoder CN")).toBeInTheDocument();
    // 没有插件在服务这些端：卡片说「先装插件」，不给一个走不通的「登录」
    expect(screen.getAllByText("先装插件").length).toBe(DOMESTIC_AGENTS.length);

    fireEvent.click(screen.getByText("WorkBuddy"));
    await waitFor(() =>
      expect(calls).toContainEqual(["plugin", "add", "@magpie-community/opencode-workbuddy-auth"]),
    );
    await waitFor(() =>
      expect(bridge.openTerminal).toHaveBeenCalledWith(["accounts", "add", "workbuddy"]),
    );
    expect(await screen.findByText(/已装上 WorkBuddy 的插件/)).toBeInTheDocument();
  });

  it("插件已经装过时，点国内端直接登录，不再装一遍", async () => {
    const { bridge, calls } = installBridge({}, {
      "plugin list --json": {
        ok: true,
        stdout: JSON.stringify({ plugins: [], loaded: [], providers: [{ id: "qoder" }], middleware: [] }),
        stderr: "",
      },
    });
    render(<ModelPage />);
    fireEvent.click(screen.getByRole("tab", { name: "来源" }));
    fireEvent.click(await screen.findByText("Qoder"));
    await waitFor(() => expect(bridge.openTerminal).toHaveBeenCalledWith(["accounts", "add", "qoder"]));
    expect(calls).not.toContainEqual(["plugin", "add", "@magpie-community/opencode-qoder-auth"]);
  });

  it("今日签到：走 accounts checkin，把领到多少写进提示条", async () => {
    const { calls } = installBridge({}, {
      "accounts checkin --json": {
        ok: true,
        stdout: JSON.stringify([
          { user: "a@example.com", by: "", outcome: "claimed", credit: 100, streak: 3 },
        ]),
        stderr: "",
      },
    });
    render(<ModelPage />);
    fireEvent.click(screen.getByRole("tab", { name: "来源" }));
    fireEvent.click(await screen.findByRole("button", { name: "今日签到" }));
    await waitFor(() => expect(calls).toContainEqual(["accounts", "checkin", "--json"]));
    expect(await screen.findByText(/已签到 \+100 · 连续 3 天/)).toBeInTheDocument();
  });

  it("签到失败用告警色，不冒充完成", async () => {
    installBridge({}, {
      "accounts checkin --json": {
        ok: true,
        stdout: JSON.stringify([{ by: "plugin:qoder", outcome: "failed", msg: "timeout" }]),
        stderr: "",
      },
    });
    render(<ModelPage />);
    fireEvent.click(screen.getByRole("tab", { name: "来源" }));
    fireEvent.click(await screen.findByRole("button", { name: "今日签到" }));
    const notice = await screen.findByRole("status");
    expect(notice).toHaveTextContent(/签到失败：timeout/);
    expect(notice).toHaveClass("ui-alert-danger");
  });

  it("高级命令在「运行」里：流式输出写进面板", async () => {
    const { bridge, calls, emit } = installBridge();
    render(<ModelPage />);
    fireEvent.click(screen.getByRole("tab", { name: "运行" }));
    fireEvent.click(screen.getByText("高级命令"));
    fireEvent.change(screen.getByLabelText("命令"), { target: { value: "providers" } });
    fireEvent.click(screen.getByRole("button", { name: "运行" }));
    await waitFor(() => expect(bridge.cliStart).toHaveBeenCalledWith(["providers"]));
    emit({ runId: "cli-1", type: "start", args: ["providers"] });
    emit({ runId: "cli-1", type: "stdout", text: "line one\n" });
    await waitFor(() => expect(screen.getByLabelText("命令输出")).toHaveTextContent("line one"));
    expect(calls).toContainEqual(["providers"]);
  });
});

describe("ModelPage · 高级表单（来源 / 分组规则 / 模型目录）", () => {
  it("来源高级：更新 Key 与保存设置都走对应命令", async () => {
    const { calls } = installBridge();
    render(<ModelPage />);
    fireEvent.click(screen.getByRole("tab", { name: "来源" }));
    await screen.findByText("mock");
    fireEvent.click(screen.getByRole("button", { name: "高级" }));
    fireEvent.change(screen.getByLabelText("更新 Key"), { target: { value: "sk-new" } });
    fireEvent.click(screen.getByRole("button", { name: "更新 Key" }));
    await waitFor(() => expect(calls).toContainEqual(["provider", "key", "mock", "sk-new"]));

    fireEvent.change(screen.getByLabelText("来源分发策略"), { target: { value: "rotate" } });
    fireEvent.change(screen.getByLabelText("错误处理"), { target: { value: "pass" } });
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    await waitFor(() =>
      expect(calls).toContainEqual(["provider", "set", "mock", "routing=rotate", "errors=pass"]),
    );
  });

  it("来源模型清单：显示这个来源暴露的模型，增删与整套切换都走 provider models", async () => {
    const { calls } = installBridge(
      {},
      {
        "provider show mock": {
          ok: true,
          stdout:
            "  chat       https://api.mock.test/v1\n" +
            "  models     2 exposed of 2 from api.mock.test · fetched Nov 13\n" +
            "             mock/mock-model  Mock 一号\n" +
            "             mock/mock-mini   Mock Mini\n",
          stderr: "",
        },
      },
    );
    render(<ModelPage />);
    fireEvent.click(screen.getByRole("tab", { name: "来源" }));
    await screen.findByText("mock");
    fireEvent.click(screen.getByRole("button", { name: "高级" }));

    expect(await screen.findByText("Mock 一号")).toBeInTheDocument();
    expect(screen.getByText(/2 exposed of 2 from api.mock.test/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "移除模型 mock/mock-mini" }));
    await waitFor(() =>
      expect(calls).toContainEqual(["provider", "models", "mock", "-mock/mock-mini"]),
    );

    fireEvent.change(screen.getByLabelText("添加模型"), {
      target: { value: "mock/mock-large" },
    });
    fireEvent.click(screen.getByRole("button", { name: "添加模型" }));
    await waitFor(() =>
      expect(calls).toContainEqual(["provider", "models", "mock", "+mock/mock-large"]),
    );

    fireEvent.click(screen.getByRole("button", { name: "每个系列只要最新" }));
    await waitFor(() => expect(calls).toContainEqual(["provider", "models", "mock", "best"]));

    fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
    await waitFor(() => expect(calls).toContainEqual(["provider", "refresh", "mock"]));
  });

  it("全局模型设置：后缀、压缩窗口、窗口上限各走一条命令", async () => {
    const { calls } = installBridge(
      {},
      {
        "model suffix": { ok: true, stdout: 'on · agents\' lists name a model with its provider\n', stderr: "" },
        "model compact": {
          ok: true,
          stdout:
            "on · Codex, Claude Code and Grok Build compact at 200K on a longer window · magpie model compact off\n",
          stderr: "",
        },
        "model context-cap": {
          ok: true,
          stdout: "off · every model takes its own window · magpie model context-cap <size>\n",
          stderr: "",
        },
      },
    );
    render(<ModelPage />);
    const summary = await screen.findByText(/全局模型设置 · 压缩到 200K/);
    fireEvent.click(summary);
    expect(screen.getByText(/名字后缀 · 带来源（「Sol · OpenAI」）/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("模型名字后缀"), { target: { value: "off" } });
    fireEvent.click(screen.getByRole("button", { name: "保存后缀" }));
    await waitFor(() => expect(calls).toContainEqual(["model", "suffix", "off"]));

    fireEvent.change(screen.getByLabelText("压缩窗口"), { target: { value: "on" } });
    fireEvent.change(screen.getByLabelText("压缩到（如 500k）"), { target: { value: "500k" } });
    fireEvent.click(screen.getByRole("button", { name: "保存压缩" }));
    await waitFor(() => expect(calls).toContainEqual(["model", "compact", "500k"]));

    fireEvent.change(screen.getByLabelText("窗口上限（如 200k，或 all）"), {
      target: { value: "200k" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存上限" }));
    await waitFor(() => expect(calls).toContainEqual(["model", "context-cap", "200k"]));

    fireEvent.click(screen.getByRole("button", { name: "关掉上限" }));
    await waitFor(() => expect(calls).toContainEqual(["model", "context-cap", "off"]));
  });

  it("看图与画图模型：读现在的选择，换看图模型、关掉画图模型", async () => {
    const { calls } = installBridge(
      {},
      {
        "settings get vision --json": { ok: true, stdout: '""\n', stderr: "" },
        "settings get imageGen --json": { ok: true, stdout: '"relay/relay-draw"\n', stderr: "" },
      },
    );
    useLlmStore.setState({
      models: [
        {
          id: "deepseek/deepseek-chat",
          name: "DeepSeek Chat",
          ownedBy: "deepseek",
          reasoningLevels: ["low", "high"],
          vision: true,
        },
      ],
    });
    render(<ModelPage />);

    fireEvent.click(await screen.findByText("看图与画图模型"));
    const vision = screen.getByLabelText("看图模型") as HTMLSelectElement;
    await waitFor(() => expect(vision.value).toBe(""));
    await waitFor(() => expect(screen.getByLabelText("画图模型")).toHaveValue("relay/relay-draw"));

    fireEvent.change(vision, { target: { value: "deepseek/deepseek-chat" } });
    await waitFor(() => expect(calls).toContainEqual(["settings", "set", "vision", "deepseek/deepseek-chat"]));

    // 思考档的选项来自选中的看图模型（上面的 reasoningLevels），清空写 reset。
    const effort = screen.getByLabelText("看图模型的思考档") as HTMLSelectElement;
    await waitFor(() => expect(Array.from(effort.options).map((o) => o.value)).toEqual(["", "low", "high"]));
    fireEvent.change(effort, { target: { value: "high" } });
    await waitFor(() =>
      expect(calls).toContainEqual(["settings", "set", "visionEffort", "high"]),
    );

    fireEvent.click(screen.getByRole("button", { name: "关掉" }));
    await waitFor(() => expect(calls).toContainEqual(["settings", "reset", "imageGen"]));
  });

  it("模型速度档：内核支持时才摆出来，选了值才发 model tier", async () => {
    const { calls } = installBridge(
      {},
      {
        model: {
          ok: true,
          stdout: "usage:\n  magpie model tier <provider/model>   how fast the model answers\n",
          stderr: "",
        },
      },
    );
    render(<ModelPage />);
    fireEvent.click(await screen.findByRole("button", { name: "编辑模型 deepseek/deepseek-chat" }));
    fireEvent.change(screen.getByLabelText("模型速度档"), { target: { value: "fast" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(calls).toContainEqual(["model", "tier", "deepseek/deepseek-chat", "fast"]),
    );
  });

  it("内核不认识 model tier 时，编辑器里没有速度档", async () => {
    installBridge();
    render(<ModelPage />);
    fireEvent.click(await screen.findByRole("button", { name: "编辑模型 deepseek/deepseek-chat" }));
    // 默认 mock 的裸 `model` 只回 "ok"，探测不到 `magpie model tier`。
    await waitFor(() => expect(screen.getByLabelText("上下文窗口")).toBeTruthy());
    expect(screen.queryByLabelText("模型速度档")).toBeNull();
  });

  it("智能体下拉只列它看得到的模型", async () => {
    useLlmStore.setState({
      profiles: [profile("deepseek/deepseek-chat"), profile("relay/relay-chat")],
    });
    installBridge(
      {},
      {
        providers: {
          ok: true,
          stdout:
            "  deepseek  deepseek  api.deepseek.com  ● sk-…  2 models\n" +
            "  relay     custom    relay.test        ● sk-…  1 models\n",
          stderr: "",
        },
        visible: {
          ok: true,
          stdout: "  claude        relay        1 shown, 1 not\n",
          stderr: "",
        },
      },
    );
    render(<ModelPage />);
    fireEvent.click(screen.getByRole("tab", { name: "智能体" }));
    const select = (await screen.findByLabelText("Claude Code 模型")) as HTMLSelectElement;
    const values = [...select.options].map((option) => option.value);
    expect(values).toContain("relay/relay-chat");
    expect(values).not.toContain("deepseek/deepseek-chat");
    expect(screen.getByText(/下拉只列它看得到的 1 个模型/)).toBeInTheDocument();
  });

  it("只显示挑过的模型：已开启时取消就发 --show-new", async () => {
    const { calls } = installBridge(
      {},
      {
        providers: {
          ok: true,
          stdout:
            "  deepseek  deepseek  api.deepseek.com  ● sk-…  2 models\n" +
            "  relay     custom    relay.test        ● sk-…  1 models\n",
          stderr: "",
        },
        visible: {
          ok: true,
          stdout: "  claude        deepseek, relay · only models picked   12 shown, 3 not\n",
          stderr: "",
        },
      },
    );
    render(<ModelPage />);
    fireEvent.click(screen.getByRole("tab", { name: "智能体" }));
    const picked = await screen.findByLabelText("Claude Code 只显示挑过的模型");
    expect(picked).toBeChecked();
    fireEvent.click(picked);
    await waitFor(() => expect(calls).toContainEqual(["visible", "claude", "--show-new"]));
  });

  it("分组规则：把「够长的请求」先交给指定模型", async () => {    const { calls } = installBridge();
    render(<ModelPage />);
    fireEvent.click(screen.getByRole("tab", { name: "运行" }));
    fireEvent.click(screen.getByText("路由分组（可选）"));
    fireEvent.change(screen.getByLabelText("规则分组"), { target: { value: "daily" } });
    fireEvent.change(screen.getByLabelText("规则模型"), { target: { value: "mock/mock-model" } });
    fireEvent.change(screen.getByLabelText("规则 token 阈值"), { target: { value: "150k" } });
    fireEvent.click(screen.getByRole("button", { name: "保存规则" }));
    await waitFor(() =>
      expect(calls).toContainEqual([
        "group",
        "rule",
        "add",
        "daily",
        "use=mock/mock-model",
        "tokens=150k",
      ]),
    );
  });

  it("模型目录按来源分组，显示名与能力摘要来自网关目录", async () => {
    installBridge();
    useLlmStore.setState({
      models: [
        {
          id: "deepseek/deepseek-chat",
          name: "DeepSeek Chat",
          ownedBy: "deepseek",
          contextWindow: 128000,
          maxOutputTokens: 8192,
          reasoningLevels: ["low", "high"],
          vision: true,
        },
      ],
    });
    render(<ModelPage />);
    // 显示名优先，模型 ID 降为副行；两者都还在，方便核对写给命令的是哪个。
    expect(await screen.findByText("DeepSeek Chat")).toBeInTheDocument();
    expect(screen.getByText("deepseek/deepseek-chat")).toBeInTheDocument();
    expect(screen.getByText("思考 low/high · 窗口 128K · 输出 8.2K · 图片输入")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "deepseek" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "openai" })).toBeInTheDocument();
  });

  it("编辑模型：显示名走 model name，思考档与窗口走 model spec", async () => {
    const { calls } = installBridge();
    render(<ModelPage />);
    fireEvent.click(await screen.findByRole("button", { name: "编辑模型 deepseek/deepseek-chat" }));
    fireEvent.change(screen.getByLabelText("模型显示名"), { target: { value: "DeepSeek Chat" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(calls).toContainEqual(["model", "name", "deepseek/deepseek-chat", "DeepSeek Chat"]),
    );

    fireEvent.click(await screen.findByRole("button", { name: "编辑模型 deepseek/deepseek-chat" }));
    fireEvent.change(screen.getByLabelText("思考档"), { target: { value: "low,high" } });
    fireEvent.change(screen.getByLabelText("上下文窗口"), { target: { value: "128k" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(calls).toContainEqual([
        "model",
        "spec",
        "deepseek/deepseek-chat",
        "--context",
        "128k",
        "--reasoning",
        "low,high",
      ]),
    );
  });

  it("测试模型走 provider test（来源 + 模型短名）", async () => {
    const { calls } = installBridge();
    render(<ModelPage />);
    fireEvent.click(await screen.findByRole("button", { name: "测试模型 deepseek/deepseek-chat" }));
    await waitFor(() =>
      expect(calls).toContainEqual(["provider", "test", "deepseek", "deepseek-chat"]),
    );
  });

  it("读取现在的设置：把 model spec 里的值填进编辑器，并标出哪些是你设的", async () => {
    installBridge(
      {},
      {
        "model spec deepseek/deepseek-chat": {
          ok: true,
          stdout: [
            "deepseek/deepseek-chat",
            "  context    200000             yours · --context auto goes back to the vendor's list",
            "  max output 8192               the vendor's list / models.dev",
            "  vision     off                yours · --vision auto goes back to the vendor's list",
            "  reasoning  low,high           yours · --reasoning auto goes back to the vendor's list",
          ].join("\n"),
          stderr: "",
        },
      },
    );
    render(<ModelPage />);
    fireEvent.click(await screen.findByRole("button", { name: "编辑模型 deepseek/deepseek-chat" }));
    fireEvent.click(screen.getByRole("button", { name: "读取现在的设置" }));
    await waitFor(() =>
      expect(screen.getByLabelText("上下文窗口")).toHaveValue("200000"),
    );
    expect(screen.getByLabelText("最大输出")).toHaveValue("8192");
    expect(screen.getByLabelText("思考档")).toHaveValue("low,high");
    expect(screen.getByLabelText("接受图片输入")).not.toBeChecked();
    expect(screen.getByText("你自己设过：窗口、图片输入、思考档")).toBeInTheDocument();
  });

  it("测试全部模型：先确认，再逐个真的测，最后报通过几个", async () => {
    const { calls } = installBridge();
    render(<ModelPage />);
    fireEvent.click(await screen.findByRole("button", { name: "测试全部模型" }));
    expect(screen.getByText(/每个模型都会真的发一次请求/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "开始测试" }));
    await waitFor(() =>
      expect(calls).toContainEqual(["provider", "test", "openai", "gpt-4o"]),
    );
    expect(calls).toContainEqual(["provider", "test", "deepseek", "deepseek-chat"]);
    expect(await screen.findByText("测试完 2 个模型：2 个通过。")).toBeInTheDocument();
  });

  it("目录带价格时，一行里看得到每 100 万 token 的价钱", async () => {
    installBridge();
    useLlmStore.setState({
      models: [
        {
          id: "deepseek/deepseek-chat",
          name: "DeepSeek Chat",
          ownedBy: "deepseek",
          reasoningLevels: [],
          vision: false,
          priceIn: 0.15,
          priceOut: 0.6,
          priceCacheRead: 0.003,
        },
      ],
    });
    render(<ModelPage />);
    expect(await screen.findByText("$0.15 入 / $0.6 出 · 每 1M token")).toBeInTheDocument();
  });

  it("改价格写 model price 的四个数；格式不对不发命令，先说清楚", async () => {
    const { calls } = installBridge();
    render(<ModelPage />);
    fireEvent.click(await screen.findByRole("button", { name: "编辑模型 deepseek/deepseek-chat" }));
    fireEvent.change(screen.getByLabelText("价格（入,出,缓存读,缓存写）"), {
      target: { value: "0.15,0.6" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(screen.getByText("价格要写 4 个数：入,出,缓存读,缓存写")).toBeInTheDocument();
    expect(calls.some((call) => call[0] === "model" && call[1] === "price")).toBe(false);

    fireEvent.change(screen.getByLabelText("价格（入,出,缓存读,缓存写）"), {
      target: { value: "0.15,0.6,0.003,0" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(calls).toContainEqual([
        "model",
        "price",
        "deepseek/deepseek-chat",
        "0.15,0.6,0.003,0",
      ]),
    );
  });

  it("按 Codex / Claude Code 的方式各问一次模型", async () => {
    const { calls } = installBridge();
    render(<ModelPage />);
    fireEvent.click(await screen.findByRole("button", { name: "编辑模型 deepseek/deepseek-chat" }));
    fireEvent.click(screen.getByRole("button", { name: "按 Codex 测试 deepseek/deepseek-chat" }));
    await waitFor(() =>
      expect(calls).toContainEqual(["provider", "test", "deepseek", "--as", "codex", "deepseek-chat"]),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "按 Claude Code 测试 deepseek/deepseek-chat" }),
    );
    await waitFor(() =>
      expect(calls).toContainEqual([
        "provider",
        "test",
        "deepseek",
        "--as",
        "claude-code",
        "deepseek-chat",
      ]),
    );
  });

  it("复制模型 ID 进剪贴板，按钮当场说已复制", async () => {
    installBridge();
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    render(<ModelPage />);
    fireEvent.click(await screen.findByRole("button", { name: "复制模型 ID deepseek/deepseek-chat" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("deepseek/deepseek-chat"));
    expect(screen.getByRole("button", { name: "复制模型 ID deepseek/deepseek-chat" })).toHaveTextContent(
      "已复制",
    );
  });

  it("禁用模型要先确认，确认后才执行 model disable", async () => {
    const { calls } = installBridge(
      {},
      {
        "model disabled": {
          ok: true,
          stdout: "no model is disabled · magpie model disable <model> turns one off",
          stderr: "",
        },
      },
    );
    render(<ModelPage />);
    fireEvent.click(await screen.findByRole("button", { name: "编辑模型 deepseek/deepseek-chat" }));
    fireEvent.click(screen.getByRole("button", { name: "禁用模型" }));
    expect(screen.getByText(/禁用后，请求经过和鸣网关时不再交给/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "禁用" }));
    await waitFor(() =>
      expect(calls).toContainEqual(["model", "disable", "deepseek/deepseek-chat"]),
    );
  });

  it("已禁用的模型列出来，启用同样要确认", async () => {
    const { calls } = installBridge(
      {},
      {
        "model disabled": {
          ok: true,
          stdout: "  deepseek/* · deepseek/deepseek-chat",
          stderr: "",
        },
      },
    );
    render(<ModelPage />);
    expect(await screen.findByText("deepseek/*")).toBeInTheDocument();
    expect(screen.getByText("现在关掉：deepseek/deepseek-chat")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "启用模型 deepseek/*" }));
    fireEvent.click(screen.getByRole("button", { name: "启用" }));
    await waitFor(() => expect(calls).toContainEqual(["model", "enable", "deepseek/*"]));
  });
});

describe("ModelPage · 智能体改模型", () => {
  it("列出本机智能体；应用与恢复默认都要二次确认", async () => {
    const { calls } = installBridge();
    render(<ModelPage />);
    fireEvent.click(screen.getByRole("tab", { name: "智能体" }));
    expect(await screen.findByText("Claude Code")).toBeInTheDocument();
    expect(screen.getByText(/space-bunny/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Claude Code 模型"), {
      target: { value: "deepseek/deepseek-chat" },
    });
    fireEvent.click(screen.getAllByRole("button", { name: "应用" })[0]!);
    expect(screen.getByText(/把 Claude Code 的模型改成/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认写入" }));
    await waitFor(() =>
      expect(calls).toContainEqual(["claude", "deepseek/deepseek-chat"]),
    );

    fireEvent.click(screen.getAllByRole("button", { name: "恢复默认" })[1]!);
    expect(screen.getByText(/恢复 Codex 原来的模型/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认写入" }));
    await waitFor(() => expect(calls).toContainEqual(["codex", "default"]));
  });

  it("可见模型：显示收窄情况，勾选来源后保存，勾空则恢复全部", async () => {
    const { calls } = installBridge(
      {},
      {
        providers: {
          ok: true,
          stdout:
            "  deepseek  deepseek  api.deepseek.com  ● sk-…  2 models\n" +
            "  relay     custom    relay.test        ● sk-…  1 models\n",
          stderr: "",
        },
        visible: {
          ok: true,
          stdout: "  claude        deepseek, relay        12 shown, 3 not\n",
          stderr: "",
        },
      },
    );
    render(<ModelPage />);
    fireEvent.click(screen.getByRole("tab", { name: "智能体" }));
    expect(
      await screen.findByText(/收窄到 deepseek、relay · 12 个可见，3 个被挡住/),
    ).toBeInTheDocument();

    // 勾掉 relay：只让 Claude Code 看到 deepseek
    fireEvent.click(screen.getByLabelText("Claude Code 可见 relay"));
    fireEvent.click(screen.getAllByRole("button", { name: "保存可见范围" })[0]!);
    await waitFor(() => expect(calls).toContainEqual(["visible", "claude", "deepseek"]));

    // 两个都不勾等于「什么都收窄掉」，按 magpie 的约定写回 all
    fireEvent.click(screen.getByLabelText("Claude Code 可见 deepseek"));
    fireEvent.click(screen.getByLabelText("Claude Code 可见 relay"));
    fireEvent.click(screen.getAllByRole("button", { name: "保存可见范围" })[0]!);
    await waitFor(() => expect(calls).toContainEqual(["visible", "claude", "all"]));
  });
});

describe("ModelPage · 网关密钥与会话", () => {
  it("新建网关密钥与查看会话都走对应命令", async () => {
    const { calls } = installBridge();
    render(<ModelPage />);
    fireEvent.click(screen.getByRole("tab", { name: "运行" }));
    fireEvent.click(screen.getByText("网关密钥"));
    fireEvent.change(screen.getByLabelText("新密钥名称"), { target: { value: "笔记本" } });
    fireEvent.click(screen.getByRole("button", { name: "新建密钥" }));
    await waitFor(() => expect(calls).toContainEqual(["gateway-key", "add", "笔记本"]));

    fireEvent.click(screen.getByText("会话与启动器"));
    fireEvent.click(screen.getByRole("button", { name: "查看最近会话" }));
    await waitFor(() => expect(calls).toContainEqual(["sessions", "--limit", "10"]));
  });
});

