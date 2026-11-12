import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WidgetSettingsCard } from "./WidgetSettingsCard.js";
import { resetWidgetsStore } from "../../lib/widgets/store.js";
import { useChatStore } from "../../store/chat.js";
import { useUiStore } from "../../store/ui.js";
import type { WidgetRecord, WidgetsBridge } from "../../types/widgets.js";

/**
 * 设置区「外观 · 桌面小组件」卡（d.94）：
 * - 宿主动作（显示/缩放/穿透/位置）不需要插件声明，永远在；
 * - 通用表单按 settings.fields 的 5 种类型渲染，改值经 `settingsSet` 交给主进程；
 * - 未安装/浏览器降级各有明确出口（去插件区 / 仅桌面端可用）。
 */

const FIELDS = [
  { key: "enabled", type: "boolean" as const, label: "在桌面显示" },
  {
    key: "presence",
    type: "select" as const,
    label: "打扰强度",
    default: "normal",
    options: [
      { value: "quiet", label: "安静" },
      { value: "normal", label: "正常" },
    ],
  },
  { key: "modelPath", type: "text" as const, label: "模型路径", default: "pet/Hiyori/Hiyori.model3.json" },
  { key: "size", type: "number" as const, label: "尺寸", default: 300 },
  { key: "agentId", type: "agent" as const, label: "绑定智能体" },
];

function record(overrides: Partial<WidgetRecord> = {}): WidgetRecord {
  return {
    id: "heming.pet",
    name: "桌宠",
    version: "1.0.0",
    enabled: true,
    widget: {
      id: "pet",
      name: "桌宠",
      entry: "files/index.html",
      width: 300,
      height: 420,
      scales: [1],
      defaultScale: 1,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      clickThrough: "auto",
      position: { anchor: "bottom-right", margin: 24, remember: true },
      settings: { title: "桌宠", fields: FIELDS },
    },
    settings: { presence: "normal" },
    installedAt: "2026-11-07T12:00:00.000Z",
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
    setEnabled: async () => ({ ok: true }),
    settingsGet: async () => ({ presence: "normal" }),
    settingsSet: async (input) => ({ ...record().settings, ...input.patch }),
    action: async () => ({ ok: true, state: { visible: true, scale: 1.25, clickThrough: false } }),
    state: async () => ({ visible: false, scale: 1, clickThrough: false }),
    publish: () => {},
    migrateLegacy: async () => ({ ok: true }),
    ...overrides,
  } as WidgetsBridge;
}

beforeEach(() => {
  resetWidgetsStore();
  delete window.__heming_widgets;
  localStorage.clear();
  useChatStore.setState({
    agentsRoster: [
      { id: "a1", owner_id: null, name: "小助手", avatar: null, description: "" },
    ],
    loadAgentsRoster: async () => {},
  });
  useUiStore.setState({ page: "settings" });
});

describe("WidgetSettingsCard · 降级与空态", () => {
  it("浏览器（无桥）→ 仅桌面端可用", () => {
    render(<WidgetSettingsCard />);
    expect(screen.getByText(/仅桌面端可用/)).toBeTruthy();
  });

  it("桌面端未安装 → 空态 + 去插件区", async () => {
    window.__heming_widgets = makeBridge({ list: async () => [] });
    render(<WidgetSettingsCard />);
    await screen.findByText(/还没有安装桌面小组件/);
    fireEvent.click(screen.getByRole("button", { name: "去插件区" }));
    expect(useUiStore.getState().page).toBe("plugins");
  });
});

describe("WidgetSettingsCard · 宿主动作", () => {
  it("显示/缩放/穿透/重置位置都走 widgets:action", async () => {
    const action = vi.fn(async (_input: { id: string; action: string }) => ({
      ok: true,
      state: { visible: true, scale: 1.25, clickThrough: false },
    }));
    window.__heming_widgets = makeBridge({ action });
    render(<WidgetSettingsCard />);
    await screen.findByText("桌宠");
    fireEvent.click(screen.getByRole("button", { name: "显示" }));
    fireEvent.click(screen.getByRole("button", { name: "放大一档" }));
    fireEvent.click(screen.getByRole("button", { name: "缩小一档" }));
    fireEvent.click(screen.getByRole("button", { name: "鼠标穿透" }));
    fireEvent.click(screen.getByRole("button", { name: "重置位置" }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(5));
    expect(action.mock.calls.map((call) => call[0].action)).toEqual([
      "toggle",
      "scaleUp",
      "scaleDown",
      "toggleClickThrough",
      "resetPosition",
    ]);
  });

  it("停用/损坏的插件：动作禁用但表单内容仍可见", async () => {
    window.__heming_widgets = makeBridge({
      list: async () => [record({ enabled: false })],
    });
    render(<WidgetSettingsCard />);
    await screen.findByText("已停用");
    expect((screen.getByRole("button", { name: "显示" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByLabelText("打扰强度")).toBeTruthy();
  });
});

describe("WidgetSettingsCard · 通用表单", () => {
  it("按字段类型渲染 5 种控件", async () => {
    window.__heming_widgets = makeBridge();
    render(<WidgetSettingsCard />);
    await screen.findByText("桌宠");
    expect(screen.getByRole("switch", { name: "在桌面显示" })).toBeTruthy();
    expect(screen.getByLabelText("打扰强度")).toBeTruthy();
    expect(screen.getByLabelText("模型路径")).toBeTruthy();
    expect(screen.getByLabelText("尺寸")).toBeTruthy();
    expect(screen.getByLabelText("绑定智能体")).toBeTruthy();
  });

  it("select / boolean / agent 改动立即写回主进程", async () => {
    const settingsSet = vi.fn(async (input: { patch: Record<string, unknown> }) => ({
      ...record().settings,
      ...input.patch,
    }));
    window.__heming_widgets = makeBridge({ settingsSet });
    render(<WidgetSettingsCard />);
    await screen.findByText("桌宠");

    fireEvent.change(screen.getByLabelText("打扰强度"), { target: { value: "quiet" } });
    fireEvent.click(screen.getByRole("switch", { name: "在桌面显示" }));
    fireEvent.change(screen.getByLabelText("绑定智能体"), { target: { value: "a1" } });

    await waitFor(() => expect(settingsSet).toHaveBeenCalledTimes(3));
    expect(settingsSet.mock.calls[0][0]).toEqual({
      id: "heming.pet",
      patch: { presence: "quiet" },
    });
    expect(settingsSet.mock.calls[1][0]).toEqual({
      id: "heming.pet",
      patch: { enabled: true },
    });
    expect(settingsSet.mock.calls[2][0]).toEqual({
      id: "heming.pet",
      patch: { agentId: "a1" },
    });
    expect(await screen.findByText("已保存")).toBeTruthy();
  });

  it("text / number 失焦提交（不是逐字写 IPC）", async () => {
    const settingsSet = vi.fn(async (input: { patch: Record<string, unknown> }) => ({
      ...record().settings,
      ...input.patch,
    }));
    window.__heming_widgets = makeBridge({ settingsSet });
    render(<WidgetSettingsCard />);
    await screen.findByText("桌宠");

    const text = screen.getByLabelText("模型路径") as HTMLInputElement;
    fireEvent.change(text, { target: { value: "pet/Shizuku/shizuku.model3.json" } });
    // 只改输入框、还没失焦 → 不写
    expect(settingsSet).not.toHaveBeenCalled();
    fireEvent.blur(text);
    await waitFor(() => expect(settingsSet).toHaveBeenCalledTimes(1));
    expect(settingsSet.mock.calls[0][0].patch).toEqual({
      modelPath: "pet/Shizuku/shizuku.model3.json",
    });

    const number = screen.getByLabelText("尺寸") as HTMLInputElement;
    fireEvent.change(number, { target: { value: "420" } });
    fireEvent.blur(number);
    await waitFor(() => expect(settingsSet).toHaveBeenCalledTimes(2));
    expect(settingsSet.mock.calls[1][0].patch).toEqual({ size: 420 });
  });

  it("写回失败显示中文错误", async () => {
    window.__heming_widgets = makeBridge({
      settingsSet: async () => {
        throw new Error("磁盘只读");
      },
    });
    render(<WidgetSettingsCard />);
    await screen.findByText("桌宠");
    fireEvent.change(screen.getByLabelText("打扰强度"), { target: { value: "quiet" } });
    expect(await screen.findByRole("alert")).toHaveTextContent(/磁盘只读/);
  });
});

/**
 * d.136：窗口设置挪进插件详情后，同一张卡有两种形态。
 * - `onlyPluginId`：只渲染这个插件的记录（插件详情里嵌的就是单个插件）；
 * - `embedded`：不套「桌面小组件」卡片壳、大标题与空态引导，只留窗口动作与表单；
 *   没有记录时返回 null（不占位、不留空标题）。
 */
describe("WidgetSettingsCard · 嵌入插件详情（d.136）", () => {
  /** 另一个插件的小组件：用于验证 onlyPluginId 的过滤。 */
  function otherRecord(): WidgetRecord {
    const base = record();
    return record({
      id: "acme.clock",
      name: "时钟",
      widget: {
        ...base.widget!,
        name: "时钟",
        settings: { title: "时钟", fields: FIELDS },
      },
    });
  }

  it("onlyPluginId：只渲染目标插件的窗口设置", async () => {
    window.__heming_widgets = makeBridge({ list: async () => [record(), otherRecord()] });
    render(<WidgetSettingsCard onlyPluginId="heming.pet" embedded />);

    await screen.findByText("桌宠");
    expect(document.querySelector('[data-widget-settings-id="heming.pet"]')).not.toBeNull();
    expect(document.querySelector('[data-widget-settings-id="acme.clock"]')).toBeNull();
  });

  it("embedded：没有卡片壳、没有大标题，但窗口动作与设置表单都在", async () => {
    window.__heming_widgets = makeBridge();
    const { container } = render(<WidgetSettingsCard onlyPluginId="heming.pet" embedded />);

    await screen.findByText("桌宠");
    // 不套 <section className="ui-card">，也不再写「桌面小组件」这个标题
    expect(container.querySelector("section")).toBeNull();
    expect(screen.queryByText("桌面小组件")).toBeNull();
    expect(screen.getByRole("button", { name: "显示" })).toBeTruthy();
    expect(screen.getByLabelText("打扰强度")).toBeTruthy();
  });

  it("embedded：没有这个插件的记录 → 返回 null（不占位）", async () => {
    window.__heming_widgets = makeBridge();
    const { container } = render(<WidgetSettingsCard onlyPluginId="acme.clock" embedded />);

    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
