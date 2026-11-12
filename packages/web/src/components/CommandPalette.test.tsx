import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { CommandPalette } from "./CommandPalette.js";
import { useUiStore } from "../store/ui.js";
import { useInfohubStore } from "../lib/infohub/store.js";
import { fetchTeam } from "../lib/api.js";
import { RECENT_KEY } from "../lib/palette/recent.js";

// 面板挂载即预取团队名册；单测里给桩，避免去打真实网络。
vi.mock("../lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api.js")>();
  return { ...actual, fetchTeam: vi.fn() };
});

// 本机三组（任务/记忆/插件）在面板挂载时读一次快照：单测里换成可控数据。
// 只覆盖 readLocalSnapshot，检索函数仍走真实实现（searchLocal* 是纯函数）。
const localSnapshot = vi.hoisted(() => ({
  current: { tasks: [] as unknown[], memories: [] as unknown[], plugins: [] as unknown[] },
}));
vi.mock("../lib/palette/local.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/palette/local.js")>();
  return { ...actual, readLocalSnapshot: () => localSnapshot.current };
});

/**
 * 命令面板 v2（d.60）的行为用例。
 *
 * 覆盖：空查询三分组、输入检索、五个动作的分发（断言调用了正确的 store）、
 * 键盘 ↑↓/Enter/Esc（含 preventDefault 不滚动页面）、结果项 a11y 口径、
 * 最近使用落盘与再次打开时置顶。
 */

// d.138：选项的可访问名就是条目名（另一会话把 aria-label 从「选择 X」改成了 X）。
const OPTION = (name: string) => screen.getByRole("option", { name });
const searchBox = () => screen.getByLabelText("搜索页面、动作与成员");

function resetStores() {
  localStorage.clear();
  useUiStore.setState({
    page: "home",
    activeConversationId: null,
    settingsTab: null,
    paletteIntent: null,
    taskDraft: null,
    taskFocusId: null,
    teamFocusUserId: null,
    infohubIntent: null,
    automationIntent: null,
  });
}

describe("命令面板 v2 · 空查询分组", () => {
  beforeEach(() => {
    resetStores();
    vi.mocked(fetchTeam).mockReset();
    vi.mocked(fetchTeam).mockResolvedValue({ members: [], onlineCount: 0 });
    useInfohubStore.setState({ available: false, running: false, booted: true, error: "" });
  });
  afterEach(() => cleanup());

  it("展示「页面跳转」与「常用动作」两组，且每组内类型单一", () => {
    render(<CommandPalette onClose={vi.fn()} />);
    expect(screen.getByText("页面跳转")).toBeInTheDocument();
    expect(screen.getByText("常用动作")).toBeInTheDocument();
    // 8 个导航页 + 9 个动作（模型路由页与模块 Tab 已删除；模块并入插件页）
    expect(screen.getAllByRole("option")).toHaveLength(17);
    // 没有最近使用时不出现该组标题
    expect(screen.queryByText("最近使用")).not.toBeInTheDocument();
  });

  it("页面项标注 Alt 快捷键，无快捷键的页面不标注", () => {
    render(<CommandPalette onClose={vi.fn()} />);
    expect(OPTION("主页").textContent).toContain("Alt+1");
    expect(OPTION("插件").textContent).toContain("Alt+0");
    // 知识库没有数字键（2 已给团队、8 已给智能体）
    expect(OPTION("知识库").textContent).not.toContain("Alt+");
  });

  it("结果项是 option，首项默认 aria-selected，输入框用 aria-activedescendant 指向它", () => {
    render(<CommandPalette onClose={vi.fn()} />);
    const options = screen.getAllByRole("option");
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    expect(options[1]).toHaveAttribute("aria-selected", "false");
    const active = searchBox().getAttribute("aria-activedescendant");
    expect(active).toBe(options[0].id);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("唤起即把焦点放在搜索框", async () => {
    render(<CommandPalette onClose={vi.fn()} />);
    await waitFor(() => expect(document.activeElement).toBe(searchBox()));
  });

  it("重新打开是「重新开始」：上次查询词清空，且输入框获得焦点并全选", async () => {
    const first = render(<CommandPalette onClose={vi.fn()} />);
    fireEvent.change(searchBox(), { target: { value: "记忆" } });
    expect(searchBox()).toHaveValue("记忆");
    first.unmount();

    render(<CommandPalette onClose={vi.fn()} />);
    const input = searchBox() as HTMLInputElement;
    expect(input).toHaveValue(""); // 面板关闭即卸载，重开从头开始
    await waitFor(() => expect(document.activeElement).toBe(input));
    // 全选：光标区间覆盖整个输入值（空值时即 0/0，非空时一打字就覆盖）
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
  });

  it("未连接信息中枢时给出归档能力说明，但不发请求", () => {
    const call = vi.fn();
    (window as unknown as { __heming_infohub?: unknown }).__heming_infohub = { call };
    render(<CommandPalette onClose={vi.fn()} />);
    expect(screen.getByText(/连接信息中枢后/)).toBeInTheDocument();
    expect(call).not.toHaveBeenCalled();
    delete (window as unknown as { __heming_infohub?: unknown }).__heming_infohub;
  });
});

describe("命令面板 v2 · 键盘", () => {
  beforeEach(() => {
    resetStores();
    vi.mocked(fetchTeam).mockReset();
    vi.mocked(fetchTeam).mockResolvedValue({ members: [], onlineCount: 0 });
    useInfohubStore.setState({ available: false, running: false, booted: true, error: "" });
  });
  afterEach(() => cleanup());

  it("↑↓ 移动选中项，并且 preventDefault（不滚动页面）", () => {
    render(<CommandPalette onClose={vi.fn()} />);
    const options = screen.getAllByRole("option");

    // fireEvent 返回 false 表示事件被 preventDefault 了
    expect(fireEvent.keyDown(searchBox(), { key: "ArrowDown" })).toBe(false);
    expect(options[1]).toHaveAttribute("aria-selected", "true");
    expect(options[0]).toHaveAttribute("aria-selected", "false");

    fireEvent.keyDown(searchBox(), { key: "ArrowUp" });
    expect(options[0]).toHaveAttribute("aria-selected", "true");
  });

  it("↓ 到底部回环到第一项（不会卡住）", () => {
    render(<CommandPalette onClose={vi.fn()} />);
    const total = screen.getAllByRole("option").length;
    for (let i = 0; i < total; i += 1) {
      fireEvent.keyDown(searchBox(), { key: "ArrowDown" });
    }
    expect(screen.getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");
  });

  it("Home / End 跳到首项与末项", () => {
    render(<CommandPalette onClose={vi.fn()} />);
    const options = screen.getAllByRole("option");
    fireEvent.keyDown(searchBox(), { key: "End" });
    expect(options[options.length - 1]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(searchBox(), { key: "Home" });
    expect(options[0]).toHaveAttribute("aria-selected", "true");
  });

  it("Enter 执行当前项并关闭面板", () => {
    const onClose = vi.fn();
    render(<CommandPalette onClose={onClose} />);
    // 首项是「主页」
    fireEvent.keyDown(searchBox(), { key: "Enter" });
    expect(useUiStore.getState().page).toBe("home");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Esc 关闭面板", () => {
    const onClose = vi.fn();
    render(<CommandPalette onClose={onClose} />);
    fireEvent.keyDown(searchBox(), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("命令面板 v2 · 检索", () => {
  beforeEach(() => {
    resetStores();
    vi.mocked(fetchTeam).mockReset();
    vi.mocked(fetchTeam).mockResolvedValue({ members: [], onlineCount: 0 });
    useInfohubStore.setState({ available: false, running: false, booted: true, error: "" });
  });
  afterEach(() => cleanup());

  it("按页面名检索并跳转", () => {
    const onClose = vi.fn();
    render(<CommandPalette onClose={onClose} />);
    fireEvent.change(searchBox(), { target: { value: "记忆" } });
    fireEvent.click(OPTION("记忆"));
    expect(useUiStore.getState().page).toBe("memory");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("按设置分区检索并直达该分区", () => {
    render(<CommandPalette onClose={vi.fn()} />);
    fireEvent.change(searchBox(), { target: { value: "主题" } });
    fireEvent.click(OPTION("外观"));
    expect(useUiStore.getState().page).toBe("settings");
    expect(useUiStore.getState().settingsTab).toBe("appearance");
  });

  it("没有命中时给明确空态", () => {
    render(<CommandPalette onClose={vi.fn()} />);
    fireEvent.change(searchBox(), { target: { value: "zzzz-not-exist" } });
    expect(screen.getByText(/没有匹配/)).toBeInTheDocument();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });

  it("成员检索沿用旧口径（能搜到并聚焦成员）", async () => {
    vi.mocked(fetchTeam).mockResolvedValue({
      members: [
        { user: { id: "u9", username: "mianjian", displayName: "免检单讨论组" }, lastSeenAt: null, online: true },
      ],
      onlineCount: 1,
    });
    render(<CommandPalette onClose={vi.fn()} />);
    fireEvent.change(searchBox(), { target: { value: "免检单" } });
    const row = await screen.findByRole("option", { name: "免检单讨论组" });
    expect(row.textContent).toContain("团队");
    fireEvent.click(row);
    expect(useUiStore.getState()).toMatchObject({ page: "team", teamFocusUserId: "u9" });
  });
});

describe("命令面板 v2 · 四个动作的分发", () => {
  beforeEach(() => {
    resetStores();
    vi.mocked(fetchTeam).mockReset();
    vi.mocked(fetchTeam).mockResolvedValue({ members: [], onlineCount: 0 });
    useInfohubStore.setState({ available: false, running: false, booted: true, error: "" });
  });
  afterEach(() => cleanup());

  it("新建任务 → 切到团队页看板（任务已经长在团队页里）", () => {
    const onClose = vi.fn();
    render(<CommandPalette onClose={onClose} />);
    fireEvent.click(OPTION("新建任务"));
    // d.138：tasks 旧页面折叠目标从 chat/tasks 改成 team/board——对话页不认 tasks 视图，
    // 原来点完停在对话 Tab，看起来像没反应。
    expect(useUiStore.getState().page).toBe("team");
    expect(useUiStore.getState().pageView).toBe("board");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("新建智能体 → 投 agent-create 意图 + 切到智能体页", () => {
    render(<CommandPalette onClose={vi.fn()} />);
    fireEvent.click(OPTION("新建智能体"));
    const s = useUiStore.getState();
    expect(s.page).toBe("chat");
    expect(s.paletteIntent).toMatchObject({ kind: "agent-create" });
    expect(typeof s.paletteIntent?.token).toBe("number");
  });

  it("打开通知中心 → 只投 notifications 意图（不切页）", () => {
    render(<CommandPalette onClose={vi.fn()} />);
    fireEvent.click(OPTION("打开通知中心"));
    const s = useUiStore.getState();
    expect(s.paletteIntent).toMatchObject({ kind: "notifications" });
    expect(s.page).toBe("home");
  });

  it("打开设置 → 切到设置页（不带分区）", () => {
    render(<CommandPalette onClose={vi.fn()} />);
    fireEvent.click(OPTION("打开设置"));
    expect(useUiStore.getState().page).toBe("settings");
    expect(useUiStore.getState().settingsTab).toBeNull();
  });

  it("「插件管理」→ 插件页 + 插件 Tab 意图（旧模块页入口也落到这里）", () => {
    render(<CommandPalette onClose={vi.fn()} />);
    fireEvent.click(OPTION("插件管理"));
    const s = useUiStore.getState();
    expect(s.page).toBe("plugins");
    expect(s.pageView).toBe("plugins");
  });

  it("「插件管理」动作跳插件页（动作文案不再带模块启用计数）", () => {
    render(<CommandPalette onClose={vi.fn()} />);
    expect(screen.getByRole("option", { name: "插件管理" })).toBeInTheDocument();
  });

  it("搜「插件」能命中「插件管理」动作（此前一条结果都没有）", async () => {
    render(<CommandPalette onClose={vi.fn()} />);
    fireEvent.change(searchBox(), { target: { value: "插件" } });
    expect(await screen.findByRole("option", { name: "插件管理" })).toBeInTheDocument();
  });

  it("连续两次「新智能体」意图的 token 不同（不会被合并成一次）", () => {
    render(<CommandPalette onClose={vi.fn()} />);
    // 点过一次后该动作会同时出现在「最近使用」与「常用动作」两组里，取第一条即可
    fireEvent.click(OPTION("新建智能体"));
    const first = useUiStore.getState().paletteIntent;
    fireEvent.click(screen.getAllByRole("option", { name: "新建智能体" })[0]);
    const second = useUiStore.getState().paletteIntent;
    expect(second?.kind).toBe("agent-create");
    expect(second!.token).not.toBe(first!.token);
  });

  it("执行任一项后都会关闭面板（行为统一可预期）", () => {
    const onClose = vi.fn();
    render(<CommandPalette onClose={onClose} />);
    fireEvent.click(OPTION("打开设置"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("命令面板 v2 · 最近使用", () => {
  beforeEach(() => {
    resetStores();
    vi.mocked(fetchTeam).mockReset();
    vi.mocked(fetchTeam).mockResolvedValue({ members: [], onlineCount: 0 });
    useInfohubStore.setState({ available: false, running: false, booted: true, error: "" });
  });
  afterEach(() => cleanup());

  it("执行页面跳转后落盘，下次打开在「最近使用」组置顶", () => {
    const first = render(<CommandPalette onClose={vi.fn()} />);
    fireEvent.click(OPTION("设置"));
    expect(JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]")).toEqual([
      { kind: "page", id: "settings" },
    ]);
    first.unmount();

    render(<CommandPalette onClose={vi.fn()} />);
    expect(screen.getByText("最近使用")).toBeInTheDocument();
    // 最近使用在页面跳转组之前
    const labels = screen.getAllByText(/最近使用|页面跳转/).map((el) => el.textContent);
    expect(labels[0]).toBe("最近使用");
  });

  it("只记页面/设置/动作三类：执行成员/技能不写最近使用", async () => {
    vi.mocked(fetchTeam).mockResolvedValue({
      members: [
        { user: { id: "u9", username: "alice", displayName: "Alice" }, lastSeenAt: null, online: true },
      ],
      onlineCount: 1,
    });
    const view = render(<CommandPalette onClose={vi.fn()} />);
    fireEvent.change(searchBox(), { target: { value: "Alice" } });
    const row = await screen.findByRole("option", { name: "Alice" });
    fireEvent.click(row);
    expect(localStorage.getItem(RECENT_KEY)).toBeNull();
    view.unmount();
  });
});

describe("命令面板 · 本机三组（任务 / 记忆 / 插件）", () => {
  const taskFixture = {
    id: "t1",
    conversationId: "c1",
    agentId: "a1",
    agentName: "阿和",
    title: "整理周报",
    prompt: "把本周材料整理成周报",
    status: "done",
    createdAt: 0,
    updatedAt: 0,
    result: "本周完成 3 项",
    steps: [],
  };
  const memoryFixture = {
    kind: "memory",
    id: "m1",
    name: "语义 · 称呼",
    detail: "用户希望被称为阿和",
    layer: "semantic",
  };
  const pluginFixture = {
    manifest: {
      schemaVersion: 2,
      id: "acme.weather",
      name: "天气能力包",
      version: "1.0.0",
      description: "出行天气建议与查询服务",
      author: "Acme",
      skills: [{ name: "出行建议", instructions: "x", triggers: [], tags: [], description: "" }],
      mcpServers: [],
    },
    enabled: true,
    skillIds: [],
    serverIds: [],
    installedAt: "",
    updatedAt: "",
  };

  beforeEach(() => {
    resetStores();
    vi.mocked(fetchTeam).mockReset();
    vi.mocked(fetchTeam).mockResolvedValue({ members: [], onlineCount: 0 });
    useInfohubStore.setState({ available: false, running: false, booted: true, error: "" });
    localSnapshot.current = {
      tasks: [taskFixture],
      memories: [memoryFixture],
      plugins: [pluginFixture],
    };
  });
  afterEach(() => {
    cleanup();
    localSnapshot.current = { tasks: [], memories: [], plugins: [] };
  });

  it("任务命中 → 结果出现「任务」组，点击切任务区并带上定位 id", () => {
    const onClose = vi.fn();
    render(<CommandPalette onClose={onClose} />);
    fireEvent.change(searchBox(), { target: { value: "周报" } });
    expect(screen.getByText("任务")).toBeInTheDocument();
    fireEvent.click(OPTION("整理周报"));
    const s = useUiStore.getState();
    expect(s.page).toBe("chat");
    expect(s.pageView).toBe("tasks");
    expect(s.taskFocusId).toBe("t1");
    // 复用 focusTask 时会连带聚焦该任务的会话
    expect(s.activeConversationId).toBe("c1");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("记忆命中 → 投 focus-memory 意图并切记忆区", () => {
    render(<CommandPalette onClose={vi.fn()} />);
    fireEvent.change(searchBox(), { target: { value: "阿和" } });
    expect(screen.getByText("记忆")).toBeInTheDocument();
    fireEvent.click(OPTION("语义 · 称呼"));
    const s = useUiStore.getState();
    expect(s.page).toBe("memory");
    expect(s.paletteIntent).toMatchObject({ kind: "focus-memory", data: { memoryId: "m1", layer: "semantic" } });
  });

  it("插件命中 → 投 open-plugin 意图并切插件区", () => {
    render(<CommandPalette onClose={vi.fn()} />);
    fireEvent.change(searchBox(), { target: { value: "天气" } });
    expect(screen.getByText("插件")).toBeInTheDocument();
    fireEvent.click(OPTION("天气能力包"));
    const s = useUiStore.getState();
    expect(s.page).toBe("plugins");
    expect(s.paletteIntent).toMatchObject({ kind: "open-plugin", data: { id: "acme.weather" } });
  });

  it("三组同屏时顺序固定：任务 → 记忆 → 插件", () => {
    localSnapshot.current = {
      tasks: [taskFixture],
      memories: [{ ...memoryFixture, name: "语义 · 周报偏好", detail: "用户喜欢周报" }],
      plugins: [{ ...pluginFixture, manifest: { ...pluginFixture.manifest, name: "周报工具包" } }],
    };
    render(<CommandPalette onClose={vi.fn()} />);
    fireEvent.change(searchBox(), { target: { value: "周报" } });
    const labels = ["任务", "记忆", "插件"].map((t) => screen.getByText(t));
    // getByText 按文档顺序返回，这里断言三个标题在 DOM 里的相对顺序
    const order = labels.map((el) => Array.from(el.parentElement!.parentElement!.children).indexOf(el.parentElement!));
    expect(order[0]).toBeLessThan(order[1]);
    expect(order[1]).toBeLessThan(order[2]);
  });

  it("本机命中超过上限时显示「还有 N 条」", () => {
    localSnapshot.current = {
      tasks: Array.from({ length: 8 }, (_, i) => ({ ...taskFixture, id: `t${i}`, title: `周报 ${i}` })),
      memories: [],
      plugins: [],
    };
    render(<CommandPalette onClose={vi.fn()} />);
    fireEvent.change(searchBox(), { target: { value: "周报" } });
    expect(screen.getByText("还有 3 条")).toBeInTheDocument(); // 8 - 5
  });

  it("本机结果不携带报告正文（面板项文本只到截断后的 detail）", async () => {
    render(<CommandPalette onClose={vi.fn()} />);
    fireEvent.change(searchBox(), { target: { value: "周报" } });
    const row = await screen.findByRole("option", { name: "整理周报" });
    expect(row.textContent).not.toContain("本周完成 3 项");
  });
});

describe("命令面板 · 焦点可见性", () => {
  beforeEach(() => {
    resetStores();
    vi.mocked(fetchTeam).mockReset();
    vi.mocked(fetchTeam).mockResolvedValue({ members: [], onlineCount: 0 });
    useInfohubStore.setState({ available: false, running: false, booted: true, error: "" });
  });
  afterEach(() => cleanup());

  it("焦点环画在面板上（has-[:focus-visible]，仅键盘），输入框只保留高对比模式可见性", () => {
    render(<CommandPalette onClose={vi.fn()} />);
    const panel = screen.getByRole("dialog", { name: "命令面板" });
    const input = searchBox();
    // 输入框不能写 outline:none——那会连 Windows 高对比模式的焦点也抹掉（v4 outline-hidden 语义）
    expect(input.style.outline).toBe("2px solid transparent");
    // 面板的环只在 :focus-visible（键盘）时出现：鼠标打开面板不会常驻一圈黑框
    expect(panel.className).toContain("has-[:focus-visible]:outline-2");
    expect(panel.className).toContain("has-[:focus-visible]:outline-ink");
  });
});

describe("命令面板 · 知识库（d.114）", () => {
  beforeEach(() => {
    resetStores();
    useUiStore.setState({ vaultIntent: null });
    vi.mocked(fetchTeam).mockReset();
    vi.mocked(fetchTeam).mockResolvedValue({ members: [], onlineCount: 0 });
    useInfohubStore.setState({ available: false, running: false, booted: true, error: "" });
  });
  afterEach(async () => {
    cleanup();
    const { useVaultStore } = await import("../lib/vault/store.js");
    useVaultStore.setState({ index: null });
    useUiStore.setState({ vaultIntent: null });
  });

  it("四个知识库动作：切到知识库页并投递对应 vaultIntent", async () => {
    const cases: { query: string; label: string; kind: string }[] = [
      { query: "新建笔记", label: "新建笔记", kind: "new" },
      { query: "打开今天的日记", label: "打开今天的日记", kind: "daily" },
      { query: "新建画布", label: "新建画布", kind: "canvas" },
      { query: "知识库设置", label: "知识库设置", kind: "settings" },
    ];
    for (const item of cases) {
      const view = render(<CommandPalette onClose={vi.fn()} />);
      fireEvent.change(searchBox(), { target: { value: item.query } });
      fireEvent.click(await screen.findByRole("option", { name: `${item.label}` }));
      expect(useUiStore.getState().page).toBe("vault");
      expect(useUiStore.getState().vaultIntent?.kind).toBe(item.kind);
      view.unmount();
      useUiStore.setState({ page: "home", vaultIntent: null });
    }
  });

  it("知识库索引就绪时出「知识库笔记」组，点选投递 open 意图", async () => {
    const { useVaultStore } = await import("../lib/vault/store.js");
    const index = {
      pages: new Map([
        [
          "notes/会议记录.md",
          {
            rel: "notes/会议记录.md",
            title: "会议记录",
            aliases: [],
            tags: [],
            headings: [],
            mtime: "2026-11-08T08:00:00.000Z",
            hash: "h",
            frontmatter: {},
            body: "",
          },
        ],
      ]),
      links: [],
      backlinks: new Map(),
      unresolved: [],
      tags: new Map(),
      orphans: [],
      ambiguous: new Map(),
    } as never;
    useVaultStore.setState({ index });
    render(<CommandPalette onClose={vi.fn()} />);
    fireEvent.change(searchBox(), { target: { value: "会议" } });
    const group = await screen.findByRole("group", { name: "知识库笔记" });
    expect(group).toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: "会议记录" }));
    expect(useUiStore.getState().page).toBe("vault");
    expect(useUiStore.getState().vaultIntent).toMatchObject({
      kind: "open",
      rel: "notes/会议记录.md",
    });
  });
});
