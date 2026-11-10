import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { AutomationPage } from "./AutomationPage.js";
import { DEFAULT_DRAFT, type SyncOptions } from "../lib/automation/model.js";
import { useAutomationStore } from "../lib/automation/store.js";
import {
  setAutomationRunStorage,
  useAutomationRunsStore,
  type AutomationRun,
} from "../lib/automation/runs.js";
import { createMemoryStorage } from "../lib/memory/storage.js";
import { useInfohubStore } from "../lib/infohub/store.js";
import { useUiStore } from "../store/ui.js";
import { useModuleStore } from "../lib/modules/store.js";

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
  useAutomationRunsStore.setState({ runs: [] });
  useInfohubStore.setState({
    available: false,
    running: false,
    booted: false,
    info: null,
    status: null,
    agenda: null,
    detected: null,
    autoCollected: false,
    busy: "",
    error: "",
  });
  useUiStore.setState({ page: "home", automationIntent: null, infohubIntent: null });
}

/** 造一条运行记录：默认是一次成功的定时同步，按需覆盖字段。 */
function makeRun(taskId: string, overrides: Partial<AutomationRun> = {}): AutomationRun {
  const now = Date.now();
  return {
    id: `run-${taskId}-${now}`,
    taskId,
    taskName: "夜间归档",
    kind: "infohub.sync",
    trigger: "schedule",
    status: "ok",
    detail: "同步完成：QQ 新增 2",
    startedAt: now - 1_500,
    finishedAt: now,
    durationMs: 1_500,
    ...overrides,
  };
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
    // 运行记录写盘走注入的 memory storage：跨用例不污染、也不吃 jsdom 的真配额。
    setAutomationRunStorage(createMemoryStorage());
    resetStores();
  });

  afterEach(() => {
    delete (window as unknown as { __heming_infohub?: unknown }).__heming_infohub;
    setAutomationRunStorage(null);
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

  it("弹窗内回车即保存（与桌面端习惯一致）", () => {
    render(<AutomationPage />);
    fireEvent.click(screen.getAllByRole("button", { name: "新建自动化" })[0]);
    const name = screen.getByLabelText("名称");
    fireEvent.change(name, { target: { value: "回车保存" } });
    fireEvent.submit(name.closest("form") as HTMLFormElement);

    const tasks = useAutomationStore.getState().tasks;
    expect(tasks).toHaveLength(1);
    expect(tasks[0].name).toBe("回车保存");
    expect(screen.queryByRole("dialog", { name: "新建自动化" })).toBeNull();
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

  it("未连接时立即运行：记为失败并顺延，不拉起本机进程", async () => {
    const { bridge } = installBridge(false);
    useInfohubStore.setState({ available: true, booted: true, running: false });
    seedTask();
    render(<AutomationPage />);

    fireEvent.click(screen.getByRole("button", { name: "立即运行 夜间归档" }));

    expect(await screen.findByText(/「夜间归档」失败/)).toBeInTheDocument();
    const [task] = useAutomationStore.getState().tasks;
    expect(task.lastStatus).toBe("error");
    expect(task.nextRunAt).toBeGreaterThan(Date.now());
    expect(useAutomationStore.getState().runningId).toBeNull();
    expect(bridge.start).not.toHaveBeenCalled();
    expect(bridge.call).not.toHaveBeenCalled();
  });

  it("未连接提示里的「去连接」跳到信息中枢页", () => {
    // 信息中枢是独立模块：装过后入口才存在，「去连接」应直达该页而不是插件页。
    useModuleStore.getState().install("infohub");
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

  it("运行记录：展开后按最新在前显示状态、触发来源与耗时", () => {
    const taskId = seedTask("夜间归档");
    const older = makeRun(taskId, {
      id: "run-older",
      status: "error",
      detail: "同步失败：边车未就绪",
      trigger: "manual",
      finishedAt: 1_700_000_000_000,
      startedAt: 1_700_000_000_000 - 65_000,
      durationMs: 65_000,
    });
    useAutomationRunsStore.setState({ runs: [makeRun(taskId), older] });

    render(<AutomationPage />);
    fireEvent.click(screen.getByRole("button", { name: "运行记录 夜间归档" }));

    // 展开后 aria-label 不变（仍是「运行记录 <任务名>」），用 aria-expanded 确认状态；
    // 以按钮的父容器为锚点，限定到这一个任务的记录列表。
    const toggle = screen.getByRole("button", { name: "运行记录 夜间归档" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const panel = toggle.closest("div") as HTMLElement;
    const items = within(panel).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("成功");
    expect(items[0]).toHaveTextContent("定时");
    expect(items[1]).toHaveTextContent("失败");
    expect(items[1]).toHaveTextContent("手动");
    expect(items[1]).toHaveTextContent("1 分 5 秒");
    expect(items[1]).toHaveTextContent("边车未就绪");
  });

  it("运行记录：没有历史时给空态，不编数据", () => {
    seedTask("夜间归档");
    render(<AutomationPage />);

    fireEvent.click(screen.getByRole("button", { name: "运行记录 夜间归档" }));
    expect(screen.getByText("还没有运行记录。")).toBeInTheDocument();
  });

  it("立即运行记为手动触发，并写入运行记录", async () => {
    installBridge(false);
    useInfohubStore.setState({ available: true, booted: true, running: false });
    seedTask("夜间归档");
    render(<AutomationPage />);

    fireEvent.click(screen.getByRole("button", { name: "立即运行 夜间归档" }));

    await waitFor(() => expect(useAutomationRunsStore.getState().runs).toHaveLength(1));
    const [run] = useAutomationRunsStore.getState().runs;
    expect(run.trigger).toBe("manual");
    expect(run.status).toBe("error");
    expect(run.taskName).toBe("夜间归档");
    expect(screen.getByText(/「夜间归档」失败/)).toBeInTheDocument();
  });

  it("从通知跳转：展开目标任务并消费焦点", () => {
    const taskId = seedTask("夜间归档");
    useUiStore.setState({ automationFocusId: taskId });

    render(<AutomationPage />);

    expect(useUiStore.getState().automationFocusId).toBeNull();
    expect(screen.getByRole("button", { name: "运行记录 夜间归档" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByText("还没有运行记录。")).toBeInTheDocument();
  });

  it("清空运行记录：二次确认后清空，任务本身不动", () => {
    const taskId = seedTask("夜间归档");
    useAutomationRunsStore.setState({ runs: [makeRun(taskId), makeRun(taskId, { id: "run-2" })] });
    render(<AutomationPage />);

    fireEvent.click(screen.getByRole("button", { name: "清空记录" }));
    const dialog = screen.getByRole("dialog", { name: "清空运行记录" });
    fireEvent.click(within(dialog).getByRole("button", { name: "清空" }));

    expect(useAutomationRunsStore.getState().runs).toHaveLength(0);
    expect(useAutomationStore.getState().tasks).toHaveLength(1);
    expect(screen.getByText("运行记录已清空")).toBeInTheDocument();
  });
});

describe("自动化页空态布局（d.73）", () => {
  beforeEach(() => {
    localStorage.clear();
    delete (window as unknown as { __heming_infohub?: unknown }).__heming_infohub;
    setAutomationRunStorage(createMemoryStorage());
    resetStores();
  });

  it("空态卡在统计行下方的剩余空间垂直居中", () => {
    render(<AutomationPage />);
    const title = screen.getByText("还没有自动化任务");
    const card = title.closest("div.ui-card") as HTMLElement;
    expect(card.className).toContain("max-w-[520px]");
    expect(card.parentElement?.className).toContain("flex-1");
    expect(card.parentElement?.className).toContain("items-center");
  });
});

describe("自动化预设（d.76）", () => {
  beforeEach(() => {
    localStorage.clear();
    delete (window as unknown as { __heming_infohub?: unknown }).__heming_infohub;
    setAutomationRunStorage(createMemoryStorage());
    resetStores();
  });

  it("一键创建：按预设落库，带默认时间、来源与启用状态", () => {
    render(<AutomationPage />);
    const region = screen.getByRole("region", { name: "自动化预设" });
    fireEvent.click(within(region).getByRole("button", { name: "一键创建：每日同步归档" }));

    const [task] = useAutomationStore.getState().tasks;
    expect(task.name).toBe("每日同步归档");
    expect(task.kind).toBe("infohub.sync");
    expect(task.enabled).toBe(true);
    expect(task.schedule).toMatchObject({ type: "daily", time: "08:00" });
    expect(task.sync.sources).toEqual(["qq", "wechat"]);
    expect(screen.getByText("已按预设创建「每日同步归档」")).toBeInTheDocument();
  });

  it("第二条预设：间隔 120 分钟，不覆盖已有任务", () => {
    render(<AutomationPage />);
    fireEvent.click(screen.getByRole("button", { name: "一键创建：每 2 小时增量同步" }));
    fireEvent.click(screen.getByRole("button", { name: "一键创建：每天早上重扫日程" }));

    const tasks = useAutomationStore.getState().tasks;
    expect(tasks).toHaveLength(2);
    const interval = tasks.find((task) => task.name === "每 2 小时增量同步");
    const agenda = tasks.find((task) => task.name === "每天早上重扫日程");
    expect(interval?.schedule).toMatchObject({ type: "interval", minutes: 120 });
    expect(agenda?.kind).toBe("infohub.agenda");
  });
});
