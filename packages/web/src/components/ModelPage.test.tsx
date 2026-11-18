import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

  it("自动收取的状态写在账号卡底部：关掉时说清账号为什么是空的", async () => {
    const { calls } = installBridge(
      {},
      {
        "accounts discovery": {
          ok: true,
          stdout:
            "account discovery is off: magpie reads none of your agents' sign-ins and serves no subscription; API-key providers work as before",
          stderr: "",
        },
        "accounts discovery on": {
          ok: true,
          stdout:
            "account discovery is on: magpie reads your agents' sign-ins and serves them as subscriptions",
          stderr: "",
        },
      },
    );
    render(<ModelPage />);
    fireEvent.click(screen.getByRole("tab", { name: "来源" }));

    expect(await screen.findByText(/已关掉自动收取：订阅账号不会自己出现/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "打开自动收取" }));

    await waitFor(() => expect(calls).toContainEqual(["accounts", "discovery", "on"]));
    expect(await screen.findByText(/本机那些软件里已经登录的账号会自动收进来/)).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "关掉自动收取" })).toBeInTheDocument();
  });

  it("手上有可重置次数时，行上就能花掉一次（先问一句，再说结果）", async () => {
    const until = new Date(Date.now() + 3 * 3600_000).toISOString();
    const { calls } = installBridge(
      {},
      {
        "accounts --json": {
          ok: true,
          stdout: JSON.stringify([
            {
              agent: "codex",
              user: "gpt@example.com",
              alias: "码号",
              plan: "Plus",
              active: true,
              on: true,
              windows: [{ name: "week", used: 100, remaining: 0, display: "100% used" }],
              resets: { count: 2, until },
              readAt: new Date().toISOString(),
            },
          ]),
          stderr: "",
        },
        "quota reset gpt@example.com --yes": { ok: true, stdout: "✓ spent", stderr: "" },
      },
    );
    render(<ModelPage />);
    fireEvent.click(screen.getByRole("tab", { name: "来源" }));
    await screen.findByText("码号");

    fireEvent.click(screen.getByRole("button", { name: "用掉一次重置" }));
    const dialog = await screen.findByRole("dialog", { name: "用掉 码号 的一次重置？" });
    // 确认框要说清「还剩几次」和「什么时候到期」，因为这一步撤不回来。
    expect(dialog.textContent).toContain("还剩 2 次");
    expect(calls.filter((args) => args[0] === "quota" && args[1] === "reset")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "用掉一次" }));
    await waitFor(() =>
      expect(calls).toContainEqual(["quota", "reset", "gpt@example.com", "--yes"]),
    );
    expect(await screen.findByText(/码号 的窗口已经重新开始/)).toBeInTheDocument();
  });

  it("重置快到期时可以让它自己花掉：只开一档时把另一档显式关掉", async () => {
    const until = new Date(Date.now() + 3 * 3600_000).toISOString();
    const { calls } = installBridge(
      {},
      {
        "accounts --json": {
          ok: true,
          stdout: JSON.stringify([
            {
              agent: "codex",
              user: "gpt@example.com",
              alias: "码号",
              plan: "Plus",
              active: true,
              on: true,
              windows: [{ name: "week", used: 40, remaining: 60, display: "40% used" }],
              resets: { count: 2, until },
              readAt: new Date().toISOString(),
            },
          ]),
          stderr: "",
        },
        "quota auto-reset": {
          ok: true,
          stdout: "● gpt@example.com  uses a reset by itself before one expires\n",
          stderr: "",
        },
        "quota auto-reset gpt@example.com week on": { ok: true, stdout: "✓", stderr: "" },
        "quota auto-reset gpt@example.com expiring off": { ok: true, stdout: "✓", stderr: "" },
      },
    );
    render(<ModelPage />);
    fireEvent.click(screen.getByRole("tab", { name: "来源" }));
    await screen.findByText("码号");

    // 内核此刻说的是「快过期才花」，下拉就得停在这一档，而不是页面自己猜的「不自己花」。
    const select = await screen.findByLabelText<HTMLSelectElement>("码号 的重置怎么花");
    await waitFor(() => expect(select.value).toBe("expiring"));

    fireEvent.change(select, { target: { value: "week" } });
    await waitFor(() =>
      expect(calls).toContainEqual(["quota", "auto-reset", "gpt@example.com", "week", "on"]),
    );
    // 只发 week on 会变成两档都开：另一档必须显式关掉。
    expect(calls).toContainEqual(["quota", "auto-reset", "gpt@example.com", "expiring", "off"]);
    expect(await screen.findByText(/码号 自己花掉重置：周额度用完就花/)).toBeInTheDocument();
  });

  it("有人选了「快过期就花」时，额度提醒卡里就能调提前多久", async () => {
    const until = new Date(Date.now() + 3 * 3600_000).toISOString();
    const { calls } = installBridge(
      {},
      {
        "accounts --json": {
          ok: true,
          stdout: JSON.stringify([
            {
              agent: "codex",
              user: "gpt@example.com",
              alias: "码号",
              plan: "Plus",
              active: true,
              on: true,
              windows: [{ name: "week", used: 40, remaining: 60, display: "40% used" }],
              resets: { count: 2, until },
              readAt: new Date().toISOString(),
            },
          ]),
          stderr: "",
        },
        "quota auto-reset": {
          ok: true,
          stdout: "● gpt@example.com  uses a reset by itself before one expires\n",
          stderr: "",
        },
        "quota auto-reset lead": {
          ok: true,
          stdout: "a reset about to expire unused is used 30m before it expires (the default)\n",
          stderr: "",
        },
        "quota auto-reset lead 2h": { ok: true, stdout: "✓", stderr: "" },
      },
    );
    render(<ModelPage />);
    fireEvent.click(screen.getByRole("tab", { name: "来源" }));
    await screen.findByText("码号");

    const lead = await screen.findByLabelText<HTMLSelectElement>("重置快过期时提前多久花");
    await waitFor(() => expect(lead.value).toBe("30"));
    expect([...lead.options].map((option) => option.textContent)).toContain("30 分钟（默认）");

    fireEvent.change(lead, { target: { value: "120" } });
    await waitFor(() =>
      expect(calls).toContainEqual(["quota", "auto-reset", "lead", "2h"]),
    );
    expect(await screen.findByText(/一份重置在到期前 2 小时还没用上/)).toBeInTheDocument();
  });

  it("没人会在快过期时花重置，就不摆这个提前量", async () => {
    installBridge(
      {},
      {
        "accounts --json": {
          ok: true,
          stdout: JSON.stringify([
            {
              agent: "codex",
              user: "gpt@example.com",
              alias: "码号",
              plan: "Plus",
              active: true,
              on: true,
              windows: [{ name: "week", used: 40, remaining: 60, display: "40% used" }],
              resets: { count: 2 },
              readAt: new Date().toISOString(),
            },
          ]),
          stderr: "",
        },
        "quota auto-reset": {
          ok: true,
          stdout: "● gpt@example.com  uses a reset by itself when its week runs out\n",
          stderr: "",
        },
        "quota auto-reset lead": {
          ok: true,
          stdout: "a reset about to expire unused is used 30m before it expires (the default)\n",
          stderr: "",
        },
      },
    );
    render(<ModelPage />);
    fireEvent.click(screen.getByRole("tab", { name: "来源" }));
    await screen.findByText("码号");
    // 等这一轮读完之后再断言「没有」，否则断言的是「还没读到」。
    await waitFor(() => expect(screen.getByLabelText("额度快用完时提醒")).toBeInTheDocument());
    expect(screen.queryByLabelText("重置快过期时提前多久花")).not.toBeInTheDocument();
  });

  it("同一家两个账号时，先把两份读成一行（平均剩多少）", async () => {
  installBridge(
    {},
    {
      "accounts --json": {
        ok: true,
        stdout: JSON.stringify([
          {
            agent: "claude",
            user: "work@example.com",
            alias: "工作号",
            plan: "Max",
            active: true,
            on: true,
            windows: [{ name: "5 hours", used: 80, remaining: 20, display: "80% used" }],
            readAt: new Date().toISOString(),
          },
          {
            agent: "claude",
            user: "home@example.com",
            alias: "家里号",
            plan: "Max",
            active: true,
            on: false,
            windows: [{ name: "5 hours", used: 20, remaining: 80, display: "20% used" }],
            readAt: new Date().toISOString(),
          },
        ]),
        stderr: "",
      },
    },
  );
  render(<ModelPage />);
  fireEvent.click(screen.getByRole("tab", { name: "来源" }));
  expect(await screen.findByText("工作号")).toBeInTheDocument();

  const merged = screen.getByLabelText("账号合计");
  expect(merged.textContent).toContain("Claude");
  expect(merged.textContent).toContain("2 个账号");
  expect(merged.textContent).toContain("5 小时 平均剩 50%");
  // 明细行还在：合计是合计，各账号各写各的
  expect(screen.getByText("家里号")).toBeInTheDocument();
});

it("账号可以就地改名：回车写 accounts alias，列表立刻换名字", async () => {
    const { calls } = installBridge();
    render(<ModelPage />);
    fireEvent.click(screen.getByRole("tab", { name: "来源" }));
    expect(await screen.findByText("工作号")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "改名" }));
    const input = screen.getByLabelText("账号名字");
    fireEvent.change(input, { target: { value: "小号" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(calls.some((args) => args.join(" ") === "accounts alias claude work@example.com 小号")).toBe(true),
    );
    // 回车与失焦都提交时也只发一次
    expect(calls.filter((args) => args[1] === "alias")).toHaveLength(1);
    // 只改名，不碰登录状态（`accounts --json` 是重读列表，不算）
    expect(
      calls.some((args) => args[0] === "accounts" && ["switch", "forget", "add", "checkin"].includes(args[1] ?? "")),
    ).toBe(false);
    expect(await screen.findByText(/已把它叫作「小号」/)).toBeInTheDocument();
  });

  it("改名时按 Esc 不改：一个命令都不发", async () => {
    const { calls } = installBridge();
    render(<ModelPage />);
    fireEvent.click(screen.getByRole("tab", { name: "来源" }));
    expect(await screen.findByText("工作号")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "改名" }));
    const input = screen.getByLabelText("账号名字");
    fireEvent.change(input, { target: { value: "不想保存" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.queryByLabelText("账号名字")).toBeNull();
    expect(calls.some((args) => args[1] === "alias")).toBe(false);
  });

  it("移除账号要二次确认，并说清那个软件可能被退出登录", async () => {
    const { calls } = installBridge();
    render(<ModelPage />);
    fireEvent.click(screen.getByRole("tab", { name: "来源" }));
    expect(await screen.findByText("工作号")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "移除" }));
    const dialog = await screen.findByRole("dialog", { name: "移除 工作号？" });
    expect(within(dialog).getByText(/会被退出登录/)).toBeInTheDocument();
    expect(calls.some((args) => args[1] === "forget")).toBe(false);

    fireEvent.click(within(dialog).getByRole("button", { name: "移除" }));
    await waitFor(() =>
      expect(calls.some((args) => args.join(" ") === "accounts forget claude work@example.com")).toBe(true),
    );
  });

  it("来源页列出国内智能体：点一下就接入并登录，两步合成一次点击", async () => {
    const { bridge, calls } = installBridge();
    render(<ModelPage />);
    fireEvent.click(screen.getByRole("tab", { name: "来源" }));
    expect(await screen.findByText("国内智能体")).toBeInTheDocument();
    expect(screen.getByText("WorkBuddy")).toBeInTheDocument();
    expect(screen.getByText("Qoder CN")).toBeInTheDocument();
    // 还没接进来的端一律写「接入」：接入与登录是同一次点击里的事，不摆两步
    expect(screen.getAllByText("接入").length).toBe(DOMESTIC_AGENTS.length);

    fireEvent.click(screen.getByText("WorkBuddy"));
    await waitFor(() =>
      expect(calls).toContainEqual(["plugin", "add", "@magpie-community/opencode-workbuddy-auth"]),
    );
    await waitFor(() =>
      expect(bridge.openTerminal).toHaveBeenCalledWith(["accounts", "add", "workbuddy"]),
    );
    expect(await screen.findByText(/已把 WorkBuddy 接进和鸣/)).toBeInTheDocument();
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

  it("内核的英文拒绝在提示条里说成中文，且不再出现外部引擎名", async () => {
    installBridge({}, {
      "accounts checkin --json": {
        ok: false,
        stdout: "",
        stderr: "magpie can't sign in to workbuddy accounts",
      },
    });
    render(<ModelPage />);
    fireEvent.click(screen.getByRole("tab", { name: "来源" }));
    fireEvent.click(await screen.findByRole("button", { name: "今日签到" }));
    const notice = await screen.findByRole("status");
    expect(notice).toHaveTextContent(/不能直接登录 workbuddy 的账号/);
    expect(notice.textContent ?? "").not.toMatch(/magpie/i);
  });

  it("每天自动签到：把四个厂商开关一起打开，并说清覆盖哪几家", async () => {
    const { calls } = installBridge({}, {
      "settings list --json": {
        ok: true,
        stdout: JSON.stringify([
          { key: "workbuddyCheckin", value: false },
          { key: "qoderCheckin", value: false },
          { key: "traeCheckin", value: false },
          { key: "minimaxCheckin", value: false },
        ]),
        stderr: "",
      },
    });
    render(<ModelPage />);
    fireEvent.click(screen.getByRole("tab", { name: "来源" }));
    expect(await screen.findByText(/打开后和鸣每天自动领/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "开启自动签到" }));
    for (const key of ["workbuddyCheckin", "qoderCheckin", "traeCheckin", "minimaxCheckin"]) {
      await waitFor(() => expect(calls).toContainEqual(["settings", "set", key, "on"]));
    }
    expect(await screen.findByText(/已开启每天自动签到/)).toBeInTheDocument();
  });

  it("自动签到已经开着时，按钮是「关掉」并把四个开关关回去", async () => {
    const { calls } = installBridge({}, {
      "settings list --json": {
        ok: true,
        stdout: JSON.stringify([
          { key: "workbuddyCheckin", value: true },
          { key: "qoderCheckin", value: true },
          { key: "traeCheckin", value: true },
          { key: "minimaxCheckin", value: true },
        ]),
        stderr: "",
      },
    });
    render(<ModelPage />);
    fireEvent.click(screen.getByRole("tab", { name: "来源" }));
    fireEvent.click(await screen.findByRole("button", { name: "关掉自动签到" }));
    await waitFor(() => expect(calls).toContainEqual(["settings", "set", "workbuddyCheckin", "off"]));
    expect(await screen.findByText(/已关掉每天自动签到/)).toBeInTheDocument();
  });

  it("本机装过的国内端在卡片上标出来", async () => {
    installBridge({}, {
      ls: {
        ok: true,
        stdout: "WorkBuddy    glm-5.3-flash  ~/.workbuddy/models.json\nQoder    auto  ~/.qoder/settings.json",
        stderr: "",
      },
    });
    render(<ModelPage />);
    fireEvent.click(screen.getByRole("tab", { name: "来源" }));
    const chips = await screen.findAllByText("本机已装");
    expect(chips.length).toBe(2);
  });

  it("智能体分区把订阅额度贴在名字旁边，悬停能看每个窗口", async () => {
    installBridge();
    render(<ModelPage />);
    fireEvent.click(screen.getByRole("tab", { name: "智能体" }));
    const chip = await screen.findByText("剩 18%");
    expect(chip).toBeInTheDocument();
    expect(chip.getAttribute("title")).toContain("5 小时");
    expect(chip.getAttribute("title")).toContain("工作号");
  });

  it("额度提醒改的是内核设置：选一档就写 settings set，并说清提醒什么", async () => {
    const { calls } = installBridge({}, {
      "settings list --json": {
        ok: true,
        stdout: JSON.stringify([
          { key: "usageAlert", value: 0 },
          { key: "resetReminder", value: 0 },
        ]),
        stderr: "",
      },
    });
    render(<ModelPage />);
    fireEvent.click(screen.getByRole("tab", { name: "来源" }));
    await screen.findByText("额度提醒");
    fireEvent.change(screen.getByLabelText("额度快用完时提醒"), { target: { value: "80" } });
    await waitFor(() => expect(calls).toContainEqual(["settings", "set", "usageAlert", "80"]));
    expect(await screen.findByText(/已记下：额度窗口用到 80%/)).toBeInTheDocument();
  });

  it("一家用完、同门还有余量时，卡片里问一句要不要换过去", async () => {
    const { calls } = installBridge({}, {
      "accounts --json": {
        ok: true,
        stdout: JSON.stringify([
          {
            agent: "claude",
            user: "used@example.com",
            alias: "用完的",
            plan: "Max",
            active: true,
            on: true,
            windows: [{ name: "5 hours", used: 100, remaining: 0, display: "100% used" }],
            readAt: new Date().toISOString(),
          },
          {
            agent: "claude",
            user: "fresh@example.com",
            alias: "还有的",
            plan: "Max",
            active: false,
            on: false,
            windows: [{ name: "5 hours", used: 20, remaining: 80, display: "20% used" }],
            readAt: new Date().toISOString(),
          },
        ]),
        stderr: "",
      },
    });
    render(<ModelPage />);
    fireEvent.click(screen.getByRole("tab", { name: "来源" }));

    const hint = await screen.findByLabelText("换到还有额度的账号");
    expect(hint).toHaveTextContent("Claude 有 1 个账号用完了，另有 1 个还有余量");

    fireEvent.click(within(hint).getByRole("button", { name: "换过去" }));
    const dialog = await screen.findByRole("dialog", {
      name: "把 Claude 换到还有额度的那个？",
    });
    expect(dialog).toHaveTextContent(/会改写这个智能体自己的登录状态/);
    expect(calls).not.toContainEqual(["accounts", "switch", "claude", "next"]);

    fireEvent.click(within(dialog).getByRole("button", { name: "换过去" }));
    await waitFor(() =>
      expect(calls).toContainEqual(["accounts", "switch", "claude", "next"]),
    );
    expect(await screen.findByText(/已把 Claude 换到还有额度的那个账号/)).toBeInTheDocument();
  });

  it("账号多了以后能只看快用完的那几个，看完再回到全部", async () => {
    const rows = [
      ...[1, 2, 3, 4].map((n) => ({
        agent: "claude",
        user: `ready${n}@example.com`,
        alias: `宽裕的 ${n}`,
        plan: "Max",
        active: n === 1,
        on: n === 1,
        windows: [{ name: "5 hours", used: 30, remaining: 70, display: "30% used" }],
        readAt: new Date().toISOString(),
      })),
      {
        agent: "codex",
        user: "tight@example.com",
        alias: "快用完的",
        plan: "Plus",
        active: false,
        on: false,
        windows: [{ name: "week", used: 88, remaining: 12, display: "88% used" }],
        readAt: new Date().toISOString(),
      },
      {
        agent: "gemini",
        user: "gone@example.com",
        alias: "失效的",
        active: true,
        on: true,
        lapsed: "登录过期了",
        windows: [],
        readAt: new Date().toISOString(),
      },
    ];
    installBridge({}, { "accounts --json": { ok: true, stdout: JSON.stringify(rows), stderr: "" } });
    render(<ModelPage />);
    fireEvent.click(screen.getByRole("tab", { name: "来源" }));

    const bar = await screen.findByRole("group", { name: "按状态筛选账号" });
    expect(within(bar).getByRole("button", { name: /^全部/ })).toHaveTextContent("6");
    expect(within(bar).getByRole("button", { name: /^要重新登录/ })).toHaveTextContent("1");
    expect(within(bar).getByRole("button", { name: /^快用完/ })).toHaveTextContent("1");
    expect(within(bar).getByRole("button", { name: /^还有余量/ })).toHaveTextContent("4");

    fireEvent.click(within(bar).getByRole("button", { name: /^快用完/ }));
    const list = screen.getByLabelText("订阅账号列表");
    expect(within(list).getByText("快用完的")).toBeInTheDocument();
    expect(within(list).queryByText("失效的")).toBeNull();
    expect(within(list).queryByText("宽裕的 1")).toBeNull();
    expect(within(bar).getByRole("button", { name: /^快用完/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    fireEvent.click(within(bar).getByRole("button", { name: /^全部/ }));
    expect(within(screen.getByLabelText("订阅账号列表")).getByText("失效的")).toBeInTheDocument();
  });

  it("账号不到六个时不摆筛选项：一眼看完的东西不用分类", async () => {
    installBridge({}, {
      "accounts --json": {
        ok: true,
        stdout: JSON.stringify([
          {
            agent: "claude",
            user: "a@example.com",
            alias: "甲",
            active: true,
            on: true,
            windows: [{ name: "5 hours", used: 10, remaining: 90, display: "10% used" }],
            readAt: new Date().toISOString(),
          },
          {
            agent: "claude",
            user: "b@example.com",
            alias: "乙",
            active: false,
            on: false,
            windows: [{ name: "5 hours", used: 95, remaining: 5, display: "95% used" }],
            readAt: new Date().toISOString(),
          },
        ]),
        stderr: "",
      },
    });
    render(<ModelPage />);
    fireEvent.click(screen.getByRole("tab", { name: "来源" }));
    const list = await screen.findByLabelText("订阅账号列表");
    expect(within(list).getByText("甲")).toBeInTheDocument();
    expect(within(list).getByText("乙")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "按状态筛选账号" })).toBeNull();
  });

  it("筛着筛着这一类没了，就说清楚并给一条「看全部」的路", async () => {
    const tight = [
      ...[1, 2].map((n) => ({
        agent: "claude",
        user: `ready${n}@example.com`,
        alias: `宽裕的 ${n}`,
        active: true,
        on: n === 1,
        windows: [{ name: "5 hours", used: 20, remaining: 80, display: "20% used" }],
        readAt: new Date().toISOString(),
      })),
      ...[3, 4].map((n) => ({
        agent: "codex",
        user: `mid${n}@example.com`,
        alias: `一般的 ${n}`,
        active: false,
        on: false,
        windows: [{ name: "week", used: 60, remaining: 40, display: "60% used" }],
        readAt: new Date().toISOString(),
      })),
      {
        agent: "codex",
        user: "tight@example.com",
        alias: "快用完的",
        active: false,
        on: false,
        windows: [{ name: "week", used: 88, remaining: 12, display: "88% used" }],
        readAt: new Date().toISOString(),
      },
      {
        agent: "qoder",
        user: "q@example.com",
        alias: "国内号",
        active: true,
        on: true,
        windows: [{ name: "Month", used: 20, remaining: 80, display: "20% used" }],
        readAt: new Date().toISOString(),
      },
    ];
    // 同一份夹具对象：重读一次之后「快用完的」不再紧张，分类就空了。
    const accountsReply = { ok: true, stdout: JSON.stringify(tight), stderr: "" };
    installBridge({}, { "accounts --json": accountsReply });
    render(<ModelPage />);
    fireEvent.click(screen.getByRole("tab", { name: "来源" }));

    const bar = await screen.findByRole("group", { name: "按状态筛选账号" });
    fireEvent.click(within(bar).getByRole("button", { name: /^快用完/ }));
    expect(within(screen.getByLabelText("订阅账号列表")).getByText("快用完的")).toBeInTheDocument();

    accountsReply.stdout = JSON.stringify(
      tight.map((row) => ({
        ...row,
        windows: [{ name: "week", used: 20, remaining: 80, display: "20% used" }],
      })),
    );
    fireEvent.click(screen.getByRole("button", { name: /重读全部/ }));

    expect(
      await screen.findByText(/这个筛选下没有快用完的账号/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "看全部" }));
    expect(within(screen.getByLabelText("订阅账号列表")).getByText("国内号")).toBeInTheDocument();
  });

  it("余额提醒也走同一个设置：选一个数额就写 balanceAlert，并说清按各自币种算", async () => {
    const { calls } = installBridge({}, {
      "settings list --json": {
        ok: true,
        stdout: JSON.stringify([
          { key: "usageAlert", value: 0 },
          { key: "resetReminder", value: 0 },
          { key: "balanceAlert", value: 0 },
        ]),
        stderr: "",
      },
    });
    render(<ModelPage />);
    fireEvent.click(screen.getByRole("tab", { name: "来源" }));

    const select = (await screen.findByLabelText("余额快用完时提醒")) as HTMLSelectElement;
    expect(select.value).toBe("0");

    fireEvent.change(select, { target: { value: "5" } });
    await waitFor(() => expect(calls).toContainEqual(["settings", "set", "balanceAlert", "5"]));
    expect(await screen.findByText(/已记下：余额低到 5 或更少时提醒一次/)).toBeInTheDocument();
  });

  it("额度窗口预热：切一档就写内核设置，关掉时用重置（空串内核不收）", async () => {
    const { calls } = installBridge({}, {
      "settings list --json": {
        ok: true,
        stdout: JSON.stringify([
          { key: "codexWarmup", value: "" },
          { key: "claudeWarmup", value: "week" },
          { key: "codexWarmAts", value: null },
          { key: "claudeWarmAts", value: [] },
        ]),
        stderr: "",
      },
    });
    render(<ModelPage />);
    fireEvent.click(screen.getByRole("tab", { name: "来源" }));
    await screen.findByText("额度窗口预热");
    fireEvent.change(screen.getByLabelText("ChatGPT 的预热"), { target: { value: "all" } });
    await waitFor(() => expect(calls).toContainEqual(["settings", "set", "codexWarmup", "all"]));
    expect(await screen.findByText("已打开预热：窗口一重置就先替你开一次。")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Claude 的预热"), { target: { value: "off" } });
    await waitFor(() => expect(calls).toContainEqual(["settings", "reset", "claudeWarmup"]));
    expect(await screen.findByText("已关掉这家厂商的预热。")).toBeInTheDocument();
  });

  it("额度窗口预热：每天的时间点按列表写进内核，清空就重置", async () => {
    const { calls } = installBridge({}, {
      "settings list --json": {
        ok: true,
        stdout: JSON.stringify([
          { key: "codexWarmup", value: "all" },
          { key: "codexWarmAts", value: ["06:00"] },
        ]),
        stderr: "",
      },
    });
    render(<ModelPage />);
    fireEvent.click(screen.getByRole("tab", { name: "来源" }));
    const input = await screen.findByLabelText("ChatGPT 每天开 5 小时窗口的时间");
    await waitFor(() => expect(input).toHaveValue("06:00"));
    fireEvent.change(input, { target: { value: "15:05 9:00" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(calls).toContainEqual(["settings", "set", "codexWarmAts", "09:00,15:05"]));
    expect(await screen.findByText("已记下：每天 09:00、15:05 各开一次。")).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(calls).toContainEqual(["settings", "reset", "codexWarmAts"]));
    expect(await screen.findByText("已清掉固定时间。")).toBeInTheDocument();
  });

  it("国内端登录之后，额度写在它自己的卡片上，不用去上面的列表里找", async () => {
    installBridge({}, {
      "accounts --json": {
        ok: true,
        stdout: JSON.stringify([
          {
            agent: "workbuddy",
            user: "me@example.com",
            alias: "腾讯号",
            plan: "免费",
            active: true,
            on: true,
            windows: [
              { name: "Month", used: 3000, remaining: 7000, amount: 3000, limit: 10000, unit: "credits", display: "" },
            ],
            readAt: new Date().toISOString(),
          },
        ]),
        stderr: "",
      },
    });
    render(<ModelPage />);
    fireEvent.click(screen.getByRole("tab", { name: "来源" }));
    // 同一句会在两处出现：订阅账号那一行按窗口报，国内端卡片报它自己最紧的窗口；
    // 两处说的是同一句话，才算「一个数字，不打架」。
    const shown = await screen.findAllByText("剩 7,000 点");
    expect(shown.length).toBeGreaterThanOrEqual(2);
    expect(shown.some((node) => node.closest("button") !== null)).toBe(true);
    // 有额度时右侧就让给徽标，不再重复「已登录」；悬停里能读到是哪个账号。
    const inCard = shown.find((node) => node.closest("button") !== null)!;
    expect(inCard.getAttribute("title")).toContain("腾讯号");
  });

  it("上次读到的来源先画出来，不等这一次的读取", async () => {
    // 真机上 `providers` 要 600ms 上下：打开页面时先拿上次的原话画一版，读回来再替换。
    // 这里让这一次的读取永远不返回，看首屏是否还画得出来。
    vi.stubEnv("MODE", "production");
    localStorage.setItem(
      "heming.modelpage.v2.providers",
      JSON.stringify({
        at: Date.now(),
        text: "  cached custom  mock  https://cache.example  ● •••••••  2 models  ",
      }),
    );
    const calls: string[][] = [];
    const cli = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === "providers") return new Promise(() => {});
      return { ok: true, stdout: "ok", stderr: "" };
    });
    installBridge({ cli });

    render(<ModelPage />);
    fireEvent.click(screen.getByRole("tab", { name: "来源" }));
    expect(await screen.findByText("cached")).toBeInTheDocument();

    vi.unstubAllEnvs();
    localStorage.clear();
  });

  it("上次读到的智能体列表也先画出来", async () => {
    vi.stubEnv("MODE", "production");
    localStorage.setItem(
      "heming.modelpage.v2.agents",
      JSON.stringify({
        at: Date.now(),
        text: "  Cached Agent       —  ·  effort —   ~/.cached/settings.json\n",
      }),
    );
    const cli = vi.fn(async (args: string[]) => {
      if (args[0] === "ls") return new Promise(() => {});
      return { ok: true, stdout: "ok", stderr: "" };
    });
    installBridge({ cli });

    render(<ModelPage />);
    fireEvent.click(screen.getByRole("tab", { name: "智能体" }));
    expect(await screen.findByText("Cached Agent")).toBeInTheDocument();

    vi.unstubAllEnvs();
    localStorage.clear();
  });

  it("首屏不等额度：订阅账号还在读的时候，模型列表已经能用了", async () => {
    // 内核每条命令都要起一个进程（实测 280–630ms）；额度这类慢一步的东西
    // 不该把整页拖住，所以这里让它永远不返回，看首屏还出不出得来。
    const hanging = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === "accounts" || args[0] === "quota") return new Promise(() => {});
      if (args[0] === "providers") {
        return { ok: true, stdout: "  mock custom  mock  127.0.0.1:39001  ● •••••••  1 models  ", stderr: "" };
      }
      if (args[0] === "ls") return { ok: true, stdout: "  Claude Code       —  ·  effort —   ~/.claude/settings.json\n", stderr: "" };
      return { ok: true, stdout: "ok", stderr: "" };
    });
    const { calls } = installBridge({ cli: hanging });
    render(<ModelPage />);
    expect(await screen.findByText("deepseek/deepseek-chat")).toBeInTheDocument();
    expect(screen.queryByTestId("page-fallback")).not.toBeInTheDocument();
    // 慢的那些确实发出去了，只是没挡住首屏。
    expect(calls.some((call) => call[0] === "accounts")).toBe(true);
  });

  it("已经知道有哪些模型时，不再先摆骨架等来源读完", async () => {
    // 模型清单来自本地 store，来源那几条命令还没回来时它就已经能画了。
    // 骨架只该留给「什么都不知道」的那一屏，否则每次打开都白等半秒。
    const cli = vi.fn(async (args: string[]) => {
      if (args[0] === "providers") return new Promise(() => {});
      return { ok: true, stdout: "ok", stderr: "" };
    });
    installBridge({ cli });

    render(<ModelPage />);
    expect(await screen.findByText("deepseek/deepseek-chat")).toBeInTheDocument();
    expect(screen.queryByLabelText("正在读取模型")).not.toBeInTheDocument();
  });

  it("来源页把 Key 与套餐的余额也列出来：订阅之外的额度不再只有终端里看得到", async () => {    installBridge({}, {
      "quota --json": {
        ok: true,
        stdout: JSON.stringify([
          {
            provider: "deepseek",
            name: "DeepSeek",
            kind: "balance",
            windows: [],
            balance: "¥2.60",
            last: true,
          },
          { provider: "claude", name: "Claude", kind: "subscription", windows: [] },
        ]),
        stderr: "",
      },
    });
    render(<ModelPage />);
    fireEvent.click(screen.getByRole("tab", { name: "来源" }));
    expect(await screen.findByText("其余来源的额度")).toBeInTheDocument();
    expect(await screen.findByText("¥2.60")).toBeInTheDocument();
    // 订阅在「订阅账号」卡里按账号列，这里不再重复一遍。
    const list = screen.getByLabelText("其余来源的额度");
    expect(within(list).queryByText("Claude")).not.toBeInTheDocument();
    expect(within(list).getByText("DeepSeek")).toBeInTheDocument();
  });

  it("来源页把额度走向收成一句话：最急的那份写在标题下，想看曲线再展开", async () => {
    const now = Date.now();
    const hour = 60 * 60 * 1000;
    const at = (hoursAgo: number): string => new Date(now - hoursAgo * hour).toISOString();
    installBridge({}, {
      "quota history --days 7 --json": {
        ok: true,
        stdout: JSON.stringify([
          {
            provider: "claude",
            user: "work@example.com",
            lines: [
              {
                name: "5 hours",
                points: [
                  { at: at(4), left: 96 },
                  { at: at(3), left: 80 },
                  { at: at(2), left: 64 },
                  { at: at(1), left: 46 },
                  { at: at(0), left: 30 },
                ],
              },
            ],
          },
        ]),
        stderr: "",
      },
    });
    render(<ModelPage />);
    fireEvent.click(screen.getByRole("tab", { name: "来源" }));

    // 收起来时只留一句结论：曲线本身不在 DOM 里。
    expect(await screen.findByText("额度走向")).toBeInTheDocument();
    expect(screen.getByText(/Claude work@example\.com（5 小时）照这个速度/)).toBeInTheDocument();
    expect(screen.queryByLabelText("额度走向")).toBeNull();
    const toggle = screen.getByRole("button", { name: "展开走向" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(toggle);
    const trend = await screen.findByLabelText("额度走向");
    expect(within(trend).getByText("剩 30%")).toBeInTheDocument();
    expect(within(trend).getByText(/^5 小时：照这个速度，/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "收起走向" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: "收起走向" }));
    expect(screen.queryByLabelText("额度走向")).toBeNull();
  });

  it("额度走向能换天数：选了 30 天就拿 30 天去问内核", async () => {
    const now = Date.now();
    const hour = 60 * 60 * 1000;
    const points = [
      { at: new Date(now - 4 * hour).toISOString(), left: 96 },
      { at: new Date(now - 3 * hour).toISOString(), left: 80 },
      { at: new Date(now - 2 * hour).toISOString(), left: 64 },
      { at: new Date(now - 1 * hour).toISOString(), left: 46 },
      { at: new Date(now).toISOString(), left: 30 },
    ];
    const { calls } = installBridge({}, {
      "quota history --days 7 --json": {
        ok: true,
        stdout: JSON.stringify([{ provider: "claude", lines: [{ name: "5 hours", points }] }]),
        stderr: "",
      },
      "quota history --days 30 --json": {
        ok: true,
        stdout: JSON.stringify([{ provider: "claude", lines: [{ name: "week", points }] }]),
        stderr: "",
      },
    });
    render(<ModelPage />);
    fireEvent.click(screen.getByRole("tab", { name: "来源" }));
    const select = await screen.findByLabelText<HTMLSelectElement>("额度走向看几天");
    expect(select.value).toBe("7");

    fireEvent.change(select, { target: { value: "30" } });
    await waitFor(() => expect(calls).toContainEqual(["quota", "history", "--days", "30", "--json"]));
    // 换档之后画的是 30 天那份：窗口名从「5 小时」变成「每周」。
    expect(await screen.findByText(/（每周）/)).toBeInTheDocument();
    expect(select.value).toBe("30");
  });

  it("没有历史读数时整张「额度走向」卡都不出现", async () => {
    installBridge({}, {
      "quota history --days 7 --json": { ok: true, stdout: "[]", stderr: "" },
    });
    render(<ModelPage />);
    fireEvent.click(screen.getByRole("tab", { name: "来源" }));
    expect(await screen.findByText("订阅账号")).toBeInTheDocument();
    expect(screen.queryByText("额度走向")).not.toBeInTheDocument();
  });

  it("国内端的登录失效时，卡片直接说「重新登录」，不装作还有额度", async () => {    installBridge({}, {
      "accounts --json": {
        ok: true,
        stdout: JSON.stringify([
          { agent: "qoder", user: "me@example.com", alias: "阿里号", active: false, on: false, lapsed: "token expired" },
        ]),
        stderr: "",
      },
    });
    render(<ModelPage />);
    fireEvent.click(screen.getByRole("tab", { name: "来源" }));
    const name = await screen.findByText("Qoder");
    const card = name.closest("button");
    expect(card).not.toBeNull();
    expect(within(card as HTMLElement).getByText("登录已失效")).toBeInTheDocument();
    expect(within(card as HTMLElement).getByText("重新登录")).toBeInTheDocument();
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

  it("保存来源设置之后，余额卡与走向图也跟着重读（写命令会动到 Key 和限额）", async () => {
    const { calls } = installBridge();
    render(<ModelPage />);
    fireEvent.click(screen.getByRole("tab", { name: "来源" }));
    await screen.findByText("mock");
    fireEvent.click(screen.getByRole("button", { name: "高级" }));
    fireEvent.change(screen.getByLabelText("来源分发策略"), { target: { value: "rotate" } });
    fireEvent.change(screen.getByLabelText("错误处理"), { target: { value: "pass" } });
    calls.length = 0;
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));

    await waitFor(() =>
      expect(calls).toContainEqual(["provider", "set", "mock", "routing=rotate", "errors=pass"]),
    );
    expect(calls).toContainEqual(["quota", "--json"]);
    expect(calls).toContainEqual(["quota", "history", "--days", "7", "--json"]);
  });

  it("打开页面只读首屏要用的：来源专用的那几路等真进去再读", async () => {
    const { calls } = installBridge();
    render(<ModelPage />);
    await screen.findByText(/deepseek\/deepseek-chat/);

    for (const args of [
      ["quota", "--json"],
      ["quota", "history", "--days", "7", "--json"],
      ["quota", "auto-reset"],
      ["plugin", "list", "--json"],
      ["accounts", "discovery"],
    ]) {
      expect(calls).not.toContainEqual(args);
    }

    fireEvent.click(screen.getByRole("tab", { name: "来源" }));
    await waitFor(() => expect(calls).toContainEqual(["quota", "--json"]));
    expect(calls).toContainEqual(["quota", "auto-reset"]);
    expect(calls).toContainEqual(["plugin", "list", "--json"]);
    expect(calls).toContainEqual(["accounts", "discovery"]);
  });

  it("在模型分区点过「重读全部」之后，再进来源不再重复读一遍", async () => {
    const { calls } = installBridge();
    render(<ModelPage />);
    await screen.findByText(/deepseek\/deepseek-chat/);

    fireEvent.click(screen.getByRole("button", { name: /重读全部/ }));
    await waitFor(() => expect(calls).toContainEqual(["quota", "--json"]));

    calls.length = 0;
    fireEvent.click(screen.getByRole("tab", { name: "来源" }));
    await screen.findByText("订阅账号");
    expect(calls).not.toContainEqual(["quota", "--json"]);
    expect(calls).not.toContainEqual(["plugin", "list", "--json"]);
  });

  it("页头那个按钮真的重读整页：额度、走向、插件、设置都在里面", async () => {
    const { calls } = installBridge();
    render(<ModelPage />);
    await screen.findByText(/deepseek\/deepseek-chat/);

    calls.length = 0;
    fireEvent.click(screen.getByRole("button", { name: /重读全部/ }));

    await waitFor(() => expect(calls).toContainEqual(["quota", "history", "--days", "7", "--json"]));
    for (const args of [
      ["providers"],
      ["accounts", "--json"],
      ["quota", "--json"],
      ["plugin", "list", "--json"],
      ["settings", "list", "--json"],
      ["ls"],
      ["accounts", "discovery"],
    ]) {
      expect(calls).toContainEqual(args);
    }
    expect(await screen.findByText(/已重读全部：来源、账号、额度、走向与设置/)).toBeInTheDocument();
  });

  it("重读全部会先向各家重新问一遍额度，不吃内核那一分钟缓存", async () => {
    const { calls } = installBridge();
    render(<ModelPage />);
    await screen.findByText(/deepseek\/deepseek-chat/);

    calls.length = 0;
    fireEvent.click(screen.getByRole("button", { name: /重读全部/ }));

    // 订阅账号（claude）与 Key 的 provider（mock）都要问；问完才去读额度。
    await waitFor(() => expect(calls).toContainEqual(["quota", "refresh", "mock"]));
    expect(calls).toContainEqual(["quota", "refresh", "claude"]);
    expect(calls.findIndex((args) => args[0] === "quota" && args[1] === "refresh")).toBeLessThan(
      calls.findIndex((args) => args[0] === "quota" && args[1] === "--json"),
    );
  });

  it("订阅账号卡里不再有第二个「刷新」：整页只有页头一个重读入口", async () => {
    installBridge();
    render(<ModelPage />);
    fireEvent.click(await screen.findByRole("tab", { name: "来源" }));
    expect(await screen.findByText("订阅账号")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "刷新额度" })).toBeNull();
    // 签到是另一件事，留着。
    expect(screen.getByRole("button", { name: "今日签到" })).toBeInTheDocument();
  });

  it("重读时有一段没读到，提示条就把那一段说出来", async () => {
    installBridge({}, { "quota --json": { ok: false, stdout: "", stderr: "读额度超时\n" } });
    render(<ModelPage />);
    fireEvent.click(await screen.findByRole("button", { name: /重读全部/ }));

    expect(await screen.findByText("已重读，但其余额度这次没读到。")).toBeInTheDocument();
  });

  it("备用链直接写在来源行上，高级里能改也能清掉", async () => {
    const { calls } = installBridge(
      {},
      {
        providers: {
          ok: true,
          stdout:
            "  mock  custom  mock  127.0.0.1:39001  ● •••••••  1 models  \n" +
            "  ⤷ openrouter/deepseek-v3 → moonshot/kimi-k2  \n",
          stderr: "",
        },
      },
    );
    render(<ModelPage />);
    fireEvent.click(screen.getByRole("tab", { name: "来源" }));

    // 行上就有：不用展开高级才知道塌了会走谁。
    expect(
      await screen.findByText("备用 openrouter/deepseek-v3 → moonshot/kimi-k2"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "高级" }));
    expect(await screen.findByLabelText("备用模型")).toHaveValue(
      "openrouter/deepseek-v3, moonshot/kimi-k2",
    );

    fireEvent.click(screen.getByRole("button", { name: "清掉备用" }));
    await waitFor(() =>
      expect(calls).toContainEqual(["provider", "fallback", "mock", "none"]),
    );
  });

  it("点「测试」就在行上给结论：通过带耗时，失败写「连不上」", async () => {
    installBridge(
      {},
      { "provider test mock": { ok: true, stdout: "✓ mock · 1 model", stderr: "" } },
    );
    render(<ModelPage />);
    fireEvent.click(screen.getByRole("tab", { name: "来源" }));
    await screen.findByText("mock");

    fireEvent.click(screen.getByRole("button", { name: "测试" }));
    const passed = await screen.findByRole("status");
    expect(passed.textContent).toMatch(/^通过 · \d\.\d 秒$/);
    expect(passed.getAttribute("title")).toMatch(/连通正常/);
    expect(passed.className).toContain("text-success");
  });

  it("测试失败时行上写「连不上」，原因挂在悬停里", async () => {
    installBridge(
      {},
      { "provider test mock": { ok: false, stdout: "", stderr: "401 Unauthorized" } },
    );
    render(<ModelPage />);
    fireEvent.click(screen.getByRole("tab", { name: "来源" }));
    await screen.findByText("mock");

    fireEvent.click(screen.getByRole("button", { name: "测试" }));
    const failed = await screen.findByRole("status");
    expect(failed.textContent).toBe("连不上");
    expect(failed.getAttribute("title")).toContain("401 Unauthorized");
    expect(failed.className).toContain("text-danger");
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
        // 看图 / 画图这两项现在从这份表里读，不再各发一条 `settings get`。
        "settings list --json": {
          ok: true,
          stdout: JSON.stringify([
            { key: "vision", type: "string", value: "", default: "" },
            { key: "visionEffort", type: "string", value: "", default: "" },
            { key: "imageGen", type: "string", value: "relay/relay-draw", default: "" },
          ]),
          stderr: "",
        },
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

  it("看图与画图的那三项不另外发命令，一次 settings list 就够了", async () => {
    const { calls } = installBridge(
      {},
      {
        "settings list --json": {
          ok: true,
          stdout: JSON.stringify([
            { key: "vision", type: "string", value: "deepseek/deepseek-chat", default: "" },
            { key: "visionEffort", type: "string", value: "high", default: "" },
            { key: "imageGen", type: "string", value: "", default: "" },
          ]),
          stderr: "",
        },
      },
    );
    render(<ModelPage />);

    fireEvent.click(await screen.findByText("看图与画图模型"));
    await waitFor(() =>
      expect(screen.getByLabelText("看图模型")).toHaveValue("deepseek/deepseek-chat"),
    );
    await waitFor(() => expect(screen.getByLabelText("看图模型的思考档")).toHaveValue("high"));

    const perSettingGets = calls.filter(
      (args) => args[0] === "settings" && args[1] === "get",
    );
    expect(perSettingGets).toEqual([]);
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

  it("内核没起来时说「没读到」，不说成「还没有来源」——点重读就能接着看", async () => {
    const replies: Record<string, { ok: boolean; stdout: string; stderr: string }> = {
      providers: { ok: false, stdout: "", stderr: "模型服务没有启动\n" },
    };
    installBridge({}, replies);
    render(<ModelPage />);
    fireEvent.click(await screen.findByRole("tab", { name: "来源" }));

    expect(await screen.findByText(/这次没读到来源：模型服务没有启动/)).toBeInTheDocument();
    expect(screen.queryByText(/还没有来源/)).not.toBeInTheDocument();

    // 服务起来之后点「重新读一次」，那一行自己换成真来源。
    replies.providers = {
      ok: true,
      stdout: "  relay custom  mock  127.0.0.1:39001  ● •••••••  1 models  ",
      stderr: "",
    };
    fireEvent.click(screen.getByRole("button", { name: "重新读一次" }));

    expect(await screen.findByText(/relay/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(/这次没读到来源/)).not.toBeInTheDocument());
  });

  it("账号读不到时，卡片说「没读到」并给原因，而不是让人去登录一个账号", async () => {
    installBridge(
      {},
      { "accounts --json": { ok: false, stdout: "", stderr: "没有运行文件\n" } },
    );
    render(<ModelPage />);
    fireEvent.click(await screen.findByRole("tab", { name: "来源" }));

    expect(await screen.findByText(/这次没读到订阅账号：没有运行文件/)).toBeInTheDocument();
    expect(screen.queryByText(/还没有账号/)).not.toBeInTheDocument();
  });

  it("账号读不到但上次的读数还在时，卡片顶上先说「这次没读到，下面是上次的读数」", async () => {
    vi.stubEnv("MODE", "production");
    localStorage.setItem(
      "heming.modelpage.v2.accounts",
      JSON.stringify({
        at: Date.now(),
        text: JSON.stringify([
          { agent: "claude", user: "old@example.com", alias: "旧号", active: true, on: true, windows: [] },
        ]),
      }),
    );
    installBridge({}, { "accounts --json": { ok: false, stdout: "", stderr: "连不上\n" } });
    render(<ModelPage />);
    fireEvent.click(await screen.findByRole("tab", { name: "来源" }));

    expect(await screen.findByText("这次没读到，下面是上次的读数")).toBeInTheDocument();
    // 上一次的行照常画着，用户知道这是旧读数而不是空账号。
    expect(screen.getByText("旧号")).toBeInTheDocument();
  });

  it("其余额度读不到时，那张卡还在，并说明这次没读到", async () => {
    installBridge({}, { "quota --json": { ok: false, stdout: "", stderr: "读额度超时\n" } });
    render(<ModelPage />);
    fireEvent.click(await screen.findByRole("tab", { name: "来源" }));

    expect(await screen.findByRole("heading", { name: "其余来源的额度" })).toBeInTheDocument();
    expect(screen.getByText(/这次没读到其余额度：读额度超时/)).toBeInTheDocument();
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

