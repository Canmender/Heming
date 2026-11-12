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
  useUiStore.setState({ page: "home" });
});

afterEach(() => {
  delete window.__heming_plugins;
  resetPluginHomeCards();
  useUiStore.setState({ page: "home" });
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
