import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import type { Agent, User } from "@heming/shared";
import { ConversationTabs } from "./ConversationTabs.js";
import { ChatConvStrip } from "./ChatConvStrip.js";
import { useChatStore } from "../store/chat.js";
import { useUiStore, TABS_MAX } from "../store/ui.js";
import { clearDraft, setDraft } from "../lib/drafts.js";

const me: User = { id: "u1", username: "alice", displayName: "爱丽丝" };
const peer: User = { id: "u2", username: "li", displayName: "李四" };
const agent: Agent = {
  id: "a1",
  owner_id: null,
  name: "和小鸣",
  avatar: null,
  description: "官方",
};

/** 三种会话各一个 + 一个已从服务端消失的会话（验证占位不崩）。 */
const conversations = [
  { id: "c1", type: "direct", peer, unreadCount: 0 },
  { id: "g1", type: "group", name: "评审组", memberCount: 3, unreadCount: 2 },
  { id: "ca1", type: "agent", agent, unreadCount: 0 },
] as never;

beforeEach(() => {
  useChatStore.setState({ conversations });
  useUiStore.setState({
    page: "chat",
    activeConversationId: "c1",
    openTabs: ["c1", "g1", "ca1", "ghost"],
    navOrder: ["home", "workspace", "skills", "interfaces", "memory", "settings"],
    contactsHidden: true,
    detailContact: null,
    pendingAttachment: null,
  });
});

describe("openTabs 标签管理（store 层）", () => {
  it("openConversation 追加标签；重复打开移到最前且不重复", () => {
    useUiStore.setState({ openTabs: [] });
    useUiStore.getState().openConversation("c1");
    useUiStore.getState().openConversation("g1");
    expect(useUiStore.getState().openTabs).toEqual(["c1", "g1"]);
    // 再次打开 c1 → 移到末尾前一位（成为当前标签），不新增
    useUiStore.getState().openConversation("c1");
    expect(useUiStore.getState().openTabs).toEqual(["g1", "c1"]);
    expect(useUiStore.getState().activeConversationId).toBe("c1");
  });

  it("标签数超上限时丢弃最久未用的", () => {
    useUiStore.setState({ openTabs: [] });
    for (let i = 0; i < TABS_MAX + 3; i++) useUiStore.getState().openConversation(`c${i}`);
    const tabs = useUiStore.getState().openTabs;
    expect(tabs).toHaveLength(TABS_MAX);
    expect(tabs[tabs.length - 1]).toBe(`c${TABS_MAX + 2}`); // 最新的在最后
    expect(tabs).not.toContain("c0"); // 最旧的已被丢弃
  });

  it("关闭非当前标签只移除它，不动当前会话", () => {
    useUiStore.getState().closeConversationTab("g1");
    expect(useUiStore.getState().openTabs).toEqual(["c1", "ca1", "ghost"]);
    expect(useUiStore.getState().activeConversationId).toBe("c1");
  });

  it("关闭当前标签：退到左邻；关到不剩才离开聊天页", () => {
    // openConversation 会把刚打开的标签移到末尾（成为当前标签），
    // 所以 ca1 的左邻是它前面的 ghost，而不是最初的 c1。
    useUiStore.getState().closeConversationTab("g1"); // 先关掉中间那个
    useUiStore.getState().openConversation("ca1"); // 当前切到 ca1（移到末尾）
    expect(useUiStore.getState().openTabs).toEqual(["c1", "ghost", "ca1"]);
    useUiStore.getState().closeConversationTab("ca1"); // 关当前 → 退到左邻 ghost
    expect(useUiStore.getState().activeConversationId).toBe("ghost");
    useUiStore.getState().closeConversationTab("ghost");
    expect(useUiStore.getState().activeConversationId).toBe("c1"); // 再退到 c1
    useUiStore.getState().closeConversationTab("c1");
    expect(useUiStore.getState().page).toBe("workspace"); // 一个不剩才离开
  });

  it("切页保留标签（去设置页看一眼再回来会话还在）", () => {
    useUiStore.getState().setPage("settings");
    expect(useUiStore.getState().openTabs).toHaveLength(4);
    expect(useUiStore.getState().activeConversationId).toBeNull();
  });
});

describe("ConversationTabs 横向标签栏", () => {
  it("没有打开过会话时不渲染", () => {
    useUiStore.setState({ openTabs: [] });
    const { container } = render(<ConversationTabs />);
    expect(container).toBeEmptyDOMElement();
  });

  it("渲染全部标签：direct/group/agent 各自的名字都对", () => {
    render(<ConversationTabs />);
    expect(screen.getByRole("tab", { name: /李四/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /评审组/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /和小鸣/ })).toBeInTheDocument();
  });

  it("会话已消失的标签显示占位而不是崩", () => {
    render(<ConversationTabs />);
    expect(screen.getByRole("tab", { name: /已失效会话/ })).toBeInTheDocument();
  });

  it("横向标签补未读角标：数字可见，tab 的 aria-label 带「N 条未读」", () => {
    render(<ConversationTabs />);
    const tab = screen.getByRole("tab", { name: "评审组 2 条未读" });
    expect(tab.textContent).toContain("2");
    // 无未读的标签不加多余文案
    expect(screen.getByRole("tab", { name: "李四" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "和小鸣" })).toBeInTheDocument();
  });

  it("当前会话的标签带 aria-selected，点标签切会话", () => {
    render(<ConversationTabs />);
    expect(screen.getByRole("tab", { name: /李四/ })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("button", { name: "切换到 评审组" }));
    expect(useUiStore.getState().activeConversationId).toBe("g1");
  });

  it("点 × 只关该标签，不会连带切进去（不冒泡到切换）", () => {
    render(<ConversationTabs />);
    fireEvent.click(screen.getByRole("button", { name: "关闭 评审组 标签" }));
    expect(useUiStore.getState().openTabs).toEqual(["c1", "ca1", "ghost"]);
    expect(useUiStore.getState().activeConversationId).toBe("c1"); // 没被切走
  });
});

describe("ChatConvStrip 左侧头像缩略列", () => {
  it("没有打开过会话时不渲染", () => {
    useUiStore.setState({ openTabs: [] });
    const { container } = render(<ChatConvStrip />);
    expect(container).toBeEmptyDOMElement();
  });

  it("每个打开过的会话一个头像，点一下即切换", () => {
    render(<ChatConvStrip />);
    const lisi = screen.getByRole("button", { name: "切换到 李四" });
    const group = screen.getByRole("button", { name: "切换到 评审组 2 条未读" });
    expect(lisi).toHaveAttribute("aria-current", "true");
    fireEvent.click(group);
    expect(useUiStore.getState().activeConversationId).toBe("g1");
  });

  it("未读数显示为角标（取会话 unreadCount）", () => {
    render(<ChatConvStrip />);
    const group = screen.getByRole("button", { name: "切换到 评审组 2 条未读" });
    expect(group.textContent).toContain("2");
  });
});

describe("草稿标记（标签栏 + 缩略列）", () => {
  it("有草稿的会话在标签与缩略列上都有标记", () => {
    setDraft("c1", "没发完的话");
    const view = render(
      <>
        <ConversationTabs />
        <ChatConvStrip />
      </>,
    );
    try {
      // 标签（role=tab）与缩略列（button）各自在自己的无障碍名里带「有草稿」
      expect(screen.getByRole("tab", { name: "李四 有草稿" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "切换到 李四 有草稿" })).toBeInTheDocument();
      // 没有草稿的会话不带多余文案
      expect(screen.getByRole("tab", { name: "评审组 2 条未读" })).toBeInTheDocument();
    } finally {
      view.unmount();
      clearDraft("c1");
    }
  });

  it("挂载后写草稿：标签与缩略列的标记即时出现，清掉后消失", () => {
    render(
      <>
        <ConversationTabs />
        <ChatConvStrip />
      </>,
    );
    try {
      expect(screen.queryByRole("tab", { name: /李四.*有草稿/ })).not.toBeInTheDocument();

      act(() => {
        setDraft("c1", "临时草稿");
      });
      const tab = screen.getByRole("tab", { name: /李四.*有草稿/ });
      expect(tab.querySelector('span[title="有草稿"]')).not.toBeNull(); // 可视圆点
      expect(screen.getByRole("button", { name: /切换到 李四.*有草稿/ })).toBeInTheDocument();

      act(() => {
        clearDraft("c1");
      });
      expect(screen.queryByRole("tab", { name: /李四.*有草稿/ })).not.toBeInTheDocument();
    } finally {
      act(() => {
        clearDraft("c1"); // 断言中途失败也清掉，避免串用例
      });
    }
  });
});