import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SYSTEM_AGENT_ID } from "@heming/shared";
import { startNewConversation, startNewConversationIn } from "../newConversation.js";
import { useChatStore } from "../../store/chat.js";
import { useUiStore } from "../../store/ui.js";

/** 「新建并打开会话」的三步顺序与工作区透传（d.147.4.91.11）。 */
describe("newConversation · 工作区", () => {
  beforeEach(() => {
    useUiStore.setState({ page: "settings", activeConversationId: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("startNewConversationIn：建会话带 workspace → 切会话页 → 选中新会话", async () => {
    const openAgent = vi.fn(async () => "c9");
    useChatStore.setState({ openAgent } as never);

    await startNewConversationIn("D:/项目/和鸣");

    expect(openAgent).toHaveBeenCalledWith(SYSTEM_AGENT_ID, {
      fresh: true,
      workspace: "D:/项目/和鸣",
    });
    expect(useUiStore.getState().page).toBe("chat");
    expect(useUiStore.getState().activeConversationId).toBe("c9");
  });

  it("startNewConversation：走未分组，不带 workspace 字段", async () => {
    // 显式声明参数，否则 mock.calls[0] 是空元组，取 [1] 会 TS2493。
    const openAgent = vi.fn(
      async (_agentId: string, _options?: { fresh?: boolean; workspace?: string }) => "c9",
    );
    useChatStore.setState({ openAgent } as never);

    await startNewConversation();

    expect(openAgent).toHaveBeenCalledWith(SYSTEM_AGENT_ID, { fresh: true });
    const options = openAgent.mock.calls[0]?.[1];
    expect(options).not.toHaveProperty("workspace");
    expect(useUiStore.getState().page).toBe("chat");
    expect(useUiStore.getState().activeConversationId).toBe("c9");
  });

  it("必须先建会话再切页：建会话未落定前不切页", async () => {
    let resolveOpen!: (id: string) => void;
    const openAgent = vi.fn(
      () => new Promise<string>((resolve) => (resolveOpen = resolve)),
    );
    useChatStore.setState({ openAgent } as never);

    const pending = startNewConversationIn(null);
    await Promise.resolve();

    // 顺序纪律：setPage("chat") 会清 activeConversationId，所以不能先切页
    expect(useUiStore.getState().page).toBe("settings");
    expect(useUiStore.getState().activeConversationId).toBeNull();

    resolveOpen("c9");
    await pending;

    expect(useUiStore.getState().page).toBe("chat");
    expect(useUiStore.getState().activeConversationId).toBe("c9");
  });

  it("建会话失败：抛出原错误，页面与选中都不动", async () => {
    const openAgent = vi.fn(async () => {
      throw new Error("建会话失败");
    });
    useChatStore.setState({ openAgent } as never);

    await expect(startNewConversationIn("D:/项目/和鸣")).rejects.toThrow("建会话失败");
    expect(useUiStore.getState().page).toBe("settings");
    expect(useUiStore.getState().activeConversationId).toBeNull();
  });
});
