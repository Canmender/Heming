import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { AutomationPage } from "./AutomationPage.js";
import { DEFAULT_DRAFT, type SyncOptions } from "../lib/automation/model.js";
import { useAutomationStore } from "../lib/automation/store.js";
import { useInfohubStore } from "../lib/infohub/store.js";
import { useUiStore } from "../store/ui.js";

/**
 * 自动化页：任务可建、可改、可删；未连接时立即运行只记跳过，不拉起进程；
 * 信息中枢投递的意图要落到预填的新建表单并随即消费。
 */

type Bridge = NonNullable<Window["__heming_infohub"]>;

const syncAll: SyncOptions = { sources: ["qq", "wechat"], full: false, archive: false };

function installBridge(running = false) {
  const bridge = {
    info: vi.fn(async () => ({ running })),
    start: vi.fn(),
    call: vi.fn(async () => undefined),
    stop: vi.fn(async () => true),
    pickHome: vi.fn(async () => null),
    pickPython: vi.fn(async () => null),
    onEvent: vi.fn(() => () => {}),
  } as unknown as Bridge;
  (window as unknown as { __heming_infohub?: Bridge }).__heming_infohub = bridge;
  return { bridge };
}

function resetStores() {
  useAutomationStore.setState({ tasks: [], runningId: null, runningSince: 0 });
  useInfohubStore.setState({
    available: false,
    running: false,
    booted: false,
    info: null,
    status: null,
    agenda: null,
    busy: "",
    error: "",
  });
  useUiStore.setState({ page: "home", automationIntent: null, infohubIntent: null });
}

function seedTask(name = "夜间归档") {
  const outcome = useAutomationStore.getState().create({ ...DEFAULT_DRAFT, name });
  if (!outcome.ok) throw new Error(outcome.error);
  return outcome.id;
}

describe("自动化页", () => {
  beforeEach(() => {
    localStorage.clear();
    delete (window as unknown as { __heming_infohub?: unknown }).__heming_infohub;
    resetStores();
  });

  afterEach(() => {
    delete (window as unknown as { __heming_infohub?: unknown }).__heming_infohub;
  });

  it("浏览器端：明确提示只在桌面端执行，仍可创建任务", () => {
    render(<AutomationPage />);

    expect(screen.getByText(/自动化只在桌面端执行/)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "新建自动化" })[0]);
    const dialog = screen.getByRole("dialog", { name: "新建自动化" });
    expect(dialog).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "晨间同步" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    const [task] = useAutomationStore.getState().tasks;
    expect(task.name).toBe("晨间同步");
    expect(task.enabled).toBe(true);
    expect(task.nextRunAt).toBeGreaterThan(Date.now());
    expect(screen.getByText("晨间同步")).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("heming.automations.v1") as string)).toHaveLength(1);
  });

  it("表单校验：名称为空时不落库，错误留在弹窗里", () => {
    render(<AutomationPage />);
    fireEvent.click(screen.getAllByRole("button", { name: "新建自动化" })[0]);
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(screen.getByText("请填写任务名称")).toBeInTheDocument();
    expect(useAutomationStore.getState().tasks).toHaveLength(0);
    expect(screen.getByRole("dialog", { name: "新建自动化" })).toBeInTheDocument();
  });

  it("意图预填：同步来源与选项带入新建表单，意图随即消费", () => {
    useUiStore.setState({
      automationIntent: {
        kind: "infohub.sync",
        sync: { sources: ["qq"], full: true, archive: false },
      },
    });

    render(<AutomationPage />);

    expect(screen.getByRole("dialog", { name: "新建自动化" })).toBeInTheDocument();
    expect((screen.getByLabelText("QQ") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("微信") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText("全量重扫") as HTMLInputElement).checked).toBe(true);
    expect(useUiStore.getState().automationIntent).toBeNull();
  });

  it("意图预填：日程重扫不带同步选项", () => {
    useUiStore.setState({ automationIntent: { kind: "infohub.agenda" } });

    render(<AutomationPage />);

    expect((screen.getByLabelText("名称") as HTMLInputElement).value).toBe("重扫日程");
    expect(screen.queryByLabelText("QQ")).not.toBeInTheDocument();
  });

  it("编辑：改名后原地更新并保留排期", () => {
    seedTask("夜间归档");
    render(<AutomationPage />);

    fireEvent.click(screen.getByRole("button", { name: "编辑 夜间归档" }));
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "凌晨归档" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    const [task] = useAutomationStore.getState().tasks;
    expect(task.name).toBe("凌晨归档");
    expect(task.runCount).toBe(0);
    expect(screen.getByText("凌晨归档")).toBeInTheDocument();
  });

  it("停用/启用：停用保留计划，启用从此刻重新排期", () => {
    seedTask();
    render(<AutomationPage />);

    fireEvent.click(screen.getByRole("button", { name: "停用 夜间归档" }));
    expect(useAutomationStore.getState().tasks[0].enabled).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "启用 夜间归档" }));
    expect(useAutomationStore.getState().tasks[0].enabled).toBe(true);
    expect(useAutomationStore.getState().tasks[0].nextRunAt).toBeGreaterThan(Date.now());
  });

  it("删除：确认后移除任务与落盘记录", () => {
    seedTask();
    render(<AutomationPage />);

    fireEvent.click(screen.getByRole("button", { name: "删除 夜间归档" }));
    const dialog = screen.getByRole("dialog", { name: "删除自动化" });
    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));

    expect(useAutomationStore.getState().tasks).toHaveLength(0);
    expect(screen.getByText("还没有自动化任务")).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("heming.automations.v1") as string)).toEqual([]);
  });

  it("未连接时立即运行：记跳过并顺延，不拉起本机进程", async () => {
    const { bridge } = installBridge(false);
    useInfohubStore.setState({ available: true, booted: true, running: false });
    seedTask();
    render(<AutomationPage />);

    fireEvent.click(screen.getByRole("button", { name: "立即运行 夜间归档" }));

    expect(await screen.findByText(/「夜间归档」已跳过/)).toBeInTheDocument();
    const [task] = useAutomationStore.getState().tasks;
    expect(task.lastStatus).toBe("skipped");
    expect(task.nextRunAt).toBeGreaterThan(Date.now());
    expect(useAutomationStore.getState().runningId).toBeNull();
    expect(bridge.start).not.toHaveBeenCalled();
    expect(bridge.call).not.toHaveBeenCalled();
  });

  it("未连接提示里的「去连接」跳到信息中枢页", () => {
    installBridge(false);
    useInfohubStore.setState({ available: true, booted: true, running: false });
    render(<AutomationPage />);

    fireEvent.click(screen.getByRole("button", { name: "去连接" }));
    expect(useUiStore.getState().page).toBe("infohub");
  });

  it("已连接时立即运行：结果与下次执行写回任务", async () => {
    const bridge = {
      info: vi.fn(async () => ({ running: true })),
      start: vi.fn(),
      call: vi.fn(async (method: string) => {
        if (method === "sync") {
          return { reports: [{ source: "qq", added: 2, updated: 0, skipped: 0, errors: [] }], agenda: {}, kb: null };
        }
        if (method === "status") return {};
        if (method === "agenda") return { items: [], summary: {} };
        return undefined;
      }),
      stop: vi.fn(async () => true),
      pickHome: vi.fn(async () => null),
      pickPython: vi.fn(async () => null),
      onEvent: vi.fn(() => () => {}),
    } as unknown as Bridge;
    (window as unknown as { __heming_infohub?: Bridge }).__heming_infohub = bridge;
    useInfohubStore.setState({ available: true, booted: true, running: true });
    seedTask();
    render(<AutomationPage />);

    fireEvent.click(screen.getByRole("button", { name: "立即运行 夜间归档" }));

    await waitFor(() => expect(useAutomationStore.getState().tasks[0].lastStatus).toBe("ok"));
    const [task] = useAutomationStore.getState().tasks;
    expect(task.lastDetail).toContain("QQ 新增 2");
    expect(task.runCount).toBe(1);
    expect(task.nextRunAt).toBeGreaterThan(Date.now());
    expect(screen.getByText(/「夜间归档」成功/)).toBeInTheDocument();
    expect(bridge.call).toHaveBeenCalledWith(
      "sync",
      { sources: syncAll.sources, full: false, archive: false },
      {},
    );
  });
});
