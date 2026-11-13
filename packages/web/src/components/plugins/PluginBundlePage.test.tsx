import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PluginBundlePage } from "./PluginBundlePage.js";
import {
  refreshWidgets,
  resetWidgetsStore,
  widgetRecord,
} from "../../lib/widgets/store.js";
import { useUiStore } from "../../store/ui.js";
import type {
  WidgetPageEventChannel,
  WidgetPageOpenResult,
  WidgetRecord,
  WidgetsBridge,
} from "../../types/widgets.js";

/**
 * 插件页面 host（d.141 内嵌 iframe）：
 * - 内容区是本插件 `widget://<id>` 的沙箱 iframe，页头在 iframe 之外；
 * - `pageOpen` 拿地址 → iframe.src；`ready`/onload 撤加载态；卸载 `pageClose`；
 * - 帧中继只认「本插件 origin + 当前 iframe contentWindow」的消息；
 * - 旧桌面端（无 pageOpen）→ 降级说明；空态三支不发任何 IPC。
 *
 * 测试直接注入 `window.__heming_widgets`（与 WidgetsView.test.tsx 同一套写法），
 * 不经过路由/注册表接线；iframe 的 message 事件手工 dispatch（jsdom 不会自己发）。
 */

const PAGE = {
  title: "我的面板",
  icon: "layout",
  summary: "本机状态一览",
  entry: "page/index.html",
};

const OPENED_URL = "widget://heming.panel/page/index.html?version=1.2.0";

const FRAME_PROTOCOL = 1;

function record(overrides: Partial<WidgetRecord> = {}): WidgetRecord {
  return {
    id: "heming.panel",
    name: "面板插件",
    version: "1.2.0",
    enabled: true,
    widget: {
      id: "panel",
      name: "面板插件",
      entry: "widget/index.html",
      width: 300,
      height: 420,
      scales: [1],
      defaultScale: 1,
      transparent: false,
      alwaysOnTop: false,
      skipTaskbar: true,
      resizable: false,
      clickThrough: "none",
      position: { anchor: "bottom-right", margin: 24, remember: false },
    },
    settings: {},
    installedAt: "2026-11-10T02:00:00.000Z",
    page: PAGE,
    ...overrides,
  };
}

function makeBridge(overrides: Partial<WidgetsBridge> = {}): WidgetsBridge {
  return {
    list: async () => [record()],
    pickPackage: async () => ({ canceled: true }),
    install: async () => ({ ok: true, record: record() }),
    installFromFile: async () => ({ ok: true, record: record() }),
    uninstall: async () => ({ ok: true }),
    setEnabled: async () => ({ ok: true, record: record() }),
    settingsGet: async () => ({}),
    settingsSet: async () => ({}),
    action: async () => ({ ok: true, state: { visible: true, scale: 1, clickThrough: false } }),
    state: async () => ({ visible: false, scale: 1, clickThrough: false }),
    publish: () => {},
    migrateLegacy: async () => ({ ok: true }),
    ...overrides,
  } as WidgetsBridge;
}

/** 新桌面端桥：pageOpen/pageClose/pageCall/pageSend/onPageEvent 齐全，用例可覆盖单个。 */
function makePageBridge(overrides: Partial<WidgetsBridge> = {}): WidgetsBridge {
  return makeBridge({
    pageOpen: async (input) => ({
      ok: true as const,
      url: `widget://${input.id}/page/index.html?version=1.2.0`,
      version: "1.2.0",
    }),
    pageClose: () => {},
    pageCall: async () => ({ ok: true as const, value: undefined }),
    pageSend: () => {},
    onPageEvent: () => () => {},
    ...overrides,
  });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function frameWindowOf(frame: HTMLIFrameElement): Window {
  const win = frame.contentWindow;
  if (!win) throw new Error("iframe.contentWindow 不存在（jsdom 环境异常）");
  return win;
}

/**
 * 手工构造 message 事件：origin/source 用 own property 钉死，
 * 不依赖 jsdom 的 MessageEventInit 是否实现 `source`。
 */
function makeMessageEvent(data: unknown, origin: string, source: Window | null): MessageEvent {
  const event = new MessageEvent("message", { data, origin });
  Object.defineProperty(event, "origin", { configurable: true, value: origin });
  Object.defineProperty(event, "source", { configurable: true, value: source });
  return event;
}

type FramePost = { message: unknown; targetOrigin: string };

/** 拦下宿主发往 iframe 的 postMessage（jsdom 跨 frame 投递不可靠，直接记参数）。 */
function captureFramePosts(frame: HTMLIFrameElement): FramePost[] {
  const win = frameWindowOf(frame);
  const posts: FramePost[] = [];
  Object.defineProperty(win, "postMessage", {
    configurable: true,
    value: (message: unknown, targetOrigin: string): void => {
      posts.push({ message, targetOrigin });
    },
  });
  return posts;
}

/** 模拟页面帧 → 宿主的一帧消息；默认来源是当前 iframe 与本插件 origin。 */
function dispatchFromFrame(
  data: unknown,
  options: {
    origin?: string;
    source?: Window | null;
    frame?: HTMLIFrameElement;
  } = {},
): void {
  const frame = options.frame ?? (screen.getByTestId("plugin-page-frame") as HTMLIFrameElement);
  const source = options.source !== undefined ? options.source : frameWindowOf(frame);
  window.dispatchEvent(makeMessageEvent(data, options.origin ?? "widget://heming.panel", source));
}

function frameCall(id: number, method: string, args: unknown[] = []): unknown {
  return { __heming_frame: FRAME_PROTOCOL, kind: "call", id, method, args };
}

function readyMessage(): unknown {
  return { __heming_frame: FRAME_PROTOCOL, kind: "ready" };
}

/**
 * render + flush 一轮微任务：`pageOpen` 的 promise 在 act 内落定，避免 act 警告。
 * 传 deferred 的用例不受影响（promise 一直 pending，加载态保持）。
 */
async function renderPage(pluginId = "heming.panel"): Promise<ReturnType<typeof render>> {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<PluginBundlePage pluginId={pluginId} />);
  });
  // store 的 refreshWidgets 也是异步链：再多冲两轮微任务，别把 setState 漏到 act 外
  await act(async () => {});
  await act(async () => {});
  return view;
}

beforeEach(() => {
  resetWidgetsStore();
  delete window.__heming_widgets;
  useUiStore.setState({ page: "home", pluginPageIntent: null });
});

afterEach(() => {
  // 先卸载再重置 store：RTL 的自动 cleanup 在本文件的 afterEach 之后才跑，
  // 组件还挂着时重置 store 会触发 act(...) 警告（纯噪音，但会淹掉真失败的输出）。
  cleanup();
  vi.restoreAllMocks();
  delete window.__heming_widgets;
  resetWidgetsStore();
  useUiStore.setState({ page: "home", pluginPageIntent: null });
});

describe("PluginBundlePage · 降级（浏览器 / 旧桌面端）", () => {
  it("没有插件桥时说明「插件页面只在安装版里可用」", async () => {
    await renderPage("heming.panel");
    expect(screen.getByText("插件页面只在安装版里可用")).toBeTruthy();
    expect(screen.queryByTestId("plugin-page-frame")).toBeNull();
  });

  it("旧桌面端桥缺少 pageOpen 时同样降级，不假定方法存在", async () => {
    window.__heming_widgets = makeBridge(); // 没有 pageOpen/pageClose/pageCall/pageSend
    await renderPage("heming.panel");
    expect(screen.getByText("插件页面只在安装版里可用")).toBeTruthy();
    expect(screen.queryByTestId("plugin-page-frame")).toBeNull();
  });
});

describe("PluginBundlePage · 挂载与页头", () => {
  it("pageOpen 返回的 url 进 iframe.src，iframe 属性齐全，页头在 iframe 之外", async () => {
    const gate = deferred<WidgetPageOpenResult>();
    const pageOpen = vi.fn(() => gate.promise);
    window.__heming_widgets = makePageBridge({ pageOpen });

    await renderPage("heming.panel");

    await waitFor(() => expect(pageOpen).toHaveBeenCalledTimes(1));
    expect(pageOpen).toHaveBeenCalledWith({ id: "heming.panel" });
    // 打开地址回来之前：只有加载态，没有 iframe
    expect(screen.getByText("正在加载插件页面…")).toBeTruthy();
    expect(screen.queryByTestId("plugin-page-frame")).toBeNull();

    await act(async () => {
      gate.resolve({ ok: true, url: OPENED_URL, version: "1.2.0" });
    });
    const frame = (await screen.findByTestId("plugin-page-frame")) as HTMLIFrameElement;

    expect(frame.src).toBe(OPENED_URL);
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.className).toContain("h-full");
    expect(frame.className).toContain("w-full");
    expect(frame.className).toContain("border-0");
    expect(frame.getAttribute("title")).toBe("我的面板");

    // 页头（iframe 之外的 DOM）照常展示插件信息
    expect(screen.getByText("我的面板")).toBeTruthy();
    expect(screen.getByText("v1.2.0")).toBeTruthy();
    expect(screen.getByText("插件")).toBeTruthy();
    expect(screen.getByText("本机状态一览")).toBeTruthy();
  });

  it("首页卡 action 带意图进入：pageOpen 收到 intent，且意图用后即清（d.139）", async () => {
    const pageOpen = vi.fn(async (_input: { id: string; intent?: string }) => ({
      ok: true as const,
      url: OPENED_URL,
      version: "1.2.0",
    }));
    window.__heming_widgets = makePageBridge({ pageOpen });
    useUiStore.setState({ pluginPageIntent: { pluginId: "heming.panel", intent: "agenda" } });

    await renderPage("heming.panel");

    await waitFor(() => expect(pageOpen).toHaveBeenCalledTimes(1));
    expect(pageOpen).toHaveBeenCalledWith({ id: "heming.panel", intent: "agenda" });
    expect(useUiStore.getState().pluginPageIntent).toBeNull();
  });

  it("意图属于别的插件时按普通进入打开（不传 intent、不消费）", async () => {
    const pageOpen = vi.fn(async (_input: { id: string; intent?: string }) => ({
      ok: true as const,
      url: OPENED_URL,
      version: "1.2.0",
    }));
    window.__heming_widgets = makePageBridge({ pageOpen });
    useUiStore.setState({ pluginPageIntent: { pluginId: "heming.other", intent: "agenda" } });

    await renderPage("heming.panel");

    await waitFor(() => expect(pageOpen).toHaveBeenCalledTimes(1));
    // 无意图时不带 intent 键，保持与旧调用方/假桥的浅比对兼容。
    expect(pageOpen).toHaveBeenCalledWith({ id: "heming.panel" });
    expect(useUiStore.getState().pluginPageIntent).toEqual({
      pluginId: "heming.other",
      intent: "agenda",
    });
  });

  it("收到帧桥 ready 撤加载态", async () => {
    window.__heming_widgets = makePageBridge();
    await renderPage("heming.panel");

    const frame = (await screen.findByTestId("plugin-page-frame")) as HTMLIFrameElement;
    expect(screen.getByText("正在加载插件页面…")).toBeTruthy();

    act(() => {
      dispatchFromFrame(readyMessage(), { frame });
    });
    expect(screen.queryByText("正在加载插件页面…")).toBeNull();
  });

  it("帧桥 ready 没来时 onload 兜底撤加载态", async () => {
    window.__heming_widgets = makePageBridge();
    await renderPage("heming.panel");

    const frame = (await screen.findByTestId("plugin-page-frame")) as HTMLIFrameElement;
    expect(screen.getByText("正在加载插件页面…")).toBeTruthy();

    fireEvent.load(frame);
    expect(screen.queryByText("正在加载插件页面…")).toBeNull();
  });

  it("「重新加载」自增 iframe key 重挂，不重复 pageOpen", async () => {
    const pageOpen = vi.fn(async () => ({
      ok: true as const,
      url: OPENED_URL,
      version: "1.2.0",
    }));
    window.__heming_widgets = makePageBridge({ pageOpen });
    await renderPage("heming.panel");

    const before = (await screen.findByTestId("plugin-page-frame")) as HTMLIFrameElement;
    act(() => {
      dispatchFromFrame(readyMessage(), { frame: before });
    });

    fireEvent.click(screen.getByRole("button", { name: "重新加载插件页面" }));

    const after = (await screen.findByTestId("plugin-page-frame")) as HTMLIFrameElement;
    expect(after).not.toBe(before); // 换了一个 DOM 节点 = key 变了
    expect(after.src).toBe(OPENED_URL);
    expect(screen.getByText("正在加载插件页面…")).toBeTruthy();
    expect(pageOpen).toHaveBeenCalledTimes(1);
  });

  it("卸载时 pageClose 并退订事件，之后消息不再转发", async () => {
    const pageCall = vi.fn(async () => ({ ok: true as const, value: null }));
    const unsubscribe = vi.fn();
    const onPageEvent = vi.fn(() => unsubscribe);
    const pageClose = vi.fn();
    window.__heming_widgets = makePageBridge({ pageCall, onPageEvent, pageClose });

    const view = await renderPage("heming.panel");
    const frame = (await screen.findByTestId("plugin-page-frame")) as HTMLIFrameElement;
    const frameWin = frameWindowOf(frame);
    expect(onPageEvent).toHaveBeenCalledTimes(1);
    expect(pageClose).not.toHaveBeenCalled();

    view.unmount();

    expect(pageClose).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);

    // 卸载后监听已移除：同样来源的消息不会再触发桥调用
    window.dispatchEvent(makeMessageEvent(frameCall(1, "settings"), "widget://heming.panel", frameWin));
    expect(pageCall).not.toHaveBeenCalled();
  });

  it("切到另一个插件页面：关闭旧页面、按新 id 打开", async () => {
    const pageOpen = vi.fn(async (input: { id: string; intent?: string }) => ({
      ok: true as const,
      url: `widget://${input.id}/page/index.html?version=1.2.0`,
      version: "1.2.0",
    }));
    const pageClose = vi.fn();
    window.__heming_widgets = makePageBridge({
      pageOpen,
      pageClose,
      list: async () => [
        record(),
        record({ id: "acme.second", name: "第二面板", page: { ...PAGE, title: "第二面板" } }),
      ],
    });

    const view = await renderPage("heming.panel");
    await screen.findByTestId("plugin-page-frame");

    await act(async () => {
      view.rerender(<PluginBundlePage pluginId="acme.second" />);
    });

    await waitFor(() => expect(pageOpen).toHaveBeenCalledTimes(2));
    expect(pageOpen.mock.calls[1]?.[0]).toEqual({ id: "acme.second" });
    expect(pageClose).toHaveBeenCalled();
    expect(screen.getByText("第二面板")).toBeTruthy();
    await waitFor(() =>
      expect(
        (screen.getByTestId("plugin-page-frame") as HTMLIFrameElement).src,
      ).toBe("widget://acme.second/page/index.html?version=1.2.0"),
    );
  });
});

describe("PluginBundlePage · 错误态", () => {
  it("pageOpen 返回 error：显示原因 + 「重新加载」「打开插件详情」，重试再打开", async () => {
    const pageOpen = vi
      .fn<() => Promise<WidgetPageOpenResult>>()
      .mockResolvedValueOnce({ ok: false, error: "页面入口不在包内：page/index.html" })
      .mockResolvedValueOnce({ ok: true, url: OPENED_URL, version: "1.2.0" });
    window.__heming_widgets = makePageBridge({ pageOpen });

    await renderPage("heming.panel");

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("插件页面没能显示出来")).toBeTruthy();
    expect(within(alert).getByText(/页面入口不在包内/)).toBeTruthy();

    // 打开插件详情 → 插件区（可在那里启停/更新/卸载）
    fireEvent.click(within(alert).getByRole("button", { name: "打开插件详情" }));
    expect(useUiStore.getState().page).toBe("plugins");

    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "重新加载" }));
    await waitFor(() => expect(pageOpen).toHaveBeenCalledTimes(2));
    // 第二次成功：错误态收掉，iframe 上来
    await screen.findByTestId("plugin-page-frame");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("IPC 本身失败（reject）也走错误态，而不是白屏", async () => {
    const pageOpen = vi.fn(async () => {
      throw new Error("桥未就绪");
    });
    window.__heming_widgets = makePageBridge({ pageOpen });

    await renderPage("heming.panel");

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(/挂载插件页面失败：桥未就绪/)).toBeTruthy();
  });
});

describe("PluginBundlePage · 空态", () => {
  it("没有安装记录时给空态，不发 pageOpen", async () => {
    const pageOpen = vi.fn(async () => ({ ok: true as const, url: OPENED_URL, version: "1.2.0" }));
    window.__heming_widgets = makePageBridge({ pageOpen, list: async () => [] });

    await renderPage("heming.gone");

    expect(await screen.findByText("这个插件没有页面或已被停用")).toBeTruthy();
    expect(screen.getByText(/没有找到这个插件的安装记录/)).toBeTruthy();
    expect(pageOpen).not.toHaveBeenCalled();
  });

  it("停用的插件不给入口，也不打开页面", async () => {
    const pageOpen = vi.fn(async () => ({ ok: true as const, url: OPENED_URL, version: "1.2.0" }));
    window.__heming_widgets = makePageBridge({
      pageOpen,
      list: async () => [record({ enabled: false })],
    });

    await renderPage("heming.panel");

    expect(await screen.findByText("这个插件没有页面或已被停用")).toBeTruthy();
    expect(screen.getByText(/已被停用，启用后才会显示/)).toBeTruthy();
    expect(pageOpen).not.toHaveBeenCalled();
  });

  it("清单没有 page 的插件给空态", async () => {
    const pageOpen = vi.fn(async () => ({ ok: true as const, url: OPENED_URL, version: "1.2.0" }));
    window.__heming_widgets = makePageBridge({
      pageOpen,
      list: async () => [record({ page: undefined })],
    });

    await renderPage("heming.panel");

    expect(await screen.findByText("这个插件没有页面或已被停用")).toBeTruthy();
    expect(screen.getByText(/没有声明页面/)).toBeTruthy();
    expect(pageOpen).not.toHaveBeenCalled();
  });
});

describe("PluginBundlePage · 帧中继", () => {
  it("call 转发到 pageCall，结果按协议回投到 iframe", async () => {
    const pageCall = vi.fn(async () => ({
      ok: true as const,
      value: { theme: "dark", agents: [] },
    }));
    window.__heming_widgets = makePageBridge({ pageCall });
    await renderPage("heming.panel");

    const frame = (await screen.findByTestId("plugin-page-frame")) as HTMLIFrameElement;
    const posts = captureFramePosts(frame);

    act(() => {
      dispatchFromFrame(frameCall(7, "settings", []), { frame });
    });

    await waitFor(() => expect(pageCall).toHaveBeenCalledTimes(1));
    expect(pageCall).toHaveBeenCalledWith({
      id: "heming.panel",
      method: "settings",
      payload: undefined,
    });

    await waitFor(() => expect(posts.length).toBe(1));
    expect(posts[0]?.message).toEqual({
      __heming_frame: 1,
      kind: "result",
      id: 7,
      ok: true,
      value: { theme: "dark", agents: [] },
    });
    // 只投给本插件 origin
    expect(posts[0]?.targetOrigin).toBe("widget://heming.panel");
  });

  it("参数打包：1 参裸传、≥2 参传数组；pageSend 不等结果也回 ok", async () => {
    const pageSend = vi.fn();
    const pageCall = vi.fn(async () => ({ ok: true as const, value: "merged" }));
    window.__heming_widgets = makePageBridge({ pageSend, pageCall });
    await renderPage("heming.panel");

    const frame = (await screen.findByTestId("plugin-page-frame")) as HTMLIFrameElement;
    const posts = captureFramePosts(frame);

    act(() => {
      dispatchFromFrame(frameCall(1, "log", ["hello"]), { frame });
      dispatchFromFrame(frameCall(2, "dataSet", ["theme", "dark"]), { frame });
    });

    await waitFor(() => expect(pageSend).toHaveBeenCalledTimes(1));
    expect(pageSend).toHaveBeenCalledWith({
      id: "heming.panel",
      method: "log",
      payload: "hello",
    });
    await waitFor(() => expect(pageCall).toHaveBeenCalledTimes(1));
    expect(pageCall).toHaveBeenCalledWith({
      id: "heming.panel",
      method: "dataSet",
      payload: ["theme", "dark"],
    });

    await waitFor(() => expect(posts.length).toBe(2));
    const byId = new Map(posts.map((p) => [(p.message as { id: number }).id, p.message]));
    expect(byId.get(1)).toEqual({
      __heming_frame: 1,
      kind: "result",
      id: 1,
      ok: true,
      value: undefined,
    });
    expect(byId.get(2)).toEqual({
      __heming_frame: 1,
      kind: "result",
      id: 2,
      ok: true,
      value: "merged",
    });
  });

  it("未知方法回 ERR_WIDGET_UNKNOWN_METHOD，不碰桥", async () => {
    const pageCall = vi.fn(async () => ({ ok: true as const, value: null }));
    const pageSend = vi.fn();
    window.__heming_widgets = makePageBridge({ pageCall, pageSend });
    await renderPage("heming.panel");

    const frame = (await screen.findByTestId("plugin-page-frame")) as HTMLIFrameElement;
    const posts = captureFramePosts(frame);

    act(() => {
      // state 由帧桥本地处理，不过宿主；宿主表外方法一律拒
      dispatchFromFrame(frameCall(9, "state", []), { frame });
      dispatchFromFrame(frameCall(10, "hackHost", []), { frame });
    });

    await waitFor(() => expect(posts.length).toBe(2));
    for (const post of posts) {
      expect(post.message).toMatchObject({
        __heming_frame: 1,
        kind: "result",
        ok: false,
        error: { code: "ERR_WIDGET_UNKNOWN_METHOD" },
      });
    }
    expect(pageCall).not.toHaveBeenCalled();
    expect(pageSend).not.toHaveBeenCalled();
  });

  it("桥调用 reject 时回 ok:false，不让帧干等", async () => {
    const pageCall = vi.fn(async () => {
      throw new Error("主进程未就绪");
    });
    window.__heming_widgets = makePageBridge({ pageCall });
    await renderPage("heming.panel");

    const frame = (await screen.findByTestId("plugin-page-frame")) as HTMLIFrameElement;
    const posts = captureFramePosts(frame);

    act(() => {
      dispatchFromFrame(frameCall(3, "info"), { frame });
    });

    await waitFor(() => expect(posts.length).toBe(1));
    expect(posts[0]?.message).toMatchObject({
      __heming_frame: 1,
      kind: "result",
      id: 3,
      ok: false,
      error: { code: "ERR_WIDGET_PAGE_CALL_FAILED", message: "主进程未就绪" },
    });
  });

  it("origin 不是本插件 / source 不是当前 iframe 的消息一律丢弃", async () => {
    const pageCall = vi.fn(async () => ({ ok: true as const, value: null }));
    window.__heming_widgets = makePageBridge({ pageCall });
    await renderPage("heming.panel");

    const frame = (await screen.findByTestId("plugin-page-frame")) as HTMLIFrameElement;
    const posts = captureFramePosts(frame);

    act(() => {
      // 来源窗口对、origin 不对
      dispatchFromFrame(readyMessage(), { frame, origin: "widget://heming.evil" });
      dispatchFromFrame(frameCall(1, "info"), { frame, origin: "https://evil.example" });
      // origin 对、来源窗口不对（顶层 window 想冒充 iframe）
      dispatchFromFrame(readyMessage(), { frame, source: window });
      dispatchFromFrame(frameCall(2, "info"), { frame, source: window });
      // 协议版本/形状不对
      dispatchFromFrame({ __heming_frame: 2, kind: "ready" }, { frame });
      dispatchFromFrame({ __heming_frame: 1, kind: "call", id: "1", method: "info" }, { frame });
    });

    expect(screen.getByText("正在加载插件页面…")).toBeTruthy();
    expect(posts.length).toBe(0);
    expect(pageCall).not.toHaveBeenCalled();
  });

  it("onPageEvent 只把本插件的事件注入 iframe", async () => {
    type PageEvent = { id: string; channel: WidgetPageEventChannel; payload: unknown };
    let emit: ((msg: PageEvent) => void) | undefined;
    const onPageEvent = vi.fn((cb: (msg: PageEvent) => void) => {
      emit = cb;
      return () => {};
    });
    window.__heming_widgets = makePageBridge({ onPageEvent });
    await renderPage("heming.panel");

    const frame = (await screen.findByTestId("plugin-page-frame")) as HTMLIFrameElement;
    const posts = captureFramePosts(frame);

    act(() => {
      emit?.({ id: "heming.panel", channel: "settings", payload: { theme: "dark" } });
    });
    expect(posts.length).toBe(1);
    expect(posts[0]?.message).toEqual({
      __heming_frame: 1,
      kind: "event",
      channel: "settings",
      payload: { theme: "dark" },
    });
    expect(posts[0]?.targetOrigin).toBe("widget://heming.panel");

    act(() => {
      // 主进程已经按 activePage 过滤，宿主仍再按 id 兜一层
      emit?.({ id: "heming.other", channel: "event", payload: { n: 1 } });
    });
    expect(posts.length).toBe(1);
  });
});

describe("widgets store · page 透传", () => {
  it("widgets:list 的 page 字段原样进 store，不被裁剪", async () => {
    const page = { title: "我的面板", icon: "layout", summary: "", entry: "page/index.html" };
    window.__heming_widgets = makePageBridge({ list: async () => [record({ page })] });

    await refreshWidgets();

    expect(widgetRecord("heming.panel")?.page).toEqual(page);
  });
});