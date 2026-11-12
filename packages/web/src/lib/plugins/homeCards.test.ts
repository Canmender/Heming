import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  normalizePluginHomeCard,
  pluginHomeCardKey,
  pluginHomeCardsAvailable,
  pluginsBridge,
  refreshPluginHomeCards,
  resetPluginHomeCards,
  subscribePluginHomeCards,
  usePluginHomeCardsStore,
  type PluginHomeCard,
  type PluginsBridge,
} from "./homeCards.js";

/** 造一张宿主推来的卡片（默认是迁移后的信息中枢）。 */
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

/** 只替换桥对象；窗口是 jsdom 全局，测试结束必须删掉，避免串到别的用例。 */
function installBridge(bridge: PluginsBridge): void {
  window.__heming_plugins = bridge;
}

beforeEach(() => {
  resetPluginHomeCards();
  delete window.__heming_plugins;
});

afterEach(() => {
  delete window.__heming_plugins;
  resetPluginHomeCards();
  vi.restoreAllMocks();
});

describe("插件首页卡片 · 桥探测", () => {
  it("浏览器里没有桥：available 为 false，读到空列表且标记 loaded", async () => {
    // 为什么：首页区块靠 available 决定整块渲染，浏览器端不能出现空壳。
    expect(pluginsBridge()).toBeUndefined();
    expect(pluginHomeCardsAvailable()).toBe(false);
    await refreshPluginHomeCards();
    expect(usePluginHomeCardsStore.getState()).toMatchObject({ cards: [], loaded: true, error: null });
  });

  it("注入桥之后 available 为 true、pluginsBridge 返回同一个对象", () => {
    const bridge = bridgeOf();
    installBridge(bridge);
    expect(pluginHomeCardsAvailable()).toBe(true);
    expect(pluginsBridge()).toBe(bridge);
  });
});

describe("插件首页卡片 · 数据校验", () => {
  it("宿主数据做形状归一：字符串 trim、缺省字段补空串", () => {
    const normalized = normalizePluginHomeCard({
      pluginId: " heming.infohub ",
      pluginName: undefined,
      id: "archive",
      title: " 信息中枢 ",
      page: "plugin:heming.infohub",
    });
    expect(normalized).toMatchObject({
      pluginId: "heming.infohub",
      pluginName: "",
      title: "信息中枢",
      summary: "",
      icon: "",
      text: "",
      detail: "",
      badge: "",
    });
  });

  it("page 必须可路由：插件页 / 内置导航页都行，其它值丢弃", () => {
    expect(normalizePluginHomeCard(card({ page: "plugin:heming.infohub" }))).not.toBeNull();
    expect(normalizePluginHomeCard(card({ page: "infohub" }))).not.toBeNull();
    // 为什么拦：page 最终会喂给 setPage，坏数据会让路由白屏（settings 是真实页面，不能当反例）。
    expect(normalizePluginHomeCard(card({ page: "no-such-page" }))).toBeNull();
    expect(normalizePluginHomeCard(card({ page: "https://evil.example" }))).toBeNull();
  });

  it("缺 pluginId / id / title 或非对象一律丢弃", () => {
    expect(normalizePluginHomeCard(undefined)).toBeNull();
    expect(normalizePluginHomeCard("card")).toBeNull();
    expect(normalizePluginHomeCard(card({ pluginId: "" }))).toBeNull();
    expect(normalizePluginHomeCard(card({ id: "" }))).toBeNull();
    expect(normalizePluginHomeCard(card({ title: "" }))).toBeNull();
  });

  it("唯一键是 pluginId:id（同 id 不同插件不能互相覆盖）", () => {
    expect(pluginHomeCardKey(card())).toBe("heming.infohub:archive");
    expect(pluginHomeCardKey(card({ pluginId: "heming.automations" }))).toBe("heming.automations:archive");
  });
});

describe("插件首页卡片 · 读取列表", () => {
  it("读成功：过滤非法卡 + 按 pluginId:id 去重（保留第一条）", async () => {
    installBridge(
      bridgeOf({
        homeCards: async () => [
          card(),
          card({ title: "重复卡" }),
          card({ id: "agenda", title: "日程", page: "plugin:heming.infohub" }),
          card({ id: "bad", page: "no-such-page" }),
        ],
      }),
    );
    await refreshPluginHomeCards();
    const state = usePluginHomeCardsStore.getState();
    expect(state.cards.map((item) => item.id)).toEqual(["archive", "agenda"]);
    expect(state.cards[0].title).toBe("信息中枢");
    expect(state.loaded).toBe(true);
    expect(state.error).toBeNull();
  });

  it("宿主返回非数组时按空列表处理（不抛错）", async () => {
    installBridge(bridgeOf({ homeCards: async () => "oops" as unknown as PluginHomeCard[] }));
    await refreshPluginHomeCards();
    expect(usePluginHomeCardsStore.getState().cards).toEqual([]);
  });

  it("读失败：清空旧卡并记录中文原因（卡片代表当前可用入口，不留假入口）", async () => {
    installBridge(bridgeOf({ homeCards: async () => [card()] }));
    await refreshPluginHomeCards();
    expect(usePluginHomeCardsStore.getState().cards).toHaveLength(1);

    installBridge(
      bridgeOf({
        homeCards: async () => {
          throw new Error("宿主没响应");
        },
      }),
    );
    await refreshPluginHomeCards();
    const state = usePluginHomeCardsStore.getState();
    expect(state.cards).toEqual([]);
    expect(state.loaded).toBe(true);
    expect(state.error).toContain("读取插件首页卡片失败");
    expect(state.error).toContain("宿主没响应");
  });
});

describe("插件首页卡片 · 增量订阅", () => {
  it("homeCardSet 推送：新卡追加、同键替换", async () => {
    installBridge(bridgeOf({ homeCards: async () => [card()] }));
    await refreshPluginHomeCards();
    const listeners: Array<(value: PluginHomeCard) => void> = [];
    installBridge(
      bridgeOf({
        homeCards: async () => [card()],
        onHomeCard: (cb) => {
          listeners.push(cb);
          return () => {};
        },
      }),
    );
    const unsubscribe = subscribePluginHomeCards();
    listeners[0](card({ text: "129 条归档" }));
    expect(usePluginHomeCardsStore.getState().cards[0].text).toBe("129 条归档");
    listeners[0](card({ id: "agenda", title: "日程", page: "plugin:heming.infohub" }));
    expect(usePluginHomeCardsStore.getState().cards.map((item) => item.id)).toEqual(["archive", "agenda"]);
    // 非法推送直接丢弃，不清空已有卡。
    listeners[0](card({ page: "no-such-page" }));
    expect(usePluginHomeCardsStore.getState().cards).toHaveLength(2);
    unsubscribe();
  });

  it("无桥时返回 noop 且不报错", () => {
    const unsubscribe = subscribePluginHomeCards();
    expect(typeof unsubscribe).toBe("function");
    expect(usePluginHomeCardsStore.getState().error).toBeNull();
  });

  it("旧 preload 缺 onHomeCard：降级为只显示首屏卡，并记录原因", () => {
    const legacy = { homeCards: async () => [] } as unknown as PluginsBridge;
    installBridge(legacy);
    const unsubscribe = subscribePluginHomeCards();
    expect(typeof unsubscribe).toBe("function");
    expect(usePluginHomeCardsStore.getState().error).toContain("订阅插件首页卡片失败");
  });
});
