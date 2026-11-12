import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PluginHomeCards } from "./PluginHomeCards.js";
import {
  resetPluginHomeCards,
  type PluginHomeCard,
  type PluginsBridge,
} from "../../lib/plugins/homeCards.js";
import { useUiStore } from "../../store/ui.js";

/**
 * 首页插件卡片区块（d.125）：
 * - 浏览器/旧桌面端没有 `window.__heming_plugins` → 整块不渲染（不留空壳与假入口）；
 * - 有桥 → 渲染宿主返回的卡片，点击按 card.page 跳转；
 * - 插件 `homeCardSet()` 推送 → 卡片文案就地更新（不重新拉列表）。
 * 卡片数据来自宿主（已安装 + 已启用 + 文件完好），这里不重复判断插件状态。
 */

function card(overrides: Partial<PluginHomeCard> = {}): PluginHomeCard {
  return {
    pluginId: "heming.infohub",
    pluginName: "信息中枢",
    id: "archive",
    title: "信息中枢",
    summary: "本机 QQ / 微信聊天记录与日程",
    icon: "grid",
    page: "plugin:heming.infohub",
    text: "128 条归档",
    detail: "今天 3 条日程",
    badge: "已连接",
    items: [],
    actions: [],
    ...overrides,
  };
}

function bridgeOf(overrides: Partial<PluginsBridge> = {}): PluginsBridge {
  return {
    homeCards: async () => [],
    onHomeCard: () => () => {},
    onNotify: () => () => {},
    ...overrides,
  };
}

beforeEach(() => {
  resetPluginHomeCards();
  delete window.__heming_plugins;
  useUiStore.setState({ page: "home", pluginPageIntent: null });
});

afterEach(() => {
  delete window.__heming_plugins;
  resetPluginHomeCards();
  useUiStore.setState({ page: "home", pluginPageIntent: null });
});

describe("首页插件卡片", () => {
  it("没有桥时整块不渲染（浏览器端不留空壳）", () => {
    const { container } = render(<PluginHomeCards />);
    expect(screen.queryByRole("region", { name: "插件首页卡" })).toBeNull();
    expect(container).toBeEmptyDOMElement();
  });

  it("有桥但没有卡片时不渲染区块", async () => {
    const homeCards = vi.fn(async () => [] as PluginHomeCard[]);
    window.__heming_plugins = bridgeOf({ homeCards });
    render(<PluginHomeCards />);
    // 等异步读取真的跑完：读到了空列表，区块仍然不出现。
    await waitFor(() => expect(homeCards).toHaveBeenCalled());
    expect(screen.queryByRole("region", { name: "插件首页卡" })).toBeNull();
  });

  it("渲染宿主返回的卡片：标题 / 主文案 / 摘要 / 徽标 / 插件名", async () => {
    window.__heming_plugins = bridgeOf({ homeCards: async () => [card()] });
    render(<PluginHomeCards />);
    const region = await screen.findByRole("region", { name: "插件首页卡" });
    expect(region).toBeTruthy();
    // 标题与插件名都叫「信息中枢」，用 getAllByText 明确允许重复。
    expect(screen.getAllByText("信息中枢").length).toBeGreaterThan(0);
    expect(screen.getByText("128 条归档")).toBeTruthy();
    expect(screen.getByText("本机 QQ / 微信聊天记录与日程")).toBeTruthy();
    expect(screen.getByText("已连接")).toBeTruthy();
    expect(screen.getByText("今天 3 条日程")).toBeTruthy();
  });

  it("点击卡片按 card.page 跳转（插件页走 plugin: 前缀）", async () => {
    window.__heming_plugins = bridgeOf({ homeCards: async () => [card()] });
    render(<PluginHomeCards />);
    fireEvent.click(await screen.findByRole("button", { name: "打开 信息中枢" }));
    expect(useUiStore.getState().page).toBe("plugin:heming.infohub");
  });

  it("插件 homeCardSet 推送后文案就地更新", async () => {
    const listeners: Array<(value: PluginHomeCard) => void> = [];
    window.__heming_plugins = bridgeOf({
      homeCards: async () => [card()],
      onHomeCard: (callback) => {
        listeners.push(callback);
        return () => {};
      },
    });
    render(<PluginHomeCards />);
    await screen.findByText("128 条归档");
    await act(async () => {
      listeners[0](card({ text: "129 条归档", detail: "今天 4 条日程" }));
    });
    expect(screen.getByText("129 条归档")).toBeTruthy();
    expect(screen.queryByText("128 条归档")).toBeNull();
  });

  it("非法 page 的卡片被过滤，不渲染假入口", async () => {
    window.__heming_plugins = bridgeOf({
      homeCards: async () => [card(), card({ id: "bad", title: "坏卡片", page: "no-such-page" })],
    });
    render(<PluginHomeCards />);
    await screen.findAllByText("信息中枢");
    expect(screen.queryByText("坏卡片")).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });
});

describe("首页插件卡片 · items / actions（d.139）", () => {
  it("items 逐条渲染在主文案下方（纯展示，不可点）", async () => {
    window.__heming_plugins = bridgeOf({
      homeCards: async () => [card({ items: ["今天 3 条日程", "2 个待归档对话"] })],
    });
    render(<PluginHomeCards />);
    await screen.findByText("2 个待归档对话");
    // 与 detail 同文时不合并：详情一份、item 一份。
    expect(screen.getAllByText("今天 3 条日程")).toHaveLength(2);
    // items 只是文本：没有为每条生成按钮，卡片只有主区 1 个 button。
    expect(screen.queryByRole("button", { name: /2 个待归档对话/ })).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("actions 渲染为小 pill 按钮，点击先导航再投递页面意图", async () => {
    window.__heming_plugins = bridgeOf({
      homeCards: async () => [
        card({
          items: ["今天 3 条日程"],
          actions: [
            { label: "日程", intent: "agenda" },
            { label: "归档", intent: "archive" },
          ],
        }),
      ],
    });
    render(<PluginHomeCards />);
    const agenda = await screen.findByRole("button", { name: "日程：信息中枢" });
    fireEvent.click(agenda);
    // 导航本身会清跨页瞬态，所以「意图还在」正是顺序正确的证据。
    expect(useUiStore.getState().page).toBe("plugin:heming.infohub");
    expect(useUiStore.getState().pluginPageIntent).toEqual({
      pluginId: "heming.infohub",
      intent: "agenda",
    });
  });

  it("按钮不嵌套：主区是 button，action 行在其外层容器里", async () => {
    window.__heming_plugins = bridgeOf({
      homeCards: async () => [card({ actions: [{ label: "日程", intent: "agenda" }] })],
    });
    render(<PluginHomeCards />);
    const main = await screen.findByRole("button", { name: "打开 信息中枢" });
    expect(main.querySelector("button")).toBeNull();
    // 两个按钮是兄弟关系，而不是父子。
    expect(main.parentElement?.querySelectorAll("button")).toHaveLength(2);
  });

  it("没有 items / actions 时不渲染空容器", async () => {
    window.__heming_plugins = bridgeOf({ homeCards: async () => [card()] });
    render(<PluginHomeCards />);
    const main = await screen.findByRole("button", { name: "打开 信息中枢" });
    expect(globalThis.document.querySelectorAll("button")).toHaveLength(1);
    // 卡片容器只有主区一个直接子节点（无空的 items 列表 / actions 行）。
    expect(main.parentElement?.children).toHaveLength(1);
  });
});
