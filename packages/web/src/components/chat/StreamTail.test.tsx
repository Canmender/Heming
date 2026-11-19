import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { StreamTail } from "../ChatPage.js";
import { useChatStore } from "../../store/chat.js";

/**
 * d.372：正文逐帧更新只重渲染 `StreamTail` 这一小块。
 *
 * 这里锁两件事：气泡真的跟着 store 走（每次增量都通往屏幕上）、以及长高时只调
 * `onGrow`（父组件不再因为正文变化被重渲染）。
 */
describe("StreamTail（d.372 流式订阅下沉）", () => {
  const seed = (text: string) => {
    useChatStore.setState({
      streaming: {
        s1: {
          agentId: "a1",
          conversationId: "c1",
          text,
          status: "streaming",
        },
      },
      streamOwner: { s1: true },
    });
  };

  it("只渲染本会话的气泡，正文增量直接反映到屏幕", () => {
    seed("第一段");
    useChatStore.setState((s) => ({
      streaming: {
        ...s.streaming,
        s2: { agentId: "a2", conversationId: "c2", text: "别的会话", status: "streaming" },
      },
    }));
    const onGrow = vi.fn();
    render(
      <StreamTail
        convId="c1"
        nameOf={() => "和小鸣"}
        marksRef={{ current: {} }}
        onGrow={onGrow}
        onRetry={() => {}}
      />,
    );
    expect(screen.getByText(/第一段/)).toBeInTheDocument();
    expect(screen.queryByText(/别的会话/)).not.toBeInTheDocument();

    act(() => {
      seed("第一段，又长了一句");
    });
    expect(screen.getByText(/又长了一句/)).toBeInTheDocument();
  });

  it("长高时调 onGrow，正文不变时不重复调", () => {
    seed("开头");
    const onGrow = vi.fn();
    render(
      <StreamTail
        convId="c1"
        nameOf={() => "和小鸣"}
        marksRef={{ current: {} }}
        onGrow={onGrow}
        onRetry={() => {}}
      />,
    );
    expect(onGrow).toHaveBeenCalledTimes(1);
    act(() => {
      seed("开头多几个字");
    });
    expect(onGrow).toHaveBeenCalledTimes(2);
    act(() => {
      seed("开头多几个字");
    });
    expect(onGrow).toHaveBeenCalledTimes(2);
  });
});
