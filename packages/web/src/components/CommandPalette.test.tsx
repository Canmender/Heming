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

/**
 * 命令面板 v2（d.60）的行为用例。
 *
 * 覆盖：空查询三分组、输入检索、四个动作的分发（断言调用了正确的 store）、
 * 键盘 ↑↓/Enter/Esc（含 preventDefault 不滚动页面）、结果项 a11y 口径、
 * 最近使用落盘与再次打开时置顶。
 */

const OPTION = (name: string) => screen.getByRole("option", { name: `选择 ${name}` });
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
    // 13 个页面 + 4 个动作
    expect(screen.getAllByRole("option")).toHaveLength(17);
    // 没有最近使用时不出现该组标题
    expect(screen.queryByText("最近使用")).not.toBeInTheDocument();
  });

  it("页面项标注 Alt 快捷键，无快捷键的页面不标注", () => {
    render(<CommandPalette onClose={vi.fn()} />);
    expect(OPTION("主页").textContent).toContain("Alt+1");
    expect(OPTION("插件区").textContent).toContain("Alt+0");
    expect(OPTION("团队").textContent).not.toContain("Alt+");
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
    fireEvent.change(searchBox(), { target: { value: "记忆区" } });
    fireEvent.click(OPTION("记忆区"));
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
    const row = await screen.findByRole("option", { name: "选择 免检单讨论组" });
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

  it("新建任务 → 切到任务区（常驻启动面板）", () => {
    const onClose = vi.fn();
    render(<CommandPalette onClose={onClose} />);
    fireEvent.click(OPTION("新建任务"));
    expect(useUiStore.getState().page).toBe("tasks");
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

  it("连续两次「新智能体」意图的 token 不同（不会被合并成一次）", () => {
    render(<CommandPalette onClose={vi.fn()} />);
    // 点过一次后该动作会同时出现在「最近使用」与「常用动作」两组里，取第一条即可
    fireEvent.click(OPTION("新建智能体"));
    const first = useUiStore.getState().paletteIntent;
    fireEvent.click(screen.getAllByRole("option", { name: "选择 新建智能体" })[0]);
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
    fireEvent.click(OPTION("设置区"));
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
    const row = await screen.findByRole("option", { name: "选择 Alice" });
    fireEvent.click(row);
    expect(localStorage.getItem(RECENT_KEY)).toBeNull();
    view.unmount();
  });
});
